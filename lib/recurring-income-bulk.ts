import { applyAmountChange, type AmountChangeMode, roundMoney } from "@/lib/recurring-expense-series"

export type RecurringIncomeTemplateAmount = {
  id: string
  description: string
  amount: number
  is_active: boolean
}

export type IncomeAmountUpdatePreviewItem = {
  templateId: string
  description: string
  fromAmount: number
  toAmount: number
}

export type IncomeAmountUpdatePlan = {
  updates: Array<{ id: string; amount: number }>
  preview: IncomeAmountUpdatePreviewItem[]
}

export type IncomePendingOccurrence = {
  id: string
  recurring_template_id: string
  recurrence_period: string | null
  transaction_date: string
  status: "pending" | "approved" | "rejected" | null
  archived_at: string | null
}

export type IncomeDisablePreviewItem = {
  templateId: string
  description: string
  wasActive: boolean
  pendingArchived: number
}

export type IncomeDisablePlan = {
  templateIds: string[]
  archiveIds: string[]
  preview: IncomeDisablePreviewItem[]
  effectivePeriod: string
}

function monthStart(value: string) {
  return `${value.slice(0, 7)}-01`
}

function getIncomePeriod(row: IncomePendingOccurrence) {
  return row.recurrence_period || monthStart(row.transaction_date)
}

export function planRecurringIncomeAmountUpdate(params: {
  templates: RecurringIncomeTemplateAmount[]
  templateIds: string[]
  mode: AmountChangeMode
  value: number
}): IncomeAmountUpdatePlan {
  const selected = new Set(params.templateIds)
  const updates: IncomeAmountUpdatePlan["updates"] = []
  const preview: IncomeAmountUpdatePreviewItem[] = []

  for (const template of params.templates) {
    if (!selected.has(template.id)) continue
    const fromAmount = roundMoney(Number(template.amount))
    const toAmount = applyAmountChange(fromAmount, params.mode, params.value)
    updates.push({ id: template.id, amount: toAmount })
    preview.push({
      templateId: template.id,
      description: template.description,
      fromAmount,
      toAmount,
    })
  }

  return {
    updates,
    preview: preview.sort((left, right) => left.description.localeCompare(right.description, "es")),
  }
}

/**
 * Delete/disable income templates and archive pending materializations
 * from `effectivePeriod` forward. Past approved incomes stay untouched.
 */
export function planRecurringIncomeDisable(params: {
  templates: RecurringIncomeTemplateAmount[]
  templateIds: string[]
  pendingRows?: IncomePendingOccurrence[]
  effectivePeriod: string
}): IncomeDisablePlan {
  const selected = new Set(params.templateIds)
  const templateIds: string[] = []
  const preview: IncomeDisablePreviewItem[] = []
  const effectivePeriod = monthStart(params.effectivePeriod)
  const archiveIds: string[] = []
  const pendingByTemplate = new Map<string, IncomePendingOccurrence[]>()

  for (const row of params.pendingRows || []) {
    if (!row.recurring_template_id || row.archived_at || (row.status || "approved") !== "pending") continue
    if (!selected.has(row.recurring_template_id)) continue
    if (getIncomePeriod(row) < effectivePeriod) continue
    pendingByTemplate.set(
      row.recurring_template_id,
      [...(pendingByTemplate.get(row.recurring_template_id) || []), row],
    )
  }

  for (const template of params.templates) {
    if (!selected.has(template.id)) continue
    templateIds.push(template.id)
    const pending = pendingByTemplate.get(template.id) || []
    for (const row of pending) archiveIds.push(row.id)
    preview.push({
      templateId: template.id,
      description: template.description,
      wasActive: template.is_active,
      pendingArchived: pending.length,
    })
  }

  return {
    templateIds,
    archiveIds,
    effectivePeriod,
    preview: preview.sort((left, right) => left.description.localeCompare(right.description, "es")),
  }
}
