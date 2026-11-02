"use client"

import { SummaryCards } from "@/components/dashboard/summary-cards"
import { ExpenseIncomeTable } from "@/components/dashboard/expense-income-table"
import { AnnualProjectionChart } from "@/components/dashboard/annual-projection-chart"
import { PaymentMethodBreakdown } from "@/components/dashboard/payment-method-breakdown"
import { SavingsOverview } from "@/components/dashboard/savings-overview"
import {
  useBrokerPositions,
  useCategories,
  useCreditCardPurchases,
  useCurrencies,
  useFxQuotes,
  useInvestments,
  useMonthlyClosures,
  useMonthlySummary,
  useMonthlyTransactions,
  usePortfolioSnapshots,
  useRecurringIncomeTemplates,
  useSavingsGoals,
  useUserSettings,
  useYearlyTransactions,
  useFamilyVisibility,
} from "@/components/dashboard/use-dashboard-data"
import { useDashboard } from "@/components/dashboard/dashboard-context"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Plus } from "lucide-react"
import Link from "next/link"
import type { GroupSummary } from "@/lib/types"
import { getWealthBreakdown } from "@/lib/wealth-summary"
import { canSeeModule } from "@/lib/family-visibility"
import { applyMonthlyClosures, buildAnnualProjection } from "@/lib/projection-engine"
import { getMonthCashBalances, getPreviousPeriod } from "@/lib/monthly-balance"
import { getTransactionActualAmount, getTransactionBudgetedAmount } from "@/lib/transaction-list-utils"

export default function DashboardPage() {
  const { selectedMonth, selectedYear } = useDashboard()
  const previousPeriod = getPreviousPeriod({ year: selectedYear, month: selectedMonth })
  const closureRangeStart = selectedMonth === 1 ? previousPeriod : { year: selectedYear, month: 1 }
  const { summary, isLoading: summaryLoading } = useMonthlySummary()
  const { data: monthlyTransactions, isLoading: transactionsLoading } = useMonthlyTransactions()
  const { data: yearlyTransactions, isLoading: yearlyLoading } = useYearlyTransactions()
  const { data: monthlyClosures, isLoading: closuresLoading } = useMonthlyClosures({
    fromYear: closureRangeStart.year,
    fromMonth: closureRangeStart.month,
    toYear: selectedYear,
    toMonth: selectedMonth,
  })
  const { data: creditCardPurchases, isLoading: purchasesLoading } = useCreditCardPurchases()
  const { data: recurringIncomeTemplates } = useRecurringIncomeTemplates()
  const { data: categories } = useCategories()
  const { data: investments } = useInvestments()
  const { data: brokerPositions } = useBrokerPositions()
  const { data: portfolioSnapshots } = usePortfolioSnapshots()
  const { data: savingsGoals } = useSavingsGoals()
  const { data: fxQuotes } = useFxQuotes()
  const { data: currencies } = useCurrencies()
  const { data: settings } = useUserSettings()
  const { data: visibility } = useFamilyVisibility()

  const isLoading = summaryLoading || transactionsLoading || yearlyLoading || purchasesLoading || closuresLoading
  const currency = settings?.default_currency || currencies?.find((item) => item.code === "ARS") || currencies?.[0] || null
  const canViewInvestments = canSeeModule("investments", visibility?.membership, visibility?.permissions)
  // Process transactions for expense/income table
  const expensesByGroup: Record<string, GroupSummary> = {}
  const incomeByCategory: Record<string, GroupSummary> = {}

  if (monthlyTransactions) {
    monthlyTransactions.forEach((t) => {
      const actualAmount = getTransactionActualAmount(t)
      const budgetedAmount = getTransactionBudgetedAmount(t)
      if (t.type === "expense") {
        const groupKey = t.group_id || "ungrouped"
        if (!expensesByGroup[groupKey]) {
          expensesByGroup[groupKey] = { group: t.group || null, budgeted: 0, actual: 0, difference: 0, categories: [] }
        }
        expensesByGroup[groupKey].actual += actualAmount
        expensesByGroup[groupKey].budgeted += budgetedAmount
        expensesByGroup[groupKey].difference = expensesByGroup[groupKey].actual - expensesByGroup[groupKey].budgeted
      } else {
        const groupKey = t.category_id || "other-income"
        if (!incomeByCategory[groupKey]) {
          incomeByCategory[groupKey] = {
            group: t.category
              ? {
                  id: t.category.id,
                  user_id: t.category.user_id,
                  name: t.category.name,
                  description: null,
                  color: t.category.color,
                  created_at: t.category.created_at,
                }
              : null,
            budgeted: 0,
            actual: 0,
            difference: 0,
            categories: [],
          }
        }
        incomeByCategory[groupKey].actual += actualAmount
        incomeByCategory[groupKey].budgeted += budgetedAmount
        incomeByCategory[groupKey].difference = incomeByCategory[groupKey].actual - incomeByCategory[groupKey].budgeted
      }
    })
  }

  const monthlyData = buildAnnualProjection({
    year: selectedYear,
    selectedMonth,
    transactions: yearlyTransactions,
    purchases: creditCardPurchases,
    recurringIncomeTemplates,
    categories,
  })
  const accountingMonthlyData = applyMonthlyClosures(monthlyData, monthlyClosures)

  const configuredInitialBalance = settings?.initial_balance || 0
  const priorMonthsSavings = accountingMonthlyData.slice(0, selectedMonth - 1).reduce((total, item) => total + item.savings, 0)
  const previousMonthSavings = accountingMonthlyData[selectedMonth - 2]?.savings || 0
  const yearToDateSavings = priorMonthsSavings + summary.savings
  const { initialBalance: monthInitialBalance, finalBalance: cashBalance } = getMonthCashBalances({
    year: selectedYear,
    month: selectedMonth,
    initialBalance: configuredInitialBalance,
    monthlySavings: summary.savings,
    closures: monthlyClosures,
  })
  const wealthBreakdown = getWealthBreakdown({
    cashBalance,
    investments,
    brokerPositions,
    portfolioSnapshots,
    savingsGoals,
    fxQuotes,
    defaultCurrency: currency,
  })

  return (
    <div className="space-y-6">
      {/* Quick Actions */}
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <Button className="w-full sm:w-auto" asChild>
          <Link href="/dashboard/gastos/nuevo">
            <Plus className="mr-2 h-4 w-4" />
            Agregar Gasto
          </Link>
        </Button>
        <Button variant="outline" className="w-full sm:w-auto" asChild>
          <Link href="/dashboard/ingresos/nuevo">
            <Plus className="mr-2 h-4 w-4" />
            Agregar Ingreso
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28 w-full rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-24 w-full rounded-lg" />
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-64 w-full rounded-lg" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <SummaryCards
            initialBalance={monthInitialBalance}
            finalBalance={cashBalance}
            totalIncome={summary.totalIncome}
            totalExpenses={summary.totalExpenses}
            budgetedIncome={summary.budgetedIncome}
            budgetedExpenses={summary.budgetedExpenses}
            savings={summary.savings}
            currency={currency}
            wealth={wealthBreakdown}
            showInvestments={canViewInvestments}
          />

          <PaymentMethodBreakdown transactions={monthlyTransactions || []} currency={currency} />

          {/* Expense/Income Tables */}
          <div className="grid gap-6 lg:grid-cols-2">
            <ExpenseIncomeTable
              type="expense"
              expenseGroups={Object.values(expensesByGroup)}
              incomeGroups={Object.values(incomeByCategory)}
              currency={currency}
            />
            <ExpenseIncomeTable
              type="income"
              expenseGroups={Object.values(expensesByGroup)}
              incomeGroups={Object.values(incomeByCategory)}
              currency={currency}
            />
          </div>

          {/* Annual Projection */}
          <AnnualProjectionChart
            data={accountingMonthlyData}
            currentMonth={selectedMonth}
            currentYear={selectedYear}
            currency={currency}
          />

          {/* Savings Overview */}
          <SavingsOverview
            data={{
              currentMonth: summary.savings,
              previousMonth: previousMonthSavings,
              monthlyTarget: settings?.monthly_savings_target || 0,
              yearToDate: yearToDateSavings,
              yearTarget: settings?.annual_savings_target || 0,
            }}
            currency={currency}
            wealth={wealthBreakdown}
          />
        </>
      )}
    </div>
  )
}
