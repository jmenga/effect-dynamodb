/**
 * What geo asks of a caller's object, trap by trap (#239): each input to `put`, `enrich` and
 * `enrich` then the entity's put in a transaction, and `nearby`'s options, center, time window and
 * `pkFilter`, is a proxy recording each trap it receives, in order, step by step. A proxy over a
 * plain object holding the caller's values as its own properties answers as that object does, so
 * what it records is exactly what a run read of the object, and how.
 *
 * Each run records the top-level objects ("top") or every nested object too ("deep"), its inputs
 * holding ordinary names ("ordinary") or names `Object.prototype` holds, given as the object's own
 * properties ("named like Object.prototype members"). The core suite's `helpers/ReadParity.ts` runs
 * the same over every core entry point.
 *
 * `captureGeoTraps` runs one case against a library given as a parameter;
 * `test/fixtures/read-parity-geo-1.40.0.json` holds what published 1.40.0 did with each, on Effect
 * 4.1.3.
 */

import { canon, type GeoApi, type GeoOutcome } from "./InheritedShapes.js"

const NOW = 1700000000000
const CENTER = { latitude: 37.7749, longitude: -122.4194 }

/** Every trap a proxy over an ordinary object can receive. */
const TRAPS = [
  "get",
  "set",
  "has",
  "deleteProperty",
  "ownKeys",
  "getOwnPropertyDescriptor",
  "defineProperty",
  "getPrototypeOf",
  "setPrototypeOf",
  "isExtensible",
  "preventExtensions",
] as const

const KEYED = new Set<string>([
  "get",
  "set",
  "has",
  "deleteProperty",
  "getOwnPropertyDescriptor",
  "defineProperty",
])

/** The names an input holds beside the model's ordinary fields. */
export interface Names {
  readonly a: string
  readonly b: string
}

/** Each ordinary name sorts among the model's other names where its counterpart does. */
export const NAME_SETS: Readonly<Record<string, Names>> = {
  ordinary: { a: "topic", b: "colour" },
  "named like Object.prototype members": { a: "toString", b: "constructor" },
}

export const VARIANTS = ["top", "deep"] as const

export interface GeoTraced extends GeoOutcome {
  /** Each step's traps, in order. */
  readonly traces: Record<string, ReadonlyArray<string>>
}

const describe = (failure: any): string =>
  failure?._tag !== undefined
    ? `${failure._tag}: ${String(failure.message || (failure.cause?.message ?? failure.cause ?? "")).slice(0, 300)}`
    : `defect: ${String(failure?.message ?? failure).slice(0, 300)}`

const COMMANDS: Record<string, string> = {
  putItem: "PutItem",
  getItem: "GetItem",
  updateItem: "UpdateItem",
  query: "Query",
  scan: "Scan",
  transactWriteItems: "TransactWriteItems",
}

/** Runs the case of `set`'s names and `variant` against `api` on a table of its own at `endpoint`. */
export const captureGeoTraps = (
  api: GeoApi,
  endpoint: string,
  tableName: string,
  set: string,
  variant: (typeof VARIANTS)[number],
): Promise<GeoTraced> => {
  const { Effect, Exit, Cause, Layer, Schema } = api
  const N = NAME_SETS[set]!
  let log: Array<string> | undefined
  const S = (tag: string, value: object): object => {
    const handler: ProxyHandler<object> = {}
    for (const trap of TRAPS) {
      ;(handler as Record<string, unknown>)[trap] = (held: object, ...args: Array<unknown>) => {
        log?.push(KEYED.has(trap) ? `${tag} ${trap} ${String(args[0])}` : `${tag} ${trap}`)
        return (Reflect as unknown as Record<string, (...all: Array<unknown>) => unknown>)[trap]!(
          held,
          ...args,
        )
      }
    }
    return new Proxy({ ...value }, handler)
  }
  const D = variant === "deep" ? S : (_tag: string, value: object) => value
  const optional = Schema.optional(Schema.String)
  const Vehicles = api.Entity.make({
    model: Schema.Struct({
      fleet: Schema.String,
      vehicleId: Schema.String,
      latitude: Schema.Number,
      longitude: Schema.Number,
      timestamp: Schema.Number,
      cell: optional,
      parentCell: optional,
      timePartition: optional,
      [N.a]: optional,
      inner: Schema.optional(Schema.Struct({ k: Schema.String, [N.b]: optional } as never)),
    } as never),
    entityType: "Vehicle",
    primaryKey: {
      pk: { field: "pk", composite: ["vehicleId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byCell: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["fleet", "parentCell", "timePartition"] },
        sk: { field: "gsi1sk", composite: ["cell"] },
      },
    },
  })
  const Main = api.Table.make({
    schema: api.DynamoSchema.make({ name: "geo", version: 1 }),
    entities: { Vehicles },
  })
  const VehicleGeo = api.GeoIndex.make({
    entity: Vehicles,
    index: "byCell",
    coordinates: (item: any) => ({ latitude: item.latitude, longitude: item.longitude }),
    fields: {
      cell: { field: "cell", resolution: 15 },
      parentCell: { field: "parentCell", resolution: 3 },
      timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
    },
  })
  const input = (id: string, offset: number): any =>
    S("item", {
      fleet: "f",
      vehicleId: id,
      latitude: CENTER.latitude + offset,
      longitude: CENTER.longitude,
      timestamp: NOW,
      [N.a]: `${id}-a`,
      inner: D("inner", { k: id, [N.b]: `${id}-b` }),
    })
  const steps: ReadonlyArray<readonly [string, () => any]> = [
    ["put", () => VehicleGeo.put(input("v1", 0)).asEffect()],
    ["enrich", () => Effect.sync(() => VehicleGeo.enrich(input("v2", 0.001)))],
    [
      "enrich, then put in a transaction",
      () => api.Transaction.transactWrite([Vehicles.put(VehicleGeo.enrich(input("v3", 0.002)))]),
    ],
    [
      "nearby",
      () =>
        VehicleGeo.nearby(
          S("options", {
            center: D("center", { latitude: CENTER.latitude, longitude: CENTER.longitude }),
            radius: 1000,
            unit: "m",
            timeWindow: D("timeWindow", { start: NOW - 1000, end: NOW + 1000 }),
            pkFilter: D("pkFilter", { fleet: "f" }),
          }),
        ).pipe(
          Effect.map((hits: ReadonlyArray<any>) =>
            [...hits].map((hit) => hit.item).sort((a, b) => (a.vehicleId < b.vehicleId ? -1 : 1)),
          ),
        ),
    ],
  ]
  const base = api.DynamoClient.layer({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  })
  const requests: Array<{ readonly command: string; readonly input: unknown }> = []
  const recording = Layer.effect(
    api.DynamoClient,
    Effect.gen(function* () {
      const client: any = yield* api.DynamoClient
      return new Proxy(client, {
        get: (target, key) => {
          const held = target[key]
          const command = typeof key === "string" ? COMMANDS[key] : undefined
          return typeof held === "function" && command !== undefined
            ? (input: unknown, ...rest: Array<unknown>) => {
                requests.push({
                  command,
                  input: JSON.parse(
                    JSON.stringify(input).split(JSON.stringify(tableName)).join('"T"'),
                  ),
                })
                return held.call(target, input, ...rest)
              }
            : held
        },
      })
    }),
  )
  const client = Layer.provide(recording, base)
  const program = Effect.gen(function* () {
    const raw: any = yield* api.DynamoClient
    yield* raw.createTable({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      ...api.Table.definition(Main),
    })
    const out: Record<string, GeoOutcome["steps"][string]> = {}
    const sentBy: Record<string, ReadonlyArray<string>> = {}
    const traces: Record<string, ReadonlyArray<string>> = {}
    requests.length = 0
    for (const [label, run] of steps) {
      const before = requests.length
      log = []
      const exit = yield* Effect.exit(Effect.suspend(run))
      traces[label] = log
      log = undefined
      sentBy[label] = requests.slice(before).map((request) => request.command)
      out[label] = Exit.isSuccess(exit)
        ? { ok: true, value: canon(exit.value, "label") }
        : { ok: false, error: describe(Cause.squash(exit.cause)) }
    }
    const sent = [...requests]
    const scanned: any = yield* raw.scan({ TableName: tableName, ConsistentRead: true })
    const rows = ((scanned.Items ?? []) as Array<unknown>).map((row) => canon(row, "label")).sort()
    yield* raw.deleteTable({ TableName: tableName }).pipe(Effect.ignore)
    return { steps: out, sentBy, requests: sent, rows, traces }
  }).pipe(Effect.provide(Layer.merge(client, Main.layer({ name: tableName }))))
  return Effect.runPromise(program)
}
