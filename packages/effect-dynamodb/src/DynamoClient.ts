/**
 * DynamoClient — Effect service wrapping the AWS SDK DynamoDBClient.
 *
 * All DynamoDB operations are exposed as Effect-returning methods that fail
 * with {@link DynamoError}. The underlying SDK client lifecycle is managed
 * via `Layer.scoped` (acquire on layer build, destroy on scope close).
 *
 * @module
 */

import type {
  BatchGetItemCommandInput,
  BatchGetItemCommandOutput,
  BatchWriteItemCommandInput,
  BatchWriteItemCommandOutput,
  CreateBackupCommandInput,
  CreateBackupCommandOutput,
  CreateTableCommandInput,
  CreateTableCommandOutput,
  DeleteBackupCommandInput,
  DeleteBackupCommandOutput,
  DeleteItemCommandInput,
  DeleteItemCommandOutput,
  DeleteTableCommandInput,
  DeleteTableCommandOutput,
  DescribeContinuousBackupsCommandInput,
  DescribeContinuousBackupsCommandOutput,
  DescribeExportCommandInput,
  DescribeExportCommandOutput,
  DescribeTableCommandInput,
  DescribeTableCommandOutput,
  DescribeTimeToLiveCommandInput,
  DescribeTimeToLiveCommandOutput,
  ExportTableToPointInTimeCommandInput,
  ExportTableToPointInTimeCommandOutput,
  GetItemCommandInput,
  GetItemCommandOutput,
  ListBackupsCommandInput,
  ListBackupsCommandOutput,
  ListTablesCommandInput,
  ListTablesCommandOutput,
  ListTagsOfResourceCommandInput,
  ListTagsOfResourceCommandOutput,
  PutItemCommandInput,
  PutItemCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  RestoreTableFromBackupCommandInput,
  RestoreTableFromBackupCommandOutput,
  RestoreTableToPointInTimeCommandInput,
  RestoreTableToPointInTimeCommandOutput,
  ScanCommandInput,
  ScanCommandOutput,
  TagResourceCommandInput,
  TagResourceCommandOutput,
  TransactGetItemsCommandInput,
  TransactGetItemsCommandOutput,
  TransactWriteItemsCommandInput,
  TransactWriteItemsCommandOutput,
  UntagResourceCommandInput,
  UntagResourceCommandOutput,
  UpdateContinuousBackupsCommandInput,
  UpdateContinuousBackupsCommandOutput,
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
  UpdateTableCommandInput,
  UpdateTableCommandOutput,
  UpdateTimeToLiveCommandInput,
  UpdateTimeToLiveCommandOutput,
} from "@aws-sdk/client-dynamodb"
import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  CreateBackupCommand,
  CreateTableCommand,
  DeleteBackupCommand,
  DeleteItemCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeExportCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ExportTableToPointInTimeCommand,
  GetItemCommand,
  ListBackupsCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
  PutItemCommand,
  QueryCommand,
  RestoreTableFromBackupCommand,
  RestoreTableToPointInTimeCommand,
  ScanCommand,
  TagResourceCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  UntagResourceCommand,
  UpdateContinuousBackupsCommand,
  UpdateItemCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb"
import { Config, Effect, Layer, type Schema, ServiceMap } from "effect"
import type { Aggregate as AggregateType, BoundAggregate } from "./Aggregate.js"
import { bind as aggregateBind } from "./Aggregate.js"
import * as DynamoSchema from "./DynamoSchema.js"
import type { BoundEntity, Entity as EntityType } from "./Entity.js"
import { bind as entityBind } from "./Entity.js"
import {
  DynamoError,
  DynamoValidationError,
  InternalServerError,
  isAwsInternalServerError,
  isAwsResourceNotFound,
  isAwsThrottling,
  isAwsValidationError,
  ResourceNotFoundError,
  ThrottlingError,
  ValidationError,
} from "./Errors.js"
import { type BoundQueryConfig, BoundQueryImpl } from "./internal/BoundQuery.js"
import { createConditionOps } from "./internal/Expr.js"
import { createPathBuilder } from "./internal/PathBuilder.js"
import type { EntityKeyType, IndexPkInput, IndexSkFields } from "./internal/EntityTypes.js"
import type { IndexDefinition } from "./KeyComposer.js"
import * as KeyComposer from "./KeyComposer.js"
import * as Query from "./Query.js"
import type { CreateTableOptions, Table, TableConfig } from "./Table.js"
import { definition as tableDefinition } from "./Table.js"

/** Union of all DynamoDB client error types */
export type DynamoClientError =
  | DynamoError
  | ThrottlingError
  | DynamoValidationError
  | InternalServerError
  | ResourceNotFoundError

/**
 * Service interface for DynamoDB operations. Each method wraps a single
 * AWS SDK command and returns `Effect<Output, DynamoError>`.
 */
export interface DynamoClientService {
  /** Create a DynamoDB table. */
  readonly createTable: (
    input: CreateTableCommandInput,
  ) => Effect.Effect<CreateTableCommandOutput, DynamoClientError>

  /** Delete a DynamoDB table. */
  readonly deleteTable: (
    input: DeleteTableCommandInput,
  ) => Effect.Effect<DeleteTableCommandOutput, DynamoClientError>

  /** Describe a DynamoDB table (status, stream specification, etc.). */
  readonly describeTable: (
    input: DescribeTableCommandInput,
  ) => Effect.Effect<DescribeTableCommandOutput, DynamoClientError>

  /** Put a single item. */
  readonly putItem: (
    input: PutItemCommandInput,
  ) => Effect.Effect<PutItemCommandOutput, DynamoClientError>

  /** Get a single item by key. */
  readonly getItem: (
    input: GetItemCommandInput,
  ) => Effect.Effect<GetItemCommandOutput, DynamoClientError>

  /** Delete a single item by key. */
  readonly deleteItem: (
    input: DeleteItemCommandInput,
  ) => Effect.Effect<DeleteItemCommandOutput, DynamoClientError>

  /** Update a single item with an update expression. */
  readonly updateItem: (
    input: UpdateItemCommandInput,
  ) => Effect.Effect<UpdateItemCommandOutput, DynamoClientError>

  /** Execute a query against a table or index. */
  readonly query: (input: QueryCommandInput) => Effect.Effect<QueryCommandOutput, DynamoClientError>

  /** Execute a scan against a table or index. */
  readonly scan: (input: ScanCommandInput) => Effect.Effect<ScanCommandOutput, DynamoClientError>

  /** Batch-get up to 100 items in a single request. */
  readonly batchGetItem: (
    input: BatchGetItemCommandInput,
  ) => Effect.Effect<BatchGetItemCommandOutput, DynamoClientError>

  /** Batch-write up to 25 items (puts and deletes) in a single request. */
  readonly batchWriteItem: (
    input: BatchWriteItemCommandInput,
  ) => Effect.Effect<BatchWriteItemCommandOutput, DynamoClientError>

  /** Atomically get up to 100 items across tables. */
  readonly transactGetItems: (
    input: TransactGetItemsCommandInput,
  ) => Effect.Effect<TransactGetItemsCommandOutput, DynamoClientError>

  /** Atomically write up to 100 items across tables (2x WCU cost). */
  readonly transactWriteItems: (
    input: TransactWriteItemsCommandInput,
  ) => Effect.Effect<TransactWriteItemsCommandOutput, DynamoClientError>

  // --- Table management ---

  /** Update table settings (provisioned throughput, GSIs, etc.). */
  readonly updateTable: (
    input: UpdateTableCommandInput,
  ) => Effect.Effect<UpdateTableCommandOutput, DynamoClientError>

  /** List all tables. */
  readonly listTables: (
    input: ListTablesCommandInput,
  ) => Effect.Effect<ListTablesCommandOutput, DynamoClientError>

  // --- Backup ---

  /** Create an on-demand backup. */
  readonly createBackup: (
    input: CreateBackupCommandInput,
  ) => Effect.Effect<CreateBackupCommandOutput, DynamoClientError>

  /** Delete a backup. */
  readonly deleteBackup: (
    input: DeleteBackupCommandInput,
  ) => Effect.Effect<DeleteBackupCommandOutput, DynamoClientError>

  /** List backups. */
  readonly listBackups: (
    input: ListBackupsCommandInput,
  ) => Effect.Effect<ListBackupsCommandOutput, DynamoClientError>

  /** Restore a table from a backup. */
  readonly restoreTableFromBackup: (
    input: RestoreTableFromBackupCommandInput,
  ) => Effect.Effect<RestoreTableFromBackupCommandOutput, DynamoClientError>

  // --- Point-in-Time Recovery ---

  /** Describe continuous backups (PITR) settings. */
  readonly describeContinuousBackups: (
    input: DescribeContinuousBackupsCommandInput,
  ) => Effect.Effect<DescribeContinuousBackupsCommandOutput, DynamoClientError>

  /** Enable or disable PITR. */
  readonly updateContinuousBackups: (
    input: UpdateContinuousBackupsCommandInput,
  ) => Effect.Effect<UpdateContinuousBackupsCommandOutput, DynamoClientError>

  /** Restore a table to a point in time. */
  readonly restoreTableToPointInTime: (
    input: RestoreTableToPointInTimeCommandInput,
  ) => Effect.Effect<RestoreTableToPointInTimeCommandOutput, DynamoClientError>

  // --- Export ---

  /** Export table to S3 (point-in-time snapshot). */
  readonly exportTableToPointInTime: (
    input: ExportTableToPointInTimeCommandInput,
  ) => Effect.Effect<ExportTableToPointInTimeCommandOutput, DynamoClientError>

  /** Describe an export. */
  readonly describeExport: (
    input: DescribeExportCommandInput,
  ) => Effect.Effect<DescribeExportCommandOutput, DynamoClientError>

  // --- TTL ---

  /** Update TTL settings for a table. */
  readonly updateTimeToLive: (
    input: UpdateTimeToLiveCommandInput,
  ) => Effect.Effect<UpdateTimeToLiveCommandOutput, DynamoClientError>

  /** Describe TTL settings for a table. */
  readonly describeTimeToLive: (
    input: DescribeTimeToLiveCommandInput,
  ) => Effect.Effect<DescribeTimeToLiveCommandOutput, DynamoClientError>

  // --- Tags ---

  /** Tag a DynamoDB resource. */
  readonly tagResource: (
    input: TagResourceCommandInput,
  ) => Effect.Effect<TagResourceCommandOutput, DynamoClientError>

  /** Remove tags from a DynamoDB resource. */
  readonly untagResource: (
    input: UntagResourceCommandInput,
  ) => Effect.Effect<UntagResourceCommandOutput, DynamoClientError>

  /** List tags on a DynamoDB resource. */
  readonly listTagsOfResource: (
    input: ListTagsOfResourceCommandInput,
  ) => Effect.Effect<ListTagsOfResourceCommandOutput, DynamoClientError>
}

/**
 * Effect ServiceMap.Service for the DynamoDB client service.
 *
 * Use `DynamoClient.layer(config)` to construct a live Layer that manages
 * the underlying AWS SDK client lifecycle with `Effect.acquireRelease`.
 *
 * @example
 * ```typescript
 * const live = DynamoClient.layer({ region: "us-east-1" })
 * pipe(program, Effect.provide(live), Effect.runPromise)
 * ```
 */
export class DynamoClient extends ServiceMap.Service<DynamoClient, DynamoClientService>()(
  "@effect-dynamodb/DynamoClient",
) {
  /**
   * Create a live Layer that manages an AWS DynamoDBClient.
   *
   * @param config.region - AWS region
   * @param config.endpoint - Optional endpoint override (e.g., for DynamoDB Local)
   * @param config.credentials - Optional static credentials
   */
  static readonly layer = (config: {
    readonly region: string
    readonly endpoint?: string | undefined
    readonly credentials?:
      | { readonly accessKeyId: string; readonly secretAccessKey: string }
      | undefined
  }): Layer.Layer<DynamoClient> =>
    Layer.effect(DynamoClient, buildService(config.region, config.endpoint, config.credentials))

  /**
   * Create a live Layer that reads configuration from Effect Config providers
   * (e.g., environment variables, config files).
   *
   * @param config.region - Config for AWS region
   * @param config.endpoint - Optional Config for endpoint override
   * @param config.credentials - Optional Config for static credentials
   */
  static readonly layerConfig = (config: {
    readonly region: Config.Config<string>
    readonly endpoint?: Config.Config<string> | undefined
    readonly credentials?:
      | Config.Config<{ readonly accessKeyId: string; readonly secretAccessKey: string }>
      | undefined
  }): Layer.Layer<DynamoClient, Config.ConfigError> =>
    Layer.effect(
      DynamoClient,
      Effect.gen(function* () {
        const region = yield* config.region
        const endpoint = config.endpoint ? yield* Config.option(config.endpoint) : undefined
        const credentials = config.credentials
          ? yield* Config.option(config.credentials)
          : undefined
        return yield* buildService(
          region,
          endpoint && endpoint._tag === "Some" ? endpoint.value : undefined,
          credentials && credentials._tag === "Some" ? credentials.value : undefined,
        )
      }),
    )

  /**
   * Create a typed client gateway.
   *
   * **Overload 1 — Entity-centric:** `DynamoClient.make({ entities, collections })`
   * Resolves tables from entities, injects collection indexes, returns a namespaced client
   * with `entities`, `collections`, and `tables` properties.
   *
   * **Overload 2 — Table shortcut:** `DynamoClient.make(table)`
   * Shortcut equivalent to `DynamoClient.make({ entities: table.entities })`.
   *
   * @example
   * ```typescript
   * // Entity-centric
   * const db = yield* DynamoClient.make({ entities: { Users, Tasks }, collections: { Assignments } })
   * yield* db.entities.Users.get({ userId: "123" })
   *
   * // Table shortcut (existing pattern)
   * const db = yield* DynamoClient.make(MainTable)
   * yield* db.Users.get({ userId: "123" })
   * ```
   */
  static readonly make: {
    // --- Overload 1: Table shortcut (existing, checked first) ---
    <T extends Table>(table: T): Effect.Effect<TypedClient<T>, never, DynamoClient | TableConfig>

    // --- Overload 2a: Entity-centric with tables ---
    <
      TEntities extends Record<string, { readonly _tag: "Entity" }>,
      TTables extends Record<string, TableLike>,
    >(config: {
      readonly entities: TEntities
      readonly tables: TTables
    }): Effect.Effect<TypedClientV2<TEntities, TTables>, never, DynamoClient | TableConfig>

    // --- Overload 2b: Entity-centric (no tables) ---
    <TEntities extends Record<string, { readonly _tag: "Entity" }>>(config: {
      readonly entities: TEntities
    }): Effect.Effect<
      TypedClientV2<TEntities, Record<string, TableLike>>,
      never,
      DynamoClient | TableConfig
    >
  } = (configOrTable: any): any => {
    // Detect which overload: Table objects have _tag = "Table"
    if (configOrTable._tag === "Table") {
      return makeFromTable(configOrTable)
    }
    return makeFromConfig(configOrTable)
  }
}

// ---------------------------------------------------------------------------
// TypedClient — mapped type for DynamoClient.make() return value
// ---------------------------------------------------------------------------

/**
 * Typed client returned by `DynamoClient.make(table)`.
 * Maps each entity key to its BoundEntity type, each aggregate key to its
 * BoundAggregate type, plus table management operations.
 */
export type TypedClient<T extends Table> = {
  readonly [K in keyof T["entities"]]: T["entities"][K] extends EntityType<
    infer M,
    any,
    infer I,
    any,
    any,
    any,
    any,
    infer R,
    any
  >
    ? Resolve<BoundEntity<M, I, R, ResolveKey<M, I>>>
    : never
} & {
  readonly [K in keyof T["aggregates"]]: T["aggregates"][K] extends AggregateType<
    infer S,
    infer TKey,
    infer TInput
  >
    ? BoundAggregate<S, TKey, TInput>
    : never
} & {
  /** Create the physical DynamoDB table from registered entity/aggregate definitions. */
  readonly createTable: (options?: CreateTableOptions) => Effect.Effect<void, DynamoClientError>
  /** Delete the physical DynamoDB table. */
  readonly deleteTable: () => Effect.Effect<void, DynamoClientError>
  /** Describe the table. */
  readonly describeTable: () => Effect.Effect<DescribeTableCommandOutput, DynamoClientError>
}

// ---------------------------------------------------------------------------
// TypedClientV2 — mapped type for entity-centric DynamoClient.make() return
// ---------------------------------------------------------------------------

/** Minimal structural type for tables used in DynamoClient.make() config. */
export interface TableLike {
  readonly _tag: "Table"
  readonly schema: import("./DynamoSchema.js").DynamoSchema
  readonly entities: Record<string, { readonly _tag: "Entity" }>
  readonly aggregates: Record<string, unknown>
  readonly Tag: ServiceMap.Service<TableConfig, TableConfig>
}

/**
 * Collection query — returned by `db.collections.Name(composites)`.
 * `.collect()` returns the grouped result directly (not an array).
 */
export interface CollectionQuery<TResult> {
  /** Execute and collect all pages into a grouped result. */
  readonly collect: () => Effect.Effect<
    TResult,
    DynamoClientError | import("./Errors.js").ValidationError,
    never
  >
  /** Execute a single page. */
  readonly fetch: () => Effect.Effect<
    { items: TResult; cursor: string | null },
    DynamoClientError | import("./Errors.js").ValidationError,
    never
  >
  /** Add a filter expression (post-read). */
  readonly filter: {
    (
      fn: (
        t: import("./internal/PathBuilder.js").PathBuilder<unknown, unknown, never>,
        ops: import("./internal/Expr.js").ConditionOps<unknown>,
      ) => import("./internal/Expr.js").Expr,
    ): CollectionQuery<TResult>
    (shorthand: import("./internal/Expr.js").ConditionShorthand): CollectionQuery<TResult>
  }
  /** Set the maximum number of items per DynamoDB page. */
  readonly limit: (n: number) => CollectionQuery<TResult>
  /** Reverse sort order. */
  readonly reverse: () => CollectionQuery<TResult>
  /** Resume from cursor. */
  readonly startFrom: (cursor: string) => CollectionQuery<TResult>
}

/**
 * Typed client returned by `DynamoClient.make({ entities, tables })`.
 * Namespaced under `entities`, `collections`, and `tables`.
 * Collections are auto-discovered from entity index `collection` properties.
 */
export type TypedClientV2<
  TEntities extends Record<string, { readonly _tag: "Entity" }>,
  TTables extends Record<string, TableLike> = Record<string, TableLike>,
> = {
  /** Bound entities with CRUD + query accessors for each index. */
  readonly entities: {
    readonly [K in keyof TEntities]: TEntities[K] extends EntityType<
      infer M,
      any,
      infer I,
      any,
      any,
      any,
      any,
      infer R,
      any
    >
      ? Resolve<
          BoundEntity<M, I, R, ResolveKey<M, I>> & {
            /** Scan this entity. Returns a BoundQuery for building scan queries. */
            readonly scan: () => import("./internal/BoundQuery.js").BoundQuery<
              Schema.Schema.Type<M>,
              never,
              Schema.Schema.Type<M>
            >
          } & EntityIndexAccessors<M, I>
        >
      : never
  }

  /**
   * Collection accessors — auto-discovered from entity index `collection` properties.
   * Access by collection name: `db.collections.assignments({ employee: "x" }).collect()`
   *
   * Each accessor returns a `CollectionQuery` with grouped results keyed by entity name.
   * Type safety for collection results requires explicit type annotation at the call site.
   */
  readonly collections: {
    readonly [K: string]: (composites: Record<string, unknown>) => CollectionQuery<any>
  }

  /** Table operations keyed by table record keys. */
  readonly tables: {
    readonly [K in keyof TTables]: TableOperations
  }
}

/**
 * Collection accessors interface. Uses an interface (not mapped type) so that
 * `noUncheckedIndexedAccess` does not add `| undefined` to each access.
 * Collections are auto-discovered from entity index `collection` properties
 * and guaranteed to exist at runtime.
 */
export interface CollectionAccessors {
  [collectionName: string]: (
    composites: Record<string, unknown>,
  ) => CollectionQuery<Record<string, unknown[]>>
}

// ---------------------------------------------------------------------------
// Collection type computation from entity indexes
// ---------------------------------------------------------------------------

/** Extract all collection names from a single entity's indexes. */
type EntityCollectionNames<E> =
  E extends EntityType<any, any, infer I, any, any, any, any, any, any>
    ? I extends Record<string, IndexDefinition>
      ? {
          [K in keyof I]: I[K] extends { readonly collection: infer C }
            ? C extends string
              ? C
              : C extends ReadonlyArray<string>
                ? C[number]
                : never
            : never
        }[keyof I]
      : never
    : never

/** Extract all collection names from all entities. */
type AllCollectionNames<TEntities extends Record<string, { readonly _tag: "Entity" }>> = {
  [K in keyof TEntities]: EntityCollectionNames<TEntities[K]>
}[keyof TEntities]

/** Build the grouped result type for a collection: { EntityKey: Array<ModelType> } for each entity that has this collection. */
type CollectionGroupedResult<
  TEntities extends Record<string, { readonly _tag: "Entity" }>,
  CollName extends string,
> = {
  readonly [K in keyof TEntities as EntityHasCollection<TEntities[K], CollName> extends true
    ? K
    : never]: TEntities[K] extends EntityType<infer M, any, any, any, any, any, any, any, any>
    ? Array<Schema.Schema.Type<M>>
    : never
}

/** Check if an entity has a specific collection name in any of its indexes. */
type EntityHasCollection<E, CollName extends string> =
  E extends EntityType<any, any, infer I, any, any, any, any, any, any>
    ? I extends Record<string, IndexDefinition>
      ? {
          [K in keyof I]: I[K] extends { readonly collection: infer C }
            ? C extends string
              ? C extends CollName
                ? true
                : false
              : C extends ReadonlyArray<string>
                ? CollName extends C[number]
                  ? true
                  : false
                : false
            : false
        }[keyof I] extends false
        ? false
        : true
      : false
    : false

/**
 * Auto-discovered collection accessors. Keyed by collection name extracted
 * from entity index `collection` properties.
 */
type DiscoveredCollections<TEntities extends Record<string, { readonly _tag: "Entity" }>> = {
  readonly [CollName in AllCollectionNames<TEntities> & string]: (
    composites: Record<string, unknown>,
  ) => CollectionQuery<CollectionGroupedResult<TEntities, CollName>>
}

/** Force TypeScript to resolve an interface/intersection into a plain object for clean hover display */
type Resolve<T> = { [K in keyof T]: T[K] }

/** Resolve EntityKeyType into a plain object type for clean hover display.
 * Uses conditional type to force eager evaluation by TypeScript. */
type ResolveKey<M extends Schema.Top, I> =
  EntityKeyType<M, I> extends infer K ? { [P in keyof K]: K[P] } : never

/** Force eager resolution of remaining SK fields for clean hover display. */
type ResolveSkFields<M extends Schema.Top, I, K extends keyof I, Provided> =
  Omit<IndexSkFields<M, I, K>, keyof Provided> extends infer SK
    ? { readonly [P in keyof SK]: SK[P] }
    : never

/** Compute entity query accessors for each index (non-primary).
 * Generic over provided input — `.where()` only exposes SK composites NOT already provided. */
type EntityIndexAccessors<M extends Schema.Top, I extends Record<string, IndexDefinition>> = {
  readonly [K in Exclude<keyof I, "primary"> & string]: <
    Provided extends IndexPkInput<M, I, K>,
  >(
    composites: Provided,
  ) => import("./internal/BoundQuery.js").BoundQuery<
    Schema.Schema.Type<M>,
    ResolveSkFields<M, I, K, Provided>,
    Schema.Schema.Type<M>
  >
}

/**
 * Pre-bound table operations with resolved table name.
 */
export interface TableOperations {
  /** Create the physical DynamoDB table. */
  readonly create: (options?: CreateTableOptions) => Effect.Effect<void, DynamoClientError>
  /** Delete the physical DynamoDB table. */
  readonly delete: () => Effect.Effect<void, DynamoClientError>
  /** Describe the table. */
  readonly describe: () => Effect.Effect<DescribeTableCommandOutput, DynamoClientError>
  /** Update table settings. */
  readonly update: (
    input: Omit<UpdateTableCommandInput, "TableName">,
  ) => Effect.Effect<void, DynamoClientError>
  /** Create an on-demand backup. */
  readonly backup: (name: string) => Effect.Effect<CreateBackupCommandOutput, DynamoClientError>
  /** List backups for this table. */
  readonly listBackups: () => Effect.Effect<ListBackupsCommandOutput, DynamoClientError>
  /** Restore from a backup. */
  readonly restoreFromBackup: (
    backupArn: string,
  ) => Effect.Effect<RestoreTableFromBackupCommandOutput, DynamoClientError>
  /** Enable point-in-time recovery. */
  readonly enablePointInTimeRecovery: () => Effect.Effect<void, DynamoClientError>
  /** Disable point-in-time recovery. */
  readonly disablePointInTimeRecovery: () => Effect.Effect<void, DynamoClientError>
  /** Restore to a point in time. */
  readonly restoreToPointInTime: (
    timestamp: Date,
  ) => Effect.Effect<RestoreTableToPointInTimeCommandOutput, DynamoClientError>
  /** Export table to S3. */
  readonly exportToS3: (
    s3Bucket: string,
    options?: { readonly s3Prefix?: string; readonly exportFormat?: "DYNAMODB_JSON" | "ION" },
  ) => Effect.Effect<ExportTableToPointInTimeCommandOutput, DynamoClientError>
  /** Enable TTL on an attribute. */
  readonly enableTTL: (attributeName: string) => Effect.Effect<void, DynamoClientError>
  /** Disable TTL on an attribute. */
  readonly disableTTL: (attributeName: string) => Effect.Effect<void, DynamoClientError>
  /** Describe TTL settings. */
  readonly describeTTL: () => Effect.Effect<DescribeTimeToLiveCommandOutput, DynamoClientError>
  /** Tag this table. */
  readonly tag: (tags: Record<string, string>) => Effect.Effect<void, DynamoClientError>
  /** Remove tags from this table. */
  readonly untag: (tagKeys: ReadonlyArray<string>) => Effect.Effect<void, DynamoClientError>
  /** List tags on this table. */
  readonly tags: () => Effect.Effect<ListTagsOfResourceCommandOutput, DynamoClientError>
}

// ---------------------------------------------------------------------------
// makeFromTable — existing Table-based make implementation
// ---------------------------------------------------------------------------

const makeFromTable = <T extends Table>(
  table: T,
): Effect.Effect<TypedClient<T>, never, DynamoClient | TableConfig> =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const tableConfig = yield* table.Tag

    // Bind each entity
    const boundEntities: Record<string, unknown> = {}
    for (const [key, entity] of Object.entries(table.entities)) {
      boundEntities[key] = yield* entityBind(entity as EntityType)
    }

    // Bind each aggregate
    const boundAggregates: Record<string, unknown> = {}
    for (const [key, aggregate] of Object.entries(table.aggregates)) {
      boundAggregates[key] = yield* aggregateBind(aggregate as AggregateType<any, any, any>)
    }

    return {
      ...boundEntities,
      ...boundAggregates,

      createTable: (options?: CreateTableOptions) =>
        idempotentCreate(
          client
            .createTable({
              TableName: tableConfig.name,
              BillingMode: options?.billingMode ?? "PAY_PER_REQUEST",
              ...tableDefinition(table),
            })
            .pipe(Effect.asVoid),
        ),

      deleteTable: () => client.deleteTable({ TableName: tableConfig.name }).pipe(Effect.asVoid),

      describeTable: () => client.describeTable({ TableName: tableConfig.name }),
    } as TypedClient<T>
  })

// ---------------------------------------------------------------------------
// makeFromConfig — entity-centric make implementation
// ---------------------------------------------------------------------------

/** @internal Structural entity type for runtime access. */
interface EntityLike {
  readonly _tag: "Entity"
  readonly entityType: string
  readonly model: Schema.Top
  readonly indexes: Record<string, IndexDefinition>
  readonly _schema: DynamoSchema.DynamoSchema
  readonly _tableTag: ServiceMap.Service<TableConfig, TableConfig>
  readonly _injectIndex: (name: string, def: IndexDefinition) => void
  readonly _decodeRecord: (raw: Record<string, unknown>) => Effect.Effect<any, any>
  readonly schemas: {
    readonly recordSchema: Schema.Codec<any>
  }
}

const makeFromConfig = (config: {
  readonly entities: Record<string, EntityType>
  readonly tables?: Record<string, TableLike>
}): Effect.Effect<any, never, DynamoClient | TableConfig> =>
  Effect.gen(function* () {
    // 1. Resolve the provide function from context
    const ctx = yield* Effect.services<DynamoClient | TableConfig>()
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DynamoClient | TableConfig>,
    ): Effect.Effect<A, E, never> => Effect.provide(effect, ctx)

    // Helper: validate query composites at runtime
    const validateQueryComposites = (
      indexName: string,
      indexDef: IndexDefinition,
      composites: Record<string, unknown>,
    ): void => {
      const pkAttrs = indexDef.pk.composite
      const skAttrs = indexDef.sk.composite

      // 1. All PK composites must be present
      for (const attr of pkAttrs) {
        if (composites[attr] === undefined) {
          throw new Error(
            `[EDD-9002] Missing required partition key attribute "${attr}" for index "${indexName}"`,
          )
        }
      }

      // 2. SK composites must follow prefix ordering
      let lastProvided = -1
      for (let i = 0; i < skAttrs.length; i++) {
        if (composites[skAttrs[i]!] !== undefined) {
          if (i !== lastProvided + 1) {
            const missing = skAttrs.slice(lastProvided + 1, i).join(", ")
            throw new Error(
              `[EDD-9004] Sort key composite "${skAttrs[i]}" for index "${indexName}" requires prior composites: ${missing}. Sort key composites must follow prefix ordering.`,
            )
          }
          lastProvided = i
        }
      }

      // 3. No excess properties
      const validKeys = new Set([...pkAttrs, ...skAttrs])
      for (const key of Object.keys(composites)) {
        if (!validKeys.has(key)) {
          throw new Error(
            `[EDD-9006] Unknown composite attribute "${key}" for index "${indexName}". Valid attributes: ${[...validKeys].join(", ")}`,
          )
        }
      }
    }

    // Helper: build a BoundQuery for a single-entity index query
    const buildEntityQueryAccessor = (
      entityLike: EntityLike,
      _indexName: string,
      indexDef: IndexDefinition,
    ) => {
      return (composites: Record<string, unknown>) => {
        validateQueryComposites(_indexName, indexDef, composites)
        const pkValue = KeyComposer.composePk(
          entityLike._schema,
          entityLike.entityType,
          indexDef,
          composites,
        )
        const query = Query.make({
          tableName: "",
          indexName: indexDef.index,
          pkField: indexDef.pk.field,
          pkValue,
          skField: indexDef.sk.field,
          entityTypes: [entityLike.entityType],
          decoder: (raw) => entityLike._decodeRecord(raw),
          resolveTableName: entityLike._tableTag.useSync((tc: TableConfig) => tc.name),
        })

        // Apply SK prefix from provided composites
        const hasSkComposites = indexDef.sk.composite.some(
          (attr: string) => composites[attr] !== undefined,
        )
        const finalQuery = hasSkComposites
          ? Query.where(query, {
              beginsWith: KeyComposer.composeSortKeyPrefix(
                entityLike._schema,
                entityLike.entityType,
                1,
                indexDef,
                composites,
              ),
            })
          : query

        const pathBuilder = createPathBuilder()
        const conditionOps = createConditionOps()

        // composeSkCondition: prepend the entity SK prefix to user's .where() condition
        const composeSkCondition = (condition: Query.SortKeyCondition): Query.SortKeyCondition => {
          const skPrefix = KeyComposer.composeSortKeyPrefix(
            entityLike._schema,
            entityLike.entityType,
            1,
            indexDef,
            composites,
          )
          const prepend = (value: string) => `${skPrefix}#${value}`
          if ("eq" in condition) return { eq: prepend(condition.eq) }
          if ("lt" in condition) return { lt: prepend(condition.lt) }
          if ("lte" in condition) return { lte: prepend(condition.lte) }
          if ("gt" in condition) return { gt: prepend(condition.gt) }
          if ("gte" in condition) return { gte: prepend(condition.gte) }
          if ("between" in condition)
            return { between: [prepend(condition.between[0]), prepend(condition.between[1])] }
          if ("beginsWith" in condition) return { beginsWith: prepend(condition.beginsWith) }
          return condition
        }

        const bqConfig: BoundQueryConfig<unknown> = {
          pathBuilder,
          conditionOps,
          provide,
          composeSkCondition,
          skFields: indexDef.sk.composite,
        }
        return new BoundQueryImpl(finalQuery, bqConfig)
      }
    }

    // 2. Bind entities + build entity query accessors
    const boundEntities: Record<string, unknown> = {}
    // Track collection memberships for auto-discovery
    // collectionName → { entityKey, entityLike, indexName, indexDef }[]
    const collectionMembers = new Map<
      string,
      Array<{ entityKey: string; entityLike: EntityLike; indexDef: IndexDefinition }>
    >()

    for (const [key, entity] of Object.entries(config.entities)) {
      const bound = yield* entityBind(entity as EntityType)
      const entityLike = entity as unknown as EntityLike
      const accessors: Record<string, unknown> = {}

      // Add query accessor for each non-primary index
      for (const [indexName, indexDef] of Object.entries(entityLike.indexes)) {
        if (indexName === "primary") continue
        if (!indexDef) continue

        accessors[indexName] = buildEntityQueryAccessor(entityLike, indexName, indexDef)

        // Track collection membership for auto-discovery
        if (indexDef.collection) {
          const collNames = Array.isArray(indexDef.collection)
            ? indexDef.collection
            : [indexDef.collection]
          for (const collName of collNames) {
            if (!collectionMembers.has(collName)) {
              collectionMembers.set(collName, [])
            }
            collectionMembers.get(collName)!.push({ entityKey: key, entityLike, indexDef })
          }
        }
      }

      // Add scan accessor
      accessors.scan = () => {
        const scanQuery = Query.makeScan({
          tableName: "",
          indexName: undefined,
          entityTypes: [entityLike.entityType],
          decoder: (raw) => entityLike._decodeRecord(raw),
          resolveTableName: entityLike._tableTag.useSync((tc: TableConfig) => tc.name),
        })
        const pathBuilder = createPathBuilder()
        const conditionOps = createConditionOps()
        const bqConfig: BoundQueryConfig<unknown> = { pathBuilder, conditionOps, provide }
        return new BoundQueryImpl(scanQuery, bqConfig)
      }

      boundEntities[key] = { ...bound, ...accessors }
    }

    // 3. Build auto-discovered collection accessors
    const boundCollections: Record<string, unknown> = {}
    for (const [collName, members] of collectionMembers) {
      boundCollections[collName] = (composites: Record<string, unknown>) => {
        // Use the first member for PK composition
        const firstMember = members[0]!
        const indexDef = firstMember.indexDef

        // Build entity type → entity key lookup
        const memberByType = new Map<string, string>()
        const entityTypes: string[] = []
        for (const member of members) {
          memberByType.set(member.entityLike.entityType, member.entityKey)
          entityTypes.push(member.entityLike.entityType)
        }

        // Collection decoder: decode and group by entity key
        const collDecoder = (raw: Record<string, unknown>) => {
          const entityType = raw.__edd_e__ as string | undefined
          if (!entityType) {
            return Effect.fail(
              new ValidationError({
                entityType: "unknown",
                operation: "collection.decode",
                cause: "Item missing __edd_e__",
              }),
            )
          }
          const entityKey = memberByType.get(entityType)
          if (!entityKey) {
            return Effect.succeed({ _memberKey: "__unknown__", _decoded: raw })
          }
          const member = members.find((m) => m.entityLike.entityType === entityType)
          if (!member) {
            return Effect.succeed({ _memberKey: "__unknown__", _decoded: raw })
          }
          return member.entityLike
            ._decodeRecord(raw)
            .pipe(Effect.map((decoded: unknown) => ({ _memberKey: entityKey, _decoded: decoded })))
        }

        const pkValue = KeyComposer.composePk(
          firstMember.entityLike._schema,
          firstMember.entityLike.entityType,
          indexDef,
          composites,
        )

        // Always isolated — begins_with on collection SK prefix
        let query = Query.make({
          tableName: "",
          indexName: indexDef.index,
          pkField: indexDef.pk.field,
          pkValue,
          skField: indexDef.sk.field,
          entityTypes,
          decoder: collDecoder as any,
          resolveTableName: firstMember.entityLike._tableTag.useSync((tc: TableConfig) => tc.name),
        })

        // Add begins_with on collection SK prefix for clustered collections.
        // For isolated collections (default), each entity has its own entity-type
        // SK prefix, so a collection-name begins_with would filter them all out.
        if (indexDef.sk.field && indexDef.type === "clustered") {
          const skPrefix = DynamoSchema.composeCollectionKey(
            firstMember.entityLike._schema,
            collName,
            [],
            { casing: indexDef.casing ?? firstMember.entityLike._schema.casing },
          )
          query = Query.where(query, { beginsWith: skPrefix })
        }

        // Wrap in BoundQuery that groups results by entity key
        const pathBuilder = createPathBuilder()
        const conditionOps = createConditionOps()
        const collectionProvide = <X, E>(eff: Effect.Effect<X, E, any>) =>
          Effect.provide(eff, ctx) as Effect.Effect<X, E, never>
        const bqConfig: BoundQueryConfig<unknown> = {
          pathBuilder,
          conditionOps,
          provide: collectionProvide,
        }
        const bq = new BoundQueryImpl(query, bqConfig)

        // Override collect to group results
        const originalCollect = bq.collect.bind(bq)
        ;(bq as any).collect = () =>
          Effect.map(originalCollect(), (items: any[]) => {
            const result: Record<string, unknown[]> = {}
            for (const member of members) {
              result[member.entityKey] = []
            }
            for (const item of items) {
              const memberKey = (item as any)._memberKey
              if (memberKey && result[memberKey]) {
                result[memberKey]!.push((item as any)._decoded)
              }
            }
            return result
          })

        return bq
      }
    }

    // 4. Build table operations
    const client = yield* DynamoClient
    const tables: Record<string, TableOperations> = {}

    if (config.tables) {
      for (const [tableKey, table] of Object.entries(config.tables)) {
        const tableConfig = yield* table.Tag
        tables[tableKey] = buildTableOperationsFromTable(
          tableConfig.name,
          table as unknown as Table,
          client,
        )
      }
    } else {
      // Group entities by table tag so we can derive full table schema for create()
      const entitiesByTag = new Map<string, { tag: EntityLike["_tableTag"]; entities: EntityLike[] }>()
      for (const [, entity] of Object.entries(config.entities)) {
        const entityLike = entity as unknown as EntityLike
        const tagId = entityLike._tableTag.key
        if (!entitiesByTag.has(tagId)) {
          entitiesByTag.set(tagId, { tag: entityLike._tableTag, entities: [] })
        }
        entitiesByTag.get(tagId)!.entities.push(entityLike)
      }
      for (const [, { tag, entities: tableEntities }] of entitiesByTag) {
        const tableConfig = yield* tag
        // Build a minimal Table-like object so tableDefinition() can derive GSIs
        const syntheticTable = {
          entities: Object.fromEntries(tableEntities.map((e) => [e.entityType, e])),
          aggregates: {},
        } as unknown as Table
        tables[tableConfig.name] = buildTableOperationsFromTable(tableConfig.name, syntheticTable, client)
      }
    }

    return { entities: boundEntities, collections: boundCollections, tables } as any
  })

// ---------------------------------------------------------------------------
// buildTableOperations — pre-bound table management
// ---------------------------------------------------------------------------

/** Check if a DynamoError wraps a ResourceInUseException (table already exists). */
const isResourceInUse = (err: DynamoClientError): boolean =>
  err._tag === "DynamoError" &&
  err.cause != null &&
  typeof err.cause === "object" &&
  "name" in err.cause &&
  (err.cause as { name: string }).name === "ResourceInUseException"

/** Make createTable idempotent — ignore if table already exists. */
const idempotentCreate = (effect: Effect.Effect<void, DynamoClientError>): Effect.Effect<void, DynamoClientError> =>
  Effect.catchIf(effect, isResourceInUse, () => Effect.void)

const buildTableOperationsFromTable = (
  tableName: string,
  table: Table,
  client: DynamoClientService,
): TableOperations => {
  const def = tableDefinition(table)
  return {
    ...buildTableOperations(tableName, client),
    create: (options?: CreateTableOptions) =>
      idempotentCreate(
        client
          .createTable({
            TableName: tableName,
            BillingMode: options?.billingMode ?? "PAY_PER_REQUEST",
            ...def,
          })
          .pipe(Effect.asVoid),
      ),
  }
}

const buildTableOperations = (tableName: string, client: DynamoClientService): TableOperations => ({
  create: (options?: CreateTableOptions) =>
    idempotentCreate(
      client
        .createTable({
          TableName: tableName,
          BillingMode: options?.billingMode ?? "PAY_PER_REQUEST",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
        })
        .pipe(Effect.asVoid),
    ),
  delete: () => client.deleteTable({ TableName: tableName }).pipe(Effect.asVoid),
  describe: () => client.describeTable({ TableName: tableName }),
  update: (input) =>
    client
      .updateTable({ ...input, TableName: tableName } as UpdateTableCommandInput)
      .pipe(Effect.asVoid),
  backup: (name) => client.createBackup({ TableName: tableName, BackupName: name }),
  listBackups: () => client.listBackups({ TableName: tableName }),
  restoreFromBackup: (backupArn) =>
    client.restoreTableFromBackup({
      TargetTableName: `${tableName}-restore`,
      BackupArn: backupArn,
    }),
  enablePointInTimeRecovery: () =>
    client
      .updateContinuousBackups({
        TableName: tableName,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      })
      .pipe(Effect.asVoid),
  disablePointInTimeRecovery: () =>
    client
      .updateContinuousBackups({
        TableName: tableName,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      })
      .pipe(Effect.asVoid),
  restoreToPointInTime: (timestamp) =>
    client.restoreTableToPointInTime({
      SourceTableName: tableName,
      TargetTableName: `${tableName}-pitr-restore`,
      RestoreDateTime: timestamp,
    }),
  exportToS3: (s3Bucket, options) =>
    client.exportTableToPointInTime({
      TableArn: tableName, // Will need actual ARN — use describe first
      S3Bucket: s3Bucket,
      S3Prefix: options?.s3Prefix,
      ExportFormat: options?.exportFormat,
    }),
  enableTTL: (attributeName) =>
    client
      .updateTimeToLive({
        TableName: tableName,
        TimeToLiveSpecification: {
          Enabled: true,
          AttributeName: attributeName,
        },
      })
      .pipe(Effect.asVoid),
  disableTTL: (attributeName) =>
    client
      .updateTimeToLive({
        TableName: tableName,
        TimeToLiveSpecification: {
          Enabled: false,
          AttributeName: attributeName,
        },
      })
      .pipe(Effect.asVoid),
  describeTTL: () => client.describeTimeToLive({ TableName: tableName }),
  tag: (tags) =>
    client
      .tagResource({
        ResourceArn: tableName, // Will need actual ARN
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      })
      .pipe(Effect.asVoid),
  untag: (tagKeys) =>
    client
      .untagResource({
        ResourceArn: tableName, // Will need actual ARN
        TagKeys: [...tagKeys],
      })
      .pipe(Effect.asVoid),
  tags: () => client.listTagsOfResource({ ResourceArn: tableName }),
})

/** @internal Classify an AWS SDK error into a specific tagged error type. */
const classifyError =
  (operation: string) =>
  (cause: unknown): DynamoClientError => {
    if (isAwsThrottling(cause)) return new ThrottlingError({ operation, cause })
    if (isAwsValidationError(cause)) return new DynamoValidationError({ operation, cause })
    if (isAwsInternalServerError(cause)) return new InternalServerError({ operation, cause })
    if (isAwsResourceNotFound(cause)) return new ResourceNotFoundError({ operation, cause })
    return new DynamoError({ operation, cause })
  }

/** @internal Build the DynamoClient service implementation from resolved config values. */
const buildService = (
  region: string,
  endpoint: string | undefined,
  credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined,
) =>
  Effect.gen(function* () {
    const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = { region }
    if (endpoint !== undefined) clientConfig.endpoint = endpoint
    if (credentials !== undefined) clientConfig.credentials = credentials
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DynamoDBClient(clientConfig)),
      (c) => Effect.sync(() => c.destroy()),
    )
    return {
      createTable: (input) =>
        Effect.tryPromise({
          try: () => client.send(new CreateTableCommand(input)),
          catch: classifyError("CreateTable"),
        }),
      deleteTable: (input) =>
        Effect.tryPromise({
          try: () => client.send(new DeleteTableCommand(input)),
          catch: classifyError("DeleteTable"),
        }),
      describeTable: (input) =>
        Effect.tryPromise({
          try: () => client.send(new DescribeTableCommand(input)),
          catch: classifyError("DescribeTable"),
        }),
      putItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new PutItemCommand(input)),
          catch: classifyError("PutItem"),
        }),
      getItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new GetItemCommand(input)),
          catch: classifyError("GetItem"),
        }),
      deleteItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new DeleteItemCommand(input)),
          catch: classifyError("DeleteItem"),
        }),
      updateItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new UpdateItemCommand(input)),
          catch: classifyError("UpdateItem"),
        }),
      query: (input) =>
        Effect.tryPromise({
          try: () => client.send(new QueryCommand(input)),
          catch: classifyError("Query"),
        }),
      scan: (input) =>
        Effect.tryPromise({
          try: () => client.send(new ScanCommand(input)),
          catch: classifyError("Scan"),
        }),
      batchGetItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new BatchGetItemCommand(input)),
          catch: classifyError("BatchGetItem"),
        }),
      batchWriteItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new BatchWriteItemCommand(input)),
          catch: classifyError("BatchWriteItem"),
        }),
      transactGetItems: (input) =>
        Effect.tryPromise({
          try: () => client.send(new TransactGetItemsCommand(input)),
          catch: classifyError("TransactGetItems"),
        }),
      transactWriteItems: (input) =>
        Effect.tryPromise({
          try: () => client.send(new TransactWriteItemsCommand(input)),
          catch: classifyError("TransactWriteItems"),
        }),
      // --- Table management ---
      updateTable: (input) =>
        Effect.tryPromise({
          try: () => client.send(new UpdateTableCommand(input)),
          catch: classifyError("UpdateTable"),
        }),
      listTables: (input) =>
        Effect.tryPromise({
          try: () => client.send(new ListTablesCommand(input)),
          catch: classifyError("ListTables"),
        }),
      // --- Backup ---
      createBackup: (input) =>
        Effect.tryPromise({
          try: () => client.send(new CreateBackupCommand(input)),
          catch: classifyError("CreateBackup"),
        }),
      deleteBackup: (input) =>
        Effect.tryPromise({
          try: () => client.send(new DeleteBackupCommand(input)),
          catch: classifyError("DeleteBackup"),
        }),
      listBackups: (input) =>
        Effect.tryPromise({
          try: () => client.send(new ListBackupsCommand(input)),
          catch: classifyError("ListBackups"),
        }),
      restoreTableFromBackup: (input) =>
        Effect.tryPromise({
          try: () => client.send(new RestoreTableFromBackupCommand(input)),
          catch: classifyError("RestoreTableFromBackup"),
        }),
      // --- PITR ---
      describeContinuousBackups: (input) =>
        Effect.tryPromise({
          try: () => client.send(new DescribeContinuousBackupsCommand(input)),
          catch: classifyError("DescribeContinuousBackups"),
        }),
      updateContinuousBackups: (input) =>
        Effect.tryPromise({
          try: () => client.send(new UpdateContinuousBackupsCommand(input)),
          catch: classifyError("UpdateContinuousBackups"),
        }),
      restoreTableToPointInTime: (input) =>
        Effect.tryPromise({
          try: () => client.send(new RestoreTableToPointInTimeCommand(input)),
          catch: classifyError("RestoreTableToPointInTime"),
        }),
      // --- Export ---
      exportTableToPointInTime: (input) =>
        Effect.tryPromise({
          try: () => client.send(new ExportTableToPointInTimeCommand(input)),
          catch: classifyError("ExportTableToPointInTime"),
        }),
      describeExport: (input) =>
        Effect.tryPromise({
          try: () => client.send(new DescribeExportCommand(input)),
          catch: classifyError("DescribeExport"),
        }),
      // --- TTL ---
      updateTimeToLive: (input) =>
        Effect.tryPromise({
          try: () => client.send(new UpdateTimeToLiveCommand(input)),
          catch: classifyError("UpdateTimeToLive"),
        }),
      describeTimeToLive: (input) =>
        Effect.tryPromise({
          try: () => client.send(new DescribeTimeToLiveCommand(input)),
          catch: classifyError("DescribeTimeToLive"),
        }),
      // --- Tags ---
      tagResource: (input) =>
        Effect.tryPromise({
          try: () => client.send(new TagResourceCommand(input)),
          catch: classifyError("TagResource"),
        }),
      untagResource: (input) =>
        Effect.tryPromise({
          try: () => client.send(new UntagResourceCommand(input)),
          catch: classifyError("UntagResource"),
        }),
      listTagsOfResource: (input) =>
        Effect.tryPromise({
          try: () => client.send(new ListTagsOfResourceCommand(input)),
          catch: classifyError("ListTagsOfResource"),
        }),
    } satisfies DynamoClientService
  })
