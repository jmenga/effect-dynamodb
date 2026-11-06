/**
 * Clearing a field, at the type level (#177, #178): `.remove` takes the names of model
 * fields a row can lack, and `.set({ f: undefined })` compiles only for those. A stored
 * name, a required field and a typo are compile errors at every position; the run-time
 * refusals they correspond to are in `Entity.clears.test.ts`. Nothing here runs: an
 * effect built inside `compiles` is never executed.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient, DynamoModel, DynamoSchema, Entity, Table } from "../src/index.js"

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
