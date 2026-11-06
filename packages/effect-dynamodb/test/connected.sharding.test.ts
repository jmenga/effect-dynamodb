/**
 * GSI write sharding (#183) — connected tests against DynamoDB Local.
 *
 * - Thousands of items in one logical partition over 16 shards: `collect`, `fetch`
 *   chains and `count` equal a brute-force sorted scan, forward and reverse.
 * - Adopting sharding on a populated unsharded index: through the transition every
 *   item is returned exactly once, and after `rekey` no stored key is unsharded.
 * - The canonical GSI-composite shapes (CLAUDE.md), the Z-order shapes and the new
 *   degenerate fixtures, on real writes and real index queries.
 *
 * DynamoDB Local shows that the keys, the merge and the cursors are right. It can't
 * show throughput: the issue's check on AWS isn't part of this suite.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { shardOf } from "@effect-dynamodb/schema/internal/Shards.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Config, DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { compareUtf8 } from "../src/internal/RangePlanner.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import * as RekeyComparison from "./helpers/RekeyComparison.js"
import * as SharedKeys from "./helpers/SharedKeyAttributes.js"
import * as TableKeyHalves from "./helpers/TableKeyHalves.js"

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

const schema = DynamoSchema.make({ name: "sharding", version: 1 })

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

let tables = 0

/** Run `body` over a fresh table of `member`'s definition, deleted afterwards. */
const withTable = <A, E>(
  definition: any,
  body: (tableName: string) => Effect.Effect<A, E, any>,
  provide: (tableName: string) => Layer.Layer<any>,
) => {
  const tableName = `sharding-${Date.now()}-${tables++}`
  const create = Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.createTable({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      ...Table.definition(definition),
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
    Effect.scoped,
    Effect.provide(Layer.mergeAll(ClientLayer, provide(tableName))),
  ) as Effect.Effect<A, E>
}

/** Every stored row of a table. */
const scanAll = (tableName: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const rows: Array<Record<string, AttributeValue>> = []
    let start: Record<string, AttributeValue> | undefined
    do {
      const page = yield* client.scan({
        TableName: tableName,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })
      rows.push(...((page.Items ?? []) as Array<Record<string, AttributeValue>>))
      start = page.LastEvaluatedKey as Record<string, AttributeValue> | undefined
    } while (start !== undefined)
    return rows
  })

class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  tenantId: Schema.String,
  groupId: Schema.String,
  status: Schema.String,
  reading: Schema.Number,
}) {}

const declared = (shards?: number | Record<string, unknown>) => {
  const Devices = Entity.make({
    model: Device,
    entityType: "Device",
    primaryKey: {
      pk: { field: "pk", composite: ["channel"] },
      sk: { field: "sk", composite: ["deviceId"] },
    },
    indexes: {
      byTenant: {
        name: "gsi5",
        pk: { field: "gsi5pk", composite: ["tenantId"] },
        sk: { field: "gsi5sk", composite: ["groupId", "deviceId"] },
        ...(shards === undefined ? {} : { shards }),
      },
    },
  } as any) as any
  return { Devices, MainTable: Table.make({ schema, entities: { Devices } }) }
}
type Deployment = ReturnType<typeof declared>

const clientOf = (deployment: Deployment) =>
  DynamoClient.make({
    entities: { Devices: deployment.Devices },
    tables: { MainTable: deployment.MainTable },
  }) as unknown as Effect.Effect<any, never, any>

const makeItems = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    channel: `channel-${i % 7}`,
    deviceId: `device-${String(i).padStart(5, "0")}`,
    tenantId: "t-123",
    groupId: `group-${i % 5}`,
    status: i % 3 === 0 ? "on" : "off",
    reading: i % 100,
  }))

/** Write items in batches through the entity's own write path. */
const writeAll = (
  deployment: Deployment,
  items: ReadonlyArray<ReturnType<typeof makeItems>[number]>,
) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(items.length / 25) }, (_, n) =>
      items.slice(n * 25, (n + 1) * 25),
    ),
    (chunk) => Batch.write(chunk.map((item) => deployment.Devices.put(item))),
    { concurrency: 8, discard: true },
  )

const ids = (rows: ReadonlyArray<{ readonly deviceId: string }>) => rows.map((row) => row.deviceId)

const SHARDS = 16
const THOUSANDS = 3000

describeConnected("#183 sharded index — thousands of items over 16 shards", () => {
  const deployment = declared(SHARDS)
  const provide = (name: string) => deployment.MainTable.layer({ name })
  const items = makeItems(THOUSANDS)

  it.live(
    "collect, fetch chains and count equal a brute-force sorted scan",
    () =>
      withTable(
        deployment.MainTable,
        (tableName) =>
          Effect.gen(function* () {
            yield* writeAll(deployment, items)
            const db = yield* clientOf(deployment)
            const devices = db.entities.Devices

            // Brute force, from a scan of the base table.
            const rows = yield* scanAll(tableName)
            expect(rows).toHaveLength(THOUSANDS)
            const partitions = new Set(rows.map((row) => row.gsi5pk!.S!))
            expect(partitions.size).toBe(SHARDS)
            for (const pk of partitions) expect(pk).toMatch(/#!16\.\d\d#tenantid_t-123$/)
            const expected = rows
              .map((row) => fromAttributeMap(row) as Record<string, string>)
              .sort((a, b) => compareUtf8(a.gsi5sk!, b.gsi5sk!))
              .map((row) => row.deviceId!)
            const reversed = [...expected].reverse()

            const query = () => devices.byTenant({ tenantId: "t-123" })
            expect(ids(yield* query().collect())).toEqual(expected)
            expect(ids(yield* query().reverse().collect())).toEqual(reversed)
            expect(yield* query().count()).toBe(THOUSANDS)
            const streamed = yield* Stream.runCollect(query().paginate())
            expect(ids(Array.from(streamed as Iterable<Device>))).toEqual(expected)

            // Chains whose limit lands anywhere, forward and reverse.
            for (const [reverse, want] of [
              [false, expected],
              [true, reversed],
            ] as const) {
              const chained: Array<string> = []
              let cursor: Option.Option<string> = Option.none()
              let n = 0
              do {
                const limit = 1 + ((n * 37 + 11) % 149)
                const base = reverse ? query().reverse() : query()
                const q = base.limit(limit)
                const page: Query.Page<Device> = yield* Option.isSome(cursor)
                  ? q.startFrom(cursor.value).fetch()
                  : q.fetch()
                chained.push(...ids(page.items))
                cursor = page.cursor
                n++
              } while (Option.isSome(cursor))
              expect(chained).toEqual(want)
            }

            // A filter, and a projection the merge has to borrow around.
            const on = rows
              .map((row) => fromAttributeMap(row) as Record<string, string>)
              .filter((row) => row.status === "on")
              .sort((a, b) => compareUtf8(a.gsi5sk!, b.gsi5sk!))
            expect(ids(yield* query().filter({ status: "on" }).collect())).toEqual(
              on.map((row) => row.deviceId!),
            )
            expect(yield* query().filter({ status: "on" }).count()).toBe(on.length)
            const selected: ReadonlyArray<Record<string, unknown>> = yield* query()
              .select(["deviceId"])
              .limit(5)
              .fetch()
              .pipe(Effect.map((page: any) => page.items))
            expect(selected).toEqual(expected.slice(0, 5).map((deviceId) => ({ deviceId })))
          }),
        provide,
      ),
    120_000,
  )
})

describeConnected("#183 equal sort keys on a real table", () => {
  const Devices = Entity.make({
    model: Device,
    entityType: "Device",
    primaryKey: {
      pk: { field: "pk", composite: ["channel"] },
      sk: { field: "sk", composite: ["deviceId"] },
    },
    indexes: {
      byTenant: {
        name: "gsi5",
        pk: { field: "gsi5pk", composite: ["tenantId"] },
        sk: { field: "gsi5sk", composite: ["groupId"] },
        shards: 8,
      },
    },
  } as any) as any
  const deployment = { Devices, MainTable: Table.make({ schema, entities: { Devices } }) }
  const items = makeItems(200)

  // The order of equal sort keys within one partition is DynamoDB's: only the order
  // of sort keys and of partitions is asserted, and every row exactly once.
  it.live("order by sort key, then partition, and reverse by partition", () =>
    withTable(
      deployment.MainTable,
      (tableName) =>
        Effect.gen(function* () {
          yield* writeAll(deployment, items)
          const rows = yield* scanAll(tableName)
          const shardOfRow = new Map(
            rows.map((row) => [row.deviceId!.S!, Number(/#!8\.(\d)#/.exec(row.gsi5pk!.S!)![1])]),
          )
          const positions = (found: ReadonlyArray<Device>) =>
            found.map((row) => ({ group: row.groupId, shard: shardOfRow.get(row.deviceId)! }))
          const inOrder = (found: ReadonlyArray<Device>, reverse: boolean) =>
            positions(found).sort((a, b) => {
              const order = compareUtf8(a.group, b.group) || a.shard - b.shard
              return reverse ? -order : order
            })
          const everyId = ids(items).sort()
          const db = yield* clientOf(deployment)
          const query = () => db.entities.Devices.byTenant({ tenantId: "t-123" })

          const forward: ReadonlyArray<Device> = yield* query().collect()
          expect(positions(forward)).toEqual(inOrder(forward, false))
          expect(ids(forward).sort()).toEqual(everyId)

          const backward: ReadonlyArray<Device> = yield* query().reverse().collect()
          expect(positions(backward)).toEqual(inOrder(backward, true))
          expect(ids(backward).sort()).toEqual(everyId)

          for (const reverse of [false, true]) {
            const chained: Array<Device> = []
            let cursor: Option.Option<string> = Option.none()
            do {
              const base = (reverse ? query().reverse() : query()).limit(7)
              const page: Query.Page<Device> = yield* Option.isSome(cursor)
                ? base.startFrom(cursor.value).fetch()
                : base.fetch()
              chained.push(...page.items)
              cursor = page.cursor
            } while (Option.isSome(cursor))
            expect(positions(chained)).toEqual(inOrder(chained, reverse))
            expect(ids(chained).sort()).toEqual(everyId)
          }
        }),
      (name) => deployment.MainTable.layer({ name }),
    ),
  )
})

describeConnected("#183 pruning on a real table", () => {
  const deployment = declared({ count: SHARDS, by: ["groupId"] })
  const provide = (name: string) => deployment.MainTable.layer({ name })
  const items = makeItems(300)

  it.live(
    "one shard; a pin in another case finds the same rows; a `by` update moves the entry",
    () =>
      withTable(
        deployment.MainTable,
        () =>
          Effect.gen(function* () {
            yield* writeAll(deployment, items)
            const db = yield* clientOf(deployment)
            const devices = db.entities.Devices
            const inGroup = items
              .filter((item) => item.groupId === "group-1")
              .map((i) => i.deviceId)
            const requests: Array<unknown> = []
            const found = yield* devices
              .byTenant({ tenantId: "t-123", groupId: "group-1" })
              .onRequest((event: unknown) => Effect.sync(() => requests.push(event)))
              .collect()
            expect(ids(found).sort()).toEqual([...inGroup].sort())
            expect(requests).toHaveLength(1)

            const upper = yield* devices
              .byTenant({ tenantId: "t-123", groupId: "GROUP-1" })
              .collect()
            expect(ids(upper)).toEqual(ids(found))

            const device = items.find((item) => item.groupId === "group-1")!
            const key = { channel: device.channel, deviceId: device.deviceId }
            yield* devices.update(key).set({ tenantId: "t-123", groupId: "group-2" }).asEffect()
            const left = yield* devices
              .byTenant({ tenantId: "t-123", groupId: "group-1" })
              .collect()
            expect(ids(left)).not.toContain(device.deviceId)
            const arrived = yield* devices
              .byTenant({ tenantId: "t-123", groupId: "group-2" })
              .collect()
            expect(ids(arrived)).toContain(device.deviceId)

            // A `by`-only update can't name the new shard: nothing is written.
            const other = items.find((item) => item.groupId === "group-3")!
            const error: any = yield* devices
              .update({ channel: other.channel, deviceId: other.deviceId })
              .set({ groupId: "group-4" })
              .asEffect()
              .pipe(Effect.flip)
            expect(String(error.cause)).toContain("[EDD-9100]")
            const still = yield* devices
              .byTenant({ tenantId: "t-123", groupId: "group-3" })
              .collect()
            expect(ids(still)).toContain(other.deviceId)
          }),
        provide,
      ),
    60_000,
  )
})

describeConnected("#183 adopting sharding on a populated unsharded index", () => {
  const before = declared()
  const during = declared({ count: SHARDS, previous: 1 })
  const after = declared(SHARDS)
  // Every deployment declares the same keys, so one definition creates the table.
  const items = makeItems(800)
  const provide = (name: string) =>
    Layer.mergeAll(
      before.MainTable.layer({ name }),
      during.MainTable.layer({ name }),
      after.MainTable.layer({ name }),
    )

  it.live(
    "every item is returned exactly once at each step, and no stored key stays unsharded",
    () =>
      withTable(
        before.MainTable,
        (tableName) =>
          Effect.gen(function* () {
            yield* writeAll(before, items)
            const everyone = ids(items).sort()

            const read = (deployment: Deployment) =>
              Effect.flatMap(clientOf(deployment), (db: any) =>
                db.entities.Devices.byTenant({ tenantId: "t-123" }).collect(),
              ) as Effect.Effect<ReadonlyArray<Device>>
            const sortedIds = (rows: ReadonlyArray<Device>) => ids(rows).sort()

            expect(sortedIds(yield* read(before))).toEqual(everyone)

            // Step 1: writes go sharded, reads see both layouts.
            expect(sortedIds(yield* read(during))).toEqual(everyone)
            yield* writeAll(during, items.slice(0, 100))
            expect(sortedIds(yield* read(during))).toEqual(everyone)

            // A fetch chain across both layouts.
            const db = yield* clientOf(during)
            const chained: Array<string> = []
            let cursor: Option.Option<string> = Option.none()
            do {
              const q = db.entities.Devices.byTenant({ tenantId: "t-123" }).limit(61)
              const page: Query.Page<Device> = yield* Option.isSome(cursor)
                ? q.startFrom(cursor.value).fetch()
                : q.fetch()
              chained.push(...ids(page.items))
              cursor = page.cursor
            } while (Option.isSome(cursor))
            expect([...chained].sort()).toEqual(everyone)
            expect(new Set(chained).size).toBe(everyone.length)

            const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
            expect(dry.indexKeysRewritten).toBe(700)

            // Step 2: `rekey`, in parallel segments, with reads holding throughout.
            const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({ segments: 3 })
            expect(report.indexKeysRewritten).toBe(700)
            expect(report.conflicts).toEqual([])
            expect(sortedIds(yield* read(during))).toEqual(everyone)

            const rows = yield* scanAll(tableName)
            expect(rows).toHaveLength(items.length)
            for (const row of rows) expect(row.gsi5pk?.S).toMatch(/#!16\.\d\d#tenantid_t-123$/)

            const again: Table.RekeyReport = yield* db.tables.MainTable.rekey()
            expect(again.indexKeysRewritten).toBe(0)

            // Step 3: `previous` is gone, and nothing is missing.
            expect(sortedIds(yield* read(after))).toEqual(everyone)
            const afterDb = yield* clientOf(after)
            expect(yield* afterDb.entities.Devices.byTenant({ tenantId: "t-123" }).count()).toBe(
              items.length,
            )
          }),
        provide,
      ),
    120_000,
  )
})

// ---------------------------------------------------------------------------
// The canonical shapes
// ---------------------------------------------------------------------------

class Fleet extends Schema.Class<Fleet>("Fleet")({
  channel: Schema.String,
  deviceId: Schema.String,
  accountId: Schema.optional(Schema.String),
  alertState: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  zone: Schema.optional(Schema.String),
  hubId: Schema.optional(Schema.String),
  deviceBinding: Schema.optional(Schema.String),
  tenantId: Schema.optional(Schema.String),
  groupId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}) {}

const Fleets = Entity.make({
  model: Fleet,
  entityType: "Fleet",
  primaryKey: {
    pk: { field: "pk", composite: ["channel"] },
    sk: { field: "sk", composite: ["deviceId"] },
  },
  indexes: {
    // 1: multi-writer.
    multiWriter: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["accountId"] },
      sk: { field: "gsi1sk", composite: ["alertState", "timestamp"] },
      shards: 8,
    },
    // 2: PK-composites-only.
    byChannel: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["channel"] },
      sk: { field: "gsi2sk", composite: ["deviceId"] },
      shards: 8,
    },
    // 3: hierarchical.
    byPlace: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["region"] },
      sk: { field: "gsi3sk", composite: ["country", "city"] },
      shards: 8,
    },
    // 4: a hole.
    byHub: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["zone", "hubId"] },
      sk: { field: "gsi4sk", composite: ["status"] },
      shards: 8,
    },
    // 5: all composites mutable, with `by`.
    byGroup: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["tenantId"] },
      sk: { field: "gsi5sk", composite: ["groupId", "status"] },
      shards: { count: 8, by: ["groupId"] },
    },
    // 6: an empty sort key half.
    byBinding: {
      name: "gsi6",
      pk: { field: "gsi6pk", composite: ["deviceBinding"] },
      sk: { field: "gsi6sk", composite: [] },
      shards: 8,
    },
    // 9a: an empty partition key half with `by`.
    allGroups: {
      name: "gsi7",
      pk: { field: "gsi7pk", composite: [] },
      sk: { field: "gsi7sk", composite: ["groupId"] },
      shards: { count: 8, by: ["groupId"] },
    },
    // 9b: `by` also in the primary key.
    byZoneDevice: {
      name: "gsi8",
      pk: { field: "gsi8pk", composite: ["zone"] },
      sk: { field: "gsi8sk", composite: ["deviceId"] },
      shards: { count: 8, by: ["deviceId"] },
    },
    // 9c: an empty partition key half with the default source.
    allStatuses: {
      name: "gsi9",
      pk: { field: "gsi9pk", composite: [] },
      sk: { field: "gsi9sk", composite: ["status"] },
      shards: 8,
    },
  },
})

const FleetTable = Table.make({ schema, entities: { Fleets } })

const fleetLayer = (name: string) => FleetTable.layer({ name })
const fleetClient = DynamoClient.make({ entities: { Fleets }, tables: { FleetTable } })
const KEY = { channel: "channel-a", deviceId: "device-1" }

/** A fresh table holding one device, and its client. */
const onFleet = <A, E>(
  body: (fleet: any, tableName: string) => Effect.Effect<A, E, any>,
  initial: Record<string, unknown> = {},
) =>
  withTable(
    FleetTable,
    (tableName) =>
      Effect.gen(function* () {
        const db: any = yield* fleetClient
        yield* db.entities.Fleets.put({ ...KEY, ...initial }).asEffect()
        return yield* body(db.entities.Fleets, tableName)
      }),
    fleetLayer,
  )

const rowOf = (tableName: string) =>
  Effect.map(scanAll(tableName), (rows) => rows.find((row) => row.pk !== undefined)!)

const keyShard = shardOf(["channel-a", "device-1"], 8)

describeConnected("#183 canonical shapes — shape 1, multi-writer", () => {
  it.live("two writers each compose their own half; the entry is found", () =>
    onFleet((fleet) =>
      Effect.gen(function* () {
        yield* fleet.update(KEY).set({ alertState: "ok", timestamp: 5 }).asEffect()
        yield* fleet.update(KEY).set({ accountId: "acct" }).asEffect()
        const found = yield* fleet.multiWriter({ accountId: "acct" }).collect()
        expect(ids(found)).toEqual(["device-1"])
        // The second writer's update didn't disturb the first's half.
        yield* fleet.update(KEY).set({ alertState: "bad", timestamp: 6 }).asEffect()
        const again = yield* fleet.multiWriter({ accountId: "acct" }).collect()
        expect(again[0].alertState).toBe("bad")
      }),
    ),
  )
})

describeConnected("#183 canonical shapes — shape 2, PK-composites-only (#43)", () => {
  it.live("found from every write, including an unrelated update", () =>
    onFleet((fleet, tableName) =>
      Effect.gen(function* () {
        expect(ids(yield* fleet.byChannel({ channel: "channel-a" }).collect())).toEqual([
          "device-1",
        ])
        yield* fleet.update(KEY).set({ status: "on" }).asEffect()
        expect(ids(yield* fleet.byChannel({ channel: "channel-a" }).collect())).toEqual([
          "device-1",
        ])
        const row = yield* rowOf(tableName)
        expect(row.gsi2pk?.S).toContain(`#!8.${keyShard}#channel_channel-a`)
      }),
    ),
  )
})

describeConnected("#183 canonical shapes — shape 3, hierarchical", () => {
  it.live("a truncated key keeps the marker, and is found at its level", () =>
    onFleet(
      (fleet, tableName) =>
        Effect.gen(function* () {
          yield* fleet.update(KEY).set({ region: "r", country: "c" }).remove(["city"]).asEffect()
          const row = yield* rowOf(tableName)
          expect(row.gsi3pk?.S).toContain(`#!8.${keyShard}#region_r`)
          expect(row.gsi3sk?.S).toBe("$sharding#v1#fleet#country_c")
          expect(ids(yield* fleet.byPlace({ region: "r" }).collect())).toEqual(["device-1"])
          expect(ids(yield* fleet.byPlace({ region: "r", country: "c" }).collect())).toEqual([
            "device-1",
          ])
        }),
      { region: "r", country: "c", city: "x" },
    ),
  )
})

describeConnected("#183 canonical shapes — shape 4, a hole", () => {
  it.live("'preserve' leaves the entry, `.remove()` takes it out", () =>
    onFleet(
      (fleet, tableName) =>
        Effect.gen(function* () {
          const before = (yield* rowOf(tableName)).gsi4pk?.S
          expect(before).toContain(`#!8.${keyShard}#zone_z#hubid_h`)
          yield* fleet.update(KEY).set({ hubId: "h2" }).asEffect()
          expect((yield* rowOf(tableName)).gsi4pk?.S).toBe(before)
          yield* fleet.update(KEY).remove(["zone"]).asEffect()
          expect((yield* rowOf(tableName)).gsi4pk).toBeUndefined()
        }),
      { zone: "z", hubId: "h", status: "on" },
    ),
  )
})

describeConnected("#183 canonical shapes — shape 5, all composites mutable", () => {
  it.live("the payload moves the entry between shards", () =>
    onFleet(
      (fleet) =>
        Effect.gen(function* () {
          const under = (groupId: string) =>
            fleet.byGroup({ tenantId: "t", groupId, status: "on" }).collect()
          expect(ids(yield* under("a"))).toEqual(["device-1"])
          yield* fleet.update(KEY).set({ tenantId: "t", groupId: "b", status: "on" }).asEffect()
          expect(ids(yield* under("a"))).toEqual([])
          expect(ids(yield* under("b"))).toEqual(["device-1"])
          expect(ids(yield* fleet.byGroup({ tenantId: "t" }).collect())).toEqual(["device-1"])
        }),
      { tenantId: "t", groupId: "a", status: "on" },
    ),
  )
})

describeConnected("#183 canonical shapes — shape 6, empty sort key half (#46)", () => {
  it.live("found once bound; the constant half always written", () =>
    onFleet((fleet, tableName) =>
      Effect.gen(function* () {
        yield* fleet.update(KEY).set({ deviceBinding: "cloud#dev-1" }).asEffect()
        expect(ids(yield* fleet.byBinding({ deviceBinding: "cloud#dev-1" }).collect())).toEqual([
          "device-1",
        ])
        yield* fleet.update(KEY).set({ status: "on" }).asEffect()
        const row = yield* rowOf(tableName)
        expect(row.gsi6sk?.S).toBe("$sharding#v1#fleet")
        expect(ids(yield* fleet.byBinding({ deviceBinding: "cloud#dev-1" }).collect())).toEqual([
          "device-1",
        ])
      }),
    ),
  )
})

describeConnected("#183 new degenerate fixtures", () => {
  it.live("9a — empty PK half with `by`: found, pruned, moved", () =>
    onFleet(
      (fleet, tableName) =>
        Effect.gen(function* () {
          expect(ids(yield* fleet.allGroups({ groupId: "a" }).collect())).toEqual(["device-1"])
          expect(ids(yield* fleet.allGroups({}).collect())).toEqual(["device-1"])
          yield* fleet.update(KEY).set({ tenantId: "t", groupId: "b", status: "on" }).asEffect()
          const row = yield* rowOf(tableName)
          expect(row.gsi7pk?.S).toBe(`$sharding#v1#fleet#!8.${shardOf(["b"], 8)}`)
          expect(ids(yield* fleet.allGroups({ groupId: "a" }).collect())).toEqual([])
          expect(ids(yield* fleet.allGroups({ groupId: "b" }).collect())).toEqual(["device-1"])
        }),
      { tenantId: "t", groupId: "a", status: "on" },
    ),
  )

  it.live("9b — `by` in the primary key: an unrelated update leaves it; the zone composes", () =>
    onFleet((fleet, tableName) =>
      Effect.gen(function* () {
        yield* fleet.update(KEY).set({ status: "on" }).asEffect()
        expect((yield* rowOf(tableName)).gsi8pk).toBeUndefined()
        yield* fleet.update(KEY).set({ zone: "z" }).asEffect()
        expect(
          ids(yield* fleet.byZoneDevice({ zone: "z", deviceId: "device-1" }).collect()),
        ).toEqual(["device-1"])
      }),
    ),
  )

  it.live("9c — empty PK half with the default source: every item found through all shards", () =>
    withTable(
      FleetTable,
      (tableName) =>
        Effect.gen(function* () {
          const db: any = yield* fleetClient
          const fleet = db.entities.Fleets
          const many = Array.from({ length: 40 }, (_, i) => `device-${i}`)
          yield* Effect.forEach(
            many,
            (deviceId) => fleet.put({ channel: "c", deviceId, status: "on" }).asEffect(),
            { discard: true },
          )
          const rows = yield* scanAll(tableName)
          expect(new Set(rows.map((row) => row.gsi9pk?.S)).size).toBeGreaterThan(1)
          const found = yield* fleet.allStatuses({}).collect()
          expect(ids(found).sort()).toEqual([...many].sort())
        }),
      fleetLayer,
    ),
  )
})

describeConnected("#183 canonical shapes — Z-order sort keys", () => {
  class Listing extends Schema.Class<Listing>("Listing")({
    listingId: Schema.String,
    region: Schema.optional(Schema.String),
    agencyId: Schema.optional(Schema.String),
    price: Schema.optional(Schema.Number),
    bedrooms: Schema.optional(Schema.Number),
  }) {}
  const zorder = [
    { field: "price", min: 0, max: 1000, step: 1 },
    { field: "bedrooms", min: 0, max: 15, step: 1 },
  ] as const
  const Listings = Entity.make({
    model: Listing,
    entityType: "Listing",
    primaryKey: {
      pk: { field: "pk", composite: ["listingId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byFacets: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["region"] },
        sk: { field: "gsi1sk", zorder },
        shards: 4,
      },
    },
  })
  const ZTable = Table.make({ schema, entities: { Listings } })

  it.live("merge binary sort keys in byte order; `.within()` is refused", () =>
    withTable(
      ZTable,
      () =>
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Listings },
            tables: { ZTable },
          })
          const listings = db.entities.Listings
          const made = Array.from({ length: 40 }, (_, i) => ({
            listingId: `l-${i}`,
            region: "r",
            price: (i * 37) % 1000,
            bedrooms: i % 16,
          }))
          yield* Effect.forEach(made, (item) => listings.put(item).asEffect(), { discard: true })
          const found = yield* listings.byFacets({ region: "r" }).collect()
          expect(found.map((row: Listing) => row.listingId).sort()).toEqual(
            made.map((row) => row.listingId).sort(),
          )
          const back = yield* listings.byFacets({ region: "r" }).reverse().collect()
          expect(back.map((row: Listing) => row.listingId)).toEqual(
            found.map((row: Listing) => row.listingId).reverse(),
          )
          expect(() => listings.byFacets({ region: "r" }).within({ price: { gte: 1 } })).toThrow(
            "[EDD-9104]",
          )
        }),
      (name) => ZTable.layer({ name }),
    ),
  )
})

// ---------------------------------------------------------------------------
// A default source prunes when the accessor pins the whole primary key. The sort
// key holds it, so the pins are the values the write hashed, serialized as it did.
// ---------------------------------------------------------------------------

describeConnected("#183 a default source: the whole primary key pinned", () => {
  const COUNT = 20

  const Pinned = Entity.make({
    model: Device,
    entityType: "Device",
    primaryKey: {
      pk: { field: "pk", composite: ["channel"] },
      sk: { field: "sk", composite: ["deviceId"] },
    },
    indexes: {
      byTenant: {
        name: "gsi5",
        pk: { field: "gsi5pk", composite: ["tenantId"] },
        sk: { field: "gsi5sk", composite: ["groupId", "channel", "deviceId"] },
        shards: COUNT,
      },
    },
  })
  const PinnedTable = Table.make({ schema, entities: { Pinned } })

  const onPinned = <A, E>(body: (devices: any, tableName: string) => Effect.Effect<A, E, any>) =>
    withTable(
      PinnedTable,
      (tableName) =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({ entities: { Pinned }, tables: { PinnedTable } })
          const devices: any = db.entities.Pinned
          yield* Effect.forEach(
            Array.from({ length: 200 }, (_, i) => ({
              channel: "channel-a",
              deviceId: `device-${i}`,
              tenantId: "t-123",
              groupId: "group-a",
              status: "on",
              reading: i,
            })),
            (item) => devices.put(item).asEffect(),
            { concurrency: 16, discard: true },
          )
          return yield* body(devices, tableName)
        }),
      (name) => PinnedTable.layer({ name }),
    )

  const fullPin = (deviceId: string) => ({
    tenantId: "t-123",
    groupId: "group-a",
    channel: "channel-a",
    deviceId,
  })

  /** The partition a device was stored on, read back from the table. */
  const storedPartition = (rows: ReadonlyArray<Record<string, AttributeValue>>, deviceId: string) =>
    rows.find((row) => row.deviceId?.S === deviceId)!.gsi5pk!.S!

  it.live("a full pin reads the one shard the row is on, for every row", () =>
    onPinned((devices, tableName) =>
      Effect.gen(function* () {
        const rows = yield* scanAll(tableName)
        expect(new Set(rows.map((row) => row.gsi5pk!.S!)).size).toBeGreaterThan(1)
        for (let i = 0; i < 200; i += 7) {
          const deviceId = `device-${i}`
          const pin = devices.byTenant(fullPin(deviceId))
          const explained: Query.QueryExplain = yield* pin.explain()
          expect(explained.fanOut?.pruned, deviceId).toBe(true)
          expect(explained.fanOut?.partitions, deviceId).toEqual([storedPartition(rows, deviceId)])
          expect(ids(yield* pin.collect()), deviceId).toEqual([deviceId])
        }
      }),
    ),
  )

  it.live("a partial pin fans out, and still finds every row", () =>
    onPinned((devices) =>
      Effect.gen(function* () {
        for (const pins of [
          { tenantId: "t-123" },
          { tenantId: "t-123", groupId: "group-a" },
          { tenantId: "t-123", groupId: "group-a", channel: "channel-a" },
        ]) {
          const query = devices.byTenant(pins)
          const explained: Query.QueryExplain = yield* query.explain()
          expect(explained.fanOut?.pruned).toBe(false)
          expect(explained.fanOut?.partitions).toHaveLength(COUNT)
          expect(yield* query.collect()).toHaveLength(200)
        }
      }),
    ),
  )

  it.live("a pin in another case reaches the stored shard", () =>
    onPinned((devices, tableName) =>
      Effect.gen(function* () {
        const rows = yield* scanAll(tableName)
        const pin = devices.byTenant({
          tenantId: "T-123",
          groupId: "GROUP-A",
          channel: "CHANNEL-A",
          deviceId: "DEVICE-17",
        })
        const explained: Query.QueryExplain = yield* pin.explain()
        expect(explained.fanOut?.partitions).toEqual([storedPartition(rows, "device-17")])
        expect(ids(yield* pin.collect())).toEqual(["device-17"])
      }),
    ),
  )

  it.live("a cursor on a pruned query stays on the shard, and isn't another query's", () =>
    onPinned((devices) =>
      Effect.gen(function* () {
        const pin = devices.byTenant(fullPin("device-17"))
        const page: Query.Page<Device> = yield* pin.limit(1).fetch()
        expect(ids(page.items)).toEqual(["device-17"])
        if (Option.isSome(page.cursor)) {
          const rest: Query.Page<Device> = yield* pin.limit(1).startFrom(page.cursor.value).fetch()
          expect(rest.items).toEqual([])
          expect(rest.cursor).toEqual(Option.none())
        }
        const wide: Query.Page<Device> = yield* devices
          .byTenant({ tenantId: "t-123" })
          .limit(1)
          .fetch()
        const refused = yield* pin
          .startFrom(Option.getOrThrow(wide.cursor))
          .collect()
          .pipe(Effect.flip)
        expect(String(refused.cause ?? refused)).toContain("[EDD-9094]")
      }),
    ),
  )

  it.live("`.where()` doesn't prune: the range is read on every shard", () =>
    onPinned((devices) =>
      Effect.gen(function* () {
        const query = devices
          .byTenant({ tenantId: "t-123", groupId: "group-a", channel: "channel-a" })
          .where((t: any, { eq }: any) => eq(t.deviceId, "device-17"))
        const explained: Query.QueryExplain = yield* query.explain()
        expect(explained.fanOut?.pruned).toBe(false)
        expect(ids(yield* query.collect())).toEqual(["device-17"])
      }),
    ),
  )

  it.live("`previous` isn't pruned: a row not yet moved is found by a full pin", () => {
    const Moving = Entity.make({
      model: Device,
      entityType: "Device",
      primaryKey: {
        pk: { field: "pk", composite: ["channel"] },
        sk: { field: "sk", composite: ["deviceId"] },
      },
      indexes: {
        byTenant: {
          name: "gsi5",
          pk: { field: "gsi5pk", composite: ["tenantId"] },
          sk: { field: "gsi5sk", composite: ["groupId", "channel", "deviceId"] },
          shards: { count: 4, previous: 1 },
        },
      },
    } as any) as any
    const MovingTable = Table.make({ schema, entities: { Moving } })
    return withTable(
      MovingTable,
      (tableName) =>
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Moving },
            tables: { MovingTable },
          } as any)
          const devices = db.entities.Moving
          yield* devices
            .put({
              channel: "channel-a",
              deviceId: "device-17",
              tenantId: "t-123",
              groupId: "group-a",
              status: "on",
              reading: 1,
            })
            .asEffect()
          const pin = devices.byTenant(fullPin("device-17"))
          const explained: Query.QueryExplain = yield* pin.explain()
          // One current shard, and the unsharded layout whole.
          expect(explained.fanOut?.pruned).toBe(true)
          expect(explained.fanOut?.partitions).toHaveLength(2)
          expect(ids(yield* pin.collect())).toEqual(["device-17"])
          // The same row where the unsharded layout left it.
          const [row] = yield* scanAll(tableName)
          const client = yield* DynamoClient
          yield* client.updateItem({
            TableName: tableName,
            Key: { pk: row!.pk!, sk: row!.sk! },
            UpdateExpression: "SET #pk = :pk",
            ExpressionAttributeNames: { "#pk": "gsi5pk" },
            ExpressionAttributeValues: { ":pk": { S: explained.fanOut!.partitions[1]! } },
          })
          expect(ids(yield* pin.collect())).toEqual(["device-17"])
        }),
      (name) => MovingTable.layer({ name }),
    )
  })

  // A write hashes the primary key as `keyForm` serializes it. A number, a date and a
  // transformed value reach the hash the way they do on the accessor.
  class Typed extends Schema.Class<Typed>("Typed")({
    tenantId: Schema.String,
    seq: Schema.Number,
    at: Schema.DateTimeUtc,
    big: Schema.BigInt,
  }) {}

  const Typeds = Entity.make({
    model: Typed,
    entityType: "Typed",
    primaryKey: {
      pk: { field: "pk", composite: ["seq"] },
      sk: { field: "sk", composite: ["at", "big"] },
    },
    indexes: {
      byTenant: {
        name: "gsi5",
        pk: { field: "gsi5pk", composite: ["tenantId"] },
        sk: { field: "gsi5sk", composite: ["seq", "at", "big"] },
        shards: COUNT,
      },
    },
  })
  const TypedTable = Table.make({ schema, entities: { Typeds } })

  it.live("typed composites hash on the accessor as they do on the write", () =>
    withTable(
      TypedTable,
      (tableName) =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({ entities: { Typeds }, tables: { TypedTable } })
          const made = Array.from({ length: 30 }, (_, i) => ({
            tenantId: "t-123",
            seq: i * 1.5 - 7,
            at: DateTime.makeUnsafe(1_780_000_000_000 + i * 86_400_000),
            big: BigInt(i) * 1_000_000_000_000n,
          }))
          for (const item of made) yield* db.entities.Typeds.put(item).asEffect()
          const rows = yield* scanAll(tableName)
          for (const item of made) {
            const stored = rows.find((row) => Number(row.seq?.N) === item.seq)!.gsi5pk!.S!
            const pin = db.entities.Typeds.byTenant(item)
            const explained: Query.QueryExplain = yield* pin.explain()
            expect(explained.fanOut?.partitions, `seq ${item.seq}`).toEqual([stored])
            const found = yield* pin.collect()
            expect(
              found.map((row) => row.seq),
              `seq ${item.seq}`,
            ).toEqual([item.seq])
          }
        }),
      (name) => TypedTable.layer({ name }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Canonical shape 10 on a sharded index: an unrelated update must not move an entry.
// ---------------------------------------------------------------------------

describeConnected("#183 canonical shapes — shape 10, a half mixing key and mutable", () => {
  class Mixed extends Schema.Class<Mixed>("Mixed")({
    channel: Schema.String,
    deviceId: Schema.String,
    zone: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
  }) {}

  const Mixeds = Entity.make({
    model: Mixed,
    entityType: "Mixed",
    primaryKey: {
      pk: { field: "pk", composite: ["channel"] },
      sk: { field: "sk", composite: ["deviceId"] },
    },
    indexes: {
      byZone: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["channel", "zone"] },
        sk: { field: "gsi1sk", composite: ["deviceId"] },
        shards: 8,
      },
    },
  })
  const MixedTable = Table.make({ schema, entities: { Mixeds } })

  const onMixed = <A, E>(
    initial: Record<string, unknown>,
    body: (mixeds: any, tableName: string) => Effect.Effect<A, E, any>,
  ) =>
    withTable(
      MixedTable,
      (tableName) =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({ entities: { Mixeds }, tables: { MixedTable } })
          const mixeds: any = db.entities.Mixeds
          yield* mixeds.put({ ...KEY, ...initial }).asEffect()
          return yield* body(mixeds, tableName)
        }),
      (name) => MixedTable.layer({ name }),
    )

  it.live("an unrelated update leaves the entry on its shard, byte for byte", () =>
    onMixed({ zone: "z" }, (mixeds, tableName) =>
      Effect.gen(function* () {
        const before = (yield* rowOf(tableName)).gsi1pk?.S
        expect(before).toContain(`#!8.${keyShard}#channel_channel-a#zone_z`)
        yield* mixeds.update(KEY).set({ status: "on" }).asEffect()
        expect((yield* rowOf(tableName)).gsi1pk?.S).toBe(before)
        const found = yield* mixeds.byZone({ channel: "channel-a", zone: "z" }).collect()
        expect(ids(found)).toEqual(["device-1"])
      }),
    ),
  )

  it.live("an item lacking the composite joins only when a write names it", () =>
    onMixed({}, (mixeds, tableName) =>
      Effect.gen(function* () {
        yield* mixeds.update(KEY).set({ status: "on" }).asEffect()
        expect((yield* rowOf(tableName)).gsi1pk).toBeUndefined()
        yield* mixeds.update(KEY).set({ zone: "z" }).asEffect()
        expect((yield* rowOf(tableName)).gsi1pk?.S).toContain(
          `#!8.${keyShard}#channel_channel-a#zone_z`,
        )
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Canonical shape 9d: `by` after a sort key composite the update can't supply. The
// shard and the sort key must not disagree, or no pin reaches the row.
// ---------------------------------------------------------------------------

describeConnected("#183 canonical shapes — shape 9d, `by` after a composite", () => {
  class Row extends Schema.Class<Row>("Row")({
    id: Schema.String,
    tenant: Schema.String,
    at: Schema.Number,
    region: Schema.optional(Schema.String),
    group: Schema.optional(Schema.String),
    rank: Schema.optional(Schema.Number),
  }) {}

  const primaryKey = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  } as const
  const byTenant = {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["tenant"] },
    sk: { field: "gsi1sk", composite: ["region", "group"] },
    shards: { count: 8, by: ["group"] },
  } as const

  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey,
    indexes: { byTenant },
  })
  const Sparse = Entity.make({
    model: Row,
    entityType: "Sparse",
    primaryKey,
    indexes: { byTenant: { ...byTenant, indexPolicy: { sk: "sparse" } } },
  })
  const Retained = Entity.make({
    model: Row,
    entityType: "Retained",
    primaryKey,
    indexes: { byTenant },
    versioned: { retain: true },
  })
  const Ranked = Entity.make({
    model: Row,
    entityType: "Ranked",
    primaryKey,
    indexes: {
      byTenant: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["tenant"] },
        sk: { field: "gsi1sk", composite: ["region", "rank"] },
        shards: { count: 8, by: ["rank"] },
      },
    },
  })
  const Series = Entity.make({
    model: Row,
    entityType: "Series",
    primaryKey,
    indexes: { byTenant },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        id: Schema.String,
        tenant: Schema.String,
        at: Schema.Number,
        group: Schema.String,
      }),
    },
  })
  const AgreeTable = Table.make({
    schema,
    entities: { Rows, Sparse, Retained, Ranked, Series },
  })

  const onAgree = <A, E>(body: (db: any, tableName: string) => Effect.Effect<A, E, any>) =>
    withTable(
      AgreeTable,
      (tableName) =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Rows, Sparse, Retained, Ranked, Series },
            tables: { AgreeTable },
          })
          return yield* body(db, tableName)
        }),
      (name) => AgreeTable.layer({ name }),
    )

  const seed = { id: "1", tenant: "t", at: 1, region: "r", group: "a" }
  const pinned = (entity: any, region: string, group: string) =>
    entity.byTenant({ tenant: "t", region, group }).collect()
  const refusal = (write: Effect.Effect<unknown, any, any>) =>
    Effect.map(Effect.flip(write), (error: any) => {
      expect(error._tag).toBe("ValidationError")
      expect(String(error.cause)).toContain("[EDD-9100]")
      expect(String(error.cause)).toContain('"region"')
    })

  it.live("the standard path refuses, and the row stays where its pin finds it", () =>
    onAgree((db, tableName) =>
      Effect.gen(function* () {
        const rows = db.entities.Rows
        yield* rows.put(seed).asEffect()
        const before = yield* scanAll(tableName)
        yield* refusal(rows.update({ id: "1" }).set({ tenant: "t", group: "b" }).asEffect())
        expect(yield* scanAll(tableName)).toEqual(before)
        expect(yield* pinned(rows, "r", "a")).toHaveLength(1)
        expect(yield* pinned(rows, "r", "b")).toHaveLength(0)
      }),
    ),
  )

  it.live("a complete update moves shard and sort key together", () =>
    onAgree((db) =>
      Effect.gen(function* () {
        const rows = db.entities.Rows
        yield* rows.put(seed).asEffect()
        yield* rows.update({ id: "1" }).set({ tenant: "t", region: "r", group: "b" }).asEffect()
        expect(yield* pinned(rows, "r", "b")).toHaveLength(1)
        expect(yield* pinned(rows, "r", "a")).toHaveLength(0)
      }),
    ),
  )

  it.live("under `sparse` the entry leaves the index, and a complete update rejoins", () =>
    onAgree((db) =>
      Effect.gen(function* () {
        const sparse = db.entities.Sparse
        yield* sparse.put(seed).asEffect()
        yield* sparse.update({ id: "1" }).set({ tenant: "t", group: "b" }).asEffect()
        expect(yield* sparse.byTenant({ tenant: "t" }).collect()).toHaveLength(0)
        yield* sparse.update({ id: "1" }).set({ tenant: "t", region: "r", group: "b" }).asEffect()
        expect(yield* pinned(sparse, "r", "b")).toHaveLength(1)
      }),
    ),
  )

  it.live("a transaction refuses the same update", () =>
    onAgree((db, tableName) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put(seed).asEffect()
        const before = yield* scanAll(tableName)
        yield* refusal(
          Transaction.transactWrite([
            Rows.update({ id: "1" }).pipe(Entity.set({ tenant: "t", group: "b" })),
          ]),
        )
        expect(yield* scanAll(tableName)).toEqual(before)
      }),
    ),
  )

  it.live("the retain path holds the whole item, so a `by`-only update composes both", () =>
    onAgree((db) =>
      Effect.gen(function* () {
        const retained = db.entities.Retained
        yield* retained.put(seed).asEffect()
        yield* retained.update({ id: "1" }).set({ group: "b" }).asEffect()
        expect(yield* pinned(retained, "r", "b")).toHaveLength(1)
        expect(yield* pinned(retained, "r", "a")).toHaveLength(0)
      }),
    ),
  )

  it.live("the computed path reads the item, so `.add()` on `by` composes both", () =>
    onAgree((db) =>
      Effect.gen(function* () {
        const ranked = db.entities.Ranked
        yield* ranked.put({ id: "1", tenant: "t", at: 1, region: "r", rank: 1 }).asEffect()
        yield* ranked.update({ id: "1" }).add({ rank: 1 }).asEffect()
        expect(
          yield* ranked.byTenant({ tenant: "t", region: "r", rank: 2 }).collect(),
        ).toHaveLength(1)
        expect(
          yield* ranked.byTenant({ tenant: "t", region: "r", rank: 1 }).collect(),
        ).toHaveLength(0)
      }),
    ),
  )

  it.live("an appendInput carrying `by` without the gap refuses", () =>
    onAgree((db) =>
      Effect.gen(function* () {
        const series = db.entities.Series
        yield* series.put(seed).asEffect()
        yield* refusal(
          series.append({ id: "1", tenant: "t", at: 2, group: "b" }).skipFollowUp().asEffect(),
        )
        expect(yield* pinned(series, "r", "a")).toHaveLength(1)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// A condition that replaces the pins (`Query.where`) drops the pruning they gave.
// ---------------------------------------------------------------------------

describeConnected("#183 a condition that replaces the pins", () => {
  class Row extends Schema.Class<Row>("Row")({
    id: Schema.String,
    tenant: Schema.String,
    region: Schema.String,
    group: Schema.String,
  }) {}
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byTenant: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["tenant"] },
        sk: { field: "gsi1sk", composite: ["region", "group"] },
        shards: { count: 8, by: ["group"] },
      },
    },
  })
  const WhereTable = Table.make({ schema, entities: { Rows } })

  it.live("`Query.where` finds a row in another shard than the pins chose", () =>
    withTable(
      WhereTable,
      () =>
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Rows },
            tables: { WhereTable },
          })
          yield* db.entities.Rows.put({ id: "1", tenant: "t", region: "r", group: "b" }).asEffect()
          const condition = {
            eq: KeyComposer.composeSk(schema, "Row", 1, Rows.indexes.byTenant, {
              region: "r",
              group: "b",
            }),
          }
          const pinned = Rows.query.byTenant({ tenant: "t", region: "r", group: "a" })
          expect(yield* Query.collect(pinned)).toHaveLength(0)
          const found = yield* Query.collect(pinned.pipe(Query.where(condition)))
          expect(found).toHaveLength(1)
        }),
      (name) => WhereTable.layer({ name }),
    ),
  )
})

describeConnected("#183 what `rekey` compares, on real writes", () => {
  const harness: RekeyComparison.Harness = {
    on: (world, body) =>
      withTable(
        world.MainTable,
        (tableName) =>
          Effect.gen(function* () {
            const db = yield* RekeyComparison.clientOf(world)
            return yield* body(db, {
              seed: (row) =>
                Effect.gen(function* () {
                  const client = yield* DynamoClient
                  yield* client.putItem({ TableName: tableName, Item: row })
                }),
              rows: () => scanAll(tableName),
            })
          }),
        (tableName) => world.MainTable.layer({ name: tableName }),
      ),
  }

  describe("`rekey` touches no key a write stored", () => {
    for (const scenario of [
      ...RekeyComparison.compositeKindScenarios,
      ...RekeyComparison.writePathScenarios,
      ...RekeyComparison.otherWritePathScenarios,
    ]) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a Z-order index", () => {
    for (const scenario of RekeyComparison.zOrderScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  it.live("a sharded partition key moves between layouts, and the sort key beside it stays", () =>
    RekeyComparison.shardLayoutMoveScenario(harness),
  )
  describe("never a table key attribute: DynamoDB refuses the write", () => {
    for (const scenario of RekeyComparison.tableKeyAttributeScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("two accessors over one row, each in its own attributes", () => {
    for (const scenario of RekeyComparison.separatePairScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a move, where accessors sharing an attribute compose the same bytes", () => {
    for (const scenario of RekeyComparison.sameBytesMoveScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
    for (const scenario of RekeyComparison.sharedTableKeyMoveScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
    it.live("two accessors over one sharded partition key", () =>
      RekeyComparison.sharedShardMoveScenario(harness),
    )
  })
  for (const scenario of RekeyComparison.labelScenarios) {
    it.live(scenario.name, () => scenario.run(harness))
  }
  describe("a dry run judges each row on its own", () => {
    for (const scenario of RekeyComparison.dryRunChainScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
})

describeConnected("#183 key halves sharing an attribute, on real writes", () => {
  const harness: SharedKeys.Harness = {
    on: (world, body) =>
      withTable(
        world.MainTable,
        () =>
          Effect.gen(function* () {
            const db = yield* SharedKeys.clientOf(world)
            return yield* body(db)
          }),
        (tableName) => world.MainTable.layer({ name: tableName }),
      ),
  }

  // DynamoDB refuses `SET sk`, so each of these is an end-to-end check of what the
  // recording table can only see in the expression.
  describe("a half stored in a table key attribute", () => {
    for (const scenario of SharedKeys.tableKeyScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
    for (const scenario of SharedKeys.leavingIndexScenarios) {
      it.live(`leaving the index: ${scenario.name}`, () => scenario.run(harness))
    }
    for (const scenario of SharedKeys.offIndexScenarios) {
      it.live(`on no index, with retained versions: ${scenario.name}`, () => scenario.run(harness))
    }
    for (const scenario of SharedKeys.keptEntryScenarios) {
      it.live(`an entry \`preserve\` keeps: ${scenario.name}`, () => scenario.run(harness))
    }
  })

  it.live("a casing the table's schema agrees with: every read finds the row", () =>
    SharedKeys.agreeingCasingScenario(harness),
  )
})

describeConnected("#183 an inverted index is the table's key (shape 14), on real writes", () => {
  const harness: TableKeyHalves.Harness = {
    on: (world, body) =>
      withTable(
        world.MainTable,
        (tableName) =>
          Effect.gen(function* () {
            const db = yield* TableKeyHalves.clientOf(world)
            return yield* body(db, {
              seed: (row) =>
                Effect.gen(function* () {
                  const client = yield* DynamoClient
                  yield* client.putItem({ TableName: tableName, Item: row })
                }),
              rows: () => scanAll(tableName),
              as: (other, inner) =>
                Effect.gen(function* () {
                  const current = yield* TableKeyHalves.clientOf(other)
                  return yield* inner(current)
                }).pipe(Effect.provide(other.MainTable.layer({ name: tableName }))),
            })
          }),
        (tableName) => world.MainTable.layer({ name: tableName }),
      ),
  }

  describe("what any value does through it", () => {
    for (const scenario of TableKeyHalves.textScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("number and date composites", () => {
    for (const scenario of TableKeyHalves.numberAndDateScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("every other write path", () => {
    for (const scenario of TableKeyHalves.writePathScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a sort key of several composites, in partition key text", () => {
    for (const scenario of TableKeyHalves.multiCompositeScenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a row 1.36 wrote", () => {
    for (const scenario of TableKeyHalves.row136Scenarios) {
      it.live(scenario.name, () => scenario.run(harness))
    }
    it.live("whose text didn't change", () => TableKeyHalves.unchanged136Scenario(harness))
    it.live("of numbers and dates", () => TableKeyHalves.number136Scenario(harness))
  })
  it.live("a row 1.37.0 overwrote stays where it is", () =>
    TableKeyHalves.overwritten137Scenario(harness),
  )
})
