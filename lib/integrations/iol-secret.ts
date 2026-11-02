import type { IolSecret, IolTokenResponse } from "@/lib/integrations/providers/iol"

/** Persist only tokens + non-secret metadata. Never store IOL password. */
export function toPersistedIolSecret(input: {
  token: IolTokenResponse
  baseUrl: string
  username?: string | null
  previous?: Partial<IolSecret> | null
}): IolSecret {
  return {
    access_token: input.token.access_token,
    refresh_token: input.token.refresh_token,
    token_type: input.token.token_type,
    expires_in: input.token.expires_in,
    obtained_at: new Date().toISOString(),
    base_url: input.baseUrl,
    // Username is useful for display/reconnect UX; password must never be stored.
    username: input.username || input.previous?.username || undefined,
  }
}

export function stripIolPassword<T extends Partial<IolSecret>>(secret: T): T {
  if (!secret || typeof secret !== "object") return secret
  const { password: _password, ...rest } = secret as T & { password?: string }
  return rest as T
}

export function iolSecretHasPassword(secret: Partial<IolSecret> | null | undefined): boolean {
  return Boolean(secret && typeof secret.password === "string" && secret.password.length > 0)
}
