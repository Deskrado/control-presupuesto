"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useDashboard } from "@/components/dashboard/dashboard-context"
import { useCurrencies, useUserSettings } from "@/components/dashboard/use-dashboard-data"
import { formatCurrency } from "@/lib/currency"
import type { RecurringExpenseSeriesSummary } from "@/lib/recurring-expense-series"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2, PencilLine, Trash2 } from "lucide-react"
import { invalidateCacheByPrefix } from "@/lib/swr-cache"

type AmountMode = "absolute" | "percent"

type AmountPreviewItem = {
  seriesId: string
  description: string
  categoryId?: string | null
  fromAmount: number
  toAmount: number
  pendingUpdated: number
  seedBudgetedUpdated: boolean
}

type DisablePreviewItem = {
  seriesId: string
  description: string
  pendingArchived: number
  remainingActive: number
  endDate: string
}

async function fetchJson(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || "No se pudo completar la solicitud")
  return payload
}

export type RecurringExpenseManagementScope = "all" | "non_card"

type RecurringExpenseManagementProps = {
  /** `non_card` = gastos recurrentes (efectivo/débito/transfer). Débitos de tarjeta viven en Tarjetas. */
  scope?: RecurringExpenseManagementScope
}

export function RecurringExpenseManagement({ scope = "non_card" }: RecurringExpenseManagementProps) {
  const { selectedMonth, selectedYear } = useDashboard()
  const { data: currencies } = useCurrencies()
  const { data: settings } = useUserSettings()
  const [series, setSeries] = useState<RecurringExpenseSeriesSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [amountOpen, setAmountOpen] = useState(false)
  const [amountMode, setAmountMode] = useState<AmountMode>("percent")
  const [amountValue, setAmountValue] = useState("10")
  const [amountPreview, setAmountPreview] = useState<AmountPreviewItem[]>([])
  const [pendingAmountChange, setPendingAmountChange] = useState<{ mode: AmountMode; value: number } | null>(null)

  const [disableOpen, setDisableOpen] = useState(false)
  const [disablePreview, setDisablePreview] = useState<DisablePreviewItem[]>([])
  const [confirmForwardDelete, setConfirmForwardDelete] = useState(false)

  const periodLabel = `${String(selectedMonth).padStart(2, "0")}/${selectedYear}`
  const pendingToArchive = useMemo(
    () => disablePreview.reduce((sum, item) => sum + item.pendingArchived, 0),
    [disablePreview],
  )
  const showTypeColumn = scope === "all"

  const defaultCurrency = settings?.default_currency || currencies?.find((currency) => currency.code === "ARS") || currencies?.[0]
  const currencyById = useMemo(() => {
    const map = new Map((currencies || []).map((currency) => [currency.id, currency]))
    return map
  }, [currencies])

  const loadSeries = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        month: String(selectedMonth),
        year: String(selectedYear),
      })
      const payload = await fetchJson(`/api/recurring-expenses/bulk?${params}`)
      const allSeries = (payload.series || []) as RecurringExpenseSeriesSummary[]
      setSeries(scope === "non_card" ? allSeries.filter((item) => !item.isAutomaticDebit) : allSeries)
      setSelectedIds(new Set())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Error al cargar recurrentes")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadSeries()
  }, [scope, selectedMonth, selectedYear])

  const selectedSeries = useMemo(
    () => series.filter((item) => selectedIds.has(item.seriesId)),
    [series, selectedIds],
  )

  const totals = useMemo(
    () => selectedSeries.reduce((sum, item) => sum + item.currentAmount, 0),
    [selectedSeries],
  )

  const allSelected = series.length > 0 && selectedIds.size === series.length

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(series.map((item) => item.seriesId)) : new Set())
  }

  const toggleOne = (seriesId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(seriesId)
      else next.delete(seriesId)
      return next
    })
  }

  const openAmountDialog = async () => {
    if (selectedIds.size === 0) return
    setError(null)
    setIsSubmitting(true)
    try {
      const value = Number(amountValue)
      if (!Number.isFinite(value)) throw new Error("Ingresá un valor numérico válido")
      const payload = await fetchJson("/api/recurring-expenses/bulk", {
        method: "POST",
        body: JSON.stringify({
          action: "update-amount",
          dryRun: true,
          seriesIds: Array.from(selectedIds),
          mode: amountMode,
          value,
          month: selectedMonth,
          year: selectedYear,
        }),
      })
      setPendingAmountChange({ mode: amountMode, value })
      setAmountPreview(payload.preview || [])
      setAmountOpen(true)
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "No se pudo preparar la vista previa")
    } finally {
      setIsSubmitting(false)
    }
  }

  const confirmAmountUpdate = async () => {
    if (!pendingAmountChange) return
    setIsSubmitting(true)
    setError(null)
    try {
      const payload = await fetchJson("/api/recurring-expenses/bulk", {
        method: "POST",
        body: JSON.stringify({
          action: "update-amount",
          seriesIds: Array.from(selectedIds),
          mode: pendingAmountChange.mode,
          value: pendingAmountChange.value,
          month: selectedMonth,
          year: selectedYear,
        }),
      })
      setMessage(`Actualizados ${payload.updated || 0} movimientos en ${payload.preview?.length || 0} series.`)
      setAmountOpen(false)
      setPendingAmountChange(null)
      invalidateCacheByPrefix("transactions")
      await loadSeries()
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Error al actualizar montos")
    } finally {
      setIsSubmitting(false)
    }
  }

  const openDisableDialog = async () => {
    if (selectedIds.size === 0) return
    setError(null)
    setIsSubmitting(true)
    try {
      const payload = await fetchJson("/api/recurring-expenses/bulk", {
        method: "POST",
        body: JSON.stringify({
          action: "disable",
          dryRun: true,
          seriesIds: Array.from(selectedIds),
          month: selectedMonth,
          year: selectedYear,
        }),
      })
      setDisablePreview(payload.preview || [])
      setConfirmForwardDelete(false)
      setDisableOpen(true)
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "No se pudo preparar la confirmación")
    } finally {
      setIsSubmitting(false)
    }
  }

  const confirmDisable = async () => {
    if (!confirmForwardDelete) return
    setIsSubmitting(true)
    setError(null)
    try {
      const payload = await fetchJson("/api/recurring-expenses/bulk", {
        method: "POST",
        body: JSON.stringify({
          action: "disable",
          seriesIds: Array.from(selectedIds),
          month: selectedMonth,
          year: selectedYear,
        }),
      })
      setMessage(
        `Series cortadas y ocultas de activas: ${payload.preview?.length || 0}. Pendientes/futuros archivados desde ${periodLabel}: ${payload.archived || 0}.`,
      )
      setDisableOpen(false)
      setConfirmForwardDelete(false)
      invalidateCacheByPrefix("transactions")
      await loadSeries()
    } catch (disableError) {
      setError(disableError instanceof Error ? disableError.message : "Error al eliminar recurrentes")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      {(message || error) && (
        <div className={`rounded-md border p-3 text-sm ${error ? "border-destructive/40 text-destructive" : "bg-muted"}`}>
          {error || message}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Series activas</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{series.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Seleccionadas</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{selectedIds.size}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total seleccionado</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold font-mono">
            {formatCurrency(totals, defaultCurrency)}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <CardTitle>{scope === "non_card" ? "Gastos recurrentes" : "Gastos recurrentes y débitos automáticos"}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {scope === "non_card" ? (
                  <>
                    Series de gasto recurrente (sin tarjeta). Los débitos automáticos de tarjeta se administran en{" "}
                    <Link href="/dashboard/tarjetas" className="font-medium text-foreground underline-offset-4 hover:underline">
                      Tarjetas
                    </Link>
                    . Seleccioná series y usá{" "}
                    <span className="font-medium text-foreground">Actualizar montos</span> o{" "}
                    <span className="font-medium text-foreground">Eliminar futuros</span>. Alcance desde {periodLabel}.
                  </>
                ) : (
                  <>
                    Incluye débitos automáticos de tarjeta. Seleccioná series con los checkboxes y usá{" "}
                    <span className="font-medium text-foreground">Actualizar montos</span> o{" "}
                    <span className="font-medium text-foreground">Eliminar futuros</span>. El alcance usa el mes del dashboard ({periodLabel}).
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="space-y-2">
                <Label>Cambio de monto</Label>
                <RadioGroup
                  value={amountMode}
                  onValueChange={(value) => setAmountMode(value as AmountMode)}
                  className="flex gap-4"
                >
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="percent" id="expense-mode-percent" />
                    Porcentaje
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="absolute" id="expense-mode-absolute" />
                    Monto fijo
                  </label>
                </RadioGroup>
              </div>
              <div className="space-y-2">
                <Label htmlFor="expense-amount-value">{amountMode === "percent" ? "% de cambio" : "Nuevo monto"}</Label>
                <Input
                  id="expense-amount-value"
                  type="number"
                  step="0.01"
                  value={amountValue}
                  onChange={(event) => setAmountValue(event.target.value)}
                  className="w-36"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={openAmountDialog}
                  disabled={selectedIds.size === 0 || isSubmitting}
                >
                  {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PencilLine className="mr-2 h-4 w-4" />}
                  Actualizar montos
                </Button>
                <Button
                  variant="destructive"
                  onClick={openDisableDialog}
                  disabled={selectedIds.size === 0 || isSubmitting}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Eliminar futuros
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : series.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">No hay gastos recurrentes activos</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(checked) => toggleAll(checked === true)}
                        aria-label="Seleccionar todos"
                      />
                    </TableHead>
                    <TableHead>Descripción</TableHead>
                    {showTypeColumn && <TableHead>Tipo</TableHead>}
                    <TableHead>Último período</TableHead>
                    <TableHead>Pendientes</TableHead>
                    <TableHead className="text-right">Monto actual</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {series.map((item) => (
                    <TableRow key={item.seriesId} data-state={selectedIds.has(item.seriesId) ? "selected" : undefined}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(item.seriesId)}
                          onCheckedChange={(checked) => toggleOne(item.seriesId, checked === true)}
                          aria-label={`Seleccionar ${item.description}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{item.description}</div>
                        {item.endDate ? (
                          <div className="text-xs text-muted-foreground">Hasta {item.endDate}</div>
                        ) : (
                          <div className="text-xs text-muted-foreground">Sin fecha de fin</div>
                        )}
                      </TableCell>
                      {showTypeColumn && (
                        <TableCell>
                          <Badge variant="outline">
                            {item.isAutomaticDebit ? "Débito automático" : "Recurrente"}
                          </Badge>
                        </TableCell>
                      )}
                      <TableCell>{item.latestPeriod.slice(0, 7)}</TableCell>
                      <TableCell>{item.pendingCount}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(item.currentAmount, currencyById.get(item.currencyId || "") || defaultCurrency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={amountOpen} onOpenChange={setAmountOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirmar actualización de montos</DialogTitle>
            <DialogDescription>
              Se actualizarán los pendientes desde {String(selectedMonth).padStart(2, "0")}/{selectedYear}.
              Los montos ya aprobados se conservan; el presupuesto del seed se ajusta para próximas materializaciones.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Serie</TableHead>
                  <TableHead className="text-right">Antes</TableHead>
                  <TableHead className="text-right">Después</TableHead>
                  <TableHead className="text-right">Pendientes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {amountPreview.map((item) => (
                  <TableRow key={item.seriesId}>
                    <TableCell>{item.description}</TableCell>
                    <TableCell className="text-right font-mono">{formatCurrency(item.fromAmount, defaultCurrency)}</TableCell>
                    <TableCell className="text-right font-mono">{formatCurrency(item.toAmount, defaultCurrency)}</TableCell>
                    <TableCell className="text-right">{item.pendingUpdated}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAmountOpen(false)} disabled={isSubmitting}>Cancelar</Button>
            <Button onClick={confirmAmountUpdate} disabled={isSubmitting || amountPreview.length === 0}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmar actualización
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={disableOpen}
        onOpenChange={(open) => {
          setDisableOpen(open)
          if (!open) setConfirmForwardDelete(false)
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>¿Eliminar pendientes y futuros de las series?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Alcance desde <span className="font-medium text-foreground">{periodLabel}</span> (mes del dashboard):
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>Se cortan las series seleccionadas: salen del listado de activas y no se materializan meses futuros.</li>
                  <li>Se archivan los movimientos <span className="font-medium text-foreground">pendientes</span> de {periodLabel} en adelante ({pendingToArchive} en total).</li>
                  <li>Los movimientos <span className="font-medium text-foreground">aprobados</span> históricos se conservan.</li>
                </ul>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-56 space-y-2 overflow-y-auto text-sm">
            {disablePreview.map((item) => (
              <div key={item.seriesId} className="rounded-md border p-3">
                <div className="font-medium">{item.description}</div>
                <div className="text-muted-foreground">
                  {item.pendingArchived === 0
                    ? `0 pendientes/futuros · corta/oculta la serie (fin ${item.endDate}) · conserva ${item.remainingActive} históricos`
                    : `Archiva ${item.pendingArchived} pendientes/futuros · conserva ${item.remainingActive} históricos · fin de serie ${item.endDate}`}
                </div>
              </div>
            ))}
          </div>
          <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <Checkbox
              checked={confirmForwardDelete}
              onCheckedChange={(checked) => setConfirmForwardDelete(checked === true)}
              className="mt-0.5"
            />
            <span>
              Confirmo cortar estas series desde {periodLabel}
              {pendingToArchive > 0 ? " y archivar pendientes/futuros" : " (aunque no haya pendientes)"}.
            </span>
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDisableOpen(false)
                setConfirmForwardDelete(false)
              }}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDisable}
              disabled={isSubmitting || !confirmForwardDelete || disablePreview.length === 0}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Eliminar futuros
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
