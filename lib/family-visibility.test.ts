import { describe, expect, it } from "vitest"
import {
  applyTransactionVisibility,
  canApplyFamilyRestrictions,
  canSeeModule,
  isCategoryVisibleForMember,
  visibleCategoryIdsForEditor,
} from "@/lib/family-visibility"
import type { FamilyMember, FamilyMemberPermissions, Transaction } from "@/lib/types"

const member: FamilyMember = {
  id: "m1",
  family_id: "f1",
  user_id: "u1",
  role: "viewer",
  is_active: true,
  joined_at: "2026-01-01T00:00:00Z",
}

const admin: FamilyMember = {
  ...member,
  id: "m-admin",
  role: "admin",
}

const owner: FamilyMember = {
  ...member,
  id: "m-owner",
  role: "owner",
}

const permissions: FamilyMemberPermissions = {
  id: "p1",
  family_id: "f1",
  family_member_id: "m1",
  user_id: "u1",
  allowed_modules: ["dashboard", "transactions"],
  visible_category_ids: ["cat-visible", "cat-masked"],
  masked_category_amounts: { "cat-masked": 10 },
  show_investments: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}

function tx(partial: Partial<Transaction> & Pick<Transaction, "id" | "category_id" | "amount">): Transaction {
  return {
    user_id: "owner",
    family_id: "f1",
    type: "expense",
    status: "approved",
    currency_id: "ars",
    transaction_date: "2026-01-15",
    created_at: "2026-01-15T00:00:00Z",
    updated_at: "2026-01-15T00:00:00Z",
    ...partial,
  } as Transaction
}

describe("family visibility (server-aligned)", () => {
  it("hides modules not allowed or investments when disabled", () => {
    expect(canSeeModule("transactions", member, permissions)).toBe(true)
    expect(canSeeModule("credit_cards", member, permissions)).toBe(false)
    expect(canSeeModule("investments", member, permissions)).toBe(false)
    expect(canSeeModule("settings", member, permissions)).toBe(false)
  })

  it("does not apply restrictions to owners or admins", () => {
    expect(canApplyFamilyRestrictions(owner, permissions)).toBe(false)
    expect(canApplyFamilyRestrictions(admin, permissions)).toBe(false)
    expect(canApplyFamilyRestrictions(member, permissions)).toBe(true)
    expect(canSeeModule("credit_cards", admin, permissions)).toBe(true)
    expect(canSeeModule("settings", admin, permissions)).toBe(true)
  })

  it("hides invisible and masked categories", () => {
    expect(isCategoryVisibleForMember({ id: "cat-visible", created_at: "2026-01-01T00:00:00Z" }, permissions)).toBe(true)
    expect(isCategoryVisibleForMember({ id: "cat-hidden", created_at: "2026-01-01T00:00:00Z" }, permissions)).toBe(false)
    expect(isCategoryVisibleForMember({ id: "cat-masked", created_at: "2026-01-01T00:00:00Z" }, permissions)).toBe(false)
  })

  it("preserves masked ids when hydrating the settings visibility editor", () => {
    const categories = [
      { id: "cat-visible" },
      { id: "cat-masked" },
      { id: "cat-other" },
    ]

    expect(visibleCategoryIdsForEditor(permissions.visible_category_ids, categories)).toEqual([
      "cat-visible",
      "cat-masked",
    ])
    expect(visibleCategoryIdsForEditor(null, categories)).toBeNull()
    expect(visibleCategoryIdsForEditor(["cat-visible", "cat-gone"], categories)).toEqual(["cat-visible"])
  })

  it("filters transactions for restricted members", () => {
    const rows = applyTransactionVisibility(
      [
        tx({ id: "1", category_id: "cat-visible", amount: 100 }),
        tx({ id: "2", category_id: "cat-hidden", amount: 200 }),
        tx({ id: "3", category_id: "cat-masked", amount: 300 }),
        tx({ id: "4", category_id: null, amount: 50 }),
      ],
      member,
      permissions,
    )

    expect(rows.map((row) => row.id)).toEqual(["1", "4"])
  })
})
