/**
 * A name every object inherits (`constructor`, `toString`, `__proto__`, …) in every position a
 * definition or a payload can give one, run against DynamoDB Local (#239).
 *
 * Each position is a definition taking the name, and the steps that run it: define, put, get,
 * update, query, as each position has them. `capture` runs one position under one name against a
 * library given as a parameter, so one definition serves this source and the published releases.
 *
 * `test/fixtures/inherited-names-1.40.0.json` holds what published 1.40.0 did with each case;
 * `test/connected.inherited-names.test.ts` runs the same cases against this source.
 */

/** The library's public modules, and the `effect` it runs on, of whichever release is under test. */
export interface Api {
  readonly Aggregate: any
  readonly Batch: any
  readonly DynamoClient: any
  readonly DynamoModel: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly EventStore: any
  readonly Table: any
  readonly Transaction: any
  /** `effect-dynamodb/compression/zlib`. */
  readonly Zlib: any
  readonly Clock: any
  readonly Effect: any
  readonly Exit: any
  readonly Cause: any
  readonly Layer: any
  readonly Option: any
  readonly Schema: any
}

/** An ordinary name first, then every member of `Object.prototype`. */
export const NAMES = [
  "label",
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "hasOwnProperty",
  "__lookupGetter__",
  "__lookupSetter__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "__proto__",
  "toLocaleString",
] as const

/** The ordinary name every other name is compared with. */
export const CONTROL = "label"

/** The clock every case runs under, so stamps are the same in every run. */
export const NOW = 1700000000000

/** What a position's definition makes. */
export interface Built {
  readonly entities: Record<string, any>
  readonly aggregates?: Record<string, any>
  /** Event streams, run unbound. */
  readonly streams?: Record<string, any>
  /** Projections, run unbound. */
  readonly projections?: Record<string, any>
  /** The compressors the client is made with. */
  readonly compressors?: ReadonlyArray<unknown>
}

export interface Step {
  readonly label: string
  readonly run: (db: any, api: Api, built: Built) => unknown
}

export interface Position {
  readonly key: string
  readonly build: (
    api: Api,
    name: string,
    table: (members: { entities?: object; aggregates?: object }) => any,
  ) => Built
  readonly steps: (name: string) => ReadonlyArray<Step>
  /**
   * What the case does under `__proto__` where that isn't what it does under the ordinary name.
   * `refusedAt`: every row written would hold the name, and the definition is refused (`EDD-9152`
   * for an entity, `EDD-9153` for an aggregate). Otherwise, `refused`: the steps that would write
   * an attribute or a map entry of that name, each refused (`EDD-9165`) and writing nothing;
   * `differ`: the steps that do otherwise only because a refused write wrote nothing, each
   * `"ok: <value>"` or the tag of the error it fails with; `rows`: the rows afterwards, where those
   * differ for that reason. Every other step does what it does under the ordinary name.
   */
  readonly proto?: {
    readonly refusedAt?: "EDD-9152" | "EDD-9153"
    readonly refused?: ReadonlyArray<string>
    readonly differ?: Readonly<Record<string, string>>
    readonly rows?: ReadonlyArray<string>
  }
}

/** One object holding `name` as its own property, whatever the name (`__proto__` included). */
export const own = (
  entries: ReadonlyArray<readonly [string, unknown]>,
): Record<string, unknown> => {
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

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** `text` with `name`, in each casing a key or entity type gives it, written as {@link CONTROL}. */
export const asControl = (text: string, name: string): string =>
  name === CONTROL
    ? text
    : [name, name.toLowerCase(), capitalised(name)].reduce(
        (held, spelling, at) =>
          held.split(spelling).join([CONTROL, CONTROL.toLowerCase(), capitalised(CONTROL)][at]!),
        text,
      )

/**
 * A random UUID (an incarnation token) as `<uuid>`, and an event's random write token as
 * `<token>`, so one run's text is every run's.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g
const TOKEN = /\b[0-9a-f]{32}\b/g
const steady = (text: string) => text.replace(UUID, "<uuid>").replace(TOKEN, "<token>")

/**
 * A value as text, own properties only, keys sorted, `name` written as {@link CONTROL} wherever it
 * appears, a random UUID as `<uuid>`: what a case did, comparable with what the same case did under
 * the ordinary name.
 */
export const canon = (value: unknown, name: string): string => {
  if (value === undefined) return "undefined"
  if (typeof value === "function") return `<function ${value.name}>`
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "string") return JSON.stringify(steady(asControl(value, name)))
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((each) => canon(each, name)).join(",")}]`
  const entries = Object.keys(value).map(
    (key) => [asControl(key, name), canon((value as any)[key], name)] as const,
  )
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${held}`).join(",")}}`
}

const keyedBy = (composite: string) => ({
  pk: { field: "pk", composite: [composite] },
  sk: { field: "sk", composite: [] },
})

const lineModel = (api: Api) =>
  api.Schema.Struct({ lineId: api.Schema.String, f: api.Schema.Number })
const linesOf = (api: Api) =>
  api.Entity.make({ model: lineModel(api), entityType: "Line", primaryKey: keyedBy("lineId") })

const effectOf = (op: any) => (typeof op?.asEffect === "function" ? op.asEffect() : op)

// ---------------------------------------------------------------------------
// Entity positions
// ---------------------------------------------------------------------------

/** A model field. */
const field: Position = {
  key: "model field",
  proto: {
    refused: ["put with it", "set it", "put in a transaction", "put in a batch"],
    differ: {
      "get with it": "ItemNotFound",
      "condition on it": "ItemNotFound",
      "query filtered on it": "ok: []",
      "query selecting it": "ok: []",
      "remove it": "ItemNotFound",
      "get after": "ItemNotFound",
      "get in a transaction": "ok: [undefined]",
      "get in a batch": 'ok: [undefined,{"id":"b","note":"m"}]',
    },
    rows: [
      '{"__edd_e__":{"S":"Doc"},"gsi1pk":{"S":"$names#v1#doc#note_m"},"gsi1sk":{"S":"$names#v1#doc#id_b"},"id":{"S":"b"},"note":{"S":"m"},"pk":{"S":"$names#v1#doc#id_b"},"sk":{"S":"$names#v1#doc"}}',
    ],
  },
  build: (api, name) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct(
        own([
          ["id", Schema.String],
          [name, Schema.optional(Schema.String)],
          ["note", Schema.optional(Schema.String)],
        ]),
      ),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
      indexes: {
        byNote: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["note"] },
          sk: { field: "gsi1sk", composite: ["id"] },
        },
      },
    })
    return { entities: { Docs } }
  },
  steps: (name) => [
    {
      label: "put with it",
      run: (db) =>
        db.entities.Docs.put(
          own([
            ["id", "a"],
            [name, "v1"],
            ["note", "n"],
          ]),
        ),
    },
    {
      label: "put without it",
      run: (db) => db.entities.Docs.put({ id: "b", note: "n" }),
    },
    {
      label: "get with it",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "get without it",
      run: (db) => db.entities.Docs.get({ id: "b" }),
    },
    {
      label: "set it",
      run: (db) => db.entities.Docs.update({ id: "a" }).set(own([[name, "v2"]])),
    },
    {
      label: "set another field",
      run: (db) => db.entities.Docs.update({ id: "b" }).set({ note: "m" }),
    },
    {
      label: "condition on it",
      run: (db) =>
        db.entities.Docs.update({ id: "a" })
          .set({ note: "c" })
          .condition(own([[name, "v2"]])),
    },
    {
      label: "query filtered on it",
      run: (db) =>
        db.entities.Docs.byNote({ note: "c" })
          .filter(own([[name, "v2"]]))
          .collect(),
    },
    {
      label: "query selecting it",
      run: (db) => db.entities.Docs.byNote({ note: "c" }).select([name]).collect(),
    },
    {
      label: "remove it",
      run: (db) => db.entities.Docs.update({ id: "a" }).remove([name]),
    },
    {
      label: "get after",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "put in a transaction",
      run: (db, api) =>
        api.Transaction.transactWrite([
          db.entities.Docs.put(
            own([
              ["id", "t"],
              [name, "v3"],
              ["note", "t"],
            ]),
          ),
        ]),
    },
    {
      label: "get in a transaction",
      run: (db, api) => api.Transaction.transactGet([db.entities.Docs.get({ id: "t" })]),
    },
    {
      label: "put in a batch",
      run: (db, api) =>
        api.Batch.write([
          db.entities.Docs.put(
            own([
              ["id", "u"],
              [name, "v4"],
              ["note", "u"],
            ]),
          ),
        ]),
    },
    {
      label: "get in a batch",
      run: (db, api) =>
        api.Batch.get([db.entities.Docs.get({ id: "u" }), db.entities.Docs.get({ id: "b" })]),
    },
  ],
}

/** A field stored packed (`storedAs: DynamoModel.Packed(...)`). */
const packedField: Position = {
  key: "packed field",
  proto: {
    refused: ["put with it", "set it"],
    differ: {
      "get with it": "ItemNotFound",
      scan: 'ok: [{"id":"b","note":"m"}]',
    },
    rows: [
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"b"},"note":{"S":"m"},"pk":{"S":"$names#v1#doc#id_b"},"sk":{"S":"$names#v1#doc"}}',
    ],
  },
  build: (api, name) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: api.DynamoModel.configure(
        Schema.Struct(
          own([
            ["id", Schema.String],
            [name, Schema.optional(Schema.Struct({ a: Schema.Number }))],
            ["note", Schema.optional(Schema.String)],
          ]),
        ),
        own([[name, { storedAs: api.DynamoModel.Packed({ format: "json" }) }]]),
      ),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    return { entities: { Docs } }
  },
  steps: (name) => [
    {
      label: "put with it",
      run: (db) =>
        db.entities.Docs.put(
          own([
            ["id", "a"],
            [name, { a: 1 }],
          ]),
        ),
    },
    {
      label: "put without it",
      run: (db) => db.entities.Docs.put({ id: "b" }),
    },
    {
      label: "get with it",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "get without it",
      run: (db) => db.entities.Docs.get({ id: "b" }),
    },
    {
      label: "set it",
      run: (db) => db.entities.Docs.update({ id: "a" }).set(own([[name, { a: 2 }]])),
    },
    {
      label: "set another field",
      run: (db) => db.entities.Docs.update({ id: "b" }).set({ note: "m" }),
    },
    {
      label: "scan",
      run: (db) => db.entities.Docs.scan().collect(),
    },
  ],
}

/** A field stored under the name (`configure(..., { x: { field: name } })`). */
const renamedTo: Position = {
  key: "attribute a field is stored under",
  // The field is optional, so an item may be without the attribute: the definition loads, and a
  // write giving the field a value is refused (an update's `.set()` and `.add()` included, which
  // 1.40.0 sent, storing an attribute no read returns).
  proto: {
    refused: ["put with it", "set it", "add to it"],
    differ: {
      get: "ItemNotFound",
      "condition on it": "ItemNotFound",
      "scan filtered on it": "ok: []",
      "remove it": "ItemNotFound",
    },
    rows: [
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"b"},"note":{"S":"m"},"pk":{"S":"$names#v1#doc#id_b"},"sk":{"S":"$names#v1#doc"}}',
    ],
  },
  build: (api, name) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: api.DynamoModel.configure(
        Schema.Struct({
          id: Schema.String,
          x: Schema.optional(Schema.Number),
          note: Schema.optional(Schema.String),
        }),
        { x: { field: name } },
      ),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    return { entities: { Docs } }
  },
  steps: () => [
    {
      label: "put with it",
      run: (db) => db.entities.Docs.put({ id: "a", x: 1 }),
    },
    {
      label: "put without it",
      run: (db) => db.entities.Docs.put({ id: "b" }),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "set it",
      run: (db) => db.entities.Docs.update({ id: "a" }).set({ x: 2 }),
    },
    {
      label: "set another field",
      run: (db) => db.entities.Docs.update({ id: "b" }).set({ note: "m" }),
    },
    {
      label: "condition on it",
      run: (db) => db.entities.Docs.update({ id: "a" }).set({ note: "c" }).condition({ x: 2 }),
    },
    {
      label: "add to it",
      run: (db) => db.entities.Docs.update({ id: "a" }).add({ x: 1 }),
    },
    {
      label: "scan filtered on it",
      run: (db) => db.entities.Docs.scan().filter({ x: 3 }).collect(),
    },
    {
      label: "remove it",
      run: (db) => db.entities.Docs.update({ id: "a" }).remove(["x"]),
    },
  ],
}

/** A field of the name, stored under another attribute. */
const renamedFrom: Position = {
  key: "field stored under another attribute",
  build: (api, name) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: api.DynamoModel.configure(
        Schema.Struct(
          own([
            ["id", Schema.String],
            [name, Schema.optional(Schema.Number)],
            ["note", Schema.optional(Schema.String)],
          ]),
        ),
        own([[name, { field: "stored" }]]),
      ),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    return { entities: { Docs } }
  },
  steps: (name) => [
    {
      label: "put with it",
      run: (db) =>
        db.entities.Docs.put(
          own([
            ["id", "a"],
            [name, 1],
          ]),
        ),
    },
    {
      label: "put without it",
      run: (db) => db.entities.Docs.put({ id: "b" }),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "set it",
      run: (db) => db.entities.Docs.update({ id: "a" }).set(own([[name, 2]])),
    },
    {
      label: "set another field",
      run: (db) => db.entities.Docs.update({ id: "b" }).set({ note: "m" }),
    },
    {
      label: "condition on it",
      run: (db) =>
        db.entities.Docs.update({ id: "a" })
          .set({ note: "c" })
          .condition(own([[name, 2]])),
    },
    {
      label: "scan selecting it",
      run: (db) =>
        db.entities.Docs.scan()
          .filter(own([[name, 2]]))
          .select([name])
          .collect(),
    },
  ],
}

/** A sparse map's entry key. */
const sparseKey: Position = {
  key: "sparse map entry key",
  build: (api) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: api.DynamoModel.configure(
        Schema.Struct({ id: Schema.String, data: Schema.Record(Schema.String, Schema.Number) }),
        { data: { storedAs: api.DynamoModel.SparseMap() } },
      ),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    return { entities: { Docs } }
  },
  steps: (name) => [
    {
      label: "put with it",
      run: (db) =>
        db.entities.Docs.put({
          id: "a",
          data: own([
            [name, 1],
            ["ok", 2],
          ]),
        }),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "set the entry",
      run: (db) => db.entities.Docs.update({ id: "a" }).set(own([[`data#${name}`, 5]])),
    },
    {
      label: "add to the entry",
      run: (db) => db.entities.Docs.update({ id: "a" }).add(own([[`data#${name}`, 1]])),
    },
  ],
}

/** A path segment: a nested struct's field. */
const pathSegment: Position = {
  key: "path segment",
  proto: {
    refused: ["put with it", "pathSet", "pathAdd"],
    differ: {
      get: "ItemNotFound",
      "condition on the path": "ItemNotFound",
      "scan filtered on the path": "ok: []",
      pathRemove: "ItemNotFound",
    },
    rows: [
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"b"},"pk":{"S":"$names#v1#doc#id_b"},"sk":{"S":"$names#v1#doc"},"target":{"M":{"x":{"N":"1"}}}}',
    ],
  },
  build: (api, name) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        target: Schema.Struct(
          own([
            [name, Schema.optional(Schema.Number)],
            ["x", Schema.optional(Schema.Number)],
          ]),
        ),
      }),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    return { entities: { Docs } }
  },
  steps: (name) => [
    {
      label: "put without it",
      run: (db) => db.entities.Docs.put({ id: "b", target: { x: 1 } }),
    },
    {
      label: "put with it",
      run: (db) => db.entities.Docs.put({ id: "a", target: own([[name, 1]]) }),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "pathSet",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).pathSet({
          segments: ["target", name],
          value: 7,
          isPath: false,
        }),
    },
    {
      label: "pathAdd",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).pathAdd({ segments: ["target", name], value: 1 }),
    },
    {
      label: "condition on the path",
      run: (db) =>
        db.entities.Docs.update({ id: "a" })
          .pathSet({ segments: ["target", "x"], value: 2, isPath: false })
          .condition((t: any, { eq }: any) => eq(t.target[name], 8)),
    },
    {
      label: "scan filtered on the path",
      run: (db) =>
        db.entities.Docs.scan()
          .filter((t: any, { eq }: any) => eq(t.target[name], 8))
          .collect(),
    },
    {
      label: "pathRemove",
      run: (db) => db.entities.Docs.update({ id: "a" }).pathRemove(["target", name]),
    },
  ],
}

/** A path segment naming no field of the struct it's in: what a path to it does with any name. */
const undeclaredSegment: Position = {
  key: "path segment naming no field",
  build: (api) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        target: Schema.Struct({ x: Schema.optional(Schema.Number) }),
      }),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    return { entities: { Docs } }
  },
  steps: (name) => [
    {
      label: "put",
      run: (db) => db.entities.Docs.put({ id: "a", target: { x: 1 } }),
    },
    {
      label: "pathSet",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).pathSet({
          segments: ["target", name],
          value: 7,
          isPath: false,
        }),
    },
    {
      label: "pathAdd",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).pathAdd({ segments: ["target", name], value: 1 }),
    },
    {
      label: "pathRemove",
      run: (db) => db.entities.Docs.update({ id: "a" }).pathRemove(["target", name]),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
  ],
  // The stored struct is a map: the path writes an entry of it.
  proto: { refused: ["pathSet", "pathAdd"] },
}

/** A record's entry key: a `Schema.Record` field, on an item and in a time-series append. */
const recordKey: Position = {
  key: "record entry key",
  build: (api) => {
    const { Schema } = api
    const data = Schema.Record(Schema.String, Schema.Number)
    const Docs = api.Entity.make({
      model: Schema.Struct({ id: Schema.String, data }),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    const Readings = api.Entity.make({
      model: Schema.Struct({ id: Schema.String, at: Schema.Number, data }),
      entityType: "Reading",
      primaryKey: keyedBy("id"),
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({ id: Schema.String, at: Schema.Number, data }),
      },
    })
    return { entities: { Docs, Readings } }
  },
  steps: (name) => [
    {
      label: "put without it",
      run: (db) => db.entities.Docs.put({ id: "a", data: { ok: 2 } }),
    },
    {
      label: "put with it",
      run: (db) =>
        db.entities.Docs.put({
          id: "a",
          data: own([
            [name, 1],
            ["ok", 2],
          ]),
        }),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "set it",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).set({
          data: own([
            [name, 5],
            ["ok", 2],
          ]),
        }),
    },
    {
      label: "pathSet it",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).pathSet({
          segments: ["data", name],
          value: 7,
          isPath: false,
        }),
    },
    {
      label: "pathAdd to it",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).pathAdd({ segments: ["data", name], value: 1 }),
    },
    {
      label: "get after updates",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "condition holding it",
      run: (db) =>
        db.entities.Docs.update({ id: "a" })
          .pathSet({ segments: ["data", "ok"], value: 2, isPath: false })
          .condition((t: any, { eq }: any) =>
            eq(
              t.data,
              own([
                [name, 8],
                ["ok", 2],
              ]),
            ),
          ),
    },
    {
      label: "scan filtered holding it",
      run: (db) =>
        db.entities.Docs.scan()
          .filter((t: any, { eq }: any) =>
            eq(
              t.data,
              own([
                [name, 8],
                ["ok", 2],
              ]),
            ),
          )
          .collect(),
    },
    {
      label: "pathRemove it",
      run: (db) => db.entities.Docs.update({ id: "a" }).pathRemove(["data", name]),
    },
    {
      label: "create with it",
      run: (db) => db.entities.Docs.create({ id: "c", data: own([[name, 1]]) }),
    },
    {
      label: "upsert with it",
      run: (db) => db.entities.Docs.upsert({ id: "u", data: own([[name, 1]]) }),
    },
    {
      label: "put in a transaction with it",
      run: (db, api) =>
        api.Transaction.transactWrite([db.entities.Docs.put({ id: "t", data: own([[name, 1]]) })]),
    },
    {
      label: "put in a batch with it",
      run: (db, api) =>
        api.Batch.write([db.entities.Docs.put({ id: "w", data: own([[name, 1]]) })]),
    },
    {
      label: "delete what those wrote",
      run: (db, api) =>
        api.Effect.all(
          ["c", "u", "t", "w"].map((id) => effectOf(db.entities.Docs.delete({ id }))),
          { discard: true },
        ),
    },
    {
      label: "put a reading",
      run: (db) => db.entities.Readings.put({ id: "r", at: 1, data: { ok: 2 } }),
    },
    {
      label: "append with it",
      run: (db) => db.entities.Readings.append({ id: "r", at: 2, data: own([[name, 3]]) }),
    },
    {
      label: "get the reading",
      run: (db) => db.entities.Readings.get({ id: "r" }),
    },
    {
      label: "purge the reading",
      run: (db) => db.entities.Readings.purge({ id: "r" }),
    },
  ],
  proto: {
    refused: [
      "put with it",
      "set it",
      "pathSet it",
      "pathAdd to it",
      "condition holding it",
      "scan filtered holding it",
      "create with it",
      "upsert with it",
      "put in a transaction with it",
      "put in a batch with it",
      "append with it",
    ],
    differ: {
      get: 'ok: {"data":{"ok":2},"id":"a"}',
      "get after updates": 'ok: {"data":{"ok":2},"id":"a"}',
      "get the reading": 'ok: {"at":1,"data":{"ok":2},"id":"r"}',
    },
  },
}

const stampSteps = (): ReadonlyArray<Step> => [
  {
    label: "put",
    run: (db) => db.entities.Docs.put({ id: "a" }),
  },
  {
    label: "get",
    run: (db) => db.entities.Docs.get({ id: "a" }),
  },
  {
    label: "set",
    run: (db) => db.entities.Docs.update({ id: "a" }).set({ note: "x" }),
  },
  {
    label: "upsert",
    run: (db) => db.entities.Docs.upsert({ id: "c", note: "y" }),
  },
  {
    label: "get after",
    run: (db) => db.entities.Docs.get({ id: "c" }),
  },
]

const stamped =
  (which: "created" | "updated") =>
  (api: Api, name: string): { entities: Record<string, any> } => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String) }),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
      timestamps: which === "created" ? { created: name } : { updated: name },
    })
    return { entities: { Docs } }
  }

/** The created timestamp's name. */
const createdName: Position = {
  key: "created timestamp",
  proto: { refusedAt: "EDD-9152" },
  build: stamped("created"),
  steps: stampSteps,
}

/** The updated timestamp's name. */
const updatedName: Position = {
  key: "updated timestamp",
  proto: { refusedAt: "EDD-9152" },
  build: stamped("updated"),
  steps: stampSteps,
}

const versioned =
  (retain: boolean) =>
  (api: Api, name: string): { entities: Record<string, any> } => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String) }),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
      versioned: retain ? { field: name, retain: true } : { field: name },
    })
    return { entities: { Docs } }
  }

/** The version field's name. */
const versionName: Position = {
  key: "version field",
  proto: { refusedAt: "EDD-9152" },
  build: versioned(false),
  steps: () => [
    {
      label: "put",
      run: (db) => db.entities.Docs.put({ id: "a" }),
    },
    {
      label: "set",
      run: (db) => db.entities.Docs.update({ id: "a" }).set({ note: "x" }),
    },
    {
      label: "set at the expected version",
      run: (db) => db.entities.Docs.update({ id: "a" }).set({ note: "z" }).expectedVersion(2),
    },
    {
      label: "upsert",
      run: (db) => db.entities.Docs.upsert({ id: "c", note: "y" }),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
  ],
}

/** The version field's name, on an entity that keeps its versions. */
const retainedVersionName: Position = {
  key: "version field, versions retained",
  proto: { refusedAt: "EDD-9152" },
  build: versioned(true),
  steps: () => [
    {
      label: "put",
      run: (db) => db.entities.Docs.put({ id: "a" }),
    },
    {
      label: "set",
      run: (db) => db.entities.Docs.update({ id: "a" }).set({ note: "x" }),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
  ],
}

/** A key composite: the primary key's partition, and a secondary index's sort key. */
const composite: Position = {
  key: "key composite",
  proto: { refusedAt: "EDD-9152" },
  build: (api, name) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct(
        own([
          [name, Schema.String],
          ["kind", Schema.String],
          ["note", Schema.optional(Schema.String)],
        ]),
      ),
      entityType: "Doc",
      primaryKey: {
        pk: { field: "pk", composite: [name] },
        sk: { field: "sk", composite: ["kind"] },
      },
      indexes: {
        byKind: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["kind"] },
          sk: { field: "gsi1sk", composite: [name] },
        },
      },
    })
    return { entities: { Docs } }
  },
  steps: (name) => [
    {
      label: "put",
      run: (db) =>
        db.entities.Docs.put(
          own([
            [name, "a"],
            ["kind", "k"],
          ]),
        ),
    },
    {
      label: "get",
      run: (db) =>
        db.entities.Docs.get(
          own([
            [name, "a"],
            ["kind", "k"],
          ]),
        ),
    },
    {
      label: "set another field",
      run: (db) =>
        db.entities.Docs.update(
          own([
            [name, "a"],
            ["kind", "k"],
          ]),
        ).set({ note: "x" }),
    },
    {
      label: "query without it",
      run: (db) => db.entities.Docs.byKind({ kind: "k" }).collect(),
    },
    {
      label: "query with it",
      run: (db) =>
        db.entities.Docs.byKind(
          own([
            ["kind", "k"],
            [name, "a"],
          ]),
        ).collect(),
    },
    {
      label: "delete",
      run: (db) =>
        db.entities.Docs.delete(
          own([
            [name, "a"],
            ["kind", "k"],
          ]),
        ),
    },
    {
      label: "query after",
      run: (db) => db.entities.Docs.byKind({ kind: "k" }).collect(),
    },
  ],
}

/** A ref field: the entity it names is read and stored inline under the field's name. */
const entityRef: Position = {
  key: "ref field",
  proto: { refusedAt: "EDD-9152" },
  build: (api, name) => {
    const { Schema } = api
    const Line = Schema.Struct({
      lineId: Schema.String.pipe(api.DynamoModel.identifier),
      f: Schema.Number,
    })
    const Lines = api.Entity.make({
      model: Line,
      entityType: "Line",
      primaryKey: keyedBy("lineId"),
    })
    const Docs = api.Entity.make({
      model: Schema.Struct(
        own([
          ["id", Schema.String],
          [name, Line.pipe(api.DynamoModel.ref)],
        ]),
      ),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
      refs: own([[name, { entity: Lines }]]),
    })
    return { entities: { Lines, Docs } }
  },
  steps: (name) => [
    {
      label: "put the line",
      run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }),
    },
    {
      label: "put by id",
      run: (db) =>
        db.entities.Docs.put(
          own([
            ["id", "a"],
            [`${name}Id`, "L"],
          ]),
        ),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "put another line",
      run: (db) => db.entities.Lines.put({ lineId: "M", f: 3 }),
    },
    {
      label: "set it by id",
      run: (db) => db.entities.Docs.update({ id: "a" }).set(own([[`${name}Id`, "M"]])),
    },
    {
      label: "get after",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
  ],
}

// ---------------------------------------------------------------------------
// Aggregate positions
// ---------------------------------------------------------------------------

/** An aggregate over `root`, keyed by `id`, with `edges`. */
const aggregateOf = (
  api: Api,
  root: any,
  edges: Record<string, unknown>,
  table: (members: { entities?: object; aggregates?: object }) => any,
  entities: Record<string, any>,
) =>
  api.Aggregate.make(root, {
    table: table({ entities }),
    schema: api.DynamoSchema.make({ name: "names", version: 1 }),
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "root" },
    root: { entityType: "Root" },
    edges,
  })

/** A `one` edge's name. */
const oneEdge: Position = {
  key: "one edge",
  build: (api, name, table) => {
    const Lines = linesOf(api)
    const entities = { Lines }
    const Roots = aggregateOf(
      api,
      api.Schema.Struct(
        own([
          ["id", api.Schema.String],
          [name, lineModel(api)],
        ]),
      ),
      own([[name, api.Aggregate.one({ entityType: "RootLine", entity: Lines })]]),
      table,
      entities,
    )
    return { entities, aggregates: { Roots } }
  },
  steps: (name) => [
    {
      label: "put the line",
      run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }),
    },
    {
      label: "create by id",
      run: (db) =>
        db.aggregates.Roots.create(
          own([
            ["id", "a"],
            [`${name}Id`, "L"],
          ]),
        ),
    },
    {
      label: "get",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
    {
      label: "create whole, from JSON",
      run: (db) =>
        db.aggregates.Roots.create(
          JSON.parse(`{"id":"b",${JSON.stringify(name)}:{"lineId":"M","f":3}}`),
        ),
    },
    {
      label: "update",
      run: (db) =>
        db.aggregates.Roots.update({ id: "b" }, ({ state }: any) => ({
          ...state,
          ...own([[name, { lineId: "M", f: 4 }]]),
        })),
    },
    {
      label: "get after",
      run: (db) => db.aggregates.Roots.get({ id: "b" }),
    },
  ],
}

/** An optional `one` edge's name. */
const optionalOneEdge: Position = {
  key: "optional one edge",
  build: (api, name, table) => {
    const Lines = linesOf(api)
    const entities = { Lines }
    const Roots = aggregateOf(
      api,
      api.Schema.Struct(
        own([
          ["id", api.Schema.String],
          [name, api.Schema.optional(lineModel(api))],
        ]),
      ),
      own([[name, api.Aggregate.one({ entityType: "RootLine", entity: Lines })]]),
      table,
      entities,
    )
    return { entities, aggregates: { Roots } }
  },
  steps: (name) => [
    {
      label: "create without it",
      run: (db) => db.aggregates.Roots.create({ id: "a" }),
    },
    {
      label: "get without it",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
    {
      label: "put the line",
      run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }),
    },
    {
      label: "create by id",
      run: (db) =>
        db.aggregates.Roots.create(
          own([
            ["id", "b"],
            [`${name}Id`, "L"],
          ]),
        ),
    },
    {
      label: "get with it",
      run: (db) => db.aggregates.Roots.get({ id: "b" }),
    },
  ],
}

/** A `ref` edge's name: its entity is stored inline, under the edge's name. */
const refEdge: Position = {
  key: "ref edge",
  proto: { refusedAt: "EDD-9153" },
  build: (api, name, table) => {
    const Lines = linesOf(api)
    const entities = { Lines }
    const Roots = aggregateOf(
      api,
      api.Schema.Struct(
        own([
          ["id", api.Schema.String],
          [name, lineModel(api)],
        ]),
      ),
      own([[name, api.Aggregate.ref(Lines)]]),
      table,
      entities,
    )
    return { entities, aggregates: { Roots } }
  },
  steps: (name) => [
    {
      label: "put the line",
      run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }),
    },
    {
      label: "create by id",
      run: (db) =>
        db.aggregates.Roots.create(
          own([
            ["id", "a"],
            [`${name}Id`, "L"],
          ]),
        ),
    },
    {
      label: "get",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
  ],
}

/** A `many` edge's name. */
const manyEdge: Position = {
  key: "many edge",
  build: (api, name, table) => {
    const { Schema } = api
    const Note = Schema.Struct({ nid: Schema.String, text: Schema.String })
    const Roots = aggregateOf(
      api,
      Schema.Struct(
        own([
          ["id", Schema.String],
          [name, Schema.Array(Note)],
        ]),
      ),
      own([[name, api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } })]]),
      table,
      {},
    )
    return { entities: {}, aggregates: { Roots } }
  },
  steps: (name) => [
    {
      label: "create",
      run: (db) =>
        db.aggregates.Roots.create(
          own([
            ["id", "a"],
            [name, [{ nid: "n", text: "t" }]],
          ]),
        ),
    },
    {
      label: "update",
      run: (db) =>
        db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          ...own([
            [
              name,
              [
                { nid: "n", text: "t" },
                { nid: "o", text: "u" },
              ],
            ],
          ]),
        })),
    },
    {
      label: "get",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
  ],
}

/** An optional `many` edge's name. */
const optionalManyEdge: Position = {
  key: "optional many edge",
  build: (api, name, table) => {
    const { Schema } = api
    const Note = Schema.Struct({ nid: Schema.String, text: Schema.String })
    const Roots = aggregateOf(
      api,
      Schema.Struct(
        own([
          ["id", Schema.String],
          [name, Schema.optional(Schema.Array(Note))],
        ]),
      ),
      own([[name, api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } })]]),
      table,
      {},
    )
    return { entities: {}, aggregates: { Roots } }
  },
  steps: (name) => [
    {
      label: "create without it",
      run: (db) => db.aggregates.Roots.create({ id: "a" }),
    },
    {
      label: "get without it",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
    {
      label: "create with it, from JSON",
      run: (db) =>
        db.aggregates.Roots.create(
          JSON.parse(`{"id":"b",${JSON.stringify(name)}:[{"nid":"n","text":"t"}]}`),
        ),
    },
    {
      label: "get with it",
      run: (db) => db.aggregates.Roots.get({ id: "b" }),
    },
  ],
}

/** A sub-aggregate's name. */
const subAggregate: Position = {
  key: "sub-aggregate",
  build: (api, name, table) => {
    const { Schema } = api
    const Lines = linesOf(api)
    const Child = Schema.Struct({ cid: Schema.String, line: lineModel(api) })
    const Children = api.Aggregate.make(Child, {
      root: { entityType: "Child" },
      edges: { line: api.Aggregate.one({ entityType: "ChildLine", entity: Lines }) },
    })
    const entities = { Lines }
    const Roots = aggregateOf(
      api,
      Schema.Struct(
        own([
          ["id", Schema.String],
          [name, Child],
        ]),
      ),
      own([[name, Children.with({ discriminator: { slot: 1 } })]]),
      table,
      entities,
    )
    return { entities, aggregates: { Roots } }
  },
  steps: (name) => [
    {
      label: "put the line",
      run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }),
    },
    {
      label: "create, its line by id, from JSON",
      run: (db) =>
        db.aggregates.Roots.create(
          JSON.parse(`{"id":"a",${JSON.stringify(name)}:{"cid":"c","lineId":"L"}}`),
        ),
    },
    {
      label: "get",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
  ],
}

/** A sub-aggregate's discriminator: an attribute of each of its rows. */
const discriminator: Position = {
  key: "sub-aggregate discriminator",
  proto: { refusedAt: "EDD-9153" },
  build: (api, name, table) => {
    const { Schema } = api
    const Lines = linesOf(api)
    const Child = Schema.Struct({ cid: Schema.String, line: lineModel(api) })
    const Children = api.Aggregate.make(Child, {
      root: { entityType: "Child" },
      edges: { line: api.Aggregate.one({ entityType: "ChildLine", entity: Lines }) },
    })
    const entities = { Lines }
    const Roots = aggregateOf(
      api,
      Schema.Struct({ id: Schema.String, first: Child, second: Child }),
      {
        first: Children.with({ discriminator: own([[name, 1]]) }),
        second: Children.with({ discriminator: own([[name, 2]]) }),
      },
      table,
      entities,
    )
    return { entities, aggregates: { Roots } }
  },
  steps: () => [
    {
      label: "put the line",
      run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }),
    },
    {
      label: "create",
      run: (db) =>
        db.aggregates.Roots.create({
          id: "a",
          first: { cid: "c", lineId: "L" },
          second: { cid: "d", lineId: "L" },
        }),
    },
    {
      label: "get",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
    {
      label: "update",
      run: (db) =>
        db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          second: { ...state.second, cid: "e" },
        })),
    },
    {
      label: "get after",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
  ],
}

/** The field a `many` element holds its entity in, named after the entity's type. */
const elementEntityField: Position = {
  key: "many element's entity field",
  build: (api, name, table) => {
    const { Schema } = api
    const entityType = name === "__proto__" ? name : name.charAt(0).toUpperCase() + name.slice(1)
    const Lines = api.Entity.make({
      model: lineModel(api),
      entityType,
      primaryKey: keyedBy("lineId"),
    })
    const entities = { Lines }
    const Roots = aggregateOf(
      api,
      Schema.Struct({
        id: Schema.String,
        lines: Schema.Array(
          Schema.Struct({ lineId: Schema.String, f: Schema.Number, qty: Schema.Number }),
        ),
      }),
      {
        lines: api.Aggregate.many({
          entityType: "RootLine",
          entity: Lines,
          sk: { composite: ["lineId"] },
        }),
      },
      table,
      entities,
    )
    return { entities, aggregates: { Roots } }
  },
  steps: () => [
    {
      label: "create",
      run: (db) => db.aggregates.Roots.create({ id: "a", lines: [{ lineId: "L", f: 1, qty: 2 }] }),
    },
    {
      label: "get",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
  ],
}

/** A root field of an aggregate, stored on the root's row. */
const rootField: Position = {
  key: "aggregate root field",
  proto: {
    refused: ["create with it, from JSON"],
    differ: {
      "get with it": "AggregateAssemblyError",
      update: "AggregateAssemblyError",
    },
    rows: [
      '{"__edd_e__":{"S":"Root"},"id":{"S":"a"},"pk":{"S":"$names#v1#root#a"},"sk":{"S":"$names#v1#root"}}',
    ],
  },
  build: (api, name, table) => {
    const { Schema } = api
    const Roots = aggregateOf(
      api,
      Schema.Struct(
        own([
          ["id", Schema.String],
          [name, Schema.optional(Schema.String)],
          ["notes", Schema.Array(Schema.Struct({ nid: Schema.String }))],
        ]),
      ),
      { notes: api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } }) },
      table,
      {},
    )
    return { entities: {}, aggregates: { Roots } }
  },
  steps: (name) => [
    {
      label: "create without it",
      run: (db) => db.aggregates.Roots.create({ id: "a", notes: [] }),
    },
    {
      label: "get without it",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
    {
      label: "create with it, from JSON",
      run: (db) =>
        db.aggregates.Roots.create(
          JSON.parse(`{"id":"b",${JSON.stringify(name)}:"v","notes":[{"nid":"n"}]}`),
        ),
    },
    {
      label: "get with it",
      run: (db) => db.aggregates.Roots.get({ id: "b" }),
    },
    {
      label: "update",
      run: (db) =>
        db.aggregates.Roots.update({ id: "b" }, ({ state }: any) => ({
          ...state,
          notes: [{ nid: "m" }],
        })),
    },
  ],
}

/** A packed record's entry key: stored as JSON text, which keeps an entry under any key. */
const packedRecordKey: Position = {
  key: "packed record entry key",
  build: (api) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: api.DynamoModel.configure(
        Schema.Struct({ id: Schema.String, data: Schema.Record(Schema.String, Schema.Number) }),
        { data: { storedAs: api.DynamoModel.Packed({ format: "json" }) } },
      ),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    return { entities: { Docs } }
  },
  steps: (name) => [
    {
      label: "put with it",
      run: (db) =>
        db.entities.Docs.put({
          id: "a",
          data: own([
            [name, 1],
            ["ok", 2],
          ]),
        }),
    },
    {
      label: "get",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
    {
      label: "set it",
      run: (db) => db.entities.Docs.update({ id: "a" }).set({ data: own([[name, 3]]) }),
    },
    {
      label: "get after",
      run: (db) => db.entities.Docs.get({ id: "a" }),
    },
  ],
}

/** A record's entry key in an aggregate: on the root's row and on a `many` element's row. */
const aggregateRecordKey: Position = {
  key: "aggregate record entry key",
  build: (api, _name, table) => {
    const { Schema } = api
    const data = Schema.Record(Schema.String, Schema.Number)
    const Roots = aggregateOf(
      api,
      Schema.Struct({
        id: Schema.String,
        data,
        notes: Schema.Array(Schema.Struct({ nid: Schema.String, tags: data })),
      }),
      { notes: api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } }) },
      table,
      {},
    )
    return { entities: {}, aggregates: { Roots } }
  },
  steps: (name) => [
    {
      label: "create without it",
      run: (db) => db.aggregates.Roots.create({ id: "a", data: { ok: 2 }, notes: [] }),
    },
    {
      label: "create with it",
      run: (db) =>
        db.aggregates.Roots.create({
          id: "b",
          data: own([
            [name, 1],
            ["ok", 2],
          ]),
          notes: [],
        }),
    },
    {
      label: "update the root with it",
      run: (db) =>
        db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          data: own([
            [name, 3],
            ["ok", 2],
          ]),
        })),
    },
    {
      label: "update an element with it",
      run: (db) =>
        db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          notes: [{ nid: "n", tags: own([[name, 1]]) }],
        })),
    },
    {
      label: "get",
      run: (db) => db.aggregates.Roots.get({ id: "a" }),
    },
    {
      label: "update without it",
      run: (db) =>
        db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          data: { ok: 2 },
          notes: [],
        })),
    },
    {
      label: "delete what create wrote",
      run: (db, api) =>
        api.Effect.gen(function* () {
          // Nothing to delete where the create was refused: a delete of no aggregate fails.
          const found = yield* api.Effect.exit(db.aggregates.Roots.get({ id: "b" }))
          if (api.Exit.isSuccess(found)) yield* db.aggregates.Roots.delete({ id: "b" })
        }),
    },
  ],
  proto: {
    refused: ["create with it", "update the root with it", "update an element with it"],
    differ: {
      get: 'ok: {"data":{"ok":2},"id":"a","notes":[]}',
    },
  },
}

// ---------------------------------------------------------------------------
// An optional property the payload leaves out, in every place a value can hold one
// ---------------------------------------------------------------------------

/** A struct with an optional number under `name`, and a required `x`. */
const innerOf = (api: Api, name: string) =>
  api.Schema.Struct(
    own([
      [name, api.Schema.optional(api.Schema.Number)],
      ["x", api.Schema.Number],
    ]),
  )

/** A `Schema.Class` of {@link innerOf}'s fields. */
const innerClassOf = (api: Api, name: string) =>
  class Inner extends api.Schema.Class("Inner")(
    own([
      [name, api.Schema.optional(api.Schema.Number)],
      ["x", api.Schema.Number],
    ]),
  ) {}

/** An entity `Docs` keyed by `id`, its `data` field `data`, configured by `configure`. */
const docsWith = (api: Api, data: unknown, configure?: Record<string, unknown>) => {
  const model = api.Schema.Struct({ id: api.Schema.String, data })
  return api.Entity.make({
    model: configure === undefined ? model : api.DynamoModel.configure(model, configure),
    entityType: "Doc",
    primaryKey: keyedBy("id"),
  })
}

/**
 * A position whose `data` field holds the name as an optional property no step gives: put, read
 * back and updated as under any other name. `values` makes the field's three values, from the
 * name (for a step that gives it).
 */
const absent = (
  key: string,
  data: (api: Api, name: string) => unknown,
  values: (api: Api, name: string) => { readonly put: unknown; readonly set: unknown },
  options: {
    readonly configure?: (api: Api) => Record<string, unknown>
    readonly compressors?: (api: Api) => ReadonlyArray<unknown>
    /** A value giving the name, put as another item and read back. */
    readonly given?: (api: Api, name: string) => unknown
  } = {},
): Position => {
  // One field schema per case, so a value is made by the class it's checked against.
  let field: unknown
  return {
    key,
    build: (api, name) => {
      field = data(api, name)
      const Docs = docsWith(api, field, options.configure?.(api))
      return options.compressors === undefined
        ? { entities: { Docs } }
        : { entities: { Docs }, compressors: options.compressors(api) }
    },
    steps: (name) => [
      {
        label: "put",
        run: (db, api) => db.entities.Docs.put({ id: "a", data: values(api, name).put }),
      },
      { label: "get", run: (db) => db.entities.Docs.get({ id: "a" }) },
      {
        label: "set",
        run: (db, api) => db.entities.Docs.update({ id: "a" }).set({ data: values(api, name).set }),
      },
      { label: "get after", run: (db) => db.entities.Docs.get({ id: "a" }) },
      ...(options.given === undefined
        ? []
        : [
            {
              label: "put with it",
              run: (db: any, api: Api) =>
                db.entities.Docs.put({ id: "b", data: options.given!(api, name) }),
            },
            { label: "get with it", run: (db: any) => db.entities.Docs.get({ id: "b" }) },
          ]),
    ],
  }
}

/** The values of a field holding {@link innerOf}: `{ x: 1 }`, then `{ x: 2 }`. */
const plainValues = () => ({ put: { x: 1 }, set: { x: 2 } })

/** {@link innerOf}'s value giving the name. */
const givenInner = (_api: Api, name: string) =>
  own([
    [name, 5],
    ["x", 1],
  ])

const absentInStruct = absent("absent from a nested struct", innerOf, plainValues)

/** Each value built by the field's own class, as a caller builds one. */
let classMade: any
const absentInClass = absent(
  "absent from a class",
  (api, name) => {
    classMade = innerClassOf(api, name)
    return classMade
  },
  () => ({ put: new classMade({ x: 1 }), set: new classMade({ x: 2 }) }),
)

let checkedMade: any
const absentInCheckedClass = absent(
  "absent from a checked class with private state",
  (api, name) => {
    const Base = innerClassOf(api, name)
    class Checked extends Base {
      #valid = true
      valid() {
        return this.#valid
      }
    }
    checkedMade = Checked
    return (Checked as any).check(api.Schema.makeFilter((value: Checked) => value.valid()))
  },
  () => ({ put: new checkedMade({ x: 1 }), set: new checkedMade({ x: 2 }) }),
)

const absentInList = absent(
  "absent from a list's element",
  (api, name) => api.Schema.Array(innerOf(api, name)),
  () => ({ put: [{ x: 1 }], set: [{ x: 2 }, { x: 3 }] }),
)

const absentInRecord = absent(
  "absent from a record's value",
  (api, name) => api.Schema.Record(api.Schema.String, innerOf(api, name)),
  () => ({ put: { k: { x: 1 } }, set: { k: { x: 2 }, l: { x: 3 } } }),
)

const absentInOption = absent(
  "absent from an Option",
  (api, name) => api.Schema.Option(innerOf(api, name)),
  (api) => ({ put: api.Option.some({ x: 1 }), set: api.Option.some({ x: 2 }) }),
)

const absentInOptionFromNullOr = absent(
  "absent from an OptionFromNullOr",
  (api, name) => api.Schema.OptionFromNullOr(innerOf(api, name)),
  (api) => ({ put: api.Option.some({ x: 1 }), set: api.Option.some({ x: 2 }) }),
)

const absentInOptionList = absent(
  "absent from a list of Options",
  (api, name) => api.Schema.Array(api.Schema.Option(innerOf(api, name))),
  (api) => ({
    put: [api.Option.some({ x: 1 }), api.Option.none()],
    set: [api.Option.some({ x: 2 })],
  }),
)

const absentInUnion = absent(
  "absent from a union with a declaration",
  (api, name) => api.Schema.Union([innerOf(api, name), api.Schema.instanceOf(URL)]),
  plainValues,
)

const absentInJson = absent(
  "absent from JSON text",
  (api, name) => api.Schema.fromJsonString(innerOf(api, name)),
  plainValues,
  { given: givenInner },
)

const absentInPacked = absent("absent from a packed field", innerOf, plainValues, {
  configure: (api) => ({ data: { storedAs: api.DynamoModel.Packed({ format: "json" }) } }),
  given: givenInner,
})

const absentInCompressed = absent("absent from a packed, compressed field", innerOf, plainValues, {
  configure: (api) => ({
    data: {
      storedAs: api.DynamoModel.Packed({
        format: "json",
        compression: { codec: "gzip", threshold: 1 },
      }),
    },
  }),
  compressors: (api) => [api.Zlib.gzip()],
  given: givenInner,
})

let fallbackMade: any
const absentInFallback = absent(
  "absent from a plain object given for a class",
  (api, name) => {
    fallbackMade = innerClassOf(api, name)
    return fallbackMade
  },
  plainValues,
)

const absentInSparse = absent(
  "absent from a sparse map's value",
  (api, name) => api.Schema.Record(api.Schema.String, innerOf(api, name)),
  () => ({ put: { k: { x: 1 } }, set: { k: { x: 2 }, l: { x: 3 } } }),
  { configure: (api) => ({ data: { storedAs: api.DynamoModel.SparseMap() } }) },
)

/** Container path operations on a value holding the name as an optional property. */
const absentInPaths: Position = {
  key: "absent from a container a path writes",
  build: (api, name) => {
    const { Schema } = api
    const inner = innerOf(api, name)
    const Docs = api.Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        data: inner,
        list: Schema.Array(inner),
        other: Schema.optional(inner),
      }),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    return { entities: { Docs } }
  },
  steps: () => [
    {
      label: "put",
      run: (db) => db.entities.Docs.put({ id: "a", data: { x: 1 }, list: [{ x: 1 }] }),
    },
    {
      label: "pathSet",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).pathSet({
          segments: ["data"],
          value: { x: 2 },
          isPath: false,
        }),
    },
    {
      label: "pathAppend",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).pathAppend({ segments: ["list"], value: [{ x: 3 }] }),
    },
    {
      label: "pathIfNotExists",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).pathIfNotExists({
          segments: ["other"],
          value: { x: 4 },
        }),
    },
    { label: "get after", run: (db) => db.entities.Docs.get({ id: "a" }) },
  ],
}

/** An aggregate's root field, a `one` edge's entity's field and a `many` element's field. */
const absentInAggregate: Position = {
  key: "absent from an aggregate's root, edge and element",
  build: (api, name, table) => {
    const { Schema } = api
    const optional = [name, Schema.optional(Schema.Number)] as const
    const Line = Schema.Struct(own([["lineId", Schema.String], ["f", Schema.Number], optional]))
    const Lines = api.Entity.make({
      model: Line,
      entityType: "Line",
      primaryKey: keyedBy("lineId"),
    })
    const entities = { Lines }
    const Roots = aggregateOf(
      api,
      Schema.Struct(
        own([
          ["id", Schema.String],
          optional,
          ["line", Line],
          ["notes", Schema.Array(Schema.Struct(own([["nid", Schema.String], optional])))],
        ]),
      ),
      {
        line: api.Aggregate.one({ entityType: "RootLine", entity: Lines }),
        notes: api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } }),
      },
      table,
      entities,
    )
    return { entities, aggregates: { Roots } }
  },
  steps: () => [
    {
      label: "create",
      run: (db) =>
        db.aggregates.Roots.create({
          id: "a",
          line: { lineId: "L", f: 1 },
          notes: [{ nid: "n" }],
        }),
    },
    { label: "get", run: (db) => db.aggregates.Roots.get({ id: "a" }) },
    {
      label: "update",
      run: (db) =>
        db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          line: { ...state.line, f: 2 },
          notes: [...state.notes, { nid: "o" }],
        })),
    },
    { label: "get after", run: (db) => db.aggregates.Roots.get({ id: "a" }) },
  ],
}

/** An event stream's events, metadata and snapshot state. */
const absentInStream: Position = {
  key: "absent from an event stream's events, metadata and snapshot",
  build: (api, name, table) => {
    const { Schema } = api
    const optional = [name, Schema.optional(Schema.Number)] as const
    const Main = table({ entities: {} })
    const Events = api.EventStore.makeStream({
      table: Main,
      streamName: "Events",
      events: [Schema.Struct(own([["kind", Schema.String], ["n", Schema.Number], optional]))],
      metadata: Schema.Struct(own([["by", Schema.String], optional])),
      snapshot: { schema: Schema.Struct(own([["total", Schema.Number], optional])) },
      streamId: { composite: ["id"] },
    })
    return { entities: {}, streams: { Events } }
  },
  steps: (name) => [
    {
      label: "append",
      run: (_db, _api, built) =>
        built.streams!.Events.append({ id: "s" }, [{ kind: "added", n: 1 }], 0, {
          metadata: { by: "me" },
        }),
    },
    { label: "read", run: (_db, _api, built) => built.streams!.Events.read({ id: "s" }) },
    {
      label: "write a snapshot",
      run: (_db, _api, built) => built.streams!.Events.writeSnapshot({ id: "s" }, { total: 1 }, 1),
    },
    {
      label: "read the snapshot",
      run: (_db, _api, built) => built.streams!.Events.readSnapshot({ id: "s" }),
    },
    {
      label: "append with it",
      run: (_db, _api, built) =>
        built.streams!.Events.append(
          { id: "s" },
          [
            own([
              ["kind", "added"],
              ["n", 2],
              [name, 3],
            ]),
          ],
          1,
        ),
    },
  ],
  proto: {
    refused: ["append with it"],
    rows: [
      '{"__edd_e__":{"S":"events.event"},"__edd_wt__":{"S":"<token>"},"data":{"M":{"_tag":{"S":"Object"},"kind":{"S":"added"},"n":{"N":"1"}}},"eventType":{"S":"Object"},"metadata":{"M":{"by":{"S":"me"}}},"pk":{"S":"$names#v1#events#s"},"sk":{"S":"$names#v1#events.event_1#0000000001"},"streamId":{"S":"s"},"timestamp":{"S":"2023-11-14T22:13:20.000Z"},"version":{"N":"1"}}',
      '{"__edd_e__":{"S":"events.snapshot"},"asOfVersion":{"N":"1"},"pk":{"S":"$names#v1#events#s"},"sk":{"S":"$names#v1#events.snapshot"},"state":{"M":{"total":{"N":"1"}}},"streamId":{"S":"s"},"timestamp":{"S":"2023-11-14T22:13:20.000Z"}}',
    ],
  },
}

// ---------------------------------------------------------------------------
// An optional field so named, left out, in the positions a definition reads it from
// ---------------------------------------------------------------------------

/** A model of `id`, an optional `note`, and an optional string under `name`. */
const noteAnd = (api: Api, name: string) =>
  api.Schema.Struct(
    own([
      ["id", api.Schema.String],
      ["note", api.Schema.optional(api.Schema.String)],
      [name, api.Schema.optional(api.Schema.String)],
    ]),
  )

/**
 * A unique constraint's field, alone and beside another field; on an entity, a soft-deleting one,
 * one keeping its reservations when soft-deleted, and under a renamed field. Every path that
 * composes or releases a sentinel: a field left out holds no value, so it reserves nothing.
 */
const uniqueField: Position = {
  key: "unique field",
  proto: {
    refused: [
      "put with it",
      "put another with it",
      "set it",
      "put after",
      "soft: put with it",
      "kept: put with it",
    ],
    differ: {
      "delete with it": "ItemNotFound",
      "soft: delete with it": "ItemNotFound",
      "soft: restore with it": "ItemNotFound",
      "kept: delete with it": "ItemNotFound",
      "kept: restore with it": "ItemNotFound",
    },
    rows: [
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"b"},"note":{"S":"m"},"pk":{"S":"$names#v1#doc#id_b"},"sk":{"S":"$names#v1#doc"}}',
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"d"},"pk":{"S":"$names#v1#doc#id_d"},"sk":{"S":"$names#v1#doc"}}',
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"e"},"pk":{"S":"$names#v1#doc#id_e"},"sk":{"S":"$names#v1#doc"}}',
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"u"},"pk":{"S":"$names#v1#doc#id_u"},"sk":{"S":"$names#v1#doc"}}',
      '{"__edd_e__":{"S":"Renamed"},"id":{"S":"c"},"pk":{"S":"$names#v1#renamed#id_c"},"sk":{"S":"$names#v1#renamed"}}',
    ],
  },
  build: (api, name) => {
    const unique = (fields: Record<string, ReadonlyArray<string>>) => ({ unique: fields })
    const Docs = api.Entity.make({
      model: noteAnd(api, name),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
      ...unique({ byIt: [name], byPair: [name, "note"] }),
    })
    const Soft = api.Entity.make({
      model: noteAnd(api, name),
      entityType: "Soft",
      primaryKey: keyedBy("id"),
      softDelete: true,
      ...unique({ byIt: [name] }),
    })
    const Kept = api.Entity.make({
      model: noteAnd(api, name),
      entityType: "Kept",
      primaryKey: keyedBy("id"),
      softDelete: { preserveUnique: true },
      ...unique({ byIt: [name] }),
    })
    const Renamed = api.Entity.make({
      model: api.DynamoModel.configure(noteAnd(api, name), own([[name, { field: "held" }]])),
      entityType: "Renamed",
      primaryKey: keyedBy("id"),
      ...unique({ byIt: [name] }),
    })
    return { entities: { Docs, Soft, Kept, Renamed } }
  },
  steps: (name) => {
    const withIt = (id: string, value: string) =>
      own([
        ["id", id],
        [name, value],
      ])
    /** `op`, its failure tagged `tag` (and only that) returned as that tag, by name. */
    const refusedWith = (api: Api, op: any, tag: string) =>
      effectOf(op).pipe(api.Effect.catchTag(tag, (error: any) => api.Effect.succeed(error._tag)))
    const lifecycle = (entity: "Soft" | "Kept", label: string): ReadonlyArray<Step> => [
      { label: `${label}: put without it`, run: (db) => db.entities[entity].put({ id: "s" }) },
      { label: `${label}: put with it`, run: (db) => db.entities[entity].put(withIt("r", "v")) },
      {
        label: `${label}: delete without it`,
        run: (db) => db.entities[entity].delete({ id: "s" }),
      },
      {
        label: `${label}: restore without it`,
        run: (db) => db.entities[entity].restore({ id: "s" }),
      },
      { label: `${label}: delete with it`, run: (db) => db.entities[entity].delete({ id: "r" }) },
      { label: `${label}: restore with it`, run: (db) => db.entities[entity].restore({ id: "r" }) },
      { label: `${label}: purge without it`, run: (db) => db.entities[entity].purge({ id: "s" }) },
    ]
    return [
      { label: "put without it", run: (db) => db.entities.Docs.put({ id: "b", note: "n" }) },
      {
        label: "put another without it",
        run: (db) => db.entities.Docs.put({ id: "c", note: "n" }),
      },
      { label: "create without it", run: (db) => db.entities.Docs.create({ id: "d" }) },
      { label: "upsert without it", run: (db) => db.entities.Docs.upsert({ id: "e" }) },
      {
        label: "set another field",
        run: (db) => db.entities.Docs.update({ id: "b" }).set({ note: "m" }),
      },
      { label: "put with it", run: (db) => db.entities.Docs.put(withIt("a", "v")) },
      {
        label: "put another with it",
        run: (db, api) =>
          refusedWith(api, db.entities.Docs.put(withIt("f", "v")), "UniqueConstraintViolation"),
      },
      {
        label: "set it",
        run: (db) => db.entities.Docs.update({ id: "b" }).set(own([[name, "w"]])),
      },
      { label: "remove it", run: (db) => db.entities.Docs.update({ id: "b" }).remove([name]) },
      {
        label: "put in a transaction without it",
        run: (db, api) =>
          api.Transaction.transactWrite([
            db.entities.Docs.put({ id: "t" }),
            db.entities.Docs.put({ id: "u" }),
          ]),
      },
      {
        label: "delete in a transaction",
        run: (db, api) => api.Transaction.transactWrite([db.entities.Docs.delete({ id: "t" })]),
      },
      {
        label: "put in a batch without it",
        run: (db, api) =>
          refusedWith(api, api.Batch.write([db.entities.Docs.put({ id: "x" })]), "ValidationError"),
      },
      { label: "delete without it", run: (db) => db.entities.Docs.delete({ id: "c" }) },
      { label: "delete with it", run: (db) => db.entities.Docs.delete({ id: "a" }) },
      { label: "put after", run: (db) => db.entities.Docs.put(withIt("g", "v")) },
      ...lifecycle("Soft", "soft"),
      ...lifecycle("Kept", "kept"),
      { label: "renamed: put without it", run: (db) => db.entities.Renamed.put({ id: "b" }) },
      {
        label: "renamed: put another without it",
        run: (db) => db.entities.Renamed.put({ id: "c" }),
      },
      { label: "renamed: put with it", run: (db) => db.entities.Renamed.put(withIt("a", "v")) },
      { label: "renamed: delete without it", run: (db) => db.entities.Renamed.delete({ id: "b" }) },
      { label: "renamed: delete with it", run: (db) => db.entities.Renamed.delete({ id: "a" }) },
    ]
  },
}

/** A secondary index's sort key composite, optional, so the index is sparse. */
const indexSortComposite: Position = {
  key: "optional index sort composite",
  proto: {
    refused: ["put with it", "set it"],
    differ: {
      query: "ok: []",
      "query with it": "ok: []",
      "query after setting another field": "ok: []",
      "remove it": "ItemNotFound",
    },
    rows: [
      '{"__edd_e__":{"S":"Doc"},"gsi1pk":{"S":"$names#v1#doc#kind_k"},"id":{"S":"c"},"kind":{"S":"k"},"pk":{"S":"$names#v1#doc#id_c"},"sk":{"S":"$names#v1#doc"}}',
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"b"},"kind":{"S":"k"},"note":{"S":"x"},"pk":{"S":"$names#v1#doc#id_b"},"sk":{"S":"$names#v1#doc"}}',
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"d"},"kind":{"S":"k"},"pk":{"S":"$names#v1#doc#id_d"},"sk":{"S":"$names#v1#doc"}}',
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"t"},"kind":{"S":"k"},"pk":{"S":"$names#v1#doc#id_t"},"sk":{"S":"$names#v1#doc"}}',
      '{"__edd_e__":{"S":"Doc"},"id":{"S":"u"},"kind":{"S":"k"},"pk":{"S":"$names#v1#doc#id_u"},"sk":{"S":"$names#v1#doc"}}',
    ],
  },
  build: (api, name) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct(
        own([
          ["id", Schema.String],
          ["kind", Schema.String],
          [name, Schema.optional(Schema.String)],
          ["note", Schema.optional(Schema.String)],
        ]),
      ),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
      indexes: {
        byKind: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["kind"] },
          sk: { field: "gsi1sk", composite: [name] },
        },
      },
    })
    return { entities: { Docs } }
  },
  steps: (name) => {
    const query = (db: any) => db.entities.Docs.byKind({ kind: "k" }).collect()
    return [
      { label: "put without it", run: (db) => db.entities.Docs.put({ id: "b", kind: "k" }) },
      {
        label: "put with it",
        run: (db) =>
          db.entities.Docs.put(
            own([
              ["id", "a"],
              ["kind", "k"],
              [name, "v"],
            ]),
          ),
      },
      { label: "query", run: query },
      {
        label: "query with it",
        run: (db) =>
          db.entities.Docs.byKind(
            own([
              ["kind", "k"],
              [name, "v"],
            ]),
          ).collect(),
      },
      {
        label: "set another field",
        run: (db) => db.entities.Docs.update({ id: "b" }).set({ note: "x" }),
      },
      { label: "query after setting another field", run: query },
      {
        label: "set it",
        run: (db) => db.entities.Docs.update({ id: "b" }).set(own([[name, "w"]])),
      },
      { label: "remove it", run: (db) => db.entities.Docs.update({ id: "a" }).remove([name]) },
      { label: "query after", run: query },
      {
        label: "set it to undefined",
        run: (db) => db.entities.Docs.update({ id: "b" }).set(own([[name, undefined]])),
      },
      { label: "query after setting it to undefined", run: query },
      { label: "upsert without it", run: (db) => db.entities.Docs.upsert({ id: "c", kind: "k" }) },
      { label: "create without it", run: (db) => db.entities.Docs.create({ id: "d", kind: "k" }) },
      {
        label: "put in a transaction without it",
        run: (db, api) =>
          api.Transaction.transactWrite([db.entities.Docs.put({ id: "t", kind: "k" })]),
      },
      {
        label: "put in a batch without it",
        run: (db, api) => api.Batch.write([db.entities.Docs.put({ id: "u", kind: "k" })]),
      },
      { label: "query at the end", run: query },
    ]
  },
}

/**
 * The fields a projection keeps on its row: a single-source projection's checkpoint, and another's
 * revision; a multi-source projection's checkpoint map, and another's instance field. On rows each
 * writes, and on rows written before it.
 */
const projectionRowField: Position = {
  key: "projection row field",
  proto: { refusedAt: "EDD-9152" },
  build: (api, name, table) => {
    const { Schema } = api
    const rowModel = (extra: string) =>
      Schema.Struct(
        own([
          ["id", Schema.String],
          ["total", Schema.Number],
          [name, Schema.optional(Schema.Number)],
          [extra, Schema.optional(Schema.Number)],
        ]),
      )
    const Totals = api.Entity.make({
      model: rowModel("rev"),
      entityType: "Total",
      primaryKey: keyedBy("id"),
    })
    const Revised = api.Entity.make({
      model: rowModel("version"),
      entityType: "Revised",
      primaryKey: keyedBy("id"),
    })
    const Mapped = api.Entity.make({
      model: Schema.Struct(
        own([
          ["id", Schema.String],
          ["total", Schema.Number],
          [name, Schema.optional(Schema.Record(Schema.String, Schema.Number))],
          ["rev", Schema.optional(Schema.Number)],
        ]),
      ),
      entityType: "Mapped",
      primaryKey: keyedBy("id"),
    })
    const Owned = api.Entity.make({
      model: Schema.Struct(
        own([
          ["id", Schema.String],
          ["total", Schema.Number],
          ["at", Schema.optional(Schema.Number)],
          [name, Schema.optional(Schema.String)],
          ["rev", Schema.optional(Schema.Number)],
        ]),
      ),
      entityType: "Owned",
      primaryKey: keyedBy("id"),
    })
    const Main = table({ entities: { Totals, Revised, Mapped, Owned } })
    const Events = api.EventStore.makeStream({
      table: Main,
      streamName: "Events",
      events: [Schema.Struct({ kind: Schema.String, n: Schema.Number })],
      streamId: { composite: ["id"] },
    })
    const over = (readModel: unknown) => ({
      stream: Events,
      readModel,
      key: (id: { readonly id: string }) => ({ id: id.id }),
      initial: (id: { readonly id: string }) => ({ id: id.id, total: 0 }),
      evolve: (state: any, event: any) =>
        api.Effect.succeed({ ...state, total: state.total + event.data.n }),
    })
    const ByCheckpoint = api.EventStore.projection({ ...over(Totals), checkpoint: name })
    const ByRevision = api.EventStore.projection({
      ...over(Revised),
      checkpoint: "version",
      revision: name,
    })
    const multi = (readModel: unknown, checkpoints: unknown) =>
      api.EventStore.multiProjection({
        readModel,
        initial: (key: { readonly id: string }) => ({ id: key.id, total: 0 }),
        sources: (source: any) => ({
          main: source(Events, {
            key: (id: { readonly id: string }) => ({ id: id.id }),
            evolve: (state: any, event: any) =>
              api.Effect.succeed({ ...state, total: state.total + event.data.n }),
          }),
        }),
        checkpoints,
        revision: "rev",
      })
    const ByMap = multi(Mapped, { field: name })
    const ByOwner = multi(Owned, { sources: { main: { field: "at", instanceField: name } } })
    return {
      entities: { Totals, Revised, Mapped, Owned },
      streams: { Events },
      projections: { ByCheckpoint, ByRevision, ByMap, ByOwner },
    }
  },
  steps: () => {
    /** Every event of the stream `id`, to both projections. */
    const both = (api: Api, built: Built, id: string) =>
      api.Effect.gen(function* () {
        const events = yield* built.streams!.Events.read({ id })
        const checkpoint = yield* built.projections!.ByCheckpoint.applyBatch(events)
        const revision = yield* built.projections!.ByRevision.applyBatch(events)
        const tagged = events.map((event: unknown) => ({ stream: "main", event }))
        const map = yield* built.projections!.ByMap.applyBatch(tagged)
        const owner = yield* built.projections!.ByOwner.applyBatch(tagged)
        return { checkpoint, revision, map, owner }
      })
    return [
      {
        label: "put rows before the projection",
        run: (db, api) =>
          api.Effect.gen(function* () {
            yield* db.entities.Totals.put({ id: "q", total: 10 })
            yield* db.entities.Revised.put({ id: "q", total: 10 })
            yield* db.entities.Mapped.put({ id: "q", total: 10 })
            yield* db.entities.Owned.put({ id: "q", total: 10 })
          }),
      },
      {
        label: "append",
        run: (_db, _api, built) =>
          built.streams!.Events.append(
            { id: "p" },
            [
              { kind: "a", n: 1 },
              { kind: "a", n: 2 },
            ],
            0,
          ),
      },
      {
        label: "apply the first",
        run: (_db, api, built) =>
          api.Effect.gen(function* () {
            const [first] = yield* built.streams!.Events.read({ id: "p" })
            yield* built.projections!.ByCheckpoint.apply(first)
            yield* built.projections!.ByRevision.apply(first)
            yield* built.projections!.ByMap.applyBatch([{ stream: "main", event: first }])
            yield* built.projections!.ByOwner.applyBatch([{ stream: "main", event: first }])
          }),
      },
      { label: "apply all", run: (_db, api, built) => both(api, built, "p") },
      {
        label: "catch up",
        run: (_db, api, built) =>
          api.Effect.all([
            built.projections!.ByMap.catchUp({ id: "p" }),
            built.projections!.ByOwner.catchUp({ id: "p" }),
          ]),
      },
      {
        label: "rebuild",
        run: (_db, api, built) =>
          api.Effect.all([
            built.projections!.ByMap.rebuild({ id: "p" }, { instances: { main: [{ id: "p" }] } }),
            built.projections!.ByOwner.rebuild({ id: "p" }, { instances: { main: [{ id: "p" }] } }),
          ]),
      },
      {
        label: "get the rows",
        run: (db, api) =>
          api.Effect.all([
            db.entities.Totals.get({ id: "p" }),
            db.entities.Revised.get({ id: "p" }),
            db.entities.Mapped.get({ id: "p" }),
            db.entities.Owned.get({ id: "p" }),
          ]),
      },
      {
        label: "append to the rows written before",
        run: (_db, _api, built) =>
          built.streams!.Events.append({ id: "q" }, [{ kind: "a", n: 4 }], 0),
      },
      {
        label: "apply to the rows written before",
        run: (_db, api, built) => both(api, built, "q"),
      },
      {
        label: "get the rows written before",
        run: (db, api) =>
          api.Effect.all([
            db.entities.Totals.get({ id: "q" }),
            db.entities.Revised.get({ id: "q" }),
            db.entities.Mapped.get({ id: "q" }),
            db.entities.Owned.get({ id: "q" }),
          ]),
      },
    ]
  },
}

/** An aggregate's context field: a root field every row beneath the root carries. */
const contextField: Position = {
  key: "aggregate context field",
  proto: {
    refused: ["create with it, from JSON"],
    differ: {
      "get with it": "AggregateAssemblyError",
      "update with it": "AggregateAssemblyError",
      "get after": "AggregateAssemblyError",
    },
    rows: [
      '{"__edd_e__":{"S":"Root"},"id":{"S":"a"},"pk":{"S":"$names#v1#root#a"},"sk":{"S":"$names#v1#root"}}',
      '{"__edd_e__":{"S":"RootNote"},"nid":{"S":"m"},"pk":{"S":"$names#v1#root#a"},"sk":{"S":"$names#v1#rootnote#m"}}',
    ],
  },
  build: (api, name, table) => {
    const { Schema } = api
    const Roots = api.Aggregate.make(
      Schema.Struct(
        own([
          ["id", Schema.String],
          [name, Schema.optional(Schema.String)],
          ["notes", Schema.Array(Schema.Struct({ nid: Schema.String }))],
        ]),
      ),
      {
        table: table({ entities: {} }),
        schema: api.DynamoSchema.make({ name: "names", version: 1 }),
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "root" },
        root: { entityType: "Root" },
        context: [name],
        edges: {
          notes: api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } }),
        },
      },
    )
    return { entities: {}, aggregates: { Roots } }
  },
  steps: (name) => [
    {
      label: "create without it",
      run: (db) => db.aggregates.Roots.create({ id: "a", notes: [{ nid: "n" }] }),
    },
    { label: "get without it", run: (db) => db.aggregates.Roots.get({ id: "a" }) },
    {
      label: "update without it",
      run: (db) =>
        db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          notes: [{ nid: "m" }],
        })),
    },
    {
      label: "create with it, from JSON",
      run: (db) =>
        db.aggregates.Roots.create(
          JSON.parse(`{"id":"b",${JSON.stringify(name)}:"v","notes":[{"nid":"n"}]}`),
        ),
    },
    { label: "get with it", run: (db) => db.aggregates.Roots.get({ id: "b" }) },
    {
      label: "update with it",
      run: (db) =>
        db.aggregates.Roots.update({ id: "b" }, ({ state }: any) => ({
          ...state,
          notes: [{ nid: "o" }],
        })),
    },
    { label: "get after", run: (db) => db.aggregates.Roots.get({ id: "b" }) },
  ],
}

/** A sparse map's entry key, the map holding no entry under it. */
const sparseKeyLeftOut: Position = {
  key: "sparse map entry key, left out",
  build: (api) => sparseKey.build(api, CONTROL, () => undefined),
  steps: (name) => [
    { label: "put without it", run: (db) => db.entities.Docs.put({ id: "a", data: { ok: 2 } }) },
    { label: "get", run: (db) => db.entities.Docs.get({ id: "a" }) },
    {
      label: "set the map",
      run: (db) => db.entities.Docs.update({ id: "a" }).set({ data: { ok: 3, other: 4 } }),
    },
    { label: "get after", run: (db) => db.entities.Docs.get({ id: "a" }) },
    {
      label: "remove the entry",
      run: (db) => db.entities.Docs.update({ id: "a" }).removeEntries("data", [name]),
    },
    {
      label: "filter on the entry",
      run: (db) =>
        db.entities.Docs.scan()
          .filter(own([[`data#${name}`, 1]]))
          .collect(),
    },
    { label: "get at the end", run: (db) => db.entities.Docs.get({ id: "a" }) },
  ],
}

/**
 * The attribute a secondary index's partition key is stored under, the index sparse; and the
 * attribute a field is stored under, by `upsert`.
 */
const indexKeyAttribute: Position = {
  key: "index key attribute",
  proto: {
    refused: [
      "put with the composite",
      "set the composite",
      "upsert with the composite",
      "create with the composite",
      "put in a transaction",
      "put in a batch",
      "renamed: put with it",
      "renamed: upsert with it",
    ],
    differ: {
      get: "ItemNotFound",
      scan: 'ok: [{"id":"b"}]',
      "renamed: get": "ItemNotFound",
    },
    rows: [
      '{"__edd_e__":{"S":"Doc"},"gsi2sk":{"S":"$names#v1#doc"},"id":{"S":"b"},"pk":{"S":"$names#v1#doc#id_b"},"sk":{"S":"$names#v1#doc"}}',
      '{"__edd_e__":{"S":"Tag"},"id":{"S":"b"},"pk":{"S":"$names#v1#tag#id_b"},"sk":{"S":"$names#v1#tag"}}',
    ],
  },
  build: (api, name) => {
    const { Schema } = api
    const model = Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String) })
    const Docs = api.Entity.make({
      model,
      entityType: "Doc",
      primaryKey: keyedBy("id"),
      indexes: {
        byNote: {
          name: "gsi2",
          pk: { field: name, composite: ["note"] },
          sk: { field: "gsi2sk", composite: [] },
        },
      },
    })
    const Tags = api.Entity.make({
      model: api.DynamoModel.configure(model, { note: { field: name } }),
      entityType: "Tag",
      primaryKey: keyedBy("id"),
    })
    return { entities: { Docs, Tags } }
  },
  steps: () => [
    { label: "put without the composite", run: (db) => db.entities.Docs.put({ id: "b" }) },
    {
      label: "put with the composite",
      run: (db) => db.entities.Docs.put({ id: "a", note: "n" }),
    },
    { label: "get", run: (db) => db.entities.Docs.get({ id: "a" }) },
    {
      label: "set the composite",
      run: (db) => db.entities.Docs.update({ id: "b" }).set({ note: "m" }),
    },
    {
      label: "remove the composite",
      run: (db) => db.entities.Docs.update({ id: "b" }).remove(["note"]),
    },
    {
      label: "upsert with the composite",
      run: (db) => db.entities.Docs.upsert({ id: "c", note: "u" }),
    },
    {
      label: "create with the composite",
      run: (db) => db.entities.Docs.create({ id: "d", note: "c" }),
    },
    {
      label: "put in a transaction",
      run: (db, api) =>
        api.Transaction.transactWrite([db.entities.Docs.put({ id: "t", note: "t" })]),
    },
    {
      label: "put in a batch",
      run: (db, api) => api.Batch.write([db.entities.Docs.put({ id: "u", note: "u" })]),
    },
    { label: "scan", run: (db) => db.entities.Docs.scan().collect() },
    { label: "renamed: put without it", run: (db) => db.entities.Tags.put({ id: "b" }) },
    { label: "renamed: put with it", run: (db) => db.entities.Tags.put({ id: "a", note: "x" }) },
    {
      label: "renamed: upsert with it",
      run: (db) => db.entities.Tags.upsert({ id: "c", note: "y" }),
    },
    { label: "renamed: get", run: (db) => db.entities.Tags.get({ id: "a" }) },
  ],
}

/** A time-series entity's `orderBy` field: the current item's field and each event's sort key. */
const orderByField: Position = {
  key: "time-series orderBy",
  // A required field: every item written holds it.
  proto: { refusedAt: "EDD-9152" },
  build: (api, name) => {
    const { Schema } = api
    const fields = () =>
      own([
        ["id", Schema.String],
        [name, Schema.Number],
        ["value", Schema.optional(Schema.Number)],
      ])
    const Readings = api.Entity.make({
      model: Schema.Struct(fields()),
      entityType: "Reading",
      primaryKey: keyedBy("id"),
      timeSeries: { orderBy: name, appendInput: Schema.Struct(fields()) },
    })
    return { entities: { Readings } }
  },
  steps: (name) => {
    const at = (n: number, value: number) =>
      own([
        ["id", "a"],
        [name, n],
        ["value", value],
      ])
    const history = (db: any) => db.entities.Readings.history({ id: "a" })
    return [
      { label: "put", run: (db) => db.entities.Readings.put(at(1, 10)) },
      { label: "append", run: (db) => db.entities.Readings.append(at(2, 20)) },
      { label: "append another", run: (db) => db.entities.Readings.append(at(3, 30)) },
      {
        label: "append a stale one",
        run: (db, api) =>
          effectOf(db.entities.Readings.append(at(2, 99))).pipe(
            api.Effect.catchTag("StaleAppend", (error: any) => api.Effect.succeed(error._tag)),
          ),
      },
      { label: "get", run: (db) => db.entities.Readings.get({ id: "a" }) },
      { label: "history", run: (db) => history(db).collect() },
      {
        label: "history in range",
        run: (db) =>
          history(db)
            .where((t: any, { between }: any) => between(t[name], 2, 3))
            .collect(),
      },
      { label: "history, latest", run: (db) => history(db).reverse().limit(1).collect() },
      {
        label: "set another field",
        run: (db) => db.entities.Readings.update({ id: "a" }).set({ value: 5 }),
      },
      { label: "get after", run: (db) => db.entities.Readings.get({ id: "a" }) },
    ]
  },
}

/** A Z-order dimension: a field interleaved into a secondary index's binary sort key. */
const zorderDimension: Position = {
  key: "Z-order dimension",
  // A required field: every item written holds it.
  proto: { refusedAt: "EDD-9152" },
  build: (api, name) => {
    const { Schema } = api
    const Homes = api.Entity.make({
      model: Schema.Struct(
        own([
          ["id", Schema.String],
          ["region", Schema.String],
          [name, Schema.Number],
          ["price", Schema.Number],
        ]),
      ),
      entityType: "Home",
      primaryKey: keyedBy("id"),
      indexes: {
        search: {
          name: "zgsi",
          pk: { field: "zpk", composite: ["region"] },
          sk: {
            field: "zsk",
            zorder: [
              { field: name, min: 0, max: 100 },
              { field: "price", min: 0, max: 1000 },
            ],
          },
        },
      },
    })
    return { entities: { Homes } }
  },
  steps: (name) => {
    const home = (id: string, dimension: number, price: number) =>
      own([
        ["id", id],
        ["region", "r"],
        [name, dimension],
        ["price", price],
      ])
    const search = (db: any) => db.entities.Homes.search({ region: "r" })
    return [
      { label: "put a", run: (db) => db.entities.Homes.put(home("a", 10, 100)) },
      { label: "put b", run: (db) => db.entities.Homes.put(home("b", 40, 900)) },
      { label: "put c", run: (db) => db.entities.Homes.put(home("c", 90, 500)) },
      { label: "query", run: (db) => search(db).collect() },
      {
        label: "within it",
        run: (db) =>
          search(db)
            .within(own([[name, { between: [0, 50] }]]))
            .collect(),
      },
      {
        label: "within it and the price",
        run: (db) =>
          search(db)
            .within(
              own([
                [name, { gte: 30 }],
                ["price", { lte: 600 }],
              ]),
            )
            .collect(),
      },
      {
        label: "within the price",
        run: (db) =>
          search(db)
            .within({ price: { gte: 400 } })
            .collect(),
      },
      {
        label: "set it",
        run: (db) => db.entities.Homes.update({ id: "a" }).set(own([[name, 60]])),
      },
      {
        label: "within it after",
        run: (db) =>
          search(db)
            .within(own([[name, { gte: 50 }]]))
            .collect(),
      },
      {
        label: "set the price",
        run: (db) => db.entities.Homes.update({ id: "b" }).set({ price: 300 }),
      },
      { label: "query after", run: (db) => search(db).collect() },
    ]
  },
}

export const POSITIONS: ReadonlyArray<Position> = [
  field,
  packedField,
  renamedTo,
  renamedFrom,
  sparseKey,
  pathSegment,
  undeclaredSegment,
  recordKey,
  packedRecordKey,
  aggregateRecordKey,
  createdName,
  updatedName,
  versionName,
  retainedVersionName,
  composite,
  entityRef,
  rootField,
  oneEdge,
  optionalOneEdge,
  refEdge,
  manyEdge,
  optionalManyEdge,
  subAggregate,
  discriminator,
  elementEntityField,
  absentInStruct,
  absentInClass,
  absentInCheckedClass,
  absentInList,
  absentInRecord,
  absentInOption,
  absentInOptionFromNullOr,
  absentInOptionList,
  absentInUnion,
  absentInJson,
  absentInPacked,
  absentInCompressed,
  absentInFallback,
  absentInSparse,
  absentInPaths,
  absentInAggregate,
  absentInStream,
  uniqueField,
  indexSortComposite,
  projectionRowField,
  contextField,
  sparseKeyLeftOut,
  indexKeyAttribute,
  orderByField,
  zorderDimension,
]

// ---------------------------------------------------------------------------
// Running a case
// ---------------------------------------------------------------------------

/** A request the library sent, its table named `T`. */
export interface Sent {
  readonly command: string
  readonly input: unknown
}

export interface StepOutcome {
  readonly ok: boolean
  /** What it returned, as {@link canon} writes it, where it worked. */
  readonly value?: string
  /** How it failed: the error's tag and message, or the defect's text. */
  readonly error?: string
}

export interface Outcome {
  /** The definition's refusal, where `make` threw. */
  readonly refused?: string
  readonly steps: Record<string, StepOutcome>
  /** Every request the steps sent, in order. */
  readonly requests: ReadonlyArray<Sent>
  /** The commands each step sent, in order. */
  readonly sentBy?: Record<string, ReadonlyArray<string>>
  /** The table's rows afterwards, each as {@link canon} writes it, sorted. */
  readonly rows: ReadonlyArray<string>
  /** What each step's {@link Trace} took, where `capture` was given one. */
  readonly traces?: Record<string, ReadonlyArray<string>>
}

/**
 * What a run notes per step: `start` before the step is made (its builder called), `take` once it
 * has finished, before what it returned is read.
 */
export interface Trace {
  readonly start: () => void
  readonly take: () => ReadonlyArray<string>
}

/** The key a case is filed under. */
export const caseKey = (position: Position, name: string) => `${position.key}: ${name}`

/** Each step's requests: `requests` split by `sentBy`, whose steps are in the order they ran. */
export const requestsByStep = (outcome: Outcome): Record<string, ReadonlyArray<Sent>> => {
  const by: Record<string, ReadonlyArray<Sent>> = {}
  let at = 0
  for (const [label, commands] of Object.entries(outcome.sentBy ?? {})) {
    by[label] = outcome.requests.slice(at, at + commands.length)
    at += commands.length
  }
  return by
}

/** A probed step's outcome without what its probe saw (`reads`, `seen`). */
export const withoutReads = (step: StepOutcome | undefined): unknown => {
  if (step?.value === undefined) return step
  const { reads: _reads, seen: _seen, ...rest } = JSON.parse(step.value) as Record<string, unknown>
  return { ...step, value: rest }
}

/**
 * The traps `received` holds beside `recorded`'s, where it holds every one of those in order, else
 * `undefined`.
 */
export const trapsBeside = (
  received: ReadonlyArray<string>,
  recorded: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  const beside: Array<string> = []
  let at = 0
  for (const trap of received) {
    if (at < recorded.length && trap === recorded[at]) at++
    else beside.push(trap)
  }
  return at === recorded.length ? beside : undefined
}

const COMMANDS: Record<string, string> = {
  putItem: "PutItem",
  getItem: "GetItem",
  updateItem: "UpdateItem",
  deleteItem: "DeleteItem",
  query: "Query",
  scan: "Scan",
  batchGetItem: "BatchGetItem",
  batchWriteItem: "BatchWriteItem",
  transactWriteItems: "TransactWriteItems",
  transactGetItems: "TransactGetItems",
}

/** The request as sent, its table name made `T` and a random UUID `<uuid>` wherever they appear. */
const withTable = (input: unknown, tableName: string): unknown =>
  JSON.parse(steady(JSON.stringify(input).split(JSON.stringify(tableName)).join('"T"')))

/** An error's tag and what it says: its message, or its cause's where it has none. */
const describe = (failure: any): string =>
  failure?._tag !== undefined
    ? `${failure._tag}: ${String(failure.message || (failure.cause?.message ?? failure.cause ?? "")).slice(0, 400)}`
    : `defect: ${String(failure?.message ?? failure).slice(0, 400)}`

/**
 * Runs `position` under `name` against `api` on a table of its own at `endpoint`: what its
 * definition did, what each step returned, and every request it sent.
 */
export const capture = (
  api: Api,
  endpoint: string,
  tableName: string,
  position: Position,
  name: string,
  trace?: Trace,
): Promise<Outcome> => {
  const { Effect, Exit, Cause, Layer } = api
  const credentials = { accessKeyId: "local", secretAccessKey: "local" }
  const base = api.DynamoClient.layer({ region: "us-east-1", endpoint, credentials })
  const sent: Array<Sent> = []
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
                sent.push({ command, input: withTable(input, tableName) })
                return held.call(target, input, ...rest)
              }
            : held
        },
      })
    }),
  )
  const client = Layer.provide(recording, base)
  const schema = api.DynamoSchema.make({ name: "names", version: 1 })
  let built: Built
  let Main: any
  try {
    const tables: Array<any> = []
    built = position.build(api, name, (members) => {
      const table = api.Table.make({ schema, ...members })
      tables.push(table)
      return table
    })
    // An aggregate's table holds its entities; without one, the entities' own.
    Main =
      tables[0] ??
      api.Table.make({ schema, entities: built.entities, aggregates: built.aggregates ?? {} })
  } catch (error) {
    const refused = String((error as Error).message ?? error)
    return Promise.resolve({ refused, steps: {}, requests: [], rows: [] })
  }
  const clock = {
    currentTimeMillisUnsafe: () => NOW,
    currentTimeMillis: Effect.succeed(NOW),
    currentTimeNanosUnsafe: () => BigInt(NOW) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(NOW) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(NOW) * 1_000_000n,
    monotonicTimeNanos: Effect.succeed(BigInt(NOW) * 1_000_000n),
    sleep: () => Effect.void,
  }
  const program = Effect.gen(function* () {
    const raw: any = yield* api.DynamoClient
    yield* raw.createTable({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
        { AttributeName: "zpk", AttributeType: "S" },
        { AttributeName: "zsk", AttributeType: "B" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        // A Z-order index's sort key is binary.
        {
          IndexName: "zgsi",
          KeySchema: [
            { AttributeName: "zpk", KeyType: "HASH" },
            { AttributeName: "zsk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    })
    const steps: Record<string, StepOutcome> = {}
    const sentBy: Record<string, ReadonlyArray<string>> = {}
    const traces: Record<string, ReadonlyArray<string>> = {}
    const run = Effect.gen(function* () {
      const db: any = yield* api.DynamoClient.make({
        entities: built.entities,
        ...(built.aggregates === undefined ? {} : { aggregates: built.aggregates }),
        ...(built.compressors === undefined ? {} : { compressors: built.compressors }),
        tables: { Main },
      })
      sent.length = 0
      for (const step of position.steps(name)) {
        const before = sent.length
        trace?.start()
        const exit = yield* Effect.exit(Effect.suspend(() => effectOf(step.run(db, api, built))))
        if (trace !== undefined) traces[step.label] = trace.take()
        sentBy[step.label] = sent.slice(before).map((request) => request.command)
        steps[step.label] = Exit.isSuccess(exit)
          ? { ok: true, value: canon(exit.value, name) }
          : { ok: false, error: describe(Cause.squash(exit.cause)) }
      }
    })
    const made = yield* Effect.exit(run)
    const requests = [...sent]
    const scanned: any = yield* raw.scan({ TableName: tableName, ConsistentRead: true })
    const rows = ((scanned.Items ?? []) as Array<unknown>).map((row) => canon(row, name)).sort()
    yield* raw.deleteTable({ TableName: tableName }).pipe(Effect.ignore)
    const traced = trace === undefined ? {} : { traces }
    return Exit.isSuccess(made)
      ? { steps, requests, sentBy, rows, ...traced }
      : { refused: describe(Cause.squash(made.cause)), steps, requests, sentBy, rows, ...traced }
  }).pipe(
    Effect.provideService(api.Clock.Clock, clock),
    Effect.provide(Main.layer({ name: tableName })),
    Effect.provide(client),
  )
  return Effect.runPromise(program) as Promise<Outcome>
}
