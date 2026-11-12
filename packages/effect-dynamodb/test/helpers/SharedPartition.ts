/**
 * Partitions holding rows of one entity type that more than one owner writes, checked step by step
 * against what published 1.39.0 stored, sent and returned (`fixtures/aggregate-shared-partition-1.39.0.json`,
 * generated once from the published package: don't regenerate or "fix" it). Shared by the unit
 * suite (an in-memory table) and the connected one (DynamoDB Local).
 *
 * No owner here declares `ownsRows` (DESIGN.md §7 "Which rows in its partition are an aggregate's"),
 * so each step is 1.39.0's. An aggregate that declares it is refused at bind (`EDD-9130`) beside
 * another owner of its entity type in its partition (`AggregateOwnsRows.test.ts`).
 *
 * - `many`: two aggregates sharing a partition and a `many` edge's entity type, each `assemble`
 *   filtering its own rows, with a custom `decompose` handing each element back.
 * - `one`: the same with `one` edges told apart by static discriminators, no custom `decompose`.
 * - `version` / `timeSeries`: an entity sharing the partition and the entity type with an
 *   aggregate, holding a retained snapshot or a time-series event of its own.
 * - `two edges`: one aggregate with two custom filtered `many` edges of one entity type.
 * - `graph`: nested sub-aggregates under static discriminators, a `one` and a `many` edge sharing an
 *   entity type, with and without a custom `decompose`.
 *
 * And against `fixtures/aggregate-ownership-1.39.0.json`, generated the same way, a custom `decompose`
 * whose keys, read as a write's value is, can name a row it doesn't hold:
 *
 * - `second reading`: A's field multiplies by 10 as it reads, so its 50, stored at key 500, decomposes
 *   as written to 5000, where B's row is.
 * - `entity second reading`: the same key holding an entity's row.
 * - `claimed destination`: A stored under escaped keys and B under the old ones, a `Line` each at one
 *   sort key, so B's row belongs where A's is. Both scan orders.
 * - `mixed edges`: a transformed custom `many` edge whose key as written is a `one` edge's.
 *
 * And against `fixtures/aggregate-decompose-rename-1.39.0.json`, generated the same way, a custom
 * `decompose` renaming a transformed field (`{ lid, f, note }` stored as `{ lid, g: f, note }`), keyed
 * by `lid`: `g` is no field of the element, so it's stored as given. `update` deletes the row, as
 * 1.39.0 did, and `rekey` moves it as stored, its partition key alone replaced: 1.39.0 wrote it from
 * the value read, decoded once more. Kinds `x10`, `nested`, `text`; an edge, one with an `entity`,
 * one of a sub-aggregate.
 *
 * And against `fixtures/aggregate-foreign-rows-1.39.0.json`, generated the same way, rows another
 * aggregate holds:
 *
 * - `content fallback same` / `different`: A's field multiplies by 10 as it reads, with a decompose
 *   handing each element back, so A's 50 is stored at key 500 and its key as written is 5000, where
 *   B's plain 5000 is. B's 5000 encodes to the 500 A would store there, and the row is still B's.
 * - `concurrent replace`: A's decompose divides by 10, so its row is at key 50, a key its value as
 *   read doesn't compose; B's update puts its own row at that key after A's update read it.
 * - `three owners`: three aggregates' rows in an escaping sort-key chain, each row's new key another
 *   row's current one, rekeyed in every scan order.
 *
 * And against `fixtures/aggregate-claimed-rows-1.39.0.json`, generated the same way, rows that hold
 * exactly what an element's key as written would hold, and rows changed after a write read them:
 *
 * - `equal content`: A and B are both x10 with a decompose handing each element back, so A's 50 is at
 *   key 500, and B's 500 at key 5000: A's key as written, holding byte for byte what A would write.
 * - `decimal 0.100` / `decimal 0.10000000000000001`: the same, B's decompose storing `payload` spelled
 *   so, where A's is 0.1 (DynamoDB Local stores `0.100` as `0.1`).
 * - `guard narrow` / `guard wide`: A's decompose divides by 10, so its row is at key 50, a key its
 *   value as read doesn't compose; B's update puts its own line there, adding `z_owner`, a field of
 *   both models. `wide`: 160 more string fields.
 *
 * Every step's rows, requests and results are compared with what 1.39.0 stored, sent and returned,
 * but for the rows `rekey` moves of the renaming `decompose`, which it moves as stored.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { NumberValueImpl } from "@aws-sdk/util-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"

export type Row = Record<string, AttributeValue>
interface Request {
  readonly command: string
  readonly input: Record<string, any>
}
type Result = { readonly ok: unknown } | { readonly failed: string }
interface Step {
  readonly rows: ReadonlyArray<Row>
  readonly requests?: ReadonlyArray<Request>
  readonly result?: Result
  readonly report?: Record<string, unknown>
  readonly commands?: ReadonlyArray<string>
  readonly gets?: Record<string, Result>
  readonly get?: Result
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-shared-partition-1.39.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly scenarios: Record<string, Record<string, any>> }
const at = (scenario: string, step: string): Step => fixture.scenarios[scenario]![step]!
const ownership = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-ownership-1.39.0.json", import.meta.url), "utf8"),
) as { readonly scenarios: Record<string, Record<string, any>> }
const atOwnership = (scenario: string, step: string): Step & Record<string, any> =>
  ownership.scenarios[scenario]![step]!
const renamed = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-decompose-rename-1.39.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly scenarios: Record<string, Record<string, any>> }
const atRenamed = (scenario: string, step: string): Step & Record<string, any> =>
  renamed.scenarios[scenario]![step]!
const foreign = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-foreign-rows-1.39.0.json", import.meta.url), "utf8"),
) as { readonly scenarios: Record<string, Record<string, any>> }
const atForeign = (scenario: string, step: string): Step & Record<string, any> =>
  foreign.scenarios[scenario]![step]!
const claimed = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-claimed-rows-1.39.0.json", import.meta.url), "utf8"),
) as { readonly scenarios: Record<string, Record<string, any>> }
const atClaimed = (scenario: string, step: string): Step & Record<string, any> =>
  claimed.scenarios[scenario]![step]!

/** A table for one world: a client over it, its rows, and a write as another writer's. */
export interface Opened {
  readonly name: string
  readonly layer: Layer.Layer<DynamoClient>
  readonly rows: Effect.Effect<ReadonlyArray<Row>>
  readonly put: (row: Row) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}
export interface Backend {
  /**
   * DynamoDB Local, as the fixture's was: it answers a scan and a query in the same order, so the
   * requests match one for one. The in-memory table orders them its own way, so there the order of
   * a batch's requests isn't compared, nor the requests `rekey` sends, which follow the scan's order
   * (on DynamoDB Local, those but its reads of a root, in any order: see {@link unordered}).
   */
  readonly local: boolean
  readonly open: (options: {
    readonly gsi: boolean
    readonly seed?: ReadonlyArray<Row> | undefined
  }) => Effect.Effect<Opened>
}

/** Rows in key order. */
export const byKey = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  [...rows].sort((a, b) => `${a.pk?.S}|${a.sk?.S}`.localeCompare(`${b.pk?.S}|${b.sk?.S}`))

/**
 * What `rekey` scanned and wrote, but not its reads: the rows it scans are handled concurrently, so
 * how many edge rows read their root before it's known, how often an aggregate reads its partitions
 * again because another aggregate's move in the same partition landed between its reads, and the
 * order the units' requests interleave in, depend on timing.
 */
const unordered = (commands: ReadonlyArray<string> | undefined) =>
  (commands ?? []).filter((command) => command !== "GetItem" && command !== "Query").sort()

/** A batch's requests in key order: the order a query returned the rows in. */
const batchInKeyOrder = (requests: ReadonlyArray<Request>): ReadonlyArray<Request> =>
  requests.map((request) =>
    request.command !== "BatchWriteItem"
      ? request
      : {
          ...request,
          input: {
            ...request.input,
            RequestItems: Object.fromEntries(
              Object.entries(request.input.RequestItems as Record<string, Array<any>>).map(
                ([table, writes]) => [
                  table,
                  [...writes].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
                ],
              ),
            ),
          },
        },
  )

/** Requests with the table's name taken out: the fixture's tables were named for their run. */
const named = (value: unknown, tables = false): unknown =>
  Array.isArray(value)
    ? value.map((inner) => named(inner))
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, inner]) => [
            tables ? "t" : key,
            key === "TableName" ? "t" : named(inner, key === "RequestItems"),
          ]),
        )
      : value

const resultOf = (exit: Exit.Exit<unknown, unknown>): Result =>
  Exit.isSuccess(exit)
    ? {
        ok:
          exit.value === undefined
            ? null
            : JSON.parse(
                JSON.stringify(exit.value, (_key, value) =>
                  typeof value === "bigint" ? `${value}n` : value,
                ),
              ),
      }
    : { failed: String(exit.cause) }

/** The parts of a rekey report 1.39.0 kept. */
const reportOf = (exit: Exit.Exit<any, unknown>) => {
  if (Exit.isFailure(exit)) return { failed: String(exit.cause) }
  const { scanned, unchanged, moved, indexKeysRewritten, conflicts } = exit.value
  return { scanned, unchanged, moved: moved.aggregate, indexKeysRewritten, conflicts }
}

interface Defined {
  readonly table: ReturnType<typeof Table.make>
  readonly entities?: Record<string, unknown>
  readonly aggregates: Record<string, any>
}

const world = (
  backend: Backend,
  define: (schema: DynamoSchema.DynamoSchema) => Defined,
  options: {
    readonly name: string
    readonly escapeKeys?: boolean
    readonly gsi?: boolean
    readonly seed?: ReadonlyArray<Row>
    /** The order a scan returns its rows in, lowest first: each order a scan might take. */
    readonly scanOrder?: (row: Row) => number
  },
) =>
  Effect.gen(function* () {
    const schema = DynamoSchema.make({
      name: options.name,
      version: 1,
      escapeKeys: options.escapeKeys ?? false,
    })
    const defined = define(schema)
    const opened = yield* backend.open({ gsi: options.gsi ?? false, seed: options.seed })
    const log: Array<Request> = []
    /** Run before a request is sent: another writer, or a failure. */
    const hooks: {
      before?: ((command: string) => Effect.Effect<void, DynamoError> | undefined) | undefined
    } = {}
    const recording = Layer.effect(
      DynamoClient,
      Effect.map(
        Effect.gen(function* () {
          return yield* DynamoClient
        }),
        (inner) =>
          new Proxy(inner, {
            get: (target, name) => {
              const value = (target as any)[name]
              if (typeof value !== "function" || typeof name !== "string") return value
              return (input: Record<string, any>, ...rest: Array<unknown>) =>
                Effect.suspend(() => {
                  const command = `${name[0]!.toUpperCase()}${name.slice(1)}`
                  log.push({ command, input: structuredClone(input) })
                  const before = hooks.before?.(command)
                  const order = options.scanOrder
                  const send = () =>
                    command !== "Scan" || order === undefined
                      ? value.call(target, input, ...rest)
                      : Effect.map(
                          value.call(target, input, ...rest) as Effect.Effect<{
                            readonly Items?: ReadonlyArray<Row>
                          }>,
                          (result) => ({
                            ...result,
                            Items: result.Items?.slice().sort((p, q) => order(p) - order(q)),
                          }),
                        )
                  return before === undefined ? send() : Effect.flatMap(before, send)
                })
            },
          }),
      ),
    ).pipe(Layer.provide(opened.layer))
    const layer = Layer.merge(recording, defined.table.layer({ name: opened.name }))
    const run = <A>(body: (db: any) => Effect.Effect<A, unknown, never>) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: defined.entities ?? {},
          aggregates: defined.aggregates,
          tables: { Main: defined.table },
        } as never)
        return yield* body(db)
      }).pipe(Effect.provide(layer as never), Effect.exit) as Effect.Effect<Exit.Exit<A, unknown>>
    const step = <A>(body: (db: any) => Effect.Effect<A, unknown, never>) =>
      Effect.gen(function* () {
        log.length = 0
        const exit = yield* run(body)
        return {
          exit,
          result: resultOf(exit),
          requests: named(log) as ReadonlyArray<Request>,
          commands: log.map((request) => request.command),
          rows: byKey(yield* opened.rows),
        }
      })
    return { opened, hooks, run, step }
  })

/** The rows not `mine`: an owner's write must leave them byte for byte. */
const others = (rows: ReadonlyArray<Row>, mine: (row: Row) => boolean) =>
  byKey(rows.filter((row) => !mine(row)))

// --- The fixture's definitions: they must stay what the generator declared -----------------------

const Line = Schema.Struct({ lid: Schema.String, owner: Schema.String, note: Schema.String })
type Line = typeof Line.Type
const sharedDefine =
  (shape: "many" | "one", owners: ReadonlyArray<string>) =>
  (schema: DynamoSchema.DynamoSchema): Defined => {
    const table = Table.make({ schema, entities: {} })
    const Model = Schema.Struct({
      id: Schema.String,
      note: Schema.String,
      lines: shape === "many" ? Schema.Array(Line) : Line,
    })
    const make = (owner: string) =>
      Aggregate.make(
        Model as any,
        {
          schema,
          table,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "shared" },
          root: { entityType: `Root${owner}` },
          edges: {
            lines:
              shape === "many"
                ? Aggregate.many({
                    entityType: "Line",
                    sk: { composite: ["owner", "lid"] },
                    assemble: (lines) =>
                      (lines as ReadonlyArray<Line>).filter((l) => l.owner === owner),
                    decompose: (lines) => lines as ReadonlyArray<unknown>,
                  })
                : Aggregate.one({ entityType: "Line", discriminator: { owner } }),
          },
        } as any,
      )
    return {
      table,
      aggregates: Object.fromEntries(owners.map((owner) => [owner.toUpperCase(), make(owner)])),
    }
  }
const sharedInput = (shape: "many" | "one", owner: string) => ({
  id: "p q",
  note: "root",
  lines:
    shape === "many" ? [{ lid: "x y", owner, note: owner }] : { lid: "x y", owner, note: owner },
})
/** A row of aggregate `owner`: its root, or a line it owns. */
const ownedBy = (owner: string) => (row: Row) =>
  row.__edd_e__?.S === `Root${owner}` || (row.__edd_e__?.S === "Line" && row.owner?.S === owner)

const HistoryLine = Schema.Struct({
  id: Schema.String,
  lid: Schema.String,
  owner: Schema.String,
  note: Schema.String,
  at: Schema.Number,
})
type HistoryLine = typeof HistoryLine.Type
const historyDefine =
  (kind: "version" | "timeSeries") =>
  (schema: DynamoSchema.DynamoSchema): Defined => {
    const Lines = Entity.make({
      model: HistoryLine,
      entityType: "Line",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: kind === "version" ? ["lid"] : [] },
      },
      ...(kind === "version"
        ? { versioned: { retain: true } }
        : { timeSeries: { orderBy: "at", appendInput: HistoryLine } }),
    } as any)
    const table = Table.make({ schema, entities: { Lines } })
    const Agg = Aggregate.make(
      Schema.Struct({ id: Schema.String, note: Schema.String, lines: Schema.Array(HistoryLine) }),
      {
        schema,
        table,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "line" },
        root: { entityType: "Root" },
        edges: {
          lines: Aggregate.many({
            entityType: "Line",
            sk: { composite: ["lid"] },
            assemble: (lines) =>
              (lines as ReadonlyArray<HistoryLine>).filter((line) => line.owner === "aggregate"),
            decompose: (lines) => lines as ReadonlyArray<unknown>,
          }),
        },
      } as any,
    )
    return { table, entities: { Lines }, aggregates: { Agg } }
  }

const TwoLine = Schema.Struct({ lid: Schema.String, owner: Schema.String, note: Schema.String })
const twoDefine = (schema: DynamoSchema.DynamoSchema): Defined => {
  const table = Table.make({ schema, entities: {} })
  const edge = (owner: string) =>
    Aggregate.many({
      entityType: "Line",
      sk: { composite: ["owner", "lid"] },
      assemble: (lines) => (lines as ReadonlyArray<Line>).filter((line) => line.owner === owner),
      decompose: (lines) => lines as ReadonlyArray<unknown>,
    })
  const Agg = Aggregate.make(
    Schema.Struct({ id: Schema.String, a: Schema.Array(TwoLine), b: Schema.Array(TwoLine) }),
    {
      schema,
      table,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "two" },
      root: { entityType: "Root" },
      edges: { a: edge("a"), b: edge("b") },
    } as any,
  )
  return { table, aggregates: { Agg } }
}

const graphDefine =
  (custom: boolean) =>
  (schema: DynamoSchema.DynamoSchema): Defined => {
    const table = Table.make({ schema, entities: {} })
    const GLine = Schema.Struct({ lid: Schema.String, kind: Schema.String, note: Schema.String })
    const One = Schema.Struct({ kind: Schema.String, note: Schema.String })
    const LeafModel = Schema.Struct({ note: Schema.String, lines: Schema.Array(GLine) })
    const BranchModel = Schema.Struct({ note: Schema.String, left: LeafModel, right: LeafModel })
    const many = (filter: boolean) =>
      Aggregate.many({
        entityType: "Line",
        sk: { composite: ["lid"] },
        ...(filter && {
          assemble: (lines: ReadonlyArray<unknown>) =>
            (lines as ReadonlyArray<{ kind: string }>).filter((line) => line.kind === "root"),
        }),
        ...(custom && { decompose: (lines: unknown) => lines as ReadonlyArray<unknown> }),
      } as any)
    const Leaf = Aggregate.make(LeafModel, {
      root: { entityType: "Leaf" },
      edges: { lines: many(false) },
    } as any)
    const Branch = Aggregate.make(BranchModel, {
      root: { entityType: "Branch" },
      edges: {
        left: (Leaf as any).with({ discriminator: { section: "left" } }),
        right: (Leaf as any).with({ discriminator: { section: "right" } }),
      },
    } as any)
    const Agg = Aggregate.make(
      Schema.Struct({
        id: Schema.String,
        note: Schema.String,
        lines: Schema.Array(GLine),
        single: One,
        a: BranchModel,
        b: BranchModel,
      }),
      {
        schema,
        table,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "root" },
        list: {
          index: "gsi1",
          name: "roots",
          pk: { field: "gsi1pk", composite: [] },
          sk: { field: "gsi1sk", composite: ["id"] },
        },
        root: { entityType: "Root" },
        edges: {
          lines: many(true),
          single: Aggregate.one({ entityType: "Line", discriminator: { kind: "one" } }),
          a: (Branch as any).with({ discriminator: { team: "a" } }),
          b: (Branch as any).with({ discriminator: { team: "b" } }),
        },
      } as any,
    )
    return { table, aggregates: { Agg } }
  }
const branch = () => ({
  note: "branch",
  left: { note: "left", lines: [{ lid: "x y", kind: "nested", note: "l" }] },
  right: { note: "right", lines: [{ lid: "x%20y", kind: "nested", note: "r" }] },
})
const graphInput = {
  id: "a b",
  note: "root",
  lines: [{ lid: "r s", kind: "root", note: "r" }],
  single: { kind: "one", note: "one" },
  a: branch(),
  b: branch(),
}

/** Two aggregates whose `many` edges both take every row of the type: they share a row. */
const overlapDefine = (schema: DynamoSchema.DynamoSchema): Defined => {
  const table = Table.make({ schema, entities: {} })
  const Model = Schema.Struct({ id: Schema.String, note: Schema.String, lines: Schema.Array(Line) })
  const make = (owner: string) =>
    Aggregate.make(Model, {
      schema,
      table,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "shared" },
      root: { entityType: `Root${owner}` },
      edges: {
        lines: Aggregate.many({
          entityType: "Line",
          sk: { composite: ["owner", "lid"] },
          decompose: (lines) => lines as ReadonlyArray<unknown>,
        }),
      },
    } as any)
  return { table, aggregates: { A: make("a"), B: make("b") } }
}

// --- A key read as written that names a row the reading doesn't hold ------------------------------

/** A field multiplying by 10 as it reads. */
const X10 = Schema.Number.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((n: number) => n * 10),
    encode: SchemaGetter.transform((n: number) => n / 10),
  }),
)
const ownerLine = (field: Schema.Top) =>
  Schema.Struct({ f: field as typeof Schema.Number, owner: Schema.String, note: Schema.String })
const secondDefine =
  (owners: ReadonlyArray<"a" | "b">) =>
  (schema: DynamoSchema.DynamoSchema): Defined => {
    const table = Table.make({ schema, entities: {} })
    const make = (owner: string, field: Schema.Top) =>
      Aggregate.make(
        Schema.Struct({
          id: Schema.String,
          note: Schema.String,
          lines: Schema.Array(ownerLine(field)),
        }),
        {
          schema,
          table,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "shared" },
          root: { entityType: `Root${owner}` },
          edges: {
            lines: Aggregate.many({
              entityType: "Line",
              sk: { composite: ["f"] },
              assemble: (lines) =>
                (lines as ReadonlyArray<{ owner: string }>).filter((l) => l.owner === owner),
              decompose: (lines) => lines as ReadonlyArray<unknown>,
            }),
          },
        } as any,
      )
    const all = { a: () => make("a", X10), b: () => make("b", Schema.Number) }
    return {
      table,
      aggregates: Object.fromEntries(owners.map((owner) => [owner.toUpperCase(), all[owner]()])),
    }
  }

const entityDefine = (schema: DynamoSchema.DynamoSchema): Defined => {
  const Lines = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      f: Schema.Number,
      owner: Schema.String,
      note: Schema.String,
    }),
    entityType: "Line",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: ["f"] },
    },
  })
  const table = Table.make({ schema, entities: { Lines } })
  const Agg = Aggregate.make(
    Schema.Struct({
      id: Schema.String,
      lines: Schema.Array(Schema.Struct({ f: X10, owner: Schema.String, note: Schema.String })),
    }),
    {
      schema,
      table,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "line" },
      root: { entityType: "Root" },
      edges: {
        lines: Aggregate.many({
          entityType: "Line",
          sk: { composite: ["k"] },
          assemble: (lines) =>
            (lines as ReadonlyArray<{ owner: string }>).filter((l) => l.owner === "aggregate"),
          decompose: (lines) =>
            (lines as ReadonlyArray<{ f: number }>).map((line) => ({
              ...line,
              k: `f_${String(line.f).padStart(16, "0")}`,
            })),
        }),
      },
    } as any,
  )
  return { table, entities: { Lines }, aggregates: { Agg } }
}

const ClaimedLine = Schema.Struct({ lid: Schema.String, owner: Schema.String, note: Schema.String })
const claimedDefine =
  (owners: ReadonlyArray<string>) =>
  (schema: DynamoSchema.DynamoSchema): Defined => {
    const table = Table.make({ schema, entities: {} })
    const make = (owner: string) =>
      Aggregate.make(
        Schema.Struct({ id: Schema.String, note: Schema.String, lines: Schema.Array(ClaimedLine) }),
        {
          schema,
          table,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "shared" },
          root: { entityType: `Root${owner}` },
          edges: {
            lines: Aggregate.many({
              entityType: "Line",
              sk: { composite: ["lid"] },
              assemble: (lines) =>
                (lines as ReadonlyArray<{ owner: string }>).filter((l) => l.owner === owner),
              decompose: (lines) => lines as ReadonlyArray<unknown>,
            }),
          },
        } as any,
      )
    return {
      table,
      aggregates: Object.fromEntries(owners.map((owner) => [owner.toUpperCase(), make(owner)])),
    }
  }

// --- Rows another aggregate holds: `aggregate-foreign-rows-1.39.0.json` ---------------------------

/** A's ×10 field and B's plain one, each decompose handing its elements back. */
const fallbackDefine =
  (owners: ReadonlyArray<"a" | "b">) =>
  (schema: DynamoSchema.DynamoSchema): Defined => {
    const table = Table.make({ schema, entities: {} })
    const make = (owner: string, field: Schema.Top) =>
      Aggregate.make(
        Schema.Struct({
          id: Schema.String,
          lines: Schema.Array(
            Schema.Struct({ f: field as typeof Schema.Number, note: Schema.String }),
          ),
        }),
        {
          schema,
          table,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "shared" },
          root: { entityType: `Root${owner}` },
          edges: {
            lines: Aggregate.many({
              entityType: "Line",
              sk: { composite: ["f"] },
              assemble: (lines) =>
                (lines as ReadonlyArray<{ f: number }>).filter((line) =>
                  owner === "a" ? line.f < 100 : line.f >= 100,
                ),
              decompose: (lines) => lines as ReadonlyArray<unknown>,
            }),
          },
        } as any,
      )
    const all = { a: () => make("a", X10), b: () => make("b", Schema.Number) }
    return {
      table,
      aggregates: Object.fromEntries(owners.map((owner) => [owner.toUpperCase(), all[owner]()])),
    }
  }

/** A's ×10 field with a decompose dividing by 10, and B's plain one handed back. */
const concurrentDefine = (schema: DynamoSchema.DynamoSchema): Defined => {
  const table = Table.make({ schema, entities: {} })
  const make = (owner: "a" | "b") =>
    Aggregate.make(
      Schema.Struct({
        id: Schema.String,
        lines: Schema.Array(
          Schema.Struct({
            f: (owner === "a" ? X10 : Schema.Number) as typeof Schema.Number,
            note: Schema.String,
          }),
        ),
      }),
      {
        schema,
        table,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "shared" },
        root: { entityType: `Root${owner}` },
        edges: {
          lines: Aggregate.many({
            entityType: "Line",
            sk: { composite: ["f"] },
            assemble: (lines) =>
              (lines as ReadonlyArray<{ note: string }>).filter((line) => line.note === owner),
            decompose: (lines) =>
              (lines as ReadonlyArray<{ f: number }>).map((line) => ({
                ...line,
                f: owner === "a" ? line.f / 10 : line.f,
              })),
          }),
        },
      } as any,
    )
  return { table, aggregates: { A: make("a"), B: make("b") } }
}

/** Three aggregates keyed by `lid`, each `assemble` taking its own rows. */
const chainDefine = (schema: DynamoSchema.DynamoSchema): Defined => {
  const table = Table.make({ schema, entities: {} })
  const make = (owner: string) =>
    Aggregate.make(Schema.Struct({ id: Schema.String, lines: Schema.Array(ClaimedLine) }), {
      schema,
      table,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "shared" },
      root: { entityType: `Root${owner}` },
      edges: {
        lines: Aggregate.many({
          entityType: "Line",
          sk: { composite: ["lid"] },
          assemble: (lines) =>
            (lines as ReadonlyArray<{ owner: string }>).filter((l) => l.owner === owner),
          decompose: (lines) => lines as ReadonlyArray<unknown>,
        }),
      },
    } as any)
  return { table, aggregates: { A: make("a"), B: make("b"), C: make("c") } }
}

/** A's and B's x10 lines, handed back, each `assemble` taking its own range; B's `payload` spelled so. */
const equalDefine =
  (owners: ReadonlyArray<"a" | "b">, spelling?: string) =>
  (schema: DynamoSchema.DynamoSchema): Defined => {
    const table = Table.make({ schema, entities: {} })
    const line = Schema.Struct({
      f: X10,
      note: Schema.String,
      ...(spelling === undefined ? {} : { payload: Schema.Number }),
    })
    const make = (owner: "a" | "b") =>
      Aggregate.make(Schema.Struct({ id: Schema.String, lines: Schema.Array(line) }), {
        schema,
        table,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "shared" },
        root: { entityType: `Root${owner}` },
        edges: {
          lines: Aggregate.many({
            entityType: "Line",
            sk: { composite: ["f"] },
            assemble: (lines) =>
              (lines as ReadonlyArray<{ f: number }>).filter((l) =>
                owner === "a" ? l.f < 100 : l.f >= 100,
              ),
            decompose: (lines) =>
              owner === "b" && spelling !== undefined
                ? (lines as ReadonlyArray<object>).map((l) => ({
                    ...l,
                    payload: NumberValueImpl.from(spelling),
                  }))
                : (lines as ReadonlyArray<unknown>),
          }),
        },
      } as any)
    return {
      table,
      aggregates: Object.fromEntries(owners.map((owner) => [owner.toUpperCase(), make(owner)])),
    }
  }

/** `wide` string fields beside a line's own. */
const fillers = (wide: number) =>
  Object.fromEntries(
    Array.from({ length: wide }, (_, i) => [`a${String(i).padStart(3, "0")}`, Schema.String]),
  )
/** A's and B's x10 lines, divided by 10, `z_owner` telling B's apart. */
const guardDefine =
  (owners: ReadonlyArray<"a" | "b">, wide: number) =>
  (schema: DynamoSchema.DynamoSchema): Defined => {
    const table = Table.make({ schema, entities: {} })
    const line = Schema.Struct({
      f: X10,
      note: Schema.String,
      z_owner: Schema.optional(Schema.String),
      ...fillers(wide),
    })
    const make = (owner: "a" | "b") =>
      Aggregate.make(Schema.Struct({ id: Schema.String, lines: Schema.Array(line) }), {
        schema,
        table,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "shared" },
        root: { entityType: `Root${owner}` },
        edges: {
          lines: Aggregate.many({
            entityType: "Line",
            sk: { composite: ["f"] },
            assemble: (lines) =>
              (lines as ReadonlyArray<{ z_owner?: string }>).filter((l) =>
                owner === "a" ? l.z_owner !== "b" : l.z_owner === "b",
              ),
            decompose: (lines) =>
              (lines as ReadonlyArray<{ f: number }>).map((l) => ({ ...l, f: l.f / 10 })),
          }),
        },
      } as any)
    return {
      table,
      aggregates: Object.fromEntries(owners.map((owner) => [owner.toUpperCase(), make(owner)])),
    }
  }

const mixedDefine = (schema: DynamoSchema.DynamoSchema): Defined => {
  const table = Table.make({ schema, entities: {} })
  const Agg = Aggregate.make(
    Schema.Struct({
      id: Schema.String,
      lines: Schema.Array(Schema.Struct({ f: X10, note: Schema.String })),
      single: Schema.Struct({ note: Schema.String }),
    }),
    {
      schema,
      table,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "shared" },
      root: { entityType: "Root" },
      edges: {
        lines: Aggregate.many({
          entityType: "Line",
          sk: { composite: ["k"] },
          assemble: (lines) =>
            (lines as ReadonlyArray<{ note: string }>).filter((l) => l.note === "many"),
          decompose: (lines) =>
            (lines as ReadonlyArray<{ f: number }>).map((line) => ({
              ...line,
              k: `slot#${line.f}`,
            })),
        }),
        single: Aggregate.one({ entityType: "Line", discriminator: { slot: "5000" } }),
      },
    } as any,
  )
  return { table, aggregates: { Agg } }
}

/** A string prefixed with "x" as it reads. */
const XText = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((text: string) => `x${text}`),
    encode: SchemaGetter.transform((text: string) => text.slice(1)),
  }),
)
const renameKinds = {
  x10: [X10, 50],
  nested: [Schema.Struct({ n: X10 }), { n: 50 }],
  text: [XText, "xabc"],
} as const
type RenameShape = "plain" | "entity" | "sub"
const renameDefine =
  (kind: keyof typeof renameKinds, shape: RenameShape) =>
  (schema: DynamoSchema.DynamoSchema): Defined => {
    const line = Schema.Struct({
      lid: Schema.String,
      f: renameKinds[kind][0] as typeof Schema.Number,
      note: Schema.String,
    })
    const entity = Entity.make({
      model: line,
      entityType: "Line",
      primaryKey: {
        pk: { field: "pk", composite: ["lid"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const table = Table.make({ schema, entities: shape === "entity" ? { entity } : {} })
    const edge = Aggregate.many({
      entityType: "Line",
      ...(shape === "entity" ? { entity } : {}),
      sk: { composite: ["lid"] },
      decompose: (lines: unknown) =>
        (lines as ReadonlyArray<{ lid: string; f: unknown; note: string }>).map((l) => ({
          lid: l.lid,
          g: l.f,
          note: l.note,
        })),
      assemble: (items: unknown) =>
        (items as ReadonlyArray<{ lid: string; g: unknown; note: string }>).map((l) => ({
          lid: l.lid,
          f: l.g,
          note: l.note,
        })),
    } as any)
    const nested = Schema.Struct({ lines: Schema.Array(line) })
    const model = Schema.Struct({
      id: Schema.String,
      note: Schema.String,
      ...(shape === "sub" ? { sub: nested } : { lines: Schema.Array(line) }),
    })
    const sub = Aggregate.make(nested, {
      root: { entityType: "Sub" },
      edges: { lines: edge },
    } as any)
    const Orders = Aggregate.make(model, {
      schema,
      table,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "root" },
      root: { entityType: "Root" },
      edges: shape === "sub" ? { sub: (sub as any).with({}) } : { lines: edge },
    } as any)
    return { table, entities: shape === "entity" ? { entity } : {}, aggregates: { Orders } }
  }

/** The keys a transaction writes, as `pk|sk`. */
const transactionKeys = (request: Request): ReadonlyArray<string> =>
  (request.input.TransactItems as ReadonlyArray<any>).map((op) => {
    const write = op.Put ?? op.Delete ?? op.Update ?? op.ConditionCheck
    const row = write.Item ?? write.Key
    return `${row.pk.S}|${row.sk.S}`
  })

// --- The suite --------------------------------------------------------------------------------------

export const sharedPartitionSuite = (backend: Backend) => {
  for (const shape of ["many", "one"] as const) {
    const scenario = shape
    const created = at(scenario, "created").rows
    const define = sharedDefine(shape, ["a", "b"])
    describe(`two aggregates sharing a partition and a \`${shape}\` edge's entity type`, () => {
      it.effect("each creates its own rows, as 1.39.0 did", () =>
        Effect.gen(function* () {
          const w = yield* world(backend, define, { name: "ownership" })
          yield* w.run((db) => db.aggregates.A.create(sharedInput(shape, "a")))
          const a = byKey(yield* w.opened.rows)
          yield* w.run((db) => db.aggregates.B.create(sharedInput(shape, "b")))
          const both = byKey(yield* w.opened.rows)
          expect(both).toEqual(byKey(created))
          // B's create left A's rows as they were.
          expect(others(both, ownedBy("b"))).toEqual(a)
          yield* w.opened.close
        }),
      )

      it.effect("an update of one leaves the other's rows, as 1.39.0 did", () =>
        Effect.gen(function* () {
          const w = yield* world(backend, define, { name: "ownership", seed: created })
          const done = yield* w.step((db) =>
            db.aggregates.A.update({ id: "p q" }, ({ state }: any) => ({
              ...state,
              note: "changed",
            })),
          )
          const expected = at(scenario, "update")
          expect(done.result).toEqual(expected.result)
          expect(done.requests).toEqual(named(expected.requests))
          expect(done.rows).toEqual(byKey(expected.rows))
          expect(others(done.rows, ownedBy("a"))).toEqual(others(created, ownedBy("a")))
          expect(resultOf(yield* w.run((db) => db.aggregates.A.get({ id: "p q" })))).toEqual(
            at(scenario, "update a get"),
          )
          expect(resultOf(yield* w.run((db) => db.aggregates.B.get({ id: "p q" })))).toEqual(
            at(scenario, "update b get"),
          )
          yield* w.opened.close
        }),
      )

      it.effect("an update that changes nothing sends only the read", () =>
        Effect.gen(function* () {
          const w = yield* world(backend, define, { name: "ownership", seed: created })
          const done = yield* w.step((db) =>
            db.aggregates.A.update({ id: "p q" }, ({ state }: any) => state),
          )
          expect(done.requests).toEqual(named(at(scenario, "noop update").requests))
          expect(done.commands).toEqual(["Query"])
          expect(done.rows).toEqual(byKey(created))
          yield* w.opened.close
        }),
      )

      it.effect("the other's row, written after the update read it, is left as written", () =>
        Effect.gen(function* () {
          const w = yield* world(backend, define, { name: "ownership", seed: created })
          const foreign = created.find(
            (row) => row.__edd_e__?.S === "Line" && row.owner?.S === "b",
          )!
          w.hooks.before = (command) => {
            if (command !== "TransactWriteItems") return undefined
            w.hooks.before = undefined
            return w.opened.put({ ...foreign, note: { S: "concurrent B edit" } })
          }
          const done = yield* w.step((db) =>
            db.aggregates.A.update({ id: "p q" }, ({ state }: any) => ({
              ...state,
              note: "A edit",
            })),
          )
          const expected = at(scenario, "race update")
          expect(done.result).toEqual(expected.result)
          expect(done.rows).toEqual(byKey(expected.rows))
          expect(done.rows).toContainEqual({ ...foreign, note: { S: "concurrent B edit" } })
          yield* w.opened.close
        }),
      )

      for (const [label, owners] of [
        ["both", ["a", "b"]],
        ["a only", ["a"]],
      ] as const) {
        for (const dryRun of [true, false]) {
          const name = `rekey ${label}${dryRun ? " dry run" : ""}`
          it.effect(`${name}: each moves its own rows, and leaves the other's, as 1.39.0 did`, () =>
            Effect.gen(function* () {
              const w = yield* world(backend, sharedDefine(shape, owners), {
                name: "ownership",
                escapeKeys: true,
                seed: created,
              })
              const done = yield* w.step((db) =>
                db.tables.Main.rekey({ repairIndexKeys: true, dryRun }),
              )
              const expected = at(scenario, name)
              expect(reportOf(done.exit)).toEqual(expected.report)
              if (backend.local)
                expect(unordered(done.commands)).toEqual(unordered(expected.commands))
              expect(done.rows).toEqual(byKey(expected.rows))
              if (owners.length === 1) {
                // B isn't registered: its rows stay where they are.
                expect(others(done.rows, ownedBy("a"))).toEqual(others(created, ownedBy("a")))
              }
              for (const [owner, read] of Object.entries(expected.gets ?? {})) {
                expect(
                  resultOf(
                    yield* w.run((db) => db.aggregates[owner.toUpperCase()].get({ id: "p q" })),
                  ),
                ).toEqual(read)
              }
              yield* w.opened.close
            }),
          )
        }
      }
    })
  }

  describe("two aggregates that both hold one row", () => {
    // `Line` is shared: whichever aggregate is judged first moves it, and the other finds it at its
    // current key, put there by the run, so counts it neither moved nor unchanged. A dry run says
    // the same (#240). On 1.39.0 a dry run counted it under each aggregate (4 moved) and a run
    // moved it once, the second counting it unchanged.
    it.effect("rekey moves it once, and a dry run says so", () =>
      Effect.gen(function* () {
        const w = yield* world(backend, overlapDefine, { name: "ownership" })
        yield* w.run((db) =>
          db.aggregates.A.create({
            id: "p q",
            note: "root",
            lines: [{ lid: "x y", owner: "a", note: "a" }],
          }),
        )
        yield* w.run((db) => db.aggregates.B.create({ id: "p q", note: "root", lines: [] }))
        const created = byKey(yield* w.opened.rows)
        expect(created).toHaveLength(3)
        const b = resultOf(yield* w.run((db) => db.aggregates.B.get({ id: "p q" })))
        expect(b).toEqual({
          ok: { id: "p q", note: "root", lines: [{ lid: "x y", owner: "a", note: "a" }] },
        })
        yield* w.opened.close
        const moved = (report: any) =>
          Object.values(report.byMember as Record<string, any>).reduce(
            (sum: number, member) => sum + (member.moved?.aggregate ?? 0),
            0,
          )
        for (const dryRun of [true, false]) {
          const r = yield* world(backend, overlapDefine, {
            name: "ownership",
            escapeKeys: true,
            seed: created,
          })
          const done = yield* r.step((db) => db.tables.Main.rekey({ dryRun }))
          if (Exit.isFailure(done.exit)) throw new Error(String(done.exit.cause))
          const report: any = done.exit.value
          expect(report.conflicts).toEqual([])
          expect(moved(report)).toBe(3)
          expect(report.unchanged).toBe(0)
          expect(report.scanned).toBe(3)
          expect(done.rows).toEqual(
            dryRun
              ? created
              : byKey(
                  created
                    .map((row): Row => ({ ...row, pk: { S: "$ownership#v1#shared#p%20q" } }))
                    .map((row) =>
                      row.__edd_e__?.S === "Line"
                        ? { ...row, sk: { S: "$ownership#v1#line#a#x%20y" } }
                        : row,
                    ),
                ),
          )
          if (!dryRun) {
            expect(resultOf(yield* r.run((db) => db.aggregates.B.get({ id: "p q" })))).toEqual(b)
          }
          yield* r.opened.close
        }
      }),
    )
  })

  for (const kind of ["version", "timeSeries"] as const) {
    describe(`an entity sharing the partition and entity type, with ${kind === "version" ? "a retained snapshot" : "a time-series event"}`, () => {
      it.effect("aggregate updates leave the entity's rows, as 1.39.0 did", () =>
        Effect.gen(function* () {
          const seeded = at(kind, "seeded").rows
          const w = yield* world(backend, historyDefine(kind), { name: "history", seed: seeded })
          const entityRows = (rows: ReadonlyArray<Row>) =>
            byKey(rows.filter((row) => row.__edd_e__?.S === "Line" && row.owner?.S === "entity"))
          for (const [name, mutate] of [
            ["update", (state: any) => ({ ...state, note: "edited" })],
            [
              "update add",
              (state: any) => ({
                ...state,
                lines: [
                  { id: "id_a", lid: "own", owner: "aggregate", note: "aggregate-owned", at: 0 },
                ],
              }),
            ],
            ["update remove", (state: any) => ({ ...state, lines: [] })],
          ] as const) {
            const done = yield* w.step((db) =>
              db.aggregates.Agg.update({ id: "id_a" }, ({ state }: any) => mutate(state)),
            )
            const expected = at(kind, name)
            expect(done.result).toEqual(expected.result)
            expect(done.requests).toEqual(named(expected.requests))
            expect(done.rows).toEqual(byKey(expected.rows))
            expect(entityRows(done.rows)).toEqual(entityRows(seeded))
          }
          const key = kind === "version" ? { id: "a", lid: "item" } : { id: "a" }
          expect(resultOf(yield* w.run((db) => db.entities.Lines.get(key)))).toEqual(
            at(kind, "entity get"),
          )
          yield* w.opened.close
        }),
      )
    })
  }

  describe("one aggregate with two custom filtered edges of one entity type", () => {
    const created = at("two edges", "created").rows
    it.effect("an update of one edge leaves the other's row, as 1.39.0 did", () =>
      Effect.gen(function* () {
        const w = yield* world(backend, twoDefine, { name: "two", seed: created })
        const bRow = (rows: ReadonlyArray<Row>) =>
          rows.filter((row) => row.__edd_e__?.S === "Line" && row.owner?.S === "b")
        for (const [name, mutate] of [
          [
            "update",
            (state: any) => ({
              ...state,
              a: state.a.map((line: Line) => ({ ...line, note: "a changed" })),
            }),
          ],
          ["update remove", (state: any) => ({ ...state, a: [] })],
        ] as const) {
          const done = yield* w.step((db) =>
            db.aggregates.Agg.update({ id: "p q" }, ({ state }: any) => mutate(state)),
          )
          const expected = at("two edges", name)
          expect(done.result).toEqual(expected.result)
          expect(done.requests).toEqual(named(expected.requests))
          expect(done.rows).toEqual(byKey(expected.rows))
          expect(bRow(done.rows)).toEqual(bRow(created))
        }
        yield* w.opened.close
      }),
    )

    for (const dryRun of [true, false]) {
      it.effect(`rekey${dryRun ? ", a dry run," : ""} moves each row once, as 1.39.0 did`, () =>
        Effect.gen(function* () {
          const w = yield* world(backend, twoDefine, {
            name: "two",
            escapeKeys: true,
            seed: created,
          })
          const done = yield* w.step((db) =>
            db.tables.Main.rekey({ repairIndexKeys: true, dryRun }),
          )
          const expected = at("two edges", `rekey${dryRun ? " dry run" : ""}`)
          expect(reportOf(done.exit)).toEqual(expected.report)
          if (backend.local) expect(unordered(done.commands)).toEqual(unordered(expected.commands))
          expect(done.rows).toEqual(byKey(expected.rows))
          if (!dryRun) {
            expect(resultOf(yield* w.run((db) => db.aggregates.Agg.get({ id: "p q" })))).toEqual(
              expected.get,
            )
          }
          yield* w.opened.close
        }),
      )
    }
  })

  for (const custom of [false, true]) {
    const scenario = `graph${custom ? " custom" : ""}`
    describe(`nested sub-aggregates under static discriminators${custom ? ", with a custom decompose" : ""}`, () => {
      it.effect("create, read, update and delete send and store what 1.39.0 did", () =>
        Effect.gen(function* () {
          const w = yield* world(backend, graphDefine(custom), { name: "graph", gsi: true })
          const ops: ReadonlyArray<
            readonly [string, (db: any) => Effect.Effect<unknown, unknown>]
          > = [
            ["create", (db) => db.aggregates.Agg.create(graphInput)],
            ["get", (db) => db.aggregates.Agg.get({ id: "a b" })],
            ["list", (db) => db.aggregates.Agg.list()],
            [
              "update",
              (db) =>
                db.aggregates.Agg.update({ id: "a b" }, ({ state }: any) => ({
                  ...state,
                  note: "changed",
                  a: { ...state.a, left: { ...state.a.left, lines: [] } },
                })),
            ],
            ["noop", (db) => db.aggregates.Agg.update({ id: "a b" }, ({ state }: any) => state)],
            ["get2", (db) => db.aggregates.Agg.get({ id: "a b" })],
            ["delete", (db) => db.aggregates.Agg.delete({ id: "a b" })],
          ]
          for (const [op, body] of ops) {
            const done = yield* w.step(body)
            const expected = at(scenario, op)
            expect(done.result, op).toEqual(expected.result)
            expect(backend.local ? done.requests : batchInKeyOrder(done.requests), op).toEqual(
              backend.local
                ? named(expected.requests)
                : batchInKeyOrder(named(expected.requests) as ReadonlyArray<Request>),
            )
            expect(done.rows, op).toEqual(byKey(expected.rows))
          }
          yield* w.opened.close
        }),
      )

      it.effect("rekey moves every row, as 1.39.0 did", () =>
        Effect.gen(function* () {
          const w = yield* world(backend, graphDefine(custom), {
            name: "graph",
            gsi: true,
            escapeKeys: true,
            seed: at(scenario, "create").rows,
          })
          const done = yield* w.step((db) => db.tables.Main.rekey({ repairIndexKeys: true }))
          const expected = at(scenario, "rekey")
          expect(reportOf(done.exit)).toEqual(expected.report)
          if (backend.local) expect(unordered(done.commands)).toEqual(unordered(expected.commands))
          expect(done.rows).toEqual(byKey(expected.rows))
          expect(resultOf(yield* w.run((db) => db.aggregates.Agg.get({ id: "a b" })))).toEqual(
            expected.get,
          )
          yield* w.opened.close
        }),
      )

      it.effect("a sub-aggregate whose transaction fails keeps its rows, as on 1.39.0", () =>
        Effect.gen(function* () {
          const seeded = at(scenario, "create").rows
          const w = yield* world(backend, graphDefine(custom), {
            name: "graph",
            gsi: true,
            seed: seeded,
          })
          let transactions = 0
          w.hooks.before = (command) =>
            command === "TransactWriteItems" && ++transactions === 2
              ? Effect.fail(
                  new DynamoError({
                    operation: "TransactWriteItems",
                    cause: new Error("injected sub-aggregate request failure"),
                  }),
                )
              : undefined
          const done = yield* w.step((db) =>
            db.aggregates.Agg.update({ id: "a b" }, ({ state }: any) => ({
              ...state,
              note: "changed",
              a: { ...state.a, left: { ...state.a.left, note: "changed sub", lines: [] } },
            })),
          )
          const expected = at(scenario, "sub failure")
          expect(done.result).toEqual(expected.result)
          expect(done.requests).toEqual(named(expected.requests))
          expect(done.rows).toEqual(byKey(expected.rows))
          const leftOfA = (rows: ReadonlyArray<Row>) =>
            byKey(rows.filter((row) => row.team?.S === "a" && row.section?.S === "left"))
          expect(leftOfA(done.rows)).toEqual(leftOfA(seeded))
          yield* w.opened.close
        }),
      )
    })
  }

  describe("a custom decompose whose key read as written is another aggregate's row", () => {
    const scenario = "second reading"
    const created = atOwnership(scenario, "created").rows
    const lineOf = (owner: string) => (row: Row) =>
      row.__edd_e__?.S === "Line" && row.owner?.S === owner

    it.effect("each reads its own row, as 1.39.0 did", () =>
      Effect.gen(function* () {
        const w = yield* world(backend, secondDefine(["a", "b"]), {
          name: "collision",
          seed: created,
        })
        for (const owner of ["a", "b"]) {
          expect(
            resultOf(yield* w.run((db) => db.aggregates[owner.toUpperCase()].get({ id: "p q" }))),
          ).toEqual(atOwnership(scenario, `created ${owner} get`))
        }
        yield* w.opened.close
      }),
    )

    it.effect("removing A's element deletes A's row alone, as 1.39.0 did", () =>
      Effect.gen(function* () {
        const w = yield* world(backend, secondDefine(["a", "b"]), {
          name: "collision",
          seed: created,
        })
        const done = yield* w.step((db) =>
          db.aggregates.A.update({ id: "p q" }, ({ state }: any) => ({ ...state, lines: [] })),
        )
        const expected = atOwnership(scenario, "remove a")
        expect(done.result).toEqual(expected.result)
        expect(done.requests).toEqual(named(expected.requests))
        expect(done.rows).toEqual(byKey(expected.rows))
        expect(byKey(done.rows.filter(lineOf("b")))).toEqual(byKey(created.filter(lineOf("b"))))
        expect(resultOf(yield* w.run((db) => db.aggregates.B.get({ id: "p q" })))).toEqual(
          atOwnership(scenario, "remove a get b"),
        )
        yield* w.opened.close
      }),
    )

    it.effect("B's row, edited after A's update read it, keeps the edit, as on 1.39.0", () =>
      Effect.gen(function* () {
        const w = yield* world(backend, secondDefine(["a", "b"]), {
          name: "collision",
          seed: created,
        })
        const foreign = created.find(lineOf("b"))!
        w.hooks.before = (command) => {
          if (command !== "TransactWriteItems") return undefined
          w.hooks.before = undefined
          return w.opened.put({ ...foreign, note: { S: "concurrent b edit" } })
        }
        const done = yield* w.step((db) =>
          db.aggregates.A.update({ id: "p q" }, ({ state }: any) => ({ ...state, lines: [] })),
        )
        const expected = atOwnership(scenario, "race remove a")
        expect(done.result).toEqual(expected.result)
        expect(done.requests).toEqual(named(expected.requests))
        expect(done.rows).toEqual(byKey(expected.rows))
        expect(done.rows).toContainEqual({ ...foreign, note: { S: "concurrent b edit" } })
        yield* w.opened.close
      }),
    )

    for (const [label, owners] of [
      ["both", ["a", "b"]],
      ["a only", ["a"]],
    ] as const) {
      for (const dryRun of [true, false]) {
        const name = `rekey ${label}${dryRun ? " dry run" : ""}`
        it.effect(`${name}: each moves its own rows, and leaves the other's, as 1.39.0 did`, () =>
          Effect.gen(function* () {
            const w = yield* world(backend, secondDefine(owners), {
              name: "collision",
              escapeKeys: true,
              seed: created,
            })
            const done = yield* w.step((db) =>
              db.tables.Main.rekey({ repairIndexKeys: true, dryRun }),
            )
            const expected = atOwnership(scenario, name)
            expect(reportOf(done.exit)).toEqual(expected.report)
            if (backend.local)
              expect(unordered(done.commands)).toEqual(unordered(expected.commands))
            expect(done.rows).toEqual(byKey(expected.rows))
            if (owners.length === 1) {
              // B isn't registered: its rows stay where they are.
              expect(byKey(done.rows.filter(lineOf("b")))).toEqual(
                byKey(created.filter(lineOf("b"))),
              )
            }
            for (const [owner, read] of Object.entries(expected.gets ?? {})) {
              expect(
                resultOf(
                  yield* w.run((db) => db.aggregates[owner.toUpperCase()].get({ id: "p q" })),
                ),
              ).toEqual(read)
            }
            if (!dryRun) {
              const again = yield* w.step((db) => db.tables.Main.rekey({ repairIndexKeys: true }))
              expect(reportOf(again.exit)).toEqual(expected.again)
            }
            yield* w.opened.close
          }),
        )
      }
    }
  })

  describe("a custom decompose whose key read as written is an entity's row", () => {
    it.effect("removing the aggregate's element leaves the entity's row, as 1.39.0 did", () =>
      Effect.gen(function* () {
        const scenario = "entity second reading"
        const seeded = atOwnership(scenario, "seeded").rows
        const w = yield* world(backend, entityDefine, { name: "entitycollision", seed: seeded })
        const done = yield* w.step((db) =>
          db.aggregates.Agg.update({ id: "id_a" }, ({ state }: any) => ({ ...state, lines: [] })),
        )
        const expected = atOwnership(scenario, "remove")
        expect(done.result).toEqual(expected.result)
        expect(done.requests).toEqual(named(expected.requests))
        expect(done.rows).toEqual(byKey(expected.rows))
        const entityRows = (rows: ReadonlyArray<Row>) =>
          byKey(rows.filter((row) => row.owner?.S === "entity"))
        expect(entityRows(done.rows)).toEqual(entityRows(seeded))
        expect(resultOf(yield* w.run((db) => db.entities.Lines.get({ id: "a", f: 5000 })))).toEqual(
          atOwnership(scenario, "remove entity get"),
        )
        yield* w.opened.close
      }),
    )
  })

  describe("an aggregate whose row belongs where another aggregate's row is", () => {
    const scenario = "claimed destination"
    for (const id of ["p%z", "p q"]) {
      const created = atOwnership(scenario, `created ${id}`).rows
      // The scan meets one aggregate's rows first: on the in-memory table, the order they're stored
      // in, and each order is run; on DynamoDB Local, its own. Either way the outcome is the same.
      const ofA = (row: Row) => row.__edd_e__?.S === "Roota" || row.owner?.S === "a"
      const aRows = byKey(created.filter(ofA))
      const bRows = byKey(created.filter((row) => !ofA(row)))
      const orders = backend.local
        ? [{ order: "", seed: created, aFirst: true }]
        : [
            { order: ", A's rows scanned first", seed: [...aRows, ...bRows], aFirst: true },
            { order: ", B's rows scanned first", seed: [...bRows, ...aRows], aFirst: false },
          ]
      for (const [label, owners] of [
        ["both", ["a", "b"]],
        ["b only", ["b"]],
      ] as const) {
        for (const dryRun of [true, false]) {
          const name = `rekey ${id} ${label}${dryRun ? " dry run" : ""}`
          for (const { order, seed, aFirst } of orders) {
            it.effect(`${name}${order}: B's move is refused whole, as 1.39.0 did`, () =>
              Effect.gen(function* () {
                const w = yield* world(
                  backend,
                  claimedDefine(aFirst || owners.length === 1 ? owners : [...owners].reverse()),
                  { name: "claimed", escapeKeys: true, seed },
                )
                const done = yield* w.step((db) =>
                  db.tables.Main.rekey({ repairIndexKeys: true, dryRun }),
                )
                const expected = atOwnership(scenario, name)
                expect(reportOf(done.exit)).toEqual(expected.report)
                if (backend.local)
                  expect(unordered(done.commands)).toEqual(unordered(expected.commands))
                // Nothing of B's moved, its root included, and A's rows are as they were.
                expect(done.rows).toEqual(byKey(created))
                expect(done.rows).toEqual(byKey(expected.rows))
                for (const [owner, read] of Object.entries(expected.gets ?? {})) {
                  expect(
                    resultOf(yield* w.run((db) => db.aggregates[owner.toUpperCase()].get({ id }))),
                  ).toEqual(read)
                }
                if (!dryRun) {
                  const again = yield* w.step((db) =>
                    db.tables.Main.rekey({ repairIndexKeys: true }),
                  )
                  expect(reportOf(again.exit)).toEqual(expected.again)
                  expect(again.rows).toEqual(byKey(created))
                }
                yield* w.opened.close
              }),
            )
          }
        }
      }
    }
  })

  describe("a transformed custom `many` edge whose key as written is a `one` edge's", () => {
    const scenario = "mixed edges"
    const created = atOwnership(scenario, "created").rows
    for (const dryRun of [true, false]) {
      const name = `rekey${dryRun ? " dry run" : ""}`
      it.effect(`${name} moves each row once, as 1.39.0 did`, () =>
        Effect.gen(function* () {
          const w = yield* world(backend, mixedDefine, {
            name: "mixed",
            escapeKeys: true,
            seed: created,
          })
          const done = yield* w.step((db) =>
            db.tables.Main.rekey({ repairIndexKeys: true, dryRun }),
          )
          const expected = atOwnership(scenario, name)
          expect(reportOf(done.exit)).toEqual(expected.report)
          if (backend.local) expect(unordered(done.commands)).toEqual(unordered(expected.commands))
          expect(done.rows).toEqual(byKey(expected.rows))
          for (const request of done.requests.filter((r) => r.command === "TransactWriteItems")) {
            const keys = transactionKeys(request)
            expect(new Set(keys).size).toBe(keys.length)
          }
          if (!dryRun) {
            expect(resultOf(yield* w.run((db) => db.aggregates.Agg.get({ id: "p q" })))).toEqual(
              expected.get,
            )
          }
          yield* w.opened.close
        }),
      )
    }
  })

  describe("a custom decompose renaming a transformed field", () => {
    type Lines = ReadonlyArray<{ readonly lid: string }>
    const linesOf = (state: any, shape: RenameShape): Lines =>
      shape === "sub" ? state.sub.lines : state.lines
    const withLines = (state: any, shape: RenameShape, lines: Lines) =>
      shape === "sub" ? { ...state, sub: { ...state.sub, lines } } : { ...state, lines }
    for (const kind of Object.keys(renameKinds) as Array<keyof typeof renameKinds>) {
      for (const shape of ["plain", "entity", "sub"] as const) {
        const scenario = `${kind} ${shape}`
        const created = atRenamed(scenario, "create").rows
        const read = (w: {
          readonly run: <A>(
            body: (db: any) => Effect.Effect<A, unknown, never>,
          ) => Effect.Effect<Exit.Exit<A, unknown>>
        }) =>
          Effect.map(
            w.run((db) => db.aggregates.Orders.get({ id: "p q" })),
            (exit) => resultOf(exit),
          )

        it.effect(`${scenario}: create stores the rows 1.39.0 stored`, () =>
          Effect.gen(function* () {
            const w = yield* world(backend, renameDefine(kind, shape), { name: "rename" })
            const [value] = [renameKinds[kind][1]]
            const lines = ["a", "b"].map((lid) => ({ lid, f: value, note: "initial" }))
            const done = yield* w.step((db) =>
              db.aggregates.Orders.create({
                id: "p q",
                note: "initial",
                ...(shape === "sub" ? { sub: { lines } } : { lines }),
              }),
            )
            expect(done.rows).toEqual(byKey(created))
            expect(yield* read(w)).toEqual(atRenamed(scenario, "create get"))
            yield* w.opened.close
          }),
        )

        it.effect(
          `${scenario}: changing a line, then removing it, leaves the rows 1.39.0 left`,
          () =>
            Effect.gen(function* () {
              const w = yield* world(backend, renameDefine(kind, shape), {
                name: "rename",
                seed: created,
              })
              for (const [name, mutate] of [
                [
                  "change",
                  (state: any) =>
                    withLines(
                      state,
                      shape,
                      linesOf(state, shape).map((l) =>
                        l.lid === "a" ? { ...l, note: "changed" } : l,
                      ),
                    ),
                ],
                [
                  "remove",
                  (state: any) =>
                    withLines(
                      state,
                      shape,
                      linesOf(state, shape).filter((l) => l.lid !== "a"),
                    ),
                ],
              ] as const) {
                const done = yield* w.step((db) =>
                  db.aggregates.Orders.update({ id: "p q" }, ({ state }: any) => mutate(state)),
                )
                const expected = atRenamed(scenario, name)
                expect(done.exit._tag).toBe("Success")
                expect(done.requests).toEqual(named(expected.requests))
                expect(done.rows).toEqual(byKey(expected.rows))
                expect(yield* read(w)).toEqual(atRenamed(scenario, `${name} get`))
              }
              yield* w.opened.close
            }),
        )

        for (const dryRun of [true, false]) {
          const name = `rekey${dryRun ? " dry run" : ""}`
          it.effect(`${scenario}: ${name} moves every row, as stored`, () =>
            Effect.gen(function* () {
              const w = yield* world(backend, renameDefine(kind, shape), {
                name: "rename",
                escapeKeys: true,
                seed: created,
              })
              const done = yield* w.step((db) =>
                db.tables.Main.rekey({ repairIndexKeys: true, dryRun }),
              )
              const expected = atRenamed(scenario, name)
              // The rows 1.39.0 moved, counted as it counted them.
              expect(reportOf(done.exit)).toEqual(expected.report)
              if (backend.local)
                expect(unordered(done.commands)).toEqual(unordered(expected.commands))
              // Each row as it was stored, under the new partition key. 1.39.0 wrote the edge's rows
              // from their value decoded once more (`g` 500 became 5000), so they read otherwise.
              expect(done.rows).toEqual(
                byKey(
                  dryRun
                    ? created
                    : created.map((row) => ({
                        ...row,
                        pk: { S: row.pk!.S!.replace("#p q", "#p%20q") },
                      })),
                ),
              )
              expect(byKey(expected.rows).map((row) => [row.pk, row.sk])).toEqual(
                done.rows.map((row) => [row.pk, row.sk]),
              )
              if (!dryRun) expect(yield* read(w)).toEqual(atRenamed(scenario, "create get"))
              yield* w.opened.close
            }),
          )
        }
      }
    }
  })

  describe("a custom decompose whose key as written holds a row that encodes to its own", () => {
    for (const note of ["same", "different"]) {
      const scenario = `content fallback ${note}`
      const created = atForeign(scenario, "created").rows
      const ofB = (row: Row) => row.__edd_e__?.S === "Rootb" || row.f?.N === "5000"
      const readB = (rows: ReadonlyArray<Row>) =>
        Effect.gen(function* () {
          const reader = yield* world(backend, fallbackDefine(["b"]), {
            name: "fallback",
            seed: rows,
          })
          const read = resultOf(yield* reader.run((db) => db.aggregates.B.get({ id: "p q" })))
          yield* reader.opened.close
          return read
        })

      it.effect(`B's note ${note}: each reads its own row, as 1.39.0 did`, () =>
        Effect.gen(function* () {
          const w = yield* world(backend, fallbackDefine(["a", "b"]), {
            name: "fallback",
            seed: created,
          })
          for (const owner of ["a", "b"]) {
            expect(
              resultOf(yield* w.run((db) => db.aggregates[owner.toUpperCase()].get({ id: "p q" }))),
            ).toEqual(atForeign(scenario, `created ${owner} get`))
          }
          yield* w.opened.close
        }),
      )

      // B's row stores 5000, and A's reading as written would store 500 there: what B's 5000
      // encodes to through A's field. The stored row is compared as stored, never encoded.
      it.effect(`B's note ${note}: removing A's element deletes A's row alone, as 1.39.0 did`, () =>
        Effect.gen(function* () {
          const w = yield* world(backend, fallbackDefine(["a", "b"]), {
            name: "fallback",
            seed: created,
          })
          const done = yield* w.step((db) =>
            db.aggregates.A.update({ id: "p q" }, ({ state }: any) => ({ ...state, lines: [] })),
          )
          const expected = atForeign(scenario, "remove a")
          expect(done.result).toEqual(expected.result)
          expect(done.requests).toEqual(named(expected.requests))
          expect(done.rows).toEqual(byKey(expected.rows))
          expect(others(done.rows, (row) => !ofB(row))).toEqual(others(created, (row) => !ofB(row)))
          expect(yield* readB(done.rows)).toEqual(atForeign(scenario, "remove a get b"))
          yield* w.opened.close
        }),
      )

      for (const dryRun of [true, false]) {
        const name = `rekey a${dryRun ? " dry run" : ""}`
        it.effect(`B's note ${note}: ${name} moves A's rows and leaves B's, as 1.39.0 did`, () =>
          Effect.gen(function* () {
            const w = yield* world(backend, fallbackDefine(["a"]), {
              name: "fallback",
              escapeKeys: true,
              seed: created,
            })
            const done = yield* w.step((db) => db.tables.Main.rekey({ dryRun }))
            const expected = atForeign(scenario, name)
            expect(reportOf(done.exit)).toEqual(expected.report)
            if (backend.local)
              expect(unordered(done.commands)).toEqual(unordered(expected.commands))
            expect(done.rows).toEqual(byKey(expected.rows))
            expect(others(done.rows, (row) => !ofB(row))).toEqual(
              others(created, (row) => !ofB(row)),
            )
            if (!dryRun)
              expect(yield* readB(done.rows)).toEqual(atForeign(scenario, "rekey a get b"))
            yield* w.opened.close
          }),
        )
      }
    }
  })

  describe("a custom decompose's row another aggregate replaces after the update read it", () => {
    const scenario = "concurrent replace"
    const created = atForeign(scenario, "created").rows
    const lineOf = (owner: string) => (row: Row) =>
      row.__edd_e__?.S === "Line" && row.note?.S === owner
    it.effect("B's update puts its row at the key, as 1.39.0 did", () =>
      Effect.gen(function* () {
        const w = yield* world(backend, concurrentDefine, { name: "concurrent", seed: created })
        const done = yield* w.step((db) =>
          db.aggregates.B.update({ id: "p" }, ({ state }: any) => ({
            ...state,
            lines: [{ f: 50, note: "b" }],
          })),
        )
        const expected = atForeign(scenario, "b takes the key")
        expect(done.result).toEqual(expected.result)
        expect(done.requests).toEqual(named(expected.requests))
        expect(done.rows).toEqual(byKey(expected.rows))
        yield* w.opened.close
      }),
    )

    // `Line` is shared by A and B, so A's update is 1.39.0's: it deletes the key as read (5),
    // where no row is, and leaves A's row at 50 (DESIGN.md §7 "Which rows in its partition are an
    // aggregate's": a shared type's stale rows stay).
    it.effect("removing A's element sends what 1.39.0 sent, and A's row stays", () =>
      Effect.gen(function* () {
        const w = yield* world(backend, concurrentDefine, { name: "concurrent", seed: created })
        const done = yield* w.step((db) =>
          db.aggregates.A.update({ id: "p" }, ({ state }: any) => ({ ...state, lines: [] })),
        )
        const expected = atForeign(scenario, "remove a")
        expect(done.requests).toEqual(named(expected.requests))
        expect(done.rows).toEqual(byKey(expected.rows))
        expect(done.rows).toContainEqual(created.find(lineOf("a")))
        // 1.39.0 and 1.40.0 returned the state as mutated; a get after it reads A's row, which
        // stays, and the update now returns what that get reads (DESIGN.md §11 "What `update`
        // returns").
        const after = yield* w.step((db) => db.aggregates.A.get({ id: "p" }))
        expect((after.result as any).ok.lines).toHaveLength(1)
        expect((expected.result as any).ok.lines).toEqual([])
        expect(done.result).toEqual(after.result)
        yield* w.opened.close
      }),
    )

    it.effect("B's row, put at the key after A's update read it, is kept, as 1.39.0 kept it", () =>
      Effect.gen(function* () {
        const w = yield* world(backend, concurrentDefine, { name: "concurrent", seed: created })
        const taken = atForeign(scenario, "b takes the key").rows.find(lineOf("b"))!
        w.hooks.before = (command) => {
          if (command !== "TransactWriteItems") return undefined
          w.hooks.before = undefined
          return w.opened.put(taken)
        }
        const before = yield* w.step((db) => db.aggregates.A.get({ id: "p" }))
        const done = yield* w.step((db) =>
          db.aggregates.A.update({ id: "p" }, ({ state }: any) => ({ ...state, lines: [] })),
        )
        const expected = atForeign(scenario, "race remove a")
        // What a get right after the update would read had nothing else written: A's row stays,
        // as read (B's replaced it in between). 1.39.0 returned the state as mutated.
        expect((expected.result as any).ok.lines).toEqual([])
        expect(done.result).toEqual({
          ok: { ...(expected.result as any).ok, lines: (before.result as any).ok.lines },
        })
        expect(done.requests).toEqual(named(expected.requests))
        expect(done.rows).toEqual(byKey(expected.rows))
        expect(done.rows).toContainEqual(taken)
        yield* w.opened.close
      }),
    )
  })

  describe("three aggregates whose rows form an escaping sort-key chain", () => {
    const scenario = "three owners"
    const created = atForeign(scenario, "created").rows
    const ownerOf = (row: Row) => row.owner?.S ?? row.__edd_e__!.S!.slice(4)
    /** A report with its conflicts in member order: the order they're found in is the scan's. */
    const inOrder = (report: any) => ({
      ...report,
      conflicts: [...(report.conflicts ?? [])].sort((p: any, q: any) =>
        p.member.localeCompare(q.member),
      ),
    })
    const lid = (owner: string, rows: ReadonlyArray<Row>) =>
      rows.find((row) => row.owner?.S === owner)?.sk?.S?.split("#line#")[1]
    // `Line` is shared by the three. A key holds an aggregate's row only if the row there holds its
    // values (#240): another owner's row in its way is judged first, as the scan would judge it, so
    // one run moves the whole chain whatever order the scan meets the rows in, and a dry run says
    // so. On 1.39.0 a dry run named the one link that could move, and a real run moved one link or
    // more depending on timing, so it took up to three runs (the fixture's `fourth` rows are where
    // they all ended).
    for (const order of ["abc", "acb", "bac", "bca", "cab", "cba"]) {
      it.effect(`scanned ${order}: one run moves the whole chain`, () =>
        Effect.gen(function* () {
          const w = yield* world(backend, chainDefine, {
            name: "chain",
            escapeKeys: true,
            seed: created,
            scanOrder: (row) => order.indexOf(ownerOf(row)),
          })
          const dry = yield* w.step((db) => db.tables.Main.rekey({ dryRun: true }))
          const first = { scanned: 6, unchanged: 3, moved: 3, indexKeysRewritten: 0, conflicts: [] }
          expect(inOrder(reportOf(dry.exit))).toEqual(first)
          expect(dry.rows).toEqual(byKey(created))

          const run = yield* w.step((db) => db.tables.Main.rekey({}))
          expect(inOrder(reportOf(run.exit))).toEqual(first)
          const again = yield* w.step((db) => db.tables.Main.rekey({}))
          expect(reportOf(again.exit)).toMatchObject({ moved: 0, conflicts: [] })
          const done = byKey(yield* w.opened.rows)
          expect(done).toEqual(byKey(atForeign(scenario, `rekey ${order}`).fourth.rows))
          expect(["a", "b", "c"].map((owner) => lid(owner, done))).toEqual([
            "x%20y",
            "x%2520y",
            "x%252520y",
          ])
          for (const owner of ["A", "B", "C"]) {
            const read: any = resultOf(yield* w.run((db) => db.aggregates[owner].get({ id: "p" })))
            expect(read.ok.lines).toHaveLength(1)
          }
          yield* w.opened.close
        }),
      )
    }
  })

  // An element of a custom decompose holds one row at most: its key as written is never its row
  // while its key as read holds one. A's 50 is read from key 500, so key 5000 is never A's, though
  // it holds byte for byte what A would write there (with `payload`, the same decimal).
  for (const scenario of ["equal content", "decimal 0.100", "decimal 0.10000000000000001"]) {
    const spelling = scenario.startsWith("decimal ") ? scenario.slice("decimal ".length) : undefined
    describe(`${scenario}: a row holding what A's key as written would hold is B's`, () => {
      const created = atClaimed(scenario, "created").rows
      const ofB = (row: Row) => row.__edd_e__?.S === "Rootb" || row.f?.N === "500"

      it.effect("removing A's element deletes A's row, as 1.39.0 did, and B's stays", () =>
        Effect.gen(function* () {
          const w = yield* world(backend, equalDefine(["a", "b"], spelling), {
            name: "equal",
            seed: created,
          })
          const done = yield* w.step((db) =>
            db.aggregates.A.update({ id: "p q" }, ({ state }: any) => ({ ...state, lines: [] })),
          )
          const expected = atClaimed(scenario, "remove a")
          expect(done.result).toEqual(expected.result)
          expect(done.requests).toEqual(named(expected.requests))
          expect(done.rows).toEqual(byKey(expected.rows))
          expect(others(done.rows, (row) => !ofB(row))).toEqual(others(created, (row) => !ofB(row)))
          expect(resultOf(yield* w.run((db) => db.aggregates.B.get({ id: "p q" })))).toEqual(
            atClaimed(scenario, "remove a get b"),
          )
          yield* w.opened.close
        }),
      )

      for (const dryRun of [true, false]) {
        it.effect(`rekey of A alone${dryRun ? ", dry run" : ""}: A's two rows, as 1.39.0`, () =>
          Effect.gen(function* () {
            const w = yield* world(backend, equalDefine(["a"], spelling), {
              name: "equal",
              escapeKeys: true,
              seed: created,
            })
            const done = yield* w.step((db) => db.tables.Main.rekey({ dryRun }))
            const expected = atClaimed(scenario, `rekey a${dryRun ? " dry run" : ""}`)
            expect(reportOf(done.exit)).toEqual(expected.report)
            if (backend.local)
              expect(unordered(done.commands)).toEqual(unordered(expected.commands))
            expect(done.rows).toEqual(byKey(expected.rows))
            expect(others(done.rows, (row) => !ofB(row))).toEqual(
              others(created, (row) => !ofB(row)),
            )
            yield* w.opened.close
          }),
        )
      }
    })
  }

  // A's decompose divides by 10, so its row is at key 50, which its value as read (500) doesn't
  // key. B's update puts its own line there, adding `z_owner`, which both models declare.
  for (const [scenario, wide] of [
    ["guard narrow", 0],
    ["guard wide", 160],
  ] as const) {
    describe(`${scenario}: A's row is at a key its value as read doesn't key`, () => {
      const created = atClaimed(scenario, "created").rows
      const lineKey = "$guard#v1#line#0000000000000050"
      const taken = atClaimed(scenario, "b takes the key").rows.find(
        (row) => row.z_owner?.S === "b",
      )!

      it.effect("B's update puts its line at the key, as 1.39.0 did", () =>
        Effect.gen(function* () {
          const w = yield* world(backend, guardDefine(["a", "b"], wide), {
            name: "guard",
            seed: created,
          })
          const done = yield* w.step((db) =>
            db.aggregates.B.update({ id: "p q" }, ({ state }: any) => ({
              ...state,
              lines: [
                {
                  f: 50,
                  note: "same",
                  ...Object.fromEntries(Object.keys(fillers(wide)).map((name) => [name, "value"])),
                  z_owner: "b",
                },
              ],
            })),
          )
          const expected = atClaimed(scenario, "b takes the key")
          // Stored as 1.39.0 stored it. 1.39.0 returned the value the mutation gave decoded once
          // more (500); the update returns it as given (50).
          expect(done.rows).toEqual(byKey(expected.rows))
          expect((expected.result as any).ok.lines[0].f).toBe(500)
          expect((done.result as any).ok.lines[0].f).toBe(50)
          yield* w.opened.close
        }),
      )

      // `Line` is shared by A and B, so A's update is 1.39.0's: it deletes the key as read (5),
      // where no row is, and A's row at 50 stays.
      it.effect("removing A's element sends what 1.39.0 sent, and A's row stays", () =>
        Effect.gen(function* () {
          const w = yield* world(backend, guardDefine(["a", "b"], wide), {
            name: "guard",
            seed: created,
          })
          const done = yield* w.step((db) =>
            db.aggregates.A.update({ id: "p q" }, ({ state }: any) => ({ ...state, lines: [] })),
          )
          const expected = atClaimed(scenario, "remove a")
          expect(done.requests).toEqual(named(expected.requests))
          expect(done.rows).toEqual(byKey(expected.rows))
          expect(done.rows.map((row) => row.sk?.S)).toContain(lineKey)
          // 1.39.0 and 1.40.0 returned the state as mutated; a get after it reads A's row, which
          // stays, and the update now returns what that get reads (DESIGN.md §11 "What `update`
          // returns").
          const after = yield* w.step((db) => db.aggregates.A.get({ id: "p q" }))
          expect((after.result as any).ok.lines).toHaveLength(1)
          expect((expected.result as any).ok.lines).toEqual([])
          expect(done.result).toEqual(after.result)
          yield* w.opened.close
        }),
      )

      it.effect(
        "B's line, put at the key after A's update read it, is kept, as 1.39.0 kept it",
        () =>
          Effect.gen(function* () {
            const w = yield* world(backend, guardDefine(["a", "b"], wide), {
              name: "guard",
              seed: created,
            })
            w.hooks.before = (command) => {
              if (command !== "TransactWriteItems") return undefined
              w.hooks.before = undefined
              return w.opened.put(taken)
            }
            const before = yield* w.step((db) => db.aggregates.A.get({ id: "p q" }))
            const done = yield* w.step((db) =>
              db.aggregates.A.update({ id: "p q" }, ({ state }: any) => ({ ...state, lines: [] })),
            )
            const expected = atClaimed(scenario, "race remove a")
            // What a get right after the update would read had nothing else written: A's row
            // stays, as read (B's replaced it in between). 1.39.0 returned the state as mutated.
            expect((expected.result as any).ok.lines).toEqual([])
            expect(done.result).toEqual({
              ok: { ...(expected.result as any).ok, lines: (before.result as any).ok.lines },
            })
            expect(done.requests).toEqual(named(expected.requests))
            expect(done.rows).toEqual(byKey(expected.rows))
            expect(done.rows).toContainEqual(taken)
            yield* w.opened.close
          }),
      )

      // 1.39.0 found no row at the key as read and moved the root alone, leaving the line in the
      // old partition (DESIGN.md §7 "Which rows in its partition are an aggregate's": without
      // `ownsRows`, a row the value doesn't key stays).
      for (const dryRun of [true, false]) {
        it.effect(`rekey of A${dryRun ? ", dry run" : ""}: the root moves alone, as 1.39.0`, () =>
          Effect.gen(function* () {
            const w = yield* world(backend, guardDefine(["a"], wide), {
              name: "guard",
              escapeKeys: true,
              seed: created,
            })
            const done = yield* w.step((db) => db.tables.Main.rekey({ dryRun }))
            const expected = atClaimed(scenario, `rekey a${dryRun ? " dry run" : ""}`)
            expect(reportOf(done.exit)).toEqual(expected.report)
            if (backend.local)
              expect(unordered(done.commands)).toEqual(unordered(expected.commands))
            expect(done.rows).toEqual(byKey(expected.rows))
            yield* w.opened.close
          }),
        )
      }
    })
  }
}
