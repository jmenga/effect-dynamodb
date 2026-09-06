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

  // ---------------------------------------------------------------------------
  // composeGsiKeysForUpdatePolicyAware — v1.7.1 per-half model
  // (DESIGN.md §7, closes #41)
  //
  // Canonical fixture: pk.composite = [A], sk.composite = [B, C]. Tests cover
  // the four pillars of the unified per-half model:
  //   1. Per-half evaluation gate — untouched halves are skipped entirely.
  //   2. Structural rule — longest leading prefix; trailing-absent truncates.
  //   3. Per-half outcome — SET / noop (preserve+can't-compose+no-cascade) /
  //      REMOVE (sparse OR preserve+cascade-override).
  //   4. Per-half cascade — Entity.remove([attr]) affects only the half(s)
  //      whose composite list contains the attr; other halves follow the gate.
  //
  // Key v1.7.1 deltas vs v1.7.0 (asserted explicitly throughout):
  //   - Untouched-half scenarios noop instead of firing the policy.
  //   - Per-half cascade replaces GSI-wide REMOVE on cascade.
  //   - Per-half cascade replaces GSI-wide REMOVE on can't-compose under sparse.
  //   - No EDD-9024 throw — hole patterns collapse into can't-compose.
  // ---------------------------------------------------------------------------

  describe("composeGsiKeysForUpdatePolicyAware — v1.7.1 per-half model", () => {
    const makeIndexes = (
      indexPolicy?: KeyComposer.IndexPolicy,
    ): Record<string, KeyComposer.IndexDefinition> => ({
      primary: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
      g1: {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["A"] },
        sk: { field: "gsi1sk", composite: ["B", "C"] },
        ...(indexPolicy ? { indexPolicy } : {}),
      },
    })

    // ----------------------------------------------------------------------
    // Per-half evaluation gate (NEW in v1.7.1)
    // ----------------------------------------------------------------------

    describe("per-half evaluation gate", () => {
      it("payload doesn't mention any composite of either half → both halves noop", () => {
        // No index policy, no composite in payload, no removedSet, and the
        // GSI's composites (A/B/C) are not entity-PK composites (so they're
        // not in keyRecord either) → composer returns nothing for this GSI.
        // (The standard update path will then simply not emit any GSI-key
        // SET/REMOVE clauses.)
        //
        // keyRecord here mirrors the production standard-update path:
        // entity-PK composites only. Putting non-PK composites in keyRecord
        // would simulate the retain path / the merged-row reality, where
        // v1.7.2's broadened gate (#43) would correctly classify those
        // halves as touched.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "sparse", sk: "sparse" }),
          { unrelated: "x" },
          { id: "i-1" },
        )
        // v1.7.1 critical assertion: even with sparse on both halves, an
        // untouched payload doesn't fire policy. (v1.7.0 would have REMOVE'd
        // both halves here.)
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual([])
      })

      it("payload touches PK composite only → PK evaluated, SK noop", () => {
        // PK touched (A present in payload) → SET pk.
        // SK untouched (neither B nor C in payload or keyRecord, and no
        // removedSet) → noop. keyRecord = entity-PK composites only.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { A: "a-new" }, // only PK touched
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBeDefined()
        // SK untouched — the v1.7.1 per-half gate shields it from sparse.
        // (v1.7.0 would have REMOVE'd gsi1sk because sk is sparse and the
        // policy was always-evaluated.)
        expect(result.sets).not.toHaveProperty("gsi1sk")
        expect(result.removes).toEqual([])
      })

      it("payload touches SK composite only → SK evaluated, PK noop", () => {
        // Mirror image of the above. SK touched → SET sk. PK untouched → noop
        // even under sparse policy.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "sparse", sk: "preserve" }),
          { B: "b-new", C: "c-new" }, // only SK touched
          { id: "i-1" },
        )
        expect(result.sets.gsi1sk).toBeDefined()
        expect(result.sets).not.toHaveProperty("gsi1pk")
        expect(result.removes).toEqual([])
      })

      it("touched via undefined-payload still evaluates the half", () => {
        // `B: undefined` makes B "in" the payload (in operator true) — the
        // half is touched. But the value classifies as absent under the
        // two-way rule. Empty leading prefix on SK + sparse → REMOVE sk.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { B: undefined },
          { id: "i-1" },
        )
        expect(result.removes).toContain("gsi1sk")
        // PK untouched → noop.
        expect(result.removes).not.toContain("gsi1pk")
        expect(result.sets).not.toHaveProperty("gsi1pk")
      })

      it("touched via removedSet still evaluates the half", () => {
        // removeSet contains "B" (an SK composite) → SK touched. SK can't
        // compose without B (and C alone would be a hole anyway) → preserve +
        // cascade override → REMOVE sk. PK untouched → noop.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          {},
          { id: "i-1" },
          { removedSet: new Set(["B"]) },
        )
        expect(result.removes).toContain("gsi1sk")
        expect(result.removes).not.toContain("gsi1pk")
      })

      it("GSI without indexPolicy + no composites in payload → skipped (gate is the same)", () => {
        // Same gate logic regardless of policy declaration; the policy only
        // affects the OUTCOME for touched halves.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes(),
          { unrelated: "x" },
          { id: "i-1" },
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual([])
      })
    })

    // ----------------------------------------------------------------------
    // Per-half outcome — SET (full / truncated)
    // ----------------------------------------------------------------------

    describe("structural rule — SET (full / truncated)", () => {
      it("all composites present (touched via payload) → SET both halves full", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes(),
          { A: "a", B: "b", C: "c" },
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#e#b_b#c_c")
        expect(result.removes).toEqual([])
      })

      it("trailing-absent on SK (B touched, C absent) → SET sk truncated to [B]", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes(),
          { A: "a", B: "b" }, // C trailing-absent
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#e#b_b") // truncated to [B]
      })

      it("trailing-absent on multi-PK → SET pk truncated to leading prefix", () => {
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
          g1: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["accountId", "fleetId"] },
            sk: { field: "gsi1sk", composite: [] },
            indexPolicy: { pk: "preserve", sk: "preserve" },
          },
        }
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Vehicle",
          1,
          indexes,
          { accountId: "acct-1" }, // fleetId trailing-absent
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#vehicle#accountid_acct-1")
        expect(result.removes).toEqual([])
      })

      it("trailing-absent under sparse (touched + leading prefix non-empty) → SET truncated", () => {
        // Sparse only fires when the half can't compose at all. Trailing-
        // absent with a non-empty leading prefix composes fine.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { A: "a", B: "b" }, // C absent
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#e#b_b")
      })

      it("hierarchical truncation via set+remove (set/remove asymmetry)", () => {
        // Demote: supply surviving composites via set, invalidate the leaf
        // via remove. Per-half cascade fires on the half containing the
        // removed leaf — but the leading prefix is non-empty, so the
        // structural rule composes the truncated prefix.
        //
        // Wait — under v1.7.1 cascade only triggers REMOVE when the
        // structural rule CAN'T compose. The leading prefix here is
        // non-empty, so the structural rule SUCCEEDS and SETs. The set/
        // remove asymmetry is honored automatically.
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
          g1: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["region"] },
            sk: { field: "gsi1sk", composite: ["country", "city", "site"] },
            indexPolicy: { pk: "preserve", sk: "preserve" },
          },
        }
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Asset",
          1,
          indexes,
          { country: "us", city: "sf" }, // surviving composites supplied
          { id: "i-1" },
          { removedSet: new Set(["site"]) }, // leaf invalidated
        )
        // SK: composite list [country, city, site]; site removed; leading
        // prefix [country, city] composes. Per-half cascade is fine because
        // the structural rule succeeded — the cascade override only fires
        // when the rule CAN'T compose.
        expect(result.sets.gsi1sk).toBe("$myapp#v1#asset#country_us#city_sf")
        // PK untouched (region not in payload, no removedSet) → noop.
        expect(result.sets).not.toHaveProperty("gsi1pk")
        expect(result.removes).not.toContain("gsi1pk")
      })
    })

    // ----------------------------------------------------------------------
    // Per-half outcome — sparse + can't-compose → REMOVE
    // ----------------------------------------------------------------------

    describe("sparse + touched + can't-compose → REMOVE this half only (NOT GSI-wide)", () => {
      it("sparse pk + payload touches A as undefined → REMOVE pk only", () => {
        // PK touched (A in payload as undefined → in operator true). Empty
        // leading prefix → can't compose → sparse → REMOVE pk only.
        // SK untouched (B/C not in payload, not in keyRecord) → noop.
        // Critical: gsi1sk must NOT be in removes.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "sparse", sk: "preserve" }),
          { A: undefined },
          { id: "i-1" },
        )
        expect(result.removes).toEqual(["gsi1pk"])
        expect(result.sets).toEqual({})
      })

      it("sparse sk + payload touches B as undefined → REMOVE sk only", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { B: undefined },
          { id: "i-1" }, // A/C not in keyRecord either
        )
        // SK touched (B in payload as undefined). Empty leading prefix →
        // sparse → REMOVE sk. PK untouched → noop. (v1.7.0 would have
        // REMOVE'd gsi1pk too via the GSI-wide cascade.)
        expect(result.removes).toEqual(["gsi1sk"])
        expect(result.sets).toEqual({})
      })

      it("sparse sk + hole (B absent + C present in payload) → REMOVE sk only", () => {
        // Hole pattern collapses into can't-compose under v1.7.1 (no more
        // silent truncate-and-discard). SK touched (C in payload). Empty
        // leading prefix (B absent) → can't compose → sparse → REMOVE sk.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { C: "c" }, // B absent → hole at sk[0]
          { id: "i-1" },
        )
        expect(result.removes).toEqual(["gsi1sk"])
        expect(result.sets).not.toHaveProperty("gsi1pk")
      })

      it("sparse sk + hole with non-empty leading prefix (B present, C absent, D present) → REMOVE sk", () => {
        // SK = [B, C, D]: B present, C absent, D present → hole at C. Under
        // v1.7.1, holes are can't-compose regardless of leading prefix
        // length. Sparse → REMOVE sk. (v1.7.0 would have silently truncated
        // to [B] and discarded D — that's gone.)
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
          g1: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["A"] },
            sk: { field: "gsi1sk", composite: ["B", "C", "D"] },
            indexPolicy: { pk: "preserve", sk: "sparse" },
          },
        }
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          indexes,
          { A: "a", B: "b", D: "d" }, // C absent → hole
          { id: "i-1" },
        )
        // PK touched (A in payload) → SET. SK touched (B, D in payload),
        // hole → REMOVE sk.
        expect(result.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        expect(result.removes).toEqual(["gsi1sk"])
      })
    })

    // ----------------------------------------------------------------------
    // Per-half outcome — preserve + can't-compose + no cascade → noop
    // ----------------------------------------------------------------------

    describe("preserve + touched + can't-compose + no cascade → noop (stored key may be stale)", () => {
      it("preserve sk + B undefined (no removedSet) → noop sk; pk noop too", () => {
        // SK touched via undefined. Empty leading prefix (no stored B/C
        // either) → can't compose. Preserve + no cascade → noop. The stored
        // gsi1sk (whatever it was) stays. PK untouched → noop.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          { B: undefined },
          { id: "i-1" },
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual([])
      })

      it("preserve sk + hole (B absent, C present) + no removedSet → noop sk", () => {
        // SK touched (C in payload). Hole pattern → can't compose. Preserve
        // + no cascade → noop. PK touched (A in payload) → SET.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          { A: "a", C: "c" }, // B absent
          { id: "i-1" },
        )
        // v1.7.1: no throw. Hole collapses into can't-compose.
        expect(result.sets.gsi1pk).toBeDefined()
        expect(result.sets).not.toHaveProperty("gsi1sk")
        expect(result.removes).toEqual([])
      })
    })

    // ----------------------------------------------------------------------
    // Per-half outcome — preserve + can't-compose + cascade override → REMOVE
    // ----------------------------------------------------------------------

    describe("cascade override under preserve (NEW in v1.7.1)", () => {
      it("preserve sk + Entity.remove(['B']) (no surviving composites) → REMOVE sk only", () => {
        // SK touched via removedSet on B. Empty leading prefix (no B/C
        // anywhere). Preserve + cascade override → REMOVE sk. PK untouched
        // (A not in payload, not in keyRecord, not in removedSet) → noop.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          {},
          { id: "i-1" },
          { removedSet: new Set(["B"]) },
        )
        expect(result.removes).toEqual(["gsi1sk"])
        expect(result.sets).not.toHaveProperty("gsi1pk")
      })

      it("preserve pk + Entity.remove(['A']) (no surviving composites) → REMOVE pk only", () => {
        // Mirror image. PK touched via removedSet. Empty leading prefix
        // (A absent). Preserve + cascade override → REMOVE pk. SK untouched
        // → noop. (v1.7.0 would have REMOVE'd both halves.)
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          {},
          { id: "i-1" },
          { removedSet: new Set(["A"]) },
        )
        expect(result.removes).toEqual(["gsi1pk"])
        expect(result.removes).not.toContain("gsi1sk")
      })

      it("preserve sk + Entity.remove(['B']) — pk untouched, sk cascade fires", () => {
        // PK is untouched (A not in payload, not in keyRecord, not in
        // removedSet) → noop. SK touched via removedSet on B; can't compose
        // → preserve + cascade override → REMOVE sk.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          {},
          { id: "i-1" },
          { removedSet: new Set(["B"]) },
        )
        expect(result.removes).toEqual(["gsi1sk"])
        expect(result.sets).not.toHaveProperty("gsi1pk") // pk untouched, noop
      })

      it("preserve + cascade override is per-half — multi-half scenario", () => {
        // Both halves preserve, single GSI with composites split between halves.
        // Update touches PK only (via removedSet). PK can't compose →
        // cascade override → REMOVE pk. SK untouched → noop.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          {},
          { id: "i-1" },
          { removedSet: new Set(["A"]) },
        )
        expect(result.removes).toEqual(["gsi1pk"])
        // SK untouched → not addressed at all (neither in sets nor removes).
        expect(result.sets).not.toHaveProperty("gsi1sk")
      })
    })

    // ----------------------------------------------------------------------
    // Two-way payload classification: null = undefined = (omitted-but-touched)
    // ----------------------------------------------------------------------

    describe("two-way payload classification", () => {
      it("payload `{ B: null }` and `{ B: undefined }` produce identical outcomes", () => {
        const r1 = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { B: null },
          { id: "i-1" },
        )
        const r2 = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { B: undefined },
          { id: "i-1" },
        )
        expect(r1.sets).toEqual(r2.sets)
        expect(r1.removes).toEqual(r2.removes)
      })

      it("`{ A: undefined }` is touched + absent (PK eval fires)", () => {
        // PK touched (A in payload). A is absent (undefined). Empty leading
        // prefix → preserve + no cascade → noop pk. SK untouched (B/C not
        // in payload, not in keyRecord) → noop.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes(),
          { A: undefined },
          { id: "i-1" },
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual([])
      })
    })

    // ----------------------------------------------------------------------
    // Multi-writer round-trip via the gate — the v1.7.0 leak closure
    // ----------------------------------------------------------------------

    describe("multi-writer round-trip (per-half gate closes the v1.7.0 leak)", () => {
      // Canonical hybrid GSI: pk owned by enrichment writer, sk owned by
      // telemetry writer. Note: the GSI composites (A/B/C) are non-PK model
      // attrs — they are not in `keyRecord` (which carries only entity-PK
      // composites in the production standard-update path; that's `id`
      // here). The "stored" values shown in comments live on disk but are
      // not seen by the composer; they represent what was last SET by
      // earlier writers.
      const hybrid = {
        primary: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        g1: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["A"] },
          sk: { field: "gsi1sk", composite: ["B", "C"] },
          indexPolicy: { pk: "preserve", sk: "sparse" } as KeyComposer.IndexPolicy,
        },
      }
      // keyRecord under the standard update path: entity-PK composites only.
      const keyOnly = { id: "i-1" }

      it("stamp scenario — `{ unrelated: 'x' }` → both halves untouched, no writes (closes v1.7.0 bug-3)", () => {
        // The v1.7.0 leak: a stamp writer that doesn't touch the GSI's
        // composites would still trigger sparse on sk and REMOVE gsi1sk.
        // Under v1.7.1, the per-half gate skips both halves entirely.
        // Under v1.7.2, the broadened gate still skips them — A/B/C are
        // non-PK composites so they're not in keyRecord either.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          hybrid,
          { unrelated: "x" },
          keyOnly,
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual([])
      })

      it("enrichment writer — `{ A: 'newAcct' }` → SET pk; sk untouched", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          hybrid,
          { A: "newAcct" },
          keyOnly,
        )
        expect(result.sets.gsi1pk).toBeDefined()
        expect(result.sets).not.toHaveProperty("gsi1sk")
        expect(result.removes).toEqual([])
      })

      it("telemetry writer (active alert) — `{ B: 'active', C: T2 }` → SET sk; pk untouched", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          hybrid,
          { B: "active", C: "t2" },
          keyOnly,
        )
        expect(result.sets.gsi1sk).toBeDefined()
        expect(result.sets).not.toHaveProperty("gsi1pk")
        expect(result.removes).toEqual([])
      })

      it("telemetry writer (no alert) — `{ C: T2 }` → REMOVE sk only (sparse + hole); pk untouched", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          hybrid,
          { C: "t2" }, // B absent → hole at sk[0]
          keyOnly,
        )
        // SK touched (C in payload), structural rule sees no B → can't compose
        // → sparse → REMOVE sk only. PK untouched → noop. (v1.7.0 would have
        // REMOVE'd gsi1pk too.)
        expect(result.removes).toEqual(["gsi1sk"])
        expect(result.sets).not.toHaveProperty("gsi1pk")
      })

      it("rejoin — telemetry writes B+C after a drop, SET sk; pk untouched (no enrichment re-fire)", () => {
        // Item state on disk: gsi1pk = "acme" (preserved from earlier
        // enrichment), gsi1sk REMOVE'd from a prior drop. Telemetry now
        // sends both B and C → SET sk. Critical: the composer leaves pk
        // untouched (no SET, no REMOVE) → the stored gsi1pk persists in
        // the database without enrichment having to re-fire.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          hybrid,
          { B: "active", C: "t3" },
          keyOnly,
        )
        expect(result.sets.gsi1sk).toBeDefined()
        expect(result.sets).not.toHaveProperty("gsi1pk")
        expect(result.removes).toEqual([])
      })

      it("explicit clear — `Entity.remove(['B'])` → REMOVE sk only via per-half cascade", () => {
        // Per-half cascade: removedSet on B touches sk only. pk untouched →
        // noop. (v1.7.0 would have REMOVE'd both halves.)
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          hybrid,
          {},
          keyOnly,
          { removedSet: new Set(["B"]) },
        )
        expect(result.removes).toEqual(["gsi1sk"])
        expect(result.sets).not.toHaveProperty("gsi1pk")
      })

      it("explicit clear on PK — `Entity.remove(['A'])` → REMOVE pk only via per-half cascade", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          hybrid,
          {},
          keyOnly,
          { removedSet: new Set(["A"]) },
        )
        expect(result.removes).toEqual(["gsi1pk"])
        // sk untouched → noop, NOT removed. (v1.7.0 would have REMOVE'd both.)
        expect(result.removes).not.toContain("gsi1sk")
        expect(result.sets).not.toHaveProperty("gsi1sk")
      })
    })

    // ----------------------------------------------------------------------
    // Multi-GSI independence
    // ----------------------------------------------------------------------

    describe("multi-GSI independence", () => {
      it("two GSIs with different policies evaluate independently per-half", () => {
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
          g1: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["A"] },
            sk: { field: "gsi1sk", composite: ["B"] },
            indexPolicy: { pk: "sparse", sk: "sparse" },
          },
          g2: {
            index: "gsi2",
            pk: { field: "gsi2pk", composite: ["C"] },
            sk: { field: "gsi2sk", composite: ["D"] },
            indexPolicy: { pk: "preserve", sk: "preserve" },
          },
        }
        // Payload touches A (g1.pk), C (g2.pk). g1.sk untouched (B not
        // present). g2.sk untouched (D not present).
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          indexes,
          { A: "a", C: "c" },
          { id: "i-1" },
        )
        // g1.pk: touched, SET. g1.sk: untouched, noop (v1.7.0 would have
        // REMOVE'd because sparse-on-untouched fired).
        expect(result.sets.gsi1pk).toBeDefined()
        expect(result.removes).not.toContain("gsi1sk")
        // g2.pk: touched, SET. g2.sk: untouched, noop.
        expect(result.sets.gsi2pk).toBeDefined()
        expect(result.removes).not.toContain("gsi2sk")
      })
    })

    // ----------------------------------------------------------------------
    // keyRecord merging — composites pulled from primary key
    // ----------------------------------------------------------------------

    describe("keyRecord merging", () => {
      it("PK composites in keyRecord fill in for GSI composites + payload supplies the other half (v1.7.2 — both halves SET, closes #43)", () => {
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
        // Payload touches role (gsi1.pk). gsi1.sk has userId — userId is in
        // keyRecord (it's the entity-PK composite). v1.7.2 (#43) broadens
        // the per-half gate to also count keyRecord membership → sk touched
        // → structural rule composes from userId → SET sk. v1.7.0 / v1.7.1
        // skipped this — items written under those versions had no gsi1sk
        // and were invisible to byUserRole queries.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "User",
          1,
          indexes,
          { role: "admin" },
          { userId: "u-1" },
        )
        // pk: role touched (payload) → SET.
        expect(result.sets.gsi1pk).toBeDefined()
        // sk: userId touched via keyRecord (v1.7.2) → SET.
        expect(result.sets.gsi1sk).toBe("$myapp#v1#user#userid_u-1")
      })

      it("payload supplies a key that's also a GSI composite → SK touched, recompose from keyRecord", () => {
        // Same shape but payload also restates userId — same outcome
        // (idempotent).
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
          { role: "admin", userId: "u-1" }, // userId touched (payload)
          { userId: "u-1" }, // also in keyRecord
        )
        expect(result.sets.gsi1pk).toBeDefined()
        expect(result.sets.gsi1sk).toBeDefined()
      })
    })

    // ----------------------------------------------------------------------
    // Issue #36 / #41 migration regression
    // ----------------------------------------------------------------------

    describe("migration regression — issue #36 / #41 (sparse footgun stays closed)", () => {
      it("partial update with omitted preserve-policied composites → no REMOVEs and no SETs on the enrichment-owned PK halves", () => {
        // Three GSIs with preserve on every half. Update touches a non-
        // composite field (`name`). The PK halves' composites (X/Y/Z) are
        // enrichment-owned model attrs — not in payload, not in keyRecord
        // → per-half gate skips them → no SETs, no REMOVEs on gsi*pk.
        //
        // The SK halves' composites are `id` (the entity-PK composite). v1.7.2
        // (closes #43) broadens the per-half gate to also count `keyRecord`
        // membership — `id` IS in keyRecord, so the SK halves are touched
        // and the structural rule SETs them. This is correct, idempotent
        // behavior: SETting `gsi*sk` with the same composed value the row
        // already has is a noop on disk and ensures items written under
        // v1.7.0 / v1.7.1 (where the gate skipped these halves) repair on
        // their next update.
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          gA: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["X"] },
            sk: { field: "gsi1sk", composite: ["id"] },
            indexPolicy: { pk: "preserve", sk: "preserve" },
          },
          gB: {
            index: "gsi2",
            pk: { field: "gsi2pk", composite: ["Y"] },
            sk: { field: "gsi2sk", composite: ["id"] },
            indexPolicy: { pk: "preserve", sk: "preserve" },
          },
          gC: {
            index: "gsi3",
            pk: { field: "gsi3pk", composite: ["Z"] },
            sk: { field: "gsi3sk", composite: ["id"] },
            indexPolicy: { pk: "preserve", sk: "preserve" },
          },
        }
        const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          indexes,
          { name: "new-name" }, // no payload-owned GSI composite touched
          { id: "i-1" }, // entity PK in keyRecord
        )
        // Zero REMOVEs (the original sparse footgun stays closed).
        expect(r.removes).toEqual([])
        // PK halves untouched (X/Y/Z not in payload, not in keyRecord) → noop.
        expect(r.sets).not.toHaveProperty("gsi1pk")
        expect(r.sets).not.toHaveProperty("gsi2pk")
        expect(r.sets).not.toHaveProperty("gsi3pk")
        // SK halves touched via keyRecord (#43) → structural rule composes
        // from `id` → SET. v1.7.0 / v1.7.1 silently skipped these.
        expect(r.sets.gsi1sk).toBeDefined()
        expect(r.sets.gsi2sk).toBeDefined()
        expect(r.sets.gsi3sk).toBeDefined()
      })
    })

    // ----------------------------------------------------------------------
    // PK-composites-only GSI shape (issue #43)
    // ----------------------------------------------------------------------

    describe("keyRecord membership counts as touched (issue #43 — PK-composites-only GSIs)", () => {
      // Canonical fixture for #43: the GSI's composites are entirely entity
      // PK composites. They never appear in `updatePayload` (writers
      // address the row by key, not by restating the PK in `.set({...})`,
      // and `.append()` separates structural fields from the SET clause).
      // Pre-v1.7.2 the per-half gate looked only at `updatePayload` and so
      // classified both halves as untouched on every write — `gsi1pk` /
      // `gsi1sk` were never composed and items were invisible to the GSI.
      //
      // v1.7.2 fix: the gate now also counts `keyRecord` membership. The
      // structural rule composes from the always-present PK values; the
      // SET is idempotent for entity-PK composites because they're
      // immutable.
      const pkOnlyIndexes = (
        indexPolicy?: KeyComposer.IndexPolicy,
      ): Record<string, KeyComposer.IndexDefinition> => ({
        primary: {
          pk: { field: "pk", composite: ["channel", "deviceId"] },
          sk: { field: "sk", composite: [] },
        },
        byChannel: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["channel"] },
          sk: { field: "gsi1sk", composite: ["deviceId"] },
          ...(indexPolicy ? { indexPolicy } : {}),
        },
      })

      it("payload empty + keyRecord supplies all composites → both halves SET (default preserve)", () => {
        // No indexPolicy → defaults to preserve on both halves. Payload is
        // empty (mirrors `Entity.update(key).set({ unrelated: "x" })` minus
        // the unrelated field, or an `Entity.append({...})` whose appendInput
        // contains only structural composites). Pre-v1.7.2 → noop on both
        // halves (the bug). Post-v1.7.2 → both halves touched via keyRecord,
        // structural rule composes, SET both.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Telemetry",
          1,
          pkOnlyIndexes(),
          {}, // empty payload — no composite in payload
          { channel: "c-1", deviceId: "d-1" }, // composites only in keyRecord
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#telemetry#channel_c-1")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#telemetry#deviceid_d-1")
        expect(result.removes).toEqual([])
      })

      it("payload empty + keyRecord supplies all composites → both halves SET under sparse policy", () => {
        // Sparse on both halves should not change behavior here — the
        // structural rule succeeds (both composites available via keyRecord),
        // so sparse never gets to fire its "drop" branch. Critical: SET
        // happens, NOT REMOVE.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Telemetry",
          1,
          pkOnlyIndexes({ pk: "sparse", sk: "sparse" }),
          {},
          { channel: "c-1", deviceId: "d-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#telemetry#channel_c-1")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#telemetry#deviceid_d-1")
        expect(result.removes).toEqual([])
      })

      it("payload empty + keyRecord supplies all composites → both halves SET under preserve policy", () => {
        // Explicit preserve → same outcome. SET (idempotent re-compose).
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Telemetry",
          1,
          pkOnlyIndexes({ pk: "preserve", sk: "preserve" }),
          {},
          { channel: "c-1", deviceId: "d-1" },
        )
        expect(result.sets.gsi1pk).toBeDefined()
        expect(result.sets.gsi1sk).toBeDefined()
        expect(result.removes).toEqual([])
      })

      it("mixed GSI: PK from keyRecord + SK from payload → both halves evaluate independently and SET", () => {
        // PK composite is an entity-PK composite (in keyRecord), SK composite
        // is an enrichment-owned model attr (in payload). Both halves
        // touched independently — pre-v1.7.2 the SK half would fire (payload-
        // membership), but the PK half would silently skip; post-v1.7.2
        // both fire correctly.
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: {
            pk: { field: "pk", composite: ["channel", "deviceId"] },
            sk: { field: "sk", composite: [] },
          },
          byChannelAlert: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["channel"] }, // entity-PK composite
            sk: { field: "gsi1sk", composite: ["alertState"] }, // model attr
            indexPolicy: { pk: "preserve", sk: "preserve" },
          },
        }
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Telemetry",
          1,
          indexes,
          { alertState: "active" }, // SK composite via payload
          { channel: "c-1", deviceId: "d-1" }, // PK composite via keyRecord
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#telemetry#channel_c-1")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#telemetry#alertstate_active")
        expect(result.removes).toEqual([])
      })

      it("negative — composites NOT in payload AND NOT in keyRecord → gate still skips (multi-writer fix preserved)", () => {
        // The v1.7.1 multi-writer leak fix: stamps writing only `{ published }`
        // shouldn't blow away enrichment-owned + telemetry-owned GSI halves.
        // Composites are NOT in keyRecord (keyRecord here only has the
        // entity-PK composite `id`, NOT `accountId` / `alertState`) and NOT
        // in payload → gate skips → noop. The v1.7.2 broadening must NOT
        // re-open this leak.
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          byCurrentAlert: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["accountId"] }, // enrichment
            sk: { field: "gsi1sk", composite: ["alertState"] }, // telemetry
            indexPolicy: { pk: "preserve", sk: "sparse" },
          },
        }
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Telemetry",
          1,
          indexes,
          { published: "2026-04-30" }, // stamp writer — non-composite
          { id: "i-1" }, // only entity-PK in keyRecord; composites are NOT here
        )
        // No SETs, no REMOVEs. Both halves untouched. v1.7.1 multi-writer
        // fix preserved across the v1.7.2 broadening.
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual([])
      })
    })

    // ----------------------------------------------------------------------
    // v1.7.3 — empty-composite halves are always evaluated (issue #46)
    // ----------------------------------------------------------------------
    //
    // Canonical fixture for #46: a GSI half declared with `composite: []`.
    // The half's value is a *constant* (the bare entity prefix) — there is
    // no per-call decision to make and no other writer to clobber. The
    // pre-v1.7.3 touched-predicate's `.some(...)` clauses all returned
    // `false` for an empty composite array, classifying the half as
    // untouched and skipping it. v1.7.3's skip-predicate short-circuits on
    // `composites.length > 0` — empty halves are always evaluated, and
    // `classifyHalf` (which already handled empty composites correctly as
    // `{ kind: 'set', length: 0 }`) is finally reached.

    describe("empty-composite halves are always evaluated (issue #46)", () => {
      const emptySkIndexes = (
        indexPolicy?: KeyComposer.IndexPolicy,
      ): Record<string, KeyComposer.IndexDefinition> => ({
        primary: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        byDeviceBinding: {
          index: "gsi3",
          pk: { field: "gsi3pk", composite: ["deviceBinding"] },
          sk: { field: "gsi3sk", composite: [] }, // ← empty SK composite
          ...(indexPolicy ? { indexPolicy } : {}),
        },
      })

      it("update touching the PK half → empty SK half ALSO emits SET (constant prefix)", () => {
        // The exact #46 reproducer scenario. Pre-v1.7.3: gsi3pk SET,
        // gsi3sk silently skipped. Post-v1.7.3: both halves SET.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Vehicle",
          1,
          emptySkIndexes(),
          { deviceBinding: "cloud#dev-1" },
          { id: "veh-1" },
        )
        expect(result.sets.gsi3pk).toBe("$myapp#v1#vehicle#devicebinding_cloud#dev-1")
        expect(result.sets.gsi3sk).toBe("$myapp#v1#vehicle")
        expect(result.removes).toEqual([])
      })

      it("update with empty payload (untouched PK) still evaluates empty SK half (constant prefix)", () => {
        // Even when no GSI composite is touched at all, the empty SK half
        // is always evaluated — it's a constant prefix, no skipping
        // possible. The PK half is touched via the multi-writer leak fix
        // surface (no payload, no removedSet, no keyRecord membership) ⇒
        // the PK half is still skipped under the multi-writer protection
        // path. The SK half — being empty — is NOT skipped.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Vehicle",
          1,
          emptySkIndexes(),
          { unrelated: "x" },
          { id: "veh-1" },
        )
        // PK skipped (multi-writer protection — composite NOT touched).
        expect(result.sets).not.toHaveProperty("gsi3pk")
        // SK empty composite → always evaluated → constant prefix SET.
        expect(result.sets.gsi3sk).toBe("$myapp#v1#vehicle")
        expect(result.removes).toEqual([])
      })

      it("symmetric — empty PK composite + non-empty SK composite", () => {
        // Symmetry check: the gate is per-half. An empty PK composite must
        // also always be evaluated.
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
          allItems: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: [] }, // ← empty PK composite
            sk: { field: "gsi1sk", composite: ["createdAt"] },
          },
        }
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Item",
          1,
          indexes,
          { createdAt: "2026-04-30T00:00:00Z" },
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#item")
        // Default casing is "lowercase" — keys are lowercased end-to-end.
        expect(result.sets.gsi1sk).toBe("$myapp#v1#item#createdat_2026-04-30t00:00:00z")
        expect(result.removes).toEqual([])
      })

      it("both halves empty → both SET as constant prefixes", () => {
        // Degenerate-but-valid: both halves are bare entity prefixes.
        // Useful for "all items of an entity type" lookup GSIs.
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
          allByType: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: [] },
            sk: { field: "gsi1sk", composite: [] },
          },
        }
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Item",
          1,
          indexes,
          {},
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#item")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#item")
        expect(result.removes).toEqual([])
      })

      it("empty SK composite + sparse policy → SET (policy irrelevant for empty composites)", () => {
        // `classifyHalf`'s contract: empty composites return
        // { kind: 'set', length: 0 } regardless of policy. The skip-
        // predicate now reaches that branch even under sparse.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Vehicle",
          1,
          emptySkIndexes({ pk: "sparse", sk: "sparse" }),
          { deviceBinding: "cloud#dev-1" },
          { id: "veh-1" },
        )
        expect(result.sets.gsi3pk).toBe("$myapp#v1#vehicle#devicebinding_cloud#dev-1")
        expect(result.sets.gsi3sk).toBe("$myapp#v1#vehicle")
        expect(result.removes).toEqual([])
      })

      it("empty SK composite + Entity.remove on PK composite → PK REMOVE'd, empty SK still SET", () => {
        // Cascade override on the PK half should not affect the empty SK
        // half. SK is always evaluated; PK structural rule fires under
        // cascade and (since deviceBinding is now removed → no leading
        // prefix) the cascade override drops the PK key.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Vehicle",
          1,
          emptySkIndexes({ pk: "preserve", sk: "preserve" }),
          {},
          { id: "veh-1" },
          { removedSet: new Set(["deviceBinding"]) },
        )
        // PK touched via removedSet, can't compose → cascade override → REMOVE.
        expect(result.removes).toContain("gsi3pk")
        // SK empty composite → still always evaluated → constant prefix SET.
        expect(result.sets.gsi3sk).toBe("$myapp#v1#vehicle")
      })

      it("regression equivalence — multi-writer leak still closed under empty-half symmetry", () => {
        // Two GSIs on the same entity: one with non-empty composites
        // (multi-writer-protected) and one with an empty SK composite.
        // The stamp-style writer touches neither GSI's payload composites
        // — the multi-writer GSI's halves stay skipped (preserves #41
        // fix), but the empty-SK-composite half on the OTHER GSI is still
        // evaluated.
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
          byCurrentAlert: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["accountId"] },
            sk: { field: "gsi1sk", composite: ["alertState"] },
            indexPolicy: { pk: "preserve", sk: "sparse" },
          },
          byDeviceBinding: {
            index: "gsi3",
            pk: { field: "gsi3pk", composite: ["deviceBinding"] },
            sk: { field: "gsi3sk", composite: [] },
            indexPolicy: { pk: "preserve", sk: "preserve" },
          },
        }
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Vehicle",
          1,
          indexes,
          { published: "2026-04-30" }, // stamp writer — non-composite
          { id: "veh-1" },
        )
        // Multi-writer GSI: both halves untouched → noop. v1.7.1 fix preserved.
        expect(result.sets).not.toHaveProperty("gsi1pk")
        expect(result.sets).not.toHaveProperty("gsi1sk")
        expect(result.removes).not.toContain("gsi1pk")
        expect(result.removes).not.toContain("gsi1sk")
        // byDeviceBinding: PK untouched → skipped (multi-writer protection),
        // SK empty composite → always evaluated → constant prefix SET.
        expect(result.sets).not.toHaveProperty("gsi3pk")
        expect(result.sets.gsi3sk).toBe("$myapp#v1#vehicle")
      })
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

  // ---------------------------------------------------------------------------
  // composeSortKeyBeginsWith — the delimiter rule (issue #115)
  // ---------------------------------------------------------------------------

  describe("composeSortKeyBeginsWith", () => {
    const twoComposites: KeyComposer.IndexDefinition = {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["status", "taskId"] },
    }

    const oneComposite: KeyComposer.IndexDefinition = {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["boardId"] },
      sk: { field: "gsi1sk", composite: ["label"] },
    }

    const threeComposites: KeyComposer.IndexDefinition = {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["orgId"] },
      sk: { field: "gsi2sk", composite: ["region", "site", "rack"] },
    }

    it("partial prefix — appends the delimiter because composites remain", () => {
      expect(
        KeyComposer.composeSortKeyBeginsWith(schema, "Task", 1, twoComposites, { status: "done" }),
      ).toBe("$myapp#v1#task#status_done#")
    })

    it("complete key — no delimiter, the stored key ends there", () => {
      expect(
        KeyComposer.composeSortKeyBeginsWith(schema, "Task", 1, twoComposites, {
          status: "done",
          taskId: "t1",
        }),
      ).toBe("$myapp#v1#task#status_done#taskid_t1")
    })

    it("single-composite sort key — supplying it is a complete key, so no delimiter", () => {
      // Regression guard: appending a delimiter here would match nothing, since
      // no stored key continues past the only composite.
      expect(
        KeyComposer.composeSortKeyBeginsWith(schema, "Note", 1, oneComposite, { label: "ship" }),
      ).toBe("$myapp#v1#note#label_ship")
    })

    it("three composites — delimiter after one and after two, none after all three", () => {
      const record = { region: "apac", site: "syd1", rack: "r7" }
      expect(
        KeyComposer.composeSortKeyBeginsWith(schema, "Node", 1, threeComposites, {
          region: record.region,
        }),
      ).toBe("$myapp#v1#node#region_apac#")
      expect(
        KeyComposer.composeSortKeyBeginsWith(schema, "Node", 1, threeComposites, {
          region: record.region,
          site: record.site,
        }),
      ).toBe("$myapp#v1#node#region_apac#site_syd1#")
      expect(KeyComposer.composeSortKeyBeginsWith(schema, "Node", 1, threeComposites, record)).toBe(
        "$myapp#v1#node#region_apac#site_syd1#rack_r7",
      )
    })

    it("excludes a sibling value that the supplied value is a strict prefix of", () => {
      // The whole point of #115: `done` must not match `done_archived` / `doneish`.
      const operand = KeyComposer.composeSortKeyBeginsWith(schema, "Task", 1, twoComposites, {
        status: "done",
      })
      const composeStored = (status: string, taskId: string) =>
        KeyComposer.composeSk(schema, "Task", 1, twoComposites, { status, taskId })

      expect(composeStored("done", "t1").startsWith(operand)).toBe(true)
      expect(composeStored("done_archived", "t3").startsWith(operand)).toBe(false)
      expect(composeStored("doneish", "t4").startsWith(operand)).toBe(false)
    })

    it("no composites supplied — bare entity prefix plus delimiter", () => {
      expect(KeyComposer.composeSortKeyBeginsWith(schema, "Task", 1, twoComposites, {})).toBe(
        "$myapp#v1#task#",
      )
    })

    it("empty SK composite list — bare entity prefix, no delimiter", () => {
      const noComposites: KeyComposer.IndexDefinition = {
        index: "gsi3",
        pk: { field: "gsi3pk", composite: ["email"] },
        sk: { field: "gsi3sk", composite: [] },
      }
      expect(KeyComposer.composeSortKeyBeginsWith(schema, "User", 1, noComposites, {})).toBe(
        "$myapp#v1#user",
      )
    })

    it("padded composites are fixed-width, so the rule is a no-op for them", () => {
      // Numbers/bigints cannot be prefixes of one another once padded — the
      // delimiter protects the string and free-text composites. Recorded here so
      // nobody concludes from numeric fixtures that the rule is unnecessary.
      const numericSk: KeyComposer.IndexDefinition = {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["deviceId"] },
        sk: { field: "gsi1sk", composite: ["seq", "part"] },
      }
      expect(
        KeyComposer.composeSortKeyBeginsWith(schema, "Reading", 1, numericSk, { seq: 42 }),
      ).toBe("$myapp#v1#reading#seq_0000000000000042#")
      expect(KeyComposer.serializeValue(42).length).toBe(KeyComposer.serializeValue(4242).length)
    })

    it("isolated collection index keeps the entity_version segment", () => {
      const collectionIndex: KeyComposer.IndexDefinition = {
        index: "gsi1",
        collection: "tenantMembers",
        type: "isolated",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["status", "taskId"] },
      }
      expect(
        KeyComposer.composeSortKeyBeginsWith(schema, "Task", 1, collectionIndex, {
          status: "done",
        }),
      ).toBe("$myapp#v1#task_1#status_done#")
    })

    it("clustered collection index keeps the hierarchy", () => {
      const clustered: KeyComposer.IndexDefinition = {
        index: "gsi1",
        collection: ["org", "team"],
        type: "clustered",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["status", "taskId"] },
      }
      expect(
        KeyComposer.composeSortKeyBeginsWith(schema, "Task", 1, clustered, { status: "done" }),
      ).toBe("$myapp#v1#org#team#task_1#status_done#")
    })
  })
})
