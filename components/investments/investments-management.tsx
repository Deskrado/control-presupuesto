"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import {
  useBrokerConnections,
  useBrokerPositions,
  useCurrencies,
  useFxQuotes,
  useInvestments,
  usePortfolioSnapshots,
  useSavingsGoals,
  useUserSettings,
} from "@/components/dashboard/use-dashboard-data"
import { formatCurrency } from "@/lib/currency"
import { toLocalDateOnly } from "@/lib/date-only"
import type { BrokerConnection, BrokerPosition, Currency, FxQuote, Investment, SavingsGoal } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
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
import { Textarea } from "@/components/ui/textarea"
import { Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react"
import { mutate } from "swr"
import { invalidateCache, invalidateCaches } from "@/lib/swr-cache"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

type InvestmentForm = {
  name: string
  type: Investment["type"]
  initial_amount: string
  current_value: string
  currency_id: string
  start_date: string
  end_date: string
  interest_rate: string
  notes: string
  is_active: boolean
}

const emptyForm: InvestmentForm = {
  name: "",
  type: "plazo_fijo",
  initial_amount: "",
  current_value: "",
  currency_id: "",
  start_date: toLocalDateOnly(),
  end_date: "",
  interest_rate: "",
  notes: "",
  is_active: true,
}

function investmentToForm(investment: Investment): InvestmentForm {
  return {
    name: investment.name,
    type: investment.type,
    initial_amount: investment.initial_amount.toString(),
    current_value: investment.current_value.toString(),
    currency_id: investment.currency_id || "",
    start_date: investment.start_date,
    end_date: investment.end_date || "",
    interest_rate: investment.interest_rate?.toString() || "",
    notes: investment.notes || "",
    is_active: investment.is_active,
  }
}

type PortfolioRow = {
  id: string
  source: "manual" | "iol" | "savings_fx"
  name: string
  kind: string
  quantity: number | null
  currentPrice: number | null
  priceCurrency: Currency | null | undefined
  initialValue: number | null
  currentValue: number
  result: number | null
  currency: Currency | null | undefined
  updatedAt: string | null
  isActive: boolean
  investment?: Investment
  position?: BrokerPosition
  savingsGoal?: SavingsGoal
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-"
  return new Date(value).toLocaleString("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
  })
}

class ApiRequestError extends Error {
  code?: string
  status: number

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
    this.code = code
  }
}

async function postJson(path: string, body?: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new ApiRequestError(
      payload.error || "No se pudo completar la solicitud",
      response.status,
      payload.code,
    )
  }
  return payload
}

function shouldAutoSyncConnection(_connection: BrokerConnection) {
  return false
}

function getLatestFxRate(quotes: FxQuote[] | undefined, fromCode: string, toCode: string) {
  if (fromCode === toCode) return 1
  const quote = (quotes || []).find((item) =>
    item.base_currency?.code === fromCode &&
    item.quote_currency?.code === toCode
  )
  if (!quote) return null
  return Number(quote.ask || quote.mid || quote.bid || 0) || null
}

function convertToCurrency(amount: number, from: Currency | null | undefined, to: Currency | null | undefined, quotes: FxQuote[] | undefined) {
  const fromCode = from?.code || to?.code || "ARS"
  const toCode = to?.code || fromCode
  const rate = getLatestFxRate(quotes, fromCode, toCode)
  return rate ? amount * rate : amount
}

function isQuotedPerHundred(kind: string | null | undefined) {
  const normalized = String(kind || "").toLowerCase()
  return (
    normalized.includes("bono") ||
    normalized.includes("titulo") ||
    normalized.includes("título") ||
    normalized.includes("letra")
  )
}

function getBrokerCostBasis(position: BrokerPosition, quantity: number) {
  if (!position.avg_cost) return null
  const rawCost = Number(position.avg_cost) * quantity
  const kind = position.instrument?.instrument_type || position.instrument?.market || ""
  return isQuotedPerHundred(kind) ? rawCost / 100 : rawCost
}

function getManualUnitPrice(investment: Investment) {
  const quantity = investment.quantity ? Number(investment.quantity) : 0
  if (!quantity) return null
  return Number(investment.current_value) / quantity
}

export function InvestmentsManagement() {
  const { data: investments, isLoading } = useInvestments()
  const { data: connections } = useBrokerConnections()
  const { data: positions, isLoading: positionsLoading } = useBrokerPositions()
  const { data: snapshots } = usePortfolioSnapshots()
  const { data: fxQuotes } = useFxQuotes()
  const { data: savingsGoals, isLoading: savingsLoading } = useSavingsGoals()
  const { data: currencies } = useCurrencies()
  const { data: settings } = useUserSettings()
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Investment | null>(null)
  const [form, setForm] = useState<InvestmentForm>(emptyForm)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [syncingFx, setSyncingFx] = useState(false)
  const [autoRefreshing, setAutoRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  const [closingInvestment, setClosingInvestment] = useState<Investment | null>(null)
  const [isClosingInvestment, setIsClosingInvestment] = useState(false)
  const autoRefreshStarted = useRef(false)

  const defaultCurrencyId = settings?.default_currency_id || currencies?.find((currency) => currency.code === "ARS")?.id || currencies?.[0]?.id || ""
  const defaultCurrency = settings?.default_currency || currencies?.find((currency) => currency.code === "ARS") || currencies?.[0] || null
  const portfolioRows = useMemo<PortfolioRow[]>(() => {
    const manualRows = (investments || []).map((investment) => {
      const initialValue = Number(investment.initial_amount)
      const currentValue = Number(investment.current_value)
      return {
        id: `manual-${investment.id}`,
        source: "manual" as const,
        name: investment.name,
        kind: investment.type.replace("_", " "),
        quantity: investment.quantity ? Number(investment.quantity) : null,
        currentPrice: getManualUnitPrice(investment),
        priceCurrency: investment.currency,
        initialValue,
        currentValue,
        result: currentValue - initialValue,
        currency: investment.currency,
        updatedAt: investment.updated_at || investment.created_at,
        isActive: investment.is_active,
        investment,
      }
    })

    const connectedRows = (positions || []).map((position) => {
      const quantity = Number(position.quantity || 0)
      const currentValue = Number(position.market_value || 0)
      const initialValue = getBrokerCostBasis(position, quantity)
      return {
        id: `iol-${position.id}`,
        source: "iol" as const,
        name: position.instrument?.symbol || position.instrument?.name || "SIN-TICKER",
        kind: position.instrument?.instrument_type || position.instrument?.market || position.source.toUpperCase(),
        quantity,
        currentPrice: position.price ? Number(position.price) : null,
        priceCurrency: position.currency,
        initialValue,
        currentValue,
        result: initialValue === null ? null : currentValue - initialValue,
        currency: position.currency,
        updatedAt: position.observed_at,
        isActive: true,
        position,
      }
    })

    const foreignSavingsRows = (savingsGoals || [])
      .filter((goal) => !goal.is_completed && Number(goal.current_amount) > 0 && goal.currency?.code !== "ARS")
      .map((goal) => {
        const fxRate = getLatestFxRate(fxQuotes, goal.currency?.code || "USD", defaultCurrency?.code || "ARS")
        return {
          id: `savings-fx-${goal.id}`,
          source: "savings_fx" as const,
          name: goal.name,
          kind: "refugio divisa",
          quantity: Number(goal.current_amount),
          currentPrice: fxRate,
          priceCurrency: defaultCurrency,
          initialValue: null,
          currentValue: Number(goal.current_amount),
          result: null,
          currency: goal.currency,
          updatedAt: goal.updated_at || goal.created_at,
          isActive: true,
          savingsGoal: goal,
        }
      })

    return [...manualRows, ...connectedRows, ...foreignSavingsRows]
  }, [defaultCurrency, fxQuotes, investments, positions, savingsGoals])

  const visibleRows = useMemo(() => {
    const query = search.toLowerCase()
    return portfolioRows.filter((row) =>
      `${row.name} ${row.kind} ${row.source}`.toLowerCase().includes(query)
    )
  }, [portfolioRows, search])

  const totals = portfolioRows.reduce(
    (acc, row) => {
      if (row.isActive) {
        acc.initial += convertToCurrency(Number(row.initialValue || 0), row.currency, defaultCurrency, fxQuotes)
        acc.current += convertToCurrency(Number(row.currentValue), row.currency, defaultCurrency, fxQuotes)
      }
      return acc
    },
    { initial: 0, current: 0 }
  )
  const connectedTotal = (positions || []).reduce((total, position) => total + convertToCurrency(Number(position.market_value || 0), position.currency, defaultCurrency, fxQuotes), 0)
  const manualTotal = (investments || []).reduce((total, investment) => total + (investment.is_active ? convertToCurrency(Number(investment.current_value), investment.currency, defaultCurrency, fxQuotes) : 0), 0)
  const foreignSavingsTotal = (savingsGoals || [])
    .filter((goal) => !goal.is_completed && Number(goal.current_amount) > 0 && goal.currency?.code !== "ARS")
    .reduce((total, goal) => total + convertToCurrency(Number(goal.current_amount), goal.currency, defaultCurrency, fxQuotes), 0)
  const consolidated = portfolioRows.reduce(
    (acc, row) => {
      if (!row.isActive || !row.initialValue || row.initialValue <= 0) return acc
      const initial = convertToCurrency(row.initialValue, row.currency, defaultCurrency, fxQuotes)
      const current = convertToCurrency(row.currentValue, row.currency, defaultCurrency, fxQuotes)
      acc.initial += initial
      acc.current += current
      return acc
    },
    { initial: 0, current: 0 }
  )
  const consolidatedResult = consolidated.current - consolidated.initial
  const consolidatedYield = consolidated.initial > 0 ? (consolidatedResult / consolidated.initial) * 100 : 0
  const latestSnapshot = snapshots?.[0] || null
  const blueQuote = (fxQuotes || []).find((quote) => quote.rate_type.toLowerCase().includes("blue"))

  const openNew = () => {
    setEditing(null)
    setForm({ ...emptyForm, currency_id: defaultCurrencyId })
    setError(null)
    setDialogOpen(true)
  }

  const openEdit = (investment: Investment) => {
    setEditing(investment)
    setForm(investmentToForm(investment))
    setError(null)
    setDialogOpen(true)
  }

  const saveInvestment = async () => {
    if (!form.name.trim() || Number(form.initial_amount) < 0 || Number(form.current_value) < 0) {
      setError("Completa nombre, monto inicial y valor actual")
      return
    }
    if (!form.start_date) {
      setError("Selecciona la fecha de inicio")
      return
    }
    if (form.end_date && form.end_date < form.start_date) {
      setError("La fecha de fin no puede ser anterior al inicio")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error("No estás autenticado")

      const payload = {
        user_id: user.id,
        name: form.name.trim(),
        type: form.type,
        initial_amount: Number(form.initial_amount),
        current_value: Number(form.current_value),
        currency_id: form.currency_id || null,
        start_date: form.start_date,
        end_date: form.end_date || null,
        interest_rate: form.interest_rate ? Number(form.interest_rate) : null,
        notes: form.notes.trim() || null,
        is_active: form.is_active,
      }

      const result = editing
        ? await supabase.from("investments").update(payload).eq("id", editing.id)
        : await supabase.from("investments").insert(payload)

      if (result.error) throw result.error
      invalidateCache("investments")
      setDialogOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar la inversion")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCloseInvestment = async () => {
    if (!closingInvestment) return
    setIsClosingInvestment(true)
    try {
      const supabase = createClient()
      const { error: updateError } = await supabase
        .from("investments")
        .update({ is_active: false, end_date: closingInvestment.end_date || toLocalDateOnly() })
        .eq("id", closingInvestment.id)
      if (updateError) {
        setError(updateError.message)
        return
      }
      invalidateCache("investments")
    } finally {
      setIsClosingInvestment(false)
      setClosingInvestment(null)
    }
  }

  const syncFx = async () => {
    setSyncingFx(true)
    setError(null)
    setSyncNotice(null)
    try {
      await postJson("/api/market/fx/sync")
      mutate("fx-quotes")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al actualizar cotizaciones")
    } finally {
      setSyncingFx(false)
    }
  }

  useEffect(() => {
    if (!connections || autoRefreshStarted.current) return
    autoRefreshStarted.current = true

    async function refreshMarketData() {
      setAutoRefreshing(true)
      setError(null)
      setSyncNotice(null)
      try {
        const staleConnections = (connections || []).filter(shouldAutoSyncConnection)
        const reauthConnections = (connections || []).filter((connection) => connection.status === "reauth_required")

        if (reauthConnections.length > 0) {
          setSyncNotice("IOL quedó pausado y se muestra la última cartera guardada. Podés renovarlo desde Configuración > Integraciones.")
        }

        const results = await Promise.allSettled([
          postJson("/api/market/fx/sync"),
          ...staleConnections.map((connection) => postJson("/api/integrations/iol/sync", { connectionId: connection.id, mode: "auto" })),
        ])

        const rejected = results.filter((result) => result.status === "rejected")
        const requiresReconnect = rejected.find(
          (result) => result.status === "rejected" && result.reason instanceof ApiRequestError && result.reason.code === "IOL_REAUTH_REQUIRED",
        )
        const otherError = rejected.find(
          (result) => !(result.status === "rejected" && result.reason instanceof ApiRequestError && result.reason.code === "IOL_REAUTH_REQUIRED"),
        )

        if (requiresReconnect) {
          setSyncNotice("IOL quedó pausado y se muestra la última cartera guardada. Podés renovarlo desde Configuración > Integraciones.")
        }
        if (otherError?.status === "rejected") {
          setError(otherError.reason instanceof Error ? otherError.reason.message : "No se pudo actualizar una cotizacion")
        }
        mutate("fx-quotes")
        invalidateCaches(["broker-connections", "broker-positions", "portfolio-snapshots"])
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error al actualizar cotizaciones")
      } finally {
        setAutoRefreshing(false)
      }
    }

    refreshMarketData()
  }, [connections])

  const syncIol = async () => {
    const activeIolConnections = (connections || []).filter(
      (connection) => connection.status === "active" && connection.provider?.code === "iol",
    )
    if (activeIolConnections.length === 0) {
      setSyncNotice("No hay una conexión IOL activa para actualizar. Revisá Configuración > Integraciones.")
      return
    }

    setAutoRefreshing(true)
    setError(null)
    setSyncNotice(null)
    try {
      const results = await Promise.allSettled([
        postJson("/api/market/fx/sync"),
        ...activeIolConnections.map((connection) =>
          postJson("/api/integrations/iol/sync", { connectionId: connection.id, mode: "manual" }),
        ),
      ])
      const rejected = results.find((result) => result.status === "rejected")
      if (rejected?.status === "rejected") throw rejected.reason

      mutate("fx-quotes")
      invalidateCaches(["broker-connections", "broker-positions", "portfolio-snapshots"])
      setSyncNotice("IOL actualizado correctamente.")
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "IOL_REAUTH_REQUIRED") {
        setSyncNotice("IOL requiere reconectar la cuenta desde Configuración > Integraciones.")
      } else {
        setError(err instanceof Error ? err.message : "Error al actualizar IOL")
      }
    } finally {
      setAutoRefreshing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Portfolio total</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xl font-bold sm:text-2xl">
            {formatCurrency(totals.current, defaultCurrency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Manual</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xl font-bold sm:text-2xl">
            {formatCurrency(manualTotal, defaultCurrency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Ahorros divisa</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xl font-bold sm:text-2xl">
            {formatCurrency(foreignSavingsTotal, defaultCurrency)}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="text-sm text-muted-foreground">Conectado</CardTitle>
              <Button variant="ghost" size="sm" className="w-full sm:w-auto" onClick={syncIol} disabled={autoRefreshing}>
                {autoRefreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Actualizar IOL
              </Button>
            </div>
          </CardHeader>
          <CardContent className="font-mono text-xl font-bold sm:text-2xl">
            {formatCurrency(connectedTotal || Number(latestSnapshot?.total_value || 0), defaultCurrency)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm text-muted-foreground">Posiciones IOL</CardTitle>
              {autoRefreshing && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
          </CardHeader>
          <CardContent className="font-mono text-xl font-bold sm:text-2xl">{positions?.length || 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm text-muted-foreground">Dolar blue venta</CardTitle>
              <Button variant="ghost" size="icon" onClick={syncFx} disabled={syncingFx}>
                {syncingFx ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="font-mono text-xl font-bold sm:text-2xl">
            {blueQuote?.ask ? formatCurrency(Number(blueQuote.ask), blueQuote.quote_currency) : "-"}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-1">
            <CardTitle>Posicion consolidada</CardTitle>
            <p className="text-sm text-muted-foreground">Rendimiento actual sobre activos con costo registrado.</p>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-sm text-muted-foreground">Costo</p>
              <p className="text-xl font-bold font-mono">{formatCurrency(consolidated.initial, defaultCurrency)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Valor actual</p>
              <p className="text-xl font-bold font-mono">{formatCurrency(consolidated.current, defaultCurrency)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Resultado</p>
              <p className={`text-xl font-bold font-mono ${consolidatedResult >= 0 ? "text-success" : "text-destructive"}`}>
                {formatCurrency(consolidatedResult, defaultCurrency)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Rendimiento</p>
              <p className={`text-xl font-bold font-mono ${consolidatedResult >= 0 ? "text-success" : "text-destructive"}`}>
                {consolidated.initial > 0 ? `${consolidatedYield.toFixed(2)}%` : "-"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Cartera</CardTitle>
            <div className="grid gap-2 sm:flex">
              <div className="relative flex-1 sm:w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Buscar..." value={search} onChange={(event) => setSearch(event.target.value)} className="pl-8" />
              </div>
              <Button className="w-full sm:w-auto" onClick={openNew}>
                <Plus className="mr-2 h-4 w-4" />
                Nueva
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {syncNotice && !dialogOpen && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {syncNotice}
            </div>
          )}
          {error && !dialogOpen && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}
          {isLoading || positionsLoading || savingsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">No hay inversiones registradas</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Activo</TableHead>
                    <TableHead>Origen</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right">Cantidad</TableHead>
                    <TableHead className="text-right">Precio actual</TableHead>
                    <TableHead className="text-right">Inicial / costo</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Resultado</TableHead>
                    <TableHead>Actualizado</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell>
                        <Badge variant={row.source === "manual" ? "outline" : "secondary"}>
                          {row.source === "manual" ? "Manual" : row.source === "iol" ? "IOL" : "Ahorro"}
                        </Badge>
                      </TableCell>
                      <TableCell className="capitalize">{row.kind}</TableCell>
                      <TableCell className="text-right font-mono">
                        {row.quantity === null ? "-" : row.quantity.toLocaleString("es-AR")}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.currentPrice === null ? "-" : formatCurrency(row.currentPrice, row.priceCurrency)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.initialValue === null ? "-" : formatCurrency(row.initialValue, row.currency)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(row.currentValue, row.currency)}</TableCell>
                      <TableCell className={`text-right font-mono ${Number(row.result || 0) >= 0 ? "text-success" : "text-destructive"}`}>
                        {row.result === null ? "-" : formatCurrency(row.result, row.currency)}
                      </TableCell>
                      <TableCell>{formatDateTime(row.updatedAt)}</TableCell>
                      <TableCell>
                        {row.investment ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label="Más acciones de inversión">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openEdit(row.investment!)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Editar
                              </DropdownMenuItem>
                              <DropdownMenuItem className="text-destructive" onClick={() => setClosingInvestment(row.investment!)}>
                                <Trash2 className="mr-2 h-4 w-4" />
                                Cerrar
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Editar inversion" : "Nueva inversion"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Nombre</Label>
                <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Tipo</Label>
                <Select value={form.type} onValueChange={(value) => setForm({ ...form, type: value as Investment["type"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plazo_fijo">Plazo fijo</SelectItem>
                    <SelectItem value="acciones">Acciones</SelectItem>
                    <SelectItem value="crypto">Crypto</SelectItem>
                    <SelectItem value="fci">FCI</SelectItem>
                    <SelectItem value="bonos">Bonos</SelectItem>
                    <SelectItem value="otros">Otros</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Inicial</Label>
                <Input type="number" step="0.01" value={form.initial_amount} onChange={(event) => setForm({ ...form, initial_amount: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Actual</Label>
                <Input type="number" step="0.01" value={form.current_value} onChange={(event) => setForm({ ...form, current_value: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Moneda</Label>
                <Select value={form.currency_id} onValueChange={(value) => setForm({ ...form, currency_id: value })}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                  <SelectContent>
                    {currencies?.map((currency) => (
                      <SelectItem key={currency.id} value={currency.id}>{currency.code} ({currency.symbol})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Inicio</Label>
                <Input type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Fin</Label>
                <Input type="date" value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Tasa %</Label>
                <Input type="number" step="0.01" value={form.interest_rate} onChange={(event) => setForm({ ...form, interest_rate: event.target.value })} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notas</Label>
              <Textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.is_active} onCheckedChange={(checked) => setForm({ ...form, is_active: checked })} />
              <Label>Activa</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={saveInvestment} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!closingInvestment} onOpenChange={() => setClosingInvestment(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cerrar inversión</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Cerrar la inversión "{closingInvestment?.name}"? Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClosingInvestment}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCloseInvestment}
              disabled={isClosingInvestment}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isClosingInvestment && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Cerrar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
