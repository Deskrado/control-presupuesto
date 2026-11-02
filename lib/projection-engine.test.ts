import { describe, expect, it } from "vitest"
import { applyMonthlyClosures, buildAnnualProjection } from "@/lib/projection-engine"
import type { MonthlyClosure, ProjectionScenario, Transaction } from "@/lib/types"

function transaction(overrides: Partial<Transaction>): Transaction {
  return {
    id: "transaction-id",
    user_id: "user-id",
    description: "Movimiento",
    amount: 100,
    budgeted_amount: null,
    currency_id: null,
    category_id: null,
    group_id: null,
    transaction_date: "2026-01-10",
    type: "expense",
    is_recurring: false,
    payment_method: "cash",
    credit_card_id: null,
    status: "approved",
    notes: null,
    created_at: "2026-01-10T00:00:00.000Z",
    ...overrides,
  }
}

describe("buildAnnualProjection", () => {
  it("genera una ventana retrospectiva que cruza el cambio de año", () => {
    const result = buildAnnualProjection({
      year: 2026,
      selectedMonth: 8,
      asOfYear: 2026,
      asOfMonth: 8,
      startYear: 2025,
      startMonth: 10,
      monthsAhead: 6,
    })

    expect(result.map(({ year, month }) => `${year}-${month}`)).toEqual([
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-1",
      "2026-2",
      "2026-3",
    ])
    expect(result.every((point) => point.periodType === "actual")).toBe(true)
  })

  it("no incorpora pendientes, recurrencias sintetizadas ni escenarios en meses históricos", () => {
    const recurring = transaction({
      id: "recurring",
      amount: 250,
      transaction_date: "2025-12-10",
      is_recurring: true,
    })
    const pending = transaction({
      id: "pending",
      amount: 400,
      transaction_date: "2026-01-12",
      status: "pending",
    })
    const scenario: ProjectionScenario = {
      id: "scenario",
      user_id: "user-id",
      family_id: null,
      name: "Escenario",
      description: null,
      is_active: true,
      created_at: "2025-01-01T00:00:00.000Z",
      items: [{
        id: "item",
        scenario_id: "scenario",
        name: "Extra",
        amount: 300,
        currency_id: null,
        frequency: "monthly",
        start_month: 1,
        start_year: 2026,
        end_month: 12,
        end_year: 2026,
        category_id: null,
        group_id: null,
        created_at: "2025-01-01T00:00:00.000Z",
      }],
    }

    const [january] = buildAnnualProjection({
      year: 2026,
      selectedMonth: 8,
      asOfYear: 2026,
      asOfMonth: 8,
      startYear: 2026,
      startMonth: 1,
      monthsAhead: 1,
      transactions: [recurring, pending],
      scenarios: [scenario],
    })

    expect(january.periodType).toBe("actual")
    expect(january.expenses).toBe(0)
    expect(january.recurringExpenses).toBe(0)
    expect(january.scenarioImpact).toBe(0)
    expect(january.simulatedExpenses).toBe(0)
  })

  it("mantiene las estimaciones y escenarios en meses futuros", () => {
    const recurring = transaction({
      id: "recurring",
      amount: 250,
      transaction_date: "2026-07-10",
      is_recurring: true,
    })
    const scenario: ProjectionScenario = {
      id: "scenario",
      user_id: "user-id",
      family_id: null,
      name: "Escenario",
      description: null,
      is_active: true,
      created_at: "2026-01-01T00:00:00.000Z",
      items: [{
        id: "item",
        scenario_id: "scenario",
        name: "Extra",
        amount: 300,
        currency_id: null,
        frequency: "one_time",
        start_month: 9,
        start_year: 2026,
        end_month: 9,
        end_year: 2026,
        category_id: null,
        group_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
      }],
    }

    const [september] = buildAnnualProjection({
      year: 2026,
      selectedMonth: 8,
      asOfYear: 2026,
      asOfMonth: 8,
      startYear: 2026,
      startMonth: 9,
      monthsAhead: 1,
      transactions: [recurring],
      scenarios: [scenario],
    })

    expect(september.periodType).toBe("projected")
    expect(september.recurringExpenses).toBe(250)
    expect(september.scenarioImpact).toBe(300)
    expect(september.simulatedExpenses).toBe(550)
  })

  it("usa el cierre como baseline histórico y recalcula acumulados", () => {
    const points = buildAnnualProjection({
      year: 2026,
      selectedMonth: 8,
      asOfYear: 2026,
      asOfMonth: 8,
      startYear: 2026,
      startMonth: 1,
      monthsAhead: 2,
      transactions: [transaction({ amount: 100, transaction_date: "2026-01-10" })],
    })
    const closure: MonthlyClosure = {
      id: "closure",
      user_id: "user-id",
      family_id: null,
      year: 2026,
      month: 1,
      income_total: 500,
      expense_total: 200,
      savings_total: 300,
      cash_total: 0,
      investments_total: 0,
      foreign_currency_total: 0,
      snapshot: {},
      closed_by: null,
      closed_at: "2026-02-01T00:00:00.000Z",
      created_at: "2026-02-01T00:00:00.000Z",
    }

    const result = applyMonthlyClosures(points, [closure])

    expect(result[0]).toMatchObject({
      income: 500,
      expenses: 200,
      savings: 300,
      simulatedSavings: 300,
      cumulativeSavings: 300,
      isClosed: true,
    })
    expect(result[1].cumulativeSavings).toBe(300)
  })

  it("en el mes actual no cuenta pendientes en gastos/ahorro (alineado al dashboard)", () => {
    const [august] = buildAnnualProjection({
      year: 2026,
      selectedMonth: 8,
      asOfYear: 2026,
      asOfMonth: 8,
      startYear: 2026,
      startMonth: 8,
      monthsAhead: 1,
      transactions: [
        transaction({
          id: "paid-cash",
          amount: 100,
          transaction_date: "2026-08-05",
          payment_method: "cash",
          status: "approved",
        }),
        transaction({
          id: "pending-card",
          amount: 1,
          budgeted_amount: 500,
          transaction_date: "2026-08-13",
          payment_method: "credit",
          credit_card_purchase_id: "purchase-1",
          installment_number: 1,
          status: "pending",
        }),
        transaction({
          id: "income",
          amount: 1000,
          transaction_date: "2026-08-01",
          type: "income",
          status: "approved",
        }),
      ],
    })

    expect(august.periodType).toBe("current")
    expect(august.expenses).toBe(100)
    expect(august.actualExpenses).toBe(100)
    expect(august.installments).toBe(0)
    expect(august.income).toBe(1000)
    expect(august.savings).toBe(900)
  })

  it("excluye pendientes del promedio histórico de proyección", () => {
    const [october] = buildAnnualProjection({
      year: 2026,
      selectedMonth: 8,
      asOfYear: 2026,
      asOfMonth: 8,
      startYear: 2026,
      startMonth: 10,
      monthsAhead: 1,
      categories: [{
        id: "cat-avg",
        user_id: "user-id",
        name: "Promedio",
        type: "expense",
        color: "#666666",
        icon: null,
        group_id: null,
        parent_id: null,
        is_active: true,
        projection_method: "historical_average",
        projection_months: 3,
        created_at: "2026-01-01T00:00:00.000Z",
      }],
      transactions: [
        transaction({
          id: "approved-hist",
          amount: 300,
          category_id: "cat-avg",
          transaction_date: "2026-07-10",
          status: "approved",
        }),
        transaction({
          id: "pending-hist",
          amount: 9000,
          budgeted_amount: 9000,
          category_id: "cat-avg",
          transaction_date: "2026-06-10",
          status: "pending",
        }),
      ],
    })

    expect(october.periodType).toBe("projected")
    expect(october.essentialProjection).toBe(300)
    expect(october.expenses).toBe(300)
  })

  it("mantiene el mes actual en vivo y usa cierres para el saldo arrastrado", () => {
    const points = buildAnnualProjection({
      year: 2026,
      selectedMonth: 2,
      asOfYear: 2026,
      asOfMonth: 2,
      startYear: 2026,
      startMonth: 1,
      monthsAhead: 2,
      transactions: [
        transaction({ amount: 100, transaction_date: "2026-01-10" }),
        transaction({ amount: 50, transaction_date: "2026-02-10" }),
      ],
    })
    const closures: MonthlyClosure[] = [
      {
        id: "january-closure",
        user_id: "user-id",
        family_id: null,
        year: 2026,
        month: 1,
        income_total: 500,
        expense_total: 200,
        savings_total: 300,
        cash_total: 0,
        investments_total: 0,
        foreign_currency_total: 0,
        snapshot: {},
        closed_by: null,
        closed_at: "2026-02-01T00:00:00.000Z",
        created_at: "2026-02-01T00:00:00.000Z",
      },
      {
        id: "february-closure",
        user_id: "user-id",
        family_id: null,
        year: 2026,
        month: 2,
        income_total: 900,
        expense_total: 100,
        savings_total: 800,
        cash_total: 0,
        investments_total: 0,
        foreign_currency_total: 0,
        snapshot: {},
        closed_by: null,
        closed_at: "2026-03-01T00:00:00.000Z",
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ]

    const result = applyMonthlyClosures(points, closures)

    expect(result[0]).toMatchObject({ savings: 300, cumulativeSavings: 300, isClosed: true })
    expect(result[1]).toMatchObject({ savings: -50, cumulativeSavings: 250, isClosed: false })
  })
})
