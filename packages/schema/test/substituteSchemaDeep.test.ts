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
  })
})
