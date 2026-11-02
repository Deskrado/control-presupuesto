import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireCronSecret } from "@/lib/supabase/admin-guards"
import { fetchDolarApiQuotes } from "@/lib/integrations/fx/dolarapi"

/**
 * FX sync writes market data with the service role. Restrict to cron credentials
 * so any authenticated session cannot trigger privileged upserts.
 */
function isAllowed(request: NextRequest) {
  if (requireCronSecret(request)) return true

  // Local/dev convenience only when CRON_SECRET is intentionally unset.
  if (!process.env.CRON_SECRET && process.env.NODE_ENV !== "production") {
    return true
  }

  return false
}

export async function POST(request: NextRequest) {
  try {
    if (!isAllowed(request)) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 })
    }

    const admin = createAdminClient()
    const [quotes, currencies] = await Promise.all([
      fetchDolarApiQuotes(),
      admin.from("currencies").select("*").in("code", ["USD", "ARS"]),
    ])

    if (currencies.error) throw currencies.error
    const usd = currencies.data.find((currency) => currency.code === "USD")
    const ars = currencies.data.find((currency) => currency.code === "ARS")
    if (!usd || !ars) throw new Error("Faltan monedas USD/ARS")

    for (const quote of quotes) {
      const observedAt = quote.fechaActualizacion ? new Date(quote.fechaActualizacion).toISOString() : new Date().toISOString()
      await admin.from("fx_quotes").upsert({
        base_currency_id: usd.id,
        quote_currency_id: ars.id,
        rate_type: quote.casa,
        bid: quote.compra || null,
        ask: quote.venta || null,
        mid: quote.compra && quote.venta ? (Number(quote.compra) + Number(quote.venta)) / 2 : quote.venta || quote.compra || null,
        source: "dolarapi",
        observed_at: observedAt,
        valid_on: observedAt.slice(0, 10),
        raw: quote,
      }, { onConflict: "source,rate_type,observed_at" })
    }

    return NextResponse.json({ ok: true, quotes: quotes.length })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al sincronizar FX" },
      { status: 500 },
    )
  }
}
