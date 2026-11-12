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
