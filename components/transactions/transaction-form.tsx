"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useCategories, useGroups, useCurrencies, useCreditCards, useUserSettings } from "@/components/dashboard/use-dashboard-data"
import { CreditCardSelectLabel } from "@/components/credit-cards/card-brand"
import { formatCurrency } from "@/lib/currency"
import {
  addMonthsToDateOnly,
  formatDateOnlyForDisplay,
  getCreditCardStatementDueDate,
  requiresCreditCardPaymentApproval,
} from "@/lib/credit-card-billing"
import { Switch } from "@/components/ui/switch"
import { ArrowLeft, Loader2 } from "lucide-react"
import Link from "next/link"
import { invalidateCache, invalidateCacheByPrefix } from "@/lib/swr-cache"
import { buildCreditCardInstallmentTransactions, splitInstallmentAmounts } from "@/lib/credit-card-installments"
import { toLocalDateOnly } from "@/lib/date-only"

const transactionSchema = z.object({
  description: z.string().min(1, "La descripción es requerida"),
  amount: z.coerce.number().positive("El monto debe ser mayor a 0"),
  budgeted_amount: z.coerce.number().optional(),
  currency_id: z.string().min(1, "Selecciona una moneda"),
  category_id: z.string().optional(),
  group_id: z.string().optional(),
  transaction_date: z.string().min(1, "La fecha es requerida"),
  payment_method: z.enum(["cash", "debit", "credit", "transfer"]).optional(),
  credit_card_id: z.string().optional(),
  is_installment_purchase: z.boolean().default(false),
  total_installments: z.coerce.number().optional(),
  recurrence_end_date: z.string().optional(),
  is_recurring: z.boolean().default(false),
  notes: z.string().optional(),
})

type TransactionFormData = z.infer<typeof transactionSchema>

interface TransactionFormProps {
  type: "expense" | "income"
  initialData?: Partial<TransactionFormData> & { id?: string }
  backUrl?: string
  redirectUrl?: string
}

function getRecurringDates(startDate: string, endDate: string | undefined, monthsAhead: number) {
  const count = Math.max(monthsAhead || 6, 1)
  const dates: string[] = []

  for (let index = 0; index < count; index += 1) {
    const nextDate = addMonthsToDateOnly(startDate, index)
    if (endDate && nextDate > endDate) break
    dates.push(nextDate)
  }

  return dates
}

export function TransactionForm({ type, initialData, backUrl, redirectUrl }: TransactionFormProps) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const { data: categories } = useCategories()
  const { data: groups } = useGroups()
  const { data: currencies } = useCurrencies()
  const { data: creditCards } = useCreditCards()
  const { data: settings } = useUserSettings()
  
  const filteredCategories = categories?.filter((c) => c.type === type) || []
  const defaultCurrency = settings?.default_currency || currencies?.find((c) => c.code === "ARS") || currencies?.[0]

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<TransactionFormData>({
    resolver: zodResolver(transactionSchema),
    defaultValues: {
      description: initialData?.description || "",
      amount: initialData?.amount || undefined,
      budgeted_amount: initialData?.budgeted_amount || undefined,
      currency_id: initialData?.currency_id || defaultCurrency?.id || "",
      category_id: initialData?.category_id || "__none",
      group_id: initialData?.group_id || "__none",
      transaction_date: initialData?.transaction_date || toLocalDateOnly(),
      payment_method: initialData?.payment_method || undefined,
      credit_card_id: initialData?.credit_card_id || "__none",
      is_installment_purchase: false,
      total_installments: 1,
      recurrence_end_date: "",
      is_recurring: initialData?.is_recurring || false,
      notes: initialData?.notes || "",
    },
  })

  const isRecurring = watch("is_recurring")
  const selectedCurrencyId = watch("currency_id")
  const selectedCategoryId = watch("category_id")
  const selectedGroupId = watch("group_id")
  const selectedCreditCardId = watch("credit_card_id")
  const paymentMethod = watch("payment_method")
  const isInstallmentPurchase = watch("is_installment_purchase")
  const transactionDate = watch("transaction_date")
  const totalInstallments = Math.max(Number(watch("total_installments")) || 1, 1)
  const amount = Number(watch("amount")) || 0
  const selectedCreditCard = creditCards?.find((card) => card.id === selectedCreditCardId)
  const installmentAmount = isInstallmentPurchase ? amount / totalInstallments : amount
  const shouldShowExpenseRecurrence = type === "expense" && isRecurring && !isInstallmentPurchase && !initialData?.id
  const showCreditCardBillingPreview = type === "expense" && paymentMethod === "credit" && selectedCreditCard && transactionDate && !initialData?.id
  const creditCardBillingDate = showCreditCardBillingPreview
    ? getCreditCardStatementDueDate(transactionDate, selectedCreditCard)
    : transactionDate

  useEffect(() => {
    if (!selectedCurrencyId && defaultCurrency?.id) {
      setValue("currency_id", defaultCurrency.id)
    }
  }, [defaultCurrency?.id, selectedCurrencyId, setValue])

  useEffect(() => {
    if (!selectedCategoryId || selectedCategoryId === "__none") return
    if (selectedGroupId && selectedGroupId !== "__none") return

    const selectedCategory = filteredCategories.find((category) => category.id === selectedCategoryId)
    if (selectedCategory?.group_id) {
      setValue("group_id", selectedCategory.group_id)
    }
  }, [filteredCategories, selectedCategoryId, selectedGroupId, setValue])

  useEffect(() => {
    if (paymentMethod !== "credit") {
      setValue("is_installment_purchase", false)
      setValue("total_installments", 1)
      setValue("credit_card_id", "__none")
    }
  }, [paymentMethod, setValue])

  const handleCategoryChange = (value: string) => {
    setValue("category_id", value, { shouldDirty: true, shouldValidate: true })
    const selectedCategory = filteredCategories.find((category) => category.id === value)
    setValue("group_id", selectedCategory?.group_id || "__none", { shouldDirty: true, shouldValidate: true })
  }

  const onSubmit = async (data: TransactionFormData) => {
    setIsSubmitting(true)
    setError(null)
    let createdPurchaseIdForCleanup: string | null = null
    let createdPurchaseScope: { id: string; user_id: string; family_id: string | null } | null = null

    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      
      if (!user) {
        setError("No estás autenticado")
        return
      }

      if (data.payment_method === "credit" && (!data.credit_card_id || data.credit_card_id === "__none")) {
        setError("Selecciona una tarjeta para pagos con crédito")
        return
      }

      const shouldCreateInstallments = type === "expense" && data.payment_method === "credit" && data.is_installment_purchase
      const isNewCreditCardExpense = type === "expense" && data.payment_method === "credit" && !initialData?.id
      const creditCardForSubmit = isNewCreditCardExpense
        ? creditCards?.find((card) => card.id === data.credit_card_id)
        : null
      const getBillingDate = (purchaseDate: string) =>
        creditCardForSubmit ? getCreditCardStatementDueDate(purchaseDate, creditCardForSubmit) : purchaseDate
      const shouldCreateRecurringExpense =
        type === "expense" &&
        data.is_recurring &&
        !data.is_installment_purchase &&
        !initialData?.id
      const installments = Math.max(Number(data.total_installments) || 1, 1)
      if (shouldCreateInstallments && installments < 2) {
        setError("La cantidad de cuotas debe ser mayor a 1")
        return
      }
      if (shouldCreateRecurringExpense && data.recurrence_end_date && data.recurrence_end_date < data.transaction_date) {
        setError("La fecha de fin no puede ser anterior al inicio")
        return
      }

      let creditCardPurchaseId: string | null = null
      const billingTransactionDate = getBillingDate(data.transaction_date)
      const requiresCardApproval =
        data.payment_method === "credit" && requiresCreditCardPaymentApproval(billingTransactionDate)
      const installmentAmounts = shouldCreateInstallments
        ? splitInstallmentAmounts(Number(data.amount), installments)
        : null
      const transactionAmount = installmentAmounts ? installmentAmounts[0] : Number(data.amount)
      const budgetedAmount = data.budgeted_amount || transactionAmount

      if (shouldCreateRecurringExpense) {
        let duplicateQuery = supabase
          .from("transactions")
          .select("id")
          .eq("user_id", user.id)
          .eq("type", type)
          .eq("is_recurring", true)
          .is("archived_at", null)
          .ilike("description", data.description.trim())
          .eq("amount", transactionAmount)
          .gte("transaction_date", data.transaction_date)
          .limit(1)
        duplicateQuery = data.payment_method
          ? duplicateQuery.eq("payment_method", data.payment_method)
          : duplicateQuery.is("payment_method", null)

        const { data: existingRecurring, error: existingRecurringError } = await duplicateQuery
        if (existingRecurringError) throw existingRecurringError
        if (existingRecurring && existingRecurring.length > 0) {
          setError("Ya existe un gasto recurrente activo con esta descripción y monto. Editá el existente en lugar de crear uno nuevo.")
          return
        }
      }

      if (shouldCreateInstallments) {
        const { data: purchase, error: purchaseError } = await supabase
          .from("credit_card_purchases")
          .insert({
            user_id: user.id,
            family_id: creditCardForSubmit?.family_id || null,
            credit_card_id: data.credit_card_id,
            description: data.description.trim(),
            total_amount: Number(data.amount),
            installment_amount: installmentAmounts?.[0] || transactionAmount,
            total_installments: installments,
            current_installment: 1,
            start_date: data.transaction_date,
            category_id: data.category_id === "__none" ? null : data.category_id || null,
            currency_id: data.currency_id || null,
            notes: data.notes?.trim() || null,
            is_active: true,
          })
          .select("id, user_id, family_id")
          .single()

        if (purchaseError) throw purchaseError
        creditCardPurchaseId = purchase.id
        createdPurchaseScope = purchase
        createdPurchaseIdForCleanup = purchase.id
      }

      const { is_installment_purchase, total_installments, recurrence_end_date, ...baseTransactionData } = data
      const transactionData = {
        ...baseTransactionData,
        type,
        user_id: user.id,
        amount: transactionAmount,
        category_id: data.category_id === "__none" ? null : data.category_id || null,
        group_id: data.group_id === "__none" ? null : data.group_id || null,
        payment_method: data.payment_method || null,
        credit_card_id: data.payment_method === "credit" && data.credit_card_id !== "__none" ? data.credit_card_id || null : null,
        budgeted_amount: budgetedAmount,
        transaction_date: billingTransactionDate,
        ...(!initialData?.id
          ? {
              status: shouldCreateRecurringExpense || requiresCardApproval ? "pending" : "approved",
              approved_at: shouldCreateRecurringExpense || requiresCardApproval ? null : new Date().toISOString(),
              approved_by: shouldCreateRecurringExpense || requiresCardApproval ? null : user.id,
            }
          : {}),
        notes: data.notes?.trim() || null,
      }
      const recurringSeriesId = shouldCreateRecurringExpense ? crypto.randomUUID() : null
      const recurringSource = data.payment_method === "credit" ? "recurring_card_debit" : "recurring_expense"
      const creditCardBillingMetadata = isNewCreditCardExpense
        ? {
            purchase_date: data.transaction_date,
            billing_date: billingTransactionDate,
            billing_rule: "credit_card_statement_due",
          }
        : undefined
      const transactionPayload = initialData?.id
        ? transactionData
        : {
            ...transactionData,
            credit_card_purchase_id: creditCardPurchaseId,
            installment_number: creditCardPurchaseId ? 1 : null,
            recurring_series_id: recurringSeriesId,
            recurrence_period: recurringSeriesId ? `${data.transaction_date.slice(0, 7)}-01` : null,
            metadata: recurringSeriesId
              ? {
                  ...creditCardBillingMetadata,
                  source: recurringSource,
                  recurring_series_id: recurringSeriesId,
                  recurrence_end_date: data.recurrence_end_date || null,
                }
              : creditCardBillingMetadata,
          }

      if (initialData?.id) {
        const { error: updateError } = await supabase
          .from("transactions")
          .update(transactionPayload)
          .eq("id", initialData.id)
        
        if (updateError) throw updateError
      } else {
        const insertPayload = shouldCreateRecurringExpense
          ? getRecurringDates(
              data.transaction_date,
              data.recurrence_end_date || undefined,
              settings?.dashboard_months_ahead || 6,
            ).map((transactionDate, index) => ({
              ...transactionPayload,
              transaction_date: getBillingDate(transactionDate),
              recurrence_period: `${transactionDate.slice(0, 7)}-01`,
              metadata: {
                ...(data.payment_method === "credit"
                  ? {
                      purchase_date: transactionDate,
                      billing_date: getBillingDate(transactionDate),
                      billing_rule: "credit_card_statement_due",
                    }
                  : {
                      scheduled_date: transactionDate,
                    }),
                source: recurringSource,
                recurring_series_id: recurringSeriesId,
                recurrence_index: index + 1,
                recurrence_end_date: data.recurrence_end_date || null,
              },
            }))
          : transactionPayload

        const installmentPayload = shouldCreateInstallments && createdPurchaseScope && selectedCreditCard
          ? buildCreditCardInstallmentTransactions({
              purchase: {
                id: createdPurchaseScope.id,
                user_id: createdPurchaseScope.user_id,
                family_id: createdPurchaseScope.family_id,
                credit_card_id: selectedCreditCard.id,
                description: data.description.trim(),
                installment_amount: installmentAmounts?.[0] || transactionAmount,
                total_amount: Number(data.amount),
                total_installments: installments,
                start_date: data.transaction_date,
                category_id: data.category_id === "__none" ? null : data.category_id || null,
                currency_id: data.currency_id || selectedCreditCard.currency_id || null,
                notes: data.notes?.trim() || null,
              },
              card: selectedCreditCard,
              groupId: data.group_id === "__none" ? null : data.group_id || null,
              actorUserId: user.id,
            })
          : null

        const insertQuery = installmentPayload
          ? supabase.from("transactions").upsert(installmentPayload, {
              onConflict: "credit_card_purchase_id,installment_number",
              ignoreDuplicates: true,
            })
          : supabase.from("transactions").insert(insertPayload)
        const { error: insertError } = await insertQuery
        
        if (insertError) throw insertError
      }

      // Revalidate data
      invalidateCacheByPrefix("transactions")
      invalidateCache("credit-card-purchases")
      invalidateCache("credit-card-statements")
      invalidateCache("credit-card-statement-transactions")

      router.push(redirectUrl || "/dashboard")
      router.refresh()
    } catch (err) {
      if (createdPurchaseIdForCleanup) {
        const supabase = createClient()
        await supabase.from("credit_card_purchases").delete().eq("id", createdPurchaseIdForCleanup)
      }
      setError(err instanceof Error ? err.message : "Error al guardar")
    } finally {
      setIsSubmitting(false)
    }
  }

  const title = type === "expense" ? "Gasto" : "Ingreso"
  const resolvedBackUrl = backUrl || (type === "expense" ? "/dashboard/gastos" : "/dashboard/ingresos")

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href={resolvedBackUrl}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <CardTitle className="truncate">
            {initialData?.id ? `Editar ${title}` : `Nuevo ${title}`}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
              {error}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="description">Descripción</Label>
              <Input
                id="description"
                placeholder="Ej: Netflix, Supermercado..."
                {...register("description")}
              />
              {errors.description && (
                <p className="text-sm text-destructive">{errors.description.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="transaction_date">
                {type === "expense" && paymentMethod === "credit" ? "Fecha de compra" : "Fecha"}
              </Label>
              <Input
                id="transaction_date"
                type="date"
                {...register("transaction_date")}
              />
              {errors.transaction_date && (
                <p className="text-sm text-destructive">{errors.transaction_date.message}</p>
              )}
            </div>
          </div>

          {showCreditCardBillingPreview && (
            <div className="rounded-md bg-muted p-3 text-sm">
              <p className="font-medium">Impacto en resumen y proyección</p>
              <p className="text-muted-foreground">
                Esta compra se computará como gasto el {formatDateOnlyForDisplay(creditCardBillingDate)}, según cierre día {selectedCreditCard.closing_day || "-"} y vencimiento día {selectedCreditCard.due_day || "-"}.
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="amount">Monto Real</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                placeholder="0.00"
                {...register("amount")}
              />
              {errors.amount && (
                <p className="text-sm text-destructive">{errors.amount.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="budgeted_amount">Monto Previsto</Label>
              <Input
                id="budgeted_amount"
                type="number"
                step="0.01"
                placeholder="0.00"
                {...register("budgeted_amount")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="currency_id">Moneda</Label>
              <Select
                value={watch("currency_id")}
                onValueChange={(value) => setValue("currency_id", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar" />
                </SelectTrigger>
                <SelectContent>
                  {currencies?.map((currency) => (
                    <SelectItem key={currency.id} value={currency.id}>
                      {currency.code} ({currency.symbol})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.currency_id && (
                <p className="text-sm text-destructive">{errors.currency_id.message}</p>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="category_id">Categoría</Label>
              <Select
                value={selectedCategoryId}
                onValueChange={handleCategoryChange}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar categoría" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Sin categoría</SelectItem>
                  {filteredCategories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="group_id">Grupo</Label>
              <Select
                value={selectedGroupId}
                onValueChange={(value) => setValue("group_id", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar grupo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Sin grupo</SelectItem>
                  {groups?.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {type === "expense" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="payment_method">Método de pago</Label>
                <Select
                  value={watch("payment_method")}
                  onValueChange={(value) => setValue("payment_method", value as "cash" | "debit" | "credit" | "transfer")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar método" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Efectivo</SelectItem>
                    <SelectItem value="debit">Débito</SelectItem>
                    <SelectItem value="credit">Crédito</SelectItem>
                    <SelectItem value="transfer">Transferencia</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {paymentMethod === "credit" && (
                <div className="space-y-2">
                  <Label htmlFor="credit_card_id">Tarjeta</Label>
                  <Select
                    value={selectedCreditCardId}
                    onValueChange={(value) => setValue("credit_card_id", value)}
                  >
                    <SelectTrigger>
                      {selectedCreditCard ? (
                        <CreditCardSelectLabel card={selectedCreditCard} />
                      ) : (
                        <SelectValue placeholder="Seleccionar tarjeta" />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Sin tarjeta</SelectItem>
                      {creditCards?.filter((card) => card.is_active).map((card) => (
                        <SelectItem key={card.id} value={card.id} textValue={`${card.name} ${card.brand || ""} ${card.last_four || ""}`}>
                          <CreditCardSelectLabel card={card} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {type === "expense" && paymentMethod === "credit" && !initialData?.id && (
            <div className="rounded-md border p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <Switch
                    id="is_installment_purchase"
                    checked={isInstallmentPurchase}
                    onCheckedChange={(checked) => {
                      setValue("is_installment_purchase", checked, { shouldDirty: true })
                      setValue("total_installments", checked ? Math.max(totalInstallments, 2) : 1, { shouldDirty: true })
                    }}
                  />
                  <Label htmlFor="is_installment_purchase">Gasto en cuotas</Label>
                </div>

                {isInstallmentPurchase && (
                  <div className="space-y-2">
                    <Label htmlFor="total_installments">Cantidad de cuotas</Label>
                    <Input
                      id="total_installments"
                      type="number"
                      min={2}
                      step={1}
                      {...register("total_installments")}
                    />
                  </div>
                )}
              </div>

              {isInstallmentPurchase && (
                <div className="mt-4 rounded-md bg-muted p-3">
                  <p className="text-sm text-muted-foreground">Valor estimado de cada cuota</p>
                  <p className="font-mono text-xl font-semibold">
                    {formatCurrency(installmentAmount, selectedCreditCard?.currency || defaultCurrency)}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Switch
              id="is_recurring"
              checked={isRecurring}
              onCheckedChange={(checked) => setValue("is_recurring", checked, { shouldDirty: true })}
            />
            <Label htmlFor="is_recurring">
              {type === "expense"
                ? paymentMethod === "credit" ? "Débito automático en tarjeta" : "Gasto recurrente"
                : "Ingreso recurrente"}
            </Label>
          </div>

          {shouldShowExpenseRecurrence && (
            <div className="rounded-md border p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="recurrence_end_date">Activo hasta</Label>
                  <Input id="recurrence_end_date" type="date" {...register("recurrence_end_date")} />
                </div>
                <div className="rounded-md bg-muted p-3">
                  <p className="text-sm text-muted-foreground">
                    {paymentMethod === "credit" ? "Débito automático en tarjeta" : "Gasto mensual pendiente"}
                  </p>
                  <p className="text-sm">
                    {paymentMethod === "credit"
                      ? `Se crearán movimientos mensuales en la tarjeta y se computarán según el vencimiento del resumen. Si no indicás fin, se generarán los próximos ${settings?.dashboard_months_ahead || 6} meses.`
                      : `Se crearán movimientos mensuales pendientes de aprobación. Si no indicás fin, se generarán los próximos ${settings?.dashboard_months_ahead || 6} meses.`}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="notes">Notas</Label>
            <Textarea
              id="notes"
              placeholder="Notas adicionales..."
              {...register("notes")}
            />
          </div>

          <div className="grid gap-2 pt-4 sm:flex">
            <Button type="submit" className="w-full sm:w-auto" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {initialData?.id ? "Guardar Cambios" : "Crear"}
            </Button>
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => router.back()}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
