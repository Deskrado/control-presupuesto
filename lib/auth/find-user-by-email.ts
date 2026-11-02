import type { User } from "@supabase/supabase-js"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Looks up a single Auth user by email without enumerating the user directory.
 * Uses a security-definer SQL helper (service role) over auth.users.
 */
export async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase()
  if (!normalized || !normalized.includes("@")) return null

  const admin = createAdminClient()
  const { data, error } = await admin.rpc("auth_user_id_by_email", {
    target_email: normalized,
  })

  if (error) throw error
  return typeof data === "string" && data.length > 0 ? data : null
}

export async function findAuthUserByEmail(email: string): Promise<User | null> {
  const userId = await findAuthUserIdByEmail(email)
  if (!userId) return null

  const admin = createAdminClient()
  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error) throw error
  return data.user ?? null
}
