export function getMonthIndexFromDateOnly(value: string | null | undefined) {
  if (!value) return -1
  const month = Number(value.slice(5, 7))
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month - 1 : -1
}

export function getYearFromDateOnly(value: string | null | undefined) {
  if (!value) return 0
  const year = Number(value.slice(0, 4))
  return Number.isFinite(year) ? year : 0
}

export function dateOnlyToLocalDate(value: string | null | undefined) {
  if (!value) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return new Date(year, month - 1, day)
}

export function getLastDayOfMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

export function clampDayOfMonth(year: number, month: number, day: number) {
  return Math.min(Math.max(day, 1), getLastDayOfMonth(year, month))
}

export function toDateOnly(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(clampDayOfMonth(year, month, day)).padStart(2, "0")}`
}

/** Local calendar date of a Date (or now). Never use toISOString().slice for business dates. */
export function toLocalDateOnly(date: Date = new Date()) {
  return toDateOnly(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

export function getMonthBounds(year: number, month: number) {
  return { start: toDateOnly(year, month, 1), end: toDateOnly(year, month, 31) }
}
