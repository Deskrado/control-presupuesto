import { getTransactionActualAmount, getTransactionBudgetedAmount } from "@/lib/transaction-list-utils"

export const CREDIT_CARD_STATEMENT_ADJUSTMENT_SOURCE = "credit_card_statement_payment_adjustment"

export function isStatementPaymentAdjustment(transaction: { metadata?: unknown }) {
  if (!transaction.metadata || typeof transaction.metadata !== "object") return false
  return (transaction.metadata as { source?: unknown }).source === CREDIT_CARD_STATEMENT_ADJUSTMENT_SOURCE
}

export function roundStatementCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function getPreviousStatementPeriod(year: number, month: number) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
}

export function getApplicablePreviousBalance({
  carryoverBalance,
  statementYear,
  statementMonth,
  targetYear,
  targetMonth,
}: {
  carryoverBalance: number
  statementYear: number
  statementMonth: number
  targetYear: number
  targetMonth: number
}) {
  const balance = roundStatementCurrency(carryoverBalance)
  if (balance >= 0) return balance

  const previous = getPreviousStatementPeriod(targetYear, targetMonth)
  return statementYear === previous.year && statementMonth === previous.month ? balance : 0
}

export function getStatementTransactionAmount(transaction: {
  amount?: number | null
  budgeted_amount?: number | null
  status?: string | null
}) {
  const status = transaction.status || "approved"
  if (status === "rejected") return 0
  const value = status === "approved"
    ? getTransactionActualAmount(transaction)
    : getTransactionBudgetedAmount(transaction)

  return roundStatementCurrency(value)
}

export function calculateStatementBalances({
  expectedAmount,
  previousBalance,
  paidAmount = 0,
}: {
  expectedAmount: number
  previousBalance: number
  paidAmount?: number
}) {
  // A previous credit can reduce this statement, but unused credit expires here.
  // Only a new overpayment creates a negative balance for the following statement.
  const amountDue = roundStatementCurrency(Math.max(0, expectedAmount + previousBalance))
  const carryoverBalance = roundStatementCurrency(amountDue - paidAmount)

  return {
    amountDue,
    balanceDelta: carryoverBalance,
    carryoverBalance,
  }
}

export function calculateStatementPaymentApplication({
  expectedAmount,
  previousBalance,
  paidAmount,
}: {
  expectedAmount: number
  previousBalance: number
  paidAmount: number
}) {
  const balances = calculateStatementBalances({ expectedAmount, previousBalance, paidAmount })
  // Paying the displayed total settles prior debt first. Conversely, a prior
  // credit covers current consumptions before any new cash payment is needed.
  const targetCurrentExpense = roundStatementCurrency(
    Math.min(expectedAmount, Math.max(0, paidAmount - previousBalance)),
  )
  const adjustmentAmount = roundStatementCurrency(Math.max(0, paidAmount - balances.amountDue))

  return { ...balances, targetCurrentExpense, adjustmentAmount }
}

export function allocateStatementPayment<T extends { id: string; weight: number }>(items: T[], total: number) {
  const totalCents = Math.max(0, Math.round(roundStatementCurrency(total) * 100))
  const normalized = items.map((item, index) => ({
    item,
    index,
    weightCents: Math.max(0, Math.round(roundStatementCurrency(item.weight) * 100)),
  }))
  const weightTotal = normalized.reduce((sum, entry) => sum + entry.weightCents, 0)

  if (totalCents === 0 || weightTotal === 0) {
    return new Map(items.map((item) => [item.id, 0]))
  }

  const payableCents = Math.min(totalCents, weightTotal)
  const allocations = normalized.map((entry) => {
    const exact = (entry.weightCents / weightTotal) * payableCents
    const cents = Math.floor(exact)
    return { ...entry, cents, remainder: exact - cents }
  })
  let remaining = payableCents - allocations.reduce((sum, entry) => sum + entry.cents, 0)

  allocations
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    .forEach((entry) => {
      if (remaining <= 0) return
      entry.cents += 1
      remaining -= 1
    })

  return new Map(allocations.map((entry) => [entry.item.id, entry.cents / 100]))
}
