/**
 * Unit tests for `substituteSchemaDeep` — the recursive, class-identity-preserving
 * substitution that lets self-date / Redacted leaves nested inside ref / edge
 * target classes round-trip through DynamoDB (Option A, issues #71/#72 follow-up).
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import { substituteSchemaDeep } from "../src/internal/EntitySchemas.js"

class Coach extends Schema.Class<Coach>("Coach")({
  id: Schema.String,
  joinedAt: Schema.DateTimeUtc, // Pattern A self-date (encoded === domain)
  dob: Schema.DateTimeUtcFromString, // Pattern B transform (encoded = string)
}) {
  greet() {
    return `Coach ${this.id}`
  }
}

const wireCoach = {
  id: "c1",
  joinedAt: "2010-03-20T00:00:00.000Z",
  dob: "1980-01-02T00:00:00.000Z",
}

describe("substituteSchemaDeep", () => {
  it.effect(
    "substitutes a nested class's Pattern A self-date while preserving instance identity",
    () =>
      Effect.gen(function* () {
        const sub = substituteSchemaDeep(Schema.Struct({ coach: Coach })) as Schema.Codec<any>
        const decoded: any = yield* Schema.decodeUnknownEffect(sub)({ coach: wireCoach })
        // Both date fields lift to DateTime…
        expect(DateTime.isDateTime(decoded.coach.joinedAt)).toBe(true)
        expect(DateTime.isDateTime(decoded.coach.dob)).toBe(true)
        // …the nested value is a real Coach instance (methods + prototype)…
        expect(decoded.coach).toBeInstanceOf(Coach)
        expect(decoded.coach.greet()).toBe("Coach c1")
        // …and it re-encodes to the exact wire form.
        const back = yield* Schema.encodeUnknownEffect(sub)(decoded)
        expect(back).toEqual({ coach: wireCoach })
      }),
  )

  it.effect("recurses through Schema.Array of classes", () =>
    Effect.gen(function* () {
      const sub = substituteSchemaDeep(
        Schema.Struct({ coaches: Schema.Array(Coach) }),
      ) as Schema.Codec<any>
      const decoded: any = yield* Schema.decodeUnknownEffect(sub)({ coaches: [wireCoach] })
      expect(decoded.coaches[0]).toBeInstanceOf(Coach)
      expect(DateTime.isDateTime(decoded.coaches[0].joinedAt)).toBe(true)
    }),
  )

  it("returns the input schema unchanged when no nested leaf needs substitution", () => {
    const plain = Schema.Struct({ a: Schema.String, b: Schema.Number })
    expect(substituteSchemaDeep(plain)).toBe(plain)
    // A Pattern B transform on its own owns its wire format — untouched.
    const bOnly = Schema.Struct({ d: Schema.DateTimeUtcFromString })
    expect(substituteSchemaDeep(bOnly)).toBe(bOnly)
  })

  it("does not crash on an optional(Array) wrapper — incl. called directly per-field (#73)", () => {
    // `substituteSchemas` (entity path) calls `substituteSchemaDeep` on each field
    // directly; an `optionalKey(Array)` wrapper has the `Arrays` AST but no runtime
    // `.value`, which previously crashed (`isSelfSchema(undefined)`). It must unwrap
    // the optional first and return non-date arrays unchanged.
    expect(() =>
      substituteSchemaDeep(Schema.optionalKey(Schema.Array(Schema.String))),
    ).not.toThrow()
    expect(() => substituteSchemaDeep(Schema.optional(Schema.Array(Schema.String)))).not.toThrow()
    const st = Schema.Struct({
      id: Schema.String,
      tags: Schema.optionalKey(Schema.Array(Schema.String)),
    })
    expect(substituteSchemaDeep(st)).toBe(st) // no date leaf → unchanged
  })

  it.effect("skipTopLevel leaves named immediate fields untouched", () =>
    Effect.gen(function* () {
      // With `joinedAt` (the only self-date) skipped, nothing needs substituting,
      // so the struct is returned unchanged.
      const skipped = substituteSchemaDeep(Schema.Struct({ joinedAt: Schema.DateTimeUtc }), {
        skipTopLevel: new Set(["joinedAt"]),
      })
      expect(skipped).toBe(skipped) // no throw; identity preserved for the skipped-only case
      const decoded: any = yield* Schema.decodeUnknownEffect(skipped as Schema.Codec<any>)({
        joinedAt: DateTime.makeUnsafe("2010-03-20T00:00:00.000Z"),
      })
      expect(DateTime.isDateTime(decoded.joinedAt)).toBe(true)
    }),
  )

  it.effect("resolveRef re-points an opaque ref field at its target model", () =>
    Effect.gen(function* () {
      // `DynamoModel.ref`-annotated fields are opaque Declarations that hide the
      // target's fields; `resolveRef` supplies the resolved target model so the
      // recursion can substitute its self-date leaves.
      const sub = substituteSchemaDeep(Schema.Struct({ coach: Schema.String }), {
        resolveRef: (name) => (name === "coach" ? (Coach as unknown as Schema.Top) : undefined),
      }) as Schema.Codec<any>
      const decoded: any = yield* Schema.decodeUnknownEffect(sub)({ coach: wireCoach })
      expect(decoded.coach).toBeInstanceOf(Coach)
      expect(DateTime.isDateTime(decoded.coach.joinedAt)).toBe(true)
    }),
  )

  // --- Optional wrappers (the "all use cases" follow-up) ----------------------
  describe("optional / optionalKey wrappers preserve instance + optionality", () => {
    const expectCoach = (c: any) => {
      expect(c).toBeInstanceOf(Coach)
      expect(c.greet()).toBe("Coach c1")
      expect(DateTime.isDateTime(c.joinedAt)).toBe(true) // Pattern A self-date
      expect(DateTime.isDateTime(c.dob)).toBe(true) // Pattern B transform
    }

    it.effect("Schema.optional(Class) — present and absent", () =>
      Effect.gen(function* () {
        const sub = substituteSchemaDeep(Schema.Struct({ coach: Schema.optional(Coach) }), {
          tolerantTransforms: true,
        }) as Schema.Codec<any>
        const present: any = yield* Schema.decodeUnknownEffect(sub)({ coach: wireCoach })
        expectCoach(present.coach)
        expect(yield* Schema.encodeUnknownEffect(sub)(present)).toEqual({ coach: wireCoach })
        const absent: any = yield* Schema.decodeUnknownEffect(sub)({})
        expect(absent.coach).toBeUndefined()
      }),
    )

    it.effect("Schema.optionalKey(Class) — present and absent", () =>
      Effect.gen(function* () {
        const sub = substituteSchemaDeep(Schema.Struct({ coach: Schema.optionalKey(Coach) }), {
          tolerantTransforms: true,
        }) as Schema.Codec<any>
        const present: any = yield* Schema.decodeUnknownEffect(sub)({ coach: wireCoach })
        expectCoach(present.coach)
        const absent: any = yield* Schema.decodeUnknownEffect(sub)({})
        expect("coach" in absent).toBe(false)
      }),
    )

    it.effect("Schema.optional(Schema.Array(Class))", () =>
      Effect.gen(function* () {
        const sub = substituteSchemaDeep(
          Schema.Struct({ coaches: Schema.optional(Schema.Array(Coach)) }),
          { tolerantTransforms: true },
        ) as Schema.Codec<any>
        const d: any = yield* Schema.decodeUnknownEffect(sub)({ coaches: [wireCoach] })
        expectCoach(d.coaches[0])
      }),
    )

    it.effect("Schema.optional(self-date leaf)", () =>
      Effect.gen(function* () {
        const sub = substituteSchemaDeep(
          Schema.Struct({ at: Schema.optional(Schema.DateTimeUtc) }),
        ) as Schema.Codec<any>
        const d: any = yield* Schema.decodeUnknownEffect(sub)({ at: "2020-01-01T00:00:00.000Z" })
        expect(DateTime.isDateTime(d.at)).toBe(true)
        const absent: any = yield* Schema.decodeUnknownEffect(sub)({})
        expect(absent.at).toBeUndefined()
      }),
    )

    // PR #73: an `optionalKey(date)` field is a bare AST with an `isOptional`
    // context, so the leaf detectors must NOT run before the optional unwrap —
    // otherwise the field is replaced by a plain REQUIRED date and an omitted
    // value fails with "Missing key".
    it.effect("Schema.optionalKey(transform date leaf) stays optional", () =>
      Effect.gen(function* () {
        const sub = substituteSchemaDeep(
          Schema.Struct({
            id: Schema.String,
            at: Schema.optionalKey(Schema.DateTimeUtcFromString),
          }),
          { tolerantTransforms: true },
        ) as Schema.Codec<any>
        const absent: any = yield* Schema.decodeUnknownEffect(sub)({ id: "x" })
        expect("at" in absent).toBe(false)
        const present: any = yield* Schema.decodeUnknownEffect(sub)({
          id: "x",
          at: "2020-01-01T00:00:00.000Z",
        })
        expect(DateTime.isDateTime(present.at)).toBe(true)
      }),
    )

    it.effect("Schema.optionalKey(self-date leaf) stays optional", () =>
      Effect.gen(function* () {
        const sub = substituteSchemaDeep(
          Schema.Struct({ id: Schema.String, at: Schema.optionalKey(Schema.DateTimeUtc) }),
        ) as Schema.Codec<any>
        const absent: any = yield* Schema.decodeUnknownEffect(sub)({ id: "x" })
        expect("at" in absent).toBe(false)
      }),
    )

    it.effect("Schema.optionalKey(Array(Class)) keeps the Array wrapper", () =>
      Effect.gen(function* () {
        const sub = substituteSchemaDeep(
          Schema.Struct({ coaches: Schema.optionalKey(Schema.Array(Coach)) }),
          { tolerantTransforms: true },
        ) as Schema.Codec<any>
        const present: any = yield* Schema.decodeUnknownEffect(sub)({ coaches: [wireCoach] })
        expect(Array.isArray(present.coaches)).toBe(true)
        expectCoach(present.coaches[0])
        const empty: any = yield* Schema.decodeUnknownEffect(sub)({ coaches: [] })
        expect(empty.coaches).toEqual([])
      }),
    )
  })
})

describe("substituteSchemaDeep — Union / Record / Tuple containers (#133)", () => {
  const tolerant = { tolerantTransforms: true } as const
  const ISO = "2000-01-01T00:00:00.000Z"
  const MS = 946684800000
  const dt = DateTime.makeUnsafe(MS)
  const roundTrip = (schema: Schema.Top, wire: unknown) =>
    Effect.gen(function* () {
      const sub = substituteSchemaDeep(schema, tolerant) as Schema.Codec<any>
      const fromWire = yield* Schema.decodeUnknownEffect(sub)(wire)
      // A tolerant decode accepts its own output (the update path) …
      const again = yield* Schema.decodeUnknownEffect(sub)(fromWire)
      // … and encodes it back to the same wire form.
      const back = yield* Schema.encodeUnknownEffect(sub)(again)
      return { fromWire, back }
    })

  it("leaves these containers untouched without tolerantTransforms (entity derivation)", () => {
    for (const schema of [
      Schema.NullOr(Schema.DateTimeUtc),
      Schema.Record(Schema.String, Schema.DateTimeUtc),
      Schema.Tuple([Schema.String, Schema.DateTimeUtc]),
      Schema.Union([Coach, Schema.String]),
    ]) {
      expect(substituteSchemaDeep(schema as Schema.Top)).toBe(schema)
    }
  })

  it("returns a container with nothing to substitute unchanged", () => {
    const plain = Schema.NullOr(Schema.String)
    expect(substituteSchemaDeep(plain, tolerant)).toBe(plain)
    const literals = Schema.Literals(["a", "b"])
    expect(substituteSchemaDeep(literals, tolerant)).toBe(literals)
  })

  it.effect("NullOr(self date) decodes the wire string and re-encodes it", () =>
    Effect.gen(function* () {
      const { fromWire, back } = yield* roundTrip(Schema.NullOr(Schema.DateTimeUtc), ISO)
      expect(DateTime.isDateTime(fromWire)).toBe(true)
      expect(back).toBe(ISO)
      expect((yield* roundTrip(Schema.NullOr(Schema.DateTimeUtc), null)).back).toBe(null)
    }),
  )

  it.effect("Record and Tuple values are substituted in place", () =>
    Effect.gen(function* () {
      const rec = yield* roundTrip(Schema.Record(Schema.String, Schema.DateTimeUtcFromString), {
        a: ISO,
      })
      expect(DateTime.isDateTime((rec.fromWire as any).a)).toBe(true)
      expect(rec.back).toEqual({ a: ISO })
      const tup = yield* roundTrip(Schema.Tuple([Schema.String, Schema.DateTimeUtcFromString]), [
        "x",
        ISO,
      ])
      expect(DateTime.isDateTime((tup.fromWire as any)[1])).toBe(true)
      expect(tup.back).toEqual(["x", ISO])
    }),
  )

  it.effect("a union member keeps its class and decodes its nested date", () =>
    Effect.gen(function* () {
      const wire = { id: "c1", joinedAt: ISO, dob: ISO }
      const { fromWire, back } = yield* roundTrip(Schema.Union([Coach, Schema.String]), wire)
      expect(fromWire).toBeInstanceOf(Coach)
      expect(back).toEqual(wire)
      expect((yield* roundTrip(Schema.Union([Coach, Schema.String]), "none")).back).toBe("none")
    }),
  )

  it.effect("keeps union checks", () =>
    Effect.gen(function* () {
      const checked = Schema.NullOr(Schema.DateTimeUtcFromString).check(
        Schema.makeFilter((v) => v !== null || "no nulls"),
      )
      const sub = substituteSchemaDeep(checked, tolerant) as Schema.Codec<any>
      const result = yield* Effect.flip(Schema.decodeUnknownEffect(sub)(null))
      expect(result._tag).toBe("SchemaError")
    }),
  )

  it.effect("a date member under a union only claims its own wire kind", () =>
    Effect.gen(function* () {
      const sub = substituteSchemaDeep(
        Schema.Union([Schema.DateTimeUtcFromString, Schema.Number]),
        tolerant,
      ) as Schema.Codec<any>
      expect(yield* Schema.decodeUnknownEffect(sub)(5)).toBe(5)
      expect(DateTime.isDateTime(yield* Schema.decodeUnknownEffect(sub)(ISO))).toBe(true)
      expect(yield* Schema.decodeUnknownEffect(sub)(dt)).toBe(dt)
    }),
  )
})

describe("substituteSchemaDeep — rebuilt containers keep their metadata (#133)", () => {
  it("keeps annotations and checks on Record / TupleWithRest / StructWithRest", () => {
    const tolerant = { tolerantTransforms: true } as const
    const shapes: ReadonlyArray<Schema.Top> = [
      Schema.Record(Schema.String, Schema.DateTimeUtcFromString)
        .check(Schema.isMaxProperties(1))
        .annotate({ description: "rec" }),
      Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.DateTimeUtcFromString])
        .check(Schema.isMaxLength(2))
        .annotate({ description: "twr" }),
      Schema.StructWithRest(Schema.Struct({ at: Schema.DateTimeUtcFromString }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ])
        .check(Schema.isMaxProperties(2))
        .annotate({ description: "swr" }),
    ]
    for (const shape of shapes) {
      const sub = substituteSchemaDeep(shape, tolerant)
      expect(sub).not.toBe(shape)
      expect(sub.ast._tag).toBe(shape.ast._tag)
      expect(sub.ast.checks).toBe(shape.ast.checks)
      expect(sub.ast.annotations?.description).toBe(shape.ast.annotations?.description)
    }
  })

  it.effect("lifts a legacy numeric bigint stored in its domain form", () =>
    Effect.gen(function* () {
      const sub = substituteSchemaDeep(Schema.Array(Schema.BigIntFromString), {
        tolerantTransforms: true,
      }) as Schema.Codec<any>
      expect(yield* Schema.decodeUnknownEffect(sub)([5, "6", 7n])).toEqual([5n, 6n, 7n])
      const rejected = yield* Effect.flip(Schema.decodeUnknownEffect(sub)([1.5]))
      expect(rejected._tag).toBe("SchemaError")
    }),
  )
})
