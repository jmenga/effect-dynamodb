/**
 * `escapeKeys` turned over without `rekey` (#241, `EDD-9160`): an aggregate's rows written under one
 * setting, then updated under the other. Each case is created under its `from` setting; each step is
 * one `update` under its `to` setting, from the rows the create wrote. `runFlip` records what was
 * sent, stored and returned; `fixtures/aggregate-escape-flip-1.40.0.json` holds what published 1.40.0
 * did, captured by running this module with its modules (the create included).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { Effect } from "effect"

export type Row = Record<string, AttributeValue>
export type Request = { readonly command: string; readonly input: unknown }
export type Outcome = { readonly ok?: unknown; readonly failed?: string; readonly cause?: string }
export type Step = {
  readonly update: Outcome
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
}
export type Recorded = {
  readonly create: Outcome
  readonly created: ReadonlyArray<Row>
  readonly steps: Record<string, Step>
}
export type FlipLib = {
  readonly Aggregate: any
  readonly DynamoClient: any
  readonly Table: any
  readonly DynamoSchema: any
  readonly Schema: any
  readonly Effect: any
  readonly Exit: any
  readonly Cause: any
  readonly Layer: any
}
export type FlipIo = {
  readonly tableName: string
  readonly client: any
  readonly take: () => ReadonlyArray<Request>
  readonly scan: () => Effect.Effect<ReadonlyArray<Row>, unknown>
  /** Store rows as they are (the head's run starts from the rows 1.40.0's create wrote). */
  readonly seed?: ((rows: ReadonlyArray<Row>) => Effect.Effect<void, unknown>) | undefined
}

export type Case = {
  readonly name: string
  readonly from: boolean
  readonly to: boolean
  /** The `lines` elements' sort key values. */
  readonly keys: ReadonlyArray<string | number>
  /** The sub-aggregate's discriminator value. */
  readonly side: string
}

export const cases: ReadonlyArray<Case> = [
  {
    name: "no escaped character, turned on",
    from: false,
    to: true,
    keys: ["k1", "k2"],
    side: "d1",
  },
  {
    name: "$ and # in a many sort key, turned on",
    from: false,
    to: true,
    keys: ["k#1$", "k2"],
    side: "d1",
  },
  {
    name: "$ and # in a discriminator, turned on",
    from: false,
    to: true,
    keys: ["k1", "k2"],
    side: "d#1$",
  },
  {
    name: "$ and # in a many sort key, turned off",
    from: true,
    to: false,
    keys: ["k#1$", "k2"],
    side: "d1",
  },
  {
    name: "$ and # in a many sort key, kept off",
    from: false,
    to: false,
    keys: ["k#1$", "k2"],
    side: "d1",
  },
  {
    name: "$ and # in a many sort key, kept on",
    from: true,
    to: true,
    keys: ["k#1$", "k2"],
    side: "d1",
  },
  // Under one setting a value's text is another value's under the other: `a b` escapes to `a%20b`.
  {
    name: "values whose texts alias across the settings, kept off",
    from: false,
    to: false,
    keys: ["a b", "a%20b"],
    side: "d1",
  },
  {
    name: "values whose texts alias across the settings, kept on",
    from: true,
    to: true,
    keys: ["a b", "a%20b"],
    side: "d1",
  },
  {
    name: "values whose texts alias across the settings, turned on",
    from: false,
    to: true,
    keys: ["a b", "a%20b"],
    side: "d1",
  },
  // Numbers: off composes 1.36's zero-padded `String(n)`, on their numeric-order text.
  {
    name: "a negative number in a many sort key, turned on",
    from: false,
    to: true,
    keys: [-5, 7],
    side: "d1",
  },
  {
    name: "a negative number in a many sort key, kept off",
    from: false,
    to: false,
    keys: [-5, 7],
    side: "d1",
  },
  {
    name: "a non-negative integer in a many sort key, turned on",
    from: false,
    to: true,
    keys: [5, 7],
    side: "d1",
  },
]

export const stepNames = [
  "no change",
  "root field",
  "element changed",
  "element added",
  "element removed",
  "sub field",
  "sub element added",
] as const

const mutate = (name: (typeof stepNames)[number], c: Case, s: any): any => {
  const extra = typeof c.keys[0] === "number" ? 100 : "z"
  switch (name) {
    case "no change":
      return s
    case "root field":
      return { ...s, title: "t2" }
    case "element changed":
      return { ...s, lines: s.lines.map((l: any) => ({ ...l, qty: l.qty + 10 })) }
    case "element added":
      return { ...s, lines: [...s.lines, { k: extra, qty: 9 }] }
    case "element removed":
      return { ...s, lines: s.lines.filter((l: any) => l.k !== c.keys[1]) }
    case "sub field":
      return { ...s, part: { ...s.part, name: "p2" } }
    case "sub element added":
      return { ...s, part: { ...s.part, bits: [...s.part.bits, { k: extra, qty: 4 }] } }
  }
}

export const defineFlip = (lib: FlipLib, c: Case, escapeKeys: boolean) => {
  const { Aggregate: A, Schema } = lib
  const schema = lib.DynamoSchema.make({ name: "flip", version: 1, escapeKeys })
  const Main = lib.Table.make({ schema, entities: {} })
  const K = typeof c.keys[0] === "number" ? Schema.Number : Schema.String
  const Line = Schema.Struct({ k: K, qty: Schema.Number })
  const Part = Schema.Struct({ name: Schema.String, bits: Schema.Array(Line) })
  const Agg = A.make(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      tenantId: Schema.String,
      lines: Schema.Array(Line),
      part: Part,
    }),
    {
      schema,
      table: Main,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "agg" },
      root: { entityType: "Root" },
      context: ["tenantId"],
      edges: {
        lines: A.many({ entityType: "Line", sk: { composite: ["k"] } }),
        part: A.make(Part, {
          root: { entityType: "Part" },
          edges: { bits: A.many({ entityType: "Bit", sk: { composite: ["k"] } }) },
        }).with({ discriminator: { side: c.side } }),
      },
    },
  )
  return { Main, Agg }
}

export const inputOf = (c: Case) => ({
  id: "a",
  title: "t",
  tenantId: "t1",
  lines: c.keys.map((k, i) => ({ k, qty: i + 1 })),
  part: { name: "p", bits: [{ k: c.keys[0], qty: 3 }] },
})

const outcomeOf = (lib: FlipLib, exit: any): Outcome => {
  if (lib.Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const error = lib.Cause.squash(exit.cause) as { _tag?: string; cause?: unknown; message?: string }
  const cause = error.cause instanceof Error ? error.cause.message : undefined
  return { failed: error._tag ?? "defect", ...(cause !== undefined && { cause }) }
}
const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`
export const sortRows = (rows: ReadonlyArray<Row>): Array<Row> =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

const bound = (lib: FlipLib, c: Case, escapeKeys: boolean, io: FlipIo) => {
  const { Effect, Layer } = lib
  const { Main, Agg } = defineFlip(lib, c, escapeKeys)
  const layer = Layer.merge(
    Layer.succeed(lib.DynamoClient, io.client),
    Main.layer({ name: io.tableName }),
  )
  return Effect.map(
    lib.DynamoClient.make({ entities: {}, aggregates: { Agg }, tables: { Main } }).pipe(
      Effect.provide(layer),
    ),
    (db: any) => db.aggregates.Agg,
  )
}

/** `create` under `from`, or `created` stored as given; then one step's `update` under `to`. */
export const runFlip = (
  lib: FlipLib,
  c: Case,
  step: (typeof stepNames)[number],
  io: FlipIo,
  created?: ReadonlyArray<Row>,
): Effect.Effect<
  { readonly create: Outcome; readonly created: ReadonlyArray<Row>; readonly step: Step },
  unknown
> => {
  const { Effect } = lib
  return Effect.gen(function* () {
    let create: Outcome = { ok: null }
    if (created !== undefined) {
      yield* io.seed!(created)
    } else {
      const writer: any = yield* bound(lib, c, c.from, io)
      create = outcomeOf(lib, yield* Effect.exit(writer.create(inputOf(c))))
    }
    const rows = sortRows(yield* io.scan())
    io.take()
    const agg: any = yield* bound(lib, c, c.to, io)
    const update = outcomeOf(
      lib,
      yield* Effect.exit(agg.update({ id: "a" }, ({ state }: any) => mutate(step, c, state))),
    )
    const requests = io.take()
    const after = sortRows(yield* io.scan())
    const get = outcomeOf(lib, yield* Effect.exit(agg.get({ id: "a" })))
    io.take()
    return { create, created: rows, step: { update, requests, rows: after, get } }
  }) as Effect.Effect<{ create: Outcome; created: ReadonlyArray<Row>; step: Step }, unknown>
}

// ---------------------------------------------------------------------------
// Every key kind (#241 round five): the cases above hold string and number keys of one model.
// These run each kind of value a sort key composes from (strings needing escapes, fractions and
// negatives, bigints, dates as ISO text and as epoch milliseconds before 1970, an `entity:` edge
// keyed by a field its model encodes) in a `many` edge, in a sub-aggregate's `many` edge and in the
// sub-aggregate's discriminator, both directions, and `delete` beside the update steps.
// `fixtures/aggregate-escape-flip-kinds-1.40.0.json` holds what published 1.40.0 did, from the rows
// its own `create` wrote under `from`.
// ---------------------------------------------------------------------------

/** The modules of one release the kinds run with: `FlipLib` and what the kinds' models need. */
export type KindLib = FlipLib & {
  readonly DynamoModel: any
  readonly DateTime: any
  readonly Entity: any
}

export type KeyKind = "string" | "number" | "bigint" | "date" | "dateEpoch" | "entity"

export type KindCase = {
  readonly name: string
  readonly kind: KeyKind
  readonly from: boolean
  readonly to: boolean
  /** The `lines` elements' sort key values, as given: a date as ISO text. */
  readonly keys: ReadonlyArray<string | number | bigint>
  /** The sub-aggregate's discriminator value. */
  readonly side: string | number | bigint
}

const both = (
  name: string,
  kind: KeyKind,
  keys: KindCase["keys"],
  side: KindCase["side"],
): ReadonlyArray<KindCase> => [
  { name: `${name}, turned on`, kind, from: false, to: true, keys, side },
  { name: `${name}, turned off`, kind, from: true, to: false, keys, side },
]

export const kindCases: ReadonlyArray<KindCase> = [
  ...both("% and ! in a many sort key", "string", ["k%1", "k!2"], "d1"),
  ...both("a space and a quote in a discriminator", "string", ["k1", "k2"], 'd "1"'),
  ...both("a tab in a many sort key", "string", ["k\t1", "k2"], "d1"),
  ...both("a fraction in a many sort key", "number", [1.5, 7], "d1"),
  ...both("a negative number in a many sort key", "number", [-5, 7], "d1"),
  ...both("a negative number in a discriminator", "number", [1, 2], -5),
  ...both("a fraction in a discriminator", "number", [1, 2], 1.5),
  ...both("a negative bigint in a many sort key", "bigint", [-3n, 4n], "d1"),
  ...both("non-negative bigints", "bigint", [3n, 4n], "d1"),
  ...both(
    "dates as ISO text",
    "date",
    ["2024-01-02T03:04:05.000Z", "2024-02-03T04:05:06.000Z"],
    "d1",
  ),
  ...both(
    "dates before 1970 as epoch milliseconds",
    "dateEpoch",
    ["1960-01-02T03:04:05.000Z", "2024-02-03T04:05:06.000Z"],
    "d1",
  ),
  ...both("an entity edge keyed by NumberFromString", "entity", [5, 7], "d1"),
]

export const kindStepNames = [...stepNames, "delete"] as const

const keyValueOf = (lib: KindLib, c: KindCase, key: KindCase["keys"][number]): unknown =>
  c.kind === "date" || c.kind === "dateEpoch" ? lib.DateTime.makeUnsafe(key as string) : key

const extraKey = (lib: KindLib, c: KindCase): unknown =>
  c.kind === "string"
    ? "z"
    : c.kind === "bigint"
      ? 100n
      : c.kind === "date" || c.kind === "dateEpoch"
        ? lib.DateTime.makeUnsafe("2030-01-01T00:00:00.000Z")
        : 100

const mutateKind = (lib: KindLib, name: (typeof stepNames)[number], c: KindCase, s: any): any => {
  const removed = keyValueOf(lib, c, c.keys[1]!)
  const same = (a: unknown, b: unknown) => JSON.stringify(a, bigints) === JSON.stringify(b, bigints)
  switch (name) {
    case "no change":
      return s
    case "root field":
      return { ...s, title: "t2" }
    case "element changed":
      return { ...s, lines: s.lines.map((l: any) => ({ ...l, qty: l.qty + 10 })) }
    case "element added":
      return { ...s, lines: [...s.lines, { k: extraKey(lib, c), qty: 9 }] }
    case "element removed":
      return { ...s, lines: s.lines.filter((l: any) => !same(l.k, removed)) }
    case "sub field":
      return { ...s, part: { ...s.part, name: "p2" } }
    case "sub element added":
      return { ...s, part: { ...s.part, bits: [...s.part.bits, { k: extraKey(lib, c), qty: 4 }] } }
  }
}

/** JSON with a `bigint` as `5n`. */
const bigints = (_key: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v)

export const defineKindFlip = (lib: KindLib, c: KindCase, escapeKeys: boolean) => {
  const { Aggregate: A, Schema } = lib
  const schema = lib.DynamoSchema.make({ name: "flipk", version: 1, escapeKeys })
  const K =
    c.kind === "string"
      ? Schema.String
      : c.kind === "number"
        ? Schema.Number
        : c.kind === "bigint"
          ? Schema.BigInt
          : c.kind === "date"
            ? Schema.DateTimeUtc
            : c.kind === "dateEpoch"
              ? lib.DynamoModel.DateEpochMs
              : Schema.NumberFromString
  const Line = Schema.Struct({ k: K, qty: Schema.Number })
  const Lines =
    c.kind === "entity"
      ? lib.Entity.make({
          model: Schema.Struct({ k: K.pipe(lib.DynamoModel.identifier), qty: Schema.Number }),
          entityType: "LineEntity",
          primaryKey: {
            pk: { field: "pk", composite: ["k"] },
            sk: { field: "sk", composite: [] },
          },
        })
      : undefined
  const Main = lib.Table.make({ schema, entities: Lines === undefined ? {} : { Lines } })
  const many = (entityType: string) =>
    A.many({
      entityType,
      ...(Lines !== undefined && { entity: Lines }),
      sk: { composite: ["k"] },
    })
  const Part = Schema.Struct({ name: Schema.String, bits: Schema.Array(Line) })
  const Agg = A.make(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      tenantId: Schema.String,
      lines: Schema.Array(Line),
      part: Part,
    }),
    {
      schema,
      table: Main,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "agg" },
      root: { entityType: "Root" },
      context: ["tenantId"],
      edges: {
        lines: many("Line"),
        part: A.make(Part, {
          root: { entityType: "Part" },
          edges: { bits: many("Bit") },
        }).with({ discriminator: { side: c.side } }),
      },
    },
  )
  return { Main, Agg, Lines }
}

export const kindInputOf = (lib: KindLib, c: KindCase) => ({
  id: "a",
  title: "t",
  tenantId: "t1",
  lines: c.keys.map((k, i) => ({ k: keyValueOf(lib, c, k), qty: i + 1 })),
  part: { name: "p", bits: [{ k: keyValueOf(lib, c, c.keys[0]!), qty: 3 }] },
})

const kindOutcomeOf = (lib: KindLib, exit: any): Outcome => {
  if (lib.Exit.isSuccess(exit)) {
    return { ok: exit.value === undefined ? null : JSON.parse(JSON.stringify(exit.value, bigints)) }
  }
  const error = lib.Cause.squash(exit.cause) as { _tag?: string; cause?: unknown; message?: string }
  const cause = error.cause instanceof Error ? error.cause.message : undefined
  return { failed: error._tag ?? "defect", ...(cause !== undefined && { cause }) }
}

const boundKind = (lib: KindLib, c: KindCase, escapeKeys: boolean, io: FlipIo) => {
  const { Effect, Layer } = lib
  const { Main, Agg, Lines } = defineKindFlip(lib, c, escapeKeys)
  const layer = Layer.merge(
    Layer.succeed(lib.DynamoClient, io.client),
    Main.layer({ name: io.tableName }),
  )
  return Effect.map(
    lib.DynamoClient.make({
      entities: Lines === undefined ? {} : { Lines },
      aggregates: { Agg },
      tables: { Main },
    }).pipe(Effect.provide(layer)),
    (db: any) => db.aggregates.Agg,
  )
}

/**
 * `create` under `from` with `writer`'s modules, or `created` stored as given; then one step under
 * `to` with `lib`'s: an `update`, or `delete`.
 */
export const runKindFlip = (
  lib: KindLib,
  c: KindCase,
  step: (typeof kindStepNames)[number],
  io: FlipIo,
  created?: ReadonlyArray<Row>,
  writer: KindLib = lib,
): Effect.Effect<
  { readonly create: Outcome; readonly created: ReadonlyArray<Row>; readonly step: Step },
  unknown
> => {
  const { Effect } = lib
  return Effect.gen(function* () {
    let create: Outcome = { ok: null }
    if (created !== undefined) {
      yield* io.seed!(created)
    } else {
      const agg: any = yield* boundKind(writer, c, c.from, io)
      create = kindOutcomeOf(writer, yield* Effect.exit(agg.create(kindInputOf(writer, c))))
    }
    const rows = sortRows(yield* io.scan())
    io.take()
    const agg: any = yield* boundKind(lib, c, c.to, io)
    const update = kindOutcomeOf(
      lib,
      yield* Effect.exit(
        step === "delete"
          ? agg.delete({ id: "a" })
          : agg.update({ id: "a" }, ({ state }: any) => mutateKind(lib, step, c, state)),
      ),
    )
    const requests = io.take()
    const after = sortRows(yield* io.scan())
    const get = kindOutcomeOf(lib, yield* Effect.exit(agg.get({ id: "a" })))
    io.take()
    return { create, created: rows, step: { update, requests, rows: after, get } }
  }) as Effect.Effect<{ create: Outcome; created: ReadonlyArray<Row>; step: Step }, unknown>
}
