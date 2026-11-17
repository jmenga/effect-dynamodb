/**
 * Per-value shard layouts (#287) — connected tests against DynamoDB Local.
 *
 * - A declared table: a hot value (spelled two ways) over its shards, a cold value in the
 *   unsharded partition with one plain request, each read back whole.
 * - A table supplied by a `ShardLayouts` layer: bound and unbound writes, and `EDD-9181`
 *   with nothing written when no layer supplies it.
 * - Bound builders in a transaction run where no layer is: they compose with their binding's.
 * - Moving one value 1 → { 4, previous: 1 } → 4 → { 1, previous: 4 } → 1 with `rekey`:
 *   every row read at every step, the dry run counting what is left, cursors of the moved
 *   value refused across a step and the other value's kept.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as ShardLayouts from "@effect-dynamodb/schema/ShardLayouts.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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

const schema = DynamoSchema.make({ name: "layouts", version: 1 })

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  tenantId: Schema.String,
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["channel"] },
  sk: { field: "sk", composite: ["deviceId"] },
} as const
const byTenant = {
  name: "gsi1",
  pk: { field: "gsi1pk", composite: ["tenantId"] },
  sk: { field: "gsi1sk", composite: ["deviceId"] },
} as const

const Declared = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey,
  indexes: {
    byTenant: {
      ...byTenant,
      shards: { layouts: { default: 1, values: [{ match: { tenantId: "t-big" }, layout: 8 }] } },
    },
  },
})
const Provided = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey,
  indexes: { byTenant: { ...byTenant, shards: { layouts: "provided" } } },
})
const DeclaredTable = Table.make({ schema, entities: { Devices: Declared } })
const ProvidedTable = Table.make({ schema, entities: { Devices: Provided } })

const devices = (tenantId: string, prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    channel: `channel-${i % 3}`,
    deviceId: `${prefix}-${String(i).padStart(3, "0")}`,
    tenantId,
  }))
const big = devices("t-big", "b", 30).map((d, i) => (i % 2 === 0 ? { ...d, tenantId: "T-BIG" } : d))
const mid = devices("t-mid", "m", 25)
const ids = (rows: ReadonlyArray<{ readonly deviceId: string }>) =>
  rows.map((row) => row.deviceId).sort()

let tables = 0

/** Run `body` over a fresh table, deleted afterwards. */
const withTable = <A, E>(body: (tableName: string) => Effect.Effect<A, E, any>) => {
  const tableName = `layouts-${Date.now()}-${tables++}`
  const create = Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.createTable({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      ...Table.definition(DeclaredTable),
    })
  })
  const drop = Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.deleteTable({ TableName: tableName })
  }).pipe(Effect.ignore)
  return Effect.acquireUseRelease(
    create,
    () => body(tableName),
    () => drop,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        ClientLayer,
        DeclaredTable.layer({ name: tableName }),
        ProvidedTable.layer({ name: tableName }),
      ),
    ),
  ) as Effect.Effect<A, E>
}

/** Every stored index partition key, by device id. */
const storedPks = (tableName: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Items } = yield* client.scan({ TableName: tableName })
    return new Map((Items ?? []).map((item) => [item.deviceId?.S ?? "", item.gsi1pk?.S ?? ""]))
  })

const layoutsOf = (table: ShardLayouts.TypedTable<"tenantId">) =>
  ShardLayouts.layer([ShardLayouts.of(Provided, { byTenant: table })])
const bindWith = (table: ShardLayouts.TypedTable<"tenantId">) =>
  DynamoClient.make({ entities: { Devices: Provided }, tables: { MainTable: ProvidedTable } }).pipe(
    Effect.provide(layoutsOf(table)),
  )
const hot = { match: { tenantId: "t-big" }, layout: 8 } as const

describeConnected("per-value shard layouts (#287)", () => {
  it.effect("a declared table: the hot value over its shards, a cold one unsharded", () =>
    withTable((tableName) =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Devices: Declared },
          tables: { MainTable: DeclaredTable },
        })
        yield* Batch.write([...big, ...mid].map((device) => Declared.put(device)))

        const pks = yield* storedPks(tableName)
        for (const device of big)
          expect(pks.get(device.deviceId)).toMatch(/#!8\.\d#tenantid_t-big$/)
        for (const device of mid)
          expect(pks.get(device.deviceId)).toMatch(/#device#tenantid_t-mid$/)

        expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-big" }).collect())).toEqual(
          ids(big),
        )
        expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "T-BIG" }).collect())).toEqual(
          ids(big),
        )
        let requests = 0
        const cold = yield* db.entities.Devices.byTenant({ tenantId: "t-mid" })
          .onRequest(() =>
            Effect.sync(() => {
              requests += 1
            }),
          )
          .collect()
        expect(ids(cold)).toEqual(ids(mid))
        expect(requests).toBe(1)
      }),
    ),
  )

  it.effect("a table from a layer: bound and unbound writes, and EDD-9181 without one", () =>
    withTable((tableName) =>
      Effect.gen(function* () {
        const table = { default: 1, values: [hot] }
        const missing = yield* Effect.exit(
          DynamoClient.make({
            entities: { Devices: Provided },
            tables: { MainTable: ProvidedTable },
          }),
        )
        expect(String(missing)).toContain("[EDD-9181]")
        const unbound = yield* Effect.exit(Batch.write([Provided.put(big[0]!)]))
        expect(String(unbound)).toContain("[EDD-9181]")
        expect((yield* storedPks(tableName)).size).toBe(0)

        const db = yield* bindWith(table)
        yield* db.entities.Devices.put(big[0]!)
        yield* Effect.gen(function* () {
          yield* Batch.write(big.slice(1, 10).map((device) => Provided.put(device)))
          yield* Transaction.transactWrite(big.slice(10).map((device) => Provided.put(device)))
          yield* Batch.write(mid.map((device) => Provided.put(device)))
        }).pipe(Effect.provide(layoutsOf(table)))

        const pks = yield* storedPks(tableName)
        for (const device of big)
          expect(pks.get(device.deviceId)).toMatch(/#!8\.\d#tenantid_t-big$/)
        for (const device of mid)
          expect(pks.get(device.deviceId)).toMatch(/#device#tenantid_t-mid$/)
        expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-big" }).collect())).toEqual(
          ids(big),
        )
      }),
    ),
  )

  it.effect("bound builders in a transaction run where no layer is: the binding's table", () =>
    withTable((tableName) =>
      Effect.gen(function* () {
        const db = yield* bindWith({ default: 1, values: [hot] })
        yield* db.entities.Devices.put(mid[0]!)
        // This fiber has no ShardLayouts: each builder composes with its binding's table, the
        // update's operands before the transaction reads included.
        yield* Transaction.transactWrite([
          db.entities.Devices.put(big[0]!),
          db.entities.Devices.create(big[1]!),
          db.entities.Devices.update({ channel: mid[0]!.channel, deviceId: mid[0]!.deviceId }).set({
            tenantId: "T-BIG",
          }),
        ])
        const pks = yield* storedPks(tableName)
        for (const device of [big[0]!, big[1]!, mid[0]!])
          expect(pks.get(device.deviceId)).toMatch(/#!8\.\d#tenantid_t-big$/)
        yield* Transaction.transactWrite([
          db.entities.Devices.delete({ channel: big[0]!.channel, deviceId: big[0]!.deviceId }),
        ])
        expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-big" }).collect())).toEqual(
          ids([big[1]!, mid[0]!]),
        )
      }),
    ),
  )

  it.effect("moving one value 1 → 4 → 1: reads stay whole, cursors refused only for it", () =>
    withTable((tableName) =>
      Effect.gen(function* () {
        const steps = [1, { count: 4, previous: 1 }, 4, { count: 1, previous: 4 }, 1] as const
        const tableAt = (layout: (typeof steps)[number]) => ({
          default: 1,
          values: [hot, { match: { tenantId: "t-mid" }, layout }],
        })
        const first = yield* bindWith(tableAt(1))
        yield* Batch.write([...big, ...mid].map((device) => Provided.put(device))).pipe(
          Effect.provide(layoutsOf(tableAt(1))),
        )

        let midCursor = Option.none<string>()
        let bigCursor = Option.none<string>()
        const page = (db: typeof first, tenantId: string) =>
          db.entities.Devices.byTenant({ tenantId }).limit(5).fetch()
        midCursor = (yield* page(first, "t-mid")).cursor
        bigCursor = (yield* page(first, "t-big")).cursor

        for (const [i, layout] of steps.entries()) {
          if (i === 0) continue
          const db = yield* bindWith(tableAt(layout))
          // The moved value's cursor from the step before is refused; the other value's kept.
          const refused = yield* db.entities.Devices.byTenant({ tenantId: "t-mid" })
            .limit(5)
            .startFrom(Option.getOrThrow(midCursor))
            .fetch()
            .pipe(Effect.flip)
          expect(`${(refused as { readonly cause?: unknown }).cause}`).toContain("EDD-9094")
          const kept = yield* db.entities.Devices.byTenant({ tenantId: "t-big" })
            .limit(5)
            .startFrom(Option.getOrThrow(bigCursor))
            .fetch()
          expect(kept.items).toHaveLength(5)

          // Every row is read, whatever is left to move.
          expect(ids(yield* db.entities.Devices.byTenant({ tenantId: "t-mid" }).collect())).toEqual(
            ids(mid),
          )
          if (typeof layout === "object") {
            const pending = yield* db.tables.MainTable.rekey({ dryRun: true })
            expect(pending.indexKeysRewritten).toBe(mid.length)
            yield* db.tables.MainTable.rekey()
            const settled = yield* db.tables.MainTable.rekey({ dryRun: true })
            expect(settled.indexKeysRewritten).toBe(0)
            expect(settled.conflicts).toEqual([])
          }
          const pks = yield* storedPks(tableName)
          const count = typeof layout === "object" ? layout.count : layout
          for (const device of mid) {
            expect(pks.get(device.deviceId)).toMatch(
              count === 1 ? /#device#tenantid_t-mid$/ : /#!4\.\d#tenantid_t-mid$/,
            )
          }
          for (const device of big)
            expect(pks.get(device.deviceId)).toMatch(/#!8\.\d#tenantid_t-big$/)
          midCursor = (yield* page(db, "t-mid")).cursor
        }
      }),
    ),
  )
})
