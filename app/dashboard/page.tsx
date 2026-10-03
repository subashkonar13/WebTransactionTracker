import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { db, schema } from "@/lib/db";
import { eq, and, desc, sql, gte, lt } from "drizzle-orm";
import { formatINR, formatDate } from "@/lib/format";
import SyncButton from "@/components/SyncButton";

export const dynamic = "force-dynamic";

const YEAR = 2026;
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const session = await auth();
  if (!session?.userId) redirect("/");
  const userId = session.userId;

  const { month } = await searchParams;
  // month is "1".."12" (1-indexed) when a specific month is selected, or
  // undefined to show the whole year (Jan 1 -> now) aggregated together.
  const selectedMonth = month ? parseInt(month, 10) : null;

  const yearStart = new Date(YEAR, 0, 1);
  const rangeStart = selectedMonth ? new Date(YEAR, selectedMonth - 1, 1) : yearStart;
  const rangeEnd = selectedMonth ? new Date(YEAR, selectedMonth, 1) : new Date(YEAR + 1, 0, 1);

  // Per-card totals within the selected range (whole year, or one month).
  const summaries = await db
    .select({
      cardLast4: schema.transactions.cardLast4,
      bankName: sql<string | null>`MAX(${schema.transactions.bankName})`,
      txnCount: sql<number>`COUNT(*)`,
      totalSpend: sql<number>`
        COALESCE(SUM(CASE WHEN ${schema.transactions.txnType} = 'DEBIT'
                          THEN ${schema.transactions.amount} ELSE 0 END), 0)
      `,
      totalCredits: sql<number>`
        COALESCE(SUM(CASE WHEN ${schema.transactions.txnType} IN ('CREDIT','PAYMENT')
                          THEN ${schema.transactions.amount} ELSE 0 END), 0)
      `,
      lastTxnAt: sql<number>`MAX(${schema.transactions.timestamp})`,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        gte(schema.transactions.timestamp, rangeStart),
        lt(schema.transactions.timestamp, rangeEnd)
      )
    )
    .groupBy(schema.transactions.cardLast4)
    .orderBy(desc(sql`MAX(${schema.transactions.timestamp})`));

  // Month-by-month totals across the whole year, used for the month-picker
  // row so you can see at a glance which months had spend, then drill in.
  const monthly = await db
    .select({
      ym: sql<string>`strftime('%Y-%m', datetime(${schema.transactions.timestamp} / 1000, 'unixepoch'))`,
      totalSpend: sql<number>`
        COALESCE(SUM(CASE WHEN ${schema.transactions.txnType} = 'DEBIT'
                          THEN ${schema.transactions.amount} ELSE 0 END), 0)
      `,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        gte(schema.transactions.timestamp, yearStart),
        lt(schema.transactions.timestamp, new Date(YEAR + 1, 0, 1))
      )
    )
    .groupBy(sql`strftime('%Y-%m', datetime(${schema.transactions.timestamp} / 1000, 'unixepoch'))`);

  const monthlyMap = new Map(monthly.map((m) => [m.ym, Number(m.totalSpend)]));
  const currentMonthIdx = new Date().getFullYear() === YEAR ? new Date().getMonth() : 11;

  const grandTotal = summaries.reduce((acc, s) => acc + Number(s.totalSpend), 0);

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-900">Transaction Tracker</h1>
          <div className="flex items-center gap-2">
            <SyncButton />
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-md hover:bg-slate-100"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <section className="max-w-4xl mx-auto px-4 py-6">
        <p className="text-xs uppercase tracking-wider text-slate-500">
          {selectedMonth ? `${MONTH_NAMES[selectedMonth - 1]} ${YEAR}` : `${YEAR} (Jan – now)`}
        </p>
        <p className="mt-1 text-4xl font-bold text-brand-700 tabular-nums">
          {formatINR(grandTotal)}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          Total spent across all cards
          {selectedMonth ? "" : " this year"}
        </p>
      </section>

      {/* Month picker: All + Jan..current month, each a link that sets ?month= */}
      <section className="max-w-4xl mx-auto px-4 pb-2 overflow-x-auto">
        <div className="flex gap-2 w-max">
          <MonthChip
            label="All"
            href="/dashboard"
            active={selectedMonth === null}
          />
          {Array.from({ length: currentMonthIdx + 1 }, (_, i) => i).map((i) => (
            <MonthChip
              key={i}
              label={MONTH_NAMES[i]}
              href={`/dashboard?month=${i + 1}`}
              active={selectedMonth === i + 1}
              amount={monthlyMap.get(`${YEAR}-${String(i + 1).padStart(2, "0")}`)}
            />
          ))}
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-4 py-4 pb-16">
        {summaries.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {summaries.map((s) => (
              <Link
                key={s.cardLast4}
                href={`/dashboard/card/${s.cardLast4}${selectedMonth ? `?month=${selectedMonth}` : ""}`}
                className="group bg-white rounded-xl border border-slate-200 p-5 hover:shadow-md transition"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-500">
                      {s.bankName ?? "Card"}
                    </p>
                    <p className="text-lg font-semibold text-slate-900 tabular-nums">
                      •••• {s.cardLast4}
                    </p>
                  </div>
                  <span className="text-xs text-slate-400">
                    {Number(s.txnCount)} txns
                  </span>
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <p className="text-xs text-slate-500">Spent</p>
                    <p className="text-xl font-semibold text-slate-900 tabular-nums">
                      {formatINR(Number(s.totalSpend))}
                    </p>
                  </div>
                  <div className="text-right">
                    {Number(s.totalCredits) > 0 && (
                      <p className="text-xs text-emerald-700 tabular-nums">
                        -{formatINR(Number(s.totalCredits))}
                      </p>
                    )}
                    <p className="text-xs text-slate-400 mt-1">
                      last {formatDate(Number(s.lastTxnAt))}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function MonthChip({
  label,
  href,
  active,
  amount,
}: {
  label: string;
  href: string;
  active: boolean;
  amount?: number;
}) {
  return (
    <Link
      href={href}
      className={
        "flex-shrink-0 rounded-lg px-3 py-2 text-xs border transition " +
        (active
          ? "bg-brand-600 border-brand-600 text-white"
          : "bg-white border-slate-200 text-slate-600 hover:border-brand-300")
      }
    >
      <div className="font-medium">{label}</div>
      {amount !== undefined && amount > 0 && (
        <div className={active ? "text-white/80" : "text-slate-400"}>
          {formatINR(amount)}
        </div>
      )}
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
      <h2 className="text-lg font-semibold text-slate-900">No transactions yet</h2>
      <p className="mt-2 text-sm text-slate-600 max-w-md mx-auto">
        Click <span className="font-medium">Sync</span> at the top to pull your
        {YEAR} credit-card alerts from Gmail. A full year can take a few
        rounds of syncing — the button will say &ldquo;Fetching more…&rdquo;
        and keep going automatically until it&apos;s caught up.
      </p>
    </div>
  );
}
