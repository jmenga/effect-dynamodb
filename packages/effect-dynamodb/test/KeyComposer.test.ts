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
  // composeGsiKeysForUpdatePolicyAware — v3 per-half structural composition
  // (DESIGN.md §7, refs #39)
  //
  // Canonical fixture: pk.composite = [A], sk.composite = [B, C]. Tests cover
  // the structural rule (longest leading prefix), policy-aware hole detection
  // (truncate under sparse, throw under preserve), whole-half-empty +
  // policy-driven drop, two-way classification (null = undefined = absent),
  // cascade override, and PK/SK symmetry.
  // ---------------------------------------------------------------------------

  describe("composeGsiKeysForUpdatePolicyAware — v3 per-half model", () => {
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

    // --- Default policy (no indexPolicy) — both halves preserve ---

    describe("default policy (no indexPolicy → preserve, preserve)", () => {
      it("all composites present → SET both halves", () => {
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

      it("only A in payload → SET pk; sk no-op (preserve + empty SK)", () => {
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

      it("only B in payload → no SET on either half (PK empty + SK trailing-absent C)", () => {
        // PK half: A absent → empty leading prefix → preserve no-op.
        // SK half: B present + C trailing-absent → truncate to [B] (SET).
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes(),
          { B: "b" },
          { id: "i-1" },
        )
        expect(result.sets).not.toHaveProperty("gsi1pk")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#e#b_b")
        expect(result.removes).toEqual([])
      })

      it("{A, B} → SET pk; SET sk truncated to [B] (C trailing-absent)", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes(),
          { A: "a", B: "b" },
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#e#b_b")
      })

      it("{B, C} (A absent, no policy) → SET sk; pk no-op (preserve + empty PK)", () => {
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

      it("hole pattern under preserve → throws EDD-9024", () => {
        // {A, C} present, B absent. Default policy is preserve, so the SK hole
        // throws.
        expect(() =>
          KeyComposer.composeGsiKeysForUpdatePolicyAware(
            schema,
            "E",
            1,
            makeIndexes(),
            { A: "a", C: "c" },
            { id: "i-1" },
          ),
        ).toThrow(/EDD-9024/)
      })
    })

    // --- Two-way payload classification: null = undefined = absent ---

    describe("two-way payload classification (null = undefined = absent)", () => {
      it("`{ B: null, ... }` and `{ ... }` (B omitted) produce identical outcomes", () => {
        // Choose a non-hole, non-throwing scenario so we can directly compare.
        // PK = [A], SK = [B, C]. Stored attrs supply A only. Payload has B
        // either null or omitted; C is also absent. SK whole-half-empty +
        // preserve → no-op on SK; PK has A → SET pk.
        const r1 = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          { B: null }, // B absent via null
          { id: "i-1", A: "a" },
        )
        const r2 = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          {}, // B absent via omission
          { id: "i-1", A: "a" },
        )
        expect(r1.sets).toEqual(r2.sets)
        expect(r1.removes).toEqual(r2.removes)
        expect(r1.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        expect(r1.sets).not.toHaveProperty("gsi1sk")
      })

      it("`{ B: null, C: 'c' }` is a hole pattern just like `{ C: 'c' }`", () => {
        // Without keyRecord supplying values for A/B, only C is reachable.
        // SK composites = [B, C], B absent (null), C present → hole.
        expect(() =>
          KeyComposer.composeGsiKeysForUpdatePolicyAware(
            schema,
            "E",
            1,
            makeIndexes(),
            { B: null, C: "c" },
            { id: "i-1", A: "a" },
          ),
        ).toThrow(/EDD-9024/)
        expect(() =>
          KeyComposer.composeGsiKeysForUpdatePolicyAware(
            schema,
            "E",
            1,
            makeIndexes(),
            { C: "c" },
            { id: "i-1", A: "a" },
          ),
        ).toThrow(/EDD-9024/)
      })

      it("`{ A: undefined }` is treated as absent (no preserve no-op for A's slot)", () => {
        // PK half: A absent → empty leading prefix → preserve no-op (no SET, no
        // REMOVE). SK half: both B and C present in stored attrs → SET.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes(),
          { A: undefined },
          { id: "i-1", B: "b", C: "c" },
        )
        expect(result.sets).not.toHaveProperty("gsi1pk")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#e#b_b#c_c")
      })
    })

    // --- Whole-half-empty: policy decides ---

    describe("whole-half-empty under sparse → REMOVE both halves", () => {
      it("{ pk: 'sparse', sk: 'preserve' } + payload omits A entirely → drop", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "sparse", sk: "preserve" }),
          { B: "b", C: "c" }, // A absent, no stored value either
          { id: "i-1" },
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
      })

      it("{ pk: 'preserve', sk: 'sparse' } + only A in payload → drop", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { A: "a" },
          { id: "i-1" }, // B, C absent — SK whole-half empty
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
      })

      it("{ pk: 'sparse', sk: 'sparse' } + nothing in payload (policy still always-evaluated) → drop", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "sparse", sk: "sparse" }),
          { unrelated: "x" },
          { id: "i-1" },
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
      })
    })

    describe("whole-half-empty under preserve → no-op (leave stored values)", () => {
      it("default policy + payload doesn't touch GSI composites → skipped (no eval)", () => {
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

      it("explicit { pk: 'preserve', sk: 'preserve' } + nothing in payload → no-op (eval, but no writes)", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          { unrelated: "x" },
          { id: "i-1" },
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual([])
      })
    })

    // --- Hole detection: policy-aware ---

    describe("hole detection — policy-aware (sparse truncates, preserve throws)", () => {
      it("hole on SK + preserve → throws EDD-9024 with location info", () => {
        try {
          KeyComposer.composeGsiKeysForUpdatePolicyAware(
            schema,
            "E",
            1,
            makeIndexes({ pk: "preserve", sk: "preserve" }),
            { A: "a", C: "c" }, // B absent at sk[0], C present at sk[1]
            { id: "i-1" },
          )
        } catch (e) {
          expect(e).toMatchObject({
            _tag: "CompositeKeyHoleError",
            indexName: "gsi1",
            clearedComposite: "B",
            trailingComposite: "C",
            half: "sk",
            clearedPosition: 0,
            trailingPosition: 1,
          })
          const msg = (e as { message: string }).message
          expect(msg).toContain("EDD-9024")
          expect(msg).toContain("'preserve'")
          return
        }
        throw new Error("expected throw")
      })

      it("hole on SK + sparse with non-empty leading prefix → silently truncates", () => {
        // SK = [B, C, D]: B present at sk[0], C absent at sk[1], D present at
        // sk[2] → hole. Under sparse, truncate to the leading prefix [B].
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
        expect(result.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#e#b_b") // truncated to [B]
      })

      it("hole on SK + sparse with empty leading prefix → drops both halves", () => {
        // SK = [B, C], B absent, C present, leading prefix is empty → sparse
        // collapses this to whole-half-empty + drop.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { A: "a", C: "c" },
          { id: "i-1" },
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
      })

      it("hole on PK + preserve → throws EDD-9024 (PK and SK symmetric in v3)", () => {
        // PK = [A1, A2] now. Construct an index with multi-PK so a PK hole is
        // expressible.
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
          g1: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["A1", "A2"] },
            sk: { field: "gsi1sk", composite: [] },
            indexPolicy: { pk: "preserve", sk: "preserve" },
          },
        }
        try {
          KeyComposer.composeGsiKeysForUpdatePolicyAware(
            schema,
            "E",
            1,
            indexes,
            { A2: "a2" }, // A1 absent at pk[0], A2 present at pk[1]
            { id: "i-1" },
          )
        } catch (e) {
          expect(e).toMatchObject({
            _tag: "CompositeKeyHoleError",
            indexName: "gsi1",
            half: "pk",
          })
          return
        }
        throw new Error("expected throw")
      })

      it("hole on PK + sparse → truncates to empty PK + sparse-on-empty drops both halves", () => {
        const indexes: Record<string, KeyComposer.IndexDefinition> = {
          primary: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
          g1: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["A1", "A2"] },
            sk: { field: "gsi1sk", composite: [] },
            indexPolicy: { pk: "sparse", sk: "preserve" },
          },
        }
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          indexes,
          { A2: "a2" }, // A1 absent → leading prefix empty → sparse drops both
          { id: "i-1" },
        )
        expect(result.sets).toEqual({})
        expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
      })

      it("multi-clear at consecutive trailing positions is OK (no hole)", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          { B: null, C: null },
          { id: "i-1", A: "a" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        // SK leading prefix is empty + preserve → no SET on SK. (Different from
        // the v1.6 'truncate-to-empty-prefix' behavior under preserve.)
        expect(result.sets).not.toHaveProperty("gsi1sk")
        expect(result.removes).toEqual([])
      })
    })

    // --- Hierarchical truncation (PK and SK symmetric) ---

    describe("hierarchical truncation — symmetric PK and SK", () => {
      it("PK truncation: { pk: 'preserve' } + multi-PK + trailing-absent", () => {
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
        // PK truncated to leading prefix [accountId].
        expect(result.sets.gsi1pk).toBe("$myapp#v1#vehicle#accountid_acct-1")
        expect(result.removes).toEqual([])
      })

      it("SK truncation: { sk: 'preserve' } + multi-SK + trailing-absent", () => {
        // Same structure on the SK side — { B, C absent } truncates SK to [B's prefix].
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          { A: "a", B: "b" },
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#e#b_b")
      })

      it("SK truncation under sparse: trailing-absent is the same as preserve (no policy diff)", () => {
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "sparse" }),
          { A: "a", B: "b" },
          { id: "i-1" },
        )
        expect(result.sets.gsi1pk).toBe("$myapp#v1#e#a_a")
        expect(result.sets.gsi1sk).toBe("$myapp#v1#e#b_b")
      })
    })

    // --- Cascade override unchanged ---

    describe("cascade — Entity.remove([attr]) overrides everything", () => {
      it("cascade composite of GSI → REMOVE both halves regardless of policy", () => {
        const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          {},
          { id: "i-1", A: "a", B: "b", C: "c" },
          { removedSet: new Set(["A"]) },
        )
        expect(r.sets).toEqual({})
        expect(r.removes).toEqual(["gsi1pk", "gsi1sk"])
      })

      it("cascade fires even with empty payload (cascade is a touch signal)", () => {
        const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes(),
          {},
          { id: "i-1" },
          { removedSet: new Set(["B"]) },
        )
        expect(r.removes).toEqual(["gsi1pk", "gsi1sk"])
      })

      it("cascade overrides preserve-truncate", () => {
        const r = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "preserve", sk: "preserve" }),
          { B: null }, // would otherwise truncate SK to []
          { id: "i-1", A: "a" },
          { removedSet: new Set(["B"]) },
        )
        expect(r.sets).toEqual({})
        expect(r.removes).toEqual(["gsi1pk", "gsi1sk"])
      })
    })

    // --- Touched gate ---

    describe("touched gate", () => {
      it("GSI without indexPolicy + no composites in payload → skipped (no eval)", () => {
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

      it("GSI WITH indexPolicy is always evaluated, even when no composite in payload", () => {
        // Policy declaration opts the GSI into event-style evaluation; a
        // sparse half + whole-half-empty still drops.
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          makeIndexes({ pk: "sparse", sk: "preserve" }),
          { unrelated: "x" }, // A, B, C all absent
          { id: "i-1" },
        )
        expect(result.removes).toEqual(["gsi1pk", "gsi1sk"])
      })
    })

    // --- Multiple GSIs evaluated independently ---

    describe("multi-GSI independence", () => {
      it("two GSIs with different policies evaluate independently", () => {
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
        const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "E",
          1,
          indexes,
          { A: "a", C: "c" }, // g1: B absent + sparse → drop; g2: D absent + preserve → SET pk only
          { id: "i-1" },
        )
        expect(result.removes).toContain("gsi1pk")
        expect(result.removes).toContain("gsi1sk")
        expect(result.sets.gsi2pk).toBeDefined()
        expect(result.sets).not.toHaveProperty("gsi2sk")
      })
    })

    // --- keyRecord merging (GSI composites pulled from primary key) ---

    describe("keyRecord merging", () => {
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

    // --- Migration regression (the consumer footgun reproducer) ---

    describe("migration regression — issue #36 + #39 (sparse footgun closed)", () => {
      it("partial update with omitted preserve-policied composites does NOT generate REMOVE", () => {
        // Captured shape from consumer report: a 3-GSI entity where each GSI's
        // PK is a single attr the consumer touches under a separate
        // workflow. Under v3 declaring all halves preserve means a partial
        // update that doesn't touch X/Y/Z is a no-op for those GSIs (the SK
        // halves recompose because they share the primary key composite, the
        // PK halves no-op).
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
          { name: "new-name" },
          { id: "i-1" },
        )
        // Zero REMOVEs.
        expect(r.removes).toEqual([])
        // Each id-bearing SK half recomposes (id is in keyRecord); PK halves
        // no-op (X/Y/Z absent + preserve).
        expect(r.sets.gsi1sk).toBeDefined()
        expect(r.sets.gsi2sk).toBeDefined()
        expect(r.sets.gsi3sk).toBeDefined()
        expect(r.sets).not.toHaveProperty("gsi1pk")
        expect(r.sets).not.toHaveProperty("gsi2pk")
        expect(r.sets).not.toHaveProperty("gsi3pk")
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
})
