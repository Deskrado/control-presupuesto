import { applyAmountChange, type AmountChangeMode } from "@/lib/recurring-expense-series"
import type { Category, FamilyMember, FamilyMemberPermissions, Transaction } from "@/lib/types"

type CategoryAmountItem = {
  categoryId?: string | null
}

type RecurringExpenseSeriesVisibilityItem = CategoryAmountItem & {
  currentAmount: number
}

type RecurringExpenseAmountPreviewVisibilityItem = CategoryAmountItem & {
  fromAmount: number
  toAmount: number
}

export const FAMILY_MODULES = [
  { id: "dashboard", label: "Dashboard" },
  { id: "transactions", label: "Transacciones" },
  { id: "credit_cards", label: "Tarjetas" },
  { id: "categories", label: "Categorías" },
  { id: "savings", label: "Ahorros" },
  { id: "projections", label: "Proyección" },
  { id: "investments", label: "Inversiones" },
  { id: "settings", label: "Configuración" },
] as const

export const ALL_FAMILY_MODULE_IDS = FAMILY_MODULES.map((module) => module.id)

export function isFamilyManager(membership: FamilyMember | null | undefined) {
  return Boolean(membership && ["owner", "admin"].includes(membership.role))
}

export function canApplyFamilyRestrictions(
  membership: FamilyMember | null | undefined,
  permissions: FamilyMemberPermissions | null | undefined,
) {
  // Owners/admins manage household visibility; never apply self-restrictions in UI.
  return Boolean(membership && permissions && !isFamilyManager(membership))
}

/**
 * Hydrate the settings "categorías visibles" editor from the raw permissions row.
 * Do NOT use isCategoryVisibleForMember here: masked categories are hidden from
 * restricted members at read time, but the editor must still show their toggle
 * state from visible_category_ids or saves silently drop/reset those ids.
 */
export function visibleCategoryIdsForEditor(
  savedIds: string[] | null | undefined,
  categories: Array<Pick<Category, "id">> | null | undefined,
): string[] | null {
  if (!Array.isArray(savedIds)) return savedIds ?? null
  const knownIds = new Set((categories || []).map((category) => category.id))
  if (knownIds.size === 0) return savedIds
  return savedIds.filter((id) => knownIds.has(id))
}

export function canSeeModule(
  moduleId: string,
  membership: FamilyMember | null | undefined,
  permissions: FamilyMemberPermissions | null | undefined,
) {
  if (moduleId === "settings" && membership && !["owner", "admin"].includes(membership.role)) return false
  if (!canApplyFamilyRestrictions(membership, permissions)) return true
  if (moduleId === "investments" && permissions?.show_investments === false) return false
  return (permissions?.allowed_modules || []).includes(moduleId)
}

export function getMaskedCategoryAmount(
  categoryId: string | null | undefined,
  permissions: FamilyMemberPermissions | null | undefined,
) {
  if (!categoryId || !permissions?.masked_category_amounts) return null
  const value = permissions.masked_category_amounts[categoryId]
  if (value === undefined || value === null || value === "") return null

  const amount = Number(value)
  return Number.isFinite(amount) ? amount : null
}

export function isCategoryVisibleForMember(
  category: Pick<Category, "id" | "created_at"> | null | undefined,
  permissions: FamilyMemberPermissions | null | undefined,
) {
  if (!category?.id) return true

  // Visibility toggles own readability. Masks only substitute amounts (see applyTransactionVisibility).
  const visibleCategoryIds = permissions?.visible_category_ids
  if (!Array.isArray(visibleCategoryIds)) return true
  if (visibleCategoryIds.includes(category.id)) return true

  const permissionsUpdatedAt = permissions?.updated_at || permissions?.created_at
  if (!category.created_at || !permissionsUpdatedAt) return false

  return new Date(category.created_at).getTime() > new Date(permissionsUpdatedAt).getTime()
}

export function applyTransactionVisibility(
  transactions: Transaction[] | undefined,
  membership: FamilyMember | null | undefined,
  permissions: FamilyMemberPermissions | null | undefined,
) {
  if (!transactions) return []
  if (!canApplyFamilyRestrictions(membership, permissions)) return transactions

  const shouldFilterCategories = Array.isArray(permissions?.visible_category_ids)

  return transactions
    .filter((transaction) => {
      if (!shouldFilterCategories) return true
      if (!transaction.category_id) return true
      return isCategoryVisibleForMember(
        transaction.category || { id: transaction.category_id, created_at: "" },
        permissions,
      )
    })
    .map((transaction) => {
      const maskedAmount = getMaskedCategoryAmount(transaction.category_id, permissions)
      if (maskedAmount === null) return transaction

      return {
        ...transaction,
        amount: maskedAmount,
        budgeted_amount: maskedAmount,
        metadata: {
          ...(transaction.metadata || {}),
          visibility_masked: true,
        },
      }
    })
}

/**
 * Recurrentes list/summaries: RLS already drops hidden categories; masks are
 * presentation-only and must be applied here (or in the API response) so real
 * amounts never reach a restricted member's browser.
 */
export function applyRecurringExpenseSeriesVisibility<T extends RecurringExpenseSeriesVisibilityItem>(
  series: T[] | undefined,
  membership: FamilyMember | null | undefined,
  permissions: FamilyMemberPermissions | null | undefined,
): T[] {
  if (!series) return []
  if (!canApplyFamilyRestrictions(membership, permissions)) return series

  const shouldFilterCategories = Array.isArray(permissions?.visible_category_ids)

  return series
    .filter((item) => {
      if (!shouldFilterCategories) return true
      if (!item.categoryId) return true
      return isCategoryVisibleForMember({ id: item.categoryId, created_at: "" }, permissions)
    })
    .map((item) => {
      const maskedAmount = getMaskedCategoryAmount(item.categoryId, permissions)
      if (maskedAmount === null) return item
      return { ...item, currentAmount: maskedAmount }
    })
}

/**
 * Bulk amount-update preview: substitute masked from/to so dry-run responses
 * do not leak real series amounts. Display "to" follows the same change on the
 * masked base; DB updates still use real amounts server-side.
 */
export function applyRecurringExpenseAmountPreviewVisibility<T extends RecurringExpenseAmountPreviewVisibilityItem>(
  preview: T[] | undefined,
  membership: FamilyMember | null | undefined,
  permissions: FamilyMemberPermissions | null | undefined,
  change?: { mode: AmountChangeMode; value: number } | null,
): T[] {
  if (!preview) return []
  if (!canApplyFamilyRestrictions(membership, permissions)) return preview

  return preview.map((item) => {
    const maskedAmount = getMaskedCategoryAmount(item.categoryId, permissions)
    if (maskedAmount === null) return item

    let toAmount = maskedAmount
    if (change) {
      try {
        toAmount = applyAmountChange(maskedAmount, change.mode, change.value)
      } catch {
        toAmount = maskedAmount
      }
    }

    return {
      ...item,
      fromAmount: maskedAmount,
      toAmount,
    }
  })
}
