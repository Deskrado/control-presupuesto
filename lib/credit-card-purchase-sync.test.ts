import { describe, expect, it } from "vitest"
import { planCreditCardPurchaseInstallmentSync } from "@/lib/credit-card-purchase-sync"

const baseSyncRow = {
  status: "pending" as const,
  approved_at: null,
  approved_by: null,
  created_by: "actor",
  description: "Compra",
  amount: 100,
}

describe("planCreditCardPurchaseInstallmentSync", () => {
  it("no resurge tombstones archivados al re-sincronizar", () => {
    const plan = planCreditCardPurchaseInstallmentSync({
      existingTransactions: [
        {
          id: "live-1",
          installment_number: 1,
          status: "approved",
          approved_at: "2026-06-01T00:00:00.000Z",
          approved_by: "owner",
          created_by: "owner",
          archived_at: null,
        },
        {
          id: "tombstone-2",
          installment_number: 2,
          status: "pending",
          approved_at: null,
          approved_by: null,
          created_by: "owner",
          archived_at: "2026-07-01T00:00:00.000Z",
        },
      ],
      synchronizedInstallments: [
        { ...baseSyncRow, installment_number: 1, amount: 110 },
        { ...baseSyncRow, installment_number: 2, amount: 110 },
      ],
      totalInstallments: 2,
    })

    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({
      id: "live-1",
      payload: {
        amount: 110,
        status: "approved",
        archived_at: null,
      },
    })
    expect(plan.inserts).toEqual([])
    expect(plan.archiveIds).toEqual([])
  })

  it("archiva en vez de borrar al reducir cuotas", () => {
    const plan = planCreditCardPurchaseInstallmentSync({
      existingTransactions: [
        {
          id: "row-1",
          installment_number: 1,
          status: "pending",
          approved_at: null,
          approved_by: null,
          created_by: "owner",
          archived_at: null,
        },
        {
          id: "row-2",
          installment_number: 2,
          status: "pending",
          approved_at: null,
          approved_by: null,
          created_by: "owner",
          archived_at: null,
        },
        {
          id: "row-3",
          installment_number: 3,
          status: "pending",
          approved_at: null,
          approved_by: null,
          created_by: "owner",
          archived_at: null,
        },
      ],
      synchronizedInstallments: [
        { ...baseSyncRow, installment_number: 1 },
        { ...baseSyncRow, installment_number: 2 },
      ],
      totalInstallments: 2,
    })

    expect(plan.archiveIds).toEqual(["row-3"])
    expect(plan.updates.map((row) => row.id)).toEqual(["row-1", "row-2"])
  })
})
