"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { useCategories, useCurrencies, useUserSettings } from "@/components/dashboard/use-dashboard-data"
import { PortfolioIntegrations } from "@/components/investments/portfolio-integrations"
import type { FamilyMember, FamilyMemberPermissions, Profile } from "@/lib/types"
import { ALL_FAMILY_MODULE_IDS, FAMILY_MODULES, visibleCategoryIdsForEditor } from "@/lib/family-visibility"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, Pencil, RefreshCw, Save, Trash2, X } from "lucide-react"
import { invalidateCache, invalidateCacheByPrefix } from "@/lib/swr-cache"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

type SettingsForm = {
  default_currency_id: string
  initial_balance: string
  monthly_savings_target: string
  annual_savings_target: string
  default_payment_method: string
  default_transaction_type: "expense" | "income"
  dashboard_months_ahead: string
  week_starts_on: string
  date_format: string
  number_format: string
  compact_mode: boolean
  show_archived: boolean
  notify_card_due_days: string
  notify_budget_threshold: string
  auto_create_card_transactions: boolean
}

type ProfileForm = {
  full_name: string
  phone: string
  locale: string
}

type FamilyForm = {
  id: string
  name: string
  description: string
  default_currency_id: string
  timezone: string
  month_start_day: string
}

type PermissionsForm = {
  allowed_modules: string[]
  visible_category_ids: string[] | null
  masked_category_amounts: Record<string, string>
  show_investments: boolean
}

type MemberEditForm = {
  display_name: string
  email: string
  role: "admin" | "member" | "viewer"
}

type InviteForm = {
  email: string
  fullName: string
  password: string
  role: string
  cloneFromMemberId: string
}

const defaultInviteForm: InviteForm = {
  email: "",
  fullName: "",
  password: "",
  role: "member",
  cloneFromMemberId: "__none",
}

const defaultSettingsForm: SettingsForm = {
  default_currency_id: "",
  initial_balance: "0",
  monthly_savings_target: "0",
  annual_savings_target: "0",
  default_payment_method: "__none",
  default_transaction_type: "expense",
  dashboard_months_ahead: "6",
  week_starts_on: "1",
  date_format: "dd/MM/yyyy",
  number_format: "es-AR",
  compact_mode: false,
  show_archived: false,
  notify_card_due_days: "3",
  notify_budget_threshold: "80",
  auto_create_card_transactions: false,
}

const defaultProfileForm: ProfileForm = {
  full_name: "",
  phone: "",
  locale: "es-AR",
}

const defaultFamilyForm: FamilyForm = {
  id: "",
  name: "",
  description: "",
  default_currency_id: "",
  timezone: "America/Argentina/Buenos_Aires",
  month_start_day: "1",
}

const defaultPermissionsForm: PermissionsForm = {
  allowed_modules: ALL_FAMILY_MODULE_IDS,
  visible_category_ids: null,
  masked_category_amounts: {},
  show_investments: true,
}

export function SettingsManagement() {
  const supabase = useMemo(() => createClient(), [])
  const { data: settings, isLoading } = useUserSettings()
  const { data: currencies } = useCurrencies()
  const { data: categories } = useCategories()
  const [userId, setUserId] = useState("")
  const [email, setEmail] = useState("")
  const [profile, setProfile] = useState<Profile | null>(null)
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([])
  const [activeFamilyMembers, setActiveFamilyMembers] = useState<FamilyMember[]>([])
  const [memberPermissions, setMemberPermissions] = useState<FamilyMemberPermissions[]>([])
  const [profileForm, setProfileForm] = useState<ProfileForm>(defaultProfileForm)
  const [settingsForm, setSettingsForm] = useState<SettingsForm>(defaultSettingsForm)
  const [familyForm, setFamilyForm] = useState<FamilyForm>(defaultFamilyForm)
  const [inviteForm, setInviteForm] = useState<InviteForm>(defaultInviteForm)
  const [selectedMemberId, setSelectedMemberId] = useState("")
  const [editingMemberId, setEditingMemberId] = useState("")
  const [memberEditForm, setMemberEditForm] = useState<MemberEditForm>({ display_name: "", email: "", role: "member" })
  const [selectedMaskCategoryId, setSelectedMaskCategoryId] = useState("")
  const [permissionsForm, setPermissionsForm] = useState<PermissionsForm>(defaultPermissionsForm)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [removingMember, setRemovingMember] = useState<FamilyMember | null>(null)

  const defaultCurrencyId = settings?.default_currency_id || currencies?.find((currency) => currency.code === "ARS")?.id || currencies?.[0]?.id || ""
  const activeMembership = familyMembers.find((member) => member.is_active) || null
  const activeFamilyId = activeMembership?.family_id || ""
  const canManageFamily = activeMembership?.role === "owner" || activeMembership?.role === "admin"
  const selectedMember = activeFamilyMembers.find((member) => member.id === selectedMemberId) || null
  const cloneableMembers = activeFamilyMembers.filter((member) => member.role !== "owner")
  const expenseCategories = (categories || []).filter((category) => category.type === "expense")
  const incomeCategories = (categories || []).filter((category) => category.type === "income")
  const selectedMaskCategory = (categories || []).find((category) => category.id === selectedMaskCategoryId) || null
  const configuredMasks = Object.entries(permissionsForm.masked_category_amounts)
    .filter(([, value]) => value !== "")
    .map(([categoryId, value]) => ({
      category: (categories || []).find((category) => category.id === categoryId),
      value,
    }))
    .filter((item) => item.category)

  useEffect(() => {
    async function loadUserContext() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      setUserId(user.id)
      setEmail(user.email || "")

      const [{ data: profileData }, { data: membershipsData }] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
        supabase
          .from("family_members")
          .select("*, family:families(*, default_currency:currencies(*))")
          .eq("user_id", user.id)
          .order("joined_at", { ascending: true }),
      ])

      setProfile(profileData || null)
      setProfileForm({
        full_name: profileData?.full_name || "",
        phone: profileData?.phone || "",
        locale: profileData?.locale || "es-AR",
      })
      setFamilyMembers((membershipsData as FamilyMember[]) || [])
    }

    loadUserContext()
  }, [supabase])

  useEffect(() => {
    setSettingsForm({
      default_currency_id: settings?.default_currency_id || defaultCurrencyId,
      initial_balance: settings?.initial_balance?.toString() || "0",
      monthly_savings_target: settings?.monthly_savings_target?.toString() || "0",
      annual_savings_target: settings?.annual_savings_target?.toString() || "0",
      default_payment_method: settings?.default_payment_method || "__none",
      default_transaction_type: settings?.default_transaction_type || "expense",
      dashboard_months_ahead: settings?.dashboard_months_ahead?.toString() || "6",
      week_starts_on: settings?.week_starts_on?.toString() || "1",
      date_format: settings?.date_format || "dd/MM/yyyy",
      number_format: settings?.number_format || "es-AR",
      compact_mode: settings?.compact_mode || false,
      show_archived: settings?.show_archived || false,
      notify_card_due_days: settings?.notify_card_due_days?.toString() || "3",
      notify_budget_threshold: settings?.notify_budget_threshold?.toString() || "80",
      auto_create_card_transactions: settings?.auto_create_card_transactions || false,
    })
  }, [defaultCurrencyId, settings])

  useEffect(() => {
    const family = activeMembership?.family
    setFamilyForm({
      id: family?.id || "",
      name: family?.name || "",
      description: family?.description || "",
      default_currency_id: family?.default_currency_id || defaultCurrencyId,
      timezone: family?.timezone || "America/Argentina/Buenos_Aires",
      month_start_day: family?.month_start_day?.toString() || "1",
    })
  }, [activeMembership, defaultCurrencyId])

  const reloadFamilyMembers = async () => {
    if (!userId) return
    const { data } = await supabase
      .from("family_members")
      .select("*, family:families(*, default_currency:currencies(*))")
      .eq("user_id", userId)
      .order("joined_at", { ascending: true })
    setFamilyMembers((data as FamilyMember[]) || [])
  }

  const reloadActiveFamilyAccess = async (familyId = activeFamilyId) => {
    if (!familyId) return

    const [{ data: membersData }, { data: permissionsData }] = await Promise.all([
      supabase
        .from("family_members")
        .select("*, family:families(*, default_currency:currencies(*))")
        .eq("family_id", familyId)
        .eq("is_active", true)
        .order("joined_at", { ascending: true }),
      supabase
        .from("family_member_permissions")
        .select("*")
        .eq("family_id", familyId),
    ])

    const members = (membersData as FamilyMember[]) || []
    setActiveFamilyMembers(members)
    setMemberPermissions((permissionsData as FamilyMemberPermissions[]) || [])
    setSelectedMemberId((current) =>
      members.find((member) => member.id === current)?.id ||
      members.find((member) => member.user_id !== userId)?.id ||
      members[0]?.id ||
      "",
    )
  }

  useEffect(() => {
    if (!activeFamilyId) return
    reloadActiveFamilyAccess(activeFamilyId)
  }, [activeFamilyId])

  useEffect(() => {
    const selectedPermissions = memberPermissions.find((permission) => permission.family_member_id === selectedMemberId)
    if (!selectedMemberId) {
      setPermissionsForm(defaultPermissionsForm)
      setSelectedMaskCategoryId("")
      return
    }

    const visibleCategoryIds = visibleCategoryIdsForEditor(
      selectedPermissions?.visible_category_ids,
      categories,
    )

    setPermissionsForm({
      allowed_modules: selectedPermissions?.allowed_modules || ALL_FAMILY_MODULE_IDS,
      visible_category_ids: visibleCategoryIds,
      masked_category_amounts: Object.fromEntries(
        Object.entries(selectedPermissions?.masked_category_amounts || {}).map(([key, value]) => [key, String(value)]),
      ),
      show_investments: selectedPermissions?.show_investments ?? true,
    })
    setSelectedMaskCategoryId("")
  }, [categories, memberPermissions, selectedMemberId])

  const saveProfile = async () => {
    setIsSubmitting(true)
    setMessage(null)

    try {
      if (!userId) throw new Error("No estás autenticado")

      const { data, error } = await supabase
        .from("profiles")
        .upsert({
          id: userId,
          full_name: profileForm.full_name.trim() || null,
          phone: profileForm.phone.trim() || null,
          locale: profileForm.locale,
          updated_at: new Date().toISOString(),
        })
        .select("*")
        .single()

      if (error) throw error
      setProfile(data)
      setMessage("Perfil guardado")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Error al guardar perfil")
    } finally {
      setIsSubmitting(false)
    }
  }

  const saveSettings = async () => {
    setIsSubmitting(true)
    setMessage(null)

    try {
      if (!userId) throw new Error("No estás autenticado")

      const monthlyTarget = Number(settingsForm.monthly_savings_target)
      const annualTarget = Number(settingsForm.annual_savings_target)
      const monthsAhead = Number(settingsForm.dashboard_months_ahead)
      const cardDueDays = Number(settingsForm.notify_card_due_days)
      const budgetThreshold = Number(settingsForm.notify_budget_threshold)
      const weekStartsOn = Number(settingsForm.week_starts_on)

      if (monthlyTarget < 0 || annualTarget < 0) throw new Error("Las metas de ahorro no pueden ser negativas")
      if (monthsAhead < 1 || monthsAhead > 24) throw new Error("La proyección debe estar entre 1 y 24 meses")
      if (cardDueDays < 0 || cardDueDays > 31) throw new Error("Los días de aviso de tarjeta deben estar entre 0 y 31")
      if (budgetThreshold < 0 || budgetThreshold > 100) throw new Error("El umbral de presupuesto debe estar entre 0 y 100")
      if (weekStartsOn < 0 || weekStartsOn > 6) throw new Error("El inicio de semana no es válido")

      const { error } = await supabase
        .from("user_settings")
        .upsert({
          user_id: userId,
          default_currency_id: settingsForm.default_currency_id || null,
          monthly_savings_target: monthlyTarget || 0,
          annual_savings_target: annualTarget || 0,
          initial_balance: Number(settingsForm.initial_balance) || 0,
          default_payment_method: settingsForm.default_payment_method === "__none" ? null : settingsForm.default_payment_method,
          default_transaction_type: settingsForm.default_transaction_type,
          dashboard_months_ahead: monthsAhead,
          week_starts_on: weekStartsOn,
          date_format: settingsForm.date_format,
          number_format: settingsForm.number_format,
          compact_mode: settingsForm.compact_mode,
          show_archived: settingsForm.show_archived,
          notify_card_due_days: cardDueDays,
          notify_budget_threshold: budgetThreshold,
          auto_create_card_transactions: settingsForm.auto_create_card_transactions,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" })

      if (error) throw error
      invalidateCache("user-settings")
      setMessage("Preferencias guardadas")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Error al guardar preferencias")
    } finally {
      setIsSubmitting(false)
    }
  }

  const saveFamily = async () => {
    setIsSubmitting(true)
    setMessage(null)

    try {
      if (!userId) throw new Error("No estás autenticado")
      if (!familyForm.name.trim()) throw new Error("El nombre del hogar es requerido")
      const monthStartDay = Number(familyForm.month_start_day)
      if (monthStartDay < 1 || monthStartDay > 28) throw new Error("El día de inicio mensual debe estar entre 1 y 28")
      let savedFamilyId = familyForm.id

      if (familyForm.id) {
        const { error } = await supabase
          .from("families")
          .update({
            name: familyForm.name.trim(),
            description: familyForm.description.trim() || null,
            default_currency_id: familyForm.default_currency_id || null,
            timezone: familyForm.timezone,
            month_start_day: monthStartDay,
            updated_at: new Date().toISOString(),
          })
          .eq("id", familyForm.id)

        if (error) throw error
      } else {
        const { data: family, error } = await supabase
          .from("families")
          .insert({
            name: familyForm.name.trim(),
            description: familyForm.description.trim() || null,
            default_currency_id: familyForm.default_currency_id || null,
            timezone: familyForm.timezone,
            month_start_day: monthStartDay,
            created_by: userId,
          })
          .select("*")
          .single()

        if (error) throw error

        savedFamilyId = family.id
        const { error: memberError } = await supabase
          .from("family_members")
          .insert({
            family_id: family.id,
            user_id: userId,
            role: "owner",
            is_active: true,
          })

        if (memberError) throw memberError
      }

      await reloadFamilyMembers()
      await reloadActiveFamilyAccess(savedFamilyId)
      setMessage("Hogar guardado")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Error al guardar hogar")
    } finally {
      setIsSubmitting(false)
    }
  }

  const addFamilyMember = async () => {
    setIsSubmitting(true)
    setMessage(null)

    try {
      if (!activeFamilyId) throw new Error("Primero creá un hogar")
      if (!canManageFamily) throw new Error("No tenés permisos para agregar miembros")

      const response = await fetch("/api/family/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          familyId: activeFamilyId,
          email: inviteForm.email,
          fullName: inviteForm.fullName,
          password: inviteForm.password,
          role: inviteForm.role,
          cloneFromMemberId: inviteForm.cloneFromMemberId === "__none" ? undefined : inviteForm.cloneFromMemberId,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Error al agregar miembro")

      setInviteForm(defaultInviteForm)
      await reloadFamilyMembers()
      await reloadActiveFamilyAccess()
      invalidateCache("family-visibility")
      setMessage("Miembro agregado")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Error al agregar miembro")
    } finally {
      setIsSubmitting(false)
    }
  }

  const beginEditMember = (member: FamilyMember) => {
    if (member.role === "owner") return
    setEditingMemberId(member.id)
    setMemberEditForm({
      display_name: member.display_name || "",
      email: member.email || "",
      role: member.role === "admin" ? "admin" : member.role === "viewer" ? "viewer" : "member",
    })
  }

  const cancelEditMember = () => {
    setEditingMemberId("")
    setMemberEditForm({ display_name: "", email: "", role: "member" })
  }

  const saveFamilyMember = async (member: FamilyMember) => {
    setIsSubmitting(true)
    setMessage(null)

    try {
      if (!canManageFamily) throw new Error("No tenés permisos para editar miembros")

      const response = await fetch("/api/family/members", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: member.id,
          displayName: memberEditForm.display_name,
          email: memberEditForm.email,
          role: memberEditForm.role,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Error al editar miembro")

      cancelEditMember()
      await reloadFamilyMembers()
      await reloadActiveFamilyAccess()
      invalidateCache("family-visibility")
      setMessage("Miembro actualizado")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Error al editar miembro")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRemoveFamilyMember = async () => {
    if (!removingMember) return
    const member = removingMember
    setIsSubmitting(true)
    setMessage(null)

    try {
      if (!canManageFamily) throw new Error("No tenés permisos para quitar miembros")

      const response = await fetch("/api/family/members", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: member.id }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Error al quitar miembro")

      if (selectedMemberId === member.id) setSelectedMemberId("")
      if (editingMemberId === member.id) cancelEditMember()
      await reloadFamilyMembers()
      await reloadActiveFamilyAccess()
      invalidateCache("family-visibility")
      setMessage("Miembro quitado del hogar")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Error al quitar miembro")
    } finally {
      setIsSubmitting(false)
      setRemovingMember(null)
    }
  }

  const toggleModule = (moduleId: string, enabled: boolean) => {
    const nextModules = enabled
      ? Array.from(new Set([...permissionsForm.allowed_modules, moduleId]))
      : permissionsForm.allowed_modules.filter((item) => item !== moduleId)

    setPermissionsForm({
      ...permissionsForm,
      allowed_modules: nextModules,
      show_investments: moduleId === "investments" ? enabled : permissionsForm.show_investments,
    })
  }

  const toggleCategory = (categoryId: string, enabled: boolean) => {
    const allCategoryIds = (categories || []).map((category) => category.id)
    const current = permissionsForm.visible_category_ids ?? allCategoryIds
    const next = enabled
      ? Array.from(new Set([...current, categoryId]))
      : current.filter((id) => id !== categoryId)

    // Disabling a category also drops its mask so a later re-enable is truly visible.
    if (!enabled && permissionsForm.masked_category_amounts[categoryId] !== undefined) {
      const { [categoryId]: _removed, ...masked_category_amounts } = permissionsForm.masked_category_amounts
      setPermissionsForm({ ...permissionsForm, visible_category_ids: next, masked_category_amounts })
      return
    }

    setPermissionsForm({ ...permissionsForm, visible_category_ids: next })
  }

  const saveMemberPermissions = async () => {
    setIsSubmitting(true)
    setMessage(null)

    try {
      if (!activeFamilyId || !selectedMember) throw new Error("Seleccioná un miembro")
      if (!canManageFamily) throw new Error("No tenés permisos para administrar miembros")

      const visibleIds = permissionsForm.visible_category_ids
      const maskedEntries = Object.entries(permissionsForm.masked_category_amounts)
        .filter(([categoryId, value]) => {
          if (value === "" || !Number.isFinite(Number(value))) return false
          // Masks only apply to categories the member is allowed to see.
          if (Array.isArray(visibleIds) && !visibleIds.includes(categoryId)) return false
          return true
        })
        .map(([key, value]) => [key, Number(value)])

      const { data, error } = await supabase
        .from("family_member_permissions")
        .upsert({
          family_id: activeFamilyId,
          family_member_id: selectedMember.id,
          user_id: selectedMember.user_id,
          allowed_modules: permissionsForm.allowed_modules,
          visible_category_ids: permissionsForm.visible_category_ids,
          masked_category_amounts: Object.fromEntries(maskedEntries),
          show_investments: permissionsForm.show_investments && permissionsForm.allowed_modules.includes("investments"),
          created_by: userId,
        }, { onConflict: "family_member_id" })
        .select("id, visible_category_ids")
        .maybeSingle()

      if (error) throw error
      if (!data) throw new Error("No se pudo guardar la vista (RLS o permisos)")
      await reloadActiveFamilyAccess()
      invalidateCache("family-visibility")
      invalidateCache("categories")
      invalidateCache("groups")
      invalidateCacheByPrefix("transactions")
      setMessage("Permisos guardados")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Error al guardar permisos")
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Configuración</h2>
        <p className="text-sm text-muted-foreground">Preferencias personales, hogar familiar, alertas y comportamiento financiero.</p>
      </div>

      {message && (
        <div className="rounded-md border bg-muted p-3 text-sm">{message}</div>
      )}

      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList className="flex h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="profile">Perfil</TabsTrigger>
          <TabsTrigger value="finance">Finanzas</TabsTrigger>
          <TabsTrigger value="family">Hogar</TabsTrigger>
          <TabsTrigger value="integrations">Integraciones</TabsTrigger>
          <TabsTrigger value="alerts">Alertas</TabsTrigger>
          <TabsTrigger value="account">Cuenta</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <Card>
            <CardHeader>
              <CardTitle>Perfil personal</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Nombre completo</Label>
                  <Input value={profileForm.full_name} onChange={(event) => setProfileForm({ ...profileForm, full_name: event.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Telefono</Label>
                  <Input value={profileForm.phone} onChange={(event) => setProfileForm({ ...profileForm, phone: event.target.value })} />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Idioma y region</Label>
                  <Select value={profileForm.locale} onValueChange={(value) => setProfileForm({ ...profileForm, locale: value })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="es-AR">Español Argentina</SelectItem>
                      <SelectItem value="es-UY">Español Uruguay</SelectItem>
                      <SelectItem value="es-CL">Español Chile</SelectItem>
                      <SelectItem value="en-US">English US</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input value={email} disabled />
                </div>
              </div>
              <Button className="w-full sm:w-auto" onClick={saveProfile} disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Guardar perfil
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="finance">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>Gastos recurrentes</CardTitle>
                  <CardDescription className="mt-1">
                    Actualizá montos o eliminá series existentes (sin débitos de tarjeta; esos están en Tarjetas).
                  </CardDescription>
                </div>
                <Button asChild variant="outline" className="w-full sm:w-auto">
                  <Link href="/dashboard/recurrentes">
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Administrar recurrentes
                  </Link>
                </Button>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Base financiera</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Moneda base</Label>
                    <Select value={settingsForm.default_currency_id} onValueChange={(value) => setSettingsForm({ ...settingsForm, default_currency_id: value })}>
                      <SelectTrigger><SelectValue placeholder="Seleccionar moneda" /></SelectTrigger>
                      <SelectContent>
                        {currencies?.map((currency) => (
                          <SelectItem key={currency.id} value={currency.id}>{currency.code} ({currency.symbol})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Saldo inicial</Label>
                    <Input type="number" step="0.01" value={settingsForm.initial_balance} onChange={(event) => setSettingsForm({ ...settingsForm, initial_balance: event.target.value })} />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Meta mensual de ahorro</Label>
                    <Input type="number" step="0.01" value={settingsForm.monthly_savings_target} onChange={(event) => setSettingsForm({ ...settingsForm, monthly_savings_target: event.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Meta anual de ahorro</Label>
                    <Input type="number" step="0.01" value={settingsForm.annual_savings_target} onChange={(event) => setSettingsForm({ ...settingsForm, annual_savings_target: event.target.value })} />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Captura y vistas</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Tipo por defecto</Label>
                    <Select value={settingsForm.default_transaction_type} onValueChange={(value) => setSettingsForm({ ...settingsForm, default_transaction_type: value as "expense" | "income" })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="expense">Gasto</SelectItem>
                        <SelectItem value="income">Ingreso</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Método de pago por defecto</Label>
                    <Select value={settingsForm.default_payment_method} onValueChange={(value) => setSettingsForm({ ...settingsForm, default_payment_method: value })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">Sin preferencia</SelectItem>
                        <SelectItem value="cash">Efectivo</SelectItem>
                        <SelectItem value="debit">Débito</SelectItem>
                        <SelectItem value="credit">Crédito</SelectItem>
                        <SelectItem value="transfer">Transferencia</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Meses a proyectar</Label>
                    <Input type="number" min={1} max={24} value={settingsForm.dashboard_months_ahead} onChange={(event) => setSettingsForm({ ...settingsForm, dashboard_months_ahead: event.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Formato fecha</Label>
                    <Select value={settingsForm.date_format} onValueChange={(value) => setSettingsForm({ ...settingsForm, date_format: value })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dd/MM/yyyy">dd/MM/yyyy</SelectItem>
                        <SelectItem value="MM/dd/yyyy">MM/dd/yyyy</SelectItem>
                        <SelectItem value="yyyy-MM-dd">yyyy-MM-dd</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Formato numeros</Label>
                    <Select value={settingsForm.number_format} onValueChange={(value) => setSettingsForm({ ...settingsForm, number_format: value })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="es-AR">es-AR</SelectItem>
                        <SelectItem value="en-US">en-US</SelectItem>
                        <SelectItem value="es-CL">es-CL</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="flex items-center gap-3 rounded-md border p-3">
                    <Switch checked={settingsForm.compact_mode} onCheckedChange={(checked) => setSettingsForm({ ...settingsForm, compact_mode: checked })} />
                    <span className="text-sm font-medium">Modo compacto</span>
                  </label>
                  <label className="flex items-center gap-3 rounded-md border p-3">
                    <Switch checked={settingsForm.show_archived} onCheckedChange={(checked) => setSettingsForm({ ...settingsForm, show_archived: checked })} />
                    <span className="text-sm font-medium">Mostrar archivados</span>
                  </label>
                </div>
                <Button className="w-full sm:w-auto" onClick={saveSettings} disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Guardar finanzas
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="family">
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <Card>
              <CardHeader>
                <CardTitle>Hogar familiar</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Nombre del hogar</Label>
                    <Input value={familyForm.name} onChange={(event) => setFamilyForm({ ...familyForm, name: event.target.value })} placeholder="Familia, casa, departamento..." />
                  </div>
                  <div className="space-y-2">
                    <Label>Moneda del hogar</Label>
                    <Select value={familyForm.default_currency_id} onValueChange={(value) => setFamilyForm({ ...familyForm, default_currency_id: value })}>
                      <SelectTrigger><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                      <SelectContent>
                        {currencies?.map((currency) => (
                          <SelectItem key={currency.id} value={currency.id}>{currency.code} ({currency.symbol})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Descripción</Label>
                  <Textarea value={familyForm.description} onChange={(event) => setFamilyForm({ ...familyForm, description: event.target.value })} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Zona horaria</Label>
                    <Select value={familyForm.timezone} onValueChange={(value) => setFamilyForm({ ...familyForm, timezone: value })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="America/Argentina/Buenos_Aires">Buenos Aires</SelectItem>
                        <SelectItem value="America/Montevideo">Montevideo</SelectItem>
                        <SelectItem value="America/Santiago">Santiago</SelectItem>
                        <SelectItem value="America/New_York">New York</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Inicio del mes financiero</Label>
                    <Input type="number" min={1} max={28} value={familyForm.month_start_day} onChange={(event) => setFamilyForm({ ...familyForm, month_start_day: event.target.value })} />
                  </div>
                </div>
                <Button className="w-full sm:w-auto" onClick={saveFamily} disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {familyForm.id ? "Guardar hogar" : "Crear hogar"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Miembros</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeFamilyMembers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Todavía no hay hogar creado.</p>
                ) : (
                  activeFamilyMembers.map((member) => (
                    <div key={member.id} className="rounded-md border p-3">
                      {editingMemberId === member.id ? (
                        <div className="space-y-3">
                          <Input
                            placeholder="Nombre visible"
                            value={memberEditForm.display_name}
                            onChange={(event) => setMemberEditForm({ ...memberEditForm, display_name: event.target.value })}
                          />
                          <Input
                            placeholder="Email visible"
                            value={memberEditForm.email}
                            onChange={(event) => setMemberEditForm({ ...memberEditForm, email: event.target.value })}
                          />
                          <Select
                            value={memberEditForm.role}
                            onValueChange={(value) => setMemberEditForm({ ...memberEditForm, role: value as MemberEditForm["role"] })}
                            disabled={member.user_id === userId}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="member">Miembro</SelectItem>
                              <SelectItem value="viewer">Solo lectura</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="grid gap-2 sm:flex">
                            <Button size="sm" className="w-full sm:w-auto" onClick={() => saveFamilyMember(member)} disabled={isSubmitting}>
                              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                              Guardar
                            </Button>
                            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={cancelEditMember} disabled={isSubmitting}>
                              <X className="h-4 w-4" />
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{member.user_id === userId ? "Vos" : member.display_name || member.email || member.user_id}</p>
                            <p className="truncate text-xs text-muted-foreground">{member.email || member.family?.name}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant={member.role === "owner" ? "default" : "secondary"}>{member.role}</Badge>
                            {canManageFamily && member.role !== "owner" && (
                              <>
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  onClick={() => beginEditMember(member)}
                                  disabled={isSubmitting}
                                  title="Editar miembro"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  onClick={() => setRemovingMember(member)}
                                  disabled={isSubmitting || member.user_id === userId}
                                  title="Quitar miembro"
                                  className="text-destructive hover:text-destructive"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}

                {canManageFamily && activeFamilyId && (
                  <div className="space-y-3 rounded-md border p-3">
                    <p className="text-sm font-medium">Registrar y agregar usuario</p>
                    <Input
                      placeholder="Nombre completo"
                      value={inviteForm.fullName}
                      onChange={(event) => setInviteForm((current) => ({ ...current, fullName: event.target.value }))}
                    />
                    <Input
                      placeholder="email@dominio.com"
                      value={inviteForm.email}
                      onChange={(event) => setInviteForm((current) => ({ ...current, email: event.target.value }))}
                    />
                    <Input
                      type="password"
                      placeholder="Contraseña inicial"
                      value={inviteForm.password}
                      onChange={(event) => setInviteForm((current) => ({ ...current, password: event.target.value }))}
                    />
                    <Select
                      value={inviteForm.role}
                      onValueChange={(value) => setInviteForm((current) => ({ ...current, role: value }))}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="member">Miembro</SelectItem>
                        <SelectItem value="viewer">Solo lectura</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={inviteForm.cloneFromMemberId}
                      onValueChange={(value) => {
                        const sourceMember = activeFamilyMembers.find((member) => member.id === value)
                        setInviteForm((current) => ({
                          ...current,
                          cloneFromMemberId: value,
                          role: sourceMember && sourceMember.role !== "owner" ? sourceMember.role : current.role,
                        }))
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Copiar configuración de..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">Sin copiar configuración</SelectItem>
                        {cloneableMembers.map((member) => (
                          <SelectItem key={member.id} value={member.id}>
                            {member.user_id === userId ? "Vos" : member.display_name || member.email || member.user_id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button className="w-full" onClick={addFamilyMember} disabled={isSubmitting}>
                      {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Agregar
                    </Button>
                    <p className="text-xs text-muted-foreground">Si copiás un miembro, el nuevo usuario hereda módulos, categorías visibles, máscaras e inversiones.</p>
                    <p className="text-xs text-muted-foreground">Si el email ya existe, se lo asocia al hogar. Si no existe, se crea la cuenta con esta contraseña inicial.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {canManageFamily && selectedMember && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Vista del miembro</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
                  <div className="space-y-2">
                    <Label>Miembro</Label>
                    <Select value={selectedMemberId} onValueChange={setSelectedMemberId}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {activeFamilyMembers.map((member) => (
                          <SelectItem key={member.id} value={member.id}>
                            {member.user_id === userId ? "Vos" : member.display_name || member.email || member.user_id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                    Estas reglas afectan la navegación, las categorías visibles y los cálculos que ve ese usuario. Si una categoría tiene máscara, sus totales se calculan con el importe visible.
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {FAMILY_MODULES.map((module) => (
                    <label key={module.id} className="flex items-center gap-3 rounded-md border p-3">
                      <Switch
                        checked={permissionsForm.allowed_modules.includes(module.id)}
                        onCheckedChange={(checked) => toggleModule(module.id, checked)}
                      />
                      <span className="text-sm font-medium">{module.label}</span>
                    </label>
                  ))}
                </div>

                <label className="flex items-center gap-3 rounded-md border p-3">
                  <Switch
                    checked={permissionsForm.show_investments && permissionsForm.allowed_modules.includes("investments")}
                    onCheckedChange={(checked) => toggleModule("investments", checked)}
                  />
                  <span className="text-sm font-medium">Puede ver inversiones y portfolio</span>
                </label>

                <div className="space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-medium">Categorías visibles</p>
                      <p className="text-sm text-muted-foreground">Si desactivás una categoría, sus movimientos no aparecen ni entran en cálculos. Activarla la vuelve visible para ese miembro.</p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full sm:w-auto"
                      onClick={() => setPermissionsForm({ ...permissionsForm, visible_category_ids: permissionsForm.visible_category_ids ? null : [] })}
                    >
                      {permissionsForm.visible_category_ids ? "Ver todas" : "Configurar"}
                    </Button>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    {[
                      { title: "Gastos", list: expenseCategories },
                      { title: "Ingresos", list: incomeCategories },
                    ].map(({ title, list }) => (
                      <div key={title} className="space-y-2 rounded-md border p-3">
                        <p className="font-medium">{title}</p>
                        {list.length === 0 ? (
                          <p className="text-sm text-muted-foreground">Sin categorías.</p>
                        ) : (
                          list.map((category) => (
                            <label key={category.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-1">
                              <span className="text-sm">{category.name}</span>
                              <Switch
                                checked={!permissionsForm.visible_category_ids || permissionsForm.visible_category_ids.includes(category.id)}
                                onCheckedChange={(checked) => toggleCategory(category.id, checked)}
                              />
                            </label>
                          ))
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <p className="font-medium">Máscara de importe</p>
                    <p className="text-sm text-muted-foreground">Solo aplica a categorías visibles: el miembro ve el concepto con este monto en lugar del real.</p>
                  </div>

                  <div className="grid gap-3 md:grid-cols-[minmax(240px,1fr)_220px_auto]">
                    <Select value={selectedMaskCategoryId} onValueChange={setSelectedMaskCategoryId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Buscar concepto..." />
                      </SelectTrigger>
                      <SelectContent>
                        {(categories || []).map((category) => (
                          <SelectItem key={category.id} value={category.id}>
                            {category.name} · {category.type === "expense" ? "Gasto" : "Ingreso"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Input
                      type="number"
                      step="0.01"
                      placeholder={selectedMaskCategory ? "Monto visible" : "Seleccioná concepto"}
                      disabled={!selectedMaskCategory}
                      value={selectedMaskCategory ? permissionsForm.masked_category_amounts[selectedMaskCategory.id] || "" : ""}
                      onChange={(event) => {
                        if (!selectedMaskCategory) return
                        setPermissionsForm({
                          ...permissionsForm,
                          masked_category_amounts: {
                            ...permissionsForm.masked_category_amounts,
                            [selectedMaskCategory.id]: event.target.value,
                          },
                        })
                      }}
                    />

                    <Button
                      type="button"
                      variant="outline"
                      className="w-full md:w-auto"
                      disabled={!selectedMaskCategory}
                      onClick={() => {
                        if (!selectedMaskCategory) return
                        const { [selectedMaskCategory.id]: _removed, ...nextMasks } = permissionsForm.masked_category_amounts
                        setPermissionsForm({ ...permissionsForm, masked_category_amounts: nextMasks })
                      }}
                    >
                      Quitar
                    </Button>
                  </div>

                  {selectedMaskCategory && (
                    <div className="rounded-md bg-muted p-3 text-sm">
                      <span className="font-medium">{selectedMaskCategory.name}</span>
                      <span className="text-muted-foreground"> se mostrará como </span>
                      <span className="font-mono">
                        {permissionsForm.masked_category_amounts[selectedMaskCategory.id] || "sin máscara"}
                      </span>
                    </div>
                  )}

                  <div className="space-y-2">
                    <p className="text-sm font-medium">Máscaras configuradas</p>
                    {configuredMasks.length === 0 ? (
                      <p className="rounded-md border p-3 text-sm text-muted-foreground">Todavía no hay conceptos enmascarados.</p>
                    ) : (
                      <div className="grid gap-2 md:grid-cols-2">
                        {configuredMasks.map(({ category, value }) => (
                          <button
                            key={category!.id}
                            type="button"
                            className="flex items-center justify-between gap-3 rounded-md border p-3 text-left hover:bg-muted"
                            onClick={() => setSelectedMaskCategoryId(category!.id)}
                          >
                            <span>
                              <span className="block text-sm font-medium">{category!.name}</span>
                              <span className="text-xs text-muted-foreground">{category!.type === "expense" ? "Gasto" : "Ingreso"}</span>
                            </span>
                            <span className="font-mono text-sm">{value}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <Button className="w-full sm:w-auto" onClick={saveMemberPermissions} disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Guardar vista del miembro
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="integrations">
          <PortfolioIntegrations variant="settings" />
        </TabsContent>

        <TabsContent value="alerts">
          <Card>
            <CardHeader>
              <CardTitle>Alertas y automatizaciones</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Aviso previo de vencimiento de tarjeta</Label>
                  <Input type="number" min={0} max={31} value={settingsForm.notify_card_due_days} onChange={(event) => setSettingsForm({ ...settingsForm, notify_card_due_days: event.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Alerta de presupuesto usado %</Label>
                  <Input type="number" min={0} max={100} step="0.01" value={settingsForm.notify_budget_threshold} onChange={(event) => setSettingsForm({ ...settingsForm, notify_budget_threshold: event.target.value })} />
                </div>
              </div>
              <label className="flex items-center gap-3 rounded-md border p-3">
                <Switch checked={settingsForm.auto_create_card_transactions} onCheckedChange={(checked) => setSettingsForm({ ...settingsForm, auto_create_card_transactions: checked })} />
                <span className="text-sm font-medium">Crear transacciones automaticamente desde compras en cuotas</span>
              </label>
              <Button className="w-full sm:w-auto" onClick={saveSettings} disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Guardar alertas
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="account">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Cuenta</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <p className="text-muted-foreground">Email</p>
                  <p className="font-medium">{email || "Usuario autenticado"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">ID usuario</p>
                  <p className="break-all font-mono text-xs">{userId || "-"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Perfil</p>
                  <p className="font-medium">{profile ? "Configurado" : "Pendiente"}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Estado de datos</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Supabase Auth</span>
                  <Badge variant="secondary">Activo</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Preferencias</span>
                  <Badge variant={settings ? "secondary" : "outline"}>{settings ? "Guardadas" : "Sin guardar"}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Hogar familiar</span>
                  <Badge variant={activeMembership ? "secondary" : "outline"}>{activeMembership ? "Activo" : "Pendiente"}</Badge>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <AlertDialog open={!!removingMember} onOpenChange={() => setRemovingMember(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quitar miembro del hogar</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Quitar a {removingMember?.display_name || removingMember?.email || "este miembro"} del hogar? Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveFamilyMember}
              disabled={isSubmitting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Quitar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
