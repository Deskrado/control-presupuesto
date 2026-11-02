import type { CreditCard } from "@/lib/types"
import { getCreditCardInstallmentDueDate, requiresCreditCardPaymentApproval } from "@/lib/credit-card-billing"
import { roundStatementCurrency } from "@/lib/credit-card-statement-calculations"

type InstallmentSource = {
  id: string
  user_id: string
  family_id?: string | null
  credit_card_id: string
  description: string
  installment_amount: number
  total_amount?: number | null
  total_installments: number
  start_date: string
  category_id?: string | null
  currency_id?: string | null
  notes?: string | null
}

type BuildInstallmentsOptions = {
  purchase: InstallmentSource
  card: CreditCard | null | undefined
  groupId?: string | null
  actorUserId: string
  generatedFor?: string
  generatedAt?: string
}

/** Split a total into N cent-safe amounts that always sum back to the total. */
export function splitInstallmentAmounts(total: number, installments: number): number[] {
  const count = Math.max(Math.floor(Number(installments) || 1), 1)
  const totalCents = Math.round((Number(total) || 0) * 100)
  const baseCents = Math.floor(totalCents / count)
  const remainderCents = totalCents - baseCents * count

  return Array.from({ length: count }, (_, index) =>
    roundStatementCurrency((baseCents + (index < remainderCents ? 1 : 0)) / 100),
  )
}

export function getPurchaseInstallmentAmounts(purchase: Pick<InstallmentSource, "total_amount" | "installment_amount" | "total_installments">) {
  const totalInstallments = Math.max(Math.floor(Number(purchase.total_installments) || 1), 1)
  const totalAmount = purchase.total_amount == null
    ? Number(purchase.installment_amount || 0) * totalInstallments
    : Number(purchase.total_amount || 0)

  return splitInstallmentAmounts(totalAmount, totalInstallments)
}

export function buildCreditCardInstallmentTransactions({
  purchase,
  card,
  groupId = null,
  actorUserId,
  generatedFor,
  generatedAt = new Date().toISOString(),
}: BuildInstallmentsOptions) {
  const amounts = getPurchaseInstallmentAmounts(purchase)

  return amounts.map((amount, index) => {
    const installmentNumber = index + 1
    const dueDate = getCreditCardInstallmentDueDate(purchase.start_date, card, index)
    // Card installments are debt until the statement is paid. "Confirmar pago"
    // is what moves them from pending → approved and reduces cash.
    const requiresApproval = requiresCreditCardPaymentApproval(dueDate)

    return {
      user_id: purchase.user_id,
      family_id: purchase.family_id || null,
      created_by: actorUserId,
      description: purchase.description,
      amount: amount,
      budgeted_amount: amount,
      currency_id: purchase.currency_id || card?.currency_id || null,
      category_id: purchase.category_id || null,
      group_id: groupId,
      transaction_date: dueDate,
      type: "expense" as const,
      is_recurring: false,
      payment_method: "credit" as const,
      credit_card_id: purchase.credit_card_id,
      credit_card_purchase_id: purchase.id,
      installment_number: installmentNumber,
      status: requiresApproval ? ("pending" as const) : ("approved" as const),
      approved_at: requiresApproval ? null : generatedAt,
      approved_by: requiresApproval ? null : actorUserId,
      notes: purchase.notes || null,
      metadata: {
        source: "credit_card_installment",
        purchase_date: purchase.start_date,
        billing_date: dueDate,
        billing_rule: "credit_card_statement_due",
        total_installments: purchase.total_installments,
        generated_at: generatedAt,
        ...(generatedFor ? { generated_for: generatedFor } : {}),
      },
    }
  })
}
