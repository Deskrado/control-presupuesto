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

export type IncomeDisablePlan = {
  templateIds: string[]
  preview: Array<{ templateId: string; description: string; wasActive: boolean }>
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

export function planRecurringIncomeDisable(params: {
  templates: RecurringIncomeTemplateAmount[]
  templateIds: string[]
}): IncomeDisablePlan {
  const selected = new Set(params.templateIds)
  const templateIds: string[] = []
  const preview: IncomeDisablePlan["preview"] = []

  for (const template of params.templates) {
    if (!selected.has(template.id)) continue
    templateIds.push(template.id)
    preview.push({
      templateId: template.id,
      description: template.description,
      wasActive: template.is_active,
    })
  }

  return {
    templateIds,
    preview: preview.sort((left, right) => left.description.localeCompare(right.description, "es")),
  }
}
