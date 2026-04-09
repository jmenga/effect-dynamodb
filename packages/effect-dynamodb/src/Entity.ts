/**
 * Entity — Binds a domain model to a Table with ElectroDB-style index definitions,
 * system field configuration, unique constraints, and CRUD operations.
 *
 * Entity.make() returns a definition + operations namespace. The Entity object
 * carries derived schemas for 7 type extractors (Model, Record, Input, Update,
 * Key, Item, Marshalled).
 */

import type { AttributeValue, DeleteItemCommandInput } from "@aws-sdk/client-dynamodb"
import { Duration, Effect, Schema, Stream } from "effect"
import { DynamoClient, type DynamoClientError } from "./DynamoClient.js"
import {
  type ConfiguredModel,
  type DynamoEncoding,
  type ExtractIdentifier,
  getEncoding,
  getIdentifierField,
  isConfiguredModel,
  isHidden,
  isRef,
  isRefField,
} from "./DynamoModel.js"
import * as DynamoSchema from "./DynamoSchema.js"
import {
  CascadePartialFailure,
  ConditionalCheckFailed,
  ItemNotFound,
  isAwsConditionalCheckFailed,
  isAwsTransactionCancelled,
  OptimisticLockError,
  RefNotFound,
  TransactionOverflow,
  UniqueConstraintViolation,
  ValidationError,
} from "./Errors.js"
import type { ConditionInput } from "./Expression.js"
import {
  compileExpr,
  createConditionOps,
  type Expr,
  isExpr,
  parseShorthand,
  parseSimpleShorthand,
} from "./internal/Expr.js"
import { type BoundQueryConfig, BoundQueryImpl } from "./internal/BoundQuery.js"
import { compilePath, createPathBuilder } from "./internal/PathBuilder.js"
import type { GsiConfig, IndexDefinition, KeyPart } from "./KeyComposer.js"
import * as KeyComposer from "./KeyComposer.js"
import { normalizeGsiConfig } from "./KeyComposer.js"
import {
  deserializeDateFromDynamo,
  fromAttributeMap,
  serializeDateForDynamo,
  toAttributeMap,
  toAttributeValue,
} from "./Marshaller.js"
import * as Query from "./Query.js"
import { filterExpr, selectPaths } from "./Query.js"
import type { TableConfig } from "./Table.js"

// Internal modules (decomposed from Entity.ts)
export type {
  CascadeIndexConfig,
  RefValue,
  SoftDeleteConfig,
  TimestampFieldConfig,
  TimestampsConfig,
  UniqueConfig,
  UniqueConstraintDef,
  UniqueFieldsDef,
  VersionedConfig,
} from "./internal/EntityConfig.js"
export {
  type CascadeConfig,
  type CascadeTarget,
  type DecodeMode,
  type EntityBase,
  type EntityDelete,
  EntityDeleteImpl,
  EntityDeleteTypeId,
  type EntityGet,
  EntityGetImpl,
  type EntityGetOpts,
  type EntityOp,
  EntityOpTypeId,
  type EntityPut,
  EntityPutImpl,
  type EntityUpdate,
  EntityUpdateImpl,
  EntityUpdateTypeId,
  emptyUpdateState,
  type ReturnValuesMode,
  returnValuesMap,
  type UpdateState,
} from "./internal/EntityOps.js"

import {
  type CascadeConfig,
  type CascadeTarget,
  type DecodeMode,
  type EntityDelete,
  EntityDeleteImpl,
  EntityDeleteTypeId,
  type EntityGet,
  EntityGetImpl,
  type EntityGetOpts,
  EntityOpTypeId,
  type EntityPut,
  EntityPutImpl,
  type EntityUpdate,
  EntityUpdateImpl,
  emptyUpdateState,
  type ReturnValuesMode,
  returnValuesMap,
  type UpdateState,
} from "./internal/EntityOps.js"
import * as Projection from "./Projection.js"

export {
  add,
  append,
  asItem,
  asModel,
  asNative,
  asRecord,
  cascade,
  consistentRead,
  deleteFromSet,
  expectedVersion,
  pathAdd,
  pathAppend,
  pathDelete,
  pathIfNotExists,
  pathPrepend,
  pathRemove,
  pathSet,
  pathSubtract,
  project,
  remove,
  returnValues,
  set,
  subtract,
} from "./internal/EntityCombinators.js"

import {
  asModel,
  condition as conditionCombinator,
  expectedVersion,
  set,
} from "./internal/EntityCombinators.js"
import type {
  CascadeIndexConfig,
  SoftDeleteConfig,
  TimestampsConfig,
  UniqueConfig,
  VersionedConfig,
} from "./internal/EntityConfig.js"

/** A ref config object: the entity and optional cascade index config. */
interface AnyRefValue {
  readonly entity: Entity<any, any, any, any, any, any, any, any, any>
  readonly cascade?: CascadeIndexConfig
}

import {
  allCompositeAttributes,
  allKeyFieldNames,
  buildDerivedSchemas,
  type DerivedSchemas,
  getFields,
  inferDefaultEncoding,
  primaryKeyComposites,
  type ResolvedSystemFields,
  resolveSystemFields,
  resolveUniqueFields,
} from "./internal/EntitySchemas.js"
import type {
  EntityInputType,
  EntityKeyType,
  EntityRecordType,
  EntityRefCreateType,
  EntityRefInputType,
  EntityRefUpdateType,
  EntityUpdateType,
  IndexPkInput,
  ModelType,
  PrimaryKeyComposites,
  RefErrors,
} from "./internal/EntityTypes.js"

// ---------------------------------------------------------------------------
// Re-export KeyComposer types for convenience
// ---------------------------------------------------------------------------

export type { IndexDefinition, KeyPart }

// ---------------------------------------------------------------------------
// Entity interface — the return type of Entity.make()
// ---------------------------------------------------------------------------

/**
 * An Entity binds a domain model to a DynamoDB Table with index definitions,
 * system field configuration, unique constraints, and CRUD operations.
 *
 * Created via {@link make}. Returns a definition with descriptor builders.
 * Table association and binding happen via `DynamoClient.make()`.
 *
 * @typeParam TModel - Effect Schema defining the domain model
 * @typeParam TEntityType - Literal string discriminator stored as `__edd_e__`
 * @typeParam TIndexes - Index definitions (primary + GSIs)
 * @typeParam TTimestamps - Timestamp configuration
 * @typeParam TVersioned - Optimistic locking configuration
 * @typeParam TSoftDelete - Soft-delete configuration
 * @typeParam TUnique - Unique constraint definitions
 * @typeParam TIdentifier - Identifier field name (auto-generated, omitted from Create type)
 */
export interface Entity<
  TModel extends Schema.Top = Schema.Top,
  TEntityType extends string = string,
  TIndexes extends globalThis.Record<string, IndexDefinition> = globalThis.Record<
    string,
    IndexDefinition
  >,
  TTimestamps extends TimestampsConfig | undefined = TimestampsConfig | undefined,
  TVersioned extends VersionedConfig | undefined = VersionedConfig | undefined,
  TSoftDelete extends SoftDeleteConfig | undefined = SoftDeleteConfig | undefined,
  TUnique extends UniqueConfig | undefined = UniqueConfig | undefined,
  TRefs extends globalThis.Record<string, AnyRefValue> | undefined = undefined,
  TIdentifier extends string | undefined = undefined,
> {
  readonly _tag: "Entity"
  readonly model: TModel
  readonly entityType: TEntityType
  readonly indexes: TIndexes
  readonly timestamps: TTimestamps
  readonly versioned: TVersioned
  readonly softDelete: TSoftDelete
  readonly unique: TUnique
  readonly identifier: TIdentifier

  /** @internal Resolved ref metadata — used by cascade to inspect target entities */
  readonly _resolvedRefs: ReadonlyArray<{
    readonly fieldName: string
    readonly idFieldName: string
    readonly identifierField: string
    readonly refEntityType: string
  }>

  /** @internal Full decode pipeline: rename + date deser + schema decode. Used by Batch/Aggregate. */
  readonly _decodeRecord: (
    raw: globalThis.Record<string, unknown>,
  ) => Effect.Effect<any, ValidationError>

  /** @internal Attach model class prototype to a decoded plain object (no-op for Schema.Struct models). */
  readonly _attachPrototype: (decoded: any) => any

  /**
   * @internal Configure the entity with table schema and tag.
   * Called by DynamoClient.make() when binding entities to a table.
   */
  readonly _configure: (
    schema: DynamoSchema.DynamoSchema,
    tableTag: import("effect").ServiceMap.Service<TableConfig, TableConfig>,
  ) => void

  /**
   * @internal Inject a GSI index definition into this entity.
   * Called by Collections binding or DynamoClient.make() to add collection-owned indexes.
   * The injected index becomes available to all entity operations (put, update, etc.)
   * for key composition.
   */
  readonly _injectIndex: (name: string, def: IndexDefinition) => void

  /** @internal Injected DynamoSchema — available after _configure(). Used by cascade. */
  readonly _schema: DynamoSchema.DynamoSchema
  /** @internal Injected TableConfig tag — available after _configure(). Used by cascade. */
  readonly _tableTag: import("effect").ServiceMap.Service<TableConfig, TableConfig>

  /** Resolved system field names */
  readonly systemFields: ResolvedSystemFields

  /** Derived schemas for type extraction */
  readonly schemas: DerivedSchemas

  /**
   * Typed input schema. Ref-aware: ref fields are replaced with branded ID fields.
   * Use in HttpApiEndpoint payloads or for validation.
   *
   * @example
   * ```ts
   * HttpApiEndpoint.post("create", "/squads", {
   *   payload: SquadSelections.inputSchema,
   * })
   * ```
   */
  readonly inputSchema: Schema.Codec<EntityRefInputType<TModel, TRefs>>

  /**
   * Typed create schema. Input fields minus primary key composites — the common
   * "create" payload where IDs are auto-generated.
   *
   * @example
   * ```ts
   * HttpApiEndpoint.post("create", "/teams", {
   *   payload: Teams.createSchema,
   *   success: Team,
   * })
   * ```
   */
  readonly createSchema: Schema.Codec<EntityRefCreateType<TModel, TIndexes, TRefs, TIdentifier>>

  /**
   * Typed update schema. Partial fields minus primary key composites and immutable fields.
   * Ref fields are replaced with optional branded ID fields.
   */
  readonly updateSchema: Schema.Codec<EntityRefUpdateType<TModel, TIndexes, TRefs>>

  // --- CRUD Operations ---

  /** Fetch an item by primary key. Returns a lazy {@link EntityGet} intermediate. */
  readonly get: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityGet<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    ItemNotFound | DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /** Create or replace an item. Returns a lazy {@link EntityPut} intermediate. */
  readonly put: (
    input: EntityRefInputType<TModel, TRefs>,
  ) => EntityPut<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    DynamoClientError | ValidationError | UniqueConstraintViolation | RefErrors<TRefs>,
    DynamoClient | TableConfig
  >

  /**
   * Begin an update operation on an existing item. Returns a lazy {@link EntityUpdate} intermediate.
   * Pipe to {@link set} to provide update fields and {@link expectedVersion} for optimistic locking.
   */
  readonly update: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityUpdate<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    EntityRefUpdateType<TModel, TIndexes, TRefs>,
    | DynamoClientError
    | ItemNotFound
    | OptimisticLockError
    | UniqueConstraintViolation
    | ValidationError
    | RefErrors<TRefs>,
    DynamoClient | TableConfig
  >

  /** Delete an item by primary key. Returns a lazy {@link EntityDelete} intermediate. */
  readonly delete: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityDelete<DynamoClientError | ItemNotFound, DynamoClient | TableConfig>

  /**
   * Create a new item. Fails with `ConditionalCheckFailed` if an item with the same
   * primary key already exists. Equivalent to `put(input)` with an `attribute_not_exists` condition.
   */
  readonly create: (
    input: EntityRefInputType<TModel, TRefs>,
  ) => EntityPut<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    | DynamoClientError
    | ValidationError
    | UniqueConstraintViolation
    | ConditionalCheckFailed
    | RefErrors<TRefs>,
    DynamoClient | TableConfig
  >

  /**
   * Update an existing item. Fails with `ConditionalCheckFailed` if the item doesn't exist.
   * Equivalent to `update(key)` with an automatic `attribute_exists` condition on the PK field.
   */
  readonly patch: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityUpdate<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    EntityRefUpdateType<TModel, TIndexes, TRefs>,
    | DynamoClientError
    | ItemNotFound
    | OptimisticLockError
    | UniqueConstraintViolation
    | ValidationError
    | ConditionalCheckFailed
    | RefErrors<TRefs>,
    DynamoClient | TableConfig
  >

  /**
   * Delete an existing item. Fails with `ConditionalCheckFailed` if the item doesn't exist.
   * Equivalent to `delete(key)` with an automatic `attribute_exists` condition on the PK field.
   */
  readonly deleteIfExists: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityDelete<
    DynamoClientError | ItemNotFound | ConditionalCheckFailed,
    DynamoClient | TableConfig
  >

  /**
   * Create or update an item atomically. Uses DynamoDB UpdateItem with `if_not_exists()`
   * for immutable fields and createdAt so they're only set on first creation.
   * Version is incremented atomically: `if_not_exists(version, 0) + 1`.
   * Returns the full record (ReturnValues: ALL_NEW).
   *
   * Does NOT support unique constraints or retain (cannot determine if item existed).
   */
  readonly upsert: (
    input: EntityRefInputType<TModel, TRefs>,
  ) => EntityPut<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    DynamoClientError | ValidationError | ItemNotFound | ConditionalCheckFailed | RefErrors<TRefs>,
    DynamoClient | TableConfig
  >

  // --- Lifecycle Operations ---

  /** Fetch a specific version snapshot by version number. */
  readonly getVersion: (
    key: EntityKeyType<TModel, TIndexes>,
    version: number,
  ) => EntityGet<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    ItemNotFound | DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /** Query version history for an item. Returns a Query for piping with limit, reverse, collect. */
  readonly versions: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => Query.Query<EntityRecordType<TModel, TTimestamps, TVersioned>>

  /** Restore a soft-deleted item. Recomposes index keys and re-establishes unique sentinels. */
  readonly restore: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityGet<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    ItemNotFound | DynamoClientError | ValidationError | UniqueConstraintViolation,
    DynamoClient | TableConfig
  >

  /** Permanently remove an item plus all version history and sentinels. */
  readonly purge: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityDelete<DynamoClientError | ValidationError, DynamoClient | TableConfig>

  /** Soft-deleted item accessors. */
  readonly deleted: {
    /** Get a specific soft-deleted item. */
    readonly get: (
      key: EntityKeyType<TModel, TIndexes>,
    ) => EntityGet<
      ModelType<TModel>,
      EntityRecordType<TModel, TTimestamps, TVersioned>,
      ItemNotFound | DynamoClientError | ValidationError,
      DynamoClient | TableConfig
    >
    /** List soft-deleted items within a partition. */
    readonly list: (
      key: EntityKeyType<TModel, TIndexes>,
    ) => Query.Query<EntityRecordType<TModel, TTimestamps, TVersioned>>
  }

  // --- Update Combinators (entity-scoped, type-safe in both paths) ---

  /**
   * Set combinator pre-bound to this entity's update type.
   *
   * GSI all-or-none composites are enforced at runtime via `ValidationError`.
   *
   * @example
   * ```typescript
   * // data-last
   * yield* Users.update({ userId: "u-1" }).pipe(
   *   Users.set({ tenantId: "t-3", region: "us-east-1" }),
   * )
   *
   * // data-first
   * Entity.set(Users.update({ userId: "u-1" }), { tenantId: "t-3", region: "us-east-1" })
   * ```
   */
  readonly set: {
    (
      updates: EntityRefUpdateType<TModel, TIndexes, TRefs>,
    ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
    <A, Rec, U, E, R>(
      self: EntityUpdate<A, Rec, U, E, R>,
      updates: EntityRefUpdateType<TModel, TIndexes, TRefs>,
    ): EntityUpdate<A, Rec, U, E, R>
  }

  /**
   * Set expected version for optimistic locking.
   * Entity-scoped for consistent pipe chains with {@link Entity.set}.
   */
  readonly expectedVersion: {
    (
      version: number,
    ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
    <A, Rec, U, E, R>(
      self: EntityUpdate<A, Rec, U, E, R>,
      version: number,
    ): EntityUpdate<A, Rec, U, E, R>
  }

  /** Index query accessors. Each non-primary index becomes a method that accepts PK composites and returns a {@link Query.Query}. */
  readonly query: {
    readonly [K in Exclude<keyof TIndexes, "primary">]: (
      pk: IndexPkInput<TModel, TIndexes, K, TRefs>,
    ) => Query.Query<ModelType<TModel>>
  }

  /** Scan all items of this entity type. Returns a {@link Query.Query} that uses DynamoDB Scan. */
  readonly scan: () => Query.Query<ModelType<TModel>>

  // --- Expression Combinators (callback + shorthand) ---

  /**
   * Build a condition expression combinator.
   * Callback receives `(t, ops)` where `t` is a PathBuilder and `ops` provides comparison functions.
   * Shorthand accepts a simple object for AND-equality conditions.
   *
   * @example
   * ```typescript
   * // Callback
   * Teams.condition((t, { eq }) => eq(t.status, "active"))
   * // Shorthand
   * Teams.condition({ status: "active" })
   * ```
   */
  readonly condition: {
    (
      cb: (
        t: import("./internal/PathBuilder.js").PathBuilder<ModelType<TModel>, ModelType<TModel>>,
        ops: import("./internal/Expr.js").ConditionOps<ModelType<TModel>>,
      ) => import("./internal/Expr.js").Expr,
    ): <
      T extends
        | EntityPut<any, any, any, any>
        | EntityUpdate<any, any, any, any, any>
        | EntityDelete<any, any>,
    >(
      self: T,
    ) => T
    (
      shorthand: globalThis.Record<string, unknown>,
    ): <
      T extends
        | EntityPut<any, any, any, any>
        | EntityUpdate<any, any, any, any, any>
        | EntityDelete<any, any>,
    >(
      self: T,
    ) => T
  }

  /**
   * Build a filter expression for query/scan operations.
   * Same API as `condition()` — callback or shorthand.
   *
   * @example
   * ```typescript
   * teams.collect(Teams.query.byAll(pk), Teams.filter((t, { gt }) => gt(t.wins, 10)))
   * ```
   */
  readonly filter: {
    (
      cb: (
        t: import("./internal/PathBuilder.js").PathBuilder<ModelType<TModel>, ModelType<TModel>>,
        ops: import("./internal/Expr.js").ConditionOps<ModelType<TModel>>,
      ) => import("./internal/Expr.js").Expr,
    ): <A>(self: Query.Query<A>) => Query.Query<A>
    (shorthand: globalThis.Record<string, unknown>): <A>(self: Query.Query<A>) => Query.Query<A>
  }

  /**
   * Build a select (projection) combinator for get/query/scan operations.
   * Callback receives `t` — a PathBuilder. Returns an array of paths to project.
   * String array shorthand for top-level only projections.
   *
   * @example
   * ```typescript
   * Teams.select((t) => [t.name, t.address.city])
   * Teams.select(["name", "status"])
   * ```
   */
  readonly select: {
    (
      cb: (
        t: import("./internal/PathBuilder.js").PathBuilder<ModelType<TModel>, ModelType<TModel>>,
      ) => ReadonlyArray<import("./internal/PathBuilder.js").Path<ModelType<TModel>, any>>,
    ): (self: Query.Query<any>) => Query.Query<any>
    (attributes: ReadonlyArray<string>): (self: Query.Query<any>) => Query.Query<any>
  }
}

// ---------------------------------------------------------------------------
// BoundEntity — Entity operations with services pre-resolved (R = never)
// ---------------------------------------------------------------------------

/**
 * An Entity whose CRUD operations have `DynamoClient` and `TableConfig` already
 * resolved, so all methods return `Effect<A, E, never>`.
 *
 * Created via {@link bind}. Use in service layers to avoid leaking infrastructure
 * requirements through service method signatures.
 *
 * @example
 * ```typescript
 * export class TeamService extends ServiceMap.Service<TeamService>()("TeamService", {
 *   make: Effect.gen(function* () {
 *     const db = yield* DynamoClient.make({ entities: { Teams }, tables: { MainTable } })
 *     const teams = db.entities.Teams
 *     return {
 *       get: (id: TeamId) => teams.get({ id }),           // R = never
 *       create: (input) => teams.create({ ...input }),     // R = never
 *       list: (filter) => teams.byAll(filter).collect(),  // R = never
 *     }
 *   }),
 * }) {}
 * ```
 */
/** Combinator that transforms a put/create/upsert operation. */
export type PutCombinator<M> = (op: EntityPut<M, any, any, any>) => EntityPut<M, any, any, any>

/** Combinator that transforms an update/patch operation. */
export type UpdateCombinator<M> = (
  op: EntityUpdate<M, any, any, any, any>,
) => EntityUpdate<M, any, any, any, any>

/** Combinator that transforms a delete operation. */
export type DeleteCombinator = (op: EntityDelete<any, any>) => EntityDelete<any, any>

export interface BoundEntity<
  TModel extends Schema.Top,
  TIndexes extends globalThis.Record<string, IndexDefinition>,
  TRefs extends globalThis.Record<string, AnyRefValue> | undefined,
  TKey = EntityKeyType<TModel, TIndexes>,
> {
  // --- CRUD Operations ---

  /** Fetch an item by primary key. Returns an Effect that resolves to the model type. */
  readonly get: (
    key: TKey,
  ) => Effect.Effect<ModelType<TModel>, ItemNotFound | DynamoClientError | ValidationError, never>

  /** Create or replace an item. Accepts optional combinators (e.g. `Entity.condition(...)`). */
  readonly put: (
    input: EntityRefInputType<TModel, TRefs>,
    ...combinators: ReadonlyArray<PutCombinator<ModelType<TModel>>>
  ) => Effect.Effect<
    ModelType<TModel>,
    DynamoClientError | ValidationError | UniqueConstraintViolation | RefErrors<TRefs>,
    never
  >

  /** Create a new item. Fails if primary key already exists. Accepts optional combinators. */
  readonly create: (
    input: EntityRefInputType<TModel, TRefs>,
    ...combinators: ReadonlyArray<PutCombinator<ModelType<TModel>>>
  ) => Effect.Effect<
    ModelType<TModel>,
    | DynamoClientError
    | ValidationError
    | UniqueConstraintViolation
    | ConditionalCheckFailed
    | RefErrors<TRefs>,
    never
  >

  /**
   * Update an existing item. Applies combinators and returns an Effect.
   *
   * ```ts
   * yield* teams.update({ id }, Entity.set(updates), Entity.expectedVersion(3))
   * ```
   */
  readonly update: (
    key: TKey,
    ...combinators: ReadonlyArray<UpdateCombinator<ModelType<TModel>>>
  ) => Effect.Effect<
    ModelType<TModel>,
    | DynamoClientError
    | ItemNotFound
    | OptimisticLockError
    | UniqueConstraintViolation
    | ValidationError
    | RefErrors<TRefs>,
    never
  >

  /** Delete an item by primary key. Accepts optional combinators (e.g. `Entity.condition(...)`). */
  readonly delete: (
    key: TKey,
    ...combinators: ReadonlyArray<DeleteCombinator>
  ) => Effect.Effect<void, DynamoClientError | ItemNotFound, never>

  /**
   * Create or update an item atomically. Uses DynamoDB UpdateItem with `if_not_exists()`
   * for immutable fields and createdAt so they're only set on first creation.
   * Accepts optional combinators.
   */
  readonly upsert: (
    input: EntityRefInputType<TModel, TRefs>,
    ...combinators: ReadonlyArray<PutCombinator<ModelType<TModel>>>
  ) => Effect.Effect<
    ModelType<TModel>,
    DynamoClientError | ValidationError | ItemNotFound | ConditionalCheckFailed | RefErrors<TRefs>,
    never
  >

  /**
   * Update an existing item. Fails with `ConditionalCheckFailed` if the item doesn't exist.
   * Applies combinators and returns an Effect.
   *
   * ```ts
   * yield* teams.patch({ id }, Entity.set(updates))
   * ```
   */
  readonly patch: (
    key: TKey,
    ...combinators: ReadonlyArray<UpdateCombinator<ModelType<TModel>>>
  ) => Effect.Effect<
    ModelType<TModel>,
    | DynamoClientError
    | ItemNotFound
    | OptimisticLockError
    | UniqueConstraintViolation
    | ValidationError
    | ConditionalCheckFailed
    | RefErrors<TRefs>,
    never
  >

  /** Delete an existing item, fails if not found. Accepts optional combinators. */
  readonly deleteIfExists: (
    key: TKey,
    ...combinators: ReadonlyArray<DeleteCombinator>
  ) => Effect.Effect<void, DynamoClientError | ItemNotFound | ConditionalCheckFailed, never>

  // --- Lifecycle Operations ---

  /** Fetch a specific version snapshot by version number. */
  readonly getVersion: (
    key: TKey,
    version: number,
  ) => Effect.Effect<ModelType<TModel>, ItemNotFound | DynamoClientError | ValidationError, never>

  /**
   * List all version snapshots for an item as a fluent BoundQuery.
   * Requires `versioned: { retain: true }` on the entity definition.
   *
   * ```ts
   * const all = yield* db.entities.Users.versions({ userId: "u-1" }).collect()
   * const last5 = yield* db.entities.Users
   *   .versions({ userId: "u-1" })
   *   .reverse()
   *   .limit(5)
   *   .collect()
   * ```
   */
  readonly versions: (
    key: TKey,
  ) => import("./internal/BoundQuery.js").BoundQuery<
    ModelType<TModel>,
    never,
    ModelType<TModel>
  >

  /** Restore a soft-deleted item. */
  readonly restore: (
    key: TKey,
  ) => Effect.Effect<
    ModelType<TModel>,
    ItemNotFound | DynamoClientError | ValidationError | UniqueConstraintViolation,
    never
  >

  /** Permanently remove an item plus all version history and sentinels. */
  readonly purge: (
    key: TKey,
  ) => Effect.Effect<void, DynamoClientError | ValidationError, never>

  /** Soft-deleted item accessors. */
  readonly deleted: {
    /** Get a specific soft-deleted item. */
    readonly get: (
      key: TKey,
    ) => Effect.Effect<ModelType<TModel>, ItemNotFound | DynamoClientError | ValidationError, never>
    /**
     * List all soft-deleted items in this partition as a fluent BoundQuery.
     * Requires `softDelete` on the entity definition.
     *
     * ```ts
     * const tombstones = yield* db.entities.Employees.deleted
     *   .list({ employeeId: "e-1" })
     *   .collect()
     * ```
     */
    readonly list: (
      key: TKey,
    ) => import("./internal/BoundQuery.js").BoundQuery<
      ModelType<TModel>,
      never,
      ModelType<TModel>
    >
  }

  // --- Query Execution ---

  /**
   * Execute a query and return a lazy Stream of items. Automatically paginates through all pages.
   * Accepts optional query combinators (e.g. `Query.limit(...)`, `Query.reverse`).
   *
   * ```ts
   * const stream = teams.paginate(Teams.query.byRole({ role: "admin" }), Query.limit(10))
   * ```
   */
  readonly paginate: <A>(
    query: Query.Query<A>,
    ...combinators: ReadonlyArray<(q: Query.Query<A>) => Query.Query<A>>
  ) => Stream.Stream<A, DynamoClientError | ValidationError, never>

  /**
   * Execute a query and collect all pages into a single array.
   * Accepts optional query combinators (e.g. `Query.limit(...)`, `Query.reverse`).
   *
   * ```ts
   * const items = yield* teams.collect(Teams.query.byRole({ role: "admin" }), Query.limit(10))
   * ```
   */
  readonly collect: <A>(
    query: Query.Query<A>,
    ...combinators: ReadonlyArray<(q: Query.Query<A>) => Query.Query<A>>
  ) => Effect.Effect<Array<A>, DynamoClientError | ValidationError, never>

  /**
   * Execute a single DynamoDB page and return a {@link Query.Page} with an opaque cursor.
   * Use `Query.startFrom(cursor)` to iterate through subsequent pages.
   * Accepts optional query combinators (e.g. `Query.limit(...)`, `Query.reverse`).
   *
   * ```ts
   * const page = yield* teams.fetch(Teams.query.byRole({ role: "admin" }), Query.limit(25))
   * if (page.cursor) {
   *   const next = yield* teams.fetch(Teams.query.byRole({ role: "admin" }), Query.limit(25), Query.startFrom(page.cursor))
   * }
   * ```
   */
  readonly fetch: <A>(
    query: Query.Query<A>,
    ...combinators: ReadonlyArray<(q: Query.Query<A>) => Query.Query<A>>
  ) => Effect.Effect<Query.Page<A>, DynamoClientError | ValidationError, never>

  /**
   * Execute a single DynamoDB scan page and return a {@link Query.Page} with an opaque cursor.
   * Convenience for `fetch(Entity.scan(), ...)`. Use `Query.startFrom(cursor)` for subsequent pages.
   * Accepts optional query combinators (e.g. `Query.limit(...)`, `Query.filter(...)`).
   *
   * ```ts
   * const page = yield* teams.scanFetch(Query.limit(25))
   * if (page.cursor) {
   *   const next = yield* teams.scanFetch(Query.limit(25), Query.startFrom(page.cursor))
   * }
   * ```
   */
  readonly scanFetch: (
    ...combinators: ReadonlyArray<
      (q: Query.Query<ModelType<TModel>>) => Query.Query<ModelType<TModel>>
    >
  ) => Effect.Effect<Query.Page<ModelType<TModel>>, DynamoClientError | ValidationError, never>
}

// ---------------------------------------------------------------------------
// Transaction limit pre-check (100-item DynamoDB limit)
// ---------------------------------------------------------------------------

/**
 * Compile a condition that may be either an Expr ADT node or a ConditionInput object.
 * Routes both paths through the Expr ADT compiler for a single compilation backend.
 * Returns undefined if the condition is undefined.
 */
const compileCondition = (
  cond: Expr | ConditionInput | undefined,
  resolveDbNameFn?: (name: string) => string,
):
  | {
      expression: string
      names: globalThis.Record<string, string>
      values: globalThis.Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>
    }
  | undefined => {
  if (cond === undefined) return undefined
  const expr = isExpr(cond) ? cond : parseShorthand(cond)
  return compileExpr(expr, resolveDbNameFn)
}

const TRANSACTION_LIMIT = 100

const checkTransactionLimit = (
  entityType: string,
  operation: string,
  items: ReadonlyArray<unknown>,
): Effect.Effect<void, TransactionOverflow> =>
  items.length > TRANSACTION_LIMIT
    ? Effect.fail(
        new TransactionOverflow({
          entityType,
          operation,
          itemCount: items.length,
          limit: TRANSACTION_LIMIT,
        }),
      )
    : Effect.void

// ---------------------------------------------------------------------------
// Entity.make()
// ---------------------------------------------------------------------------

/**
 * Create a new Entity — binding a domain model to a Table with index definitions
 * and optional system field configuration.
 *
 * @param config - Entity configuration
 * @param config.model - Effect Schema class or struct defining the domain model
 * @param config.entityType - Literal string discriminator stored as `__edd_e__`
 * @param config.indexes - ElectroDB-style composite key definitions (must include `primary`)
 * @param config.timestamps - Automatic `createdAt` / `updatedAt` fields
 * @param config.versioned - Optimistic locking via auto-incrementing version field
 * @param config.softDelete - Soft-delete behavior
 * @param config.unique - Named unique constraints enforced via transaction sentinels
 * @returns An {@link Entity} with typed CRUD operations and index query accessors
 *
 * @example
 * ```typescript
 * const Users = Entity.make({
 *   model: User,
 *   table: MainTable,
 *   entityType: "User",
 *   indexes: {
 *     primary: { pk: { field: "pk", composite: ["userId"] }, sk: { field: "sk", composite: [] } },
 *     byEmail: { index: "gsi1", pk: { field: "gsi1pk", composite: ["email"] }, sk: { field: "gsi1sk", composite: [] } },
 *   },
 *   timestamps: true,
 *   versioned: true,
 * })
 * ```
 */
/** Valid composite attribute names: model fields + ref-derived ID fields (e.g., `playerId` from ref field `player`). */
type ValidCompositeAttr<TModel extends Schema.Top, TRefs> =
  | (string & keyof Schema.Schema.Type<TModel>)
  | ([TRefs] extends [globalThis.Record<infer K extends string, any>] ? `${K}Id` : never)

/** Extract all composite attribute names from an index definition. */
type IndexComposites<T> = T extends {
  readonly pk: { readonly composite: ReadonlyArray<infer P extends string> }
  readonly sk: { readonly composite: ReadonlyArray<infer S extends string> }
}
  ? P | S
  : never

/** Find invalid composite attributes across all indexes. */
type InvalidComposites<F extends string, TIndexes> = Exclude<
  IndexComposites<TIndexes[keyof TIndexes]>,
  F
>

/** Compute the normalized indexes type from primaryKey + optional GSI configs. */
type NormalizedIndexes<
  TPrimaryKey extends PrimaryKeyDef,
  TGsiIndexes extends globalThis.Record<string, GsiConfig>,
> = keyof TGsiIndexes extends never
  ? { readonly primary: TPrimaryKey }
  : { readonly primary: TPrimaryKey } & {
      readonly [K in keyof TGsiIndexes & string]: IndexDefinition & {
        readonly collection: TGsiIndexes[K]["collection"]
        readonly pk: { readonly composite: TGsiIndexes[K]["pk"]["composite"] }
        readonly sk: { readonly composite: TGsiIndexes[K]["sk"]["composite"] }
      }
    }

/** Primary key definition — used in the new `primaryKey` config form. */
type PrimaryKeyDef = IndexDefinition &
  (
    | { readonly pk: { readonly composite: readonly [string, ...string[]] } }
    | { readonly sk: { readonly composite: readonly [string, ...string[]] } }
  )

/**
 * Create an Entity definition.
 *
 * `primaryKey` defines the table's primary key. `indexes` optionally defines GSI
 * access patterns. GSIs with a `collection` property are auto-discovered as
 * cross-entity collections by `DynamoClient.make()`.
 *
 * @example
 * ```typescript
 * const Tasks = Entity.make({
 *   model: Task,
 *   entityType: "Task",
 *   primaryKey: {
 *     pk: { field: "pk", composite: ["taskId"] },
 *     sk: { field: "sk", composite: [] },
 *   },
 *   indexes: {
 *     byProject: {
 *       name: "gsi1",
 *       pk: { field: "gsi1pk", composite: ["projectId"] },
 *       sk: { field: "gsi1sk", composite: ["status"] },
 *     },
 *     assigned: {
 *       collection: "assignments",
 *       name: "gsi2",
 *       pk: { field: "gsi2pk", composite: ["employee"] },
 *       sk: { field: "gsi2sk", composite: ["project"] },
 *     },
 *   },
 * })
 * ```
 */
export const make = <
  TModel extends Schema.Top,
  const TEntityType extends string,
  const TPrimaryKey extends PrimaryKeyDef,
  const TGsiIndexes extends globalThis.Record<string, GsiConfig> = {},
  const TTimestamps extends TimestampsConfig | undefined = undefined,
  const TVersioned extends VersionedConfig | undefined = undefined,
  const TSoftDelete extends SoftDeleteConfig | undefined = undefined,
  const TUnique extends UniqueConfig | undefined = undefined,
  const TRefs extends globalThis.Record<string, AnyRefValue> | undefined = undefined,
  const TAttrs extends {} = {},
>(config: {
  readonly model: TModel | ConfiguredModel<TModel, TAttrs>
  readonly entityType: TEntityType
  readonly primaryKey: TPrimaryKey
  readonly indexes?: TGsiIndexes
  readonly timestamps?: TTimestamps
  readonly versioned?: TVersioned
  readonly softDelete?: TSoftDelete
  readonly unique?: TUnique
  readonly refs?: TRefs
}): Entity<
  TModel,
  TEntityType,
  NormalizedIndexes<TPrimaryKey, TGsiIndexes>,
  TTimestamps,
  TVersioned,
  TSoftDelete,
  TUnique,
  TRefs,
  ExtractIdentifier<ConfiguredModel<TModel, TAttrs>>
> => {
  // Normalize GSI configs to internal IndexDefinition format
  const gsiIndexes: globalThis.Record<string, IndexDefinition> = {}
  if (config.indexes) {
    for (const [name, gsi] of Object.entries(config.indexes)) {
      gsiIndexes[name] = normalizeGsiConfig(gsi)
    }
  }

  const indexes = { primary: config.primaryKey, ...gsiIndexes } as any
  // Delegate to the internal implementation with normalized indexes
  return makeImpl({ ...config, indexes }) as any
}

const makeImpl = <
  TModel extends Schema.Top,
  const TEntityType extends string,
  const TIndexes extends globalThis.Record<string, IndexDefinition> & {
    readonly primary: IndexDefinition &
      (
        | { readonly pk: { readonly composite: readonly [string, ...string[]] } }
        | { readonly sk: { readonly composite: readonly [string, ...string[]] } }
      )
  },
  const TTimestamps extends TimestampsConfig | undefined = undefined,
  const TVersioned extends VersionedConfig | undefined = undefined,
  const TSoftDelete extends SoftDeleteConfig | undefined = undefined,
  const TUnique extends UniqueConfig | undefined = undefined,
  const TRefs extends globalThis.Record<string, AnyRefValue> | undefined = undefined,
  const TAttrs extends {} = {},
>(config: {
  readonly model: TModel | ConfiguredModel<TModel, TAttrs>
  readonly entityType: TEntityType
  readonly indexes: typeof undefined extends never ? never : TIndexes
  readonly timestamps?: TTimestamps
  readonly versioned?: TVersioned
  readonly softDelete?: TSoftDelete
  readonly unique?: TUnique
  readonly refs?: TRefs
}): Entity<
  TModel,
  TEntityType,
  TIndexes,
  TTimestamps,
  TVersioned,
  TSoftDelete,
  TUnique,
  TRefs,
  ExtractIdentifier<ConfiguredModel<TModel, TAttrs>>
> => {
  // Unwrap ConfiguredModel to get the raw model and attribute overrides
  const configured = isConfiguredModel(config.model) ? config.model : undefined
  const rawModel = configured ? configured.model : (config.model as Schema.Top)
  const configuredAttributes = configured?.attributes ?? {}
  const isSchemaClass = typeof rawModel === "function"
  const modelFields = getFields(rawModel)
  const hasHiddenFields = Object.values(modelFields).some(isHidden)
  const systemFields = resolveSystemFields(config.timestamps, config.versioned)

  // ---------------------------------------------------------------------------
  // Validate indexes
  // ---------------------------------------------------------------------------

  const primaryIndex = config.indexes.primary
  if (primaryIndex.pk.composite.length === 0 && primaryIndex.sk.composite.length === 0) {
    throw new Error(
      `[EDD-9001] Entity "${config.entityType}": primary key must have at least one composite attribute in pk or sk`,
    )
  }

  // Build the set of valid composite attribute names: model fields + ref-derived ID fields
  const validCompositeFields = new Set(Object.keys(modelFields))
  for (const fieldName of Object.keys(modelFields)) {
    if (isRefField(fieldName, config.model as Schema.Top)) {
      validCompositeFields.add(`${fieldName}Id`)
    }
  }

  for (const [indexName, indexDef] of Object.entries(config.indexes)) {
    for (const attr of [...indexDef.pk.composite, ...indexDef.sk.composite]) {
      if (!validCompositeFields.has(attr)) {
        throw new Error(
          `[EDD-9002] Entity "${config.entityType}": index "${indexName}" references unknown attribute "${attr}". ` +
            `Valid attributes: ${[...validCompositeFields].sort().join(", ")}`,
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Resolve refs at make() time
  // ---------------------------------------------------------------------------

  interface ResolvedRef {
    readonly fieldName: string
    readonly idFieldName: string
    readonly identifierField: string
    readonly identifierSchema: Schema.Top
    readonly refEntity: Entity
    readonly refEntityType: string
  }

  const resolvedRefs: ReadonlyArray<ResolvedRef> = config.refs
    ? Object.entries(config.refs).map(([fieldName, refValue]) => {
        // Extract entity from shorthand or expanded form
        const refEntity = refValue.entity as Entity

        // Validate the field exists in the model
        const fieldSchema = modelFields[fieldName]
        if (!fieldSchema) {
          throw new Error(
            `Entity "${config.entityType}": refs config references field "${fieldName}" which does not exist in the model`,
          )
        }
        // Check for ref annotation — either on the schema field or via DynamoModel.configure
        if (!isRef(fieldSchema) && !isRefField(fieldName, config.model as Schema.Top)) {
          throw new Error(
            `Entity "${config.entityType}": refs config references field "${fieldName}" which does not have the DynamoModel.ref annotation. Add DynamoModel.ref to the model field or set { ref: true } in DynamoModel.configure.`,
          )
        }

        // Resolve the identifier field from the referenced entity's model
        // getIdentifierField handles both schema-level annotations and ConfiguredModel overrides
        const idField = getIdentifierField(refEntity.model as Schema.Top)
        if (!idField) {
          throw new Error(
            `Entity "${config.entityType}": ref field "${fieldName}" references entity "${refEntity.entityType}" which has no identifier field. Add DynamoModel.identifier to the model field or set { identifier: true } in DynamoModel.configure.`,
          )
        }

        return {
          fieldName,
          idFieldName: `${fieldName}Id`,
          identifierField: idField.name,
          identifierSchema: idField.schema,
          refEntity: refEntity as Entity,
          refEntityType: refEntity.entityType,
        }
      })
    : []

  const hasRefs = resolvedRefs.length > 0

  // ---------------------------------------------------------------------------
  // Auto-generate cascade indexes from expanded ref configs
  // ---------------------------------------------------------------------------

  const cascadeIndexes: globalThis.Record<string, IndexDefinition> = {}
  if (config.refs) {
    for (const [refFieldName, refValue] of Object.entries(config.refs)) {
      const cascadeConfig = refValue.cascade
      if (!cascadeConfig) continue
      const ref = resolvedRefs.find((r) => r.fieldName === refFieldName)!
      cascadeIndexes[`_cascade_${refFieldName}`] = {
        index: cascadeConfig.index,
        pk: { field: cascadeConfig.pk.field, composite: [ref.idFieldName] },
        sk: { field: cascadeConfig.sk.field, composite: [...config.indexes.primary.pk.composite] },
      }
    }
  }
  let allIndexes: globalThis.Record<string, IndexDefinition> = {
    ...config.indexes,
    ...cascadeIndexes,
  }

  // Build immutable fields set from ConfiguredModel (for update schema exclusion + upsert if_not_exists wrapping)
  const immutableFields = new Set<string>()
  for (const [fieldName, attrConfig] of Object.entries(configuredAttributes)) {
    if (attrConfig.immutable) immutableFields.add(fieldName)
  }

  // Resolve identifier field name from model annotation
  const resolvedIdentifier = getIdentifierField(config.model as Schema.Top)?.name

  const schemas = buildDerivedSchemas(
    modelFields,
    allIndexes,
    systemFields,
    resolvedRefs,
    immutableFields,
    resolvedIdentifier,
  )
  // schema and tableTag are injected via _configure() when the entity is registered
  // on a Table and bound through DynamoClient.make(). They are captured by operation
  // closures and resolved at runtime (inside Effects), not at definition time.
  // Using definite assignment (!) since _configure is called before any operation executes.
  let schema!: DynamoSchema.DynamoSchema
  let tableTag!: import("effect").ServiceMap.Service<TableConfig, TableConfig>

  const entityType = config.entityType
  const entityVersion = 1

  // ---------------------------------------------------------------------------
  // DynamoEncoding map: field name → encoding for date-annotated fields
  // Merges schema annotations with ConfiguredModel storage overrides.
  // ---------------------------------------------------------------------------

  const fieldEncodings: globalThis.Record<string, DynamoEncoding> = {}
  for (const [fieldName, fieldSchema] of Object.entries(modelFields)) {
    const encoding = getEncoding(fieldSchema)
    if (encoding) {
      fieldEncodings[fieldName] = encoding
    } else {
      // Auto-detect standard Effect date schemas (Pattern B: pure model)
      const inferred = inferDefaultEncoding(fieldSchema)
      if (inferred) fieldEncodings[fieldName] = inferred
    }
  }
  // Apply ConfiguredModel storage overrides (takes precedence over schema annotations)
  for (const [fieldName, attrConfig] of Object.entries(configuredAttributes)) {
    if (attrConfig.encoding) {
      const existing = fieldEncodings[fieldName]
      fieldEncodings[fieldName] = {
        storage: attrConfig.encoding.storage,
        domain: existing?.domain ?? attrConfig.encoding.domain,
      }
    }
  }
  // Note: System timestamp encodings are NOT added to fieldEncodings.
  // generateTimestamp() handles serialization directly for timestamps.
  // This avoids double-serialization in serializeDateFields.
  const hasDateFields = Object.keys(fieldEncodings).length > 0

  // ---------------------------------------------------------------------------
  // Field renaming: domain name → DynamoDB attribute name (from ConfiguredModel)
  // ---------------------------------------------------------------------------

  const fieldRenames: globalThis.Record<string, string> = {} // domain → dynamo
  for (const [domainName, attrConfig] of Object.entries(configuredAttributes)) {
    if (attrConfig.field) fieldRenames[domainName] = attrConfig.field
  }
  const hasRenames = Object.keys(fieldRenames).length > 0

  /**
   * Rename domain field names to DynamoDB attribute names.
   * Called before toAttributeMap (put path).
   */
  const renameToDynamo = (item: globalThis.Record<string, unknown>): void => {
    if (!hasRenames) return
    for (const [domain, dynamo] of Object.entries(fieldRenames)) {
      if (domain in item) {
        item[dynamo] = item[domain]
        delete item[domain]
      }
    }
  }

  /**
   * Rename DynamoDB attribute names back to domain field names.
   * Called after fromAttributeMap (get path).
   */
  const renameFromDynamo = (item: globalThis.Record<string, unknown>): void => {
    if (!hasRenames) return
    for (const [domain, dynamo] of Object.entries(fieldRenames)) {
      if (dynamo in item) {
        item[domain] = item[dynamo]
        delete item[dynamo]
      }
    }
  }

  /** Resolve a domain field name to its DynamoDB attribute name. */
  const resolveDbName = (domainName: string): string => fieldRenames[domainName] ?? domainName

  /**
   * Convert domain date values to storage primitives for DynamoEncoding-annotated fields.
   * Called before toAttributeMap (put path).
   */
  const serializeDateFields = (item: globalThis.Record<string, unknown>): void => {
    if (!hasDateFields) return
    for (const [field, encoding] of Object.entries(fieldEncodings)) {
      if (field in item && item[field] != null) {
        item[field] = serializeDateForDynamo(item[field], encoding)
      }
    }
  }

  /**
   * Convert storage primitives back to domain values for DynamoEncoding-annotated fields.
   * Called after fromAttributeMap (get path).
   */
  const deserializeDateFields = (raw: globalThis.Record<string, unknown>): void => {
    if (!hasDateFields) return
    for (const [field, encoding] of Object.entries(fieldEncodings)) {
      if (field in raw && raw[field] != null) {
        raw[field] = deserializeDateFromDynamo(raw[field], encoding)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const composePrimaryKey = (record: globalThis.Record<string, unknown>) => {
    const primary = config.indexes.primary
    return {
      [primary.pk.field]: KeyComposer.composePk(schema, entityType, primary, record),
      [primary.sk.field]: KeyComposer.composeSk(schema, entityType, entityVersion, primary, record),
    }
  }

  const composeAllKeys = (record: globalThis.Record<string, unknown>) =>
    KeyComposer.composeAllKeys(schema, entityType, entityVersion, allIndexes, record)

  /** Attach the model class prototype to a decoded plain object (when model is Schema.Class). */
  const attachPrototype = (decoded: any) =>
    isSchemaClass
      ? Object.assign(Object.create((rawModel as any).prototype), decoded)
      : decoded

  const decodeRecord = (raw: globalThis.Record<string, unknown>) => {
    renameFromDynamo(raw)
    deserializeDateFields(raw)
    return Schema.decodeUnknownEffect(schemas.recordSchema as Schema.Codec<any>)(raw).pipe(
      Effect.map(attachPrototype),
      Effect.mapError(
        (cause) =>
          new ValidationError({
            entityType,
            operation: "decode",
            cause,
          }),
      ),
    )
  }

  /** Decode a raw item using the schema selected by mode */
  const decodeAs = (
    raw: globalThis.Record<string, unknown>,
    marshalled: globalThis.Record<string, AttributeValue>,
    mode: DecodeMode,
  ) => {
    if (mode === "native") return Effect.succeed(marshalled)
    // Rename DynamoDB attributes back to domain field names
    renameFromDynamo(raw)
    // Convert date storage primitives to domain values before Schema decode.
    // recordSchema/itemSchema use fromSelf variants for annotated fields,
    // so they accept domain values directly. modelSchema also uses fromSelf
    // for the decode path after deserialization.
    deserializeDateFields(raw)
    const targetSchema =
      mode === "model"
        ? schemas.modelDecodeSchema
        : mode === "record"
          ? schemas.recordSchema
          : schemas.itemSchema
    return Schema.decodeUnknownEffect(targetSchema as Schema.Codec<any>)(raw).pipe(
      Effect.map((decoded) =>
        mode === "model" && isSchemaClass && !hasHiddenFields
          ? new (rawModel as any)(decoded)
          : mode !== "item" ? attachPrototype(decoded) : decoded,
      ),
      Effect.mapError(
        (cause) =>
          new ValidationError({
            entityType,
            operation: "decode",
            cause,
          }),
      ),
    )
  }

  const nowIso = () => new Date().toISOString()

  /**
   * Generate a timestamp value appropriate for the field's encoding.
   * Default (no encoding): ISO string. Custom encoding: serialized primitive.
   */
  const generateTimestamp = (encoding: DynamoEncoding | null): string | number => {
    if (!encoding) return nowIso()
    const now = new Date()
    return serializeDateForDynamo(now, encoding)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle config helpers
  // ---------------------------------------------------------------------------

  const isRetainEnabled = (): boolean =>
    typeof config.versioned === "object" &&
    config.versioned !== null &&
    (config.versioned as { retain?: boolean }).retain === true

  const isSoftDeleteEnabled = (): boolean =>
    config.softDelete === true ||
    (typeof config.softDelete === "object" && config.softDelete !== null)

  const retainTtl = (): Duration.Duration | undefined => {
    if (typeof config.versioned !== "object" || config.versioned === null) return undefined
    return (config.versioned as { ttl?: Duration.Duration }).ttl
  }

  const softDeleteTtl = (): Duration.Duration | undefined => {
    if (typeof config.softDelete !== "object" || config.softDelete === null) return undefined
    return (config.softDelete as { ttl?: Duration.Duration }).ttl
  }

  const preserveUnique = (): boolean => {
    if (typeof config.softDelete !== "object" || config.softDelete === null) return false
    return (config.softDelete as { preserveUnique?: boolean }).preserveUnique === true
  }

  /** Collect all key field names (pk, sk, gsi*pk, gsi*sk) */
  const gsiKeyFields = (): ReadonlyArray<string> => {
    const fields: Array<string> = []
    for (const [indexName, indexDef] of Object.entries(allIndexes)) {
      if (indexName === "primary") continue
      fields.push(indexDef.pk.field, indexDef.sk.field)
    }
    return fields
  }

  /**
   * Build a version snapshot item: same PK, version SK, stripped GSI keys,
   * keeps __edd_e__ for entity type filtering.
   */
  const buildSnapshotItem = (
    item: globalThis.Record<string, unknown>,
    version: number,
    _tablePkField: string,
    tableSkField: string,
  ): globalThis.Record<string, unknown> => {
    const snapshot: globalThis.Record<string, unknown> = { ...item }

    // Strip GSI key fields — snapshots must not appear in index queries
    for (const field of gsiKeyFields()) {
      delete snapshot[field]
    }

    // Replace SK with version SK
    snapshot[tableSkField] = DynamoSchema.composeVersionKey(schema, entityType, version)

    // Add optional TTL
    const ttl = retainTtl()
    if (ttl) {
      snapshot._ttl = Math.floor(Date.now() / 1000) + Duration.toSeconds(ttl)
    }

    return snapshot
  }

  // ---------------------------------------------------------------------------
  // Ref hydration
  // ---------------------------------------------------------------------------

  /**
   * Hydrate ref fields by fetching referenced entities by ID and embedding
   * their core domain data. Returns a new object with ref fields populated.
   *
   * @param decoded - Decoded input containing `${field}Id` values
   * @returns Object with `${field}Id` removed and `${field}` populated with domain data
   */
  const hydrateRefs = (
    decoded: globalThis.Record<string, unknown>,
    refs?: ReadonlyArray<ResolvedRef>,
  ): Effect.Effect<
    globalThis.Record<string, unknown>,
    RefNotFound | DynamoClientError | ItemNotFound | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      const refsToProcess = refs ?? resolvedRefs
      if (refsToProcess.length === 0) return decoded

      // Fetch all refs in parallel
      const hydrated = { ...decoded }
      const fetchEffects = refsToProcess.map((ref) => {
        const id = decoded[ref.idFieldName] as string
        return Effect.gen(function* () {
          const keyInput = { [ref.identifierField]: id }
          // Use asModel to convert EntityGet to Effect<ModelType>
          const getEffect = asModel(ref.refEntity.get(keyInput) as EntityGet<any, any, any, any>)
          const result = yield* getEffect.pipe(
            Effect.catchTag("ItemNotFound", () =>
              Effect.fail(
                new RefNotFound({
                  entity: entityType,
                  field: ref.fieldName,
                  refEntity: ref.refEntityType,
                  refId: id,
                }),
              ),
            ),
          )
          return { fieldName: ref.fieldName, idFieldName: ref.idFieldName, data: result }
        })
      })

      const results = yield* Effect.all(fetchEffects, { concurrency: "unbounded" })
      for (const r of results) {
        // Spread the Schema.Class instance to extract domain data as a plain object
        hydrated[r.fieldName] = { ...(r.data as object) }
        delete hydrated[r.idFieldName]
      }

      return hydrated
    })

  // ---------------------------------------------------------------------------
  // Cascade update execution
  // ---------------------------------------------------------------------------

  /**
   * Find a GSI on a target entity whose PK composite includes the source entity's
   * identifier field name (e.g., "playerId"). This GSI is used to query all target
   * items that reference the source entity.
   *
   * Selection priority:
   *   1. A GSI whose PK composite is exactly `[idFieldName]` (single attribute).
   *      This is the only shape that can be recomposed from the source identifier
   *      alone, so it's always safe for cascade.
   *   2. Otherwise, the first GSI whose PK composite contains `idFieldName`.
   *      This is a fallback for backwards compatibility — `executeCascade`
   *      validates that all extra composites can be supplied at runtime and
   *      raises a clear error if they cannot.
   */
  const findCascadeIndex = (
    target: CascadeTarget,
    idFieldName: string,
  ): { readonly indexName: string; readonly indexDef: IndexDefinition } | undefined => {
    let fallback: { readonly indexName: string; readonly indexDef: IndexDefinition } | undefined
    for (const [indexName, indexDef] of Object.entries(target.indexes)) {
      if (indexName === "primary") continue
      const composite = indexDef.pk.composite
      if (composite.length === 1 && composite[0] === idFieldName) {
        // Exact match — preferred. PK is fully determined by the source id.
        return { indexName, indexDef }
      }
      if (fallback === undefined && composite.includes(idFieldName)) {
        fallback = { indexName, indexDef }
      }
    }
    return fallback
  }

  /** Cached source entity identifier field name (e.g., "playerId") */
  const sourceIdentifierField = (() => {
    const idField = getIdentifierField(config.model as Schema.Top)
    return idField?.name
  })()

  /**
   * Execute cascade updates after a source entity update completes.
   * For each target entity: query its cascade GSI, then update all matching items.
   */
  const executeCascade = (
    cascadeConfig: CascadeConfig,
    sourceDomainData: globalThis.Record<string, unknown>,
    sourceIdValue: string,
  ): Effect.Effect<void, CascadePartialFailure | DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const { targets, filter, mode } = cascadeConfig
      const sourceEntityType = entityType
      const client = yield* DynamoClient

      if (!sourceIdentifierField) return undefined as undefined

      const allUpdateOps: Array<{
        readonly tableName: string
        readonly key: globalThis.Record<string, AttributeValue>
        readonly refFieldName: string
        readonly refData: AttributeValue
      }> = []

      for (const target of targets) {
        // Find the ref on the target that points to our source entity
        const matchingRef = target._resolvedRefs.find((r) => r.refEntityType === sourceEntityType)
        if (!matchingRef) continue

        // Find GSI on target whose PK composite includes the ref's ID field
        const cascadeIdx = findCascadeIndex(target, matchingRef.idFieldName)
        if (!cascadeIdx) continue

        // The cascade can only recompose a GSI PK from the source identifier
        // if every composite attribute is satisfied. The source entity (e.g. a
        // Team) only carries its own identifier (e.g. teamId), so any GSI whose
        // PK includes additional composites (e.g. season, series) is unusable
        // for cascade. findCascadeIndex prefers the safe shape, but the
        // fallback may still hand back an over-composed GSI when no exact
        // match exists. Detect that here and fail with a clear, tagged error
        // rather than throwing deep inside KeyComposer.composePk.
        const cascadePkComposite = cascadeIdx.indexDef.pk.composite
        if (cascadePkComposite.length !== 1 || cascadePkComposite[0] !== matchingRef.idFieldName) {
          return yield* new CascadePartialFailure({
            sourceEntity: sourceEntityType,
            sourceId: sourceIdValue,
            succeeded: 0,
            failed: 0,
            errors: [
              `Cascade target "${target.entityType}" has no GSI usable for cascade from "${sourceEntityType}". ` +
                `The chosen index "${cascadeIdx.indexName}" (${cascadeIdx.indexDef.index}) has PK composite ` +
                `[${cascadePkComposite.join(", ")}], but cascade requires a GSI whose PK composite is exactly ` +
                `["${matchingRef.idFieldName}"]. Add a single-attribute GSI keyed on "${matchingRef.idFieldName}" ` +
                `(or use the refs.${matchingRef.fieldName}.cascade config to auto-generate one).`,
            ],
          })
        }

        // Resolve target table name
        const { name: targetTableName } = yield* target._tableTag

        // Compose GSI PK for the source entity's ID
        const targetSchema = target._schema
        const gsiPkValue = KeyComposer.composePk(
          targetSchema,
          target.entityType,
          cascadeIdx.indexDef,
          { [matchingRef.idFieldName]: sourceIdValue },
        )

        // Build query parameters
        const gsiPkField = cascadeIdx.indexDef.pk.field
        const queryNames: globalThis.Record<string, string> = {
          "#pk": gsiPkField,
          "#et": "__edd_e__",
        }
        const queryValues: globalThis.Record<string, AttributeValue> = {
          ":pk": { S: gsiPkValue },
          ":et0": { S: target.entityType },
        }

        let filterExpression = "#et = :et0"

        // Add user-provided filter
        if (filter) {
          let filterIdx = 0
          for (const [key, value] of Object.entries(filter)) {
            const nameKey = `#cf${filterIdx}`
            const valKey = `:cf${filterIdx}`
            queryNames[nameKey] = key
            queryValues[valKey] = toAttributeValue(value)
            filterExpression += ` AND ${nameKey} = ${valKey}`
            filterIdx++
          }
        }

        // Paginated query
        let exclusiveStartKey: globalThis.Record<string, AttributeValue> | undefined
        do {
          const queryResult = yield* client.query({
            TableName: targetTableName,
            IndexName: cascadeIdx.indexDef.index,
            KeyConditionExpression: "#pk = :pk",
            FilterExpression: filterExpression,
            ExpressionAttributeNames: queryNames,
            ExpressionAttributeValues: queryValues,
            ExclusiveStartKey: exclusiveStartKey,
          })

          for (const item of queryResult.Items ?? []) {
            allUpdateOps.push({
              tableName: targetTableName,
              key: { pk: item.pk!, sk: item.sk! },
              refFieldName: matchingRef.fieldName,
              refData: toAttributeValue(sourceDomainData),
            })
          }

          exclusiveStartKey = queryResult.LastEvaluatedKey as
            | globalThis.Record<string, AttributeValue>
            | undefined
        } while (exclusiveStartKey !== undefined)
      }

      if (allUpdateOps.length === 0) return

      if (mode === "transactional") {
        // Transactional mode — fail if >100 items
        if (allUpdateOps.length > 100) {
          return yield* new CascadePartialFailure({
            sourceEntity: sourceEntityType,
            sourceId: sourceIdValue,
            succeeded: 0,
            failed: allUpdateOps.length,
            errors: [`Transactional cascade exceeded 100-item limit: ${allUpdateOps.length} items`],
          })
        }

        yield* client.transactWriteItems({
          TransactItems: allUpdateOps.map((op) => ({
            Update: {
              TableName: op.tableName,
              Key: op.key,
              UpdateExpression: "SET #ref = :refData",
              ExpressionAttributeNames: { "#ref": op.refFieldName },
              ExpressionAttributeValues: { ":refData": op.refData },
            },
          })),
        })
      } else {
        // Eventual mode — concurrent updates with partial failure tracking
        let succeeded = 0
        const errors: Array<unknown> = []

        const updateEffects = allUpdateOps.map((op) =>
          client
            .updateItem({
              TableName: op.tableName,
              Key: op.key,
              UpdateExpression: "SET #ref = :refData",
              ExpressionAttributeNames: { "#ref": op.refFieldName },
              ExpressionAttributeValues: { ":refData": op.refData },
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  succeeded++
                }),
              ),
              Effect.catch((err: DynamoClientError) =>
                Effect.sync(() => {
                  errors.push(err)
                }),
              ),
            ),
        )

        yield* Effect.all(updateEffects, { concurrency: 10 })

        if (errors.length > 0) {
          return yield* new CascadePartialFailure({
            sourceEntity: sourceEntityType,
            sourceId: sourceIdValue,
            succeeded,
            failed: errors.length,
            errors,
          })
        }
      }
    })

  // ---------------------------------------------------------------------------
  // put operation
  // ---------------------------------------------------------------------------

  // Mutable self — safe because operations are closures that only
  // dereference `self` when called by users, after make() has returned
  let self: Entity

  const put = (input: unknown) =>
    new EntityPutImpl(
      (mode: DecodeMode, opts: { readonly condition: Expr | ConditionInput | undefined }) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const { name: tableName } = yield* tableTag

          // Decode input
          const decodedInput = yield* Schema.decodeUnknownEffect(
            schemas.inputSchema as Schema.Codec<any>,
          )(input).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "put.decode",
                  cause,
                }),
            ),
          )

          // Compose all keys BEFORE ref hydration (ID fields are still present)
          const keys = composeAllKeys(decodedInput as globalThis.Record<string, unknown>)

          // Hydrate refs: replace ID fields with full entity domain data
          const decoded = hasRefs
            ? yield* hydrateRefs(decodedInput as globalThis.Record<string, unknown>)
            : decodedInput

          // Build the DynamoDB item
          const item: globalThis.Record<string, unknown> = { ...decoded }

          // Add system fields (encoding-aware timestamps)
          if (systemFields.createdAt)
            item[systemFields.createdAt] = generateTimestamp(systemFields.createdAtEncoding)
          if (systemFields.updatedAt)
            item[systemFields.updatedAt] = generateTimestamp(systemFields.updatedAtEncoding)
          if (systemFields.version) item[systemFields.version] = 1

          // Add entity type discriminator
          item.__edd_e__ = entityType

          // Apply composed keys
          Object.assign(item, keys)

          // Convert date fields from domain values to storage primitives
          serializeDateFields(item)
          // Rename domain fields to DynamoDB attribute names
          renameToDynamo(item)

          const marshalledItem = toAttributeMap(item)

          // Build user condition expression if provided
          const userCondition = opts.condition
            ? compileCondition(opts.condition, resolveDbName)
            : undefined

          const hasUniqueConstraints =
            config.unique != null && Object.keys(config.unique).length > 0
          const needsTransaction = hasUniqueConstraints || isRetainEnabled()

          if (needsTransaction) {
            // Use transactWriteItems for atomic put + sentinel creation + snapshot
            const transactItems: Array<{
              Put: {
                TableName: string
                Item: globalThis.Record<string, AttributeValue>
                ConditionExpression?: string
                ExpressionAttributeNames?: globalThis.Record<string, string>
                ExpressionAttributeValues?: globalThis.Record<string, AttributeValue>
              }
            }> = []

            // Main entity item (with optional user condition)
            const mainPut: (typeof transactItems)[number]["Put"] = {
              TableName: tableName,
              Item: marshalledItem,
            }
            if (userCondition) {
              mainPut.ConditionExpression = userCondition.expression
              mainPut.ExpressionAttributeNames = userCondition.names
              if (Object.keys(userCondition.values).length > 0) {
                mainPut.ExpressionAttributeValues = userCondition.values
              }
            }
            transactItems.push({ Put: mainPut })

            // Unique constraint sentinels
            if (hasUniqueConstraints) {
              for (const [constraintName, constraintDef] of Object.entries(config.unique!)) {
                const fields = resolveUniqueFields(constraintDef)
                const fieldValues = fields.map((f) => KeyComposer.serializeValue(decoded[f]))
                const uniqueKey = DynamoSchema.composeUniqueKey(
                  schema,
                  entityType,
                  constraintName,
                  fieldValues,
                )

                transactItems.push({
                  Put: {
                    TableName: tableName,
                    Item: toAttributeMap({
                      [config.indexes.primary.pk.field]: uniqueKey.pk,
                      [config.indexes.primary.sk.field]: uniqueKey.sk,
                      __edd_e__: `${entityType}._unique.${constraintName}`,
                      _entity_pk: keys[config.indexes.primary.pk.field],
                      _entity_sk: keys[config.indexes.primary.sk.field],
                    }),
                    ConditionExpression: "attribute_not_exists(pk)",
                  },
                })
              }
            }

            // Version snapshot (v1) when retain is enabled
            if (isRetainEnabled()) {
              const snapshotItem = buildSnapshotItem(
                item,
                1,
                config.indexes.primary.pk.field,
                config.indexes.primary.sk.field,
              )
              transactItems.push({
                Put: {
                  TableName: tableName,
                  Item: toAttributeMap(snapshotItem),
                },
              })
            }

            yield* checkTransactionLimit(entityType, "put", transactItems)
            yield* client
              .transactWriteItems({
                TransactItems: transactItems.map((t) => ({ Put: t.Put })),
              })
              .pipe(
                Effect.mapError(
                  (err): DynamoClientError | UniqueConstraintViolation | ConditionalCheckFailed => {
                    // Check if this is a transaction cancellation
                    if (isAwsTransactionCancelled(err.cause)) {
                      const reasons = err.cause.CancellationReasons
                      if (reasons) {
                        // Index 0 is the main item — if it failed with user condition, return ConditionalCheckFailed
                        if (opts.condition && reasons[0]?.Code === "ConditionalCheckFailed") {
                          return new ConditionalCheckFailed({
                            entityType,
                            key: decoded,
                          })
                        }
                        // Sentinel items start at index 1
                        for (let i = 1; i < reasons.length; i++) {
                          if (reasons[i]?.Code === "ConditionalCheckFailed") {
                            const constraintNames = Object.keys(config.unique!)
                            const constraintName = constraintNames[i - 1] ?? "unknown"
                            const constraintDef = config.unique![constraintName]
                            const uniqueFields = constraintDef
                              ? resolveUniqueFields(constraintDef)
                              : []
                            const fieldsRecord: globalThis.Record<string, string> = {}
                            for (const f of uniqueFields) {
                              fieldsRecord[f] = KeyComposer.serializeValue(decoded[f])
                            }
                            return new UniqueConstraintViolation({
                              entityType,
                              constraint: constraintName,
                              fields: fieldsRecord,
                            })
                          }
                        }
                      }
                    }
                    return err
                  },
                ),
              )
          } else {
            // Simple put without unique constraints or retain
            const putInput: {
              TableName: string
              Item: globalThis.Record<string, AttributeValue>
              ConditionExpression?: string
              ExpressionAttributeNames?: globalThis.Record<string, string>
              ExpressionAttributeValues?: globalThis.Record<string, AttributeValue>
            } = {
              TableName: tableName,
              Item: marshalledItem,
            }
            if (userCondition) {
              putInput.ConditionExpression = userCondition.expression
              putInput.ExpressionAttributeNames = userCondition.names
              if (Object.keys(userCondition.values).length > 0) {
                putInput.ExpressionAttributeValues = userCondition.values
              }
            }
            yield* client.putItem(putInput).pipe(
              Effect.mapError((err): DynamoClientError | ConditionalCheckFailed => {
                if (opts.condition && isAwsConditionalCheckFailed(err.cause)) {
                  return new ConditionalCheckFailed({ entityType, key: decoded })
                }
                return err
              }),
            )
          }

          // Decode and return using selected mode
          return yield* decodeAs(item, marshalledItem, mode)
        }),
      self,
      input as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // create operation — put + attribute_not_exists condition
  // ---------------------------------------------------------------------------

  const create = (input: unknown) => {
    const pkField = config.indexes.primary.pk.field
    const skField = config.indexes.primary.sk.field
    const op = put(input)
    return new EntityPutImpl(op._builder, op._entity, op._input, {
      attributeNotExists: [pkField, skField],
    })
  }

  // ---------------------------------------------------------------------------
  // patch operation — update + attribute_exists condition
  // ---------------------------------------------------------------------------

  const patch = (key: unknown) => {
    const pkField = config.indexes.primary.pk.field
    const op = update(key)
    return new EntityUpdateImpl(
      op._builder,
      { ...op._updateState, condition: { attributeExists: [pkField] } },
      op._entity,
      op._key,
    )
  }

  // ---------------------------------------------------------------------------
  // get operation
  // ---------------------------------------------------------------------------

  const get = (key: unknown) =>
    new EntityGetImpl(
      (mode: DecodeMode, opts: EntityGetOpts) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const { name: tableName } = yield* tableTag

          // Decode key
          const decodedKey = yield* Schema.decodeUnknownEffect(
            schemas.keySchema as Schema.Codec<any>,
          )(key).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "get.decode",
                  cause,
                }),
            ),
          )

          // Compose primary key
          const primaryKey = composePrimaryKey(decodedKey)
          const marshalledKey = toAttributeMap(primaryKey)

          // Build ProjectionExpression if projection attributes provided
          let projectionExpression: string | undefined
          let projectionNames: globalThis.Record<string, string> | undefined
          if (opts.projection && opts.projection.length > 0) {
            const proj = Projection.projection(opts.projection)
            projectionExpression = proj.expression
            projectionNames = proj.names
          }

          const result = yield* client.getItem({
            TableName: tableName,
            Key: marshalledKey,
            ConsistentRead: opts.consistentRead || undefined,
            ProjectionExpression: projectionExpression,
            ExpressionAttributeNames:
              projectionNames && Object.keys(projectionNames).length > 0
                ? projectionNames
                : undefined,
          })

          if (!result.Item) {
            return yield* new ItemNotFound({ entityType, key: decodedKey })
          }

          // Raw mode: return unmarshalled record without schema decode
          if (mode === "raw") {
            return fromAttributeMap(result.Item)
          }

          // Unmarshall and decode using selected mode
          const raw = fromAttributeMap(result.Item)
          return yield* decodeAs(raw, result.Item, mode)
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // update operation
  // ---------------------------------------------------------------------------

  const update = (key: unknown) =>
    new EntityUpdateImpl(
      (mode: DecodeMode, uState: UpdateState) =>
        Effect.gen(function* () {
          const updates = uState.updates
          const evExpected = uState.expectedVersion
          const userCond = uState.condition
          const client = yield* DynamoClient
          const { name: tableName } = yield* tableTag

          // Decode key
          const decodedKey = yield* Schema.decodeUnknownEffect(
            schemas.keySchema as Schema.Codec<any>,
          )(key).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "update.decodeKey",
                  cause,
                }),
            ),
          )

          // Decode updates
          const decodedUpdates = yield* Schema.decodeUnknownEffect(
            schemas.updateSchema as Schema.Codec<any>,
          )(updates ?? {}).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "update.decodeUpdates",
                  cause,
                }),
            ),
          )

          // Hydrate refs in updates: for any ${field}Id present, fetch and embed
          let hydratedUpdates = decodedUpdates as globalThis.Record<string, unknown>
          if (hasRefs) {
            const refsToHydrate = resolvedRefs.filter(
              (ref) =>
                ref.idFieldName in (decodedUpdates as globalThis.Record<string, unknown>) &&
                (decodedUpdates as globalThis.Record<string, unknown>)[ref.idFieldName] !==
                  undefined,
            )
            if (refsToHydrate.length > 0) {
              hydratedUpdates = yield* hydrateRefs(hydratedUpdates, refsToHydrate)
            }
          }

          // Compose primary key
          const primaryKey = composePrimaryKey(decodedKey)
          const marshalledKey = toAttributeMap(primaryKey)

          // Detect whether the update touches any unique constraint fields
          const hasUniqueConstraints =
            config.unique != null && Object.keys(config.unique).length > 0
          let touchesUniqueFields = false
          if (hasUniqueConstraints) {
            const uniqueFieldSet = new Set(
              Object.values(config.unique!).flatMap((def) => [...resolveUniqueFields(def)]),
            )
            const allUpdatedFields = new Set([
              ...Object.keys(hydratedUpdates as globalThis.Record<string, unknown>).filter(
                (k) => (hydratedUpdates as globalThis.Record<string, unknown>)[k] !== undefined,
              ),
              ...(uState.remove ?? []),
              ...Object.keys(uState.add ?? {}),
              ...Object.keys(uState.subtract ?? {}),
              ...Object.keys(uState.append ?? {}),
              ...Object.keys(uState.deleteFromSet ?? {}),
            ])
            touchesUniqueFields = [...uniqueFieldSet].some((f) => allUpdatedFields.has(f))
          }

          if (isRetainEnabled() || touchesUniqueFields) {
            // --- Retain path: read-then-transact ---
            // Read current item (needed to create snapshot of pre-update state)
            const currentResult = yield* client.getItem({
              TableName: tableName,
              Key: marshalledKey,
            })

            if (!currentResult.Item) {
              return yield* new ItemNotFound({ entityType, key: decodedKey })
            }

            const currentRaw = fromAttributeMap(currentResult.Item)
            const currentVersion = systemFields.version
              ? ((currentRaw as globalThis.Record<string, unknown>)[systemFields.version] as number)
              : 0

            // Validate optimistic lock if requested
            if (evExpected !== undefined && currentVersion !== evExpected) {
              return yield* new OptimisticLockError({
                entityType,
                key: decodedKey,
                expectedVersion: evExpected,
                actualVersion: currentVersion,
              })
            }

            // Build new item: merge current + updates + rich ops + recompose keys
            const newItem: globalThis.Record<string, unknown> = {
              ...(currentRaw as globalThis.Record<string, unknown>),
            }
            for (const [attr, val] of Object.entries(
              hydratedUpdates as globalThis.Record<string, unknown>,
            )) {
              if (val !== undefined) newItem[attr] = val
            }

            // Apply rich operations to in-memory item
            if (uState.remove) {
              for (const attr of uState.remove) {
                delete newItem[attr]
              }
            }
            if (uState.add) {
              for (const [attr, val] of Object.entries(uState.add)) {
                newItem[attr] = ((newItem[attr] as number) ?? 0) + val
              }
            }
            if (uState.subtract) {
              for (const [attr, val] of Object.entries(uState.subtract)) {
                newItem[attr] = ((newItem[attr] as number) ?? 0) - val
              }
            }
            if (uState.append) {
              for (const [attr, val] of Object.entries(uState.append)) {
                const existing = (newItem[attr] as Array<unknown>) ?? []
                newItem[attr] = [...existing, ...val]
              }
            }
            if (uState.deleteFromSet) {
              for (const [attr, val] of Object.entries(uState.deleteFromSet)) {
                if (newItem[attr] instanceof Set && val instanceof Set) {
                  const current = newItem[attr] as Set<unknown>
                  for (const elem of val as Set<unknown>) {
                    current.delete(elem)
                  }
                }
              }
            }

            // Increment version and update timestamp
            const newVersion = currentVersion + 1
            if (systemFields.version) newItem[systemFields.version] = newVersion
            if (systemFields.updatedAt)
              newItem[systemFields.updatedAt] = generateTimestamp(systemFields.updatedAtEncoding)

            // Convert DynamoDB attribute names to domain names for key composition
            // and sentinel value comparison (newItem was built from currentRaw which
            // uses DynamoDB names; composites and unique fields use domain names)
            renameFromDynamo(newItem)

            // Recompose all keys with updated attributes
            const newKeys = composeAllKeys(newItem)
            Object.assign(newItem, newKeys)

            // Compute sentinel rotation values while newItem is in domain names.
            // currentRaw uses DynamoDB names, so resolve via resolveDbName for
            // fields that may have been renamed (e.g. id → teamId).
            type SentinelRotation = {
              constraintName: string
              oldUniqueKey: { readonly pk: string; readonly sk: string }
              newUniqueKey: { readonly pk: string; readonly sk: string }
              newFieldsRecord: globalThis.Record<string, string>
            }
            const sentinelRotations: Array<SentinelRotation> = []
            if (touchesUniqueFields) {
              const currentRawRecord = currentRaw as globalThis.Record<string, unknown>
              for (const [constraintName, constraintDef] of Object.entries(config.unique!)) {
                const fields = resolveUniqueFields(constraintDef)
                const oldFieldValues = fields.map((f) =>
                  KeyComposer.serializeValue(
                    currentRawRecord[f] ?? currentRawRecord[resolveDbName(f)],
                  ),
                )
                const newFieldValues = fields.map((f) => KeyComposer.serializeValue(newItem[f]))

                const changed = oldFieldValues.some((v, i) => v !== newFieldValues[i])
                if (!changed) continue

                const newFieldsRecord: globalThis.Record<string, string> = {}
                for (const f of fields) {
                  newFieldsRecord[f] = KeyComposer.serializeValue(newItem[f])
                }
                sentinelRotations.push({
                  constraintName,
                  oldUniqueKey: DynamoSchema.composeUniqueKey(
                    schema,
                    entityType,
                    constraintName,
                    oldFieldValues,
                  ),
                  newUniqueKey: DynamoSchema.composeUniqueKey(
                    schema,
                    entityType,
                    constraintName,
                    newFieldValues,
                  ),
                  newFieldsRecord,
                })
              }
            }

            // Convert back to DynamoDB attribute names for storage
            renameToDynamo(newItem)

            const marshalledNewItem = toAttributeMap(newItem)

            // Build snapshot of the pre-update state (only when retain is enabled)
            const snapshotItem = isRetainEnabled()
              ? buildSnapshotItem(
                  currentRaw as globalThis.Record<string, unknown>,
                  currentVersion,
                  config.indexes.primary.pk.field,
                  config.indexes.primary.sk.field,
                )
              : undefined

            type TransactPut = {
              Put: {
                TableName: string
                Item: globalThis.Record<string, AttributeValue>
                ConditionExpression?: string
                ExpressionAttributeNames?: globalThis.Record<string, string>
                ExpressionAttributeValues?: globalThis.Record<string, AttributeValue>
              }
            }
            type TransactDelete = {
              Delete: {
                TableName: string
                Key: globalThis.Record<string, AttributeValue>
              }
            }
            const transactItems: Array<TransactPut | TransactDelete> = []

            // Put new item with version condition + optional user condition
            {
              const retainCondParts: Array<string> = []
              const retainNames: globalThis.Record<string, string> = {}
              const retainValues: globalThis.Record<string, AttributeValue> = {}
              if (systemFields.version) {
                retainNames["#ver"] = systemFields.version
                retainValues[":expectedVer"] = toAttributeValue(currentVersion)
                retainCondParts.push("#ver = :expectedVer")
              }
              if (userCond) {
                const uc = compileCondition(userCond, resolveDbName)!
                retainCondParts.push(`(${uc.expression})`)
                Object.assign(retainNames, uc.names)
                Object.assign(retainValues, uc.values)
              }
              const mainPut: TransactPut["Put"] = {
                TableName: tableName,
                Item: marshalledNewItem,
              }
              if (retainCondParts.length > 0) {
                mainPut.ConditionExpression = retainCondParts.join(" AND ")
                mainPut.ExpressionAttributeNames = retainNames
                mainPut.ExpressionAttributeValues = retainValues
              }
              transactItems.push({ Put: mainPut })
            }

            // Snapshot of pre-update state (only when retain is enabled)
            if (snapshotItem) {
              transactItems.push({
                Put: {
                  TableName: tableName,
                  Item: toAttributeMap(snapshotItem),
                },
              })
            }

            // Apply sentinel rotations computed earlier
            const sentinelPutIndices: Array<{
              index: number
              constraintName: string
              newFieldsRecord: globalThis.Record<string, string>
            }> = []
            for (const rotation of sentinelRotations) {
              // Delete old sentinel
              transactItems.push({
                Delete: {
                  TableName: tableName,
                  Key: toAttributeMap({
                    [config.indexes.primary.pk.field]: rotation.oldUniqueKey.pk,
                    [config.indexes.primary.sk.field]: rotation.oldUniqueKey.sk,
                  }),
                },
              })

              // Put new sentinel with uniqueness check
              sentinelPutIndices.push({
                index: transactItems.length,
                constraintName: rotation.constraintName,
                newFieldsRecord: rotation.newFieldsRecord,
              })
              transactItems.push({
                Put: {
                  TableName: tableName,
                  Item: toAttributeMap({
                    [config.indexes.primary.pk.field]: rotation.newUniqueKey.pk,
                    [config.indexes.primary.sk.field]: rotation.newUniqueKey.sk,
                    __edd_e__: `${entityType}._unique.${rotation.constraintName}`,
                    _entity_pk: primaryKey[config.indexes.primary.pk.field],
                    _entity_sk: primaryKey[config.indexes.primary.sk.field],
                  }),
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              })
            }

            yield* checkTransactionLimit(entityType, "update", transactItems)
            yield* client
              .transactWriteItems({
                TransactItems: transactItems.map((t) =>
                  "Put" in t ? { Put: t.Put } : { Delete: t.Delete },
                ),
              })
              .pipe(
                Effect.mapError(
                  (err): DynamoClientError | OptimisticLockError | UniqueConstraintViolation => {
                    if (isAwsTransactionCancelled(err.cause)) {
                      const reasons = err.cause.CancellationReasons
                      if (reasons) {
                        // Check sentinel Puts for unique constraint violations
                        for (const {
                          index,
                          constraintName,
                          newFieldsRecord,
                        } of sentinelPutIndices) {
                          if (reasons[index]?.Code === "ConditionalCheckFailed") {
                            return new UniqueConstraintViolation({
                              entityType,
                              constraint: constraintName,
                              fields: newFieldsRecord,
                            })
                          }
                        }
                        // Index 0 is the main item — version conflict or user condition
                        if (reasons[0]?.Code === "ConditionalCheckFailed") {
                          return new OptimisticLockError({
                            entityType,
                            key: decodedKey,
                            expectedVersion: currentVersion,
                            actualVersion: -1,
                          })
                        }
                      }
                    }
                    if (isAwsConditionalCheckFailed(err.cause)) {
                      return new OptimisticLockError({
                        entityType,
                        key: decodedKey,
                        expectedVersion: currentVersion,
                        actualVersion: -1,
                      })
                    }
                    return err as
                      | DynamoClientError
                      | OptimisticLockError
                      | UniqueConstraintViolation
                  },
                ),
              )

            const retainDecoded = yield* decodeAs(newItem, marshalledNewItem, mode)

            // Execute cascade if configured (retain path)
            if (uState.cascade) {
              const domainData = { ...(retainDecoded as object) }
              const sourceId =
                sourceIdentifierField != null
                  ? (decodedKey as globalThis.Record<string, unknown>)[sourceIdentifierField]
                  : undefined
              if (sourceId != null) {
                yield* executeCascade(uState.cascade, domainData, String(sourceId))
              }
            }

            return retainDecoded
          }

          // --- Standard path: updateItem ---
          // Build UpdateExpression
          const setClauses: Array<string> = []
          const names: globalThis.Record<string, string> = {}
          const values: globalThis.Record<string, AttributeValue> = {}
          let counter = 0

          // Add user-provided updates
          for (const [attr, val] of Object.entries(
            hydratedUpdates as globalThis.Record<string, unknown>,
          )) {
            if (val === undefined) continue
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = resolveDbName(attr)
            values[valKey] = toAttributeValue(val)
            setClauses.push(`${nameKey} = ${valKey}`)
            counter++
          }

          // Shared sets for GSI removal detection (used by both compose and REMOVE)
          const removedSet = uState.remove ? new Set(uState.remove) : undefined
          const pkCompositeSet = new Set(primaryKeyComposites(config.indexes))

          // Compose GSI keys for indexes whose composites are in the update,
          // filtering out any GSI whose composites are targeted by REMOVE
          const indexesForGsiUpdate = removedSet
            ? (() => {
                const filtered: globalThis.Record<string, IndexDefinition> = {}
                for (const [indexName, indexDef] of Object.entries(allIndexes)) {
                  if (!("index" in indexDef)) {
                    filtered[indexName] = indexDef
                    continue
                  }
                  const gsiComposites = [...indexDef.pk.composite, ...indexDef.sk.composite].filter(
                    (attr) => !pkCompositeSet.has(attr),
                  )
                  if (!gsiComposites.some((attr) => removedSet.has(attr))) {
                    filtered[indexName] = indexDef
                  }
                }
                return filtered
              })()
            : allIndexes
          let gsiKeys: globalThis.Record<string, string>
          try {
            gsiKeys = KeyComposer.composeGsiKeysForUpdate(
              schema,
              entityType,
              entityVersion,
              indexesForGsiUpdate,
              hydratedUpdates as globalThis.Record<string, unknown>,
              decodedKey as globalThis.Record<string, unknown>,
            )
          } catch (e) {
            return yield* new ValidationError({
              entityType,
              operation: "update.gsiComposites",
              cause: e instanceof Error ? e.message : e,
            })
          }
          for (const [field, value] of Object.entries(gsiKeys)) {
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = field
            values[valKey] = toAttributeValue(value)
            setClauses.push(`${nameKey} = ${valKey}`)
            counter++
          }

          // Add updatedAt timestamp (encoding-aware)
          if (systemFields.updatedAt) {
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = systemFields.updatedAt
            values[valKey] = toAttributeValue(generateTimestamp(systemFields.updatedAtEncoding))
            setClauses.push(`${nameKey} = ${valKey}`)
            counter++
          }

          // Add version increment
          if (systemFields.version) {
            const nameKey = `#u${counter}`
            names[nameKey] = systemFields.version
            setClauses.push(`${nameKey} = ${nameKey} + :vinc`)
            values[":vinc"] = toAttributeValue(1)
            counter++
          }

          // Rich update operations from state
          const removeClauses: Array<string> = []
          const addClauses: Array<string> = []
          const deleteClauses: Array<string> = []

          // SUBTRACT → synthesize SET #field = #field - :val
          if (uState.subtract) {
            for (const [attr, val] of Object.entries(uState.subtract)) {
              const nameKey = `#u${counter}`
              const valKey = `:u${counter}`
              names[nameKey] = resolveDbName(attr)
              values[valKey] = toAttributeValue(val)
              setClauses.push(`${nameKey} = ${nameKey} - ${valKey}`)
              counter++
            }
          }

          // APPEND → synthesize SET #field = list_append(#field, :val)
          if (uState.append) {
            for (const [attr, val] of Object.entries(uState.append)) {
              const nameKey = `#u${counter}`
              const valKey = `:u${counter}`
              names[nameKey] = resolveDbName(attr)
              values[valKey] = toAttributeValue(val)
              setClauses.push(`${nameKey} = list_append(${nameKey}, ${valKey})`)
              counter++
            }
          }

          // REMOVE
          if (uState.remove) {
            for (const attr of uState.remove) {
              const nameKey = `#r${removeClauses.length}`
              names[nameKey] = resolveDbName(attr)
              removeClauses.push(nameKey)
            }
          }

          // Cascade REMOVE to GSI key fields: when a removed attribute is a GSI
          // composite, the GSI pk/sk fields must also be removed so the item drops
          // out of the sparse index.
          if (removedSet) {
            for (const [, indexDef] of Object.entries(allIndexes)) {
              if (!("index" in indexDef)) continue
              const gsiComposites = [...indexDef.pk.composite, ...indexDef.sk.composite].filter(
                (attr) => !pkCompositeSet.has(attr),
              )
              if (gsiComposites.some((attr) => removedSet.has(attr))) {
                for (const keyField of [indexDef.pk.field, indexDef.sk.field]) {
                  const nameKey = `#r${removeClauses.length}`
                  names[nameKey] = keyField
                  removeClauses.push(nameKey)
                }
              }
            }
          }

          // ADD (atomic numeric increment / set addition)
          if (uState.add) {
            for (const [attr, val] of Object.entries(uState.add)) {
              const nameKey = `#a${addClauses.length}`
              const valKey = `:a${addClauses.length}`
              names[nameKey] = resolveDbName(attr)
              values[valKey] = toAttributeValue(val)
              addClauses.push(`${nameKey} ${valKey}`)
            }
          }

          // DELETE (remove elements from set)
          if (uState.deleteFromSet) {
            for (const [attr, val] of Object.entries(uState.deleteFromSet)) {
              const nameKey = `#d${deleteClauses.length}`
              const valKey = `:d${deleteClauses.length}`
              names[nameKey] = resolveDbName(attr)
              values[valKey] = toAttributeValue(val)
              deleteClauses.push(`${nameKey} ${valKey}`)
            }
          }

          // Path-based operations (from typed callback API)
          const pathCounter = { value: 0 }

          // Path SET operations
          if (uState.pathSets) {
            for (const op of uState.pathSets) {
              const pathExpr = compilePath(op.segments, names, "ps", pathCounter, resolveDbName)
              if (op.isPath && op.valueSegments) {
                const srcExpr = compilePath(
                  op.valueSegments,
                  names,
                  "ps",
                  pathCounter,
                  resolveDbName,
                )
                setClauses.push(`${pathExpr} = ${srcExpr}`)
              } else {
                const valKey = `:ps${pathCounter.value++}`
                values[valKey] = toAttributeValue(op.value)
                setClauses.push(`${pathExpr} = ${valKey}`)
              }
            }
          }

          // Path SUBTRACT operations
          if (uState.pathSubtracts) {
            for (const op of uState.pathSubtracts) {
              const pathExpr = compilePath(op.segments, names, "psb", pathCounter, resolveDbName)
              if (op.isPath && op.valueSegments) {
                const srcExpr = compilePath(
                  op.valueSegments,
                  names,
                  "psb",
                  pathCounter,
                  resolveDbName,
                )
                setClauses.push(`${pathExpr} = ${pathExpr} - ${srcExpr}`)
              } else {
                const valKey = `:psb${pathCounter.value++}`
                values[valKey] = toAttributeValue(op.value)
                setClauses.push(`${pathExpr} = ${pathExpr} - ${valKey}`)
              }
            }
          }

          // Path APPEND operations
          if (uState.pathAppends) {
            for (const op of uState.pathAppends) {
              const pathExpr = compilePath(op.segments, names, "pa", pathCounter, resolveDbName)
              const valKey = `:pa${pathCounter.value++}`
              values[valKey] = toAttributeValue(op.value)
              setClauses.push(`${pathExpr} = list_append(${pathExpr}, ${valKey})`)
            }
          }

          // Path PREPEND operations
          if (uState.pathPrepends) {
            for (const op of uState.pathPrepends) {
              const pathExpr = compilePath(op.segments, names, "pp", pathCounter, resolveDbName)
              const valKey = `:pp${pathCounter.value++}`
              values[valKey] = toAttributeValue(op.value)
              setClauses.push(`${pathExpr} = list_append(${valKey}, ${pathExpr})`)
            }
          }

          // Path if_not_exists operations
          if (uState.pathIfNotExists) {
            for (const op of uState.pathIfNotExists) {
              const pathExpr = compilePath(op.segments, names, "pi", pathCounter, resolveDbName)
              const valKey = `:pi${pathCounter.value++}`
              values[valKey] = toAttributeValue(op.value)
              setClauses.push(`${pathExpr} = if_not_exists(${pathExpr}, ${valKey})`)
            }
          }

          // Path REMOVE operations
          if (uState.pathRemoves) {
            for (const segments of uState.pathRemoves) {
              const pathExpr = compilePath(segments, names, "pr", pathCounter, resolveDbName)
              removeClauses.push(pathExpr)
            }
          }

          // Path ADD operations
          if (uState.pathAdds) {
            for (const op of uState.pathAdds) {
              const pathExpr = compilePath(op.segments, names, "pad", pathCounter, resolveDbName)
              const valKey = `:pad${pathCounter.value++}`
              values[valKey] = toAttributeValue(op.value)
              addClauses.push(`${pathExpr} ${valKey}`)
            }
          }

          // Path DELETE operations
          if (uState.pathDeletes) {
            for (const op of uState.pathDeletes) {
              const pathExpr = compilePath(op.segments, names, "pd", pathCounter, resolveDbName)
              const valKey = `:pd${pathCounter.value++}`
              values[valKey] = toAttributeValue(op.value)
              deleteClauses.push(`${pathExpr} ${valKey}`)
            }
          }

          const hasAnyUpdate =
            setClauses.length > 0 ||
            removeClauses.length > 0 ||
            addClauses.length > 0 ||
            deleteClauses.length > 0

          if (!hasAnyUpdate) {
            // Nothing to update — just get the current item
            return yield* get(key)._run(mode)
          }

          // Compose UpdateExpression from all clause types
          const expressionParts: Array<string> = []
          if (setClauses.length > 0) expressionParts.push(`SET ${setClauses.join(", ")}`)
          if (removeClauses.length > 0) expressionParts.push(`REMOVE ${removeClauses.join(", ")}`)
          if (addClauses.length > 0) expressionParts.push(`ADD ${addClauses.join(", ")}`)
          if (deleteClauses.length > 0) expressionParts.push(`DELETE ${deleteClauses.join(", ")}`)
          const updateExpression = expressionParts.join(" ")

          // Build condition expression — combine optimistic lock + user condition
          const condParts: Array<string> = []
          if (evExpected !== undefined && systemFields.version) {
            names["#condVer"] = systemFields.version
            values[":expectedVer"] = toAttributeValue(evExpected)
            condParts.push("#condVer = :expectedVer")
          }
          if (userCond) {
            const uc = compileCondition(userCond, resolveDbName)!
            condParts.push(`(${uc.expression})`)
            Object.assign(names, uc.names)
            Object.assign(values, uc.values)
          }
          const conditionExpression = condParts.length > 0 ? condParts.join(" AND ") : undefined

          const result = yield* client
            .updateItem({
              TableName: tableName,
              Key: marshalledKey,
              UpdateExpression: updateExpression,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
              ConditionExpression: conditionExpression,
              ReturnValues: returnValuesMap[uState.returnValues ?? "allNew"],
            })
            .pipe(
              Effect.mapError((err) => {
                if (isAwsConditionalCheckFailed(err.cause)) {
                  if (evExpected !== undefined) {
                    return new OptimisticLockError({
                      entityType,
                      key: decodedKey,
                      expectedVersion: evExpected,
                      actualVersion: -1,
                    }) as DynamoClientError | OptimisticLockError | ConditionalCheckFailed
                  }
                  if (userCond) {
                    return new ConditionalCheckFailed({
                      entityType,
                      key: decodedKey,
                    }) as DynamoClientError | OptimisticLockError | ConditionalCheckFailed
                  }
                }
                return err as DynamoClientError | OptimisticLockError | ConditionalCheckFailed
              }),
            )

          if (!result.Attributes) {
            return yield* new ItemNotFound({ entityType, key: decodedKey })
          }

          const raw = fromAttributeMap(result.Attributes)
          const decoded = yield* decodeAs(raw, result.Attributes, mode)

          // Execute cascade if configured
          if (uState.cascade) {
            const domainData = { ...(decoded as object) }
            const sourceId =
              sourceIdentifierField != null
                ? (decodedKey as globalThis.Record<string, unknown>)[sourceIdentifierField]
                : undefined
            if (sourceId != null) {
              yield* executeCascade(uState.cascade, domainData, String(sourceId))
            }
          }

          return decoded
        }),
      emptyUpdateState,
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // delete operation
  // ---------------------------------------------------------------------------

  const del = (key: unknown) =>
    new EntityDeleteImpl(
      (opts: {
        readonly condition: Expr | ConditionInput | undefined
        readonly returnValues: ReturnValuesMode | undefined
      }) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const { name: tableName } = yield* tableTag

          // Decode key
          const decodedKey = yield* Schema.decodeUnknownEffect(
            schemas.keySchema as Schema.Codec<any>,
          )(key).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "delete.decode",
                  cause,
                }),
            ),
          )

          // Compose primary key
          const primaryKey = composePrimaryKey(decodedKey)
          const marshalledKey = toAttributeMap(primaryKey)
          const primary = config.indexes.primary
          const hasUniqueConstraints =
            config.unique != null && Object.keys(config.unique).length > 0

          // Build user condition expression if provided
          const userCondition = opts.condition
            ? compileCondition(opts.condition, resolveDbName)
            : undefined

          if (isSoftDeleteEnabled()) {
            // --- Soft delete path ---
            // Read current item
            const result = yield* client.getItem({
              TableName: tableName,
              Key: marshalledKey,
            })

            if (!result.Item) {
              return yield* Effect.fail(new ItemNotFound({ entityType, key: decodedKey }))
            }

            const raw = fromAttributeMap(result.Item) as globalThis.Record<string, unknown>
            const now = nowIso()

            // Build soft-deleted item: same PK, replace SK with deleted key, strip GSI keys
            const deletedItem: globalThis.Record<string, unknown> = { ...raw }

            // Strip GSI key fields — soft-deleted items must not appear in index queries
            for (const field of gsiKeyFields()) {
              delete deletedItem[field]
            }

            // Replace SK with deleted sort key
            deletedItem[primary.sk.field] = DynamoSchema.composeDeletedKey(schema, entityType, now)

            // Add deletedAt
            deletedItem.deletedAt = now

            // Add optional TTL
            const sdTtl = softDeleteTtl()
            if (sdTtl) {
              deletedItem._ttl = Math.floor(Date.now() / 1000) + Duration.toSeconds(sdTtl)
            }

            // Build transaction
            type TransactItem = {
              Put?: { TableName: string; Item: globalThis.Record<string, AttributeValue> }
              Delete?: { TableName: string; Key: globalThis.Record<string, AttributeValue> }
            }
            const transactItems: Array<TransactItem> = []

            // Delete current entity item
            transactItems.push({
              Delete: { TableName: tableName, Key: marshalledKey },
            })

            // Put soft-deleted item
            transactItems.push({
              Put: {
                TableName: tableName,
                Item: toAttributeMap(deletedItem),
              },
            })

            // Version snapshot if retain is enabled
            if (isRetainEnabled()) {
              const currentVersion = systemFields.version
                ? (raw[systemFields.version] as number)
                : 0
              const snapshotItem = buildSnapshotItem(
                raw,
                currentVersion,
                primary.pk.field,
                primary.sk.field,
              )
              transactItems.push({
                Put: {
                  TableName: tableName,
                  Item: toAttributeMap(snapshotItem),
                },
              })
            }

            // Delete sentinels if not preserving unique
            if (hasUniqueConstraints && !preserveUnique()) {
              for (const [constraintName, constraintDef] of Object.entries(config.unique!)) {
                const fields = resolveUniqueFields(constraintDef)
                const fieldValues = fields.map((f) => KeyComposer.serializeValue(raw[f]))
                const uniqueKey = DynamoSchema.composeUniqueKey(
                  schema,
                  entityType,
                  constraintName,
                  fieldValues,
                )

                transactItems.push({
                  Delete: {
                    TableName: tableName,
                    Key: toAttributeMap({
                      [primary.pk.field]: uniqueKey.pk,
                      [primary.sk.field]: uniqueKey.sk,
                    }),
                  },
                })
              }
            }

            yield* checkTransactionLimit(entityType, "delete", transactItems)
            yield* client.transactWriteItems({
              TransactItems: transactItems,
            })
          } else if (hasUniqueConstraints) {
            // --- Hard delete with unique constraints ---
            // First get the item to find sentinel key values
            const result = yield* client.getItem({
              TableName: tableName,
              Key: marshalledKey,
            })

            if (!result.Item) {
              return yield* Effect.fail(new ItemNotFound({ entityType, key: decodedKey }))
            }

            const raw = fromAttributeMap(result.Item)

            const transactItems: Array<{
              Delete: {
                TableName: string
                Key: globalThis.Record<string, AttributeValue>
              }
            }> = []

            // Delete entity item
            transactItems.push({
              Delete: { TableName: tableName, Key: marshalledKey },
            })

            // Delete sentinels
            for (const [constraintName, constraintDef] of Object.entries(config.unique!)) {
              const fields = resolveUniqueFields(constraintDef)
              const fieldValues = fields.map((f) => KeyComposer.serializeValue(raw[f]))
              const uniqueKey = DynamoSchema.composeUniqueKey(
                schema,
                entityType,
                constraintName,
                fieldValues,
              )

              transactItems.push({
                Delete: {
                  TableName: tableName,
                  Key: toAttributeMap({
                    [primary.pk.field]: uniqueKey.pk,
                    [primary.sk.field]: uniqueKey.sk,
                  }),
                },
              })
            }

            yield* checkTransactionLimit(entityType, "delete", transactItems)
            yield* client.transactWriteItems({
              TransactItems: transactItems.map((t) => ({ Delete: t.Delete })),
            })
          } else {
            // Simple delete
            const deleteInput: DeleteItemCommandInput = {
              TableName: tableName,
              Key: marshalledKey,
            }
            if (userCondition) {
              deleteInput.ConditionExpression = userCondition.expression
              deleteInput.ExpressionAttributeNames = userCondition.names
              if (Object.keys(userCondition.values).length > 0) {
                deleteInput.ExpressionAttributeValues = userCondition.values
              }
            }
            if (opts.returnValues) {
              deleteInput.ReturnValues = returnValuesMap[opts.returnValues]
            }
            yield* client.deleteItem(deleteInput).pipe(
              Effect.mapError((err): DynamoClientError | ConditionalCheckFailed => {
                if (opts.condition && isAwsConditionalCheckFailed(err.cause)) {
                  return new ConditionalCheckFailed({
                    entityType,
                    key: decodedKey,
                  })
                }
                return err
              }),
            )
          }
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // deleteIfExists operation — delete + attribute_exists condition
  // ---------------------------------------------------------------------------

  const deleteIfExists = (key: unknown) => {
    const pkField = config.indexes.primary.pk.field
    const op = del(key)
    return new EntityDeleteImpl(
      op._builder,
      op._entity,
      op._key,
      { attributeExists: [pkField] },
      op._returnValues,
    )
  }

  // ---------------------------------------------------------------------------
  // upsert operation — create-or-update via UpdateItem with if_not_exists()
  // ---------------------------------------------------------------------------

  const upsert = (input: unknown) =>
    new EntityPutImpl(
      (mode: DecodeMode, opts: { readonly condition: Expr | ConditionInput | undefined }) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const { name: tableName } = yield* tableTag

          // Decode input
          const decodedInput = yield* Schema.decodeUnknownEffect(
            schemas.inputSchema as Schema.Codec<any>,
          )(input).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "upsert.decode",
                  cause,
                }),
            ),
          )

          // Hydrate refs: replace ID fields with full entity domain data
          const decoded = hasRefs
            ? yield* hydrateRefs(decodedInput as globalThis.Record<string, unknown>)
            : decodedInput

          const item = decoded as globalThis.Record<string, unknown>

          // Compose primary key
          const primaryKey = composePrimaryKey(item)
          const marshalledKey = toAttributeMap(primaryKey)

          // Build UpdateExpression with if_not_exists for immutable fields + createdAt
          const setClauses: Array<string> = []
          const names: globalThis.Record<string, string> = {}
          const values: globalThis.Record<string, AttributeValue> = {}
          let counter = 0

          // Determine primary key composite attribute names
          const pkComposites = new Set(primaryKeyComposites(config.indexes))

          // Serialize date fields on the decoded item
          if (hasDateFields) {
            serializeDateFields(item)
          }

          // All model fields (excluding PK composites, which are in the Key)
          for (const [attr, val] of Object.entries(item)) {
            if (pkComposites.has(attr)) continue
            if (val === undefined) continue

            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = resolveDbName(attr)
            values[valKey] = toAttributeValue(val)

            // Immutable fields use if_not_exists — only set on first create
            if (immutableFields.has(attr)) {
              setClauses.push(`${nameKey} = if_not_exists(${nameKey}, ${valKey})`)
            } else {
              setClauses.push(`${nameKey} = ${valKey}`)
            }
            counter++
          }

          // Add all index keys (including GSIs)
          const allKeys = composeAllKeys(item)
          for (const [field, value] of Object.entries(allKeys)) {
            // Skip primary key fields (they're in Key, not UpdateExpression)
            if (
              field === config.indexes.primary.pk.field ||
              field === config.indexes.primary.sk.field
            )
              continue
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = field
            values[valKey] = toAttributeValue(value)
            setClauses.push(`${nameKey} = ${valKey}`)
            counter++
          }

          // Add entity type discriminator
          {
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = "__edd_e__"
            values[valKey] = toAttributeValue(entityType)
            setClauses.push(`${nameKey} = ${valKey}`)
            counter++
          }

          // Add createdAt with if_not_exists — only set on first create
          if (systemFields.createdAt) {
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = systemFields.createdAt
            values[valKey] = toAttributeValue(generateTimestamp(systemFields.createdAtEncoding))
            setClauses.push(`${nameKey} = if_not_exists(${nameKey}, ${valKey})`)
            counter++
          }

          // Add updatedAt — always set to current time
          if (systemFields.updatedAt) {
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = systemFields.updatedAt
            values[valKey] = toAttributeValue(generateTimestamp(systemFields.updatedAtEncoding))
            setClauses.push(`${nameKey} = ${valKey}`)
            counter++
          }

          // Add version: if_not_exists(version, 0) + 1
          if (systemFields.version) {
            const nameKey = `#u${counter}`
            const zeroKey = `:u${counter}z`
            names[nameKey] = systemFields.version
            values[zeroKey] = toAttributeValue(0)
            values[":vinc"] = toAttributeValue(1)
            setClauses.push(`${nameKey} = if_not_exists(${nameKey}, ${zeroKey}) + :vinc`)
            counter++
          }

          const updateExpression = `SET ${setClauses.join(", ")}`

          // Optional user condition
          const condParts: Array<string> = []
          if (opts.condition) {
            const uc = compileCondition(opts.condition, resolveDbName)!
            condParts.push(`(${uc.expression})`)
            Object.assign(names, uc.names)
            Object.assign(values, uc.values)
          }

          const result = yield* client
            .updateItem({
              TableName: tableName,
              Key: marshalledKey,
              UpdateExpression: updateExpression,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
              ConditionExpression: condParts.length > 0 ? condParts.join(" AND ") : undefined,
              ReturnValues: "ALL_NEW",
            })
            .pipe(
              Effect.mapError((err): DynamoClientError | ConditionalCheckFailed => {
                if (opts.condition && isAwsConditionalCheckFailed(err.cause)) {
                  return new ConditionalCheckFailed({ entityType, key: item })
                }
                return err
              }),
            )

          if (!result.Attributes) {
            return yield* new ItemNotFound({ entityType, key: item })
          }

          const raw = fromAttributeMap(result.Attributes)
          return yield* decodeAs(raw, result.Attributes, mode)
        }),
      self,
      input as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // query namespace
  // ---------------------------------------------------------------------------

  const queryNamespace: globalThis.Record<
    string,
    (pk: globalThis.Record<string, unknown>) => Query.Query<any>
  > = {}
  for (const indexName of Object.keys(config.indexes)) {
    if (indexName === "primary") continue
    const indexDef = config.indexes[indexName]!
    queryNamespace[indexName] = (pk: globalThis.Record<string, unknown>) => {
      const pkValue = KeyComposer.composePk(schema, entityType, indexDef, pk)
      const hasSkComposites = indexDef.sk.composite.some((attr) => pk[attr] !== undefined)
      const query = Query.make({
        tableName: "",
        indexName: indexDef.index,
        pkField: indexDef.pk.field,
        pkValue,
        skField: indexDef.sk.field,
        entityTypes: [entityType],
        decoder: (raw) => decodeRecord(raw),
        resolveTableName: tableTag.useSync((tc: TableConfig) => tc.name),
      })
      if (hasSkComposites) {
        const skPrefix = KeyComposer.composeSortKeyPrefix(
          schema,
          entityType,
          entityVersion,
          indexDef,
          pk,
        )
        return Query.where(query, { beginsWith: skPrefix })
      }
      return query
    }
  }

  // ---------------------------------------------------------------------------
  // scan operation
  // ---------------------------------------------------------------------------

  const scan = () =>
    Query.makeScan({
      tableName: "",
      indexName: undefined,
      entityTypes: [entityType],
      decoder: (raw) => decodeRecord(raw),
      resolveTableName: tableTag.useSync((tc: TableConfig) => tc.name),
    })

  // ---------------------------------------------------------------------------
  // getVersion operation
  // ---------------------------------------------------------------------------

  const getVersion = (key: unknown, versionNumber: number) =>
    new EntityGetImpl(
      (mode: DecodeMode, opts: EntityGetOpts) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const { name: tableName } = yield* tableTag

          // Decode key
          const decodedKey = yield* Schema.decodeUnknownEffect(
            schemas.keySchema as Schema.Codec<any>,
          )(key).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "getVersion.decode",
                  cause,
                }),
            ),
          )

          // Compose PK + version SK
          const primary = config.indexes.primary
          const pkValue = KeyComposer.composePk(schema, entityType, primary, decodedKey)
          const versionSk = DynamoSchema.composeVersionKey(schema, entityType, versionNumber)

          const marshalledKey = toAttributeMap({
            [primary.pk.field]: pkValue,
            [primary.sk.field]: versionSk,
          })

          const result = yield* client.getItem({
            TableName: tableName,
            Key: marshalledKey,
            ConsistentRead: opts.consistentRead || undefined,
          })

          if (!result.Item) {
            return yield* new ItemNotFound({ entityType, key: decodedKey })
          }

          const raw = fromAttributeMap(result.Item)
          return yield* decodeAs(raw, result.Item, mode)
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // versions operation
  // ---------------------------------------------------------------------------

  const versions = (key: unknown) => {
    const decodedKey = Schema.decodeUnknownSync(schemas.keySchema as Schema.Codec<any>)(key)
    const primary = config.indexes.primary
    const pkValue = KeyComposer.composePk(schema, entityType, primary, decodedKey)
    const versionPrefix = DynamoSchema.composeVersionKeyPrefix(schema, entityType)

    return Query.make({
      tableName: "",
      indexName: undefined,
      pkField: primary.pk.field,
      pkValue,
      skField: primary.sk.field,
      entityTypes: [entityType],
      decoder: (raw) => decodeRecord(raw),
      resolveTableName: tableTag.useSync((tc: TableConfig) => tc.name),
    }).pipe(Query.where({ beginsWith: versionPrefix }))
  }

  // ---------------------------------------------------------------------------
  // deleted namespace
  // ---------------------------------------------------------------------------

  const deletedGet = (key: unknown) =>
    new EntityGetImpl(
      (mode: DecodeMode, _opts: EntityGetOpts) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const { name: tableName } = yield* tableTag

          // Decode key
          const decodedKey = yield* Schema.decodeUnknownEffect(
            schemas.keySchema as Schema.Codec<any>,
          )(key).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "deleted.get.decode",
                  cause,
                }),
            ),
          )

          // Query for soft-deleted item using begins_with on deleted prefix
          const primary = config.indexes.primary
          const pkValue = KeyComposer.composePk(schema, entityType, primary, decodedKey)
          const deletedPrefix = DynamoSchema.composeDeletedKeyPrefix(schema, entityType)

          const result = yield* client.query({
            TableName: tableName,
            KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
            ExpressionAttributeNames: {
              "#pk": primary.pk.field,
              "#sk": primary.sk.field,
            },
            ExpressionAttributeValues: {
              ":pk": toAttributeValue(pkValue),
              ":skPrefix": toAttributeValue(deletedPrefix),
            },
            Limit: 1,
            ScanIndexForward: false,
          })

          if (!result.Items || result.Items.length === 0) {
            return yield* new ItemNotFound({ entityType, key: decodedKey })
          }

          const raw = fromAttributeMap(result.Items[0]!)
          // Soft-deleted items have GSI keys stripped — always use deletedRecordSchema
          // (itemSchema would fail because it expects GSI key fields that aren't present)
          if (mode === "native") return result.Items[0]!
          const targetSchema = schemas.deletedRecordSchema
          return yield* Schema.decodeUnknownEffect(targetSchema as Schema.Codec<any>)(raw).pipe(
            Effect.map(attachPrototype),
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "deleted.get.decode",
                  cause,
                }),
            ),
          )
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  const deletedList = (key: unknown) => {
    const decodedKey = Schema.decodeUnknownSync(schemas.keySchema as Schema.Codec<any>)(key)
    const primary = config.indexes.primary
    const pkValue = KeyComposer.composePk(schema, entityType, primary, decodedKey)
    const deletedPrefix = DynamoSchema.composeDeletedKeyPrefix(schema, entityType)

    const decodeDeleted = (raw: globalThis.Record<string, unknown>) =>
      Schema.decodeUnknownEffect(schemas.deletedRecordSchema as Schema.Codec<any>)(raw).pipe(
        Effect.map(attachPrototype),
        Effect.mapError(
          (cause) =>
            new ValidationError({
              entityType,
              operation: "deleted.list.decode",
              cause,
            }),
        ),
      )

    return Query.make({
      tableName: "",
      indexName: undefined,
      pkField: primary.pk.field,
      pkValue,
      skField: primary.sk.field,
      entityTypes: [],
      decoder: (raw) => decodeDeleted(raw),
      resolveTableName: tableTag.useSync((tc: TableConfig) => tc.name),
    }).pipe(Query.where({ beginsWith: deletedPrefix }))
  }

  // ---------------------------------------------------------------------------
  // restore operation
  // ---------------------------------------------------------------------------

  const restore = (key: unknown) =>
    new EntityGetImpl(
      (mode: DecodeMode, _opts: EntityGetOpts) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const { name: tableName } = yield* tableTag

          // Decode key
          const decodedKey = yield* Schema.decodeUnknownEffect(
            schemas.keySchema as Schema.Codec<any>,
          )(key).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "restore.decode",
                  cause,
                }),
            ),
          )

          // Query for the soft-deleted item
          const primary = config.indexes.primary
          const pkValue = KeyComposer.composePk(schema, entityType, primary, decodedKey)
          const deletedPrefix = DynamoSchema.composeDeletedKeyPrefix(schema, entityType)

          const queryResult = yield* client.query({
            TableName: tableName,
            KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
            ExpressionAttributeNames: {
              "#pk": primary.pk.field,
              "#sk": primary.sk.field,
            },
            ExpressionAttributeValues: {
              ":pk": toAttributeValue(pkValue),
              ":skPrefix": toAttributeValue(deletedPrefix),
            },
            Limit: 1,
            ScanIndexForward: false,
          })

          if (!queryResult.Items || queryResult.Items.length === 0) {
            return yield* new ItemNotFound({ entityType, key: decodedKey })
          }

          const deletedRaw = fromAttributeMap(queryResult.Items[0]!)
          const deletedMarshalledKey = toAttributeMap({
            [primary.pk.field]: (deletedRaw as globalThis.Record<string, unknown>)[
              primary.pk.field
            ],
            [primary.sk.field]: (deletedRaw as globalThis.Record<string, unknown>)[
              primary.sk.field
            ],
          })

          // Build restored item: original SK, recompose all GSI keys, remove deletedAt + _ttl
          const restoredItem: globalThis.Record<string, unknown> = {
            ...(deletedRaw as globalThis.Record<string, unknown>),
          }
          delete restoredItem.deletedAt
          delete restoredItem._ttl

          // Increment version
          const currentVersion = systemFields.version
            ? (restoredItem[systemFields.version] as number)
            : 0
          const newVersion = currentVersion + 1
          if (systemFields.version) restoredItem[systemFields.version] = newVersion
          if (systemFields.updatedAt)
            restoredItem[systemFields.updatedAt] = generateTimestamp(systemFields.updatedAtEncoding)

          // Recompose all keys (original SK, GSI keys)
          const restoredKeys = composeAllKeys(restoredItem)
          Object.assign(restoredItem, restoredKeys)

          const marshalledRestoredItem = toAttributeMap(restoredItem)

          // Build transaction
          type TransactItem = {
            Put?: {
              TableName: string
              Item: globalThis.Record<string, AttributeValue>
              ConditionExpression?: string
              ExpressionAttributeNames?: globalThis.Record<string, string>
            }
            Delete?: { TableName: string; Key: globalThis.Record<string, AttributeValue> }
          }
          const transactItems: Array<TransactItem> = []

          // Delete the soft-deleted item
          transactItems.push({
            Delete: { TableName: tableName, Key: deletedMarshalledKey },
          })

          // Put restored item
          transactItems.push({
            Put: {
              TableName: tableName,
              Item: marshalledRestoredItem,
            },
          })

          // Version snapshot if retain enabled
          if (isRetainEnabled()) {
            const snapshotItem = buildSnapshotItem(
              deletedRaw as globalThis.Record<string, unknown>,
              currentVersion,
              primary.pk.field,
              primary.sk.field,
            )
            transactItems.push({
              Put: {
                TableName: tableName,
                Item: toAttributeMap(snapshotItem),
              },
            })
          }

          // Re-establish unique constraint sentinels
          if (config.unique && Object.keys(config.unique).length > 0) {
            for (const [constraintName, constraintDef] of Object.entries(config.unique)) {
              const fields = resolveUniqueFields(constraintDef)
              const fieldValues = fields.map((f) => KeyComposer.serializeValue(restoredItem[f]))
              const uniqueKey = DynamoSchema.composeUniqueKey(
                schema,
                entityType,
                constraintName,
                fieldValues,
              )

              transactItems.push({
                Put: {
                  TableName: tableName,
                  Item: toAttributeMap({
                    [primary.pk.field]: uniqueKey.pk,
                    [primary.sk.field]: uniqueKey.sk,
                    __edd_e__: `${entityType}._unique.${constraintName}`,
                    _entity_pk: restoredKeys[primary.pk.field],
                    _entity_sk: restoredKeys[primary.sk.field],
                  }),
                  ConditionExpression: "attribute_not_exists(#pk)",
                  ExpressionAttributeNames: { "#pk": primary.pk.field },
                },
              })
            }
          }

          yield* checkTransactionLimit(entityType, "restore", transactItems)
          yield* client
            .transactWriteItems({
              TransactItems: transactItems,
            })
            .pipe(
              Effect.mapError((err): DynamoClientError | UniqueConstraintViolation => {
                if (isAwsTransactionCancelled(err.cause)) {
                  const reasons = err.cause.CancellationReasons
                  if (reasons && config.unique) {
                    // Sentinel items are after Delete + Put + optional snapshot
                    const sentinelStart = isRetainEnabled() ? 3 : 2
                    const constraintNames = Object.keys(config.unique)
                    for (let i = sentinelStart; i < reasons.length; i++) {
                      if (reasons[i]?.Code === "ConditionalCheckFailed") {
                        const constraintName = constraintNames[i - sentinelStart] ?? "unknown"
                        const constraintDef = config.unique[constraintName]
                        const uniqueFields = constraintDef ? resolveUniqueFields(constraintDef) : []
                        const fieldsRecord: globalThis.Record<string, string> = {}
                        for (const f of uniqueFields) {
                          fieldsRecord[f] = KeyComposer.serializeValue(restoredItem[f])
                        }
                        return new UniqueConstraintViolation({
                          entityType,
                          constraint: constraintName,
                          fields: fieldsRecord,
                        })
                      }
                    }
                  }
                }
                return err
              }),
            )

          return yield* decodeAs(restoredItem, marshalledRestoredItem, mode)
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // purge operation
  // ---------------------------------------------------------------------------

  const purge = (key: unknown) =>
    new EntityDeleteImpl(
      (_opts: { readonly condition: Expr | ConditionInput | undefined }) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const { name: tableName } = yield* tableTag

          // Decode key
          const decodedKey = yield* Schema.decodeUnknownEffect(
            schemas.keySchema as Schema.Codec<any>,
          )(key).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "purge.decode",
                  cause,
                }),
            ),
          )

          const primary = config.indexes.primary
          const pkValue = KeyComposer.composePk(schema, entityType, primary, decodedKey)

          // Query ALL items in this partition (current + versions + deleted)
          // Use ProjectionExpression to only get keys
          const allItems: Array<globalThis.Record<string, AttributeValue>> = []
          let exclusiveStartKey: globalThis.Record<string, AttributeValue> | undefined

          do {
            const result = yield* client.query({
              TableName: tableName,
              KeyConditionExpression: "#pk = :pk",
              ExpressionAttributeNames: { "#pk": primary.pk.field },
              ExpressionAttributeValues: { ":pk": toAttributeValue(pkValue) },
              ProjectionExpression: `${primary.pk.field}, ${primary.sk.field}`,
              ExclusiveStartKey: exclusiveStartKey,
            })

            if (result.Items) {
              allItems.push(...result.Items)
            }
            exclusiveStartKey = result.LastEvaluatedKey as
              | globalThis.Record<string, AttributeValue>
              | undefined
          } while (exclusiveStartKey)

          // Also get the main/deleted item to find unique sentinel keys
          if (config.unique && Object.keys(config.unique).length > 0) {
            // Get current or deleted item to extract field values for sentinel cleanup
            const marshalledKey = toAttributeMap({
              [primary.pk.field]: pkValue,
              [primary.sk.field]: KeyComposer.composeSk(
                schema,
                entityType,
                entityVersion,
                primary,
                decodedKey,
              ),
            })
            const mainResult = yield* client.getItem({
              TableName: tableName,
              Key: marshalledKey,
            })

            // Try deleted items if main not found
            let entityItem: globalThis.Record<string, unknown> | undefined
            if (mainResult.Item) {
              entityItem = fromAttributeMap(mainResult.Item) as globalThis.Record<string, unknown>
            } else {
              // Check for a soft-deleted item
              const deletedPrefix = DynamoSchema.composeDeletedKeyPrefix(schema, entityType)
              const deletedResult = yield* client.query({
                TableName: tableName,
                KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
                ExpressionAttributeNames: {
                  "#pk": primary.pk.field,
                  "#sk": primary.sk.field,
                },
                ExpressionAttributeValues: {
                  ":pk": toAttributeValue(pkValue),
                  ":skPrefix": toAttributeValue(deletedPrefix),
                },
                Limit: 1,
              })
              if (deletedResult.Items && deletedResult.Items.length > 0) {
                entityItem = fromAttributeMap(deletedResult.Items[0]!) as globalThis.Record<
                  string,
                  unknown
                >
              }
            }

            if (entityItem) {
              // Add sentinel keys to delete list
              for (const [constraintName, constraintDef] of Object.entries(config.unique)) {
                const fields = resolveUniqueFields(constraintDef)
                const fieldValues = fields.map((f) => KeyComposer.serializeValue(entityItem![f]))
                const uniqueKey = DynamoSchema.composeUniqueKey(
                  schema,
                  entityType,
                  constraintName,
                  fieldValues,
                )
                allItems.push(
                  toAttributeMap({
                    [primary.pk.field]: uniqueKey.pk,
                    [primary.sk.field]: uniqueKey.sk,
                  }),
                )
              }
            }
          }

          // Batch delete in chunks of 25
          for (let i = 0; i < allItems.length; i += 25) {
            const chunk = allItems.slice(i, i + 25)
            yield* client.batchWriteItem({
              RequestItems: {
                [tableName]: chunk.map((item) => ({
                  DeleteRequest: {
                    Key: {
                      [primary.pk.field]: item[primary.pk.field]!,
                      [primary.sk.field]: item[primary.sk.field]!,
                    },
                  },
                })),
              },
            })
          }
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // Expression combinators: condition, filter, select
  // ---------------------------------------------------------------------------

  const entityPathBuilder = createPathBuilder<any>([], resolveDbName)
  const entityConditionOps = createConditionOps<any>()

  /**
   * Build a condition expression combinator from callback or shorthand.
   * Returns a function that applies the condition to an EntityPut/Update/Delete.
   */
  const entityCondition = (
    cbOrShorthand: ((...args: any[]) => any) | globalThis.Record<string, unknown>,
  ) => {
    const expr: Expr =
      typeof cbOrShorthand === "function"
        ? cbOrShorthand(entityPathBuilder, entityConditionOps)
        : parseSimpleShorthand(cbOrShorthand)
    return (self: any) => conditionCombinator(self, expr)
  }

  /**
   * Build a filter expression combinator from callback or shorthand.
   * Returns a function that applies the filter to a Query.
   */
  const entityFilter = (
    cbOrShorthand: ((...args: any[]) => any) | globalThis.Record<string, unknown>,
  ) => {
    const expr: Expr =
      typeof cbOrShorthand === "function"
        ? cbOrShorthand(entityPathBuilder, entityConditionOps)
        : parseSimpleShorthand(cbOrShorthand)
    return <A>(q: Query.Query<A>): Query.Query<A> => filterExpr(q, expr)
  }

  /**
   * Build a select (projection) combinator from callback or string array.
   */
  const entitySelect = (
    cbOrAttrs:
      | ((t: any) => ReadonlyArray<{ segments: ReadonlyArray<string | number> }>)
      | ReadonlyArray<string>,
  ) => {
    if (typeof cbOrAttrs === "function") {
      const paths = cbOrAttrs(entityPathBuilder)
      const segments = paths.map((p: { segments: ReadonlyArray<string | number> }) => p.segments)
      return <A>(q: Query.Query<A>): Query.Query<globalThis.Record<string, unknown>> =>
        selectPaths(q, segments)
    }
    return <A>(q: Query.Query<A>): Query.Query<globalThis.Record<string, unknown>> =>
      Query.select(q, cbOrAttrs)
  }

  // ---------------------------------------------------------------------------
  // Flattened query accessors (same as query namespace, but on entity directly)
  // ---------------------------------------------------------------------------

  const flattenedAccessors: globalThis.Record<string, (pk: any) => Query.Query<any>> = {}
  for (const indexName of Object.keys(config.indexes)) {
    if (indexName === "primary") continue
    flattenedAccessors[indexName] = queryNamespace[indexName]!
  }

  const entity = {
    _tag: "Entity" as const,
    model: config.model,
    entityType: config.entityType,
    get indexes() {
      return allIndexes
    },
    timestamps: config.timestamps as TTimestamps,
    versioned: config.versioned as TVersioned,
    softDelete: config.softDelete as TSoftDelete,
    unique: config.unique as TUnique,
    identifier: resolvedIdentifier as ExtractIdentifier<ConfiguredModel<TModel, TAttrs>>,
    _resolvedRefs: resolvedRefs,
    /** @internal Full decode pipeline: rename + date deser + schema decode. Used by Batch/Aggregate. */
    _decodeRecord: decodeRecord,
    _attachPrototype: attachPrototype,
    _configure: (
      injectedSchema: DynamoSchema.DynamoSchema,
      injectedTableTag: import("effect").ServiceMap.Service<TableConfig, TableConfig>,
    ) => {
      schema = injectedSchema
      tableTag = injectedTableTag
    },
    _injectIndex: (name: string, def: IndexDefinition) => {
      allIndexes = { ...allIndexes, [name]: def }
    },
    get _schema() {
      return schema
    },
    get _tableTag() {
      return tableTag
    },
    systemFields,
    schemas,
    inputSchema: schemas.inputSchema,
    createSchema: schemas.createSchema,
    updateSchema: schemas.updateSchema,

    get,
    put,
    create,
    patch,
    update,
    delete: del,
    deleteIfExists,
    upsert,
    scan,
    getVersion,
    versions,
    restore,
    purge,
    deleted: { get: deletedGet, list: deletedList },

    set,
    expectedVersion,

    query: queryNamespace,
    condition: entityCondition,
    filter: entityFilter,
    select: entitySelect,
    ...flattenedAccessors,
    // Cast rationale: Entity.make() builds the entity object incrementally from
    // closures that capture the config. The object literal's inferred type is a
    // union of all closure return types, which doesn't satisfy the fully-generic
    // Entity<TModel, ...> interface. The cast is safe because each method
    // is constructed with the correct types from the generic config parameters.
  } as unknown as Entity<
    TModel,
    TEntityType,
    TIndexes,
    TTimestamps,
    TVersioned,
    TSoftDelete,
    TUnique,
    TRefs,
    ExtractIdentifier<ConfiguredModel<TModel, TAttrs>>
  >

  // Assign self so operation closures can reference the entity
  // Cast needed: Entity<TModel,...> set property is contravariant in updates type,
  // which makes it incompatible with the default Entity (Schema.Top).
  // This is safe — self is only used internally for extractTransactable.
  self = entity as unknown as Entity
  return entity
}

// ---------------------------------------------------------------------------
// Entity binding — resolve services, return BoundEntity with R = never
// ---------------------------------------------------------------------------

/**
 * Bind an Entity to resolved `DynamoClient` and `TableConfig` services.
 * Returns a {@link BoundEntity} where all operations have `R = never`.
 *
 * @internal Used by `DynamoClient.make()` to bind entities.
 */
export const bind = <
  TModel extends Schema.Top,
  TEntityType extends string,
  TIndexes extends globalThis.Record<string, IndexDefinition>,
  TTimestamps extends TimestampsConfig | undefined,
  TVersioned extends VersionedConfig | undefined,
  TSoftDelete extends SoftDeleteConfig | undefined,
  TUnique extends UniqueConfig | undefined,
  TRefs extends globalThis.Record<string, AnyRefValue> | undefined,
  TIdentifier extends string | undefined,
>(
  entity: Entity<
    TModel,
    TEntityType,
    TIndexes,
    TTimestamps,
    TVersioned,
    TSoftDelete,
    TUnique,
    TRefs,
    TIdentifier
  >,
): Effect.Effect<BoundEntity<TModel, TIndexes, TRefs>, never, DynamoClient | TableConfig> =>
  Effect.gen(function* () {
    const ctx = yield* Effect.services<DynamoClient | TableConfig>()
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DynamoClient | TableConfig>,
    ): Effect.Effect<A, E, never> => Effect.provide(effect, ctx)

    type Key = EntityKeyType<TModel, TIndexes>
    type Input = EntityRefInputType<TModel, TRefs>

    // Helper: apply combinators to an EntityUpdate, then run in record mode + provide
    const applyUpdate = (
      op: EntityUpdate<any, any, any, any, any>,
      combinators: ReadonlyArray<(op: any) => any>,
    ) => {
      let result: any = op
      for (const fn of combinators) result = fn(result)
      return provide(result._run("record"))
    }

    // Helper: apply combinators to an EntityPut, then run in record mode + provide
    const applyPut = (
      op: EntityPut<any, any, any, any>,
      combinators: ReadonlyArray<(op: any) => any>,
    ) => {
      let result: any = op
      for (const fn of combinators) result = fn(result)
      return provide(result._run("record"))
    }

    // Helper: apply combinators to an EntityDelete, then asEffect + provide
    const applyDelete = (
      op: EntityDelete<any, any>,
      combinators: ReadonlyArray<(op: any) => any>,
    ) => {
      let result: any = op
      for (const fn of combinators) result = fn(result)
      return provide(result.asEffect())
    }

    // Helper: apply query combinators then execute
    const applyQuery = <A>(q: Query.Query<A>, combinators: ReadonlyArray<(q: any) => any>) => {
      let result: any = q
      for (const fn of combinators) result = fn(result)
      return result as Query.Query<A>
    }

    // Helper: wrap a raw entity-level Query<A> in a BoundQuery with this binding's
    // pre-resolved provide. Used by `versions` and `deleted.list` accessors so consumers
    // get the same fluent .collect() / .fetch() / .paginate() / .reverse() / .limit() /
    // .filter() ergonomics they get from index accessors and `.scan()`.
    const wrapAsBoundQuery = <A>(q: Query.Query<A>) => {
      const bqConfig: BoundQueryConfig<unknown> = {
        pathBuilder: createPathBuilder(),
        conditionOps: createConditionOps(),
        provide,
      }
      return new BoundQueryImpl(q, bqConfig) as unknown as import("./internal/BoundQuery.js").BoundQuery<
        A,
        never,
        A
      >
    }

    return {
      // CRUD — all ops return Effect (auto-wrapped)
      get: (key: Key) => provide((entity.get(key) as any)._run("record")),
      put: (input: Input, ...combinators: ReadonlyArray<(op: any) => any>) =>
        applyPut(entity.put(input), combinators),
      create: (input: Input, ...combinators: ReadonlyArray<(op: any) => any>) =>
        applyPut(entity.create(input), combinators),
      update: (key: Key, ...combinators: ReadonlyArray<(op: any) => any>) =>
        applyUpdate(entity.update(key), combinators),
      delete: (key: Key, ...combinators: ReadonlyArray<(op: any) => any>) =>
        applyDelete(entity.delete(key), combinators),
      upsert: (input: Input, ...combinators: ReadonlyArray<(op: any) => any>) =>
        applyPut(entity.upsert(input), combinators),
      patch: (key: Key, ...combinators: ReadonlyArray<(op: any) => any>) =>
        applyUpdate(entity.patch(key), combinators),
      deleteIfExists: (key: Key, ...combinators: ReadonlyArray<(op: any) => any>) =>
        applyDelete(entity.deleteIfExists(key), combinators),
      // Lifecycle
      getVersion: (key: Key, version: number) =>
        provide((entity.getVersion(key, version) as any)._run("record")),
      versions: (key: Key) => wrapAsBoundQuery(entity.versions(key)),
      restore: (key: Key) => provide((entity.restore(key) as any)._run("record")),
      purge: (key: Key) => provide(entity.purge(key).asEffect()),
      deleted: {
        get: (key: Key) => provide((entity.deleted.get(key) as any)._run("record")),
        list: (key: Key) => wrapAsBoundQuery(entity.deleted.list(key)),
      },
      // Query execution
      paginate: <A>(q: Query.Query<A>, ...combinators: ReadonlyArray<(q: any) => any>) => {
        const final = applyQuery(q, combinators)
        return Stream.unwrap(provide(Query.paginate(final))).pipe(
          Stream.flatMap((page) => Stream.fromIterable(page)),
        )
      },
      collect: <A>(q: Query.Query<A>, ...combinators: ReadonlyArray<(q: any) => any>) =>
        provide(Query.collect(applyQuery(q, combinators))),
      fetch: <A>(q: Query.Query<A>, ...combinators: ReadonlyArray<(q: any) => any>) =>
        provide(Query.execute(applyQuery(q, combinators))),
      scanFetch: (...combinators: ReadonlyArray<(q: any) => any>) =>
        provide(Query.execute(applyQuery(entity.scan(), combinators))),
    } as unknown as BoundEntity<TModel, TIndexes, TRefs>
  })

// ---------------------------------------------------------------------------
// Extraction protocol — used by Transaction and Batch modules
// ---------------------------------------------------------------------------

export interface TransactableInfo {
  readonly opType: "get" | "put" | "update" | "delete"
  readonly entity: Entity
  readonly key?: globalThis.Record<string, unknown> | undefined
  readonly input?: globalThis.Record<string, unknown> | undefined
}

/** @internal */
interface InternalEntityOp {
  readonly [EntityOpTypeId]: EntityOpTypeId
  readonly _opType: string
  readonly _entity: Entity
  readonly _key?: globalThis.Record<string, unknown>
  readonly _input?: globalThis.Record<string, unknown>
}

/** @internal */
interface InternalEntityDelete {
  readonly [EntityDeleteTypeId]: EntityDeleteTypeId
  readonly _entity: Entity
  readonly _key: globalThis.Record<string, unknown>
}

const isEntityOp = (op: object): op is InternalEntityOp => EntityOpTypeId in op

const isEntityDelete = (op: object): op is InternalEntityDelete => EntityDeleteTypeId in op

/**
 * Extract transactable metadata from an Entity operation intermediate.
 * Returns undefined if the value is not a recognized entity operation.
 */
export const extractTransactable = (op: unknown): TransactableInfo | undefined => {
  if (op == null || typeof op !== "object") return undefined

  // Check for EntityOp intermediates (get, put, update)
  if (isEntityOp(op)) {
    if (op._opType === "get") {
      return { opType: "get", entity: op._entity, key: op._key }
    }
    if (op._opType === "put") {
      return { opType: "put", entity: op._entity, input: op._input }
    }
    if (op._opType === "update") {
      return { opType: "update", entity: op._entity, key: op._key }
    }
  }

  // Check for EntityDelete intermediate
  if (isEntityDelete(op)) {
    return { opType: "delete", entity: op._entity, key: op._key }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Type extractors — the 7 derived types
// ---------------------------------------------------------------------------

/**
 * Extract the pure model type from an Entity.
 *
 * `Entity.Model<typeof Users>` = `{ userId: string, email: string, ... }`
 */
export type Model<E extends { readonly model: Schema.Top }> = ModelType<E["model"]>

/**
 * Extract the record type (model + system fields) from an Entity.
 *
 * `Entity.Record<typeof Users>` = model fields + createdAt, updatedAt, version
 */
// eslint-disable-next-line @typescript-eslint/no-shadow
export type Record<
  E extends { readonly model: Schema.Top; readonly timestamps: any; readonly versioned: any },
> = EntityRecordType<E["model"], E["timestamps"], E["versioned"]>

/**
 * Extract the input type from an Entity. Ref-aware: when refs are present,
 * ref fields are replaced with `${field}Id: string`.
 *
 * `Entity.Input<typeof Users>` = model fields only
 * `Entity.Input<typeof TeamPlayerSelection>` = `{ teamId: string, playerId: string, ... }`
 */
export type Input<E extends { readonly model: Schema.Top }> =
  E extends Entity<infer M extends Schema.Top, any, any, any, any, any, any, infer R, any>
    ? EntityRefInputType<M, R>
    : EntityInputType<E["model"]>

/**
 * Extract the create type from an Entity — input fields minus the identifier.
 * Uses the `identifier` config to determine which field to omit.
 * Falls back to omitting all primary key composites when no identifier is set.
 *
 * `Entity.Create<typeof Teams>` = `{ name: string, gender: Gender, league: League }`
 */
export type Create<E extends { readonly model: Schema.Top; readonly indexes: any }> =
  E extends Entity<infer M extends Schema.Top, any, infer I, any, any, any, any, infer R, infer Id>
    ? EntityRefCreateType<M, I, R, Id extends string ? Id : undefined>
    : Omit<EntityInputType<E["model"]>, PrimaryKeyComposites<E["indexes"]>>

/**
 * Extract the update type from an Entity. Ref-aware: when refs are present,
 * ref fields are replaced with optional `${field}Id?: string`.
 *
 * `Entity.Update<typeof Users>` = `{ email?: string, displayName?: string, ... }`
 */
export type Update<E extends { readonly model: Schema.Top; readonly indexes: any }> =
  E extends Entity<infer M extends Schema.Top, any, infer I, any, any, any, any, infer R, any>
    ? EntityRefUpdateType<M, I, R>
    : EntityUpdateType<E["model"], E["indexes"]>

/**
 * Extract the key type from an Entity.
 * Primary index pk + sk composite attributes only.
 *
 * `Entity.Key<typeof Users>` = `{ userId: string }`
 */
export type Key<E extends { readonly model: Schema.Top; readonly indexes: any }> = EntityKeyType<
  E["model"],
  E["indexes"]
>

/**
 * Extract the full DynamoDB item type (unmarshalled).
 * Record + key attributes + __edd_e__.
 *
 * `Entity.Item<typeof Users>` = record + pk, sk, gsi1pk, etc. + __edd_e__
 */
export type Item<E extends { readonly schemas: DerivedSchemas }> = Schema.Schema.Type<
  E["schemas"]["itemSchema"]
>

/**
 * Marshalled DynamoDB item (AttributeValue format).
 * For now, a simple record type. Full typing comes in Group 5.
 */
export type Marshalled<_E> = globalThis.Record<
  string,
  {
    readonly S?: string
    readonly N?: string
    readonly BOOL?: boolean
    readonly NULL?: boolean
    readonly L?: ReadonlyArray<unknown>
    readonly M?: globalThis.Record<string, unknown>
  }
>

// ---------------------------------------------------------------------------
// Utility accessors
// ---------------------------------------------------------------------------

/** Minimal structural type for utility accessors (avoids Entity invariance issues). */
interface EntityLike {
  readonly indexes: globalThis.Record<string, IndexDefinition>
}

/**
 * Get the names of all primary key composite attributes for an entity.
 */
export const keyAttributes = (entity: EntityLike): ReadonlyArray<string> =>
  primaryKeyComposites(entity.indexes)

/**
 * Get the names of all key field attributes (pk, sk, gsi1pk, etc.) for an entity.
 */
export const keyFieldNames = (entity: EntityLike): ReadonlyArray<string> =>
  allKeyFieldNames(entity.indexes)

/**
 * Get the names of all composite attributes across all indexes.
 */
export const compositeAttributes = (entity: EntityLike): ReadonlyArray<string> =>
  allCompositeAttributes(entity.indexes)

// ---------------------------------------------------------------------------
// Schema accessors for raw data
// ---------------------------------------------------------------------------

/** Minimal structural type for schema accessors. */
interface EntityWithSchemas {
  readonly schemas: DerivedSchemas
  readonly _attachPrototype?: (decoded: any) => any
}

/**
 * Get the item schema for an entity.
 *
 * Returns a Schema that decodes unmarshalled DynamoDB items (plain JS objects
 * from `Marshaller.fromAttributeMap`) into Entity.Record instances.
 *
 * Useful for consuming DynamoDB Streams or working with raw query results.
 */
export const itemSchema = (entity: EntityWithSchemas): Schema.Codec<any> =>
  entity.schemas.itemSchema

/**
 * Decode a marshalled DynamoDB item (AttributeValue format) into a typed Entity.Record.
 *
 * Unmarshalls the AttributeValue map to plain JS, then decodes via the entity's item schema.
 * Useful for consuming DynamoDB Streams events or raw SDK responses.
 *
 * Returns an Effect that fails with `ValidationError` if the item doesn't match the schema.
 */
export const decodeMarshalledItem = (
  entity: EntityWithSchemas & { readonly entityType: string },
  marshalledItem: globalThis.Record<string, AttributeValue>,
): Effect.Effect<unknown, ValidationError> =>
  Schema.decodeUnknownEffect(entity.schemas.itemSchema)(fromAttributeMap(marshalledItem)).pipe(
    Effect.map((decoded) => entity._attachPrototype ? entity._attachPrototype(decoded) : decoded),
    Effect.mapError(
      (cause) =>
        new ValidationError({
          entityType: entity.entityType,
          operation: "decodeMarshalledItem",
          cause,
        }),
    ),
  )
