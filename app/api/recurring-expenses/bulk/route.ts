import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { toDateOnly } from "@/lib/date-only"
import {
  planRecurringExpenseAmountUpdate,
  planRecurringExpenseSeriesDisable,
  summarizeRecurringExpenseSeries,
  type AmountChangeMode,
  type RecurringExpenseOccurrence,
} from "@/lib/recurring-expense-series"

const PAGE_SIZE = 1000

async function loadRecurringExpenseRows(supabase: Awaited<ReturnType<typeof createClient>>) {
  const rows: RecurringExpenseOccurrence[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("transactions")
      .select(`
        id,
        user_id,
        family_id,
        description,
        amount,
        budgeted_amount,
        currency_id,
        category_id,
        group_id,
        transaction_date,
        payment_method,
        credit_card_id,
        credit_card_purchase_id,
        installment_number,
        status,
        metadata,
        archived_at,
        recurring_series_id,
        recurrence_period
      `)
      .eq("type", "expense")
      .eq("is_recurring", true)
      .order("transaction_date", { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...((data || []) as RecurringExpenseOccurrence[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

function parseSeriesIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return null
  const ids = value.map((item) => String(item || "").trim()).filter(Boolean)
  return ids.length > 0 ? Array.from(new Set(ids)) : null
}

function parseEffectivePeriod(body: Record<string, unknown>) {
  const today = new Date()
  const month = Number(body.month || today.getMonth() + 1)
  const year = Number(body.year || today.getFullYear())
  if (month < 1 || month > 12 || year < 2000 || year > 2100) {
    throw new Error("Periodo inválido")
  }
  return toDateOnly(year, month, 1)
}

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const rows = await loadRecurringExpenseRows(supabase)
    return NextResponse.json({
      ok: true,
      series: summarizeRecurringExpenseSeries(rows),
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al listar recurrentes" },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action || "")
    const seriesIds = parseSeriesIds(body.seriesIds)
    if (!seriesIds) {
      return NextResponse.json({ error: "Selecciona al menos un recurrente" }, { status: 400 })
    }

    const effectivePeriod = parseEffectivePeriod(body)
    const rows = await loadRecurringExpenseRows(supabase)
    const dryRun = Boolean(body.dryRun)

    if (action === "update-amount") {
      const mode = String(body.mode || "") as AmountChangeMode
      const value = Number(body.value)
      if (mode !== "absolute" && mode !== "percent") {
        return NextResponse.json({ error: "Modo de actualización inválido" }, { status: 400 })
      }
      if (!Number.isFinite(value)) {
        return NextResponse.json({ error: "Valor de monto inválido" }, { status: 400 })
      }

      const plan = planRecurringExpenseAmountUpdate({
        rows,
        seriesIds,
        mode,
        value,
        effectivePeriod,
      })

      if (dryRun) {
        return NextResponse.json({ ok: true, dryRun: true, preview: plan.preview, updateCount: plan.updates.length })
      }

      let updated = 0
      for (const item of plan.updates) {
        const { error } = await supabase.from("transactions").update(item.payload).eq("id", item.id)
        if (error) throw error
        updated += 1
      }

      return NextResponse.json({
        ok: true,
        updated,
        preview: plan.preview,
      })
    }

    if (action === "disable") {
      const plan = planRecurringExpenseSeriesDisable({
        rows,
        seriesIds,
        effectivePeriod,
      })

      if (dryRun) {
        return NextResponse.json({
          ok: true,
          dryRun: true,
          preview: plan.preview,
          archiveCount: plan.archiveIds.length,
          endDateUpdateCount: plan.endDateUpdates.length,
        })
      }

      const archivedAt = new Date().toISOString()
      let archived = 0
      let ended = 0

      if (plan.archiveIds.length > 0) {
        const { error, count } = await supabase
          .from("transactions")
          .update({ archived_at: archivedAt }, { count: "exact" })
          .in("id", plan.archiveIds)
          .is("archived_at", null)
        if (error) throw error
        archived = count || plan.archiveIds.length
      }

      for (const item of plan.endDateUpdates) {
        const { error } = await supabase.from("transactions").update(item.payload).eq("id", item.id)
        if (error) throw error
        ended += 1
      }

      return NextResponse.json({
        ok: true,
        archived,
        ended,
        preview: plan.preview,
      })
    }

    return NextResponse.json({ error: "Acción no soportada" }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error en operación masiva de recurrentes" },
      { status: 500 },
    )
  }
}
