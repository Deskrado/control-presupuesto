type IolTokenResponse = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

export type IolSecret = IolTokenResponse & {
  obtained_at: string
  base_url: string
  /** Non-secret account label for reconnect UX. Never persist password. */
  username?: string
  /**
   * @deprecated Legacy field. Passwords must not be persisted; ignored if present
   * in historical ciphertext and stripped on next secret rewrite.
   */
  password?: string
}

export async function loginToIol(input: {
  username: string
  password: string
  baseUrl: string
}) {
  const body = new URLSearchParams({
    username: input.username,
    password: input.password,
    grant_type: "password",
  })

  const response = await fetch(`${input.baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Error(`IOL rechazó el login (${response.status})`)
  }

  return response.json() as Promise<IolTokenResponse>
}

export async function refreshIolToken(input: {
  refreshToken: string
  baseUrl: string
}) {
  const body = new URLSearchParams({
    refresh_token: input.refreshToken,
    grant_type: "refresh_token",
  })

  const response = await fetch(`${input.baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Error(`IOL rechazó el refresh token (${response.status})`)
  }

  return response.json() as Promise<IolTokenResponse>
}

export async function getIolJson<T>(baseUrl: string, accessToken: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Error(`IOL ${path} respondio ${response.status}`)
  }

  return response.json() as Promise<T>
}

export async function fetchIolReadOnlyData(baseUrl: string, accessToken: string) {
  const results: Record<string, unknown> = {}

  const endpoints = [
    ["accountStatus", "/api/v2/estadocuenta"],
    ["portfolioArgentina", "/api/v2/portafolio/Argentina"],
    ["portfolioLegacy", "/api/micuenta/miportafolio"],
  ] as const

  for (const [key, path] of endpoints) {
    try {
      results[key] = await getIolJson(baseUrl, accessToken, path)
    } catch (error) {
      results[`${key}Error`] = error instanceof Error ? error.message : "Error desconocido"
    }
  }

  return results
}

function findArrays(value: unknown): unknown[][] {
  if (Array.isArray(value)) return [value, ...value.flatMap(findArrays)]
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(findArrays)
  }
  return []
}

function readObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readNumber(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue
    if (typeof value === "number") return Number.isFinite(value) ? value : 0
    const compact = String(value).replace(/\s/g, "")
    const normalized = compact.includes(",")
      ? compact.replace(/\./g, "").replace(",", ".")
      : compact
    const parsed = Number(normalized)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function normalizeCurrency(value: unknown) {
  const raw = String(value || "ARS").toUpperCase()
  if (raw === "US$" || raw.includes("USD") || raw.includes("DOLAR")) return "USD"
  if (raw.includes("PESO") || raw.includes("ARS")) return "ARS"
  return raw
}

function normalizeInstrumentType(value: unknown) {
  const raw = String(value || "other").toLowerCase()
  if (raw.includes("accion")) return "acciones"
  if (raw.includes("bono")) return "bonos"
  if (raw.includes("titulo")) return "bonos"
  if (raw.includes("cedear")) return "cedear"
  if (raw.includes("fondo") || raw.includes("fci")) return "fci"
  return raw || "other"
}

function getPreferredPositionArray(raw: Record<string, unknown>) {
  const portfolioArgentina = readObject(raw.portfolioArgentina)
  const portfolioLegacy = readObject(raw.portfolioLegacy)
  const preferred = [
    portfolioArgentina.activos,
    portfolioArgentina.titulos,
    portfolioArgentina.tenencias,
    portfolioLegacy.activos,
    portfolioLegacy.titulos,
    portfolioLegacy.tenencias,
  ]

  for (const value of preferred) {
    if (Array.isArray(value) && value.length > 0) return value
  }

  return findArrays(raw)
    .filter((items) => items.length > 0 && items.every((item) => item && typeof item === "object"))
    .sort((a, b) => {
      const score = (items: unknown[]) => {
        const first = readObject(items[0])
        const title = readObject(first.titulo)
        const keys = new Set([...Object.keys(first), ...Object.keys(title)])
        let total = 0
        for (const key of ["simbolo", "descripcion", "cantidad", "valorizado", "ultimoPrecio", "titulo"]) {
          if (keys.has(key)) total += 10
        }
        return total + items.length
      }
      return score(b) - score(a)
    })[0] || []
}

export function parseIolPositions(raw: Record<string, unknown>) {
  const source = getPreferredPositionArray(raw)

  return source.map((item) => {
    const row = item as Record<string, unknown>
    const title = readObject(row.titulo)
    const symbol = String(title.simbolo || row.simbolo || row.ticker || row.symbol || "").trim()
    const name = String(title.descripcion || row.descripcion || row.nombre || symbol).trim()
    const quantity = readNumber(row.cantidad, row.nominales, row.quantity, row.tenencia)
    const avgCost = readNumber(row.ppc, row.precioPromedio, row.avgCost, row.costoPromedio)
    const price = readNumber(row.ultimoPrecio, row.cotizacion, row.precio, row.lastPrice, row.price)
    const marketValue = readNumber(row.valorizado, row.valuacion, row.marketValue, row.valorActual, quantity * price)
    const currencyCode = normalizeCurrency(title.moneda || row.moneda || row.currency)

    return {
      symbol: symbol || name || "SIN-TICKER",
      name: name || symbol || "Sin descripción",
      market: String(title.mercado || row.mercado || row.market || "IOL"),
      instrumentType: normalizeInstrumentType(title.tipo || row.tipo || row.type),
      quantity,
      avgCost,
      price,
      marketValue,
      currencyCode,
      raw: row,
    }
  }).filter((position) => position.symbol !== "SIN-TICKER" || position.quantity !== 0 || position.marketValue !== 0)
}
