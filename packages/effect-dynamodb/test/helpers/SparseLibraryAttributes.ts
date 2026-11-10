/**
 * Definitions that store an attribute of their own where a row's reader takes it as a sparse map's
 * entry, and what the published 1.39.0 made of the rows it wrote for them.
 *
 * `test/fixtures/sparse-library-attributes-1.39.0.json` holds, for every case here, the rows 1.39.0
 * stored and what it read back, captured by running `capture` against it.
 * `test/SparseLibraryAttributes.test.ts` checks that record and that each definition is now refused.
 *
 * The library is taken as a parameter, so one definition serves both.
 */

import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { makeRecordingTable } from "./RecordingTable.js"

/** The library's public modules, of whichever release is under test. */
export interface Api {
  readonly DynamoClient: any
  readonly DynamoModel: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly Table: any
}

export const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}

export interface Case {
  readonly key: string
  /** The attribute the reader takes as an entry of `data`, and the name beside it that it doesn't. */
  readonly attribute: string
  readonly allowed: string
  /** Where the name is checked: when the entity is made, or when its table is bound. */
  readonly refusedAt: "Entity.make" | "DynamoClient.make"
  /** What a read returns of the definition storing `allowed`, where it isn't `data: { ok: 1 }`. */
  readonly allowedReads?: Record<string, unknown>
  /** The entity's configuration, storing `name` (`attribute`, or `allowed`). */
  readonly entity: (api: Api, name: string) => Record<string, unknown>
  /** The table's TTL attribute, for a case that names it. */
  readonly ttlAttribute?: (name: string) => string
  /** Writes rows of item `a` and reads one back. */
  readonly read: (db: any, name: string) => Effect.Effect<unknown, unknown, any>
}

const counted = (api: Api, extra: Record<string, Schema.Top> = {}, renames = {}) =>
  api.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      data: Schema.Record(Schema.String, Schema.Number),
      ...extra,
    }),
    { data: { storedAs: api.DynamoModel.SparseMap() }, ...renames },
  )

const putThenGet =
  (extra: Record<string, unknown> = {}) =>
  (db: any) =>
    Effect.gen(function* () {
      yield* db.entities.Docs.put({ id: "a", data: { ok: 1 }, ...extra }).asEffect()
      return yield* db.entities.Docs.get({ id: "a" })
    })

export const cases: ReadonlyArray<Case> = [
  {
    key: "the created timestamp",
    attribute: "data#created",
    allowed: "data_created",
    refusedAt: "Entity.make",
    entity: (api, name) => ({ model: counted(api), timestamps: { created: name } }),
    read: putThenGet(),
  },
  {
    key: "the updated timestamp",
    attribute: "data#updated",
    allowed: "data_updated",
    refusedAt: "Entity.make",
    entity: (api, name) => ({ model: counted(api), timestamps: { updated: name } }),
    read: putThenGet(),
  },
  {
    key: "the version",
    attribute: "data#v",
    allowed: "data_v",
    refusedAt: "Entity.make",
    entity: (api, name) => ({ model: counted(api), versioned: { field: name } }),
    read: putThenGet(),
  },
  {
    key: "a field renamed into the map's prefix",
    attribute: "data#x",
    allowed: "data_x",
    refusedAt: "Entity.make",
    entity: (api, name) => ({
      model: counted(api, { counter: Schema.Number }, { counter: { field: name } }),
    }),
    read: putThenGet({ counter: 7 }),
  },
  {
    key: "a field named in the map's prefix",
    attribute: "data#x",
    allowed: "data_x",
    refusedAt: "Entity.make",
    entity: (api, name) => ({ model: counted(api, { [name]: Schema.Number }) }),
    read: (db, name) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put({ id: "a", data: { ok: 1 }, [name]: 7 }).asEffect()
        return yield* db.entities.Docs.get({ id: "a" })
      }),
  },
  {
    key: "a sparse map a put stores whole",
    attribute: "data#shadow",
    allowed: "other",
    refusedAt: "Entity.make",
    entity: (api, name) => ({
      model: counted(
        api,
        { aux: Schema.Record(Schema.String, Schema.Number) },
        { aux: { storedAs: api.DynamoModel.SparseMap(), field: name } },
      ),
    }),
    read: putThenGet({ aux: { y: 2 } }),
    allowedReads: { data: { ok: 1 }, aux: { y: 2 } },
  },
  {
    key: "the TTL of a retained version",
    attribute: "data#expires",
    allowed: "expires",
    refusedAt: "DynamoClient.make",
    entity: (api) => ({ model: counted(api), versioned: { retain: true, ttl: "1 day" } }),
    ttlAttribute: (name) => name,
    read: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put({ id: "a", data: { ok: 1 } }).asEffect()
        yield* db.entities.Docs.update({ id: "a" })
          .set({ data: { more: 2 } })
          .asEffect()
        return yield* db.entities.Docs.getVersion({ id: "a" }, 1)
      }),
  },
  {
    key: "the TTL of a soft-deleted row",
    attribute: "data#expires",
    allowed: "expires",
    refusedAt: "DynamoClient.make",
    entity: (api) => ({ model: counted(api), softDelete: { ttl: "1 day" } }),
    ttlAttribute: (name) => name,
    read: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put({ id: "a", data: { ok: 1 } }).asEffect()
        yield* db.entities.Docs.delete({ id: "a" }).asEffect()
        return yield* db.entities.Docs.deleted.get({ id: "a" })
      }),
  },
  {
    key: "the TTL of a time series' event",
    attribute: "data#expires",
    allowed: "expires",
    refusedAt: "DynamoClient.make",
    entity: (api) => ({
      model: counted(api, { seq: Schema.Number }),
      timeSeries: {
        orderBy: "seq",
        ttl: "1 day",
        appendInput: Schema.Struct({ id: Schema.String, seq: Schema.Number }),
      },
    }),
    ttlAttribute: (name) => name,
    read: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.append({ id: "a", seq: 1 }).asEffect()
        return yield* db.entities.Docs.history({ id: "a" }).collect()
      }),
  },
]

/**
 * Definitions that look like the ones above and store nothing where a reader takes it as an entry:
 * 1.39.0 read their rows back, and they still load.
 */
export const loads: ReadonlyArray<Case> = [
  {
    key: "a created timestamp the model declares, named in the prefix and stored outside it",
    attribute: "safeDate",
    allowed: "safeDate",
    refusedAt: "Entity.make",
    entity: (api, name) => ({
      model: counted(api, { "data#created": Schema.Date }, { "data#created": { field: name } }),
      timestamps: { created: "data#created" },
    }),
    read: putThenGet(),
  },
  {
    key: "an updated timestamp the model declares, named in the prefix and stored outside it",
    attribute: "safeDate",
    allowed: "safeDate",
    refusedAt: "Entity.make",
    entity: (api, name) => ({
      model: counted(api, { "data#updated": Schema.Date }, { "data#updated": { field: name } }),
      timestamps: { updated: "data#updated" },
    }),
    read: putThenGet(),
  },
  {
    // `versioned: { ttl }` without `retain` writes no snapshot, so no TTL attribute.
    key: "a version TTL on an entity that retains nothing, beside a TTL attribute in the prefix",
    attribute: "data#expires",
    allowed: "data#expires",
    refusedAt: "DynamoClient.make",
    entity: (api) => ({ model: counted(api), versioned: { ttl: "1 day" } }),
    ttlAttribute: (name) => name,
    read: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put({ id: "a", data: { ok: 1 } }).asEffect()
        yield* db.entities.Docs.update({ id: "a" })
          .set({ data: { more: 2 } })
          .asEffect()
        return yield* db.entities.Docs.get({ id: "a" })
      }),
  },
]

/** JSON as a fixture holds it. */
export const plain = <A>(value: A): A =>
  JSON.parse(JSON.stringify(value, (_key, held) => (typeof held === "bigint" ? `${held}n` : held)))

export interface Captured {
  /** Every row the writes stored. */
  readonly rows: ReadonlyArray<Record<string, unknown>>
  /** What the read returned, or how it failed. */
  readonly read: { readonly value: unknown } | { readonly failed: string }
}

/** Makes the entity storing `name`, binds it, and runs the case's writes and read. */
export const capture = (api: Api, each: Case, name: string): Effect.Effect<Captured> => {
  const table = makeRecordingTable()
  return Effect.suspend(() => {
    const Docs = api.Entity.make({ entityType: "Doc", primaryKey, ...each.entity(api, name) })
    const MainTable = api.Table.make({
      schema: api.DynamoSchema.make({ name: "library", version: 1 }),
      entities: { Docs },
    })
    return Effect.gen(function* () {
      const db: any = yield* api.DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
      const exit = yield* Effect.exit(Effect.suspend(() => each.read(db, name)))
      return {
        rows: plain([...table.items.values()]),
        read: Exit.isSuccess(exit)
          ? { value: plain(exit.value) }
          : { failed: String((Cause.squash(exit.cause) as { _tag?: string })._tag) },
      }
    }).pipe(
      Effect.provide(
        MainTable.layer({
          name: "library",
          ...(each.ttlAttribute ? { ttlAttributeName: each.ttlAttribute(name) } : {}),
        }),
      ),
      Effect.provide(Layer.succeed(api.DynamoClient, table.client)),
      Effect.provide(
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((n) => new Uint8Array(n).fill(7)),
        ),
      ),
    )
  }) as unknown as Effect.Effect<Captured>
}
