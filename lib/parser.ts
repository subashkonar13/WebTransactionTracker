import crypto from "crypto";

/**
 * Parses credit-card transaction emails from Indian banks into structured records.
 *
 * Design parallels the Kotlin SMS parser in the Android app:
 *  - Noise filters first (short-circuit)
 *  - Amount + card-last-4 required (precision over recall)
 *  - Rule-based regex only, no ML
 *
 * Email-specific additions on top of the SMS parser:
 *  - HTML stripping (bank emails are HTML with inline CSS)
 *  - Reply-chain truncation (don't parse forwarded content)
 *  - Longer noise list (emails carry marketing fluff SMS does not)
 */

export type TxnType = "DEBIT" | "CREDIT" | "PAYMENT" | "UNKNOWN";

export interface ParsedTxn {
  cardLast4: string;
  amount: number;             // positive rupees
  currency: "INR";
  merchant: string | null;
  bankName: string | null;
  txnType: TxnType;
  rawSnippet: string;         // first 500 chars for audit
}

// --- Noise filters (short-circuit before regex) ---

const NOISE_PHRASES: string[] = [
  "otp", "one time password", "verification code", "do not share",
  "statement is generated", "statement for your", "e-statement", "estatement",
  "due date", "minimum amount due", "total amount due", "payment due",
  "reward points balance", "redeem your points", "points earned",
  "pre-approved", "pre approved", "congratulations you have been",
  "limit has been increased", "credit limit increase",
  "card blocked", "card has been blocked", "disputed transaction",
  "unsubscribe", "promotional email",
];

const TXN_KEYWORDS: string[] = [
  "spent", "debited", "debit", "charged", "paid",
  "purchase", "purchased", "transaction", "txn", "using",
  "credited", "refund", "reversed", "withdrawn",
  "payment received", "received towards",
];

// --- Regex patterns (same as Kotlin, JS-flavoured) ---

const AMOUNT_RE = /(?:rs\.?|inr|₹)\s*([0-9][0-9,]{0,15}(?:\.[0-9]{1,2})?)/i;

const CARD_RE =
  /(?:ending(?:\s+with)?|card(?:\s+(?:no\.?|number|ending))?|a\/c|ac\s+no\.?|acc?t|acct\s+no\.?)\s*[:\-]?\s*(?:x+|\*+)?\s*([0-9]{4})\b/i;

const CARD_MASK_RE = /(?:x{2,}|\*{2,})\s*([0-9]{4})\b/i;

/**
 * Merchant extraction tries several phrasings, in order, first match wins.
 * SMS tends to be one prose sentence ("...at AMAZON on 12-01..."); email
 * alerts are often a structured card/table ("Merchant Name: AMAZON") with
 * no connecting prose at all. We cover both.
 *
 * All patterns are run against a whitespace-FLATTENED copy of the text (see
 * parseEmail) so that HTML-induced line breaks between a label and its value
 * — which happens routinely once a <table>/<td> layout gets stripped to
 * plain text — don't prevent a match. `.` in JS regex does not cross "\n"
 * without the /s flag, so flattening is cheaper and safer than adding /s to
 * every pattern here.
 */
const MERCHANT_PATTERNS: RegExp[] = [
  // "...at AMAZON on 12-01..." / "...at AMAZON, Info:..."
  /\bat\s+([A-Za-z0-9&.\-_*,' ]{2,60}?)(?=\s+on\b|\s+info\b|\s+ref\b|[.,;]|$)/i,
  // "...paid to AMAZON on..." / "...transferred to AMAZON..."
  /\b(?:paid|transferred|sent)\s+to\s+([A-Za-z0-9&.\-_*,' ]{2,60}?)(?=\s+on\b|\s+info\b|\s+ref\b|[.,;]|$)/i,
  // Structured label: "Merchant Name: AMAZON", "Merchant: AMAZON", "Payee Name - AMAZON"
  /\b(?:merchant(?:\s+name)?|payee(?:\s+name)?)\s*[:\-]\s*([A-Za-z0-9&.\-_*,' ]{2,60}?)(?=\s{2,}|[.,;\n]|$)/i,
  // "...towards AMAZON..."
  /\btowards\s+([A-Za-z0-9&.\-_*,' ]{2,60}?)(?=\s+on\b|\s+info\b|\s+ref\b|[.,;]|$)/i,
];

function extractMerchant(flatText: string): string | null {
  for (const re of MERCHANT_PATTERNS) {
    const m = flatText.match(re);
    if (m && m[1]) {
      const cleaned = cleanMerchant(m[1]);
      // Reject obviously-wrong captures (bank's own name, generic words).
      if (cleaned.length >= 2 && !/^(the|your|is|was|for|rs|inr)$/i.test(cleaned)) {
        return cleaned;
      }
    }
  }
  return null;
}

const BANK_SIGNATURES: Record<string, string[]> = {
  HDFC: ["hdfc"],
  ICICI: ["icici"],
  SBI: ["sbi card", "sbicard", "state bank"],
  AXIS: ["axis bank", "axis "],
  KOTAK: ["kotak"],
  AMEX: ["american express", "amex"],
  RBL: ["rbl bank", "rblbank"],
  YES: ["yes bank"],
  IDFC: ["idfc"],
  INDUSIND: ["indusind"],
  CITI: ["citibank", "citi bank"],
};

const CREDIT_HINTS = ["credited", "refund", "reversed", "cashback", "received towards"];
const PAYMENT_HINTS = ["payment received", "bill paid", "neft received"];

// --- Public API ---

/**
 * Parse raw email text (plain or stripped HTML). Returns null if the email
 * doesn't look like a transaction notification.
 */
export function parseEmail(rawText: string): ParsedTxn | null {
  if (!rawText) return null;

  // Truncate reply-chains — only parse the top message.
  const text = truncateReplyChain(rawText).trim();
  if (text.length < 15) return null;

  // Flatten ALL whitespace (including newlines from HTML <br>/<td> stripping)
  // to single spaces before running any extraction regex. Bank email alerts
  // are frequently rendered as a label/value table; once stripped to plain
  // text, "Merchant Name" and its value can end up on separate lines, which
  // would otherwise silently break a match since `.` doesn't cross "\n".
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();

  if (NOISE_PHRASES.some((p) => lower.includes(p))) return null;
  if (!TXN_KEYWORDS.some((k) => lower.includes(k))) return null;

  const amountMatch = flat.match(AMOUNT_RE);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1].replace(/,/g, ""));
  if (!isFinite(amount) || amount <= 0) return null;

  const cardMatch = flat.match(CARD_RE) ?? flat.match(CARD_MASK_RE);
  if (!cardMatch) return null;
  const cardLast4 = cardMatch[1];

  const merchant = extractMerchant(flat);

  const bankName = detectBank(lower);
  const txnType = classify(lower);

  return {
    cardLast4,
    amount,
    currency: "INR",
    merchant,
    bankName,
    txnType,
    rawSnippet: text.slice(0, 500),
  };
}

/**
 * Strip HTML tags, decode common entities, collapse whitespace.
 * Not perfect — just good enough to let the regex engine find the text.
 */
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Deterministic dedupe key. We salt with userId so two users with the same
 * Gmail message ID (impossible in practice, but defensive) don't collide.
 */
export function makeSourceHash(userId: string, gmailMessageId: string): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}|${gmailMessageId}`)
    .digest("hex");
}

// --- Internals ---

function truncateReplyChain(text: string): string {
  // Cut at the first "On <date> ... wrote:" or "-----Original Message-----"
  // or "From: ... Sent:" quoted-header pattern.
  const markers = [
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\nOn .+ wrote:/,
    /\nFrom:\s.+\nSent:\s/i,
    /\nForwarded message/i,
  ];
  let cut = text.length;
  for (const re of markers) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut);
}

function classify(lower: string): TxnType {
  if (PAYMENT_HINTS.some((p) => lower.includes(p))) return "PAYMENT";
  if (CREDIT_HINTS.some((h) => lower.includes(h))) return "CREDIT";
  return "DEBIT";
}

function detectBank(lower: string): string | null {
  for (const [name, needles] of Object.entries(BANK_SIGNATURES)) {
    if (needles.some((n) => lower.includes(n))) return name;
  }
  return null;
}

function cleanMerchant(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/^[\s,.;:*\-]+|[\s,.;:*\-]+$/g, "").slice(0, 80);
}
