/**
 * `failingAsBefore`, `issueDecoding` and `decodingAsBefore` (`internal/FailingAsBefore.ts`): a read
 * that dies fails with the issue 1.39.0's read gave, asked only once it has died; without one it
 * dies as it did. Pinned on stored rows in `effect-dynamodb`'s `MissingKeyReads.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema, SchemaGetter } from "effect"
import {
  decodingAsBefore,
  failingAsBefore,
  issueDecoding,
} from "../src/internal/FailingAsBefore.js"

const missingF = () => issueDecoding(Schema.Struct({ f: Schema.String }), {})
const tagged = (cause: Schema.SchemaError) => ({ _tag: "Failed", message: cause.message })

describe("failingAsBefore", () => {
  it.effect("a read that doesn't die runs nothing more", () =>
    Effect.gen(function* () {
      let asked = 0
      const before = () => {
        asked++
        return missingF()
      }
      expect(yield* Effect.succeed(1).pipe(failingAsBefore(before, tagged))).toBe(1)
      const failed = yield* Effect.fail("its own").pipe(
        failingAsBefore(before, tagged),
        Effect.flip,
      )
      expect(failed).toBe("its own")
      expect(asked).toBe(0)
    }),
  )

  it.effect("a read that died fails with the issue before gives", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.die(new TypeError("died")).pipe(
        failingAsBefore(missingF, tagged),
        Effect.flip,
      )
      expect(failed).toEqual({ _tag: "Failed", message: 'Missing key\n  at ["f"]' })
    }),
  )

  it.effect("without an issue, or when before throws, it dies as it did", () =>
    Effect.gen(function* () {
      const defect = new TypeError("died")
      for (const before of [
        () => undefined,
        () => {
          throw new Error("before threw")
        },
      ]) {
        const exit = yield* Effect.exit(Effect.die(defect).pipe(failingAsBefore(before, tagged)))
        expect(Exit.hasDies(exit)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect)
      }
    }),
  )
})

describe("issueDecoding", () => {
  it("none where the input decodes, or the decode dies", () => {
    const dying = Schema.Unknown.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((): string => {
          throw new Error("a step that throws")
        }),
        encode: SchemaGetter.transform((s: string) => s),
      } as never),
    )
    expect(issueDecoding(Schema.Struct({ f: Schema.String }), { f: "x" })).toBeUndefined()
    expect(issueDecoding(Schema.Struct({ f: dying }), { f: "x" })).toBeUndefined()
    expect(new Schema.SchemaError(missingF()!).message).toBe('Missing key\n  at ["f"]')
  })
})

describe("decodingAsBefore", () => {
  const upper = Schema.Unknown.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((u: unknown) => (u as string).toUpperCase()),
      encode: SchemaGetter.transform((s: string) => s.toLowerCase()),
    } as never),
  )
  const declared = Schema.Struct({ f: upper })
  // A read schema that reads the absent attribute as `undefined`, through the field's step.
  const read = Schema.Struct({
    f: upper.pipe(Schema.withDecodingDefaultKey(Effect.succeed(undefined))),
  })

  it.effect("decodes through the read schema", () =>
    Effect.gen(function* () {
      expect(yield* decodingAsBefore(read, declared)({ f: "x" })).toEqual({ f: "X" })
    }),
  )

  it.effect("a decode that dies fails with the declared schema's issue", () =>
    Effect.gen(function* () {
      const error = yield* decodingAsBefore(read, declared)({}).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Schema.SchemaError)
      expect(error.message).toBe('Missing key\n  at ["f"]')
    }),
  )
})
