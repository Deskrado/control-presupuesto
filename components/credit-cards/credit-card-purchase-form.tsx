"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { useCategories, useCreditCards } from "@/components/dashboard/use-dashboard-data"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatCurrency } from "@/lib/currency"
import { CreditCardSelectLabel } from "@/components/credit-cards/card-brand"
import { formatDateOnlyForDisplay, getCreditCardStatementDueDate } from "@/lib/credit-card-billing"
import type { CreditCardPurchase } from "@/lib/types"
import { ArrowLeft, Loader2 } from "lucide-react"
import Link from "next/link"
import { invalidateCache, invalidateCacheByPrefix } from "@/lib/swr-cache"
import { buildCreditCardInstallmentTransactions, splitInstallmentAmounts } from "@/lib/credit-card-installments"
import { planCreditCardPurchaseInstallmentSync } from "@/lib/credit-card-purchase-sync"
import { toLocalDateOnly } from "@/lib/date-only"

type CreditCardPurchaseFormProps = {
  initialData?: CreditCardPurchase
}

type ExistingInstallmentTransaction = {
  id: string
  installment_number: number | null
  status: "pending" | "approved" | "rejected" | null
  approved_at: string | null
  approved_by: string | null
  created_by: string | null
  archived_at: string | null
}

export function CreditCardPurchaseForm({ initialData }: CreditCardPurchaseFormProps) {
  const router = useRouter()
  const { data: cards } = useCreditCards()
  const { data: categories } = useCategories()
  const [form, setForm] = useState({
    credit_card_id: initialData?.credit_card_id || "",
    description: initialData?.description || "",
    total_amount: initialData?.total_amount?.toString() || "",
    total_installments: initialData?.total_installments?.toString() || "1",
    start_date: initialData?.start_date || toLocalDateOnly(),
    category_id: initialData?.category_id || "__none",
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedCard = cards?.find((card) => card.id === form.credit_card_id)
  const selectedCategory = categories?.find((category) => category.id === form.category_id)
  const firstInstallmentDueDate = selectedCard && form.start_date
    ? getCreditCardStatementDueDate(form.start_date, selectedCard)
    : form.start_date
  const installmentAmounts = useMemo(() => {
    const total = Number(form.total_amount) || 0
    const installments = Math.max(Number(form.total_installments) || 1, 1)
    return splitInstallmentAmounts(total, installments)
  }, [form.total_amount, form.total_installments])
  const installmentAmount = installmentAmounts[0] || 0

  const savePurchase = async () => {
    if (!form.credit_card_id || !form.description.trim() || Number(form.total_amount) <= 0) {
      setError("Completa tarjeta, descripción y monto total")
      return
    }
    if (!form.start_date) {
      setError("Selecciona la fecha de inicio")
      return
    }
    if (!Number.isInteger(Number(form.total_installments)) || Number(form.total_installments) < 1) {
      setError("La cantidad de cuotas debe ser mayor o igual a 1")
      return
    }
    if (!selectedCard) {
      setError("Selecciona una tarjeta válida")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error("No estás autenticado")

      const totalInstallments = Number(form.total_installments)
      const purchasePayload = {
        user_id: initialData?.user_id || user.id,
        family_id: initialData?.family_id || selectedCard.family_id || null,
        credit_card_id: form.credit_card_id,
        description: form.description.trim(),
        total_amount: Number(form.total_amount),
        installment_amount: installmentAmount,
        total_installments: totalInstallments,
        start_date: form.start_date,
        category_id: form.category_id === "__none" ? null : form.category_id,
        currency_id: selectedCard.currency_id || null,
        is_active: true,
      }

      const purchaseResult = initialData?.id
        ? await supabase
            .from("credit_card_purchases")
            .update(purchasePayload)
            .eq("id", initialData.id)
            .select("id, user_id, family_id")
            .single()
        : await supabase
            .from("credit_card_purchases")
            .insert(purchasePayload)
            .select("id, user_id, family_id")
            .single()

      if (purchaseResult.error) throw purchaseResult.error
      const purchaseId = purchaseResult.data.id

      const { data: existingTransactions, error: existingTransactionsError } = await supabase
        .from("transactions")
        .select("id, installment_number, status, approved_at, approved_by, created_by, archived_at")
        .eq("credit_card_purchase_id", purchaseId)

      if (existingTransactionsError) throw existingTransactionsError

      const synchronizedInstallments = buildCreditCardInstallmentTransactions({
        purchase: {
          ...purchasePayload,
          id: purchaseId,
          user_id: purchaseResult.data.user_id,
          family_id: purchaseResult.data.family_id,
          category_id: purchasePayload.category_id,
        },
        card: selectedCard,
        groupId: selectedCategory?.group_id || null,
        actorUserId: user.id,
      })

      const syncPlan = planCreditCardPurchaseInstallmentSync({
        existingTransactions: (existingTransactions || []) as ExistingInstallmentTransaction[],
        synchronizedInstallments,
        totalInstallments,
      })

      for (const update of syncPlan.updates) {
        const { error: updateError } = await supabase
          .from("transactions")
          .update(update.payload)
          .eq("id", update.id)
        if (updateError) throw updateError
      }

      if (syncPlan.inserts.length > 0) {
        const { error: insertError } = await supabase.from("transactions").upsert(syncPlan.inserts, {
          onConflict: "credit_card_purchase_id,installment_number",
          ignoreDuplicates: true,
        })
        if (insertError) throw insertError
      }

      if (syncPlan.archiveIds.length > 0) {
        const { error: archiveExtraError } = await supabase
          .from("transactions")
          .update({ archived_at: new Date().toISOString() })
          .in("id", syncPlan.archiveIds)
          .is("archived_at", null)
        if (archiveExtraError) throw archiveExtraError
      }

      invalidateCache("credit-card-purchases")
      invalidateCache("credit-card-statements")
      invalidateCache("credit-card-statement-transactions")
      invalidateCacheByPrefix("transactions")
      router.push("/dashboard/tarjetas")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar la compra")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/dashboard/tarjetas">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <CardTitle className="truncate">{initialData?.id ? "Editar compra en cuotas" : "Compra en cuotas"}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Tarjeta</Label>
            <Select value={form.credit_card_id} onValueChange={(value) => setForm({ ...form, credit_card_id: value })}>
              <SelectTrigger>
                {selectedCard ? (
                  <CreditCardSelectLabel card={selectedCard} />
                ) : (
                  <SelectValue placeholder="Seleccionar tarjeta" />
                )}
              </SelectTrigger>
              <SelectContent>
                {cards?.filter((card) => card.is_active).map((card) => (
                  <SelectItem key={card.id} value={card.id} textValue={`${card.name} ${card.brand || ""} ${card.last_four || ""}`}>
                    <CreditCardSelectLabel card={card} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Categoria</Label>
            <Select value={form.category_id} onValueChange={(value) => setForm({ ...form, category_id: value })}>
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar categoría" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Sin categoria</SelectItem>
                {categories?.filter((category) => category.type === "expense").map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Descripción</Label>
          <Input id="description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="total_amount">Monto total</Label>
            <Input id="total_amount" type="number" step="0.01" value={form.total_amount} onChange={(event) => setForm({ ...form, total_amount: event.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="total_installments">Cuotas</Label>
            <Input id="total_installments" type="number" min={1} value={form.total_installments} onChange={(event) => setForm({ ...form, total_installments: event.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="start_date">Fecha de compra</Label>
            <Input id="start_date" type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
          </div>
        </div>

        <div className="rounded-md border p-3">
          <p className="text-sm text-muted-foreground">Valor de cuota</p>
          <p className="text-xl font-semibold font-mono">{formatCurrency(installmentAmount, selectedCard?.currency)}</p>
          {installmentAmounts.length > 1 && installmentAmounts[0] !== installmentAmounts[installmentAmounts.length - 1] && (
            <p className="mt-1 text-xs text-muted-foreground">
              Las cuotas se ajustan en centavos para que sumen exactamente el total.
            </p>
          )}
          {selectedCard && form.start_date && (
            <p className="mt-2 text-sm text-muted-foreground">
              La primera cuota impactará el {formatDateOnlyForDisplay(firstInstallmentDueDate)} según el cierre y vencimiento de la tarjeta. El efectivo solo se reduce al confirmar el pago del resumen.
            </p>
          )}
        </div>

        <div className="grid gap-2 pt-2 sm:flex">
          <Button className="w-full sm:w-auto" onClick={savePurchase} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {initialData?.id ? "Guardar cambios" : "Guardar compra"}
          </Button>
          <Button variant="outline" className="w-full sm:w-auto" asChild>
            <Link href="/dashboard/tarjetas">Cancelar</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
