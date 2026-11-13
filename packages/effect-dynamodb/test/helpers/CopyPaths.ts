/**
 * The paths that hand Effect's parser a copy of a caller's object rather than the object (#239),
 * run against DynamoDB Local: a write filling a decoding default an index key needs (`put`,
 * `create`, `upsert`, a transaction's and a batch's put, a time-series `put`, and an `append`
 * re-making a default its `.remove()` names), an aggregate's dates stamped on every row that
 * declares one (`create` and `update`, at the root, a `one` edge, a sub-aggregate and a `many`
 * element of each), and an aggregate's `create` fetching what ids name (a `one` edge's, a `many`
 * element's, a list given under its `inputField`, two sub-aggregates down, beside a union field).
 * Each copy is 1.40.0's: the same construct, reading the same properties as often, in the same
 * order.
 *
 * Every object a step gives, at every depth, is made by a probe ({@link PROBES}):
 *
 * - counting getters, beside an undeclared one, counted and throwing;
 * - getters that throw on their second read;
 * - a proxy recording each trap it answers, in order;
 * - a proxy whose `has` trap throws;
 * - an object inheriting each name the library fills on it (a default, a date, a fetched item, a
 *   renamed list) from a getter that throws.
 *
 * Each step's outcome carries what the probe saw: each read, counted, or each trap, in order, each
 * named by where the object sits (`root.child.notes[0]`).
 *
 * `capture` (`InheritedNames.ts`) runs each position against a library given as a parameter;
 * `test/fixtures/copy-paths-1.40.0.json` holds what published 1.40.0 did on Effect 4.1.3.
 */

import { type Api, CONTROL, canon, type Position, type Step } from "./InheritedNames.js"

/** What the probe saw since the step began. */
const SEEN: Array<string> = []

/** How a probe's sightings are said: counted (`name×n`, sorted), or in order. */
type Telling = "counted" | "in order"

/**
 * A probe: the object a caller gives holding `record`, `at` naming where it sits, `filled` the names
 * the library fills on it.
 */
export type Make = (
  record: Record<string, unknown>,
  at: string,
  filled?: ReadonlyArray<string>,
) => object

export interface Probe {
  readonly make: Make
  readonly telling: Telling
}

/** An object holding `record`'s entries as own enumerable getters, beside an undeclared one. */
const getters = (
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
const recording = (record: Record<string, unknown>, at: string): object => {
  const seen = (trap: string, name?: PropertyKey) =>
    SEEN.push(name === undefined ? `${at} ${trap}` : `${at} ${trap} ${String(name)}`)
  return new Proxy(
    { ...record, undeclared: "u" },
    {
      get: (target, name, receiver) => {
        seen("get", name)
        return Reflect.get(target, name, receiver)
      },
      has: (target, name) => {
        seen("has", name)
        return Reflect.has(target, name)
      },
      ownKeys: (target) => {
        seen("ownKeys")
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor: (target, name) => {
        seen("getOwnPropertyDescriptor", name)
        return Reflect.getOwnPropertyDescriptor(target, name)
      },
      getPrototypeOf: (target) => {
        seen("getPrototypeOf")
        return Reflect.getPrototypeOf(target)
      },
      set: (target, name, value, receiver) => {
        seen("set", name)
        return Reflect.set(target, name, value, receiver)
      },
      defineProperty: (target, name, descriptor) => {
        seen("defineProperty", name)
        return Reflect.defineProperty(target, name, descriptor)
      },
      deleteProperty: (target, name) => {
        seen("deleteProperty", name)
        return Reflect.deleteProperty(target, name)
      },
      isExtensible: (target) => {
        seen("isExtensible")
        return Reflect.isExtensible(target)
      },
    },
  )
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
  const out = Object.create(parent)
  for (const [name, value] of Object.entries(record)) {
    Object.defineProperty(out, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

export const PROBES: Readonly<Record<string, Probe>> = {
  "counting getters": { make: (record, at) => getters(record, at, () => {}), telling: "counted" },
  "counting getters, an undeclared one throwing": {
    make: (record, at) =>
      getters(record, at, (name) => {
        if (name === "undeclared") throw new Error(`${at}.undeclared was read`)
      }),
    telling: "counted",
  },
  "getters that throw on their second read": {
    make: (record, at) =>
      getters(record, at, (name, count) => {
        if (count > 1) throw new Error(`${at}.${name} was read twice`)
      }),
    telling: "counted",
  },
  "a proxy recording each trap": {
    make: (record, at) => recording(record, at),
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
  "each name the library fills inherited from a throwing getter": {
    make: (record, at, filled = []) => inheritingFilled(record, at, filled),
    telling: "counted",
  },
}

/** What the probe saw, as `telling` says it. */
const told = (telling: Telling): string =>
  telling === "in order"
    ? SEEN.join(", ")
    : [...SEEN.reduce((held, name) => held.set(name, (held.get(name) ?? 0) + 1), new Map())]
        .map(([name, count]) => `${name}×${count}`)
        .sort()
        .join(" ")

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

const describe = (failure: any): string =>
  failure?._tag !== undefined
    ? `${failure._tag}: ${String(failure.message || (failure.cause?.message ?? failure.cause ?? "")).slice(0, 400)}`
    : `defect: ${String(failure?.message ?? failure).slice(0, 400)}`

/**
 * `step`, its outcome given with what the probe saw: always a success, so what a failed step saw
 * is kept too. What it returned is read as text after that is told.
 */
const probing = (step: Step, telling: Telling): Step => ({
  label: step.label,
  run: (db, api, built) =>
    api.Effect.suspend(() => {
      SEEN.length = 0
      let op: unknown
      try {
        op = step.run(db, api, built)
      } catch (thrown) {
        return api.Effect.succeed({ thrown: describe(thrown), seen: told(telling) })
      }
      return api.Effect.exit(api.Effect.suspend(() => effectOf(api, op))).pipe(
        api.Effect.map((exit: any) => {
          const seen = told(telling)
          return api.Exit.isSuccess(exit)
            ? { value: settled(exit.value), seen }
            : { failed: describe(api.Cause.squash(exit.cause)), seen }
        }),
      )
    }),
})

/** A path's definition, and its steps given each object by `as`. */
interface Path {
  readonly name: string
  readonly build: Position["build"]
  readonly steps: (as: Make) => ReadonlyArray<Step>
}

const keyedBy = (composite: string) => ({
  pk: { field: "pk", composite: [composite] },
  sk: { field: "sk", composite: [] },
})

/** A plain object holding `record`: a part a step doesn't give by the probe. */
const plain: Make = (record) => ({ ...record })

// ---------------------------------------------------------------------------
// Decoding defaults
// ---------------------------------------------------------------------------

const defaults: Path = {
  name: "a decoding default an index key needs",
  build: (api, _name, table) => {
    const { Schema, Effect } = api
    const Docs = api.Entity.make({
      model: Schema.Struct({
        id: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("d"))),
        label: Schema.String,
        data: Schema.Struct({ a: Schema.String, deeper: Schema.Struct({ b: Schema.String }) }),
        list: Schema.Array(Schema.Struct({ c: Schema.String })),
      }),
      entityType: "Doc",
      primaryKey: keyedBy("id"),
    })
    const reading = Schema.Struct({
      rid: Schema.String,
      at: Schema.Number,
      v: Schema.Number,
      tag: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("t"))),
    })
    const Readings = api.Entity.make({
      model: reading,
      entityType: "Reading",
      primaryKey: keyedBy("rid"),
      indexes: {
        byTag: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["tag"] },
          sk: { field: "gsi1sk", composite: ["at"] },
        },
      },
      timeSeries: { orderBy: "at", appendInput: reading },
    })
    const entities = { Docs, Readings }
    table({ entities })
    return { entities }
  },
  steps: (as) => {
    const doc = (id?: string) =>
      as(
        {
          ...(id === undefined ? {} : { id }),
          label: "L",
          data: as({ a: "a", deeper: as({ b: "b" }, "doc.data.deeper") }, "doc.data"),
          list: [as({ c: "c" }, "doc.list[0]")],
        },
        "doc",
        ["id"],
      )
    return [
      { label: "put, the default filled", run: (db) => db.entities.Docs.put(doc()) },
      { label: "get", run: (db) => db.entities.Docs.get({ id: "d" }) },
      { label: "delete", run: (db) => db.entities.Docs.delete({ id: "d" }) },
      { label: "create, the default filled", run: (db) => db.entities.Docs.create(doc()) },
      { label: "upsert, the default filled", run: (db) => db.entities.Docs.upsert(doc()) },
      { label: "put, the id given", run: (db) => db.entities.Docs.put(doc("g")) },
      {
        label: "transact write, the default filled",
        run: (db, api) => api.Transaction.transactWrite([db.entities.Docs.put(doc())]),
      },
      {
        label: "batch write, the default filled",
        run: (db, api) => api.Batch.write([db.entities.Docs.put(doc())]),
      },
      { label: "scan", run: (db) => db.entities.Docs.scan().collect() },
      {
        label: "put a reading, the default filled",
        run: (db) => db.entities.Readings.put(as({ rid: "r", at: 1, v: 1 }, "reading", ["tag"])),
      },
      {
        label: "append, the default its remove names made again",
        run: (db) =>
          db.entities.Readings.append(as({ rid: "r", at: 2, v: 2 }, "appended", ["tag"])).remove([
            "tag",
          ]),
      },
      { label: "get the reading", run: (db) => db.entities.Readings.get({ rid: "r" }) },
      { label: "history", run: (db) => db.entities.Readings.history({ rid: "r" }).collect() },
    ]
  },
}

// ---------------------------------------------------------------------------
// Aggregate stamps
// ---------------------------------------------------------------------------

const stamps: Path = {
  name: "an aggregate's stamps",
  build: (api, _name, table) => {
    const { Schema } = api
    const Note = Schema.Struct({
      nid: Schema.String,
      text: Schema.String,
      updatedAt: Schema.DateTimeUtcFromString,
    })
    const Meta = Schema.Struct({ m: Schema.String, updatedAt: Schema.DateTimeUtcFromString })
    const Child = Schema.Struct({
      cid: Schema.String,
      updatedAt: Schema.DateTimeUtcFromString,
      notes: Schema.Array(Note),
    })
    const Children = api.Aggregate.make(Child, {
      root: { entityType: "Child" },
      edges: {
        notes: api.Aggregate.many({ entityType: "ChildNote", sk: { composite: ["nid"] } }),
      },
    })
    const Roots = api.Aggregate.make(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        updatedAt: Schema.DateTimeUtcFromString,
        meta: Meta,
        child: Child,
        notes: Schema.Array(Note),
      }),
      {
        table: table({ entities: {} }),
        schema: api.DynamoSchema.make({ name: "names", version: 1 }),
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "root" },
        root: { entityType: "Root" },
        timestamps: { updated: "updatedAt" },
        edges: {
          meta: api.Aggregate.one({ entityType: "RootMeta" }),
          child: Children.with({ discriminator: { slot: 1 } }),
          notes: api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } }),
        },
      },
    )
    return { entities: {}, aggregates: { Roots } }
  },
  steps: (as) => {
    const dated = ["updatedAt"]
    /** A root, the parts `shaped` names given by the probe, the others plain. */
    const root = (id: string, shaped: ReadonlyArray<string>, title = "t") => {
      const by = (part: string): Make => (shaped.includes(part) ? as : plain)
      return by("root")(
        {
          id,
          title,
          meta: by("meta")({ m: "m" }, "root.meta", dated),
          child: by("child")(
            {
              cid: "c",
              notes: [by("child note")({ nid: "n", text: "x" }, "root.child.notes[0]", dated)],
            },
            "root.child",
            dated,
          ),
          notes: [by("note")({ nid: "n", text: "x" }, "root.notes[0]", dated)],
        },
        "root",
        dated,
      )
    }
    const parts = ["root", "meta", "child", "child note", "note"]
    const creates: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
      ["create, every part given", "r0", parts],
      ["create, the root given", "r1", ["root"]],
      ["create, the one edge given", "r2", ["meta"]],
      ["create, the sub-aggregate given", "r3", ["child"]],
      ["create, the sub-aggregate's many element given", "r4", ["child note"]],
      ["create, a many element given", "r5", ["note"]],
    ]
    return [
      ...creates.map(
        ([label, id, shaped]): Step => ({
          label,
          run: (db) => db.aggregates.Roots.create(root(id, shaped)),
        }),
      ),
      ...creates.map(
        ([, id]): Step => ({ label: `get ${id}`, run: (db) => db.aggregates.Roots.get({ id }) }),
      ),
      {
        label: "update, every part of the result given",
        run: (db) => db.aggregates.Roots.update({ id: "r1" }, () => root("r1", parts, "u")),
      },
      { label: "get r1 after", run: (db) => db.aggregates.Roots.get({ id: "r1" }) },
    ]
  },
}

// ---------------------------------------------------------------------------
// Fetched refs
// ---------------------------------------------------------------------------

const refs = (optional: boolean): Path => ({
  name: `an aggregate's fetched ids, the lists ${optional ? "optional" : "required"}`,
  build: (api, _name, table) => {
    const { Schema } = api
    const Line = Schema.Struct({ lineId: Schema.String, f: Schema.Number })
    const Lines = api.Entity.make({
      model: Line,
      entityType: "Line",
      primaryKey: keyedBy("lineId"),
    })
    const Notes = Schema.Array(Schema.Struct({ nid: Schema.String, text: Schema.String }))
    const notes = optional ? Schema.optionalKey(Notes) : Notes
    const Leaves = api.Aggregate.make(Schema.Struct({ line: Line, notes }), {
      root: { entityType: "Leaf" },
      edges: {
        line: api.Aggregate.one({ entityType: "LeafLine", entity: Lines }),
        notes: api.Aggregate.many({
          entityType: "LeafNote",
          inputField: "entries",
          sk: { composite: ["nid"] },
        }),
      },
    })
    const Level = Schema.Struct({ child: Schema.Struct({ line: Line, notes }) })
    const Levels = api.Aggregate.make(Level, {
      root: { entityType: "Level" },
      edges: { child: Leaves.with({ discriminator: { slot1: 1 } }) },
    })
    const entities = { Lines }
    const Roots = api.Aggregate.make(
      Schema.Struct({
        id: Schema.String,
        line: Line,
        data: Schema.Union([
          Schema.Struct({ value: Schema.Number }),
          Schema.Struct({ value: Schema.String }),
        ]),
        child: Level,
        notes,
        items: Schema.Array(Schema.Struct({ line: Line, qty: Schema.Number })),
      }),
      {
        table: table({ entities }),
        schema: api.DynamoSchema.make({ name: "names", version: 1 }),
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "root" },
        root: { entityType: "Root" },
        edges: {
          line: api.Aggregate.one({ entityType: "RootLine", entity: Lines }),
          child: Levels.with({ discriminator: { slot0: 0 } }),
          notes: api.Aggregate.many({
            entityType: "RootNote",
            inputField: "entries",
            sk: { composite: ["nid"] },
          }),
          items: api.Aggregate.many({
            entityType: "RootItem",
            entity: Lines,
            sk: { composite: ["line.lineId"] },
          }),
        },
      },
    )
    return { entities, aggregates: { Roots } }
  },
  steps: (as) => {
    const fetched = ["line", "notes"]
    /** A root, the parts `shaped` names given by the probe, the others plain. */
    const root = (id: string, shaped: ReadonlyArray<string>) => {
      const by = (part: string): Make => (shaped.includes(part) ? as : plain)
      return by("root")(
        {
          id,
          lineId: "L",
          data: by("data")({ value: "v" }, "root.data"),
          child: by("level")(
            {
              child: by("leaf")(
                {
                  lineId: "L",
                  entries: [
                    by("leaf note")({ nid: "n", text: "x" }, "root.child.child.entries[0]"),
                  ],
                },
                "root.child.child",
                fetched,
              ),
            },
            "root.child",
          ),
          entries: [by("note")({ nid: "n", text: "x" }, "root.entries[0]")],
          items: [by("item")({ lineId: "L", qty: 2 }, "root.items[0]", ["line"])],
        },
        "root",
        fetched,
      )
    }
    const parts = ["root", "data", "level", "leaf", "leaf note", "note", "item"]
    const creates: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
      ["create, every part given", "r0", parts],
      ["create, the root given", "r1", ["root"]],
      ["create, the union field given", "r2", ["data"]],
      ["create, the sub-aggregate given", "r3", ["level"]],
      ["create, the sub-aggregate's sub-aggregate given", "r4", ["leaf"]],
      ["create, its renamed list's element given", "r5", ["leaf note"]],
      ["create, the renamed list's element given", "r6", ["note"]],
      ["create, a many element's id given", "r7", ["item"]],
    ]
    return [
      { label: "put the line", run: (db) => db.entities.Lines.put({ lineId: "L", f: 9 }) },
      ...creates.map(
        ([label, id, shaped]): Step => ({
          label,
          run: (db) => db.aggregates.Roots.create(root(id, shaped)),
        }),
      ),
      ...creates.map(
        ([, id]): Step => ({ label: `get ${id}`, run: (db) => db.aggregates.Roots.get({ id }) }),
      ),
    ]
  },
})

/** Every path a copy is made on. */
export const PATHS: ReadonlyArray<Path> = [defaults, stamps, refs(false), refs(true)]

/** A position per path and probe. */
export const COPY_PATH_POSITIONS: ReadonlyArray<Position> = PATHS.flatMap((path) =>
  Object.entries(PROBES).map(
    ([probe, { make, telling }]): Position => ({
      key: `${path.name}, ${probe}`,
      build: path.build,
      steps: () => path.steps(make).map((step) => probing(step, telling)),
    }),
  ),
)
