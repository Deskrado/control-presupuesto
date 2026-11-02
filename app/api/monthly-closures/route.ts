import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

async function getDefaultFamilyId(userId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("family_members")
    .select("family_id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data?.family_id || null
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const yearParam = request.nextUrl.searchParams.get("year")
    const fromYearParam = request.nextUrl.searchParams.get("fromYear")
    const fromMonthParam = request.nextUrl.searchParams.get("fromMonth")
    const toYearParam = request.nextUrl.searchParams.get("toYear")
    const toMonthParam = request.nextUrl.searchParams.get("toMonth")
    const fromYear = Number(fromYearParam)
    const fromMonth = Number(fromMonthParam)
    const toYear = Number(toYearParam)
    const toMonth = Number(toMonthParam)
    const rangeParams = [fromYearParam, fromMonthParam, toYearParam, toMonthParam]
    const providedRangeParams = rangeParams.filter((value) => value !== null).length
    const hasRange = providedRangeParams === rangeParams.length &&
      [fromYear, fromMonth, toYear, toMonth].every(Number.isFinite)
    const year = Number(yearParam || new Date().getFullYear())

    if (providedRangeParams > 0 && !hasRange) {
      return NextResponse.json({ error: "Rango incompleto" }, { status: 400 })
    }

    if (hasRange) {
      const fromIndex = fromYear * 12 + fromMonth
      const toIndex = toYear * 12 + toMonth
      if (fromYear < 2000 || fromYear > 2100 || toYear < 2000 || toYear > 2100 || fromMonth < 1 || fromMonth > 12 || toMonth < 1 || toMonth > 12 || fromIndex > toIndex) {
        return NextResponse.json({ error: "Rango inválido" }, { status: 400 })
      }
    }

    let query = supabase
      .from("monthly_closures")
      .select("*")
      .order("year", { ascending: false })
      .order("month", { ascending: false })

    if (hasRange) {
      query = query.gte("year", fromYear).lte("year", toYear)
    } else if (Number.isFinite(year)) {
      query = query.eq("year", year)
    }

    const { data, error } = await query
    if (error) throw error

    const closures = hasRange
      ? (data || []).filter((closure) => {
          const periodIndex = closure.year * 12 + closure.month
          return periodIndex >= fromYear * 12 + fromMonth && periodIndex <= toYear * 12 + toMonth
        })
      : data || []

    return NextResponse.json({ closures })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al obtener cierres" },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const year = Number(body.year)
    const month = Number(body.month)
    const familyId = body.familyId === null ? null : String(body.familyId || await getDefaultFamilyId(user.id) || "") || null

    if (month < 1 || month > 12 || year < 2000 || year > 2100) {
      return NextResponse.json({ error: "Periodo inválido" }, { status: 400 })
    }

    const payload = {
      user_id: user.id,
      family_id: familyId,
      year,
      month,
      income_total: Number(body.incomeTotal || 0),
      expense_total: Number(body.expenseTotal || 0),
      savings_total: Number(body.savingsTotal || 0),
      cash_total: Number(body.cashTotal || 0),
      investments_total: Number(body.investmentsTotal || 0),
      foreign_currency_total: Number(body.foreignCurrencyTotal || 0),
      snapshot: body.snapshot && typeof body.snapshot === "object" ? body.snapshot : {},
      closed_by: user.id,
      closed_at: new Date().toISOString(),
    }

    // Family scope: one closure per (family, year, month). Personal: one per (user, year, month).
    // Partial unique indexes are not reliable conflict targets for PostgREST upsert, so resolve manually.
    let existingQuery = supabase
      .from("monthly_closures")
      .select("id")
      .eq("year", year)
      .eq("month", month)
      .limit(1)

    existingQuery = familyId
      ? existingQuery.eq("family_id", familyId)
      : existingQuery.eq("user_id", user.id).is("family_id", null)

    const { data: existing, error: existingError } = await existingQuery.maybeSingle()
    if (existingError) throw existingError

    const write = existing?.id
      ? await supabase
          .from("monthly_closures")
          .update(payload)
          .eq("id", existing.id)
          .select("*")
          .single()
      : await supabase
          .from("monthly_closures")
          .insert(payload)
          .select("*")
          .single()

    if (write.error) throw write.error
    return NextResponse.json({ closure: write.data })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error al cerrar mes" },
      { status: 500 },
    )
  }
}
