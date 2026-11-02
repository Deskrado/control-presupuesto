import { describe, expect, it } from "vitest"
import {
  findMonthlyClosure,
  getMonthCashBalances,
  getPreviousMonthClosingBalance,
} from "@/lib/monthly-balance"
import type { MonthlyClosure } from "@/lib/types"

function closure(overrides: Partial<MonthlyClosure>): MonthlyClosure {
  return {
    id: "closure-id",
    user_id: "user-id",
    family_id: null,
    year: 2026,
    month: 8,
    income_total: 0,
    expense_total: 0,
    savings_total: 252_298.43,
    cash_total: 3_047_248.83,
    investments_total: 0,
    foreign_currency_total: 0,
    snapshot: {},
    closed_by: null,
    closed_at: "2026-09-01T00:00:00.000Z",
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("monthly cash balances", () => {
  it("usa el saldo final cerrado de agosto como saldo inicial de septiembre", () => {
    const august = closure({})

    expect(getMonthCashBalances({
      year: 2026,
      month: 9,
      initialBalance: 210_690.93,
      monthlySavings: 100_000,
      closures: [august],
    })).toEqual({
      initialBalance: 3_047_248.83,
      finalBalance: 3_147_248.83,
    })
  })

  it("muestra los saldos guardados cuando el mes ya está cerrado", () => {
    const august = closure({})

    expect(getMonthCashBalances({
      year: 2026,
      month: 8,
      initialBalance: 210_690.93,
      monthlySavings: 999_999,
      closures: [august],
    })).toEqual({
      initialBalance: 2_794_950.4,
      finalBalance: 3_047_248.83,
    })
  })

  it("usa el saldo configurado si no existe un cierre del mes anterior", () => {
    expect(getPreviousMonthClosingBalance({
      year: 2026,
      month: 5,
      initialBalance: 210_690.93,
      closures: [],
    })).toBe(210_690.93)
  })

  it("encadena correctamente diciembre con enero", () => {
    const december = closure({ year: 2025, month: 12, cash_total: 750_000 })

    expect(getPreviousMonthClosingBalance({
      year: 2026,
      month: 1,
      initialBalance: 0,
      closures: [december],
    })).toBe(750_000)
  })

  it("elige el cierre familiar más reciente cuando hay varios del mismo período", () => {
    const older = closure({
      id: "older",
      user_id: "member-a",
      family_id: "family-1",
      cash_total: 2_500_000,
      closed_at: "2026-09-01T10:00:00.000Z",
    })
    const newer = closure({
      id: "newer",
      user_id: "member-b",
      family_id: "family-1",
      cash_total: 3_000_000,
      closed_at: "2026-09-02T10:00:00.000Z",
    })

    expect(findMonthlyClosure([older, newer], {
      year: 2026,
      month: 8,
      familyId: "family-1",
    })?.id).toBe("newer")

    expect(getPreviousMonthClosingBalance({
      year: 2026,
      month: 9,
      initialBalance: 0,
      familyId: "family-1",
      closures: [older, newer],
    })).toBe(3_000_000)
  })
})
