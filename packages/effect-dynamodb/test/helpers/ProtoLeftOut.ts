/**
 * A field named `__proto__` a write leaves out, or gives a value that stores nothing (#239), run
 * against DynamoDB Local.
 *
 * 1.40.0 built the structs it derives from a model (an entity's payload and record schemas, an
 * aggregate's rebuilt structs) by assignment, and assigning `__proto__` set the map's prototype, so
 * the field wasn't in them: a payload leaving it out was taken, and a value given was lost. These
 * positions pin that a write leaving it out, or giving `undefined`, a `None` encoded `undefined` or
 * an empty set, does what 1.40.0 did (`test/fixtures/proto-left-out-1.40.0.json`), and that a value
 * storing something is refused (`EDD-9165`) with nothing sent. Each value has an item of its own.
 *
 * And an event naming no event type (an object without a prototype, no `_tag`): 1.40.0's append
 * died before sending anything; it is refused, and the stream reads as before.
 */

import { type Api, type Built, own, type Position, type Step } from "./InheritedNames.js"

/** How a write gives the field. */
export type Kind = "left out" | "nothing" | "value"

const LEFT_OUT: unique symbol = Symbol.for("effect-dynamodb/test/proto-left-out")

interface Value {
  readonly label: string
  readonly kind: Kind
  readonly value: (api: Api) => unknown
}

interface Encoding {
  readonly name: string
  readonly field: (api: Api) => unknown
  readonly values: ReadonlyArray<Value>
}

const leftOut: Value = { label: "left out", kind: "left out", value: () => LEFT_OUT }

const UNDEFINED_OR: Encoding = {
  name: "UndefinedOr",
  field: (api) => api.Schema.UndefinedOr(api.Schema.Number),
  values: [
    leftOut,
    { label: "undefined", kind: "nothing", value: () => undefined },
    { label: "a number", kind: "value", value: () => 5 },
  ],
}

const OPTION: Encoding = {
  name: "OptionFromUndefinedOr",
  field: (api) => api.Schema.OptionFromUndefinedOr(api.Schema.Number),
  values: [
    leftOut,
    { label: "none", kind: "nothing", value: (api) => api.Option.none() },
    { label: "some", kind: "value", value: (api) => api.Option.some(5) },
  ],
}

const SET: Encoding = {
  name: "an optional set",
  field: (api) => api.Schema.optional(api.Schema.ReadonlySet(api.Schema.String)),
  values: [
    leftOut,
    { label: "an empty set", kind: "nothing", value: () => new Set<string>() },
    { label: "a set", kind: "value", value: () => new Set(["s"]) },
  ],
}

/** `None` encoded `null`, which stores something. */
const OPTION_NULL: Encoding = {
  name: "OptionFromOptionalNullOr, None encoded null",
  field: (api) => api.Schema.OptionFromOptionalNullOr(api.Schema.Number, { onNoneEncoding: null }),
  values: [leftOut],
}

/** The kind a step's label names, `undefined` for a read. */
export const kindOf = (label: string): Kind | undefined =>
  /\[(left out|nothing|value)\]$/.exec(label)?.[1] as Kind | undefined

/** `entries`, and `__proto__` given as `value` unless it's left out. */
const withProto = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  value: unknown,
): Record<string, unknown> =>
  own([...entries, ...(value === LEFT_OUT ? [] : [["__proto__", value] as const])])

const protoStruct = (
  api: Api,
  encoding: Encoding,
  entries: ReadonlyArray<readonly [string, unknown]>,
) => api.Schema.Struct(own([...entries, ["__proto__", encoding.field(api)]]))

const keyedBy = (composite: string) => ({
  pk: { field: "pk", composite: [composite] },
  sk: { field: "sk", composite: [] },
})

/** Each value through each operation, then a read of what it wrote. */
const eachValue = (
  encoding: Encoding,
  operations: ReadonlyArray<{
    readonly name: string
    readonly before?: (at: number) => Step["run"]
    readonly write: (at: number, value: unknown) => Step["run"]
    readonly read: (at: number) => Step["run"]
  }>,
): ReadonlyArray<Step> =>
  operations.flatMap((operation) =>
    encoding.values.flatMap((value, at): ReadonlyArray<Step> => {
      const label = `${operation.name}, ${value.label} [${value.kind}]`
      return [
        ...(operation.before === undefined
          ? []
          : [{ label: `${label}: the row before`, run: operation.before(at) }]),
        { label, run: (db, api, built) => operation.write(at, value.value(api))(db, api, built) },
        { label: `${label}: read back`, run: operation.read(at) },
      ]
    }),
  )

/** An entity's field: put, create, upsert, a transaction's put and a batch's put. */
const entityField = (encoding: Encoding): Position => ({
  key: `an entity's field, ${encoding.name}`,
  build: (api) => ({
    entities: {
      Docs: api.Entity.make({
        model: protoStruct(api, encoding, [
          ["id", api.Schema.String],
          ["x", api.Schema.Number],
        ]),
        entityType: "Doc",
        primaryKey: keyedBy("id"),
      }),
    },
  }),
  steps: () => {
    const row = (id: string, value: unknown) =>
      withProto(
        [
          ["id", id],
          ["x", 1],
        ],
        value,
      )
    const get = (prefix: string) => (at: number) => (db: any) =>
      db.entities.Docs.get({ id: `${prefix}${at}` })
    return eachValue(encoding, [
      {
        name: "put",
        write: (at, v) => (db) => db.entities.Docs.put(row(`p${at}`, v)),
        read: get("p"),
      },
      {
        name: "create",
        write: (at, v) => (db) => db.entities.Docs.create(row(`c${at}`, v)),
        read: get("c"),
      },
      {
        name: "upsert",
        write: (at, v) => (db) => db.entities.Docs.upsert(row(`u${at}`, v)),
        read: get("u"),
      },
      {
        name: "a transaction's put",
        write: (at, v) => (db, api) =>
          api.Transaction.transactWrite([db.entities.Docs.put(row(`t${at}`, v))]),
        read: get("t"),
      },
      {
        name: "a batch's put",
        write: (at, v) => (db, api) => api.Batch.write([db.entities.Docs.put(row(`b${at}`, v))]),
        read: get("b"),
      },
    ])
  },
})

const aggregateOf = (api: Api, root: unknown, table: Parameters<Position["build"]>[2]) =>
  api.Aggregate.make(root, {
    table: table({ entities: {} }),
    schema: api.DynamoSchema.make({ name: "names", version: 1 }),
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "root" },
    root: { entityType: "Root" },
    edges: {},
  })

/** An aggregate's `create` of each value, and an `update` giving it to one created without it. */
const aggregateSteps = (
  encoding: Encoding,
  input: (id: string, value: unknown) => Record<string, unknown>,
  updated: (state: any, value: unknown) => Record<string, unknown>,
): ReadonlyArray<Step> => {
  const get = (prefix: string) => (at: number) => (db: any) =>
    db.aggregates.Roots.get({ id: `${prefix}${at}` })
  return eachValue(encoding, [
    {
      name: "create",
      write: (at, v) => (db) => db.aggregates.Roots.create(input(`c${at}`, v)),
      read: get("c"),
    },
    {
      name: "update",
      before: (at) => (db) => db.aggregates.Roots.create(input(`u${at}`, LEFT_OUT)),
      write: (at, v) => (db) =>
        db.aggregates.Roots.update({ id: `u${at}` }, ({ state }: any) => updated(state, v)),
      read: get("u"),
    },
  ])
}

/** An aggregate root's own field. */
const aggregateRootField = (encoding: Encoding): Position => ({
  key: `an aggregate root's field, ${encoding.name}`,
  build: (api, _name, table): Built => ({
    entities: {},
    aggregates: {
      Roots: aggregateOf(
        api,
        protoStruct(api, encoding, [
          ["id", api.Schema.String],
          ["x", api.Schema.Number],
        ]),
        table,
      ),
    },
  }),
  steps: () =>
    aggregateSteps(
      encoding,
      (id, value) =>
        withProto(
          [
            ["id", id],
            ["x", 1],
          ],
          value,
        ),
      (state, value) =>
        withProto(
          [...Object.entries(state).filter(([key]) => key !== "__proto__"), ["x", 2]],
          value,
        ),
    ),
})

/** A property of an aggregate root's struct field. */
const aggregateStructProperty = (encoding: Encoding): Position => ({
  key: `a property of an aggregate root's struct field, ${encoding.name}`,
  build: (api, _name, table): Built => ({
    entities: {},
    aggregates: {
      Roots: aggregateOf(
        api,
        api.Schema.Struct({
          id: api.Schema.String,
          data: protoStruct(api, encoding, [["x", api.Schema.Number]]),
        }),
        table,
      ),
    },
  }),
  steps: () =>
    aggregateSteps(
      encoding,
      (id, value) => ({ id, data: withProto([["x", 1]], value) }),
      (state, value) => ({ ...state, data: withProto([["x", 2]], value) }),
    ),
})

/** Every position compared with 1.40.0. */
export const LEFT_OUT_POSITIONS: ReadonlyArray<Position> = [
  entityField(UNDEFINED_OR),
  entityField(OPTION),
  entityField(SET),
  aggregateRootField(OPTION),
  aggregateStructProperty(OPTION),
]

/**
 * Named, not reworked: an aggregate's field whose `None` is encoded `null`, left out of an
 * `update`. The state the update starts from holds it as `None`, which stores `null`, so the write
 * is refused (`EDD-9165`); 1.40.0's struct held no such field, so its `update` stored the row
 * without it.
 */
export const NULL_NONE_UPDATE: Position = {
  key: "an aggregate root's field, None encoded null, left out of an update",
  build: (api, _name, table): Built => ({
    entities: {},
    aggregates: {
      Roots: aggregateOf(
        api,
        protoStruct(api, OPTION_NULL, [
          ["id", api.Schema.String],
          ["x", api.Schema.Number],
        ]),
        table,
      ),
    },
  }),
  steps: () => [
    { label: "create", run: (db: any) => db.aggregates.Roots.create({ id: "a", x: 1 }) },
    {
      label: "update",
      run: (db: any) =>
        db.aggregates.Roots.update({ id: "a" }, ({ state }: any) =>
          own([...Object.entries(state).filter(([key]) => key !== "__proto__"), ["x", 2]]),
        ),
    },
    { label: "get", run: (db: any) => db.aggregates.Roots.get({ id: "a" }) },
  ],
}

/** An event naming no event type, appended to a stream holding one event. */
export const UNTYPED_EVENT: Position = {
  key: "an event naming no event type",
  build: (api, _name, table) => {
    const Main = table({ entities: {} })
    const Events = api.EventStore.makeStream({
      table: Main,
      streamName: "Events",
      events: [
        api.Schema.Struct({
          kind: api.Schema.Literals(["noted"]),
          note: api.Schema.optional(api.Schema.String),
        }),
      ],
      streamId: { composite: ["id"] },
    })
    return { entities: {}, streams: { Events } }
  },
  steps: () => [
    {
      label: "append a plain object",
      run: (_db, _api, built) =>
        built.streams!.Events.append({ id: "s" }, [{ kind: "noted", note: "first" }], 0),
    },
    {
      label: "append an object without a prototype",
      run: (_db, _api, built) =>
        built.streams!.Events.append(
          { id: "s" },
          [Object.assign(Object.create(null), { kind: "noted", note: "np" })],
          1,
        ),
    },
    { label: "read", run: (_db, _api, built) => built.streams!.Events.read({ id: "s" }) },
    {
      label: "currentVersion",
      run: (_db, _api, built) => built.streams!.Events.currentVersion({ id: "s" }),
    },
  ],
}
