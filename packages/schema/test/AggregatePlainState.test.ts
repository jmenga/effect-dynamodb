/**
 * The schema an aggregate re-decodes its mutated state with: a declaration takes back the form the
 * state holds it as and the domain value a mutation sets, and still refuses anything else. `create`
 * takes only the declared type. Stored and read in `connected.unreadable.test.ts`.
 */

import {
  Cause,
  Chunk,
  Effect,
  Equal,
  Exit,
  HashMap,
  HashSet,
  Option,
  Result,
  Schema,
  SchemaGetter,
} from "effect"
import { describe, expect, it } from "vitest"
import { substituteSchemaDeep } from "../src/internal/EntitySchemas.js"

const mutated = (schema: Schema.Top) =>
  substituteSchemaDeep(schema, {
    tolerantTransforms: true,
    enforceChecks: true,
    plainStateForms: true,
  }) as Schema.Codec<any>
const created = (schema: Schema.Top) =>
  substituteSchemaDeep(schema, {
    tolerantTransforms: true,
    enforceChecks: true,
  }) as Schema.Codec<any>

const plainOf = (field: Schema.Top, value: unknown) => {
  const model = Schema.Struct({ f: field as never })
  return (Schema.toIso(model) as any).get({ f: value }).f as unknown
}

const DECLARATIONS: ReadonlyArray<readonly [string, Schema.Top, unknown]> = [
  ["Schema.Option", Schema.Option(Schema.String), Option.some("a")],
  ["Schema.Result", Schema.Result(Schema.String, Schema.Number), Result.succeed("a")],
  ["Schema.Exit", Schema.Exit(Schema.String, Schema.String, Schema.Defect()), Exit.succeed("a")],
  ["Schema.Cause", Schema.Cause(Schema.String, Schema.Defect()), Cause.fail("a")],
  ["Schema.ReadonlySet", Schema.ReadonlySet(Schema.String), new Set(["a"])],
  ["Schema.ReadonlyMap", Schema.ReadonlyMap(Schema.String, Schema.Number), new Map([["a", 1]])],
  ["Schema.HashSet", Schema.HashSet(Schema.String), HashSet.make("a")],
  ["Schema.HashMap", Schema.HashMap(Schema.String, Schema.Number), HashMap.make(["a", 1])],
  ["Schema.Chunk", Schema.Chunk(Schema.String), Chunk.make("a")],
]

describe("an aggregate's mutated state", () => {
  for (const [name, field, value] of DECLARATIONS) {
    const same = Schema.toEquivalence(field as never) as (a: unknown, b: unknown) => boolean
    const model = Schema.Struct({ f: field as never })

    it(`${name}: the form the state holds it as comes back as the declared type`, () => {
      const plain = plainOf(field, value)
      expect(plain).not.toBe(value)
      const read = Schema.decodeUnknownSync(mutated(model))({ f: plain }) as { f: unknown }
      expect(same(read.f, value)).toBe(true)
    })

    it(`${name}: a domain value stays`, () => {
      const read = Schema.decodeUnknownSync(mutated(model))({ f: value }) as { f: unknown }
      expect(same(read.f, value)).toBe(true)
    })

    it(`${name}: anything else is refused`, () => {
      expect(() => Schema.decodeUnknownSync(mutated(model))({ f: 12 })).toThrow()
    })

    it(`${name}: create takes only the declared type`, () => {
      const plain = plainOf(field, value)
      expect(() => Schema.decodeUnknownSync(created(model))({ f: plain })).toThrow()
      const read = Schema.decodeUnknownSync(created(model))({ f: value }) as { f: unknown }
      expect(same(read.f, value)).toBe(true)
    })
  }

  it("under a struct, an array, a record and an optional key", () => {
    const some = Option.some("a")
    const plain = plainOf(Schema.Option(Schema.String), some)
    const inner = Schema.Option(Schema.String)
    for (const [field, value] of [
      [Schema.Struct({ o: inner }), { o: plain }],
      [Schema.Array(inner), [plain]],
      [Schema.Record(Schema.String, inner), { a: plain }],
      [Schema.optionalKey(inner), plain],
    ] as const) {
      const model = Schema.Struct({ f: field as never })
      expect(() => Schema.decodeUnknownSync(mutated(model))({ f: value })).not.toThrow()
    }
  })

  it("a transformation under a declaration: the domain value, the plain form and the wire form", () => {
    const field = Schema.Option(Schema.DateFromString)
    const model = Schema.Struct({ f: field })
    const at = new Date("2025-01-01T00:00:00.000Z")
    const decode = Schema.decodeUnknownSync(mutated(model)) as (input: unknown) => { f: unknown }
    const expected = Option.some(at)
    expect(Equal.equals(decode({ f: expected }).f, expected)).toBe(true)
    expect(Equal.equals(decode({ f: plainOf(field, expected) }).f, expected)).toBe(true)
    expect(Equal.equals(decode({ f: Option.some(at.toISOString()) }).f, expected)).toBe(true)
  })

  it("a class isn't one: its fields are walked and it stays a class", () => {
    class Line extends Schema.Class<Line>("PlainStateLine")({
      o: Schema.Option(Schema.String),
    }) {}
    const model = Schema.Struct({ line: Line })
    const plain = plainOf(Schema.Option(Schema.String), Option.some("a"))
    const read = Schema.decodeUnknownSync(mutated(model))({ line: { o: plain } }) as {
      line: unknown
    }
    expect(read.line).toBeInstanceOf(Line)
  })

  it("a declaration of your own stays what it is", () => {
    class Point {
      constructor(readonly x: number) {}
    }
    const model = Schema.Struct({ f: Schema.instanceOf(Point) })
    const point = new Point(1)
    const read = Schema.decodeUnknownSync(mutated(model))({ f: point }) as { f: unknown }
    expect(read.f).toBe(point)
    expect(() => Schema.decodeUnknownSync(mutated(model))({ f: { x: 1 } })).toThrow()
  })
})

describe("a transformation under a declaration, on an aggregate's create", () => {
  const field = Schema.Option(Schema.DateFromString)
  const model = Schema.Struct({ f: field })
  const at = new Date("2025-01-01T00:00:00.000Z")

  it("takes the domain value the strict schema refuses, and the wire form it reads", () => {
    expect(() => Schema.decodeUnknownSync(model)({ f: Option.some(at) } as never)).toThrow()
    const decode = Schema.decodeUnknownSync(created(model)) as (input: unknown) => { f: unknown }
    expect(Equal.equals(decode({ f: Option.some(at) }).f, Option.some(at))).toBe(true)
    expect(Equal.equals(decode({ f: Option.some(at.toISOString()) }).f, Option.some(at))).toBe(true)
  })

  it("still refuses what's neither", () => {
    expect(() => Schema.decodeUnknownSync(created(model))({ f: Option.some(12) })).toThrow()
    expect(() => Schema.decodeUnknownSync(created(model))({ f: 12 })).toThrow()
  })

  it("leaves a declaration with nothing to transform as it is", () => {
    const plain = Schema.Struct({ f: Schema.Option(Schema.String) })
    expect(created(plain)).toBe(plain)
  })

  it("an entity's schema is left alone", () => {
    expect(substituteSchemaDeep(model)).toBe(model)
  })
})

describe("a transformation encoded as a declaration, on an aggregate's writes", () => {
  it("Schema.Defect() takes a domain value, which the strict schema refuses", () => {
    const model = Schema.Struct({ f: Schema.Defect() })
    const error = new Error("a")
    expect(() => Schema.decodeUnknownSync(model as never)({ f: error })).toThrow()
    const read = Schema.decodeUnknownSync(created(model))({ f: error }) as { f: unknown }
    expect(read.f).toBe(error)
  })

  it("Schema.RecordFromCookies takes a domain value and the wire form", () => {
    const model = Schema.Struct({ f: Schema.RecordFromCookies })
    const read = Schema.decodeUnknownSync(created(model))({ f: { a: "b" } }) as { f: unknown }
    expect(read.f).toEqual({ a: "b" })
  })

  it("a value that's neither is still refused", () => {
    const model = Schema.Struct({ f: Schema.RecordFromCookies })
    expect(() => Schema.decodeUnknownSync(created(model))({ f: 12 })).toThrow()
  })

  it("an entity's schema is left alone", () => {
    const model = Schema.Struct({ f: Schema.Defect() })
    expect(substituteSchemaDeep(model)).toBe(model)
  })
})

const decodesTo = <A>(codec: Schema.Codec<any>, input: unknown, check: (read: A) => void) =>
  check((Schema.decodeUnknownSync(codec as never)({ f: input }) as { readonly f: A }).f)

const over = (field: Schema.Top, options?: Parameters<typeof substituteSchemaDeep>[1]) =>
  substituteSchemaDeep(Schema.Struct({ f: field as never }), {
    tolerantTransforms: true,
    enforceChecks: true,
    ...options,
  }) as Schema.Codec<any>

describe("a transformation that isn't stored as a string or a number", () => {
  const mapFromRecord = Schema.Record(Schema.String, Schema.Number).pipe(
    Schema.decodeTo(Schema.ReadonlyMap(Schema.String, Schema.Number), {
      decode: SchemaGetter.transform(
        (record: Readonly<Record<string, number>>) => new Map(Object.entries(record)),
      ),
      encode: SchemaGetter.transform((map: ReadonlyMap<string, number>) => Object.fromEntries(map)),
    }),
  )

  it("a map decoded from a record keeps its entries: an instance isn't read as a record", () => {
    decodesTo<Map<string, number>>(over(mapFromRecord), new Map([["a", 1]]), (read) => {
      expect([...read.entries()]).toEqual([["a", 1]])
    })
  })

  it("a map decoded from a record reads the record it's stored as", () => {
    decodesTo<Map<string, number>>(over(mapFromRecord), { a: 1 }, (read) => {
      expect([...read.entries()]).toEqual([["a", 1]])
    })
  })

  it("a map decoded from a record takes back the entries the plain state holds", () => {
    const state = over(mapFromRecord, { plainStateForms: true })
    decodesTo<Map<string, number>>(state, [["a", 1]], (read) => {
      expect([...read.entries()]).toEqual([["a", 1]])
    })
    expect(() =>
      Schema.decodeUnknownSync(over(mapFromRecord) as never)({ f: [["a", 1]] }),
    ).toThrow()
  })

  for (const [name, field, domain, stored] of [
    ["Schema.OptionFromNullOr", Schema.OptionFromNullOr(Schema.String), Option.some("a"), "a"],
    ["Schema.OptionFromNullOr, none", Schema.OptionFromNullOr(Schema.String), Option.none(), null],
    [
      "Schema.OptionFromUndefinedOr",
      Schema.OptionFromUndefinedOr(Schema.String),
      Option.some("a"),
      "a",
    ],
    [
      "Schema.OptionFromNullishOr",
      Schema.OptionFromNullishOr(Schema.String),
      Option.some("a"),
      "a",
    ],
  ] as const) {
    it(`${name}: the domain value, and the form it's stored as`, () => {
      const equal = (read: unknown) => expect(Equal.equals(read, domain)).toBe(true)
      decodesTo(over(field), domain, equal)
      decodesTo(over(field), stored, equal)
    })
  }

  it("an instance that's neither form is still refused", () => {
    class Other {}
    const field = Schema.toCodecJson(Schema.ReadonlyMap(Schema.String, Schema.Number))
    expect(() => Schema.decodeUnknownSync(over(field) as never)({ f: new Other() })).toThrow()
  })

  // Each is a form a transformation is stored as, and reads back as the same kind of value, so
  // asking the domain type first would skip the transformation on every read.
  const shout = <T>(wire: Schema.Top, from: (t: T) => T, to: (t: T) => T) =>
    wire.pipe(
      Schema.decodeTo(Schema.Unknown, {
        decode: SchemaGetter.transform(from as never),
        encode: SchemaGetter.transform(to as never),
      } as never),
    ) as unknown as Schema.Top

  for (const [name, wire, stored, expected] of [
    ["a record", Schema.Record(Schema.String, Schema.String), { a: "x" }, { marked: { a: "x" } }],
    ["a list", Schema.Array(Schema.String), ["x"], { marked: ["x"] }],
    ["a set", Schema.ReadonlySet(Schema.String), new Set(["x"]), { marked: new Set(["x"]) }],
    ["bytes", Schema.Uint8Array, new Uint8Array([1]), { marked: new Uint8Array([1]) }],
  ] as const) {
    it(`${name} read from storage goes through the transformation`, () => {
      const field = shout<unknown>(
        wire,
        (value) => ({ marked: value }),
        (value) => (value as { readonly marked: unknown }).marked,
      )
      decodesTo(over(field), stored, (read) => expect(read).toEqual(expected))
    })
  }

  it("a list held as JSON takes the list and the text it's stored as", () => {
    const field = Schema.fromJsonString(Schema.Array(Schema.String))
    decodesTo(over(field), ["a"], (read) => expect(read).toEqual(["a"]))
    decodesTo(over(field), '["a"]', (read) => expect(read).toEqual(["a"]))
    const asList = Schema.Array(Schema.BigIntFromString)
    decodesTo(over(asList), [5n, "6"], (read) => expect(read).toEqual([5n, 6n]))
  })

  it("an entity's schema stays strict: nothing but an aggregate takes the domain value", () => {
    const strict = substituteSchemaDeep(
      Schema.Struct({
        at: Schema.Date,
        f: Schema.Option(Schema.DateFromString),
        m: Schema.toCodecJson(Schema.ReadonlyMap(Schema.String, Schema.Number)),
      }),
    ) as Schema.Codec<any>
    const at = new Date("2025-01-01T00:00:00.000Z")
    const stored = { at: at.toISOString(), f: Option.some(at.toISOString()), m: [["a", 1]] }
    expect(Schema.decodeUnknownSync(strict as never)(stored)).toMatchObject({ at })
    for (const given of [{ f: Option.some(at) }, { m: new Map([["a", 1]]) }]) {
      expect(() => Schema.decodeUnknownSync(strict as never)({ ...stored, ...given })).toThrow()
    }
    const inside = Schema.Option(Schema.DateFromString)
    expect(substituteSchemaDeep(inside)).toBe(inside)
  })

  it("a decoding default still fills a missing key", () => {
    const field = Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("x")))
    expect(Schema.decodeUnknownSync(over(field) as never)({})).toEqual({ f: "x" })
  })

  it("a class's fields are walked, so a state may hold either form of each", () => {
    class Stamped extends Schema.Class<Stamped>("Stamped")({
      at: Schema.DateFromString,
      n: Schema.BigIntFromString,
    }) {}
    const at = new Date("2025-01-01T00:00:00.000Z")
    decodesTo<Stamped>(
      over(Stamped, { plainStateForms: true }),
      { at: at.toISOString(), n: 5n },
      (read) => {
        expect(read.at).toEqual(at)
        expect(read.n).toBe(5n)
      },
    )
  })
})
