import { describe, expect, it } from "vitest"
import {
  allocateStatementPayment,
  calculateStatementBalances,
  calculateStatementPaymentApplication,
  getApplicablePreviousBalance,
  getPreviousStatementPeriod,
  getStatementTransactionAmount,
  isStatementPaymentAdjustment,
} from "./credit-card-statement-calculations"

describe("credit card statement calculations", () => {
  it("uses actual amounts for approved transactions and budgeted amounts for pending ones", () => {
    expect(getStatementTransactionAmount({ status: "approved", amount: 80, budgeted_amount: 100 })).toBe(80)
    expect(getStatementTransactionAmount({ status: "pending", amount: 80, budgeted_amount: 100 })).toBe(100)
  })

  it("recognizes payment adjustments so they are not counted as consumption again", () => {
    expect(isStatementPaymentAdjustment({
      metadata: { source: "credit_card_statement_payment_adjustment" },
    })).toBe(true)
    expect(isStatementPaymentAdjustment({ metadata: { source: "recurring_expense" } })).toBe(false)
  })

  it("only reads carryover from the immediately preceding statement", () => {
    expect(getPreviousStatementPeriod(2026, 8)).toEqual({ year: 2026, month: 7 })
    expect(getPreviousStatementPeriod(2026, 1)).toEqual({ year: 2025, month: 12 })
  })

  it("expires old credit but keeps outstanding debt until a later statement settles it", () => {
    expect(getApplicablePreviousBalance({
      carryoverBalance: -80,
      statementYear: 2026,
      statementMonth: 6,
      targetYear: 2026,
      targetMonth: 8,
    })).toBe(0)
    expect(getApplicablePreviousBalance({
      carryoverBalance: 80,
      statementYear: 2026,
      statementMonth: 6,
      targetYear: 2026,
      targetMonth: 8,
    })).toBe(80)
  })

  it("consumes an existing credit without allowing a negative total payable", () => {
    expect(calculateStatementBalances({ expectedAmount: 331_709.83, previousBalance: -87_738.93 })).toEqual({
      amountDue: 243_970.9,
      balanceDelta: 243_970.9,
      carryoverBalance: 243_970.9,
    })
    expect(calculateStatementBalances({ expectedAmount: 50, previousBalance: -80, paidAmount: 0 })).toEqual({
      amountDue: 0,
      balanceDelta: 0,
      carryoverBalance: 0,
    })
  })

  it("expires the old credit after payment and only carries a new overpayment", () => {
    expect(calculateStatementBalances({ expectedAmount: 100, previousBalance: -20, paidAmount: 80 }).carryoverBalance).toBe(0)
    expect(calculateStatementBalances({ expectedAmount: 100, previousBalance: -20, paidAmount: 90 }).carryoverBalance).toBe(-10)
  })

  it("uses prior credit to cover current consumptions before allocating cash", () => {
    expect(calculateStatementPaymentApplication({ expectedAmount: 100, previousBalance: -20, paidAmount: 80 })).toMatchObject({
      amountDue: 80,
      carryoverBalance: 0,
      targetCurrentExpense: 100,
      adjustmentAmount: 0,
    })
    expect(calculateStatementPaymentApplication({ expectedAmount: 50, previousBalance: -80, paidAmount: 0 })).toMatchObject({
      amountDue: 0,
      carryoverBalance: 0,
      targetCurrentExpense: 50,
      adjustmentAmount: 0,
    })
  })

  it("settles prior debt before allocating payment to current consumptions", () => {
    expect(calculateStatementPaymentApplication({ expectedAmount: 100, previousBalance: 30, paidAmount: 80 })).toMatchObject({
      amountDue: 130,
      carryoverBalance: 50,
      targetCurrentExpense: 50,
      adjustmentAmount: 0,
    })
  })

  it("computes overpayment against amount_due (expected + previous_balance), not expected alone", () => {
    // Legacy backfill used paid - expected (= 20) whenever paid > expected.
    // App + repair migration use paid - amount_due (= 0 here).
    expect(calculateStatementPaymentApplication({
      expectedAmount: 100,
      previousBalance: 30,
      paidAmount: 120,
    })).toMatchObject({
      amountDue: 130,
      adjustmentAmount: 0,
      carryoverBalance: 10,
    })

    expect(calculateStatementPaymentApplication({
      expectedAmount: 100,
      previousBalance: 30,
      paidAmount: 150,
    })).toMatchObject({
      amountDue: 130,
      adjustmentAmount: 20,
      carryoverBalance: -20,
    })

    // Prior credit: paid can be below expected yet still overpay amount_due.
    expect(calculateStatementPaymentApplication({
      expectedAmount: 100,
      previousBalance: -20,
      paidAmount: 90,
    })).toMatchObject({
      amountDue: 80,
      adjustmentAmount: 10,
      carryoverBalance: -10,
    })
  })

  it("allocates payment in cents without inventing a minimum transaction amount", () => {
    const allocation = allocateStatementPayment([
      { id: "a", weight: 10 },
      { id: "b", weight: 10 },
      { id: "c", weight: 10 },
    ], 10)
    expect([...allocation.values()].reduce((sum, value) => sum + value, 0)).toBe(10)
    expect(allocateStatementPayment([{ id: "a", weight: 10 }], 0).get("a")).toBe(0)
  })
})
