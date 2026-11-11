/**
 * Schemas built by nesting wrappers at random, from a seed, and values sampled from Effect's
 * arbitrary for each, encoded to what DynamoDB stores: the generator of `ReadersAt.property.test.ts`.
 * It is `PathIsRequired.property.test.ts`'s, so a seed builds the same schema in both.
 */
import { Arbitrary, Effect, Schema } from "effect"

/** mulberry32: a small seeded generator, so a schema rebuilds from its seed alone. */
export const generator = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Built = { readonly schema: Schema.Top; readonly label: string }
export type Random = () => number
type Child = () => Built

const S = Schema.String

export const LEAVES: ReadonlyArray<Built> = [
  { schema: S, label: "string" },
  { schema: Schema.Number, label: "number" },
  { schema: Schema.Literal("a"), label: '"a"' },
  { schema: Schema.Boolean, label: "boolean" },
  { schema: Schema.Null, label: "null" },
  { schema: Schema.Struct({}), label: "{}" },
  { schema: Schema.Unknown, label: "unknown" },
  { schema: Schema.NumberFromString, label: "NumberFromString" },
]

export const sample = (schema: Schema.Top, count: number, size: number, seed: number) =>
  Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(schema as never), { count, size, seed }))

export const pick = <A>(random: Random, items: ReadonlyArray<A>): A =>
  items[Math.floor(random() * items.length)]!

export const range = (random: Random, low: number, high: number): ReadonlyArray<number> =>
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

export const WRAPPERS: ReadonlyArray<(child: Child, random: Random) => Built> = [
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
    const identifier = `Generated${classes++}`
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

export const build = (random: Random, depth: number): Built => {
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

export const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** What DynamoDB would store: an attribute holding `undefined` is left out. `undefined` for
 * anything it can't hold (an `undefined` list element, a function, a class instance). */
export const stored = (value: unknown): { readonly value: unknown } | undefined => {
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
export const pathsOf = (
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
export const containerAt = (value: unknown, prefix: ReadonlyArray<string | number>): unknown => {
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
