import { describe, expect, it } from "vitest"
import { getSafeRedirectPath } from "@/lib/auth/safe-redirect"

describe("getSafeRedirectPath", () => {
  it("defaults to dashboard", () => {
    expect(getSafeRedirectPath(null)).toBe("/dashboard")
    expect(getSafeRedirectPath(undefined)).toBe("/dashboard")
    expect(getSafeRedirectPath("")).toBe("/dashboard")
  })

  it("allows relative app paths", () => {
    expect(getSafeRedirectPath("/dashboard/settings")).toBe("/dashboard/settings")
    expect(getSafeRedirectPath("/auth/login?x=1")).toBe("/auth/login?x=1")
  })

  it("rejects open redirects", () => {
    expect(getSafeRedirectPath("//evil.example")).toBe("/dashboard")
    expect(getSafeRedirectPath("https://evil.example")).toBe("/dashboard")
    expect(getSafeRedirectPath("http://evil.example/phish")).toBe("/dashboard")
    expect(getSafeRedirectPath("/\\evil.example")).toBe("/dashboard")
    expect(getSafeRedirectPath("dashboard")).toBe("/dashboard")
    expect(getSafeRedirectPath("://evil.example")).toBe("/dashboard")
  })

  it("supports custom fallback", () => {
    expect(getSafeRedirectPath("//evil", "/auth/login")).toBe("/auth/login")
  })
})
