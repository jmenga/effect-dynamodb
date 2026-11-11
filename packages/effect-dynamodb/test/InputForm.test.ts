/**
 * `InputForm.encodeInput`: the one decision of which form a write's input is in (#236). The domain
 * form is encoded; the stored form decoded, then encoded; and an input neither takes whole, in the
 * domain form but for a field given `undefined` whose decode makes a default of it, holds that
 * default and is encoded. Anything else is refused with both forms' issues, as before.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { encodeInput } from "../src/internal/InputForm.js"

const Data = Schema.Record(Schema.String, Schema.Number)

const schema = Schema.Struct({
  n: Schema.NumberFromString,
  m: Schema.optional(Schema.NumberFromString),
  data: Data.pipe(Schema.withDecodingDefault(Effect.succeed({ d: 1 }))),
  keyed: Schema.optionalKey(Data).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ k: 1 }))),
}) as unknown as Schema.Codec<any>

const run = (input: unknown) => Effect.exit(encodeInput(schema, input))

describe("InputForm.encodeInput", () => {
  it.effect("the domain form is encoded", () =>
    Effect.gen(function* () {
      expect(yield* encodeInput(schema, { n: 1, data: { x: 2 }, keyed: {} })).toEqual({
        n: "1",
        data: { x: 2 },
        keyed: {},
      })
    }),
  )

  it.effect("the stored form is decoded, then encoded: undefined is the default there", () =>
    Effect.gen(function* () {
      expect(yield* encodeInput(schema, { n: "1", data: undefined })).toEqual({
        n: "1",
        data: { d: 1 },
        keyed: { k: 1 },
      })
    }),
  )

  it.effect("the domain form but for a defaulted field given undefined: the default", () =>
    Effect.gen(function* () {
      expect(yield* encodeInput(schema, { n: 1, data: undefined })).toEqual({
        n: "1",
        data: { d: 1 },
      })
    }),
  )

  it.effect("an optional field given undefined beside the defaulted one stays undefined", () =>
    Effect.gen(function* () {
      expect(yield* encodeInput(schema, { n: 1, m: undefined, data: undefined })).toEqual({
        n: "1",
        m: undefined,
        data: { d: 1 },
      })
    }),
  )

  it.effect("a key-only default given undefined is refused, as its decode refuses it", () =>
    Effect.gen(function* () {
      const exit = yield* run({ n: 1, data: {}, keyed: undefined })
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("two transformed fields in two forms are refused: only undefineds are decoded", () =>
    Effect.gen(function* () {
      const exit = yield* run({ n: 1, m: "2", data: undefined })
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("a refusal carries the domain form's issue and the stored form's, as before", () =>
    Effect.gen(function* () {
      const input = { n: [1], data: undefined }
      const exit = yield* run(input)
      const domain = yield* Effect.flip(Schema.encodeUnknownEffect(schema)(input))
      const stored = yield* Effect.flip(Schema.decodeUnknownEffect(schema)(input))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const issues = yield* Effect.flip(encodeInput(schema, input))
        expect(String(issues.domain)).toBe(String(domain))
        expect(String(issues.stored)).toBe(String(stored))
      }
    }),
  )
})
