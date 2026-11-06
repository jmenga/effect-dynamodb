/**
 * Clearing a field, at the type level (#177, #178): `.remove` takes the names of model
 * fields a row can lack, and `.set({ f: undefined })` compiles only for those. A stored
 * name, a required field and a typo are compile errors at every position; the run-time
 * refusals they correspond to are in `Entity.clears.test.ts`. Nothing here runs: an
 * effect built inside `compiles` is never executed.
 */
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient, DynamoModel, DynamoSchema, Entity, Table } from "../src/index.js"
import type { BoundAppend, BoundUpdate } from "../src/internal/BoundCrud.js"
import type { EntityUpdate } from "../src/internal/EntityOps.js"

const AppSchema = DynamoSchema.make({ name: "cleartypes", version: 1 })

class Item extends Schema.Class<Item>("ClearTypesItem")({
  id: Schema.String,
  note: Schema.String,
  code: Schema.optional(Schema.String),
  keyed: Schema.optionalKey(Schema.String),
  region: Schema.optional(Schema.String),
  defaulted: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("d"))),
  keyDefault: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("d"))),
  maybe: Schema.OptionFromOptional(Schema.String),
  maybeKey: Schema.OptionFromOptionalKey(Schema.String),
  nullable: Schema.NullOr(Schema.String),
  optionalNullable: Schema.optional(Schema.NullOr(Schema.String)),
  noneIsNull: Schema.OptionFromNullOr(Schema.String),
  fixed: Schema.optional(Schema.String),
  tags: Schema.Record(Schema.String, Schema.Number),
}) {}

const Items = Entity.make({
  model: DynamoModel.configure(Item, {
    region: { field: "g" },
    fixed: { immutable: true },
    tags: { storedAs: DynamoModel.SparseMap() },
  }),
  entityType: "Item",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byRegion: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", composite: ["id"] },
    },
  },
  timestamps: true,
  versioned: true,
})

class Reading extends Schema.Class<Reading>("ClearTypesReading")({
  id: Schema.String,
  at: Schema.Number,
  reading: Schema.Number,
  alert: Schema.optional(Schema.String),
  enrichment: Schema.optional(Schema.String),
}) {}

const Readings = Entity.make({
  model: DynamoModel.configure(Reading, { alert: { field: "a" } }),
  entityType: "Reading",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      id: Schema.String,
      at: Schema.Number,
      reading: Schema.Number,
      alert: Schema.optional(Schema.String),
    }),
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Items, Readings } })

const key = { id: "1" }

/** The type checker reads the body. Nothing runs it. */
const compiles = (_body: () => unknown) => undefined

describe("BoundUpdate", () => {
  const db = () =>
    Effect.gen(function* () {
      const client = yield* DynamoClient.make({
        entities: { Items, Readings },
        tables: { MainTable },
      })
      return client.entities
    })
  type Db = Effect.Success<ReturnType<typeof db>>
  const bound = undefined as unknown as Db

  it(".remove takes a field a row can lack, by its model name", () => {
    compiles(() => {
      const u = bound.Items.update(key)
      u.remove([])
      u.remove(["code"])
      u.remove(["keyed"])
      u.remove(["region"])
      u.remove(["defaulted"])
      u.remove(["keyDefault"])
      u.remove(["maybe"])
      u.remove(["maybeKey"])
      u.remove(["optionalNullable"])
      u.remove(["code", "keyed"])
      u.set({ note: "n" }).remove(["code"]).expectedVersion(1)
      const fields: ReadonlyArray<"code" | "keyed"> = ["code"]
      u.remove(fields)
      const narrowed = ["code", "keyed"] as const
      u.remove(narrowed)
    })
    expect(true).toBe(true)
  })

  it(".remove refuses what isn't one", () => {
    compiles(() => {
      const u = bound.Items.update(key)
      // @ts-expect-error a required field
      u.remove(["note"])
      // @ts-expect-error a required key whose value may be empty
      u.remove(["nullable"])
      // @ts-expect-error None encodes to `null`, stored: a row can't lack it
      u.remove(["noneIsNull"])
      // @ts-expect-error a typo
      u.remove(["cod"])
      // @ts-expect-error a stored name
      u.remove(["g"])
      // @ts-expect-error an index's key attribute
      u.remove(["gsi1pk"])
      // @ts-expect-error the discriminator
      u.remove(["__edd_e__"])
      // @ts-expect-error the version
      u.remove(["version"])
      // @ts-expect-error a timestamp
      u.remove(["createdAt"])
      // @ts-expect-error a timestamp
      u.remove(["updatedAt"])
      // @ts-expect-error a primary-key composite
      u.remove(["id"])
      // @ts-expect-error immutable
      u.remove(["fixed"])
      // @ts-expect-error a sparse map: `.removeEntries` or `.clearMap`
      u.remove(["tags"])
      // @ts-expect-error mixed with one that's fine
      u.remove(["code", "note"])
      const names: Array<string> = ["code"]
      // @ts-expect-error a `string[]` says nothing about what's in it
      u.remove(names)
    })
    expect(true).toBe(true)
  })

  it(".pathRemove stays open: it's how an undeclared attribute is cleaned up", () => {
    compiles(() => {
      bound.Items.update(key).pathRemove(["legacy"])
      bound.Items.update(key).pathRemove(["address", "zip"])
    })
    expect(true).toBe(true)
  })

  it(".set({ f: undefined }) compiles for a field a row can lack", () => {
    compiles(() => {
      const u = bound.Items.update(key)
      u.set({ code: undefined })
      u.set({ keyed: undefined })
      u.set({ region: undefined })
      u.set({ defaulted: undefined })
      u.set({ keyDefault: undefined })
      u.set({ maybe: undefined })
      u.set({ maybeKey: undefined })
      u.set({ optionalNullable: undefined })
      u.set({ optionalNullable: null })
    })
    expect(true).toBe(true)
  })

  it(".set({ f: undefined }) is an error for a field a row can't lack", () => {
    compiles(() => {
      const u = bound.Items.update(key)
      // @ts-expect-error required
      u.set({ note: undefined })
      // @ts-expect-error a required key whose value may be empty
      u.set({ nullable: undefined })
      // @ts-expect-error required, beside a field that's fine
      u.set({ note: undefined, code: undefined })
      u.set({ note: "n", nullable: null })
    })
    expect(true).toBe(true)
  })
})

describe("BoundAppend", () => {
  const db = () =>
    Effect.gen(function* () {
      const client = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
      return client.entities
    })
  type Db = Effect.Success<ReturnType<typeof db>>
  const bound = undefined as unknown as Db
  const input = { id: "1", at: 1, reading: 1 }

  it(".remove takes what appendInput declares and a row can lack", () => {
    compiles(() => {
      bound.Readings.append(input).remove(["alert"])
    })
    expect(true).toBe(true)
  })

  it(".remove refuses the rest", () => {
    compiles(() => {
      const a = bound.Readings.append(input)
      // @ts-expect-error required
      a.remove(["reading"])
      // @ts-expect-error the clock
      a.remove(["at"])
      // @ts-expect-error a primary-key composite
      a.remove(["id"])
      // @ts-expect-error a stored name
      a.remove(["a"])
      // @ts-expect-error not declared in appendInput
      a.remove(["enrichment"])
      // @ts-expect-error a typo
      a.remove(["alrt"])
    })
    expect(true).toBe(true)
  })
})

describe("Entity.remove", () => {
  it("data-first", () => {
    compiles(() => {
      const update = Items.update(key)
      Entity.remove(update, ["code"])
      Entity.remove(update, ["keyed", "region"])
      // @ts-expect-error required
      Entity.remove(update, ["note"])
      // @ts-expect-error a stored name
      Entity.remove(update, ["g"])
      // @ts-expect-error a typo
      Entity.remove(update, ["cod"])
    })
    expect(true).toBe(true)
  })

  it("data-last, in a pipe", () => {
    compiles(() => {
      const update = Items.update(key)
      update.pipe(Entity.remove(["code"]))
      update.pipe(Entity.set({ note: "n" }), Entity.remove(["code"]))
      // @ts-expect-error required
      update.pipe(Entity.remove(["note"]))
      // @ts-expect-error a stored name
      update.pipe(Entity.remove(["g"]))
      // @ts-expect-error a typo
      update.pipe(Entity.remove(["cod"]))
    })
    expect(true).toBe(true)
  })

  it("Entity.pathRemove stays open", () => {
    compiles(() => {
      Entity.pathRemove(Items.update(key), ["legacy"])
    })
    expect(true).toBe(true)
  })
})

describe("the unbound append", () => {
  it("removeAttrs", () => {
    compiles(() => {
      const input = { id: "1", at: 1, reading: 1 }
      Readings.append(input, undefined, false, ["alert"])
      // @ts-expect-error required
      Readings.append(input, undefined, false, ["reading"])
      // @ts-expect-error a stored name
      Readings.append(input, undefined, false, ["a"])
    })
    expect(true).toBe(true)
  })
})

describe("a model the types can't read", () => {
  it("a field name stays a string when the model's fields aren't known", () => {
    compiles(() => {
      const anyModel = Schema.Struct({ id: Schema.String }) as unknown as Schema.Codec<any>
      const Open = Entity.make({
        model: anyModel,
        entityType: "Open",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      })
      Open.update({ id: "1" }).pipe(Entity.remove(["whatever"]))
    })
    expect(true).toBe(true)
  })
})

describe("an appendInput that can't compose a sharded index's key (EDD-9113)", () => {
  class Series extends Schema.Class<Series>("ClearTypesSeries")({
    id: Schema.String,
    at: Schema.Number,
    tenant: Schema.String,
    region: Schema.optional(Schema.String),
    group: Schema.optional(Schema.String),
  }) {}
  const primaryKey = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  } as const
  const indexes = {
    byTenant: {
      name: "gsi",
      indexPolicy: { pk: "preserve", sk: "preserve" },
      pk: { field: "gpk", composite: ["tenant"] },
      sk: { field: "gsk", composite: ["region", "group"] },
      shards: { count: 4, by: ["group"] },
    },
  } as const

  it("the whole key is fine", () => {
    Entity.make({
      model: Series,
      entityType: "Series",
      primaryKey,
      indexes,
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({
          id: Schema.String,
          at: Schema.Number,
          tenant: Schema.String,
          region: Schema.String,
          group: Schema.String,
        }),
      },
    })
  })

  it("`by` without the composite before it is a compile error, and throws at make", () => {
    expect(() =>
      Entity.make({
        model: Series,
        entityType: "Series",
        primaryKey,
        indexes,
        timeSeries: {
          orderBy: "at",
          // @ts-expect-error carries `group` but not `region`
          appendInput: Schema.Struct({
            id: Schema.String,
            at: Schema.Number,
            tenant: Schema.String,
            group: Schema.String,
          }),
        },
      }),
    ).toThrow("[EDD-9113]")
  })

  it("not carrying `by` compiles", () => {
    Entity.make({
      model: Series,
      entityType: "Series",
      primaryKey,
      indexes,
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({ id: Schema.String, at: Schema.Number, tenant: Schema.String }),
      },
    })
  })
})

describe("a value with no stored form", () => {
  class Row extends Schema.Class<Row>("ClearTypesNoStoredForm")({
    id: Schema.String,
    note: Schema.String,
    nullable: Schema.NullOr(Schema.String),
    set: Schema.ReadonlySet(Schema.String),
    numbers: Schema.ReadonlySet(Schema.Number),
    undefinable: Schema.UndefinedOr(Schema.String),
    nullableSet: Schema.NullOr(Schema.ReadonlySet(Schema.String)),
    unknown: Schema.Unknown,
    filled: Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(1)),
  }) {}
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const MainTable = Table.make({ schema: AppSchema, entities: { Rows } })
  const key = { id: "1" }

  it("a set and an UndefinedOr can be cleared, and take `undefined`", () => {
    const compiles = Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Rows }, tables: { MainTable } })
      const rows = db.entities.Rows
      rows.update(key).remove(["set", "numbers", "undefinable", "nullableSet", "unknown"])
      rows.update(key).set({
        set: undefined,
        numbers: undefined,
        undefinable: undefined,
        nullableSet: undefined,
        unknown: undefined,
      })
      rows.update(key).set({ set: new Set<string>(), nullableSet: null })
      rows.update(key).deleteFromSet({ set: new Set(["a"]) })
      rows.update(key).add({ set: new Set(["a"]), numbers: new Set([1]) })
      Rows.update(key).pipe(Entity.add({ set: new Set(["a"]) }))
      // @ts-expect-error a list isn't a set, and ADD can't take one
      rows.update(key).add({ set: ["a"] })
    })
    expect(Effect.isEffect(compiles)).toBe(true)
  })

  it("a required field beside them still can't", () => {
    const compiles = Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Rows }, tables: { MainTable } })
      const rows = db.entities.Rows
      // @ts-expect-error the model requires it
      rows.update(key).remove(["note"])
      // @ts-expect-error null is a value it holds, and an absent attribute isn't one
      rows.update(key).remove(["nullable"])
      // @ts-expect-error the model requires it
      rows.update(key).set({ note: undefined })
      // @ts-expect-error null is a value it holds, and an absent attribute isn't one
      rows.update(key).set({ nullable: undefined })
    })
    expect(Effect.isEffect(compiles)).toBe(true)
  })

  it("a read holds the field as the model declares it, not as optional", () => {
    const read = (row: Entity.Record<typeof Rows>) => {
      const set: ReadonlySet<string> = row.set
      const undefinable: string | undefined = row.undefinable
      return [set, undefinable]
    }
    expect(typeof read).toBe("function")
  })

  it("a set whose .check() refuses an empty one compiles: a type can't see it, the run time refuses", () => {
    const compiles = Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Rows }, tables: { MainTable } })
      db.entities.Rows.update(key).remove(["filled"])
    })
    expect(Effect.isEffect(compiles)).toBe(true)
  })
})

/**
 * `Entity` gained a 14th type parameter and `BoundEntity` an 11th, for the names `.remove()`
 * refuses by configuration. Types written with the old argument count must still compile, on
 * an entity with such a field too. Every position the names reach is compared both ways.
 */
describe("types written with the argument counts before the removable names", () => {
  class Plain extends Schema.Class<Plain>("ClearTypesPositional")({
    id: Schema.String,
    note: Schema.optional(Schema.String),
    held: Schema.optional(Schema.String),
  }) {}
  const primaryKey = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  } as const
  const Unconfigured = Entity.make({ model: Plain, entityType: "Plain", primaryKey })
  const Configured = Entity.make({
    model: DynamoModel.configure(Plain, { held: { immutable: true } }),
    entityType: "Configured",
    primaryKey,
  })
  const Definition = PureEntity.make({
    model: DynamoModel.configure(Plain, { held: { immutable: true } }),
    entityType: "Pure",
    primaryKey,
  })
  const MainTable = Table.make({ schema: AppSchema, entities: { Unconfigured, Configured } })

  type ThirteenOf<E> =
    E extends Entity.Entity<
      infer A,
      infer B,
      infer C,
      infer D,
      infer F,
      infer G,
      infer H,
      infer I,
      infer J,
      infer K,
      infer L,
      infer M,
      infer N
    >
      ? Entity.Entity<A, B, C, D, F, G, H, I, J, K, L, M, N>
      : "no match"
  type ThirteenOfDefinition<E> =
    E extends PureEntity.EntityDefinition<
      infer A,
      infer B,
      infer C,
      infer D,
      infer F,
      infer G,
      infer H,
      infer I,
      infer J,
      infer K,
      infer L,
      infer M,
      infer N
    >
      ? PureEntity.EntityDefinition<A, B, C, D, F, G, H, I, J, K, L, M, N>
      : "no match"

  it("Entity, with and without an immutable field", () => {
    const unconfigured: ThirteenOf<typeof Unconfigured> = Unconfigured
    const configured: ThirteenOf<typeof Configured> = Configured
    expect([unconfigured, configured]).toHaveLength(2)
  })

  it("EntityDefinition", () => {
    const definition: ThirteenOfDefinition<typeof Definition> = Definition
    expect(definition.entityType).toBe("Pure")
  })

  it("a generic function over thirteen positions", () => {
    const takes = <
      M extends Schema.Top,
      T extends string,
      I extends Record<string, any>,
      P extends string,
    >(
      entity: Entity.Entity<M, T, I, any, any, any, any, any, any, any, any, any, P>,
    ) => entity.model
    expect(takes(Configured)).toBe(Configured.model)
  })

  it("an update held in its positional type", () => {
    type Parts<E> = E extends {
      readonly update: (...args: any) => EntityUpdate<infer A, infer B, any, infer D, infer F>
    }
      ? readonly [A, B, D, F]
      : never
    type P = Parts<typeof Configured>
    const held: EntityUpdate<
      P[0],
      P[1],
      Entity.Update<typeof Configured>,
      P[2],
      P[3]
    > = Configured.update({ id: "1" })
    const anything: EntityUpdate<any, any, any, any, any> = Configured.update({ id: "1" })
    expect([held, anything]).toHaveLength(2)
  })

  it("a client over an entity annotated with thirteen positions", () => {
    const Annotated: ThirteenOf<typeof Configured> = Configured
    const AnnotatedTable = Table.make({ schema: AppSchema, entities: { Annotated } })
    const compiles = Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Annotated },
        tables: { AnnotatedTable },
      })
      // The annotation forgot which field is immutable: the run time still refuses it.
      db.entities.Annotated.update({ id: "1" }).remove(["held"])
      // @ts-expect-error a typo is still one
      db.entities.Annotated.update({ id: "1" }).remove(["nope"])
    })
    expect(Effect.isEffect(compiles)).toBe(true)
  })

  it("BoundEntity and BoundUpdate", () => {
    const compiles = Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Unconfigured, Configured },
        tables: { MainTable },
      })
      const unconfigured: Entity.BoundEntity<
        typeof Plain,
        typeof Unconfigured.indexes,
        undefined,
        { readonly id: string },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        never
      > = db.entities.Unconfigured
      const configured: Entity.BoundEntity<
        typeof Plain,
        typeof Configured.indexes,
        undefined,
        { readonly id: string },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        never
      > = db.entities.Configured
      const clearing = <M, A, U, E>(update: BoundUpdate<M, A, U, E, never>) =>
        update.remove(["note"])
      return [unconfigured, configured, clearing(db.entities.Configured.update({ id: "1" }))]
    })
    expect(Effect.isEffect(compiles)).toBe(true)
  })

  it("BoundAppend", () => {
    const compiles = Effect.gen(function* () {
      const ReadingsTable = Table.make({ schema: AppSchema, entities: { Readings } })
      const db = yield* DynamoClient.make({ entities: { Readings }, tables: { ReadingsTable } })
      const clearing = <M, A, E, S>(append: BoundAppend<M, A, E, S, never>) =>
        append.remove(["alert"])
      return clearing(db.entities.Readings.append({ id: "1", at: 1, reading: 1 }))
    })
    expect(Effect.isEffect(compiles)).toBe(true)
  })

  it("the client still narrows what it knows", () => {
    const compiles = Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Configured }, tables: { MainTable } })
      db.entities.Configured.update({ id: "1" }).remove(["note"])
      // @ts-expect-error immutable
      db.entities.Configured.update({ id: "1" }).remove(["held"])
    })
    expect(Effect.isEffect(compiles)).toBe(true)
  })

  it("the unbound form narrows too", () => {
    Configured.update({ id: "1" }).pipe(Entity.remove(["note"]))
    // @ts-expect-error immutable
    Configured.update({ id: "1" }).pipe(Entity.remove(["held"]))
  })
})
