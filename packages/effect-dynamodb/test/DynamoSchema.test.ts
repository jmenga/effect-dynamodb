import { describe, expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"

describe("DynamoSchema", () => {
  const schema = DynamoSchema.make({ name: "myapp", version: 1 })
  const uppercaseSchema = DynamoSchema.make({ name: "MyApp", version: 1, casing: "uppercase" })
  const preserveSchema = DynamoSchema.make({ name: "MyApp", version: 1, casing: "preserve" })

  describe("make", () => {
    it("creates with default lowercase casing", () => {
      expect(schema.casing).toBe("lowercase")
    })

    it("accepts explicit casing", () => {
      expect(uppercaseSchema.casing).toBe("uppercase")
    })
  })

  describe("prefix", () => {
    it("generates $name#vN format", () => {
      expect(DynamoSchema.prefix(schema)).toBe("$myapp#v1")
    })

    it("applies casing to name", () => {
      expect(DynamoSchema.prefix(uppercaseSchema)).toBe("$MYAPP#v1")
    })

    it("preserves casing when set to preserve", () => {
      expect(DynamoSchema.prefix(preserveSchema)).toBe("$MyApp#v1")
    })
  })

  describe("composeKey", () => {
    it("entity key with composites", () => {
      expect(DynamoSchema.composeKey(schema, "User", ["abc-123"])).toBe("$myapp#v1#user#abc-123")
    })

    it("entity key with empty composites", () => {
      expect(DynamoSchema.composeKey(schema, "User", [])).toBe("$myapp#v1#user")
    })

    it("entity key with multiple composites", () => {
      expect(DynamoSchema.composeKey(schema, "User", ["t-1", "active", "2024-01-15"])).toBe(
        "$myapp#v1#user#t-1#active#2024-01-15",
      )
    })

    it("applies casing to entity type only, not attribute values", () => {
      expect(DynamoSchema.composeKey(schema, "Employee", ["Alice@Example.com"])).toBe(
        "$myapp#v1#employee#Alice@Example.com",
      )
    })

    it("respects casing override", () => {
      expect(DynamoSchema.composeKey(schema, "User", ["abc"], { casing: "uppercase" })).toBe(
        "$myapp#v1#USER#abc",
      )
    })
  })

  describe("composeCollectionKey", () => {
    it("collection key with composites", () => {
      expect(DynamoSchema.composeCollectionKey(schema, "TenantItems", ["t-1"])).toBe(
        "$myapp#v1#tenantitems#t-1",
      )
    })

    it("collection key with empty composites", () => {
      expect(DynamoSchema.composeCollectionKey(schema, "TenantItems", [])).toBe(
        "$myapp#v1#tenantitems",
      )
    })
  })

  describe("composeClusteredSortKey", () => {
    it("clustered sort key with composites", () => {
      expect(
        DynamoSchema.composeClusteredSortKey(schema, "TenantItems", "User", 1, ["2024-01-15"]),
      ).toBe("$myapp#v1#tenantitems#user_1#2024-01-15")
    })

    it("clustered sort key with empty composites", () => {
      expect(DynamoSchema.composeClusteredSortKey(schema, "TenantItems", "User", 1, [])).toBe(
        "$myapp#v1#tenantitems#user_1",
      )
    })
  })

  describe("composeIsolatedSortKey", () => {
    it("isolated sort key with composites", () => {
      expect(DynamoSchema.composeIsolatedSortKey(schema, "User", 1, ["2024-01-15"])).toBe(
        "$myapp#v1#user_1#2024-01-15",
      )
    })
  })

  describe("composeUniqueKey", () => {
    it("generates pk and sk for unique constraint", () => {
      const result = DynamoSchema.composeUniqueKey(schema, "User", "email", ["alice@example.com"])
      expect(result.pk).toBe("$myapp#v1#user.email#alice@example.com")
      expect(result.sk).toBe("$myapp#v1#user.email")
    })

    it("compound unique key", () => {
      const result = DynamoSchema.composeUniqueKey(schema, "User", "tenantEmail", [
        "t-1",
        "alice@example.com",
      ])
      expect(result.pk).toBe("$myapp#v1#user.tenantemail#t-1#alice@example.com")
      expect(result.sk).toBe("$myapp#v1#user.tenantemail")
    })
  })

  describe("composeVersionKey", () => {
    it("generates zero-padded version sort key", () => {
      expect(DynamoSchema.composeVersionKey(schema, "User", 3)).toBe("$myapp#v1#user#v#0000003")
    })

    it("handles large version numbers", () => {
      expect(DynamoSchema.composeVersionKey(schema, "User", 1234567)).toBe(
        "$myapp#v1#user#v#1234567",
      )
    })
  })

  describe("composeDeletedKey", () => {
    it("generates deleted sort key with timestamp", () => {
      expect(DynamoSchema.composeDeletedKey(schema, "User", "2024-01-15T10:30:00Z")).toBe(
        "$myapp#v1#user#deleted#2024-01-15T10:30:00Z",
      )
    })
  })

  describe("composeVersionKeyPrefix", () => {
    it("generates version key prefix for begins_with queries", () => {
      expect(DynamoSchema.composeVersionKeyPrefix(schema, "User")).toBe("$myapp#v1#user#v#")
    })

    it("applies casing to entity type", () => {
      expect(DynamoSchema.composeVersionKeyPrefix(uppercaseSchema, "User")).toBe(
        "$MYAPP#v1#USER#v#",
      )
    })
  })

  describe("composeDeletedKeyPrefix", () => {
    it("generates deleted key prefix for begins_with queries", () => {
      expect(DynamoSchema.composeDeletedKeyPrefix(schema, "User")).toBe("$myapp#v1#user#deleted#")
    })

    it("applies casing to entity type", () => {
      expect(DynamoSchema.composeDeletedKeyPrefix(uppercaseSchema, "User")).toBe(
        "$MYAPP#v1#USER#deleted#",
      )
    })
  })

  describe("applyCasing", () => {
    it("lowercase", () => {
      expect(DynamoSchema.applyCasing("MyApp", "lowercase")).toBe("myapp")
    })

    it("uppercase", () => {
      expect(DynamoSchema.applyCasing("MyApp", "uppercase")).toBe("MYAPP")
    })

    it("preserve", () => {
      expect(DynamoSchema.applyCasing("MyApp", "preserve")).toBe("MyApp")
    })
  })
})
