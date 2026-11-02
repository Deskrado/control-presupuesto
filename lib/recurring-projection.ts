import type { RecurringIncomeTemplate, Transaction } from "@/lib/types"
import { getMonthIndexFromDateOnly, getYearFromDateOnly } from "@/lib/date-only"
import { getTransactionBudgetedAmount } from "@/lib/transaction-list-utils"

type RecurringProjection = {
  income: number
  expenses: number
}

function transactionMonthKey(transaction: Transaction) {
  return `${getYearFromDateOnly(transaction.transaction_date)}-${getMonthIndexFromDateOnly(transaction.transaction_date)}`
}

function targetMonthKey(year: number, monthIndex: number) {
  return `${year}-${monthIndex}`
}

function getRecurringKey(transaction: Transaction) {
  const metadata = transaction.metadata || {}
  const seriesId = transaction.recurring_series_id ||
    (typeof metadata.recurring_series_id === "string" ? metadata.recurring_series_id : null)
  if (seriesId) return `series:${seriesId}`

  return [
    transaction.type,
    transaction.description.trim().toLowerCase(),
    transaction.category_id || "no-category",
    transaction.group_id || "no-group",
    transaction.payment_method || "no-method",
    transaction.credit_card_id || "no-card",
    transaction.currency_id || "no-currency",
  ].join("|")
}

function isBeforeOrSameMonth(transaction: Transaction, year: number, monthIndex: number) {
  const transactionYear = getYearFromDateOnly(transaction.transaction_date)
  const transactionMonth = getMonthIndexFromDateOnly(transaction.transaction_date)
  return transactionYear < year || (transactionYear === year && transactionMonth <= monthIndex)
}

function getRecurrenceEndDate(transaction: Transaction) {
  const value = transaction.metadata?.recurrence_end_date
  return typeof value === "string" && value ? value : null
}

export function getRecurringProjectionForMonth(
  transactions: Transaction[] | undefined,
  year: number,
  monthIndex: number,
  selectedYear: number,
  selectedMonth: number,
  recurringIncomeTemplates: RecurringIncomeTemplate[] | undefined = undefined,
): RecurringProjection {
  void selectedYear
  void selectedMonth

  const templateIds = new Set((recurringIncomeTemplates || []).map((template) => template.id))
  const targetKey = targetMonthKey(year, monthIndex)
  const actualRecurringKeys = new Set(
    (transactions || [])
      .filter((transaction) => transaction.is_recurring && transactionMonthKey(transaction) === targetKey)
      .map(getRecurringKey),
  )
  const actualRecurringTemplateIds = new Set(
    (transactions || [])
      .filter((transaction) => transaction.recurring_template_id && transactionMonthKey(transaction) === targetKey)
      .map((transaction) => transaction.recurring_template_id),
  )

  const latestTransactionByKey = new Map<string, Transaction>()
  for (const transaction of transactions || []) {
    if (transaction.status === "rejected") continue
    if (transaction.recurring_template_id && templateIds.has(transaction.recurring_template_id)) continue
    if (!isBeforeOrSameMonth(transaction, year, monthIndex)) continue

    const endDate = getRecurrenceEndDate(transaction)
    const targetDate = `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`
    if (endDate && targetDate > endDate) continue

    const key = getRecurringKey(transaction)
    const current = latestTransactionByKey.get(key)
    if (!current || transaction.transaction_date > current.transaction_date) {
      latestTransactionByKey.set(key, transaction)
    }
  }

  const projection = { income: 0, expenses: 0 }
  for (const [key, transaction] of latestTransactionByKey.entries()) {
    if (actualRecurringKeys.has(key)) continue
    if (!transaction.is_recurring) continue

    // Forward recurring templates with the expected/budgeted amount (pending rows
    // often keep a placeholder `amount` until statement payment approval).
    const amount = getTransactionBudgetedAmount(transaction)
    if (transaction.type === "income") {
      projection.income += amount
    } else {
      projection.expenses += amount
    }
  }

  for (const template of recurringIncomeTemplates || []) {
    if (!template.is_active) continue
    if (actualRecurringTemplateIds.has(template.id)) continue

    const targetDate = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(template.day_of_month).padStart(2, "0")}`
    if (targetDate < template.start_date) continue
    if (template.end_date && targetDate > template.end_date) continue

    projection.income += Number(template.amount || 0)
  }

  return projection
}
