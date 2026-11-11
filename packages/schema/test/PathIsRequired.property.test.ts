/**
 * The removal guard is never wrong, with Effect's own decoder as the oracle. Whenever
 * `pathIsRequired` refuses a removal below a field, removing that property or splicing out that
 * list position leaves every sampled value of the field that holds it one the field's schema
 * refuses, and no sampled value holds what's above it without holding it (DynamoDB leaves such a
 * value as it was, so it would still read).
 *
 * Schemas are built by nesting wrappers at random, from a seed, and values are sampled from
 * Effect's arbitrary for each, encoded to what's stored. A failure names the seed that rebuilds
 * its schema; a failing seed becomes a fixed case in `RowCanLack.test.ts`. This asserts soundness
 * only: a refusal is never wrong. It doesn't ask that every removal leaving a row that can't be
 * read is refused.
 */
import { Arbitrary, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { pathIsRequired } from "../src/internal/SchemaAccessors.js"

const SCHEMAS = 400
const FIRST_SEED = 1

/** mulberry32: a small seeded generator, so a schema rebuilds from its seed alone. */
const generator = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Built = { readonly schema: Schema.Top; readonly label: string }
type Random = () => number
type Child = () => Built

const S = Schema.String

const LEAVES: ReadonlyArray<Built> = [
  { schema: S, label: "string" },
  { schema: Schema.Number, label: "number" },
  { schema: Schema.Literal("a"), label: '"a"' },
  { schema: Schema.Boolean, label: "boolean" },
  { schema: Schema.Null, label: "null" },
  { schema: Schema.Struct({}), label: "{}" },
  { schema: Schema.Unknown, label: "unknown" },
  { schema: Schema.NumberFromString, label: "NumberFromString" },
]

const sample = (schema: Schema.Top, count: number, size: number, seed: number) =>
  Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(schema as never), { count, size, seed }))

const pick = <A>(random: Random, items: ReadonlyArray<A>): A =>
  items[Math.floor(random() * items.length)]!

const range = (random: Random, low: number, high: number): ReadonlyArray<number> =>
  Array.from({ length: low + Math.floor(random() * (high - low + 1)) }, (_, i) => i)

/** A struct's property: as it is, optional, an optional key, or a key with a decoding default. */
const property = (child: Child, random: Random): Built => {
  const built = child()
  const roll = random()
  if (roll < 0.2) return { schema: Schema.optional(built.schema), label: `${built.label}?` }
  if (roll < 0.3) return { schema: Schema.optionalKey(built.schema), label: `${built.label}?:` }
  if (roll < 0.38) {
    const [value] = sample(built.schema, 1, 2, Math.floor(random() * 1e9))
    const stored = Schema.encodeUnknownSync(built.schema as never)(value)
    return {
      schema: (built.schema as Schema.Codec<unknown, unknown>).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(stored)),
      ),
      label: `${built.label} = default`,
    }
  }
  return built
}

const fieldsOf = (child: Child, random: Random, low: number, high: number) => {
  const built = range(random, low, high).map((i) => [`p${i}`, property(child, random)] as const)
  return {
    fields: Object.fromEntries(built.map(([name, field]) => [name, field.schema])),
    label: `{ ${built.map(([name, field]) => `${name}: ${field.label}`).join(", ")} }`,
  }
}

const tupleOf = (child: Child, random: Random, optional: boolean) => {
  const required = range(random, 0, 2).map(() => child())
  const optionals = optional ? range(random, 0, 2).map(() => child()) : []
  return {
    elements: [
      ...required.map((element) => element.schema),
      ...optionals.map((element) =>
        random() < 0.5 ? Schema.optional(element.schema) : Schema.optionalKey(element.schema),
      ),
    ],
    label: [...required.map((e) => e.label), ...optionals.map((e) => `${e.label}?`)].join(", "),
  }
}

let classes = 0

const WRAPPERS: ReadonlyArray<(child: Child, random: Random) => Built> = [
  // A struct.
  (child, random) => {
    const { fields, label } = fieldsOf(child, random, 1, 3)
    return { schema: Schema.Struct(fields), label }
  },
  // A record with one index signature.
  (child) => {
    const value = child()
    return { schema: Schema.Record(S, value.schema), label: `Record<string, ${value.label}>` }
  },
  // A record with two index signatures.
  (child) => {
    const [a, b] = [child(), child()]
    return {
      schema: Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(Schema.TemplateLiteral(["a-", S]), a.schema),
        Schema.Record(Schema.TemplateLiteral(["b-", S]), b.schema),
      ]),
      label: `{ [a-*]: ${a.label}, [b-*]: ${b.label} }`,
    }
  },
  // A struct with a rest.
  (child) => {
    const value = child()
    return {
      schema: Schema.StructWithRest(Schema.Struct({ p0: value.schema }), [
        Schema.Record(S, value.schema),
      ]),
      label: `{ p0: ${value.label}, [string]: ${value.label} }`,
    }
  },
  // An array.
  (child) => {
    const element = child()
    return { schema: Schema.Array(element.schema), label: `${element.label}[]` }
  },
  // A tuple, with optional positions.
  (child, random) => {
    const { elements, label } = tupleOf(child, random, true)
    return { schema: Schema.Tuple(elements), label: `[${label}]` }
  },
  // A tuple with one rest element.
  (child, random) => {
    const { elements, label } = tupleOf(child, random, true)
    const rest = child()
    return {
      schema: Schema.TupleWithRest(Schema.Tuple(elements), [rest.schema]),
      label: `[${label}, ...${rest.label}[]]`,
    }
  },
  // A tuple with several rest elements.
  (child, random) => {
    const { elements, label } = tupleOf(child, random, false)
    const [rest, after] = [child(), child()]
    return {
      schema: Schema.TupleWithRest(Schema.Tuple(elements), [rest.schema, after.schema]),
      label: `[${label}, ...${rest.label}[], ${after.label}]`,
    }
  },
  // A union.
  (child, random) => {
    const members = range(random, 2, 3).map(() => child())
    return {
      schema: Schema.Union(members.map((member) => member.schema)),
      label: `Union(${members.map((member) => member.label).join(" | ")})`,
    }
  },
  // A union with an `Unknown` member.
  (child) => {
    const member = child()
    return {
      schema: Schema.Union([member.schema, Schema.Unknown]),
      label: `Union(${member.label} | unknown)`,
    }
  },
  // A tagged union.
  (child) => {
    const [a, b] = [child(), child()]
    return {
      schema: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), p: a.schema }),
        Schema.Struct({ kind: Schema.Literal("b"), p: b.schema }),
      ]),
      label: `Union({ kind: a, p: ${a.label} } | { kind: b, p: ${b.label} })`,
    }
  },
  // A `Schema.TaggedStruct` union.
  (child) => {
    const [a, b] = [child(), child()]
    return {
      schema: Schema.Union([
        Schema.TaggedStruct("A", { p: a.schema }),
        Schema.TaggedStruct("B", { p: b.schema, q: S }),
      ]),
      label: `Union(A { p: ${a.label} } | B { p: ${b.label}, q: string })`,
    }
  },
  // A `Schema.Class`.
  (child, random) => {
    const { fields, label } = fieldsOf(child, random, 1, 2)
    const identifier = `PathIsRequiredGenerated${classes++}`
    class Generated extends Schema.Class<Generated>(identifier)(fields) {}
    return { schema: Generated, label: `class ${label}` }
  },
  // A suspension.
  (child) => {
    const inner = child()
    return { schema: Schema.suspend(() => inner.schema), label: `suspend(${inner.label})` }
  },
  // A recursive schema.
  (child) => {
    const value = child()
    type Tree = { readonly v: unknown; readonly kids: ReadonlyArray<Tree> }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      v: value.schema as Schema.Codec<unknown>,
      kids: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
    })
    return { schema: Tree, label: `Tree<${value.label}>` }
  },
  // A check.
  (child) => {
    const inner = child()
    return {
      schema: (inner.schema as Schema.Codec<unknown>).check(Schema.makeFilter(() => true)),
      label: `${inner.label}.check()`,
    }
  },
  // A transformation that recovers a failed read.
  (child, random) => {
    const inner = child()
    const [fallback] = sample(inner.schema, 1, 2, Math.floor(random() * 1e9))
    return {
      schema: (inner.schema as Schema.Codec<unknown>).pipe(
        Schema.catchDecoding(() => Effect.succeedSome(fallback)),
      ),
      label: `${inner.label}.catchDecoding()`,
    }
  },
  // A transformation renaming a key.
  (child) => {
    const value = child()
    return {
      schema: Schema.Struct({ p0: value.schema, p1: S }).pipe(Schema.encodeKeys({ p0: "P0" })),
      label: `{ p0 (as P0): ${value.label}, p1: string }`,
    }
  },
  // Nullable.
  (child) => {
    const inner = child()
    return { schema: Schema.NullOr(inner.schema), label: `${inner.label} | null` }
  },
]

const build = (random: Random, depth: number): Built => {
  if (depth === 0 || random() < 0.15) return pick(random, LEAVES)
  const wrapper = pick(random, WRAPPERS)
  const built: Array<Built> = []
  const child = () => {
    const inner = build(random, depth - 1)
    built.push(inner)
    return inner
  }
  try {
    return wrapper(child, random)
  } catch {
    // A wrapper Effect refuses for this child (a check on a suspension): the child as it is.
    return built[0] ?? pick(random, LEAVES)
  }
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** What DynamoDB would store: an attribute holding `undefined` is left out. `undefined` for
 * anything it can't hold (an `undefined` list element, a function, a class instance). */
const stored = (value: unknown): { readonly value: unknown } | undefined => {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return { value }
  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? undefined : stored(item)))
    return items.every((item) => item !== undefined)
      ? { value: items.map((item) => item!.value) }
      : undefined
  }
  if (isMap(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [name, held] of Object.entries(value)) {
      if (held === undefined) continue
      const item = stored(held)
      if (item === undefined) return undefined
      out[name] = item.value
    }
    return { value: out }
  }
  return undefined
}

/** Every path a value holds, plus a position past each list's end and a property no map has. */
const pathsOf = (
  value: unknown,
  prefix: ReadonlyArray<string | number>,
  out: Map<string, ReadonlyArray<string | number>>,
): void => {
  if (prefix.length >= 5) return
  const add = (path: ReadonlyArray<string | number>) => out.set(JSON.stringify(path), path)
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      add([...prefix, i])
      pathsOf(item, [...prefix, i], out)
    })
    add([...prefix, value.length])
  } else if (isMap(value)) {
    for (const [name, held] of Object.entries(value)) {
      add([...prefix, name])
      pathsOf(held, [...prefix, name], out)
    }
    add([...prefix, "absent"])
  }
}

/** The container at `prefix`, where each segment is there and of the kind DynamoDB needs. */
const containerAt = (value: unknown, prefix: ReadonlyArray<string | number>): unknown => {
  let at: unknown = value
  for (const segment of prefix) {
    if (typeof segment === "number") {
      if (!Array.isArray(at) || segment >= at.length) return undefined
      at = at[segment]
    } else {
      if (!isMap(at) || !Object.hasOwn(at, segment)) return undefined
      at = at[segment]
    }
  }
  return at
}

/** `value` with the path removed as DynamoDB removes it: a list closes up. */
const removed = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
  const [head, ...rest] = path
  if (Array.isArray(value) && typeof head === "number") {
    return rest.length === 0
      ? value.filter((_, i) => i !== head)
      : value.map((item, i) => (i === head ? removed(item, rest) : item))
  }
  if (isMap(value) && typeof head === "string") {
    if (rest.length === 0) {
      const { [head]: _, ...left } = value
      return left
    }
    return { ...value, [head]: removed(value[head], rest) }
  }
  return value
}

type Finding = {
  readonly seed: number
  readonly field: string
  readonly path: ReadonlyArray<string | number>
  readonly value: unknown
  readonly problem: string
}

describe("pathIsRequired, against Effect's decoder", () => {
  it(`refuses no removal a value of the field survives, over ${SCHEMAS} generated schemas`, () => {
    const findings: Array<Finding> = []
    let refusals = 0
    let sampled = 0
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SCHEMAS; seed++) {
      const random = generator(seed)
      const { schema, label } = build(random, 1 + Math.floor(random() * 4))
      const decode = Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)
      const encode = Schema.encodeUnknownExit(schema as Schema.Codec<unknown, unknown>)
      let values: ReadonlyArray<unknown>
      try {
        values = sample(schema, 24, 4, seed).flatMap((value) => {
          const encoded = encode(value)
          const held = Exit.isSuccess(encoded) ? stored(encoded.value) : undefined
          return held !== undefined && Exit.isSuccess(decode(held.value)) ? [held.value] : []
        })
      } catch {
        continue
      }
      if (values.length > 0) sampled++
      const paths = new Map<string, ReadonlyArray<string | number>>()
      for (const value of values) pathsOf(value, [], paths)
      for (const path of paths.values()) {
        if (!pathIsRequired(schema, path)) continue
        refusals++
        const prefix = path.slice(0, -1)
        const last = path[path.length - 1]!
        for (const value of values) {
          const container = containerAt(value, prefix)
          const holds =
            typeof last === "number"
              ? Array.isArray(container) && last < container.length
              : isMap(container) && Object.hasOwn(container, last)
          const holdsAbove = typeof last === "number" ? Array.isArray(container) : isMap(container)
          if (!holdsAbove) continue
          if (!holds) {
            findings.push({ seed, field: label, path, value, problem: "left as it was, reads" })
          } else if (Exit.isSuccess(decode(removed(value, path)))) {
            findings.push({ seed, field: label, path, value, problem: "what's left reads" })
          }
        }
      }
    }
    expect(findings.slice(0, 5)).toEqual([])
    // Not vacuous: most schemas sampled values, and the guard refused many removals.
    expect(sampled).toBeGreaterThan(SCHEMAS * 0.8)
    expect(refusals).toBeGreaterThan(100)
  })
})
