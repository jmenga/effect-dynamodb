/**
 * Every member of `Object.prototype` a payload gives as a field, in every shape a payload takes,
 * through every write path, run against DynamoDB Local (#239).
 *
 * The names are `InheritedNames.ts`'s, `__proto__` left out (a write giving it is refused, `EDD-9165`,
 * as `connected.inherited-names.test.ts` pins), and the shapes `PayloadShapes.ts`'s (a plain object,
 * one made by `Object.create`, a class with getters, a frozen object, a proxy and a strict proxy) and
 * an instance of a `Schema.Class`. The name is a field at the top level (optional), a required
 * property of a struct, an optional property of a list's element and of a record's value, a required
 * property of one alternative of a union of structs and an optional one of a union of a struct and a
 * string, and an optional property of a struct a suspended schema gives; each value given in the
 * shape. The writes: an entity's put, create, upsert, update, patch, transaction and batch; a
 * time-series put and append; an event stream's append (two events, and metadata) and snapshot; and
 * an aggregate's create and update (root, `one` edge, sub-aggregate and `many` element). Geo's write
 * path runs in its own package.
 *
 * `capture` (`InheritedNames.ts`) runs one shape under one name against a library given as a
 * parameter. `test/fixtures/inherited-shapes-1.40.0.json` holds what published 1.40.0 did with each
 * on Effect 4.1.3, and `inherited-shapes-effect-4.1.2.json` a few on Effect 4.1.2.
 */

import { Schema } from "effect"
import { type Api, NAMES, own, type Position, type Step } from "./InheritedNames.js"
import { SHAPES, type Shape } from "./PayloadShapes.js"

/** The names crossed: an ordinary name first, then each member of `Object.prototype` but `__proto__`. */
export const CROSSED_NAMES = NAMES.filter((name) => name !== "__proto__")

const keyedBy = (composite: string) => ({
  pk: { field: "pk", composite: [composite] },
  sk: { field: "sk", composite: [] },
})

/**
 * The fields holding `name`: at the top level (optional), a required property of a struct, an
 * optional property of a list's element and of a record's value, a required property of one
 * alternative of a union of structs (`u`) and an optional one of a union of a struct and a string
 * (`v`), and an optional property of a struct a suspended schema gives, a level down (`deep`).
 */
const fieldsOf = (api: Api, name: string) => {
  const { Schema } = api
  const optional = Schema.optional(Schema.String)
  const Inner = Schema.Struct(
    own([
      ["k", Schema.String],
      [name, Schema.String],
    ]),
  )
  const Element = Schema.Struct(
    own([
      ["e", Schema.String],
      [name, optional],
    ]),
  )
  const U = Schema.Union([
    Schema.Struct(
      own([
        ["kind", Schema.Literal("a")],
        [name, Schema.String],
      ]),
    ),
    Schema.Struct({ kind: Schema.Literal("b"), n: Schema.Number }),
  ])
  const V = Schema.Union([
    Schema.Struct(
      own([
        ["k", Schema.String],
        [name, optional],
      ]),
    ),
    Schema.String,
  ])
  const Deep = Schema.Struct({ s: Schema.suspend(() => Element) })
  return {
    Inner,
    U,
    fields: [
      [name, optional],
      ["inner", Inner],
      ["list", Schema.Array(Element)],
      ["map", Schema.Record(Schema.String, Element)],
      ["u", U],
      ["v", V],
      ["deep", Deep],
    ] as Array<readonly [string, unknown]>,
  }
}

/** The values of {@link fieldsOf}'s fields, each object given as `as` gives one. */
const given = (as: Shape, name: string, tag: string): Array<readonly [string, unknown]> => [
  [name, `${tag}-top`],
  [
    "inner",
    shaped(as, [
      ["k", tag],
      [name, `${tag}-inner`],
    ]),
  ],
  [
    "list",
    [
      shaped(as, [
        ["e", tag],
        [name, `${tag}-list`],
      ]),
    ],
  ],
  [
    "map",
    own([
      [
        "m",
        shaped(as, [
          ["e", tag],
          [name, `${tag}-map`],
        ]),
      ],
    ]),
  ],
  [
    "u",
    shaped(as, [
      ["kind", "a"],
      [name, `${tag}-u`],
    ]),
  ],
  [
    "v",
    shaped(as, [
      ["k", tag],
      [name, `${tag}-v`],
    ]),
  ],
  [
    "deep",
    shaped(as, [
      [
        "s",
        shaped(as, [
          ["e", tag],
          [name, `${tag}-deep`],
        ]),
      ],
    ]),
  ],
]

/** An object holding `entries`, given as `as` gives one. */
const shaped = (as: Shape, entries: Array<readonly [string, unknown]>) => as(own(entries))

/** The part of `name`'s fields an update gives: the top-level field, the struct and the union. */
const changed = (as: Shape, name: string, tag: string): Array<readonly [string, unknown]> =>
  given(as, name, tag).filter(([field]) => field === name || field === "inner" || field === "u")

const build: Position["build"] = (api, name, table) => {
  const { Schema } = api
  const { Inner, U, fields } = fieldsOf(api, name)
  const optional = Schema.optional(Schema.String)
  const Docs = api.Entity.make({
    model: Schema.Struct(own([["id", Schema.String], ...fields])),
    entityType: "Doc",
    primaryKey: keyedBy("id"),
  })
  const reading = Schema.Struct(own([["id", Schema.String], ["at", Schema.Number], ...fields]))
  const Readings = api.Entity.make({
    model: reading,
    entityType: "Reading",
    primaryKey: keyedBy("id"),
    timeSeries: { orderBy: "at", appendInput: reading },
  })
  const entities = { Docs, Readings }
  const Main = table({ entities })
  const Events = api.EventStore.makeStream({
    table: Main,
    streamName: "Events",
    events: [
      Schema.TaggedStruct("Added", own(fields)),
      Schema.TaggedStruct(
        "Removed",
        own([
          ["why", Schema.String],
          [name, optional],
        ]),
      ),
    ],
    metadata: Schema.Struct(
      own([
        ["by", Schema.String],
        [name, optional],
      ]),
    ),
    snapshot: { schema: Schema.Struct(own([["total", Schema.Number], ...fields])) },
    streamId: { composite: ["id"] },
  })
  const part = (id: string) =>
    Schema.Struct(
      own([
        [id, Schema.String],
        [name, optional],
        ["inner", Inner],
        ["u", U],
      ]),
    )
  const Children = api.Aggregate.make(part("cid"), { root: { entityType: "Child" }, edges: {} })
  const Roots = api.Aggregate.make(
    Schema.Struct(
      own([
        ["id", Schema.String],
        [name, optional],
        ["inner", Inner],
        ["u", U],
        ["line", part("lineId")],
        ["child", part("cid")],
        ["notes", Schema.Array(part("nid"))],
      ]),
    ),
    {
      table: Main,
      schema: api.DynamoSchema.make({ name: "names", version: 1 }),
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "root" },
      root: { entityType: "Root" },
      edges: {
        line: api.Aggregate.one({ entityType: "RootLine" }),
        child: Children.with({ discriminator: { slot: 1 } }),
        notes: api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } }),
      },
    },
  )
  return { entities, aggregates: { Roots }, streams: { Events } }
}

/** An aggregate part keyed `idName: id`, holding the name and the struct, given as `as` gives one. */
const partGiven = (as: Shape, name: string, idName: string, id: string) =>
  shaped(as, [[idName, id], ...changed(as, name, id)])

const steps =
  (as: Shape) =>
  (name: string): ReadonlyArray<Step> => {
    const doc = (id: string) => shaped(as, [["id", id], ...given(as, name, id)])
    const reading = (at: number) =>
      shaped(as, [["id", "r"], ["at", at], ...given(as, name, `r${at}`)])
    return [
      { label: "put", run: (db) => db.entities.Docs.put(doc("a")) },
      { label: "create", run: (db) => db.entities.Docs.create(doc("c")) },
      { label: "upsert", run: (db) => db.entities.Docs.upsert(doc("u")) },
      {
        label: "update",
        run: (db) => db.entities.Docs.update({ id: "a" }).set(shaped(as, changed(as, name, "a2"))),
      },
      {
        label: "patch",
        run: (db) => db.entities.Docs.patch({ id: "c" }).set(shaped(as, changed(as, name, "c2"))),
      },
      { label: "get after", run: (db) => db.entities.Docs.get({ id: "a" }) },
      {
        label: "transact write",
        run: (db, api) => api.Transaction.transactWrite([db.entities.Docs.put(doc("t"))]),
      },
      { label: "batch write", run: (db, api) => api.Batch.write([db.entities.Docs.put(doc("w"))]) },
      { label: "put a reading", run: (db) => db.entities.Readings.put(reading(1)) },
      { label: "append a reading", run: (db) => db.entities.Readings.append(reading(2)) },
      { label: "history", run: (db) => db.entities.Readings.history({ id: "r" }).collect() },
      {
        label: "append to a stream",
        run: (_db, _api, built) =>
          built.streams!.Events.append(
            { id: "s" },
            [
              shaped(as, [["_tag", "Added"], ...given(as, name, "e")]),
              shaped(as, [
                ["_tag", "Removed"],
                ["why", "w"],
                [name, "e-removed"],
              ]),
            ],
            0,
            {
              metadata: shaped(as, [
                ["by", "me"],
                [name, "m"],
              ]),
            },
          ),
      },
      {
        label: "write a snapshot",
        run: (_db, _api, built) =>
          built.streams!.Events.writeSnapshot(
            { id: "s" },
            shaped(as, [["total", 2], ...given(as, name, "s")]),
            2,
          ),
      },
      {
        label: "read the stream",
        run: (_db, _api, built) => built.streams!.Events.read({ id: "s" }),
      },
      {
        label: "read the snapshot",
        run: (_db, _api, built) => built.streams!.Events.readSnapshot({ id: "s" }),
      },
      {
        label: "create an aggregate",
        run: (db) =>
          db.aggregates.Roots.create(
            shaped(as, [
              ["id", "g"],
              ...changed(as, name, "g"),
              ["line", partGiven(as, name, "lineId", "l")],
              ["child", partGiven(as, name, "cid", "c")],
              ["notes", [partGiven(as, name, "nid", "n")]],
            ]),
          ),
      },
      { label: "get the aggregate", run: (db) => db.aggregates.Roots.get({ id: "g" }) },
      {
        label: "update the aggregate",
        run: (db) =>
          db.aggregates.Roots.update({ id: "g" }, ({ state }: any) =>
            shaped(as, [
              ...Object.entries(state),
              ...changed(as, name, "g2"),
              ["line", partGiven(as, name, "lineId", "l2")],
              ["child", partGiven(as, name, "cid", "c2")],
              ["notes", [partGiven(as, name, "nid", "n"), partGiven(as, name, "nid", "o")]],
            ]),
          ),
      },
      { label: "get the aggregate after", run: (db) => db.aggregates.Roots.get({ id: "g" }) },
    ]
  }

/** A `Schema.Class` per set of names, each field `Unknown`: the class a record's instance is of. */
const classes = new Map<string, new (props: object) => object>()

/**
 * The shapes crossed: `PayloadShapes.ts`'s, and an instance of a `Schema.Class` given where the
 * model declares a struct (a class declaring the record's names, each field `Unknown`; its
 * instance holds each as its own property).
 */
export const CROSSED_SHAPES: Readonly<Record<string, Shape>> = {
  ...SHAPES,
  "Schema.Class instance": (record) => {
    const names = Reflect.ownKeys(record).filter((name): name is string => typeof name === "string")
    const id = JSON.stringify(names)
    let Given = classes.get(id)
    if (Given === undefined) {
      Given = Schema.Class<object>("Given")(
        own(names.map((name) => [name, Schema.Unknown] as const)) as Schema.Struct.Fields,
      ) as unknown as new (
        props: object,
      ) => object
      classes.set(id, Given)
    }
    return new Given(record)
  },
}

/** The names Effect's struct parser (4.1.3) reads only as a value's own properties. */
const OWN_ONLY = new Set<PropertyKey>([...Reflect.ownKeys(Object.prototype), "__proto__"])

/** Whether Effect's struct parser (4.1.3) reads `name` of `value`. */
const read = (value: object, name: PropertyKey) =>
  Object.hasOwn(value, name) || (name in value && !OWN_ONLY.has(name))

/** Whether Effect's parser reads `name` of an object `as` gives: as it reads the ordinary name. */
export const parserReads = (as: Shape, name: string): boolean => read(as(own([[name, ""]])), name)

/**
 * `as`, each object then made a plain one holding what Effect's parser reads of it: a name it
 * holds itself, or one it answers `in` for that `Object.prototype` doesn't hold too. The shape
 * 1.40.0 is given to see what it did with a strict proxy as the parser sees it, where its own reads
 * died on a name the proxy doesn't hold.
 */
export const asTheParserSees =
  (as: Shape): Shape =>
  (record) => {
    const value = as(record) as Record<PropertyKey, unknown>
    const seen: Record<PropertyKey, unknown> = {}
    for (const name of Reflect.ownKeys(record)) {
      if (read(value, name)) {
        Object.defineProperty(seen, name, {
          value: value[name],
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    }
    return seen
  }

/** The position of a shape: `as` giving each object. */
export const crossedPosition = (shape: string, as: Shape): Position => ({
  key: `a name every object inherits, given by ${shape}`,
  build,
  steps: steps(as),
})

/** A position per shape, each run under every one of {@link CROSSED_NAMES}. */
export const CROSSED_POSITIONS: ReadonlyArray<{
  readonly shape: string
  readonly as: Shape
  readonly position: Position
}> = Object.entries(CROSSED_SHAPES).map(([shape, as]) => ({
  shape,
  as,
  position: crossedPosition(shape, as),
}))
