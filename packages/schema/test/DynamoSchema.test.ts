import { describe, expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as KeyComposer from "../src/KeyComposer.js"

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

    it("applies casing to both entity type and attribute values", () => {
      expect(DynamoSchema.composeKey(schema, "Employee", ["Alice@Example.com"])).toBe(
        "$myapp#v1#employee#alice@example.com",
      )
    })

    it("respects casing override", () => {
      expect(DynamoSchema.composeKey(schema, "User", ["abc"], { casing: "uppercase" })).toBe(
        "$myapp#v1#USER#ABC",
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

  describe("history keys of one item in a shared partition (#133)", () => {
    const item = { item: "kind_a#seq_0000000002" }
    it("insert the item segment after the history marker", () => {
      expect(DynamoSchema.composeVersionKey(schema, "User", 3, item)).toBe(
        "$myapp#v1#user#v#kind_a#seq_0000000002#0000003",
      )
      expect(DynamoSchema.composeVersionKeyPrefix(schema, "User", item)).toBe(
        "$myapp#v1#user#v#kind_a#seq_0000000002#",
      )
      expect(DynamoSchema.composeDeletedKey(schema, "User", "2024-01-15T10:30:00Z", item)).toBe(
        "$myapp#v1#user#deleted#kind_a#seq_0000000002#2024-01-15T10:30:00Z",
      )
      expect(DynamoSchema.composeDeletedKeyPrefix(schema, "User", item)).toBe(
        "$myapp#v1#user#deleted#kind_a#seq_0000000002#",
      )
    })

    it("are byte-identical to the partition-wide keys without one", () => {
      for (const options of [undefined, {}, { item: undefined }, { item: "" }]) {
        expect(DynamoSchema.composeVersionKey(schema, "User", 1, options)).toBe(
          "$myapp#v1#user#v#0000001",
        )
        expect(DynamoSchema.composeDeletedKey(schema, "User", "t", options)).toBe(
          "$myapp#v1#user#deleted#t",
        )
      }
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

  // Storage format. These markers are written into keys that already exist in
  // tables, so changing how they are cased would orphan stored items. Most are
  // fixed literals that ignore casing; the time-series `e` infix is the
  // exception and has always followed it.
  describe("fixed key markers", () => {
    const at = (casing: DynamoSchema.Casing) =>
      DynamoSchema.make({ name: "App", version: 2, casing })

    it("version prefix `v` ignores casing", () => {
      expect(DynamoSchema.prefix(at("uppercase"))).toBe("$APP#v2")
      expect(DynamoSchema.prefix(at("preserve"))).toBe("$App#v2")
    })

    it("version snapshot `#v#` ignores casing", () => {
      expect(DynamoSchema.composeVersionKey(at("uppercase"), "User", 3)).toBe(
        "$APP#v2#USER#v#0000003",
      )
      expect(DynamoSchema.composeVersionKeyPrefix(at("preserve"), "User")).toBe("$App#v2#User#v#")
    })

    it("soft-delete `#deleted#` ignores casing", () => {
      expect(DynamoSchema.composeDeletedKey(at("uppercase"), "User", "2024-01-15T10:30:00Z")).toBe(
        "$APP#v2#USER#deleted#2024-01-15T10:30:00Z",
      )
      expect(DynamoSchema.composeDeletedKeyPrefix(at("preserve"), "User")).toBe(
        "$App#v2#User#deleted#",
      )
    })

    it("event-version `_1` marker ignores casing", () => {
      expect(DynamoSchema.composeEventVersionKey(at("uppercase"), "orders.event", 7)).toBe(
        "$APP#v2#ORDERS.EVENT_1#0000000007",
      )
      expect(DynamoSchema.composeEventVersionKeyPrefix(at("preserve"), "Orders.event")).toBe(
        "$App#v2#Orders.event_1#",
      )
    })

    it("time-series `#e#` infix follows casing", () => {
      expect(KeyComposer.composeEventSk("$APP#v2#METER", "Ab", "uppercase")).toBe(
        "$APP#v2#METER#E#AB",
      )
      expect(KeyComposer.composeEventSk("$app#v2#meter", "Ab", "lowercase")).toBe(
        "$app#v2#meter#e#ab",
      )
      expect(KeyComposer.composeEventSkPrefix("$App#v2#Meter", "preserve")).toBe("$App#v2#Meter#e#")
    })
  })
})
