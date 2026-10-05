import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import * as Projection from "../src/Projection.js"

describe("Projection", () => {
  it("builds projection expression from attribute list", () => {
    const result = Projection.projection(["name", "email", "status"])

    expect(result.expression).toBe("#proj_name, #proj_email, #proj_status")
    expect(result.names).toEqual({
      "#proj_name": "name",
      "#proj_email": "email",
      "#proj_status": "status",
    })
  })

  it("handles single attribute", () => {
    const result = Projection.projection(["userId"])

    expect(result.expression).toBe("#proj_userId")
    expect(result.names).toEqual({ "#proj_userId": "userId" })
  })

  it("returns empty expression for empty attribute list", () => {
    const result = Projection.projection([])

    expect(result.expression).toBe("")
    expect(result.names).toEqual({})
  })

  it("handles reserved word attribute names", () => {
    // DynamoDB reserved words like "name", "status", "type" are safely aliased
    const result = Projection.projection(["name", "type", "status"])

    expect(result.expression).toBe("#proj_name, #proj_type, #proj_status")
    expect(result.names["#proj_name"]).toBe("name")
    expect(result.names["#proj_type"]).toBe("type")
    expect(result.names["#proj_status"]).toBe("status")
  })

  it("handles many attributes", () => {
    const attrs = ["a", "b", "c", "d", "e", "f"]
    const result = Projection.projection(attrs)

    expect(result.expression).toBe("#proj_a, #proj_b, #proj_c, #proj_d, #proj_e, #proj_f")
    expect(Object.keys(result.names)).toHaveLength(6)
  })

  it("gives a name a placeholder may not hold a numbered one (#133)", () => {
    const result = Projection.projection(["first-name", "a.b", "plain", "has space"])
    expect(result.expression).toBe("#projn0, #projn1, #proj_plain, #projn3")
    expect(result.names).toEqual({
      "#projn0": "first-name",
      "#projn1": "a.b",
      "#proj_plain": "plain",
      "#projn3": "has space",
    })
  })
})
