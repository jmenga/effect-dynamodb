/**
 * Read models whose projections' outboxes share one table (#237), on DynamoDB Local: bigint key
 * shapes, and the key-space relations `DynamoClient.make`, `drainPending` and the outbox table's
 * `rekey` decide. A bigint's key text is a number's (`n_0000000000000007`, a negative's `-` and
 * nine's complement, a large one's `:` and exponent): no letter, no `#`.
 *
 * - A bigint beside a label it can't spell (`n` beside `n_x`), and a bigint alone beside a bigint
 *   then a label (`n` beside `n`, `branch`): they bind; each drainer drains its own; `rekey`
 *   moves each item by its own read model, reading no row; a rerun moves nothing.
 * - A bigint beside a number, or a string beside a string, at one composite: one key space.
 *   `DynamoClient.make` refuses them (`EDD-9134`); a client made before the projections were
 *   defined reaches `rekey`, which refuses them before sending anything; the item stays and drains.
 * - A member of the outbox table with the read model's entity type: one keyed by a number where
 *   the read model's is a bigint is refused by `rekey`; one keyed as the read model moves its
 *   items, written with or without the read model's tag (1.39.0 and 1.40.0 wrote none).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Config, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

class Opened extends Schema.TaggedClass<Opened>()("Opened", {}) {}
class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
const Notice = Schema.Struct({ account: Schema.String, total: Schema.Number })

const Pair = Schema.Struct({
  n: Schema.BigInt,
  n_x: Schema.String,
  shop: Schema.String,
  branch: Schema.String,
  name: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Pair = typeof Pair.Type
type PairKey = "n" | "n_x" | "shop" | "branch"

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }
const INDEX = { name: "outbox", pk: "obpk", sk: "obsk" } as const

let made = 0

/** The physical tables of one test, and the client recording the tables its `GetItem`s name. */
const physical = () => {
  const stamp = `${Date.now()}-${made++}`
  const names = {
    t: `ks-t-${stamp}`,
    o: `ks-o-${stamp}`,
    r0: `ks-r0-${stamp}`,
    r1: `ks-r1-${stamp}`,
  }
  const gets: Array<string> = []
  const client = Layer.effect(
    DynamoClient,
    Effect.map(Effect.service(DynamoClient), (inner) => ({
      ...inner,
      getItem: (input: Parameters<typeof inner.getItem>[0]) => {
        gets.push(String(input.TableName))
        return inner.getItem(input)
      },
    })),
  ).pipe(Layer.provide(ClientLayer))
  const create = Effect.gen(function* () {
    const ddb = yield* DynamoClient
    for (const name of Object.values(names)) {
      yield* ddb.createTable({
        TableName: name,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          ...(name === names.o
            ? [
                { AttributeName: INDEX.pk, AttributeType: "S" as const },
                { AttributeName: INDEX.sk, AttributeType: "S" as const },
              ]
            : []),
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        ...(name === names.o && {
          GlobalSecondaryIndexes: [
            {
              IndexName: INDEX.name,
              KeySchema: [
                { AttributeName: INDEX.pk, KeyType: "HASH" as const },
                { AttributeName: INDEX.sk, KeyType: "RANGE" as const },
              ],
              Projection: { ProjectionType: "ALL" as const },
            },
          ],
        }),
      })
    }
  })
  const drop = Effect.gen(function* () {
    const ddb = yield* DynamoClient
    for (const name of Object.values(names)) {
      yield* ddb.deleteTable({ TableName: name }).pipe(Effect.ignore)
    }
  })
  /** The outbox items, by key, sorted. */
  const outbox = Effect.gen(function* () {
    const ddb = yield* DynamoClient
    const page = yield* ddb.scan({ TableName: names.o, ConsistentRead: true })
    return (page.Items ?? [])
      .filter((item) => item.__edd_e__?.S === "Ledger#outbox")
      .map((item) => `${item.pk?.S}|${item.sk?.S}`)
      .sort()
  })
  /** The tables other than the outbox's that `GetItem` named since the last call. */
  const rowReads = () => gets.splice(0).filter((name) => name !== names.o)
  return { names, client, create, drop, outbox, rowReads }
}

/** One side: a `Ledger` read model keyed by `pk`, on a table of its own or a member of `O`. */
interface Side {
  readonly pk: ReadonlyArray<PairKey>
  /** `Pair` with its fields of other types. */
  readonly model?: Schema.Top
  /** A member of the outbox table, with no projection. */
  readonly member?: boolean
  /** The row its projection writes, when not the pair's. */
  readonly row?: Record<string, unknown>
}

/**
 * `sides` under `escapeKeys` in schema `ks`, every projection writing `row` (or its side's), with
 * its outbox on `O`; the physical tables `names`. `projections()` defines the projections, so a
 * client can be made before them.
 */
const pairs = (
  escapeKeys: boolean,
  sides: ReadonlyArray<Side>,
  row: Partial<Pair>,
  names: ReturnType<typeof physical>["names"],
) => {
  const schema = DynamoSchema.make({ name: "ks", version: 1, escapeKeys })
  const EventsTable = Table.make({ schema, entities: {} })
  const Accounts = EventStore.makeStream({
    table: EventsTable,
    streamName: "Account",
    events: [Opened, Added],
    streamId: { composite: ["account"] },
  })
  const ledgers = sides.map((side) =>
    Entity.make({
      model: (side.model ?? Pair) as typeof Pair,
      entityType: "Ledger",
      primaryKey: {
        pk: { field: "pk", composite: [...side.pk] as [PairKey, ...Array<PairKey>] },
        sk: { field: "sk", composite: ["name"] },
      },
    }),
  )
  const O = Table.make({
    schema,
    entities: Object.fromEntries(
      ledgers.flatMap((Ledgers, i) => (sides[i]!.member ? [[`M${i}`, Ledgers]] : [])),
    ),
  })
  const read = ledgers.map((Ledgers, i) =>
    sides[i]!.member ? undefined : Table.make({ schema, entities: { [`L${i}`]: Ledgers } }),
  )
  const projections = () =>
    ledgers.map((Ledgers, i) =>
      sides[i]!.member
        ? undefined
        : (EventStore.projection({
            stream: Accounts,
            readModel: Ledgers as unknown as Entity.Entity<any, any, any, any, any>,
            key: () => sides[i]!.row ?? row,
            initial: (): Pair => ({
              ...((sides[i]!.row ?? row) as Pair),
              total: 0,
              version: 0,
              rev: 0,
            }),
            evolve: (state: Pair, event: { readonly data: Opened | Added }) =>
              Effect.succeed(
                event.data._tag === "Added"
                  ? { ...state, total: state.total + event.data.amount }
                  : state,
              ),
            checkpoint: "version",
            revision: "rev",
            outbox: {
              schema: Notice,
              effects: (event: any, next: Pair | undefined) =>
                event.data._tag === "Added"
                  ? [{ account: event.streamId, total: next?.total ?? -1 }]
                  : [],
              table: O,
              index: INDEX,
            },
          } as any) as any),
    )
  const layer = Layer.mergeAll(
    EventsTable.layer({ name: names.t }),
    O.layer({ name: names.o }),
    ...read.flatMap((table, i) =>
      table === undefined ? [] : [table.layer({ name: i === 0 ? names.r0 : names.r1 })],
    ),
  )
  const client = DynamoClient.make({
    entities: Object.fromEntries(
      ledgers.flatMap((Ledgers, i) => (sides[i]!.member ? [] : [[`L${i}`, Ledgers]])),
    ),
    tables: Object.fromEntries([
      ["O", O],
      ...read.flatMap((table, i) => (table === undefined ? [] : [[`R${i}`, table]])),
    ]),
  } as any) as Effect.Effect<any, never, any>
  return { Accounts, ledgers, O, read, projections, layer, client }
}

/** What `projection`'s drainers deliver: `drain` of `row`, or `drainPending`. */
const delivered = (projection: any, row: Record<string, unknown> | undefined) =>
  Effect.gen(function* () {
    const totals: Array<number> = []
    const deliver = (effect: { readonly total: number }) =>
      Effect.sync(() => void totals.push(effect.total))
    if (row === undefined) yield* projection.drainPending(deliver) as Effect.Effect<unknown>
    else yield* projection.drain(row, deliver) as Effect.Effect<unknown>
    return totals
  })

/** A defect `effect` dies with, as text, or `"binds"`. */
const defectOf = <R>(effect: Effect.Effect<unknown, unknown, R>) =>
  effect.pipe(
    Effect.as("binds"),
    Effect.catchDefect((cause) => Effect.succeed(String(cause))),
  )

const BIGINTS = [
  ["7", 7n],
  ["-7", -7n],
  ["10^20", 10n ** 20n],
] as const

const DIRECTIONS = [
  ["to on", false, true],
  ["to off", true, false],
] as const

describeConnected("outbox key spaces on DynamoDB Local (#237)", () => {
  for (const [relation, sides] of [
    ["a bigint beside a label it can't spell", [{ pk: ["n"] }, { pk: ["n_x"] }]],
    ["a bigint beside a bigint then a label", [{ pk: ["n"] }, { pk: ["n", "branch"] }]],
  ] as const) {
    for (const [value, n] of BIGINTS) {
      for (const [direction, from, to] of DIRECTIONS) {
        it.effect(
          `${relation} (n = ${value}, ${direction}): each drains its own, rekey moves each by its own`,
          () => {
            const p = physical()
            const row = { n, n_x: "q", shop: "north", branch: "b1", name: "a b" }
            const written = pairs(from, sides as ReadonlyArray<Side>, row, p.names)
            const now = pairs(to, sides as ReadonlyArray<Side>, row, p.names)
            const before = written.projections()
            const after = now.projections()
            return Effect.gen(function* () {
              yield* p.create
              expect(yield* defectOf(written.client)).toBe("binds")
              expect(yield* defectOf(now.client)).toBe("binds")
              // Each drainer drains its own, and leaves the other's, whichever drains first.
              const apply = (events: ReadonlyArray<unknown>) =>
                Effect.gen(function* () {
                  for (const projection of before) {
                    const result = yield* projection.applyBatch(events)
                    expect(result.failedPositions).toEqual([])
                  }
                })
              yield* written.Accounts.append(
                { account: "x" },
                [new Opened(), new Added({ amount: 2 })],
                0,
              )
              yield* apply(yield* written.Accounts.read({ account: "x" }))
              for (const [first, second] of [
                [0, 1],
                [1, 0],
              ] as const) {
                expect(yield* p.outbox).toHaveLength(2)
                expect(yield* delivered(before[first], undefined)).toEqual([2])
                expect(yield* p.outbox).toHaveLength(1)
                expect(yield* delivered(before[second], undefined)).toEqual([2])
                expect(yield* p.outbox).toEqual([])
                if (first === 0) {
                  // The same item again: each projection redelivers its last effect.
                  yield* written.Accounts.append({ account: "x" }, [new Added({ amount: 0 })], 2)
                  yield* apply(yield* written.Accounts.read({ account: "x" }))
                }
              }
              // An item of each, then the setting changes.
              yield* written.Accounts.append({ account: "x" }, [new Added({ amount: 3 })], 3)
              yield* apply(yield* written.Accounts.read({ account: "x" }))
              const total = 5
              const items = yield* p.outbox
              expect(items).toHaveLength(2)
              const db = yield* now.client
              p.rowReads()
              const dry = (yield* db.tables.O.rekey({
                streams: [now.Accounts],
                dryRun: true,
              })) as Table.RekeyReport
              expect(dry.moved).toEqual({ ...ZERO, outbox: 2 })
              expect(yield* p.outbox).toEqual(items)
              const report = (yield* db.tables.O.rekey({
                streams: [now.Accounts],
              })) as Table.RekeyReport
              expect(report.moved).toEqual({ ...ZERO, outbox: 2 })
              expect(report.ambiguous).toEqual([])
              expect(report.conflicts).toEqual([])
              expect(report.skipped.unrecognizedKey).toBe(0)
              // Neither's key text holds `#`: no row is read.
              expect(p.rowReads()).toEqual([])
              const moved = yield* p.outbox
              expect(moved.filter((key) => items.includes(key))).toEqual([])
              const again = (yield* db.tables.O.rekey({
                streams: [now.Accounts],
              })) as Table.RekeyReport
              expect(again.moved).toEqual(ZERO)
              expect(yield* p.outbox).toEqual(moved)
              expect(yield* delivered(after[0], row)).toEqual([total])
              expect(yield* delivered(after[1], undefined)).toEqual([total])
              expect(yield* p.outbox).toEqual([])
            }).pipe(
              Effect.ensuring(p.drop),
              Effect.provide(Layer.mergeAll(p.client, written.layer, now.layer)),
            ) as Effect.Effect<void, unknown>
          },
        )
      }
    }
  }

  for (const [relation, other, n] of [
    ["a bigint beside a number", Schema.Struct({ ...Pair.fields, n: Schema.Number }), 7],
    ["a bigint beside a string", Schema.Struct({ ...Pair.fields, n: Schema.String }), "7"],
  ] as const) {
    it.effect(
      `${relation} at one composite: refused by make, and by rekey before it sends anything`,
      () => {
        const p = physical()
        const row = { n: 7n, n_x: "q", shop: "north", branch: "b1", name: "a b" }
        const s = pairs(
          true,
          [{ pk: ["n"] }, { pk: ["n"], model: other, row: { ...row, n } }],
          row,
          p.names,
        )
        return Effect.gen(function* () {
          yield* p.create
          // A client made before the projections were defined: it saw no outbox.
          const db = yield* s.client
          const [A, B] = s.projections()
          expect(yield* defectOf(s.client)).toContain(
            `[EDD-9134] DynamoClient.make: "L0" writes its projection's outbox items into ` +
              `another table`,
          )
          expect(
            yield* defectOf(
              EventStore.processBatch([], { projections: { a: A, b: B }, source: "lambda" }),
            ),
          ).toContain("[EDD-9134] EventStore.processBatch:")
          yield* s.Accounts.append({ account: "x" }, [new Opened(), new Added({ amount: 2 })], 0)
          yield* B.applyBatch(yield* s.Accounts.read({ account: "x" }))
          const items = yield* p.outbox
          expect(items).toHaveLength(1)
          for (const options of [{ dryRun: true }, {}]) {
            p.rowReads()
            const exit = yield* Effect.exit(
              db.tables.O.rekey({ streams: [s.Accounts], ...options }) as Effect.Effect<
                Table.RekeyReport,
                unknown
              >,
            )
            expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
            const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
            expect(error).toMatchObject({ _tag: "ValidationError", operation: "rekey" })
            expect(String((error as { readonly cause?: unknown }).cause)).toContain("[EDD-9134]")
            expect(p.rowReads()).toEqual([])
            expect(yield* p.outbox).toEqual(items)
          }
          expect(yield* delivered(B, { ...row, n })).toEqual([2])
        }).pipe(
          Effect.ensuring(p.drop),
          Effect.provide(Layer.mergeAll(p.client, s.layer)),
        ) as Effect.Effect<void, unknown>
      },
    )
  }

  it.effect(
    "a member keyed by a number where the read model has a bigint: rekey refuses it, the item drains",
    () => {
      const p = physical()
      const row = { n: 7n, n_x: "q", shop: "north", branch: "b1", name: "a b" }
      const s = pairs(
        true,
        [
          { pk: ["n"], member: true, model: Schema.Struct({ ...Pair.fields, n: Schema.Number }) },
          { pk: ["n"] },
        ],
        row,
        p.names,
      )
      const [, R] = s.projections()
      return Effect.gen(function* () {
        yield* p.create
        // The member is no read model: it binds.
        expect(yield* defectOf(s.client)).toBe("binds")
        yield* s.Accounts.append({ account: "x" }, [new Opened(), new Added({ amount: 2 })], 0)
        yield* R.applyBatch(yield* s.Accounts.read({ account: "x" }))
        const items = yield* p.outbox
        expect(items).toHaveLength(1)
        const db = yield* s.client
        for (const options of [{ dryRun: true }, {}]) {
          const exit = yield* Effect.exit(
            db.tables.O.rekey({ streams: [s.Accounts], ...options }) as Effect.Effect<
              Table.RekeyReport,
              unknown
            >,
          )
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(error).toMatchObject({ _tag: "ValidationError", operation: "rekey" })
          expect(String((error as { readonly cause?: unknown }).cause)).toContain("[EDD-9134]")
          expect(yield* p.outbox).toEqual(items)
        }
        expect(yield* delivered(R, row)).toEqual([2])
      }).pipe(
        Effect.ensuring(p.drop),
        Effect.provide(Layer.mergeAll(p.client, s.layer)),
      ) as Effect.Effect<void, unknown>
    },
  )

  for (const tagged of [true, false]) {
    for (const [direction, from, to] of DIRECTIONS) {
      it.effect(
        `a member keyed as the read model moves its item, ${tagged ? "tagged" : "untagged (1.39.0's and 1.40.0's)"} (${direction})`,
        () => {
          const p = physical()
          const row = { n: 7n, n_x: "q", shop: "north", branch: "b1", name: "a b" }
          const sides: ReadonlyArray<Side> = [
            { pk: ["shop", "branch"], member: true },
            { pk: ["shop", "branch"] },
          ]
          const written = pairs(from, sides, row, p.names)
          const now = pairs(to, sides, row, p.names)
          const [, before] = written.projections()
          const [, after] = now.projections()
          return Effect.gen(function* () {
            yield* p.create
            yield* written.Accounts.append(
              { account: "x" },
              [new Opened(), new Added({ amount: 2 })],
              0,
            )
            yield* before.applyBatch(yield* written.Accounts.read({ account: "x" }))
            const ddb = yield* DynamoClient
            if (!tagged) {
              const page = yield* ddb.scan({ TableName: p.names.o, ConsistentRead: true })
              for (const item of page.Items ?? []) {
                if (item.__edd_e__?.S !== "Ledger#outbox") continue
                yield* ddb.updateItem({
                  TableName: p.names.o,
                  Key: { pk: item.pk!, sk: item.sk! },
                  UpdateExpression: "REMOVE #rm",
                  ExpressionAttributeNames: { "#rm": "__edd_rm__" },
                })
              }
            }
            const items = yield* p.outbox
            expect(items).toHaveLength(1)
            const db = yield* now.client
            const report = (yield* db.tables.O.rekey({
              streams: [now.Accounts],
            })) as Table.RekeyReport
            expect(report.moved).toEqual({ ...ZERO, outbox: 1 })
            expect(report.ambiguous).toEqual([])
            expect(report.conflicts).toEqual([])
            expect(yield* p.outbox).not.toEqual(items)
            expect(yield* delivered(after, row)).toEqual([2])
          }).pipe(
            Effect.ensuring(p.drop),
            Effect.provide(Layer.mergeAll(p.client, written.layer, now.layer)),
          ) as Effect.Effect<void, unknown>
        },
      )
    }
  }
})
