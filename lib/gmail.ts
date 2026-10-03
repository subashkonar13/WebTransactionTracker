import { htmlToText } from "./parser";

/**
 * Minimal Gmail API wrapper using native fetch. Avoids the googleapis SDK
 * (saves ~500KB on cold start, which matters on Vercel serverless).
 *
 * All calls use the user's OAuth access token. Token refresh is handled in
 * auth.ts; by the time we're called the token is fresh.
 *
 * Scope used: gmail.readonly. We cannot modify anything in the user's inbox.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailListResult {
  messageIds: string[];
  nextPageToken?: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: number;      // epoch ms
  subject: string;
  from: string;
  bodyText: string;          // decoded + HTML-stripped
}

/**
 * The search query that finds credit-card alerts.
 * Scoped to the most common bank sender domains + transaction subject terms.
 *
 * Why not just `from:bank`? Because banks also send statements, offers, OTPs
 * from the same addresses — we rely on the parser to filter those out, but
 * narrowing by subject makes the sync much cheaper (fewer messages fetched).
 */
export function buildSearchQuery(sinceEpochSec: number | null): string {
  const senders = [
    "alerts@hdfcbank.net",
    "alerts@hdfcbank.com",
    "credit_cards@hdfcbank.net",
    "no-reply@sbicard.com",
    "sbicard.alerts@sbicard.com",
    "cc.statements@icicibank.com",
    "credit_cards@icicibank.com",
    "alerts@axisbank.com",
    "cc.statements@axisbank.com",
    "cc.email@kotak.com",
    "customercare@amexindia.com",
    "noreply@rblbank.com",
  ];
  const fromClause = `from:(${senders.join(" OR ")})`;
  const subjectHints = `subject:(spent OR debited OR charged OR transaction OR purchase OR txn OR using OR credited OR refund OR reversed)`;
  const timeClause = sinceEpochSec ? `after:${sinceEpochSec}` : `newer_than:30d`;
  return `${fromClause} ${subjectHints} ${timeClause}`;
}

export async function listMessages(
  accessToken: string,
  query: string,
  pageToken?: string
): Promise<GmailListResult> {
  const url = new URL(`${GMAIL_API}/messages`);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "100");
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await gmailFetch(accessToken, url.toString());
  if (!res.ok) throw await gmailError(res, "listMessages");
  const data = (await res.json()) as {
    messages?: { id: string }[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  };
  return {
    messageIds: (data.messages ?? []).map((m) => m.id),
    nextPageToken: data.nextPageToken,
  };
}

export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  const res = await gmailFetch(accessToken, `${GMAIL_API}/messages/${id}?format=full`);
  if (!res.ok) throw await gmailError(res, `getMessage(${id})`);
  const msg = (await res.json()) as RawGmailMessage;

  return {
    id: msg.id,
    threadId: msg.threadId,
    internalDate: Number(msg.internalDate ?? Date.now()),
    subject: header(msg, "Subject") ?? "",
    from: header(msg, "From") ?? "",
    bodyText: extractBodyText(msg.payload),
  };
}

// --- internals ---

async function gmailFetch(accessToken: string, url: string): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // Gmail is reliable; a short timeout prevents hung serverless invocations.
    signal: AbortSignal.timeout(15_000),
  });
}

async function gmailError(res: Response, where: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`Gmail ${where} failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
}

interface RawGmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload: GmailPayload;
}

interface GmailPayload {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

function header(msg: RawGmailMessage, name: string): string | undefined {
  const h = msg.payload.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value;
}

/**
 * Walks the MIME tree. Preference order:
 *   1. text/plain (cleanest)
 *   2. text/html (strip tags)
 *   3. first part with a body
 *
 * Concatenates all parts of the preferred type found; multipart/alternative
 * usually has both plain and html, in which case plain wins.
 */
function extractBodyText(payload: GmailPayload): string {
  const plain: string[] = [];
  const html: string[] = [];
  walk(payload, plain, html);
  if (plain.length) return plain.join("\n").trim();
  if (html.length) return htmlToText(html.join("\n"));
  return "";
}

function walk(p: GmailPayload, plain: string[], html: string[]): void {
  const mt = (p.mimeType ?? "").toLowerCase();
  if (mt.startsWith("multipart/") && p.parts) {
    for (const part of p.parts) walk(part, plain, html);
    return;
  }
  const data = p.body?.data;
  if (!data) return;
  const decoded = decodeBase64Url(data);
  if (mt === "text/plain") plain.push(decoded);
  else if (mt === "text/html") html.push(decoded);
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(normalized, "base64").toString("utf-8");
  } catch {
    return "";
  }
}
