import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { db, schema } from "@/lib/db";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import { formatINR, formatDate, formatMonthYear } from "@/lib/format";
import SyncButton from "@/components/SyncButton";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.userId) redirect("/");

  const monthStart = startOfMonth(new Date());

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
        eq(schema.transactions.userId, session.userId),
        gte(schema.transactions.timestamp, monthStart)
      )
    )
    .groupBy(schema.transactions.cardLast4)
    .orderBy(desc(sql`MAX(${schema.transactions.timestamp})`));

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
          {formatMonthYear()}
        </p>
        <p className="mt-1 text-4xl font-bold text-brand-700 tabular-nums">
          {formatINR(grandTotal)}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          Total spent across all cards this month
        </p>
      </section>

      <section className="max-w-4xl mx-auto px-4 pb-16">
        {summaries.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {summaries.map((s) => (
              <Link
                key={s.cardLast4}
                href={`/dashboard/card/${s.cardLast4}`}
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

function EmptyState() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
      <h2 className="text-lg font-semibold text-slate-900">No transactions yet</h2>
      <p className="mt-2 text-sm text-slate-600 max-w-md mx-auto">
        Click <span className="font-medium">Sync</span> at the top to pull your
        last 30 days of credit-card alerts from Gmail. First sync may take up
        to a minute.
      </p>
    </div>
  );
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
