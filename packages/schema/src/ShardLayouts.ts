/**
 * ShardLayouts — the shard tables of indexes declared `shards: { layouts: "provided" }`
 * (#287, `docs/designs/shard-layouts.md` §10).
 *
 * An entity is a module-level constant and can't read configuration, so a table
 * holding a production tenant id is supplied at run time: the entity declares the
 * index's layouts `"provided"`, and the application provides the tables through a
 * layer, from configuration ({@link layer}) or from an Effect run at startup
 * ({@link layerEffect}).
 *
 * `DynamoClient.make` reads the service when it binds, so bound operations keep
 * `R = never`; every path that composes keys without a bound client (unbound ops in
 * `Transaction`, `Batch` and `EventStore.append({ additionalItems })`, projection
 * rows, unbound queries and collections, `rekey`) reads it from the context it runs
 * in. A provided index with no table is `[EDD-9180]`, never a fallback.
 *
 * The service is built once, when its layer is built, and never changes: one table
 * per process, no hot reload.
 *
 * @since 1.44.0
 */

import { Config, Context, Effect, Layer, Schema } from "effect"
import type * as DynamoSchema from "./DynamoSchema.js"
import type { CaseInsensitive, ModelFields } from "./internal/EntityTypes.js"
import {
  checkShardTables,
  type IndexDefinition,
  type IndexShards,
  type ShardLayoutConfig,
  type ShardTable,
  shardLayoutsOf,
} from "./KeyComposer.js"

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** What a {@link ShardLayouts} service holds: each provided index's compiled table. */
export interface ShardLayoutsRegistry {
  /** Keyed by the index's normalised `shards`, which is what composers are handed. */
  readonly tables: ReadonlyMap<IndexShards, ShardTable>
}

// ---------------------------------------------------------------------------
// The Table schema
// ---------------------------------------------------------------------------

const Count = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 }))

const LayoutSchema = Schema.Union([
  Count,
  Schema.Struct({ count: Count, previous: Schema.optionalKey(Count) }).check(
    Schema.makeFilter((layout) =>
      layout.previous === undefined || layout.previous !== layout.count
        ? undefined
        : `previous must differ from count (both ${layout.count})`,
    ),
  ),
])

const MatchValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])

const TableSchema = Schema.Struct({
  default: LayoutSchema,
  values: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        match: Schema.Record(Schema.String, MatchValue),
        layout: LayoutSchema,
      }),
    ),
  ),
}).pipe(Schema.brand("@effect-dynamodb/ShardLayouts.Table"))

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One layout: a count (1 is the unsharded key), or `{ count, previous }` while a value migrates. */
export type Layout = ShardLayoutConfig

/** A decoded shard table ({@link Table}): its `match` names are known only at run time. */
export type Table = typeof TableSchema.Type

/** A shard table whose `match` names the partition key composites `P`. */
export interface TypedTable<P extends string> {
  readonly default: Layout
  readonly values?: ReadonlyArray<{
    readonly match: { readonly [K in P]: unknown }
    readonly layout: Layout
  }>
}

/** The model fields of `E`, which a `match`'s values are typed by. */
export type FieldsOf<E> = E extends { readonly model: infer M extends Schema.Top }
  ? ModelFields<M>
  : {}

/** What {@link of} accepts for an entity: one with indexes. */
export interface EntityLike {
  readonly entityType: string
  readonly indexes: Readonly<Record<string, IndexDefinition>>
}

/** The indexes of `E` declared `shards: { layouts: "provided" }`. */
export type ProvidedIndexes<E> = E extends { readonly indexes: infer I }
  ? {
      [K in keyof I]-?: NonNullable<I[K]> extends { readonly shards?: infer S }
        ? NonNullable<S> extends { readonly declared: { readonly layouts: "provided" } }
          ? K
          : never
        : never
    }[keyof I] &
      string
  : never

/** The partition key composites of index `K` of `E`. */
export type PartitionComposites<E, K> = E extends { readonly indexes: infer I }
  ? K extends keyof I
    ? NonNullable<I[K]> extends {
        readonly pk: { readonly composite: infer C extends ReadonlyArray<string> }
      }
      ? C[number]
      : never
    : never
  : never

/** One provided index's table: typed, decoded, or a `Config` of either. */
export type TableInput<P extends string> =
  | TypedTable<P>
  | Table
  | Config.Config<TypedTable<P>>
  | Config.Config<Table>

/** `true` for `any`: an entity whose type is lost (an untyped caller) is checked at run time. */
type IsAny<T> = 0 extends 1 & T ? true : false

/** The tables {@link of} takes for `E`: one for every provided index. */
export type ProvidedTables<E> =
  IsAny<E> extends true
    ? Readonly<Record<string, unknown>>
    : { readonly [K in ProvidedIndexes<E>]: TableInput<PartitionComposites<E, K>> }

/**
 * `of()`'s guard: a key that isn't a provided index is `never`, and in a literal
 * table each `match` key outside the index's partition key composites is `never`,
 * so a typo beside the right name is an error on that entry (a decoded table's
 * names are known only at run time, and are checked when the layer builds).
 */
export type ProvidedTablesGuard<E, T> =
  IsAny<E> extends true ? unknown : ProvidedTablesGuardOf<E, T>

type ProvidedTablesGuardOf<E, T> = {
  readonly [K in keyof T]: K extends ProvidedIndexes<E>
    ? T[K] extends Table | Config.Config<unknown>
      ? unknown
      : T[K] extends { readonly values: infer V extends ReadonlyArray<unknown> }
        ? {
            readonly values: {
              readonly [I in keyof V]: V[I] extends { readonly match: infer M }
                ? {
                    // Every key of the entry is kept, so a fresh literal's other
                    // properties (`layout`) pass the excess property check.
                    readonly [P in keyof V[I]]: P extends "match"
                      ? MatchGuard<M, PartitionComposites<E, K>, FieldsOf<E>>
                      : unknown
                  }
                : unknown
            }
          }
        : unknown
    : never
}

/**
 * A literal `match`: a key outside the partition key composites `P` is `never`, and each
 * composite's value is its type in the model's fields `F`, the value an accessor would pin
 * for it (`123` is not `"123"`: it composes another key).
 */
type MatchGuard<M, P extends string, F> = {
  readonly [X in keyof M]: X extends P
    ? X extends keyof F
      ? CaseInsensitive<F[X]>
      : unknown
    : never
}

declare const EntryTypeId: unique symbol

/** One entity's tables, from {@link of}: what a layer is built from. */
export interface Entry {
  readonly [EntryTypeId]: typeof EntryTypeId
  readonly entity: EntityLike
  readonly tables: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Building a registry
// ---------------------------------------------------------------------------

const misused = (why: string): Error => new Error(`[EDD-9181] ShardLayouts.of: ${why}`)

/** The entity's own compile function: a runtime entity's, or a pure definition's. */
const compilerOf = (
  entity: EntityLike,
): ((indexName: string, declared: unknown) => ShardTable) | undefined => {
  const e = entity as {
    readonly _compileShardTable?: (indexName: string, declared: unknown) => ShardTable
    readonly _data?: { readonly compileShardTable?: (i: string, d: unknown) => ShardTable }
  }
  return e._compileShardTable ?? e._data?.compileShardTable
}

/** The provided indexes of an entity, by logical name. */
const providedIndexesOf = (entity: EntityLike): ReadonlyArray<readonly [string, IndexShards]> =>
  Object.entries(entity.indexes).flatMap(([name, def]) =>
    def.shards !== undefined && shardLayoutsOf(def.shards) === "provided"
      ? [[name, def.shards] as const]
      : [],
  )

/**
 * Compile resolved entries into a registry: each table checked against its entity
 * and index, then its text index built under the entity's schema. A defect for a
 * malformed table (`[EDD-9099]`) or a misuse of `of` (`[EDD-9181]`).
 */
const buildRegistry = (
  entries: ReadonlyArray<{
    readonly entity: EntityLike
    readonly tables: Readonly<Record<string, unknown>>
  }>,
): ShardLayoutsRegistry => {
  const tables = new Map<IndexShards, ShardTable>()
  for (const { entity, tables: given } of entries) {
    const name = entity.entityType
    const compile = compilerOf(entity)
    if (compile === undefined) {
      throw misused(`${JSON.stringify(name)} is not an entity made by Entity.make.`)
    }
    const provided = providedIndexesOf(entity)
    for (const key of Object.keys(given)) {
      if (entity.indexes[key] === undefined || key === "primary") {
        throw misused(`entity "${name}" has no index "${key}".`)
      }
      if (!provided.some(([indexName]) => indexName === key)) {
        // The entity's own message: the index doesn't declare `layouts: "provided"`.
        compile(key, given[key])
      }
    }
    const own = new Map<IndexShards, ShardTable>()
    for (const [indexName, shards] of provided) {
      if (!Object.hasOwn(given, indexName)) {
        throw misused(
          `entity "${name}": index "${indexName}" declares shards: { layouts: "provided" }, but ` +
            `no table is given for it. Give one for every provided index.`,
        )
      }
      if (tables.has(shards)) {
        throw misused(
          `entity "${name}" is given twice: build one layer with one ShardLayouts.of per entity.`,
        )
      }
      own.set(shards, compile(indexName, given[indexName]))
    }
    const schema = (entity as { readonly _schema?: DynamoSchema.DynamoSchema })._schema
    if (schema === undefined) {
      throw misused(
        `entity "${name}" is registered on no table: add it to a Table.make({ entities }) ` +
          `before supplying its shard tables.`,
      )
    }
    // Two entries composing one key, under the casing the keys are composed with.
    checkShardTables(schema, name, entity.indexes, own)
    for (const [shards, table] of own) tables.set(shards, table)
  }
  return { tables }
}

/** Resolve each `Config` in the entries, then build the registry (a defect if it's refused). */
const resolve = (
  entries: ReadonlyArray<Entry>,
): Effect.Effect<ShardLayoutsRegistry, Config.ConfigError> =>
  Effect.gen(function* () {
    const resolved: Array<{
      readonly entity: EntityLike
      readonly tables: Readonly<Record<string, unknown>>
    }> = []
    for (const entry of entries) {
      const tables: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(entry.tables)) {
        tables[key] = Config.isConfig(value) ? yield* value : value
      }
      resolved.push({ entity: entry.entity, tables })
    }
    return yield* Effect.suspend(() => {
      try {
        return Effect.succeed(buildRegistry(resolved))
      } catch (defect) {
        return Effect.die(defect)
      }
    })
  })

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Effect `Context.Service` holding the shard tables of every index declared
 * `shards: { layouts: "provided" }` (#287). Provide it with {@link layer} or
 * {@link layerEffect}, once, in the application layer beside the client. Build one
 * layer with an {@link of} per entity: two `ShardLayouts` layers can't both apply,
 * and the one provided last wins.
 */
export class ShardLayouts extends Context.Service<ShardLayouts, ShardLayoutsRegistry>()(
  "@effect-dynamodb/ShardLayouts",
) {}

/**
 * A Schema for one shard table: `{ default, values? }`, each layout a count in
 * 1..256 or `{ count, previous? }`. For `Config.schema(Schema.fromJsonString(
 * ShardLayouts.Table), "NAME")`, or as a field of an entity holding tables. It
 * checks the shape and the ranges; what needs the entity (the `match` names, the
 * key text, two entries for one key) is checked when the layer is built.
 */
export const Table = TableSchema

/**
 * The tables of one entity's provided indexes: one for each, typed by its
 * partition key composites, a decoded {@link Table}, or a `Config` of either.
 * Checked when the layer is built.
 *
 * @example
 * ```typescript
 * const ShardsLayer = ShardLayouts.layer([
 *   ShardLayouts.of(Devices, {
 *     byTenant: Config.String("BIG_TENANT_ID").pipe(
 *       Config.map((id) => ({ default: 1, values: [{ match: { tenantId: id }, layout: 20 }] })),
 *     ),
 *   }),
 * ])
 * ```
 */
export const of = <E extends EntityLike, const T extends ProvidedTables<E>>(
  entity: E,
  tables: T & ProvidedTablesGuard<E, T>,
): Entry => ({ entity, tables }) as unknown as Entry

/**
 * A layer from entries: each `Config` is read (a `ConfigError` fails the layer),
 * then each table is checked against its entity and index. A malformed table
 * (`[EDD-9099]`) or a misuse of {@link of} (`[EDD-9181]`) is a defect: the
 * application doesn't start.
 */
export const layer = (
  entries: ReadonlyArray<Entry>,
): Layer.Layer<ShardLayouts, Config.ConfigError> => Layer.effect(ShardLayouts, resolve(entries))

/**
 * A layer from an Effect producing entries, run once when the layer is built: a
 * table loaded at startup (a config item, SSM, AppConfig). Its failure is the
 * layer's, so a table that can't be read stops the application from starting
 * rather than letting it run unsharded.
 */
export const layerEffect = <E, R>(
  effect: Effect.Effect<ReadonlyArray<Entry>, E, R>,
): Layer.Layer<ShardLayouts, E | Config.ConfigError, R> =>
  Layer.effect(
    ShardLayouts,
    Effect.flatMap(effect, (entries) => resolve(entries)),
  )

/**
 * A registry built from entries whose tables are values (no `Config`), for tests
 * and tools: throws what {@link layer} dies with.
 */
export const make = (entries: ReadonlyArray<Entry>): ShardLayoutsRegistry => buildRegistry(entries)
