/**
 * The rules a read of Effect's look-alike declarations keeps (`internal/InstanceReads.ts` in the
 * schema package), on the values DynamoDB hands back (`asRead`: marshalled and unmarshalled for real):
 *
 * - A row is decoded once. Everything a schema runs (a check, a transformation, a class's constructor
 *   or initializer, a declaration's parser, a decoding default) runs as often as it did on 1.39.0.
 * - Each look-alike declaration's own parser decides on the stored map as it did on 1.39.0, and what
 *   it takes comes back as the instance it stands for.
 * - What changes: code that inspects one of these values (the declaration's own checks, a check, a
 *   transformation, a class or a declaration holding it) is handed the instance where 1.39.0 handed
 *   it a map, and may answer differently. Its answers are pinned here as the new results, in
 *   "code that inspects a look-alike sees the instance".
 * - Nothing else changes: a union takes the member it took, and a read whose code never inspects a
 *   look-alike decodes and fails exactly as 1.39.0's did.
 * - What any of it costs is decided when the schema is built: a schema holding none of these is the
 *   schema it was, the same object.
 */
import { it } from "@effect/vitest"
import { readingInstances } from "@effect-dynamodb/schema/internal/InstanceReads.js"
import {
  Cause,
  Duration,
  Effect,
  Equal,
  Exit,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaParser,
} from "effect"
import { describe, expect } from "vitest"
import { asRead } from "../src/internal/RoundTrip.js"

const millis = (n: number) => Duration.millis(n)
/** The map DynamoDB hands back for a duration of `n` milliseconds. */
const stored = (n: number) => asRead(millis(n)) as object

const isReal = (value: unknown, n: number) =>
  Duration.isDuration(value) &&
  Object.getPrototypeOf(value) !== Object.prototype &&
  Equal.equals(value, millis(n))
const isMap = (value: unknown) =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype

/** Passes only on the instance: what a check reading the value through its prototype does. */
const realOnly = Schema.makeFilter((d: unknown) => Equal.isEqual(d) || "a real Duration")
/** Passes only on the map. */
const mapOnly = Schema.makeFilter((d: unknown) => isMap(d) || "a stored map")

const decode = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)
/** 1.39.0's read and today's, of one stored value. */
const both = (schema: Schema.Top, value: unknown) => ({
  before: decode(schema, value),
  now: decode(readingInstances(schema), value),
})
const valueOf = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected a success, got ${Cause.pretty(exit.cause)}`)
}
const messageOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  return String(Cause.squash(exit.cause))
}

/** Counts each time it's called. */
const counter = () => {
  const calls = { count: 0 }
  return { calls, tick: () => void calls.count++ }
}

describe("what a read costs", () => {
  it("a schema holding no look-alike is the schema it was, the same object", () => {
    const plain = Schema.Struct({ a: Schema.String, n: Schema.Array(Schema.Number) })
    expect(readingInstances(plain)).toBe(plain)
    const optional = Schema.optionalKey(Schema.DurationFromMillis)
    expect(readingInstances(optional)).toBe(optional)
  })

  it("a row is decoded once: every check, transformation, constructor and default runs once", () => {
    const check = counter()
    const enclosing = counter()
    const transform = counter()
    const constructed = counter()
    const defaulted = counter()
    class Held extends Schema.Class<Held>("Held")({ d: Schema.optionalKey(Schema.Duration) }) {
      constructor(props: { readonly d?: Duration.Duration }, options?: Schema.MakeOptions) {
        constructed.tick()
        super(props, options)
      }
    }
    const model = Schema.Struct({
      d: Schema.optionalKey(Schema.Duration),
      n: Schema.Number.check(
        Schema.makeFilter(() => {
          check.tick()
          return true
        }),
      ),
      s: Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((s: string) => {
            transform.tick()
            return s
          }),
          encode: SchemaGetter.transform((s: string) => s),
        }),
      ),
      p: Schema.String.pipe(
        Schema.withDecodingDefaultKey(
          Effect.sync(() => {
            defaulted.tick()
            return "default"
          }),
        ),
      ),
      held: Held,
    }).check(
      Schema.makeFilter(() => {
        enclosing.tick()
        return true
      }),
    )
    const counts = () =>
      [check, enclosing, transform, constructed, defaulted].map(({ calls }) => calls.count)
    const reset = () => {
      for (const { calls } of [check, enclosing, transform, constructed, defaulted]) calls.count = 0
    }

    // A row holding no look-alike: what 1.39.0 read, by the same calls.
    const plainRow = { n: 1, s: "x", held: {} }
    const before = valueOf(decode(model, plainRow))
    expect(counts()).toEqual([1, 1, 1, 1, 1])
    reset()
    const now = valueOf(decode(readingInstances(model), plainRow))
    expect(counts()).toEqual([1, 1, 1, 1, 1])
    expect(now).toEqual(before)
    expect((now as any).p).toBe("default")

    // A row holding them: the same calls, and the instances.
    reset()
    const read = valueOf(
      decode(readingInstances(model), { d: stored(5), n: 1, s: "x", held: { d: stored(6) } }),
    ) as any
    expect(counts()).toEqual([1, 1, 1, 1, 1])
    expect(isReal(read.d, 5)).toBe(true)
    expect(isReal(read.held.d, 6)).toBe(true)
  })

  it("a look-alike under a check of its own is decoded once, its check seeing the instance", () => {
    const seen: Array<unknown> = []
    const field = Schema.Struct({ d: Schema.Duration }).check(
      Schema.makeFilter((s: { readonly d: unknown }) => {
        seen.push(s.d)
        return true
      }),
    )
    const read = valueOf(decode(readingInstances(field), { d: stored(5) })) as any
    expect(isReal(read.d, 5)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(isReal(seen[0], 5)).toBe(true)
  })
})

describe("code that inspects a look-alike sees the instance", () => {
  it("a check the map failed and the instance passes: the read takes the instance", () => {
    const { before, now } = both(Schema.Duration.check(realOnly), stored(5))
    expect(messageOf(before)).toBe("SchemaError(a real Duration)")
    expect(isReal(valueOf(now), 5)).toBe(true)
  })

  it("a check the map passed and the instance fails: the read fails", () => {
    const { before, now } = both(Schema.Duration.check(mapOnly), stored(5))
    expect(isMap(valueOf(before))).toBe(true)
    expect(messageOf(now)).toBe("SchemaError(a stored map)")
  })

  it("an enclosing check the map passed and the instance fails: the read fails", () => {
    const field = Schema.Struct({
      kept: Schema.Struct({ d: Schema.Duration }).check(
        Schema.makeFilter((s: { readonly d: unknown }) => isMap(s.d) || "a stored map"),
      ),
      read: Schema.Duration,
    })
    const { before, now } = both(field, { kept: { d: stored(5) }, read: stored(6) })
    expect(isMap((valueOf(before) as any).kept.d)).toBe(true)
    expect(messageOf(now)).toBe('SchemaError(a stored map\n  at ["kept"])')
  })

  it("an enclosing check the map failed and the instance passes: the read takes the instances", () => {
    const field = Schema.Struct({ d: Schema.Duration, n: Schema.Number }).check(
      Schema.makeFilter((s: any) => Equal.isEqual(s.d) || "a real d"),
    )
    const { before, now } = both(field, { d: stored(5), n: 1 })
    expect(messageOf(before)).toBe("SchemaError(a real d)")
    expect(isReal((valueOf(now) as any).d, 5)).toBe(true)
  })

  it("a class with a check of its own: the check sees the instance", () => {
    class Kept extends Schema.Class<Kept>("Kept")(
      Schema.Struct({ d: Schema.Duration }).check(
        Schema.makeFilter((s: { readonly d: unknown }) => isMap(s.d) || "a stored map"),
      ),
    ) {}
    const { before, now } = both(Kept, { d: stored(5) })
    expect(isMap((valueOf(before) as any).d)).toBe(true)
    expect(messageOf(now)).toBe("SchemaError(a stored map)")
  })

  it("a union member whose check passes on the instance takes it, ahead of a later member", () => {
    const union = Schema.Union([
      Schema.Duration.check(realOnly),
      Schema.Struct({ value: Schema.Unknown }),
    ])
    const { before, now } = both(union, stored(5))
    // 1.39.0: the Duration's check refused the map, and the struct took it.
    expect(isMap(valueOf(before))).toBe(true)
    expect(Object.keys(valueOf(before) as object)).toEqual(["value"])
    expect(isReal(valueOf(now), 5)).toBe(true)
  })

  it("a union member whose check fails on the instance is passed over for a later member", () => {
    const union = Schema.Union([
      Schema.Duration.check(mapOnly),
      Schema.Struct({ value: Schema.Unknown }),
    ])
    const { before, now } = both(union, stored(5))
    expect(Object.keys(valueOf(before) as object)).toContain("~effect/Duration")
    expect(Object.keys(valueOf(now) as object)).toEqual(["value"])
  })

  it("a union whose members all refused the map takes the first that takes the instance", () => {
    const union = Schema.Union([
      Schema.Duration.check(realOnly),
      Schema.Struct({ other: Schema.String }),
    ])
    const { before, now } = both(union, stored(5))
    expect(Exit.isFailure(before)).toBe(true)
    expect(isReal(valueOf(now), 5)).toBe(true)
  })

  describe("a declaration holding one", () => {
    /** A box whose parser decodes its child, and takes it only as a plain map. */
    const Box = <S extends Schema.Top>(child: S) =>
      Schema.declareConstructor<{ readonly branch: string }, unknown>()(
        [child],
        ([inner]) =>
          (input: unknown, ast, options) =>
            typeof input === "object" && input !== null && "boxed" in input
              ? Effect.flatMap(
                  SchemaParser.decodeUnknownEffect(inner as Schema.Codec<unknown>)(
                    (input as { readonly boxed: unknown }).boxed,
                    options,
                  ),
                  (child) =>
                    isMap(child)
                      ? Effect.succeed({ branch: "box" })
                      : Effect.fail(
                          new SchemaIssue.InvalidValue(
                            { message: "a plain child" },
                            input,
                            options,
                          ),
                        ),
                )
              : Effect.fail(new SchemaIssue.InvalidType(ast, input, options)),
      )
    const Fallback = Schema.Struct({ boxed: Schema.Unknown }).pipe(
      Schema.decodeTo(Schema.Struct({ branch: Schema.String }), {
        decode: SchemaGetter.transform(() => ({ branch: "fallback" })),
        encode: SchemaGetter.transform(() => ({ boxed: null })),
      }),
    )

    it("its parser is handed the instance: refusing it, the union takes the next member", () => {
      const { before, now } = both(Schema.Union([Box(Schema.Duration), Fallback]), {
        boxed: stored(5),
      })
      expect(valueOf(before)).toEqual({ branch: "box" })
      expect(valueOf(now)).toEqual({ branch: "fallback" })
    })

    it("its parser is handed the instance: refusing it alone, the read fails", () => {
      const { before, now } = both(Box(Schema.Duration), { boxed: stored(5) })
      expect(valueOf(before)).toEqual({ branch: "box" })
      expect(messageOf(now)).toBe("SchemaError(a plain child)")
    })
  })

  describe("a class holding one", () => {
    it("an initializer reading it reads the instance", () => {
      class Timed extends Schema.Class<Timed>("Timed")({ d: Schema.Duration }) {
        readonly text = String(this.d)
      }
      const { before, now } = both(Timed, { d: stored(5) })
      expect((valueOf(before) as Timed).text).toBe("[object Object]")
      expect((valueOf(now) as Timed).text).toBe("5 millis")
    })

    it("a constructor refusing an instance refuses the read, as it would any value it refused", () => {
      class Picky extends Schema.Class<Picky>("Picky")({ d: Schema.Duration }) {
        constructor(props: { readonly d: Duration.Duration }, options?: Schema.MakeOptions) {
          if (Equal.isEqual(props.d)) throw new Error("not a real Duration")
          super(props, options)
        }
      }
      const { before, now } = both(Picky, { d: stored(5) })
      expect(isMap((valueOf(before) as any).d)).toBe(true)
      expect(Exit.isFailure(now) && Cause.hasDies(now.cause)).toBe(true)
      expect(messageOf(now)).toBe("Error: not a real Duration")
    })
  })

  it("a transformation from one is handed the instance", () => {
    const text = Schema.Duration.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((d: Duration.Duration) => String(d)),
        encode: SchemaGetter.transform((s: string) => Duration.millis(Number.parseInt(s, 10))),
      }),
    )
    const { before, now } = both(text, stored(5))
    expect(valueOf(before)).toBe("[object Object]")
    expect(valueOf(now)).toBe("5 millis")

    const wrapped = Schema.Struct({ d: Schema.Duration }).pipe(
      Schema.decodeTo(Schema.Struct({ wrapped: Schema.Duration }), {
        decode: SchemaGetter.transform((s: { readonly d: Duration.Duration }) => ({
          wrapped: s.d,
        })),
        encode: SchemaGetter.transform((w: { readonly wrapped: Duration.Duration }) => ({
          d: w.wrapped,
        })),
      }),
    )
    const read = valueOf(decode(readingInstances(wrapped), { d: stored(5) })) as any
    expect(isReal(read.wrapped, 5)).toBe(true)
  })

  it("a failure its code reports of the instance is the failure the read reports", () => {
    const overTen = Schema.makeFilter(
      (d: any) =>
        (Equal.isEqual(d) && Duration.toMillis(d as Duration.Duration) > 10) || "over ten",
    )
    const { before, now } = both(Schema.Duration.check(realOnly, overTen), stored(5))
    expect(messageOf(before)).toBe("SchemaError(a real Duration)")
    expect(messageOf(now)).toBe("SchemaError(over ten)")

    // 1.39.0's check refused the first map; the first instance is over ten, the second isn't.
    const list = both(Schema.Array(Schema.Duration.check(overTen)), [stored(50), stored(5)])
    expect(messageOf(list.before)).toBe("SchemaError(over ten\n  at [0])")
    expect(messageOf(list.now)).toBe("SchemaError(over ten\n  at [1])")
  })
})

describe("a transformation onto a look-alike", () => {
  it("a step passing the stored map through: the declaration's parser took it, and it's the instance", () => {
    const codec = Schema.Unknown.pipe(
      Schema.decodeTo(Schema.Duration, {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      } as never),
    )
    const { before, now } = both(codec, stored(5))
    expect(isMap(valueOf(before))).toBe(true)
    expect(isReal(valueOf(now), 5)).toBe(true)
    // Its steps run as they did, on a write as on a read.
    const duration = millis(5)
    const encode = (schema: Schema.Top) =>
      Schema.encodeUnknownSync(schema as Schema.Codec<unknown, unknown>)(duration)
    expect(encode(readingInstances(codec))).toBe(duration)
    expect(encode(codec)).toBe(duration)
  })

  it("held by a struct, a list and an option", () => {
    const codec = Schema.Unknown.pipe(
      Schema.decodeTo(Schema.Duration, {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      } as never),
    )
    const model = Schema.Struct({ d: codec, l: Schema.Array(codec), o: Schema.Option(codec) })
    const row = asRead({ d: millis(1), l: [millis(2)], o: Option.some(millis(3)) })
    const read = valueOf(decode(readingInstances(model), row)) as any
    expect(isReal(read.d, 1)).toBe(true)
    expect(isReal(read.l[0], 2)).toBe(true)
    expect(isReal(Option.getOrThrow(read.o), 3)).toBe(true)
  })

  it("a step that makes the instance itself runs once, and what it made is what's read", () => {
    const step = counter()
    const made: Array<Duration.Duration> = []
    const codec = Schema.Number.pipe(
      Schema.decodeTo(Schema.Duration, {
        decode: SchemaGetter.transform((n: number) => {
          step.tick()
          const duration = millis(n)
          made.push(duration)
          return duration
        }),
        encode: SchemaGetter.transform((d: Duration.Duration) => Duration.toMillis(d)),
      } as never),
    )
    const read = readingInstances(codec)
    expect(valueOf(decode(read, 5))).toBe(made[0])
    expect(step.calls.count).toBe(1)
    // Read nodes are built once: a read schema read again is itself.
    expect(readingInstances(read)).toBe(read)
    expect(valueOf(decode(readingInstances(read), 6))).toBe(made[1])
    expect(step.calls.count).toBe(2)
  })

  it("one of Effect's own codecs makes its instance, and is left the schema it was", () => {
    for (const codec of [
      Schema.DurationFromMillis,
      Schema.DateTimeUtcFromString,
      Schema.BigDecimalFromString,
      Schema.Ipv4AddressFromString,
    ] as ReadonlyArray<Schema.Top>) {
      expect(readingInstances(codec)).toBe(codec)
      const held = Schema.Struct({ f: Schema.optionalKey(codec) })
      expect(readingInstances(held)).toBe(held)
    }
  })
})

describe("what doesn't change", () => {
  it("a union takes the member it took: the first that takes the map", () => {
    const first = both(
      Schema.Union([Schema.Duration, Schema.Struct({ value: Schema.Unknown })]),
      stored(5),
    )
    expect(isMap(valueOf(first.before))).toBe(true)
    expect(isReal(valueOf(first.now), 5)).toBe(true)

    const second = both(
      Schema.Union([Schema.Struct({ value: Schema.Unknown }), Schema.Duration]),
      stored(5),
    )
    expect(valueOf(second.now)).toEqual(valueOf(second.before))
    expect(Object.keys(valueOf(second.now) as object)).toEqual(["value"])
  })

  it("a member whose parser refuses the map stays refused", () => {
    const union = Schema.Union([Schema.Duration, Schema.String])
    const { before, now } = both(union, { value: { _tag: "Millis", millis: 5 } })
    expect(messageOf(now)).toBe(messageOf(before))
  })

  it("a read that fails where no code inspects a look-alike fails as 1.39.0's did", () => {
    const negative = Schema.makeFilter((n: number) => n >= 0 || "not negative")
    const cases: ReadonlyArray<readonly [Schema.Top, unknown]> = [
      [Schema.Duration, "not a duration"],
      [Schema.Struct({ d: Schema.Duration, n: Schema.Number }), { d: stored(5), n: "x" }],
      [
        Schema.Struct({ d: Schema.Duration, n: Schema.Number.check(negative) }),
        { d: stored(5), n: -1 },
      ],
      [Schema.Array(Schema.Duration), [stored(50), "x"]],
      [Schema.Union([Schema.Duration, Schema.Struct({ other: Schema.String })]), "x"],
      [Schema.Struct({ d: Schema.optionalKey(Schema.Duration) }), { d: 5 }],
      [Schema.Option(Schema.Duration), { _tag: "Some", value: stored(5) }],
    ]
    for (const [schema, value] of cases) {
      const { before, now } = both(schema, value)
      expect(messageOf(now)).toBe(messageOf(before))
    }
  })

  it("a failure that says the same of the map and the instance is the failure 1.39.0 reported", () => {
    const overTen = Schema.makeFilter(
      (d: any) =>
        (Equal.isEqual(d) && Duration.toMillis(d as Duration.Duration) > 10) || "over ten",
    )
    const cases: ReadonlyArray<readonly [Schema.Top, unknown]> = [
      [
        Schema.Union([Schema.Duration.check(overTen), Schema.Struct({ other: Schema.String })]),
        stored(5),
      ],
      [Schema.Struct({ d: Schema.optionalKey(Schema.Duration.check(overTen)) }), { d: stored(5) }],
      [
        Schema.Struct({ d: Schema.Duration }).check(
          Schema.makeFilter((s: any) => (Equal.isEqual(s.d) && false) || "never"),
        ),
        { d: stored(5) },
      ],
    ]
    for (const [schema, value] of cases) {
      const { before, now } = both(schema, value)
      expect(messageOf(now)).toBe(messageOf(before))
    }
  })
})

describe("an absent value", () => {
  const checked = Schema.Duration.check(realOnly)
  const checkedStruct = Schema.Struct({ d: Schema.Duration }).check(Schema.makeFilter(() => true))

  it("an optional or optional-key look-alike, absent, stays absent", () => {
    for (const property of [
      Schema.optionalKey(Schema.Duration),
      Schema.optional(Schema.Duration),
      Schema.optionalKey(checked),
      Schema.optional(checked),
      Schema.optionalKey(checkedStruct),
      Schema.optional(Schema.Union([Schema.Duration, Schema.String])),
    ]) {
      const field = Schema.Struct({ p: property })
      const read = valueOf(decode(readingInstances(field), {})) as object
      expect(Object.hasOwn(read, "p")).toBe(false)
    }
  })

  it("an optional or optional-key look-alike, present, reads the instance", () => {
    for (const property of [
      Schema.optionalKey(Schema.Duration),
      Schema.optional(Schema.Duration),
      Schema.optionalKey(checked),
      Schema.optional(checked),
    ]) {
      const field = Schema.Struct({ p: property })
      const read = valueOf(decode(readingInstances(field), { p: stored(5) })) as any
      expect(isReal(read.p, 5)).toBe(true)
    }
  })

  it("a look-alike with a decoding default reads the default when absent, the instance when not", () => {
    const made = counter()
    const field = Schema.Struct({
      p: Schema.Duration.pipe(
        Schema.withDecodingDefaultKey(
          Effect.sync(() => {
            made.tick()
            return millis(7)
          }),
        ),
      ),
    })
    const absent = valueOf(decode(readingInstances(field), {})) as any
    expect(isReal(absent.p, 7)).toBe(true)
    expect(made.calls.count).toBe(1)
    const present = valueOf(decode(readingInstances(field), { p: stored(5) })) as any
    expect(isReal(present.p, 5)).toBe(true)
    expect(made.calls.count).toBe(1)
  })

  it("a field that is itself optional keeps its optionality", () => {
    const field = Schema.optionalKey(Schema.Duration.check(realOnly))
    expect(readingInstances(field).ast.context?.isOptional).toBe(true)
    const model = Schema.Struct({ p: readingInstances(field) })
    expect(Object.hasOwn(valueOf(decode(model, {})) as object, "p")).toBe(false)
  })
})

describe("look-alikes wherever a model holds them", () => {
  it("in lists, records, tuples, options and classes", () => {
    class Holder extends Schema.Class<Holder>("Holder")({ d: Schema.Duration }) {}
    const field = Schema.Struct({
      list: Schema.Array(Schema.Duration),
      record: Schema.Record(Schema.String, Schema.Duration),
      tuple: Schema.Tuple([Schema.Duration, Schema.String]),
      option: Schema.Option(Schema.Duration),
      holder: Holder,
    })
    const value = {
      list: [millis(1)],
      record: { a: millis(2) },
      tuple: [millis(3), "x"],
      option: Option.some(millis(4)),
      holder: new Holder({ d: millis(5) }),
    }
    const read = valueOf(decode(readingInstances(field), asRead(value))) as any
    expect(isReal(read.list[0], 1)).toBe(true)
    expect(isReal(read.record.a, 2)).toBe(true)
    expect(isReal(read.tuple[0], 3)).toBe(true)
    expect(isReal(Option.getOrThrow(read.option), 4)).toBe(true)
    expect(read.holder).toBeInstanceOf(Holder)
    expect(isReal(read.holder.d, 5)).toBe(true)
  })

  it("in a recursive schema", () => {
    interface Tree {
      readonly d: Duration.Duration
      readonly children: ReadonlyArray<Tree>
    }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      d: Schema.Duration,
      children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
    })
    const value = { d: millis(1), children: [{ d: millis(2), children: [] }] }
    const read = valueOf(decode(readingInstances(Tree), asRead(value))) as any
    expect(isReal(read.d, 1)).toBe(true)
    expect(isReal(read.children[0].d, 2)).toBe(true)
  })

  it("an encode through a read is the encode 1.39.0's schema made", () => {
    const field = Schema.Struct({
      d: Schema.Duration.check(realOnly),
      u: Schema.Union([Schema.Duration, Schema.String]),
    }).check(Schema.makeFilter(() => true))
    const value = { d: millis(5), u: millis(6) }
    const encode = (schema: Schema.Top) =>
      valueOf(Schema.encodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value))
    expect(encode(readingInstances(field))).toEqual(encode(field))
  })
})
