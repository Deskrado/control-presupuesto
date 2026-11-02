import type { BrokerPosition, Currency, FxQuote, Investment, PortfolioSnapshot, SavingsGoal } from "@/lib/types"

export type WealthBreakdown = {
  cash: number
  investments: number
  foreignCurrencies: number
  total: number
  /** Cross-currency amounts omitted because no FX quote was available. */
  omittedWithoutFx: number
}

export function getLatestFxRate(quotes: FxQuote[] | undefined, fromCode: string, toCode: string) {
  if (fromCode === toCode) return 1
  const directQuote = (quotes || []).find((item) =>
    item.base_currency?.code === fromCode &&
    item.quote_currency?.code === toCode
  )
  if (directQuote) return Number(directQuote.ask || directQuote.mid || directQuote.bid || 0) || null

  const inverseQuote = (quotes || []).find((item) =>
    item.base_currency?.code === toCode &&
    item.quote_currency?.code === fromCode
  )
  const inverseRate = inverseQuote ? Number(inverseQuote.bid || inverseQuote.mid || inverseQuote.ask || 0) : 0
  return inverseRate ? 1 / inverseRate : null
}

/**
 * Convert amount using FX quotes. Same-currency is identity.
 * Missing cross-currency quotes return 0 (never silent 1:1).
 */
export function convertToCurrency(
  amount: number,
  from: Currency | null | undefined,
  to: Currency | null | undefined,
  quotes: FxQuote[] | undefined,
) {
  const fromCode = from?.code || to?.code || "ARS"
  const toCode = to?.code || fromCode
  const rate = getLatestFxRate(quotes, fromCode, toCode)
  if (rate == null) return 0
  return amount * rate
}

export function canConvertCurrency(
  from: Currency | null | undefined,
  to: Currency | null | undefined,
  quotes: FxQuote[] | undefined,
) {
  const fromCode = from?.code || to?.code || "ARS"
  const toCode = to?.code || fromCode
  return getLatestFxRate(quotes, fromCode, toCode) != null
}

type WealthBreakdownInput = {
  cashBalance: number
  investments?: Investment[]
  brokerPositions?: BrokerPosition[]
  portfolioSnapshots?: PortfolioSnapshot[]
  savingsGoals?: SavingsGoal[]
  fxQuotes?: FxQuote[]
  defaultCurrency: Currency | null | undefined
}

function convertOrTrackOmitted(
  amount: number,
  from: Currency | null | undefined,
  to: Currency | null | undefined,
  quotes: FxQuote[] | undefined,
  omitted: { value: number },
) {
  if (canConvertCurrency(from, to, quotes)) {
    return convertToCurrency(amount, from, to, quotes)
  }
  omitted.value += Math.abs(amount)
  return 0
}

export function getWealthBreakdown({
  cashBalance,
  investments,
  brokerPositions,
  portfolioSnapshots,
  savingsGoals,
  fxQuotes,
  defaultCurrency,
}: WealthBreakdownInput): WealthBreakdown {
  const omitted = { value: 0 }

  const manualInvestments = (investments || [])
    .filter((investment) => investment.is_active)
    .reduce(
      (total, investment) =>
        total + convertOrTrackOmitted(
          Number(investment.current_value || 0),
          investment.currency,
          defaultCurrency,
          fxQuotes,
          omitted,
        ),
      0,
    )

  const connectedPositions = (brokerPositions || []).reduce(
    (total, position) =>
      total + convertOrTrackOmitted(
        Number(position.market_value || 0),
        position.currency,
        defaultCurrency,
        fxQuotes,
        omitted,
      ),
    0,
  )
  const latestSnapshot = portfolioSnapshots?.[0]
  const snapshotFallback = connectedPositions > 0 || !latestSnapshot
    ? 0
    : convertOrTrackOmitted(
      Number(latestSnapshot.total_value || 0),
      latestSnapshot.currency,
      defaultCurrency,
      fxQuotes,
      omitted,
    )

  const foreignCurrencies = (savingsGoals || [])
    .filter((goal) => !goal.is_completed && Number(goal.current_amount) > 0 && goal.currency?.code !== defaultCurrency?.code)
    .reduce(
      (total, goal) =>
        total + convertOrTrackOmitted(
          Number(goal.current_amount || 0),
          goal.currency,
          defaultCurrency,
          fxQuotes,
          omitted,
        ),
      0,
    )

  const investmentsTotal = manualInvestments + connectedPositions + snapshotFallback
  const total = cashBalance + investmentsTotal + foreignCurrencies

  return {
    cash: cashBalance,
    investments: investmentsTotal,
    foreignCurrencies,
    total,
    omittedWithoutFx: omitted.value,
  }
}
