"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense } from "react"
import { RecurringExpenseManagement } from "@/components/expenses/recurring-expense-management"
import { TransactionList } from "@/components/transactions/transaction-list"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useMonthlyTransactions } from "@/components/dashboard/use-dashboard-data"
import { Button } from "@/components/ui/button"
import { RefreshCw } from "lucide-react"

const VALID_TABS = new Set(["all", "expenses", "income", "recurring"])

function TransaccionesPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get("tab") || "all"
  const activeTab = VALID_TABS.has(requestedTab) ? requestedTab : "all"
  const { data: transactions, isLoading } = useMonthlyTransactions()
  const all = transactions || []

  const setTab = (value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value === "all") params.delete("tab")
    else params.set("tab", value)
    const query = params.toString()
    router.replace(query ? `/dashboard/transacciones?${query}` : "/dashboard/transacciones", { scroll: false })
  }

  return (
    <Tabs value={activeTab} onValueChange={setTab} className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="all">Todas</TabsTrigger>
          <TabsTrigger value="expenses">Gastos</TabsTrigger>
          <TabsTrigger value="income">Ingresos</TabsTrigger>
          <TabsTrigger value="recurring">Gastos recurrentes</TabsTrigger>
        </TabsList>
        {activeTab !== "recurring" && (
          <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
            <Link href="/dashboard/recurrentes">
              <RefreshCw className="mr-2 h-4 w-4" />
              Administrar recurrentes
            </Link>
          </Button>
        )}
      </div>

      <TabsContent value="all">
        <TransactionList transactions={all} type="all" isLoading={isLoading} />
      </TabsContent>
      <TabsContent value="expenses">
        <TransactionList
          transactions={all.filter((transaction) => transaction.type === "expense")}
          type="expense"
          isLoading={isLoading}
        />
      </TabsContent>
      <TabsContent value="income">
        <TransactionList
          transactions={all.filter((transaction) => transaction.type === "income")}
          type="income"
          isLoading={isLoading}
        />
      </TabsContent>
      <TabsContent value="recurring">
        <RecurringExpenseManagement scope="non_card" />
      </TabsContent>
    </Tabs>
  )
}

export default function TransaccionesPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Cargando transacciones…</div>}>
      <TransaccionesPageContent />
    </Suspense>
  )
}
