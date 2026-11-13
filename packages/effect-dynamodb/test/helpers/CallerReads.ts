/**
 * What the library reads of a caller's object, and what it makes of an argument that is no object
 * (#239), run against DynamoDB Local.
 *
 * - Read counts: every key and payload is an object of counting getters (each an own, enumerable
 *   property), beside an undeclared getter, counted in one shape and throwing in the other, through
 *   every path `PayloadShapes.ts` runs (entity, `Batch`, `Transaction`, index accessors and
 *   `.within()`, collections, `.history()`, event streams, aggregates). Each step's outcome carries
 *   the names it read, each with the number of reads.
 * - A symbol-keyed field the model declares, given by a counting getter: through each write and a
 *   condition, a filter and `StorageEncoding.valueBytes`.
 * - An argument that is no object (`undefined`, `null`, a string, a number, an array) given to every
 *   combinator and accessor that takes a record, a key or a callback, and returned by a callback.
 * - A stored map that looks like the library's own `UnreadableName` error, compared in a condition,
 *   a filter and a transaction.
 *
 * `capture` (`InheritedNames.ts`) runs each position against a library given as a parameter;
 * `test/fixtures/caller-reads-1.40.0.json` holds what published 1.40.0 did on Effect 4.1.3.
 */

import { type Api, CONTROL, canon, type Position, type Step } from "./InheritedNames.js"
import { aggregatePosition, entityPosition, type Shape } from "./PayloadShapes.js"

/** What a step made, as an effect: a builder's result that is no effect is its value. */
const effectOf = (api: Api, op: any) =>
  typeof op?.asEffect === "function"
    ? op.asEffect()
    : api.Effect.isEffect(op)
      ? op
      : api.Effect.succeed(op)

/** `value` as text, read once here: a getter that throws is said, not thrown. */
const settled = (value: unknown): string => {
  try {
    return canon(value, CONTROL)
  } catch (thrown) {
    return `unreadable: ${String((thrown as Error)?.message ?? thrown)}`
  }
}

/** Every read a counting getter saw since the step began, in order. */
const READS: Array<string> = []

/** The symbol-keyed field a model declares. */
export const TOKEN: unique symbol = Symbol.for("effect-dynamodb/test/token")

/** The reads, as `name×count`, sorted. */
const counted = (): string =>
  [...READS.reduce((held, name) => held.set(name, (held.get(name) ?? 0) + 1), new Map())]
    .map(([name, count]) => `${name}×${count}`)
    .sort()
    .join(" ")

/** An object holding `record`'s entries as own enumerable getters that count each read. */
const countingGetters = (
  record: Record<PropertyKey, unknown>,
  undeclared: "counted" | "throwing",
): object => {
  const out = {}
  for (const name of Reflect.ownKeys(record)) {
    const value = record[name as string]
    Object.defineProperty(out, name, {
      get: () => {
        READS.push(String(name))
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

/** The shapes counted: the undeclared getter counted, and throwing. */
export const COUNTING_SHAPES: Readonly<Record<string, Shape>> = {
  "counting getters": (record) => countingGetters(record, "counted"),
  "counting getters, an undeclared one throwing": (record) => countingGetters(record, "throwing"),
}

const describe = (failure: any): string =>
  failure?._tag !== undefined
    ? `${failure._tag}: ${String(failure.message || (failure.cause?.message ?? failure.cause ?? "")).slice(0, 400)}`
    : `defect: ${String(failure?.message ?? failure).slice(0, 400)}`

/**
 * `step`, its outcome (what it returned, or how it failed, a builder's throw included) given with
 * the reads it made: always a success, so the reads of a step that failed are kept too. What it
 * returned is read as text after the reads are counted.
 */
const countingStep = (step: Step): Step => ({
  label: step.label,
  run: (db, api, built) =>
    api.Effect.suspend(() => {
      READS.length = 0
      let op: unknown
      try {
        op = step.run(db, api, built)
      } catch (thrown) {
        return api.Effect.succeed({ thrown: describe(thrown), reads: counted() })
      }
      return api.Effect.exit(api.Effect.suspend(() => effectOf(api, op))).pipe(
        api.Effect.map((exit: any) => {
          const reads = counted()
          return api.Exit.isSuccess(exit)
            ? { value: settled(exit.value), reads }
            : { failed: describe(api.Cause.squash(exit.cause)), reads }
        }),
      )
    }),
})

/** `position`, each of its steps counting the reads it makes. */
const countingPosition = (position: Position): Position => ({
  ...position,
  steps: (name) => position.steps(name).map(countingStep),
})

/** An event stream's event and metadata given by `as`, the stream's id too. */
const streamPosition = (shape: string, as: Shape): Position => ({
  key: `event streams, ${shape}`,
  build: (api, _name, table) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct({ id: Schema.String }),
      entityType: "Doc",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    })
    const Main = table({ entities: { Docs } })
    const Events = api.EventStore.makeStream({
      table: Main,
      streamName: "Events",
      events: [
        Schema.TaggedStruct("Added", { kind: Schema.String, n: Schema.Number }),
        Schema.TaggedStruct("Removed", { kind: Schema.String }),
      ],
      metadata: Schema.Struct({ by: Schema.String }),
      snapshot: { schema: Schema.Struct({ total: Schema.Number }) },
      streamId: { composite: ["id"] },
    })
    return { entities: { Docs }, streams: { Events } }
  },
  steps: () => [
    {
      label: "append two events",
      run: (_db, _api, built) =>
        built.streams!.Events.append(
          as({ id: "s" }),
          [as({ _tag: "Added", kind: "a", n: 1 }), as({ _tag: "Removed", kind: "r" })],
          0,
          { metadata: as({ by: "me" }) },
        ),
    },
    {
      label: "write a snapshot",
      run: (_db, _api, built) =>
        built.streams!.Events.writeSnapshot(as({ id: "s" }), as({ total: 2 }), 2),
    },
    { label: "read", run: (_db, _api, built) => built.streams!.Events.read(as({ id: "s" })) },
    {
      label: "read the snapshot",
      run: (_db, _api, built) => built.streams!.Events.readSnapshot(as({ id: "s" })),
    },
  ],
})

/** The expression builders' operator form, given by `as`, and a check made of one. */
const conditionPosition = (shape: string, as: Shape): Position => ({
  key: `conditions and expressions, ${shape}`,
  build: (api, _name, table) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        note: Schema.optional(Schema.String),
        n: Schema.optional(Schema.Number),
      }),
      entityType: "Doc",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    })
    table({ entities: { Docs } })
    return { entities: { Docs } }
  },
  steps: () => [
    { label: "put", run: (db) => db.entities.Docs.put({ id: "a", note: "u", n: 1 }) },
    {
      label: "Expression.condition",
      run: (_db, api) =>
        (api as any).Expression.condition(as({ eq: as({ note: "u" }), ge: as({ n: 1 }) })),
    },
    {
      label: "Expression.filter",
      run: (_db, api) =>
        (api as any).Expression.filter(as({ ne: as({ note: "u" }), between: as({ n: [0, 5] }) })),
    },
    {
      label: "Expression.update",
      run: (_db, api) => (api as any).Expression.update(as({ set: as({ note: "v" }) })),
    },
    {
      label: "Transaction.check",
      run: (db, api) =>
        api.Transaction.transactWrite([
          api.Transaction.check(
            db.entities.Docs.get({ id: "a" }),
            (api as any).Expression.condition(as({ eq: as({ note: "u" }) })),
          ),
        ]),
    },
    { label: "get", run: (db) => db.entities.Docs.get({ id: "a" }) },
  ],
})

/** A position per counting shape and path: entity, aggregate, event stream and conditions. */
export const COUNTING_POSITIONS: ReadonlyArray<Position> = Object.entries(COUNTING_SHAPES).flatMap(
  ([shape, as]) => [
    countingPosition(entityPosition(shape, as)),
    countingPosition(aggregatePosition(shape, as)),
    countingPosition(streamPosition(shape, as)),
    countingPosition(conditionPosition(shape, as)),
  ],
)

// ---------------------------------------------------------------------------
// A symbol-keyed field the model declares
// ---------------------------------------------------------------------------

const symbolPosition: Position = countingPosition({
  key: "a symbol-keyed field the model declares, given by a counting getter",
  build: (api, _name, table) => {
    const { Schema } = api
    const fields = {
      id: Schema.String,
      label: Schema.String,
      [TOKEN]: Schema.optional(Schema.String),
    }
    const Docs = api.Entity.make({
      model: Schema.Struct(fields),
      entityType: "Doc",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    })
    const Main = table({ entities: { Docs } })
    const Events = api.EventStore.makeStream({
      table: Main,
      streamName: "Events",
      events: [Schema.TaggedStruct("Added", { label: Schema.String, [TOKEN]: Schema.String })],
      streamId: { composite: ["id"] },
    })
    return { entities: { Docs }, streams: { Events } }
  },
  steps: () => {
    const doc = (id: string) => countingGetters({ id, label: "L", [TOKEN]: "t" }, "counted")
    return [
      { label: "put", run: (db) => db.entities.Docs.put(doc("a")) },
      { label: "create", run: (db) => db.entities.Docs.create(doc("c")) },
      { label: "upsert", run: (db) => db.entities.Docs.upsert(doc("u")) },
      {
        label: "set",
        run: (db) =>
          db.entities.Docs.update({ id: "a" }).set(countingGetters({ [TOKEN]: "v" }, "counted")),
      },
      {
        label: "condition",
        run: (db) =>
          db.entities.Docs.update({ id: "a" })
            .set({ label: "M" })
            .condition(countingGetters({ label: "L", [TOKEN]: "v" }, "counted")),
      },
      {
        label: "scan filtered",
        run: (db) =>
          db.entities.Docs.scan()
            .filter(countingGetters({ label: "M", [TOKEN]: "v" }, "counted"))
            .collect(),
      },
      {
        label: "transact write",
        run: (db, api) => api.Transaction.transactWrite([db.entities.Docs.put(doc("t"))]),
      },
      { label: "batch write", run: (db, api) => api.Batch.write([db.entities.Docs.put(doc("w"))]) },
      {
        label: "append to a stream",
        run: (_db, _api, built) =>
          built.streams!.Events.append(
            { id: "s" },
            [countingGetters({ _tag: "Added", label: "L", [TOKEN]: "t" }, "counted")],
            0,
          ),
      },
      {
        label: "StorageEncoding.valueBytes",
        run: (_db, api) =>
          (api as any).StorageEncoding.valueBytes({
            schema: api.Schema.Struct({ label: api.Schema.String, [TOKEN]: api.Schema.String }),
            value: countingGetters({ label: "L", [TOKEN]: "t" }, "counted"),
          }),
      },
      { label: "scan", run: (db) => db.entities.Docs.scan().collect() },
    ]
  },
})

// ---------------------------------------------------------------------------
// An argument that is no object
// ---------------------------------------------------------------------------

/** The arguments given: each kind of value that is no record. */
export const ARGUMENTS: Readonly<Record<string, () => unknown>> = {
  undefined: () => undefined,
  null: () => null,
  "a string": () => "text",
  "a number": () => 42,
  "an array": () => ["label"],
}

const argumentEntities = (api: Api) => {
  const { Schema } = api
  const Docs = api.Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      n: Schema.Number,
      note: Schema.optional(Schema.String),
      tally: Schema.optional(Schema.Number),
      tags: Schema.optional(Schema.Array(Schema.String)),
      set: Schema.optional(Schema.ReadonlySet(Schema.String)),
    }),
    entityType: "Doc",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byLabel: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["label"] },
        sk: { field: "gsi1sk", composite: ["n"] },
        collection: "labelled",
      },
    },
  })
  return { Docs }
}

const argumentSteps = (argument: () => unknown): ReadonlyArray<Step> => {
  const x = argument
  const a = { id: "a" }
  const doc = { id: "d", label: "L", n: 2 }
  return [
    {
      label: "put a",
      run: (db) =>
        db.entities.Docs.put({ id: "a", label: "L", n: 1, note: "u", tally: 1, tags: ["t"] }),
    },
    // An update's record operations.
    { label: "set", run: (db) => db.entities.Docs.update(a).set(x()) },
    { label: "remove", run: (db) => db.entities.Docs.update(a).remove(x()) },
    { label: "add", run: (db) => db.entities.Docs.update(a).add(x()) },
    { label: "subtract", run: (db) => db.entities.Docs.update(a).subtract(x()) },
    { label: "append", run: (db) => db.entities.Docs.update(a).append(x()) },
    { label: "deleteFromSet", run: (db) => db.entities.Docs.update(a).deleteFromSet(x()) },
    { label: "pathSet", run: (db) => db.entities.Docs.update(a).pathSet(x()) },
    { label: "pathRemove", run: (db) => db.entities.Docs.update(a).pathRemove(x()) },
    // Conditions: given, and returned by a callback.
    {
      label: "update, condition",
      run: (db) => db.entities.Docs.update(a).set({ note: "c" }).condition(x()),
    },
    {
      label: "update, condition returned",
      run: (db) =>
        db.entities.Docs.update(a)
          .set({ note: "r" })
          .condition(() => x()),
    },
    { label: "put, condition", run: (db) => db.entities.Docs.put(doc).condition(x()) },
    {
      label: "put, condition returned",
      run: (db) => db.entities.Docs.put(doc).condition(() => x()),
    },
    {
      label: "delete, condition",
      run: (db) => db.entities.Docs.delete({ id: "d" }).condition(x()),
    },
    { label: "put d again", run: (db) => db.entities.Docs.put(doc) },
    {
      label: "delete, condition returned",
      run: (db) => db.entities.Docs.delete({ id: "d" }).condition(() => x()),
    },
    // Queries: a filter given and returned, `.where()`, `.within()`, `.select()`.
    {
      label: "filter",
      run: (db) => db.entities.Docs.byLabel({ label: "L" }).filter(x()).collect(),
    },
    {
      label: "filter returned",
      run: (db) =>
        db.entities.Docs.byLabel({ label: "L" })
          .filter(() => x())
          .collect(),
    },
    {
      label: "scan filter",
      run: (db) => db.entities.Docs.scan().filter(x()).collect(),
    },
    {
      label: "scan filter returned",
      run: (db) =>
        db.entities.Docs.scan()
          .filter(() => x())
          .collect(),
    },
    {
      label: "collection filter",
      run: (db) => db.collections.labelled({ label: "L" }).filter(x()).collect(),
    },
    {
      label: "where",
      run: (db) => db.entities.Docs.byLabel({ label: "L" }).where(x()).collect(),
    },
    {
      label: "where returned",
      run: (db) =>
        db.entities.Docs.byLabel({ label: "L" })
          .where(() => x())
          .collect(),
    },
    {
      label: "within",
      run: (db) => db.entities.Docs.byLabel({ label: "L" }).within(x()).collect(),
    },
    {
      label: "select",
      run: (db) => db.entities.Docs.byLabel({ label: "L" }).select(x()).collect(),
    },
    {
      label: "select returned",
      run: (db) =>
        db.entities.Docs.byLabel({ label: "L" })
          .select(() => x())
          .collect(),
    },
    // Keys and payloads.
    { label: "get", run: (db) => db.entities.Docs.get(x()) },
    { label: "update's key", run: (db) => db.entities.Docs.update(x()).set({ note: "k" }) },
    { label: "delete's key", run: (db) => db.entities.Docs.delete(x()) },
    { label: "put's payload", run: (db) => db.entities.Docs.put(x()) },
    { label: "index accessor", run: (db) => db.entities.Docs.byLabel(x()).collect() },
    { label: "collection accessor", run: (db) => db.collections.labelled(x()).collect() },
    // The expression builders, and a check made of one.
    { label: "Expression.condition", run: (_db, api) => (api as any).Expression.condition(x()) },
    { label: "Expression.filter", run: (_db, api) => (api as any).Expression.filter(x()) },
    { label: "Expression.update", run: (_db, api) => (api as any).Expression.update(x()) },
    {
      label: "Transaction.check",
      run: (db, api) =>
        api.Transaction.transactWrite([api.Transaction.check(db.entities.Docs.get(a), x())]),
    },
    { label: "scan", run: (db) => db.entities.Docs.scan().collect() },
  ]
}

/** A position per {@link ARGUMENTS} kind, each given to every combinator and accessor. */
export const ARGUMENT_POSITIONS: ReadonlyArray<Position> = Object.entries(ARGUMENTS).map(
  ([kind, argument]) =>
    countingPosition({
      key: `an argument that is no object: ${kind}`,
      build: (api, _name, table) => {
        const entities = argumentEntities(api)
        table({ entities })
        return { entities }
      },
      steps: () => argumentSteps(argument),
    }),
)

// ---------------------------------------------------------------------------
// A stored map that looks like the library's own error
// ---------------------------------------------------------------------------

const lookalike = () => ({
  _tag: "UnreadableName",
  field: "businessField",
  message: "ordinary stored message",
})

const lookalikePosition: Position = countingPosition({
  key: "a stored map that looks like the library's UnreadableName",
  build: (api, _name, table) => {
    const { Schema } = api
    const Docs = api.Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        data: Schema.Struct({ _tag: Schema.String, field: Schema.String, message: Schema.String }),
        n: Schema.optional(Schema.Number),
      }),
      entityType: "Doc",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    })
    table({ entities: { Docs } })
    return { entities: { Docs } }
  },
  steps: () => [
    { label: "put", run: (db) => db.entities.Docs.put({ id: "a", data: lookalike() }) },
    {
      label: "update, condition",
      run: (db) =>
        db.entities.Docs.update({ id: "a" }).set({ n: 1 }).condition({ data: lookalike() }),
    },
    {
      label: "update, condition returned",
      run: (db) =>
        db.entities.Docs.update({ id: "a" })
          .set({ n: 2 })
          .condition((t: any, { eq }: any) => eq(t.data, lookalike())),
    },
    {
      label: "scan filter",
      run: (db) => db.entities.Docs.scan().filter({ data: lookalike() }).collect(),
    },
    {
      label: "transact write, condition",
      run: (db, api) =>
        api.Transaction.transactWrite([
          db.entities.Docs.update({ id: "a" }).set({ n: 3 }).condition({ data: lookalike() }),
        ]),
    },
    {
      label: "transact write, check",
      run: (db, api) =>
        api.Transaction.transactWrite([
          api.Transaction.check(
            db.entities.Docs.get({ id: "a" }),
            (api as any).Expression.condition({ eq: { data: lookalike() } }),
          ),
        ]),
    },
    { label: "get", run: (db) => db.entities.Docs.get({ id: "a" }) },
  ],
})

/** Every position, filed by key. */
export const CALLER_READ_POSITIONS: ReadonlyArray<Position> = [
  ...COUNTING_POSITIONS,
  symbolPosition,
  ...ARGUMENT_POSITIONS,
  lookalikePosition,
]
