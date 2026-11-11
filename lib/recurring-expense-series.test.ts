import { describe, expect, it } from "vitest"
import {
  applyAmountChange,
  getRecurringExpenseSeedAmounts,
  planRecurringExpenseAmountUpdate,
  planRecurringExpenseSeriesDisable,
  summarizeRecurringExpenseSeries,
  type RecurringExpenseOccurrence,
} from "@/lib/recurring-expense-series"

function occurrence(partial: Partial<RecurringExpenseOccurrence> & Pick<RecurringExpenseOccurrence, "id" | "description">): RecurringExpenseOccurrence {
  return {
    user_id: "user-1",
    family_id: "family-1",
    amount: 1000,
    budgeted_amount: 1000,
    currency_id: "ars",
    category_id: "cat-1",
    group_id: null,
    transaction_date: "2026-10-05",
    payment_method: "debit",
    credit_card_id: null,
    credit_card_purchase_id: null,
    installment_number: null,
    status: "pending",
    metadata: { recurring_series_id: "11111111-1111-4111-a111-111111111111" },
    archived_at: null,
    recurring_series_id: "11111111-1111-4111-a111-111111111111",
    recurrence_period: "2026-10-01",
    ...partial,
  }
}

describe("applyAmountChange", () => {
  it("soporta monto absoluto y porcentaje", () => {
    expect(applyAmountChange(1000, "absolute", 1250)).toBe(1250)
    expect(applyAmountChange(1000, "percent", 10)).toBe(1100)
    expect(applyAmountChange(999.99, "percent", 1)).toBe(1009.99)
  })

  it("rechaza resultados no positivos", () => {
    expect(() => applyAmountChange(100, "absolute", 0)).toThrow(/mayor a cero/i)
    expect(() => applyAmountChange(100, "percent", -100)).toThrow(/mayor a cero/i)
  })
})

describe("summarizeRecurringExpenseSeries", () => {
  it("agrupa por series e ignora cuotas e inactivos", () => {
    const rows = [
      occurrence({ id: "oct", description: "Netflix", recurrence_period: "2026-10-01", status: "approved", amount: 900, budgeted_amount: 900 }),
      occurrence({ id: "nov", description: "Netflix", recurrence_period: "2026-11-01", status: "pending", amount: 900, budgeted_amount: 900 }),
      occurrence({
        id: "installment",
        description: "Cuota",
        credit_card_purchase_id: "purchase-1",
        installment_number: 1,
        recurring_series_id: null,
        metadata: null,
      }),
      occurrence({
        id: "archived",
        description: "Netflix",
        recurrence_period: "2026-09-01",
        archived_at: "2026-09-02T00:00:00.000Z",
      }),
    ]

    const summaries = summarizeRecurringExpenseSeries(rows)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      seriesId: "11111111-1111-4111-a111-111111111111",
      description: "Netflix",
      currentAmount: 900,
      pendingCount: 1,
      approvedCount: 1,
      seedId: "nov",
    })
  })
})

describe("planRecurringExpenseAmountUpdate", () => {
  it("actualiza pendientes desde el período efectivo y preserva montos aprobados", () => {
    const rows = [
      occurrence({
        id: "sep",
        description: "Spotify",
        recurrence_period: "2026-09-01",
        status: "approved",
        amount: 800,
        budgeted_amount: 800,
      }),
      occurrence({
        id: "oct",
        description: "Spotify",
        recurrence_period: "2026-10-01",
        status: "approved",
        amount: 800,
        budgeted_amount: 800,
      }),
      occurrence({
        id: "nov",
        description: "Spotify",
        recurrence_period: "2026-11-01",
        status: "pending",
        amount: 800,
        budgeted_amount: 800,
      }),
      occurrence({
        id: "dec",
        description: "Spotify",
        recurrence_period: "2026-12-01",
        status: "pending",
        amount: 800,
        budgeted_amount: 800,
      }),
    ]

    const plan = planRecurringExpenseAmountUpdate({
      rows,
      seriesIds: ["11111111-1111-4111-a111-111111111111"],
      mode: "percent",
      value: 25,
      effectivePeriod: "2026-11-01",
    })

    expect(plan.preview[0]).toMatchObject({
      fromAmount: 800,
      toAmount: 1000,
      pendingUpdated: 2,
      seedBudgetedUpdated: true,
    })

    const byId = Object.fromEntries(plan.updates.map((item) => [item.id, item.payload]))
    expect(byId.nov).toMatchObject({ amount: 1000, budgeted_amount: 1000 })
    expect(byId.dec).toMatchObject({ amount: 1000, budgeted_amount: 1000 })
    expect(byId.oct).toBeUndefined()
    expect(byId.sep).toBeUndefined()
  })

  it("si no hay pendientes, actualiza solo budgeted del seed aprobado para próximas materializaciones", () => {
    const rows = [
      occurrence({
        id: "oct",
        description: "Internet",
        recurrence_period: "2026-10-01",
        status: "approved",
        amount: 2000,
        budgeted_amount: 2000,
      }),
    ]

    const plan = planRecurringExpenseAmountUpdate({
      rows,
      seriesIds: ["11111111-1111-4111-a111-111111111111"],
      mode: "absolute",
      value: 2500,
      effectivePeriod: "2026-11-01",
    })

    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({
      id: "oct",
      payload: {
        budgeted_amount: 2500,
      },
    })
    expect(plan.updates[0].payload.amount).toBeUndefined()
    expect(plan.preview[0]).toMatchObject({
      pendingUpdated: 0,
      seedBudgetedUpdated: true,
      toAmount: 2500,
    })
  })
})

describe("planRecurringExpenseSeriesDisable", () => {
  it("archiva pendientes futuros y corta la serie con end date", () => {
    const rows = [
      occurrence({
        id: "oct",
        description: "Gym",
        recurrence_period: "2026-10-01",
        status: "approved",
      }),
      occurrence({
        id: "nov",
        description: "Gym",
        recurrence_period: "2026-11-01",
        status: "pending",
      }),
      occurrence({
        id: "dec",
        description: "Gym",
        recurrence_period: "2026-12-01",
        status: "pending",
      }),
    ]

    const plan = planRecurringExpenseSeriesDisable({
      rows,
      seriesIds: ["11111111-1111-4111-a111-111111111111"],
      effectivePeriod: "2026-11-01",
    })

    expect(plan.archiveIds.sort()).toEqual(["dec", "nov"])
    expect(plan.endDateUpdates).toHaveLength(1)
    expect(plan.endDateUpdates[0]).toMatchObject({
      id: "oct",
      payload: {
        metadata: expect.objectContaining({
          recurrence_end_date: "2026-10-31",
          bulk_disabled_from_period: "2026-11-01",
        }),
      },
    })
    expect(plan.preview[0]).toMatchObject({
      pendingArchived: 2,
      remainingActive: 1,
      endDate: "2026-10-31",
    })
  })
})

describe("getRecurringExpenseSeedAmounts", () => {
  it("prioriza budgeted_amount para materializar el siguiente período", () => {
    expect(getRecurringExpenseSeedAmounts(occurrence({
      id: "seed",
      description: "Luz",
      amount: 500,
      budgeted_amount: 700,
      status: "approved",
    }))).toEqual({ amount: 700, budgeted_amount: 700 })
  })
})
