/**
 * A struct with a required property named `__proto__`, in every container a model can hold one in,
 * run against DynamoDB Local (#239).
 *
 * A definition is refused (`EDD-9152` for an entity, `EDD-9153` for an aggregate) only where every
 * write would store the name: every container from the root down is required and certain to hold a
 * map. Inside an optional or `optionalKey` field, a nullable one, a union's alternative, a list's or
 * a tuple's rest element (an empty list stores none), a record's value or an `Option`, the
 * definition loads; a write leaving the container out (or empty) does what it did on 1.40.0, and a
 * write that gives the name is refused (`EDD-9165`) and writes nothing. Each container is an entity's
 * field and an aggregate's root field; an aggregate's optional `one` edge and optional sub-aggregate
 * are containers too.
 *
 * `capture` (`InheritedNames.ts`) runs each under `__proto__` against a library given as a
 * parameter. `test/fixtures/proto-containers-1.40.0.json` holds what published 1.40.0 did with each.
 */

import { type Api, own, type Position, type Step } from "./InheritedNames.js"

/** A struct holding `__proto__` (required) and `x`, and a value of it giving both. */
const protoStruct = (api: Api) =>
  api.Schema.Struct(
    own([
      ["__proto__", api.Schema.Number],
      ["x", api.Schema.Number],
    ]),
  )
const protoValue = () =>
  own([
    ["__proto__", 1],
    ["x", 2],
  ])

/** A container: its schema around `inner`, a value leaving the name out, and one giving it. */
interface Container {
  readonly name: string
  readonly schema: (api: Api, inner: unknown) => unknown
  /** The field's entries in a write leaving the name out: none where the field is left out. */
  readonly without: (api: Api) => ReadonlyArray<readonly [string, unknown]>
  readonly with: (api: Api, value: unknown) => unknown
  /** Every write stores the name: the definition is refused. */
  readonly certain?: true
}

export const CONTAINERS: ReadonlyArray<Container> = [
  {
    name: "a required field",
    schema: (_api, inner) => inner,
    without: () => [["data", { x: 2 }]],
    with: (_api, value) => value,
    certain: true,
  },
  {
    name: "an optional field",
    schema: (api, inner) => api.Schema.optional(inner),
    without: () => [],
    with: (_api, value) => value,
  },
  {
    name: "an optionalKey field",
    schema: (api, inner) => api.Schema.optionalKey(inner),
    without: () => [],
    with: (_api, value) => value,
  },
  {
    name: "a nullable field",
    schema: (api, inner) => api.Schema.NullOr(inner),
    without: () => [["data", null]],
    with: (_api, value) => value,
  },
  {
    name: "a union's alternative",
    schema: (api, inner) => api.Schema.Union([api.Schema.String, inner]),
    without: () => [["data", "text"]],
    with: (_api, value) => value,
  },
  {
    name: "a list's element",
    schema: (api, inner) => api.Schema.Array(inner),
    without: () => [["data", []]],
    with: (_api, value) => [value],
  },
  {
    name: "a tuple's rest element",
    schema: (api, inner) =>
      api.Schema.TupleWithRest(api.Schema.Tuple([api.Schema.String]), [inner]),
    without: () => [["data", ["t"]]],
    with: (_api, value) => ["t", value],
  },
  {
    name: "a record's value",
    schema: (api, inner) => api.Schema.Record(api.Schema.String, inner),
    without: () => [["data", {}]],
    with: (_api, value) => ({ k: value }),
  },
  {
    name: "an Option",
    schema: (api, inner) => api.Schema.Option(inner),
    without: (api) => [["data", api.Option.none()]],
    with: (api, value) => api.Option.some(value),
  },
  {
    name: "an OptionFromNullOr",
    schema: (api, inner) => api.Schema.OptionFromNullOr(inner),
    without: (api) => [["data", api.Option.none()]],
    with: (api, value) => api.Option.some(value),
  },
  {
    name: "an OptionFromOptionalKey",
    schema: (api, inner) => api.Schema.OptionFromOptionalKey(inner),
    without: (api) => [["data", api.Option.none()]],
    with: (api, value) => api.Option.some(value),
  },
]

const keyedBy = (composite: string) => ({
  pk: { field: "pk", composite: [composite] },
  sk: { field: "sk", composite: [] },
})

/** The steps leaving the name out and giving it, of an entity's `data` field. */
const entitySteps = (container: Container): ReadonlyArray<Step> => [
  {
    label: "put without it",
    run: (db, api) => db.entities.Docs.put(own([["id", "a"], ...container.without(api)])),
  },
  { label: "get without it", run: (db) => db.entities.Docs.get({ id: "a" }) },
  {
    label: "put with it",
    run: (db, api) => db.entities.Docs.put({ id: "b", data: container.with(api, protoValue()) }),
  },
  { label: "get with it", run: (db) => db.entities.Docs.get({ id: "b" }) },
]

/** The steps leaving the name out and giving it, of an aggregate's root field `data`. */
const aggregateSteps = (container: Container): ReadonlyArray<Step> => [
  {
    label: "create without it",
    run: (db, api) =>
      db.aggregates.Roots.create(
        own([["id", "a"], ...container.without(api), ["notes", [{ nid: "n" }]]]),
      ),
  },
  { label: "get without it", run: (db) => db.aggregates.Roots.get({ id: "a" }) },
  {
    label: "create with it",
    run: (db, api) =>
      db.aggregates.Roots.create({
        id: "b",
        data: container.with(api, protoValue()),
        notes: [{ nid: "n" }],
      }),
  },
  { label: "get with it", run: (db) => db.aggregates.Roots.get({ id: "b" }) },
]

const aggregateOf = (
  api: Api,
  fields: Record<string, unknown>,
  edges: Record<string, unknown>,
  table: Parameters<Position["build"]>[2],
) => {
  const { Schema } = api
  return api.Aggregate.make(
    Schema.Struct({
      id: Schema.String,
      ...fields,
      notes: Schema.Array(Schema.Struct({ nid: Schema.String })),
    }),
    {
      table: table({ entities: {} }),
      schema: api.DynamoSchema.make({ name: "names", version: 1 }),
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "root" },
      root: { entityType: "Root" },
      edges: {
        ...edges,
        notes: api.Aggregate.many({ entityType: "RootNote", sk: { composite: ["nid"] } }),
      },
    },
  )
}

/** A position, and whether its definition is refused. */
export interface ContainerPosition {
  readonly position: Position
  readonly refusedAt?: "EDD-9152" | "EDD-9153"
}

/**
 * A type the required `__proto__` property of a required field may take, and the writes of it: each
 * a value given (`undefined` own), or `absent` (the property left out).
 */
interface PropertyType {
  readonly name: string
  readonly schema: (api: Api) => unknown
  readonly writes: (api: Api) => ReadonlyArray<readonly [string, unknown]>
  /** No value of it stores nothing: the definition is refused. */
  readonly refused?: true
}

/** The property left out of a write. */
export const ABSENT: unique symbol = Symbol.for("effect-dynamodb/test/absent")

export const PROPERTY_TYPES: ReadonlyArray<PropertyType> = [
  {
    name: "UndefinedOr",
    schema: (api) => api.Schema.UndefinedOr(api.Schema.Number),
    writes: () => [
      ["undefined", undefined],
      ["a number", 5],
      ["left out", ABSENT],
    ],
  },
  {
    name: "NullOr",
    schema: (api) => api.Schema.NullOr(api.Schema.Number),
    writes: () => [
      ["null", null],
      ["a number", 5],
    ],
    refused: true,
  },
  {
    name: "NullishOr",
    schema: (api) => api.Schema.NullishOr(api.Schema.Number),
    writes: () => [
      ["undefined", undefined],
      ["null", null],
      ["a number", 5],
      ["left out", ABSENT],
    ],
  },
  {
    name: "OptionFromNullOr",
    schema: (api) => api.Schema.OptionFromNullOr(api.Schema.Number),
    writes: (api) => [
      ["none", api.Option.none()],
      ["some", api.Option.some(5)],
    ],
    refused: true,
  },
  {
    name: "OptionFromNullishOr, none encoded undefined",
    schema: (api) => api.Schema.OptionFromNullishOr(api.Schema.Number),
    writes: (api) => [
      ["none", api.Option.none()],
      ["some", api.Option.some(5)],
    ],
  },
  {
    name: "OptionFromNullishOr, none encoded null",
    schema: (api) => api.Schema.OptionFromNullishOr(api.Schema.Number, { onNoneEncoding: null }),
    writes: (api) => [
      ["none", api.Option.none()],
      ["some", api.Option.some(5)],
    ],
  },
  {
    name: "OptionFromUndefinedOr",
    schema: (api) => api.Schema.OptionFromUndefinedOr(api.Schema.Number),
    writes: (api) => [
      ["none", api.Option.none()],
      ["some", api.Option.some(5)],
    ],
  },
  {
    name: "a decoding default",
    schema: (api) => api.Schema.Number.pipe(api.Schema.withDecodingDefault(api.Effect.succeed(0))),
    writes: () => [
      ["left out", ABSENT],
      ["undefined", undefined],
      ["the default", 0],
      ["a number", 5],
    ],
  },
  {
    name: "a decoding default, omitted on encoding",
    schema: (api) =>
      api.Schema.Number.pipe(
        api.Schema.withDecodingDefault(api.Effect.succeed(0), { encodingStrategy: "omit" }),
      ),
    writes: () => [
      ["left out", ABSENT],
      ["the default", 0],
      ["a number", 5],
    ],
  },
  {
    name: "a decoding default key",
    schema: (api) =>
      api.Schema.Number.pipe(api.Schema.withDecodingDefaultKey(api.Effect.succeed(0))),
    writes: () => [
      ["left out", ABSENT],
      ["the default", 0],
      ["a number", 5],
    ],
  },
  {
    name: "a literal union with undefined",
    schema: (api) => api.Schema.Union([api.Schema.Literals([1, 2]), api.Schema.Undefined]),
    writes: () => [
      ["undefined", undefined],
      ["a literal", 1],
      ["left out", ABSENT],
    ],
  },
]

/** `data`: the property given as `value` (or left out), beside `x`. */
const dataOf = (value: unknown) =>
  own([...(value === ABSENT ? [] : [["__proto__", value] as const]), ["x", 2]])

/** A struct holding `__proto__` of the property's type (required) and `x`. */
const typedStruct = (api: Api, type: PropertyType) =>
  api.Schema.Struct(
    own([
      ["__proto__", type.schema(api)],
      ["x", api.Schema.Number],
    ]),
  )

/** An entity's writes of each value, each read back. */
const typedEntitySteps = (type: PropertyType): ReadonlyArray<Step> =>
  type.writes(DUMMY).flatMap(([label], at): ReadonlyArray<Step> => {
    const id = `w${at}`
    return [
      {
        label: `put, ${label}`,
        run: (db, api) => db.entities.Docs.put({ id, data: dataOf(type.writes(api)[at]![1]) }),
      },
      { label: `get, ${label}`, run: (db) => db.entities.Docs.get({ id }) },
    ]
  })

/** An aggregate's creates of each value, each read back. */
const typedAggregateSteps = (type: PropertyType): ReadonlyArray<Step> =>
  type.writes(DUMMY).flatMap(([label], at): ReadonlyArray<Step> => {
    const id = `w${at}`
    return [
      {
        label: `create, ${label}`,
        run: (db, api) =>
          db.aggregates.Roots.create({
            id,
            data: dataOf(type.writes(api)[at]![1]),
            notes: [{ nid: "n" }],
          }),
      },
      { label: `get, ${label}`, run: (db) => db.aggregates.Roots.get({ id }) },
    ]
  })

/** Labels only: what a write gives is made with the library under test. */
const DUMMY = {
  Option: { none: () => undefined, some: () => undefined },
} as unknown as Api

/** Each property type, the property of an entity's required field and of an aggregate's. */
export const TYPED_POSITIONS: ReadonlyArray<ContainerPosition> = PROPERTY_TYPES.flatMap(
  (type): ReadonlyArray<ContainerPosition> => [
    {
      ...(type.refused ? { refusedAt: "EDD-9152" as const } : {}),
      position: {
        key: `an entity's required field, the property ${type.name}`,
        build: (api) => ({
          entities: {
            Docs: api.Entity.make({
              model: api.Schema.Struct({ id: api.Schema.String, data: typedStruct(api, type) }),
              entityType: "Doc",
              primaryKey: keyedBy("id"),
            }),
          },
        }),
        steps: () => typedEntitySteps(type),
      },
    },
    {
      ...(type.refused ? { refusedAt: "EDD-9153" as const } : {}),
      position: {
        key: `an aggregate's root required field, the property ${type.name}`,
        build: (api, _name, table) => ({
          entities: {},
          aggregates: { Roots: aggregateOf(api, { data: typedStruct(api, type) }, {}, table) },
        }),
        steps: () => typedAggregateSteps(type),
      },
    },
  ],
)

export const CONTAINER_POSITIONS: ReadonlyArray<ContainerPosition> = [
  ...CONTAINERS.map(
    (container): ContainerPosition => ({
      ...(container.certain ? { refusedAt: "EDD-9152" as const } : {}),
      position: {
        key: `an entity's ${container.name.replace(/^an? /, "")}`,
        build: (api) => ({
          entities: {
            Docs: api.Entity.make({
              model: api.Schema.Struct({
                id: api.Schema.String,
                data: container.schema(api, protoStruct(api)),
              }),
              entityType: "Doc",
              primaryKey: keyedBy("id"),
            }),
          },
        }),
        steps: () => entitySteps(container),
      },
    }),
  ),
  ...CONTAINERS.map(
    (container): ContainerPosition => ({
      ...(container.certain ? { refusedAt: "EDD-9153" as const } : {}),
      position: {
        key: `an aggregate's root ${container.name.replace(/^an? /, "")}`,
        build: (api, _name, table) => ({
          entities: {},
          aggregates: {
            Roots: aggregateOf(api, { data: container.schema(api, protoStruct(api)) }, {}, table),
          },
        }),
        steps: () => aggregateSteps(container),
      },
    }),
  ),
  {
    position: {
      key: "an aggregate's optional one edge",
      build: (api, _name, table) => ({
        entities: {},
        aggregates: {
          Roots: aggregateOf(
            api,
            { data: api.Schema.optional(protoStruct(api)) },
            { data: api.Aggregate.one({ entityType: "RootData" }) },
            table,
          ),
        },
      }),
      steps: () => aggregateSteps(CONTAINERS[1]!),
    },
  },
  {
    position: {
      key: "an aggregate's optional sub-aggregate",
      build: (api, _name, table) => {
        const Data = api.Aggregate.make(protoStruct(api), {
          root: { entityType: "Data" },
          edges: {},
        })
        return {
          entities: {},
          aggregates: {
            Roots: aggregateOf(
              api,
              { data: api.Schema.optional(protoStruct(api)) },
              { data: Data.with({ discriminator: { slot: 1 } }) },
              table,
            ),
          },
        }
      },
      steps: () => aggregateSteps(CONTAINERS[1]!),
    },
  },
]
