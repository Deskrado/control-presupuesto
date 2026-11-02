import type { Transaction } from "@/lib/types"

type TransactionAmountData = Pick<Transaction, "amount" | "budgeted_amount" | "status">
type TransactionSearchData = Pick<Transaction, "description" | "amount" | "budgeted_amount" | "status">
type TransactionRecurrenceData = Pick<Transaction, "type" | "is_recurring" | "payment_method" | "credit_card_id">

export type TransactionRecurrenceKind = "normal" | "recurring" | "automatic_debit"

export function getTransactionRecurrenceKind(transaction: TransactionRecurrenceData): TransactionRecurrenceKind {
  if (!transaction.is_recurring) return "normal"

  return transaction.type === "expense" &&
    transaction.payment_method === "credit" &&
    Boolean(transaction.credit_card_id)
    ? "automatic_debit"
    : "recurring"
}

/** Cash-realized amount. Pending/rejected never reduce cash until approved. */
export function getTransactionActualAmount(transaction: TransactionAmountData) {
  const status = transaction.status || "approved"
  return status === "pending" || status === "rejected" ? 0 : Number(transaction.amount || 0)
}

/** Expected/previsto amount. Pending uses budgeted_amount when present. */
export function getTransactionBudgetedAmount(transaction: TransactionAmountData) {
  const status = transaction.status || "approved"
  if (status === "rejected") return 0
  return Number(transaction.budgeted_amount ?? transaction.amount ?? 0)
}

/**
 * Primary UI amount: show expected debt for pending rows, realized cash otherwise.
 * Aligns mobile/search with statements (`budgeted` while unpaid).
 */
export function getTransactionDisplayAmount(transaction: TransactionAmountData) {
  const status = transaction.status || "approved"
  if (status === "pending") return getTransactionBudgetedAmount(transaction)
  return getTransactionActualAmount(transaction)
}

export function parseLocalizedAmount(value: string) {
  const compactValue = value.trim().replace(/\s/g, "")
  if (!/^[+-]?\d[\d.,]*$/.test(compactValue)) return null

  const sign = compactValue.startsWith("-") ? -1 : 1
  const unsignedValue = compactValue.replace(/^[+-]/, "")
  const lastDot = unsignedValue.lastIndexOf(".")
  const lastComma = unsignedValue.lastIndexOf(",")
  const separatorIndex = Math.max(lastDot, lastComma)

  if (separatorIndex === -1) {
    const parsedValue = Number(unsignedValue)
    return Number.isFinite(parsedValue) ? sign * parsedValue : null
  }

  const separator = unsignedValue[separatorIndex]
  const occurrences = unsignedValue.split(separator).length - 1
  const decimalLength = unsignedValue.length - separatorIndex - 1
  const usesThousandsSeparator =
    lastDot === -1 || lastComma === -1
      ? decimalLength === 3 && unsignedValue.split(separator).slice(1).every((part) => part.length === 3)
      : false

  const normalizedValue = usesThousandsSeparator
    ? unsignedValue.replace(/[.,]/g, "")
    : `${unsignedValue.slice(0, separatorIndex).replace(/[.,]/g, "")}.${unsignedValue.slice(separatorIndex + 1)}`

  if (occurrences > 1 && !usesThousandsSeparator && decimalLength === 0) return null

  const parsedValue = Number(normalizedValue)
  return Number.isFinite(parsedValue) ? sign * parsedValue : null
}

export function matchesTransactionSearch(transaction: TransactionSearchData, searchQuery: string) {
  const query = searchQuery.trim()
  if (!query) return true

  const searchedAmount = parseLocalizedAmount(query)
  if (searchedAmount !== null) {
    const actual = getTransactionActualAmount(transaction)
    const budgeted = getTransactionBudgetedAmount(transaction)
    const display = getTransactionDisplayAmount(transaction)
    return [actual, budgeted, display].some((candidate) => Math.abs(candidate - searchedAmount) < 0.005)
  }

  return transaction.description.toLocaleLowerCase("es").includes(query.toLocaleLowerCase("es"))
}
