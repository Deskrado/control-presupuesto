"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { invalidateCacheByPrefix, invalidateCaches } from "@/lib/swr-cache"
import { createClient } from "@/lib/supabase/client"
import { useDashboard } from "@/components/dashboard/dashboard-context"
import {
  useCreditCardPurchases,
  useCreditCards,
  useCreditCardStatements,
  useCreditCardStatementTransactions,
  useCurrencies,
  useUserSettings,
} from "@/components/dashboard/use-dashboard-data"
import { formatCurrency } from "@/lib/currency"
import { getInstallmentAmountInPeriod, hasInstallmentInPeriod } from "@/lib/credit-card-purchase-period"
import { getStatementTransactionAmount, isStatementPaymentAdjustment } from "@/lib/credit-card-statement-calculations"
import { getMonthIndexFromDateOnly, getYearFromDateOnly } from "@/lib/date-only"
import { formatDateOnlyForDisplay, getCreditCardStatementDueDate } from "@/lib/credit-card-billing"
import type { CreditCard, CreditCardPurchase, CreditCardStatement, Transaction } from "@/lib/types"
import {
  CARD_BRANDS,
  CardBrandMark,
  CreditCardSelectLabel,
  getCardBrandLabel,
  normalizeCardBrand,
} from "@/components/credit-cards/card-brand"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CreditCard as CreditCardIcon, Loader2, MoreHorizontal, Pencil, Plus, Repeat, Search, Trash2, XCircle } from "lucide-react"

type CardFormState = {
  name: string
  brand: string
  last_four: string
  credit_limit: string
  closing_day: string
  due_day: string
  currency_id: string
  is_active: boolean
}

const emptyCardForm: CardFormState = {
  name: "",
  brand: "__none",
  last_four: "",
  credit_limit: "",
  closing_day: "",
  due_day: "",
  currency_id: "",
  is_active: true,
}

function cardToForm(card: CreditCard): CardFormState {
  return {
    name: card.name,
    brand: normalizeCardBrand(card.brand),
    last_four: card.last_four || "",
    credit_limit: card.credit_limit?.toString() || "",
    closing_day: card.closing_day?.toString() || "",
    due_day: card.due_day?.toString() || "",
    currency_id: card.currency_id || "",
    is_active: card.is_active,
  }
}

function getAutomaticDebitSeriesId(transaction: Transaction) {
  const metadata = transaction.metadata || {}
  if (transaction.recurring_series_id) return transaction.recurring_series_id
  if (typeof metadata.recurring_series_id === "string" && metadata.recurring_series_id) {
    return metadata.recurring_series_id
  }
  return null
}

function transactionStatementKey(transaction: Transaction) {
  const seriesId = getAutomaticDebitSeriesId(transaction)
  if (seriesId) return `series:${seriesId}`

  return [
    transaction.description.trim().toLowerCase(),
    transaction.category_id || "no-category",
    transaction.group_id || "no-group",
    transaction.credit_card_id || "no-card",
    transaction.currency_id || "no-currency",
  ].join("|")
}

function isTransactionInMonth(transaction: Transaction, year: number, month: number) {
  return getYearFromDateOnly(transaction.transaction_date) === year && getMonthIndexFromDateOnly(transaction.transaction_date) === month - 1
}

function isTransactionBeforeOrInMonth(transaction: Transaction, year: number, month: number) {
  const transactionYear = getYearFromDateOnly(transaction.transaction_date)
  const transactionMonth = getMonthIndexFromDateOnly(transaction.transaction_date) + 1
  return transactionYear < year || (transactionYear === year && transactionMonth <= month)
}

function getStatementTransactionKind(transaction: Transaction) {
  if (transaction.metadata?.source === "credit_card_statement_payment_adjustment") return "Ajuste"
  if (transaction.is_recurring) return "Débito automático"
  if (transaction.credit_card_purchase_id) {
    return transaction.installment_number ? `Cuota ${transaction.installment_number}` : "Compra en cuotas"
  }
  return "Transacción manual"
}

function getInstallmentProgress(purchase: CreditCardPurchase, year: number, month: number) {
  const periodEnd = `${year}-${String(month).padStart(2, "0")}-31`
  return (purchase.transactions || []).reduce((progress, transaction) => {
    if (transaction.archived_at || transaction.transaction_date > periodEnd) return progress
    return Math.max(progress, Number(transaction.installment_number) || 0)
  }, 0)
}

export function CreditCardManagement() {
  const { selectedMonth, selectedYear } = useDashboard()
  const statementMonth = selectedMonth
  const statementYear = selectedYear
  const { data: cards, isLoading } = useCreditCards()
  const { data: currencies } = useCurrencies()
  const { data: settings } = useUserSettings()
  const { data: purchases, isLoading: purchasesLoading } = useCreditCardPurchases()
  const { data: statements, isLoading: statementsLoading } = useCreditCardStatements(statementYear, statementMonth)
  const { data: statementTransactions } = useCreditCardStatementTransactions(statementYear, statementMonth)
  const [search, setSearch] = useState("")
  const [form, setForm] = useState<CardFormState>(emptyCardForm)
  const [editingCard, setEditingCard] = useState<CreditCard | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [paymentStatement, setPaymentStatement] = useState<CreditCardStatement | null>(null)
  const [paymentAmount, setPaymentAmount] = useState("")
  const [statementActionId, setStatementActionId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [consumptionCardFilter, setConsumptionCardFilter] = useState("all")
  const [selectedDebitKeys, setSelectedDebitKeys] = useState<Set<string>>(new Set())
  const [debitDeleteOpen, setDebitDeleteOpen] = useState(false)
  const [debitDeleteTargets, setDebitDeleteTargets] = useState<Transaction[]>([])
  const [debitDeleteScope, setDebitDeleteScope] = useState<"single" | "forward">("forward")
  const [confirmForwardDebitDelete, setConfirmForwardDebitDelete] = useState(false)
  const [isDeletingDebits, setIsDeletingDebits] = useState(false)
  const [debitMessage, setDebitMessage] = useState<string | null>(null)
  const [debitError, setDebitError] = useState<string | null>(null)

  const visibleCards = useMemo(() => {
    const query = search.toLowerCase()
    return (cards || []).filter((card) =>
      `${card.name} ${getCardBrandLabel(card.brand)} ${card.last_four || ""}`.toLowerCase().includes(query),
    )
  }, [cards, search])

  const filteredPurchases = useMemo(() => {
    const periodPurchases = (purchases || []).filter((purchase) =>
      hasInstallmentInPeriod(purchase, statementYear, statementMonth),
    )
    if (consumptionCardFilter === "all") return periodPurchases
    return periodPurchases.filter((purchase) => purchase.credit_card_id === consumptionCardFilter)
  }, [consumptionCardFilter, purchases, statementMonth, statementYear])

  const defaultCurrencyId = settings?.default_currency_id || currencies?.find((currency) => currency.code === "ARS")?.id || currencies?.[0]?.id || ""
  const recurringCardDebits = useMemo(() => {
    const targetDate = `${statementYear}-${String(statementMonth).padStart(2, "0")}-01`
    const latestByKey = new Map<string, Transaction>()

    for (const transaction of statementTransactions || []) {
      if (!transaction.credit_card_id || !transaction.is_recurring || transaction.status === "rejected") continue
      if (!isTransactionBeforeOrInMonth(transaction, statementYear, statementMonth)) continue

      const endDate = typeof transaction.metadata?.recurrence_end_date === "string" ? transaction.metadata.recurrence_end_date : null
      if (endDate && targetDate > endDate) continue

      const key = transactionStatementKey(transaction)
      const current = latestByKey.get(key)
      const currentIsTargetMonth = current ? isTransactionInMonth(current, statementYear, statementMonth) : false
      const transactionIsTargetMonth = isTransactionInMonth(transaction, statementYear, statementMonth)

      if (
        !current ||
        (transactionIsTargetMonth && !currentIsTargetMonth) ||
        (transactionIsTargetMonth === currentIsTargetMonth && transaction.transaction_date > current.transaction_date)
      ) {
        latestByKey.set(key, transaction)
      }
    }

    const rows = Array.from(latestByKey.values()).sort((a, b) =>
      (a.credit_card?.name || "").localeCompare(b.credit_card?.name || "") ||
      a.description.localeCompare(b.description),
    )

    if (consumptionCardFilter === "all") return rows
    return rows.filter((transaction) => transaction.credit_card_id === consumptionCardFilter)
  }, [consumptionCardFilter, statementMonth, statementYear, statementTransactions])

  const statementConsumptions = useMemo(() => {
    const rows = (statementTransactions || [])
      .filter((transaction) =>
        transaction.status !== "rejected" &&
        !isStatementPaymentAdjustment(transaction) &&
        isTransactionInMonth(transaction, statementYear, statementMonth),
      )
      .sort((left, right) =>
        right.transaction_date.localeCompare(left.transaction_date) ||
        new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime(),
      )

    if (consumptionCardFilter === "all") return rows
    return rows.filter((transaction) => transaction.credit_card_id === consumptionCardFilter)
  }, [consumptionCardFilter, statementMonth, statementYear, statementTransactions])

  const automaticDebitHref = `/dashboard/transacciones/nuevo?type=expense&payment=credit&recurring=1&back=/dashboard/tarjetas&redirect=/dashboard/tarjetas${
    consumptionCardFilter === "all" ? "" : `&cardId=${encodeURIComponent(consumptionCardFilter)}`
  }`
  const debitPeriodLabel = `${String(statementMonth).padStart(2, "0")}/${statementYear}`
  const allDebitsSelected = recurringCardDebits.length > 0 && selectedDebitKeys.size === recurringCardDebits.length

  useEffect(() => {
    setSelectedDebitKeys(new Set())
  }, [consumptionCardFilter, statementMonth, statementYear])

  const getDebitSelectionKey = (transaction: Transaction) =>
    getAutomaticDebitSeriesId(transaction) || transaction.id

  const toggleAllDebits = (checked: boolean) => {
    setSelectedDebitKeys(checked ? new Set(recurringCardDebits.map(getDebitSelectionKey)) : new Set())
  }

  const toggleDebit = (transaction: Transaction, checked: boolean) => {
    const key = getDebitSelectionKey(transaction)
    setSelectedDebitKeys((current) => {
      const next = new Set(current)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const openDebitDeleteDialog = (targets: Transaction[]) => {
    if (targets.length === 0) return
    setDebitMessage(null)
    setDebitError(null)
    setDebitDeleteTargets(targets)
    setDebitDeleteScope("forward")
    setConfirmForwardDebitDelete(false)
    setDebitDeleteOpen(true)
  }

  const resetDebitDeleteState = () => {
    setDebitDeleteOpen(false)
    setDebitDeleteTargets([])
    setDebitDeleteScope("forward")
    setConfirmForwardDebitDelete(false)
    setDebitError(null)
  }

  const confirmDebitDelete = async () => {
    if (debitDeleteTargets.length === 0) return
    if (debitDeleteScope === "forward" && !confirmForwardDebitDelete) return

    setIsDeletingDebits(true)
    setDebitError(null)
    setDebitMessage(null)

    try {
      if (debitDeleteScope === "forward") {
        const seriesIds = Array.from(new Set(
          debitDeleteTargets
            .map(getAutomaticDebitSeriesId)
            .filter((value): value is string => Boolean(value)),
        ))
        const transactionIds = debitDeleteTargets.map((transaction) => transaction.id)

        const response = await fetch("/api/recurring-expenses/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "disable",
            seriesIds,
            transactionIds,
            month: statementMonth,
            year: statementYear,
          }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || "No se pudieron eliminar los débitos automáticos")

        setDebitMessage(
          `Débitos cortados: ${payload.preview?.length || transactionIds.length}. Pendientes/futuros archivados desde ${debitPeriodLabel}: ${payload.archived || 0}.`,
        )
        setSelectedDebitKeys(new Set())
      } else {
        const supabase = createClient()
        const ids = debitDeleteTargets.map((transaction) => transaction.id)
        const { error: archiveError } = await supabase
          .from("transactions")
          .update({ archived_at: new Date().toISOString() })
          .in("id", ids)
        if (archiveError) throw archiveError
        setDebitMessage(
          ids.length === 1
            ? "Se archivó solo el débito de este período. La serie puede seguir generando futuros."
            : `Se archivaron ${ids.length} débitos de este período. Las series pueden seguir generando futuros.`,
        )
        setSelectedDebitKeys(new Set())
      }

      invalidateCaches(["credit-card-statements", "credit-card-statement-transactions", "credit-card-purchases"])
      invalidateCacheByPrefix("transactions")
      resetDebitDeleteState()
    } catch (deleteError) {
      setDebitError(deleteError instanceof Error ? deleteError.message : "Error al eliminar débitos automáticos")
    } finally {
      setIsDeletingDebits(false)
    }
  }

  const openNewDialog = () => {
    setEditingCard(null)
    setForm({ ...emptyCardForm, currency_id: defaultCurrencyId })
    setError(null)
    setDialogOpen(true)
  }

  const openEditDialog = (card: CreditCard) => {
    setEditingCard(card)
    setForm(cardToForm(card))
    setError(null)
    setDialogOpen(true)
  }

  const saveCard = async () => {
    if (!form.name.trim()) {
      setError("El nombre es requerido")
      return
    }
    if (form.last_four && !/^[0-9]{4}$/.test(form.last_four)) {
      setError("Los ultimos 4 digitos deben ser numericos")
      return
    }
    if (form.credit_limit && Number(form.credit_limit) < 0) {
      setError("El limite no puede ser negativo")
      return
    }
    const closingDay = Number(form.closing_day)
    const dueDay = Number(form.due_day)
    if (form.closing_day && (closingDay < 1 || closingDay > 31)) {
      setError("El dia de cierre debe estar entre 1 y 31")
      return
    }
    if (form.due_day && (dueDay < 1 || dueDay > 31)) {
      setError("El dia de vencimiento debe estar entre 1 y 31")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error("No estás autenticado")

      if (!form.name.trim()) throw new Error("El nombre de la tarjeta es requerido")
      if (form.credit_limit && Number(form.credit_limit) < 0) throw new Error("El límite no puede ser negativo")
      const closingDay = form.closing_day ? Number(form.closing_day) : null
      if (closingDay !== null && (closingDay < 1 || closingDay > 31)) throw new Error("El día de cierre debe estar entre 1 y 31")
      const dueDay = form.due_day ? Number(form.due_day) : null
      if (dueDay !== null && (dueDay < 1 || dueDay > 31)) throw new Error("El día de vencimiento debe estar entre 1 y 31")

      const payload = {
        user_id: user.id,
        name: form.name.trim(),
        brand: form.brand === "__none" ? null : form.brand,
        last_four: form.last_four.trim() || null,
        credit_limit: form.credit_limit ? Number(form.credit_limit) : null,
        closing_day: closingDay,
        due_day: dueDay,
        currency_id: form.currency_id || null,
        is_active: form.is_active,
      }

      const result = editingCard
        ? await supabase.from("credit_cards").update(payload).eq("id", editingCard.id)
        : await supabase.from("credit_cards").insert(payload)

      if (result.error) throw result.error

      invalidateCaches(["credit-cards", "credit-card-purchases", "credit-card-statements"])
      setDialogOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar la tarjeta")
    } finally {
      setIsSubmitting(false)
    }
  }

  const setCardActive = async (card: CreditCard, isActive: boolean) => {
    const supabase = createClient()
    const { error: updateError } = await supabase
      .from("credit_cards")
      .update({ is_active: isActive })
      .eq("id", card.id)

    if (updateError) {
      setError(updateError.message)
      return
    }
    invalidateCaches(["credit-cards", "credit-card-purchases", "credit-card-statements"])
  }

  const openPaymentDialog = (statement: CreditCardStatement) => {
    setPaymentStatement(statement)
    setPaymentAmount(String(Math.max(Number(statement.amount_due || 0), 0)))
    setError(null)
  }

  const confirmPayment = async () => {
    if (!paymentStatement) return
    const paidAmount = Number(paymentAmount)
    if (!Number.isFinite(paidAmount) || paidAmount < 0) {
      setError("Ingresa un monto pagado valido")
      return
    }

    setStatementActionId(paymentStatement.credit_card_id)
    setError(null)

    try {
      const response = await fetch("/api/credit-card-statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creditCardId: paymentStatement.credit_card_id,
          year: paymentStatement.year,
          month: paymentStatement.month,
          paidAmount,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Error al confirmar el pago")

      invalidateCaches(["credit-card-statements", "credit-card-statement-transactions", "transactions"])
      setPaymentStatement(null)
      setPaymentAmount("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al confirmar el pago")
    } finally {
      setStatementActionId(null)
    }
  }

  const paymentPreview = paymentStatement
    ? Number(paymentStatement.amount_due || 0) - (Number(paymentAmount) || 0)
    : 0

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Tarjetas de credito</CardTitle>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1 sm:w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar tarjeta..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="pl-8"
                />
              </div>
              <Button variant="outline" asChild className="w-full sm:w-auto">
                <Link href="/dashboard/tarjetas/compra">
                  <CreditCardIcon className="mr-2 h-4 w-4" />
                  Compra
                </Link>
              </Button>
              <Button variant="outline" asChild className="w-full sm:w-auto">
                <Link href={automaticDebitHref}>
                  <Repeat className="mr-2 h-4 w-4" />
                  Debito automatico
                </Link>
              </Button>
              <Button onClick={openNewDialog} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                Nueva
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {error && !dialogOpen && !paymentStatement && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : visibleCards.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">No hay tarjetas registradas</div>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {visibleCards.map((card) => (
                  <div key={card.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <CardBrandMark brand={card.brand} />
                          <p className="min-w-0 truncate font-medium">
                            {card.name}
                            {card.last_four && <span className="ml-2 text-muted-foreground">**** {card.last_four}</span>}
                          </p>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Cierre día {card.closing_day || "-"} · Vencimiento día {card.due_day || "-"}
                        </p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Más acciones de tarjeta">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditDialog(card)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Editar
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setCardActive(card, !card.is_active)}>
                            <XCircle className="mr-2 h-4 w-4" />
                            {card.is_active ? "Desactivar" : "Activar"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <Badge variant={card.is_active ? "secondary" : "outline"}>
                        {card.is_active ? "Activa" : "Inactiva"}
                      </Badge>
                      <span className="font-mono text-sm">
                        {card.credit_limit ? formatCurrency(Number(card.credit_limit), card.currency) : "-"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tarjeta</TableHead>
                      <TableHead>Marca</TableHead>
                      <TableHead className="text-right">Limite</TableHead>
                      <TableHead>Cierre</TableHead>
                      <TableHead>Vencimiento</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleCards.map((card) => (
                      <TableRow key={card.id}>
                        <TableCell className="font-medium">
                          {card.name}
                          {card.last_four && <span className="ml-2 text-muted-foreground">**** {card.last_four}</span>}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <CardBrandMark brand={card.brand} />
                            <span>{getCardBrandLabel(card.brand)}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {card.credit_limit ? formatCurrency(Number(card.credit_limit), card.currency) : "-"}
                        </TableCell>
                        <TableCell>{card.closing_day ? `Dia ${card.closing_day}` : "-"}</TableCell>
                        <TableCell>{card.due_day ? `Dia ${card.due_day}` : "-"}</TableCell>
                        <TableCell>
                          <Badge variant={card.is_active ? "secondary" : "outline"}>
                            {card.is_active ? "Activa" : "Inactiva"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label="Más acciones de tarjeta">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openEditDialog(card)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Editar
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setCardActive(card, !card.is_active)}>
                                <XCircle className="mr-2 h-4 w-4" />
                                {card.is_active ? "Desactivar" : "Activar"}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statementsLoading ? (
          <Card>
            <CardContent className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </CardContent>
          </Card>
        ) : (statements || []).map((statement) => (
          <Card key={`statement-${statement.credit_card_id}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm text-muted-foreground">
                  Resumen {String(statementMonth).padStart(2, "0")}/{statementYear}
                </CardTitle>
                <CardBrandMark brand={statement.credit_card?.brand} />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{statement.credit_card?.name || "Tarjeta"}</p>
                <Badge variant={statement.status === "paid" ? "secondary" : "outline"}>
                  {statement.status === "paid" ? "Pagado" : "Pendiente"}
                </Badge>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Previsto pendiente de pago</span>
                  <span className="font-mono">{formatCurrency(Number(statement.expected_amount || 0), statement.currency || statement.credit_card?.currency)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Saldo anterior</span>
                  <span className="font-mono">{formatCurrency(Number(statement.previous_balance || 0), statement.currency || statement.credit_card?.currency)}</span>
                </div>
                <div className="flex justify-between gap-3 font-medium">
                  <span>Total a pagar</span>
                  <span className="font-mono">{formatCurrency(Number(statement.amount_due || 0), statement.currency || statement.credit_card?.currency)}</span>
                </div>
                {statement.status === "paid" && (
                  <>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Monto pagado</span>
                      <span className="font-mono">{formatCurrency(Number(statement.paid_amount || 0), statement.currency || statement.credit_card?.currency)}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Saldo resultante</span>
                      <span className="font-mono">{formatCurrency(Number(statement.carryover_balance || 0), statement.currency || statement.credit_card?.currency)}</span>
                    </div>
                  </>
                )}
              </div>
              {statement.status !== "paid" && (
                <Button
                  className="w-full"
                  size="sm"
                  onClick={() => openPaymentDialog(statement)}
                  disabled={statementActionId === statement.credit_card_id}
                >
                  {statementActionId === statement.credit_card_id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirmar pago
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Consumos incluidos en los resúmenes</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Cuotas, débitos y transacciones manuales que forman el previsto del período seleccionado.
              </p>
            </div>
            <Select value={consumptionCardFilter} onValueChange={setConsumptionCardFilter}>
              <SelectTrigger className="w-full sm:w-72">
                <SelectValue placeholder="Filtrar por tarjeta" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas las tarjetas</SelectItem>
                {(cards || []).map((card) => (
                  <SelectItem key={card.id} value={card.id} textValue={`${card.name} ${card.brand || ""} ${card.last_four || ""}`}>
                    <CreditCardSelectLabel card={card} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {!statementTransactions ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : statementConsumptions.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {consumptionCardFilter === "all"
                ? "No hay consumos incluidos en los resúmenes de este período"
                : "No hay consumos para esta tarjeta en el período seleccionado"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Descripción</TableHead>
                    <TableHead>Tarjeta</TableHead>
                    <TableHead>Origen</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Importe</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statementConsumptions.map((transaction) => (
                    <TableRow key={transaction.id}>
                      <TableCell className="whitespace-nowrap">
                        {formatDateOnlyForDisplay(transaction.transaction_date)}
                      </TableCell>
                      <TableCell className="font-medium">{transaction.description}</TableCell>
                      <TableCell>
                        {transaction.credit_card ? <CreditCardSelectLabel card={transaction.credit_card} /> : "-"}
                      </TableCell>
                      <TableCell>{getStatementTransactionKind(transaction)}</TableCell>
                      <TableCell>
                        <Badge variant={transaction.status === "pending" ? "outline" : "secondary"}>
                          {transaction.status === "pending" ? "Pendiente" : "Aprobado"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(
                          getStatementTransactionAmount(transaction),
                          transaction.currency || transaction.credit_card?.currency,
                        )}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" asChild>
                          <Link href={`/dashboard/gastos/${transaction.id}`}>
                            <Pencil className="h-4 w-4" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Compras en cuotas activas</CardTitle>
            <Select value={consumptionCardFilter} onValueChange={setConsumptionCardFilter}>
              <SelectTrigger className="w-full sm:w-72">
                <SelectValue placeholder="Filtrar por tarjeta" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas las tarjetas</SelectItem>
                {(cards || []).map((card) => (
                  <SelectItem key={card.id} value={card.id} textValue={`${card.name} ${card.brand || ""} ${card.last_four || ""}`}>
                    <CreditCardSelectLabel card={card} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {purchasesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : filteredPurchases.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {consumptionCardFilter === "all" ? "No hay compras en cuotas activas" : "No hay compras en cuotas para esta tarjeta"}
            </div>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {filteredPurchases.map((purchase) => (
                  <div key={purchase.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="min-w-0 truncate font-medium">{purchase.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {purchase.credit_card ? <CreditCardSelectLabel card={purchase.credit_card} /> : "-"}
                        </p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Más acciones de compra">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/dashboard/tarjetas/compra/${purchase.id}`}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Editar
                            </Link>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{formatDateOnlyForDisplay(purchase.start_date)}</span>
                      <Badge variant="outline">{getInstallmentProgress(purchase, statementYear, statementMonth)}/{purchase.total_installments} cuotas</Badge>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-xs text-muted-foreground">
                        Total {formatCurrency(Number(purchase.total_amount), purchase.credit_card?.currency)}
                      </span>
                      <span className="font-mono text-sm font-semibold">
                        {formatCurrency(
                          getInstallmentAmountInPeriod(purchase, statementYear, statementMonth) ?? Number(purchase.installment_amount),
                          purchase.credit_card?.currency,
                        )}/cuota
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Compra</TableHead>
                      <TableHead>Tarjeta</TableHead>
                      <TableHead>Fecha</TableHead>
                      <TableHead>Primer vencimiento</TableHead>
                      <TableHead>Cuotas</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Cuota</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPurchases.map((purchase) => (
                      <TableRow key={purchase.id}>
                        <TableCell className="font-medium">{purchase.description}</TableCell>
                        <TableCell>{purchase.credit_card ? <CreditCardSelectLabel card={purchase.credit_card} /> : "-"}</TableCell>
                        <TableCell>{formatDateOnlyForDisplay(purchase.start_date)}</TableCell>
                        <TableCell>
                          {formatDateOnlyForDisplay(getCreditCardStatementDueDate(purchase.start_date, purchase.credit_card))}
                        </TableCell>
                        <TableCell>{getInstallmentProgress(purchase, statementYear, statementMonth)}/{purchase.total_installments}</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(Number(purchase.total_amount), purchase.credit_card?.currency)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(
                            getInstallmentAmountInPeriod(purchase, statementYear, statementMonth) ?? Number(purchase.installment_amount),
                            purchase.credit_card?.currency,
                          )}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label="Más acciones de compra">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem asChild>
                                <Link href={`/dashboard/tarjetas/compra/${purchase.id}`}>
                                  <Pencil className="mr-2 h-4 w-4" />
                                  Editar
                                </Link>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Débitos automáticos activos</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Seleccioná uno o varios y usá Eliminar. Al borrar se pregunta si cortás la serie hacia adelante
                  (pendientes/futuros desde {debitPeriodLabel}) o solo el movimiento de este período.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select value={consumptionCardFilter} onValueChange={setConsumptionCardFilter}>
                  <SelectTrigger className="w-full sm:w-72">
                    <SelectValue placeholder="Filtrar por tarjeta" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas las tarjetas</SelectItem>
                    {(cards || []).map((card) => (
                      <SelectItem key={card.id} value={card.id} textValue={`${card.name} ${card.brand || ""} ${card.last_four || ""}`}>
                        <CreditCardSelectLabel card={card} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="destructive"
                  disabled={selectedDebitKeys.size === 0 || isDeletingDebits}
                  onClick={() =>
                    openDebitDeleteDialog(
                      recurringCardDebits.filter((transaction) => selectedDebitKeys.has(getDebitSelectionKey(transaction))),
                    )
                  }
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Eliminar ({selectedDebitKeys.size})
                </Button>
              </div>
            </div>
            {debitMessage && <div className="rounded-md border bg-muted p-3 text-sm">{debitMessage}</div>}
          </div>
        </CardHeader>
        <CardContent>
          {!statementTransactions ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : recurringCardDebits.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {consumptionCardFilter === "all" ? "No hay débitos automáticos activos" : "No hay débitos automáticos para esta tarjeta"}
            </div>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={allDebitsSelected}
                    onCheckedChange={(checked) => toggleAllDebits(checked === true)}
                    aria-label="Seleccionar todos los débitos"
                  />
                  Seleccionar todos
                </label>
                {recurringCardDebits.map((transaction) => {
                  const selectionKey = getDebitSelectionKey(transaction)
                  return (
                    <div key={transaction.id} className="rounded-md border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-1 items-start gap-3">
                          <Checkbox
                            checked={selectedDebitKeys.has(selectionKey)}
                            onCheckedChange={(checked) => toggleDebit(transaction, checked === true)}
                            aria-label={`Seleccionar ${transaction.description}`}
                            className="mt-1"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="min-w-0 truncate font-medium">{transaction.description}</p>
                            <p className="text-xs text-muted-foreground">
                              {transaction.credit_card ? <CreditCardSelectLabel card={transaction.credit_card} /> : "-"}
                              {transaction.category?.name ? ` · ${transaction.category.name}` : ""}
                            </p>
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label="Más acciones de débito automático">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/dashboard/transacciones/${transaction.id}`}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Editar
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => openDebitDeleteDialog([transaction])}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Eliminar
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <Badge variant={transaction.status === "pending" ? "outline" : "secondary"}>
                          {transaction.status === "pending" ? "Pendiente" : "Activo"}
                        </Badge>
                        <span className="font-mono text-sm">
                          {formatCurrency(Number(transaction.budgeted_amount || transaction.amount || 0), transaction.currency)}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allDebitsSelected}
                          onCheckedChange={(checked) => toggleAllDebits(checked === true)}
                          aria-label="Seleccionar todos los débitos"
                        />
                      </TableHead>
                      <TableHead>Servicio</TableHead>
                      <TableHead>Tarjeta</TableHead>
                      <TableHead>Categoria</TableHead>
                      <TableHead>Impacto</TableHead>
                      <TableHead className="text-right">Monto</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recurringCardDebits.map((transaction) => {
                      const selectionKey = getDebitSelectionKey(transaction)
                      return (
                        <TableRow key={transaction.id} data-state={selectedDebitKeys.has(selectionKey) ? "selected" : undefined}>
                          <TableCell>
                            <Checkbox
                              checked={selectedDebitKeys.has(selectionKey)}
                              onCheckedChange={(checked) => toggleDebit(transaction, checked === true)}
                              aria-label={`Seleccionar ${transaction.description}`}
                            />
                          </TableCell>
                          <TableCell className="font-medium">{transaction.description}</TableCell>
                          <TableCell>{transaction.credit_card ? <CreditCardSelectLabel card={transaction.credit_card} /> : "-"}</TableCell>
                          <TableCell>{transaction.category?.name || "-"}</TableCell>
                          <TableCell>
                            {formatDateOnlyForDisplay(transaction.transaction_date)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatCurrency(Number(transaction.budgeted_amount || transaction.amount || 0), transaction.currency)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={transaction.status === "pending" ? "outline" : "secondary"}>
                              {transaction.status === "pending" ? "Pendiente" : "Activo"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label="Más acciones de débito automático">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                  <Link href={`/dashboard/transacciones/${transaction.id}`}>
                                    <Pencil className="mr-2 h-4 w-4" />
                                    Editar
                                  </Link>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => openDebitDeleteDialog([transaction])}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Eliminar
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCard ? "Editar tarjeta" : "Nueva tarjeta"}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Nombre</Label>
                <Input id="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand">Marca</Label>
                <Select value={form.brand} onValueChange={(value) => setForm({ ...form, brand: value })}>
                  <SelectTrigger id="brand">
                    <SelectValue placeholder="Seleccionar marca" />
                  </SelectTrigger>
                  <SelectContent>
                    {CARD_BRANDS.map((brand) => (
                      <SelectItem key={brand.value} value={brand.value}>
                        <span className="flex items-center gap-2">
                          <CardBrandMark brand={brand.value} />
                          {brand.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="last_four">Ultimos 4</Label>
                <Input id="last_four" maxLength={4} value={form.last_four} onChange={(event) => setForm({ ...form, last_four: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="closing_day">Cierre</Label>
                <Input id="closing_day" min={1} max={31} type="number" value={form.closing_day} onChange={(event) => setForm({ ...form, closing_day: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="due_day">Vencimiento</Label>
                <Input id="due_day" min={1} max={31} type="number" value={form.due_day} onChange={(event) => setForm({ ...form, due_day: event.target.value })} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="credit_limit">Limite</Label>
                <Input id="credit_limit" type="number" step="0.01" value={form.credit_limit} onChange={(event) => setForm({ ...form, credit_limit: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Moneda</Label>
                <Select value={form.currency_id} onValueChange={(value) => setForm({ ...form, currency_id: value })}>
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
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.is_active} onCheckedChange={(checked) => setForm({ ...form, is_active: checked })} />
              <Label>Tarjeta activa</Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={saveCard} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!paymentStatement}
        onOpenChange={(open) => {
          if (!open && !statementActionId) {
            setPaymentStatement(null)
            setPaymentAmount("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar pago de tarjeta</DialogTitle>
            <DialogDescription>
              Carga el monto realmente pagado. La diferencia queda como deuda o saldo a favor para el proximo resumen.
            </DialogDescription>
          </DialogHeader>

          {paymentStatement && (
            <div className="space-y-4">
              <div className="rounded-md bg-muted p-3 text-sm">
                <p className="font-medium">{paymentStatement.credit_card?.name || "Tarjeta"}</p>
                <p className="text-muted-foreground">
                  Total a pagar: {formatCurrency(Number(paymentStatement.amount_due || 0), paymentStatement.currency || paymentStatement.credit_card?.currency)}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="paid_amount">Monto pagado</Label>
                <Input
                  id="paid_amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={paymentAmount}
                  onChange={(event) => setPaymentAmount(event.target.value)}
                />
              </div>

              <div className="rounded-md border p-3 text-sm">
                {paymentPreview > 0.009 ? (
                  <p>Quedara deuda de <span className="font-mono">{formatCurrency(paymentPreview, paymentStatement.currency || paymentStatement.credit_card?.currency)}</span>.</p>
                ) : paymentPreview < -0.009 ? (
                  <p>Quedara saldo a favor de <span className="font-mono">{formatCurrency(Math.abs(paymentPreview), paymentStatement.currency || paymentStatement.credit_card?.currency)}</span>.</p>
                ) : (
                  <p>El resumen quedara saldado.</p>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={!!statementActionId}
              onClick={() => {
                setPaymentStatement(null)
                setPaymentAmount("")
              }}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={confirmPayment}
              disabled={!!statementActionId || !Number.isFinite(Number(paymentAmount)) || Number(paymentAmount) < 0}
            >
              {statementActionId && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={debitDeleteOpen}
        onOpenChange={(open) => {
          if (!open) resetDebitDeleteState()
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {debitDeleteTargets.length === 1
                ? `Eliminar débito automático “${debitDeleteTargets[0]?.description}”`
                : `Eliminar ${debitDeleteTargets.length} débitos automáticos`}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>Elegí el alcance sobre pendientes y futuros desde {debitPeriodLabel}:</p>
                <RadioGroup
                  value={debitDeleteScope}
                  onValueChange={(value) => {
                    setDebitDeleteScope(value as "single" | "forward")
                    setConfirmForwardDebitDelete(false)
                  }}
                  className="gap-3"
                >
                  <label className="flex items-start gap-3 rounded-md border p-3">
                    <RadioGroupItem value="single" id="debit-delete-single" className="mt-0.5" />
                    <span>
                      <span className="font-medium text-foreground">Solo este período</span>
                      <span className="mt-1 block">
                        Archiva el/los movimiento(s) visibles ahora. La serie puede volver a materializarse en meses siguientes.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 rounded-md border p-3">
                    <RadioGroupItem value="forward" id="debit-delete-forward" className="mt-0.5" />
                    <span>
                      <span className="font-medium text-foreground">Cortar serie desde {debitPeriodLabel}</span>
                      <span className="mt-1 block">
                        Archiva pendientes/futuros desde {debitPeriodLabel} y evita nuevas materializaciones.
                        Los movimientos ya aprobados se conservan.
                      </span>
                    </span>
                  </label>
                </RadioGroup>
                {debitDeleteScope === "forward" && (
                  <label className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-foreground">
                    <Checkbox
                      checked={confirmForwardDebitDelete}
                      onCheckedChange={(checked) => setConfirmForwardDebitDelete(checked === true)}
                      className="mt-0.5"
                    />
                    <span>
                      Confirmo cortar {debitDeleteTargets.length === 1 ? "esta serie" : "estas series"} y archivar
                      pendientes/futuros desde {debitPeriodLabel}.
                    </span>
                  </label>
                )}
                <div className="max-h-40 space-y-2 overflow-y-auto">
                  {debitDeleteTargets.map((transaction) => (
                    <div key={transaction.id} className="rounded-md border p-2 text-foreground">
                      <div className="font-medium">{transaction.description}</div>
                      <div className="text-xs text-muted-foreground">
                        {transaction.credit_card ? <CreditCardSelectLabel card={transaction.credit_card} /> : "Sin tarjeta"}
                        {" · "}
                        {formatCurrency(Number(transaction.budgeted_amount || transaction.amount || 0), transaction.currency)}
                      </div>
                    </div>
                  ))}
                </div>
                {debitError && (
                  <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{debitError}</div>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={resetDebitDeleteState} disabled={isDeletingDebits}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDebitDelete}
              disabled={
                isDeletingDebits ||
                (debitDeleteScope === "forward" && !confirmForwardDebitDelete)
              }
            >
              {isDeletingDebits && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {debitDeleteScope === "forward" ? "Eliminar futuros" : "Eliminar solo este período"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
