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
})
