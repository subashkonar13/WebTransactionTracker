import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, schema } from "@/lib/db";
import { buildSearchQuery, listMessages, getMessage } from "@/lib/gmail";
import { parseEmail, makeSourceHash } from "@/lib/parser";
import { eq } from "drizzle-orm";

export const maxDuration = 60;

export async function POST() {
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
  const sinceEpochSec = user?.lastSyncAt
    ? Math.floor(user.lastSyncAt.getTime() / 1000)
    : null;

  const query = buildSearchQuery(sinceEpochSec);
  let scanned = 0, inserted = 0, skipped = 0, errors = 0;

  try {
    const list = await listMessages(token, query);
    scanned = list.messageIds.length;

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

        return insertRes.length > 0
          ? { kind: "insert" as const }
          : { kind: "skip" as const };
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

    await db
      .update(schema.users)
      .set({ lastSyncAt: new Date() })
      .where(eq(schema.users.id, userId));

    return NextResponse.json({ scanned, inserted, skipped, errors });
  } catch (err) {
    console.error("sync: fatal", err);
    return NextResponse.json(
      { error: "sync_failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}

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
