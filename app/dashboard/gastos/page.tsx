"use client"

import Link from "next/link"
import { RecurringExpenseManagement } from "@/components/expenses/recurring-expense-management"
import { TransactionList } from "@/components/transactions/transaction-list"
import { useMonthlyTransactions } from "@/components/dashboard/use-dashboard-data"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { RefreshCw } from "lucide-react"

export default function GastosPage() {
  const { data: transactions, isLoading } = useMonthlyTransactions()
  const expenses = transactions?.filter((t) => t.type === "expense") || []

  return (
    <Tabs defaultValue="movements" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="movements">Gastos</TabsTrigger>
          <TabsTrigger value="recurring">Recurrentes</TabsTrigger>
        </TabsList>
        <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
          <Link href="/dashboard/recurrentes">
            <RefreshCw className="mr-2 h-4 w-4" />
            Ir a Gastos recurrentes
          </Link>
        </Button>
      </div>

      <TabsContent value="movements">
        <TransactionList
          transactions={expenses}
          type="expense"
          isLoading={isLoading}
        />
      </TabsContent>

      <TabsContent value="recurring">
        <RecurringExpenseManagement scope="non_card" />
      </TabsContent>
    </Tabs>
  )
}
