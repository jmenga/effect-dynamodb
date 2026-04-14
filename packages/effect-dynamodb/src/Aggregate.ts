/**
 * Aggregate — Graph-based composite domain model for DynamoDB.
 *
 * An Aggregate binds a Schema.Class hierarchy to a graph of underlying entities
 * sharing a partition key. The read path queries the collection, discriminates
 * items by entity type + discriminators, and assembles them leaves-to-root into
 * a Schema.Class instance.
 *
 * Created via {@link make}. Sub-aggregates compose recursively via `.with()`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Effect, type Optic, Schema, SchemaAST, type Context } from "effect"
import * as Batch from "./Batch.js"
import { DynamoClient, type DynamoClientError, type DynamoClientService } from "./DynamoClient.js"
import type { DynamoEncoding } from "./DynamoModel.js"
import * as DynamoModel from "./DynamoModel.js"
import type * as DynamoSchemaModule from "./DynamoSchema.js"
import { composeCollectionKey, composeKey } from "./DynamoSchema.js"
import type { EntityGet } from "./Entity.js"
import {
  AggregateAssemblyError,
  type AggregateDecompositionError,
  AggregateTransactionOverflow,
  type ItemNotFound,
  RefNotFound,
  TransactionCancelled,
  ValidationError,
} from "./Errors.js"
import * as KeyComposer from "./KeyComposer.js"
import {
  deserializeDateFromDynamo,
  fromAttributeMap,
  serializeDateForDynamo,
  toAttributeMap,
  toAttributeValue,
} from "./Marshaller.js"
import type { Table, TableConfig } from "./Table.js"

export type { Cursor, DiscriminatorConfig, UpdateContext } from "./internal/AggregateCursor.js"
// Internal modules (decomposed from Aggregate.ts)
export {
  type AggregateEdge,
  isManyEdge,
  isOneEdge,
  isRefEdge,
  type ManyEdge,
  type ManyEdgeConfig,
  many,
  type OneEdge,
  one,
  type RefEdge,
  type RefEntity,
  ref,
} from "./internal/AggregateEdges.js"
export {
  type DerivedAggregateSchemas,
  deriveAggregateSchemas,
  deriveElementInputSchema,
  deriveEntityFieldName,
  extractArrayElement,
  getSchemaFields,
  isFieldOptional,
  isSchemaMatchingEntity,
  unwrapModel,
} from "./internal/AggregateSchemas.js"
export type {
  AggregateInputType,
  BoundSubAggregate,
  Input,
  Key,
  SubAggregate,
  Type,
  UpdateFn,
} from "./internal/AggregateTypes.js"

import {
  type DiscriminatorConfig,
  makeCursor,
  type UpdateContext,
} from "./internal/AggregateCursor.js"
import type { AggregateEdge, RefEntity } from "./internal/AggregateEdges.js"
import { deriveAggregateSchemas, deriveEntityFieldName } from "./internal/AggregateSchemas.js"
import type {
  AggregateInputType,
  BoundSubAggregate,
  SubAggregate,
} from "./internal/AggregateTypes.js"

// ---------------------------------------------------------------------------
// TypeId
// ---------------------------------------------------------------------------

export const TypeId: unique symbol = Symbol.for("effect-dynamodb/Aggregate")
export type TypeId = typeof TypeId

// ---------------------------------------------------------------------------
// Internal: Resolved graph node
// ---------------------------------------------------------------------------

interface ResolvedNode {
  readonly fieldName: string | null // null for root
  readonly entityType: string
  readonly cardinality: "root" | "one" | "many"
  readonly discriminator?: Record<string, unknown> | undefined
  readonly ownDiscriminator?: Record<string, unknown> | undefined
  readonly children: ReadonlyArray<ResolvedNode>
  readonly assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  readonly decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined
}

// ---------------------------------------------------------------------------
// List pagination types
// ---------------------------------------------------------------------------

/** Options for paginated list queries */
export interface ListOptions {
  /** Maximum number of root items (aggregates) to return */
  readonly limit?: number | undefined
  /** Opaque cursor from a previous list call to resume pagination */
  readonly cursor?: string | undefined
}

/** Result of a paginated list query */
export interface ListResult<T> {
  /** The assembled aggregates for this page */
  readonly data: Array<T>
  /** Opaque cursor for the next page, or null if no more results */
  readonly cursor: string | null
}

// ---------------------------------------------------------------------------
// Aggregate interface
// ---------------------------------------------------------------------------

/** Error union for aggregate write operations */
type AggregateWriteError =
  | AggregateAssemblyError
  | AggregateDecompositionError
  | AggregateTransactionOverflow
  | DynamoClientError
  | ValidationError
  | RefNotFound
  | ItemNotFound
  | TransactionCancelled

/**
 * An operational aggregate — returned by `Aggregate.make` with full config.
 * Provides `get`, `create`, `update`, and `delete` for full CRUD lifecycle.
 */
export interface Aggregate<
  TSchema extends Schema.Top,
  TKey extends Record<string, unknown>,
  TInput = unknown,
> {
  readonly [TypeId]: TypeId
  readonly _tag: "Aggregate"
  readonly schema: TSchema

  /**
   * @internal Tag of the table this aggregate is bound to. Used by
   * `DynamoClient.make()` to group aggregates with their table for
   * `db.tables.X.create()` GSI derivation.
   */
  readonly _tableTag: Context.Service<TableConfig, TableConfig>

  /** Primary key field name (e.g., "pk") */
  readonly pkField: string

  /** Collection GSI config — used for assembling aggregates by partition key */
  readonly collection: {
    readonly index: string
    readonly sk: { readonly field: string }
  }

  /** List GSI config — used for listing/paginating aggregates. Undefined when not configured. */
  readonly listIndex:
    | {
        readonly index: string
        readonly pk: { readonly field: string }
        readonly sk: { readonly field: string }
      }
    | undefined

  /** Fetch and assemble the aggregate by its partition key composites */
  readonly get: (
    key: TKey,
  ) => Effect.Effect<
    Schema.Schema.Type<TSchema>,
    AggregateAssemblyError | DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /**
   * Create a new aggregate from input data.
   * Ref fields accept IDs (e.g., `venueId` instead of `venue: Venue`).
   * Refs are hydrated automatically via the `refs` config.
   * Items are written via sub-aggregate transaction groups.
   */
  readonly create: (
    input: Record<string, unknown>,
  ) => Effect.Effect<Schema.Schema.Type<TSchema>, AggregateWriteError, DynamoClient | TableConfig>

  /**
   * Update an aggregate: fetch current state, apply mutation, diff, write changes.
   * Only changed sub-aggregate transaction groups are rewritten.
   * Context field changes propagate to all member items.
   *
   * The mutation function receives an {@link UpdateContext} with:
   * - `state` — current state as a plain object
   * - `cursor` — pre-bound optic for navigating and transforming (`cursor.key("x").replace(v)`)
   * - `optic` — composable optic for use with externally-defined lenses (pass `state` explicitly)
   * - `current` — the Schema.Class instance (rarely needed)
   *
   * Return either a class instance or a plain object — the schema decode handles both.
   */
  readonly update: (
    key: TKey,
    mutationFn: (
      context: UpdateContext<TSchema["Iso"], Schema.Schema.Type<TSchema>>,
    ) => Schema.Schema.Type<TSchema> | TSchema["Iso"],
  ) => Effect.Effect<Schema.Schema.Type<TSchema>, AggregateWriteError, DynamoClient | TableConfig>

  /** Delete an aggregate — removes all items in the partition. */
  readonly delete: (
    key: TKey,
  ) => Effect.Effect<void, AggregateAssemblyError | DynamoClientError, DynamoClient | TableConfig>

  /**
   * List aggregates by querying a list collection GSI for root items and assembling each.
   *
   * Requires `list` config on the aggregate. Queries the list collection GSI using
   * filter as key composites. PK composites are required (or empty for shared
   * partition), SK composites enable prefix filtering.
   *
   * Supports cursor-based pagination via `options.limit` and `options.cursor`.
   * When `limit` is specified, returns at most that many aggregates plus a cursor
   * for the next page. Without `limit`, returns all matching aggregates.
   */
  readonly list: (
    filter?: Record<string, unknown>,
    options?: ListOptions,
  ) => Effect.Effect<
    ListResult<Schema.Schema.Type<TSchema>>,
    AggregateAssemblyError | DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /**
   * Derived input schema for `create()`.
   *
   * Automatically transforms the domain model for use as an HTTP payload:
   * - Ref fields become `${field}Id: string` (e.g., `venue: Venue` → `venueId: string`)
   * - Date fields accept ISO 8601 strings (via `Schema.toCodecJson`)
   * - PK composites (auto-generated) are omitted
   * - Sub-aggregates and many-edges are recursed
   */
  readonly inputSchema: Schema.Codec<TInput>

  /** Alias for `inputSchema` — consistent with `Entity.createSchema`. */
  readonly createSchema: Schema.Codec<TInput>

  /**
   * Derived update schema — all `inputSchema` fields made optional.
   *
   * Use as the payload schema for HTTP update endpoints. The handler
   * receives a validated partial payload and applies it inside the
   * mutation function.
   */
  readonly updateSchema: Schema.Codec<Partial<TInput>>
}

// ---------------------------------------------------------------------------
// BoundAggregate — Aggregate operations with services pre-resolved (R = never)
// ---------------------------------------------------------------------------

/**
 * An Aggregate whose operations have `DynamoClient` and `TableConfig` already
 * resolved, so all methods return `Effect<A, E, never>`.
 *
 * Created via {@link bind}. Use in service layers to avoid leaking infrastructure
 * requirements through service method signatures.
 */
export interface BoundAggregate<
  TSchema extends Schema.Top,
  TKey extends Record<string, unknown>,
  TInput = unknown,
> {
  readonly schema: TSchema

  readonly get: (
    key: TKey,
  ) => Effect.Effect<
    Schema.Schema.Type<TSchema>,
    AggregateAssemblyError | DynamoClientError | ValidationError,
    never
  >

  readonly create: (
    input: Record<string, unknown>,
  ) => Effect.Effect<Schema.Schema.Type<TSchema>, AggregateWriteError, never>

  readonly update: (
    key: TKey,
    mutationFn: (
      context: UpdateContext<TSchema["Iso"], Schema.Schema.Type<TSchema>>,
    ) => Schema.Schema.Type<TSchema> | TSchema["Iso"],
  ) => Effect.Effect<Schema.Schema.Type<TSchema>, AggregateWriteError, never>

  readonly delete: (
    key: TKey,
  ) => Effect.Effect<void, AggregateAssemblyError | DynamoClientError, never>

  readonly list: (
    filter?: Record<string, unknown>,
    options?: ListOptions,
  ) => Effect.Effect<
    ListResult<Schema.Schema.Type<TSchema>>,
    AggregateAssemblyError | DynamoClientError | ValidationError,
    never
  >

  readonly inputSchema: Schema.Codec<TInput>

  /** Alias for `inputSchema` — consistent with `Entity.createSchema`. */
  readonly createSchema: Schema.Codec<TInput>

  /** Derived update schema — all `inputSchema` fields made optional. */
  readonly updateSchema: Schema.Codec<Partial<TInput>>

  /** Eliminate DynamoClient | TableConfig from any effect using the pre-resolved context. */
  readonly provide: <A, E>(
    effect: Effect.Effect<A, E, DynamoClient | TableConfig>,
  ) => Effect.Effect<A, E, never>
}

// ---------------------------------------------------------------------------
// Aggregate.make — sub-aggregate form
// ---------------------------------------------------------------------------

interface SubAggregateConfig<
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>> = Record<
    string,
    AggregateEdge | BoundSubAggregate<any, any>
  >,
> {
  readonly root: { readonly entityType: string }
  readonly edges: TEdges
}

// ---------------------------------------------------------------------------
// Aggregate.make — top-level form
// ---------------------------------------------------------------------------

interface CollectionConfig {
  readonly index: string
  readonly name: string
  readonly sk: {
    readonly field: string
    readonly composite: ReadonlyArray<string>
  }
}

interface ListCollectionConfig extends CollectionConfig {
  readonly pk: {
    readonly field: string
    readonly composite: ReadonlyArray<string>
  }
  readonly cardinality?: number | undefined
}

interface AggregateConfig<
  _TSchema extends Schema.Top,
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>> = Record<
    string,
    AggregateEdge | BoundSubAggregate<any, any>
  >,
  TPK extends ReadonlyArray<string> = ReadonlyArray<string>,
> {
  readonly table: Table
  readonly schema: DynamoSchemaModule.DynamoSchema
  readonly pk: { readonly field: string; readonly composite: TPK }
  readonly collection: CollectionConfig
  readonly list?: ListCollectionConfig | undefined
  readonly context?: ReadonlyArray<string> | undefined
  readonly root: { readonly entityType: string }
  readonly edges: TEdges
}

// ---------------------------------------------------------------------------
// make — overloaded for sub-aggregate and top-level forms
// ---------------------------------------------------------------------------

/**
 * Create an aggregate definition.
 *
 * **Sub-aggregate form** — `Aggregate.make(Schema, { root, edges })`:
 * Returns a composable SubAggregate with `.with()` for discriminator binding.
 *
 * **Top-level form** — `Aggregate.make(Schema, { table, schema, pk, collection, ... })`:
 * Returns an operational Aggregate with `.get()` for reading.
 */
export function make<
  TSchema extends Schema.Top,
  const TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
>(
  schema: TSchema,
  config: SubAggregateConfig<TEdges> & { readonly table?: undefined },
): SubAggregate<TSchema, TEdges>
export function make<
  TSchema extends Schema.Top,
  const TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  const TPK extends ReadonlyArray<string>,
>(
  schema: TSchema,
  config: AggregateConfig<TSchema, TEdges, TPK>,
): Aggregate<
  TSchema,
  Record<string, unknown>,
  AggregateInputType<Schema.Schema.Type<TSchema>, TEdges, TPK>
>
export function make<TSchema extends Schema.Top>(
  schema: TSchema,
  config: SubAggregateConfig | AggregateConfig<TSchema>,
): SubAggregate<TSchema> | Aggregate<TSchema, Record<string, unknown>> {
  if (!("table" in config) || config.table === undefined) {
    // Sub-aggregate form
    return makeSubAggregate(schema, config as SubAggregateConfig)
  }
  // Top-level form
  return makeAggregate(schema, config as AggregateConfig<TSchema>)
}

// ---------------------------------------------------------------------------
// Sub-aggregate construction
// ---------------------------------------------------------------------------

const makeSubAggregate = <TSchema extends Schema.Top>(
  schema: TSchema,
  config: SubAggregateConfig,
): SubAggregate<TSchema> => {
  const sub: SubAggregate<TSchema> = {
    _tag: "SubAggregate",
    schema,
    root: config.root,
    edges: config.edges,
    with: (discConfig: DiscriminatorConfig) => ({
      _tag: "BoundSubAggregate",
      aggregate: sub,
      discriminator: discConfig.discriminator,
    }),
  }
  return sub
}

// ---------------------------------------------------------------------------
// Date encoding inference (handles optional wrappers)
// ---------------------------------------------------------------------------

type ASTNode = Record<string, unknown> & {
  _tag?: string
  annotations?: Record<string, unknown>
  types?: ReadonlyArray<ASTNode>
}

/**
 * Try to match a date encoding from a SchemaAST.resolve() result.
 * SchemaAST.resolve flattens annotations to the top level (typeConstructor, meta).
 */
const matchResolvedDateAST = (resolved: ASTNode): DynamoEncoding | undefined => {
  const tc = resolved.typeConstructor as { _tag?: string } | undefined
  if (tc?._tag === "effect/DateTime.Utc") return { storage: "string", domain: "DateTime.Utc" }
  if (tc?._tag === "effect/DateTime.Zoned") return { storage: "string", domain: "DateTime.Zoned" }
  if (tc?._tag === "Date") return { storage: "string", domain: "Date" }
  const meta = resolved.meta as { _tag?: string } | undefined
  if (meta?._tag === "isDateValid") return { storage: "string", domain: "Date" }
  return undefined
}

/**
 * Try to match a date encoding from a raw AST member (Union type member).
 * Raw AST nodes have annotations nested under .annotations (not flattened).
 */
const matchRawDateAST = (node: ASTNode): DynamoEncoding | undefined => {
  const ann = node.annotations as Record<string, unknown> | undefined
  if (!ann) return undefined
  const tc = ann.typeConstructor as { _tag?: string } | undefined
  if (tc?._tag === "effect/DateTime.Utc") return { storage: "string", domain: "DateTime.Utc" }
  if (tc?._tag === "effect/DateTime.Zoned") return { storage: "string", domain: "DateTime.Zoned" }
  if (tc?._tag === "Date") return { storage: "string", domain: "Date" }
  const meta = ann.meta as { _tag?: string } | undefined
  if (meta?._tag === "isDateValid") return { storage: "string", domain: "Date" }
  return undefined
}

/**
 * Infer date encoding from a schema AST, handling Schema.optional() wrappers.
 * Optional fields have Union AST with [InnerType, Undefined] — unwrap to find dates.
 */
const inferDateEncoding = (ast: Schema.Top["ast"]): DynamoEncoding | undefined => {
  // Try SchemaAST.resolve first (works for non-optional date fields)
  const resolved = SchemaAST.resolve(ast) as ASTNode | undefined
  if (resolved) {
    const direct = matchResolvedDateAST(resolved)
    if (direct) return direct
  }
  // Handle optional wrapper: Union with Undefined + inner type.
  // SchemaAST.resolve returns undefined for Union ASTs, so check the raw AST.
  const rawAst = ast as unknown as ASTNode
  if (rawAst._tag === "Union" && rawAst.types) {
    for (const member of rawAst.types) {
      if (member._tag === "Undefined") continue
      // Try SchemaAST.resolve on the inner member (e.g., Declaration for Schema.Date)
      const memberResolved = SchemaAST.resolve(member as unknown as Schema.Top["ast"]) as
        | ASTNode
        | undefined
      if (memberResolved) {
        const enc = matchResolvedDateAST(memberResolved)
        if (enc) return enc
      }
      // Fallback: check raw member annotations
      const enc = matchRawDateAST(member)
      if (enc) return enc
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Top-level aggregate construction
// ---------------------------------------------------------------------------

const makeAggregate = <TSchema extends Schema.Top>(
  schema: TSchema,
  config: AggregateConfig<TSchema>,
): Aggregate<TSchema, Record<string, unknown>> => {
  // Build resolved graph by walking edges recursively
  const rootNode = resolveNode(null, config.root.entityType, "root", config.edges)
  const aggregateName = config.root.entityType
  const contextFields = config.context ?? []

  // Detect date encodings for all root schema fields (once, at make() time).
  // Fields with Date/DateTime types need serialization before DynamoDB
  // marshalling and deserialization before Schema decode, matching Entity's
  // serializeDateFields/deserializeDateFields pattern.
  const dateEncodings: Record<string, DynamoEncoding> = {}
  const schemaFields = (schema as Record<string, unknown>).fields as
    | Record<string, Schema.Top>
    | undefined
  if (schemaFields) {
    for (const field of Object.keys(schemaFields)) {
      const fieldSchema = schemaFields[field]!
      const explicit = DynamoModel.getEncoding(fieldSchema)
      if (explicit) {
        dateEncodings[field] = explicit
      } else {
        // Infer for standard Effect date schemas (Schema.Date, DateTime, etc.)
        // For optional fields (Union with Undefined), unwrap to find the inner type.
        const inferred = inferDateEncoding(fieldSchema.ast)
        if (inferred) dateEncodings[field] = inferred
      }
    }
  }

  // Build optics at construction time (once per aggregate definition)
  const classToPlain = Schema.toIso(schema) as Optic.Iso<
    Schema.Schema.Type<TSchema>,
    TSchema["Iso"]
  >
  const opticRoot = Schema.toIsoFocus(schema) as Optic.Iso<TSchema["Iso"], TSchema["Iso"]>

  /** Shared: compose PK and query all items */
  const fetchPartition = (key: Record<string, unknown>) =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      const tableConfig: TableConfig = yield* config.table.Tag
      const composites = KeyComposer.extractComposites(config.pk.composite, key)
      const pkValue = composeCollectionKey(config.schema, config.collection.name, composites)
      const allItems = yield* queryAllItems(
        client,
        tableConfig.name,
        config.collection.index,
        config.pk.field,
        pkValue,
      )
      return { client, tableConfig, pkValue, composites, allItems }
    })

  const derivedSchemas = deriveAggregateSchemas(schema, config.edges, config.pk.composite)

  return {
    [TypeId]: TypeId,
    _tag: "Aggregate",
    _tableTag: config.table.Tag,
    schema,
    pkField: config.pk.field,
    collection: {
      index: config.collection.index,
      sk: { field: config.collection.sk.field },
    },
    listIndex: config.list
      ? {
          index: config.list.index,
          pk: { field: config.list.pk.field },
          sk: { field: config.list.sk.field },
        }
      : undefined,
    inputSchema: derivedSchemas.inputSchema as unknown as Schema.Codec<unknown>,
    createSchema: derivedSchemas.inputSchema as unknown as Schema.Codec<unknown>,
    updateSchema: derivedSchemas.updateSchema as any,

    get: (key) =>
      Effect.gen(function* () {
        const { allItems } = yield* fetchPartition(key)

        if (allItems.length === 0) {
          return yield* new AggregateAssemblyError({
            aggregate: aggregateName,
            reason: "No items found for aggregate key",
            key,
          })
        }

        const result = yield* assembleAggregate(
          schema,
          rootNode,
          allItems,
          contextFields,
          dateEncodings,
          key,
          aggregateName,
        )
        return result as Schema.Schema.Type<TSchema>
      }),

    create: (input) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const tableConfig: TableConfig = yield* config.table.Tag

        // 1. Hydrate refs from edges
        const hydrated = yield* hydrateAggregateRefs(input, config.edges, aggregateName)

        // 2. Validate via schema decode
        const decoded = yield* Schema.decodeUnknownEffect(schema as unknown as Schema.Codec<any>)(
          hydrated,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ValidationError({
                entityType: aggregateName,
                operation: "aggregate.create",
                cause,
              }),
          ),
        )

        const assembled = { ...(decoded as object) } as Record<string, unknown>

        // 3. Compose PK
        const composites = KeyComposer.extractComposites(config.pk.composite, assembled)
        const pkValue = composeCollectionKey(config.schema, config.collection.name, composites)

        // 4. Decompose into items grouped by sub-aggregate transaction boundaries
        const groups = yield* decomposeAggregate(
          assembled,
          rootNode,
          contextFields,
          dateEncodings,
          aggregateName,
        )

        // 5. Compose collection SK composites for root item
        const collectionSkComposites = KeyComposer.extractComposites(
          config.collection.sk.composite,
          assembled,
        )

        // 6. Build DynamoDB items with composed keys
        const dynamoGroups = buildDynamoItems(groups, config, pkValue, collectionSkComposites)

        // 7. Write via sub-aggregate transactions
        yield* writeTransactionGroups(client, tableConfig.name, dynamoGroups, aggregateName)

        return decoded as Schema.Schema.Type<TSchema>
      }),

    update: (key, mutationFn) =>
      Effect.gen(function* () {
        const { client, tableConfig, pkValue, allItems } = yield* fetchPartition(key)

        if (allItems.length === 0) {
          return yield* new AggregateAssemblyError({
            aggregate: aggregateName,
            reason: "No items found for aggregate key",
            key,
          })
        }

        // 1. Assemble current state
        const current = yield* assembleAggregate(
          schema,
          rootNode,
          allItems,
          contextFields,
          dateEncodings,
          key,
          aggregateName,
        )

        // 2. Apply mutation — provide optics context for composable updates
        const state = classToPlain.get(current as Schema.Schema.Type<TSchema>)
        const updated = mutationFn({
          state,
          cursor: makeCursor(state, opticRoot),
          optic: opticRoot,
          current: current as Schema.Schema.Type<TSchema>,
        })

        // 3. Validate updated state via schema decode
        const decoded = yield* Schema.decodeUnknownEffect(schema as unknown as Schema.Codec<any>)(
          updated,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ValidationError({
                entityType: aggregateName,
                operation: "aggregate.update",
                cause,
              }),
          ),
        )

        const assembledOld = { ...(current as object) } as Record<string, unknown>
        const assembledNew = { ...(decoded as object) } as Record<string, unknown>

        // 4. Decompose both old and new
        const oldGroups = yield* decomposeAggregate(
          assembledOld,
          rootNode,
          contextFields,
          dateEncodings,
          aggregateName,
        )
        const newGroups = yield* decomposeAggregate(
          assembledNew,
          rootNode,
          contextFields,
          dateEncodings,
          aggregateName,
        )

        // 5. Diff: determine which transaction groups changed
        const oldGroupMap = new Map(oldGroups.map((g) => [g.name, g]))
        const newGroupMap = new Map(newGroups.map((g) => [g.name, g]))

        // Check if context fields changed — if so, ALL groups must be rewritten
        let contextChanged = false
        for (const field of contextFields) {
          if (!deepEqual(assembledOld[field], assembledNew[field])) {
            contextChanged = true
            break
          }
        }

        const groupsToWrite: TransactionGroup[] = []
        for (const [name, newGroup] of newGroupMap) {
          if (contextChanged) {
            groupsToWrite.push(newGroup)
            continue
          }
          const oldGroup = oldGroupMap.get(name)
          if (!oldGroup || !deepEqualGroups(oldGroup, newGroup)) {
            groupsToWrite.push(newGroup)
          }
        }

        if (groupsToWrite.length > 0) {
          // 6. Compose collection SK composites
          const collectionSkComposites = KeyComposer.extractComposites(
            config.collection.sk.composite,
            assembledNew,
          )

          // 7. Build and write changed groups
          const dynamoGroups = buildDynamoItems(
            groupsToWrite,
            config,
            pkValue,
            collectionSkComposites,
          )

          yield* writeTransactionGroups(client, tableConfig.name, dynamoGroups, aggregateName)
        }

        return decoded as Schema.Schema.Type<TSchema>
      }),

    delete: (key) =>
      Effect.gen(function* () {
        const { client, tableConfig, allItems } = yield* fetchPartition(key)

        if (allItems.length === 0) {
          return yield* new AggregateAssemblyError({
            aggregate: aggregateName,
            reason: "No items found for aggregate key",
            key,
          })
        }

        yield* deleteAllItems(client, tableConfig.name, allItems, config.pk.field)
      }),

    list: (filter, options) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const tableConfig: TableConfig = yield* config.table.Tag

        if (!config.list) {
          return yield* new ValidationError({
            entityType: aggregateName,
            operation: "list",
            cause:
              "Aggregate.list() requires a `list` collection config. " +
              "Define `list: { index, name, pk, sk }` in your aggregate config.",
          })
        }

        const listConfig = config.list
        const limit = options?.limit
        const startKey = options?.cursor
          ? (JSON.parse(atob(options.cursor)) as Record<string, AttributeValue>)
          : undefined

        // Compose PK from filter values matching PK composites
        const listPkComposites = KeyComposer.extractComposites(
          listConfig.pk.composite,
          filter ?? {},
        )

        // Build SK prefix from contiguous filter values matching SK composites
        const skValues: string[] = []
        for (const attr of listConfig.sk.composite) {
          if (filter?.[attr] !== undefined) skValues.push(String(filter[attr]))
          else break // Stop at first gap (prefix matching)
        }

        let rootItems: Array<Record<string, unknown>>
        let nextKey: Record<string, AttributeValue> | undefined

        if (listConfig.cardinality) {
          // Fan out: query each shard in parallel, merge results
          // Pagination not supported for sharded lists — returns all results
          const shardQueries = Array.from({ length: listConfig.cardinality }, (_, shard) => {
            const shardPkValue = composeCollectionKey(config.schema, listConfig.name, [
              ...listPkComposites,
              String(shard),
            ])
            return queryListPartition(
              client,
              tableConfig,
              listConfig,
              config.schema,
              shardPkValue,
              skValues,
            )
          })
          const shardResults = yield* Effect.all(shardQueries)
          rootItems = shardResults.flatMap((r) => r.items)
          nextKey = undefined
        } else {
          const listPkValue = composeCollectionKey(config.schema, listConfig.name, listPkComposites)
          const result = yield* queryListPartition(
            client,
            tableConfig,
            listConfig,
            config.schema,
            listPkValue,
            skValues,
            limit,
            startKey,
          )
          rootItems = result.items
          nextKey = result.lastKey
        }

        // Extract PK composite values from each root item and assemble
        const aggregates: Array<Schema.Schema.Type<TSchema>> = []
        for (const rootItem of rootItems) {
          const key: Record<string, unknown> = {}
          for (const composite of config.pk.composite) {
            key[composite] = rootItem[composite]
          }
          const assembled = yield* Effect.gen(function* () {
            const { allItems } = yield* fetchPartition(key)
            if (allItems.length === 0) return undefined

            const result = yield* assembleAggregate(
              schema,
              rootNode,
              allItems,
              contextFields,
              dateEncodings,
              key,
              aggregateName,
            )
            return result as Schema.Schema.Type<TSchema>
          })
          if (assembled !== undefined) aggregates.push(assembled)
        }

        const cursor = nextKey ? btoa(JSON.stringify(nextKey)) : null

        return { data: aggregates, cursor }
      }),
  }
}

// ---------------------------------------------------------------------------
// Aggregate binding — resolve services, return BoundAggregate with R = never
// ---------------------------------------------------------------------------

/**
 * Bind an Aggregate to resolved `DynamoClient` and `TableConfig` services.
 * Returns a {@link BoundAggregate} where all operations have `R = never`.
 *
 * @internal Used by `DynamoClient.make()` to bind aggregates.
 */
export const bind = <TSchema extends Schema.Top, TKey extends Record<string, unknown>, TInput>(
  aggregate: Aggregate<TSchema, TKey, TInput>,
): Effect.Effect<BoundAggregate<TSchema, TKey, TInput>, never, DynamoClient | TableConfig> =>
  Effect.gen(function* () {
    const ctx = yield* Effect.context<DynamoClient | TableConfig>()
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DynamoClient | TableConfig>,
    ): Effect.Effect<A, E, never> => Effect.provide(effect, ctx)

    return {
      schema: aggregate.schema,
      get: (key: TKey) => provide(aggregate.get(key)),
      create: (input: Record<string, unknown>) => provide(aggregate.create(input)),
      update: (
        key: TKey,
        mutationFn: (
          context: UpdateContext<TSchema["Iso"], Schema.Schema.Type<TSchema>>,
        ) => Schema.Schema.Type<TSchema> | TSchema["Iso"],
      ) => provide(aggregate.update(key, mutationFn)),
      delete: (key: TKey) => provide(aggregate.delete(key)),
      list: (filter?: Record<string, unknown>, options?: ListOptions) =>
        provide(aggregate.list(filter, options)),
      inputSchema: aggregate.inputSchema,
      createSchema: aggregate.createSchema,
      updateSchema: aggregate.updateSchema,
      provide,
    } as BoundAggregate<TSchema, TKey, TInput>
  })

// ---------------------------------------------------------------------------
// Internal: Deep equality helpers for diff-based update
// ---------------------------------------------------------------------------

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return false

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (Array.isArray(a) || Array.isArray(b)) return false

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]))
}

const deepEqualGroups = (a: TransactionGroup, b: TransactionGroup): boolean => {
  if (a.items.length !== b.items.length) return false
  return a.items.every((item, i) => {
    const other = b.items[i]!
    if (item.entityType !== other.entityType) return false
    return deepEqual(item.attributes, other.attributes)
  })
}

// ---------------------------------------------------------------------------
// Internal: Resolve the graph
// ---------------------------------------------------------------------------

const resolveNode = (
  fieldName: string | null,
  entityType: string,
  cardinality: "root" | "one" | "many",
  edges: Record<string, AggregateEdge | BoundSubAggregate<any>>,
  discriminator?: Record<string, unknown>,
  assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined,
  decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined,
  ownDiscriminator?: Record<string, unknown>,
): ResolvedNode => {
  const children: Array<ResolvedNode> = []

  for (const [field, edge] of Object.entries(edges)) {
    if ("_tag" in edge) {
      if (edge._tag === "OneEdge") {
        // Merge parent discriminator with edge's own discriminator
        const mergedDisc = edge.discriminator
          ? { ...(discriminator ?? {}), ...edge.discriminator }
          : discriminator
        children.push(
          resolveNode(
            field,
            edge.entityType,
            "one",
            {},
            mergedDisc,
            undefined,
            undefined,
            edge.discriminator,
          ),
        )
      } else if (edge._tag === "ManyEdge") {
        children.push(
          resolveNode(
            field,
            edge.entityType,
            "many",
            {},
            discriminator,
            edge.assemble,
            edge.decompose,
          ),
        )
      } else if (edge._tag === "BoundSubAggregate") {
        const bound = edge as BoundSubAggregate<any>
        const subChildren = resolveNode(
          field,
          bound.aggregate.root.entityType,
          "one",
          bound.aggregate.edges,
          bound.discriminator,
          undefined,
          undefined,
          bound.discriminator,
        )
        children.push(subChildren)
      }
    }
  }

  return {
    fieldName,
    entityType,
    cardinality,
    discriminator,
    ownDiscriminator,
    children,
    assemble,
    decompose,
  }
}

// ---------------------------------------------------------------------------
// Internal: Query all items in the aggregate partition
// ---------------------------------------------------------------------------

const queryAllItems = (
  client: DynamoClientService,
  tableName: string,
  indexName: string,
  pkField: string,
  pkValue: string,
): Effect.Effect<Array<Record<string, unknown>>, DynamoClientError> =>
  Effect.gen(function* () {
    const allItems: Array<Record<string, unknown>> = []
    let exclusiveStartKey: Record<string, AttributeValue> | undefined

    // Paginate through all results
    do {
      const result = yield* client.query({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": pkField },
        ExpressionAttributeValues: { ":pk": toAttributeValue(pkValue) },
        ExclusiveStartKey: exclusiveStartKey,
      })

      if (result.Items) {
        for (const item of result.Items) {
          allItems.push(fromAttributeMap(item as Record<string, AttributeValue>))
        }
      }

      exclusiveStartKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined
    } while (exclusiveStartKey !== undefined)

    return allItems
  })

// ---------------------------------------------------------------------------
// Internal: Assembly algorithm
// ---------------------------------------------------------------------------

const assembleAggregate = (
  schema: Schema.Top,
  rootNode: ResolvedNode,
  allItems: Array<Record<string, unknown>>,
  _contextFields: ReadonlyArray<string>,
  dateEncodings: Record<string, DynamoEncoding>,
  key: Record<string, unknown>,
  aggregateName: string,
): Effect.Effect<unknown, AggregateAssemblyError | ValidationError> =>
  Effect.gen(function* () {
    // Find the root item
    const rootItems = allItems.filter((item) => item.__edd_e__ === rootNode.entityType)

    if (rootItems.length === 0) {
      return yield* new AggregateAssemblyError({
        aggregate: aggregateName,
        reason: "Missing root item",
        key,
      })
    }

    if (rootItems.length > 1) {
      return yield* new AggregateAssemblyError({
        aggregate: aggregateName,
        reason: "Multiple root items found",
        key,
      })
    }

    const rootItem = rootItems[0]!

    // Assemble edge values from the item collection
    const edgeValues: Record<string, unknown> = {}

    for (const child of rootNode.children) {
      const assembled = yield* assembleNode(child, allItems, key, aggregateName)
      if (child.fieldName !== null && assembled !== undefined) {
        edgeValues[child.fieldName] = assembled
      }
    }

    // Combine root item fields (minus DynamoDB metadata + context) with assembled edges
    const rootFields: Record<string, unknown> = {}
    const edgeFieldNames = new Set(rootNode.children.map((c) => c.fieldName).filter(Boolean))
    const metaFields = new Set([
      "__edd_e__",
      "pk",
      "sk",
      "gsi1pk",
      "gsi1sk",
      "gsi2pk",
      "gsi2sk",
      "gsi3pk",
      "gsi3sk",
      "gsi4pk",
      "gsi4sk",
      "gsi5pk",
      "gsi5sk",
      "lsi1sk",
      "lsi2sk",
    ])

    for (const [fieldKey, value] of Object.entries(rootItem)) {
      if (metaFields.has(fieldKey)) continue
      if (edgeFieldNames.has(fieldKey)) continue
      rootFields[fieldKey] = value
    }

    // Deserialize date context fields from DynamoDB storage primitives to domain values.
    // Schema.decodeUnknownEffect expects domain types (Date, DateTime), not encoded strings.
    for (const [field, encoding] of Object.entries(dateEncodings)) {
      if (field in rootFields && rootFields[field] != null) {
        rootFields[field] = deserializeDateFromDynamo(rootFields[field], encoding)
      }
    }

    // Merge root fields with assembled edge values
    const assembled = { ...rootFields, ...edgeValues }

    // Decode through the aggregate's Schema.Class
    const decoded = yield* Schema.decodeUnknownEffect(schema as unknown as Schema.Codec<any>)(
      assembled,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ValidationError({
            entityType: aggregateName,
            operation: "aggregate.assemble",
            cause,
          }),
      ),
    )

    return decoded
  })

const assembleNode = (
  node: ResolvedNode,
  allItems: Array<Record<string, unknown>>,
  key: Record<string, unknown>,
  aggregateName: string,
): Effect.Effect<unknown, AggregateAssemblyError | ValidationError> =>
  Effect.gen(function* () {
    // Find items matching this node's entity type and discriminator
    const matchingItems = allItems.filter((item) => {
      if (item.__edd_e__ !== node.entityType) return false
      // If this node has a discriminator, check that item attributes match
      if (node.discriminator) {
        for (const [attr, value] of Object.entries(node.discriminator)) {
          // Skip computed discriminators (functions) — only match on static values
          if (typeof value === "function") continue
          if (item[attr] !== value) return false
        }
      }
      return true
    })

    if (node.cardinality === "one") {
      // One-to-one: sub-aggregate root or simple one edge
      if (node.children.length > 0) {
        // Sub-aggregate — assemble recursively
        // If no matching items found, return undefined (supports optional sub-aggregates)
        if (matchingItems.length === 0) return undefined
        if (matchingItems.length > 1) {
          return yield* new AggregateAssemblyError({
            aggregate: aggregateName,
            reason: `Multiple sub-aggregate root items for "${node.fieldName}" (entityType: ${node.entityType})`,
            key,
          })
        }

        const subRootItem = matchingItems[0]!
        const edgeValues: Record<string, unknown> = {}

        for (const child of node.children) {
          // For children within a sub-aggregate, propagate the parent's discriminator
          const childNode = node.discriminator
            ? { ...child, discriminator: { ...node.discriminator, ...child.discriminator } }
            : child
          const assembled = yield* assembleNode(childNode, allItems, key, aggregateName)
          if (child.fieldName !== null && assembled !== undefined) {
            edgeValues[child.fieldName] = assembled
          }
        }

        // Build sub-aggregate result: sub-root fields + assembled edges
        const subFields: Record<string, unknown> = {}
        const edgeFieldNames = new Set(node.children.map((c) => c.fieldName).filter(Boolean))

        for (const [fieldKey, value] of Object.entries(subRootItem)) {
          // Skip DynamoDB metadata, discriminator attributes, and edge fields
          if (fieldKey === "__edd_e__") continue
          if (fieldKey.startsWith("pk") || fieldKey.startsWith("sk")) continue
          if (fieldKey.startsWith("gsi") || fieldKey.startsWith("lsi")) continue
          if (edgeFieldNames.has(fieldKey)) continue
          // Skip discriminator attributes
          if (node.discriminator && fieldKey in node.discriminator) continue
          subFields[fieldKey] = value
        }

        return { ...subFields, ...edgeValues }
      }

      // Simple one-to-one edge — if no matching items, return undefined
      // (the Schema decode will catch truly required missing fields)
      if (matchingItems.length === 0) return undefined

      // Return the item (stripped of DynamoDB metadata)
      const item = matchingItems[0]!
      return stripMetadata(item)
    }

    // Many edge: collect all matching items
    const stripped = matchingItems.map(stripMetadata)

    if (node.assemble) {
      return node.assemble(stripped)
    }

    return stripped
  })

// ---------------------------------------------------------------------------
// Internal: Strip DynamoDB metadata from items
// ---------------------------------------------------------------------------

const stripMetadata = (item: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item)) {
    if (key === "__edd_e__") continue
    if (key === "pk" || key === "sk") continue
    if (key.startsWith("gsi") || key.startsWith("lsi")) continue
    result[key] = value
  }
  return result
}

// ---------------------------------------------------------------------------
// Internal: Ref hydration (aggregate-level, edge-driven)
// ---------------------------------------------------------------------------

/** A ref request collected from walking edges */
interface RefRequest {
  readonly entity: RefEntity
  readonly id: string
  readonly path: ReadonlyArray<string>
  readonly fieldName: string
  readonly idFieldName: string
}

/**
 * Walk the input recursively following graph edges, collect ref IDs,
 * fetch referenced entities, and replace IDs with hydrated domain data.
 */
const hydrateAggregateRefs = (
  input: Record<string, unknown>,
  edges: Record<string, AggregateEdge | BoundSubAggregate<any>>,
  aggregateName: string,
): Effect.Effect<
  Record<string, unknown>,
  RefNotFound | DynamoClientError | ValidationError,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    // Collect all ref IDs from the entire input hierarchy
    const refRequests: RefRequest[] = []
    collectRefIdsFromEdges(refRequests, input, edges, [])

    if (refRequests.length === 0) return input

    // Group by entity type for efficient fetching
    const byEntityType = new Map<string, { entity: RefEntity; reqs: RefRequest[] }>()
    for (const req of refRequests) {
      const key = req.entity.entityType
      const existing = byEntityType.get(key)
      if (existing) {
        existing.reqs.push(req)
      } else {
        byEntityType.set(key, { entity: req.entity, reqs: [req] })
      }
    }

    // Batch-fetch all refs — one Batch.get call per entity type
    const hydratedLookup = new Map<string, Record<string, unknown>>()

    for (const [entityType, { entity, reqs }] of byEntityType) {
      const idField = DynamoModel.getIdentifierField(entity.model)
      const identifierName = idField?.name ?? "id"

      // Deduplicate IDs for this entity type
      const uniqueIds = [...new Set(reqs.map((r) => r.id))]

      // Build EntityGet intermediates for batch fetching
      const getOps = uniqueIds.map(
        (id) => entity.get({ [identifierName]: id }) as EntityGet<any, any, any, any>,
      )

      const results = yield* Batch.get(getOps)

      // Map results back to lookup, failing on missing refs
      for (let i = 0; i < uniqueIds.length; i++) {
        const id = uniqueIds[i]!
        const result = results[i]
        if (result == null) {
          return yield* new RefNotFound({
            entity: aggregateName,
            field: reqs.find((r) => r.id === id)?.fieldName ?? "",
            refEntity: entityType,
            refId: id,
          })
        }
        hydratedLookup.set(`${entityType}:${id}`, { ...(result as object) })
      }
    }

    // Walk the input again and replace IDs with hydrated data
    const result = replaceRefIds(input, refRequests, hydratedLookup)
    renameInputFields(result, edges)
    return result
  })

/**
 * Rename ManyEdge inputField keys back to model field names so the domain
 * schema can decode correctly. Walks edges recursively through sub-aggregates.
 */
const renameInputFields = (
  data: Record<string, unknown>,
  edges: Record<string, AggregateEdge | BoundSubAggregate<any>>,
): void => {
  for (const [edgeName, edge] of Object.entries(edges)) {
    if (!("_tag" in edge)) continue

    if (edge._tag === "ManyEdge" && edge.inputField && edge.inputField !== edgeName) {
      if (edge.inputField in data) {
        data[edgeName] = data[edge.inputField]
        delete data[edge.inputField]
      }
    } else if (edge._tag === "BoundSubAggregate") {
      const sub = data[edgeName]
      if (sub != null && typeof sub === "object") {
        renameInputFields(
          sub as Record<string, unknown>,
          (edge as BoundSubAggregate<any>).aggregate.edges,
        )
      }
    }
  }
}

/**
 * Recursively walk input following graph edges to collect ref ID references.
 * Edge-driven: entity lookup comes from the edge directly, not from a refs bag.
 */
const collectRefIdsFromEdges = (
  result: RefRequest[],
  input: Record<string, unknown>,
  edges: Record<string, AggregateEdge | BoundSubAggregate<any>>,
  path: ReadonlyArray<string>,
): void => {
  for (const [edgeName, edge] of Object.entries(edges)) {
    if (!("_tag" in edge)) continue

    if (edge._tag === "RefEdge") {
      // RefEdge → ${field}Id in input
      const idFieldName = `${edgeName}Id`
      const idValue = input[idFieldName]
      if (typeof idValue === "string") {
        result.push({
          entity: edge.entity,
          id: idValue,
          path: [...path],
          fieldName: edgeName,
          idFieldName,
        })
      }
    } else if (edge._tag === "OneEdge" && edge.entity) {
      // OneEdge with entity → ${field}Id in input
      const idFieldName = `${edgeName}Id`
      const idValue = input[idFieldName]
      if (typeof idValue === "string") {
        result.push({
          entity: edge.entity,
          id: idValue,
          path: [...path],
          fieldName: edgeName,
          idFieldName,
        })
      }
    } else if (edge._tag === "BoundSubAggregate") {
      const bound = edge as BoundSubAggregate<any>
      const subInput = input[edgeName]
      if (subInput != null && typeof subInput === "object") {
        collectRefIdsFromEdges(result, subInput as Record<string, unknown>, bound.aggregate.edges, [
          ...path,
          edgeName,
        ])
      }
    } else if (edge._tag === "ManyEdge" && edge.entity) {
      // ManyEdge with entity → walk array elements for ref IDs
      const inputKey = edge.inputField ?? edgeName
      const arr = input[inputKey]
      if (Array.isArray(arr)) {
        const entityFieldName = deriveEntityFieldName(edge.entity)
        for (let i = 0; i < arr.length; i++) {
          const elem = arr[i]
          if (typeof elem === "string") {
            // Element IS the ref ID (e.g., Array<string> for Array<Umpire>)
            result.push({
              entity: edge.entity,
              id: elem,
              path: [...path, inputKey, String(i)],
              fieldName: edgeName,
              idFieldName: String(i),
            })
          } else if (elem != null && typeof elem === "object") {
            // Element wraps entity + attributes — find the entityFieldName + "Id"
            const elemObj = elem as Record<string, unknown>
            const idFieldName = `${entityFieldName}Id`
            const idValue = elemObj[idFieldName]
            if (typeof idValue === "string") {
              result.push({
                entity: edge.entity,
                id: idValue,
                path: [...path, inputKey, String(i)],
                fieldName: entityFieldName,
                idFieldName,
              })
            }
          }
        }
      }
    }
  }
}

/**
 * Replace ref ID fields in the input with hydrated domain data.
 */
const replaceRefIds = (
  input: Record<string, unknown>,
  refRequests: ReadonlyArray<RefRequest>,
  lookup: Map<string, Record<string, unknown>>,
): Record<string, unknown> => {
  // Deep clone the input for mutation
  const result = structuredClone(input) as Record<string, unknown>

  for (const req of refRequests) {
    const lookupKey = `${req.entity.entityType}:${req.id}`
    const data = lookup.get(lookupKey)
    if (!data) continue

    // Navigate to the target location in the result
    let target: Record<string, unknown> = result
    for (const segment of req.path) {
      const next = target[segment]
      if (next == null || typeof next !== "object") break
      target = next as Record<string, unknown>
    }

    // For ManyEdge elements that are direct IDs (element IS the ref),
    // the target is the array itself — replace the element at the index
    if (Array.isArray(target) && /^\d+$/.test(req.idFieldName)) {
      target[Number(req.idFieldName)] = data
    } else {
      // Replace: remove ${field}Id, add ${field}: data
      delete target[req.idFieldName]
      target[req.fieldName] = data
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Internal: Decomposition (write path)
// ---------------------------------------------------------------------------

/** A single DynamoDB item produced by decomposition */
interface DecomposedItem {
  readonly entityType: string
  readonly attributes: Record<string, unknown>
  readonly transactionGroup: string
  readonly skComposites: ReadonlyArray<string>
}

/** A group of items to write in a single transaction */
interface TransactionGroup {
  readonly name: string
  readonly items: ReadonlyArray<DecomposedItem>
}

/**
 * Decompose an assembled domain object into DynamoDB items grouped by
 * sub-aggregate transaction boundaries.
 */
const decomposeAggregate = (
  assembled: Record<string, unknown>,
  rootNode: ResolvedNode,
  contextFields: ReadonlyArray<string>,
  dateEncodings: Record<string, DynamoEncoding>,
  aggregateName: string,
): Effect.Effect<ReadonlyArray<TransactionGroup>, AggregateDecompositionError> =>
  Effect.gen(function* () {
    const items: DecomposedItem[] = []

    // Extract context values from the root, serializing date fields for DynamoDB storage.
    // Domain Date/DateTime objects must be encoded before toAttributeMap() marshalling,
    // otherwise Date objects become { M: {} } (no enumerable properties).
    const contextValues: Record<string, unknown> = {}
    for (const field of contextFields) {
      const value = assembled[field]
      const encoding = dateEncodings[field]
      contextValues[field] =
        encoding && value != null ? serializeDateForDynamo(value, encoding) : value
    }

    // Root item: fields not claimed by edges
    const edgeFieldNames = new Set(rootNode.children.map((c) => c.fieldName).filter(Boolean))
    const rootAttrs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(assembled)) {
      if (edgeFieldNames.has(key)) continue
      // Serialize date fields in root attributes (same as context values)
      const encoding = dateEncodings[key]
      rootAttrs[key] = encoding && value != null ? serializeDateForDynamo(value, encoding) : value
    }

    items.push({
      entityType: rootNode.entityType,
      attributes: rootAttrs,
      transactionGroup: "root",
      skComposites: [],
    })

    // Decompose each edge
    for (const child of rootNode.children) {
      const fieldValue = assembled[child.fieldName!]
      yield* decomposeNode(items, child, fieldValue, contextValues, "root", [], aggregateName)
    }

    // Group by transaction
    const groups = new Map<string, DecomposedItem[]>()
    for (const item of items) {
      const list = groups.get(item.transactionGroup) ?? []
      list.push(item)
      groups.set(item.transactionGroup, list)
    }

    return [...groups.entries()].map(([name, groupItems]) => ({ name, items: groupItems }))
  })

/**
 * Merge context values into decomposed item attributes.
 * Context values always override entity-specific fields — the aggregate root
 * defines the authoritative values for context fields like "name" and "gender".
 */
const mergeContextValues = (
  attrs: Record<string, unknown>,
  contextValues: Record<string, unknown>,
): void => {
  for (const [key, value] of Object.entries(contextValues)) {
    attrs[key] = value
  }
}

/**
 * Recursively decompose a node's value into DynamoDB items.
 */
const decomposeNode = (
  items: DecomposedItem[],
  node: ResolvedNode,
  value: unknown,
  contextValues: Record<string, unknown>,
  parentGroup: string,
  parentDiscriminatorValues: ReadonlyArray<string>,
  aggregateName: string,
): Effect.Effect<void, AggregateDecompositionError> =>
  Effect.gen(function* () {
    // Optional edges may have null/undefined values — skip decomposition
    if (value == null) return

    if (node.cardinality === "one" && node.children.length > 0) {
      // Sub-aggregate — becomes its own transaction group
      const subValue = value as Record<string, unknown>
      const txGroup = node.fieldName ?? node.entityType

      // Discriminator values for SK composition (name#value pairs from own discriminator)
      const discValues = node.ownDiscriminator
        ? Object.entries(node.ownDiscriminator)
            .filter(([, v]) => typeof v !== "function")
            .flatMap(([k, v]) => [k, KeyComposer.serializeValue(v)])
        : []

      // Sub-aggregate root item: fields not claimed by child edges
      const childEdgeNames = new Set(node.children.map((c) => c.fieldName).filter(Boolean))
      const subRootAttrs: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(subValue)) {
        if (childEdgeNames.has(key)) continue
        subRootAttrs[key] = val
      }

      // Inject context and discriminator
      mergeContextValues(subRootAttrs, contextValues)
      if (node.discriminator) {
        for (const [k, v] of Object.entries(node.discriminator)) {
          if (typeof v !== "function") subRootAttrs[k] = v
        }
      }

      items.push({
        entityType: node.entityType,
        attributes: subRootAttrs,
        transactionGroup: txGroup,
        skComposites: discValues,
      })

      // Decompose children within this sub-aggregate
      for (const child of node.children) {
        const childValue = subValue[child.fieldName!]
        yield* decomposeNode(
          items,
          child,
          childValue,
          contextValues,
          txGroup,
          discValues,
          aggregateName,
        )
      }
    } else if (node.cardinality === "one") {
      // Simple one-to-one edge (no children)
      const attrs = { ...(value as Record<string, unknown>) }
      mergeContextValues(attrs, contextValues)
      if (node.discriminator) {
        for (const [k, v] of Object.entries(node.discriminator)) {
          if (typeof v !== "function") attrs[k] = v
        }
      }

      // Own discriminator values as name#value pairs for SK composition
      const ownDiscValues = node.ownDiscriminator
        ? Object.entries(node.ownDiscriminator)
            .filter(([, v]) => typeof v !== "function")
            .flatMap(([k, v]) => [k, KeyComposer.serializeValue(v)])
        : []

      items.push({
        entityType: node.entityType,
        attributes: attrs,
        transactionGroup: parentGroup,
        skComposites: [...parentDiscriminatorValues, ...ownDiscValues],
      })
    } else {
      // Many edge
      const arrayItems = node.decompose
        ? node.decompose(value)
        : Array.isArray(value)
          ? (value as ReadonlyArray<unknown>)
          : []

      for (const elem of arrayItems) {
        const attrs = { ...(elem as Record<string, unknown>) }
        mergeContextValues(attrs, contextValues)
        if (node.discriminator) {
          for (const [k, v] of Object.entries(node.discriminator)) {
            if (typeof v !== "function") attrs[k] = v
          }
        }

        // Extract ref identifiers for SK composites
        const itemComposites = extractRefIdentifiers(attrs)

        items.push({
          entityType: node.entityType,
          attributes: attrs,
          transactionGroup: parentGroup,
          skComposites: [...parentDiscriminatorValues, ...itemComposites],
        })
      }
    }
  })

/**
 * Extract ref identifier values from an item's attributes for use as SK composites.
 * Walks fields looking for embedded objects that have an identifier-annotated field.
 */
const extractRefIdentifiers = (attrs: Record<string, unknown>): ReadonlyArray<string> => {
  const ids: string[] = []
  // Case 1: Element wraps entity — look for nested objects with id-like fields
  for (const [, value] of Object.entries(attrs)) {
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      if (typeof obj.id === "string") {
        ids.push(obj.id)
      } else {
        for (const [k, v] of Object.entries(obj)) {
          if (k.endsWith("Id") && typeof v === "string") {
            ids.push(v)
            break
          }
        }
      }
    }
  }
  // Case 2: Element IS entity — top-level id field (e.g., Umpire with { id: "ump-1", ... })
  if (ids.length === 0 && typeof attrs.id === "string") {
    ids.push(attrs.id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Internal: Hash-based shard selection for list collection cardinality
// ---------------------------------------------------------------------------

const hashToShard = (value: string, cardinality: number): number => {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % cardinality
}

// ---------------------------------------------------------------------------
// Internal: Compose DynamoDB items from decomposed data
// ---------------------------------------------------------------------------

/**
 * Convert decomposed items into DynamoDB attribute maps with composed keys.
 */
const buildDynamoItems = (
  groups: ReadonlyArray<TransactionGroup>,
  config: AggregateConfig<any>,
  pkValue: string,
  rootCollectionSkComposites: ReadonlyArray<string>,
): ReadonlyArray<{ group: string; items: ReadonlyArray<Record<string, AttributeValue>> }> =>
  groups.map((group) => ({
    group: group.name,
    items: group.items.map((item) => {
      const attrs: Record<string, unknown> = { ...item.attributes }

      // Add entity type discriminator
      attrs.__edd_e__ = item.entityType

      // PK: shared collection key
      attrs[config.pk.field] = pkValue

      // SK: entity-type specific
      attrs.sk = composeKey(config.schema, item.entityType, [...item.skComposites])

      // Collection SK (LSI): root uses collection composites, others mirror their SK
      const isRootItem =
        item.entityType === config.root.entityType && item.skComposites.length === 0
      attrs[config.collection.sk.field] = isRootItem
        ? composeCollectionKey(config.schema, config.collection.name, rootCollectionSkComposites)
        : composeKey(config.schema, item.entityType, [...item.skComposites])

      // List collection GSI keys (root items only)
      if (isRootItem && config.list) {
        const listPkComposites = KeyComposer.extractComposites(
          config.list.pk.composite,
          item.attributes,
        )
        if (config.list.cardinality) {
          const shard = hashToShard(pkValue, config.list.cardinality)
          attrs[config.list.pk.field] = composeCollectionKey(config.schema, config.list.name, [
            ...listPkComposites,
            String(shard),
          ])
        } else {
          attrs[config.list.pk.field] = composeCollectionKey(
            config.schema,
            config.list.name,
            listPkComposites,
          )
        }
        const listSkComposites = KeyComposer.extractComposites(
          config.list.sk.composite,
          item.attributes,
        )
        attrs[config.list.sk.field] = composeCollectionKey(
          config.schema,
          config.list.name,
          listSkComposites,
        )
      }

      return toAttributeMap(attrs)
    }),
  }))

// ---------------------------------------------------------------------------
// Internal: Write transaction groups to DynamoDB
// ---------------------------------------------------------------------------

const writeTransactionGroups = (
  client: DynamoClientService,
  tableName: string,
  groups: ReadonlyArray<{ group: string; items: ReadonlyArray<Record<string, AttributeValue>> }>,
  aggregateName: string,
): Effect.Effect<void, AggregateTransactionOverflow | DynamoClientError | TransactionCancelled> =>
  Effect.gen(function* () {
    for (const group of groups) {
      // Check transaction size limit
      if (group.items.length > 100) {
        return yield* new AggregateTransactionOverflow({
          aggregate: aggregateName,
          subgraph: group.group,
          itemCount: group.items.length,
          limit: 100,
        })
      }

      if (group.items.length === 0) continue

      // Build TransactWriteItems request
      const transactItems = group.items.map((item) => ({
        Put: { TableName: tableName, Item: item },
      }))

      yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
        Effect.mapError((error) => {
          if (
            error.cause != null &&
            typeof error.cause === "object" &&
            "name" in error.cause &&
            (error.cause as { name: unknown }).name === "TransactionCanceledException"
          ) {
            const cancelled = error.cause as {
              CancellationReasons?: ReadonlyArray<{ Code?: string; Message?: string }>
            }
            return new TransactionCancelled({
              operation: "TransactWriteItems",
              reasons: (cancelled.CancellationReasons ?? []).map((r) => ({
                code: r?.Code,
                message: r?.Message,
              })),
              cause: error.cause,
            }) as DynamoClientError | TransactionCancelled
          }
          return error as DynamoClientError | TransactionCancelled
        }),
      )
    }
  })

// ---------------------------------------------------------------------------
// Internal: Delete all items in an aggregate partition
// ---------------------------------------------------------------------------

const deleteAllItems = (
  client: DynamoClientService,
  tableName: string,
  allItems: ReadonlyArray<Record<string, unknown>>,
  pkField: string,
): Effect.Effect<void, DynamoClientError> =>
  Effect.gen(function* () {
    // Extract primary keys from items
    const deleteRequests = allItems.map((item) => ({
      DeleteRequest: {
        Key: toAttributeMap({
          [pkField]: item[pkField],
          sk: item.sk,
        }),
      },
    }))

    // Chunk into batches of 25 (DynamoDB batchWriteItem limit)
    for (let i = 0; i < deleteRequests.length; i += 25) {
      const chunk = deleteRequests.slice(i, i + 25)
      yield* client.batchWriteItem({
        RequestItems: { [tableName]: chunk },
      })
    }
  })

// ---------------------------------------------------------------------------
// Internal: Query a single list collection GSI partition (paginated)
// ---------------------------------------------------------------------------

interface ListPartitionResult {
  readonly items: Array<Record<string, unknown>>
  readonly lastKey: Record<string, AttributeValue> | undefined
}

const queryListPartition = (
  client: DynamoClientService,
  tableConfig: TableConfig,
  listConfig: ListCollectionConfig,
  schema: DynamoSchemaModule.DynamoSchema,
  pkValue: string,
  skValues: ReadonlyArray<string>,
  limit?: number | undefined,
  startKey?: Record<string, AttributeValue> | undefined,
): Effect.Effect<ListPartitionResult, DynamoClientError> =>
  Effect.gen(function* () {
    const exprNames: Record<string, string> = { "#pk": listConfig.pk.field }
    const exprValues: Record<string, AttributeValue> = { ":pk": toAttributeValue(pkValue) }
    let keyCondition = "#pk = :pk"

    if (skValues.length > 0) {
      const skPrefix = composeCollectionKey(schema, listConfig.name, skValues)
      exprNames["#sk"] = listConfig.sk.field
      exprValues[":skPrefix"] = toAttributeValue(skPrefix)
      keyCondition += " AND begins_with(#sk, :skPrefix)"
    }

    const items: Array<Record<string, unknown>> = []
    let lastKey: Record<string, AttributeValue> | undefined = startKey

    do {
      const result = yield* client.query({
        TableName: tableConfig.name,
        IndexName: listConfig.index,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ExclusiveStartKey: lastKey,
        ...(limit !== undefined ? { Limit: limit - items.length } : {}),
      })

      if (result.Items) {
        for (const item of result.Items) {
          items.push(fromAttributeMap(item as Record<string, AttributeValue>))
        }
      }

      lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined

      // Stop when we've collected enough items
      if (limit !== undefined && items.length >= limit) break
    } while (lastKey !== undefined)

    return { items, lastKey }
  })
