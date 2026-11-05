/**
 * Devices on a sharded index (#183): an entity whose `byTenant` index spreads one
 * tenant over N partitions, and a mock serving each partition the way DynamoDB
 * does (`PartitionMock`), so a test sees every request and its key condition.
 *
 * Unlike a bare `PartitionMock`, this applies a `ProjectionExpression`, so a merge
 * that didn't borrow the attributes it needs fails here as it would on DynamoDB.
 */

import type { QueryCommandInput, QueryCommandOutput } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { shardOf } from "@effect-dynamodb/schema/internal/Shards.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient, type DynamoClientError } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { toAttributeMap } from "../../src/Marshaller.js"
import * as Table from "../../src/Table.js"
import { mockDynamoClientLayer } from "./MockDynamoClient.js"
import { compareBytes, makePartition, type Partition, type Row } from "./PartitionMock.js"

export const TENANT = "t-123"

export interface Device {
  readonly channel: string
  readonly deviceId: string
  readonly tenantId: string
  readonly groupId: string
  readonly status: string
  readonly reading: number
}

export interface DevicesOptions {
  /** The `shards` of `byTenant` (default 8); `null` leaves the index unsharded. */
  readonly shards?: number | KeyComposer.ShardsConfig<string> | null | undefined
  /** The sort key composites of `byTenant` (default `groupId`, `channel`, `deviceId`). */
  readonly sk?: ReadonlyArray<"groupId" | "channel" | "deviceId" | "status"> | undefined
}

export interface ServerOptions {
  /** Cap a page at this many rows, as 1 MB would, whatever the `Limit`. */
  readonly pageRows?: number | undefined
  /** Fail or delay a request: runs before the partition answers. */
  readonly before?:
    | ((input: QueryCommandInput, request: number) => Effect.Effect<void, DynamoClientError>)
    | undefined
}

export interface Server {
  readonly layer: Layer.Layer<any>
  /** Every request received, in order. */
  readonly inputs: Array<QueryCommandInput>
  /** The partition keys asked for, in order. */
  readonly partitionsRead: () => Array<string>
  /** Rows examined across every request. */
  readonly scanned: () => number
  /** Forget the requests received. */
  readonly clear: () => void
}

const encoder = new TextEncoder()

/** The partition key a request reads. */
export const pkOfInput = (input: QueryCommandInput): string =>
  input.ExpressionAttributeValues![":pk"]!.S!

/** Apply a projection's top-level attributes, as DynamoDB would. */
const applyProjection = (input: QueryCommandInput, row: Row): Row => {
  const expression = input.ProjectionExpression
  if (expression === undefined) return row
  const names = input.ExpressionAttributeNames ?? {}
  const kept = expression.split(",").map((part) => {
    const first = part.trim().split(".")[0]!
    return first.startsWith("#") ? names[first]! : first
  })
  return Object.fromEntries(kept.flatMap((name) => (row[name] ? [[name, row[name]]] : [])))
}

/** Serve `rows` by the value of their `pkField`, each partition as DynamoDB would. */
export const serveRows = (
  rows: ReadonlyArray<Row>,
  fields: {
    readonly pkField: string
    readonly skField: string
    readonly keyFields: ReadonlyArray<string>
  },
  options: ServerOptions = {},
): Omit<Server, "layer"> & {
  readonly query: (input: QueryCommandInput) => Effect.Effect<QueryCommandOutput, DynamoClientError>
} => {
  const partitionOf = (rowsOfPartition: ReadonlyArray<Row>): Partition =>
    makePartition({
      rows: rowsOfPartition,
      ...fields,
      evaluateFilter: true,
      ...(options.pageRows === undefined ? {} : { rowBytes: () => 1, pageBytes: options.pageRows }),
    })
  const partitions = new Map<string, Partition>()
  const grouped = new Map<string, Array<Row>>()
  for (const row of rows) {
    const pk = row[fields.pkField]?.S
    if (pk === undefined) continue
    grouped.set(pk, [...(grouped.get(pk) ?? []), row])
  }
  for (const [pk, partitionRows] of grouped) partitions.set(pk, partitionOf(partitionRows))
  const empty = partitionOf([])
  const inputs: Array<QueryCommandInput> = []
  const query = (input: QueryCommandInput) =>
    Effect.gen(function* () {
      const request = inputs.push(input)
      if (options.before !== undefined) yield* options.before(input, request)
      const output = yield* (partitions.get(pkOfInput(input)) ?? empty).query(input)
      return {
        ...output,
        ...(output.Items === undefined
          ? {}
          : { Items: output.Items.map((row) => applyProjection(input, row as Row)) }),
      } as QueryCommandOutput
    })
  return {
    query,
    inputs,
    partitionsRead: () => inputs.map(pkOfInput),
    scanned: () => [...partitions.values()].reduce((n, p) => n + p.scanned(), 0),
    clear: () => {
      inputs.length = 0
      for (const partition of partitions.values()) partition.clear()
    },
  }
}

export const schema = DynamoSchema.make({ name: "fleet-db", version: 1 })

export const Model = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  tenantId: Schema.String,
  groupId: Schema.String,
  status: Schema.String,
  reading: Schema.Number,
})

export const makeDevices = (options: DevicesOptions = {}) => {
  const sk = options.sk ?? ["groupId", "channel", "deviceId"]
  const Devices: any = Entity.make({
    model: Model,
    entityType: "DeviceState",
    primaryKey: {
      pk: { field: "pk", composite: ["channel"] },
      sk: { field: "sk", composite: ["deviceId"] },
    },
    indexes: {
      byTenant: {
        name: "gsi5",
        pk: { field: "gsi5pk", composite: ["tenantId"] },
        sk: { field: "gsi5sk", composite: [...sk] },
        ...(options.shards === null ? {} : { shards: options.shards ?? 8 }),
      },
    },
  } as any)
  const MainTable = Table.make({ schema, entities: { Devices } })
  const definition = Devices.indexes as Record<string, KeyComposer.IndexDefinition>
  const fields = {
    pkField: "gsi5pk",
    skField: "gsi5sk",
    keyFields: ["gsi5pk", "gsi5sk", "pk", "sk"],
  }
  const index = definition.byTenant!

  const rowOf = (item: Device): Row =>
    toAttributeMap({
      ...item,
      ...KeyComposer.composeAllKeys(schema, "DeviceState", 1, definition, item),
      __edd_e__: "DeviceState",
    })

  /** The partition an item is stored in, by position in the merge. */
  const shardIndexOf = (item: Device): number => {
    const shards = index.shards
    if (shards === undefined) return 0
    const texts = shards.source!.map((attr) =>
      KeyComposer.serializeValue((item as unknown as Record<string, unknown>)[attr]),
    )
    return shardOf(texts, shards.count)
  }

  /** `rows` in merge order: sort key bytes, then partition, then table key. */
  const merged = (items: ReadonlyArray<Device>, reverse = false): Array<Device> => {
    const entries = items.map((item) => ({
      item,
      sk: encoder.encode(rowOf(item).gsi5sk!.S!),
      shard: shardIndexOf(item),
      tie: encoder.encode(
        JSON.stringify([rowOf(item).gsi5pk, rowOf(item).gsi5sk, rowOf(item).pk, rowOf(item).sk]),
      ),
    }))
    entries.sort(
      (a, b) => compareBytes(a.sk, b.sk) || a.shard - b.shard || compareBytes(a.tie, b.tie),
    )
    const sorted = entries.map((entry) => entry.item)
    return reverse ? sorted.reverse() : sorted
  }

  const serve = (
    items: ReadonlyArray<Device>,
    serverOptions: ServerOptions = {},
    extraRows: ReadonlyArray<Row> = [],
  ): Server => {
    const server = serveRows([...items.map(rowOf), ...extraRows], fields, serverOptions)
    return {
      ...server,
      layer: Layer.merge(
        mockDynamoClientLayer({ query: server.query }),
        MainTable.layer({ name: "devices" }),
      ),
    }
  }

  return {
    Devices,
    MainTable,
    index,
    rowOf,
    merged,
    shardIndexOf,
    serve,
    fields,
    client: Effect.map(
      DynamoClient.make({ entities: { Devices }, tables: { MainTable } }),
      (db: any) => db.entities.Devices,
    ) as Effect.Effect<any, never, DynamoClient>,
  }
}

/** A deterministic PRNG (mulberry32), so a failing seed reproduces. */
export const prng = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` devices of one tenant, drawn from `groups` and `statuses`. */
export const randomDevices = (
  next: () => number,
  count: number,
  groups: ReadonlyArray<string> = ["group-a", "group-b", "group-c"],
  statuses: ReadonlyArray<string> = ["on", "off", "idle"],
): Array<Device> =>
  Array.from({ length: count }, (_, n) => ({
    channel: `channel-${Math.floor(next() * 4)}`,
    deviceId: `device-${String(n).padStart(4, "0")}`,
    tenantId: TENANT,
    groupId: groups[Math.floor(next() * groups.length)]!,
    status: statuses[Math.floor(next() * statuses.length)]!,
    reading: Math.floor(next() * 100),
  }))

export const idsOf = (items: ReadonlyArray<{ readonly deviceId: string }>) =>
  items.map((item) => item.deviceId)
