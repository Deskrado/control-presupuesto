import { describe, expect, it } from "vitest"
import {
  planRecurringIncomeAmountUpdate,
  planRecurringIncomeDisable,
} from "@/lib/recurring-income-bulk"

describe("planRecurringIncomeAmountUpdate", () => {
  it("calcula montos absolutos y porcentuales sobre plantillas seleccionadas", () => {
    const templates = [
      { id: "a", description: "Sueldo", amount: 100000, is_active: true },
      { id: "b", description: "Alquiler cobrado", amount: 50000, is_active: true },
      { id: "c", description: "Otro", amount: 10, is_active: false },
    ]

    const absolute = planRecurringIncomeAmountUpdate({
      templates,
      templateIds: ["a", "b"],
      mode: "absolute",
      value: 120000,
    })
    expect(absolute.updates).toEqual([
      { id: "a", amount: 120000 },
      { id: "b", amount: 120000 },
    ])

    const percent = planRecurringIncomeAmountUpdate({
      templates,
      templateIds: ["b"],
      mode: "percent",
      value: 10,
    })
    expect(percent.preview[0]).toMatchObject({
      templateId: "b",
      fromAmount: 50000,
      toAmount: 55000,
    })
  })
})

describe("planRecurringIncomeDisable", () => {
  it("lista plantillas seleccionadas para pausar/eliminar", () => {
    const plan = planRecurringIncomeDisable({
      templates: [
        { id: "a", description: "Sueldo", amount: 1, is_active: true },
        { id: "b", description: "Bonus", amount: 1, is_active: false },
      ],
      templateIds: ["a", "b"],
    })

    expect(plan.templateIds).toEqual(["a", "b"])
    expect(plan.preview).toEqual([
      { templateId: "b", description: "Bonus", wasActive: false },
      { templateId: "a", description: "Sueldo", wasActive: true },
    ])
  })
})
