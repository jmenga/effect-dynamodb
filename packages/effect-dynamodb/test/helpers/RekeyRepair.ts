/**
 * `rekey`'s count of index keys that differ, and `repairIndexKeys` (#185, `rekey-repair.md`).
 *
 * `fixtures/damaged-rows-1.38.0.json` holds what the published 1.38.0 stored, by the writes each row
 * names: the damage, and the states that look like it. The scenarios seed those exact bytes, or a
 * state only a writer outside the library leaves, and run under both `escapeKeys` settings, on a
 * recording table (`RekeyRepair.test.ts`) and on DynamoDB Local (`connected.rekey-repair.test.ts`).
 */

import { readFileSync } from "node:fs"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { fromAttributeMap, toAttributeMap } from "../../src/Marshaller.js"
import * as Table from "../../src/Table.js"
import { rekeyOutcome } from "./RekeyOutcome.js"

type StoredRow = Record<string, any>

export interface RecordedRequest {
  readonly command: string
  readonly input: Record<string, any>
}

/** What a scenario can do with a table, none of it through the client `rekey` runs on. */
export interface RepairTable {
  readonly seed: (row: StoredRow) => Effect.Effect<void, unknown>
  readonly remove: (row: StoredRow) => Effect.Effect<void, unknown>
  /** Every stored row, by key. */
  readonly rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown>
  /** The requests the client has been sent since {@link clear}. */
  readonly requests: () => ReadonlyArray<RecordedRequest>
  readonly clear: () => void
  /** Run before each `UpdateItem` is sent: another writer landing just before it. */
  readonly beforeUpdate: (
    hook: (input: Record<string, any>) => Effect.Effect<void, unknown>,
  ) => void
}

export interface Harness {
  /** Run `body` on a fresh table of `world`'s definition, with its client recording. */
  readonly on: <A, E>(
    world: { readonly MainTable: any },
    body: (table: RepairTable) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

/** A table a {@link Harness} runs on: its name, and how it comes and goes. */
export interface TableSetup {
  readonly tableName: string
  readonly client: Layer.Layer<DynamoClient>
  readonly acquire: Effect.Effect<void, unknown, DynamoClient>
  readonly release: Effect.Effect<void, unknown, DynamoClient>
}

/** A {@link Harness} over whatever table `setup` makes, wrapping its client to record and interfere. */
export const harnessOn = (setup: (world: { readonly MainTable: any }) => TableSetup): Harness => ({
  on: (world, body) => {
    const { tableName, client, acquire, release } = setup(world)
    const requests: Array<RecordedRequest> = []
    let hook: ((input: Record<string, any>) => Effect.Effect<void, unknown>) | undefined
    let raw: any
    const recording = Layer.effect(
      DynamoClient,
      Effect.gen(function* () {
        const inner: any = yield* DynamoClient
        raw = inner
        return new Proxy(inner, {
          get: (target, property) => {
            const method = Reflect.get(target, property)
            if (typeof method !== "function" || typeof property !== "string") return method
            return (input: Record<string, any>) =>
              Effect.suspend(() => {
                requests.push({ command: property, input })
                return property === "updateItem" && hook !== undefined
                  ? Effect.flatMap(hook(input), () => method.call(target, input))
                  : method.call(target, input)
              })
          },
        })
      }) as never,
    ).pipe(Layer.provide(client)) as Layer.Layer<DynamoClient>
    const table: RepairTable = {
      seed: (row) => Effect.asVoid(raw.putItem({ TableName: tableName, Item: row })),
      remove: (row) =>
        Effect.asVoid(raw.deleteItem({ TableName: tableName, Key: { pk: row.pk, sk: row.sk } })),
      rows: () =>
        Effect.gen(function* () {
          const rows: Array<StoredRow> = []
          let start: Record<string, any> | undefined
          do {
            const page: any = yield* raw.scan({
              TableName: tableName,
              ConsistentRead: true,
              ...(start === undefined ? {} : { ExclusiveStartKey: start }),
            })
            rows.push(...(page.Items ?? []))
            start = page.LastEvaluatedKey
          } while (start !== undefined)
          return rows.sort((a, b) => (`${a.pk.S}|${a.sk.S}` < `${b.pk.S}|${b.sk.S}` ? -1 : 1))
        }) as unknown as Effect.Effect<ReadonlyArray<StoredRow>, unknown>,
      requests: () => [...requests],
      clear: () => {
        requests.length = 0
      },
      beforeUpdate: (next) => {
        hook = next
      },
    }
    return Effect.acquireUseRelease(
      acquire,
      () => body(table),
      () => Effect.ignore(release),
    ).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(recording, world.MainTable.layer({ name: tableName }))),
    ) as never
  },
})

// ---------------------------------------------------------------------------
// The rows 1.38.0 stored
// ---------------------------------------------------------------------------

const fixture: {
  readonly rows: Readonly<Record<string, { readonly writes: string; readonly item: StoredRow }>>
} = JSON.parse(
  readFileSync(new URL("../fixtures/damaged-rows-1.38.0.json", import.meta.url), "utf8"),
)

/** The stored item of a fixture row. */
export const stored138 = (deviceId: string): StoredRow => fixture.rows[deviceId]!.item

export const FIXTURE_IDS = Object.keys(fixture.rows)

class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  zone: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  level: Schema.optional(Schema.Number),
  a: Schema.optional(Schema.String),
  b: Schema.optional(Schema.String),
  alertState: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
}) {}

const half = (n: number, composite: ReadonlyArray<string>) => ({
  field: `gsi${n}pk`,
  composite,
})
const sortHalf = (n: number, composite: ReadonlyArray<string>) => ({
  field: `gsi${n}sk`,
  composite,
})

/** The entity the fixture's rows were written by, on the fixture's schema name. */
const devices = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "damaged", version: 1, escapeKeys })
  const Devices = Entity.make({
    model: Device,
    entityType: "Device",
    primaryKey: {
      pk: { field: "pk", composite: ["channel", "deviceId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      sparseMixed: {
        name: "gsi1",
        pk: half(1, ["channel"]),
        sk: sortHalf(1, ["zone", "deviceId"]),
        indexPolicy: { sk: "sparse" },
      },
      preserveMixedSk: {
        name: "gsi2",
        pk: half(2, ["channel"]),
        sk: sortHalf(2, ["deviceId", "zone"]),
      },
      preserveMixedPk: {
        name: "gsi3",
        pk: half(3, ["channel", "zone"]),
        sk: sortHalf(3, ["deviceId"]),
      },
      byCurrentAlert: {
        name: "gsi4",
        pk: half(4, ["accountId"]),
        sk: sortHalf(4, ["alertState", "timestamp"]),
        indexPolicy: { pk: "preserve", sk: "sparse" },
      },
      twoSparse: {
        name: "gsi5",
        pk: half(5, ["channel"]),
        sk: sortHalf(5, ["a", "b"]),
        indexPolicy: { sk: "sparse" },
      },
      twoPreserve: { name: "gsi6", pk: half(6, ["channel"]), sk: sortHalf(6, ["a", "b"]) },
      byPlace: { name: "gsi7", pk: half(7, ["region"]), sk: sortHalf(7, ["country", "city"]) },
      byLevel: { name: "gsi8", pk: half(8, ["channel"]), sk: sortHalf(8, ["deviceId", "level"]) },
      byZone: { name: "gsi9", pk: half(9, ["zone"]), sk: sortHalf(9, []) },
      byChannel: { name: "gsi10", pk: half(10, ["channel"]), sk: sortHalf(10, ["deviceId"]) },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Devices } })
  const client = DynamoClient.make({ entities: { Devices }, tables: { MainTable } })
  return { schema, Devices, MainTable, client } as any
}

/** The secondary indexes a recording table needs to answer the scenarios' queries. */
export const RECORDING_INDEXES = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [`gsi${n}`, { pk: `gsi${n}pk`, sk: `gsi${n}sk` }]),
)

const seedAll = (table: RepairTable, ids: ReadonlyArray<string> = FIXTURE_IDS) =>
  Effect.forEach(ids, (id) => table.seed(stored138(id)), { discard: true })

const rowOf = (rows: ReadonlyArray<StoredRow>, deviceId: string) =>
  rows.find((row) => row.deviceId?.S === deviceId)!

/** What a `put` of `row`'s values writes: the same composer, on the row's own values. */
const putKeys = (w: any, row: StoredRow) =>
  KeyComposer.composeAllKeys(w.schema, "Device", 1, w.Devices.indexes, fromAttributeMap(row) as any)

/** The fixture's rows a repair must leave out of an index: a deliberate drop can't be told apart. */
const AMBIGUOUS: Readonly<Record<string, ReadonlyArray<string>>> = {
  dropped: ["gsi4sk"],
  writers: ["gsi5sk"],
  lag: ["gsi5sk"],
}

/**
 * Every key a `put` writes is stored, byte for byte, but those a drop can't be told from. Halves a
 * `put` wouldn't write are the update path's, and left.
 */
const expectKeysAsPut = (w: any, row: StoredRow) => {
  const deviceId = row.deviceId.S as string
  for (const [field, value] of Object.entries(putKeys(w, row))) {
    if ((AMBIGUOUS[deviceId] ?? []).includes(field)) {
      expect(row[field], `${deviceId} ${field}`).toBeUndefined()
    } else {
      expect(row[field]?.S, `${deviceId} ${field}`).toBe(value)
    }
  }
}

const ZERO = { missing: 0, truncated: 0, lagging: 0, ambiguous: 0, repaired: 0, skipped: 0 }

/**
 * What the fixture holds, under each setting. The row holding characters a key escapes, `a b`, has
 * a table key the setting decides: off leaves it, and its three damaged keys are counted; on moves
 * it, and a move recomposes its keys.
 */
const DAMAGE = {
  off: { ...ZERO, missing: 3, truncated: 10, lagging: 1, ambiguous: 3 },
  on: { ...ZERO, missing: 2, truncated: 8, lagging: 1, ambiguous: 3 },
}
const damageOf = (escapeKeys: boolean) => (escapeKeys ? DAMAGE.on : DAMAGE.off)
const repairsOf = (escapeKeys: boolean) => {
  const { missing, truncated, lagging } = damageOf(escapeKeys)
  return missing + truncated + lagging
}

export interface RepairScenario {
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}

const bothSettings = (
  name: string,
  run: (h: Harness, escapeKeys: boolean) => Effect.Effect<void, unknown>,
): ReadonlyArray<RepairScenario> =>
  [false, true].map((escapeKeys) => ({
    name: `${escapeKeys ? "escapeKeys on" : "escapeKeys off"}: ${name}`,
    run: (h) => run(h, escapeKeys),
  }))

const updatesOf = (table: RepairTable) =>
  table.requests().filter((request) => request.command === "updateItem")

// ---------------------------------------------------------------------------
// The rows of the fixture
// ---------------------------------------------------------------------------

export const fixtureScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("without the option it counts what differs and writes nothing new", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        yield* seedAll(table)
        const db = yield* w.client
        const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(real.indexKeys).toEqual(damageOf(on))
        expect(real.byMember.Device!.indexKeys).toEqual(damageOf(on))
        expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
        const after = yield* table.rows()
        // Nothing of any row but the one whose text the setting changes.
        for (const id of FIXTURE_IDS) {
          if (id !== "a b") expect(rowOf(after, id), id).toEqual(stored138(id))
        }
        // It holds what it held on every later run too, and still writes nothing.
        table.clear()
        const again: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(updatesOf(table)).toEqual([])
        expect(again.indexKeys.missing).toBe(DAMAGE.on.missing + (on ? 0 : 1))
        expect(again.indexKeys.lagging).toBe(1)
      }),
    )
  }),
  ...bothSettings(
    "with it, every damaged key is what a put writes, and a dry run agrees",
    (h, on) => {
      const w = devices(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          yield* seedAll(table)
          const db = yield* w.client
          const before = yield* table.rows()
          table.clear()
          const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            dryRun: true,
            repairIndexKeys: true,
          })
          expect(dry.dryRun).toBe(true)
          expect(updatesOf(table)).toEqual([])
          expect(yield* table.rows()).toEqual(before)

          const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
          })
          expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
          expect(real.indexKeys).toEqual({ ...damageOf(on), repaired: repairsOf(on) })
          expect(real.conflicts).toEqual([])

          const after = yield* table.rows()
          for (const row of after) expectKeysAsPut(w, row)
          // A row with nothing to repair is as it was.
          for (const id of ["healthy", "bare", "dropped", "cleared", "place"]) {
            expect(rowOf(after, id), id).toEqual(stored138(id))
          }
          expect(real.unchanged).toBe(5)
          // A half a put wouldn't write is left: a shape 3 truncation, and a key with no level.
          expect(rowOf(after, "place").gsi7sk.S).toBe("$damaged#v1#device#country_de")
          expect(rowOf(after, "damaged").gsi8sk.S).toBe("$damaged#v1#device#deviceid_damaged")
          // The values stay as they are, down to the attribute.
          const { gsi1sk, gsi2sk, gsi3pk, ...untouched } = rowOf(after, "damaged")
          expect(gsi1sk.S).toBe("$damaged#v1#device#zone_north#deviceid_damaged")
          expect(gsi2sk.S).toBe("$damaged#v1#device#deviceid_damaged#zone_north")
          expect(gsi3pk.S).toBe("$damaged#v1#device#channel_c1#zone_north")
          expect(untouched).toEqual(
            Object.fromEntries(
              Object.entries(stored138("damaged")).filter(
                ([field]) => !["gsi1sk", "gsi2sk", "gsi3pk"].includes(field),
              ),
            ),
          )

          // A second run finds what can't be told apart, and writes nothing.
          table.clear()
          const again: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
          })
          expect(again.indexKeys).toEqual({ ...ZERO, ambiguous: 3 })
          expect(updatesOf(table)).toEqual([])
          expect(yield* table.rows()).toEqual(after)
        }),
      )
    },
  ),
  ...bothSettings(
    "each row of the issue's table is found by its query only once repaired",
    (h, on) => {
      const w = devices(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          yield* seedAll(table, ["healthy", "damaged", "dropped", "lag"])
          const db = yield* w.client
          const ids = (items: ReadonlyArray<any>) => items.map((item) => item.deviceId).sort()
          const queries = Effect.gen(function* () {
            return {
              // `sparse`, `sk: [zone, deviceId]`: removed from the index.
              sparse: ids(yield* db.entities.Devices.sparseMixed({ channel: "c1" }).collect()),
              // `preserve`, `sk: [deviceId, zone]`: truncated, so a pin on the zone misses it.
              sortKey: ids(
                yield* db.entities.Devices.preserveMixedSk({
                  channel: "c1",
                  deviceId: "damaged",
                  zone: "north",
                }).collect(),
              ),
              // `preserve`, `pk: [channel, zone]`: truncated, so it's in another partition.
              partition: ids(
                yield* db.entities.Devices.preserveMixedPk({
                  channel: "c1",
                  zone: "north",
                }).collect(),
              ),
              // A key lagging its values: a pin on the value the row holds misses it.
              lagging: ids(
                yield* db.entities.Devices.twoPreserve({
                  channel: "c1",
                  a: "A",
                  b: "new",
                }).collect(),
              ),
              // The documented drop: an alert the writer said was over.
              alerts: ids(
                yield* db.entities.Devices.byCurrentAlert({ accountId: "acme" }).collect(),
              ),
            }
          })
          expect(yield* queries).toEqual({
            sparse: ["healthy"],
            sortKey: [],
            partition: ["healthy"],
            lagging: [],
            alerts: ["healthy"],
          })
          yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
          expect(yield* queries).toEqual({
            sparse: ["damaged", "healthy"],
            sortKey: ["damaged"],
            partition: ["damaged", "healthy"],
            lagging: ["lag"],
            alerts: ["healthy"],
          })
        }),
      )
    },
  ),
  ...bothSettings("a table with nothing to repair costs the scan alone", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        // Healthy, and the states that look like damage and aren't.
        yield* seedAll(table, ["healthy", "bare", "dropped", "cleared", "place"])
        const db = yield* w.client
        const before = yield* table.rows()
        table.clear()
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
        })
        expect(table.requests().map((request) => request.command)).toEqual(["scan"])
        expect(report.capacity.requests).toBe(1)
        expect(report.capacity.writeCapacityUnits).toBe(0)
        expect(report.indexKeys).toEqual({ ...ZERO, ambiguous: 1 })
        expect(report.unchanged).toBe(5)
        expect(yield* table.rows()).toEqual(before)
      }),
    )
  }),
  ...bothSettings("one conditional UpdateItem a row, guarded on what it read", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        yield* seedAll(table, ["damaged"])
        const db = yield* w.client
        table.clear()
        yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        const [update, ...others] = updatesOf(table)
        expect(others).toEqual([])
        const { ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues } =
          update!.input
        const guards = String(ConditionExpression).split(" AND ")
        const named = guards.map((guard) =>
          guard.replace(/#\w+/g, (name) => ExpressionAttributeNames[name]),
        )
        const heldAs = (attribute: string) =>
          ExpressionAttributeValues[
            guards[named.findIndex((guard) => guard.startsWith(`${attribute} = `))]!.split(
              " = ",
            )[1]!
          ]
        expect(named).toContain("attribute_exists(pk)")
        // A key it writes: its absence, or what it held. A composite: what it held.
        expect(named).toContain("attribute_not_exists(gsi1sk)")
        expect(heldAs("gsi2sk")).toEqual(stored138("damaged").gsi2sk)
        expect(heldAs("gsi3pk")).toEqual(stored138("damaged").gsi3pk)
        expect(heldAs("zone")).toEqual({ S: "north" })
        expect(heldAs("channel")).toEqual({ S: "c1" })
        expect(heldAs("deviceId")).toEqual({ S: "damaged" })
        expect(String(update!.input.UpdateExpression)).not.toContain("REMOVE")
      }),
    )
  }),
  ...bothSettings("a run resumed part way ends as a run over the table does", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        yield* seedAll(table)
        const db = yield* w.client
        const reports: Array<Table.RekeyReport> = []
        let resume: string | undefined
        do {
          const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
            pageSize: 1,
            maxPages: 2,
            ...(resume === undefined ? {} : { resume }),
          })
          reports.push(report)
          resume = Option.getOrUndefined(report.resume)
        } while (resume !== undefined)
        expect(reports.length).toBeGreaterThan(1)
        const sum = (count: keyof typeof ZERO) =>
          reports.reduce((total, report) => total + report.indexKeys[count], 0)
        expect(sum("repaired")).toBe(repairsOf(on))
        expect(sum("skipped")).toBe(0)
        for (const row of yield* table.rows()) expectKeysAsPut(w, row)
        // A token taken part way, used again, finds nothing left to do.
        const final: Table.RekeyReport = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(final.indexKeys.repaired).toBe(0)
      }),
    )
  }),
  ...bothSettings("segments agree with one scan", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        yield* seedAll(table)
        const db = yield* w.client
        const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
          dryRun: true,
          segments: 3,
        })
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
          segments: 3,
        })
        expect(real.indexKeys).toEqual({ ...damageOf(on), repaired: repairsOf(on) })
        expect(dry.indexKeys).toEqual(real.indexKeys)
        for (const row of yield* table.rows()) expectKeysAsPut(w, row)
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// A writer in between
// ---------------------------------------------------------------------------

export const racingScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("a writer changing a composite wins, and the key follows its value", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        yield* seedAll(table, ["damaged"])
        const db = yield* w.client
        let writes = 0
        table.beforeUpdate(() => {
          writes++
          return writes === 1
            ? table.seed({ ...stored138("damaged"), zone: { S: "south" } })
            : Effect.void
        })
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
        })
        const [row] = yield* table.rows()
        expect(row!.zone).toEqual({ S: "south" })
        expect(row!.gsi1sk.S).toBe("$damaged#v1#device#zone_south#deviceid_damaged")
        expect(row!.gsi3pk.S).toBe("$damaged#v1#device#channel_c1#zone_south")
        expect(row!.gsi9pk.S).toBe("$damaged#v1#device#zone_south")
        expect(report.indexKeys.skipped).toBe(0)
        // Read once, tried twice: it found three keys, and after the writer there were four.
        expect(table.requests().filter((r) => r.command === "getItem")).toHaveLength(1)
        expect(writes).toBe(2)
        expect(report.indexKeys.missing + report.indexKeys.truncated).toBe(3)
        expect(report.indexKeys.repaired).toBe(4)
      }),
    )
  }),
  ...bothSettings("a writer fixing the row itself leaves nothing to write", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        yield* seedAll(table, ["damaged"])
        const db = yield* w.client
        const fixed = {
          ...stored138("damaged"),
          ...toAttributeMap(putKeys(w, stored138("damaged"))),
        }
        let writes = 0
        table.beforeUpdate(() => {
          writes++
          return table.seed(fixed)
        })
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
        })
        expect(writes).toBe(1)
        expect(report.indexKeys.repaired).toBe(0)
        expect(report.indexKeys.skipped).toBe(0)
        expect((yield* table.rows())[0]).toEqual(fixed)
      }),
    )
  }),
  ...bothSettings("a writer changing it every time wins: counted skipped, and left", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        yield* seedAll(table, ["damaged"])
        const db = yield* w.client
        let writes = 0
        table.beforeUpdate(() => {
          writes++
          return table.seed({
            ...stored138("damaged"),
            status: { S: "x" },
            zone: { S: `z${writes}` },
          })
        })
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
        })
        expect(writes).toBe(2)
        expect(report.indexKeys.repaired).toBe(0)
        // The keys the second judging would have written: the three, and the partition of byZone.
        expect(report.indexKeys.skipped).toBe(4)
        expect(report.conflicts).toEqual([])
        const [row] = yield* table.rows()
        expect(row!.zone).toEqual({ S: "z2" })
        expect(row!.gsi1sk).toBeUndefined()
        // It isn't left for later: the next run repairs it.
        table.beforeUpdate(() => Effect.void)
        const next: Table.RekeyReport = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(next.indexKeys.repaired).toBe(4)
      }),
    )
  }),
  ...bothSettings("a writer deleting the row wins: nothing brings it back", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        yield* seedAll(table, ["damaged"])
        const db = yield* w.client
        table.beforeUpdate(() => table.remove(stored138("damaged")))
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
        })
        expect(yield* table.rows()).toEqual([])
        expect(report.indexKeys.repaired).toBe(0)
        expect(report.indexKeys.skipped).toBe(0)
        expect(report.conflicts).toEqual([])
      }),
    )
  }),
  ...bothSettings("a writer dropping the row on purpose wins: the key's as-read guard", (h, on) => {
    const w = devices(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        // `leading`: a truncated `sparse` key, both values on the row, repaired to the whole key.
        yield* seedAll(table, ["leading"])
        const db = yield* w.client
        const { gsi5sk: _gsi5sk, ...dropped } = stored138("leading")
        let writes = 0
        table.beforeUpdate(() => {
          writes++
          return writes === 1 ? table.seed(dropped) : Effect.void
        })
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
        })
        const [row] = yield* table.rows()
        // With no key it can't be told from a drop, so it stays out.
        expect(row!.gsi5sk).toBeUndefined()
        expect(report.indexKeys.skipped).toBe(0)
        // The other half it found, `preserve`, is still repaired.
        expect(row!.gsi6sk.S).toBe("$damaged#v1#device#a_a2#b_b")
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// States only a writer outside the library leaves, and the shapes
// ---------------------------------------------------------------------------

class Row extends Schema.Class<Row>("Row")({
  tenant: Schema.String,
  id: Schema.String,
  a: Schema.optional(Schema.String),
  b: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}) {}

const rowWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "shapes", version: 1, escapeKeys })
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey: {
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "sk", composite: ["id"] },
    },
    indexes: {
      sparse: {
        name: "gsi1",
        pk: half(1, ["tenant"]),
        sk: sortHalf(1, ["a", "b"]),
        indexPolicy: { sk: "sparse" },
      },
      kept: { name: "gsi2", pk: half(2, ["tenant"]), sk: sortHalf(2, ["a", "b"]) },
      sharded: {
        name: "gsi3",
        pk: half(3, ["tenant"]),
        sk: sortHalf(3, ["group", "id"]),
        shards: { count: 8, by: ["group"] },
      },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Rows } })
  const client = DynamoClient.make({ entities: { Rows }, tables: { MainTable } })
  return { schema, Rows, MainTable, client } as any
}

const shapeRow = (w: any, values: Record<string, string>, keys: Record<string, unknown>) =>
  toAttributeMap({
    ...values,
    pk: KeyComposer.composePk(w.schema, "Row", w.Rows.indexes.primary, values),
    sk: KeyComposer.composeSk(w.schema, "Row", 1, w.Rows.indexes.primary, values),
    __edd_e__: "Row",
    ...keys,
  })

const SK = (w: any, ...parts: ReadonlyArray<string>) =>
  [`$shapes#v1#row`, ...parts].join("#").replace(/^\$shapes/, `$${w.schema.name}`)

const PK = SK

export const shapeScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings(
    "trailing composite gone, key holding it: sparse truncates, preserve stays",
    (h, on) => {
      const w = rowWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const full = SK(w, "a_a", "b_old")
          yield* table.seed(
            shapeRow(w, { tenant: "t", id: "1", a: "A" }, { gsi1sk: full, gsi2sk: full }),
          )
          const db = yield* w.client
          const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
            dryRun: true,
          })
          const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
          })
          expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
          expect(real.indexKeys).toEqual({ ...ZERO, lagging: 1, repaired: 1 })
          const [row] = yield* table.rows()
          expect(row!.gsi1sk.S).toBe(SK(w, "a_a"))
          expect(row!.gsi2sk.S).toBe(full)
        }),
      )
    },
  ),
  ...bothSettings("a hole, key held: sparse removes, preserve stays", (h, on) => {
    const w = rowWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const full = SK(w, "a_a", "b_b")
        yield* table.seed(
          shapeRow(w, { tenant: "t", id: "1", b: "B" }, { gsi1sk: full, gsi2sk: full }),
        )
        const db = yield* w.client
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(real.indexKeys).toEqual({ ...ZERO, lagging: 1, repaired: 1 })
        const [row] = yield* table.rows()
        expect(row!.gsi1sk).toBeUndefined()
        expect(row!.gsi2sk.S).toBe(full)
      }),
    )
  }),
  ...bothSettings(
    "a key it removes is guarded as read: a writer changing it goes first",
    (h, on) => {
      const w = rowWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const seeded = shapeRow(
            w,
            { tenant: "t", id: "1", b: "B" },
            { gsi1sk: SK(w, "a_a", "b_b") },
          )
          yield* table.seed(seeded)
          const db = yield* w.client
          let writes = 0
          table.beforeUpdate(() => {
            writes++
            return writes === 1
              ? table.seed({ ...seeded, gsi1sk: { S: SK(w, "a_z", "b_b") } })
              : Effect.void
          })
          const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
          })
          // The first attempt held the key as read, so it failed; the second judged what's there now.
          expect(writes).toBe(2)
          expect(table.requests().filter((r) => r.command === "getItem")).toHaveLength(1)
          expect(report.indexKeys.repaired).toBe(1)
          const [row] = yield* table.rows()
          expect(row!.gsi1sk).toBeUndefined()
        }),
      )
    },
  ),
  ...bothSettings("a composite absent when read: a writer filling it wins", (h, on) => {
    const w = rowWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const full = SK(w, "a_a", "b_old")
        const seeded = shapeRow(
          w,
          { tenant: "t", id: "1", a: "A" },
          {
            gsi1pk: PK(w, "tenant_t"),
            gsi1sk: full,
            gsi2pk: PK(w, "tenant_t"),
            gsi2sk: SK(w, "a_a"),
          },
        )
        yield* table.seed(seeded)
        const db = yield* w.client
        let writes = 0
        table.beforeUpdate(() => {
          writes++
          return writes === 1 ? table.seed({ ...seeded, b: { S: "new" } }) : Effect.void
        })
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
        })
        const [row] = yield* table.rows()
        // Not `a_a`, which is what the read composed: the value the writer put is on the row now.
        expect(row!.gsi1sk.S).toBe(SK(w, "a_a", "b_new"))
        expect(row!.gsi2sk.S).toBe(SK(w, "a_a", "b_new"))
        expect(report.indexKeys.repaired).toBe(2)
      }),
    )
  }),
  ...bothSettings("sharded: a missing key is added with its marker, and only then", (h, on) => {
    const w = rowWorld(on)
    const index = w.Rows.indexes.sharded
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const whole = { tenant: "t", id: "1", group: "g" }
        const key = KeyComposer.composeStoredPk(w.schema, "Row", index, whole)!
        const sort = KeyComposer.composeSk(w.schema, "Row", 1, index, whole)
        // Its source: missing a key it could compose.
        yield* table.seed(shapeRow(w, whole, { gsi3sk: sort }))
        // No source: it can't compute the shard, so nothing is said.
        yield* table.seed(shapeRow(w, { tenant: "t", id: "2" }, {}))
        const db = yield* w.client
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(real.indexKeys).toEqual({ ...ZERO, missing: 1, repaired: 1 })
        expect(real.conflicts).toEqual([])
        const rows = yield* table.rows()
        expect(rows.find((row) => row.id?.S === "1")!.gsi3pk.S).toBe(key)
        expect(key).toContain("!8.")
        expect(rows.find((row) => row.id?.S === "2")!.gsi3pk).toBeUndefined()
      }),
    )
  }),
  ...bothSettings(
    "sharded: a sort key missing beside a source that's gone isn't whole",
    (h, on) => {
      const w = rowWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          // A put of these values refuses: no shard source.
          yield* table.seed(shapeRow(w, { tenant: "t", id: "1" }, {}))
          const db = yield* w.client
          const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
          })
          expect(real.indexKeys).toEqual(ZERO)
        }),
      )
    },
  ),
]

// ---------------------------------------------------------------------------
// Z-order
// ---------------------------------------------------------------------------

class Home extends Schema.Class<Home>("Home")({
  region: Schema.String,
  serial: Schema.Number,
  price: Schema.optional(Schema.Number),
  beds: Schema.optional(Schema.Number),
  kind: Schema.optional(Schema.Literals(["a", "b"])),
  agency: Schema.optional(Schema.String),
  office: Schema.optional(Schema.String),
}) {}

const zOrderWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "homes", version: 1, escapeKeys })
  const dimensions = [
    { field: "price", min: 0, max: 1000, step: 10 },
    { field: "beds", min: 0, max: 15 },
  ]
  const Homes = Entity.make({
    model: Home,
    entityType: "Home",
    primaryKey: {
      pk: { field: "pk", composite: ["region"] },
      sk: { field: "sk", composite: ["serial"] },
    },
    indexes: {
      // Shape 7, each policy.
      facets: {
        name: "gsi1",
        pk: half(1, ["region"]),
        sk: { field: "gsi1sk", zorder: dimensions },
      },
      facetsSparse: {
        name: "gsi2",
        pk: half(2, ["region"]),
        sk: { field: "gsi2sk", zorder: dimensions },
        indexPolicy: { sk: "sparse" },
      },
      // Shape 7a: one dimension, one bit.
      oneBit: {
        name: "gsi3",
        pk: half(3, ["region"]),
        sk: { field: "gsi3sk", zorder: ["kind"] },
        indexPolicy: { sk: "sparse" },
      },
      // Shape 8a: every field a primary key composite.
      keyed: {
        name: "gsi4",
        pk: half(4, ["region"]),
        sk: {
          field: "gsi4sk",
          prefix: ["region"],
          zorder: [{ field: "serial", min: 0, max: 1000 }],
        },
        indexPolicy: { sk: "sparse" },
      },
      // Shape 8c: a hierarchical prefix, each policy.
      offices: {
        name: "gsi5",
        pk: half(5, ["region"]),
        sk: {
          field: "gsi5sk",
          prefix: ["agency", "office"],
          zorder: [{ field: "beds", min: 0, max: 15 }],
        },
      },
      officesSparse: {
        name: "gsi6",
        pk: half(6, ["region"]),
        sk: {
          field: "gsi6sk",
          prefix: ["agency", "office"],
          zorder: [{ field: "beds", min: 0, max: 15 }],
        },
        indexPolicy: { sk: "sparse" },
      },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Homes } })
  const client = DynamoClient.make({ entities: { Homes }, tables: { MainTable } })
  const address = (name: string, values: Record<string, unknown>) =>
    KeyComposer.composeZOrderSk(schema, Homes.indexes[name], values)
  return { schema, Homes, MainTable, client, address } as any
}

const homeRow = (w: any, values: Record<string, unknown>, keys: Record<string, Uint8Array>) => ({
  ...toAttributeMap({
    ...values,
    pk: KeyComposer.composePk(w.schema, "Home", w.Homes.indexes.primary, values),
    sk: KeyComposer.composeSk(w.schema, "Home", 1, w.Homes.indexes.primary, values),
    __edd_e__: "Home",
  }),
  ...Object.fromEntries(Object.entries(keys).map(([field, bytes]) => [field, { B: bytes }])),
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((n) => [
      `gsi${n}pk`,
      {
        S: KeyComposer.composePk(w.schema, "Home", w.Homes.indexes.primary, values).replace(
          /#serial.*$/,
          "",
        ),
      },
    ]),
  ),
})

export const RECORDING_ZORDER_INDEXES = Object.fromEntries(
  [1, 2, 3, 4, 5, 6].map((n) => [`gsi${n}`, { pk: `gsi${n}pk`, sk: `gsi${n}sk` }]),
)

export const zOrderScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("a value within one quantization level writes nothing", (h, on) => {
    const w = zOrderWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const at = { region: "r", serial: 1, price: 100, beds: 2 }
        const held = { ...at, price: 104 }
        const stored = w.address("facets", at)
        // Stored from 100, the row holds 104: the same level, so the same bytes.
        expect([...w.address("facets", held)]).toEqual([...stored])
        yield* table.seed(
          homeRow(w, held, {
            gsi1sk: stored,
            gsi2sk: stored,
            gsi4sk: w.address("keyed", held),
          }),
        )
        const db = yield* w.client
        table.clear()
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(real.indexKeys).toEqual(ZERO)
        expect(table.requests().map((request) => request.command)).toEqual(["scan"])
      }),
    )
  }),
  ...bothSettings("another level is set, whole: there's no truncating an address", (h, on) => {
    const w = zOrderWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const held = { region: "r", serial: 1, price: 500, beds: 2 }
        const lagging = w.address("facets", { ...held, price: 100 })
        yield* table.seed(
          homeRow(w, held, {
            gsi1sk: lagging,
            gsi2sk: lagging,
            gsi4sk: w.address("keyed", held),
          }),
        )
        const db = yield* w.client
        const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
          dryRun: true,
        })
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
        expect(real.indexKeys).toEqual({ ...ZERO, lagging: 2, repaired: 2 })
        const [row] = yield* table.rows()
        const whole = [...w.address("facets", held)]
        expect([...row!.gsi1sk.B]).toEqual(whole)
        expect([...row!.gsi2sk.B]).toEqual(whole)
      }),
    )
  }),
  ...bothSettings(
    "a dimension gone: sparse removes, preserve stays, neither truncates",
    (h, on) => {
      const w = zOrderWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const stored = w.address("facets", { region: "r", serial: 1, price: 100, beds: 2 })
          yield* table.seed(
            homeRow(
              w,
              { region: "r", serial: 1, price: 100 },
              {
                gsi1sk: stored,
                gsi2sk: stored,
                gsi4sk: w.address("keyed", { region: "r", serial: 1 }),
              },
            ),
          )
          const db = yield* w.client
          const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
          })
          expect(real.indexKeys).toEqual({ ...ZERO, lagging: 1, repaired: 1 })
          const [row] = yield* table.rows()
          expect(row!.gsi2sk).toBeUndefined()
          expect([...row!.gsi1sk.B]).toEqual([...stored])
        }),
      )
    },
  ),
  ...bothSettings(
    "no address, every dimension there: preserve adds, sparse can't tell",
    (h, on) => {
      const w = zOrderWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const held = { region: "r", serial: 1, price: 100, beds: 2 }
          yield* table.seed(homeRow(w, held, { gsi4sk: w.address("keyed", held) }))
          const db = yield* w.client
          const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
          })
          expect(real.indexKeys).toEqual({ ...ZERO, missing: 1, ambiguous: 1, repaired: 1 })
          const [row] = yield* table.rows()
          expect([...row!.gsi1sk.B]).toEqual([...w.address("facets", held)])
          expect(row!.gsi2sk).toBeUndefined()
        }),
      )
    },
  ),
  ...bothSettings(
    "shape 7a: a single dimension's address missing is added, under sparse",
    (h, on) => {
      const w = zOrderWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const held = { region: "r", serial: 1, kind: "b" }
          yield* table.seed(homeRow(w, held, { gsi4sk: w.address("keyed", held) }))
          const db = yield* w.client
          const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
          })
          expect(real.indexKeys).toEqual({ ...ZERO, missing: 1, repaired: 1 })
          const [row] = yield* table.rows()
          expect([...row!.gsi3sk.B]).toEqual([1])
        }),
      )
    },
  ),
  ...bothSettings("shape 8a: every field a primary key composite, missing is added", (h, on) => {
    const w = zOrderWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const held = { region: "r", serial: 1 }
        yield* table.seed(homeRow(w, held, {}))
        const db = yield* w.client
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(real.indexKeys).toEqual({ ...ZERO, missing: 1, repaired: 1 })
        const [row] = yield* table.rows()
        expect([...row!.gsi4sk.B]).toEqual([...w.address("keyed", held)])
      }),
    )
  }),
  ...bothSettings("shape 8c: a prefix composite gone is never a truncated address", (h, on) => {
    const w = zOrderWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const stored = w.address("offices", {
          region: "r",
          serial: 1,
          agency: "x",
          office: "y",
          beds: 2,
        })
        yield* table.seed(
          homeRow(
            w,
            { region: "r", serial: 1, agency: "x", beds: 2 },
            {
              gsi5sk: stored,
              gsi6sk: stored,
              gsi4sk: w.address("keyed", { region: "r", serial: 1 }),
            },
          ),
        )
        const db = yield* w.client
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(real.indexKeys).toEqual({ ...ZERO, lagging: 1, repaired: 1 })
        const [row] = yield* table.rows()
        expect([...row!.gsi5sk.B]).toEqual([...stored])
        expect(row!.gsi6sk).toBeUndefined()
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// A ref's id, composites the library stamps
// ---------------------------------------------------------------------------

class Team extends Schema.Class<Team>("Team")({ id: Schema.String, name: Schema.String }) {}

const TeamModel = DynamoModel.configure(Team, { id: { identifier: true } })

class Player extends Schema.Class<Player>("Player")({
  id: Schema.String,
  team: Team.pipe(DynamoModel.ref),
  status: Schema.optional(Schema.String),
}) {}

const refWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "refs", version: 1, escapeKeys })
  const Teams = Entity.make({
    model: TeamModel,
    entityType: "Team",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const Players = Entity.make({
    model: Player,
    entityType: "Player",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    refs: {
      team: {
        entity: Teams,
        cascade: { index: "gsi2", pk: { field: "gsi2pk" }, sk: { field: "gsi2sk" } },
      },
    },
    indexes: {
      byTeam: {
        name: "gsi1",
        pk: half(1, ["teamId"]),
        sk: sortHalf(1, ["id"]),
        indexPolicy: { pk: "sparse" },
      },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Teams, Players } })
  const client = DynamoClient.make({ entities: { Teams, Players }, tables: { MainTable } })
  return { schema, Teams, Players, MainTable, client } as any
}

export const refScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings(
    "a ref's id is read from the stored ref: a healthy row isn't touched",
    (h, on) => {
      const w = refWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Teams.put({ id: "t1", name: "Reds" }).asEffect()
          yield* db.entities.Players.put({ id: "p1", teamId: "t1" }).asEffect()
          const before = yield* table.rows()
          const player = before.find((row) => row.__edd_e__?.S === "Player")!
          // It holds the ref, and no `teamId`: read by name, a `sparse` half would be removed.
          expect(player.teamId).toBeUndefined()
          expect(player.gsi1pk.S).toContain("teamid_t1")
          expect(player.gsi2pk.S).toContain("teamid_t1")
          table.clear()
          const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
            repairIndexKeys: true,
          })
          expect(report.indexKeys).toEqual(ZERO)
          expect(table.requests().map((request) => request.command)).toEqual(["scan"])
          expect(yield* table.rows()).toEqual(before)
        }),
      )
    },
  ),
  ...bothSettings("a ref's id missing from its key is repaired, guarded on the ref", (h, on) => {
    const w = refWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Teams.put({ id: "t1", name: "Reds" }).asEffect()
        yield* db.entities.Teams.put({ id: "t2", name: "Blues" }).asEffect()
        yield* db.entities.Players.put({ id: "p1", teamId: "t1" }).asEffect()
        const player = (yield* table.rows()).find((row) => row.__edd_e__?.S === "Player")!
        const { gsi2pk, ...damaged } = player
        yield* table.seed(damaged)
        // A writer moves the player to another team, with its index keys left as they were.
        let writes = 0
        table.beforeUpdate((input) => {
          writes++
          expect(Object.values(input.ExpressionAttributeNames)).toContain("team")
          return writes === 1
            ? table.seed({ ...damaged, team: { M: { id: { S: "t2" }, name: { S: "Blues" } } } })
            : Effect.void
        })
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
        })
        expect(writes).toBe(2)
        expect(report.indexKeys.missing).toBe(1)
        const row = (yield* table.rows()).find((item) => item.__edd_e__?.S === "Player")!
        expect(row.gsi2pk.S).toContain("teamid_t2")
        expect(gsi2pk.S).toContain("teamid_t1")
      }),
    )
  }),
]

class Stamped extends Schema.Class<Stamped>("Stamped")({
  id: Schema.String,
  owner: Schema.String,
  status: Schema.optional(Schema.String),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  version: Schema.Number,
}) {}

const stampedWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "stamped", version: 1, escapeKeys })
  const Stampeds = Entity.make({
    model: Stamped,
    entityType: "Stamped",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    timestamps: true,
    versioned: true,
    indexes: {
      byCreated: { name: "gsi1", pk: half(1, ["owner"]), sk: sortHalf(1, ["createdAt"]) },
      byUpdated: { name: "gsi2", pk: half(2, ["owner"]), sk: sortHalf(2, ["updatedAt"]) },
      byVersion: { name: "gsi3", pk: half(3, ["owner"]), sk: sortHalf(3, ["version"]) },
      byUpdatedSparse: {
        name: "gsi4",
        pk: half(4, ["owner"]),
        sk: sortHalf(4, ["updatedAt"]),
        indexPolicy: { sk: "sparse" },
      },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Stampeds } })
  const client = DynamoClient.make({ entities: { Stampeds }, tables: { MainTable } })
  return { schema, Stampeds, MainTable, client } as any
}

export const stampedScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("a composite the library stamps is never judged", (h, on) => {
    const w = stampedWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        // A put not supplying them: their values on the row, no index keys.
        yield* db.entities.Stampeds.put({ id: "a", owner: "o" }).asEffect()
        // Supplied, then updated: `updatedAt` and `version` move, and their keys stay.
        const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
        yield* db.entities.Stampeds.put({
          id: "b",
          owner: "o",
          createdAt: at,
          updatedAt: at,
        }).asEffect()
        yield* db.entities.Stampeds.update({ id: "b" }).set({ status: "x" }).asEffect()
        const before = yield* table.rows()
        const unsupplied = before.find((row) => row.id?.S === "a")!
        expect(unsupplied.updatedAt).toBeDefined()
        expect(unsupplied.version).toBeDefined()
        expect(unsupplied.gsi1sk).toBeUndefined()
        expect(unsupplied.gsi2sk).toBeUndefined()
        expect(unsupplied.gsi3sk).toBeUndefined()
        table.clear()
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          repairIndexKeys: true,
        })
        expect(report.indexKeys).toEqual(ZERO)
        expect(table.requests().map((request) => request.command)).toEqual(["scan"])
        expect(yield* table.rows()).toEqual(before)
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// A row that moves
// ---------------------------------------------------------------------------

const moveScenario = (
  name: string,
  run: (
    now: any,
    was: any,
    table: RepairTable,
    repairIndexKeys: boolean,
  ) => Effect.Effect<void, unknown, any>,
): ReadonlyArray<RepairScenario> =>
  [false, true].flatMap((repairIndexKeys) =>
    bothSettings(`${name}, ${repairIndexKeys ? "with" : "without"} the option`, (h, on) => {
      const now = devices(on)
      const was = devices(!on)
      return h.on(now, (table) => run(now, was, table, repairIndexKeys))
    }),
  )

export const moveScenarios: ReadonlyArray<RepairScenario> = moveScenario(
  "a row dropped on purpose stays out of the index when it moves",
  (now, was, table, repairIndexKeys) =>
    Effect.gen(function* () {
      const values = {
        channel: "c 1",
        deviceId: "dropped",
        accountId: "acme",
        alertState: "active",
        timestamp: "t2",
      }
      const row = {
        ...toAttributeMap({
          ...values,
          __edd_e__: "Device",
          ...KeyComposer.composeAllKeys(was.schema, "Device", 1, was.Devices.indexes, values),
        }),
      }
      const { gsi4sk: _dropped, ...stored } = row as StoredRow
      yield* table.seed(stored)
      const db = yield* now.client
      const options = repairIndexKeys ? { repairIndexKeys: true } : {}
      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ ...options, dryRun: true })
      const real: Table.RekeyReport = yield* db.tables.MainTable.rekey(options)
      expect(real.moved.item).toBe(1)
      expect(real.indexKeys).toEqual({ ...ZERO, ambiguous: 1 })
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      const [moved] = yield* table.rows()
      expect(moved!.gsi4pk.S).toContain("accountid_acme")
      expect(moved!.gsi4sk).toBeUndefined()
      // Everything else a move recomposes is there.
      expect(moved!.gsi10sk.S).toContain("deviceid_dropped")
    }),
).concat(
  moveScenario("a row damaged is caught up when it moves", (now, was, table, repairIndexKeys) =>
    Effect.gen(function* () {
      const values = { channel: "c 1", deviceId: "moved", zone: "north" }
      const full = KeyComposer.composeAllKeys(was.schema, "Device", 1, was.Devices.indexes, values)
      const { gsi1sk: _gone, ...keys } = full as Record<string, string>
      yield* table.seed(
        toAttributeMap({ ...values, __edd_e__: "Device", ...keys, gsi2sk: "$damaged#v1#device" }),
      )
      const db = yield* now.client
      const options = repairIndexKeys ? { repairIndexKeys: true } : {}
      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ ...options, dryRun: true })
      const real: Table.RekeyReport = yield* db.tables.MainTable.rekey(options)
      expect(real.moved.item).toBe(1)
      expect(real.indexKeys).toEqual(ZERO)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      const [moved] = yield* table.rows()
      expectKeysAsPut(now, moved!)
    }),
  ),
  moveScenario(
    "a row the scan meets again where it moved is counted once",
    (now, was, table, repairIndexKeys) =>
      Effect.gen(function* () {
        // One channel's key sorts later under each setting, so the scan meets those rows twice
        // going one way or the other, on a table in key order and in hash order alike.
        const rows = ["c 1", "%z"].flatMap((channel) =>
          ["one", "two", "three"].map((deviceId) => ({
            channel,
            deviceId,
            accountId: "acme",
            alertState: "active",
            timestamp: "t2",
          })),
        )
        for (const values of rows) {
          const { gsi4sk: _dropped, ...keys } = KeyComposer.composeAllKeys(
            was.schema,
            "Device",
            1,
            was.Devices.indexes,
            values,
          ) as Record<string, string>
          yield* table.seed(toAttributeMap({ ...values, __edd_e__: "Device", ...keys }))
        }
        const db = yield* now.client
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          pageSize: 1,
          ...(repairIndexKeys ? { repairIndexKeys: true } : {}),
        })
        expect(real.moved.item).toBe(rows.length)
        expect(real.indexKeys).toEqual({ ...ZERO, ambiguous: rows.length })
      }),
  ),
)
