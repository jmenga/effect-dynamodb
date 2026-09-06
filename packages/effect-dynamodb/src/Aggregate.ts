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
import { TypeId as SchemaAggregateTypeId } from "@effect-dynamodb/schema/Aggregate.js"
import type { DynamoEncoding } from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import type * as DynamoSchemaModule from "@effect-dynamodb/schema/DynamoSchema.js"
import { composeCollectionKey, composeKey } from "@effect-dynamodb/schema/DynamoSchema.js"
import type { EntityDefinition } from "@effect-dynamodb/schema/Entity.js"
import {
  AggregateAssemblyError,
  AggregateDecompositionError,
  AggregateTransactionOverflow,
  type ItemNotFound,
  RefNotFound,
  TransactionCancelled,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import {
  makeCompositeKeyForm,
  toCompositeKeyRecord,
} from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import type { TimestampsConfig } from "@effect-dynamodb/schema/internal/EntityConfig.js"
import {
  buildDateTransform,
  matchDateRepresentation,
  resolveSystemFields,
  substituteSchemaDeep,
  validateNoTransformOverride,
} from "@effect-dynamodb/schema/internal/EntitySchemas.js"
import { hasEncodingTransformation } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { type Context, DateTime, Effect, type Optic, Option, Schema, SchemaAST } from "effect"
import * as Batch from "./Batch.js"
import { DynamoClient, type DynamoClientError, type DynamoClientService } from "./DynamoClient.js"
import { type EntityGet, fromDefinition as entityFromDefinition } from "./Entity.js"
import {
  type CompileResult,
  type ConditionOps,
  type ConditionShorthand,
  compileExpr,
  createConditionOps,
  type Expr,
  parseSimpleShorthand,
} from "./internal/Expr.js"
import { createPathBuilder, type PathBuilder } from "./internal/PathBuilder.js"
import { generateTimestampPrimitive } from "./internal/TransactableOps.js"
import { fromAttributeMap, toAttributeMap, toAttributeValue } from "./Marshaller.js"
import { resolvePrimaryKey, type Table, type TableConfig } from "./Table.js"

export type {
  Cursor,
  DiscriminatorConfig,
  UpdateContext,
} from "@effect-dynamodb/schema/internal/AggregateCursor.js"
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
} from "@effect-dynamodb/schema/internal/AggregateEdges.js"
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
} from "@effect-dynamodb/schema/internal/AggregateSchemas.js"
export type {
  AggregateInputType,
  BoundSubAggregate,
  Input,
  Key,
  SubAggregate,
  Type,
  UpdateFn,
} from "@effect-dynamodb/schema/internal/AggregateTypes.js"

import {
  type DiscriminatorConfig,
  makeCursor,
  type UpdateContext,
} from "@effect-dynamodb/schema/internal/AggregateCursor.js"
import type { AggregateEdge, RefEntity } from "@effect-dynamodb/schema/internal/AggregateEdges.js"
import {
  deriveAggregateSchemas,
  deriveEntityFieldName,
} from "@effect-dynamodb/schema/internal/AggregateSchemas.js"
import type {
  AggregateInputType,
  BoundSubAggregate,
  SubAggregate,
} from "@effect-dynamodb/schema/internal/AggregateTypes.js"

// ---------------------------------------------------------------------------
// TypeId
// ---------------------------------------------------------------------------

// Re-export the schema package's TypeId rather than declaring a second
// `unique symbol`. Both resolve to the same registered `Symbol.for` at runtime,
// but two separate `unique symbol` declarations are NOMINALLY distinct types —
// which made the runtime `Aggregate` non-assignable to the pure
// `AggregateDefinition` it is meant to extend. Sharing one symbol type closes
// that dual-package hazard.
export const TypeId: typeof SchemaAggregateTypeId = SchemaAggregateTypeId
export type TypeId = typeof SchemaAggregateTypeId

// ---------------------------------------------------------------------------
// Internal: Resolved graph node
// ---------------------------------------------------------------------------

interface ResolvedNode {
  readonly fieldName: string | null // null for root
  readonly entityType: string
  readonly cardinality: "root" | "one" | "many"
  readonly discriminator?: Record<string, unknown>
  readonly ownDiscriminator?: Record<string, unknown>
  readonly children: ReadonlyArray<ResolvedNode>
  readonly assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  readonly decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined
  /**
   * Per-field encoders for this node entity's own date fields, applied on the
   * WRITE path (decompose) so transform/self-date values are serialized to their
   * wire primitive before marshalling (issue #72). Undefined for the root, whose
   * attributes are encoded directly by `decomposeAggregate`.
   */
  readonly attrEncoders?: Record<string, (value: unknown) => unknown> | undefined
  /**
   * Declared sort-key composites for a `many` edge (`Aggregate.many(..., { sk })`).
   * When present these are authoritative: they replace the ref-identifier
   * heuristic, so the edge's element ordering and uniqueness are the user's to
   * decide rather than a consequence of property order (#103). Each entry names
   * an attribute on the decomposed element, and may use a dotted path to reach
   * into a hydrated ref (`"contact.contactId"`).
   */
  readonly skComposite?: ReadonlyArray<string> | undefined
  /**
   * Name of the referenced entity's `DynamoModel.identifier` field, when the edge
   * declares one. Used by {@link extractRefIdentifiers} for the "element IS the
   * ref" shape (`Schema.Array(Player)`), where hydration leaves the entity's own
   * fields flat and there is no nested object to walk.
   */
  readonly refIdentifierField?: string | undefined
}

// ---------------------------------------------------------------------------
// List pagination types
// ---------------------------------------------------------------------------

/**
 * Server-side predicate for {@link ListOptions.filter} — the same two forms
 * `BoundQuery.filter()` takes, so there is one filter vocabulary in the library:
 *
 * - callback: `(t, { gt }) => gt(t.total, 100)`
 * - shorthand: `{ status: "shipped" }` (attribute equality, ANDed)
 */
export type ListFilter<Model> =
  | ((t: PathBuilder<Model, Model, never>, ops: ConditionOps<Model>) => Expr)
  | ConditionShorthand

/** Options for paginated list queries */
export interface ListOptions<Model = Record<string, unknown>> {
  /**
   * Return at most this many aggregates — a contract on results, not on rows
   * examined. Under {@link ListOptions.filter} the root query accumulates
   * across as many requests as it takes to fill the page. Use
   * {@link ListOptions.pageSize} to size the requests themselves.
   */
  readonly limit?: number
  /**
   * Rows examined per DynamoDB request (`Limit`) — a contract on round trips,
   * not on what comes back. Mostly useful with a selective `filter`, where a
   * request can return nothing and the loop simply asks again.
   */
  readonly pageSize?: number
  /** Opaque cursor from a previous list call to resume pagination */
  readonly cursor?: string
  /**
   * `FilterExpression` applied to the **root-item** query, server-side.
   *
   * Worth reaching for beyond ergonomics: `list` assembles each surviving root
   * item with its own partition read, so a predicate applied after the fact
   * pays a full assembly for every aggregate it then discards. Pushing it into
   * the query means the discarded rows are never assembled.
   *
   * Filters the root item's stored attributes only — edge items are not
   * examined by this query.
   */
  readonly filter?: ListFilter<Model>
  /** Walk the list index in descending order (`ScanIndexForward: false`). */
  readonly reverse?: boolean
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

  /**
   * Collection index config — used for assembling aggregates by partition key.
   * `index` is `undefined` when the aggregate assembles directly off the base table.
   */
  readonly collection: {
    readonly index: string | undefined
    readonly sk: { readonly field: string } | undefined
  }

  /** Whether assembly reads use strongly consistent reads. */
  readonly consistentRead: boolean

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
   *
   * `options.filter` adds a server-side `FilterExpression` to the root-item
   * query; `limit` still means "this many aggregates", the loop accumulating
   * across requests until the page fills or the key range ends. A `null` cursor
   * means genuinely exhausted.
   *
   * On a **sharded** list (`list.cardinality`) `limit` bounds the merged result
   * but there is no resumable position across shards, so `cursor` is always
   * `null` and passing one fails with `EDD-9051`.
   */
  readonly list: (
    filter?: Record<string, unknown>,
    options?: ListOptions<Schema.Schema.Type<TSchema>>,
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
    options?: ListOptions<Schema.Schema.Type<TSchema>>,
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
  /**
   * Physical index backing the collection query.
   *
   * **Optional.** Aggregate assembly reads the whole partition with a bare
   * `pk = :pk` condition and discriminates items by `__edd_e__` in memory — it
   * issues no sort-key condition and depends on no ordering. When the aggregate's
   * `pk.field` is the table's primary PK, that query runs against the base table
   * and no index is needed; omit `index` and none is provisioned.
   *
   * Supply an index only when the aggregate's `pk.field` is *not* the table's
   * primary PK, where a GSI is genuinely load-bearing.
   *
   * Declared `?: string` rather than `?: string | undefined` — under
   * `exactOptionalPropertyTypes` those differ, and "no index" is expressed by
   * omitting the key, never by passing an explicit `undefined`.
   */
  readonly index?: string
  readonly name: string
  /**
   * Sort key for the collection index. Required with `index`, meaningless without
   * it — the mirror attribute exists only so the index has something to sort by,
   * so a base-table aggregate omits both. Supplying one without the other throws
   * at `make()` time.
   */
  readonly sk?: {
    readonly field: string
    readonly composite: ReadonlyArray<string>
  }
}

interface ListCollectionConfig extends CollectionConfig {
  /** The list index is always a GSI — it has its own partition key. */
  readonly index: string
  readonly sk: {
    readonly field: string
    readonly composite: ReadonlyArray<string>
  }
  readonly pk: {
    readonly field: string
    readonly composite: ReadonlyArray<string>
  }
  readonly cardinality?: number
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
  readonly list?: ListCollectionConfig
  /**
   * Use strongly consistent reads when assembling this aggregate. Defaults to `false`,
   * matching DynamoDB and `Entity`.
   *
   * Aggregate writes are transactional, so an eventually consistent read taken shortly
   * after a write can observe a torn item collection — the root may be missing (raising
   * `AggregateAssemblyError`), or an edge may be missing while the root is visible, which
   * for optional or empty-able edges assembles successfully into an aggregate that is
   * quietly incomplete. Enable this when read-after-write correctness matters; it doubles
   * the RCU cost of every assembly read.
   *
   * Only valid where the assembly query can be strongly consistent: the base table (no
   * `collection.index`) or an LSI. DynamoDB rejects consistent reads against a GSI, so
   * combining this with a GSI-shaped collection index throws at `make()` time.
   */
  readonly consistentRead?: boolean
  readonly context?: ReadonlyArray<string>
  /**
   * Auto-managed `created` / `updated` attributes on every row this aggregate
   * writes — the root item and all edge items, sub-aggregate groups included.
   *
   * Takes the same {@link TimestampsConfig} as `Entity.make`, so field names and
   * `DynamoModel` storage annotations behave identically (a `schema` without a
   * `DynamoEncoding` annotation throws EDD-9044 at make() time).
   *
   * `updated` is per row: it records when *that* row last changed. A diff-based
   * `update` rewrites only the sub-aggregate groups whose content changed, so
   * rows the mutation left alone keep their stored value. `created` is carried
   * forward from the stored item on rewrite, since aggregate writes are `Put`
   * rather than `UpdateItem`.
   */
  readonly timestamps?: TimestampsConfig
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
 * Infer date encoding from a schema AST, handling Schema.optional() wrappers.
 * Optional fields have Union AST with [InnerType, Undefined] — unwrap to find dates.
 */
const inferDateEncoding = (ast: Schema.Top["ast"]): DynamoEncoding | undefined => {
  // Try SchemaAST.resolve first (works for non-optional date fields)
  const resolved = SchemaAST.resolve(ast) as ASTNode | undefined
  if (resolved) {
    const direct = matchDateRepresentation(resolved)
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
        const enc = matchDateRepresentation(memberResolved)
        if (enc) return enc
      }
      // Fallback: check raw member annotations (same record shape, nested under .annotations)
      const enc = matchDateRepresentation(member.annotations)
      if (enc) return enc
    }
  }
  return undefined
}

/**
 * Build per-field ATTRIBUTE encoders for a schema's own fields — the write-side
 * equivalent of what `Entity.put` gets for free by encoding its whole input
 * through `inputSchema`.
 *
 * Decomposition works from the schema-DECODED domain object, so every attribute
 * it produces is a Type-side value. Marshalling those directly stores a shape
 * the read path cannot decode: a `Schema.BigIntFromString` field lands as
 * `{N:"5"}` and assembly's decode (which expects the encoded string) rejects it,
 * so the aggregate cannot round-trip at all. Dates were noticed first (#72) and
 * got a date-only pass; the same argument applies to every transformed field.
 *
 * Exactly ONE encoder per field, so nothing is ever encoded twice:
 *
 * 1. **A date encoding** — an explicit `DynamoModel.storedAs` annotation, or the
 *    inferred default for a standard Effect date schema. This wins over the
 *    field's own encode because `storedAs` is precisely an override of it
 *    (a `Schema.DateTimeUtc` field marked `storedAs(DateEpochMs)` must store the
 *    epoch, not the ISO string its own schema would produce). This branch is the
 *    former `buildAttrEncoders`, unchanged.
 * 2. **Any other encoding transformation** — the field's own `encode`. A ref
 *    field's schema is the referenced entity's, so a hydrated ref is encoded
 *    with the entity it came from, not with the aggregate's schema.
 * 3. **No transformation** — no encoder at all, so the stored bytes are
 *    identical to before this existed.
 *
 * The READ path is handled entirely by the aggregate's tolerant `decodeSchema`
 * (see `makeAggregate`), so no separate decoders are needed.
 */
const buildAttrEncoders = (
  fields: Record<string, Schema.Top> | undefined,
): Record<string, (value: unknown) => unknown> => {
  const encoders: Record<string, (value: unknown) => unknown> = {}
  if (!fields) return encoders

  for (const field of Object.keys(fields)) {
    const fieldSchema = fields[field]!

    // 1. Date encoding — `storedAs` override, else the inferred date default.
    const encoding = DynamoModel.getEncoding(fieldSchema) ?? inferDateEncoding(fieldSchema.ast)
    if (encoding) {
      const encode = Schema.encodeUnknownSync(buildDateTransform(encoding) as Schema.Codec<any>)
      encoders[field] = (value) => encode(value)
      continue
    }

    // 3. Identity by construction — `SchemaAST` documents `encoding === undefined`
    //    as "type and encoded forms are identical". Adding an encoder here could
    //    only change bytes that are already correct.
    if (!hasEncodingTransformation(fieldSchema)) continue

    // 2. The field's own encode, with `decode -> encode` as the fallback so a
    //    caller who already supplied wire form round-trips to itself (the same
    //    strategy `Entity.put` uses). Neither working means the value is neither
    //    Type nor Encoded for this field; store it unchanged rather than
    //    introduce a new write-time failure mode mid-release — that shape is
    //    already unreadable, and the tolerant read path reports it.
    const codec = fieldSchema as unknown as Schema.Codec<any>
    const encode = Schema.encodeUnknownOption(codec)
    const decode = Schema.decodeUnknownOption(codec)
    encoders[field] = (value) => {
      const direct = encode(value)
      if (Option.isSome(direct)) return direct.value
      const decoded = decode(value)
      if (Option.isSome(decoded)) {
        const reencoded = encode(decoded.value)
        if (Option.isSome(reencoded)) return reencoded.value
      }
      return value
    }
  }
  return encoders
}

/**
 * A schema's declared fields, if it exposes them (Schema.Struct / Schema.Class).
 *
 * Unwraps `DynamoModel.configure(...)` first: that returns a `{ model, attributes }`
 * WRAPPER, not a schema, so reading `.fields` off it yields nothing. An edge
 * entity declared with a configured model therefore got NO encoders at all —
 * its dates marshalled as `{M:{...}}` and its transformed fields as their Type
 * values, on every row of that edge. Configured models are the norm (any
 * `identifier: true` / `field:` rename produces one), so this blind spot covered
 * most real edges.
 */
const fieldsOf = (schema: unknown): Record<string, Schema.Top> | undefined => {
  const source = DynamoModel.isConfiguredModel(schema) ? schema.model : schema
  return (source as { readonly fields?: Record<string, Schema.Top> } | undefined)?.fields
}

/**
 * Apply a node's date encoders in place — converts the node entity's own domain
 * date fields to their wire primitives before the decomposed item is marshalled
 * (issue #72: without this, an edge's `DateTime` field marshals to `{M:{}}` and
 * the subsequent `get`/assemble fails decoding it as a string).
 */
const applyNodeAttrEncoders = (
  attrs: Record<string, unknown>,
  encoders: Record<string, (value: unknown) => unknown> | undefined,
): void => {
  if (!encoders) return
  for (const [field, encode] of Object.entries(encoders)) {
    if (field in attrs && attrs[field] != null) attrs[field] = encode(attrs[field])
  }
}

// ---------------------------------------------------------------------------
// Top-level aggregate construction
// ---------------------------------------------------------------------------

const makeAggregate = <TSchema extends Schema.Top>(
  schema: TSchema,
  config: AggregateConfig<TSchema>,
): Aggregate<TSchema, Record<string, unknown>> => {
  // Build resolved graph by walking edges recursively
  const rootNode = resolveNode({
    fieldName: null,
    entityType: config.root.entityType,
    cardinality: "root",
    edges: config.edges,
  })
  const aggregateName = config.root.entityType
  const contextFields = config.context ?? []

  // Detect date encodings for all root schema fields (once, at make() time)
  // and build a per-field bidirectional substitute schema.
  //
  // Aggregates decompose/assemble at the root-attribute level — each date
  // field is converted in isolation (write: domain → wire primitive; read:
  // wire primitive → domain). To stay schema-driven (issue #29), we route
  // the conversion through the same `buildDateTransform` substitute used by
  // Entity. `Schema.encodeUnknownSync` produces the wire form on writes and
  // `Schema.decodeUnknownSync` lifts the wire form back on reads — wire
  // format is byte-identical to the legacy per-field helpers.
  //
  // Policy: aggregate fields that already carry a date transform schema
  // (e.g. `Schema.DateTimeUtcFromString`) cannot be combined with a
  // `DynamoModel.storedAs(...)` annotation that conflicts with the
  // transform's wire kind — same rule as Entity.
  const schemaFields = (schema as Record<string, unknown>).fields as
    | Record<string, Schema.Top>
    | undefined
  if (schemaFields) {
    // Reject transform + storedAs annotation conflicts (Option (b) policy).
    // Aggregates do not currently support `DynamoModel.configure` overrides,
    // so we pass an empty `configuredAttributes` map — only the schema-level
    // annotation conflict is checked.
    validateNoTransformOverride(schemaFields, {})
  }
  // Date ENCODERS for the write path: decompose works from the schema-decoded
  // domain object, so every root date field (Pattern A self-date AND Pattern B
  // transform) is serialized to its wire primitive for storage.
  const attrEncoders = buildAttrEncoders(schemaFields)

  // Decode schema for read/assemble + input validation. Mirrors the raw `schema`
  // but recursively substitutes EVERY date / Redacted leaf — root and nested,
  // Pattern A and Pattern B — with a TOLERANT transform. This is the single
  // decode path for get / create / update:
  //   - reads supply the stored wire form (string/number) → lifted to domain;
  //   - update re-decodes the mutated state, which carries domain `DateTime`
  //     values → accepted as-is (a strict `*FromString` decoder would reject
  //     them). It is decode-only, so making transforms tolerant is safe — the
  //     stored wire format is still produced by `attrEncoders` / node encoders.
  // Nested edge / ref classes round-trip with their class instance identity
  // preserved (Option A). Returns the raw `schema` unchanged when it carries no
  // date / Redacted leaf at all (zero overhead).
  //
  // SINGLE ref/one edge fields carry the opaque `DynamoModel.ref` annotation, so
  // the substitution can't introspect them — `resolveRef` re-points each to its
  // edge target model (unwrapping `DynamoModel.configure`). MANY edges are
  // excluded: their model field is a `Schema.Array(...)` (or a wrapper class) that
  // `substituteSchemaDeep` introspects directly — re-pointing it at the element
  // model would drop the `Array` and yield "Expected object, got []" on assemble.
  const edgeRefModels = new Map<string, Schema.Top>()
  const unwrapModel = (model: Schema.Top): Schema.Top =>
    DynamoModel.isConfiguredModel(model) ? (model.model as Schema.Top) : model
  for (const [edgeName, edge] of Object.entries(config.edges)) {
    if (!("_tag" in edge)) continue
    if (edge._tag !== "RefEdge" && edge._tag !== "OneEdge") continue
    const entity = (
      edge as {
        readonly entity?: {
          readonly model?: Schema.Top
          readonly _data?: {
            readonly resolvedRefs?: ReadonlyArray<{
              readonly fieldName: string
              readonly refEntity?: { readonly model?: Schema.Top }
            }>
          }
        }
      }
    ).entity
    const model = entity?.model
    if (!model) continue
    edgeRefModels.set(edgeName, unwrapModel(model))

    // A ref nested INSIDE an edge's model needs the same treatment. `maker` on
    // an edge entity is annotated with `DynamoModel.ref`, and `Schema.annotate`
    // drops a `Schema.Class`'s `.fields`, so the substitution cannot introspect
    // it and the target's own transformed fields keep their strict schemas —
    // which is what made `update` reject a `bigint` at
    // `["supplier"]["maker"]["founded"]` (#116). Registering the target by field
    // name re-points it exactly as a top-level edge is re-pointed.
    for (const nested of entity?._data?.resolvedRefs ?? []) {
      const nestedModel = nested.refEntity?.model
      if (nestedModel && !edgeRefModels.has(nested.fieldName)) {
        edgeRefModels.set(nested.fieldName, unwrapModel(nestedModel))
      }
    }
  }
  const decodeSchema = substituteSchemaDeep(schema, {
    tolerantTransforms: true,
    resolveRef: (name) => edgeRefModels.get(name),
  }) as unknown as Schema.Codec<any>

  // Validate the collection index / consistency combination against the table's
  // primary key. Best effort: a table registering only aggregates has no primary key
  // to resolve, in which case both checks are skipped rather than guessed at.
  const consistentRead = config.consistentRead ?? false
  const tablePrimary = resolvePrimaryKey(config.table.entities)
  const collectionIsGsi =
    tablePrimary !== undefined &&
    config.collection.index !== undefined &&
    config.pk.field !== tablePrimary.pk

  if (tablePrimary !== undefined && config.collection.index === undefined) {
    if (config.pk.field !== tablePrimary.pk) {
      throw new Error(
        `[EDD-9041] Aggregate "${aggregateName}": collection PK field "${config.pk.field}" is ` +
          `not the table's primary partition key ("${tablePrimary.pk}"), so assembly cannot ` +
          `query the base table. Either set \`pk.field\` to "${tablePrimary.pk}", or supply ` +
          `\`collection.index\` naming the GSI partitioned by "${config.pk.field}".`,
      )
    }
  }

  if ((config.collection.index === undefined) !== (config.collection.sk === undefined)) {
    throw new Error(
      `[EDD-9043] Aggregate "${aggregateName}": \`collection.index\` and \`collection.sk\` must ` +
        `be supplied together. The collection SK exists only to give the index something to ` +
        `sort by — declare both to assemble through an index, or neither to assemble off the ` +
        `base table.`,
    )
  }

  if (consistentRead && collectionIsGsi) {
    throw new Error(
      `[EDD-9042] Aggregate "${aggregateName}": \`consistentRead\` is not supported against a ` +
        `GSI. Collection index "${config.collection.index}" is partitioned by ` +
        `"${config.pk.field}" rather than the table's primary partition key ` +
        `("${tablePrimary?.pk}"), which makes it a GSI, and DynamoDB serves GSI reads as ` +
        `eventually consistent only. Drop \`consistentRead\`, or key the aggregate on the ` +
        `table's primary partition key so assembly reads the base table.`,
    )
  }

  // System timestamps (#98). Aggregates compose their DynamoDB items directly
  // rather than routing through Entity write ops, so Entity's timestamp
  // machinery never reached these rows. Resolution goes through the SAME
  // resolver as Entity, which means field names, `DynamoModel` storage
  // annotations and the EDD-9044 guard on an un-annotated `schema` all behave
  // identically here. Passing the root schema's fields also inherits Entity's
  // collision rule: a date-compatible root field of the same name supplies the
  // encoding, and a non-date one means the user owns the attribute outright.
  const timestampFields = resolveSystemFields(
    config.timestamps,
    undefined,
    undefined,
    schemaFields ?? {},
    {},
    `Aggregate "${aggregateName}"`,
  )
  const stampFields: StampFields | undefined =
    timestampFields.createdAt !== null || timestampFields.updatedAt !== null
      ? {
          createdAt: timestampFields.createdAt,
          createdEncoding: timestampFields.createdAtEncoding,
          updatedAt: timestampFields.updatedAt,
          updatedEncoding: timestampFields.updatedAtEncoding,
        }
      : undefined
  // Attributes the read path must drop before decoding. A field the root model
  // declares itself is NOT stripped — it belongs to the domain object.
  const systemAttrs: ReadonlySet<string> = new Set(
    [
      timestampFields.createdAtCollision ? null : timestampFields.createdAt,
      timestampFields.updatedAtCollision ? null : timestampFields.updatedAt,
    ].filter((name): name is string => name !== null),
  )

  /** Read stored `created` values back, keyed by sk, so a rewrite preserves them. */
  const readExistingCreated = (
    allItems: ReadonlyArray<Record<string, unknown>>,
  ): ReadonlyMap<string, unknown> => {
    const createdField = stampFields?.createdAt
    if (createdField === undefined || createdField === null) return EMPTY_CREATED
    const map = new Map<string, unknown>()
    for (const item of allItems) {
      const sk = item.sk
      const prior = item[createdField]
      if (typeof sk === "string" && prior !== undefined) map.set(sk, prior)
    }
    return map
  }

  /** Bind the per-write stamp: config + the Clock-backed instant + carry-forward. */
  const stampFor = (
    now: DateTime.Utc,
    existingCreated: ReadonlyMap<string, unknown>,
  ): Stamp | undefined =>
    stampFields === undefined ? undefined : { fields: stampFields, now, existingCreated }

  // Build optics at construction time (once per aggregate definition)
  const classToPlain = Schema.toIso(schema) as Optic.Iso<
    Schema.Schema.Type<TSchema>,
    TSchema["Iso"]
  >
  const opticRoot = Schema.toIsoFocus(schema) as Optic.Iso<TSchema["Iso"], TSchema["Iso"]>

  // Composite key form — the SAME rule and the SAME function the entity path
  // uses (`internal/CompositeCodec.ts`). Aggregates compose from assembled
  // domain objects, so without this a `DateEpochMs` composite would key on its
  // ISO form here and its epoch form on the entity path, and a numeric
  // composite with a string encoding would not be zero-padded on either.
  const compositeKeyForm = makeCompositeKeyForm(schema, (attr, value) => {
    throw new Error(
      `[EDD-9050] Composite "${attr}" on aggregate "${aggregateName}" could not be put into ` +
        `its key form. The attribute's schema carries an encoding transformation, but ` +
        `${JSON.stringify(String(value))} resolves under neither encode nor decode->encode. ` +
        `Supply a value of the attribute's own type.`,
    )
  })
  const keyRecord = (record: Record<string, unknown>): Record<string, unknown> =>
    toCompositeKeyRecord(compositeKeyForm, record)

  /** Shared: compose PK and query all items */
  const fetchPartition = (key: Record<string, unknown>) =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      const tableConfig: TableConfig = yield* config.table.Tag
      const composites = KeyComposer.extractComposites(config.pk.composite, keyRecord(key))
      const pkValue = composeCollectionKey(config.schema, config.collection.name, composites)
      const allItems = yield* queryAllItems(
        client,
        tableConfig.name,
        config.collection.index,
        config.pk.field,
        pkValue,
        consistentRead,
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
      sk: config.collection.sk === undefined ? undefined : { field: config.collection.sk.field },
    },
    consistentRead,
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
          decodeSchema,
          rootNode,
          allItems,
          contextFields,
          key,
          aggregateName,
          systemAttrs,
        )
        return result as Schema.Schema.Type<TSchema>
      }),

    create: (input) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const tableConfig: TableConfig = yield* config.table.Tag

        // 1. Hydrate refs from edges
        const hydrated = yield* hydrateAggregateRefs(input, config.edges, aggregateName)

        // 2. Validate via schema decode (decodeSchema substitutes nested edge
        //    self-date/Redacted leaves — Option A — and is identical to `schema`
        //    when no edge needs it).
        const decoded = yield* Schema.decodeUnknownEffect(decodeSchema)(hydrated).pipe(
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
        const composites = KeyComposer.extractComposites(config.pk.composite, keyRecord(assembled))
        const pkValue = composeCollectionKey(config.schema, config.collection.name, composites)

        // 4. Decompose into items grouped by sub-aggregate transaction boundaries
        const groups = yield* decomposeAggregate(
          assembled,
          rootNode,
          contextFields,
          attrEncoders,
          aggregateName,
          config.schema,
        )

        // 5. Compose collection SK composites for root item. Through the key
        // form — `update` already did (see `newDynamo` / `oldDynamo` below), so
        // leaving `create` raw made the two write paths mirror the collection SK
        // differently for a transformed composite.
        const collectionSkComposites = KeyComposer.extractComposites(
          config.collection.sk?.composite ?? [],
          keyRecord(assembled),
        )

        // 6. Build DynamoDB items with composed keys (create only ever PUTs).
        //    Every row is new, so `created` has nothing to carry forward.
        const now = yield* DateTime.now
        const dynamoGroups = buildDynamoItems(
          groups,
          config,
          pkValue,
          collectionSkComposites,
          keyRecord,
          stampFor(now, EMPTY_CREATED),
        )

        // 7. Write via sub-aggregate transactions
        yield* writeTransactionGroups(
          client,
          tableConfig.name,
          dynamoGroups.map((g) => ({ group: g.group, puts: g.items, deletes: [] })),
          aggregateName,
        )

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
          decodeSchema,
          rootNode,
          allItems,
          contextFields,
          key,
          aggregateName,
          systemAttrs,
        )

        // 2. Apply mutation — provide optics context for composable updates
        const state = classToPlain.get(current as Schema.Schema.Type<TSchema>)
        const updated = mutationFn({
          state,
          cursor: makeCursor(state, opticRoot),
          optic: opticRoot,
          current: current as Schema.Schema.Type<TSchema>,
        })

        // 3. Validate the mutated state via `decodeSchema` — its tolerant date
        //    transforms accept the domain `DateTime` values the mutation yields
        //    for every date field (root + nested edges, Pattern A and Pattern B),
        //    so update no longer trips the "Expected string, got DateTime" decode
        //    that a strict `*FromString` schema would raise (#72 update path).
        const decoded = yield* Schema.decodeUnknownEffect(decodeSchema)(updated).pipe(
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
          attrEncoders,
          aggregateName,
          config.schema,
        )
        const newGroups = yield* decomposeAggregate(
          assembledNew,
          rootNode,
          contextFields,
          attrEncoders,
          aggregateName,
          config.schema,
        )

        // 5. Diff at the ITEM (primary-key) level, not just the group level.
        //    A `many`-edge element — and a cleared `one` edge — lives in its PARENT's
        //    transaction group, so removing it SHRINKS a group rather than dropping a
        //    whole group. A group-level diff would rewrite the group's surviving PUTs
        //    but never DELETE the removed row, leaving an orphan that re-appears on
        //    read (#74). We therefore compute, per changed group, both the items to
        //    PUT (new) and the items to DELETE (in old, absent from the entire new
        //    state), and apply them together in one transaction.
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

        // 6. Build the full new + old DynamoDB item sets (with composed keys). The
        //    collection SK composites only affect the LSI/GSI mirror attributes,
        //    never the (pk, sk) identity used to PUT or DELETE, so the old set's
        //    composites are irrelevant — we read only its (pk, sk) for deletes.
        //    Rewritten rows are stamped `updated`; their stored `created` is read
        //    back off the fetched partition and re-emitted verbatim, since these are
        //    PUTs and would otherwise clobber it. The old set is only mined for
        //    (pk, sk) delete keys, so it is never stamped.
        const now = yield* DateTime.now
        const newDynamo = buildDynamoItems(
          newGroups,
          config,
          pkValue,
          KeyComposer.extractComposites(
            config.collection.sk?.composite ?? [],
            keyRecord(assembledNew),
          ),
          keyRecord,
          stampFor(now, readExistingCreated(allItems)),
        )
        const oldDynamo = buildDynamoItems(
          oldGroups,
          config,
          pkValue,
          KeyComposer.extractComposites(
            config.collection.sk?.composite ?? [],
            keyRecord(assembledOld),
          ),
          keyRecord,
        )

        const skOf = (item: Record<string, AttributeValue>): string =>
          (item.sk as { S?: string } | undefined)?.S ?? ""
        const newItemsByGroup = new Map(newDynamo.map((g) => [g.group, g.items]))
        const oldItemsByGroup = new Map(oldDynamo.map((g) => [g.group, g.items]))
        // Every sk that survives anywhere in the new decomposition — an old item is
        // an orphan to DELETE only if its key appears in no new group at all.
        const survivingSks = new Set<string>()
        for (const g of newDynamo) {
          for (const item of g.items) survivingSks.add(skOf(item))
        }

        // 7. Per group (union of old + new names), collect PUTs + orphan DELETEs.
        const groupWrites: Array<{
          group: string
          puts: ReadonlyArray<Record<string, AttributeValue>>
          deletes: ReadonlyArray<Record<string, AttributeValue>>
        }> = []
        const groupNames = new Set<string>([...newGroupMap.keys(), ...oldGroupMap.keys()])
        for (const name of groupNames) {
          const oldGroup = oldGroupMap.get(name)
          const newGroup = newGroupMap.get(name)
          const changed =
            contextChanged ||
            oldGroup === undefined ||
            newGroup === undefined ||
            !deepEqualGroups(oldGroup, newGroup)
          if (!changed) continue

          const puts = newItemsByGroup.get(name) ?? []
          const deletes = (oldItemsByGroup.get(name) ?? [])
            .filter((item) => !survivingSks.has(skOf(item)))
            .map((item) => ({
              [config.pk.field]: item[config.pk.field]!,
              sk: item.sk!,
            }))
          if (puts.length === 0 && deletes.length === 0) continue
          groupWrites.push({ group: name, puts, deletes })
        }

        if (groupWrites.length > 0) {
          yield* writeTransactionGroups(client, tableConfig.name, groupWrites, aggregateName)
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
        const pageSize = options?.pageSize

        // Root-item FilterExpression. Compiled once — the same two forms
        // `BoundQuery.filter()` takes, through the same `Expr` compiler, so
        // there is one filter vocabulary rather than a second dialect here.
        const rootFilter = compileListFilter(options?.filter)

        // Attribute names that make up a resume key on the list index: the index
        // key plus the table key. A `LastEvaluatedKey` supplies them when there
        // is one; this is the fallback for the case a filtered request over-reads
        // on the LAST page, where the surplus still has to be re-read next time.
        const listKeyFields = Array.from(
          new Set([
            tablePrimary?.pk ?? config.pk.field,
            tablePrimary?.sk ?? "sk",
            listConfig.pk.field,
            listConfig.sk.field,
          ]),
        )

        // Compose PK from filter values matching PK composites. The filter is a
        // DOMAIN record, so it goes through the same key form the write side
        // used — otherwise `list` composes a key `create` never wrote and
        // silently returns nothing (#111).
        const listPkComposites = KeyComposer.extractComposites(
          listConfig.pk.composite,
          keyRecord(filter ?? {}),
        )

        // Build SK prefix from contiguous filter values matching SK composites.
        // `serializeValue`, NOT `String(v)` — the write side pads numerics, so
        // `String(5)` would look for `5` where `0000000000000005` is stored.
        const skValues: string[] = []
        const listSkFilter = keyRecord(filter ?? {})
        for (const attr of listConfig.sk.composite) {
          if (listSkFilter[attr] !== undefined)
            skValues.push(KeyComposer.serializeValue(listSkFilter[attr]))
          else break // Stop at first gap (prefix matching)
        }

        let rootItems: Array<Record<string, unknown>>
        let nextKey: Record<string, AttributeValue> | undefined

        if (listConfig.cardinality) {
          // A sharded list is a fan-out over N independent partitions, and a
          // DynamoDB cursor addresses a position in ONE of them. Resuming would
          // need a per-shard cursor set plus a defined global merge order, which
          // this fan-out does not have (results are concatenated shard by shard).
          // Rejecting is the honest answer — the previous behaviour accepted the
          // cursor and restarted from the beginning, silently.
          if (options?.cursor !== undefined) {
            return yield* new ValidationError({
              entityType: aggregateName,
              operation: "list",
              cause:
                `[EDD-9051] Aggregate "${aggregateName}" has a sharded list ` +
                `(list.cardinality = ${listConfig.cardinality}), and a sharded fan-out has no ` +
                "resumable cursor: a DynamoDB cursor names a position in one partition, while " +
                "this query spans all of them with no defined order across shards. `list` on a " +
                "sharded aggregate always returns `cursor: null`; use `limit` to bound the " +
                "result, or drop `list.cardinality` if the partition needs paging more than it " +
                "needs spreading.",
            })
          }

          // Fan out across shards and merge. `limit` bounds each shard too — no
          // single shard can contribute more than the whole page.
          const shardQueries = Array.from({ length: listConfig.cardinality }, (_, shard) => {
            const shardPkValue = composeCollectionKey(config.schema, listConfig.name, [
              ...listPkComposites,
              String(shard),
            ])
            return queryListPartition(client, tableConfig, listConfig, config.schema, {
              pkValue: shardPkValue,
              skValues,
              limit,
              pageSize,
              filter: rootFilter,
              reverse: options?.reverse === true,
              keyFields: listKeyFields,
            })
          })
          const shardResults = yield* Effect.all(shardQueries)
          const merged = shardResults.flatMap((r) => r.items)
          // Truncate the merged fan-out to `limit`. Previously the option was
          // accepted and discarded, so a large aggregate set returned everything.
          rootItems = limit === undefined ? merged : merged.slice(0, limit)
          nextKey = undefined
        } else {
          const startKey = options?.cursor
            ? (JSON.parse(atob(options.cursor)) as Record<string, AttributeValue>)
            : undefined
          const listPkValue = composeCollectionKey(config.schema, listConfig.name, listPkComposites)
          const result = yield* queryListPartition(client, tableConfig, listConfig, config.schema, {
            pkValue: listPkValue,
            skValues,
            limit,
            pageSize,
            startKey,
            filter: rootFilter,
            reverse: options?.reverse === true,
            keyFields: listKeyFields,
          })
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
              decodeSchema,
              rootNode,
              allItems,
              contextFields,
              key,
              aggregateName,
              systemAttrs,
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
      list: (
        filter?: Record<string, unknown>,
        options?: ListOptions<Schema.Schema.Type<TSchema>>,
      ) => provide(aggregate.list(filter, options)),
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

/**
 * Arguments to {@link resolveNode}. An options object rather than positionals:
 * the node shape has enough optional facets that a call site's trailing
 * `undefined, undefined, x` told the reader nothing about which facet was being
 * set.
 */
interface ResolveNodeArgs {
  readonly fieldName: string | null
  readonly entityType: string
  readonly cardinality: "root" | "one" | "many"
  readonly edges: Record<string, AggregateEdge | BoundSubAggregate<any>>
  readonly discriminator?: Record<string, unknown> | undefined
  readonly assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  readonly decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined
  readonly ownDiscriminator?: Record<string, unknown> | undefined
  readonly attrEncoders?: Record<string, (value: unknown) => unknown> | undefined
  readonly skComposite?: ReadonlyArray<string> | undefined
  readonly refIdentifierField?: string | undefined
}

const resolveNode = (args: ResolveNodeArgs): ResolvedNode => {
  const {
    assemble,
    cardinality,
    attrEncoders,
    decompose,
    discriminator,
    edges,
    entityType,
    fieldName,
    ownDiscriminator,
    refIdentifierField,
    skComposite,
  } = args
  const children: Array<ResolvedNode> = []

  for (const [field, edge] of Object.entries(edges)) {
    if ("_tag" in edge) {
      if (edge._tag === "OneEdge") {
        // Merge parent discriminator with edge's own discriminator
        const mergedDisc = edge.discriminator
          ? { ...(discriminator ?? {}), ...edge.discriminator }
          : discriminator
        children.push(
          resolveNode({
            fieldName: field,
            entityType: edge.entityType,
            cardinality: "one",
            edges: {},
            discriminator: mergedDisc,
            ownDiscriminator: edge.discriminator,
            // Encode this edge entity's own date fields on write (issue #72).
            attrEncoders: buildAttrEncoders(fieldsOf(edge.entity?.model)),
          }),
        )
      } else if (edge._tag === "ManyEdge") {
        children.push(
          resolveNode({
            fieldName: field,
            entityType: edge.entityType,
            cardinality: "many",
            edges: {},
            discriminator,
            assemble: edge.assemble,
            decompose: edge.decompose,
            attrEncoders: buildAttrEncoders(fieldsOf(edge.entity?.model)),
            // Declared sort-key composites, authoritative when present (#103).
            skComposite: edge.sk?.composite,
            refIdentifierField: edge.entity
              ? DynamoModel.getIdentifierField(edge.entity.model)?.name
              : undefined,
          }),
        )
      } else if (edge._tag === "BoundSubAggregate") {
        const bound = edge as BoundSubAggregate<any>
        const subChildren = resolveNode({
          fieldName: field,
          entityType: bound.aggregate.root.entityType,
          cardinality: "one",
          edges: bound.aggregate.edges,
          discriminator: bound.discriminator,
          ownDiscriminator: bound.discriminator,
          // The sub-aggregate root item carries the sub-schema's own (non-edge)
          // date fields; its child edges get their own encoders via recursion.
          attrEncoders: buildAttrEncoders(fieldsOf(bound.aggregate.schema)),
        })
        children.push(subChildren)
      }
    }
  }

  return {
    fieldName,
    entityType,
    cardinality,
    // Absent optionals stay absent under `exactOptionalPropertyTypes`.
    ...(discriminator !== undefined && { discriminator }),
    ...(ownDiscriminator !== undefined && { ownDiscriminator }),
    children,
    ...(assemble !== undefined && { assemble }),
    ...(decompose !== undefined && { decompose }),
    ...(skComposite !== undefined && { skComposite }),
    ...(refIdentifierField !== undefined && { refIdentifierField }),
    attrEncoders,
  }
}

// ---------------------------------------------------------------------------
// Internal: Query all items in the aggregate partition
// ---------------------------------------------------------------------------

const queryAllItems = (
  client: DynamoClientService,
  tableName: string,
  indexName: string | undefined,
  pkField: string,
  pkValue: string,
  consistentRead: boolean,
): Effect.Effect<Array<Record<string, unknown>>, DynamoClientError> =>
  Effect.gen(function* () {
    const allItems: Array<Record<string, unknown>> = []
    let exclusiveStartKey: Record<string, AttributeValue> | undefined

    // Paginate through all results. Assembly needs every item in the partition and
    // discriminates them by `__edd_e__`, so there is no sort-key condition and no
    // ordering requirement — which is why `IndexName` is optional here.
    do {
      const result = yield* client.query({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": pkField },
        ExpressionAttributeValues: { ":pk": toAttributeValue(pkValue) },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: consistentRead || undefined,
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
  decodeSchema: Schema.Top,
  rootNode: ResolvedNode,
  allItems: Array<Record<string, unknown>>,
  _contextFields: ReadonlyArray<string>,
  key: Record<string, unknown>,
  aggregateName: string,
  /** Library-managed attribute names (system timestamps) to drop before decode. */
  systemAttrs: ReadonlySet<string> = EMPTY_ATTRS,
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
      const assembled = yield* assembleNode(child, allItems, key, aggregateName, systemAttrs)
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
      ...systemAttrs,
    ])

    for (const [fieldKey, value] of Object.entries(rootItem)) {
      if (metaFields.has(fieldKey)) continue
      if (edgeFieldNames.has(fieldKey)) continue
      rootFields[fieldKey] = value
    }

    // Merge raw (wire-form) root fields with assembled edge items.
    const assembled = { ...rootFields, ...edgeValues }

    // Decode through `decodeSchema` — a tolerant clone of the aggregate schema
    // that lifts every date / Redacted leaf (root + nested edges) from the stored
    // wire form to its domain value in a single pass (#72 + Option A).
    const decoded = yield* Schema.decodeUnknownEffect(decodeSchema as Schema.Codec<any>)(
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
  systemAttrs: ReadonlySet<string> = EMPTY_ATTRS,
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
          const assembled = yield* assembleNode(
            childNode,
            allItems,
            key,
            aggregateName,
            systemAttrs,
          )
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
          if (systemAttrs.has(fieldKey)) continue
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
      return stripMetadata(item, systemAttrs)
    }

    // Many edge: collect all matching items
    const stripped = matchingItems.map((item) => stripMetadata(item, systemAttrs))

    if (node.assemble) {
      return node.assemble(stripped)
    }

    return stripped
  })

// ---------------------------------------------------------------------------
// Internal: Strip DynamoDB metadata from items
// ---------------------------------------------------------------------------

const EMPTY_ATTRS: ReadonlySet<string> = new Set()

const stripMetadata = (
  item: Record<string, unknown>,
  systemAttrs: ReadonlySet<string> = EMPTY_ATTRS,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item)) {
    if (key === "__edd_e__") continue
    if (key === "pk" || key === "sk") continue
    if (key.startsWith("gsi") || key.startsWith("lsi")) continue
    if (systemAttrs.has(key)) continue
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

      // `RefEntity` is the pure structural bound (no `get` — issue #66): aggregate
      // edges can be authored from AWS-free `@effect-dynamodb/schema` definitions,
      // which carry no runtime `.get`/operations. Ref hydration is a runtime
      // operation, so promote a pure edge target to a full operational Entity (a
      // thin op-attach over its retained `_data`); runtime-authored targets already
      // carry `.get` and pass through untouched. Mirrors `DynamoClient.make()`'s
      // entity binding. The promoted entity also exposes `.schemas`, used by the
      // encode-back below (issue #72). The loop is already grouped by entity type,
      // so this promotes once per distinct edge entity type per hydrate (issue #71).
      const runtimeEntity = (
        typeof (entity as { readonly get?: unknown }).get === "function"
          ? entity
          : entityFromDefinition(entity as unknown as EntityDefinition)
      ) as RefEntity & {
        readonly get: (key: any) => any
        readonly schemas: { readonly recordSchema: Schema.Codec<any> }
      }

      // Build EntityGet intermediates for batch fetching
      const getOps = uniqueIds.map(
        (id) => runtimeEntity.get({ [identifierName]: id }) as EntityGet<any, any, any, any>,
      )

      const results = yield* Batch.get(getOps)

      // Map results back to lookup, failing on missing refs.
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
        // `Batch.get` returns the DECODED record — transform fields are lifted to
        // their domain form (e.g. `Schema.DateTimeUtcFromString` → `DateTime`). The
        // denormalized ref is spliced into `input` and decoded again by the
        // aggregate's strict `schema`, whose nested edge field is the ORIGINAL ref
        // class expecting the wire form. Re-encode through the ref's substituted
        // `recordSchema` so the spliced value is wire-form and decoded exactly once
        // (issue #72) — this also keeps it marshall-safe for decompose.
        const wire = yield* Schema.encodeUnknownEffect(runtimeEntity.schemas.recordSchema)(
          result,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ValidationError({
                entityType: aggregateName,
                operation: "aggregate.hydrateRefs.encode",
                cause,
              }),
          ),
        )
        hydratedLookup.set(`${entityType}:${id}`, wire as Record<string, unknown>)
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
  /** Edge field name (entity type for the root) — used to name the culprit in errors. */
  readonly member: string
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
  attrEncoders: Record<string, (value: unknown) => unknown>,
  aggregateName: string,
  schema: DynamoSchemaModule.DynamoSchema,
): Effect.Effect<ReadonlyArray<TransactionGroup>, AggregateDecompositionError> =>
  Effect.gen(function* () {
    const items: DecomposedItem[] = []

    // Extract context values from the root, serializing date fields for DynamoDB storage.
    // Domain Date/DateTime objects must be encoded before toAttributeMap() marshalling,
    // otherwise Date objects become { M: {} } (no enumerable properties).
    // The encoder is the substituted bidirectional date schema built at make() time.
    const contextValues: Record<string, unknown> = {}
    for (const field of contextFields) {
      const value = assembled[field]
      const encode = attrEncoders[field]
      contextValues[field] = encode && value != null ? encode(value) : value
    }

    // Root item: fields not claimed by edges
    const edgeFieldNames = new Set(rootNode.children.map((c) => c.fieldName).filter(Boolean))
    const rootAttrs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(assembled)) {
      if (edgeFieldNames.has(key)) continue
      // Serialize date fields in root attributes (same as context values)
      const encode = attrEncoders[key]
      rootAttrs[key] = encode && value != null ? encode(value) : value
    }

    items.push({
      entityType: rootNode.entityType,
      attributes: rootAttrs,
      transactionGroup: "root",
      skComposites: [],
      member: rootNode.entityType,
    })

    // Decompose each edge
    for (const child of rootNode.children) {
      const fieldValue = assembled[child.fieldName!]
      yield* decomposeNode(items, child, fieldValue, contextValues, "root", [], aggregateName)
    }

    // Two items composing the same sort key are two writes to one row. DynamoDB
    // rejects the whole TransactWriteItems with a ValidationException ("Transaction
    // request cannot include multiple operations on one item") that names no edge,
    // and carries no CancellationReasons — so `writeTransactionGroups` cannot
    // decode it and the collision reaches the caller as an opaque client error.
    // Catch it here, where the edge that produced it is still known (#103).
    const seen = new Map<string, DecomposedItem>()
    for (const item of items) {
      const sk = composeKey(schema, item.entityType, [...item.skComposites])
      const prior = seen.get(sk)
      if (prior !== undefined) {
        const hint =
          prior.member === item.member
            ? ` Give the "${item.member}" edge a declared sort key naming attributes that differ` +
              ` between its elements: Aggregate.many("${item.member}", { …, sk: { composite: [...] } }).`
            : ""
        return yield* new AggregateDecompositionError({
          aggregate: aggregateName,
          member: item.member,
          reason:
            `"${prior.member}" and "${item.member}" both compose the sort key "${sk}", ` +
            `so one would overwrite the other.${hint}`,
        })
      }
      seen.set(sk, item)
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

      // Serialize this node's own date fields to their wire primitive (#72).
      applyNodeAttrEncoders(subRootAttrs, node.attrEncoders)

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
        member: node.fieldName ?? node.entityType,
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
      // Serialize this edge entity's own date fields to their wire primitive (#72).
      applyNodeAttrEncoders(attrs, node.attrEncoders)
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
        member: node.fieldName ?? node.entityType,
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
        // Serialize this edge entity's own date fields to their wire primitive (#72).
        applyNodeAttrEncoders(attrs, node.attrEncoders)
        mergeContextValues(attrs, contextValues)
        if (node.discriminator) {
          for (const [k, v] of Object.entries(node.discriminator)) {
            if (typeof v !== "function") attrs[k] = v
          }
        }

        const itemComposites = yield* manyEdgeSkComposites(node, attrs, aggregateName)

        items.push({
          entityType: node.entityType,
          attributes: attrs,
          transactionGroup: parentGroup,
          skComposites: [...parentDiscriminatorValues, ...itemComposites],
          member: node.fieldName ?? node.entityType,
        })
      }
    }
  })

/**
 * Read one declared sk composite off a decomposed element.
 *
 * Dotted paths are supported because ref hydration REPLACES the id field with the
 * hydrated object — an input element `{ contactId, role }` decomposes to
 * `{ contact: { contactId, … }, role }`, so the referenced entity's identifier is
 * only reachable as `"contact.contactId"`.
 */
const readCompositePath = (attrs: Record<string, unknown>, path: string): unknown => {
  if (!path.includes(".")) return attrs[path]
  let current: unknown = attrs
  for (const segment of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Whether a resolved composite value can be a sort-key segment.
 *
 * `KeyComposer.serializeValue` falls through to `String(value)`, so an object
 * reaches the key as `[object Object]` or, for a Schema.Class instance, its
 * whole JSON body. Either is silently wrong and unqueryable — and naming the
 * ref object (`"umpire"`) instead of a scalar path (`"umpire.id"`) is the easy
 * mistake to make, precisely because the dotted path is the unfamiliar part.
 */
const isScalarComposite = (value: unknown): boolean => {
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return true
    case "object":
      return value instanceof Date || DateTime.isDateTime(value as DateTime.DateTime)
    default:
      return false
  }
}

/**
 * Sort-key composites for one element of a `many` edge.
 *
 * A declared `sk.composite` is AUTHORITATIVE — it replaces the ref-identifier
 * heuristic rather than extending it, so both the uniqueness and the ordering of
 * an edge's elements are the user's to state (#103). Without one, uniqueness is
 * bounded by the referenced entity's identifier and the same entity cannot appear
 * twice in one aggregate.
 *
 * Resolution never throws: a declared attribute that is missing or null is a
 * modelling error, reported as an {@link AggregateDecompositionError} naming the
 * edge and the attributes, not a defect escaping the decompose walk.
 */
const manyEdgeSkComposites = (
  node: ResolvedNode,
  attrs: Record<string, unknown>,
  aggregateName: string,
): Effect.Effect<ReadonlyArray<string>, AggregateDecompositionError> =>
  Effect.gen(function* () {
    const declared = node.skComposite
    if (declared === undefined) return extractRefIdentifiers(attrs, node.refIdentifierField)

    const values = declared.map((path) => readCompositePath(attrs, path))
    const missing = declared.filter((_, i) => values[i] == null)
    if (missing.length > 0) {
      return yield* new AggregateDecompositionError({
        aggregate: aggregateName,
        member: node.fieldName ?? node.entityType,
        reason:
          `sk.composite names ${missing.map((m) => `"${m}"`).join(", ")}, ` +
          `${missing.length === 1 ? "which is" : "which are"} missing from the element. ` +
          `A referenced entity's identifier is reachable by dotted path after hydration ` +
          `(e.g. "contact.contactId", not "contactId").`,
      })
    }
    const nonScalar = declared.filter((_, i) => !isScalarComposite(values[i]))
    if (nonScalar.length > 0) {
      return yield* new AggregateDecompositionError({
        aggregate: aggregateName,
        member: node.fieldName ?? node.entityType,
        reason:
          `sk.composite names ${nonScalar.map((m) => `"${m}"`).join(", ")}, ` +
          `${nonScalar.length === 1 ? "which resolves" : "which resolve"} to a non-scalar value. ` +
          `A sort key segment must be a string, number, bigint, boolean or date — name the ` +
          `attribute itself by dotted path (e.g. "umpire.id", not "umpire").`,
      })
    }

    return values.map((value) => KeyComposer.serializeValue(value))
  })

/**
 * Extract ref identifier values from an item's attributes for use as SK composites.
 * Walks fields looking for embedded objects that have an identifier-annotated field.
 *
 * A heuristic, and order-dependent: it takes each nested object's `id` (else its
 * first `*Id` key) in property order. Declaring `sk.composite` on the edge opts
 * out of it entirely — see {@link manyEdgeSkComposites}.
 */
const extractRefIdentifiers = (
  attrs: Record<string, unknown>,
  refIdentifierField?: string | undefined,
): ReadonlyArray<string> => {
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
  // Case 2: Element IS entity — the entity's own fields are flat, so there is no
  // nested object for case 1 to find. Prefer the edge entity's declared
  // `DynamoModel.identifier` field; fall back to a literal `id` for edges with no
  // entity. Without this an `Array(Player)` edge composes NO composites and every
  // element collapses onto one row (#103).
  if (ids.length === 0) {
    const declared = refIdentifierField !== undefined ? attrs[refIdentifierField] : undefined
    if (typeof declared === "string") ids.push(declared)
    else if (typeof attrs.id === "string") ids.push(attrs.id)
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

/** Resolved timestamp attribute names + storage for one aggregate. */
interface StampFields {
  readonly createdAt: string | null
  readonly createdEncoding: DynamoEncoding | null
  readonly updatedAt: string | null
  readonly updatedEncoding: DynamoEncoding | null
}

/** A single write's stamp: what to write, when, and what `created` to preserve. */
interface Stamp {
  readonly fields: StampFields
  readonly now: DateTime.Utc
  readonly existingCreated: ReadonlyMap<string, unknown>
}

const EMPTY_CREATED: ReadonlyMap<string, unknown> = new Map()

/**
 * Convert decomposed items into DynamoDB attribute maps with composed keys.
 *
 * `stamp` is applied HERE rather than in `decomposeAggregate` on purpose: update
 * diffs the decomposed groups (`deepEqualGroups`) to decide which sub-aggregate
 * transactions to rewrite, so a timestamp mixed into decomposition would differ
 * on every comparison and silently collapse the diff into a full-partition
 * rewrite on every update (#98).
 */
const buildDynamoItems = (
  groups: ReadonlyArray<TransactionGroup>,
  config: AggregateConfig<any>,
  pkValue: string,
  rootCollectionSkComposites: ReadonlyArray<string>,
  /**
   * The aggregate's composite key-form normaliser. Required, not optional: the
   * list-GSI keys composed below have to be spelled exactly as `Aggregate.list`
   * spells them when it reads, and the only way to guarantee that is for both
   * to go through the same function (#111).
   */
  keyRecord: (record: Record<string, unknown>) => Record<string, unknown>,
  stamp?: Stamp | undefined,
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

      // Collection SK mirror — only written when an index is actually provisioned.
      // Root items get the collection key; every other item's value is a verbatim copy
      // of its own `sk`. With no index there is nothing to sort, so the attribute is
      // omitted entirely rather than duplicating `sk` on every item.
      const isRootItem =
        item.entityType === config.root.entityType && item.skComposites.length === 0
      const collectionSk = config.collection.sk
      if (config.collection.index !== undefined && collectionSk !== undefined) {
        attrs[collectionSk.field] = isRootItem
          ? composeCollectionKey(config.schema, config.collection.name, rootCollectionSkComposites)
          : composeKey(config.schema, item.entityType, [...item.skComposites])
      }

      // List collection GSI keys (root items only)
      if (isRootItem && config.list) {
        const listPkComposites = KeyComposer.extractComposites(
          config.list.pk.composite,
          keyRecord(item.attributes),
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
          keyRecord(item.attributes),
        )
        attrs[config.list.sk.field] = composeCollectionKey(
          config.schema,
          config.list.name,
          listSkComposites,
        )
      }

      // System timestamps — last, so a generated value wins over the same-named
      // field propagated onto edge items via `context`.
      if (stamp) {
        const { existingCreated, fields, now } = stamp
        const sk = attrs.sk as string
        if (fields.createdAt !== null) {
          const prior = existingCreated.get(sk)
          attrs[fields.createdAt] = prior ?? generateTimestampPrimitive(now, fields.createdEncoding)
        }
        if (fields.updatedAt !== null) {
          attrs[fields.updatedAt] = generateTimestampPrimitive(now, fields.updatedEncoding)
        }
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
  groups: ReadonlyArray<{
    group: string
    puts: ReadonlyArray<Record<string, AttributeValue>>
    deletes: ReadonlyArray<Record<string, AttributeValue>>
  }>,
  aggregateName: string,
): Effect.Effect<void, AggregateTransactionOverflow | DynamoClientError | TransactionCancelled> =>
  Effect.gen(function* () {
    // Validate ALL group sizes BEFORE writing any group. Each group is its own
    // transaction (DynamoDB: 100 items per TransactWriteItems), and the per-group
    // count now spans Puts AND Deletes together — so an `update` that both adds and
    // removes many edges roughly doubles the count. Checking up front means an
    // oversized later group fails fast instead of partially committing earlier ones.
    for (const group of groups) {
      const itemCount = group.puts.length + group.deletes.length
      if (itemCount > 100) {
        return yield* new AggregateTransactionOverflow({
          aggregate: aggregateName,
          subgraph: group.group,
          itemCount,
          limit: 100,
        })
      }
    }

    for (const group of groups) {
      // Each group is one transaction — Puts AND Deletes applied atomically, so an
      // edge add and a sibling edge removal in the same sub-aggregate commit together.
      const itemCount = group.puts.length + group.deletes.length
      if (itemCount === 0) continue

      // Build TransactWriteItems request — Puts first, then Deletes for orphans.
      const transactItems = [
        ...group.puts.map((item) => ({ Put: { TableName: tableName, Item: item } })),
        ...group.deletes.map((key) => ({ Delete: { TableName: tableName, Key: key } })),
      ]

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
// Internal: list filter compilation
// ---------------------------------------------------------------------------

/**
 * @internal Compile a {@link ListFilter} to a `FilterExpression` fragment.
 *
 * Both forms route through the same `Expr` compiler `BoundQuery.filter()` uses,
 * so `{ status: "shipped" }` and `(t, { eq }) => eq(t.status, "shipped")` mean
 * the same thing here as they do on an entity query. A shorthand with no
 * entries compiles to the empty string — that is a no-op, not `FilterExpression: ""`,
 * which DynamoDB rejects.
 */
const compileListFilter = <Model>(
  filter: ListFilter<Model> | undefined,
): CompileResult | undefined => {
  if (filter === undefined) return undefined
  const expr =
    typeof filter === "function"
      ? filter(
          createPathBuilder<Model>() as PathBuilder<Model, Model, never>,
          createConditionOps<Model>(),
        )
      : parseSimpleShorthand(filter)
  const compiled = compileExpr(expr)
  return compiled.expression === "" ? undefined : compiled
}

// ---------------------------------------------------------------------------
// Internal: Query a single list collection GSI partition (paginated)
// ---------------------------------------------------------------------------

interface ListPartitionResult {
  readonly items: Array<Record<string, unknown>>
  /**
   * Where the next page resumes, or `undefined` when the key range genuinely
   * ended. NOT always the response's `LastEvaluatedKey`: once a filtered request
   * over-reads and the surplus is dropped, this is rebuilt from the last item
   * actually returned, so the caller resumes after what it saw.
   */
  readonly lastKey: Record<string, AttributeValue> | undefined
}

interface ListPartitionOptions {
  /** Composed GSI partition key value. */
  readonly pkValue: string
  /** Serialized SK composites forming a `begins_with` prefix (may be empty). */
  readonly skValues: ReadonlyArray<string>
  /** At most this many items — accumulated across requests, filter or not. */
  readonly limit?: number | undefined
  /** DynamoDB `Limit` per request (rows examined). */
  readonly pageSize?: number | undefined
  readonly startKey?: Record<string, AttributeValue> | undefined
  readonly filter?: CompileResult | undefined
  readonly reverse?: boolean | undefined
  /** Attribute names forming a resume key, when there is no LastEvaluatedKey. */
  readonly keyFields: ReadonlyArray<string>
}

/**
 * @internal DynamoDB `Limit` for the next request — the same rule `Query.ts`
 * applies, and for the same reason: `Limit` bounds rows EXAMINED, and a
 * `FilterExpression` runs after, so under a filter `limit` cannot be expressed
 * as `Limit` at all. `pageSize` (or, unset, a natural 1 MB page) is the budget
 * then, and the loop keeps asking until the page fills.
 */
const listRequestLimit = (
  options: ListPartitionOptions,
  remaining: number | undefined,
): number | undefined => {
  if (remaining === undefined) return options.pageSize
  if (options.filter !== undefined) return options.pageSize
  return options.pageSize === undefined ? remaining : Math.min(options.pageSize, remaining)
}

/**
 * @internal Rebuild a resume key from an item the query returned. Every item
 * carries its table key and index key as ordinary attributes, so any item can
 * address itself. Returns `undefined` if a name is missing.
 */
const listKeyFromItem = (
  item: Record<string, AttributeValue>,
  names: ReadonlyArray<string>,
): Record<string, AttributeValue> | undefined => {
  if (names.length === 0) return undefined
  const key: Record<string, AttributeValue> = {}
  for (const name of names) {
    const value = item[name]
    if (value === undefined) return undefined
    key[name] = value
  }
  return key
}

const queryListPartition = (
  client: DynamoClientService,
  tableConfig: TableConfig,
  listConfig: ListCollectionConfig,
  schema: DynamoSchemaModule.DynamoSchema,
  options: ListPartitionOptions,
): Effect.Effect<ListPartitionResult, DynamoClientError> =>
  Effect.gen(function* () {
    const { filter, limit, pkValue, skValues } = options

    const exprNames: Record<string, string> = { "#pk": listConfig.pk.field }
    const exprValues: Record<string, AttributeValue> = { ":pk": toAttributeValue(pkValue) }
    let keyCondition = "#pk = :pk"

    if (skValues.length > 0) {
      const skPrefix = composeCollectionKey(schema, listConfig.name, skValues)
      exprNames["#sk"] = listConfig.sk.field
      exprValues[":skPrefix"] = toAttributeValue(skPrefix)
      keyCondition += " AND begins_with(#sk, :skPrefix)"
    }

    if (filter !== undefined) {
      Object.assign(exprNames, filter.names)
      Object.assign(exprValues, filter.values)
    }

    if (limit !== undefined && limit <= 0) return { items: [], lastKey: undefined }

    const items: Array<Record<string, unknown>> = []
    let startKey = options.startKey
    let lastKey: Record<string, AttributeValue> | undefined

    for (;;) {
      const remaining = limit === undefined ? undefined : limit - items.length
      const requestLimit = listRequestLimit(options, remaining)
      const result = yield* client.query({
        TableName: tableConfig.name,
        IndexName: listConfig.index,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ExclusiveStartKey: startKey,
        ...(filter !== undefined ? { FilterExpression: filter.expression } : {}),
        ...(requestLimit !== undefined ? { Limit: requestLimit } : {}),
        ...(options.reverse === true ? { ScanIndexForward: false } : {}),
      })

      const returned = (result.Items ?? []) as Array<Record<string, AttributeValue>>
      const lastEvaluatedKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined
      const take = remaining === undefined ? returned.length : Math.min(remaining, returned.length)

      for (let i = 0; i < take; i++) items.push(fromAttributeMap(returned[i]!))

      // Over-read — a filtered request returns whatever survives the filter, not
      // `Limit` rows. The surplus is dropped, so `LastEvaluatedKey` (the last row
      // EXAMINED) would skip past items the caller never saw. Resume from the
      // last item actually handed back instead.
      if (take < returned.length) {
        lastKey =
          listKeyFromItem(
            returned[take - 1]!,
            lastEvaluatedKey != null ? Object.keys(lastEvaluatedKey) : options.keyFields,
          ) ?? lastEvaluatedKey
        break
      }

      const exhausted = lastEvaluatedKey == null
      const limitReached = limit !== undefined && items.length >= limit

      if (exhausted || limitReached) {
        lastKey = lastEvaluatedKey
        break
      }

      startKey = lastEvaluatedKey
    }

    return { items, lastKey }
  })
