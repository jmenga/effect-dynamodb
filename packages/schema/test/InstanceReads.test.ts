/**
 * `readingDeclaration` and `readingInstances` (`internal/EffectInstances.ts`, `internal/InstanceReads.ts`):
 * the read node each of Effect's look-alike declarations becomes, and what a read schema is built
 * from. The read rules themselves are pinned on the values DynamoDB hands back in
 * `effect-dynamodb`'s `LookalikeReadRules.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Duration, Equal, Exit, Schema, SchemaAST } from "effect"
import {
  effectDeclarationOf,
  isReadingDeclaration,
  readingDeclaration,
} from "../src/internal/EffectInstances.js"
import { readingInstances } from "../src/internal/InstanceReads.js"
import { holdsCustomDeclaration } from "../src/internal/SchemaAccessors.js"

/** The map DynamoDB hands back for a duration of `n` milliseconds. */
const stored = (n: number) => ({
  value: { _tag: "Millis", millis: n },
  "~effect/Duration": "~effect/Duration",
})
const isMap = (value: unknown) =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
const isReal = (value: unknown, n: number) =>
  Duration.isDuration(value) && !isMap(value) && Equal.equals(value, Duration.millis(n))
const decode = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)
const encode = (schema: Schema.Top, value: unknown) =>
  Schema.encodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)
const valueOf = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected a success")
}

/** Counts the values a check is asked about, and passes. */
const counting = () => {
  const seen: Array<unknown> = []
  return {
    seen,
    check: Schema.makeFilter((value: unknown) => {
      seen.push(value)
      return true
    }),
  }
}

describe("readingDeclaration", () => {
  const read = readingDeclaration(Schema.Duration.ast, "Duration")

  it("returns what the parser takes as the instance it stands for", () => {
    expect(isReal(valueOf(decode(Schema.make(read), stored(5))), 5)).toBe(true)
  })

  it("refuses what the parser refuses, with the parser's issue", () => {
    const before = decode(Schema.Duration, "five")
    const now = decode(Schema.make(read), "five")
    expect(Exit.isFailure(now)).toBe(true)
    expect(String(now)).toBe(String(before))
  })

  it("returns what the parser took where the rebuild can't place it", () => {
    const odd = {
      value: { _tag: "Millis", millis: "five" },
      "~effect/Duration": "~effect/Duration",
    }
    // The parser takes anything carrying the marker, as it always did.
    expect(valueOf(decode(Schema.Duration, odd))).toBe(odd)
    expect(valueOf(decode(Schema.make(read), odd))).toBe(odd)
  })

  it("returns a real instance as it is", () => {
    const real = Duration.millis(5)
    expect(valueOf(decode(Schema.make(read), real))).toBe(real)
  })

  it("runs its checks after the parser, on what it returns", () => {
    const { seen, check } = counting()
    const node = readingDeclaration(
      Schema.Duration.check(check).ast as SchemaAST.Declaration,
      "Duration",
    )
    valueOf(decode(Schema.make(node), stored(5)))
    expect(seen).toHaveLength(1)
    expect(isReal(seen[0], 5)).toBe(true)
  })

  it("encodes through the declaration's own parser, untouched", () => {
    const real = Duration.millis(5)
    expect(valueOf(encode(Schema.make(read), real))).toBe(real)
    // The map an encode is handed stays a map: it's no read.
    const map = stored(5)
    expect(valueOf(encode(Schema.make(read), map))).toBe(map)
    expect((SchemaAST.flip(read) as SchemaAST.Declaration).run).toBe(Schema.Duration.ast.run)
  })

  it("keeps the declaration's annotations, checks and context", () => {
    const declared = Schema.optionalKey(
      Schema.Duration.check(Schema.makeFilter(() => true)).annotate({ title: "t" }),
    ).ast as SchemaAST.Declaration
    const node = readingDeclaration(declared, "Duration")
    expect(node.annotations).toBe(declared.annotations)
    expect(node.checks).toBe(declared.checks)
    expect(node.context).toBe(declared.context)
  })
})

describe("the one identity function knows the read node", () => {
  const read = readingDeclaration(Schema.Duration.ast, "Duration")

  it("as the declaration it reads", () => {
    expect(effectDeclarationOf(read)).toBe("Duration")
    expect(isReadingDeclaration(read)).toBe(true)
    expect(isReadingDeclaration(Schema.Duration.ast)).toBe(false)
  })

  it("never as a declaration of one's own (EDD-9126)", () => {
    expect(holdsCustomDeclaration(read)).toBe(false)
    expect(
      holdsCustomDeclaration(readingInstances(Schema.Struct({ d: Schema.Duration })).ast),
    ).toBe(false)
    // A declaration of one's own still is one.
    expect(holdsCustomDeclaration(Schema.declare(Duration.isDuration).ast)).toBe(true)
  })

  it("so a read schema is never read twice", () => {
    const once = readingInstances(Schema.Struct({ d: Schema.Duration }))
    expect(readingInstances(once)).toBe(once)
    expect(readingInstances(Schema.make<Schema.Top>(read)).ast).toBe(read)
  })
})

describe("readingInstances", () => {
  it("returns the schema itself, the same object, when it holds no look-alike", () => {
    class Plain extends Schema.Class<Plain>("Plain")({ a: Schema.String }) {}
    interface Tree {
      readonly n: number
      readonly children: ReadonlyArray<Tree>
    }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      n: Schema.Number,
      children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
    })
    for (const schema of [
      Schema.Struct({ a: Schema.String, b: Schema.Option(Schema.Number) }),
      Schema.optionalKey(Schema.DurationFromMillis),
      Schema.BigDecimalFromString,
      Schema.Union([Schema.String, Schema.Number]),
      Schema.Record(Schema.String, Schema.Array(Schema.Number)),
      Schema.Number.check(Schema.makeFilter(() => true)),
      Plain,
      Tree,
    ] as ReadonlyArray<Schema.Top>) {
      expect(readingInstances(schema)).toBe(schema)
    }
  })

  it("gives each look-alike the read node, and leaves the rest of the schema as it was", () => {
    const sibling = Schema.Number.check(Schema.makeFilter(() => true))
    const read = readingInstances(Schema.Struct({ d: Schema.Duration, n: sibling }))
    const [d, n] = (read.ast as SchemaAST.Objects).propertySignatures
    expect(isReadingDeclaration(d!.type)).toBe(true)
    expect(n!.type).toBe(sibling.ast)
  })

  it("builds each node once: a schema shared by two fields is read alike", () => {
    const shared = Schema.Struct({ d: Schema.Duration })
    const model = Schema.Struct({ a: shared, b: shared })
    const read = valueOf(
      decode(readingInstances(model), { a: { d: stored(1) }, b: { d: stored(2) } }),
    ) as any
    expect(isReal(read.a.d, 1)).toBe(true)
    expect(isReal(read.b.d, 2)).toBe(true)
    const [a, b] = (readingInstances(model).ast as SchemaAST.Objects).propertySignatures
    expect(a!.type).toBe(b!.type)
  })

  it("decodes a row once: a check above a look-alike sees the instance, once", () => {
    const { seen, check } = counting()
    const model = Schema.Struct({ d: Schema.Duration }).check(check)
    const read = valueOf(decode(readingInstances(model), { d: stored(5) })) as any
    expect(isReal(read.d, 5)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(isReal((seen[0] as any).d, 5)).toBe(true)
  })
})
