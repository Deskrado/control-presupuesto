/**
 * Returns a safe same-origin relative path for post-auth redirects.
 * Rejects absolute URLs, protocol-relative URLs, and backslash tricks.
 */
export function getSafeRedirectPath(
  next: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (!next) return fallback

  const trimmed = next.trim()
  if (!trimmed.startsWith("/")) return fallback
  if (trimmed.startsWith("//")) return fallback
  if (trimmed.includes("://")) return fallback
  if (trimmed.includes("\\")) return fallback
  if (/[\x00-\x1f]/.test(trimmed)) return fallback

  return trimmed
}
