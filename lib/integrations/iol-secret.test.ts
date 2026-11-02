import { describe, expect, it } from "vitest"
import {
  iolSecretHasPassword,
  stripIolPassword,
  toPersistedIolSecret,
} from "@/lib/integrations/iol-secret"

describe("iol secret persistence", () => {
  it("never persists password", () => {
    const persisted = toPersistedIolSecret({
      token: {
        access_token: "a",
        refresh_token: "r",
        token_type: "bearer",
        expires_in: 900,
      },
      baseUrl: "https://api.example",
      username: "user1",
      previous: { password: "should-not-leak", username: "old" },
    })

    expect(persisted.password).toBeUndefined()
    expect(persisted.username).toBe("user1")
    expect(persisted.access_token).toBe("a")
    expect(persisted.refresh_token).toBe("r")
  })

  it("strips legacy password fields", () => {
    const stripped = stripIolPassword({
      access_token: "a",
      refresh_token: "r",
      token_type: "bearer",
      expires_in: 1,
      obtained_at: "t",
      base_url: "u",
      username: "x",
      password: "secret",
    })

    expect(stripped.password).toBeUndefined()
    expect(iolSecretHasPassword({ password: "secret" })).toBe(true)
    expect(iolSecretHasPassword(stripped)).toBe(false)
  })
})
