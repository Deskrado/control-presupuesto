import { describe, expect, it } from "vitest"
import type { Currency, FxQuote, Investment, SavingsGoal } from "@/lib/types"
import { convertToCurrency, getLatestFxRate, getWealthBreakdown } from "@/lib/wealth-summary"

const ars: Currency = {
  id: "ars",
  code: "ARS",
  name: "Peso",
  symbol: "$",
  decimal_separator: ",",
  thousand_separator: ".",
}

const usd: Currency = {
  id: "usd",
  code: "USD",
  name: "Dólar",
  symbol: "U$S",
  decimal_separator: ".",
  thousand_separator: ",",
}

const usdArsQuote: FxQuote = {
  id: "fx-1",
  base_currency_id: "usd",
  quote_currency_id: "ars",
  rate_type: "blue",
  bid: 1000,
  ask: 1020,
  mid: 1010,
  source: "test",
  observed_at: "2026-11-02T00:00:00.000Z",
  valid_on: "2026-11-02",
  raw: {},
  created_at: "2026-11-02T00:00:00.000Z",
  base_currency: usd,
  quote_currency: ars,
}

describe("convertToCurrency / FX", () => {
  it("keeps same-currency amounts unchanged", () => {
    expect(convertToCurrency(1500, usd, usd, [])).toBe(1500)
    expect(getLatestFxRate([], "ARS", "ARS")).toBe(1)
  })

  it("converts with a direct quote", () => {
    expect(convertToCurrency(10, usd, ars, [usdArsQuote])).toBe(10200)
  })

  it("converts with an inverse quote", () => {
    // Inverse uses bid (1000): 2000 ARS → 2 USD.
    expect(convertToCurrency(2000, ars, usd, [usdArsQuote])).toBe(2)
  })

  it("never falls back to silent 1:1 when FX is missing", () => {
    expect(convertToCurrency(1000, usd, ars, [])).toBe(0)
    expect(convertToCurrency(1000, usd, ars, undefined)).toBe(0)
  })
})

describe("getWealthBreakdown", () => {
  it("omits foreign amounts without FX instead of counting them as ARS 1:1", () => {
    const investments: Investment[] = [{
      id: "inv-1",
      user_id: "user",
      name: "CEDEAR",
      type: "acciones",
      initial_amount: 1000,
      current_value: 1000,
      currency_id: "usd",
      start_date: "2026-01-01",
      end_date: null,
      interest_rate: null,
      notes: null,
      is_active: true,
      created_at: "2026-01-01T00:00:00.000Z",
      currency: usd,
    }]
    const savingsGoals: SavingsGoal[] = [{
      id: "goal-1",
      user_id: "user",
      name: "USD cash",
      target_amount: 5000,
      current_amount: 500,
      currency_id: "usd",
      target_date: null,
      monthly_target: null,
      is_completed: false,
      created_at: "2026-01-01T00:00:00.000Z",
      currency: usd,
    }]

    const withoutFx = getWealthBreakdown({
      cashBalance: 10_000,
      investments,
      savingsGoals,
      fxQuotes: [],
      defaultCurrency: ars,
    })

    expect(withoutFx.cash).toBe(10_000)
    expect(withoutFx.investments).toBe(0)
    expect(withoutFx.foreignCurrencies).toBe(0)
    expect(withoutFx.total).toBe(10_000)
    expect(withoutFx.omittedWithoutFx).toBe(1500)

    const withFx = getWealthBreakdown({
      cashBalance: 10_000,
      investments,
      savingsGoals,
      fxQuotes: [usdArsQuote],
      defaultCurrency: ars,
    })

    expect(withFx.investments).toBe(1_020_000)
    expect(withFx.foreignCurrencies).toBe(510_000)
    expect(withFx.total).toBe(10_000 + 1_020_000 + 510_000)
    expect(withFx.omittedWithoutFx).toBe(0)
  })
})
