import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, schema } from "@/lib/db";
import { buildSearchQuery, listMessages, getMessage, startOfYearEpochSec } from "@/lib/gmail";
import { parseEmail, makeSourceHash } from "@/lib/parser";
import { eq } from "drizzle-orm";

/**
 * POST /api/sync
 *
 * Pulls credit-card alert emails from the signed-in user's Gmail, parses
 * them, and inserts new transactions into Turso.
 *
 * BACKFILL STRATEGY
 * ------------------
 * A "from Jan 1 of this year" sync can easily be 500-2000 messages — far more
 * than fits in one Vercel function invocation (60s Hobby limit). So we:
 *
 *  1. On the FIRST sync ever for a user, anchor the query to `after:<Jan 1>`
 *     instead of the rolling 30-day window, and mark syncInProgress = true.
 *  2. Page through Gmail's `nextPageToken` within a ~50s time budget (leaving
 *     headroom under the 60s hard limit for the final DB writes + response).
 *  3. If Gmail has more pages left when the time budget runs out, we persist
 *     the cursor (syncCursor) and the exact query used (syncQuery) on the
 *     user row, and return `{ done: false }`. The UI shows "Continue sync"
 *     and calls this endpoint again, which resumes from the saved cursor
 *     instead of restarting from page 1.
 *  4. Once Gmail reports no more pages, we clear the cursor, set
 *     lastSyncAt = now, and return `{ done: true }`. Subsequent "Sync" clicks
 *     go back to being fast incremental syncs anchored on lastSyncAt.
 *
 * This makes one logical "sync my whole year" operation safely span as many
 * HTTP round-trips as it needs, each one well inside the serverless timeout.
 */
export const maxDuration = 60;

const TIME_BUDGET_MS = 50_000; // leave ~10s headroom under the 60s hard cap
const BACKFILL_YEAR = 2026;

export async function POST() {
  const started = Date.now();

  const session = await auth();
  if (!session?.userId || !session.accessToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "please_sign_in_again" }, { status: 401 });
  }

  const userId = session.userId;
  const token = session.accessToken;

  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  // Resume an in-progress backfill, or start a new sync.
  let query: string;
  let pageToken: string | undefined;

  if (user.syncInProgress && user.syncQuery) {
    // Continuing a paginated backfill from where we left off.
    query = user.syncQuery;
    pageToken = user.syncCursor ?? undefined;
  } else if (!user.lastSyncAt) {
    // First-ever sync for this user: backfill the whole year to date.
    query = buildSearchQuery(startOfYearEpochSec(BACKFILL_YEAR));
  } else {
    // Routine incremental sync since the last successful run.
    query = buildSearchQuery(Math.floor(user.lastSyncAt.getTime() / 1000));
  }

  let scanned = 0;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let pagesFetched = 0;

  try {
    let nextPageToken = pageToken;
    let exhausted = false;

    while (Date.now() - started < TIME_BUDGET_MS) {
      const list = await listMessages(token, query, nextPageToken);
      pagesFetched++;
      scanned += list.messageIds.length;

      const results = await mapWithConcurrency(list.messageIds, 5, async (id) => {
        try {
          const msg = await getMessage(token, id);
          const parsed = parseEmail(msg.bodyText);
          if (!parsed) return { kind: "skip" as const };

          const sourceHash = makeSourceHash(userId, msg.id);
          const insertRes = await db
            .insert(schema.transactions)
            .values({
              userId,
              sourceHash,
              gmailMessageId: msg.id,
              bankName: parsed.bankName,
              cardLast4: parsed.cardLast4,
              amount: parsed.amount,
              currency: parsed.currency,
              merchant: parsed.merchant,
              txnType: parsed.txnType,
              timestamp: new Date(msg.internalDate),
              emailSubject: msg.subject.slice(0, 300),
              rawSnippet: parsed.rawSnippet,
            })
            .onConflictDoNothing()
            .returning({ id: schema.transactions.id });

          return insertRes.length > 0 ? { kind: "insert" as const } : { kind: "skip" as const };
        } catch (err) {
          console.error(`sync: message ${id} failed`, err);
          return { kind: "error" as const };
        }
      });

      for (const r of results) {
        if (r.kind === "insert") inserted++;
        else if (r.kind === "skip") skipped++;
        else errors++;
      }

      nextPageToken = list.nextPageToken;
      if (!nextPageToken) {
        exhausted = true;
        break;
      }
      // Loop continues to the next page as long as we're inside the time budget.
    }

    if (exhausted) {
      // Fully caught up — clear backfill state, stamp lastSyncAt.
      await db
        .update(schema.users)
        .set({
          lastSyncAt: new Date(),
          syncInProgress: false,
          syncCursor: null,
          syncQuery: null,
        })
        .where(eq(schema.users.id, userId));

      return NextResponse.json({
        done: true,
        scanned,
        inserted,
        skipped,
        errors,
        pagesFetched,
      });
    } else {
      // Ran out of time budget with more pages left — save cursor to resume.
      await db
        .update(schema.users)
        .set({
          syncInProgress: true,
          syncCursor: nextPageToken,
          syncQuery: query,
        })
        .where(eq(schema.users.id, userId));

      return NextResponse.json({
        done: false,
        scanned,
        inserted,
        skipped,
        errors,
        pagesFetched,
      });
    }
  } catch (err) {
    console.error("sync: fatal", err);
    return NextResponse.json(
      { error: "sync_failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}

/** Simple bounded-concurrency map; keeps Gmail happy and the function fast. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
