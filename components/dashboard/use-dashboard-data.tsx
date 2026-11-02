"use client"

import { createClient } from "@/lib/supabase/client"
import { useEffect } from "react"
import useSWR, { mutate } from "swr"
import { invalidateCacheByPrefix, invalidateCaches } from "@/lib/swr-cache"
import { getMonthRange } from "@/lib/currency"
import { getMonthBounds } from "@/lib/date-only"
import { getTransactionActualAmount, getTransactionBudgetedAmount } from "@/lib/transaction-list-utils"
import { useDashboard } from "./dashboard-context"
import type {
  Transaction,
  RecurringIncomeTemplate,
  ProjectionScenario,
  Category,
  Group,
  Currency,
  CreditCard,
  CreditCardPurchase,
  CreditCardStatement,
  Investment,
  BrokerConnection,
  BrokerPosition,
  PortfolioSnapshot,
  FxQuote,
  SavingsGoal,
  UserSettings,
  MonthlyClosure,
  FamilyMember,
  FamilyMemberPermissions,
} from "@/lib/types"
import {
  applyTransactionVisibility,
  canApplyFamilyRestrictions,
  canSeeModule,
  getMaskedCategoryAmount,
  isCategoryVisibleForMember,
} from "@/lib/family-visibility"

const supabase = createClient()
const generatedRecurringExpensePeriods = new Set<string>()
const generatedRecurringIncomePeriods = new Set<string>()
const materializedCreditCardPurchasePeriods = new Set<string>()

type FamilyVisibilityData = {
  membership: FamilyMember | null
  permissions: FamilyMemberPermissions | null
}

function getVisibilityScope(visibility: FamilyVisibilityData | undefined) {
  if (!visibility) return null
  if (!visibility.membership) return "personal"
  return [
    visibility.membership.family_id,
    visibility.membership.id,
    visibility.membership.role,
    visibility.permissions?.updated_at || "owner",
  ].join(":")
}

async function postJson(path: string, body?: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || "Error al ejecutar la acción")
  return payload as { created?: number }
}

function getPositionAccountKey(position: BrokerPosition) {
  const connection = position.account?.connection
  const provider = connection?.provider_id || "provider"
  const environment = connection?.environment || "environment"
  const symbol = position.instrument?.symbol || position.instrument?.provider_symbol || position.instrument_id || "instrument"
  const market = position.instrument?.market || "market"
  return `${provider}:${environment}:${symbol}:${market}:${position.source}`
}

function dedupeBrokerPositions(positions: BrokerPosition[]) {
  const latestByKey = new Map<string, BrokerPosition>()

  for (const position of positions) {
    const status = position.account?.connection?.status
    if (status === "disabled") continue

    const key = getPositionAccountKey(position)
    const current = latestByKey.get(key)
    if (!current) {
      latestByKey.set(key, position)
      continue
    }

    const currentObservedAt = new Date(current.observed_at || current.updated_at).getTime()
    const nextObservedAt = new Date(position.observed_at || position.updated_at).getTime()
    if (nextObservedAt > currentObservedAt) {
      latestByKey.set(key, position)
    }
  }

  return Array.from(latestByKey.values()).sort(
    (a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime(),
  )
}

export function useCurrencies() {
  return useSWR<Currency[]>("currencies", async () => {
    const { data, error } = await supabase
      .from("currencies")
      .select("*")
      .eq("is_active", true)
      .order("code")
    if (error) throw error
    return data || []
  })
}

function useCurrentUserId() {
  const result = useSWR<string | null>("current-user-id", async () => {
    const { data: { user } } = await supabase.auth.getUser()
    return user?.id || null
  })

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      mutate("current-user-id", session?.user?.id || null, { revalidate: false })
    })

    return () => subscription.unsubscribe()
  }, [])

  return result
}

export function useFamilyVisibility() {
  const { data: userId } = useCurrentUserId()

  return useSWR<FamilyVisibilityData>(
    userId === undefined ? null : ["family-visibility", userId],
    async () => {
      if (!userId) return { membership: null, permissions: null }

      const { data: memberships, error: membershipsError } = await supabase
        .from("family_members")
        .select("*, family:families(*)")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("joined_at", { ascending: true })

      if (membershipsError) throw membershipsError

      const membership = ((memberships || []) as FamilyMember[])[0] || null
      if (!membership) return { membership: null, permissions: null }
      if (membership.role === "owner") return { membership, permissions: null }

      const { data: permissions, error: permissionsError } = await supabase
        .from("family_member_permissions")
        .select("*")
        .eq("family_member_id", membership.id)
        .maybeSingle()

      if (permissionsError) throw permissionsError

      return {
        membership,
        permissions: (permissions as FamilyMemberPermissions | null) || null,
      }
    },
  )
}

export function useCategories() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const result = useSWR<Category[]>(visibilityScope ? ["categories", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("categories")
      .select("*, group:groups(*)")
      .eq("is_active", true)
      .is("archived_at", null)
      .order("name")
    if (error) throw error
    return data || []
  })

  const permissions = visibility?.permissions
  const membership = visibility?.membership
  const shouldFilter = canApplyFamilyRestrictions(membership, permissions) && Array.isArray(permissions?.visible_category_ids)
  const visibleCategories = shouldFilter
    ? (result.data || []).filter((category) => isCategoryVisibleForMember(category, permissions))
    : result.data

  return { ...result, data: visibleCategories }
}

export function useGroups() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  return useSWR<Group[]>(visibilityScope ? ["groups", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("groups")
      .select("*")
      .is("archived_at", null)
      .order("name")
    if (error) throw error
    return data || []
  })
}

export function useCreditCards() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  return useSWR<CreditCard[]>(visibilityScope ? ["credit-cards", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("credit_cards")
      .select("*, currency:currencies(*)")
      .order("name")
    if (error) throw error
    return data || []
  })
}

export function useCreditCardStatementTransactions(year: number, month: number) {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const endDate = getMonthBounds(year, month).end

  const result = useSWR<Transaction[]>(
    visibilityScope ? ["credit-card-statement-transactions", year, month, visibilityScope] : null,
    async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select(`
          *,
          category:categories(*),
          group:groups(*),
          currency:currencies(*),
          credit_card:credit_cards(*)
        `)
        .is("archived_at", null)
        .eq("type", "expense")
        .eq("payment_method", "credit")
        .lte("transaction_date", endDate)
        .order("transaction_date", { ascending: false })
      if (error) throw error
      return data || []
    }
  )

  return {
    ...result,
    data: applyTransactionVisibility(result.data, visibility?.membership, visibility?.permissions),
  }
}

export function useCreditCardStatements(year: number, month: number) {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const key = visibilityScope ? ["credit-card-statements", year, month, visibilityScope] : null

  const result = useSWR<CreditCardStatement[]>(key, async () => {
    const response = await fetch(`/api/credit-card-statements?year=${year}&month=${month}`)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || "Error al obtener resumenes de tarjeta")
    return payload.statements || []
  })

  useEffect(() => {
    if (!visibilityScope) return
    const periodKey = `${visibilityScope}:${year}-${month}`
    if (materializedCreditCardPurchasePeriods.has(periodKey)) return

    materializedCreditCardPurchasePeriods.add(periodKey)
    postJson("/api/credit-card-purchases/materialize", { year, month })
      .then((response) => {
        if (Number(response.created || 0) > 0) {
          invalidateCaches(["credit-card-statements", "credit-card-purchases", "credit-card-statement-transactions"])
          invalidateCacheByPrefix("transactions")
        }
      })
      .catch((error) => {
        materializedCreditCardPurchasePeriods.delete(periodKey)
        console.error("No se pudieron materializar las cuotas del período", error)
      })
  }, [visibilityScope, month, year])

  return result
}

export function useMonthlyTransactions() {
  const { selectedMonth, selectedYear } = useDashboard()
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const { start: startDate, end: endDate } = getMonthBounds(selectedYear, selectedMonth)
  const key = visibilityScope ? ["transactions", selectedYear, selectedMonth, visibilityScope] : null

  const result = useSWR<Transaction[]>(
    key,
    async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select(`
          *,
          category:categories(*),
          group:groups(*),
          currency:currencies(*),
          credit_card:credit_cards(*)
        `)
        .is("archived_at", null)
        .gte("transaction_date", startDate)
        .lte("transaction_date", endDate)
        .order("transaction_date", { ascending: false })
      if (error) throw error
      return data || []
    }
  )

  useEffect(() => {
    if (!key) return
    const periodKey = `${visibilityScope}:${selectedYear}-${selectedMonth}`
    const jobs: Array<{ guard: Set<string>; request: ReturnType<typeof postJson> }> = []
    const payload = { year: selectedYear, month: selectedMonth }

    if (!generatedRecurringExpensePeriods.has(periodKey)) {
      generatedRecurringExpensePeriods.add(periodKey)
      jobs.push({ guard: generatedRecurringExpensePeriods, request: postJson("/api/recurring-expenses/generate", payload) })
    }
    if (!generatedRecurringIncomePeriods.has(periodKey)) {
      generatedRecurringIncomePeriods.add(periodKey)
      jobs.push({ guard: generatedRecurringIncomePeriods, request: postJson("/api/recurring-incomes/generate", payload) })
    }
    if (!materializedCreditCardPurchasePeriods.has(periodKey)) {
      materializedCreditCardPurchasePeriods.add(periodKey)
      jobs.push({ guard: materializedCreditCardPurchasePeriods, request: postJson("/api/credit-card-purchases/materialize", payload) })
    }
    if (jobs.length === 0) return

    Promise.all(jobs.map((job) => job.request))
      .then((responses) => {
        if (responses.some((response) => Number(response.created || 0) > 0)) {
          invalidateCacheByPrefix("transactions")
          invalidateCaches(["credit-card-purchases"])
        }
      })
      .catch((error) => {
        for (const job of jobs) job.guard.delete(periodKey)
        console.error("No se pudieron materializar los movimientos del período", error)
      })
  }, [visibilityScope, selectedMonth, selectedYear])

  return {
    ...result,
    data: applyTransactionVisibility(result.data, visibility?.membership, visibility?.permissions),
  }
}

type TransactionRange = {
  fromMonth: number
  fromYear: number
  toMonth: number
  toYear: number
}

export function useYearlyTransactions(range?: TransactionRange) {
  const { selectedMonth, selectedYear } = useDashboard()
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const projectionEnd = new Date(selectedYear, selectedMonth + 11, 0)
  const fallbackEnd = { year: projectionEnd.getFullYear(), month: projectionEnd.getMonth() + 1 }
  const fromDate = range ? getMonthRange(range.fromMonth, range.fromYear).start : null
  const endDate = range
    ? getMonthRange(range.toMonth, range.toYear).end
    : getMonthRange(fallbackEnd.month, fallbackEnd.year).end

  const result = useSWR<Transaction[]>(
    visibilityScope ? ["transactions-year", fromDate, endDate, visibilityScope] : null,
    async () => {
      let query = supabase
        .from("transactions")
        .select(`
          *,
          category:categories(*),
          group:groups(*),
          currency:currencies(*),
          credit_card:credit_cards(*)
        `)
        .is("archived_at", null)
        .lte("transaction_date", endDate)
        .order("transaction_date", { ascending: false })

      if (fromDate) query = query.gte("transaction_date", fromDate)

      const { data, error } = await query
      if (error) throw error
      return data || []
    }
  )

  return {
    ...result,
    data: applyTransactionVisibility(result.data, visibility?.membership, visibility?.permissions),
  }
}

export function useCreditCardPurchases() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const result = useSWR<CreditCardPurchase[]>(visibilityScope ? ["credit-card-purchases", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("credit_card_purchases")
      .select(`
        *,
        credit_card:credit_cards(*, currency:currencies(*)),
        category:categories(*),
        transactions(id, installment_number, transaction_date, amount, budgeted_amount, status, archived_at)
      `)
      .eq("is_active", true)
      .order("start_date", { ascending: false })
    if (error) throw error
    return data || []
  })

  const membership = visibility?.membership
  const permissions = visibility?.permissions
  const shouldRestrict = canApplyFamilyRestrictions(membership, permissions)
  const shouldFilter = shouldRestrict && Array.isArray(permissions?.visible_category_ids)
  const data = !shouldRestrict
    ? result.data
    : (result.data || [])
        .filter((purchase) =>
          !shouldFilter ||
          !purchase.category_id ||
          isCategoryVisibleForMember(purchase.category || { id: purchase.category_id, created_at: "" }, permissions)
        )
        .map((purchase) => {
          const maskedAmount = getMaskedCategoryAmount(purchase.category_id, permissions)
          if (maskedAmount === null) return purchase
          return {
            ...purchase,
            installment_amount: maskedAmount,
            total_amount: maskedAmount * Number(purchase.total_installments || 1),
          }
        })

  return { ...result, data }
}

export function useInvestments() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const result = useSWR<Investment[]>(visibilityScope ? ["investments", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("investments")
      .select("*, currency:currencies(*)")
      .order("start_date", { ascending: false })
    if (error) throw error
    return data || []
  })

  return {
    ...result,
    data: canSeeModule("investments", visibility?.membership, visibility?.permissions) ? result.data : [],
  }
}

export function useRecurringIncomeTemplates() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const result = useSWR<RecurringIncomeTemplate[]>(visibilityScope ? ["recurring-income-templates", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("recurring_income_templates")
      .select("*, currency:currencies(*), category:categories(*), group:groups(*)")
      .order("day_of_month", { ascending: true })
    if (error) throw error
    return data || []
  })

  const membership = visibility?.membership
  const permissions = visibility?.permissions
  const shouldRestrict = canApplyFamilyRestrictions(membership, permissions)
  const shouldFilter = shouldRestrict && Array.isArray(permissions?.visible_category_ids)
  const data = !shouldRestrict
    ? result.data
    : (result.data || [])
        .filter((template) =>
          !shouldFilter ||
          !template.category_id ||
          isCategoryVisibleForMember(template.category || { id: template.category_id, created_at: "" }, permissions)
        )
        .map((template) => {
          const maskedAmount = getMaskedCategoryAmount(template.category_id, permissions)
          return maskedAmount === null ? template : { ...template, amount: maskedAmount }
        })

  return { ...result, data }
}

export function useProjectionScenarios() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const result = useSWR<ProjectionScenario[]>(visibilityScope ? ["projection-scenarios", visibilityScope] : null, async () => {
    const response = await fetch("/api/projection-scenarios")
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || "Error al obtener escenarios")
    return payload.scenarios || []
  })

  const membership = visibility?.membership
  const permissions = visibility?.permissions
  const shouldRestrict = canApplyFamilyRestrictions(membership, permissions)
  const shouldFilter = shouldRestrict && Array.isArray(permissions?.visible_category_ids)
  const data = !shouldRestrict
    ? result.data
    : (result.data || []).map((scenario) => ({
        ...scenario,
        items: (scenario.items || [])
          .filter((item) =>
            !shouldFilter ||
            !item.category_id ||
            isCategoryVisibleForMember(item.category || { id: item.category_id, created_at: "" }, permissions)
          )
          .map((item) => {
            const maskedAmount = getMaskedCategoryAmount(item.category_id, permissions)
            return maskedAmount === null ? item : { ...item, amount: maskedAmount }
          }),
      }))

  return { ...result, data }
}

export function useBrokerConnections() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  return useSWR<BrokerConnection[]>(visibilityScope ? ["broker-connections", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("broker_connections")
      .select("*, provider:external_providers(*)")
      .order("created_at", { ascending: false })
    if (error) throw error
    return data || []
  })
}

export function useBrokerPositions() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const result = useSWR<BrokerPosition[]>(visibilityScope ? ["broker-positions", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("broker_positions")
      .select(`
        *,
        account:broker_accounts(*, connection:broker_connections(*)),
        instrument:market_instruments(*),
        currency:currencies(*)
    `)
      .order("observed_at", { ascending: false })
    if (error) throw error
    return dedupeBrokerPositions(data || [])
  })

  return {
    ...result,
    data: canSeeModule("investments", visibility?.membership, visibility?.permissions) ? result.data : [],
  }
}

export function usePortfolioSnapshots() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const result = useSWR<PortfolioSnapshot[]>(visibilityScope ? ["portfolio-snapshots", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("portfolio_snapshots")
      .select("*, account:broker_accounts(*), currency:currencies(*)")
      .order("snapshot_at", { ascending: false })
      .limit(24)
    if (error) throw error
    return data || []
  })

  return {
    ...result,
    data: canSeeModule("investments", visibility?.membership, visibility?.permissions) ? result.data : [],
  }
}

export function useFxQuotes() {
  return useSWR<FxQuote[]>("fx-quotes", async () => {
    const { data, error } = await supabase
      .from("fx_quotes")
      .select(`
        *,
        base_currency:currencies!fx_quotes_base_currency_id_fkey(*),
        quote_currency:currencies!fx_quotes_quote_currency_id_fkey(*)
      `)
      .order("observed_at", { ascending: false })
      .limit(60)
    if (error) throw error
    return data || []
  })
}

export function useSavingsGoals() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  return useSWR<SavingsGoal[]>(visibilityScope ? ["savings-goals", visibilityScope] : null, async () => {
    const { data, error } = await supabase
      .from("savings_goals")
      .select("*, currency:currencies(*)")
      .order("target_date", { ascending: true, nullsFirst: false })
    if (error) throw error
    return data || []
  })
}

export function useUserSettings() {
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  return useSWR<UserSettings | null>(visibilityScope ? ["user-settings", visibilityScope] : null, async () => {
    const { data, error } = await (supabase as any)
      .rpc("effective_user_settings")
      .select("*, default_currency:currencies(*)")
      .maybeSingle()
    if (error) throw error
    return (data as UserSettings | null) || null
  })
}

type MonthlyClosureRange = {
  fromMonth: number
  fromYear: number
  toMonth: number
  toYear: number
}

export function useMonthlyClosures(range?: MonthlyClosureRange) {
  const { selectedYear } = useDashboard()
  const { data: visibility } = useFamilyVisibility()
  const visibilityScope = getVisibilityScope(visibility)
  const query = range
    ? `fromYear=${range.fromYear}&fromMonth=${range.fromMonth}&toYear=${range.toYear}&toMonth=${range.toMonth}`
    : `year=${selectedYear}`

  return useSWR<MonthlyClosure[]>(visibilityScope ? ["monthly-closures", query, visibilityScope] : null, async () => {
    const response = await fetch(`/api/monthly-closures?${query}`)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || "Error al obtener cierres")
    return payload.closures || []
  })
}

export function useMonthlySummary() {
  const { data: transactions, isLoading } = useMonthlyTransactions()
  
  const summary = {
    totalIncome: 0,
    totalExpenses: 0,
    budgetedIncome: 0,
    budgetedExpenses: 0,
    savings: 0,
    savingsRate: 0,
  }

  if (transactions) {
    transactions.forEach((t) => {
      const actualAmount = getTransactionActualAmount(t)
      const budgetedAmount = getTransactionBudgetedAmount(t)
      if (t.type === "income") {
        summary.totalIncome += actualAmount
        summary.budgetedIncome += budgetedAmount
      } else {
        summary.totalExpenses += actualAmount
        summary.budgetedExpenses += budgetedAmount
      }
    })
    summary.savings = summary.totalIncome - summary.totalExpenses
    summary.savingsRate = summary.totalIncome > 0 
      ? (summary.savings / summary.totalIncome) * 100 
      : 0
  }

  return { summary, isLoading }
}

export function useGroupedTransactions() {
  const { data: transactions, isLoading } = useMonthlyTransactions()
  const { data: groups } = useGroups()

  const grouped: Record<string, {
    group: Group | null
    budgeted: number
    actual: number
    difference: number
    items: Transaction[]
  }> = {}

  if (transactions && groups) {
    // Initialize groups
    groups.forEach((g) => {
      grouped[g.id] = {
        group: g,
        budgeted: 0,
        actual: 0,
        difference: 0,
        items: [],
      }
    })
    grouped["ungrouped"] = {
      group: null,
      budgeted: 0,
      actual: 0,
      difference: 0,
      items: [],
    }

    // Group transactions
    transactions.forEach((t) => {
      const key = t.group_id || "ungrouped"
      if (!grouped[key]) {
        grouped[key] = {
          group: null,
          budgeted: 0,
          actual: 0,
          difference: 0,
          items: [],
        }
      }
      grouped[key].items.push(t)
      const amount = getTransactionActualAmount(t)
      const budgeted = getTransactionBudgetedAmount(t)
      if (t.type === "expense") {
        grouped[key].actual += amount
        grouped[key].budgeted += budgeted
      } else {
        grouped[key].actual -= amount
        grouped[key].budgeted -= budgeted
      }
    })

    // Calculate differences
    Object.values(grouped).forEach((g) => {
      g.difference = g.actual - g.budgeted
    })
  }

  return { grouped, isLoading }
}
