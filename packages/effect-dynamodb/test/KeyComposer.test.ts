import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as KeyComposer from "../src/KeyComposer.js"

describe("KeyComposer", () => {
  const schema = DynamoSchema.make({ name: "myapp", version: 1 })

  describe("extractComposites", () => {
    it("extracts values in order", () => {
      const result = KeyComposer.extractComposites(["tenantId", "email"], {
        tenantId: "t-1",
        email: "a@b.com",
        name: "Alice",
      })
      expect(result).toEqual(["t-1", "a@b.com"])
    })

    it("returns empty array for empty composite", () => {
      expect(KeyComposer.extractComposites([], {})).toEqual([])
    })

    it("throws for missing attribute", () => {
      expect(() => KeyComposer.extractComposites(["missing"], {})).toThrow(
        'Missing composite attribute "missing"',
      )
    })
  })

  describe("serializeValue", () => {
    it("strings pass through", () => {
      expect(KeyComposer.serializeValue("hello")).toBe("hello")
    })

    it("numbers are zero-padded to 16 digits", () => {
      expect(KeyComposer.serializeValue(42)).toBe("0000000000000042")
      expect(KeyComposer.serializeValue(0)).toBe("0000000000000000")
      expect(KeyComposer.serializeValue(9007199254740991)).toBe("9007199254740991") // MAX_SAFE_INTEGER
    })

    it("bigints are zero-padded to 38 digits", () => {
      expect(KeyComposer.serializeValue(42n)).toBe("00000000000000000000000000000000000042")
      expect(KeyComposer.serializeValue(0n)).toBe("00000000000000000000000000000000000000")
    })

    it("booleans stringify", () => {
      expect(KeyComposer.serializeValue(true)).toBe("true")
      expect(KeyComposer.serializeValue(false)).toBe("false")
    })

    it("DateTime.Utc serializes to ISO string", () => {
      const dt = DateTime.makeUnsafe(1704067200000)
      expect(KeyComposer.serializeValue(dt)).toBe("2024-01-01T00:00:00.000Z")
    })

    it("DateTime.Zoned serializes to UTC ISO string (normalized)", () => {
      const utc = DateTime.makeUnsafe("2024-01-01T06:00:00Z")
      const zoned = DateTime.makeZonedUnsafe(utc, { timeZone: "Asia/Tokyo" })
      // Should normalize to UTC for consistent sort order
      expect(KeyComposer.serializeValue(zoned)).toBe("2024-01-01T06:00:00.000Z")
    })

    it("native Date serializes to ISO string", () => {
      const d = new Date(1704067200000)
      expect(KeyComposer.serializeValue(d)).toBe("2024-01-01T00:00:00.000Z")
    })
  })

  describe("composePk", () => {
    it("entity pk with composites", () => {
      const index: KeyComposer.IndexDefinition = {
        pk: { field: "pk", composite: ["userId"] },
        sk: { field: "sk", composite: [] },
      }
      expect(KeyComposer.composePk(schema, "User", index, { userId: "abc-123" })).toBe(
        "$myapp#v1#user#userid_abc-123",
      )
    })

    it("entity pk with empty composites", () => {
      const index: KeyComposer.IndexDefinition = {
        pk: { field: "pk", composite: [] },
        sk: { field: "sk", composite: [] },
      }
      expect(KeyComposer.composePk(schema, "User", index, {})).toBe("$myapp#v1#user")
    })

    it("collection pk uses collection name", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        collection: "TenantItems",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["createdAt"] },
      }
      expect(KeyComposer.composePk(schema, "User", index, { tenantId: "t-1" })).toBe(
        "$myapp#v1#tenantitems#tenantid_t-1",
      )
    })
  })

  describe("composeSk", () => {
    it("non-collection sk", () => {
      const index: KeyComposer.IndexDefinition = {
        pk: { field: "pk", composite: ["userId"] },
        sk: { field: "sk", composite: [] },
      }
      expect(KeyComposer.composeSk(schema, "User", 1, index, {})).toBe("$myapp#v1#user")
    })

    it("clustered collection sk", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        collection: "TenantItems",
        type: "clustered",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["createdAt"] },
      }
      expect(KeyComposer.composeSk(schema, "User", 1, index, { createdAt: "2024-01-15" })).toBe(
        "$myapp#v1#tenantitems#user_1#createdat_2024-01-15",
      )
    })

    it("isolated collection sk", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        collection: "TenantItems",
        type: "isolated",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["createdAt"] },
      }
      expect(KeyComposer.composeSk(schema, "User", 1, index, { createdAt: "2024-01-15" })).toBe(
        "$myapp#v1#user_1#createdat_2024-01-15",
      )
    })

    it("clustered sub-collection sk writes the full hierarchy", () => {
      // Sub-collection: collection is a [parent, child] array
      const index: KeyComposer.IndexDefinition = {
        index: "gsi2",
        collection: ["contributions", "assignments"],
        type: "clustered",
        pk: { field: "gsi2pk", composite: ["employeeId"] },
        sk: { field: "gsi2sk", composite: ["projectId"] },
      }
      // SK contains BOTH levels — a begins_with at "contributions" or
      // "contributions#assignments" both match.
      expect(KeyComposer.composeSk(schema, "Task", 1, index, { projectId: "p-1" })).toBe(
        "$myapp#v1#contributions#assignments#task_1#projectid_p-1",
      )
    })

    it("clustered single-element array collection sk is equivalent to a string", () => {
      const arrayIndex: KeyComposer.IndexDefinition = {
        index: "gsi2",
        collection: ["contributions"],
        type: "clustered",
        pk: { field: "gsi2pk", composite: ["employeeId"] },
        sk: { field: "gsi2sk", composite: ["department"] },
      }
      const stringIndex: KeyComposer.IndexDefinition = {
        ...arrayIndex,
        collection: "contributions",
      }
      const arraySk = KeyComposer.composeSk(schema, "Employee", 1, arrayIndex, {
        department: "engineering",
      })
      const stringSk = KeyComposer.composeSk(schema, "Employee", 1, stringIndex, {
        department: "engineering",
      })
      expect(arraySk).toBe(stringSk)
      expect(arraySk).toBe("$myapp#v1#contributions#employee_1#department_engineering")
    })
  })

  describe("composeIndexKeys", () => {
    it("composes pk and sk for a primary index", () => {
      const index: KeyComposer.IndexDefinition = {
        pk: { field: "pk", composite: ["userId"] },
        sk: { field: "sk", composite: [] },
      }
      const result = KeyComposer.composeIndexKeys(schema, "User", 1, index, { userId: "u-1" })
      expect(result).toEqual({
        pk: "$myapp#v1#user#userid_u-1",
        sk: "$myapp#v1#user",
      })
    })
  })

  describe("composeAllKeys", () => {
    it("composes keys for all indexes", () => {
      const indexes: Record<string, KeyComposer.IndexDefinition> = {
        primary: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        byEmail: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["email"] },
          sk: { field: "gsi1sk", composite: [] },
        },
      }
      const result = KeyComposer.composeAllKeys(schema, "User", 1, indexes, {
        userId: "u-1",
        email: "alice@example.com",
      })
      expect(result).toEqual({
        pk: "$myapp#v1#user#userid_u-1",
        sk: "$myapp#v1#user",
        gsi1pk: "$myapp#v1#user#email_alice@example.com",
        gsi1sk: "$myapp#v1#user",
      })
    })
  })

  describe("tryExtractComposites", () => {
    it("returns values when all composites are present", () => {
      const result = KeyComposer.tryExtractComposites(["tenantId", "email"], {
        tenantId: "t-1",
        email: "a@b.com",
        name: "Alice",
      })
      expect(result).toEqual(["t-1", "a@b.com"])
    })

    it("returns undefined when any composite is missing", () => {
      expect(
        KeyComposer.tryExtractComposites(["tenantId", "email"], { tenantId: "t-1" }),
      ).toBeUndefined()
    })

    it("returns undefined when a composite is null", () => {
      expect(KeyComposer.tryExtractComposites(["tenantId"], { tenantId: null })).toBeUndefined()
    })

    it("returns empty array for empty composite list", () => {
      expect(KeyComposer.tryExtractComposites([], {})).toEqual([])
    })
  })

  describe("tryComposeIndexKeys", () => {
    it("returns keys when all composites present", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["email"] },
        sk: { field: "gsi1sk", composite: [] },
      }
      const result = KeyComposer.tryComposeIndexKeys(schema, "User", 1, index, { email: "a@b.com" })
      expect(result).toEqual({
        gsi1pk: "$myapp#v1#user#email_a@b.com",
        gsi1sk: "$myapp#v1#user",
      })
    })

    it("returns undefined when pk composite is missing", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["email"] },
        sk: { field: "gsi1sk", composite: [] },
      }
      expect(KeyComposer.tryComposeIndexKeys(schema, "User", 1, index, {})).toBeUndefined()
    })

    it("returns undefined when sk composite is missing", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["region"] },
      }
      expect(
        KeyComposer.tryComposeIndexKeys(schema, "User", 1, index, { tenantId: "t-1" }),
      ).toBeUndefined()
    })
  })

  describe("composeAllKeys (sparse GSI)", () => {
    it("skips GSI with missing composites", () => {
      const indexes: Record<string, KeyComposer.IndexDefinition> = {
        primary: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        byTenant: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["tenantId"] },
          sk: { field: "gsi1sk", composite: ["region"] },
        },
      }
      // tenantId and region are missing — GSI should be skipped
      const result = KeyComposer.composeAllKeys(schema, "User", 1, indexes, {
        userId: "u-1",
      })
      expect(result).toEqual({
        pk: "$myapp#v1#user#userid_u-1",
        sk: "$myapp#v1#user",
      })
      expect(result).not.toHaveProperty("gsi1pk")
      expect(result).not.toHaveProperty("gsi1sk")
    })

    it("still throws for missing primary composites", () => {
      const indexes: Record<string, KeyComposer.IndexDefinition> = {
        primary: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
      }
      expect(() => KeyComposer.composeAllKeys(schema, "User", 1, indexes, {})).toThrow(
        'Missing composite attribute "userId"',
      )
    })

    it("handles mixed: some GSIs complete, some sparse", () => {
      const indexes: Record<string, KeyComposer.IndexDefinition> = {
        primary: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        byEmail: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["email"] },
          sk: { field: "gsi1sk", composite: [] },
        },
        byTenant: {
          index: "gsi2",
          pk: { field: "gsi2pk", composite: ["tenantId"] },
          sk: { field: "gsi2sk", composite: ["region"] },
        },
      }
      const result = KeyComposer.composeAllKeys(schema, "User", 1, indexes, {
        userId: "u-1",
        email: "a@b.com",
        // tenantId and region missing — gsi2 skipped
      })
      expect(result.pk).toBe("$myapp#v1#user#userid_u-1")
      expect(result.gsi1pk).toBe("$myapp#v1#user#email_a@b.com")
      expect(result).not.toHaveProperty("gsi2pk")
      expect(result).not.toHaveProperty("gsi2sk")
    })
  })

  describe("composeGsiKeysForUpdatePolicyAware", () => {
    // pk.composite = [A], sk.composite = [B, C]  — canonical shape for the matrix below
    const makeIndexes = (
      indexPolicy?: KeyComposer.IndexPolicy,
    ): Record<string, KeyComposer.IndexDefinition> => ({
      primary: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
      byABC: {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["A"] },
        sk: { field: "gsi1sk", composite: ["B", "C"] },
        indexPolicy,
      },
    })

    // --- 1. Default policy (no indexPolicy) — all attrs preserve ---

    it("all composites present → SET both halves (no policy)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(),
        { A: "a", B: "b", C: "c" },
        { id: "i-1" },
      )
      expect(result.sets).toHaveProperty("gsi1pk")
      expect(result.sets).toHaveProperty("gsi1sk")
      expect(result.removes).toEqual([])
    })

    it("only A in payload, no policy → SET pk; sk untouched (preserve default)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(),
        { A: "a" },
        { id: "i-1" },
      )
      expect(result.sets).toHaveProperty("gsi1pk")
      expect(result.sets).not.toHaveProperty("gsi1sk")
      expect(result.removes).toEqual([])
    })

    it("only B in payload, no policy → both halves untouched (C missing preserve)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(),
        { B: "b" },
        { id: "i-1" },
      )
      expect(result.sets).toEqual({})
      expect(result.removes).toEqual([])
    })

    it("{A, B} in payload, no policy → SET pk; sk untouched (C missing preserve)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(),
        { A: "a", B: "b" },
        { id: "i-1" },
      )
      expect(result.sets).toHaveProperty("gsi1pk")
      expect(result.sets).not.toHaveProperty("gsi1sk")
      expect(result.removes).toEqual([])
    })

    it("{B, C} in payload, no policy → SET sk; pk untouched (A missing preserve)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(),
        { B: "b", C: "c" },
        { id: "i-1" },
      )
      expect(result.sets).not.toHaveProperty("gsi1pk")
      expect(result.sets).toHaveProperty("gsi1sk")
      expect(result.removes).toEqual([])
    })

    // --- 2. Sparse policy ---

    it("A sparse + A missing → REMOVE both halves (sparse wins)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({ A: "sparse" })),
        { B: "b", C: "c" },
        { id: "i-1" },
      )
      expect(result.sets).toEqual({})
      expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    it("A sparse + A present → SET both halves (no dropout)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({ A: "sparse" })),
        { A: "a", B: "b", C: "c" },
        { id: "i-1" },
      )
      expect(result.sets).toHaveProperty("gsi1pk")
      expect(result.sets).toHaveProperty("gsi1sk")
      expect(result.removes).toEqual([])
    })

    it("B sparse + C preserve, C present, B missing → REMOVE both (sparse wins)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({ B: "sparse", C: "preserve" })),
        { A: "a", C: "c" },
        { id: "i-1" },
      )
      expect(result.sets).toEqual({})
      expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    it("B preserve + C sparse, B present, C missing → REMOVE both (sparse wins)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({ B: "preserve", C: "sparse" })),
        { A: "a", B: "b" },
        { id: "i-1" },
      )
      expect(result.sets).toEqual({})
      expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    it("explicit A preserve with {B, C} → SET sk; pk untouched (same as default)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({ A: "preserve" })),
        { B: "b", C: "c" },
        { id: "i-1" },
      )
      expect(result.sets).not.toHaveProperty("gsi1pk")
      expect(result.sets).toHaveProperty("gsi1sk")
      expect(result.removes).toEqual([])
    })

    it("A explicit null in merged is treated as missing (sparse)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({ A: "sparse" })),
        { A: null, B: "b", C: "c" },
        { id: "i-1" },
      )
      expect(result.sets).toEqual({})
      expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    // --- 3. Policy function behaviour ---

    it("policy function returns empty → all attrs preserve", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({})),
        { A: "a" },
        { id: "i-1" },
      )
      expect(result.sets).toHaveProperty("gsi1pk")
      expect(result.sets).not.toHaveProperty("gsi1sk")
      expect(result.removes).toEqual([])
    })

    it("policy function receives merged record for item-dependent decisions", () => {
      const received: Array<Record<string, unknown>> = []
      const policy: KeyComposer.IndexPolicy = (item) => {
        received.push(item as Record<string, unknown>)
        return item.A === "x" ? { A: "sparse" } : { A: "preserve" }
      }
      // Case 1: A === "x" → sparse → REMOVE
      const r1 = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(policy),
        { A: "x", B: "b", C: "c" }, // A present but policy recomputes; both halves present → SET (sparse only fires when missing)
        { id: "i-1" },
      )
      expect(r1.sets).toHaveProperty("gsi1pk")
      expect(r1.sets).toHaveProperty("gsi1sk")

      // Case 2: A missing, policy returns sparse based on B value → REMOVE
      const r2 = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes((item) => (item.B === "drop" ? { A: "sparse" } : {})),
        { B: "drop" },
        { id: "i-1" },
      )
      expect(r2.removes).toEqual(["gsi1pk", "gsi1sk"])
      expect(received.length).toBeGreaterThan(0)
    })

    // --- 4. Touched gate ---

    it("GSI without indexPolicy + no composites in payload → skipped", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(), // no indexPolicy
        { unrelated: "x" },
        { id: "i-1" },
      )
      expect(result.sets).toEqual({})
      expect(result.removes).toEqual([])
    })

    it("GSI WITH indexPolicy is always evaluated, even when no composite in payload (sparse drop)", () => {
      // Declaring indexPolicy opts the GSI into event-style evaluation: the
      // policy fires on every update. Absent from payload = absent from the
      // event = sparse rule applies.
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({ A: "sparse" })),
        { unrelated: "x" }, // A, B, C all absent from payload
        { id: "i-1" },
      )
      expect(result.sets).toEqual({})
      expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    it("GSI with indexPolicy (all preserve) + no composite in payload → halves left alone", () => {
      // Preserve policy + absent composites → leave halves alone. Evaluated
      // but no writes emitted.
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve" })),
        { unrelated: "x" },
        { id: "i-1" },
      )
      expect(result.sets).toEqual({})
      expect(result.removes).toEqual([])
    })

    // --- 5. Cascade REMOVE (Entity.remove of composite) ---

    it("REMOVE cascade of composite A → REMOVE both halves regardless of policy", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(() => ({ A: "preserve" })), // preserve says don't touch…
        {},
        { id: "i-1" },
        { removedSet: new Set(["A"]) }, // …but cascade overrides
      )
      expect(result.sets).toEqual({})
      expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    it("REMOVE cascade without any payload still fires (cascade is a touch signal)", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeIndexes(),
        {},
        { id: "i-1" },
        { removedSet: new Set(["B"]) },
      )
      expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    // --- 6. Multiple GSIs with independent evaluation ---

    it("two GSIs with different policies are evaluated independently", () => {
      const indexes: Record<string, KeyComposer.IndexDefinition> = {
        primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
        g1: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["A"] },
          sk: { field: "gsi1sk", composite: ["B"] },
          indexPolicy: () => ({ A: "sparse", B: "sparse" }),
        },
        g2: {
          index: "gsi2",
          pk: { field: "gsi2pk", composite: ["C"] },
          sk: { field: "gsi2sk", composite: ["D"] },
          indexPolicy: () => ({ C: "preserve", D: "preserve" }),
        },
      }
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        indexes,
        { A: "a", C: "c" }, // g1: B missing sparse → REMOVE; g2: D missing preserve + C present → SET pk, sk untouched
        { id: "i-1" },
      )
      expect(result.removes).toContain("gsi1pk")
      expect(result.removes).toContain("gsi1sk")
      expect(result.sets).toHaveProperty("gsi2pk")
      expect(result.sets).not.toHaveProperty("gsi2sk")
    })

    // --- 7. keyRecord merging ---

    it("PK composites from keyRecord fill in for GSI composites", () => {
      const indexes: Record<string, KeyComposer.IndexDefinition> = {
        primary: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        byUserRole: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["role"] },
          sk: { field: "gsi1sk", composite: ["userId"] },
        },
      }
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "User",
        1,
        indexes,
        { role: "admin" },
        { userId: "u-1" },
      )
      expect(result.sets.gsi1pk).toBeDefined()
      expect(result.sets.gsi1sk).toBeDefined()
    })
  })

  describe("composeSortKeyPrefix", () => {
    it("partial sk for begins_with queries", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        collection: "TenantItems",
        type: "clustered",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["department", "hireDate"] },
      }
      // Only department provided, hireDate missing
      const result = KeyComposer.composeSortKeyPrefix(schema, "Employee", 1, index, {
        department: "engineering",
      })
      expect(result).toBe("$myapp#v1#tenantitems#employee_1#department_engineering")
    })

    it("full sk when all composites provided", () => {
      const index: KeyComposer.IndexDefinition = {
        pk: { field: "pk", composite: ["userId"] },
        sk: { field: "sk", composite: ["status"] },
      }
      const result = KeyComposer.composeSortKeyPrefix(schema, "Task", 1, index, {
        status: "active",
      })
      expect(result).toBe("$myapp#v1#task#status_active")
    })
  })

  // ---------------------------------------------------------------------------
  // v2 — three-way classification + hierarchical SK pruning + hole detection
  // (DESIGN.md §7 + §7.6, refs #36)
  // ---------------------------------------------------------------------------

  describe("composeGsiKeysForUpdatePolicyAware — v2 three-way classification", () => {
    // Hierarchical-friendly shape: pk.composite=[A], sk.composite=[B, C, D]
    const makeHierIndexes = (
      indexPolicy?: KeyComposer.IndexPolicy,
    ): Record<string, KeyComposer.IndexDefinition> => ({
      primary: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
      hier: {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["A"] },
        sk: { field: "gsi1sk", composite: ["B", "C", "D"] },
        indexPolicy,
      },
    })

    // --- Three-way classification: null ≡ undefined; auto-derived clearedSet ---

    it("explicit null and explicit undefined collapse — both behave as cleared", () => {
      // Null on PK composite → drop.
      const r1 = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve" })),
        { A: null, B: "b", C: "c", D: "d" },
        { id: "i-1" },
      )
      expect(r1.removes).toEqual(["gsi1pk", "gsi1sk"])

      // Undefined on PK composite → drop (collapse with null).
      const r2 = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve" })),
        { A: undefined, B: "b", C: "c", D: "d" },
        { id: "i-1" },
      )
      expect(r2.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    it("clearedSet auto-derives from null/undefined values in updatePayload", () => {
      // No explicit clearedSet passed; derived from B: null → SK truncate.
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve", D: "preserve" })),
        { A: "a", B: null },
        { id: "i-1" },
      )
      // pk fully present → SET. sk truncated at position 0 (B) → empty leading
      // prefix → SET to bare entity prefix.
      expect(r.sets.gsi1pk).toBeDefined()
      expect(r.sets.gsi1sk).toBe("$myapp#v1#e")
      expect(r.removes).toEqual([])
    })

    it("explicit clearedSet option drives truncation even when payload has no nulls", () => {
      // D explicitly cleared via option (not via null in payload). With B
      // and C present and D being the last SK composite, this is a clean
      // trailing truncation.
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve", D: "preserve" })),
        { A: "a", B: "b", C: "c" },
        { id: "i-1" },
        { clearedSet: new Set(["D"]) },
      )
      // SK truncated at D (position 2) → leading prefix [B, C].
      expect(r.sets.gsi1sk).toBe("$myapp#v1#e#b_b#c_c")
      expect(r.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
      expect(r.removes).toEqual([])
    })

    // --- PK clear cascades unconditionally regardless of policy ---

    it("PK composite explicit-cleared with preserve policy → DROP (PK degrades to sparse)", () => {
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve" })),
        { A: null, B: "b", C: "c", D: "d" },
        { id: "i-1" },
      )
      expect(r.sets).toEqual({})
      expect(r.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    // --- SK preserve-truncate + sparse-drop ---

    it("SK trailing composite cleared with preserve → SK truncates", () => {
      // Stored values: A, B, C, D all present; user clears D.
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve", D: "preserve" })),
        { D: null },
        { id: "i-1", A: "a", B: "b", C: "c" },
      )
      // SK truncated at D (position 2) → leading prefix [B, C].
      expect(r.sets.gsi1sk).toBe("$myapp#v1#e#b_b#c_c")
      // PK side recomposes (all PK present).
      expect(r.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
      expect(r.removes).toEqual([])
    })

    it("SK middle composite cleared with preserve and trailing absent → truncate", () => {
      // User clears C; D not in payload and not in stored merge.
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve", D: "preserve" })),
        { C: null },
        { id: "i-1", A: "a", B: "b" },
      )
      // SK truncated at C (position 1) → leading prefix [B].
      expect(r.sets.gsi1sk).toBe("$myapp#v1#e#b_b")
      expect(r.removes).toEqual([])
    })

    it("SK first composite cleared with preserve → truncate to base prefix", () => {
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve", D: "preserve" })),
        { B: null },
        { id: "i-1", A: "a" },
      )
      // SK truncated at B (position 0) → leading prefix is empty.
      expect(r.sets.gsi1sk).toBe("$myapp#v1#e")
      expect(r.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
    })

    it("SK composite cleared with sparse policy → DROP (not truncate)", () => {
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ B: "preserve", C: "sparse", D: "preserve" })),
        { C: null },
        { id: "i-1", A: "a", B: "b" },
      )
      expect(r.sets).toEqual({})
      expect(r.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    // --- Hole detection ---

    it("hole — clear at position i with present at j > i → throw EDD-9024", () => {
      expect(() =>
        KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeHierIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve", D: "preserve" })),
          // B cleared at SK position 0; C present at position 1 (a hole).
          { B: null },
          { id: "i-1", A: "a", C: "c" },
        ),
      ).toThrow(/EDD-9024/)
    })

    it("hole error names the GSI, the cleared composite, and the (first) trailing composite", () => {
      try {
        KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeHierIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve", D: "preserve" })),
          // B cleared at SK position 0; both C and D still present. The error
          // reports the first trailing composite found (C at position 1).
          { B: null },
          { id: "i-1", A: "a", C: "c", D: "d" },
        )
      } catch (e) {
        expect(e).toMatchObject({
          _tag: "CompositeKeyHoleError",
          indexName: "gsi1",
          clearedComposite: "B",
          trailingComposite: "C",
          half: "sk",
        })
        const msg = (e as { message: string }).message
        expect(msg).toContain("EDD-9024")
        expect(msg).toContain("gsi1")
        expect(msg).toContain('"B"')
        expect(msg).toContain('"C"')
        return
      }
      throw new Error("expected throw")
    })

    it("multi-clear at consecutive trailing positions is OK (no hole)", () => {
      // Clear C and D, both trailing. No hole.
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve", D: "preserve" })),
        { C: null, D: null },
        { id: "i-1", A: "a", B: "b" },
      )
      expect(r.sets.gsi1sk).toBe("$myapp#v1#e#b_b")
      expect(r.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
      expect(r.removes).toEqual([])
    })

    // --- Cascade override unchanged ---

    it("cascade Entity.remove([attr]) overrides preserve-truncate", () => {
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        makeHierIndexes(() => ({ A: "preserve", B: "preserve", C: "preserve", D: "preserve" })),
        { B: null },
        { id: "i-1", A: "a" },
        { removedSet: new Set(["B"]) },
      )
      // Cascade wins → DROP, not truncate.
      expect(r.sets).toEqual({})
      expect(r.removes).toEqual(["gsi1pk", "gsi1sk"])
    })

    // --- Reproducer of the consumer footgun (issue #36) ---

    it("partial-update payload that omits sparse-policied composites does NOT generate REMOVE under preserve", () => {
      // Captured shape from consumer report: a 5-GSI entity with mostly
      // `preserve` policies. A partial update that doesn't mention the
      // sparse-policied composites should not REMOVE their key fields.
      const indexes: Record<string, KeyComposer.IndexDefinition> = {
        primary: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        // Three GSIs that previously mis-fired sparse on every partial update.
        // Under v2, switching them to preserve makes them no-ops on omission.
        gA: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["X"] },
          sk: { field: "gsi1sk", composite: ["id"] },
          indexPolicy: () => ({ X: "preserve" }),
        },
        gB: {
          index: "gsi2",
          pk: { field: "gsi2pk", composite: ["Y"] },
          sk: { field: "gsi2sk", composite: ["id"] },
          indexPolicy: () => ({ Y: "preserve" }),
        },
        gC: {
          index: "gsi3",
          pk: { field: "gsi3pk", composite: ["Z"] },
          sk: { field: "gsi3sk", composite: ["id"] },
          indexPolicy: () => ({ Z: "preserve" }),
        },
      }
      // User updates only `name` — never mentions X, Y, Z.
      const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "E",
        1,
        indexes,
        { name: "new-name" },
        { id: "i-1" },
      )
      // Zero REMOVEs — the v1 footgun is closed.
      expect(r.removes).toEqual([])
      // The id-bearing SK halves recompose (PK halves no-op because X/Y/Z
      // are absent and preserve).
      expect(r.sets.gsi1sk).toBeDefined()
      expect(r.sets.gsi2sk).toBeDefined()
      expect(r.sets.gsi3sk).toBeDefined()
      expect(r.sets.gsi1pk).toBeUndefined()
      expect(r.sets.gsi2pk).toBeUndefined()
      expect(r.sets.gsi3pk).toBeUndefined()
    })
  })

  describe("composeSkPrefixUpTo", () => {
    it("composes leading prefix for non-collection isolated SK", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["A"] },
        sk: { field: "gsi1sk", composite: ["B", "C", "D"] },
      }
      const result = KeyComposer.composeSkPrefixUpTo(
        schema,
        "E",
        1,
        index,
        { B: "b-val", C: "c-val", D: "d-val" },
        2, // truncate at D position → keep [B, C]
      )
      expect(result).toBe("$myapp#v1#e#b_b-val#c_c-val")
    })

    it("composes empty leading prefix when stopBefore is 0", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["A"] },
        sk: { field: "gsi1sk", composite: ["B", "C"] },
      }
      const result = KeyComposer.composeSkPrefixUpTo(schema, "E", 1, index, { B: "b", C: "c" }, 0)
      expect(result).toBe("$myapp#v1#e")
    })

    it("composes leading prefix for clustered collection SK", () => {
      const index: KeyComposer.IndexDefinition = {
        index: "gsi1",
        collection: "Org",
        type: "clustered",
        pk: { field: "gsi1pk", composite: ["division"] },
        sk: { field: "gsi1sk", composite: ["department", "team", "squad"] },
      }
      const result = KeyComposer.composeSkPrefixUpTo(
        schema,
        "Engineer",
        1,
        index,
        { department: "platform", team: "infra", squad: "storage" },
        2, // keep [department, team]
      )
      expect(result).toBe("$myapp#v1#org#engineer_1#department_platform#team_infra")
    })
  })
})
