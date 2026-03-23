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
import type {
  Collection as CollectionDef,
  CollectionMember,
  CollectionResult,
} from "./Collections.js"
import { buildMemberIndexDef } from "./Collections.js"
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

    // --- Overload 2a: Entity-centric with collections ---
    <
      TEntities extends Record<string, { readonly _tag: "Entity" }>,
      TCollections extends Record<string, CollectionDef>,
    >(config: {
      readonly entities: TEntities
      readonly collections: TCollections
    }): Effect.Effect<TypedClientV2<TEntities, TCollections>, never, DynamoClient | TableConfig>

    // --- Overload 2b: Entity-centric (no collections) ---
    <TEntities extends Record<string, { readonly _tag: "Entity" }>>(config: {
      readonly entities: TEntities
    }): Effect.Effect<TypedClientV2<TEntities, {}>, never, DynamoClient | TableConfig>
  } = (configOrTable: any): any => {
    // Detect which overload: Table objects have _tag
    if (configOrTable._tag !== undefined || !("entities" in configOrTable)) {
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
    ? BoundEntity<M, I, R>
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
 * Typed client returned by `DynamoClient.make({ entities, collections })`.
 * Namespaced under `entities`, `collections`, and `tables`.
 */
export type TypedClientV2<
  TEntities extends Record<string, { readonly _tag: "Entity" }>,
  TCollections extends Record<string, CollectionDef>,
> = {
  /** Bound entities with CRUD ops + query accessors from collections. */
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
      ? BoundEntity<M, I, R> & {
          /** Scan this entity. Returns a BoundQuery for building scan queries. */
          readonly scan: () => import("./internal/BoundQuery.js").BoundQuery<
            import("effect").Schema.Schema.Type<M>,
            never,
            import("effect").Schema.Schema.Type<M>
          >
        }
      : never
  }

  /** Collection accessors — grouped result queries. */
  readonly collections: {
    readonly [K in keyof TCollections]: (
      composites: Record<string, unknown>,
    ) => CollectionQuery<
      CollectionResult<TCollections[K] extends CollectionDef<any, infer M> ? M : never>
    >
  }

  /** Table operations keyed by resolved table name. */
  readonly tables: Record<string, TableOperations>
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
        client
          .createTable({
            TableName: tableConfig.name,
            BillingMode: options?.billingMode ?? "PAY_PER_REQUEST",
            ...tableDefinition(table),
          })
          .pipe(Effect.asVoid),

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

const makeFromConfig = <
  TEntities extends Record<string, EntityType>,
  TCollections extends Record<string, CollectionDef>,
>(config: {
  readonly entities: TEntities
  readonly collections?: TCollections
}): Effect.Effect<TypedClientV2<TEntities, TCollections>, never, DynamoClient | TableConfig> =>
  Effect.gen(function* () {
    const collections = (config.collections ?? {}) as Record<string, CollectionDef>

    // 1. Inject collection indexes into member entities
    for (const [collName, collection] of Object.entries(collections)) {
      for (const [memberKey, m] of Object.entries(collection.members)) {
        const member = m as CollectionMember
        const entity = member.entity as unknown as EntityLike
        const indexDef = buildMemberIndexDef(collection, memberKey, member)
        entity._injectIndex(collName, indexDef)
      }
    }

    // 2. Resolve the provide function from context
    const ctx = yield* Effect.services<DynamoClient | TableConfig>()
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DynamoClient | TableConfig>,
    ): Effect.Effect<A, E, never> => Effect.provide(effect, ctx)

    // 3. Bind entities
    const boundEntities: Record<string, unknown> = {}
    for (const [key, entity] of Object.entries(config.entities)) {
      const bound = yield* entityBind(entity as EntityType)

      // Inject collection-derived query accessors
      const entityLike = entity as unknown as EntityLike
      const accessors: Record<string, unknown> = {}

      for (const [collName, collection] of Object.entries(collections)) {
        // Check if this entity is a member of this collection
        for (const [, m] of Object.entries(collection.members)) {
          const member = m as CollectionMember
          if ((member.entity as unknown as EntityLike).entityType !== entityLike.entityType)
            continue

          // Build query accessor for this collection membership
          accessors[collName] = (composites: Record<string, unknown>) => {
            const indexDef = entityLike.indexes[collName]
            if (!indexDef) return undefined

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

            // Build BoundQuery config
            const pathBuilder = createPathBuilder()
            const conditionOps = createConditionOps()
            const bqConfig: BoundQueryConfig<unknown> = {
              pathBuilder,
              conditionOps,
              provide,
            }
            return new BoundQueryImpl(finalQuery, bqConfig)
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
        const bqConfig: BoundQueryConfig<unknown> = {
          pathBuilder,
          conditionOps,
          provide,
        }
        return new BoundQueryImpl(scanQuery, bqConfig)
      }

      boundEntities[key] = { ...bound, ...accessors }
    }

    // 4. Build collection accessors
    const boundCollections: Record<string, unknown> = {}
    for (const [collName, collection] of Object.entries(collections)) {
      boundCollections[collName] = (composites: Record<string, unknown>) => {
        // Get the first member to extract schema and PK info
        const firstMember = Object.values(collection.members)[0] as CollectionMember
        const firstEntity = firstMember.entity as unknown as EntityLike
        const indexDef = firstEntity.indexes[collName]
        if (!indexDef)
          throw new Error(
            `Collection '${collName}' index not found on entity '${firstEntity.entityType}'`,
          )

        // Build entity type → member key lookup
        const memberByType = new Map<string, string>()
        const entityTypes: string[] = []
        for (const [memberKey, m] of Object.entries(collection.members)) {
          const member = m as CollectionMember
          const entity = member.entity as unknown as EntityLike
          memberByType.set(entity.entityType, memberKey)
          entityTypes.push(entity.entityType)
        }

        // Collection decoder: decode and group by member key
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
          const memberKey = memberByType.get(entityType)
          if (!memberKey) {
            return Effect.succeed({ _memberKey: "__unknown__", _decoded: raw })
          }
          // Find the member's entity and decode through its record schema
          for (const [mk, m] of Object.entries(collection.members)) {
            const member = m as CollectionMember
            const entity = member.entity as unknown as EntityLike
            if (entity.entityType === entityType) {
              return entity._decodeRecord(raw).pipe(
                Effect.map((decoded: unknown) => ({
                  _memberKey: mk,
                  _decoded: decoded,
                })),
              )
            }
          }
          return Effect.succeed({ _memberKey: "__unknown__", _decoded: raw })
        }

        const pkValue = KeyComposer.composePk(
          firstEntity._schema,
          firstEntity.entityType,
          indexDef,
          composites,
        )

        // For clustered collections, add begins_with on collection SK prefix
        let query = Query.make({
          tableName: "",
          indexName: indexDef.index,
          pkField: indexDef.pk.field,
          pkValue,
          skField: indexDef.sk.field,
          entityTypes,
          decoder: collDecoder as any,
          resolveTableName: firstEntity._tableTag.useSync((tc: TableConfig) => tc.name),
        })

        if (collection.type === "clustered" && indexDef.sk.field) {
          const skPrefix = DynamoSchema.composeCollectionKey(firstEntity._schema, collName, [], {
            casing: indexDef.casing ?? firstEntity._schema.casing,
          })
          query = Query.where(query, { beginsWith: skPrefix })
        }

        // Wrap in a BoundQuery that groups results by member key
        const pathBuilder = createPathBuilder()
        const conditionOps = createConditionOps()

        // Custom provide that also groups results
        const collectionProvide = <X, E>(eff: Effect.Effect<X, E, any>) =>
          Effect.provide(eff, ctx) as Effect.Effect<X, E, never>

        // Return a custom BoundQuery that transforms collect/fetch results
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
            for (const [memberKey] of Object.entries(collection.members)) {
              result[memberKey] = []
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

    // 5. Build table operations
    const client = yield* DynamoClient
    const tables: Record<string, TableOperations> = {}

    // Collect unique tables from entities
    const seenTags = new Set<string>()
    for (const [, entity] of Object.entries(config.entities)) {
      const entityLike = entity as unknown as EntityLike
      const tagId = entityLike._tableTag.key
      if (seenTags.has(tagId)) continue
      seenTags.add(tagId)

      const tableConfig = yield* entityLike._tableTag
      const tableName = tableConfig.name

      tables[tableName] = buildTableOperations(tableName, client)
    }

    return {
      entities: boundEntities,
      collections: boundCollections,
      tables,
    } as unknown as TypedClientV2<TEntities, TCollections>
  })

// ---------------------------------------------------------------------------
// buildTableOperations — pre-bound table management
// ---------------------------------------------------------------------------

const buildTableOperations = (tableName: string, client: DynamoClientService): TableOperations => ({
  create: (options?: CreateTableOptions) =>
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
