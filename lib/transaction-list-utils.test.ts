import { describe, expect, it } from "vitest"
import {
  getTransactionActualAmount,
  getTransactionBudgetedAmount,
  getTransactionDisplayAmount,
  getTransactionRecurrenceKind,
  matchesTransactionSearch,
  parseLocalizedAmount,
} from "@/lib/transaction-list-utils"

describe("transaction list helpers", () => {
  it.each([
    ["9000", 9000],
    ["9.000", 9000],
    ["9000,50", 9000.5],
    ["9.000,50", 9000.5],
    ["9,000.50", 9000.5],
  ])("parses %s as an amount", (query, expected) => {
    expect(parseLocalizedAmount(query)).toBe(expected)
  })

  it("searches text only in the description", () => {
    const transaction = { description: "Gastos varios", amount: 9000, budgeted_amount: 9000, status: "approved" as const }

    expect(matchesTransactionSearch(transaction, "varios")).toBe(true)
    expect(matchesTransactionSearch(transaction, "compras")).toBe(false)
  })

  it("usa budgeted para pending en display y búsqueda", () => {
    const pending = {
      description: "Cuota tarjeta",
      amount: 1,
      budgeted_amount: 40133.33,
      status: "pending" as const,
    }

    expect(getTransactionActualAmount(pending)).toBe(0)
    expect(getTransactionBudgetedAmount(pending)).toBe(40133.33)
    expect(getTransactionDisplayAmount(pending)).toBe(40133.33)
    expect(matchesTransactionSearch(pending, "40133,33")).toBe(true)
    expect(matchesTransactionSearch(pending, "1")).toBe(false)
  })

  it("searches numeric queries by the displayed real amount when approved", () => {
    const approved = { description: "Compra", amount: 9000, budgeted_amount: 9000, status: "approved" as const }

    expect(matchesTransactionSearch(approved, "9.000")).toBe(true)
    expect(getTransactionActualAmount(approved)).toBe(9000)
  })

  it("separates automatic card debits from recurring expenses", () => {
    expect(getTransactionRecurrenceKind({
      type: "expense",
      is_recurring: true,
      payment_method: "credit",
      credit_card_id: "card-id",
    })).toBe("automatic_debit")

    expect(getTransactionRecurrenceKind({
      type: "expense",
      is_recurring: true,
      payment_method: "debit",
      credit_card_id: null,
    })).toBe("recurring")

    expect(getTransactionRecurrenceKind({
      type: "expense",
      is_recurring: false,
      payment_method: "credit",
      credit_card_id: "card-id",
    })).toBe("normal")
  })
})
