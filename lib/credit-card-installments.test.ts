import { describe, expect, it } from "vitest"
import {
  buildCreditCardInstallmentTransactions,
  splitInstallmentAmounts,
} from "@/lib/credit-card-installments"
import type { CreditCard } from "@/lib/types"

const bbvaMastercard = {
  id: "card-bbva-mastercard",
  user_id: "purchase-owner",
  family_id: "family-1",
  name: "BBVA Mastercard",
  brand: "mastercard",
  closing_day: 2,
  due_day: 13,
  currency_id: "ars",
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
} as CreditCard

describe("splitInstallmentAmounts", () => {
  it("reparte el resto en centavos para que la suma sea exacta", () => {
    const amounts = splitInstallmentAmounts(100_000, 3)
    expect(amounts).toEqual([33333.34, 33333.33, 33333.33])
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(100_000)
  })

  it("soporta totales ya exactos", () => {
    expect(splitInstallmentAmounts(90, 3)).toEqual([30, 30, 30])
  })
})

describe("buildCreditCardInstallmentTransactions", () => {
  it("genera la cuota 3 de BBVA en agosto con cierre 2 y vencimiento 13", () => {
    const installments = buildCreditCardInstallmentTransactions({
      purchase: {
        id: "purchase-1",
        user_id: "purchase-owner",
        family_id: "family-1",
        credit_card_id: bbvaMastercard.id,
        description: "Zapatillas Lilu",
        installment_amount: 67032.33,
        total_amount: 201096.99,
        total_installments: 3,
        start_date: "2026-05-03",
        category_id: "clothing",
        currency_id: "ars",
      },
      card: bbvaMastercard,
      actorUserId: "family-member-materializer",
      generatedAt: "2026-07-06T12:00:00.000Z",
    })

    expect(installments.map((installment) => installment.transaction_date)).toEqual([
      "2026-06-13",
      "2026-07-13",
      "2026-08-13",
    ])
    expect(installments.reduce((sum, row) => sum + row.amount, 0)).toBe(201096.99)
    expect(installments[2]).toMatchObject({
      amount: 67032.33,
      installment_number: 3,
      status: "pending",
      approved_at: null,
      approved_by: null,
      user_id: "purchase-owner",
      family_id: "family-1",
      created_by: "family-member-materializer",
    })
  })

  it("deja cuotas pre-junio 2026 aprobadas por compatibilidad histórica", () => {
    const installments = buildCreditCardInstallmentTransactions({
      purchase: {
        id: "purchase-legacy",
        user_id: "purchase-owner",
        credit_card_id: bbvaMastercard.id,
        description: "Compra vieja",
        installment_amount: 100,
        total_amount: 100,
        total_installments: 1,
        start_date: "2026-04-01",
        currency_id: "ars",
      },
      card: bbvaMastercard,
      actorUserId: "purchase-owner",
      generatedAt: "2026-04-02T12:00:00.000Z",
    })

    expect(installments[0]).toMatchObject({
      transaction_date: "2026-04-13",
      status: "approved",
      approved_at: "2026-04-02T12:00:00.000Z",
      approved_by: "purchase-owner",
    })
  })
})
