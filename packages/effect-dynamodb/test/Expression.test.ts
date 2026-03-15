import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import * as Expression from "../src/Expression.js"

describe("Expression", () => {
  describe("condition", () => {
    it("builds eq condition", () => {
      const result = Expression.condition({
        eq: { status: "active" },
      })

      expect(result.expression).toBe("#status = :v0")
      expect(result.names).toEqual({ "#status": "status" })
      expect(result.values[":v0"]).toEqual({ S: "active" })
    })

    it("builds ne condition", () => {
      const result = Expression.condition({
        ne: { status: "deleted" },
      })

      expect(result.expression).toBe("#status <> :v0")
      expect(result.names).toEqual({ "#status": "status" })
    })

    it("builds multiple comparison operators", () => {
      const result = Expression.condition({
        eq: { status: "active" },
        gt: { quantity: 5 },
      })

      expect(result.expression).toBe("#status = :v0 AND #quantity > :v1")
      expect(result.names).toEqual({ "#status": "status", "#quantity": "quantity" })
    })

    it("builds between condition", () => {
      const result = Expression.condition({
        between: { price: [10, 50] },
      })

      expect(result.expression).toBe("#price BETWEEN :v0 AND :v1")
      expect(result.names).toEqual({ "#price": "price" })
    })

    it("builds beginsWith condition", () => {
      const result = Expression.condition({
        beginsWith: { name: "A" },
      })

      expect(result.expression).toBe("begins_with(#name, :v0)")
      expect(result.names).toEqual({ "#name": "name" })
      expect(result.values[":v0"]).toEqual({ S: "A" })
    })

    it("builds attributeExists condition (single)", () => {
      const result = Expression.condition({
        attributeExists: "email",
      })

      expect(result.expression).toBe("attribute_exists(#email)")
      expect(result.names).toEqual({ "#email": "email" })
      expect(result.values).toEqual({})
    })

    it("builds attributeExists condition (array)", () => {
      const result = Expression.condition({
        attributeExists: ["email", "name"],
      })

      expect(result.expression).toBe("attribute_exists(#email) AND attribute_exists(#name)")
    })

    it("builds attributeNotExists condition", () => {
      const result = Expression.condition({
        attributeNotExists: "deletedAt",
      })

      expect(result.expression).toBe("attribute_not_exists(#deletedAt)")
    })

    it("combines multiple condition types with AND", () => {
      const result = Expression.condition({
        eq: { status: "active" },
        attributeExists: "email",
        gt: { quantity: 0 },
      })

      expect(result.expression).toContain(" AND ")
      // All three conditions should be present
      expect(result.expression).toContain("#status = :v0")
      expect(result.expression).toContain("#quantity > :v1")
      expect(result.expression).toContain("attribute_exists(#email)")
    })

    it("builds le and ge conditions", () => {
      const result = Expression.condition({
        le: { endDate: "2026-12-31" },
        ge: { startDate: "2026-01-01" },
      })

      expect(result.expression).toBe("#endDate <= :v0 AND #startDate >= :v1")
    })
  })

  describe("filter", () => {
    it("builds filter expression (same syntax as condition)", () => {
      const result = Expression.filter({
        gt: { quantity: 5 },
        beginsWith: { name: "A" },
      })

      expect(result.expression).toContain("#quantity > :v0")
      expect(result.expression).toContain("begins_with(#name, :v1)")
      expect(result.expression).toContain(" AND ")
    })
  })

  describe("update", () => {
    it("builds SET expression", () => {
      const result = Expression.update({
        set: { email: "new@example.com", name: "Updated" },
      })

      expect(result.expression).toBe("SET #email = :v0, #name = :v1")
      expect(result.names).toEqual({ "#email": "email", "#name": "name" })
      expect(result.values[":v0"]).toEqual({ S: "new@example.com" })
      expect(result.values[":v1"]).toEqual({ S: "Updated" })
    })

    it("builds REMOVE expression", () => {
      const result = Expression.update({
        remove: ["obsoleteField", "tempData"],
      })

      expect(result.expression).toBe("REMOVE #obsoleteField, #tempData")
      expect(result.names).toEqual({
        "#obsoleteField": "obsoleteField",
        "#tempData": "tempData",
      })
      expect(result.values).toEqual({})
    })

    it("builds ADD expression", () => {
      const result = Expression.update({
        add: { viewCount: 1 },
      })

      expect(result.expression).toBe("ADD #viewCount :v0")
      expect(result.values[":v0"]).toEqual({ N: "1" })
    })

    it("builds DELETE expression", () => {
      const result = Expression.update({
        delete: { tags: new Set(["old-tag"]) },
      })

      expect(result.expression).toContain("DELETE #tags :v0")
    })

    it("combines SET and REMOVE in one expression", () => {
      const result = Expression.update({
        set: { email: "new@example.com", updatedAt: "2026-02-15" },
        remove: ["obsoleteField"],
      })

      expect(result.expression).toBe("SET #email = :v0, #updatedAt = :v1 REMOVE #obsoleteField")
      expect(Object.keys(result.names)).toHaveLength(3)
    })

    it("combines all four update actions", () => {
      const result = Expression.update({
        set: { name: "Updated" },
        remove: ["tempField"],
        add: { counter: 1 },
        delete: { tags: new Set(["old"]) },
      })

      expect(result.expression).toContain("SET")
      expect(result.expression).toContain("REMOVE")
      expect(result.expression).toContain("ADD")
      expect(result.expression).toContain("DELETE")
    })

    it("produces empty expression for empty input", () => {
      const result = Expression.update({})

      expect(result.expression).toBe("")
      expect(result.names).toEqual({})
      expect(result.values).toEqual({})
    })

    it("handles numeric SET values", () => {
      const result = Expression.update({
        set: { quantity: 42 },
      })

      expect(result.expression).toBe("SET #quantity = :v0")
      expect(result.values[":v0"]).toEqual({ N: "42" })
    })
  })
})
