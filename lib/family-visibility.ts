import type { Category, FamilyMember, FamilyMemberPermissions, Transaction } from "@/lib/types"

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

  // Align with RLS: masked categories are not readable by the restricted member.
  if (getMaskedCategoryAmount(category.id, permissions) !== null) return false

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

  const visibleCategoryIds = permissions?.visible_category_ids
  const shouldFilterCategories = Array.isArray(visibleCategoryIds)
  const hasMaskedCategories = Boolean(
    permissions?.masked_category_amounts
    && Object.keys(permissions.masked_category_amounts).length > 0,
  )

  return transactions
    .filter((transaction) => {
      if (!transaction.category_id) return true
      if (getMaskedCategoryAmount(transaction.category_id, permissions) !== null) return false
      if (!shouldFilterCategories && !hasMaskedCategories) return true
      if (!shouldFilterCategories) return true
      return isCategoryVisibleForMember(
        transaction.category || { id: transaction.category_id, created_at: "" },
        permissions,
      )
    })
}
