/**
 * A caller's key or payload in every shape JavaScript gives an object, run against DynamoDB Local
 * (#239): a plain object, one made by `Object.create` (every field inherited), an instance of a class
 * whose fields are getters, a frozen object, and a proxy answering `get` and `has` over an empty
 * target. Each is read as `value[name]`, as a plain object is, wherever the library reads a key or a
 * payload: entity writes, reads, updates and deletes, `Batch`, `Transaction`, an index accessor, a
 * collection, `.history()`, an event stream's id, and an aggregate's key, root, sub-aggregate, `one`
 * edge and `many` element, ids to fetch included. A record argument (a condition, a filter,
 * `.add()`, `.subtract()`, `.append()`, `.within()`'s bounds) is read by its own entries, as 1.40.0
 * read it.
 *
 * A strict proxy (its entries its own, reading a name it doesn't hold throws, as a strict config or
 * environment object does) is read by the names it holds alone.
 *
 * Each position runs one shape through every step; `capture` (`InheritedNames.ts`) runs it against
 * a library given as a parameter. `test/fixtures/payload-shapes-1.40.0.json` holds what published
 * 1.40.0 did with each.
 */

import type { Api, Position, Step } from "./InheritedNames.js"

/** A shape: `record`, given as the shape gives an object. */
export type Shape = (record: Record<string, unknown>) => object

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
}

/** The shape every other is compared with. */
export const CONTROL_SHAPE = "plain"

const effectOf = (op: any) => (typeof op?.asEffect === "function" ? op.asEffect() : op)

const keyedBy = (composite: string) => ({
  pk: { field: "pk", composite: [composite] },
  sk: { field: "sk", composite: [] },
})

// ---------------------------------------------------------------------------
// Entity keys and payloads
// ---------------------------------------------------------------------------

const entities = (api: Api) => {
  const { Schema } = api
  const byLabel = (collection: string) => ({
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["label"] },
    sk: { field: "gsi1sk", composite: ["n"] },
    collection,
  })
  const Docs = api.Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      sort: Schema.String,
      label: Schema.String,
      n: Schema.Number,
      note: Schema.optional(Schema.String),
      tally: Schema.optional(Schema.Number),
      tags: Schema.optional(Schema.Array(Schema.String)),
    }),
    entityType: "Doc",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: ["sort"] },
    },
    indexes: { byLabel: byLabel("labelled") },
  })
  const Notes = api.Entity.make({
    model: Schema.Struct({ nid: Schema.String, label: Schema.String, n: Schema.Number }),
    entityType: "Note",
    primaryKey: keyedBy("nid"),
    indexes: { byLabel: byLabel("labelled") },
  })
  const reading = Schema.Struct({ id: Schema.String, at: Schema.Number, v: Schema.Number })
  const Readings = api.Entity.make({
    model: reading,
    entityType: "Reading",
    primaryKey: keyedBy("id"),
    timeSeries: { orderBy: "at", appendInput: reading },
  })
  return { Docs, Notes, Readings }
}

/**
 * The entity steps, a key or a payload given as `as` gives it, and a record argument (a condition,
 * a filter, `.add()`, `.subtract()`, `.append()`, `.within()`'s bounds) as `record` gives it.
 */
const entitySteps = (as: Shape, record: Shape): ReadonlyArray<Step> => [
  {
    label: "put",
    run: (db) => db.entities.Docs.put(as({ id: "a", sort: "s", label: "L", n: 1 })),
  },
  {
    label: "create",
    run: (db) => db.entities.Docs.create(as({ id: "c", sort: "s", label: "L", n: 2 })),
  },
  {
    label: "upsert",
    run: (db) => db.entities.Docs.upsert(as({ id: "u", sort: "s", label: "L", n: 3 })),
  },
  {
    label: "put a note",
    run: (db) => db.entities.Notes.put(as({ nid: "x", label: "L", n: 4 })),
  },
  { label: "get", run: (db) => db.entities.Docs.get(as({ id: "a", sort: "s" })) },
  {
    label: "update",
    run: (db) => db.entities.Docs.update(as({ id: "a", sort: "s" })).set({ note: "u" }),
  },
  {
    label: "set",
    run: (db) => db.entities.Docs.update({ id: "c", sort: "s" }).set(as({ note: "v", n: 5 })),
  },
  {
    label: "patch",
    run: (db) => db.entities.Docs.patch(as({ id: "u", sort: "s" })).set({ note: "w" }),
  },
  {
    label: "condition not met",
    run: (db) =>
      db.entities.Docs.update({ id: "a", sort: "s" })
        .set({ note: "z" })
        .condition(record({ note: "nope" })),
  },
  {
    label: "condition met",
    run: (db) =>
      db.entities.Docs.update({ id: "a", sort: "s" })
        .set({ tags: ["t"] })
        .condition(record({ note: "u" })),
  },
  {
    label: "delete, condition not met",
    run: (db) =>
      db.entities.Docs.delete({ id: "a", sort: "s" }).condition(record({ note: "nope" })),
  },
  {
    label: "add",
    run: (db) => db.entities.Docs.update({ id: "a", sort: "s" }).add(record({ tally: 2 })),
  },
  {
    label: "subtract",
    run: (db) => db.entities.Docs.update({ id: "a", sort: "s" }).subtract(record({ tally: 1 })),
  },
  {
    label: "append to a list",
    run: (db) => db.entities.Docs.update({ id: "a", sort: "s" }).append(record({ tags: ["x"] })),
  },
  {
    label: "filter",
    run: (db) =>
      db.entities.Docs.byLabel({ label: "L" })
        .filter(record({ note: "u" }))
        .collect(),
  },
  {
    label: "scan filtered",
    run: (db) =>
      db.entities.Docs.scan()
        .filter(record({ note: "w" }))
        .collect(),
  },
  {
    label: "collection filtered",
    run: (db) =>
      db.collections
        .labelled({ label: "L" })
        .filter(record({ n: 4 }))
        .collect(),
  },
  {
    label: "index accessor",
    run: (db) => db.entities.Docs.byLabel(as({ label: "L" })).collect(),
  },
  {
    label: "index accessor with its sort key",
    run: (db) => db.entities.Docs.byLabel(as({ label: "L", n: 1 })).collect(),
  },
  {
    label: "within",
    run: (db) =>
      db.entities.Docs.byLabel({ label: "L" })
        .within(record({ n: { between: [2, 5] } }))
        .collect(),
  },
  {
    label: "within pinned",
    run: (db) =>
      db.entities.Docs.byLabel({ label: "L" })
        .within(record({ n: record({ eq: 1 }) }))
        .collect(),
  },
  {
    label: "collection",
    run: (db) => db.collections.labelled(as({ label: "L" })).collect(),
  },
  {
    label: "batch get",
    run: (db, api) =>
      api.Batch.get([
        db.entities.Docs.get(as({ id: "a", sort: "s" })),
        db.entities.Notes.get(as({ nid: "x" })),
      ]),
  },
  {
    label: "transact get",
    run: (db, api) =>
      api.Transaction.transactGet([
        db.entities.Docs.get(as({ id: "a", sort: "s" })),
        db.entities.Notes.get(as({ nid: "x" })),
      ]),
  },
  {
    label: "transact write",
    run: (db, api) =>
      api.Transaction.transactWrite([
        db.entities.Docs.put(as({ id: "t", sort: "s", label: "L", n: 6 })),
        db.entities.Docs.delete(as({ id: "u", sort: "s" })),
      ]),
  },
  {
    label: "batch write",
    run: (db, api) =>
      api.Batch.write([
        db.entities.Docs.put(as({ id: "w", sort: "s", label: "L", n: 7 })),
        db.entities.Docs.delete(as({ id: "t", sort: "s" })),
      ]),
  },
  {
    label: "delete",
    run: (db) => db.entities.Docs.delete(as({ id: "c", sort: "s" })),
  },
  {
    label: "delete if exists",
    run: (db) => db.entities.Docs.deleteIfExists(as({ id: "a", sort: "s" })),
  },
  {
    label: "scan",
    run: (db) => db.entities.Docs.scan().collect(),
  },
  {
    label: "put a reading",
    run: (db) => db.entities.Readings.put(as({ id: "r", at: 1, v: 1 })),
  },
  {
    label: "append",
    run: (db) => db.entities.Readings.append(as({ id: "r", at: 2, v: 2 })),
  },
  {
    label: "history",
    run: (db) => db.entities.Readings.history(as({ id: "r" })).collect(),
  },
  {
    label: "append to a stream",
    run: (_db, _api, built) =>
      built.streams!.Events.append(as({ id: "s" }), [{ kind: "added", n: 1 }], 0),
  },
  {
    label: "read the stream",
    run: (_db, _api, built) => built.streams!.Events.read(as({ id: "s" })),
  },
]

const entityPositionOf = (key: string, as: Shape, record: Shape): Position => ({
  key,
  build: (api, _name, table) => {
    const { Schema } = api
    const members = entities(api)
    const Main = table({ entities: members })
    const Events = api.EventStore.makeStream({
      table: Main,
      streamName: "Events",
      events: [Schema.Struct({ kind: Schema.String, n: Schema.Number })],
      streamId: { composite: ["id"] },
    })
    return { entities: members, streams: { Events } }
  },
  steps: () => entitySteps(as, record),
})

/** The entity steps, each key, payload and record argument given as `as` gives it. */
export const entityPosition = (shape: string, as: Shape): Position =>
  entityPositionOf(`entity keys and payloads, ${shape}`, as, as)

/** The entity steps, each key and payload given in `shape`, each record argument plain. */
export const entityKeysPosition = (shape: string, as: Shape): Position =>
  entityPositionOf(`entity keys and payloads, ${shape}`, as, SHAPES.plain!)

/** The entity steps, each record argument given in `shape`, each key and payload plain. */
export const entityRecordsPosition = (shape: string, as: Shape): Position =>
  entityPositionOf(`entity records, ${shape}`, SHAPES.plain!, as)

// ---------------------------------------------------------------------------
// Aggregate keys and payloads
// ---------------------------------------------------------------------------

const aggregate = (api: Api, table: (members: { entities?: object }) => any) => {
  const { Schema } = api
  const Line = Schema.Struct({ lineId: Schema.String, f: Schema.Number })
  const Lines = api.Entity.make({ model: Line, entityType: "Line", primaryKey: keyedBy("lineId") })
  const Child = Schema.Struct({ cid: Schema.String, line: Line })
  const Children = api.Aggregate.make(Child, {
    root: { entityType: "Child" },
    edges: { line: api.Aggregate.one({ entityType: "ChildLine", entity: Lines }) },
  })
  const Root = Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    updatedAt: Schema.DateTimeUtcFromString,
    line: Line,
    child: Child,
    notes: Schema.Array(Schema.Struct({ nid: Schema.String, text: Schema.String })),
    items: Schema.Array(Schema.Struct({ line: Line, qty: Schema.Number })),
  })
  const entities = { Lines }
  const Roots = api.Aggregate.make(Root, {
    table: table({ entities }),
    schema: api.DynamoSchema.make({ name: "names", version: 1 }),
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "root" },
    root: { entityType: "Root" },
    timestamps: { updated: "updatedAt" },
    edges: {
      line: api.Aggregate.one({ entityType: "RootLine", entity: Lines }),
      child: Children.with({ discriminator: { slot: 1 } }),
      notes: api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } }),
      items: api.Aggregate.many({
        entityType: "RootItem",
        entity: Lines,
        sk: { composite: ["line.lineId"] },
      }),
    },
  })
  return { entities, aggregates: { Roots } }
}

/** A root to create, its parts as `parts` gives them. */
const rootInput = (
  id: string,
  parts: {
    readonly root?: Shape
    readonly line?: object
    readonly child?: object
    readonly note?: object
    readonly item?: object
  },
) => {
  const record = {
    id,
    title: "t",
    ...(parts.line === undefined ? { lineId: "L" } : { line: parts.line }),
    child: parts.child ?? { cid: "c", lineId: "L" },
    notes: [parts.note ?? { nid: "n", text: "x" }],
    items: [parts.item ?? { lineId: "L", qty: 2 }],
  }
  return parts.root === undefined ? record : parts.root(record)
}

const aggregateSteps = (as: Shape): ReadonlyArray<Step> => [
  { label: "put the lines", run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }) },
  {
    label: "create, the root shaped",
    run: (db) => db.aggregates.Roots.create(rootInput("r1", { root: as })),
  },
  {
    label: "create, the sub-aggregate shaped",
    run: (db) =>
      db.aggregates.Roots.create(rootInput("r2", { child: as({ cid: "c", lineId: "L" }) })),
  },
  {
    label: "create, the one edge shaped",
    run: (db) => db.aggregates.Roots.create(rootInput("r3", { line: as({ lineId: "L", f: 9 }) })),
  },
  {
    label: "create, a many element shaped",
    run: (db) => db.aggregates.Roots.create(rootInput("r4", { note: as({ nid: "n", text: "x" }) })),
  },
  {
    label: "create, a many element's entity id shaped",
    run: (db) => db.aggregates.Roots.create(rootInput("r5", { item: as({ lineId: "L", qty: 2 }) })),
  },
  {
    label: "create whole, every part shaped",
    run: (db) =>
      db.aggregates.Roots.create(
        as({
          id: "r6",
          title: "t",
          line: as({ lineId: "L", f: 9 }),
          child: as({ cid: "c", line: as({ lineId: "L", f: 9 }) }),
          notes: [as({ nid: "n", text: "x" })],
          items: [as({ line: as({ lineId: "L", f: 9 }), qty: 2 })],
        }),
      ),
  },
  ...["r1", "r2", "r3", "r4", "r5", "r6"].map(
    (id): Step => ({ label: `get ${id}`, run: (db) => db.aggregates.Roots.get({ id }) }),
  ),
  { label: "get, the key shaped", run: (db) => db.aggregates.Roots.get(as({ id: "r1" })) },
  {
    label: "update, the key shaped",
    run: (db) =>
      db.aggregates.Roots.update(as({ id: "r1" }), ({ state }: any) => ({ ...state, title: "u" })),
  },
  {
    label: "update, the result shaped",
    run: (db) =>
      db.aggregates.Roots.update({ id: "r2" }, ({ state }: any) => {
        const { updatedAt: _, ...rest } = state
        return as({ ...rest, title: "v", notes: [as({ nid: "m", text: "y" })] })
      }),
  },
  { label: "get r2 after", run: (db) => db.aggregates.Roots.get({ id: "r2" }) },
  { label: "delete, the key shaped", run: (db) => db.aggregates.Roots.delete(as({ id: "r3" })) },
  {
    label: "get r3 after",
    run: (db, api) => api.Effect.flip(effectOf(db.aggregates.Roots.get({ id: "r3" }))),
  },
]

export const aggregatePosition = (shape: string, as: Shape): Position => ({
  key: `aggregate keys and payloads, ${shape}`,
  build: (api, _name, table) => aggregate(api, table),
  steps: () => aggregateSteps(as),
})

export const SHAPE_POSITIONS: ReadonlyArray<{
  readonly shape: string
  readonly position: Position
}> = Object.entries(SHAPES).flatMap(([shape, as]) => [
  { shape, position: entityKeysPosition(shape, as) },
  { shape, position: aggregatePosition(shape, as) },
])

/**
 * A record argument in every shape: read by its own entries, as 1.40.0 read it (`Object.entries`),
 * so a shape whose entries aren't its own properties gives none.
 */
export const RECORD_POSITIONS: ReadonlyArray<{
  readonly shape: string
  readonly position: Position
}> = Object.entries(SHAPES).map(([shape, as]) => ({
  shape,
  position: entityRecordsPosition(shape, as),
}))

/** The position `position` is compared with: the same one, its payloads plain. */
export const controlOf = (position: Position): Position =>
  SHAPE_POSITIONS.find(
    (each) =>
      each.shape === CONTROL_SHAPE &&
      each.position.key.split(", ")[0] === position.key.split(", ")[0],
  )!.position

// ---------------------------------------------------------------------------
// Keys and records given by an object that throws for a name it doesn't hold
// ---------------------------------------------------------------------------

/** A class whose getters for `note` and `tally` throw, as a model loaded lazily does. */
class Unloaded {
  get note(): string {
    throw new Error("note is not loaded")
  }
  get tally(): number {
    throw new Error("tally is not loaded")
  }
}

/**
 * A key or a record argument given by an object that throws when asked for a name it doesn't hold:
 * a strict proxy, which doesn't claim the name (`in` is false), and an `Unloaded` holding the
 * record's entries as its own, whose class claims `note` and `tally` with getters that throw.
 */
export const UNHELD_SHAPES: Readonly<Record<string, Shape>> = {
  plain: SHAPES.plain!,
  "strict proxy": SHAPES["strict proxy"]!,
  "throwing getter": (record) =>
    Object.create(
      Unloaded.prototype,
      Object.fromEntries(
        Object.keys(record).map((name) => [
          name,
          { value: record[name], enumerable: true, writable: true, configurable: true },
        ]),
      ),
    ),
}

const zKey = { id: "z", sort: "s" }

const unheldSteps = (as: Shape): ReadonlyArray<Step> => [
  {
    label: "put",
    run: (db) =>
      db.entities.Docs.put({ id: "a", sort: "s", label: "L", n: 1, note: "u", tally: 1 }),
  },
  { label: "put b", run: (db) => db.entities.Docs.put({ id: "b", sort: "s", label: "L", n: 2 }) },
  {
    label: "put z",
    run: (db) => db.entities.Docs.put({ ...zKey, label: "Z", n: 0, tally: 1, tags: ["t"] }),
  },
  { label: "put a note", run: (db) => db.entities.Notes.put({ nid: "x", label: "L", n: 4 }) },
  // Keys: read by the composites each needs.
  { label: "get", run: (db) => db.entities.Docs.get(as({ id: "a", sort: "s" })) },
  {
    label: "update, the key",
    run: (db) => db.entities.Docs.update(as({ id: "a", sort: "s" })).set({ note: "v" }),
  },
  { label: "index accessor", run: (db) => db.entities.Docs.byLabel(as({ label: "L" })).collect() },
  {
    label: "index accessor with its sort key",
    run: (db) => db.entities.Docs.byLabel(as({ label: "L", n: 2 })).collect(),
  },
  {
    label: "within",
    run: (db) =>
      db.entities.Docs.byLabel({ label: "L" })
        .within(as({ n: { between: [1, 9] } }))
        .collect(),
  },
  { label: "collection", run: (db) => db.collections.labelled(as({ label: "L" })).collect() },
  {
    label: "batch get",
    run: (db, api) =>
      api.Batch.get([
        db.entities.Docs.get(as({ id: "a", sort: "s" })),
        db.entities.Notes.get(as({ nid: "x" })),
      ]),
  },
  {
    label: "transact get",
    run: (db, api) =>
      api.Transaction.transactGet([
        db.entities.Docs.get(as({ id: "a", sort: "s" })),
        db.entities.Notes.get(as({ nid: "x" })),
      ]),
  },
  {
    label: "transact write, a delete's key",
    run: (db, api) =>
      api.Transaction.transactWrite([db.entities.Docs.delete(as({ id: "b", sort: "s" }))]),
  },
  {
    label: "put b again",
    run: (db) => db.entities.Docs.put({ id: "b", sort: "s", label: "L", n: 2 }),
  },
  {
    label: "batch write, a delete's key",
    run: (db, api) => api.Batch.write([db.entities.Docs.delete(as({ id: "b", sort: "s" }))]),
  },
  {
    label: "put b once more",
    run: (db) => db.entities.Docs.put({ id: "b", sort: "s", label: "L", n: 2 }),
  },
  {
    label: "delete if exists, the key",
    run: (db) => db.entities.Docs.deleteIfExists(as({ id: "b", sort: "s" })),
  },
  // Records: read by their own entries. Each runs on `z`, deleted at the end.
  {
    label: "condition",
    run: (db) =>
      db.entities.Docs.update(zKey)
        .set({ n: 1 })
        .condition(as({ label: "Z" })),
  },
  {
    label: "delete, condition",
    run: (db) => db.entities.Docs.delete(zKey).condition(as({ label: "nope" })),
  },
  {
    label: "put, condition",
    run: (db) =>
      db.entities.Docs.put({ ...zKey, label: "Z", n: 2 }).condition(as({ label: "nope" })),
  },
  {
    label: "filter",
    run: (db) =>
      db.entities.Docs.byLabel({ label: "L" })
        .filter(as({ label: "L" }))
        .collect(),
  },
  {
    label: "scan filtered",
    run: (db) =>
      db.entities.Docs.scan()
        .filter(as({ label: "Z" }))
        .collect(),
  },
  {
    label: "collection filtered",
    run: (db) =>
      db.collections
        .labelled({ label: "L" })
        .filter(as({ n: 4 }))
        .collect(),
  },
  { label: "add", run: (db) => db.entities.Docs.update(zKey).add(as({ tally: 2 })) },
  { label: "subtract", run: (db) => db.entities.Docs.update(zKey).subtract(as({ tally: 1 })) },
  { label: "append", run: (db) => db.entities.Docs.update(zKey).append(as({ tags: ["x"] })) },
  // A payload: Effect's parser reads each field the model declares, as it did on 1.40.0.
  {
    label: "put, the parser reading every field",
    run: (db) => db.entities.Docs.put(as({ id: "c", sort: "s", label: "C", n: 3 })),
  },
  {
    label: "set, the parser reading every field",
    run: (db) => db.entities.Docs.update(zKey).set(as({ n: 9 })),
  },
  { label: "delete z", run: (db) => db.entities.Docs.delete(zKey) },
  { label: "delete c", run: (db) => db.entities.Docs.delete({ id: "c", sort: "s" }) },
  { label: "scan", run: (db) => db.entities.Docs.scan().collect() },
]

/** A position per {@link UNHELD_SHAPES} shape: keys and records given by an object that throws. */
export const UNHELD_POSITIONS: ReadonlyArray<{
  readonly shape: string
  readonly position: Position
}> = Object.entries(UNHELD_SHAPES).map(([shape, as]) => ({
  shape,
  position: {
    key: `keys and records, an object throwing for a name it doesn't hold, ${shape}`,
    build: (api, _name, table) => {
      const members = entities(api)
      table({ entities: members })
      return { entities: members }
    },
    steps: () => unheldSteps(as),
  },
}))
