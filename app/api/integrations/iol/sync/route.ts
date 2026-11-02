import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { decryptJson, encryptJson } from "@/lib/integrations/crypto"
import { iolSecretHasPassword, stripIolPassword, toPersistedIolSecret } from "@/lib/integrations/iol-secret"
import {
  fetchIolReadOnlyData,
  IolSecret,
  parseIolPositions,
  refreshIolToken,
} from "@/lib/integrations/providers/iol"

async function getCurrencyId(admin: ReturnType<typeof createAdminClient>, code: string) {
  const normalized = code.toUpperCase() === "US$" ? "USD" : code.toUpperCase()
  const { data } = await admin.from("currencies").select("id").eq("code", normalized).maybeSingle()
  return data?.id || null
}

function getAccessTokenExpiresAt(expiresIn: number | undefined) {
  return new Date(Date.now() + Number(expiresIn || 900) * 1000).toISOString()
}

async function persistIolSecret(input: {
  admin: ReturnType<typeof createAdminClient>
  secretId: string
  connectionId: string
  currentSecret: IolSecret
  token: Pick<IolSecret, "access_token" | "refresh_token" | "token_type" | "expires_in">
}) {
  const nextSecret = toPersistedIolSecret({
    token: input.token,
    baseUrl: input.currentSecret.base_url,
    username: input.currentSecret.username,
    previous: stripIolPassword(input.currentSecret),
  })

  await input.admin.from("integration_secrets").update(encryptJson(nextSecret)).eq("id", input.secretId)
  await input.admin
    .from("broker_connections")
    .update({
      access_token_expires_at: getAccessTokenExpiresAt(input.token.expires_in),
      status: "active",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.connectionId)

  return nextSecret
}

async function refreshIolOrRequireReauth(input: {
  admin: ReturnType<typeof createAdminClient>
  secretId: string
  connectionId: string
  secret: IolSecret
}) {
  // If a legacy ciphertext still contains a password, drop it on the next successful rewrite.
  const sanitized = stripIolPassword(input.secret)
  if (iolSecretHasPassword(input.secret)) {
    await input.admin.from("integration_secrets").update(encryptJson(sanitized)).eq("id", input.secretId)
  }

  const refreshed = await refreshIolToken({
    refreshToken: sanitized.refresh_token,
    baseUrl: sanitized.base_url,
  })
  return persistIolSecret({
    admin: input.admin,
    secretId: input.secretId,
    connectionId: input.connectionId,
    currentSecret: sanitized,
    token: refreshed,
  })
}

export async function POST(request: NextRequest) {
  let admin: ReturnType<typeof createAdminClient> | null = null
  let connectionIdForError: string | null = null
  let userIdForError: string | null = null
  let syncMode: "auto" | "manual" = "manual"

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })
    userIdForError = user.id

    const body = await request.json()
    const { connectionId } = body
    syncMode = body.mode === "auto" ? "auto" : "manual"
    if (!connectionId) return NextResponse.json({ error: "connectionId requerido" }, { status: 400 })
    connectionIdForError = connectionId

    admin = createAdminClient()
    const { data: connection, error: connectionError } = await admin
      .from("broker_connections")
      .select("*, provider:external_providers(*), secret:integration_secrets(*)")
      .eq("id", connectionId)
      .eq("user_id", user.id)
      .single()

    if (connectionError) throw connectionError
    if (!connection.secret) throw new Error("La conexion no tiene secreto activo")

    let secret = decryptJson<IolSecret>(connection.secret)
    const expiresAt = connection.access_token_expires_at ? new Date(connection.access_token_expires_at).getTime() : 0
    const shouldRefreshBeforeSync = syncMode === "manual" || !expiresAt || expiresAt - Date.now() < 2 * 60_000
    if (shouldRefreshBeforeSync) {
      try {
        secret = await refreshIolOrRequireReauth({
          admin,
          secretId: connection.secret.id,
          connectionId: connection.id,
          secret,
        })
      } catch (refreshError) {
        const refreshMessage = refreshError instanceof Error ? refreshError.message : "IOL rechazó el refresh token"
        const accessTokenStillUsable = expiresAt - Date.now() > 30_000

        if (!accessTokenStillUsable && syncMode === "auto") {
          await admin
            .from("broker_connections")
            .update({
              last_error: "IOL no se actualizó automáticamente para evitar pedir reconexión en cada carga",
              updated_at: new Date().toISOString(),
            })
            .eq("id", connection.id)

          await admin.from("integration_audit_events").insert({
            user_id: user.id,
            connection_id: connection.id,
            event_type: "iol_sync",
            status: "skipped",
            message: refreshMessage,
          })

          return NextResponse.json(
            {
              ok: false,
              skipped: true,
              code: "IOL_AUTO_REFRESH_SKIPPED",
              error: "IOL no se actualizó automáticamente. Se muestra la última cartera guardada.",
            },
            { status: 202 },
          )
        }

        if (!accessTokenStillUsable) {
          throw refreshError
        }

        await admin
          .from("broker_connections")
          .update({
            last_error: "IOL rechazó el refresh, se usó el access token vigente",
            updated_at: new Date().toISOString(),
          })
          .eq("id", connection.id)
      }
    }

    let raw = await fetchIolReadOnlyData(secret.base_url, secret.access_token)
    const hasUnauthorizedRead = Object.values(raw).some(
      (value) => typeof value === "string" && value.includes("respondio 401"),
    )
    if (hasUnauthorizedRead) {
      secret = await refreshIolOrRequireReauth({
        admin,
        secretId: connection.secret.id,
        connectionId: connection.id,
        secret,
      })
      raw = await fetchIolReadOnlyData(secret.base_url, secret.access_token)
    }
    const rawHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex")
    const positions = parseIolPositions(raw)
    const arsCurrencyId = await getCurrencyId(admin, "ARS")

    const { data: account, error: accountError } = await admin
      .from("broker_accounts")
      .upsert({
        user_id: user.id,
        connection_id: connection.id,
        external_account_id: "iol-default",
        name: "IOL Argentina",
        base_currency_id: arsCurrencyId,
        status: "active",
        metadata: { source: "iol" },
      }, { onConflict: "connection_id,external_account_id" })
      .select("*")
      .single()

    if (accountError) throw accountError

    const totalValue = positions.reduce((total, position) => total + Number(position.marketValue || 0), 0)
    const { data: snapshot, error: snapshotError } = await admin
      .from("portfolio_snapshots")
      .insert({
        user_id: user.id,
        connection_id: connection.id,
        account_id: account.id,
        total_value: totalValue,
        currency_id: arsCurrencyId,
        source: "iol",
        raw_hash: rawHash,
        raw,
      })
      .select("*")
      .single()

    if (snapshotError) throw snapshotError

    await admin.from("broker_positions").delete().eq("account_id", account.id)

    for (const position of positions) {
      const currencyId = await getCurrencyId(admin, position.currencyCode)
      const { data: instrument } = await admin
        .from("market_instruments")
        .upsert({
          provider_id: connection.provider_id,
          symbol: position.symbol,
          market: position.market,
          instrument_type: position.instrumentType,
          currency_id: currencyId,
          name: position.name,
          provider_symbol: position.symbol,
          metadata: { source: "iol" },
        }, { onConflict: "provider_id,symbol,market" })
        .select("*")
        .single()

      await admin.from("broker_positions").insert({
        user_id: user.id,
        account_id: account.id,
        instrument_id: instrument?.id || null,
        quantity: position.quantity,
        avg_cost: position.avgCost || null,
        currency_id: currencyId,
        market_value: position.marketValue,
        price: position.price,
        source: "iol",
        raw: position.raw,
      })

      await admin.from("portfolio_snapshot_items").insert({
        user_id: user.id,
        snapshot_id: snapshot.id,
        instrument_id: instrument?.id || null,
        quantity: position.quantity,
        price: position.price,
        market_value: position.marketValue,
        currency_id: currencyId,
        raw: position.raw,
      })
    }

    await admin
      .from("broker_connections")
      .update({ last_sync_at: new Date().toISOString(), status: "active", last_error: null })
      .eq("id", connection.id)

    await admin.from("integration_audit_events").insert({
      user_id: user.id,
      connection_id: connection.id,
      event_type: "iol_sync",
      status: "success",
      message: `Sincronizadas ${positions.length} posiciones read-only`,
      metadata: { positions: positions.length, rawHash },
    })

    return NextResponse.json({ ok: true, positions: positions.length, snapshotId: snapshot.id })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error al sincronizar IOL"
    const authRejected = message.includes("refresh token") || message.includes("(401)")
    const requiresReconnect = syncMode === "manual" && authRejected

    if (syncMode === "auto" && authRejected && admin && connectionIdForError) {
      await admin
        .from("broker_connections")
        .update({
          last_error: "IOL no se actualizó automáticamente para evitar pedir reconexión en cada carga",
          updated_at: new Date().toISOString(),
        })
        .eq("id", connectionIdForError)

      await admin.from("integration_audit_events").insert({
        user_id: userIdForError,
        connection_id: connectionIdForError,
        event_type: "iol_sync",
        status: "skipped",
        message,
      })

      return NextResponse.json(
        {
          ok: false,
          skipped: true,
          code: "IOL_AUTO_REFRESH_SKIPPED",
          error: "IOL no se actualizó automáticamente. Se muestra la última cartera guardada.",
        },
        { status: 202 },
      )
    }

    if (requiresReconnect && admin && connectionIdForError) {
      await admin
        .from("broker_connections")
        .update({
          status: "reauth_required",
          last_error: "IOL requiere reconectar la cuenta",
          updated_at: new Date().toISOString(),
        })
        .eq("id", connectionIdForError)

      await admin.from("integration_audit_events").insert({
        user_id: userIdForError,
        connection_id: connectionIdForError,
        event_type: "iol_sync",
        status: "reauth_required",
        message: "IOL rechazó el refresh token. Reconecta la cuenta desde Configuración.",
      })
    }

    return NextResponse.json(
      {
        error: requiresReconnect
          ? "IOL requiere reconectar la cuenta desde Configuración > Integraciones"
          : message,
        code: requiresReconnect ? "IOL_REAUTH_REQUIRED" : "IOL_SYNC_ERROR",
      },
      { status: requiresReconnect ? 409 : 500 },
    )
  }
}
