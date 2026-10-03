import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { db, schema } from "@/lib/db";
import { eq, and, desc, gte, lt } from "drizzle-orm";
import { formatINR, formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const YEAR = 2026;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default async function CardDetail({
  params,
  searchParams,
}: {
  params: Promise<{ last4: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const session = await auth();
  if (!session?.userId) redirect("/");

  const { last4 } = await params;
  if (!/^\d{4}$/.test(last4)) notFound();

  const { month } = await searchParams;
  const selectedMonth = month ? parseInt(month, 10) : null;

  const conditions = [
    eq(schema.transactions.userId, session.userId),
    eq(schema.transactions.cardLast4, last4),
  ];
  if (selectedMonth) {
    conditions.push(gte(schema.transactions.timestamp, new Date(YEAR, selectedMonth - 1, 1)));
    conditions.push(lt(schema.transactions.timestamp, new Date(YEAR, selectedMonth, 1)));
  }

  const txns = await db
    .select()
    .from(schema.transactions)
    .where(and(...conditions))
    .orderBy(desc(schema.transactions.timestamp))
    .limit(2000); // a full year of one card's transactions comfortably fits

  const spent = txns.filter((t) => t.txnType === "DEBIT").reduce((a, t) => a + t.amount, 0);
  const credits = txns
    .filter((t) => t.txnType === "CREDIT" || t.txnType === "PAYMENT")
    .reduce((a, t) => a + t.amount, 0);
  const bank = txns.find((t) => t.bankName)?.bankName ?? "Card";

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href={selectedMonth ? `/dashboard?month=${selectedMonth}` : "/dashboard"}
            className="text-slate-600 hover:text-slate-900 text-sm"
          >
            ← Back
          </Link>
          <h1 className="text-lg font-semibold text-slate-900">
            {bank} •••• {last4}
          </h1>
          {selectedMonth && (
            <span className="text-sm text-slate-500">
              — {MONTH_NAMES[selectedMonth - 1]} {YEAR}
            </span>
          )}
        </div>
      </header>

      <section className="max-w-4xl mx-auto px-4 py-6">
        <div className="grid grid-cols-3 gap-3">
          <Stat label={selectedMonth ? "Spent (month)" : "Spent (year)"} value={formatINR(spent)} />
          <Stat label="Credited" value={formatINR(credits)} tone="credit" />
          <Stat label="Transactions" value={String(txns.length)} />
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-4 pb-16">
        {txns.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-500">
            No transactions for this card{selectedMonth ? " in this month" : ""}.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 bg-white rounded-xl border border-slate-200">
            {txns.map((t) => (
              <li key={t.id} className="px-5 py-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900 truncate">
                    {t.merchant ?? "Unknown merchant"}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {formatDateTime(t.timestamp.getTime())}
                    {t.bankName && <> · {t.bankName}</>}
                  </p>
                </div>
                <p
                  className={
                    "tabular-nums font-semibold whitespace-nowrap " +
                    (t.txnType === "DEBIT" ? "text-slate-900" : "text-emerald-700")
                  }
                >
                  {t.txnType === "DEBIT" ? "" : "+ "}
                  {formatINR(t.amount, true)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "credit";
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={
          "mt-1 text-xl font-semibold tabular-nums " +
          (tone === "credit" ? "text-emerald-700" : "text-slate-900")
        }
      >
        {value}
      </p>
    </div>
  );
}
