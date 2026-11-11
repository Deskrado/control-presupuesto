import { createHash } from "node:crypto"

export type RecurringExpenseOccurrence = {
  id: string
  user_id: string
  family_id: string | null
  description: string
  amount: number
  budgeted_amount: number | null
  currency_id: string | null
  category_id: string | null
  group_id: string | null
  transaction_date: string
  payment_method: "cash" | "debit" | "credit" | "transfer" | null
  credit_card_id: string | null
  credit_card_purchase_id?: string | null
  installment_number?: number | null
  status: "pending" | "approved" | "rejected" | null
  metadata: Record<string, unknown> | null
  archived_at: string | null
  recurring_series_id: string | null
  recurrence_period: string | null
}

export type AmountChangeMode = "absolute" | "percent"

export type RecurringExpenseSeriesSummary = {
  seriesId: string
  description: string
  currentAmount: number
  currencyId: string | null
  paymentMethod: RecurringExpenseOccurrence["payment_method"]
  creditCardId: string | null
  categoryId: string | null
  groupId: string | null
  isAutomaticDebit: boolean
  latestPeriod: string
  endDate: string | null
  pendingCount: number
  approvedCount: number
  activeCount: number
  seedId: string
}

export type AmountUpdatePreviewItem = {
  seriesId: string
  description: string
  fromAmount: number
  toAmount: number
  pendingUpdated: number
  seedBudgetedUpdated: boolean
}

export type AmountUpdatePlan = {
  updates: Array<{
    id: string
    payload: {
      amount?: number
      budgeted_amount: number
      metadata?: Record<string, unknown>
    }
  }>
  preview: AmountUpdatePreviewItem[]
}

export type SeriesDisablePlan = {
  archiveIds: string[]
  endDateUpdates: Array<{
    id: string
    payload: {
      metadata: Record<string, unknown>
    }
  }>
  preview: Array<{
    seriesId: string
    description: string
    pendingArchived: number
    remainingActive: number
    endDate: string
  }>
}

function monthStart(value: string) {
  return `${value.slice(0, 7)}-01`
}

function metadataDate(transaction: RecurringExpenseOccurrence, key: "purchase_date" | "scheduled_date") {
  const value = transaction.metadata?.[key]
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export function getRecurringExpenseOccurrenceDate(transaction: RecurringExpenseOccurrence) {
  return transaction.payment_method === "credit"
    ? metadataDate(transaction, "purchase_date") || transaction.transaction_date
    : metadataDate(transaction, "scheduled_date") || transaction.transaction_date
}

export function getRecurringExpensePeriod(transaction: RecurringExpenseOccurrence) {
  return transaction.recurrence_period || monthStart(getRecurringExpenseOccurrenceDate(transaction))
}

function getLegacyKey(transaction: RecurringExpenseOccurrence) {
  return [
    transaction.family_id || `user:${transaction.user_id}`,
    transaction.description.trim().toLowerCase(),
    transaction.category_id || "no-category",
    transaction.group_id || "no-group",
    transaction.payment_method || "no-method",
    transaction.credit_card_id || "no-card",
    transaction.currency_id || "no-currency",
  ].join("|")
}

function deterministicSeriesId(key: string) {
  const hex = createHash("sha256").update(`family-expense-recurring:${key}`).digest("hex").slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function getRecurringExpenseSeriesId(transaction: RecurringExpenseOccurrence) {
  const metadataId = transaction.metadata?.recurring_series_id
  if (transaction.recurring_series_id) return transaction.recurring_series_id
  if (typeof metadataId === "string" && /^[0-9a-f-]{36}$/i.test(metadataId)) return metadataId
  return deterministicSeriesId(getLegacyKey(transaction))
}

export function getRecurringExpenseEndDate(transaction: RecurringExpenseOccurrence) {
  const value = transaction.metadata?.recurrence_end_date
  return typeof value === "string" && value ? value : null
}

export function getRecurringExpenseTemplateAmount(transaction: RecurringExpenseOccurrence) {
  return Number(transaction.budgeted_amount ?? transaction.amount ?? 0)
}

export function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function applyAmountChange(currentAmount: number, mode: AmountChangeMode, value: number) {
  if (!Number.isFinite(currentAmount) || !Number.isFinite(value)) {
    throw new Error("Monto inválido")
  }

  const next = mode === "absolute"
    ? value
    : currentAmount * (1 + value / 100)

  const rounded = roundMoney(next)
  if (rounded <= 0) throw new Error("El monto resultante debe ser mayor a cero")
  return rounded
}

function isInstallmentRow(transaction: RecurringExpenseOccurrence) {
  return Boolean(transaction.credit_card_purchase_id || transaction.installment_number)
}

function isActiveOccurrence(transaction: RecurringExpenseOccurrence) {
  return !transaction.archived_at && transaction.status !== "rejected"
}

export function groupRecurringExpenseSeries(
  rows: RecurringExpenseOccurrence[],
): Map<string, RecurringExpenseOccurrence[]> {
  const rowsBySeries = new Map<string, RecurringExpenseOccurrence[]>()

  for (const row of rows) {
    if (!row || isInstallmentRow(row)) continue
    const seriesId = getRecurringExpenseSeriesId(row)
    rowsBySeries.set(seriesId, [...(rowsBySeries.get(seriesId) || []), row])
  }

  return rowsBySeries
}

function sortByPeriodDesc(a: RecurringExpenseOccurrence, b: RecurringExpenseOccurrence) {
  return getRecurringExpensePeriod(b).localeCompare(getRecurringExpensePeriod(a))
}

export function summarizeRecurringExpenseSeries(
  rows: RecurringExpenseOccurrence[],
): RecurringExpenseSeriesSummary[] {
  const summaries: RecurringExpenseSeriesSummary[] = []

  for (const [seriesId, seriesRows] of groupRecurringExpenseSeries(rows)) {
    const activeRows = seriesRows.filter(isActiveOccurrence).sort(sortByPeriodDesc)
    if (activeRows.length === 0) continue

    const seed = activeRows[0]
    const pendingCount = activeRows.filter((row) => (row.status || "approved") === "pending").length
    const approvedCount = activeRows.filter((row) => (row.status || "approved") === "approved").length

    summaries.push({
      seriesId,
      description: seed.description,
      currentAmount: getRecurringExpenseTemplateAmount(seed),
      currencyId: seed.currency_id,
      paymentMethod: seed.payment_method,
      creditCardId: seed.credit_card_id,
      categoryId: seed.category_id,
      groupId: seed.group_id,
      isAutomaticDebit: seed.payment_method === "credit" && Boolean(seed.credit_card_id),
      latestPeriod: getRecurringExpensePeriod(seed),
      endDate: getRecurringExpenseEndDate(seed),
      pendingCount,
      approvedCount,
      activeCount: activeRows.length,
      seedId: seed.id,
    })
  }

  return summaries.sort((left, right) => left.description.localeCompare(right.description, "es"))
}

function previousPeriodEnd(periodStart: string) {
  const year = Number(periodStart.slice(0, 4))
  const month = Number(periodStart.slice(5, 7))
  const previous = new Date(year, month - 2, 1)
  const lastDay = new Date(previous.getFullYear(), previous.getMonth() + 1, 0).getDate()
  return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
}

/**
 * Bulk amount change for recurring expense series.
 * - Pending materializations from `effectivePeriod` forward get amount + budgeted_amount.
 * - Approved history keeps realized `amount`; only the seed's `budgeted_amount` is updated
 *   so future generation/projection pick up the new price.
 */
export function planRecurringExpenseAmountUpdate(params: {
  rows: RecurringExpenseOccurrence[]
  seriesIds: string[]
  mode: AmountChangeMode
  value: number
  effectivePeriod: string
}): AmountUpdatePlan {
  const selected = new Set(params.seriesIds)
  const updates = new Map<string, AmountUpdatePlan["updates"][number]>()
  const preview: AmountUpdatePreviewItem[] = []
  const effectivePeriod = monthStart(params.effectivePeriod)

  for (const [seriesId, seriesRows] of groupRecurringExpenseSeries(params.rows)) {
    if (!selected.has(seriesId)) continue

    const activeRows = seriesRows.filter(isActiveOccurrence).sort(sortByPeriodDesc)
    if (activeRows.length === 0) continue

    const seed = activeRows[0]
    const fromAmount = getRecurringExpenseTemplateAmount(seed)
    const toAmount = applyAmountChange(fromAmount, params.mode, params.value)
    let pendingUpdated = 0
    let seedBudgetedUpdated = false

    for (const row of activeRows) {
      const period = getRecurringExpensePeriod(row)
      const status = row.status || "approved"

      if (status === "pending" && period >= effectivePeriod) {
        updates.set(row.id, {
          id: row.id,
          payload: {
            amount: toAmount,
            budgeted_amount: toAmount,
            metadata: {
              ...(row.metadata || {}),
              bulk_amount_change: {
                previous_amount: Number(row.amount),
                previous_budgeted_amount: row.budgeted_amount,
                new_amount: toAmount,
                mode: params.mode,
                value: params.value,
                changed_at: new Date().toISOString(),
              },
            },
          },
        })
        pendingUpdated += 1
        if (row.id === seed.id) seedBudgetedUpdated = true
        continue
      }

      if (row.id === seed.id && Math.abs(getRecurringExpenseTemplateAmount(row) - toAmount) >= 0.005) {
        updates.set(row.id, {
          id: row.id,
          payload: {
            budgeted_amount: toAmount,
            metadata: {
              ...(row.metadata || {}),
              bulk_amount_change: {
                previous_amount: Number(row.amount),
                previous_budgeted_amount: row.budgeted_amount,
                new_budgeted_amount: toAmount,
                mode: params.mode,
                value: params.value,
                changed_at: new Date().toISOString(),
                approved_amount_preserved: status === "approved",
              },
            },
          },
        })
        seedBudgetedUpdated = true
      }
    }

    preview.push({
      seriesId,
      description: seed.description,
      fromAmount,
      toAmount,
      pendingUpdated,
      seedBudgetedUpdated,
    })
  }

  return {
    updates: Array.from(updates.values()),
    preview: preview.sort((left, right) => left.description.localeCompare(right.description, "es")),
  }
}

/**
 * Disable/delete selected series from `effectivePeriod` forward:
 * - archive pending materializations in/after that period (tombstones)
 * - set recurrence_end_date on remaining active rows so generation/projection stop
 */
export function planRecurringExpenseSeriesDisable(params: {
  rows: RecurringExpenseOccurrence[]
  seriesIds: string[]
  effectivePeriod: string
}): SeriesDisablePlan {
  const selected = new Set(params.seriesIds)
  const archiveIds: string[] = []
  const endDateUpdates: SeriesDisablePlan["endDateUpdates"] = []
  const preview: SeriesDisablePlan["preview"] = []
  const effectivePeriod = monthStart(params.effectivePeriod)
  const endDate = previousPeriodEnd(effectivePeriod)

  for (const [seriesId, seriesRows] of groupRecurringExpenseSeries(params.rows)) {
    if (!selected.has(seriesId)) continue

    const activeRows = seriesRows.filter(isActiveOccurrence).sort(sortByPeriodDesc)
    if (activeRows.length === 0) continue

    let pendingArchived = 0
    let remainingActive = 0

    for (const row of activeRows) {
      const period = getRecurringExpensePeriod(row)
      const status = row.status || "approved"

      if (status === "pending" && period >= effectivePeriod) {
        archiveIds.push(row.id)
        pendingArchived += 1
        continue
      }

      remainingActive += 1
      const currentEnd = getRecurringExpenseEndDate(row)
      const nextEnd = !currentEnd || currentEnd > endDate ? endDate : currentEnd
      endDateUpdates.push({
        id: row.id,
        payload: {
          metadata: {
            ...(row.metadata || {}),
            recurrence_end_date: nextEnd,
            bulk_disabled_at: new Date().toISOString(),
            bulk_disabled_from_period: effectivePeriod,
          },
        },
      })
    }

    preview.push({
      seriesId,
      description: activeRows[0].description,
      pendingArchived,
      remainingActive,
      endDate,
    })
  }

  return {
    archiveIds,
    endDateUpdates,
    preview: preview.sort((left, right) => left.description.localeCompare(right.description, "es")),
  }
}

/** Amount used when materializing the next period from a seed occurrence. */
export function getRecurringExpenseSeedAmounts(source: RecurringExpenseOccurrence) {
  const templateAmount = getRecurringExpenseTemplateAmount(source)
  return {
    amount: templateAmount,
    budgeted_amount: templateAmount,
  }
}
