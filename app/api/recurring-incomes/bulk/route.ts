import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  planRecurringIncomeAmountUpdate,
  planRecurringIncomeDisable,
} from "@/lib/recurring-income-bulk"
import type { AmountChangeMode } from "@/lib/recurring-expense-series"

function parseTemplateIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return null
  const ids = value.map((item) => String(item || "").trim()).filter(Boolean)
  return ids.length > 0 ? Array.from(new Set(ids)) : null
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action || "")
    const templateIds = parseTemplateIds(body.templateIds)
    if (!templateIds) {
      return NextResponse.json({ error: "Selecciona al menos un recurrente" }, { status: 400 })
    }

    const { data: templates, error: templatesError } = await supabase
      .from("recurring_income_templates")
      .select("id, description, amount, is_active")
      .in("id", templateIds)
    if (templatesError) throw templatesError

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

      const plan = planRecurringIncomeAmountUpdate({
        templates: templates || [],
        templateIds,
        mode,
        value,
      })

      if (dryRun) {
        return NextResponse.json({ ok: true, dryRun: true, preview: plan.preview, updateCount: plan.updates.length })
      }

      let updated = 0
      for (const item of plan.updates) {
        const { error } = await supabase
          .from("recurring_income_templates")
          .update({ amount: item.amount })
          .eq("id", item.id)
        if (error) throw error
        updated += 1
      }

      // Keep already-materialized pending incomes aligned with the new template amount.
      if (plan.updates.length > 0) {
        const archivedAtFilter = null
        for (const item of plan.updates) {
          const { error } = await supabase
            .from("transactions")
            .update({
              amount: item.amount,
              budgeted_amount: item.amount,
            })
            .eq("recurring_template_id", item.id)
            .eq("status", "pending")
            .is("archived_at", archivedAtFilter)
          if (error) throw error
        }
      }

      return NextResponse.json({ ok: true, updated, preview: plan.preview })
    }

    if (action === "disable" || action === "delete") {
      const plan = planRecurringIncomeDisable({
        templates: templates || [],
        templateIds,
      })

      if (dryRun) {
        return NextResponse.json({
          ok: true,
          dryRun: true,
          preview: plan.preview,
          action,
        })
      }

      const archivedAt = new Date().toISOString()
      if (plan.templateIds.length > 0) {
        const { error: archiveError } = await supabase
          .from("transactions")
          .update({ archived_at: archivedAt })
          .in("recurring_template_id", plan.templateIds)
          .eq("status", "pending")
          .is("archived_at", null)
        if (archiveError) throw archiveError
      }

      if (action === "disable") {
        const { error } = await supabase
          .from("recurring_income_templates")
          .update({ is_active: false })
          .in("id", plan.templateIds)
        if (error) throw error
        return NextResponse.json({ ok: true, disabled: plan.templateIds.length, preview: plan.preview })
      }

      const { error } = await supabase
        .from("recurring_income_templates")
        .delete()
        .in("id", plan.templateIds)
      if (error) throw error
      return NextResponse.json({ ok: true, deleted: plan.templateIds.length, preview: plan.preview })
    }

    return NextResponse.json({ error: "Acción no soportada" }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error en operación masiva de ingresos recurrentes" },
      { status: 500 },
    )
  }
}
