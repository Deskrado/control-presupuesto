import { NextRequest, NextResponse } from "next/server"
import { createHash } from "node:crypto"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { encryptJson } from "@/lib/integrations/crypto"
import { toPersistedIolSecret } from "@/lib/integrations/iol-secret"
import { loginToIol } from "@/lib/integrations/providers/iol"

function getIolAccountHash(username: string, environment: string) {
  return createHash("sha256")
    .update(`iol:${environment}:${username.trim().toLowerCase()}`)
    .digest("hex")
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const body = await request.json()
    const username = String(body.username || "")
    const password = String(body.password || "")
    const environment = body.environment === "production" ? "production" : "sandbox"
    const displayName = String(body.displayName || "IOL read-only")
    const reconnectConnectionId = body.connectionId ? String(body.connectionId) : null
    const externalAccountHash = getIolAccountHash(username, environment)

    if (!username || !password) {
      return NextResponse.json({ error: "Usuario y password de IOL son requeridos" }, { status: 400 })
    }

    const admin = createAdminClient()
    const { data: provider, error: providerError } = await admin
      .from("external_providers")
      .select("*")
      .eq("code", "iol")
      .single()

    if (providerError) throw providerError

    const baseUrl = environment === "sandbox"
      ? provider.sandbox_base_url || provider.base_url
      : provider.base_url

    const token = await loginToIol({ username, password, baseUrl })
    // Password is used only for this interactive login; persist tokens (+ username) only.
    const encrypted = encryptJson(toPersistedIolSecret({ token, baseUrl, username }))
    const expiresAt = new Date(Date.now() + Number(token.expires_in || 900) * 1000).toISOString()

    if (reconnectConnectionId) {
      const { data: existingConnection, error: existingConnectionError } = await admin
        .from("broker_connections")
        .select("*")
        .eq("id", reconnectConnectionId)
        .eq("user_id", user.id)
        .eq("provider_id", provider.id)
        .single()

      if (existingConnectionError) throw existingConnectionError

      let secretId = existingConnection.secret_id
      if (secretId) {
        const { error: secretUpdateError } = await admin
          .from("integration_secrets")
          .update(encrypted)
          .eq("id", secretId)

        if (secretUpdateError) throw secretUpdateError
      } else {
        const { data: secret, error: secretError } = await admin
          .from("integration_secrets")
          .insert({
            provider_code: "iol",
            ...encrypted,
          })
          .select("id")
          .single()

        if (secretError) throw secretError
        secretId = secret.id
      }

      await admin
        .from("broker_connections")
        .update({
          status: "disabled",
          last_error: "Duplicada por reconexión de la misma cuenta IOL",
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("provider_id", provider.id)
        .eq("environment", environment)
        .eq("external_account_hash", externalAccountHash)
        .neq("id", existingConnection.id)

      const { data: connection, error: connectionError } = await admin
        .from("broker_connections")
        .update({
          secret_id: secretId,
          display_name: displayName,
          environment,
          status: "active",
          external_account_hash: externalAccountHash,
          access_token_expires_at: expiresAt,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingConnection.id)
        .select("*, provider:external_providers(*)")
        .single()

      if (connectionError) throw connectionError

      await admin.from("integration_audit_events").insert({
        user_id: user.id,
        connection_id: connection.id,
        event_type: "iol_reconnect",
        status: "success",
        message: "Conexion IOL read-only reconectada",
      })

      return NextResponse.json({ connection })
    }

    const { data: existingConnection } = await admin
      .from("broker_connections")
      .select("*")
      .eq("user_id", user.id)
      .eq("provider_id", provider.id)
      .eq("environment", environment)
      .eq("external_account_hash", externalAccountHash)
      .neq("status", "disabled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingConnection) {
      let secretId = existingConnection.secret_id
      if (secretId) {
        const { error: secretUpdateError } = await admin
          .from("integration_secrets")
          .update(encrypted)
          .eq("id", secretId)

        if (secretUpdateError) throw secretUpdateError
      } else {
        const { data: secret, error: secretError } = await admin
          .from("integration_secrets")
          .insert({
            provider_code: "iol",
            ...encrypted,
          })
          .select("id")
          .single()

        if (secretError) throw secretError
        secretId = secret.id
      }

      const { data: connection, error: connectionError } = await admin
        .from("broker_connections")
        .update({
          secret_id: secretId,
          display_name: displayName,
          status: "active",
          access_token_expires_at: expiresAt,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingConnection.id)
        .select("*, provider:external_providers(*)")
        .single()

      if (connectionError) throw connectionError

      await admin.from("integration_audit_events").insert({
        user_id: user.id,
        connection_id: connection.id,
        event_type: "iol_reconnect",
        status: "success",
        message: "Conexion IOL read-only reutilizada",
      })

      return NextResponse.json({ connection })
    }

    const { data: secret, error: secretError } = await admin
      .from("integration_secrets")
      .insert({
        provider_code: "iol",
        ...encrypted,
      })
      .select("id")
      .single()

    if (secretError) throw secretError

    const { data: connection, error: connectionError } = await admin
      .from("broker_connections")
      .insert({
        user_id: user.id,
        provider_id: provider.id,
        secret_id: secret.id,
        display_name: displayName,
        environment,
        status: "active",
        external_account_hash: externalAccountHash,
        access_token_expires_at: expiresAt,
        metadata: { mode: "read_only" },
      })
      .select("*, provider:external_providers(*)")
      .single()

    if (connectionError) throw connectionError

    await admin.from("integration_audit_events").insert({
      user_id: user.id,
      connection_id: connection.id,
      event_type: "iol_connect",
      status: "success",
      message: "Conexion IOL read-only creada",
    })

    return NextResponse.json({ connection })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al conectar IOL" },
      { status: 500 },
    )
  }
}
