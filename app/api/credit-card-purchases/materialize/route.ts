import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { buildCreditCardInstallmentTransactions } from "@/lib/credit-card-installments"
import { toDateOnly } from "@/lib/date-only"
import type { CreditCard, CreditCardPurchase } from "@/lib/types"

type PurchaseWithRelations = CreditCardPurchase & {
  credit_card: CreditCard | null
  category?: { group_id: string | null } | null
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const today = new Date()
    const month = Number(body.month || today.getMonth() + 1)
    const year = Number(body.year || today.getFullYear())

    if (month < 1 || month > 12 || year < 2000 || year > 2100) {
      return NextResponse.json({ error: "Periodo inválido" }, { status: 400 })
    }

    const startDate = toDateOnly(year, month, 1)
    const endDate = toDateOnly(year, month, 31)

    const { data: purchases, error: purchasesError } = await supabase
      .from("credit_card_purchases")
      .select("*, credit_card:credit_cards(*), category:categories(group_id)")
      .eq("is_active", true)

    if (purchasesError) throw purchasesError

    const purchaseRows = (purchases || []) as PurchaseWithRelations[]
    const purchaseIds = purchaseRows.map((purchase) => purchase.id)
    const existingKeys = new Set<string>()

    if (purchaseIds.length > 0) {
      // Include archived tombstones so we do not attempt inserts that the
      // unique (purchase, installment) constraint would ignore anyway.
      const { data: existingTransactions, error: existingError } = await supabase
        .from("transactions")
        .select("credit_card_purchase_id, installment_number")
        .in("credit_card_purchase_id", purchaseIds)

      if (existingError) throw existingError

      for (const transaction of existingTransactions || []) {
        existingKeys.add(`${transaction.credit_card_purchase_id}:${transaction.installment_number}`)
      }
    }

    const inserts = []
    for (const purchase of purchaseRows) {
      const installments = buildCreditCardInstallmentTransactions({
        purchase,
        card: purchase.credit_card,
        groupId: purchase.category?.group_id || null,
        actorUserId: user.id,
        generatedFor: `${year}-${String(month).padStart(2, "0")}`,
      })

      for (const installment of installments) {
        const dueDate = installment.transaction_date
        if (dueDate < startDate || dueDate > endDate) continue
        if (existingKeys.has(`${purchase.id}:${installment.installment_number}`)) continue
        inserts.push(installment)
      }
    }

    let created = 0
    if (inserts.length > 0) {
      const { data: upserted, error: insertError } = await supabase
        .from("transactions")
        .upsert(inserts, {
          onConflict: "credit_card_purchase_id,installment_number",
          ignoreDuplicates: true,
        })
        .select("id")
      if (insertError) throw insertError
      // With ignoreDuplicates, select returns only rows that were actually inserted.
      created = upserted?.length || 0
    }

    return NextResponse.json({ ok: true, created, attempted: inserts.length })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al materializar cuotas" },
      { status: 500 },
    )
  }
}
