import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { assertBrokerConnectionOwner } from "@/lib/supabase/admin-guards"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const { connectionId } = await request.json()
    if (!connectionId) return NextResponse.json({ error: "connectionId requerido" }, { status: 400 })

    const admin = createAdminClient()
    const connection = await assertBrokerConnectionOwner(admin, connectionId, user.id)

    const { error } = await admin
      .from("broker_connections")
      .update({ status: "disabled", secret_id: null, updated_at: new Date().toISOString() })
      .eq("id", connection.id)
      .eq("user_id", user.id)

    if (error) throw error
    if (connection.secret_id) {
      await admin.from("integration_secrets").delete().eq("id", connection.secret_id)
    }

    await admin.from("integration_audit_events").insert({
      user_id: user.id,
      connection_id: connection.id,
      event_type: "iol_disconnect",
      status: "success",
      message: "Conexion IOL deshabilitada",
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al desconectar IOL" },
      { status: 500 },
    )
  }
}
