/**
 * Every member of `Object.prototype` a geo input gives as a field, in every shape an input takes,
 * through the geo write paths, run against DynamoDB Local (#239): `GeoIndex.put`, and `enrich` with
 * the entity's put in a transaction; then `nearby` reads them back. The name is a field at the top
 * level (optional), a required property of a required struct, a required property of one
 * alternative of a union of structs, and an optional property of a struct a suspended schema gives.
 * The shapes are the core suite's (`effect-dynamodb/test/helpers/PayloadShapes.ts`), and an
 * instance of a `Schema.Class`.
 *
 * `captureGeo` runs one shape under one name against a library given as a parameter: each step's
 * result or failure, every request, and the rows. `test/fixtures/inherited-shapes-geo-1.40.0.json`
 * holds what published 1.40.0 did with each on Effect 4.1.3. `captureGeoReads` counts what geo
 * reads of a caller's objects, and `captureGeoCopies` runs the copy `enrich` makes under each probe
 * of {@link PROBES}.
 */

import { Schema as HeadSchema } from "effect"

/** The library's public modules, geo's, and the `effect` they run on. */
export interface GeoApi {
  readonly DynamoClient: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly Table: any
  readonly Transaction: any
  readonly GeoIndex: any
  readonly Cause: any
  readonly Effect: any
  readonly Exit: any
  readonly Layer: any
  readonly Schema: any
}

/** An ordinary name first, then every member of `Object.prototype` but `__proto__`. */
export const NAMES = [
  "label",
  ...Object.getOwnPropertyNames(Object.prototype).filter((name) => name !== "__proto__"),
]

/** The name every other is compared with. */
export const CONTROL = "label"

export type Shape = (record: Record<string, unknown>) => object

/** A `Schema.Class` per set of names, each field `Unknown`: the class a record's instance is of. */
const classes = new Map<string, new (props: object) => object>()

export const SHAPES: Readonly<Record<string, Shape>> = {
  plain: (record) => ({ ...record }),
  "Object.create": (record) => Object.create({ ...record }),
  "class with getters": (record) => {
    class Payload {}
    for (const name of Object.keys(record)) {
      Object.defineProperty(Payload.prototype, name, {
        get: () => record[name],
        enumerable: false,
        configurable: true,
      })
    }
    return new Payload()
  },
  frozen: (record) => Object.freeze({ ...record }),
  proxy: (record) =>
    new Proxy(
      {},
      {
        get: (_target, name) => Reflect.get(record, name),
        has: (_target, name) => name in record,
      },
    ),
  "strict proxy": (record) =>
    new Proxy(
      { ...record },
      {
        get: (target, name) => {
          if (typeof name === "string" && !(name in target)) {
            throw new Error(`strict proxy: no "${name}"`)
          }
          return Reflect.get(target, name)
        },
      },
    ),
  "Schema.Class instance": (record) => {
    const names = Object.keys(record)
    const id = JSON.stringify(names)
    let Given = classes.get(id)
    if (Given === undefined) {
      Given = HeadSchema.Class<object>("Given")(
        own(names.map((name) => [name, HeadSchema.Unknown] as const)) as HeadSchema.Struct.Fields,
      ) as unknown as new (
        props: object,
      ) => object
      classes.set(id, Given)
    }
    return new Given(record)
  },
}

/** One object holding each of `entries` as its own property. */
const own = (entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [name, value] of entries) {
    Object.defineProperty(out, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/** `text` with `name` written as {@link CONTROL}. */
export const asControl = (text: string, name: string) =>
  name === CONTROL ? text : text.split(name).join(CONTROL)

/** A value as text: own properties only, keys sorted, `name` written as {@link CONTROL}. */
export const canon = (value: unknown, name: string): string => {
  if (value === undefined) return "undefined"
  if (typeof value === "function") return `<function ${value.name}>`
  if (typeof value === "string") return JSON.stringify(asControl(value, name))
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((each) => canon(each, name)).join(",")}]`
  const entries = Object.keys(value).map(
    (key) => [asControl(key, name), canon((value as any)[key], name)] as const,
  )
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${held}`).join(",")}}`
}

const NOW = 1700000000000
const CENTER = { latitude: 37.7749, longitude: -122.4194 }

export interface GeoOutcome {
  readonly steps: Record<
    string,
    { readonly ok: boolean; readonly value?: string; readonly error?: string }
  >
  /** The commands each step sent, in order. */
  readonly sentBy: Record<string, ReadonlyArray<string>>
  /** Every request the steps sent, in order, the table's name written `T`. */
  readonly requests: ReadonlyArray<{ readonly command: string; readonly input: unknown }>
  readonly rows: ReadonlyArray<string>
}

const COMMANDS: Record<string, string> = {
  putItem: "PutItem",
  getItem: "GetItem",
  updateItem: "UpdateItem",
  query: "Query",
  scan: "Scan",
  transactWriteItems: "TransactWriteItems",
}

/** An error's tag and what it says: its message, or its cause's where it has none. */
const describe = (failure: any): string =>
  failure?._tag !== undefined
    ? `${failure._tag}: ${String(failure.message || (failure.cause?.message ?? failure.cause ?? "")).slice(0, 300)}`
    : `defect: ${String(failure?.message ?? failure).slice(0, 300)}`

/** Runs `shape` under `name` against `api` on a table of its own at `endpoint`. */
export const captureGeo = (
  api: GeoApi,
  endpoint: string,
  tableName: string,
  as: Shape,
  name: string,
): Promise<GeoOutcome> => {
  const { Effect, Exit, Cause, Layer, Schema } = api
  const optional = Schema.optional(Schema.String)
  const Element = Schema.Struct(
    own([
      ["e", Schema.String],
      [name, optional],
    ]),
  )
  const Vehicles = api.Entity.make({
    model: Schema.Struct(
      own([
        ["vehicleId", Schema.String],
        ["latitude", Schema.Number],
        ["longitude", Schema.Number],
        ["timestamp", Schema.Number],
        ["cell", optional],
        ["parentCell", optional],
        ["timePartition", optional],
        [name, optional],
        [
          "inner",
          Schema.Struct(
            own([
              ["k", Schema.String],
              [name, Schema.String],
            ]),
          ),
        ],
        [
          "u",
          Schema.Union([
            Schema.Struct(
              own([
                ["kind", Schema.Literal("a")],
                [name, Schema.String],
              ]),
            ),
            Schema.Struct({ kind: Schema.Literal("b"), n: Schema.Number }),
          ]),
        ],
        ["deep", Schema.Struct({ s: Schema.suspend(() => Element) })],
      ]),
    ),
    entityType: "Vehicle",
    primaryKey: {
      pk: { field: "pk", composite: ["vehicleId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byCell: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["parentCell", "timePartition"] },
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
  const input = (id: string, offset: number) =>
    as(
      own([
        ["vehicleId", id],
        ["latitude", CENTER.latitude + offset],
        ["longitude", CENTER.longitude],
        ["timestamp", NOW],
        [name, `${id}-top`],
        [
          "inner",
          as(
            own([
              ["k", id],
              [name, `${id}-inner`],
            ]),
          ),
        ],
        [
          "u",
          as(
            own([
              ["kind", "a"],
              [name, `${id}-u`],
            ]),
          ),
        ],
        [
          "deep",
          as(
            own([
              [
                "s",
                as(
                  own([
                    ["e", id],
                    [name, `${id}-deep`],
                  ]),
                ),
              ],
            ]),
          ),
        ],
      ]),
    ) as any
  const steps: ReadonlyArray<readonly [string, () => any]> = [
    ["put", () => VehicleGeo.put(input("v1", 0)).asEffect()],
    [
      "enrich, then put in a transaction",
      () => api.Transaction.transactWrite([Vehicles.put(VehicleGeo.enrich(input("v2", 0.001)))]),
    ],
    [
      "nearby",
      () =>
        VehicleGeo.nearby({
          center: CENTER,
          radius: 1000,
          unit: "m",
          timeWindow: { start: NOW - 1000, end: NOW + 1000 },
        }).pipe(
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
    requests.length = 0
    for (const [label, run] of steps) {
      const before = requests.length
      const exit = yield* Effect.exit(Effect.suspend(run))
      sentBy[label] = requests.slice(before).map((request) => request.command)
      out[label] = Exit.isSuccess(exit)
        ? { ok: true, value: canon(exit.value, name) }
        : { ok: false, error: describe(Cause.squash(exit.cause)) }
    }
    const sent = [...requests]
    const scanned: any = yield* raw.scan({ TableName: tableName, ConsistentRead: true })
    const rows = ((scanned.Items ?? []) as Array<unknown>).map((row) => canon(row, name)).sort()
    yield* raw.deleteTable({ TableName: tableName }).pipe(Effect.ignore)
    return { steps: out, sentBy, requests: sent, rows }
  }).pipe(Effect.provide(Layer.merge(client, Main.layer({ name: tableName }))))
  return Effect.runPromise(program)
}

/** Every read a counting getter saw since the step began, in order. */
const READS: Array<string> = []

/** The reads, as `name×count`, sorted. */
const counted = (): string =>
  [...READS.reduce((held, name) => held.set(name, (held.get(name) ?? 0) + 1), new Map())]
    .map(([name, count]) => `${name}×${count}`)
    .sort()
    .join(" ")

/** An object holding `record`'s entries as own enumerable getters that count each read. */
const countingGetters = (
  record: Record<string, unknown>,
  undeclared: "counted" | "throwing",
): any => {
  const out = {}
  for (const name of Object.keys(record)) {
    const value = record[name]
    Object.defineProperty(out, name, {
      get: () => {
        READS.push(name)
        return value
      },
      enumerable: true,
      configurable: true,
    })
  }
  Object.defineProperty(out, "undeclared", {
    get: () => {
      READS.push("undeclared")
      if (undeclared === "throwing") throw new Error("the undeclared getter was read")
      return "u"
    },
    enumerable: true,
    configurable: true,
  })
  return out
}

/** `value` as text, read once here: a getter that throws is said, not thrown. */
const settled = (value: unknown): string => {
  try {
    return canon(value, CONTROL)
  } catch (thrown) {
    return `unreadable: ${String((thrown as Error)?.message ?? thrown)}`
  }
}

/** How each undeclared getter behaves: counted, and throwing. */
export const UNDECLARED = ["counted", "throwing"] as const

/** What a copy probe saw since the step began. */
const SEEN: Array<string> = []

/**
 * A probe of the copy `enrich` makes: the object a caller gives holding `record`, `at` naming where
 * it sits, `filled` the names geo fills on it.
 */
type Make = (record: Record<string, unknown>, at: string, filled?: ReadonlyArray<string>) => object

interface Probe {
  readonly make: Make
  /** What it saw: each read counted (`name×n`, sorted), or each trap in order. */
  readonly telling: "counted" | "in order"
}

/** An object holding `record`'s entries as own enumerable getters, beside an undeclared one. */
const probeGetters = (
  record: Record<string, unknown>,
  at: string,
  read: (name: string, count: number) => void,
): object => {
  const out = {}
  for (const [name, value] of [...Object.entries(record), ["undeclared", "u"] as const]) {
    let count = 0
    Object.defineProperty(out, name, {
      get: () => {
        count++
        SEEN.push(`${at}.${name}`)
        read(name, count)
        return value
      },
      enumerable: true,
      configurable: true,
    })
  }
  return out
}

/** Each trap a proxy answers, said with the name it's asked about. */
const recordingTraps = (record: Record<string, unknown>, at: string): object => {
  const seen = (trap: string, name?: PropertyKey) =>
    SEEN.push(name === undefined ? `${at} ${trap}` : `${at} ${trap} ${String(name)}`)
  const handler: ProxyHandler<Record<PropertyKey, unknown>> = {}
  for (const trap of [
    "get",
    "has",
    "ownKeys",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "set",
    "defineProperty",
    "deleteProperty",
    "isExtensible",
  ] as const) {
    ;(handler as any)[trap] = (...args: Array<any>) => {
      seen(
        trap,
        trap === "ownKeys" || trap === "getPrototypeOf" || trap === "isExtensible"
          ? undefined
          : args[1],
      )
      return (Reflect as any)[trap](...args)
    }
  }
  return new Proxy({ ...record, undeclared: "u" }, handler)
}

/** `record`'s entries as own properties of an object inheriting each of `filled` from a throwing getter. */
const inheritingFilled = (
  record: Record<string, unknown>,
  at: string,
  filled: ReadonlyArray<string>,
): object => {
  const parent = {}
  for (const name of filled) {
    Object.defineProperty(parent, name, {
      get: () => {
        SEEN.push(`${at}.${name}`)
        throw new Error(`the inherited ${name} getter was read`)
      },
      enumerable: true,
      configurable: true,
    })
  }
  return Object.assign(Object.create(parent), own(Object.entries(record)))
}

/** The probes the core suite's copy paths run under (`effect-dynamodb/test/helpers/CopyPaths.ts`). */
export const PROBES: Readonly<Record<string, Probe>> = {
  "counting getters": {
    make: (record, at) => probeGetters(record, at, () => {}),
    telling: "counted",
  },
  "counting getters, an undeclared one throwing": {
    make: (record, at) =>
      probeGetters(record, at, (name) => {
        if (name === "undeclared") throw new Error(`${at}.undeclared was read`)
      }),
    telling: "counted",
  },
  "getters that throw on their second read": {
    make: (record, at) =>
      probeGetters(record, at, (name, count) => {
        if (count > 1) throw new Error(`${at}.${name} was read twice`)
      }),
    telling: "counted",
  },
  "a proxy recording each trap": {
    make: (record, at) => recordingTraps(record, at),
    telling: "in order",
  },
  "a proxy whose has trap throws": {
    make: (record, at) =>
      new Proxy(
        { ...record },
        {
          has: (_target, name) => {
            throw new Error(`the has trap was called for ${at}.${String(name)}`)
          },
        },
      ),
    telling: "counted",
  },
  "each name geo fills inherited from a throwing getter": {
    make: (record, at, filled = []) => inheritingFilled(record, at, filled),
    telling: "counted",
  },
}

/** What the probe saw, as `telling` says it. */
const told = (telling: Probe["telling"]): string =>
  telling === "in order"
    ? SEEN.join(", ")
    : [...SEEN.reduce((held, name) => held.set(name, (held.get(name) ?? 0) + 1), new Map())]
        .map(([name, count]) => `${name}×${count}`)
        .sort()
        .join(" ")

/**
 * The copy `enrich` makes of an input, against `api` on a table of its own at `endpoint`: an input
 * given to `put`, to `enrich`, and to `enrich` then the entity's put in a transaction, every object
 * in it at every depth made by `probe`. Each step's outcome carries what the probe saw.
 */
export const captureGeoCopies = (
  api: GeoApi,
  endpoint: string,
  tableName: string,
  probe: Probe,
): Promise<GeoOutcome> => {
  const { Effect, Exit, Cause, Layer, Schema } = api
  const optional = Schema.optional(Schema.String)
  const Vehicles = api.Entity.make({
    model: Schema.Struct({
      vehicleId: Schema.String,
      latitude: Schema.Number,
      longitude: Schema.Number,
      timestamp: Schema.Number,
      cell: optional,
      parentCell: optional,
      timePartition: optional,
      detail: Schema.Struct({ a: Schema.String, deeper: Schema.Struct({ b: Schema.String }) }),
      list: Schema.Array(Schema.Struct({ c: Schema.String })),
    }),
    entityType: "Vehicle",
    primaryKey: {
      pk: { field: "pk", composite: ["vehicleId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byCell: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["parentCell", "timePartition"] },
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
  const as = probe.make
  const input = (id: string, offset: number): any =>
    as(
      {
        vehicleId: id,
        latitude: CENTER.latitude + offset,
        longitude: CENTER.longitude,
        timestamp: NOW,
        detail: as({ a: "a", deeper: as({ b: "b" }, "input.detail.deeper") }, "input.detail"),
        list: [as({ c: "c" }, "input.list[0]")],
      },
      "input",
      ["cell", "parentCell", "timePartition"],
    )
  const steps: ReadonlyArray<readonly [string, () => any]> = [
    ["put", () => VehicleGeo.put(input("v1", 0)).asEffect()],
    ["enrich", () => Effect.sync(() => VehicleGeo.enrich(input("v2", 0.001)))],
    [
      "enrich, then put in a transaction",
      () => api.Transaction.transactWrite([Vehicles.put(VehicleGeo.enrich(input("v3", 0.002)))]),
    ],
  ]
  const base = api.DynamoClient.layer({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  })
  const requests: Array<{ readonly command: string; readonly input: unknown }> = []
  const recordingClient = Layer.effect(
    api.DynamoClient,
    Effect.gen(function* () {
      const client: any = yield* api.DynamoClient
      return new Proxy(client, {
        get: (target, key) => {
          const held = target[key]
          const command = typeof key === "string" ? COMMANDS[key] : undefined
          return typeof held === "function" && command !== undefined
            ? (sent: unknown, ...rest: Array<unknown>) => {
                requests.push({
                  command,
                  input: JSON.parse(
                    JSON.stringify(sent).split(JSON.stringify(tableName)).join('"T"'),
                  ),
                })
                return held.call(target, sent, ...rest)
              }
            : held
        },
      })
    }),
  )
  const program = Effect.gen(function* () {
    const raw: any = yield* api.DynamoClient
    yield* raw.createTable({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      ...api.Table.definition(Main),
    })
    const out: Record<string, GeoOutcome["steps"][string]> = {}
    const sentBy: Record<string, ReadonlyArray<string>> = {}
    requests.length = 0
    for (const [label, run] of steps) {
      SEEN.length = 0
      const before = requests.length
      let op: any
      let outcome: object
      try {
        op = run()
        const exit = yield* Effect.exit(Effect.suspend(() => op))
        const seen = told(probe.telling)
        outcome = Exit.isSuccess(exit)
          ? { value: settled(exit.value), seen }
          : { failed: describe(Cause.squash(exit.cause)), seen }
      } catch (thrown) {
        outcome = { thrown: describe(thrown), seen: told(probe.telling) }
      }
      sentBy[label] = requests.slice(before).map((request) => request.command)
      out[label] = { ok: true, value: JSON.stringify(outcome) }
    }
    const sent = [...requests]
    const scanned: any = yield* raw.scan({ TableName: tableName, ConsistentRead: true })
    const rows = ((scanned.Items ?? []) as Array<unknown>).map((row) => canon(row, CONTROL)).sort()
    yield* raw.deleteTable({ TableName: tableName }).pipe(Effect.ignore)
    return { steps: out, sentBy, requests: sent, rows }
  }).pipe(
    Effect.provide(
      Layer.merge(Layer.provide(recordingClient, base), Main.layer({ name: tableName })),
    ),
  )
  return Effect.runPromise(program)
}

/**
 * Geo's reads of a caller's objects, against `api` on a table of its own at `endpoint`: an input
 * given to `put`, to `enrich` and to `enrich` then the entity's put in a transaction, and `nearby`'s
 * options, center, time window and `pkFilter`, each an object of counting getters beside an
 * undeclared getter (counted, or throwing). Each step's outcome carries the names it read, each with
 * the number of reads.
 */
export const captureGeoReads = (
  api: GeoApi,
  endpoint: string,
  tableName: string,
  undeclared: (typeof UNDECLARED)[number],
): Promise<GeoOutcome> => {
  const { Effect, Exit, Cause, Layer, Schema } = api
  const optional = Schema.optional(Schema.String)
  const Vehicles = api.Entity.make({
    model: Schema.Struct({
      fleet: Schema.String,
      vehicleId: Schema.String,
      latitude: Schema.Number,
      longitude: Schema.Number,
      timestamp: Schema.Number,
      note: optional,
      cell: optional,
      parentCell: optional,
      timePartition: optional,
    }),
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
  const counting = (record: Record<string, unknown>) => countingGetters(record, undeclared)
  const input = (id: string, offset: number) =>
    counting({
      fleet: "f",
      vehicleId: id,
      latitude: CENTER.latitude + offset,
      longitude: CENTER.longitude,
      timestamp: NOW,
      note: `${id}-note`,
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
          counting({
            center: counting({ latitude: CENTER.latitude, longitude: CENTER.longitude }),
            radius: 1000,
            unit: "m",
            timeWindow: counting({ start: NOW - 1000, end: NOW + 1000 }),
            pkFilter: counting({ fleet: "f" }),
          }),
        ).pipe(
          Effect.map((hits: ReadonlyArray<any>) =>
            [...hits].map((hit) => hit.item).sort((a, b) => (a.vehicleId < b.vehicleId ? -1 : 1)),
          ),
        ),
    ],
  ]
  const client = api.DynamoClient.layer({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  })
  const program = Effect.gen(function* () {
    const raw: any = yield* api.DynamoClient
    yield* raw.createTable({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      ...api.Table.definition(Main),
    })
    const out: Record<string, GeoOutcome["steps"][string]> = {}
    for (const [label, run] of steps) {
      READS.length = 0
      let op: any
      try {
        op = run()
      } catch (thrown) {
        out[label] = {
          ok: true,
          value: JSON.stringify({ thrown: describe(thrown), reads: counted() }),
        }
        continue
      }
      const exit = yield* Effect.exit(Effect.suspend(() => op))
      const reads = counted()
      out[label] = {
        ok: true,
        value: JSON.stringify(
          Exit.isSuccess(exit)
            ? { value: settled(exit.value), reads }
            : { failed: describe(Cause.squash(exit.cause)), reads },
        ),
      }
    }
    const scanned: any = yield* raw.scan({ TableName: tableName, ConsistentRead: true })
    const rows = ((scanned.Items ?? []) as Array<unknown>).map((row) => canon(row, CONTROL)).sort()
    yield* raw.deleteTable({ TableName: tableName }).pipe(Effect.ignore)
    return { steps: out, sentBy: {}, requests: [], rows }
  }).pipe(Effect.provide(Layer.merge(client, Main.layer({ name: tableName }))))
  return Effect.runPromise(program)
}
