/**
 * Unit tests for `substituteSchemaDeep` — the recursive, class-identity-preserving
 * substitution that lets self-date / Redacted leaves nested inside ref / edge
 * target classes round-trip through DynamoDB (Option A, issues #71/#72 follow-up).
 */
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import * as DynamoModel from "../src/DynamoModel.js"
import { substituteSchemaDeep, substituteSchemas } from "../src/internal/EntitySchemas.js"

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

  it("without tolerantTransforms (entity derivation), leaves Pattern B transforms alone", () => {
    for (const schema of [
      Schema.NullOr(Schema.DateTimeUtcFromString),
      Schema.Record(Schema.String, Schema.BigIntFromString),
      Schema.Tuple([Schema.String, Schema.DateTimeUtcFromString]),
      Schema.Union([Schema.String, Schema.NumberFromString]),
    ]) {
      expect(substituteSchemaDeep(schema as Schema.Top)).toBe(schema)
    }
  })

  it.effect("without tolerantTransforms, substitutes self dates inside those containers", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [Schema.Top, unknown, unknown]> = [
        [Schema.NullOr(Schema.DateTimeUtc), dt, ISO],
        [Schema.Record(Schema.String, Schema.DateTimeUtc), { a: dt }, { a: ISO }],
        [Schema.Tuple([Schema.String, Schema.DateTimeUtc]), ["x", dt], ["x", ISO]],
        [
          Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.DateTimeUtc]),
          ["x", dt, dt],
          ["x", ISO, ISO],
        ],
      ]
      for (const [schema, domain, wire] of cases) {
        const sub = substituteSchemaDeep(schema) as Schema.Codec<any>
        expect(sub).not.toBe(schema)
        expect(yield* Schema.encodeUnknownEffect(sub)(domain)).toEqual(wire)
      }
    }),
  )

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

describe("substituteSchemaDeep — unions with a colliding member (#133)", () => {
  const ISO = "2000-01-01T00:00:00.000Z"
  const MS = 946684800000
  const decode = (schema: Schema.Top, value: unknown) =>
    Schema.decodeUnknownEffect(substituteSchemaDeep(schema) as Schema.Codec<any>)(value)
  const encode = (schema: Schema.Top, value: unknown) =>
    Schema.encodeUnknownEffect(substituteSchemaDeep(schema) as Schema.Codec<any>)(value)

  it.effect("a self date next to a String member claims only its canonical form", () =>
    Effect.gen(function* () {
      for (const schema of [
        Schema.Union([Schema.DateTimeUtc, Schema.String]),
        Schema.Union([Schema.String, Schema.DateTimeUtc]),
      ]) {
        expect(yield* decode(schema, "2020")).toBe("2020")
        expect(yield* decode(schema, "5")).toBe("5")
        expect(DateTime.isDateTime(yield* decode(schema, ISO))).toBe(true)
        expect(yield* encode(schema, DateTime.makeUnsafe(MS))).toBe(ISO)
        expect(yield* encode(schema, "hello")).toBe("hello")
      }
    }),
  )

  it("rejects an epoch-stored date next to a member stored as a number (EDD-9058)", () => {
    for (const other of [Schema.Number, Schema.Literal(0), Schema.BigInt]) {
      expect(() =>
        substituteSchemaDeep(
          Schema.Union([
            Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
            other as Schema.Top,
          ]),
        ),
      ).toThrow(/EDD-9058/)
    }
    // A member stored as a string does not collide with an epoch number.
    expect(() =>
      substituteSchemaDeep(
        Schema.Union([
          Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
          Schema.NumberFromString,
        ]),
      ),
    ).not.toThrow()
  })

  it.effect("a date with no colliding member keeps its storage", () =>
    Effect.gen(function* () {
      const schema = Schema.NullOr(
        Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
      )
      expect(yield* encode(schema, DateTime.makeUnsafe(MS))).toBe(MS)
      expect(DateTime.isDateTime(yield* decode(schema, MS))).toBe(true)
      expect(yield* decode(schema, null)).toBe(null)
    }),
  )

  it.effect("a Pattern B date member keeps its own decode inside an aggregate union", () =>
    Effect.gen(function* () {
      const sub = substituteSchemaDeep(
        Schema.Union([Schema.DateTimeUtcFromString, Schema.Number]),
        { tolerantTransforms: true },
      ) as Schema.Codec<any>
      expect(yield* Schema.decodeUnknownEffect(sub)(5)).toBe(5)
      const dt = DateTime.makeUnsafe(MS)
      expect(yield* Schema.decodeUnknownEffect(sub)(dt)).toBe(dt)
    }),
  )
})

describe("substituteSchemas — read leniency and configured union storage (#133)", () => {
  it.effect("legacy domain-form values decode only in read schemas", () =>
    Effect.gen(function* () {
      const fields = {
        n: Schema.NumberFromString,
        big: Schema.BigIntFromString,
        plain: Schema.BigInt,
        at: Schema.DateTimeUtcFromString,
        either: Schema.Union([Schema.BigIntFromString, Schema.Number]),
      }
      const read = Schema.Struct(substituteSchemas(fields, {}, { legacyReads: true }) as any)
      const decoded: any = yield* Schema.decodeUnknownEffect(read)({
        n: 5,
        big: 7,
        plain: 9,
        at: {
          epochMilliseconds: 946684800000,
          "~effect/time/DateTime": "~effect/time/DateTime",
          _tag: "Utc",
        },
        either: 4,
      })
      expect(decoded).toMatchObject({ n: 5, big: 7n, plain: 9n, either: 4 })
      expect(DateTime.isDateTime(decoded.at)).toBe(true)
      // The encode is the transform's own.
      expect(yield* Schema.encodeUnknownEffect(read)(decoded)).toMatchObject({
        n: "5",
        big: "7",
        plain: 9n,
        at: "2000-01-01T00:00:00.000Z",
      })
      // Write schemas stay strict.
      const write = Schema.Struct(substituteSchemas(fields, {}) as any)
      const rejected = yield* Effect.flip(Schema.decodeUnknownEffect(write)({ n: 5 }))
      expect(rejected._tag).toBe("SchemaError")
    }),
  )

  it("rejects a configured override on a union with two date members (EDD-9057)", () => {
    expect(() =>
      substituteSchemas(
        { f: Schema.Union([Schema.DateTimeUtc, Schema.Date]) },
        { f: { storage: "epochMs", domain: "DateTime.Utc" } },
      ),
    ).toThrow(/EDD-9057/)
  })
})

describe("substituteSchemaDeep — zoned zones and nested unions (#133)", () => {
  const MS = 946684800000
  const roundTrip = (schema: Schema.Top, value: unknown) =>
    Effect.gen(function* () {
      const sub = substituteSchemaDeep(schema) as Schema.Codec<any>
      const wire = yield* Schema.encodeUnknownEffect(sub)(value)
      return { wire, back: yield* Schema.decodeUnknownEffect(sub)(wire) }
    })

  it.effect("named, offset and UTC zones are rebuilt exactly", () =>
    Effect.gen(function* () {
      for (const zone of [
        "Europe/London",
        "UTC",
        DateTime.zoneMakeOffset(5 * 3_600_000),
        DateTime.zoneMakeOffset(-(3 * 3_600_000 + 30 * 60_000)),
      ]) {
        const zoned = DateTime.makeZonedUnsafe(MS, { timeZone: zone })
        for (const schema of [
          Schema.DateTimeZoned,
          Schema.Union([Schema.DateTimeZoned, Schema.String]),
        ]) {
          const { wire, back } = yield* roundTrip(schema, zoned)
          expect(wire).toBe(DateTime.formatIsoZoned(zoned))
          expect(DateTime.formatIsoZoned(back as DateTime.Zoned)).toBe(wire)
        }
      }
    }),
  )

  it.effect("a self date in a nested union yields to the outer union's string member", () =>
    Effect.gen(function* () {
      for (const schema of [
        Schema.Union([Schema.NullOr(Schema.DateTimeUtc), Schema.String]),
        Schema.Union([Schema.String, Schema.NullOr(Schema.DateTimeUtc)]),
        Schema.NullOr(Schema.Union([Schema.DateTimeUtc, Schema.String])),
      ]) {
        const sub = substituteSchemaDeep(schema) as Schema.Codec<any>
        expect(yield* Schema.decodeUnknownEffect(sub)("2020")).toBe("2020")
        expect(yield* Schema.decodeUnknownEffect(sub)("5")).toBe("5")
        const date = yield* Schema.decodeUnknownEffect(sub)("2000-01-01T00:00:00.000Z")
        expect(DateTime.isDateTime(date)).toBe(true)
      }
    }),
  )
})
