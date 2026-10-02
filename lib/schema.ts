import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * One row per Google user. Keyed by the sub claim from their ID token.
 * We never store the OAuth refresh token itself here — Auth.js keeps that in
 * its own encrypted session. This table only identifies "whose data this is"
 * for the transactions table below.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),               // Google sub claim
  email: text("email").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
});

/**
 * A single parsed transaction.
 *
 * sourceHash is SHA-256(userId + gmailMessageId) — unique per (user, email).
 * Re-syncing the same inbox will IGNORE on conflict, so we never double-count.
 *
 * All amounts in paise (integer) to avoid floating-point drift. Divide by 100
 * for display. Negative values would be refunds in a signed model; we instead
 * use txnType to classify so the amount is always a positive magnitude.
 */
export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceHash: text("source_hash").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    bankName: text("bank_name"),
    cardLast4: text("card_last4").notNull(),
    amount: real("amount").notNull(),         // in rupees, 2 decimal places
    currency: text("currency").notNull().default("INR"),
    merchant: text("merchant"),
    txnType: text("txn_type", { enum: ["DEBIT", "CREDIT", "PAYMENT", "UNKNOWN"] }).notNull(),
    timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
    emailSubject: text("email_subject"),
    rawSnippet: text("raw_snippet"),          // first 500 chars of body for audit
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    uniqSource: uniqueIndex("uniq_user_source").on(t.userId, t.sourceHash),
    byUserCard: index("by_user_card").on(t.userId, t.cardLast4),
    byUserTime: index("by_user_time").on(t.userId, t.timestamp),
  })
);

export type User = typeof users.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
