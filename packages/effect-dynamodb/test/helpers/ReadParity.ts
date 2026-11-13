/**
 * What the library asks of a caller's object, trap by trap (#239): every key, payload and record a
 * caller hands in is a proxy recording each trap it receives (`get`, `has`, `ownKeys`,
 * `getOwnPropertyDescriptor`, `getPrototypeOf` and the rest), in order, step by step. A proxy over a
 * plain object holding the caller's values as its own properties answers as that object does, so
 * what it records is exactly what a run read of the object, and how.
 *
 * Each position runs its steps once with the top-level objects recording ("top") and once with
 * every nested plain object and list recording too ("deep"), its payloads holding ordinary names
 * ("ordinary") or names `Object.prototype` holds, given as the object's own properties ("named like
 * Object.prototype members"). The entry points: keys for `get`, `update`, `delete`, index accessors,
 * `.within()`, collections, `.history()`, versions, soft-deleted items, `Batch` and `Transaction`;
 * every record combinator (`set`, `add`, `subtract`, `append`, `remove`, `deleteFromSet`);
 * conditions, filters and selects; `put`, `create` and `upsert` inputs; an aggregate's inputs and
 * key; an event stream's id, events and metadata.
 *
 * `capture` (`InheritedNames.ts`) runs a position against a library given as a parameter;
 * `test/fixtures/read-parity-1.40.0.json` holds what published 1.40.0 did with each, on Effect
 * 4.1.3, and `connected.read-parity.test.ts` compares this source's run with it, trap for trap.
 */

import type { Api, Position, Step, Trace } from "./InheritedNames.js"

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

/** The traps whose first argument after the target is a property key. */
const KEYED = new Set<string>([
  "get",
  "set",
  "has",
  "deleteProperty",
  "getOwnPropertyDescriptor",
  "defineProperty",
])

const keyText = (key: unknown): string =>
  typeof key === "symbol" ? `[${key.description}]` : String(key)

/**
 * Makes an object of a caller's: `value`'s own properties (a list's elements), as a proxy recording
 * each trap it receives, tagged `tag`.
 */
export type Shaper = (tag: string, value: object) => object

/**
 * A recorder: `record` makes recording proxies, and `trace` takes, per step, what they recorded
 * between the step's start and its end.
 */
export const recorder = (): { readonly record: Shaper; readonly trace: Trace } => {
  let log: Array<string> | undefined
  const record: Shaper = (tag, value) => {
    const target: object = Array.isArray(value) ? [...value] : { ...value }
    const handler: ProxyHandler<object> = {}
    for (const trap of TRAPS) {
      ;(handler as Record<string, unknown>)[trap] = (held: object, ...args: Array<unknown>) => {
        log?.push(KEYED.has(trap) ? `${tag} ${trap} ${keyText(args[0])}` : `${tag} ${trap}`)
        return (Reflect as unknown as Record<string, (...all: Array<unknown>) => unknown>)[trap]!(
          held,
          ...args,
        )
      }
    }
    return new Proxy(target, handler)
  }
  const trace: Trace = {
    start: () => {
      log = []
    },
    take: () => {
      const taken = log ?? []
      log = undefined
      return taken
    },
  }
  return { record, trace }
}

/** The names a payload holds beside the model's ordinary fields. */
export interface Names {
  /** A top-level field of each model. */
  readonly a: string
  /** A field of a nested struct, a list element, an event's metadata. */
  readonly b: string
}

/**
 * Each ordinary name sorts among the model's other names where its counterpart does, so a run under
 * one set is the other's, name for name.
 */
export const NAME_SETS: Readonly<Record<string, Names>> = {
  ordinary: { a: "topic", b: "colour" },
  "named like Object.prototype members": { a: "toString", b: "constructor" },
}

export const VARIANTS = ["top", "deep"] as const
export type Variant = (typeof VARIANTS)[number]

/** The shapers a variant gives: `S` for what the caller hands in, `D` for what that holds. */
const shapers = (record: Shaper, variant: Variant) => ({
  S: record,
  D: variant === "deep" ? record : (_tag: string, value: object) => value,
})

const effectOf = (op: any) => (typeof op?.asEffect === "function" ? op.asEffect() : op)

const keyedBy = (composite: string) => ({
  pk: { field: "pk", composite: [composite] },
  sk: { field: "sk", composite: [] },
})

// ---------------------------------------------------------------------------
// Entities and event streams
// ---------------------------------------------------------------------------

const entities = (api: Api, N: Names) => {
  const { Schema } = api
  const Inner = Schema.Struct({
    x: Schema.optional(Schema.String),
    [N.b]: Schema.optional(Schema.String),
  } as never)
  const model = Schema.Struct({
    id: Schema.String,
    sort: Schema.String,
    label: Schema.String,
    n: Schema.Number,
    note: Schema.optional(Schema.String),
    tally: Schema.optional(Schema.Number),
    tags: Schema.optional(Schema.Array(Schema.String)),
    marks: Schema.optional(Schema.ReadonlySet(Schema.String)),
    [N.a]: Schema.optional(Schema.String),
    inner: Schema.optional(Inner),
  } as never)
  const primaryKey = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: ["sort"] },
  }
  const byLabel = {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["label"] },
    sk: { field: "gsi1sk", composite: ["n"] },
    collection: "labelled",
  }
  const Docs = api.Entity.make({
    model,
    entityType: "Doc",
    primaryKey,
    indexes: { byLabel },
  })
  const Notes = api.Entity.make({
    model: Schema.Struct({ nid: Schema.String, label: Schema.String, n: Schema.Number }),
    entityType: "Note",
    primaryKey: keyedBy("nid"),
    indexes: { byLabel },
  })
  const Kept = api.Entity.make({
    model,
    entityType: "Kept",
    primaryKey,
    versioned: { retain: true },
  })
  const Unique = api.Entity.make({
    model,
    entityType: "Unique",
    primaryKey,
    unique: { byNote: ["note"] },
    softDelete: true,
  })
  const reading = Schema.Struct({
    id: Schema.String,
    at: Schema.Number,
    v: Schema.Number,
    [N.a]: Schema.optional(Schema.String),
  } as never)
  const Readings = api.Entity.make({
    model: reading,
    entityType: "Reading",
    primaryKey: keyedBy("id"),
    timeSeries: { orderBy: "at", appendInput: reading },
  })
  return { Inner, members: { Docs, Notes, Kept, Unique, Readings } }
}

const entitySteps = (N: Names, S: Shaper, D: Shaper): ReadonlyArray<Step> => {
  const key = (id: string) => S("key", { id, sort: "s" })
  const inner = (at: string) => D("inner", { x: at, [N.b]: `${at}-b` })
  const doc = (id: string, n: number) =>
    S("item", {
      id,
      sort: "s",
      label: "L",
      n,
      note: `${id}-note`,
      tally: 1,
      tags: D("tags", ["t"]),
      marks: new Set(["m"]),
      [N.a]: `${id}-a`,
      inner: inner(id),
    })
  const byLabel = (db: any) => db.entities.Docs.byLabel({ label: "L" })
  return [
    { label: "put", run: (db) => db.entities.Docs.put(doc("a", 1)) },
    { label: "create", run: (db) => db.entities.Docs.create(doc("c", 2)) },
    { label: "upsert", run: (db) => db.entities.Docs.upsert(doc("u", 3)) },
    {
      label: "put a note",
      run: (db) => db.entities.Notes.put(S("item", { nid: "x", label: "L", n: 4 })),
    },
    { label: "get", run: (db) => db.entities.Docs.get(key("a")) },
    {
      label: "update, set",
      run: (db) =>
        db.entities.Docs.update(key("a")).set(
          S("set", { note: "u", [N.a]: "a2", inner: inner("s") }),
        ),
    },
    {
      label: "patch, set",
      run: (db) => db.entities.Docs.patch(key("u")).set(S("set", { tally: 3 })),
    },
    {
      label: "condition not met",
      run: (db) =>
        db.entities.Docs.update(key("a"))
          .set({ note: "z" })
          .condition(S("condition", { note: "nope" })),
    },
    {
      label: "condition met",
      run: (db) =>
        db.entities.Docs.update(key("a"))
          .set({ tags: ["t"] })
          .condition(S("condition", { note: "u", [N.a]: "a2" })),
    },
    {
      label: "add",
      run: (db) => db.entities.Docs.update(key("a")).add(S("add", { tally: 2 })),
    },
    {
      label: "subtract",
      run: (db) => db.entities.Docs.update(key("a")).subtract(S("subtract", { tally: 1 })),
    },
    {
      label: "append",
      run: (db) =>
        db.entities.Docs.update(key("a")).append(S("append", { tags: D("tags", ["x"]) })),
    },
    {
      label: "delete from a set",
      run: (db) =>
        db.entities.Docs.update(key("a")).deleteFromSet(
          S("deleteFromSet", { marks: new Set(["m"]) }),
        ),
    },
    {
      label: "remove",
      run: (db) => db.entities.Docs.update(key("a")).remove(S("remove", ["note", N.a])),
    },
    {
      label: "put, condition not met",
      run: (db) => db.entities.Docs.put(doc("p", 8)).condition(S("condition", { label: "nope" })),
    },
    {
      label: "delete, condition not met",
      run: (db) => db.entities.Docs.delete(key("c")).condition(S("condition", { note: "nope" })),
    },
    {
      label: "index accessor",
      run: (db) => db.entities.Docs.byLabel(S("key", { label: "L" })).collect(),
    },
    {
      label: "index accessor with its sort key",
      run: (db) => db.entities.Docs.byLabel(S("key", { label: "L", n: 1 })).collect(),
    },
    {
      label: "filter",
      run: (db) =>
        byLabel(db)
          .filter(S("filter", { tally: 1, [N.a]: "c-a" }))
          .collect(),
    },
    {
      label: "select",
      run: (db) =>
        byLabel(db)
          .select(S("select", ["id", "n", N.a]))
          .collect(),
    },
    {
      label: "within",
      run: (db) =>
        byLabel(db)
          .within(S("within", { n: D("bound", { between: D("range", [2, 5]) }) }))
          .collect(),
    },
    {
      label: "within, pinned",
      run: (db) =>
        byLabel(db)
          .within(S("within", { n: D("bound", { eq: 1 }) }))
          .collect(),
    },
    {
      label: "scan, filtered",
      run: (db) =>
        db.entities.Docs.scan()
          .filter(S("filter", { tally: 3 }))
          .collect(),
    },
    {
      label: "collection",
      run: (db) => db.collections.labelled(S("key", { label: "L" })).collect(),
    },
    {
      label: "collection, filtered",
      run: (db) =>
        db.collections
          .labelled({ label: "L" })
          .filter(S("filter", { n: 4 }))
          .collect(),
    },
    {
      label: "batch get",
      run: (db, api) =>
        api.Batch.get([
          db.entities.Docs.get(key("a")),
          db.entities.Notes.get(S("key", { nid: "x" })),
        ]),
    },
    {
      label: "transact get",
      run: (db, api) =>
        api.Transaction.transactGet([
          db.entities.Docs.get(key("a")),
          db.entities.Notes.get(S("key", { nid: "x" })),
        ]),
    },
    {
      label: "transact write",
      run: (db, api) =>
        api.Transaction.transactWrite([
          db.entities.Docs.put(doc("t", 6)),
          db.entities.Docs.update(key("a")).set(S("set", { note: "tw" })),
          db.entities.Docs.delete(key("u")),
        ]),
    },
    {
      label: "batch write",
      run: (db, api) =>
        api.Batch.write([db.entities.Docs.put(doc("w", 7)), db.entities.Docs.delete(key("t"))]),
    },
    { label: "delete if exists", run: (db) => db.entities.Docs.deleteIfExists(key("c")) },
    { label: "delete", run: (db) => db.entities.Docs.delete(key("w")) },
    { label: "retained put", run: (db) => db.entities.Kept.put(doc("k", 1)) },
    {
      label: "retained update",
      run: (db) => db.entities.Kept.update(key("k")).set(S("set", { note: "k2" })),
    },
    { label: "a version", run: (db) => db.entities.Kept.getVersion(key("k"), 1) },
    { label: "versions", run: (db) => db.entities.Kept.versions(key("k")).collect() },
    { label: "retained delete", run: (db) => db.entities.Kept.delete(key("k")) },
    { label: "unique put", run: (db) => db.entities.Unique.put(doc("q", 1)) },
    {
      label: "unique update",
      run: (db) => db.entities.Unique.update(key("q")).set(S("set", { note: "q2" })),
    },
    { label: "soft delete", run: (db) => db.entities.Unique.delete(key("q")) },
    { label: "a soft-deleted item", run: (db) => db.entities.Unique.deleted.get(key("q")) },
    { label: "restore", run: (db) => db.entities.Unique.restore(key("q")) },
    { label: "purge", run: (db) => db.entities.Unique.purge(key("q")) },
    {
      label: "put a reading",
      run: (db) => db.entities.Readings.put(S("item", { id: "r", at: 1, v: 1, [N.a]: "ra" })),
    },
    {
      label: "append a reading",
      run: (db) => db.entities.Readings.append(S("item", { id: "r", at: 2, v: 2, [N.a]: "rb" })),
    },
    {
      label: "history",
      run: (db) => db.entities.Readings.history(S("key", { id: "r" })).collect(),
    },
    {
      label: "append tagged events",
      run: (_db, _api, built) =>
        built.streams!.Tagged.append(
          S("key", { id: "s" }),
          [
            S("event", { _tag: "Added", n: 1, [N.a]: "ea", inner: inner("e") }),
            S("event", { _tag: "Gone", n: 2 }),
          ],
          0,
          { metadata: S("metadata", { by: "me", [N.b]: "mb" }) },
        ),
    },
    {
      label: "read tagged events",
      run: (_db, _api, built) => built.streams!.Tagged.read(S("key", { id: "s" })),
    },
    {
      label: "append struct events",
      run: (_db, _api, built) =>
        built.streams!.Plain.append(
          S("key", { id: "p" }),
          [S("event", { kind: "k", [N.a]: "pa" })],
          0,
        ),
    },
    {
      label: "read struct events",
      run: (_db, _api, built) => built.streams!.Plain.read(S("key", { id: "p" })),
    },
    { label: "scan", run: (db) => db.entities.Docs.scan().collect() },
  ]
}

const entityPosition = (set: string, N: Names, variant: Variant, record: Shaper): Position => {
  const { S, D } = shapers(record, variant)
  return {
    key: `entities and streams, ${set}, ${variant}`,
    build: (api, _name, table) => {
      const { Schema } = api
      const { Inner, members } = entities(api, N)
      const Main = table({ entities: members })
      const Tagged = api.EventStore.makeStream({
        table: Main,
        streamName: "Tagged",
        events: [
          Schema.TaggedStruct("Added", {
            n: Schema.Number,
            [N.a]: Schema.optional(Schema.String),
            inner: Schema.optional(Inner),
          } as never),
          Schema.TaggedStruct("Gone", { n: Schema.Number }),
        ],
        metadata: Schema.Struct({
          by: Schema.String,
          [N.b]: Schema.optional(Schema.String),
        } as never),
        streamId: { composite: ["id"] },
      })
      const Plain = api.EventStore.makeStream({
        table: Main,
        streamName: "Plain",
        events: [
          Schema.Struct({ kind: Schema.String, [N.a]: Schema.optional(Schema.String) } as never),
        ],
        streamId: { composite: ["id"] },
      })
      return { entities: members, streams: { Tagged, Plain } }
    },
    steps: () => entitySteps(N, S, D),
  }
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

const aggregate = (
  api: Api,
  N: Names,
  table: (members: { entities?: object; aggregates?: object }) => any,
) => {
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
    [N.a]: Schema.optional(Schema.String),
    line: Line,
    child: Child,
    notes: Schema.Array(
      Schema.Struct({
        nid: Schema.String,
        text: Schema.String,
        [N.b]: Schema.optional(Schema.String),
      } as never),
    ),
    items: Schema.Array(Schema.Struct({ line: Line, qty: Schema.Number })),
  } as never)
  const members = { Lines }
  const Roots = api.Aggregate.make(Root, {
    table: table({ entities: members }),
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
  return { entities: members, aggregates: { Roots } }
}

const aggregateSteps = (N: Names, S: Shaper, D: Shaper): ReadonlyArray<Step> => {
  const note = (nid: string, text: string) => D("note", { nid, text, [N.b]: `${nid}-b` })
  const line = () => D("line", { lineId: "L", f: 9 })
  return [
    { label: "put the lines", run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }) },
    {
      label: "create by ids",
      run: (db) =>
        db.aggregates.Roots.create(
          S("root", {
            id: "r1",
            title: "t",
            [N.a]: "r1-a",
            lineId: "L",
            child: D("child", { cid: "c", lineId: "L" }),
            notes: D("notes", [note("n", "x")]),
            items: D("items", [D("item", { lineId: "L", qty: 2 })]),
          }),
        ),
    },
    {
      label: "create whole",
      run: (db) =>
        db.aggregates.Roots.create(
          S("root", {
            id: "r2",
            title: "t",
            [N.a]: "r2-a",
            line: line(),
            child: D("child", { cid: "c", line: line() }),
            notes: D("notes", [note("n", "x")]),
            items: D("items", [D("item", { line: line(), qty: 2 })]),
          }),
        ),
    },
    { label: "get", run: (db) => db.aggregates.Roots.get(S("key", { id: "r1" })) },
    {
      label: "update",
      run: (db) =>
        db.aggregates.Roots.update(S("key", { id: "r1" }), ({ state }: any) => {
          const { updatedAt: _, ...rest } = state
          return S("state", {
            ...rest,
            title: "u",
            [N.a]: "r1-b",
            notes: D("notes", [note("m", "y")]),
          })
        }),
    },
    { label: "get after the update", run: (db) => db.aggregates.Roots.get({ id: "r1" }) },
    { label: "delete", run: (db) => db.aggregates.Roots.delete(S("key", { id: "r2" })) },
    {
      label: "get after the delete",
      run: (db, api) => api.Effect.flip(effectOf(db.aggregates.Roots.get({ id: "r2" }))),
    },
  ]
}

const aggregatePosition = (set: string, N: Names, variant: Variant, record: Shaper): Position => {
  const { S, D } = shapers(record, variant)
  return {
    key: `aggregates, ${set}, ${variant}`,
    build: (api, _name, table) => aggregate(api, N, table),
    steps: () => aggregateSteps(N, S, D),
  }
}

/** Every position, each with a recorder of its own. */
export const parityPositions = (): ReadonlyArray<{
  readonly position: Position
  readonly trace: Trace
}> =>
  Object.entries(NAME_SETS).flatMap(([set, N]) =>
    VARIANTS.flatMap((variant) =>
      [entityPosition, aggregatePosition].map((make) => {
        const { record, trace } = recorder()
        return { position: make(set, N, variant, record), trace }
      }),
    ),
  )
