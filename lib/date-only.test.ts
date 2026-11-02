import { describe, expect, it } from "vitest"
import { getMonthBounds, toLocalDateOnly } from "@/lib/date-only"

describe("toLocalDateOnly", () => {
  it("usa getFullYear/getMonth/getDate locales, no el slice ISO-UTC", () => {
    // Local calendar constructor: 2 Nov 2026 22:30 in the VM's local zone.
    const localEvening = new Date(2026, 10, 2, 22, 30, 0)
    expect(toLocalDateOnly(localEvening)).toBe("2026-11-02")

    // The historical bug: ISO date can already be the next UTC day while local is still the 2nd.
    if (localEvening.getTimezoneOffset() > 0) {
      expect(localEvening.toISOString().split("T")[0]).not.toBe("2026-11-02")
    }
  })
})

describe("getMonthBounds", () => {
  it("devuelve extremos date-only del mes", () => {
    expect(getMonthBounds(2026, 11)).toEqual({
      start: "2026-11-01",
      end: "2026-11-30",
    })
  })
})
