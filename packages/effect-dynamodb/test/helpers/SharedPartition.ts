/**
 * Partitions holding rows of one entity type that more than one owner writes, checked step by step
 * against what published 1.39.0 stored, sent and returned (`fixtures/aggregate-shared-partition-1.39.0.json`,
 * generated once from the published package: don't regenerate or "fix" it). Shared by the unit
 * suite (an in-memory table) and the connected one (DynamoDB Local).
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
 * The other owner's rows are compared byte for byte after every step: no write of one owner may
 * delete, move or rewrite them.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Exit, Layer, Schema } from "effect"
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
                  const send = () => value.call(target, input, ...rest)
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
    it.effect("rekey moves it once, and a dry run counts it once", () =>
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
}
