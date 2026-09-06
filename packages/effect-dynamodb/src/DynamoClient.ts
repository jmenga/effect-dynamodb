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
  SearchVectorsCommandInput,
  SearchVectorsCommandOutput,
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
  SearchVectorsCommand,
  TagResourceCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  UntagResourceCommand,
  UpdateContinuousBackupsCommand,
  UpdateItemCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { EmbedderService } from "@effect-dynamodb/schema/Embedder.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import type { EntityDefinition } from "@effect-dynamodb/schema/Entity.js"
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
} from "@effect-dynamodb/schema/Errors.js"
import {
  encodeCompositeRecord,
  makeCompositeEncoder,
} from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import { makeDefaultCrypto } from "@effect-dynamodb/schema/internal/DefaultCrypto.js"
import type {
  EntityKeyType,
  IndexPkInput,
  IndexSkFields,
} from "@effect-dynamodb/schema/internal/EntityTypes.js"
import type { IndexDefinition } from "@effect-dynamodb/schema/KeyComposer.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import type {
  VectorIndexConfig,
  VectorIndexDefinition,
} from "@effect-dynamodb/schema/VectorIndex.js"
import { Config, Context, Crypto, Duration, Effect, Layer, Option, type Schema } from "effect"
import type { Aggregate as AggregateType, BoundAggregate } from "./Aggregate.js"
import { bind as aggregateBind } from "./Aggregate.js"
import type { BoundEntity, Entity as EntityType } from "./Entity.js"
import { bind as entityBind, fromDefinition as entityFromDefinition } from "./Entity.js"
import {
  type BoundQueryConfig,
  BoundQueryImpl,
  type RawSortKeyCondition,
} from "./internal/BoundQuery.js"
import {
  type BoundVectorQuery,
  type BoundVectorQueryConfig,
  makeBoundVectorQuery,
} from "./internal/BoundVectorQuery.js"
import { createConditionOps } from "./internal/Expr.js"
import { createPathBuilder } from "./internal/PathBuilder.js"
import * as Query from "./Query.js"
import type { CreateTableOptions, Table, TableConfig } from "./Table.js"
import { mergeVectorIndexes, definition as tableDefinition, toVectorIndexSpec } from "./Table.js"

/**
 * Upper-bound sentinel used when a `.where()` condition targets a sort key
 * composite that is NOT the last one. The composed operand is then only a
 * prefix of the stored key, so an inclusive upper bound has to be pushed past
 * every key in that composite value's subtree. `￿` is the highest
 * code point representable in a 3-byte UTF-8 sequence, which sorts above every
 * character DynamoDB key composition emits for the following segment.
 */
const SK_MAX_SENTINEL = "￿"

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

  /**
   * Approximate-nearest-neighbour search against a vector index.
   *
   * Endpoint routing to `search-dynamodb.{region}.amazonaws.com` is handled by
   * the standard SDK client's endpoint ruleset (an explicit `endpoint` override
   * wins), so there is no second client to configure. The operation requires the
   * `dynamodb:SearchVectors` IAM action — existing read policies do NOT cover it.
   *
   * DynamoDB Local does not implement this operation; use
   * `VectorSearchEmulation.layer` for local testing.
   */
  readonly searchVectors: (
    input: SearchVectorsCommandInput,
  ) => Effect.Effect<SearchVectorsCommandOutput, DynamoClientError>

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
 * Effect Context.Service for the DynamoDB client service.
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
export class DynamoClient extends Context.Service<DynamoClient, DynamoClientService>()(
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
   * Create a typed client gateway from entities, aggregates, and (optionally) tables.
   *
   * Returns a namespaced client with `entities`, `aggregates`, `collections`, and
   * `tables` properties. Collections are auto-discovered from entity index
   * `collection` properties — no separate registration needed.
   *
   * @example
   * ```typescript
   * const db = yield* DynamoClient.make({
   *   entities: { Users, Tasks },
   *   aggregates: { OrderAggregate },
   *   tables: { MainTable },
   * })
   *
   * yield* db.entities.Users.get({ userId: "123" })
   * yield* db.aggregates.OrderAggregate.get({ orderId: "o-1" })
   * yield* db.collections.assignments({ userId: "123" }).collect()
   * yield* db.tables.MainTable.create()
   * ```
   */
  static readonly make: {
    <
      TEntities extends Record<string, { readonly _tag: "Entity" }>,
      TAggregates extends Record<string, AggregateType<any, any, any>>,
      TTables extends Record<string, TableLike>,
    >(config: {
      readonly entities: TEntities
      readonly aggregates: TAggregates
      readonly tables: TTables
      readonly crypto?: Crypto.Crypto
      readonly embedder?: EmbedderService
    }): Effect.Effect<
      TypedClient<TEntities, TAggregates, TTables>,
      never,
      DynamoClient | TableConfig
    >

    <
      TEntities extends Record<string, { readonly _tag: "Entity" }>,
      TAggregates extends Record<string, AggregateType<any, any, any>>,
    >(config: {
      readonly entities: TEntities
      readonly aggregates: TAggregates
      readonly crypto?: Crypto.Crypto
      readonly embedder?: EmbedderService
    }): Effect.Effect<
      TypedClient<TEntities, TAggregates, Record<string, TableLike>>,
      never,
      DynamoClient | TableConfig
    >

    <
      TEntities extends Record<string, { readonly _tag: "Entity" }>,
      TTables extends Record<string, TableLike>,
    >(config: {
      readonly entities: TEntities
      readonly tables: TTables
      readonly crypto?: Crypto.Crypto
      readonly embedder?: EmbedderService
    }): Effect.Effect<
      TypedClient<TEntities, Record<string, never>, TTables>,
      never,
      DynamoClient | TableConfig
    >

    <TEntities extends Record<string, { readonly _tag: "Entity" }>>(config: {
      readonly entities: TEntities
      readonly crypto?: Crypto.Crypto
      readonly embedder?: EmbedderService
    }): Effect.Effect<
      TypedClient<TEntities, Record<string, never>, Record<string, TableLike>>,
      never,
      DynamoClient | TableConfig
    >
  } = (config: any): any => makeFromConfig(config)
}

// ---------------------------------------------------------------------------
// TypedClient — mapped type for DynamoClient.make() return value
// ---------------------------------------------------------------------------

/** Minimal structural type for tables used in DynamoClient.make() config. */
export interface TableLike {
  readonly _tag: "Table"
  readonly schema: import("@effect-dynamodb/schema/DynamoSchema.js").DynamoSchema
  readonly entities: Record<string, { readonly _tag: "Entity" }>
  readonly aggregates: Record<string, unknown>
  readonly Tag: Context.Service<TableConfig, TableConfig>
}

/**
 * Collection query — returned by `db.collections.Name(composites)`.
 * `.collect()` returns the grouped result directly (not an array).
 */
export interface CollectionQuery<TResult> {
  /** Execute and collect all pages into a grouped result. */
  readonly collect: () => Effect.Effect<
    TResult,
    DynamoClientError | import("@effect-dynamodb/schema/Errors.js").ValidationError,
    never
  >
  /** Execute a single page. */
  readonly fetch: () => Effect.Effect<
    { items: TResult; cursor: string | null },
    DynamoClientError | import("@effect-dynamodb/schema/Errors.js").ValidationError,
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
 * Typed client returned by `DynamoClient.make({ entities, aggregates?, tables? })`.
 * Namespaced under `entities`, `aggregates`, `collections`, and `tables`.
 * Collections are auto-discovered from entity index `collection` properties.
 */
export type TypedClient<
  TEntities extends Record<string, { readonly _tag: "Entity" }>,
  TAggregates extends Record<string, AggregateType<any, any, any>> = Record<string, never>,
  TTables extends Record<string, TableLike> = Record<string, TableLike>,
> = {
  /**
   * Bound entities with CRUD + query accessors for each index.
   *
   * A member may be a runtime `Entity` (authored with `effect-dynamodb`'s
   * `Entity.make`) OR a pure `EntityDefinition` (authored with
   * `@effect-dynamodb/schema`'s `Entity.make` — the AWS-free contract surface).
   * Both carry the same 11 type parameters, so both map to the same bound shape,
   * and both branches forward the inferred refs `R` — the two packages now share
   * one structural `AnyRefValue` (`entity: RefEntity`), so ref-derived composite
   * types (e.g. `${field}Id`) survive into the bound client for either authoring
   * style. `make()` promotes pure definitions (and their ref targets) to runtime
   * entities at bind time, so the type and runtime agree.
   */
  readonly entities: {
    readonly [K in keyof TEntities]: TEntities[K] extends EntityType<
      infer M,
      any,
      infer I,
      infer Ts,
      infer V,
      any,
      any,
      infer R,
      any,
      infer TS,
      infer GenId,
      infer VI
    >
      ? Resolve<
          BoundEntity<M, I, R, ResolveKey<M, I>, TS, Ts, V, GenId, VI> & {
            /** Scan this entity. Returns a BoundQuery for building scan queries. */
            readonly scan: () => import("./internal/BoundQuery.js").BoundQuery<
              Schema.Schema.Type<M>,
              never,
              Schema.Schema.Type<M>
            >
          } & EntityIndexAccessors<M, I, R> &
            EntityVectorAccessors<M, VI>
        >
      : TEntities[K] extends EntityDefinition<
            infer M,
            any,
            infer I,
            infer Ts,
            infer V,
            any,
            any,
            infer R,
            any,
            infer TS,
            infer GenId,
            infer VI
          >
        ? Resolve<
            BoundEntity<M, I, R, ResolveKey<M, I>, TS, Ts, V, GenId, VI> & {
              /** Scan this entity. Returns a BoundQuery for building scan queries. */
              readonly scan: () => import("./internal/BoundQuery.js").BoundQuery<
                Schema.Schema.Type<M>,
                never,
                Schema.Schema.Type<M>
              >
            } & EntityIndexAccessors<M, I, R> &
              EntityVectorAccessors<M, VI>
          >
        : never
  }

  /** Bound aggregates with CRUD + list operations (R = never). */
  readonly aggregates: {
    readonly [K in keyof TAggregates]: TAggregates[K] extends AggregateType<
      infer S,
      infer TKey,
      infer TInput
    >
      ? BoundAggregate<S, TKey, TInput>
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

/** Force TypeScript to resolve an interface/intersection into a plain object for clean hover display */
type Resolve<T> = { [K in keyof T]: T[K] }

/** Resolve EntityKeyType into a plain object type for clean hover display.
 * Uses conditional type to force eager evaluation by TypeScript. */
type ResolveKey<M extends Schema.Top, I> =
  EntityKeyType<M, I> extends infer K ? { [P in keyof K]: K[P] } : never

/** Force eager resolution of remaining SK fields for clean hover display. */
type ResolveSkFields<M extends Schema.Top, I, K extends keyof I, Provided, R = undefined> =
  Omit<IndexSkFields<M, I, K, R>, keyof Provided> extends infer SK
    ? { readonly [P in keyof SK]: SK[P] }
    : never

/** Compute entity query accessors for each index — including `primary`.
 * Generic over provided input — `.where()` only exposes SK composites NOT already provided.
 * `R` (refs) lets ref-derived composite names (e.g. `playerId`) resolve to their
 * branded identifier types instead of being silently dropped. */
type EntityIndexAccessors<
  M extends Schema.Top,
  I extends Record<string, IndexDefinition>,
  R = undefined,
> = {
  readonly [K in keyof I & string]: <Provided extends IndexPkInput<M, I, K, R>>(
    composites: Provided,
  ) => import("./internal/BoundQuery.js").BoundQuery<
    Schema.Schema.Type<M>,
    ResolveSkFields<M, I, K, Provided, R>,
    Schema.Schema.Type<M>
  >
}

/**
 * Partition composites a vector index accessor requires.
 *
 * Resolves to `never` when the index declares no `partition` — which is exactly
 * what makes `.partition()` disappear (and the terminals appear immediately) in
 * {@link BoundVectorQuery}. Same shape as the "PK composites required" rule on
 * index query accessors.
 */
type VectorPartitionInput<M extends Schema.Top, C> = C extends {
  readonly partition: ReadonlyArray<infer K>
}
  ? [K] extends [never]
    ? never
    : { readonly [P in K & keyof Schema.Schema.Type<M>]: Schema.Schema.Type<M>[P] }
  : never

/**
 * The `INLINE_FILTER` attributes a vector index declares, as a string union.
 *
 * Resolves to `never` for an index with no `filters`, which makes `.filter()`
 * accept only `{}` — matching DynamoDB, where an undeclared filter attribute is
 * a `ValidationException` rather than a slower query.
 */
type VectorFilterNames<C> = C extends { readonly filters: ReadonlyArray<infer K extends string> }
  ? K
  : never

/**
 * Vector search accessors injected for each declared vector index, plus the
 * `reembed` maintenance operation. Empty when the entity declares none — so a
 * consumer never sees vector API surface on an entity that has no vectors.
 */
type EntityVectorAccessors<M extends Schema.Top, VI> =
  VI extends Record<string, VectorIndexConfig>
    ? {
        readonly [K in keyof VI & string]: (
          query: string | ReadonlyArray<number>,
        ) => BoundVectorQuery<
          Schema.Schema.Type<M>,
          VectorPartitionInput<M, VI[K]>,
          VectorFilterNames<VI[K]>,
          Schema.Schema.Type<M>
        >
      } & {
        /**
         * Re-derive and rewrite every stored embedding for this entity.
         *
         * DynamoDB never recomputes a vector — this is the migration path when the
         * embedding model or the declared `source.fields` change. Returns the
         * number of items whose vector was rewritten.
         */
        readonly reembed: (options?: {
          readonly concurrency?: number | undefined
        }) => Effect.Effect<
          number,
          | DynamoClientError
          | import("@effect-dynamodb/schema/Errors.js").ValidationError
          | import("@effect-dynamodb/schema/Errors.js").EmbeddingError,
          never
        >
      }
    : {}

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

  // --- Vector indexes ---

  /**
   * Add a declared vector index to an existing table via `UpdateTable`.
   * `indexName` is the physical index name declared on a registered entity.
   *
   * The index backfills asynchronously; `searchVectors` fails until it is
   * ACTIVE, so follow this with {@link waitForVectorIndex}.
   */
  readonly addVectorIndex: (indexName: string) => Effect.Effect<void, DynamoClientError>

  /** Remove a vector index from the table via `UpdateTable`. */
  readonly removeVectorIndex: (indexName: string) => Effect.Effect<void, DynamoClientError>

  /**
   * Poll `DescribeTable` until the named vector index reports `ACTIVE` with
   * `Backfilling: false`.
   *
   * Returns once the index is searchable, or fails with `ResourceNotFoundError`
   * if the index never appears within the timeout. DynamoDB Local never reports
   * vector indexes at all, so this resolves immediately there.
   */
  readonly waitForVectorIndex: (
    indexName: string,
    options?: {
      readonly pollInterval?: Duration.Input | undefined
      readonly timeout?: Duration.Input | undefined
    },
  ) => Effect.Effect<void, DynamoClientError>
}

// ---------------------------------------------------------------------------
// makeFromConfig — entity-centric make implementation
// ---------------------------------------------------------------------------

/**
 * Accessor names the bound entity owns outright. A vector index logical name
 * that lands on one of these would take the corresponding feature offline.
 */
const RESERVED_ACCESSOR_NAMES: ReadonlySet<string> = new Set(["scan", "reembed"])

/** @internal Structural entity type for runtime access. */
interface EntityLike {
  readonly _tag: "Entity"
  readonly entityType: string
  readonly model: Schema.Top
  readonly indexes: Record<string, IndexDefinition>
  readonly _vectorIndexes?: Record<string, VectorIndexDefinition> | undefined
  /** Domain field name → stored DynamoDB attribute name (`storedAs` renames). */
  readonly _resolveDbName?: ((domainName: string) => string) | undefined
  readonly _schema: DynamoSchema.DynamoSchema
  readonly _tableTag: Context.Service<TableConfig, TableConfig>
  readonly _injectIndex: (name: string, def: IndexDefinition) => void
  readonly _decodeRecord: (raw: Record<string, unknown>) => Effect.Effect<any, any>
  readonly schemas: {
    readonly recordSchema: Schema.Codec<any>
    /** The schema `put` encodes through — the source of truth for composite
     * encoding on the read path. Optional so pure schema-package definitions
     * promoted at bind time still satisfy the shape. */
    readonly inputSchema?: Schema.Top | undefined
  }
}

const makeFromConfig = (config: {
  readonly entities: Record<string, EntityType>
  readonly aggregates?: Record<string, AggregateType<any, any, any>>
  readonly tables?: Record<string, TableLike>
  readonly crypto?: Crypto.Crypto
  readonly embedder?: EmbedderService
}): Effect.Effect<any, never, DynamoClient | TableConfig> =>
  Effect.gen(function* () {
    // 1. Resolve the provide function from context.
    //
    // Bundle a `Crypto` service into the captured context so that bound entity
    // operations (auto-generated UUID primary keys via `generatedId`) resolve a
    // cryptographically-secure source WITHOUT widening the public `R` of bound
    // methods — bound `put` stays `R = never`. A caller-supplied `crypto`
    // override (e.g. `@effect/platform-node`) takes precedence over the default
    // `globalThis.crypto`-backed wrapper. The `provide` helper is widened to
    // admit `Crypto.Crypto`. See `DESIGN.md` for the `R = never` rationale.
    const baseCtx = yield* Effect.context<DynamoClient | TableConfig>()
    const cryptoService = config.crypto ?? makeDefaultCrypto()
    const withCrypto = Context.add(baseCtx, Crypto.Crypto, cryptoService)
    // Bundle the Embedder the same way, so entities with `vectorIndexes` keep
    // `R = never` on their bound operations. An explicit `embedder` wins; an
    // ambient one already in context is honoured; otherwise nothing is added
    // and the write path fails with a pointed `EmbeddingError` naming the index
    // (rather than forcing the service on every consumer's type).
    const ambientEmbedder = Context.getOption(baseCtx, Embedder)
    const embedderService =
      config.embedder ?? (Option.isSome(ambientEmbedder) ? ambientEmbedder.value : undefined)
    const ctx =
      embedderService !== undefined
        ? Context.add(withCrypto, Embedder, embedderService)
        : withCrypto
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DynamoClient | TableConfig | Crypto.Crypto>,
    ): Effect.Effect<A, E, never> => Effect.provide(effect, ctx)

    // Dimension agreement between the Embedder and every bound vector index is
    // a construction-time invariant — a mismatch would otherwise surface as a
    // per-write failure long after wiring. See `DESIGN.md §14`.
    if (embedderService !== undefined) {
      for (const [entityKey, rawEntity] of Object.entries(config.entities)) {
        const declared = (rawEntity as unknown as EntityLike)._vectorIndexes
        if (!declared) continue
        for (const [logicalName, definition] of Object.entries(declared)) {
          if (definition.dimensions === embedderService.dimensions) continue
          throw new Error(
            `[EDD-9037] Entity "${entityKey}" vector index "${logicalName}" declares ` +
              `${definition.dimensions} dimensions, but the provided Embedder produces ` +
              `${embedderService.dimensions}. Dimensions are immutable on a DynamoDB vector index — ` +
              `align the index declaration with the embedding model.`,
          )
        }
      }
    }

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
      // Key composition runs on the ENCODED record on the write path
      // (`Entity.put` encodes, then composes), while accessors and `.where()`
      // hand us DECODED model values. Put both on one pipeline by encoding the
      // composites here — otherwise a transformed composite (e.g.
      // `Schema.BigIntFromString`) composes a different string from the one
      // that was stored, and the query silently matches nothing.
      // Source: `inputSchema`, the EXACT schema `put` encodes through before
      // composing keys. The raw model is not equivalent — entity derivation
      // substitutes date/Redacted fields with their wire transforms.
      const encoderSource = entityLike.schemas.inputSchema ?? entityLike.model
      const encodeComposite = makeCompositeEncoder(encoderSource, (attr, value) => {
        throw new Error(
          `[EDD-9050] Composite "${attr}" on index "${_indexName}" of entity ` +
            `"${entityLike.entityType}" could not be encoded to its stored form. The ` +
            `attribute's schema carries an encoding transformation, so the stored key holds ` +
            `the ENCODED value, but ${JSON.stringify(String(value))} encodes under neither ` +
            `encode nor decode->encode. Supply a value of the attribute's own type.`,
        )
      })

      return (rawComposites: Record<string, unknown>) => {
        validateQueryComposites(_indexName, indexDef, rawComposites)
        const composites = encodeCompositeRecord(encodeComposite, rawComposites)
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

        // Apply SK prefix from provided composites.
        // `composeSortKeyBeginsWith`, not `composeSortKeyPrefix` — the operand
        // must terminate on a segment boundary when composites remain, or it
        // matches sibling values that merely start with the supplied one
        // (`status_done` also matching `status_done_archived`, issue #115).
        const hasSkComposites = indexDef.sk.composite.some(
          (attr: string) => composites[attr] !== undefined,
        )
        const finalQuery = hasSkComposites
          ? Query.where(query, {
              beginsWith: KeyComposer.composeSortKeyBeginsWith(
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

        // composeSkCondition — compose the user's `.where()` operand into a full
        // sort key value the same way `put` composes the stored one.
        //
        // A stored SK is `$schema#v1#entity#<name>_<cased value>#...`; comparing
        // a raw operand against that is meaningless (issue #101 — `gte` matched
        // the whole partition because `"1-009" < "ballkey_…"`, while
        // `begins_with` / `between` matched nothing). So the operand is placed
        // in the *position* of the SK composite it targets and run through the
        // same composer, which applies `serializeValue`, the `<name>_` prefix
        // and the schema casing.
        const skComposites = indexDef.sk.composite
        const composeSkCondition = (
          condition: RawSortKeyCondition,
          field: string | undefined,
        ): Query.SortKeyCondition => {
          if (skComposites.length === 0) {
            throw new Error(
              `[EDD-9045] Index "${_indexName}" has no sort key composites, so there is ` +
                `nothing for .where() to constrain. Remove the .where() call, or add sort ` +
                `key composites to the index definition.`,
            )
          }

          // Resolve the targeted composite. `.where((t) => ...)` hands back the
          // composite name via the sk accessor; fall back to the first composite
          // the accessor call did not already pin.
          const firstUnpinned = (() => {
            const i = skComposites.findIndex((attr: string) => composites[attr] === undefined)
            return i === -1 ? skComposites.length - 1 : i
          })()
          const targetIndex =
            field !== undefined && skComposites.includes(field)
              ? skComposites.indexOf(field)
              : firstUnpinned
          const targetAttr = skComposites[targetIndex]!

          // Every composite to the left of the target must already be pinned by
          // the accessor — otherwise the composed operand would have a hole and
          // silently compare against the wrong prefix.
          const missing = skComposites
            .slice(0, targetIndex)
            .filter((attr: string) => composites[attr] === undefined)
          if (missing.length > 0) {
            throw new Error(
              `[EDD-9004] Sort key condition on "${targetAttr}" for index "${_indexName}" ` +
                `requires prior composites: ${missing.join(", ")}. Sort key composites must ` +
                `follow prefix ordering — supply them to the accessor before calling .where().`,
            )
          }

          // Compose a sort key value with the leading pinned composites followed
          // by `<targetAttr>_<value>`. Trailing composites are excluded — the
          // condition bounds the key at the target's position.
          const pinnedRecord: Record<string, unknown> = {}
          for (let i = 0; i < targetIndex; i++) {
            pinnedRecord[skComposites[i]!] = composites[skComposites[i]!]
          }
          // Encode the operand exactly as the accessor composites (and the
          // write path) are encoded, so both sides of the comparison come out
          // of one pipeline.
          const operand = (value: unknown): unknown => encodeComposite(targetAttr, value)
          const compose = (value: unknown): string =>
            KeyComposer.composeSortKeyPrefix(
              entityLike._schema,
              entityLike.entityType,
              1,
              indexDef,
              {
                ...pinnedRecord,
                [targetAttr]: operand(value),
              },
            )

          const isLastComposite = targetIndex === skComposites.length - 1

          /**
           * `begins_with` operand matching exactly the keys whose target
           * composite equals `value`. Delegates the delimiter rule (#115) to
           * `composeSortKeyBeginsWith` — one rule, shared with the accessor's
           * own prefix — so it stops on a segment boundary rather than leaking
           * into sibling values (`status_done` vs `status_done_archived`).
           */
          const subtreeBeginsWith = (value: unknown): string =>
            KeyComposer.composeSortKeyBeginsWith(
              entityLike._schema,
              entityLike.entityType,
              1,
              indexDef,
              { ...pinnedRecord, [targetAttr]: operand(value) },
            )

          /**
           * A bound sorting strictly above every key whose target composite is
           * `value`, and strictly below the first key of any greater value.
           *
           * Unlike `subtreeBeginsWith` the delimiter here is UNCONDITIONAL,
           * including on the last composite: `compose(v)￿` alone would sort
           * below `compose(v + "0")`, which is a strictly greater value that
           * must stay inside a `gt`. `compose(v)#￿` sits above `compose(v)` and
           * below every longer value because `#` is lower than every character
           * the composer emits for a value segment.
           */
          const aboveSubtree = (value: unknown): string =>
            `${compose(value)}${DynamoSchema.KEY_DELIMITER}${SK_MAX_SENTINEL}`

          /** Inclusive upper bound covering the whole subtree of `value`. */
          const upper = (value: unknown): string =>
            isLastComposite ? compose(value) : aboveSubtree(value)

          // `beginsWith` / `between` / `eq` already carry the pinned composites
          // in BOTH operands, so they never escape the pinned prefix.
          if ("beginsWith" in condition) return { beginsWith: compose(condition.beginsWith) }
          if ("eq" in condition) {
            return isLastComposite
              ? { eq: compose(condition.eq) }
              : { beginsWith: subtreeBeginsWith(condition.eq) }
          }
          if ("between" in condition) {
            return { between: [compose(condition.between[0]), upper(condition.between[1])] }
          }

          // One-sided operators are open on the other side. With no pinned
          // composites that is exactly right — the open end runs to the edge of
          // the partition. But once the accessor has pinned leading composites,
          // DynamoDB's single sort key condition must ALSO stay inside that
          // prefix, so the open end is clamped and the condition becomes a
          // BETWEEN. (`Query.where` replaces the accessor's own `begins_with`,
          // so it cannot do the clamping.)
          if (targetIndex === 0) {
            if ("lt" in condition) return { lt: compose(condition.lt) }
            if ("lte" in condition) return { lte: upper(condition.lte) }
            // `>` is already exclusive of the composed value, so only a
            // non-terminal target needs the subtree pushed past.
            if ("gt" in condition) {
              return { gt: isLastComposite ? compose(condition.gt) : aboveSubtree(condition.gt) }
            }
            if ("gte" in condition) return { gte: compose(condition.gte) }
            return condition
          }

          // The pinned composites are a strict prefix by construction (the
          // target composite follows them), so the shared delimiter rule always
          // terminates this bound on a segment boundary.
          const pinnedPrefix = KeyComposer.composeSortKeyBeginsWith(
            entityLike._schema,
            entityLike.entityType,
            1,
            indexDef,
            pinnedRecord,
          )
          const pinnedMax = `${pinnedPrefix}${SK_MAX_SENTINEL}`
          if ("gte" in condition) return { between: [compose(condition.gte), pinnedMax] }
          if ("gt" in condition) return { between: [aboveSubtree(condition.gt), pinnedMax] }
          if ("lte" in condition) return { between: [pinnedPrefix, upper(condition.lte)] }
          if ("lt" in condition) {
            // On a non-terminal composite no stored key can equal the composed
            // bound (trailing composites always follow), so BETWEEN's inclusive
            // high end is harmless. On the LAST composite the bound IS a
            // storable key, and DynamoDB has neither a half-open BETWEEN nor a
            // FilterExpression that may reference a key attribute — so there is
            // no way to say `begins_with(prefix) AND sk < value` in one key
            // condition. Refuse rather than silently return the boundary item.
            if (!isLastComposite) return { between: [pinnedPrefix, compose(condition.lt)] }
            throw new Error(
              `[EDD-9046] A strict "lt" condition on sort key composite "${targetAttr}" for ` +
                `index "${_indexName}" cannot be expressed once earlier composites ` +
                `(${skComposites.slice(0, targetIndex).join(", ")}) are pinned by the accessor: ` +
                `DynamoDB allows one sort key condition, BETWEEN is inclusive at both ends, and ` +
                `a FilterExpression may not reference a key attribute. Use ` +
                `.where((t, { between }) => between(t.${targetAttr}, low, high)) or "lte" instead.`,
            )
          }
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

    for (const [key, rawEntity] of Object.entries(config.entities)) {
      // A member may be a pure `@effect-dynamodb/schema` EntityDefinition (the
      // headline output of the schema/runtime split) rather than a runtime
      // Entity. Pure definitions carry no operations or `_decodeRecord`, so
      // binding one directly would crash at call time. Promote it to a full
      // runtime Entity (a thin op-attach over its retained `_data`) so the bound
      // CRUD, query accessors, and collection decode all work. Runtime-authored
      // entities already carry `.get` and pass through untouched.
      const entity =
        typeof (rawEntity as { get?: unknown }).get === "function"
          ? rawEntity
          : entityFromDefinition(rawEntity as unknown as EntityDefinition)
      // Provide the resolved Crypto service into the bind so the bound `put`
      // (which yields `Crypto.Crypto` when `generatedId` is configured) resolves
      // it from context — keeping the bound method at `R = never`. `bind`
      // respects an already-present Crypto and only fills its own default when
      // absent, so this override is honored.
      const bound = yield* Effect.provideService(
        entityBind(entity as EntityType),
        Crypto.Crypto,
        cryptoService,
      )
      const entityLike = entity as unknown as EntityLike
      const accessors: Record<string, unknown> = {}

      // Add query accessor for each index — including `primary`.
      for (const [indexName, indexDef] of Object.entries(entityLike.indexes)) {
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

      // Vector search accessors — one per declared vector index.
      for (const [logicalName, definition] of Object.entries(entityLike._vectorIndexes ?? {})) {
        // Accessors share one namespace on the bound entity. A vector index
        // named after an existing index accessor (or `scan` / `reembed`) would
        // silently replace it and take the other feature offline, so make the
        // collision a construction-time failure instead.
        if (logicalName in accessors || RESERVED_ACCESSOR_NAMES.has(logicalName)) {
          throw new Error(
            `[EDD-9038] Entity "${key}": vector index "${logicalName}" collides with an existing ` +
              `accessor of the same name. Vector index names share a namespace with GSI query ` +
              `accessors, \`scan\` and \`reembed\` — rename one of them.`,
          )
        }
        const vqConfig: BoundVectorQueryConfig = {
          entityType: entityLike.entityType,
          logicalName,
          definition,
          schema: entityLike._schema,
          tableTag: entityLike._tableTag,
          decode: (raw) => entityLike._decodeRecord(raw),
          provide,
          resolveDbName: entityLike._resolveDbName ?? ((domainName: string) => domainName),
        }
        accessors[logicalName] = (query: string | ReadonlyArray<number>) =>
          makeBoundVectorQuery(vqConfig, query)
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
        //
        // For sub-collections (collection: ["parent", "child"]), the SK prefix
        // includes the full hierarchy from root up to and including the queried
        // collection name. A query at the parent level matches every descendant.
        if (indexDef.sk.field && indexDef.type === "clustered") {
          const coll = indexDef.collection
          const hierarchy = Array.isArray(coll)
            ? coll.slice(0, coll.indexOf(collName) + 1)
            : [collName]
          const casing = indexDef.casing ?? firstMember.entityLike._schema.casing
          const pre = DynamoSchema.prefix(firstMember.entityLike._schema)
          const casedNames = hierarchy.map((n) => DynamoSchema.applyCasing(n, casing))
          const skPrefix = `${pre}#${casedNames.join("#")}`
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

    // 4. Bind aggregates
    const boundAggregates: Record<string, unknown> = {}
    if (config.aggregates) {
      for (const [key, aggregate] of Object.entries(config.aggregates)) {
        boundAggregates[key] = yield* aggregateBind(aggregate)
      }
    }

    // 5. Build table operations
    const client = yield* DynamoClient
    const tables: Record<string, TableOperations> = {}

    if (config.tables) {
      for (const [tableKey, table] of Object.entries(config.tables)) {
        const tableConfig = yield* table.Tag
        // Merge any runtime-registered aggregates from `config.aggregates` whose
        // `_tableTag` matches this table's tag. Users may intentionally omit
        // aggregates from `Table.make({ aggregates })` to sidestep the multi-file
        // circular-import problem, registering them on `DynamoClient.make` instead.
        // Without this merge, `tableDefinition()` would never see those aggregates
        // and `db.tables.*.create()` would silently drop their (L|G)SIs.
        let mergedTable = table as unknown as Table
        if (config.aggregates) {
          const tableTagKey = table.Tag.key
          const existingAggs = table.aggregates as Record<string, unknown>
          const existingAggSet = new Set(Object.values(existingAggs))
          const extraAggregateEntries: Array<[string, unknown]> = []
          for (const [aggKey, agg] of Object.entries(config.aggregates)) {
            const aggTag = (agg as unknown as { _tableTag?: EntityLike["_tableTag"] })._tableTag
            if (aggTag === undefined) continue
            if (aggTag.key !== tableTagKey) continue
            // Skip if this aggregate is already registered on the table object
            // (reference equality) so we don't emit duplicate LSI/GSI entries.
            if (existingAggSet.has(agg)) continue
            extraAggregateEntries.push([aggKey, agg])
          }
          if (extraAggregateEntries.length > 0) {
            mergedTable = {
              ...(table as unknown as Table),
              aggregates: {
                ...existingAggs,
                ...Object.fromEntries(extraAggregateEntries),
              },
            } as unknown as Table
          }
        }
        tables[tableKey] = buildTableOperationsFromTable(tableConfig.name, mergedTable, client)
      }
    } else {
      // Group entities by table tag so we can derive full table schema for create().
      // Aggregates are also assigned to a table tag via their underlying entities;
      // we collect them here so create() includes their GSIs.
      const entitiesByTag = new Map<
        string,
        {
          tag: EntityLike["_tableTag"]
          entities: EntityLike[]
          aggregates: AggregateType<any, any, any>[]
        }
      >()
      for (const [, entity] of Object.entries(config.entities)) {
        const entityLike = entity as unknown as EntityLike
        const tagId = entityLike._tableTag.key
        if (!entitiesByTag.has(tagId)) {
          entitiesByTag.set(tagId, { tag: entityLike._tableTag, entities: [], aggregates: [] })
        }
        entitiesByTag.get(tagId)!.entities.push(entityLike)
      }
      // Attach aggregates to whichever table tag matches their root entity tag.
      // (Aggregates expose `_tableTag` from their root entity registration.)
      if (config.aggregates) {
        for (const [, agg] of Object.entries(config.aggregates)) {
          const aggTag = (agg as unknown as { _tableTag?: EntityLike["_tableTag"] })._tableTag
          if (aggTag && entitiesByTag.has(aggTag.key)) {
            entitiesByTag.get(aggTag.key)!.aggregates.push(agg)
          }
        }
      }
      for (const [
        ,
        { tag, entities: tableEntities, aggregates: tableAggregates },
      ] of entitiesByTag) {
        const tableConfig = yield* tag
        // Build a minimal Table-like object so tableDefinition() can derive GSIs
        // (entities + aggregates).
        const syntheticTable = {
          entities: Object.fromEntries(tableEntities.map((e) => [e.entityType, e])),
          aggregates: Object.fromEntries(
            tableAggregates.map((a, i) => [
              (a as { name?: string }).name ?? `__aggregate_${i}__`,
              a,
            ]),
          ),
        } as unknown as Table
        tables[tableConfig.name] = buildTableOperationsFromTable(
          tableConfig.name,
          syntheticTable,
          client,
        )
      }
    }

    return {
      entities: boundEntities,
      aggregates: boundAggregates,
      collections: boundCollections,
      tables,
    } as any
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
const idempotentCreate = (
  effect: Effect.Effect<void, DynamoClientError>,
): Effect.Effect<void, DynamoClientError> =>
  Effect.catchIf(effect, isResourceInUse, () => Effect.void)

const buildTableOperationsFromTable = (
  tableName: string,
  table: Table,
  client: DynamoClientService,
): TableOperations => {
  const def = tableDefinition(table)
  const vectorIndexes = mergeVectorIndexes(
    table.entities as unknown as Record<string, Parameters<typeof mergeVectorIndexes>[0][string]>,
  )
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
    addVectorIndex: (indexName) => {
      const entry = vectorIndexes.get(indexName)
      if (entry === undefined) {
        return Effect.fail(
          new DynamoError({
            operation: "UpdateTable",
            cause:
              `[EDD-9036] No entity registered on table "${tableName}" declares vector index ` +
              `"${indexName}". Declared: ${[...vectorIndexes.keys()].sort().join(", ") || "(none)"}`,
          }),
        )
      }
      // UpdateTable, like CreateTable, requires every SearchSchema element to
      // be declared in AttributeDefinitions (the composed HASH partition is
      // always a string; filter types were derived at Entity.make).
      const attributeDefinitions = [
        { AttributeName: entry.definition.partitionField, AttributeType: "S" as const },
        ...Object.entries(entry.filterStoredTypes).map(([AttributeName, AttributeType]) => ({
          AttributeName,
          AttributeType,
        })),
      ]
      return client
        .updateTable({
          TableName: tableName,
          AttributeDefinitions: attributeDefinitions,
          VectorIndexUpdates: [
            {
              Create: toVectorIndexSpec(entry.definition, {
                filters: entry.filters,
                resolveDbName: entry.resolveDbName,
              }),
            },
          ],
        })
        .pipe(Effect.asVoid)
    },
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
  addVectorIndex: (indexName) =>
    Effect.fail(
      new DynamoError({
        operation: "UpdateTable",
        cause:
          `[EDD-9036] Cannot add vector index "${indexName}" — this table handle was built ` +
          `without entity registrations, so no vector index declarations are available. ` +
          `Pass \`tables\` to DynamoClient.make().`,
      }),
    ),
  removeVectorIndex: (indexName) =>
    client
      .updateTable({
        TableName: tableName,
        VectorIndexUpdates: [{ Delete: { IndexName: indexName } }],
      })
      .pipe(Effect.asVoid),
  waitForVectorIndex: (indexName, options) =>
    waitForVectorIndexReady(tableName, indexName, client, options),
})

/** Default poll interval while waiting for a vector index to finish backfilling. */
const VECTOR_INDEX_POLL_INTERVAL = Duration.seconds(2)
/** Default overall timeout while waiting for a vector index to finish backfilling. */
const VECTOR_INDEX_TIMEOUT = Duration.minutes(10)

/**
 * @internal Poll `DescribeTable` until the named vector index is ACTIVE and no
 * longer backfilling.
 *
 * A vector index absent from `DescribeTable` output is treated as "nothing to
 * wait for" rather than an error: DynamoDB Local silently discards
 * `VectorIndexes` on `CreateTable`, so every local run would otherwise block
 * for the full timeout.
 */
const waitForVectorIndexReady = (
  tableName: string,
  indexName: string,
  client: DynamoClientService,
  options?: {
    readonly pollInterval?: Duration.Input | undefined
    readonly timeout?: Duration.Input | undefined
  },
): Effect.Effect<void, DynamoClientError> => {
  const pollInterval = options?.pollInterval ?? VECTOR_INDEX_POLL_INTERVAL
  const timeout = options?.timeout ?? VECTOR_INDEX_TIMEOUT
  const poll: Effect.Effect<boolean, DynamoClientError> = Effect.gen(function* () {
    const described = yield* client.describeTable({ TableName: tableName })
    const indexes = described.Table?.VectorIndexes
    if (indexes === undefined || indexes.length === 0) return true
    const found = indexes.find((i) => i.IndexName === indexName)
    if (found === undefined) return true
    return found.IndexStatus === "ACTIVE" && found.Backfilling !== true
  })
  return Effect.gen(function* () {
    while (true) {
      if (yield* poll) return
      yield* Effect.sleep(pollInterval)
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new DynamoError({
            operation: "DescribeTable",
            cause:
              `Vector index "${indexName}" on table "${tableName}" did not become ACTIVE within ` +
              `${Duration.format(Duration.fromInputUnsafe(timeout))}.`,
          }),
        ),
    }),
  )
}

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
      searchVectors: (input) =>
        Effect.tryPromise({
          try: () => client.send(new SearchVectorsCommand(input)),
          catch: classifyError("SearchVectors"),
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
