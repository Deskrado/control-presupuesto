"use client"

import { RecurringExpenseManagement } from "@/components/expenses/recurring-expense-management"
import { TransactionList } from "@/components/transactions/transaction-list"
import { useMonthlyTransactions } from "@/components/dashboard/use-dashboard-data"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function GastosPage() {
  const { data: transactions, isLoading } = useMonthlyTransactions()
  const expenses = transactions?.filter((t) => t.type === "expense") || []

  return (
    <Tabs defaultValue="movements" className="space-y-4">
      <TabsList className="flex h-auto flex-wrap justify-start">
        <TabsTrigger value="movements">Gastos</TabsTrigger>
        <TabsTrigger value="recurring">Recurrentes</TabsTrigger>
      </TabsList>

      <TabsContent value="movements">
        <TransactionList
          transactions={expenses}
          type="expense"
          isLoading={isLoading}
        />
      </TabsContent>

      <TabsContent value="recurring">
        <RecurringExpenseManagement />
      </TabsContent>
    </Tabs>
  )
}
