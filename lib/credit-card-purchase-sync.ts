type ExistingInstallmentTransaction = {
  id: string
  installment_number: number | null
  status: "pending" | "approved" | "rejected" | null
  approved_at: string | null
  approved_by: string | null
  created_by: string | null
  archived_at: string | null
}

type SynchronizedInstallment = {
  installment_number: number
  status: "pending" | "approved" | "rejected"
  approved_at: string | null
  approved_by: string | null
  created_by: string
  [key: string]: unknown
}

export type PurchaseInstallmentSyncPlan = {
  updates: Array<{ id: string; payload: Record<string, unknown> }>
  inserts: Array<Record<string, unknown>>
  archiveIds: string[]
}

/**
 * Plan installment sync for an edited purchase.
 * - Never resurrects archived tombstones.
 * - Preserves approval fields on live rows.
 * - Archives (does not hard-delete) installments beyond the new total.
 */
export function planCreditCardPurchaseInstallmentSync({
  existingTransactions,
  synchronizedInstallments,
  totalInstallments,
}: {
  existingTransactions: ExistingInstallmentTransaction[]
  synchronizedInstallments: SynchronizedInstallment[]
  totalInstallments: number
}): PurchaseInstallmentSyncPlan {
  const liveByInstallment = new Map<number, ExistingInstallmentTransaction>()
  const archivedByInstallment = new Map<number, ExistingInstallmentTransaction>()

  for (const transaction of existingTransactions) {
    const installmentNumber = Number(transaction.installment_number || 0)
    if (!installmentNumber) continue
    if (transaction.archived_at) {
      archivedByInstallment.set(installmentNumber, transaction)
    } else {
      liveByInstallment.set(installmentNumber, transaction)
    }
  }

  const updates: PurchaseInstallmentSyncPlan["updates"] = []
  const inserts: PurchaseInstallmentSyncPlan["inserts"] = []

  for (const synchronizedInstallment of synchronizedInstallments) {
    const installmentNumber = synchronizedInstallment.installment_number
    const existingLive = liveByInstallment.get(installmentNumber)
    const existingArchived = archivedByInstallment.get(installmentNumber)

    // Tombstones must stay archived; materialize/reconcile already treat the key as taken.
    if (!existingLive && existingArchived) continue

    if (existingLive) {
      updates.push({
        id: existingLive.id,
        payload: {
          ...synchronizedInstallment,
          status: existingLive.status || synchronizedInstallment.status,
          approved_at: existingLive.approved_at || synchronizedInstallment.approved_at,
          approved_by: existingLive.approved_by || synchronizedInstallment.approved_by,
          created_by: existingLive.created_by ?? synchronizedInstallment.created_by,
          archived_at: existingLive.archived_at,
        },
      })
      continue
    }

    inserts.push({
      ...synchronizedInstallment,
      archived_at: null,
    })
  }

  const archiveIds = existingTransactions
    .filter((transaction) => {
      const installmentNumber = Number(transaction.installment_number || 0)
      return installmentNumber > totalInstallments && !transaction.archived_at
    })
    .map((transaction) => transaction.id)

  return { updates, inserts, archiveIds }
}
