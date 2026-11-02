import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Narrow helpers around service-role usage. Callers must still authenticate the
 * end user first; these asserts prevent accidental cross-user access.
 */
export async function assertBrokerConnectionOwner(
  admin: SupabaseClient,
  connectionId: string,
  userId: string,
) {
  const { data, error } = await admin
    .from("broker_connections")
    .select("id, user_id, secret_id, provider_id, environment, status, external_account_hash, access_token_expires_at, display_name")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle()

  if (error) throw error
  if (!data) {
    const ownershipError = new Error("Conexión no encontrada o sin permiso")
    ;(ownershipError as Error & { status: number }).status = 404
    throw ownershipError
  }

  return data
}

export function requireCronSecret(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  const authHeader = request.headers.get("authorization")
  return authHeader === `Bearer ${cronSecret}`
}
