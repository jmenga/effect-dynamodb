/**
 * A function a caller gives as a value, its object's own property, on every path that reads a
 * caller's record (#239), run against DynamoDB Local: a payload's field, each kind of key (an index
 * accessor's partition and sort composites, a collection's, `get`, `update`, `delete`, `Batch.get`,
 * `Transaction.transactGet`), a condition and a filter (a record and a callback), an update's
 * record operations, `.within()` bounds and `.where()`, the expression builders, an aggregate's id to
 * fetch and its key, an event's `_tag` and a stream's id; and a field named like an
 * `Object.prototype` member, given an own function.
 *
 * A function inherited from `Object.prototype` is not given; one the object holds itself is, and
 * does on each path what it did on 1.40.0. The function is made by `new Function`, so its source
 * text (which a key composed from it holds) is the engine's, whatever compiled the test.
 *
 * `capture` (`InheritedNames.ts`) runs the position against a library given as a parameter;
 * `test/fixtures/own-functions-1.40.0.json` holds what published 1.40.0 did on Effect 4.1.3.
 */

import type { Position, Step } from "./InheritedNames.js"

/** The function given: its own property of each object below. */
const ownFunction = (): unknown => new Function("return 1")

/** The function's source text, which a key composed from it holds. */
export const FUNCTION_TEXT = String(ownFunction())

/** `step`, what it made as an effect: a builder's result that is no effect is its value. */
const asEffect = (step: Step): Step => ({
  label: step.label,
  run: (db, api, built) => {
    const op: any = step.run(db, api, built)
    return typeof op?.asEffect === "function"
      ? op.asEffect()
      : api.Effect.isEffect(op)
        ? op
        : api.Effect.succeed(op)
  },
})

const keyedBy = (composite: string) => ({
  pk: { field: "pk", composite: [composite] },
  sk: { field: "sk", composite: [] },
})

const steps = (): ReadonlyArray<Step> => {
  const fn = ownFunction
  const a = { id: "a" }
  return [
    {
      label: "put a",
      run: (db) => db.entities.Docs.put({ id: "a", label: "L", n: 1, note: "u", tally: 1 }),
    },
    { label: "put b", run: (db) => db.entities.Docs.put({ id: "b", label: "M", n: 2 }) },
    // A payload's field.
    {
      label: "put, a field",
      run: (db) => db.entities.Docs.put({ id: "c", label: "L", n: 3, note: fn() }),
    },
    {
      label: "put, a field named like a member of Object.prototype",
      run: (db) => db.entities.Docs.put({ id: "d", label: "L", n: 4, toString: fn() }),
    },
    // Keys.
    {
      label: "index accessor, its sort composite",
      run: (db) => db.entities.Docs.byLabel({ label: "L", n: fn() }).collect(),
    },
    {
      label: "index accessor, its partition composite",
      run: (db) => db.entities.Docs.byLabel({ label: fn() }).collect(),
    },
    {
      label: "collection accessor, its partition composite",
      run: (db) => db.collections.labelled({ label: fn() }).collect(),
    },
    { label: "get", run: (db) => db.entities.Docs.get({ id: fn() }) },
    {
      label: "update's key",
      run: (db) => db.entities.Docs.update({ id: fn() }).set({ note: "k" }),
    },
    { label: "delete's key", run: (db) => db.entities.Docs.delete({ id: fn() }) },
    {
      label: "batch get",
      run: (db, api) => api.Batch.get([db.entities.Docs.get({ id: fn() })]),
    },
    {
      label: "transact get",
      run: (db, api) => api.Transaction.transactGet([db.entities.Docs.get({ id: fn() })]),
    },
    // Conditions.
    {
      label: "condition, a record",
      run: (db) => db.entities.Docs.update(a).set({ tally: 2 }).condition({ note: fn() }),
    },
    {
      label: "condition, a callback",
      run: (db) =>
        db.entities.Docs.update(a)
          .set({ tally: 3 })
          .condition((t: any, { eq }: any) => eq(t.note, fn())),
    },
    {
      label: "condition, a field named like a member of Object.prototype",
      run: (db) => db.entities.Docs.update(a).set({ tally: 4 }).condition({ toString: fn() }),
    },
    // Filters.
    {
      label: "filter, a record",
      run: (db) => db.entities.Docs.byLabel({ label: "L" }).filter({ note: fn() }).collect(),
    },
    {
      label: "filter, a callback",
      run: (db) =>
        db.entities.Docs.byLabel({ label: "L" })
          .filter((t: any, { eq }: any) => eq(t.note, fn()))
          .collect(),
    },
    {
      label: "scan filter, a record",
      run: (db) => db.entities.Docs.scan().filter({ note: fn() }).collect(),
    },
    {
      label: "collection filter, a record",
      run: (db) => db.collections.labelled({ label: "L" }).filter({ note: fn() }).collect(),
    },
    // An update's record operations.
    { label: "set", run: (db) => db.entities.Docs.update(a).set({ note: fn() }) },
    { label: "add", run: (db) => db.entities.Docs.update(a).add({ tally: fn() }) },
    { label: "subtract", run: (db) => db.entities.Docs.update(a).subtract({ tally: fn() }) },
    { label: "append", run: (db) => db.entities.Docs.update(a).append({ tags: fn() }) },
    {
      label: "deleteFromSet",
      run: (db) => db.entities.Docs.update(a).deleteFromSet({ set: fn() }),
    },
    // Bounds.
    {
      label: "within, the composite",
      run: (db) => db.entities.Docs.byLabel({ label: "L" }).within({ n: fn() }).collect(),
    },
    {
      label: "within, an operator's",
      run: (db) =>
        db.entities.Docs.byLabel({ label: "L" })
          .within({ n: { gte: fn() } })
          .collect(),
    },
    {
      label: "within, between's",
      run: (db) =>
        db.entities.Docs.byLabel({ label: "L" })
          .within({ n: { between: [fn(), 5] } })
          .collect(),
    },
    {
      label: "where, a callback",
      run: (db) =>
        db.entities.Docs.byLabel({ label: "L" })
          .where((t: any, { gte }: any) => gte(t.n, fn()))
          .collect(),
    },
    // The expression builders.
    {
      label: "Expression.condition",
      run: (_db, api) => (api as any).Expression.condition({ eq: { note: fn() } }),
    },
    {
      label: "Expression.filter",
      run: (_db, api) => (api as any).Expression.filter({ ne: { note: fn() } }),
    },
    {
      label: "Expression.update",
      run: (_db, api) => (api as any).Expression.update({ set: { note: fn() } }),
    },
    // An aggregate's id to fetch, and its key.
    { label: "put the line", run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }) },
    {
      label: "aggregate create, an id to fetch",
      run: (db) => db.aggregates.Roots.create({ id: "r", lineId: fn(), notes: [] }),
    },
    { label: "aggregate get, its key", run: (db) => db.aggregates.Roots.get({ id: fn() }) },
    // An event's tag, and a stream's id.
    {
      label: "append to a stream, an event's _tag",
      run: (_db, _api, built) =>
        built.streams!.Events.append({ id: "s" }, [{ _tag: fn(), kind: "a", n: 1 }], 0),
    },
    {
      label: "append to a stream, its id",
      run: (_db, _api, built) =>
        built.streams!.Events.append({ id: fn() }, [{ _tag: "Added", kind: "a", n: 1 }], 0),
    },
    {
      label: "read the stream",
      run: (_db, _api, built) => built.streams!.Events.read({ id: "s" }),
    },
    { label: "scan", run: (db) => db.entities.Docs.scan().collect() },
  ]
}

export const OWN_FUNCTION_POSITION: Position = {
  key: "a function given as a value, its object's own property",
  build: (api, _name, table) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        n: Schema.Number,
        note: Schema.optional(Schema.Unknown),
        tally: Schema.optional(Schema.Unknown),
        tags: Schema.optional(Schema.Unknown),
        set: Schema.optional(Schema.Unknown),
        toString: Schema.optional(Schema.Unknown),
      }),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
      indexes: {
        byLabel: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["label"] },
          sk: { field: "gsi1sk", composite: ["n"] },
          collection: "labelled",
        },
      },
    })
    const Line = Schema.Struct({ lineId: Schema.String, f: Schema.Number })
    const Lines = api.Entity.make({
      model: Line,
      entityType: "Line",
      primaryKey: keyedBy("lineId"),
    })
    const entities = { Docs, Lines }
    const Main = table({ entities })
    const Roots = api.Aggregate.make(
      Schema.Struct({
        id: Schema.String,
        line: Line,
        notes: Schema.Array(Schema.Struct({ nid: Schema.String })),
      }),
      {
        table: Main,
        schema: api.DynamoSchema.make({ name: "names", version: 1 }),
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "root" },
        root: { entityType: "Root" },
        edges: {
          line: api.Aggregate.one({ entityType: "RootLine", entity: Lines }),
          notes: api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } }),
        },
      },
    )
    const Events = api.EventStore.makeStream({
      table: Main,
      streamName: "Events",
      events: [
        Schema.TaggedStruct("Added", { kind: Schema.String, n: Schema.Number }),
        Schema.TaggedStruct("Removed", { kind: Schema.String }),
      ],
      streamId: { composite: ["id"] },
    })
    return { entities, aggregates: { Roots }, streams: { Events } }
  },
  steps: () => steps().map(asEffect),
}
