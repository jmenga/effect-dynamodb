/**
 * `rekey` of an outbox table two read models of one entity type share (#237), on DynamoDB Local,
 * over the items, read-model rows and row tombstones the published 1.39.0 and 1.40.0 wrote
 * (`fixtures/rekey-outbox-owners-*.json`, captured once, never regenerated): A is keyed by `shop`
 * in its sort key, B by `shop` and `branch`. Under `escapeKeys: false`, A's `shop` =
 * `north#branch_b1` is written `shop_north#branch_b1`, as B's `north` and `b1` are, so either can
 * have written an item there, and those releases' items don't name their read model. 1.40.0
 * refused the table's `rekey`; 1.39.0 moved every item by the first read model's reading.
 *
 * Each account: `a1` A's alone, `b1` B's alone, `both` (A's and B's rows; under `false` one item,
 * the last written), `gone` (A's item, its row deleted), `tomb` (A's item, its row removed: a row
 * tombstone).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
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

type Item = Record<string, AttributeValue>
interface Captured {
  readonly version: string
  readonly runs: Record<
    "escapeKeys off" | "escapeKeys on",
    { readonly ra: Array<Item>; readonly rb: Array<Item>; readonly o: Array<Item> }
  >
}
const captured = (version: string): Captured =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/rekey-outbox-owners-${version}.json`, import.meta.url),
      "utf8",
    ),
  )

class Opened extends Schema.TaggedClass<Opened>()("Opened", {}) {}
class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {}) {}
const Ledger = Schema.Struct({
  idA: Schema.String,
  shop: Schema.String,
  branch: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Ledger = typeof Ledger.Type
const Notice = Schema.Struct({ account: Schema.String, total: Schema.Number })

/** The definitions the fixtures were written with, under `escapeKeys`. */
const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "amb", version: 1, escapeKeys })
  const EventsTable = Table.make({ schema, entities: {} })
  const Accounts = EventStore.makeStream({
    table: EventsTable,
    streamName: "Account",
    events: [Opened, Added, Closed],
    streamId: { composite: ["account"] },
  })
  const OutboxTable = Table.make({ schema, entities: {} })
  const side = (sk: ReadonlyArray<"shop" | "branch">, row: (idA: string) => Partial<Ledger>) => {
    const Ledgers = Entity.make({
      model: Ledger,
      entityType: "Ledger",
      primaryKey: {
        pk: { field: "pk", composite: ["idA"] },
        sk: { field: "sk", composite: [...sk] },
      },
    })
    const ReadTable = Table.make({ schema, entities: { Ledgers } })
    const projection = EventStore.projection({
      stream: Accounts,
      readModel: Ledgers,
      key: (id) => row(id.account) as Ledger,
      initial: (id): Ledger => ({ ...(row(id.account) as Ledger), total: 0, version: 0, rev: 0 }),
      evolve: (state, event) =>
        Effect.succeed(
          event.data._tag === "Closed"
            ? EventStore.removeRow
            : event.data._tag === "Added"
              ? { ...state, total: state.total + event.data.amount }
              : state,
        ),
      checkpoint: "version",
      revision: "rev",
      removal: {},
      outbox: {
        schema: Notice,
        effects: (event, next) =>
          event.data._tag === "Added"
            ? [{ account: event.streamId, total: next?.total ?? -1 }]
            : [],
        table: OutboxTable,
      },
    })
    return { Ledgers, ReadTable, projection, row }
  }
  return {
    Accounts,
    EventsTable,
    OutboxTable,
    A: side(["shop"], (idA) => ({ idA, shop: "north#branch_b1", branch: "b1" })),
    B: side(["shop", "branch"], (idA) => ({ idA, shop: "north", branch: "b1" })),
  }
}

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

/** The client, recording the tables each `GetItem` names. */
const recording = () => {
  const gets: Array<string> = []
  const layer = Layer.effect(
    DynamoClient,
    Effect.map(Effect.service(DynamoClient), (inner) => ({
      ...inner,
      getItem: (input: Parameters<typeof inner.getItem>[0]) => {
        gets.push(String(input.TableName))
        return inner.getItem(input)
      },
    })),
  ).pipe(Layer.provide(ClientLayer))
  return { gets, layer }
}

let made = 0

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

const keyOf = (item: Item) => `${item.pk?.S}|${item.sk?.S}`

/** One run, or a run resumed from its token until done, its counts added up. */
const fullRun = (
  rekey: (options: Record<string, unknown>) => Effect.Effect<Table.RekeyReport, unknown>,
  options: Record<string, unknown>,
  sliced: boolean,
) =>
  Effect.gen(function* () {
    const moved = { ...ZERO }
    let unchanged = 0
    let slices = 0
    const conflicts: Array<Table.RekeyConflict> = []
    const ambiguous: Array<Table.RekeyAmbiguity> = []
    let resume: string | undefined
    do {
      const report = yield* rekey({
        ...options,
        ...(sliced && { pageSize: 2, maxPages: 1 }),
        ...(resume !== undefined && { resume }),
      })
      slices++
      for (const kind of Object.keys(ZERO) as Array<keyof typeof ZERO>) {
        moved[kind] += report.moved[kind]
      }
      unchanged += report.unchanged
      conflicts.push(...report.conflicts)
      ambiguous.push(...report.ambiguous)
      expect(report.skipped.ambiguousOwner).toBe(report.ambiguous.length)
      resume = Option.getOrUndefined(report.resume)
    } while (resume !== undefined)
    return { moved, unchanged, conflicts, ambiguous, slices }
  })

describeConnected.each(["1.39.0", "1.40.0"])(
  "rekey of a shared outbox table, items %s wrote",
  (version) => {
    const fixture = captured(version)

    it.effect.each([
      ["escapeKeys off, to on", false],
      ["escapeKeys on, to off", true],
    ] as const)(
      "%s: each item moves by its own read model, or is left and reported",
      ([, from]) => {
        const written = fixture.runs[from ? "escapeKeys on" : "escapeKeys off"]
        const now = world(!from)
        const stamp = `${Date.now()}-${made++}`
        const names = {
          events: `own-e-${stamp}`,
          ra: `own-ra-${stamp}`,
          rb: `own-rb-${stamp}`,
          o: `own-o-${stamp}`,
        }
        const client = recording()
        return Effect.gen(function* () {
          const ddb = yield* DynamoClient
          for (const name of Object.values(names)) {
            yield* ddb.createTable({
              TableName: name,
              BillingMode: "PAY_PER_REQUEST",
              AttributeDefinitions: [
                { AttributeName: "pk", AttributeType: "S" },
                { AttributeName: "sk", AttributeType: "S" },
              ],
              KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "sk", KeyType: "RANGE" },
              ],
            })
          }
          const scan = (name: string) =>
            Effect.map(ddb.scan({ TableName: name, ConsistentRead: true }), (page) =>
              (page.Items ?? []).map(keyOf).sort(),
            )
          for (const [table, items] of [
            [names.ra, written.ra],
            [names.rb, written.rb],
            [names.o, written.o],
          ] as const) {
            for (const item of items) yield* ddb.putItem({ TableName: table, Item: item })
          }
          // The projections are defined (in `world`), so the client finds their outbox on `O`.
          const db = (yield* DynamoClient.make({
            entities: { A: now.A.Ledgers, B: now.B.Ledgers },
            tables: { RA: now.A.ReadTable, RB: now.B.ReadTable, O: now.OutboxTable },
          })) as any
          const rekeyOf = (table: "RA" | "RB" | "O") => (options: Record<string, unknown>) =>
            db.tables[table].rekey({ streams: [now.Accounts], ...options }) as Effect.Effect<
              Table.RekeyReport,
              unknown
            >
          const item = (idA: string, shop: string) =>
            `$amb#v1#ledger#ida_${idA}|$amb#v1#ledger#shop_${shop}#outbox#000000000001#0000`
          const before = yield* scan(names.o)
          const rowRead = () =>
            client.gets
              .splice(0)
              .filter((name) => name !== names.o)
              .sort()

          if (!from) {
            // Unescaped: each item is at a key both write, and they'd move it apart. The rows settle
            // `a1` (A's) and `b1` (B's); `both` has a row of each, `gone` none, `tomb` a tombstone.
            expect(before).toEqual(
              ["a1", "b1", "both", "gone", "tomb"].map((id) => item(id, "north#branch_b1")),
            )
            const reasons = (run: { readonly ambiguous: ReadonlyArray<Table.RekeyAmbiguity> }) =>
              run.ambiguous
                .map((a) => `${String(a.key.pk).slice("$amb#v1#ledger#ida_".length)}:${a.reason}`)
                .sort()
            const dry = yield* fullRun(rekeyOf("O"), { dryRun: true }, false)
            expect(dry.moved).toEqual({ ...ZERO, outbox: 1 })
            expect(dry.unchanged).toBe(1)
            expect(dry.conflicts).toEqual([])
            expect(reasons(dry)).toEqual(["both:unsettled", "gone:rowGone", "tomb:unsettled"])
            expect(yield* scan(names.o)).toEqual(before)
            // Each read model's row, where it is and where that read model would move it.
            expect(rowRead()).toEqual(
              [
                ...Array(5).fill(names.ra),
                ...Array(5).fill(names.ra),
                ...Array(5).fill(names.rb),
              ].sort(),
            )
            // Sliced, resumed from its token.
            const real = yield* fullRun(rekeyOf("O"), {}, true)
            expect(real.slices).toBeGreaterThan(1)
            expect(real.moved).toEqual({ ...ZERO, outbox: 1 })
            expect(real.conflicts).toEqual([])
            expect(reasons(real)).toEqual(["both:unsettled", "gone:rowGone", "tomb:unsettled"])
            const after = yield* scan(names.o)
            expect(after).toEqual(
              [
                item("a1", "north%23branch_b1"),
                ...["b1", "both", "gone", "tomb"].map((id) => item(id, "north#branch_b1")),
              ].sort(),
            )
            // The read models' tables next: A's rows and tombstone move where A reads them now.
            const ra = yield* fullRun(rekeyOf("RA"), {}, false)
            expect(ra.moved).toEqual({ ...ZERO, item: 2, tombstone: 1 })
            expect((yield* fullRun(rekeyOf("RB"), {}, false)).moved).toEqual(ZERO)
            // A second run changes nothing: what it left, it leaves, for the same reasons.
            client.gets.splice(0)
            const again = yield* fullRun(rekeyOf("O"), {}, false)
            expect(again.moved).toEqual(ZERO)
            expect(reasons(again)).toEqual(["both:unsettled", "gone:rowGone", "tomb:unsettled"])
            expect(yield* scan(names.o)).toEqual(after)
          } else {
            // Escaped, A's items are no key B writes, and B's are no text A's reader reads: no row is
            // read. A's `both` would move onto B's: the key is taken, and it's left and reported.
            expect(before).toEqual(
              [
                ...["a1", "both", "gone", "tomb"].map((id) => item(id, "north%23branch_b1")),
                ...["b1", "both"].map((id) => item(id, "north#branch_b1")),
              ].sort(),
            )
            const dry = yield* fullRun(rekeyOf("O"), { dryRun: true }, false)
            expect(dry.moved).toEqual({ ...ZERO, outbox: 3 })
            expect(dry.unchanged).toBe(2)
            expect(dry.ambiguous).toEqual([])
            expect(dry.conflicts.map((c) => [c.reason, c.key.pk])).toEqual([
              ["taken", "$amb#v1#ledger#ida_both"],
            ])
            expect(yield* scan(names.o)).toEqual(before)
            expect(rowRead()).toEqual([])
            const real = yield* fullRun(rekeyOf("O"), {}, true)
            expect(real.slices).toBeGreaterThan(1)
            expect(real.moved).toEqual({ ...ZERO, outbox: 3 })
            expect(real.ambiguous).toEqual([])
            expect(real.conflicts.map((c) => [c.reason, c.key.pk])).toEqual([
              ["taken", "$amb#v1#ledger#ida_both"],
            ])
            expect(rowRead()).toEqual([])
            const after = yield* scan(names.o)
            expect(after).toEqual(
              [
                item("both", "north%23branch_b1"),
                ...["a1", "b1", "both", "gone", "tomb"].map((id) => item(id, "north#branch_b1")),
              ].sort(),
            )
            const again = yield* fullRun(rekeyOf("O"), {}, false)
            expect(again.moved).toEqual(ZERO)
            expect(again.ambiguous).toEqual([])
            expect(again.conflicts.map((c) => c.reason)).toEqual(["taken"])
            expect(yield* scan(names.o)).toEqual(after)
          }
          // Each read model's drainer finds its own item where rekey put it.
          for (const [side, id] of [
            ["A", "a1"],
            ["B", "b1"],
          ] as const) {
            const delivered: Array<number> = []
            yield* now[side].projection.drain(now[side].row(id) as Ledger, (effect) =>
              Effect.sync(() => void delivered.push(effect.total)),
            )
            expect(delivered).toEqual([2])
          }
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const ddb = yield* DynamoClient
              for (const name of Object.values(names)) {
                yield* ddb.deleteTable({ TableName: name }).pipe(Effect.ignore)
              }
            }),
          ),
          Effect.provide(
            Layer.mergeAll(
              client.layer,
              now.EventsTable.layer({ name: names.events }),
              now.A.ReadTable.layer({ name: names.ra }),
              now.B.ReadTable.layer({ name: names.rb }),
              now.OutboxTable.layer({ name: names.o }),
            ),
          ),
        ) as Effect.Effect<void, unknown>
      },
    )
  },
)
