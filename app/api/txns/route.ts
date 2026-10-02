import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, schema } from "@/lib/db";
import { eq, and, desc, sql, gte } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.userId;
  const card = req.nextUrl.searchParams.get("card");

  if (card) {
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.cardLast4, card)
        )
      )
      .orderBy(desc(schema.transactions.timestamp))
      .limit(500);
    return NextResponse.json({ transactions: rows });
  }

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
        eq(schema.transactions.userId, userId),
        gte(schema.transactions.timestamp, monthStart)
      )
    )
    .groupBy(schema.transactions.cardLast4)
    .orderBy(desc(sql`MAX(${schema.transactions.timestamp})`));

  return NextResponse.json({ summaries, monthStart: monthStart.getTime() });
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
