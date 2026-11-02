import type { MonthlyClosure } from "@/lib/types"

type Period = {
  year: number
  month: number
}

type MonthCashBalancesInput = Period & {
  initialBalance: number
  monthlySavings: number
  closures?: MonthlyClosure[]
  familyId?: string | null
}

function closureRecency(closure: MonthlyClosure) {
  return closure.closed_at || closure.created_at || ""
}

export function getPreviousPeriod({ year, month }: Period): Period {
  return month === 1
    ? { year: year - 1, month: 12 }
    : { year, month: month - 1 }
}

/**
 * Resolve one closure for a period.
 * Prefer the active family scope when provided; otherwise the latest closure wins
 * so multi-member family data stays deterministic.
 */
export function findMonthlyClosure(
  closures: MonthlyClosure[] | undefined,
  { year, month, familyId }: Period & { familyId?: string | null },
) {
  const matches = (closures || []).filter((closure) => closure.year === year && closure.month === month)
  if (matches.length === 0) return null

  const scoped = familyId
    ? matches.filter((closure) => closure.family_id === familyId)
    : matches

  const candidates = scoped.length > 0 ? scoped : matches
  return [...candidates].sort((left, right) => closureRecency(right).localeCompare(closureRecency(left)))[0] || null
}

export function getPreviousMonthClosingBalance({
  year,
  month,
  initialBalance,
  closures,
  familyId,
}: Period & { initialBalance: number; closures?: MonthlyClosure[]; familyId?: string | null }) {
  const previousClosure = findMonthlyClosure(closures, { ...getPreviousPeriod({ year, month }), familyId })
  return previousClosure ? Number(previousClosure.cash_total || 0) : initialBalance
}

export function getMonthCashBalances({
  year,
  month,
  initialBalance,
  monthlySavings,
  closures,
  familyId,
}: MonthCashBalancesInput) {
  const selectedClosure = findMonthlyClosure(closures, { year, month, familyId })

  if (selectedClosure) {
    const finalBalance = Number(selectedClosure.cash_total || 0)
    return {
      initialBalance: finalBalance - Number(selectedClosure.savings_total || 0),
      finalBalance,
    }
  }

  const openingBalance = getPreviousMonthClosingBalance({ year, month, initialBalance, closures, familyId })
  return {
    initialBalance: openingBalance,
    finalBalance: openingBalance + monthlySavings,
  }
}
