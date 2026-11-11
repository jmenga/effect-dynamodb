/**
 * A value the marshaller leaves out, where the substitution can't walk: under a declaration, a
 * `Schema.suspend` or a transformation. An empty set isn't stored, so an `Option` holding a struct
 * holding one comes back without it, and an `Option` holding one itself comes back with no value, and
 * each reads back as what was written.
 */

import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Result, Schema, SchemaGetter } from "effect"
import { readingStreamValues, substituteSchemaDeep } from "../src/internal/EntitySchemas.js"

const READS: ReadonlyArray<readonly [string, (schema: Schema.Top) => Schema.Top]> = [
  ["an entity", (schema) => substituteSchemaDeep(schema, { legacyReads: true, absentReads: true })],
  [
    "an aggregate",
    (schema) =>
      substituteSchemaDeep(schema, {
        tolerantTransforms: true,
        decodeOnly: true,
        absentReads: true,
      }),
  ],
  ["a stream", readingStreamValues],
]

/** What comes back for a value: its enumerable properties, its prototype's too, less what isn't stored. */
const stored = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  if (value instanceof Set) return value.size === 0 ? undefined : value
  if (Array.isArray(value)) return value.map(stored)
  const map: Record<string, unknown> = {}
  for (const key in value) {
    const part = stored((value as Record<string, unknown>)[key])
    if (part !== undefined && typeof part !== "function") map[key] = part
  }
  return map
}

const decoding = (read: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(read as unknown as Schema.Codec<unknown>)(value)

const Tags = Schema.ReadonlySet(Schema.String)
const Inner = Schema.Struct({ s: Tags, n: Schema.optional(Schema.String) })
class Cls extends Schema.Class<Cls>("Cls")({ s: Tags, n: Schema.String }) {}
class Tagged extends Schema.TaggedClass<Tagged>("Tagged")("Tagged", {
  s: Tags,
  n: Schema.String,
}) {}
type Tree = { readonly s: ReadonlySet<string>; readonly next?: Tree }
const Tree: Schema.Codec<Tree> = Schema.Struct({
  s: Tags,
  next: Schema.optionalKey(Schema.suspend((): Schema.Codec<Tree> => Tree)),
})
const u = Schema.Unknown

const empty = () => ({ s: new Set<string>(), n: "x" })

const POSITIONS: ReadonlyArray<readonly [string, Schema.Top, unknown]> = [
  ["an Option", Schema.Option(Inner), Option.some(empty())],
  [
    "an Option in an Option",
    Schema.Option(Schema.Option(Inner)),
    Option.some(Option.some(empty())),
  ],
  ["a Schema.Class in an Option", Schema.Option(Cls), Option.some(new Cls(empty()))],
  ["a Schema.TaggedClass in an Option", Schema.Option(Tagged), Option.some(new Tagged(empty()))],
  ["a Result's success", Schema.Result(Inner, Schema.String), Result.succeed(empty())],
  ["a Result's failure", Schema.Result(Schema.String, Inner), Result.fail(empty())],
  ["an Exit's success", Schema.Exit(Inner, Schema.String, u), Exit.succeed(empty())],
  ["an Exit's failure", Schema.Exit(Schema.String, Inner, u), Exit.fail(empty())],
  ["a Cause", Schema.Cause(Inner, u), Cause.fail(empty())],
  ["a list of them", Schema.Array(Schema.Option(Inner)), [Option.some(empty()), Option.none()]],
  [
    "a record of them",
    Schema.Record(Schema.String, Schema.Exit(Inner, u, u)),
    { k: Exit.succeed(empty()) },
  ],
  [
    "a tuple of them",
    Schema.Tuple([Schema.Option(Inner), Schema.String]),
    [Option.some(empty()), "a"],
  ],
  ["a NullOr of one", Schema.NullOr(Schema.Option(Inner)), Option.some(empty())],
  ["a union member", Schema.Union([Schema.Option(Inner), Schema.String]), Option.some(empty())],
  ["a suspend", Schema.suspend(() => Inner), empty()],
  ["a suspend in an Option", Schema.Option(Schema.suspend(() => Inner)), Option.some(empty())],
  ["a recursive schema", Tree, { s: new Set(), next: { s: new Set(), next: { s: new Set() } } }],
  ["a class with a check", Cls.check(Schema.makeFilter(() => true)), new Cls(empty())],
  ["an annotated class", Cls.annotate({ title: "annotated" }), new Cls(empty())],
  [
    "a struct beside a bigint",
    Schema.Option(Schema.Struct({ s: Tags, b: Schema.BigInt })),
    Option.some({ s: new Set(), b: 5n }),
  ],
  [
    "a struct holding a set beside a bigint",
    Schema.Option(Schema.Struct({ s: Schema.Union([Schema.BigInt, Tags]) })),
    Option.some({ s: new Set() }),
  ],
  ["a list in an Option", Schema.Option(Schema.Array(Inner)), Option.some([empty()])],
  [
    "a record in an Option",
    Schema.Option(Schema.Record(Schema.String, Inner)),
    Option.some({ k: empty() }),
  ],
  [
    "a struct in a struct in an Option",
    Schema.Option(Schema.Struct({ a: Inner })),
    Option.some({ a: empty() }),
  ],
  ["a set in an Option", Schema.Option(Tags), Option.some(new Set())],
  [
    "a set beside a bigint in an Option",
    Schema.Option(Schema.Union([Schema.BigInt, Tags])),
    Option.some(new Set()),
  ],
  [
    "a set in an Option in an Option",
    Schema.Option(Schema.Option(Tags)),
    Option.some(Option.some(new Set())),
  ],
  [
    "a set in a union in an Option",
    Schema.Option(Schema.Union([Tags, Schema.String])),
    Option.some(new Set()),
  ],
  ["a set as a Result's success", Schema.Result(Tags, Schema.String), Result.succeed(new Set())],
  ["a set as an Exit's success", Schema.Exit(Tags, Schema.String, u), Exit.succeed(new Set())],
  ["a set as a Cause's failure", Schema.Cause(Tags, u), Cause.fail(new Set())],
]

describe("a value the marshaller leaves out, beyond the walk", () => {
  describe.each(READS)("on %s", (_owner, read) => {
    it.each(POSITIONS)("in %s, it reads back as written", (_name, schema, value) => {
      const decoded = decoding(read(schema), stored(value))
      expect(Exit.isSuccess(decoded)).toBe(true)
      if (Exit.isSuccess(decoded)) {
        expect(Schema.toEquivalence(schema as never)(decoded.value, value)).toBe(true)
      }
    })

    it.each(POSITIONS)("in %s, a set holding something reads as itself", (_name, schema, value) => {
      const full = (given: unknown): unknown => {
        if (typeof given !== "object" || given === null) return given
        if (given instanceof Set) return new Set(["a"])
        if (Array.isArray(given)) return given.map(full)
        const map: Record<string, unknown> = {}
        for (const key in given) map[key] = full((given as Record<string, unknown>)[key])
        return map
      }
      const decoded = decoding(read(schema), full(value))
      expect(Exit.isSuccess(decoded)).toBe(true)
      if (Exit.isSuccess(decoded)) {
        expect(Schema.toEquivalence(schema as never)(decoded.value, value)).toBe(false)
      }
    })

    it("a union gives every member its try as declared first", () => {
      const Named = Schema.Struct({ n: Schema.String })
      const asNamed = Option.some({ n: "x" })
      for (const schema of [
        Schema.Union([Schema.Option(Inner), Schema.Option(Named)]),
        Schema.Option(Schema.Union([Inner, Named])),
        Schema.Option(Schema.suspend(() => Schema.Union([Inner, Named]))),
      ]) {
        const decoded = decoding(read(schema), stored(asNamed))
        expect(Exit.isSuccess(decoded) && Option.getOrThrow(decoded.value as never)).toEqual({
          n: "x",
        })
      }
      const asUndefined = decoding(
        read(Schema.Union([Schema.Option(Tags), Schema.Option(Schema.Undefined)])),
        stored(Option.some(undefined)),
      )
      expect(Exit.isSuccess(asUndefined) && Option.getOrThrow(asUndefined.value as never)).toBe(
        undefined,
      )
      // Only a value none of them takes as declared reads absent.
      const lifted = decoding(
        read(Schema.Option(Schema.Union([Schema.String, Inner]))),
        stored(Option.some({ n: "x" })),
      )
      expect(Exit.isSuccess(lifted) && Option.getOrThrow(lifted.value as never)).toEqual({
        s: new Set(),
        n: "x",
      })
    })

    it("a oneOf union stays whole, and refuses what two members would take", () => {
      const A = Schema.Struct({ a: Tags })
      const B = Schema.Struct({ b: Tags })
      const schema = Schema.Option(Schema.Union([A, B], { mode: "oneOf" }))
      const decoded = decoding(read(schema), stored(Option.some({ a: new Set(["x"]) })))
      expect(Exit.isSuccess(decoded) && Option.getOrThrow(decoded.value as never)).toEqual({
        a: new Set(["x"]),
      })
      expect(Exit.isSuccess(decoding(read(schema), stored(Option.some({}))))).toBe(false)
      const one = decoding(
        read(
          Schema.Option(Schema.Union([A, Schema.Struct({ b: Schema.String })], { mode: "oneOf" })),
        ),
        stored(Option.some({})),
      )
      expect(Exit.isSuccess(one) && Option.getOrThrow(one.value as never)).toEqual({ a: new Set() })
      const held = decoding(
        read(
          Schema.Option(Schema.Union([A, Schema.Struct({ b: Schema.String })], { mode: "oneOf" })),
        ),
        stored(Option.some({ a: new Set(["x"]) })),
      )
      expect(Exit.isSuccess(held) && Option.getOrThrow(held.value as never)).toEqual({
        a: new Set(["x"]),
      })
      const both = stored(Option.some({ a: new Set(["x"]), b: new Set(["y"]) }))
      expect(Exit.isSuccess(decoding(read(schema), both))).toBe(false)
    })

    it("a union's own transformation runs once", () => {
      const schema = Schema.Option(
        Schema.Struct({ n: Schema.String }).pipe(
          Schema.decodeTo(Schema.Union([Inner, Schema.Struct({ m: Schema.String })]), {
            decode: SchemaGetter.transform(({ n }: { n: string }) => ({ m: `${n}!` })),
            encode: SchemaGetter.forbidden(() => "read only"),
          } as never),
        ),
      )
      const decoded = decoding(read(schema), stored(Option.some({ n: "x" })))
      expect(Exit.isSuccess(decoded) && Option.getOrThrow(decoded.value as never)).toEqual({
        m: "x!",
      })
    })

    it("what a transformation makes isn't read as stored", () => {
      const making = (to: Schema.Top) =>
        Schema.Option(
          Schema.Struct({ n: Schema.String }).pipe(
            Schema.decodeTo(to, {
              decode: SchemaGetter.transform(({ n }: { n: string }) => ({ n })),
              encode: SchemaGetter.forbidden(() => "read only"),
            } as never),
          ),
        )
      for (const to of [Inner, Schema.Union([Inner, Schema.Struct({ m: Schema.String })])]) {
        expect(Exit.isSuccess(decoding(read(making(to)), stored(Option.some({ n: "x" }))))).toBe(
          false,
        )
      }
      // The same value through a transformation whose encoded side holds the set reads as written.
      const within = Schema.Option(
        Inner.pipe(
          Schema.decodeTo(Schema.Union([Inner, Schema.Struct({ m: Schema.String })]), {
            decode: SchemaGetter.passthrough(),
            encode: SchemaGetter.passthrough(),
          } as never),
        ),
      )
      const decoded = decoding(read(within), stored(Option.some(empty())))
      expect(Exit.isSuccess(decoded) && Option.getOrThrow(decoded.value as never)).toEqual(empty())
    })

    it("a union with nothing to read absent names each member once when it refuses", () => {
      const decoded = decoding(
        read(Schema.Option(Schema.Union([Schema.Boolean, Schema.BigInt]))),
        stored(Option.some("x")),
      )
      expect(Exit.isSuccess(decoded)).toBe(false)
      if (Exit.isFailure(decoded)) {
        expect(String(Cause.squash(decoded.cause)).match(/bigint/g)).toHaveLength(1)
      }
    })

    it("a check refusing an empty set leaves the value required", () => {
      const NonEmpty = Tags.check(Schema.isMinSize(1))
      for (const [schema, written] of [
        [Schema.Option(Schema.Struct({ s: NonEmpty })), Option.some({ s: new Set() })],
        [Schema.Option(NonEmpty), Option.some(new Set())],
        [Schema.Result(NonEmpty, Schema.String), Result.succeed(new Set())],
      ] as const) {
        expect(Exit.isSuccess(decoding(read(schema), stored(written)))).toBe(false)
      }
    })

    it("a transformation's stored side is reached", () => {
      const renamed = Schema.Struct({ s: Tags }).pipe(Schema.encodeKeys({ s: "stored" }))
      const decoded = decoding(read(Schema.Option(renamed)), stored(Option.some({})))
      expect(Exit.isSuccess(decoded) && Option.getOrThrow(decoded.value as never)).toEqual({
        s: new Set(),
      })
      const counted = Schema.Struct({ s: Tags }).pipe(
        Schema.decodeTo(Schema.Struct({ size: Schema.Number }), {
          decode: SchemaGetter.transform(({ s }: { s: ReadonlySet<string> }) => ({ size: s.size })),
          encode: SchemaGetter.transform(() => ({ s: new Set<string>() })),
        }),
      )
      const size = decoding(read(Schema.Struct({ f: Schema.suspend(() => counted) })), { f: {} })
      expect(Exit.isSuccess(size) && size.value).toEqual({ f: { size: 0 } })
    })

    it("what's beneath a decoding default on a container reads too", () => {
      const defaulted = Schema.Struct({
        f: Schema.Struct({ s: Tags }).pipe(
          Schema.withDecodingDefault(Effect.succeed({ s: new Set<string>() })),
        ),
      })
      const decoded = decoding(read(defaulted), { f: {} })
      expect(Exit.isSuccess(decoded) && decoded.value).toEqual({ f: { s: new Set() } })
    })

    it("a field that can hold undefined reads back without its key", () => {
      const schema = Schema.Option(Schema.Struct({ a: Schema.UndefinedOr(Schema.String) }))
      const decoded = decoding(read(schema), stored(Option.some({ a: undefined })))
      expect(Exit.isSuccess(decoded) && Option.getOrThrow(decoded.value as never)).toEqual({
        a: undefined,
      })
    })

    it("a value that isn't left out reads as it did", () => {
      for (const [schema, value] of [
        [Schema.Option(Schema.String), Option.some("a")],
        [Schema.Option(Inner), Option.none()],
        [Schema.Option(Schema.Unknown), Option.some(undefined)],
        [Schema.Option(Schema.Undefined), Option.some(undefined)],
      ] as const) {
        const decoded = decoding(read(schema), stored(value))
        expect(Exit.isSuccess(decoded) && decoded.value).toEqual(value)
      }
    })
  })

  describe("what doesn't read absent", () => {
    it("a write schema leaves the value required, on create and on a mutated state", () => {
      for (const options of [
        { tolerantTransforms: true, decodeOnly: true, enforceChecks: true },
        { tolerantTransforms: true, decodeOnly: true, enforceChecks: true, plainStateForms: true },
      ]) {
        for (const [schema, value] of [
          [Schema.Option(Schema.Struct({ s: Tags })), {}],
          [Schema.Option(Schema.Struct({ s: Tags, b: Schema.BigInt })), { b: 5n }],
        ] as const) {
          const decoded = decoding(
            substituteSchemaDeep(schema, options),
            stored(Option.some(value)),
          )
          expect(Exit.isSuccess(decoded)).toBe(false)
        }
      }
    })

    it("a schema with nothing to read absent is returned as it came", () => {
      for (const schema of [
        Schema.Option(Schema.String),
        Schema.Option(Schema.Unknown),
        Schema.Result(Schema.Number, Schema.String),
        Schema.Exit(Schema.String, Schema.String, Schema.Unknown),
      ]) {
        expect(substituteSchemaDeep(schema, { legacyReads: true, absentReads: true })).toBe(schema)
        expect(readingStreamValues(schema)).toBe(schema)
      }
    })
  })
})
