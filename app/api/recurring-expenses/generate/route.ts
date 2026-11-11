import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCreditCardStatementDueDate } from "@/lib/credit-card-billing"
import { toDateOnly } from "@/lib/date-only"
import {
  getRecurringExpenseEndDate,
  getRecurringExpenseOccurrenceDate,
  getRecurringExpensePeriod,
  getRecurringExpenseSeedAmounts,
  getRecurringExpenseSeriesId,
  groupRecurringExpenseSeries,
  type RecurringExpenseOccurrence,
} from "@/lib/recurring-expense-series"

type RecurringExpenseRow = RecurringExpenseOccurrence & {
  is_recurring: boolean
  notes: string | null
  credit_card: { closing_day: number | null; due_day: number | null } | null
}

const PAGE_SIZE = 1000

function getDay(value: string) {
  const day = Number(value.slice(8, 10))
  return Number.isFinite(day) && day > 0 ? day : 1
}

function cleanMetadata(metadata: Record<string, unknown> | null) {
  const {
    approved_amount_change: _approvedAmountChange,
    bulk_amount_change: _bulkAmountChange,
    bulk_disabled_at: _bulkDisabledAt,
    bulk_disabled_from_period: _bulkDisabledFromPeriod,
    generated_at: _generatedAt,
    generated_for: _generatedFor,
    generated_from_transaction_id: _generatedFrom,
    recurrence_index: _recurrenceIndex,
    purchase_date: _purchaseDate,
    billing_date: _billingDate,
    scheduled_date: _scheduledDate,
    ...rest
  } = metadata || {}
  return rest
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const today = new Date()
    const month = Number(body.month || today.getMonth() + 1)
    const year = Number(body.year || today.getFullYear())
    if (month < 1 || month > 12 || year < 2000 || year > 2100) {
      return NextResponse.json({ error: "Periodo inválido" }, { status: 400 })
    }

    // RLS supplies the family boundary. Deliberately do not filter by user_id:
    // any family member may trigger materialization, but ownership remains with
    // the member who created the series.
    const rows: RecurringExpenseRow[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("transactions")
        .select("*, credit_card:credit_cards(closing_day, due_day)")
        .eq("type", "expense")
        .eq("is_recurring", true)
        .order("transaction_date", { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw error

      rows.push(...((data || []) as unknown as RecurringExpenseRow[]))
      if (!data || data.length < PAGE_SIZE) break
    }
    const rowsBySeries = groupRecurringExpenseSeries(rows)

    const requestedPeriod = toDateOnly(year, month, 1)
    const previousDate = new Date(year, month - 2, 1)
    const previousPeriod = toDateOnly(previousDate.getFullYear(), previousDate.getMonth() + 1, 1)
    const inserts: Record<string, unknown>[] = []

    for (const [seriesId, seriesRows] of rowsBySeries) {
      const activeRows = seriesRows.filter((row) => !row.archived_at && row.status !== "rejected")
      if (activeRows.length === 0) continue

      const periods = activeRows.some((row) => row.payment_method === "credit")
        ? [previousPeriod, requestedPeriod]
        : [requestedPeriod]

      for (const period of periods) {
        // Archived/rejected rows are tombstones too: once a period existed it
        // must not silently reappear on a later dashboard load.
        if (seriesRows.some((row) => getRecurringExpensePeriod(row) === period)) continue

        const source = [...activeRows]
          .filter((row) => getRecurringExpensePeriod(row) < period)
          .sort((a, b) => getRecurringExpensePeriod(b).localeCompare(getRecurringExpensePeriod(a)))[0]
        if (!source) continue

        const occurrenceDate = toDateOnly(Number(period.slice(0, 4)), Number(period.slice(5, 7)), getDay(getRecurringExpenseOccurrenceDate(source)))
        const endDate = getRecurringExpenseEndDate(source)
        if (endDate && occurrenceDate > endDate) continue

        const isCardDebit = source.payment_method === "credit" && source.credit_card_id
        const transactionDate = isCardDebit
          ? getCreditCardStatementDueDate(occurrenceDate, (source as RecurringExpenseRow).credit_card)
          : occurrenceDate
        const seedAmounts = getRecurringExpenseSeedAmounts(source)
        const metadata = {
          ...cleanMetadata(source.metadata),
          source: isCardDebit ? "recurring_card_debit" : "recurring_expense",
          recurring_series_id: seriesId || getRecurringExpenseSeriesId(source),
          ...(isCardDebit
            ? { purchase_date: occurrenceDate, billing_date: transactionDate, billing_rule: "credit_card_statement_due" }
            : { scheduled_date: occurrenceDate }),
          generated_at: new Date().toISOString(),
          generated_for: period.slice(0, 7),
          generated_from_transaction_id: source.id,
        }

        inserts.push({
          user_id: source.user_id,
          family_id: source.family_id,
          created_by: user.id,
          description: source.description,
          amount: seedAmounts.amount,
          budgeted_amount: seedAmounts.budgeted_amount,
          currency_id: source.currency_id,
          category_id: source.category_id,
          group_id: source.group_id,
          transaction_date: transactionDate,
          type: "expense",
          is_recurring: true,
          payment_method: source.payment_method,
          credit_card_id: source.credit_card_id,
          status: "pending",
          approved_at: null,
          approved_by: null,
          notes: (source as RecurringExpenseRow).notes,
          recurring_series_id: seriesId || getRecurringExpenseSeriesId(source),
          recurrence_period: period,
          metadata,
        })
      }
    }

    let created = 0
    if (inserts.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from("transactions")
        .upsert(inserts, { onConflict: "recurring_series_id,recurrence_period", ignoreDuplicates: true })
        .select("id")
      if (insertError) throw insertError
      created = inserted?.length || 0
    }

    return NextResponse.json({ ok: true, created, skipped: Math.max(0, inserts.length - created) })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al generar gastos recurrentes" },
      { status: 500 },
    )
  }
}
