import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

const PAGE_SIZE = 1000
// Keep in sync with lib/credit-card-billing.ts CREDIT_CARD_PAYMENT_APPROVAL_START_DATE.
// Installments on/after this date stay pending until statement payment (cash impact).
const APPROVAL_START_DATE = "2026-06-01"

function loadEnv() {
  const envPath = join(process.cwd(), ".env")
  if (!existsSync(envPath)) return

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue
    const [key, ...rest] = trimmed.split("=")
    process.env[key] ||= rest.join("=")
  }
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "")
  if (!match) throw new Error(`Fecha inválida: ${value}`)
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

function toDateOnly(year, month, day) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(Math.max(day, 1), lastDay)).padStart(2, "0")}`
}

function addMonthsToDateOnly(value, monthsToAdd) {
  const parsed = parseDateOnly(value)
  const target = new Date(Date.UTC(parsed.year, parsed.month - 1 + monthsToAdd, 1))
  return toDateOnly(target.getUTCFullYear(), target.getUTCMonth() + 1, parsed.day)
}

function getStatementDueDate(purchaseDate, card) {
  const parsed = parseDateOnly(purchaseDate)
  if (!card?.closing_day) return purchaseDate

  const closingDay = Math.max(1, Math.min(Number(card.closing_day) || 1, 31))
  const dueDay = Math.max(1, Math.min(Number(card.due_day) || 1, 31))
  const monthsToClose = parsed.day <= closingDay ? 0 : 1
  const monthsFromCloseToDue = dueDay > closingDay ? 0 : 1
  const target = new Date(Date.UTC(parsed.year, parsed.month - 1 + monthsToClose + monthsFromCloseToDue, 1))
  return toDateOnly(target.getUTCFullYear(), target.getUTCMonth() + 1, dueDay)
}

async function fetchAll(makeQuery) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await makeQuery().range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) return rows
  }
}

loadEnv()

const apply = process.argv.includes("--apply")
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
if (!url || !key) {
  throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY")
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

const purchases = await fetchAll(() => supabase
  .from("credit_card_purchases")
  .select("*, credit_card:credit_cards(id, name, brand, closing_day, due_day, currency_id, family_id), category:categories(id, group_id)")
  .eq("is_active", true)
  .not("family_id", "is", null)
  .order("created_at", { ascending: true }))

const purchaseIds = new Set(purchases.map((purchase) => purchase.id))
const transactions = await fetchAll(() => supabase
  .from("transactions")
  .select("id, credit_card_purchase_id, installment_number, archived_at")
  .not("credit_card_purchase_id", "is", null)
  .order("created_at", { ascending: true }))

// Archived rows are deliberate tombstones: their keys count as materialized and
// must never be recreated by this reconciliation.
const existingKeys = new Set(
  transactions
    .filter((transaction) => purchaseIds.has(transaction.credit_card_purchase_id))
    .map((transaction) => `${transaction.credit_card_purchase_id}:${transaction.installment_number}`),
)

const generatedAt = new Date().toISOString()
const missing = []

for (const purchase of purchases) {
  if (!purchase.credit_card) {
    console.warn(`Compra ${purchase.id} (${purchase.description}) sin tarjeta relacionada; se omite.`)
    continue
  }

  const firstDueDate = getStatementDueDate(purchase.start_date, purchase.credit_card)
  for (let index = 0; index < Number(purchase.total_installments || 0); index += 1) {
    const installmentNumber = index + 1
    const keyForInstallment = `${purchase.id}:${installmentNumber}`
    if (existingKeys.has(keyForInstallment)) continue

    const dueDate = addMonthsToDateOnly(firstDueDate, index)
    // Align with buildCreditCardInstallmentTransactions: unpaid statement debt is pending.
    const requiresApproval = dueDate >= APPROVAL_START_DATE
    const totalAmount = Number(purchase.total_amount ?? (Number(purchase.installment_amount) * Number(purchase.total_installments || 0)))
    const totalInstallments = Math.max(Math.floor(Number(purchase.total_installments) || 1), 1)
    const totalCents = Math.round(totalAmount * 100)
    const baseCents = Math.floor(totalCents / totalInstallments)
    const remainderCents = totalCents - baseCents * totalInstallments
    const amount = Math.round(baseCents + (index < remainderCents ? 1 : 0)) / 100
    missing.push({
      user_id: purchase.user_id,
      family_id: purchase.family_id,
      created_by: purchase.user_id,
      description: purchase.description,
      amount,
      budgeted_amount: amount,
      currency_id: purchase.currency_id || purchase.credit_card.currency_id || null,
      category_id: purchase.category_id || null,
      group_id: purchase.category?.group_id || null,
      transaction_date: dueDate,
      type: "expense",
      is_recurring: false,
      payment_method: "credit",
      credit_card_id: purchase.credit_card_id,
      credit_card_purchase_id: purchase.id,
      installment_number: installmentNumber,
      status: requiresApproval ? "pending" : "approved",
      approved_at: requiresApproval ? null : generatedAt,
      approved_by: requiresApproval ? null : purchase.user_id,
      notes: purchase.notes || null,
      metadata: {
        source: "credit_card_installment",
        purchase_date: purchase.start_date,
        billing_date: dueDate,
        billing_rule: "credit_card_statement_due",
        total_installments: purchase.total_installments,
        generated_at: generatedAt,
        generated_by: "scripts/reconcile-credit-card-installments.mjs",
      },
      _card_name: purchase.credit_card.name,
    })
  }
}

console.table(missing.map((row) => ({
  compra: row.description,
  tarjeta: row._card_name,
  cuota: `${row.installment_number}/${row.metadata.total_installments}`,
  vencimiento: row.transaction_date,
  monto: row.amount,
  compra_id: row.credit_card_purchase_id,
})))

console.log(`Compras familiares activas: ${purchases.length}. Cuotas faltantes sin tombstone: ${missing.length}.`)

if (!apply) {
  console.log("Dry-run: no se modificó ninguna fila. Ejecuta con --apply después de aplicar las migraciones.")
} else if (missing.length === 0) {
  console.log("Apply: no hay cuotas para insertar.")
} else {
  const payload = missing.map(({ _card_name, ...row }) => row)
  const { error } = await supabase.from("transactions").upsert(payload, {
    onConflict: "credit_card_purchase_id,installment_number",
    ignoreDuplicates: true,
  })
  if (error) throw error
  console.log(`Apply completo: se reconciliaron hasta ${payload.length} cuotas de forma idempotente.`)
}
