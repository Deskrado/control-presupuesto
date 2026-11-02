import { NextRequest, NextResponse } from "next/server"
import { findAuthUserByEmail } from "@/lib/auth/find-user-by-email"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { ALL_FAMILY_MODULE_IDS } from "@/lib/family-visibility"

const DEFAULT_MEMBER_MODULES = ALL_FAMILY_MODULE_IDS.filter((moduleId) => moduleId !== "settings")

type FamilyRole = "owner" | "admin" | "member" | "viewer"

async function getManagerMembership(familyId: string, userId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("family_members")
    .select("id, role")
    .eq("family_id", familyId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .in("role", ["owner", "admin"])
    .maybeSingle()

  if (error) throw error
  return data as { id: string; role: FamilyRole } | null
}

async function canManageFamily(familyId: string, userId: string) {
  return Boolean(await getManagerMembership(familyId, userId))
}

function normalizeRole(value: unknown): Exclude<FamilyRole, "owner"> {
  return ["admin", "member", "viewer"].includes(String(value))
    ? String(value) as Exclude<FamilyRole, "owner">
    : "member"
}

function modulesForRole(role: Exclude<FamilyRole, "owner">, currentModules?: string[] | null) {
  const modules = currentModules?.length ? currentModules : role === "admin" ? ALL_FAMILY_MODULE_IDS : DEFAULT_MEMBER_MODULES
  if (role === "admin") return Array.from(new Set([...modules, "settings"]))
  return modules.filter((moduleId) => moduleId !== "settings")
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const familyId = String(body.familyId || "")
    const email = String(body.email || "").trim().toLowerCase()
    const fullName = String(body.fullName || "").trim()
    const password = String(body.password || "")
    const role = normalizeRole(body.role)
    const cloneFromMemberId = String(body.cloneFromMemberId || "")

    if (!familyId) return NextResponse.json({ error: "familyId requerido" }, { status: 400 })
    if (!email || !email.includes("@")) return NextResponse.json({ error: "Email inválido" }, { status: 400 })
    if (password && password.length < 6) return NextResponse.json({ error: "La contraseña debe tener al menos 6 caracteres" }, { status: 400 })
    if (!(await canManageFamily(familyId, user.id))) {
      return NextResponse.json({ error: "No tenés permisos para administrar este hogar" }, { status: 403 })
    }

    let clonedPermissions: {
      allowed_modules: string[] | null
      visible_category_ids: string[] | null
      masked_category_amounts: Record<string, unknown> | null
      show_investments: boolean | null
    } | null = null

    if (cloneFromMemberId) {
      const { data: sourceMember, error: sourceMemberError } = await supabase
        .from("family_members")
        .select("id, family_id, is_active")
        .eq("id", cloneFromMemberId)
        .eq("family_id", familyId)
        .eq("is_active", true)
        .maybeSingle()

      if (sourceMemberError) throw sourceMemberError
      if (!sourceMember) return NextResponse.json({ error: "El miembro a copiar no pertenece a este hogar" }, { status: 400 })

      const { data: sourcePermissions, error: sourcePermissionsError } = await supabase
        .from("family_member_permissions")
        .select("allowed_modules, visible_category_ids, masked_category_amounts, show_investments")
        .eq("family_member_id", cloneFromMemberId)
        .maybeSingle()

      if (sourcePermissionsError) throw sourcePermissionsError
      clonedPermissions = sourcePermissions || null
    }

    // Service role only for Auth user lookup/create + profile bootstrap of the invitee.
    const admin = createAdminClient()
    let targetUser = await findAuthUserByEmail(email)
    if (!targetUser) {
      if (!password) {
        return NextResponse.json({ error: "Ingresá una contraseña inicial para registrar el usuario" }, { status: 400 })
      }

      const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: fullName ? { full_name: fullName } : undefined,
      })
      if (createError) throw createError
      targetUser = createdUser.user
    }

    const displayName = fullName || (typeof targetUser.user_metadata?.full_name === "string"
      ? targetUser.user_metadata.full_name
      : null)

    const { error: profileError } = await admin
      .from("profiles")
      .upsert({
        id: targetUser.id,
        full_name: displayName,
        locale: "es-AR",
        updated_at: new Date().toISOString(),
      })

    if (profileError) throw profileError

    const { data: member, error: memberError } = await supabase
      .from("family_members")
      .upsert({
        family_id: familyId,
        user_id: targetUser.id,
        role,
        email,
        display_name: displayName,
        is_active: true,
      }, { onConflict: "family_id,user_id" })
      .select("*")
      .single()

    if (memberError) throw memberError

    const allowedModules = clonedPermissions
      ? modulesForRole(role, clonedPermissions.allowed_modules)
      : role === "admin" ? ALL_FAMILY_MODULE_IDS : DEFAULT_MEMBER_MODULES

    const { error: permissionsError } = await supabase
      .from("family_member_permissions")
      .upsert({
        family_id: familyId,
        family_member_id: member.id,
        user_id: targetUser.id,
        allowed_modules: allowedModules,
        visible_category_ids: clonedPermissions?.visible_category_ids ?? null,
        masked_category_amounts: clonedPermissions?.masked_category_amounts ?? {},
        show_investments: clonedPermissions?.show_investments ?? true,
        created_by: user.id,
      }, { onConflict: "family_member_id" })

    if (permissionsError) throw permissionsError

    return NextResponse.json({ ok: true, member })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al agregar miembro" },
      { status: 500 },
    )
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const memberId = String(body.memberId || "")
    const displayName = String(body.displayName || "").trim()
    const email = String(body.email || "").trim().toLowerCase()
    const role = normalizeRole(body.role)

    if (!memberId) return NextResponse.json({ error: "memberId requerido" }, { status: 400 })
    if (email && !email.includes("@")) return NextResponse.json({ error: "Email inválido" }, { status: 400 })

    const { data: targetMember, error: memberError } = await supabase
      .from("family_members")
      .select("*")
      .eq("id", memberId)
      .maybeSingle()

    if (memberError) throw memberError
    if (!targetMember) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 })

    const manager = await getManagerMembership(targetMember.family_id, user.id)
    if (!manager) return NextResponse.json({ error: "No tenés permisos para administrar este hogar" }, { status: 403 })
    if (targetMember.role === "owner") return NextResponse.json({ error: "No se puede editar al propietario desde esta pantalla" }, { status: 400 })
    if (targetMember.user_id === user.id && role !== targetMember.role) {
      return NextResponse.json({ error: "No podés cambiar tu propio rol" }, { status: 400 })
    }
    if (manager.role !== "owner" && targetMember.role === "admin" && role !== targetMember.role) {
      return NextResponse.json({ error: "Solo el propietario puede cambiar el rol de otro admin" }, { status: 403 })
    }

    const { data: updatedMember, error: updateError } = await supabase
      .from("family_members")
      .update({
        display_name: displayName || null,
        email: email || null,
        role,
        is_active: true,
      })
      .eq("id", memberId)
      .select("*")
      .single()

    if (updateError) throw updateError

    const admin = createAdminClient()
    if (displayName) {
      const { error: profileError } = await admin
        .from("profiles")
        .upsert({
          id: targetMember.user_id,
          full_name: displayName,
          locale: "es-AR",
          updated_at: new Date().toISOString(),
        })
      if (profileError) throw profileError
    }

    const { data: permissions } = await supabase
      .from("family_member_permissions")
      .select("allowed_modules")
      .eq("family_member_id", memberId)
      .maybeSingle()

    const { error: permissionsError } = await supabase
      .from("family_member_permissions")
      .upsert({
        family_id: targetMember.family_id,
        family_member_id: memberId,
        user_id: targetMember.user_id,
        allowed_modules: modulesForRole(role, permissions?.allowed_modules),
        created_by: user.id,
      }, { onConflict: "family_member_id" })

    if (permissionsError) throw permissionsError

    return NextResponse.json({ ok: true, member: updatedMember })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al editar miembro" },
      { status: 500 },
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const memberId = String(body.memberId || "")
    if (!memberId) return NextResponse.json({ error: "memberId requerido" }, { status: 400 })

    const { data: targetMember, error: memberError } = await supabase
      .from("family_members")
      .select("*")
      .eq("id", memberId)
      .maybeSingle()

    if (memberError) throw memberError
    if (!targetMember) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 })

    const manager = await getManagerMembership(targetMember.family_id, user.id)
    if (!manager) return NextResponse.json({ error: "No tenés permisos para administrar este hogar" }, { status: 403 })
    if (targetMember.user_id === user.id) return NextResponse.json({ error: "No podés quitarte a vos mismo del hogar" }, { status: 400 })
    if (targetMember.role === "owner") return NextResponse.json({ error: "No se puede quitar al propietario del hogar" }, { status: 400 })
    if (manager.role !== "owner" && targetMember.role === "admin") {
      return NextResponse.json({ error: "Solo el propietario puede quitar a otro admin" }, { status: 403 })
    }

    const { error: updateError } = await supabase
      .from("family_members")
      .update({ is_active: false })
      .eq("id", memberId)

    if (updateError) throw updateError

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al quitar miembro" },
      { status: 500 },
    )
  }
}

