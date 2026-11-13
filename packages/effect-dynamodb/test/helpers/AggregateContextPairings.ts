/**
 * A root `context` attribute that a member declares too (#241, `EDD-9159`), by every pairing of the
 * root's type with the member's own declaration: the same type, another form of it (a number and
 * its string form, a date and another date encoding, a `bigint` and its string form), `Schema.Unknown`,
 * a set given its members in another order, bytes. The member declares it as is, optional, renamed
 * with `field:` (an entity's `DynamoModel.configure`) or stored packed (`DynamoModel.Packed`), at a
 * `one` edge, a `many` element, a sub-aggregate's root and a `many` edge with a custom `decompose`
 * and `assemble`. The member is given the root's value (`same`, in a form of its own where it has
 * one), another value (`other`), or, where it's optional, none.
 *
 * `runPairing` creates the aggregate and reads it, recording what was sent, stored and returned,
 * each value tagged so that two values that differ record differently (`tagged`): a set's members
 * sorted, a `bigint`, bytes, a date and a `DateTime` as such. `fixtures/aggregate-context-pairings-1.40.0.json`
 * holds what published 1.40.0 did, captured by running this module with its modules.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { Effect } from "effect"

export type Row = Record<string, AttributeValue>
export type Request = { readonly command: string; readonly input: unknown }
export type Outcome = {
  readonly ok?: unknown
  readonly failed?: string
  readonly operation?: string
  readonly member?: string
  readonly reason?: string
}
export type Recorded = {
  /** Where defining the case throws (a packed scalar, `EDD-9073`): the message, and nothing else. */
  readonly make?: string
  readonly create: Outcome
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
  /** The input `create` was given, tagged. */
  readonly input: unknown
}

/** The modules of one release. */
export type PairLib = {
  readonly Aggregate: any
  readonly Entity: any
  readonly DynamoClient: any
  readonly Table: any
  readonly DynamoSchema: any
  readonly DynamoModel: any
  readonly Schema: any
  readonly Effect: any
  readonly DateTime: any
  readonly Exit: any
  readonly Cause: any
  readonly Layer: any
}

/** What a run sends and reads through: a recording client on a table of its own. */
export type PairIo = {
  readonly tableName: string
  readonly client: any
  /** The requests sent since the last call, the table's name as `<table>`. */
  readonly take: () => ReadonlyArray<Request>
  /** Every row, in key order. */
  readonly scan: () => Effect.Effect<ReadonlyArray<Row>, unknown>
}

type Values = { readonly root: unknown; readonly same: unknown; readonly other: unknown }
type Kind = {
  readonly root: (lib: PairLib) => any
  readonly member: (lib: PairLib) => any
  readonly values: (lib: PairLib) => Values
}

const at = (lib: PairLib, ms: number) => lib.DateTime.makeUnsafe(ms)
const dates = (lib: PairLib): Values => ({
  root: at(lib, 1714979289000),
  same: at(lib, 1714979289000),
  other: at(lib, 1714979300000),
})

/** The pairings: the root's type, the member's own declaration, and the values given. */
export const KINDS: Readonly<Record<string, Kind>> = {
  "Number / Number": {
    root: (l) => l.Schema.Number,
    member: (l) => l.Schema.Number,
    values: () => ({ root: 5, same: 5, other: 6 }),
  },
  "Number / NumberFromString": {
    root: (l) => l.Schema.Number,
    member: (l) => l.Schema.NumberFromString,
    values: () => ({ root: 5, same: 5, other: 6 }),
  },
  "NumberFromString / Number": {
    root: (l) => l.Schema.NumberFromString,
    member: (l) => l.Schema.Number,
    values: () => ({ root: 5, same: 5, other: 6 }),
  },
  "Number / Unknown": {
    root: (l) => l.Schema.Number,
    member: (l) => l.Schema.Unknown,
    values: () => ({ root: 5, same: 5, other: "5" }),
  },
  "BigInt / BigInt": {
    root: (l) => l.Schema.BigInt,
    member: (l) => l.Schema.BigInt,
    values: () => ({ root: 5n, same: 5n, other: 6n }),
  },
  "BigInt / BigIntFromString": {
    root: (l) => l.Schema.BigInt,
    member: (l) => l.Schema.BigIntFromString,
    values: () => ({ root: 5n, same: 5n, other: 6n }),
  },
  "String / String": {
    root: (l) => l.Schema.String,
    member: (l) => l.Schema.String,
    values: () => ({ root: "x", same: "x", other: "y" }),
  },
  "String / Unknown": {
    root: (l) => l.Schema.String,
    member: (l) => l.Schema.Unknown,
    values: () => ({ root: "5", same: "5", other: 5 }),
  },
  "DateEpochMs / DateEpochMs": {
    root: (l) => l.DynamoModel.DateEpochMs,
    member: (l) => l.DynamoModel.DateEpochMs,
    values: dates,
  },
  "DateEpochMs / DateString": {
    root: (l) => l.DynamoModel.DateEpochMs,
    member: (l) => l.DynamoModel.DateString,
    values: dates,
  },
  "DateString / DateEpochMs": {
    root: (l) => l.DynamoModel.DateString,
    member: (l) => l.DynamoModel.DateEpochMs,
    values: dates,
  },
  "DateTimeUtc / DateEpochMs": {
    root: (l) => l.Schema.DateTimeUtc,
    member: (l) => l.DynamoModel.DateEpochMs,
    values: dates,
  },
  "ReadonlySet(String) / ReadonlySet(String)": {
    root: (l) => l.Schema.ReadonlySet(l.Schema.String),
    member: (l) => l.Schema.ReadonlySet(l.Schema.String),
    values: () => ({
      root: new Set(["a", "b"]),
      same: new Set(["b", "a"]),
      other: new Set(["a", "c"]),
    }),
  },
  "ReadonlySet(Number) / ReadonlySet(Number)": {
    root: (l) => l.Schema.ReadonlySet(l.Schema.Number),
    member: (l) => l.Schema.ReadonlySet(l.Schema.Number),
    values: () => ({ root: new Set([1, 2]), same: new Set([2, 1]), other: new Set([1, 3]) }),
  },
  "ReadonlySet(String) / Unknown": {
    root: (l) => l.Schema.ReadonlySet(l.Schema.String),
    member: (l) => l.Schema.Unknown,
    values: () => ({
      root: new Set(["a", "b"]),
      same: new Set(["b", "a"]),
      other: ["a", "b"],
    }),
  },
  "Uint8Array / Uint8Array": {
    root: (l) => l.Schema.Uint8Array,
    member: (l) => l.Schema.Uint8Array,
    values: () => ({
      root: new Uint8Array([1, 2, 3]),
      same: new Uint8Array([1, 2, 3]),
      other: new Uint8Array([1, 2, 4]),
    }),
  },
  "Struct / Unknown": {
    root: (l) => l.Schema.Struct({ a: l.Schema.String }),
    member: (l) => l.Schema.Unknown,
    values: () => ({ root: { a: "1" }, same: { a: "1" }, other: '{"a":"1"}' }),
  },
}

export const VARIANTS = ["declared", "optional", "renamed", "packed"] as const
export const POSITIONS = ["one", "many", "sub", "custom"] as const
export const GIVENS = ["same", "other", "none"] as const
export type Variant = (typeof VARIANTS)[number]
export type Position = (typeof POSITIONS)[number]
export type Given = (typeof GIVENS)[number]
export type Case = {
  readonly kind: string
  readonly variant: Variant
  readonly position: Position
  readonly given: Given
}

/** Every case: a renamed or packed member is an entity's, at a `one` or `many` edge. */
export const cases: ReadonlyArray<Case & { readonly label: string }> = Object.keys(KINDS).flatMap(
  (kind) =>
    POSITIONS.flatMap((position) =>
      VARIANTS.filter(
        (variant) =>
          position === "one" ||
          position === "many" ||
          variant === "declared" ||
          variant === "optional",
      ).flatMap((variant) =>
        GIVENS.filter((given) => given !== "none" || variant === "optional").map((given) => ({
          kind,
          variant,
          position,
          given,
          label: `${kind}, ${variant} at ${position}, given ${given}`,
        })),
      ),
    ),
)

/**
 * A value as recorded: JSON in which two values that differ differ: a `bigint`, a set (its members
 * sorted), a map, bytes, a `Date` and a `DateTime` are tagged; an object's keys sorted.
 */
export const tagged = (lib: PairLib, value: unknown): unknown => {
  const walk = (x: unknown): unknown => {
    if (typeof x === "bigint") return { $bigint: String(x) }
    if (typeof x === "number" && !Number.isFinite(x)) return { $number: String(x) }
    if (typeof x !== "object" || x === null) return x
    if (lib.DateTime.isDateTime(x)) {
      return lib.DateTime.isZoned(x)
        ? { $zoned: lib.DateTime.formatIsoZoned(x) }
        : { $utc: lib.DateTime.formatIso(x) }
    }
    if (x instanceof Date) return { $date: Number.isNaN(x.getTime()) ? "invalid" : x.toISOString() }
    if (x instanceof Uint8Array) return { $bytes: [...x] }
    if (x instanceof Set) {
      return { $set: [...x].map((member) => JSON.stringify(walk(member))).sort() }
    }
    if (x instanceof Map) {
      return {
        $map: [...x].map(([k, v]) => JSON.stringify([walk(k), walk(v)])).sort(),
      }
    }
    if (Array.isArray(x)) return x.map(walk)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(x).sort()) {
      const v = (x as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = walk(v)
    }
    return out
  }
  return walk(value)
}

/** The aggregate of a case, over one release's modules, and the entity of its member. */
export const definePairing = (lib: PairLib, c: Case) => {
  const { Schema, DynamoModel, Aggregate } = lib
  const kind = KINDS[c.kind]!
  const member = c.variant === "optional" ? Schema.optional(kind.member(lib)) : kind.member(lib)
  const Note = Schema.Struct({
    k: Schema.String.pipe(DynamoModel.identifier),
    text: Schema.String,
    v: member,
  })
  const model =
    c.variant === "renamed"
      ? DynamoModel.configure(Note, { v: { field: "vv" } })
      : c.variant === "packed"
        ? DynamoModel.configure(Note, { v: { storedAs: DynamoModel.Packed({ format: "json" }) } })
        : Note
  const Notes = lib.Entity.make({
    model,
    entityType: "Member",
    primaryKey: { pk: { field: "pk", composite: ["k"] }, sk: { field: "sk", composite: [] } },
  })
  const schema = lib.DynamoSchema.make({ name: "pair", version: 1, escapeKeys: false })
  const Main = lib.Table.make({ schema, entities: { Notes } })
  const Part = Schema.Struct({ name: Schema.String, v: member })
  const Line = Schema.Struct({ k: Schema.String, v: member })
  const field =
    c.position === "one"
      ? Note
      : c.position === "many"
        ? Schema.Array(Note)
        : c.position === "sub"
          ? Part
          : Schema.Array(Line)
  const edge =
    c.position === "one"
      ? Aggregate.one({ entity: Notes, entityType: "Note" })
      : c.position === "many"
        ? Aggregate.many({ entity: Notes, entityType: "Note", sk: { composite: ["k"] } })
        : c.position === "sub"
          ? Aggregate.make(Part, { root: { entityType: "Part" }, edges: {} }).with({
              discriminator: { side: 1 },
            })
          : Aggregate.many({
              entityType: "Line",
              sk: { composite: ["k"] },
              decompose: (lines: ReadonlyArray<unknown>) => lines,
              assemble: (rows: ReadonlyArray<unknown>) => rows,
            })
  const A = Aggregate.make(
    Schema.Struct({ id: Schema.String, title: Schema.String, v: kind.root(lib), m: field }),
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "pair" },
      root: { entityType: "Root" },
      context: ["v"],
      edges: { m: edge },
    },
  )
  return { A, Notes, Main }
}

/** The input `create` is given. */
export const pairingInput = (lib: PairLib, c: Case) => {
  const values = KINDS[c.kind]!.values(lib)
  const v = c.given === "none" ? {} : { v: c.given === "same" ? values.same : values.other }
  const m =
    c.position === "one"
      ? { k: "k1", text: "n", ...v }
      : c.position === "many"
        ? [{ k: "k1", text: "n", ...v }]
        : c.position === "sub"
          ? { name: "p", ...v }
          : [{ k: "k1", ...v }]
  return { id: "a", title: "t", v: values.root, m }
}

/** The member's value of `v`, from an aggregate's value: each element's for a `many` edge. */
export const memberValues = (value: any): ReadonlyArray<unknown> =>
  Array.isArray(value?.m) ? value.m.map((element: any) => element?.v) : [value?.m?.v]

const outcomeOf = (lib: PairLib, exit: any): Outcome => {
  if (lib.Exit.isSuccess(exit)) return { ok: tagged(lib, exit.value) }
  const error = lib.Cause.squash(exit.cause) as {
    _tag?: string
    operation?: string
    member?: string
    reason?: string
  }
  return {
    failed: error._tag ?? "defect",
    ...(error.operation !== undefined && { operation: error.operation }),
    ...(error.member !== undefined && { member: error.member }),
    ...(error.reason !== undefined && { reason: error.reason }),
  }
}

const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`

/** Create the case's aggregate with `lib`'s release, then read it. */
export const runPairing = (
  lib: PairLib,
  c: Case,
  io: PairIo,
): Effect.Effect<Recorded | { readonly make: string }, unknown> => {
  const { Effect, Layer } = lib
  let defined: ReturnType<typeof definePairing>
  try {
    defined = definePairing(lib, c)
  } catch (error) {
    return Effect.succeed({ make: String((error as Error).message) })
  }
  const { A, Notes, Main } = defined
  return Effect.gen(function* () {
    const db: any = yield* lib.DynamoClient.make({
      entities: { Notes },
      aggregates: { A },
      tables: { Main },
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(lib.DynamoClient, io.client), Main.layer({ name: io.tableName })),
      ),
    )
    io.take()
    const input = pairingInput(lib, c)
    const create = outcomeOf(lib, yield* Effect.exit(db.aggregates.A.create(input)))
    const requests = io.take()
    const rows = [...(yield* io.scan())].sort((a, b) =>
      keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
    )
    const get = outcomeOf(lib, yield* Effect.exit(db.aggregates.A.get({ id: "a" })))
    io.take()
    return { create, requests, rows, get, input: tagged(lib, input) }
  }) as Effect.Effect<Recorded, unknown>
}
