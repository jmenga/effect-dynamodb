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

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { TypeId as SchemaAggregateTypeId } from "@effect-dynamodb/schema/Aggregate.js"
import type { DynamoEncoding } from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import type * as DynamoSchemaModule from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  composeCollectionKey,
  composeKey,
  composeUniqueKey,
  KEY_DELIMITER,
} from "@effect-dynamodb/schema/DynamoSchema.js"
import type { EntityDefinition } from "@effect-dynamodb/schema/Entity.js"
import {
  AggregateAssemblyError,
  AggregateDecompositionError,
  AggregateTransactionOverflow,
  ConditionalCheckFailed,
  DynamoError,
  DynamoValidationError,
  type ItemNotFound,
  isAwsTransactionCancelled,
  RefNotFound,
  TRANSACT_WRITE_ITEMS_LIMIT,
  TransactionCancelled,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import {
  fieldAtPath,
  type KindTargets,
  kindReadingOf,
  kindTargets,
  makeCompositeKeyForm,
  readBackAs,
  readBackUnsure,
  readsBackOtherwise,
  refuseInexact,
  toCompositeKeyRecord,
} from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import type { TimestampsConfig } from "@effect-dynamodb/schema/internal/EntityConfig.js"
import {
  buildDateTransform,
  containsWireTransform,
  type DeepSubstitutionOptions,
  matchDateRepresentation,
  optionalField,
  substituteSchemaDeep,
  validateNoTransformOverride,
} from "@effect-dynamodb/schema/internal/EntitySchemas.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import { KeyValueError } from "@effect-dynamodb/schema/internal/NumericKey.js"
import { isDispatchEligible } from "@effect-dynamodb/schema/internal/PackedCodec.js"
import {
  extractArrayElement,
  extractKeyedValue,
  getSchemaFields,
  hasEncodingTransformation,
  holdsCustomDeclaration,
  refuseUnreadable,
} from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import { refuseAggregateKeyInTableKey } from "@effect-dynamodb/schema/internal/SharedKeyAttribute.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import {
  type Context,
  DateTime,
  Effect,
  Equal,
  type Optic,
  Option,
  Schema,
  SchemaAST,
} from "effect"
import * as Batch from "./Batch.js"
import type { DynamoClient, DynamoClientError, DynamoClientService } from "./DynamoClient.js"
import { type EntityGet, fromDefinition as entityFromDefinition } from "./Entity.js"
import * as Capacity from "./internal/Capacity.js"
import { decodeKeyCursor, encodeKeyCursor } from "./internal/Cursor.js"
import {
  type CompileResult,
  type ConditionOps,
  type ConditionShorthand,
  compileExpr,
  createConditionOps,
  type Expr,
  emptyPartProblem,
  isEmptyExpr,
  parseSimpleShorthand,
} from "./internal/Expr.js"
import { asReadGuard } from "./internal/ExpressionLimits.js"
import { packRequests, transactWriteShape, transactWriteUnit } from "./internal/ItemSize.js"
import { hasStoredForm, packItemSync, unpackItemSync, withRegistry } from "./internal/Packed.js"
import { createPathBuilder, type PathBuilder } from "./internal/PathBuilder.js"
import * as Rekey from "./internal/Rekey.js"
import { asRead, notReadBack, notStoredForm, readBackRefusal } from "./internal/RoundTrip.js"
import {
  generateTimestampPrimitive,
  INCARNATION_TOKEN,
  KEY_TEXT,
  marshalOrFail,
  OUTBOX_CLAIM,
  OUTBOX_CLAIMED_UNTIL,
  OUTBOX_ROW_PK,
  OUTBOX_ROW_SK,
} from "./internal/TransactableOps.js"
import {
  type Diagnosis,
  diagnosedValidationError,
  diagnoseFailure,
  explainDiagnosis,
  type KeyAttributes,
  mergeKeyAttributes,
  transactItemTarget,
  withCause,
} from "./internal/WriteDiagnosis.js"
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
  type OneEdgeConfig,
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
  isFieldOptional,
  manyEdgePaths,
  manyElementFields,
  refuseAggregateKeyOverMovingValue,
  refuseAggregateKeysOverBothKinds,
  refuseManySortKeysOverMovingValue,
  resolveAggregateStamps,
  unwrapModel,
} from "@effect-dynamodb/schema/internal/AggregateSchemas.js"
import type {
  AggregateEdgesConfig,
  AggregateEdgesGuard,
  AggregateInputType,
  AggregateStampNames,
  BoundSubAggregate,
  SubAggregate,
} from "@effect-dynamodb/schema/internal/AggregateTypes.js"
import type { ModelFieldName } from "@effect-dynamodb/schema/internal/EntityTypes.js"

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
  /** The fields of the value this node's rows hold: what they declare. */
  readonly ownFields?: Record<string, Schema.Top> | undefined
  /** What this node's rows do with each timestamp. Undefined without `timestamps`. */
  readonly rowStamps?: RowStamps | undefined
  /**
   * Edge attributes stored packed (#147): the edge entity's
   * `storedAs: DynamoModel.Packed` fields that are top-level attributes of this
   * node's items (a `one` edge's flattened entity, a `many` edge element that
   * IS the entity). Packed on write, read by stored form on read.
   */
  readonly packed?: Readonly<Record<string, DynamoModel.PackedConfig>> | undefined
  /**
   * The attributes of this node's items read by their stored form (#147): every
   * packed one, plus every object- or array-shaped field of the edge entity's
   * item. A value stored packed while the entity configured it so still reads
   * after packing is turned off — readers dispatch on the stored value, not the
   * current config.
   */
  readonly dispatch?: ReadonlyArray<string> | undefined
  readonly cardinality: "root" | "one" | "many"
  readonly discriminator?: Record<string, unknown>
  readonly ownDiscriminator?: Record<string, unknown>
  readonly children: ReadonlyArray<ResolvedNode>
  readonly assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  readonly decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined
  /**
   * `many` edges with a custom `decompose` only: the value that `decompose` is handed on a write,
   * the caller's own value read as 1.39.0 read it (see {@link storedFormFirst}). Undefined where
   * that's the value itself.
   */
  readonly decomposeInput?: ((written: Written) => Option.Option<unknown>) | undefined
  /**
   * Per-attribute encoders for this node's items, applied on the WRITE path
   * (decompose) so every value with a wire form — a date, a transformed scalar,
   * or a container or hydrated ref holding one — is put into it before
   * marshalling (#72, #133). Built from the schema the decomposed values
   * actually have: a `many` edge's array ELEMENT, a `one` edge's entity model, a
   * sub-aggregate's own schema. Undefined for the root, whose attributes are
   * encoded directly by `decomposeAggregate`.
   */
  readonly attrEncoders?: AttrEncoders | undefined
  /**
   * `many` edges only: the encoders whose output the edge's sort-key composites
   * are read from. These are the pre-#133 encoders, kept separate from
   * {@link attrEncoders} so that putting a nested value into its wire form can
   * never change a composed key (see {@link buildKeyAttrEncoders}).
   */
  readonly keyAttrEncoders?: Record<string, (value: unknown) => unknown> | undefined
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
  /**
   * Opaque cursor from a previous list call to resume pagination. One that
   * can't be decoded fails with a `ValidationError` (`[EDD-9094]`,
   * `operation: "list"`); nothing is sent.
   */
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
  /**
   * **Client-side** predicate on the root item, evaluated inside the same
   * accumulate loop `limit` uses — so a page still fills to `limit` and the
   * cursor still resumes after the last aggregate kept (#122). Filtering the
   * returned `data` instead breaks both: the page comes back short, and its
   * cursor points past aggregates the caller never saw.
   *
   * It runs **before assembly**, for the same reason {@link ListOptions.filter}
   * is worth pushing server-side: a rejected root item never pays for its
   * partition read. That is also why it receives the root item as **stored** —
   * DynamoDB attribute names, wire-form values — rather than the assembled
   * aggregate, which does not exist yet at that point.
   *
   * Prefer {@link ListOptions.filter} whenever DynamoDB can express the
   * condition; a `FilterExpression` rejects rows before they cross the wire.
   * Reach for this when it cannot — case-insensitive matching being the usual
   * case, since DynamoDB has no `lower()`:
   *
   * ```ts
   * list(key, { filterBy: (root) => String(root.name).toLowerCase().startsWith("mel") })
   * ```
   */
  readonly filterBy?: (rootItem: Record<string, unknown>) => boolean
  /** Walk the list index in descending order (`ScanIndexForward: false`). */
  readonly reverse?: boolean
}

/** Result of a paginated list query */
export interface ListResult<T> {
  /** The assembled aggregates for this page */
  readonly data: Array<T>
  /**
   * Opaque cursor for the next page — pass it as `list({ cursor })` — or
   * `None` when there are no more results.
   */
  readonly cursor: Option.Option<string>
}

// ---------------------------------------------------------------------------
// Aggregate interface
// ---------------------------------------------------------------------------

/** Error union for aggregate write operations */
export type AggregateWriteError =
  | AggregateAssemblyError
  | AggregateDecompositionError
  | AggregateTransactionOverflow
  | DynamoClientError
  | ValidationError
  | RefNotFound
  | ItemNotFound
  | TransactionCancelled

/**
 * `create`'s errors: a write's, plus `ConditionalCheckFailed` when the
 * aggregate's root item already exists (#134).
 */
export type AggregateCreateError = AggregateWriteError | ConditionalCheckFailed

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

  /**
   * @internal The packed attributes of each edge entity type's items (stored
   * name → config). `DynamoClient.make()` checks the codecs they name against
   * the registry it binds with (`[EDD-9078]`).
   */
  readonly _packedByType?: ReadonlyMap<string, Readonly<Record<string, DynamoModel.PackedConfig>>>

  /** @internal Whether the aggregate declares `ownsRows`. */
  readonly _ownsRows?: boolean

  /**
   * @internal The attributes this aggregate writes on its rows: what an aggregate declaring
   * `ownsRows` checks at bind (DESIGN.md §7 "Which rows in its partition are an aggregate's").
   */
  readonly _attributeWriters?: ReadonlyArray<AttributeWriter>

  /** @internal What `DynamoClient.make` checks this aggregate's `ownsRows` against. */
  readonly _ownership?: Ownership

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
  ) => Effect.Effect<Schema.Schema.Type<TSchema>, AggregateCreateError, DynamoClient | TableConfig>

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
   * for the next page. Without `limit`, returns all matching aggregates. A
   * cursor that can't be decoded fails with `EDD-9094`.
   *
   * `options.filter` adds a server-side `FilterExpression` to the root-item
   * query; `limit` still means "this many aggregates", the loop accumulating
   * across requests until the page fills or the key range ends. A `None` cursor
   * means genuinely exhausted.
   *
   * On a **sharded** list (`list.cardinality`) `limit` bounds the merged result
   * but there is no resumable position across shards, so `cursor` is always
   * `None` and passing one fails with `EDD-9051`.
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
  ) => Effect.Effect<Schema.Schema.Type<TSchema>, AggregateCreateError, never>

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

/** `F`: the aggregate schema's fields, which the composites name. */
interface CollectionConfig<F extends string = string> {
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
    readonly composite: ReadonlyArray<F>
  }
}

interface ListCollectionConfig<F extends string = string> extends CollectionConfig<F> {
  /** The list index is always a GSI — it has its own partition key. */
  readonly index: string
  readonly sk: {
    readonly field: string
    readonly composite: ReadonlyArray<F>
  }
  readonly pk: {
    readonly field: string
    readonly composite: ReadonlyArray<F>
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
  readonly collection: CollectionConfig<ModelFieldName<_TSchema>>
  readonly list?: ListCollectionConfig<ModelFieldName<_TSchema>>
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
   * `collection.index`) or an LSI. DynamoDB rejects consistent reads against a GSI; with
   * a GSI collection index, each assembly read fails with that rejection, named for the
   * aggregate and the index (a `ValidationError`, `operation: "<op>.consistentRead"`;
   * `delete`'s read keeps DynamoDB's `DynamoValidationError` tag). It is not refused at
   * `make()` time (#144).
   */
  readonly consistentRead?: boolean
  /** Aggregate fields whose change rewrites every edge group. */
  readonly context?: ReadonlyArray<ModelFieldName<_TSchema>>
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
  /**
   * Every row of this aggregate's entity types (its root's, its edges', its sub-aggregates') in its
   * partition is its own (DESIGN.md §7 "Which rows in its partition are an aggregate's"). Off by
   * default: `update` deletes and `rekey` moves only the rows the aggregate's value keys, as 1.39.0
   * did, and a row a custom `decompose` left under a key it no longer composes stays.
   *
   * With it, after its transactions `update` also deletes every other row it read of each node that
   * changed and that the new state doesn't write, in requests of its own (each Delete conditioned
   * on the row being gone or still of the type read). `rekey` moves what it moves without it, and
   * reports any other row of its types: `failed` when the row's own partition key changes,
   * `unrecognizedKey` otherwise. `DynamoClient.make` refuses the aggregate (`EDD-9130`) when another
   * member it can see can write a row of one of its types into its partition; a writer it doesn't
   * bind, here or in another process, isn't seen.
   */
  readonly ownsRows?: boolean
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
// The top-level form comes first: an editor completing a config takes its
// contextual type from the first overload, and the top-level form is the one
// whose `pk`, `collection`, `list` and `context` name schema fields.
export function make<
  TSchema extends Schema.Top,
  const TEdges extends AggregateEdgesConfig<TSchema>,
  const TPK extends ReadonlyArray<ModelFieldName<TSchema>>,
  const TTimestamps extends TimestampsConfig | undefined = undefined,
>(
  schema: TSchema,
  config: AggregateConfig<TSchema, TEdges, TPK> & {
    readonly edges: AggregateEdgesGuard<TSchema, TEdges>
    readonly timestamps?: TTimestamps
  },
): Aggregate<
  TSchema,
  Record<string, unknown>,
  AggregateInputType<
    Schema.Schema.Type<TSchema>,
    TEdges,
    TPK,
    AggregateStampNames<Schema.Schema.Type<TSchema>, TTimestamps>
  >
>
export function make<
  TSchema extends Schema.Top,
  const TEdges extends AggregateEdgesConfig<TSchema>,
>(
  schema: TSchema,
  // The top-level form's keys, refused here, so an error in a top-level config
  // is reported against the top-level overload (it fails this one on each key).
  config: SubAggregateConfig<TEdges> & {
    readonly edges: AggregateEdgesGuard<TSchema, TEdges>
    readonly table?: undefined
    readonly schema?: undefined
    readonly pk?: undefined
    readonly collection?: undefined
  },
): SubAggregate<TSchema, TEdges>
export function make<TSchema extends Schema.Top>(
  schema: TSchema,
  config: SubAggregateConfig | AggregateConfig<TSchema>,
): SubAggregate<TSchema> | Aggregate<TSchema, Record<string, unknown>> {
  refuseUnreadable(`Aggregate "${config.root.entityType}"`, "aggregate", unwrapModel(schema), {
    manyEdges: manyEdgePaths(config.edges),
  })
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
 * The date encodings a schema AST holds, handling Schema.optional() wrappers: one, or one per date
 * member of a union, in the order they're declared.
 * Optional fields have Union AST with [InnerType, Undefined] — unwrap to find dates.
 */
const inferDateEncodings = (ast: Schema.Top["ast"]): ReadonlyArray<DynamoEncoding> => {
  // Try SchemaAST.resolve first (works for non-optional date fields)
  const resolved = SchemaAST.resolve(ast) as ASTNode | undefined
  if (resolved) {
    const direct = matchDateRepresentation(resolved)
    if (direct) return [direct]
  }
  // Handle optional wrapper: Union with Undefined + inner type.
  // SchemaAST.resolve returns undefined for Union ASTs, so check the raw AST.
  const rawAst = ast as unknown as ASTNode
  if (rawAst._tag !== "Union" || !rawAst.types) return []
  return rawAst.types.flatMap((member) => {
    if (member._tag === "Undefined") return []
    // Try SchemaAST.resolve on the inner member (e.g., Declaration for Schema.Date)
    const memberResolved = SchemaAST.resolve(member as unknown as Schema.Top["ast"]) as
      | ASTNode
      | undefined
    // Fallback: check raw member annotations (same record shape, nested under .annotations)
    const encoding =
      (memberResolved ? matchDateRepresentation(memberResolved) : undefined) ??
      matchDateRepresentation(member.annotations)
    return encoding ? [encoding] : []
  })
}

/**
 * A union that holds a date member alongside a member that is neither a date
 * nor `Undefined` / `Null` — `Union([DateTimeUtcFromString, Number])`.
 * `inferDateEncodings` looks through unions to find the date in `optional(date)`,
 * so it reports such a field as a date, and encoding a `5` through a date
 * transform throws. Its stored form is the union's own business: it is encoded
 * member by member through the substituted union instead.
 */
const isMixedDateUnion = (ast: Schema.Top["ast"]): boolean => {
  if (!SchemaAST.isUnion(ast)) return false
  const isDate = (member: SchemaAST.AST): boolean =>
    matchDateRepresentation(SchemaAST.resolve(member) as Record<string, unknown> | undefined) !==
      undefined ||
    matchDateRepresentation(member.annotations as Record<string, unknown> | undefined) !== undefined
  return ast.types.some(
    (member) => !SchemaAST.isUndefined(member) && !SchemaAST.isNull(member) && !isDate(member),
  )
}

/** Resolves a ref field (by schema identity) to the model it should be read as. */
type RefResolver = (name: string, field: Schema.Top) => Schema.Top | undefined

/**
 * A field's attribute encoder. A value it can't put in its stored form is stored as given, and
 * `asGiven` is told, so that the write can refuse it when it wouldn't read back (`EDD-9127`).
 */
type AttrEncoder = (value: unknown, asGiven?: () => void) => unknown

type AttrEncoders = Record<string, AttrEncoder>

/**
 * The date branch shared by both encoder builders: an explicit
 * `DynamoModel.storedAs` annotation, or the inferred default for a standard
 * Effect date schema. It wins over the field's own encode because `storedAs` is
 * precisely an override of it (a `Schema.DateTimeUtc` field marked
 * `storedAs(DateEpochMs)` must store the epoch, not the ISO string its own schema
 * would produce).
 */
const dateAttrEncoder = (
  fieldSchema: Schema.Top,
  options?: { readonly mixedUnions?: boolean },
): ((value: unknown) => unknown) | undefined => {
  if (options?.mixedUnions !== true && isMixedDateUnion(fieldSchema.ast)) return undefined
  const explicit = DynamoModel.getEncoding(fieldSchema)
  const encodings = explicit ? [explicit] : inferDateEncodings(fieldSchema.ast)
  const last = encodings.at(-1)
  if (!last) return undefined
  // A union of dates of different kinds: a value is stored in the form of the kind it is.
  const earlier = encodings
    .slice(0, -1)
    .map((encoding) =>
      Schema.encodeUnknownOption(buildDateTransform(encoding) as Schema.Codec<any>),
    )
  const encode = Schema.encodeUnknownSync(buildDateTransform(last) as Schema.Codec<any>)
  return (value) => {
    for (const encodeEarlier of earlier) {
      const encoded = encodeEarlier(value)
      if (Option.isSome(encoded)) return encoded.value
    }
    return encode(value)
  }
}

/** Whether a value is a date field's stored form: one its date encodings decode. */
const storedDateForm = (fieldSchema: Schema.Top): ((value: unknown) => boolean) => {
  const explicit = DynamoModel.getEncoding(fieldSchema)
  const decoders = (explicit ? [explicit] : inferDateEncodings(fieldSchema.ast)).map((encoding) =>
    Schema.decodeUnknownOption(buildDateTransform(encoding) as Schema.Codec<any>),
  )
  return (value) => decoders.some((decode) => Option.isSome(decode(value)))
}

/**
 * The field's own encode, with `decode -> encode` as the fallback so a caller
 * who already supplied wire form round-trips to itself (the same strategy
 * `Entity.put` uses). `None` when neither works: the value is neither Type nor
 * Encoded for this field, and what's stored is the caller's to decide.
 */
const ownAttrEncoder = (fieldSchema: Schema.Top): ((value: unknown) => Option.Option<unknown>) => {
  const codec = fieldSchema as unknown as Schema.Codec<any>
  const encode = Schema.encodeUnknownOption(codec)
  const decode = Schema.decodeUnknownOption(codec)
  return (value) => {
    const direct = encode(value)
    if (Option.isSome(direct)) return direct
    return Option.flatMap(decode(value), encode)
  }
}

/**
 * A write's own value at one place in the aggregate, as the caller gave it: `create`'s input, or the
 * state `update`'s mutation returned, before either is decoded. `present` is false where the
 * caller left the field out.
 */
interface Written {
  readonly present: boolean
  readonly value: unknown
  /** `update`'s new state, which holds what a mutation's plain state holds. */
  readonly update: boolean
}

/**
 * Whether a caller's object holds `field`: as its own property or one its class gives it (a
 * getter, a prototype's property), as `in` says, but never as a member every object inherits
 * (`toString`, `constructor`).
 */
const holdsField = (holder: object, field: string): boolean => {
  for (
    let at: object | null = holder;
    at !== null && at !== Object.prototype;
    at = Object.getPrototypeOf(at)
  ) {
    if (Object.hasOwn(at, field)) return true
  }
  return false
}

/** The caller's value of `field`, under `written`. */
const writtenField = (written: Written | undefined, field: string): Written | undefined => {
  if (written === undefined) return undefined
  const holder = written.present ? written.value : undefined
  const present = holder !== null && typeof holder === "object" && holdsField(holder, field)
  return {
    present,
    value: present ? (holder as Record<string, unknown>)[field] : undefined,
    update: written.update,
  }
}

/**
 * What a `many` edge's custom `decompose` is handed on a write: the caller's own value of the edge
 * read stored form first, once, as 1.39.0 read every write's input. A write's value is otherwise
 * taken as the domain value a caller holds, but a `decompose` written for 1.39.0 was handed this,
 * and what it returns is stored and keyed as it is: handed the domain value instead, a `decompose`
 * that returns a field's stored form (`f / 10` on a field that multiplies by 10) has that encoded
 * once more, its sort key moves, and every `update` compounds the value and adds a row. Handed
 * this, its rows store, key and read exactly as on 1.39.0, and an `update` of a row 1.39.0 wrote
 * finds it. A `decompose` that hands such a field back unchanged stores it decoded once more, as
 * on 1.39.0.
 *
 * It reads what the caller gave, never the value the write already decoded: read again, a decoding
 * default (`5`, read as 50) or a stored form the domain side refuses (`"5"`, read as 50) would be
 * decoded twice, to 500. Only a transformation with one type on both sides reads differently, and
 * a class whose fields hold none reads as given, so undefined when the field holds no
 * transformation beneath its classes: nothing is read again. What was read (update's old state,
 * `rekey`) is handed to `decompose` as it was read, as 1.39.0 did. None where the caller's value
 * doesn't read, and `decompose` is handed the decoded value.
 */
const storedFormFirst = (
  field: string,
  fieldSchema: Schema.Top | undefined,
  resolveRef: RefResolver | undefined,
): ((written: Written) => Option.Option<unknown>) | undefined => {
  if (fieldSchema === undefined || !containsWireTransform(fieldSchema, { throughClasses: true })) {
    return undefined
  }
  const reader = (update: boolean) =>
    Schema.decodeUnknownOption(
      substituteSchemaDeep(Schema.Struct({ [field]: fieldSchema }), {
        tolerantTransforms: true,
        decodeOnly: true,
        resolveRef,
        // A mutation's plain state holds a set as a list and an `Option` as a tagged object.
        ...(update && { plainStateForms: true }),
      }) as unknown as Schema.Codec<any>,
    )
  const readers: { create?: ReturnType<typeof reader>; update?: ReturnType<typeof reader> } = {}
  return (written) => {
    const which = written.update ? "update" : "create"
    const read = readers[which] ?? reader(written.update)
    readers[which] = read
    return Option.map(
      read(written.present ? { [field]: written.value } : {}),
      (asRead) => (asRead as Record<string, unknown>)[field],
    )
  }
}

/**
 * Build per-field ATTRIBUTE encoders for a schema's own fields — the write-side
 * equivalent of what `Entity.put` gets for free by encoding its whole input
 * through `inputSchema`.
 *
 * Decomposition works from the schema-DECODED domain object, so every attribute
 * it produces is a Type-side value. Marshalling those directly stores a shape
 * the read path cannot decode: a `DateTime` lands as a marshalled
 * `{ epochMilliseconds, "~effect/DateTime", _tag }` map, a `Date` as `{M:{}}`,
 * a `bigint` as `{N:"5"}`.
 *
 * Exactly ONE encoder per field, so nothing is ever encoded twice:
 *
 * 1. **A date encoding** — see {@link dateAttrEncoder}. With `storedDates`, a value already in
 *    the field's stored form is stored as it is ({@link storedDateForm}).
 * 2. **Anything that holds a wire transform AT ANY DEPTH** — a leaf transform, a
 *    `Schema.Class`, and also an `Array` / `Struct` / `Union` containing one, or
 *    a self date or `Redacted` nested anywhere ({@link containsWireTransform}).
 *    The attribute is encoded through the SAME substituted, tolerant schema the
 *    read path decodes it with (`substituteSchemaDeep` under
 *    `tolerantTransforms`, with the aggregate's ref resolver), so the stored
 *    form is exactly what assembly reads back — nested date leaves included —
 *    and a `DynamoModel.ref`-annotated field is encoded through the ref
 *    target's model. The field's own encode is the fallback. A value none of
 *    them takes is stored as given, and reported through `asGiven`: the write
 *    then stores it only if its rows read back (`refuseNotReadBack`,
 *    `EDD-9127`). A schema that can't encode a value it decodes to, such as a
 *    transformation over itself, gets here with every value a caller holds.
 *
 *    Gating on the TOP-LEVEL node instead (as before #133) skipped every
 *    container, because an `Arrays` / `Objects` node carries no encoding of its
 *    own: `Schema.Array(DateTimeUtcFromString)` and `Schema.Array(SomeClass)`
 *    attributes stored their `DateTime`s as maps.
 * 3. **Nothing to encode** — no encoder at all, so the stored bytes are
 *    identical to before this existed.
 *
 * Encoding stays PER ATTRIBUTE: decomposition and key composition need the
 * Type-side values (`numericTypeWithStringEncoding`), so the aggregate is never
 * encoded as a whole before it is decomposed.
 */
const buildAttrEncoders = (
  fields: Record<string, Schema.Top> | undefined,
  resolveRef?: RefResolver | undefined,
  /**
   * A keyed (`Schema.Record`) `many` edge without an `entity` only: 1.39.0 gave it no encoders, so
   * it stored a date its custom `decompose` returned in the field's stored form as it was.
   */
  storedDates = false,
): AttrEncoders => {
  const encoders: AttrEncoders = {}
  if (!fields) return encoders

  for (const field of Object.keys(fields)) {
    const fieldSchema = fields[field]!

    // 1. Date encoding. With `storedDates`, a value already in the field's stored form (a custom
    //    `decompose` that returns the ISO text of a `DateTimeUtcFromString`) is stored as it is, as
    //    1.39.0 stored it there; anything else is stored as given, and the write refuses it unless
    //    it reads back. Elsewhere a value the encoding doesn't take fails the write, as on 1.39.0.
    const date = dateAttrEncoder(fieldSchema)
    if (date && !storedDates) {
      encoders[field] = date
      continue
    }
    if (date) {
      const stored = storedDateForm(fieldSchema)
      encoders[field] = (value, asGiven) => {
        try {
          return date(value)
        } catch {
          if (!stored(value)) asGiven?.()
          return value
        }
      }
      continue
    }

    // 3. Nothing anywhere in the value has a wire form distinct from its domain form.
    if (!containsWireTransform(fieldSchema)) continue

    // 2. Encode through the read path's own (substituted, tolerant) schema. A
    //    one-field struct carries the field's optionality and lets `resolveRef`
    //    re-point the field itself, exactly as it does inside `decodeSchema`.
    const encoderOver = (options: DeepSubstitutionOptions) => {
      const encode = Schema.encodeUnknownOption(
        substituteSchemaDeep(Schema.Struct({ [field]: fieldSchema }), {
          ...options,
          tolerantTransforms: true,
          resolveRef,
        }) as unknown as Schema.Codec<any>,
      )
      return (value: unknown) => {
        const encoded = encode({ [field]: value })
        return Option.isSome(encoded)
          ? Option.some((encoded.value as Record<string, unknown>)[field])
          : Option.none()
      }
    }
    const encodeSubstituted = encoderOver({})
    // A read reaches beneath a decoding default and this doesn't, and what it takes there isn't
    // always what the field's own schema takes: a redacted value of another label. What's stored
    // is the first's; this only keeps such a value from being marshalled as it is.
    const encodeAsRead = encoderOver({ decodeOnly: true })
    const own = ownAttrEncoder(fieldSchema)
    encoders[field] = (value, asGiven) =>
      encodeSubstituted(value).pipe(
        Option.orElse(() => encodeAsRead(value)),
        Option.orElse(() => own(value)),
        Option.getOrElse(() => {
          asGiven?.()
          return value
        }),
      )
  }
  return encoders
}

/**
 * The encoders sort-key composites are READ from — the encoders as they stood
 * before #133, gated on the field's TOP-LEVEL encoding.
 *
 * A `many` edge's declared `sk.composite` (and a root list index's composites)
 * are read off the item's attributes. Those attributes used to be encoded by
 * these encoders only, so the stored keys were composed from their output: a
 * top-level transformed field from its encoded form, anything nested (a
 * `DateTime` or `NumberFromString` reached through `"umpire.dateOfBirth"`) from
 * its domain form. Composing keys from the new, deeper encoders instead would
 * re-spell those keys — orphaning every stored row and making `update` diff
 * against keys that do not exist. Keys therefore keep this exact behaviour,
 * and only the STORED attribute values gain the deeper encoding.
 */
const buildKeyAttrEncoders = (fields: Record<string, Schema.Top> | undefined): AttrEncoders => {
  const encoders: AttrEncoders = {}
  if (!fields) return encoders
  for (const field of Object.keys(fields)) {
    const fieldSchema = fields[field]!
    const date = dateAttrEncoder(fieldSchema, { mixedUnions: true })
    if (date) {
      // Before, a value this encoder rejects (the `5` of a mixed date union)
      // threw and failed the write, so there is no stored key to stay
      // byte-identical with: compose from the value as it is.
      encoders[field] = (value) => {
        try {
          return date(value)
        } catch {
          return value
        }
      }
    } else if (hasEncodingTransformation(fieldSchema)) {
      // A key composed from a value no encoder takes is composed from the value as it is.
      const own = ownAttrEncoder(fieldSchema)
      encoders[field] = (value) => Option.getOrElse(own(value), () => value)
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

/** The value schema of a struct field, with any `optionalKey` / `optional` wrapper removed. */
const unwrapOptionalField = (field: Schema.Top): Schema.Top => optionalField(field)?.inner ?? field

/**
 * Whether a field is a class-like value whose fields the schema walker cannot
 * see. `DynamoModel.ref` annotates with `Schema.annotate`, which drops a
 * `Schema.Class`'s `.fields`, so `substituteSchemaDeep` cannot recurse into it
 * and the target's transformed fields keep their strict decoders. A plain class
 * is introspectable and is left to the walker.
 */
const isOpaqueRefField = (field: Schema.Top): boolean => {
  const inner = unwrapOptionalField(field)
  return getSchemaFields(inner) === undefined && SchemaAST.isDeclaration(inner.ast)
}

/**
 * A sub-aggregate nested in another inherits its parent's discriminator, and
 * its rows carry both (#133). Re-using an inherited attribute name would
 * overwrite the parent's value on the inner rows: the two bindings of the
 * parent would then key and assemble the inner sub-aggregate identically.
 * Refused at `make()` time, naming the edge, rather than surfacing as a
 * key collision or a mis-assembly at runtime.
 */
const validateNestedDiscriminators = (
  aggregateName: string,
  edges: Record<string, AggregateEdge | BoundSubAggregate<any>>,
  inherited: ReadonlyMap<string, string> = new Map(),
  path: ReadonlyArray<string> = [],
): void => {
  for (const [edgeName, edge] of Object.entries(edges)) {
    if (!("_tag" in edge) || edge._tag !== "BoundSubAggregate") continue
    const bound = edge as BoundSubAggregate<any>
    const here = [...path, edgeName]
    const own = Object.keys(bound.discriminator ?? {})
    for (const attr of own) {
      const owner = inherited.get(attr)
      if (owner !== undefined) {
        throw new Error(
          `[EDD-9056] Aggregate "${aggregateName}": the sub-aggregate at "${here.join(".")}" ` +
            `declares discriminator "${attr}", which it already inherits from "${owner}". ` +
            `A nested sub-aggregate's rows carry every enclosing discriminator, so the inner ` +
            `value would overwrite the outer one. Give the nested binding a distinct attribute ` +
            `name (e.g. { squadNo: 1 } inside { clubNo: 1 }).`,
        )
      }
    }
    const next = new Map(inherited)
    for (const attr of own) next.set(attr, here.join("."))
    validateNestedDiscriminators(aggregateName, bound.aggregate.edges, next, here)
  }
}

/** The structural slice of an edge's target entity that ref resolution reads. */
interface RefTargetEntity {
  readonly model?: Schema.Top
  readonly _data?: {
    readonly resolvedRefs?: ReadonlyArray<{
      readonly fieldName: string
      readonly refEntity?: { readonly model?: Schema.Top }
    }>
  }
}

const unwrapEntityModel = (model: Schema.Top): Schema.Top =>
  DynamoModel.isConfiguredModel(model) ? (model.model as Schema.Top) : model

/**
 * Map each ref FIELD SCHEMA the aggregate's schema walker cannot see into to the
 * model it should be decoded (and encoded) as.
 *
 * `substituteSchemaDeep` recurses into plain classes / structs / arrays on its
 * own. It cannot recurse into a `DynamoModel.ref`-annotated class (the
 * annotation drops `.fields`), so that field's transformed leaves keep their
 * strict decoders: a re-decoded domain `DateTime` is rejected as "Expected
 * string", and a legacy marshalled one is never lifted. Registered here:
 *
 * - **root `one` / `ref` edge fields** — unconditionally, re-pointed at the
 *   edge entity's model (the behaviour since #72);
 * - **sub-aggregate `one` / `ref` edge fields** and **the ref field inside a
 *   `many` element** (`PlayerSheet.player`, found by
 *   `deriveEntityFieldName(entity)` as hydration finds it), at root or in a
 *   sub-aggregate — only when OPAQUE. A plain class there is already walked,
 *   and swapping it for the entity's model could only make its decode stricter
 *   or change its class (#133);
 * - **a `many` edge field whose ELEMENT is an opaque ref**
 *   (`Schema.Array(Player.pipe(DynamoModel.ref))`) — the array field itself,
 *   re-pointed at `Schema.Array(<entity model>)`, since the walker can only
 *   re-point fields, not array elements;
 * - **refs nested inside an edge entity's own model** (`maker` on a `supplier`
 *   edge entity, #116).
 *
 * Keyed by schema IDENTITY. The resolver is consulted at every depth of the
 * walk, so the former name-keyed table re-pointed every same-named field
 * anywhere in the model — a `coach` field three levels down was decoded as the
 * root `coach` edge's entity.
 */
const collectRefTargets = (
  rootFields: Record<string, Schema.Top> | undefined,
  rootEdges: Record<string, AggregateEdge | BoundSubAggregate<any>>,
): ReadonlyMap<Schema.Top, Schema.Top> => {
  const targets = new Map<Schema.Top, Schema.Top>()
  const register = (field: Schema.Top | undefined, model: Schema.Top | undefined) => {
    if (field !== undefined && model !== undefined && !targets.has(field)) {
      targets.set(field, unwrapEntityModel(model))
    }
  }
  const registerNested = (entity: RefTargetEntity | undefined) => {
    if (entity?.model === undefined) return
    const entityFields = getSchemaFields(unwrapEntityModel(entity.model))
    for (const nested of entity._data?.resolvedRefs ?? []) {
      register(entityFields?.[nested.fieldName], nested.refEntity?.model)
    }
  }
  const walk = (
    fields: Record<string, Schema.Top> | undefined,
    edges: Record<string, AggregateEdge | BoundSubAggregate<any>>,
    isRoot: boolean,
  ) => {
    for (const [edgeName, edge] of Object.entries(edges)) {
      if (!("_tag" in edge)) continue
      if (edge._tag === "RefEdge" || edge._tag === "OneEdge") {
        const entity = (edge as { readonly entity?: RefTargetEntity }).entity
        const field = fields?.[edgeName]
        if (field !== undefined && (isRoot || isOpaqueRefField(field))) {
          register(field, entity?.model)
        }
        registerNested(entity)
      } else if (edge._tag === "ManyEdge") {
        const entity = edge.entity as RefTargetEntity | undefined
        const arrayField = fields?.[edgeName]
        const element = arrayField === undefined ? undefined : extractArrayElement(arrayField)
        if (arrayField !== undefined && element !== undefined && isOpaqueRefField(element)) {
          // The element IS an opaque ref (`Schema.Array(Player.pipe(DynamoModel.ref))`):
          // re-point the whole array field at an array of the entity's model. The
          // walker re-applies the field's optionality around the target.
          const model = entity?.model
          if (model !== undefined && !targets.has(arrayField)) {
            targets.set(
              arrayField,
              Schema.Array(unwrapEntityModel(model) as Schema.Codec<any>) as unknown as Schema.Top,
            )
          }
        } else if (edge.entity !== undefined) {
          // The element WRAPS the ref (`PlayerSheet { player }`), found by name as
          // hydration finds it.
          const refField = manyElementFields(fields, edgeName)?.[deriveEntityFieldName(edge.entity)]
          if (refField !== undefined && isOpaqueRefField(refField)) {
            register(refField, entity?.model)
          }
        }
        registerNested(entity)
      } else if (edge._tag === "BoundSubAggregate") {
        const bound = edge as BoundSubAggregate<any>
        walk(fieldsOf(bound.aggregate.schema), bound.aggregate.edges, false)
      }
    }
  }
  walk(rootFields, rootEdges, true)
  return targets
}

/**
 * Apply a node's attribute encoders in place — puts each attribute into its
 * stored form before the decomposed item is marshalled (#72, #133: without
 * this, a `DateTime` marshals to a `{ epochMilliseconds, … }` map that the
 * read path cannot decode as the wire form). Returns the fields stored as
 * given (see {@link AttrEncoder}).
 */
const applyNodeAttrEncoders = (
  attrs: Record<string, unknown>,
  encoders: AttrEncoders | undefined,
): ReadonlyArray<string> => {
  const asGiven: Array<string> = []
  if (!encoders) return asGiven
  for (const [field, encode] of Object.entries(encoders)) {
    if (field in attrs && attrs[field] != null) {
      attrs[field] = encode(attrs[field], () => asGiven.push(field))
    }
  }
  return asGiven
}

// ---------------------------------------------------------------------------
// Top-level aggregate construction
// ---------------------------------------------------------------------------

const makeAggregate = <TSchema extends Schema.Top>(
  schema: TSchema,
  config: AggregateConfig<TSchema>,
): Aggregate<TSchema, Record<string, unknown>> => {
  const aggregateName = config.root.entityType
  const groupKeys: GroupKeys = {
    pkField: config.pk.field,
    // Every key attribute an aggregate item can carry: `pk` / `sk`, the
    // collection index's PK and SK mirror, and the list index's (root items).
    keys: mergeKeyAttributes({
      partition: [
        "pk",
        config.pk.field,
        ...(config.list === undefined ? [] : [config.list.pk.field]),
      ],
      sort: [
        "sk",
        ...(config.collection.sk === undefined ? [] : [config.collection.sk.field]),
        ...(config.list === undefined ? [] : [config.list.sk.field]),
      ],
    }),
  }
  const contextFields = config.context ?? []

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

  validateNestedDiscriminators(aggregateName, config.edges)

  // Ref fields whose target the schema walker must be told about (see
  // `collectRefTargets`). Keyed by the field SCHEMA, not its name: the resolver
  // is consulted at every depth, so a name-keyed table re-pointed any
  // same-named field anywhere in the model.
  const refTargets = collectRefTargets(schemaFields, config.edges)
  const resolveRef: RefResolver = (_name, field) => refTargets.get(field)

  // System timestamps (#98). Aggregates compose their DynamoDB items directly
  // rather than routing through Entity write ops, so Entity's timestamp
  // machinery never reached these rows. Resolution goes through the SAME
  // resolver as Entity, which means field names, `DynamoModel` storage
  // annotations and the EDD-9044 guard on an un-annotated `schema` all behave
  // identically here. Passing the root schema's fields also inherits Entity's
  // collision rule: a date-compatible root field of the same name supplies the
  // encoding, and a non-date one means the user owns the attribute outright, on
  // every row. As on an entity, `Schema.optional` wraps the value that's read.
  const resolveStampsOver = (fields: Record<string, Schema.Top> | undefined) =>
    resolveAggregateStamps(config.timestamps, fields, `Aggregate "${aggregateName}"`)
  const timestampFields = resolveStampsOver(schemaFields)
  refuseAggregateKeyOverMovingValue(
    aggregateName,
    config.timestamps,
    schemaFields,
    config.pk.composite,
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
  // What the read path may drop before decoding: each node drops those its rows
  // don't declare ({@link stampsToStrip}). Declared, it belongs to the domain object.
  const systemAttrs: ReadonlySet<string> = new Set(
    [timestampFields.createdAt, timestampFields.updatedAt].filter(
      (name): name is string => name !== null,
    ),
  )

  /**
   * What the rows of a value with these fields do with each timestamp, as an entity's do: a date the
   * value declares is the library's, a supplied value winning, under the field's encoding; any other
   * field of that name is the caller's and the row isn't stamped. Undeclared, the row is stamped.
   */
  const rowStampsOf = (fields: Record<string, Schema.Top> | undefined): RowStamps | undefined => {
    if (stampFields === undefined) return undefined
    const own = resolveStampsOver(fields)
    const required = (name: string | null) =>
      name !== null && fields?.[name] !== undefined && !isFieldOptional(fields[name])
    return {
      createdAt: stampFields.createdAt === null ? null : own.createdAt,
      createdEncoding: own.createdAtCollision ? own.createdAtEncoding : stampFields.createdEncoding,
      createdDeclared: own.createdAtCollision,
      createdRequired: own.createdAtCollision && required(own.createdAt),
      updatedAt: stampFields.updatedAt === null ? null : own.updatedAt,
      updatedEncoding: own.updatedAtCollision ? own.updatedAtEncoding : stampFields.updatedEncoding,
      updatedDeclared: own.updatedAtCollision,
      updatedRequired: own.updatedAtCollision && required(own.updatedAt),
    }
  }
  refuseManySortKeysOverMovingValue(aggregateName, config.timestamps, schemaFields, config.edges)
  refuseAggregateKeysOverBothKinds(aggregateName, schemaFields, config, config.edges)
  const withRowStamps = (node: ResolvedNode): ResolvedNode => ({
    ...node,
    rowStamps: rowStampsOf(node.ownFields),
    children: node.children.map(withRowStamps),
  })

  // Build resolved graph by walking edges recursively. Each node's attribute
  // encoders come from the schema its decomposed values actually have — for a
  // `many` edge that is the aggregate model's array ELEMENT (#133).
  const rootNode = withRowStamps(
    resolveNode({
      fieldName: null,
      entityType: config.root.entityType,
      cardinality: "root",
      edges: config.edges,
      parentFields: schemaFields,
      resolveRef,
    }),
  )
  // Rows that hold a stamp in the domain object: what `update` returns has to say what it wrote.
  const declaresStamp = (node: ResolvedNode): boolean =>
    node.rowStamps?.createdDeclared === true ||
    node.rowStamps?.updatedDeclared === true ||
    node.children.some(declaresStamp)
  const returnsStamps = declaresStamp(rootNode)

  // Packed edge attributes, and those read by stored form, by item entity type (#147).
  const packedByType = collectPackedByType(rootNode)
  const dispatchByType = collectDispatchByType(rootNode)

  // Attribute ENCODERS for the root item: decompose works from the
  // schema-decoded domain object, so every root attribute holding a wire
  // transform — a date, a transformed scalar, or a container of either — is
  // put into its stored form. The key encoders are the pre-#133 ones, which the
  // root's list-index composites are still read from (see `buildKeyAttrEncoders`).
  const attrEncoders = buildAttrEncoders(schemaFields, resolveRef)
  const keyAttrEncoders = buildKeyAttrEncoders(schemaFields)
  const rootEncoders: NodeEncoders = { stored: attrEncoders, key: keyAttrEncoders }

  // Decode schema for read/assemble + input validation. Mirrors the raw `schema`
  // but recursively substitutes EVERY date / Redacted / transformed leaf — root
  // and nested — with a TOLERANT transform. This is the single decode path for
  // get / create / update:
  //   - reads supply the stored wire form (string/number) → lifted to domain;
  //     a legacy marshalled `DateTime` map is rebuilt into a real one (#133);
  //   - update re-decodes the mutated state, which carries domain `DateTime`
  //     values → accepted as-is (a strict `*FromString` decoder would reject
  //     them). It is decode-only, so making transforms tolerant is safe — the
  //     stored wire format is still produced by the attribute encoders;
  //   - an absent attribute reads as the value it stands for: `undefined`, or an
  //     empty set, neither of which DynamoDB can store (`absentReading`).
  // Nested edge / ref classes round-trip with their class instance identity
  // preserved (Option A). Returns the raw `schema` unchanged when it carries no
  // such leaf at all (zero overhead).
  const decodeSchema = substituteSchemaDeep(schema, {
    tolerantTransforms: true,
    decodeOnly: true,
    resolveRef,
    absentReads: true,
  }) as unknown as Schema.Codec<any>
  // The same schema for WRITES — `create` input and `update`'s mutated state —
  // with the container `.check()` refinements the substitution rebuilds kept, so
  // a write that breaks one is rejected (#133), and a value is asked as the domain
  // value first, since that's what a caller holds. Assembly keeps `decodeSchema`:
  // a row written while those checks were not enforced must stay readable.
  const writeSchema = substituteSchemaDeep(schema, {
    tolerantTransforms: true,
    decodeOnly: true,
    resolveRef,
    enforceChecks: true,
    domainValues: true,
  }) as unknown as Schema.Codec<any>

  // `update`'s mutated state: the plain state a mutation is handed holds a set as a list and
  // an `Option` as a tagged object (`Schema.toIso`), and it can hand that straight back.
  const mutatedStateSchema = substituteSchemaDeep(schema, {
    tolerantTransforms: true,
    decodeOnly: true,
    resolveRef,
    enforceChecks: true,
    plainStateForms: true,
    domainValues: true,
  }) as unknown as Schema.Codec<any>

  // Validate the collection index against the table's primary key. Best effort: a
  // table registering only aggregates has no primary key to resolve, in which case
  // the check is skipped rather than guessed at. `consistentRead` on a GSI collection
  // index is not refused here: DynamoDB rejects the consistent read, and the
  // assembly read diagnoses it, naming the aggregate and the index (#144).
  const consistentRead = config.consistentRead ?? false
  const tablePrimary = resolvePrimaryKey(config.table.entities)

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

  refuseAggregateKeyInTableKey(
    aggregateName,
    [config.pk.field, "sk", tablePrimary?.pk, tablePrimary?.sk],
    [
      ...(config.collection.index === undefined || config.collection.sk === undefined
        ? []
        : [["its collection sort key", config.collection.sk.field] as const]),
      ...(config.list === undefined
        ? []
        : [
            ["its list partition key", config.list.pk.field] as const,
            ["its list sort key", config.list.sk.field] as const,
          ]),
    ],
  )

  if ((config.collection.index === undefined) !== (config.collection.sk === undefined)) {
    throw new Error(
      `[EDD-9043] Aggregate "${aggregateName}": \`collection.index\` and \`collection.sk\` must ` +
        `be supplied together. The collection SK exists only to give the index something to ` +
        `sort by — declare both to assemble through an index, or neither to assemble off the ` +
        `base table.`,
    )
  }

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
    existingUpdated?: ReadonlyMap<string, unknown>,
    updatedBefore?: ReadonlyMap<string, unknown>,
  ): Stamp | undefined =>
    stampFields === undefined ? undefined : { now, existingCreated, existingUpdated, updatedBefore }

  /** Compose keys and marshal rows: a value it can't place is a `ValidationError`, not a defect. */
  const composeOrFail = <A>(operation: string, compose: () => A) =>
    marshalOrFail(aggregateName, `aggregate.${operation}`, compose)

  /** The partition key `record` composes. Throws what {@link composeOrFail} turns into its failure. */
  const collectionPkOf = (record: Record<string, unknown>): string =>
    composeCollectionKey(
      config.schema,
      config.collection.name,
      keyCompositesOrThrow(
        aggregateName,
        "its partition key",
        config.schema,
        config.pk.composite,
        keyRecord(record),
      ),
    )

  // Build optics at construction time (once per aggregate definition)
  const classToPlain = Schema.toIso(schema) as Optic.Iso<
    Schema.Schema.Type<TSchema>,
    TSchema["Iso"]
  >
  const opticRoot = Schema.toIsoFocus(schema) as Optic.Iso<TSchema["Iso"], TSchema["Iso"]>
  // The same conversion through the READ schema. `toIso(schema)` re-checks the
  // model's `.check()` refinements, so a stored row written while a container
  // check was not enforced (#133) would make every `update` throw before the
  // mutation could repair it. Reads accept such a row; so does this.
  const readToPlain = Schema.toIso(decodeSchema as unknown as TSchema) as Optic.Iso<
    Schema.Schema.Type<TSchema>,
    TSchema["Iso"]
  >
  const toPlainState = (value: Schema.Schema.Type<TSchema>): TSchema["Iso"] => {
    try {
      return classToPlain.get(value)
    } catch {
      return readToPlain.get(value)
    }
  }

  // Composite key form — the SAME rule and the SAME function the entity path
  // uses (`internal/CompositeCodec.ts`). Aggregates compose from assembled
  // domain objects, so without this a `DateEpochMs` composite would key on its
  // ISO form here and its epoch form on the entity path, and a numeric
  // composite with a string encoding would not be zero-padded on either.
  const compositeKeyForm = makeCompositeKeyForm(schema, (attr, value, reason) => {
    if (reason !== undefined) {
      return refuseInexact(`Composite "${attr}" on aggregate "${aggregateName}"`, value, reason)
    }
    throw new Error(
      `[EDD-9050] Composite "${attr}" on aggregate "${aggregateName}" could not be put into ` +
        `its key form. The attribute's schema carries an encoding transformation, but ` +
        `${JSON.stringify(String(value))} resolves under neither encode nor decode->encode. ` +
        `Supply a value of the attribute's own type.`,
    )
  })
  // Only the attributes a key is ever composed from are put into key form. The
  // rest of the record is never read off the result, and normalising it could
  // only fail: a stored value that breaks a field's `.check()` (#133) made
  // every `update` throw EDD-9050 over an attribute no key uses.
  const compositeAttrs: ReadonlySet<string> = new Set([
    ...config.pk.composite,
    ...(config.collection.sk?.composite ?? []),
    ...(config.list?.pk.composite ?? []),
    ...(config.list?.sk.composite ?? []),
  ])
  const keyRecord = (record: Record<string, unknown>): Record<string, unknown> => {
    const composites: Record<string, unknown> = {}
    for (const attr of compositeAttrs) {
      if (attr in record) composites[attr] = record[attr]
    }
    return toCompositeKeyRecord(compositeKeyForm, composites)
  }

  /**
   * DynamoDB's rejection of an assembly read (#144) — a consistent read of a
   * GSI collection index — explained for the aggregate and its index.
   */
  const assemblyReadCause = (operation: string, diagnosis: Diagnosis, original: unknown) =>
    withCause(
      `Aggregate "${aggregateName}" ${operation}: ${explainDiagnosis(diagnosis, operation)} ` +
        "Drop `consistentRead` from the aggregate, or key it on the table's primary " +
        "partition key so assembly reads the base table.",
      original,
    )

  /** Compose the PK and query all items; a rejected read fails as `rejected` names it. */
  const readPartition = <E>(
    key: Record<string, unknown>,
    rejected: (diagnosis: Diagnosis, original: unknown) => E,
    rekeyRead?: RekeyRead,
  ) =>
    Effect.flatMap(readPartitionRaw(key, rejected, rekeyRead), (read) =>
      // Packed edge attributes, read by their stored form (#147).
      Effect.as(unpackAggregateItems(read.allItems, dispatchByType, aggregateName), read),
    )

  // A root row's partition key composites as a read takes them: decoded through their fields, as
  // assembly decodes the root row. `create` composes the key from the value it holds, so a key
  // composed again from a stored row (`list`, `rekey`) is composed from these, never from the
  // stored form: a transformation that isn't its own inverse on the other side (a value stored
  // divided by ten, an `Option` holding one) keys the stored form elsewhere.
  const decodeRootKey = (() => {
    const fields: Record<string, Schema.Top> = {}
    for (const attr of config.pk.composite) {
      const field = schemaFields?.[attr]
      if (field !== undefined) fields[attr] = field
    }
    return Schema.decodeUnknownOption(
      substituteSchemaDeep(Schema.Struct(fields), {
        tolerantTransforms: true,
        decodeOnly: true,
        resolveRef,
        absentReads: true,
      }) as unknown as Schema.Codec<Record<string, unknown>>,
    )
  })()
  /**
   * `row` (a stored root row) with its partition key composites as a read takes them. A row whose
   * composites a read can't take is left as it is: its key composes as the stored form does, and its
   * read fails as assembly's does.
   */
  const rootKeyAsRead = (row: Record<string, unknown>): Record<string, unknown> => {
    const composites: Record<string, unknown> = {}
    for (const attr of config.pk.composite) {
      if (attr in row) composites[attr] = row[attr]
    }
    const read = decodeRootKey(composites)
    return Option.isSome(read) ? { ...row, ...read.value } : row
  }

  /** The collection partition key `record`'s values compose under `under`. */
  const collectionPkUnder = (
    under: DynamoSchemaModule.DynamoSchema,
    record: Record<string, unknown>,
  ): string =>
    composeCollectionKey(
      config.schema,
      config.collection.name,
      KeyComposer.extractKeyComposites(under, {}, config.pk.composite, keyRecord(record)),
    )

  /** {@link readPartition} without unpacking — `delete` needs only the keys. */
  const readPartitionRaw = <E>(
    key: Record<string, unknown>,
    rejected: (diagnosis: Diagnosis, original: unknown) => E,
    rekeyRead?: RekeyRead,
  ) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const tableConfig: TableConfig = yield* config.table.Tag
      const pkValue = yield* composeOrFail("key", () => collectionPkOf(key))
      const read = (partition: string) =>
        queryAllItems(
          client,
          tableConfig.name,
          config.collection.index,
          config.pk.field,
          partition,
          consistentRead,
          rejected,
          rekeyRead?.stored,
        )
      const from = rekeyRead?.from
      const allItems =
        from === undefined
          ? yield* read(pkValue)
          : [...(yield* read(from)), ...(rekeyRead?.fromOnly === true ? [] : yield* read(pkValue))]
      return { client, tableConfig, pkValue, allItems }
    })

  const holdsCustom = holdsCustomDeclaration(schema.ast)

  /**
   * Refuses the rows of a write that wouldn't read back: the rows it's about to write, through the read
   * path a `get` takes. Only two kinds of write pay for it: one of an aggregate holding a custom
   * declaration (`EDD-9126`), and one that stored a value as given, which no encoder of its field
   * takes (`asGiven`, `EDD-9127`). Every other write has nothing to do here.
   */
  const refuseNotReadBack = (
    groups: ReadonlyArray<{ readonly items: ReadonlyArray<Record<string, AttributeValue>> }>,
    key: Record<string, unknown>,
    operation: string,
    asGiven: ReadonlyArray<string>,
  ): Effect.Effect<void, ValidationError> =>
    !holdsCustom && asGiven.length === 0
      ? Effect.void
      : Effect.gen(function* () {
          const rows = groups.flatMap((group) =>
            group.items.map((item) => fromAttributeMap(item) as Record<string, unknown>),
          )
          yield* unpackAggregateItems(rows, dispatchByType, aggregateName)
          yield* assembleAggregate(
            decodeSchema,
            rootNode,
            rows,
            contextFields,
            key,
            aggregateName,
            systemAttrs,
          ).pipe(
            Effect.mapError(
              (error) =>
                new ValidationError({
                  entityType: aggregateName,
                  operation,
                  cause:
                    asGiven.length > 0
                      ? notStoredForm(asGiven, (error as ValidationError).cause ?? error)
                      : notReadBack("The aggregate", (error as ValidationError).cause ?? error),
                }),
            ),
          )
        })

  /**
   * `[EDD-9128]`, by value: each key composite whose numeric kinds can't be read at load
   * (`Schema.Unknown`, `Schema.Any`, a declaration, or a transformation from one), with what composes
   * it and the test of a stored value that reads back otherwise (`readsBackOtherwise`), per node
   * whose key composes it. A composite that's a path into a value (`nested.n`) is followed to the
   * field it names (`fieldAtPath`). A declared one is refused at load. Empty for an aggregate with
   * none, which pays nothing more on a write.
   */
  const otherKindKeys = (() => {
    type Check = {
      readonly path: string
      readonly into: string
      /** The value the refusal names and what it reads back as, `undefined` when it reads back. */
      readonly judge: (item: DecomposedItem) => { held: unknown; readsAs: string } | undefined
    }
    // A composite judged by the value at its path alone.
    const leafJudge =
      (path: string, readsOther: (value: unknown) => string | undefined) =>
      (item: DecomposedItem) => {
        const held = readCompositePath(item.attributes, path)
        const readsAs = held == null ? undefined : readsOther(held)
        return readsAs === undefined ? undefined : { held, readsAs }
      }
    // A dotted composite of `node`'s sort key (`nested.n`), judged through the field holding it:
    // the text `node` composes for it from the element written against the text composed again
    // from the row as a read takes it, its field decoded as assembly decodes it and its key read
    // off the result as `decompose` reads it. A transformation of what holds the value (a struct
    // decoded to another) is a read's too, so the value at the path alone isn't what a key read
    // back is composed from.
    const throughFieldJudge = (
      node: ResolvedNode,
      fields: Record<string, Schema.Top>,
      path: string,
    ) => {
      const top = path.slice(0, path.indexOf("."))
      const decode = Schema.decodeUnknownOption(
        substituteSchemaDeep(Schema.Struct({ [top]: fields[top]! }), {
          tolerantTransforms: true,
          decodeOnly: true,
          resolveRef,
          absentReads: true,
        }) as unknown as Schema.Codec<any>,
      )
      const keyEncoder = node.keyAttrEncoders?.[top]
      // The value at the path of a top-level value decoded, as `decompose` reads a key off it.
      const leafOf = (value: unknown): Option.Option<unknown> =>
        Option.map(decode({ [top]: value }), (decoded) => {
          const held = (decoded as Record<string, unknown>)[top]
          return readCompositePath(
            { [top]: keyEncoder === undefined ? held : keyEncoder(held) },
            path,
          )
        })
      return (item: DecomposedItem) => {
        const stored = item.attributes[top]
        if (stored == null) return undefined
        // Only a `many` element has a sort key `node` composes from it.
        const written = item.skTextFor?.(node, path)
        if (written === undefined) return undefined
        let returned: unknown
        try {
          returned = asRead(stored)
        } catch {
          // A value the marshaller refuses is the write's own marshalling's to report.
          return undefined
        }
        const read = Option.filter(leafOf(returned), (leaf) => leaf != null)
        if (
          Option.isSome(read) &&
          isScalarComposite(read.value) &&
          KeyComposer.keyValueText(config.schema, read.value, config.schema.casing) === written
        ) {
          return undefined
        }
        const was = Option.getOrUndefined(leafOf(stored))
        return {
          held: was ?? readCompositePath(item.attributes, path),
          readsAs: readBackAs(read, was),
        }
      }
    }
    // The text the root's key composes from a composite's value, written and read back alike: the
    // key form takes a value read back as its field reads it.
    const rootKeyText = (path: string) => (value: unknown) => {
      try {
        return KeyComposer.compositeText(config.schema, compositeKeyForm(path, value))
      } catch {
        return undefined
      }
    }
    const checksOf = (
      fields: Record<string, Schema.Top> | undefined,
      into: string,
      composites: ReadonlyArray<string>,
      root = false,
    ): ReadonlyArray<Check> =>
      composites.flatMap((path) => {
        const fieldSchema = fieldAtPath(fields, path)
        const text = rootKeyText(path)
        const readsOther =
          fieldSchema === undefined
            ? undefined
            : readsBackOtherwise(fieldSchema, {
                asRead,
                texts: root ? [{ written: text, read: text }] : [],
              })
        return readsOther === undefined ? [] : [{ path, into, judge: leafJudge(path, readsOther) }]
      })
    // An edge's sort key: a dotted composite is judged through the field holding it when that field's
    // read-back can't be guaranteed at load, and any other composite by its value.
    const edgeChecksOf = (node: ResolvedNode, composites: ReadonlyArray<string>) => {
      const into = `edge "${node.fieldName}"'s sort key`
      const fields = node.ownFields
      return composites.flatMap((path): ReadonlyArray<Check> => {
        const top = fields?.[path.slice(0, path.indexOf("."))]
        const leaf = fieldAtPath(fields, path)
        return fields !== undefined &&
          top !== undefined &&
          path.includes(".") &&
          (readBackUnsure(top) || (leaf !== undefined && readBackUnsure(leaf)))
          ? [{ path, into, judge: throughFieldJudge(node, fields, path) }]
          : checksOf(fields, into, [path])
      })
    }
    // Each node's own checks: a row is judged by every node assembly hands it to (`assemblyWalk`).
    const byNode = new Map<ResolvedNode, ReadonlyArray<Check>>()
    const add = (node: ResolvedNode, checks: ReadonlyArray<Check>) => {
      if (checks.length > 0) byNode.set(node, checks)
    }
    add(rootNode, [
      ...checksOf(schemaFields, "its partition key", config.pk.composite, true),
      ...checksOf(
        schemaFields,
        "its collection sort key",
        config.collection.sk?.composite ?? [],
        true,
      ),
      ...(config.list === undefined
        ? []
        : [
            ...checksOf(schemaFields, "its list partition key", config.list.pk.composite, true),
            ...checksOf(schemaFields, "its list sort key", config.list.sk.composite, true),
          ]),
    ])
    const walk = (node: ResolvedNode): void => {
      if (node.cardinality === "many" && node.skComposite !== undefined) {
        add(node, edgeChecksOf(node, node.skComposite))
      }
      for (const child of node.children) walk(child)
    }
    walk(rootNode)
    return byNode
  })()

  /**
   * Refuses a write storing, for a key composite whose numeric kinds can't be read at load, a value
   * that reads back otherwise: a stored row would compose other key text (`EDD-9128`). `groups` is
   * the whole decomposition of the value stored, rows a diff leaves alone included: a read of the
   * aggregate takes them all. A row is judged by the checks of each node a read hands it to
   * (`assemblyWalk`), its composites read off its stored attributes, a path into a value followed.
   */
  const refuseOtherKindKeys = (
    groups: ReadonlyArray<TransactionGroup>,
    operation: string,
  ): Effect.Effect<void, ValidationError> => {
    if (otherKindKeys.size === 0) return Effect.void
    const reached = assemblyWalk(
      rootNode,
      groups.flatMap((group) => group.items),
      // An attribute as a read has it: a discriminator is matched against what's read back.
      (node, item) =>
        takesRow(node, item.entityType, (attr) => {
          try {
            return asRead(item.attributes[attr])
          } catch {
            return undefined
          }
        }),
    )
    for (const [node, taken] of reached) {
      const checks = otherKindKeys.get(node)
      if (checks === undefined) continue
      for (const item of taken) {
        for (const { path, into, judge } of checks) {
          const refused = judge(item)
          if (refused === undefined) continue
          return Effect.fail(
            new ValidationError({
              entityType: aggregateName,
              operation,
              cause: readBackRefusal(
                `Field "${path}" of "${item.member}" is composed into ${into}`,
                refused.held,
                refused.readsAs,
              ),
            }),
          )
        }
      }
    }
    return Effect.void
  }

  /** Shared: compose PK and query all items, a rejected read a `ValidationError`. */
  const fetchPartition = (key: Record<string, unknown>, operation: string, rekeyRead?: RekeyRead) =>
    readPartition(
      key,
      (diagnosis, original) =>
        new ValidationError({
          entityType: aggregateName,
          operation: `${operation}.consistentRead`,
          cause: assemblyReadCause(operation, diagnosis, original),
        }),
      rekeyRead,
    )

  const derivedSchemas = deriveAggregateSchemas(
    schema,
    config.edges,
    config.pk.composite,
    config.timestamps,
  )

  /** A stored row's position: its partition and sort key. */
  const positionOf = (pk: string, sk: string): string => `${pk}\u0000${sk}`
  type Position = { readonly pk: string; readonly sk: string }

  /**
   * Attributes holding index keys the aggregate composes: the collection SK mirror, the list
   * keys. Never a table key attribute, which `make` refuses (`EDD-9112`).
   */
  const indexFields = [
    ...(config.collection.index !== undefined && config.collection.sk !== undefined
      ? [config.collection.sk.field]
      : []),
    ...(config.list === undefined ? [] : [config.list.pk.field, config.list.sk.field]),
  ]

  /** Index key attributes of `composed` whose text the row stored as `stored` doesn't hold. */
  const staleIndexFields = (
    composed: Record<string, AttributeValue>,
    stored: Record<string, unknown>,
  ): ReadonlyArray<string> =>
    indexFields.filter((field) => {
      const text = (composed[field] as { S?: string } | undefined)?.S
      return text !== undefined && text !== stored[field]
    })

  /**
   * Where a row may be under the partition's old text: at the sort key the other setting composes,
   * or the current one, where 1.37.0 and 1.38.0 wrote it (its partition key unescaped, its sort key escaped).
   * Under a partition whose text didn't change, the current sort key is where the row belongs.
   */
  const oldPosition = (
    pk: string,
    pkNow: string,
    skOther: string,
    sk: string,
    storedAt: ReadonlyMap<string, Record<string, unknown>>,
    otherKind: (pk: string) => string | undefined,
  ): { readonly pk: string; readonly sk: string } => {
    if (storedAt.has(positionOf(pk, skOther))) return { pk, sk: skOther }
    if (storedAt.has(positionOf(pk, sk))) return { pk, sk: pk === pkNow ? skOther : sk }
    // A sort key holding a numeric composite's other kind's text. Looked for only for a row at
    // neither key: one at its current key under the other kind's text too would have been read
    // back as a second element composing that key, which the decomposition refuses.
    return { pk, sk: otherKind(pk) ?? skOther }
  }

  // ---------------------------------------------------------------------------
  // Which rows of its partition are the aggregate's (DESIGN.md §7 "Which rows in its partition
  // are an aggregate's")
  // ---------------------------------------------------------------------------

  /** Every entity type a node of the aggregate's rows carries. */
  const nodeTypes: ReadonlyArray<string> = (() => {
    const types = new Set<string>()
    const walk = (node: ResolvedNode): void => {
      types.add(node.entityType)
      for (const child of node.children) walk(child)
    }
    walk(rootNode)
    return [...types]
  })()

  /** The fixed text every partition key the aggregate composes begins with. */
  const partitionHead = composeCollectionKey(config.schema, config.collection.name, [])

  /**
   * `ownsRows`: every row of the aggregate's types in its partition is its own, so `update` deletes
   * the rows of them it reads beyond the ones its value keys, and `rekey` reports them.
   */
  const ownsRows = config.ownsRows === true
  const ownedTypes: ReadonlySet<string> = new Set(nodeTypes)

  /**
   * Each node a row can be handed to, as `assembleNode` hands rows: its entity type and its static
   * discriminator (an enclosing sub-aggregate's merged in at resolve time). With the transaction
   * group its rows are written in and the discriminator values its sort key holds.
   */
  const nodeSlots: ReadonlyArray<{
    readonly node: ResolvedNode
    readonly group: string
    readonly keyDiscriminators: DiscriminatorValues
  }> = (() => {
    const slots: Array<{
      readonly node: ResolvedNode
      readonly group: string
      readonly keyDiscriminators: DiscriminatorValues
    }> = [{ node: rootNode, group: "root", keyDiscriminators: { current: [], other: () => [] } }]
    const visit = (node: ResolvedNode, parentGroup: string, parent: DiscriminatorValues): void => {
      if (node.cardinality === "one" && node.children.length > 0) {
        const ownName = node.fieldName ?? node.entityType
        const group = parentGroup === "root" ? ownName : `${parentGroup}.${ownName}`
        const own = ownDiscriminatorValues(node, config.schema)
        const values: DiscriminatorValues = {
          current: [...parent.current, ...own.current],
          other: () => [...parent.other(), ...own.other()],
        }
        slots.push({ node, group, keyDiscriminators: values })
        for (const child of node.children) visit(child, group, values)
        return
      }
      if (node.cardinality === "one") {
        const own = ownDiscriminatorValues(node, config.schema)
        slots.push({
          node,
          group: parentGroup,
          keyDiscriminators: {
            current: [...parent.current, ...own.current],
            other: () => [...parent.other(), ...own.other()],
          },
        })
        return
      }
      slots.push({ node, group: parentGroup, keyDiscriminators: parent })
    }
    for (const child of rootNode.children) visit(child, "root", { current: [], other: () => [] })
    return slots
  })()

  /** The nodes `item` is handed to by its entity type and static discriminator. */
  const slotsOf = (item: Record<string, unknown>) =>
    nodeSlots.filter(
      ({ node }) =>
        item.__edd_e__ === node.entityType &&
        Object.entries(node.discriminator ?? {}).every(
          ([attr, value]) =>
            typeof value === "function" || (Object.hasOwn(item, attr) && item[attr] === value),
        ),
    )

  /**
   * `update`'s cleanup with `ownsRows` (DESIGN.md §7 "Which rows in its partition are an
   * aggregate's"): the rows read of each changed node, keyed where the new value writes nothing and
   * the update's groups delete nothing (`written`, `deleted`). A node changed when the update writes
   * its group (`writtenGroups`) and its items of the old value and of the new one differ by the
   * comparison that decides that ({@link sameItems}: types and attributes in order, not keys). A row
   * is a node's as assembly hands it ({@link slotsOf}); one handed to two nodes is left. Each row
   * once.
   */
  const ownedRowsLeft = (
    allItems: ReadonlyArray<Record<string, unknown>>,
    pkValue: string,
    oldGroups: ReadonlyArray<TransactionGroup>,
    newGroups: ReadonlyArray<TransactionGroup>,
    writtenGroups: ReadonlySet<string>,
    written: ReadonlySet<string>,
    deleted: ReadonlyArray<string>,
  ): ReadonlyArray<OwnedRow> => {
    const inWrittenGroup = new Set<ResolvedNode>()
    const byNode = (groups: ReadonlyArray<TransactionGroup>) => {
      const items = new Map<ResolvedNode, Array<DecomposedItem>>()
      for (const group of groups) {
        for (const item of group.items) {
          if (writtenGroups.has(group.name)) inWrittenGroup.add(item.node)
          const list = items.get(item.node) ?? []
          list.push(item)
          items.set(item.node, list)
        }
      }
      return items
    }
    const before = byNode(oldGroups)
    const after = byNode(newGroups)
    const changed = new Set(
      nodeSlots
        .map(({ node }) => node)
        .filter(
          (node) =>
            inWrittenGroup.has(node) && !sameItems(before.get(node) ?? [], after.get(node) ?? []),
        ),
    )
    if (changed.size === 0) return []
    const taken = new Set(deleted)
    const left: Array<OwnedRow> = []
    for (const item of allItems) {
      const sk = String(item.sk)
      if (item[config.pk.field] !== pkValue || written.has(sk) || taken.has(sk)) continue
      const slots = slotsOf(item)
      if (slots.length !== 1 || !changed.has(slots[0]!.node)) continue
      taken.add(sk)
      left.push({ pk: pkValue, sk, entityType: String(item.__edd_e__) })
    }
    return left
  }

  /**
   * The attributes the aggregate writes on its rows, for another aggregate declaring `ownsRows` to
   * check at bind (DESIGN.md §7 "Which rows in its partition are an aggregate's"), as each row holds
   * them after the last write of each: its partition key, `sk` and the collection index's sort key
   * on every row, its list keys on its root row, its timestamps, written last, and its rows' own
   * attributes (their fields, discriminators and context, or what a custom `decompose` returns):
   * any name holding any text, but the ones the library writes after them.
   */
  const attributeWriters: ReadonlyArray<AttributeWriter> = (() => {
    const table = config.table.Tag
    const labelled = (type: string): RowType => ({
      type,
      label: composeKey(config.schema, type, []),
    })
    const all = nodeTypes.map(labelled)
    const root = labelled(config.root.entityType)
    const mirror =
      config.collection.index !== undefined && config.collection.sk !== undefined
        ? config.collection.sk.field
        : undefined
    const writers: Array<AttributeWriter> = [
      {
        field: config.pk.field,
        head: partitionHead,
        exact: config.pk.composite.length === 0,
        types: all,
        table,
        channel: "its partition key",
      },
      ...all.map((type) => ({
        field: "sk",
        head: type.label,
        types: [type],
        table,
        channel: "its sort key",
      })),
    ]
    if (mirror !== undefined) {
      writers.push({
        field: mirror,
        head: partitionHead,
        types: [root],
        table,
        channel: "its collection index's sort key",
      })
      for (const type of all) {
        writers.push({
          field: mirror,
          head: type.label,
          types: [type],
          table,
          channel: "its collection index's sort key",
        })
      }
    }
    if (config.list !== undefined) {
      const head = composeCollectionKey(config.schema, config.list.name, [])
      for (const field of [config.list.pk.field, config.list.sk.field]) {
        writers.push({ field, head, types: [root], table, channel: "its list index's keys" })
      }
    }
    // Its timestamps, written after everything else: one named as a key replaces it.
    for (const name of systemAttrs) {
      writers.push({ field: name, head: undefined, types: all, table, channel: `its "${name}"` })
    }
    // Its rows' own attributes. Whatever a schema declares, these are any name holding any text, but
    // the ones the library writes after them.
    const library = [config.pk.field, "sk", "__edd_e__", ...(mirror === undefined ? [] : [mirror])]
    writers.push({
      field: undefined,
      except: library,
      head: undefined,
      types: all,
      table,
      channel: "its rows' own attributes",
    })
    return withTypeOverwrites(writers)
  })()

  /** What `DynamoClient.make` checks an aggregate declaring `ownsRows` against. */
  const ownership: Ownership = {
    pkField: config.pk.field,
    pkComposite: config.pk.composite,
    partitionHead,
    schema: config.schema,
    table: config.table.Tag,
    types: nodeTypes.map((type) => ({ type, label: composeKey(config.schema, type, []) })),
    declared: [
      ...Object.entries((config.table.entities ?? {}) as Record<string, unknown>),
      ...Object.entries((config.table.aggregates ?? {}) as Record<string, unknown>),
    ].map(([name, member]) => ({ name, member })),
  }

  /**
   * `rekey`'s view of where the aggregate's rows are stored (#183, DESIGN.md §7 "`rekey`"): for
   * each decomposed item, its current key and its old one — the partition the row was found in
   * and the sort key text of the other setting — the rows stored at each, and where the item is
   * ({@link placeRows}).
   */
  const locateRows = (
    groups: ReadonlyArray<TransactionGroup>,
    composed: ReadonlyArray<{
      readonly group: string
      readonly items: ReadonlyArray<Record<string, AttributeValue>>
    }>,
    allItems: ReadonlyArray<Record<string, unknown>>,
    pkValue: string,
    from: string | undefined,
  ) => {
    const storedAt = new Map<string, Record<string, unknown>>()
    for (const item of allItems) {
      storedAt.set(positionOf(String(item[config.pk.field]), String(item.sk)), item)
    }
    /** The sort keys stored in a partition, other than `sk` ({@link oldPosition}). */
    const partitions = new Map<string, KindTargets>()
    const sortKeysIn = (pk: string, sk: string): KindTargets => {
      let held = partitions.get(pk)
      if (held === undefined) {
        held = kindTargets(
          allItems
            .filter((item) => String(item[config.pk.field]) === pk)
            .map((item) => String(item.sk)),
        )
        partitions.set(pk, held)
      }
      const inPartition = held
      return {
        has: (text) => text !== sk && inPartition.has(text),
        hasPrefix: inPartition.hasPrefix,
      }
    }
    const rows = groups.flatMap((group, g) =>
      group.items.map((item, i) => {
        const built = composed[g]!.items[i]!
        const sk = (built.sk as { S?: string } | undefined)?.S ?? ""
        return {
          group: group.name,
          item,
          built,
          /** An element of a `many` edge with a custom `decompose`: its row moves as stored. */
          custom: item.node.decompose !== undefined,
          current: { pk: pkValue, sk },
          old: oldPosition(
            from ?? pkValue,
            pkValue,
            otherSortKey(config.schema, item, sk),
            sk,
            storedAt,
            (pk) => item.otherKindSortKey?.(sortKeysIn(pk, sk)),
          ),
        }
      }),
    )
    const placements = placeRows(
      rows.map((row) => ({
        current: positionOf(row.current.pk, row.current.sk),
        old: positionOf(row.old.pk, row.old.sk),
      })),
      (position) => storedAt.has(position),
    )
    return rows.map((row, r) => ({
      ...row,
      placement: placements[r]!,
      atCurrent: storedAt.get(positionOf(row.current.pk, row.current.sk)),
      atOld: storedAt.get(positionOf(row.old.pk, row.old.sk)),
    }))
  }

  const updateCore = (
    key: Record<string, unknown>,
    mutationFn: (
      context: UpdateContext<TSchema["Iso"], Schema.Schema.Type<TSchema>>,
    ) => Schema.Schema.Type<TSchema> | TSchema["Iso"],
  ): Effect.Effect<Schema.Schema.Type<TSchema>, AggregateWriteError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const { client, tableConfig, pkValue, allItems } = yield* fetchPartition(key, "update")

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

      const now = yield* DateTime.now

      // 2. Apply mutation — provide optics context for composable updates
      const state = toPlainState(current as Schema.Schema.Type<TSchema>)
      const updated = mutationFn({
        state,
        cursor: makeCursor(state, opticRoot),
        optic: opticRoot,
        current: current as Schema.Schema.Type<TSchema>,
      })

      // 3. Validate the mutated state — its tolerant transforms take the domain
      //    values the mutation yields as what they are, for every field (root +
      //    nested edges), so update no longer trips the "Expected string, got
      //    DateTime" decode that a strict `*FromString` schema would raise (#72
      //    update path), and a transformation with one type on both sides isn't
      //    applied again to a value it already made.
      //    A row the mutation added doesn't need the dates the library stamps.
      const written = fillStamps(rootNode, updated, now, "required")
      const decoded = yield* Schema.decodeUnknownEffect(mutatedStateSchema)(written).pipe(
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
        rootEncoders,
        aggregateName,
        config.schema,
      )
      const newGroups = yield* decomposeAggregate(
        assembledNew,
        rootNode,
        contextFields,
        rootEncoders,
        aggregateName,
        config.schema,
        { present: true, value: written, update: true },
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
      //    collection SK and list keys are mirror attributes, never the (pk, sk)
      //    identity used to PUT or DELETE, and the old set is read only for its
      //    (pk, sk) delete keys, so it composes neither and is never stamped.
      //    Rewritten rows are stamped `updated`; their stored `created` is read
      //    back off the fetched partition and re-emitted verbatim, since these are
      //    PUTs and would otherwise clobber it.
      const oldDynamo = buildDynamoItems(oldGroups, config, pkValue, undefined, keyRecord)

      const skOf = (item: Record<string, AttributeValue>): string =>
        (item.sk as { S?: string } | undefined)?.S ?? ""

      const existingCreated = new Map(readExistingCreated(allItems))
      // Each row's declared `updated` as the mutation found it: if it changed it, it's the caller's.
      const updatedBefore = new Map<string, unknown>()
      if (stampFields?.updatedAt) {
        for (const group of oldGroups) {
          for (const item of group.items) {
            updatedBefore.set(
              composeKey(config.schema, item.entityType, [...item.skComposites]),
              item.attributes[stampFields.updatedAt],
            )
          }
        }
      }

      // Packed AFTER the group diff above compared the decomposed values, so
      // an unchanged packed value is never rewritten (#147).
      const newPacked = yield* packAggregateGroups(newGroups, packedByType, aggregateName, "update")
      const newDynamo = yield* composeOrFail("update", () =>
        buildDynamoItems(
          newPacked,
          config,
          pkValue,
          assembledNew,
          keyRecord,
          stampFor(now, existingCreated, undefined, updatedBefore),
        ),
      )
      yield* refuseOtherKindKeys(newGroups, "aggregate.update")
      yield* refuseNotReadBack(newDynamo, key, "aggregate.update", storedAsGivenIn(newGroups))

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

      // With `ownsRows`, every row of its types in the partition is the aggregate's (DESIGN.md §7
      // "Which rows in its partition are an aggregate's"). After the update's groups, the rows read
      // of each node whose decomposition changed that the new value doesn't write are deleted too
      // (`ownedRowsLeft`): a node's rows are what its decomposition writes.
      const cleanup = ownsRows
        ? ownedRowsLeft(
            allItems,
            pkValue,
            oldGroups,
            newGroups,
            new Set(groupWrites.map(({ group }) => group)),
            survivingSks,
            groupWrites.flatMap(({ deletes }) => deletes.map((item) => skOf(item))),
          )
        : []

      if (groupWrites.length > 0) {
        yield* writeTransactionGroups(
          client,
          tableConfig.name,
          groupWrites,
          aggregateName,
          groupKeys,
        )
      }
      if (cleanup.length > 0) {
        yield* deleteOwnedRows(client, tableConfig.name, config.pk.field, cleanup)
      }

      if (!returnsStamps) {
        return decoded as Schema.Schema.Type<TSchema>
      }
      // A stamp the domain object holds: what's returned is what's stored, as `get` would read it,
      // and no read is needed to know that. The partition as read, with these writes applied.
      const stored = new Map(allItems.map((item) => [String(item.sk), item]))
      for (const { sk } of cleanup) stored.delete(sk)
      for (const { deletes, puts } of groupWrites) {
        for (const item of deletes) stored.delete(String((item.sk as { S?: string }).S))
        const written = puts.map((item) => fromAttributeMap(item) as Record<string, unknown>)
        yield* unpackAggregateItems(written, dispatchByType, aggregateName)
        for (const item of written) stored.set(String(item.sk), item)
      }
      return (yield* assembleAggregate(
        decodeSchema,
        rootNode,
        [...stored.values()],
        contextFields,
        key,
        aggregateName,
        systemAttrs,
      )) as Schema.Schema.Type<TSchema>
    })

  /** How many times `rekey` reads an aggregate again after a write changed it in between. */
  const REKEY_ATTEMPTS = 3

  /**
   * `rekey`'s move of the aggregate at `key` (#183, DESIGN.md §7 "`rekey`"): read from the
   * partition its root was found in and its current one, and placed ({@link locateRows}). Each row
   * under its old key moves — a Put of the row `update` would write at its current key, keeping
   * its `created` and `updated`, beside a Delete of the old row — and a row at its current key
   * whose list or collection index key holds other text has those keys rewritten. Nothing else is
   * written, and every write is conditional: the Put only where nothing is, the Delete and the
   * rewrite only while the row is as read (`asReadGuard`). Rows whose keys chain move in order, the
   * one whose current key is free first, so no write lands on a row still to move, and the root
   * moves last, so a move cut short is found by the next run. A write that loses to a concurrent
   * one reads the aggregate again; a row stored under both keys leaves the aggregate as it is,
   * reported. A dry run writes nothing.
   */
  const rekeyCore = (
    key: Record<string, unknown>,
    dryRun: boolean,
    /** The old partition the aggregate's root was found in, when it isn't the current one. */
    from: string | undefined,
    /**
     * Leave the current partition unread: a dry run's, while another aggregate still to move
     * holds it, whose rows this one's move would find gone by then.
     */
    fromOnly: boolean,
  ): Effect.Effect<Rekey.RekeyTally, AggregateWriteError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      let movedRows = 0
      let rewrittenRows = 0
      for (let attempt = 0; attempt < REKEY_ATTEMPTS; attempt++) {
        const stored: Array<Record<string, AttributeValue>> = []
        const { client, tableConfig, pkValue, allItems } = yield* fetchPartition(key, "rekey", {
          stored,
          from,
          fromOnly,
        })
        const done = (rows: number): Rekey.RekeyTally => {
          const unchanged = Math.max(0, rows - movedRows - rewrittenRows)
          return {
            ...(unchanged > 0 && { unchanged }),
            ...(movedRows > 0 && { moved: { aggregate: movedRows } }),
            ...(rewrittenRows > 0 && { indexKeysRewritten: rewrittenRows }),
          }
        }
        // Gone since the scan read it: deleted by a write.
        if (allItems.length === 0) return done(0)

        // A write moving the aggregate between the reads of its two partitions shows its
        // rows under both, and they can't be assembled or placed: with rows in both, read
        // again, and while a row read under the old partition has gone from it, retry.
        const atFrom = allItems.filter((item) => item[config.pk.field] === from)
        if (from !== undefined && atFrom.length > 0 && atFrom.length < allItems.length) {
          const again = yield* fetchPartition(key, "rekey", { from, fromOnly })
          const held = new Set(
            again.allItems
              .filter((item) => item[config.pk.field] === from)
              .map((item) => String(item.sk)),
          )
          if (atFrom.some((item) => !held.has(String(item.sk)))) continue
        }

        const current = yield* assembleAggregate(
          decodeSchema,
          rootNode,
          allItems,
          contextFields,
          key,
          aggregateName,
          systemAttrs,
        )
        const assembled = { ...(current as object) } as Record<string, unknown>
        const groups = yield* decomposeAggregate(
          assembled,
          rootNode,
          contextFields,
          rootEncoders,
          aggregateName,
          config.schema,
        )
        const rows = locateRows(
          groups,
          buildDynamoItems(groups, config, pkValue, undefined, keyRecord),
          allItems,
          pkValue,
          from,
        )
        const doubled = rows.filter(
          (row) => row.placement === "both" || row.placement === "ambiguous",
        )
        if (doubled.length > 0) {
          // In one partition, a move during the read shows a row at both keys too: it's
          // only under both while it's still under its old key.
          const held = yield* Effect.forEach(doubled, (row) =>
            client
              .getItem({
                TableName: tableConfig.name,
                Key: toAttributeMap({ [config.pk.field]: row.old.pk, sk: row.old.sk }),
                ConsistentRead: true,
              })
              .pipe(Effect.map(({ Item }) => Item !== undefined)),
          )
          if (held.some((still) => !still)) continue
          return {
            conflicts: doubled.map((row) => ({
              member: aggregateName,
              kind: "aggregate" as const,
              reason: "bothKeys" as const,
              key: { [config.pk.field]: row.old.pk, sk: row.old.sk },
              target: { [config.pk.field]: row.current.pk, sk: row.current.sk },
              message:
                row.placement === "both"
                  ? "The row is also stored under its current key: the aggregate is left as it is."
                  : "Its rows' keys overlap across key text, and which row is stored under which " +
                    "key can't be told from the keys held: the aggregate is left as it is.",
            })),
          }
        }

        // With `ownsRows`, every row of its types it reads is the aggregate's (DESIGN.md §7 "Which
        // rows in its partition are an aggregate's"), and it moves exactly what it moves without the
        // option: the rows its value decomposes to. Where any other row of its types would go can't
        // be told from what's stored, so it isn't moved. One whose own partition key changes would
        // be left behind in the old partition: the aggregate is left as it is, reported `failed`.
        // Otherwise the row stays where the aggregate reads it, counted `unrecognizedKey`. Without
        // `ownsRows`, nothing here applies.
        const placed = new Set<string>()
        for (const row of rows) {
          if (row.placement === "old") placed.add(positionOf(row.old.pk, row.old.sk))
          if (row.placement === "current") placed.add(positionOf(row.current.pk, row.current.sk))
        }
        const unplaced: Array<Position> = []
        for (const item of ownsRows ? allItems : []) {
          if (!ownedTypes.has(String(item.__edd_e__))) continue
          const at = { pk: String(item[config.pk.field]), sk: String(item.sk) }
          if (!placed.has(positionOf(at.pk, at.sk))) unplaced.push(at)
        }
        const stranded = unplaced.filter((at) => at.pk !== pkValue)
        if (stranded.length > 0) {
          return {
            conflicts: stranded.map((at) => ({
              member: aggregateName,
              kind: "aggregate" as const,
              reason: "failed" as const,
              key: { [config.pk.field]: at.pk, sk: at.sk },
              target: undefined,
              message:
                "The aggregate owns its rows (`ownsRows`), and this one isn't a row its value " +
                "decomposes to, so where it goes can't be told. Moving the rest would leave it in " +
                "the old partition: the aggregate is left as it is.",
            })),
          }
        }
        const left: Rekey.RekeyTally =
          unplaced.length > 0 ? { skipped: { unrecognizedKey: unplaced.length } } : {}
        const tally = (rows: number): Rekey.RekeyTally => ({ ...done(rows), ...left })
        const counted = rows.length

        // Each row's write keeps the `created` and `updated` of the row it moves.
        const createdField = stampFields?.createdAt ?? null
        const updatedField = stampFields?.updatedAt ?? null
        const keptCreated = new Map<string, unknown>()
        const keptUpdated = new Map<string, unknown>()
        for (const row of rows) {
          const was = row.placement === "old" ? row.atOld : row.atCurrent
          if (was === undefined) continue
          if (createdField !== null && was[createdField] !== undefined) {
            keptCreated.set(row.current.sk, was[createdField])
          }
          if (updatedField !== null && was[updatedField] !== undefined) {
            keptUpdated.set(row.current.sk, was[updatedField])
          }
        }
        const packedGroups = yield* packAggregateGroups(
          groups,
          packedByType,
          aggregateName,
          "update",
        )
        const rekeyedAt = yield* DateTime.now
        const built = (yield* composeOrFail("rekey", () =>
          buildDynamoItems(
            packedGroups,
            config,
            pkValue,
            assembled,
            keyRecord,
            stampFor(rekeyedAt, keptCreated, keptUpdated),
          ),
        )).flatMap((group) => group.items)
        const storedAt = new Map(
          stored.map((item) => [
            positionOf(item[config.pk.field]?.S ?? "", item.sk?.S ?? ""),
            item,
          ]),
        )
        const guardOf = (at: { readonly pk: string; readonly sk: string }) =>
          asReadGuard(storedAt.get(positionOf(at.pk, at.sk)) ?? {}, config.pk.field, [
            ...(updatedField === null ? [] : [updatedField]),
          ])
        const keyOf = (at: { readonly pk: string; readonly sk: string }) =>
          toAttributeMap({ [config.pk.field]: at.pk, sk: at.sk })
        // A custom `decompose`'s row is written as stored, its keys and its collection sort key
        // copy replaced: decomposing the value read back needn't give the attributes it holds (one
        // renaming a transformed field would store it decoded once more on every run).
        const mirror =
          config.collection.index !== undefined && config.collection.sk !== undefined
            ? config.collection.sk.field
            : undefined
        const itemOf = (r: number): Record<string, AttributeValue> => {
          const row = rows[r]!
          if (!row.custom) return built[r]!
          const at = row.placement === "old" ? row.old : row.current
          return {
            ...storedAt.get(positionOf(at.pk, at.sk)),
            [config.pk.field]: { S: row.current.pk },
            sk: { S: row.current.sk },
            ...(mirror !== undefined && { [mirror]: { S: row.current.sk } }),
          }
        }

        type Move = {
          readonly from: { readonly pk: string; readonly sk: string }
          readonly to: { readonly pk: string; readonly sk: string }
          readonly items: ReadonlyArray<TransactWriteItem>
        }
        const moves: Array<Move> = []
        const rewrites: Array<ReadonlyArray<TransactWriteItem>> = []
        for (const [r, row] of rows.entries()) {
          if (row.placement === "old") {
            moves.push({
              from: row.old,
              to: row.current,
              items: [
                {
                  Put: {
                    TableName: tableConfig.name,
                    Item: itemOf(r),
                    ConditionExpression: "attribute_not_exists(#pk)",
                    ExpressionAttributeNames: { "#pk": config.pk.field },
                  },
                },
                {
                  Delete: { TableName: tableConfig.name, Key: keyOf(row.old), ...guardOf(row.old) },
                },
              ],
            })
            continue
          }
          if (row.placement !== "current" || row.atCurrent === undefined) continue
          const item = itemOf(r)
          const stale = staleIndexFields(item, row.atCurrent)
          if (stale.length === 0) continue
          const guard = guardOf(row.current)
          const names: Record<string, string> = { ...guard.ExpressionAttributeNames }
          const values: Record<string, AttributeValue> = { ...guard.ExpressionAttributeValues }
          const sets = stale.map((field, i) => {
            names[`#x${i}`] = field
            values[`:x${i}`] = item[field]!
            return `#x${i} = :x${i}`
          })
          rewrites.push([
            {
              Update: {
                TableName: tableConfig.name,
                Key: keyOf(row.current),
                UpdateExpression: `SET ${sets.join(", ")}`,
                ConditionExpression: guard.ConditionExpression,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
          ])
        }
        if (moves.length === 0 && rewrites.length === 0) return tally(counted)
        if (dryRun) {
          movedRows += moves.length
          rewrittenRows += rewrites.length
          return tally(counted)
        }

        // In waves: a row moves once no row still to move is stored at its
        // current key, and the root once nothing else is left: while it's under the old partition
        // the next run finds the aggregate there. Each move's Put and Delete share a transaction;
        // a transaction takes the units in order while it is within DynamoDB's limits on one
        // (`packRequests`: 100 actions, 4 MB of item size, 16 MB of body), and at least one.
        const shape = transactWriteShape(yield* Capacity.requestFields)
        const units: Array<{
          readonly kind: "move" | "rewrite"
          readonly items: ReadonlyArray<TransactWriteItem>
        }> = rewrites.map((items) => ({ kind: "rewrite" as const, items }))
        let pending = moves
        let lost = false
        while (!lost && (pending.length > 0 || units.length > 0)) {
          const sources = new Set(pending.map((move) => positionOf(move.from.pk, move.from.sk)))
          const wave = pending.filter(
            (move) =>
              !sources.has(positionOf(move.to.pk, move.to.sk)) &&
              (pending.length === 1 || move.from.sk !== rekeyRootSk),
          )
          // Moves whose keys cycle: `placeRows` leaves such rows ambiguous, so
          // none reach here — reported below if one ever does.
          if (wave.length === 0 && units.length === 0) break
          pending = pending.filter((move) => !wave.includes(move))
          units.push(...wave.map((move) => ({ kind: "move" as const, items: move.items })))
          const chunks = packRequests(
            units.splice(0),
            (unit) => transactWriteUnit(unit.items),
            shape,
          )
          for (const chunk of chunks) {
            const written = yield* client
              .transactWriteItems({ TransactItems: chunk.flatMap((unit) => unit.items) })
              .pipe(
                Effect.as(true),
                Effect.catch((error: DynamoClientError) =>
                  isAwsTransactionCancelled(error.cause)
                    ? Effect.succeed(false)
                    : Effect.fail(error),
                ),
              )
            if (!written) {
              lost = true
              break
            }
            for (const unit of chunk) {
              if (unit.kind === "move") movedRows++
              else rewrittenRows++
            }
          }
        }
        // A write landed in between: read the aggregate again.
        if (lost) continue
        if (pending.length === 0) return tally(counted)
        return {
          ...tally(counted - pending.length),
          conflicts: pending.map((move) => ({
            member: aggregateName,
            kind: "aggregate" as const,
            reason: "failed" as const,
            key: { [config.pk.field]: move.from.pk, sk: move.from.sk },
            target: { [config.pk.field]: move.to.pk, sk: move.to.sk },
            message: "Its keys cycle with another row's: neither can move first.",
          })),
        }
      }
      return {
        ...(movedRows > 0 && { moved: { aggregate: movedRows } }),
        ...(rewrittenRows > 0 && { indexKeysRewritten: rewrittenRows }),
        conflicts: [
          {
            member: aggregateName,
            kind: "aggregate" as const,
            reason: "contended" as const,
            key,
            target: undefined,
            message: "Concurrent writes changed the aggregate on every attempt to move it.",
          },
        ],
      }
    })

  // rekey (#171, #183): the aggregate's part in `db.tables.<Table>.rekey()`. Its rows move together
  // ({@link rekeyCore}): the scan's root row runs the move, once per partition per run. A row below
  // the root moves with it; with no root in its partition there's no aggregate to move it with, and
  // it's reported ({@link rekeyFinish}).
  const rekeyTypes = (() => {
    const types = new Set<string>()
    const walk = (node: ResolvedNode): void => {
      types.add(node.entityType)
      for (const child of node.children) walk(child)
    }
    walk(rootNode)
    return [...types]
  })()
  const rekeyPrefix = composeCollectionKey(config.schema, config.collection.name, [])
  const rekeyRootSk = composeKey(config.schema, config.root.entityType, [])
  const rekeyUnit = (pk: string) => `${aggregateName}\u0000${pk}`

  const rootItemAt = (tableName: string, pk: string) =>
    Effect.flatMap(Capacity.client, (client) =>
      client.getItem({
        TableName: tableName,
        Key: toAttributeMap({ [config.pk.field]: pk, sk: rekeyRootSk }),
        ConsistentRead: true,
      }),
    )

  /** The partition key a row's values compose under `under`; none if they compose no key. */
  const partitionUnder = (under: DynamoSchemaModule.DynamoSchema, row: Record<string, unknown>) => {
    try {
      return collectionPkUnder(under, row)
    } catch {
      return undefined
    }
  }

  /**
   * Is `pk` a partition key a root row's values have composed: under each setting's text, and with
   * a numeric composite as either kind (`CompositeCodec.kindReadingOf`), the other kind read from
   * the digits the row stored. The current text comes first, and a root under it composes nothing
   * more.
   */
  const holdsPartition = (
    row: Record<string, AttributeValue>,
    key: Record<string, unknown>,
    pk: string,
  ): boolean =>
    [
      config.schema,
      KeyText136.schema136(config.schema),
      KeyText136.schema137(config.schema),
      KeyText136.schemaEscaped(config.schema),
    ].some(
      (under) =>
        kindReadingOf(
          keyRecord(key),
          config.pk.composite,
          (field) => row[field]?.N,
          ({ record }) =>
            composeCollectionKey(
              config.schema,
              config.collection.name,
              KeyComposer.extractKeyComposites(under, {}, config.pk.composite, record),
            ),
          pk,
        ) !== undefined,
    )

  /**
   * The root of another aggregate at `pk`, stored there under text its values no longer compose:
   * it moves first, or this move's rows would land in its partition.
   */
  const staleRootAt = (tableName: string, pk: string) =>
    Effect.map(rootItemAt(tableName, pk), ({ Item }) =>
      Item === undefined ||
      partitionUnder(config.schema, rootKeyAsRead(fromAttributeMap(Item))) === pk
        ? undefined
        : Item,
    )

  /**
   * What a run has learned: the partitions holding a root or about to, so each edge row in one costs
   * no read of its own, and the rows found in a partition with no root.
   */
  const rekeyRuns = new WeakMap<
    Rekey.RekeyRowContext,
    {
      readonly rooted: Set<string>
      readonly rootless: Array<Record<string, AttributeValue>>
    }
  >()
  const rekeyRunOf = (ctx: Rekey.RekeyRowContext) => {
    const known = rekeyRuns.get(ctx) ?? { rooted: new Set<string>(), rootless: [] }
    rekeyRuns.set(ctx, known)
    return known
  }

  const rekeyRowBelowRoot = (
    row: Record<string, AttributeValue>,
    pk: string,
    ctx: Rekey.RekeyRowContext,
  ) =>
    Effect.gen(function* () {
      const { rooted, rootless } = rekeyRunOf(ctx)
      if (rooted.has(pk)) return {}
      const { Item } = yield* rootItemAt(ctx.tableName, pk)
      if (Item !== undefined) {
        rooted.add(pk)
        return {}
      }
      rootless.push(row)
      return {}
    })

  /**
   * A row with no root in its partition, once everything is scanned: a root may have moved it on,
   * or be on its way to it (a run cut short moves the root last), in any order the scan met them,
   * and a dry run decides the same. Its values don't say whose it is unless the aggregate's context
   * holds them, so with no root at all there's no aggregate to move it with, and it's reported.
   *
   * A run that hasn't read the whole table can't say there's no root: a root at its old key, on a
   * page this run didn't read, names this partition only when the scan reaches it. So it reports
   * the row as unjudged, and a run over the whole table judges it.
   */
  const rekeyFinish = (
    ctx: Rekey.RekeyRowContext,
  ): Effect.Effect<Rekey.RekeyTally, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const { rooted, rootless } = rekeyRunOf(ctx)
      const client = yield* Capacity.client
      let left = 0
      for (const row of rootless) {
        if (rooted.has(row[config.pk.field]!.S!)) continue
        const { Item } = yield* client.getItem({
          TableName: ctx.tableName,
          Key: { [config.pk.field]: row[config.pk.field]!, sk: row.sk! },
          ConsistentRead: true,
        })
        if (Item !== undefined) left++
      }
      if (left === 0) return {}
      return { skipped: ctx.sawWholeTable() ? { unrecognizedKey: left } : { rootNotSeen: left } }
    })

  const rekeyRow = (
    row: Record<string, AttributeValue>,
    ctx: Rekey.RekeyRowContext,
    depth: number,
  ): Effect.Effect<Rekey.RekeyTally | undefined, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const pk = row[config.pk.field]?.S
      if (pk === undefined || (pk !== rekeyPrefix && !pk.startsWith(`${rekeyPrefix}#`))) {
        return undefined
      }
      if (row.sk?.S !== rekeyRootSk || row.__edd_e__?.S !== config.root.entityType) {
        return yield* rekeyRowBelowRoot(row, pk, ctx)
      }
      const key = rootKeyAsRead(fromAttributeMap(row) as Record<string, unknown>)
      const current = partitionUnder(config.schema, key)
      // Under none of the keys its values have had: nothing here can place it.
      if (current === undefined || !holdsPartition(row, key, pk)) {
        return { skipped: { unrecognizedKey: 1 } }
      }
      const { rooted } = rekeyRunOf(ctx)
      rooted.add(pk)
      rooted.add(current)
      return yield* ctx.once(
        rekeyUnit(pk),
        Effect.gen(function* () {
          const from = pk === current ? undefined : pk
          // The chain: another aggregate may still be stored where this one goes (`foo%20bar`'s
          // old row where `foo bar`'s current one belongs). It moves first; it leaves no row in
          // this one's way, and nothing is overwritten or merged whichever the scan reached first.
          let first: Rekey.RekeyTally = {}
          let fromOnly = false
          if (from !== undefined) {
            const stale = yield* staleRootAt(ctx.tableName, current)
            if (stale !== undefined) {
              const tooDeep = depth >= Rekey.DISPLACE_DEPTH
              first = tooDeep
                ? {}
                : yield* Rekey.displace(ctx, (under) => rekeyRow(stale, under, depth + 1))
              // A dry run moved nothing: what would stop that aggregate is what would leave it.
              const stillThere = ctx.dryRun
                ? tooDeep || (first.conflicts ?? []).length > 0
                : (yield* staleRootAt(ctx.tableName, current)) !== undefined
              if (stillThere) {
                return Rekey.mergeTallies(first, {
                  conflicts: [
                    {
                      member: aggregateName,
                      kind: "aggregate" as const,
                      reason: "taken" as const,
                      key: { [config.pk.field]: pk, sk: rekeyRootSk },
                      target: { [config.pk.field]: current, sk: rekeyRootSk },
                      message: "Another aggregate's root is stored where this one's belongs.",
                    },
                  ],
                })
              }
              fromOnly = ctx.dryRun
            }
          }
          const moved = yield* rekeyCore(key, ctx.dryRun, from, fromOnly).pipe(
            Effect.catch(
              (error: AggregateWriteError): Effect.Effect<Rekey.RekeyTally, DynamoClientError> => {
                if (Rekey.isDynamoClientError(error)) return Effect.fail(error)
                const assembly = error._tag === "AggregateAssemblyError" ? error.reason : undefined
                // Gone since the scan read it: deleted by a write.
                if (assembly === "Missing root item") return Effect.succeed({})
                // A root under both partition keys (its sort key is fixed, so one
                // partition holds one): neither copy is judged.
                const both = assembly === "Multiple root items found"
                // What went wrong, as the error says it: a tagged error's own message is empty.
                const detail =
                  error._tag === "AggregateAssemblyError" ||
                  error._tag === "AggregateDecompositionError"
                    ? error.reason
                    : error._tag === "ValidationError"
                      ? String(error.cause ?? error.message)
                      : error.message
                return Effect.succeed({
                  conflicts: [
                    {
                      member: aggregateName,
                      kind: "aggregate" as const,
                      reason: both ? ("bothKeys" as const) : ("failed" as const),
                      key: { [config.pk.field]: pk, sk: rekeyRootSk },
                      target: { [config.pk.field]: current, sk: rekeyRootSk },
                      message: both
                        ? "The aggregate's root is also stored under its current key."
                        : `${error._tag}: ${detail}`,
                    },
                  ],
                })
              },
            ),
          )
          return Rekey.mergeTallies(first, moved)
        }),
      )
    })

  const rekeyHandler: Rekey.RekeyMember = {
    name: aggregateName,
    types: rekeyTypes,
    row: (row, ctx) => rekeyRow(row, ctx, 0),
    finish: rekeyFinish,
  }

  return Rekey.carry(
    rekeyHandler,
    withOperations<Aggregate<TSchema, Record<string, unknown>>>(aggregateName, {
      [TypeId]: TypeId,
      _tag: "Aggregate",
      _tableTag: config.table.Tag,
      _packedByType: packedByType,
      _ownsRows: ownsRows,
      _attributeWriters: attributeWriters,
      _ownership: ownership,
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
          const { allItems } = yield* fetchPartition(key, "get")

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
          const client = yield* Capacity.client
          const tableConfig: TableConfig = yield* config.table.Tag

          // 1. Hydrate refs from edges
          const hydrated = yield* hydrateAggregateRefs(
            input,
            config.edges,
            schemaFields,
            aggregateName,
          )

          // 2. Validate via schema decode (decodeSchema substitutes nested edge
          //    self-date/Redacted leaves — Option A — and is identical to `schema`
          //    when no edge needs it). A date the library stamps is stamped now
          //    unless supplied, so what's composed and returned is what's stored.
          const now = yield* DateTime.now
          const written = fillStamps(rootNode, hydrated, now, "declared")
          const decoded = yield* Schema.decodeUnknownEffect(writeSchema)(written).pipe(
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
          const pkValue = yield* composeOrFail("create", () => collectionPkOf(assembled))

          // 4. Decompose into items grouped by sub-aggregate transaction boundaries
          const groups = yield* decomposeAggregate(
            assembled,
            rootNode,
            contextFields,
            rootEncoders,
            aggregateName,
            config.schema,
            { present: true, value: written, update: false },
          )

          // 5. Build DynamoDB items with composed keys (create only ever PUTs).
          //    Every row is new, so `created` has nothing to carry forward.
          const packedGroups = yield* packAggregateGroups(
            groups,
            packedByType,
            aggregateName,
            "create",
          )
          const dynamoGroups = yield* composeOrFail("create", () =>
            buildDynamoItems(
              packedGroups,
              config,
              pkValue,
              assembled,
              keyRecord,
              stampFor(now, EMPTY_CREATED),
            ),
          )
          yield* refuseOtherKindKeys(groups, "aggregate.create")
          yield* refuseNotReadBack(
            dynamoGroups,
            assembled,
            "aggregate.create",
            storedAsGivenIn(groups),
          )

          // 6. Write via sub-aggregate transactions. The root item goes first in
          //    the first transaction, guarded by `attribute_not_exists` (#134):
          //    an existing aggregate cancels it before any edge or sub-aggregate
          //    row is written. Rows below the root need no guard of their own —
          //    they are only ever written after the root's transaction commits.
          const rootSk = composeKey(config.schema, config.root.entityType, [])
          const isRoot = (item: Record<string, AttributeValue>) => item.sk?.S === rootSk
          const ordered = [...dynamoGroups]
            .sort((a, b) => Number(b.items.some(isRoot)) - Number(a.items.some(isRoot)))
            .map((g) => ({
              group: g.group,
              puts: [...g.items].sort((a, b) => Number(isRoot(b)) - Number(isRoot(a))),
              deletes: [],
            }))
          yield* writeTransactionGroups(
            client,
            tableConfig.name,
            ordered,
            aggregateName,
            groupKeys,
            {
              pkField: config.pk.field,
              entityType: config.root.entityType,
              key: { [config.pk.field]: pkValue, sk: rootSk },
            },
          )

          return decoded as Schema.Schema.Type<TSchema>
        }),

      update: (key, mutationFn) => updateCore(key, mutationFn),

      delete: (key) =>
        Effect.gen(function* () {
          const { client, tableConfig, allItems } = yield* readPartitionRaw(
            key,
            // `delete` declares no `ValidationError`: a rejected read keeps
            // DynamoDB's own tag, its message explained.
            (diagnosis, original) =>
              new DynamoValidationError({
                operation: "Query",
                cause: assemblyReadCause("delete", diagnosis, original),
              }),
          ).pipe(
            // Nor a key with no value: nothing to read, reported as a key that finds nothing.
            Effect.catchTag("ValidationError", (error) =>
              Effect.fail(
                new AggregateAssemblyError({
                  aggregate: aggregateName,
                  reason: String((error.cause as { message?: unknown })?.message ?? error.cause),
                  key,
                }),
              ),
            ),
          )

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
          const client = yield* Capacity.client
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
          const rootFilter = yield* compileListFilter(options?.filter, aggregateName)

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
          const listPkComposites = yield* composeOrFail("list", () =>
            keyCompositesOrThrow(
              aggregateName,
              "its list partition key",
              config.schema,
              listConfig.pk.composite,
              keyRecord(filter ?? {}),
            ),
          )

          // Build SK prefix from contiguous filter values matching SK composites.
          // `keyValueText`, NOT `String(v)` — the write side encodes
          // numerics, so `String(5)` would look for `5` where `0000000000000005`
          // is stored, and escapes the key's text.
          const skValues: string[] = []
          const listSkFilter = keyRecord(filter ?? {})
          for (const attr of listConfig.sk.composite) {
            if (listSkFilter[attr] !== undefined)
              skValues.push(
                KeyComposer.keyValueText(config.schema, listSkFilter[attr], config.schema.casing),
              )
            else break // Stop at first gap (prefix matching)
          }
          const skComplete = skValues.length === listConfig.sk.composite.length

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
                  "sharded aggregate always returns `cursor: None`; use `limit` to bound the " +
                  "result, or drop `list.cardinality` if the partition needs paging more than it " +
                  "needs spreading.",
              })
            }

            // Fan out across shards and merge. `limit` bounds each shard too — no
            // single shard can contribute more than the whole page.
            const shardQueries = Array.from({ length: listConfig.cardinality }, (_, shard) =>
              queryListPartition(
                client,
                tableConfig,
                listConfig,
                config.schema,
                {
                  pkValue: composeCollectionKey(config.schema, listConfig.name, [
                    ...listPkComposites,
                    String(shard),
                  ]),
                  skValues,
                  skComplete,
                  limit,
                  pageSize,
                  filter: rootFilter,
                  accept: options?.filterBy,
                  reverse: options?.reverse === true,
                  keyFields: listKeyFields,
                },
                aggregateName,
              ),
            )
            const shardResults = yield* Effect.all(shardQueries)
            const merged = shardResults.flatMap((r) => r.items)
            // Truncate the merged fan-out to `limit`. Previously the option was
            // accepted and discarded, so a large aggregate set returned everything.
            rootItems = limit === undefined ? merged : merged.slice(0, limit)
            nextKey = undefined
          } else {
            // `!== undefined`, as above: an empty string is a cursor no list
            // returned, not a way of saying "from the start".
            const startKey =
              options?.cursor === undefined ? undefined : decodeKeyCursor(options.cursor)
            if (options?.cursor !== undefined && startKey === undefined) {
              return yield* new ValidationError({
                entityType: aggregateName,
                operation: "list",
                cause:
                  `[EDD-9094] Aggregate "${aggregateName}": the cursor is not one a list returned. ` +
                  "A cursor is opaque: pass back the text of a previous `list` result's `cursor`, " +
                  "unchanged, to the same list. Nothing was sent.",
              })
            }
            const result = yield* queryListPartition(
              client,
              tableConfig,
              listConfig,
              config.schema,
              {
                pkValue: composeCollectionKey(config.schema, listConfig.name, listPkComposites),
                skValues,
                skComplete,
                limit,
                pageSize,
                startKey,
                filter: rootFilter,
                accept: options?.filterBy,
                reverse: options?.reverse === true,
                keyFields: listKeyFields,
              },
              aggregateName,
            )
            rootItems = result.items
            nextKey = result.lastKey
          }

          // Extract PK composite values from each root item and assemble
          const aggregates: Array<Schema.Schema.Type<TSchema>> = []
          for (const rootItem of rootItems) {
            const stored: Record<string, unknown> = {}
            for (const composite of config.pk.composite) {
              stored[composite] = rootItem[composite]
            }
            // The key the root's values compose as a read takes them, as `create` composed it.
            const key = rootKeyAsRead(stored)
            const assembled = yield* Effect.gen(function* () {
              const { allItems } = yield* fetchPartition(key, "list")
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

          const cursor = nextKey ? Option.some(encodeKeyCursor(nextKey)) : Option.none()

          return { data: aggregates, cursor }
        }),
    }),
  )
}

/**
 * Each aggregate operation as a named operation for consumed-capacity
 * reports (#174); the entity ops and batches it composes nest under it.
 */
const withOperations = <A extends Aggregate<any, any, any>>(aggregateName: string, ops: A): A => {
  const target = { target: aggregateName }
  return {
    ...ops,
    get: (key: any) => Capacity.operation("Aggregate.get", target, ops.get(key)),
    create: (input: any) => Capacity.operation("Aggregate.create", target, ops.create(input)),
    update: (key: any, mutationFn: any) =>
      Capacity.operation("Aggregate.update", target, ops.update(key, mutationFn)),
    delete: (key: any) => Capacity.operation("Aggregate.delete", target, ops.delete(key)),
    list: (filter: any, options: any) =>
      Capacity.operation("Aggregate.list", target, ops.list(filter, options)),
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
    // Detached: no current operation or parent span is pinned for later calls (#174).
    const ctx = Capacity.detachContext(yield* Effect.context<DynamoClient | TableConfig>())
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
  // A set has no own keys: compared below, any two would be equal, and a change to one
  // would never be written. Members are strings, numbers or binary values, by identity.
  if (a instanceof Set || b instanceof Set) {
    return (
      a instanceof Set &&
      b instanceof Set &&
      a.size === b.size &&
      [...a].every((member) => b.has(member))
    )
  }

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]))
}

const deepEqualGroups = (a: TransactionGroup, b: TransactionGroup): boolean =>
  sameItems(a.items, b.items)

/** Whether two decompositions are one: the same items, in order, of the same types and attributes. */
const sameItems = (a: ReadonlyArray<DecomposedItem>, b: ReadonlyArray<DecomposedItem>): boolean => {
  if (a.length !== b.length) return false
  return a.every((item, i) => {
    const other = b[i]!
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
  /** Fields of the model `edges` belong to — the root schema, or a sub-aggregate's. */
  readonly parentFields?: Record<string, Schema.Top> | undefined
  /** Fields of the value this node's rows hold, where that isn't `parentFields`. */
  readonly ownFields?: Record<string, Schema.Top> | undefined
  /** The aggregate's ref resolver, shared with its `decodeSchema`. */
  readonly resolveRef?: RefResolver | undefined
  readonly discriminator?: Record<string, unknown> | undefined
  readonly assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  readonly decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined
  readonly decomposeInput?: ((written: Written) => Option.Option<unknown>) | undefined
  readonly ownDiscriminator?: Record<string, unknown> | undefined
  readonly attrEncoders?: AttrEncoders | undefined
  readonly keyAttrEncoders?: AttrEncoders | undefined
  readonly skComposite?: ReadonlyArray<string> | undefined
  readonly refIdentifierField?: string | undefined
  readonly packed?: Readonly<Record<string, DynamoModel.PackedConfig>> | undefined
  readonly dispatch?: ReadonlyArray<string> | undefined
}

/**
 * The edge entity's packed fields that are top-level attributes of the node's
 * items (`itemFields`), refusing one that is a discriminator or a declared
 * sort-key composite (`[EDD-9072]`): those are compared and composed as scalar
 * stored values.
 */
const edgePackedFields = (
  edgeName: string,
  entity: { readonly model: Schema.Top; readonly entityType: string } | undefined,
  itemFields: Record<string, Schema.Top> | undefined,
  discriminator: Record<string, unknown> | undefined,
  skComposite: ReadonlyArray<string> | undefined,
): Readonly<Record<string, DynamoModel.PackedConfig>> | undefined => {
  if (entity === undefined) return undefined
  const configured = DynamoModel.getPackedFields(entity.model)
  const packed: Record<string, DynamoModel.PackedConfig> = {}
  for (const [field, storedAs] of Object.entries(configured)) {
    if (itemFields !== undefined && !(field in itemFields)) continue
    if (discriminator !== undefined && field in discriminator) {
      throw new Error(
        `[EDD-9072] Aggregate edge "${edgeName}": discriminator "${field}" is a packed field of ` +
          `entity "${entity.entityType}". A discriminator is matched as a scalar stored value.`,
      )
    }
    if ((skComposite ?? []).some((path) => path.split(".")[0] === field)) {
      throw new Error(
        `[EDD-9072] Aggregate edge "${edgeName}": sort-key composite "${field}" is a packed field ` +
          `of entity "${entity.entityType}". Key composites must be scalar model values.`,
      )
    }
    packed[field] = storedAs
  }
  return Object.keys(packed).length > 0 ? packed : undefined
}

/**
 * The attributes of an edge entity's items a reader dispatches on by stored
 * form: its packed ones, plus every non-sparse field of the item whose encoded
 * side is object- or array-shaped (a native value of it is never `S` or `B`) —
 * the edge counterpart of an entity's `dispatchAttributes`.
 */
const edgeDispatchFields = (
  entity: { readonly model: Schema.Top } | undefined,
  itemFields: Record<string, Schema.Top> | undefined,
  packed: Readonly<Record<string, DynamoModel.PackedConfig>> | undefined,
): ReadonlyArray<string> | undefined => {
  if (entity === undefined) return undefined
  const sparse = DynamoModel.getSparseFields(entity.model)
  const dispatch = new Set<string>(Object.keys(packed ?? {}))
  for (const [field, schema] of Object.entries(itemFields ?? {})) {
    if (field in sparse) continue
    if (isDispatchEligible(schema)) dispatch.add(field)
  }
  return dispatch.size > 0 ? [...dispatch] : undefined
}

/** A node's packed and stored-form-dispatch attributes, as `resolveNode` args. */
const edgeStorage = (
  packed: Readonly<Record<string, DynamoModel.PackedConfig>> | undefined,
  entity: { readonly model: Schema.Top } | undefined,
  itemFields: Record<string, Schema.Top> | undefined,
): Pick<ResolveNodeArgs, "packed" | "dispatch"> => ({
  packed,
  dispatch: edgeDispatchFields(entity, itemFields, packed),
})

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
    keyAttrEncoders,
    ownDiscriminator,
    parentFields,
    refIdentifierField,
    resolveRef,
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
        // The item is the edge value flattened: encode it field by field with
        // the edge entity's model (#72), or — for an edge without an entity —
        // with the model field's own class.
        const parentField = parentFields?.[field]
        const valueFields =
          fieldsOf(edge.entity?.model) ??
          (parentField === undefined
            ? undefined
            : getSchemaFields(unwrapOptionalField(parentField)))
        children.push(
          resolveNode({
            fieldName: field,
            entityType: edge.entityType,
            cardinality: "one",
            edges: {},
            discriminator: mergedDisc,
            ownDiscriminator: edge.discriminator,
            ownFields: valueFields,
            attrEncoders: buildAttrEncoders(valueFields, resolveRef),
            ...edgeStorage(
              edgePackedFields(
                field,
                edge.entity as
                  | { readonly model: Schema.Top; readonly entityType: string }
                  | undefined,
                valueFields,
                edge.discriminator,
                undefined,
              ),
              edge.entity as { readonly model: Schema.Top } | undefined,
              valueFields,
            ),
          }),
        )
      } else if (edge._tag === "ManyEdge") {
        // The item is one decomposed ELEMENT. Its encoders must come from the
        // element's schema — `PlayerSheet { player, isCaptain }` — not from the
        // edge entity's model (`Player { id, name, dateOfBirth }`), whose field
        // names never match a wrapper element's, so a hydrated ref inside the
        // element was never encoded (#133). An element that exposes no fields
        // (a custom `decompose`, an opaque ref element) falls back to the
        // entity's model, which is what such an element IS.
        const entityFields = fieldsOf(edge.entity?.model)
        const elementFields = manyElementFields(parentFields, field) ?? entityFields
        const parentField = parentFields?.[field]
        const arrayElement =
          parentField === undefined ? undefined : extractArrayElement(parentField)
        const keyedValue =
          parentField === undefined || arrayElement !== undefined
            ? undefined
            : extractKeyedValue(parentField)
        children.push(
          resolveNode({
            fieldName: field,
            entityType: edge.entityType,
            cardinality: "many",
            edges: {},
            discriminator,
            assemble: edge.assemble,
            decompose: edge.decompose,
            decomposeInput:
              edge.decompose === undefined
                ? undefined
                : storedFormFirst(field, parentFields?.[field], resolveRef),
            ownFields: elementFields,
            attrEncoders: buildAttrEncoders(
              elementFields,
              resolveRef,
              keyedValue !== undefined && edge.entity === undefined,
            ),
            // Sort-key composites keep reading the pre-#133 encoding (the entity
            // model's top-level transforms), so no stored key is re-spelled.
            keyAttrEncoders: buildKeyAttrEncoders(entityFields),
            // Declared sort-key composites, authoritative when present (#103).
            skComposite: edge.sk?.composite,
            refIdentifierField: edge.entity
              ? DynamoModel.getIdentifierField(edge.entity.model)?.name
              : undefined,
            ...edgeStorage(
              edgePackedFields(
                field,
                edge.entity as
                  | { readonly model: Schema.Top; readonly entityType: string }
                  | undefined,
                elementFields,
                discriminator,
                edge.sk?.composite,
              ),
              edge.entity as { readonly model: Schema.Top } | undefined,
              elementFields,
            ),
          }),
        )
      } else if (edge._tag === "BoundSubAggregate") {
        const bound = edge as BoundSubAggregate<any>
        const subFields = fieldsOf(bound.aggregate.schema)
        // A sub-aggregate nested in another inherits its parent's discriminator,
        // exactly as a `one` edge does: its rows carry the parent's attributes
        // (`clubNo`) as well as their own (`squadNo`), so assembly — which
        // matches on the merged set — can tell the two bindings of the parent
        // apart. At the top level there is no parent discriminator and this is
        // `bound.discriminator`, as before.
        const inherited =
          discriminator === undefined
            ? bound.discriminator
            : { ...discriminator, ...bound.discriminator }
        const subChildren = resolveNode({
          fieldName: field,
          entityType: bound.aggregate.root.entityType,
          cardinality: "one",
          edges: bound.aggregate.edges,
          parentFields: subFields,
          resolveRef,
          discriminator: inherited,
          ownDiscriminator: bound.discriminator,
          // The sub-aggregate root item carries the sub-schema's own (non-edge)
          // fields; its child edges get their own encoders via recursion.
          attrEncoders: buildAttrEncoders(subFields, resolveRef),
        })
        children.push(subChildren)
      }
    }
  }

  const ownFields = args.ownFields ?? parentFields
  return {
    fieldName,
    entityType,
    cardinality,
    ownFields,
    // Absent optionals stay absent under `exactOptionalPropertyTypes`.
    ...(discriminator !== undefined && { discriminator }),
    ...(ownDiscriminator !== undefined && { ownDiscriminator }),
    children,
    ...(assemble !== undefined && { assemble }),
    ...(decompose !== undefined && { decompose }),
    ...(args.decomposeInput !== undefined && { decomposeInput: args.decomposeInput }),
    ...(skComposite !== undefined && { skComposite }),
    ...(refIdentifierField !== undefined && { refIdentifierField }),
    ...(args.packed !== undefined && { packed: args.packed }),
    ...(args.dispatch !== undefined && { dispatch: args.dispatch }),
    attrEncoders,
    ...(keyAttrEncoders !== undefined && { keyAttrEncoders }),
  }
}

// ---------------------------------------------------------------------------
// Internal: packed edge attributes (#147)
// ---------------------------------------------------------------------------

/** Every node's packed attributes, by the entity type of its items. */
const collectPackedByType = (
  root: ResolvedNode,
): ReadonlyMap<string, Readonly<Record<string, DynamoModel.PackedConfig>>> => {
  const out = new Map<string, Record<string, DynamoModel.PackedConfig>>()
  const walk = (node: ResolvedNode): void => {
    if (node.packed !== undefined) {
      out.set(node.entityType, { ...(out.get(node.entityType) ?? {}), ...node.packed })
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return out
}

/** Every node's stored-form-dispatch attributes, by the entity type of its items. */
const collectDispatchByType = (root: ResolvedNode): ReadonlyMap<string, ReadonlyArray<string>> => {
  const out = new Map<string, Set<string>>()
  const walk = (node: ResolvedNode): void => {
    if (node.dispatch !== undefined) {
      const attrs = out.get(node.entityType) ?? new Set<string>()
      for (const attr of node.dispatch) attrs.add(attr)
      out.set(node.entityType, attrs)
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return new Map([...out].map(([type, attrs]) => [type, [...attrs]]))
}

/** The decomposed groups with each item's packed attributes in their stored form. */
const packAggregateGroups = (
  groups: ReadonlyArray<TransactionGroup>,
  packedByType: ReadonlyMap<string, Readonly<Record<string, DynamoModel.PackedConfig>>>,
  aggregateName: string,
  operation: string,
): Effect.Effect<ReadonlyArray<TransactionGroup>, ValidationError> =>
  packedByType.size === 0
    ? Effect.succeed(groups)
    : withRegistry((registry) => {
        const packedGroups: Array<TransactionGroup> = []
        for (const group of groups) {
          const items: Array<DecomposedItem> = []
          for (const item of group.items) {
            const packed = packedByType.get(item.entityType)
            if (packed === undefined) {
              items.push(item)
              continue
            }
            const attributes = { ...item.attributes }
            const failure = packItemSync(attributes, packed, registry, {
              entityType: `${aggregateName}.${item.member}`,
              operation: `aggregate.${operation}.packed`,
            })
            if (failure !== undefined) return failure
            items.push({ ...item, attributes })
          }
          packedGroups.push({ ...group, items })
        }
        return packedGroups
      })

/**
 * Read, in place, each item's dispatch attributes by their stored form — by
 * what is stored, whatever the edge entity configures now. A row with no
 * string or binary value on any of them costs one `typeof` per attribute.
 * One Effect for the whole partition; the work inside is synchronous.
 */
const unpackAggregateItems = (
  items: ReadonlyArray<Record<string, unknown>>,
  dispatchByType: ReadonlyMap<string, ReadonlyArray<string>>,
  aggregateName: string,
): Effect.Effect<void, ValidationError> =>
  dispatchByType.size === 0
    ? Effect.void
    : withRegistry((registry) => {
        for (const item of items) {
          const dispatch = dispatchByType.get(item.__edd_e__ as string)
          if (dispatch === undefined || !hasStoredForm(item, dispatch)) continue
          const failure = unpackItemSync(item, dispatch, registry, {
            entityType: `${aggregateName}.${String(item.__edd_e__)}`,
            operation: "aggregate.decode",
          })
          if (failure !== undefined) return failure
        }
        return undefined
      })

// ---------------------------------------------------------------------------
// Internal: Query all items in the aggregate partition
// ---------------------------------------------------------------------------

const queryAllItems = <E>(
  client: DynamoClientService,
  tableName: string,
  indexName: string | undefined,
  pkField: string,
  pkValue: string,
  consistentRead: boolean,
  /** A consistent read of a GSI, which DynamoDB rejects, as the caller names it (#144). */
  consistentReadRejected: (diagnosis: Diagnosis, original: unknown) => E,
  /** Where to keep each item as stored, too: `rekey` guards its writes on them (#171). */
  stored?: Array<Record<string, AttributeValue>>,
): Effect.Effect<Array<Record<string, unknown>>, DynamoClientError | E> =>
  Effect.gen(function* () {
    const allItems: Array<Record<string, unknown>> = []
    let exclusiveStartKey: Record<string, AttributeValue> | undefined

    // Paginate through all results. Assembly needs every item in the partition and
    // discriminates them by `__edd_e__`, so there is no sort-key condition and no
    // ordering requirement — which is why `IndexName` is optional here.
    do {
      const input = {
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": pkField },
        ExpressionAttributeValues: { ":pk": toAttributeValue(pkValue) },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: consistentRead || undefined,
      }
      const result = yield* client.query(input).pipe(
        diagnoseFailure({
          sent: () => ({ _tag: "Read", scan: false, input }),
          only: ["ConsistentReadOnGsi"],
          rewrite: consistentReadRejected,
        }),
      )

      if (result.Items) {
        for (const item of result.Items) {
          allItems.push(fromAttributeMap(item as Record<string, AttributeValue>))
          stored?.push(item as Record<string, AttributeValue>)
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
    const reached = assemblyWalk(rootNode, allItems, (node, item) =>
      takesRow(node, item.__edd_e__, (attr) => item[attr]),
    )
    // Find the root item
    const rootItems = reached.get(rootNode) ?? []

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
      const assembled = yield* assembleNode(child, reached, key, aggregateName, systemAttrs)
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
      ...stampsToStrip(rootNode, systemAttrs),
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

/**
 * Whether assembly hands a row to `node`: the row's entity type is the node's, and so is each of
 * the node's static discriminator values (a computed one, a function, isn't matched). A node's
 * discriminator already holds every enclosing one (`resolveNode`). `valueOf` reads an attribute of
 * the row as a read has it.
 */
const takesRow = (
  node: ResolvedNode,
  entityType: unknown,
  valueOf: (attr: string) => unknown,
): boolean => {
  if (entityType !== node.entityType) return false
  for (const [attr, value] of Object.entries(node.discriminator ?? {})) {
    if (typeof value === "function") continue
    if (valueOf(attr) !== value) return false
  }
  return true
}

/**
 * Assembly's walk over an aggregate's rows: each node a read reaches, with the rows it takes
 * (`takesRow`). A node with edges (the root, a sub-aggregate) leads to them only through its one
 * row: one that takes none is absent, and one that takes more can't be assembled, so a read hands
 * nothing to the nodes under it. Assembly reads each node's rows off this walk, and the write
 * check (`EDD-9128`) judges a row only by the nodes it reaches, so the two never disagree on which
 * node a row is.
 */
const assemblyWalk = <Row>(
  rootNode: ResolvedNode,
  rows: ReadonlyArray<Row>,
  takes: (node: ResolvedNode, row: Row) => boolean,
): ReadonlyMap<ResolvedNode, ReadonlyArray<Row>> => {
  const reached = new Map<ResolvedNode, ReadonlyArray<Row>>()
  const visit = (node: ResolvedNode): void => {
    const taken = rows.filter((row) => takes(node, row))
    reached.set(node, taken)
    if (node.children.length > 0 && taken.length !== 1) return
    for (const child of node.children) visit(child)
  }
  visit(rootNode)
  return reached
}

const assembleNode = (
  node: ResolvedNode,
  reached: ReadonlyMap<ResolvedNode, ReadonlyArray<Record<string, unknown>>>,
  key: Record<string, unknown>,
  aggregateName: string,
  systemAttrs: ReadonlySet<string> = EMPTY_ATTRS,
): Effect.Effect<unknown, AggregateAssemblyError | ValidationError> =>
  Effect.gen(function* () {
    const matchingItems = reached.get(node) ?? []

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

        // Its one row leads to its edges (`assemblyWalk`). Each child's discriminator already holds
        // this node's (`resolveNode`).
        for (const child of node.children) {
          const assembled = yield* assembleNode(child, reached, key, aggregateName, systemAttrs)
          if (child.fieldName !== null && assembled !== undefined) {
            edgeValues[child.fieldName] = assembled
          }
        }

        // Build sub-aggregate result: sub-root fields + assembled edges
        const subFields: Record<string, unknown> = {}
        const edgeFieldNames = new Set(node.children.map((c) => c.fieldName).filter(Boolean))
        const stripped = stampsToStrip(node, systemAttrs)

        for (const [fieldKey, value] of Object.entries(subRootItem)) {
          // Skip DynamoDB metadata, discriminator attributes, and edge fields
          if (fieldKey === "__edd_e__") continue
          if (fieldKey.startsWith("pk") || fieldKey.startsWith("sk")) continue
          if (fieldKey.startsWith("gsi") || fieldKey.startsWith("lsi")) continue
          if (stripped.has(fieldKey)) continue
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
      return stripMetadata(item, stampsToStrip(node, systemAttrs))
    }

    // Many edge: collect all matching items
    const stripped = matchingItems.map((item) =>
      stripMetadata(item, stampsToStrip(node, systemAttrs)),
    )

    if (node.assemble) {
      return node.assemble(stripped)
    }

    return stripped
  })

// ---------------------------------------------------------------------------
// Internal: Strip DynamoDB metadata from items
// ---------------------------------------------------------------------------

const EMPTY_ATTRS: ReadonlySet<string> = new Set()

/** The timestamps a node's rows hold beside its value: those its value doesn't declare. */
const stampsToStrip = (
  node: ResolvedNode,
  systemAttrs: ReadonlySet<string>,
): ReadonlySet<string> => {
  const own = node.ownFields
  if (own === undefined) return systemAttrs
  const kept = [...systemAttrs].filter((name) => !(name in own))
  return kept.length === systemAttrs.size ? systemAttrs : new Set(kept)
}

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
 * The attribute an entity is fetched by from one id: its primary key's only composite. The id an
 * edge is given is typed as that composite's value (`RefEntityIdentifierValue`), whatever the
 * entity's `DynamoModel.identifier` names, so it's the key it's fetched under. `undefined` for a
 * primary key composed from more than one attribute, or none: no one id names one item there.
 */
const refFetchKey = (entity: RefEntity): string | undefined => {
  const composites = primaryCompositesOf(entity)
  return composites.length === 1 ? composites[0] : undefined
}

/** An entity's primary key composites, its partition key's then its sort key's. */
const primaryCompositesOf = (entity: RefEntity): ReadonlyArray<string> => {
  const primary = (
    entity.indexes as
      | {
          readonly primary?: {
            readonly pk?: { readonly composite?: ReadonlyArray<string> }
            readonly sk?: { readonly composite?: ReadonlyArray<string> }
          }
        }
      | undefined
  )?.primary
  return [...(primary?.pk?.composite ?? []), ...(primary?.sk?.composite ?? [])]
}

/**
 * Walk the input recursively following graph edges, collect ref IDs,
 * fetch referenced entities, and replace IDs with hydrated domain data.
 */
const hydrateAggregateRefs = (
  input: Record<string, unknown>,
  edges: Record<string, AggregateEdge | BoundSubAggregate<any>>,
  fields: Record<string, Schema.Top> | undefined,
  aggregateName: string,
): Effect.Effect<
  Record<string, unknown>,
  RefNotFound | DynamoClientError | ValidationError,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    // Collect all ref IDs from the entire input hierarchy
    const refRequests: RefRequest[] = []
    collectRefIdsFromEdges(refRequests, input, edges, fields, [])

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
      const identifierName = refFetchKey(entity)
      if (identifierName === undefined) {
        // Nothing to fetch it by: 1.39.0 fetched under its identifier (or `id`), which no key
        // composes from alone, and died composing it.
        const composites = primaryCompositesOf(entity)
        const fields = [...new Set(reqs.map((req) => req.fieldName))]
        return yield* new ValidationError({
          entityType: aggregateName,
          operation: "aggregate.create",
          cause: new Error(
            `[EDD-9129] Aggregate "${aggregateName}": ${fields.map((name) => `"${name}"`).join(", ")} ` +
              `${fields.length === 1 ? "is" : "are"} given an id of entity "${entityType}", whose ` +
              `primary key is composed from ${
                composites.length === 0
                  ? "no attribute"
                  : composites.map((name) => `"${name}"`).join(", ")
              }, so no one id names one item to fetch. Key that entity by one attribute to ` +
              `fetch it by id.`,
          ),
        })
      }

      // Deduplicate IDs for this entity type
      const uniqueIds = [...new Set(reqs.map((r) => r.id))]

      // `RefEntity` is the pure structural bound (no `get` — issue #66): aggregate
      // edges can be authored from AWS-free `@effect-dynamodb/schema` definitions,
      // which carry no runtime `.get`/operations. Ref hydration is a runtime
      // operation, so promote a pure edge target to a full operational Entity (a
      // thin op-attach over its retained `_data`); runtime-authored targets already
      // carry `.get` and pass through untouched. Mirrors `DynamoClient.make()`'s
      // entity binding. The loop is already grouped by entity type, so this promotes
      // once per distinct edge entity type per hydrate (issue #71).
      const runtimeEntity = (
        typeof (entity as { readonly get?: unknown }).get === "function"
          ? entity
          : entityFromDefinition(entity as unknown as EntityDefinition)
      ) as RefEntity & {
        readonly get: (key: any) => any
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
        // `Batch.get` returns the decoded record: domain values, as a caller holds, and
        // `writeSchema` takes them as that. Encoded here, a field with one type on both
        // sides of a transformation would be taken for a domain value and encoded twice.
        hydratedLookup.set(`${entityType}:${id}`, result as Record<string, unknown>)
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
  /** The fields of the schema `input` is a value of: a `many` element's are read off it. */
  fields: Record<string, Schema.Top> | undefined,
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
        collectRefIdsFromEdges(
          result,
          subInput as Record<string, unknown>,
          bound.aggregate.edges,
          fieldsOf(bound.aggregate.schema),
          [...path, edgeName],
        )
      }
    } else if (edge._tag === "ManyEdge" && edge.entity) {
      // ManyEdge with entity → walk array elements for ref IDs
      const inputKey = edge.inputField ?? edgeName
      const arr = input[inputKey]
      if (Array.isArray(arr)) {
        const entityFieldName = deriveEntityFieldName(edge.entity)
        // An element wrapping the entity names it by a field of its own, which its input takes as
        // `${field}Id` (`deriveElementInputSchema`). An element declaring no such field holds no
        // ref, whatever it holds: an element that is the entity's own model has its key field
        // (`lineId` of a `Line`) as a value of its own, and 1.39.0 took it for a ref.
        const wraps = manyElementFields(fields, edgeName)?.[entityFieldName] !== undefined
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
          } else if (wraps && elem != null && typeof elem === "object") {
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
 * Deep-copy a create input so ref replacement can mutate it — like
 * `structuredClone`, which this replaces, except that DOMAIN VALUES survive.
 *
 * `structuredClone` copies only own enumerable properties, so it reduced every
 * Effect data type to a bare object: a `DateTime` became `{ epochMilliseconds }`
 * with no prototype or tag, a `Redacted` became `{}`, an `Option` lost its
 * variant. No schema accepts those, so any aggregate with a ref edge rejected
 * such a value in its create input (#133).
 *
 * - Values implementing `Equal` — `DateTime`, `Redacted`, `Option`, `Duration`,
 *   `Chunk`, `HashMap`, … — are immutable, so they are kept by reference.
 * - Built-ins `structuredClone` knows (`Date`, `Map`, `Set`, `RegExp`, binary
 *   data) still go through it.
 * - Plain objects, arrays and other class instances (a `Schema.Class` value
 *   among them) are walked and copied to plain objects, as `structuredClone`
 *   copied them — so ref replacement never mutates the caller's objects.
 * - Cycles are preserved, as `structuredClone` preserved them.
 */
const cloneInput = (value: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Equal.isEqual(value)) return value
  const prior = seen.get(value)
  if (prior !== undefined) return prior
  if (Array.isArray(value)) {
    const copy: Array<unknown> = []
    seen.set(value, copy)
    for (const entry of value) copy.push(cloneInput(entry, seen))
    return copy
  }
  if (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof RegExp ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  ) {
    const copy = structuredClone(value)
    seen.set(value, copy)
    return copy
  }
  const copy: Record<string, unknown> = {}
  seen.set(value, copy)
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneInput(entry, seen)
  return copy
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
  const result = cloneInput(input) as Record<string, unknown>

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
  /**
   * Root item only: its attributes under the pre-#133 key encoders, which its
   * list-index composites are read from (see `buildKeyAttrEncoders`).
   */
  readonly keyAttributes?: Record<string, unknown>
  readonly transactionGroup: string
  readonly skComposites: ReadonlyArray<string>
  /**
   * The sort key composites in the other setting's text, for `rekey` to find a row stored under
   * them. Asked for only there: a value that setting refuses (`NaN`) stops nothing else.
   */
  readonly skCompositesOther: () => ReadonlyArray<string>
  /**
   * A `many` element's sort key with some numeric values as the other kind, in either setting's
   * text, that is one of `targets`: a field that stored both composed each value's own kind's text
   * (`EDD-9128`), and `rekey` looks for a row there too. Found value by value
   * (`CompositeCodec.kindReadingOf`), never by composing each combination; `undefined` when none
   * is. A value a setting refuses (`NaN`) gives none there.
   */
  readonly otherKindSortKey?: ((targets: KindTargets) => string | undefined) | undefined
  /**
   * A `many` element only: the text `node`'s sort key composes for the composite `path` from the
   * element, as `node`'s decomposition composes it (`EDD-9128` judges each node a read hands the
   * row to); `undefined` when `node` composes none from it.
   */
  readonly skTextFor?: ((node: ResolvedNode, path: string) => string | undefined) | undefined
  /** Edge field name (entity type for the root) — used to name the culprit in errors. */
  readonly member: string
  /** What the row does with each timestamp. */
  readonly rowStamps: RowStamps | undefined
  /** The fields stored as given, which no encoder of theirs takes (see {@link AttrEncoder}). */
  readonly storedAsGiven: ReadonlyArray<string>
  /** The node that decomposed it. */
  readonly node: ResolvedNode
}

/** A group of items to write in a single transaction */
interface TransactionGroup {
  readonly name: string
  readonly items: ReadonlyArray<DecomposedItem>
}

/** Each field a decomposition stored as given, once, as `"field" of "member"` (`EDD-9127`). */
const storedAsGivenIn = (groups: ReadonlyArray<TransactionGroup>): ReadonlyArray<string> => [
  ...new Set(
    groups.flatMap((group) =>
      group.items.flatMap((item) =>
        item.storedAsGiven.map((field) => `"${field}" of "${item.member}"`),
      ),
    ),
  ),
]

/**
 * A node's two encoder sets: `stored` puts every attribute into its stored
 * form; `key` is what composed keys are read from (see `buildKeyAttrEncoders`).
 */
interface NodeEncoders {
  readonly stored: AttrEncoders
  readonly key: AttrEncoders
}

/** Context values, as stored on member items and as their keys read them. */
interface ContextValues {
  readonly stored: Record<string, unknown>
  readonly key: Record<string, unknown>
}

/**
 * Decompose an assembled domain object into DynamoDB items grouped by
 * sub-aggregate transaction boundaries.
 */
const decomposeAggregate = (
  assembled: Record<string, unknown>,
  rootNode: ResolvedNode,
  contextFields: ReadonlyArray<string>,
  encoders: NodeEncoders,
  aggregateName: string,
  schema: DynamoSchemaModule.DynamoSchema,
  /**
   * A write's own value (`create`'s input, the state `update`'s mutation returned), before it was
   * decoded: a custom `decompose` is handed it read as on 1.39.0. Undefined for what was read.
   */
  written?: Written | undefined,
): Effect.Effect<ReadonlyArray<TransactionGroup>, AggregateDecompositionError> =>
  Effect.gen(function* () {
    const items: DecomposedItem[] = []
    const encodeWith = (
      set: AttrEncoders,
      field: string,
      value: unknown,
      asGiven?: () => void,
    ): unknown => {
      const encode = set[field]
      return encode && value != null ? encode(value, asGiven) : value
    }

    // Extract context values from the root, encoded for DynamoDB storage.
    // Domain Date/DateTime objects must be encoded before toAttributeMap() marshalling,
    // otherwise Date objects become { M: {} } (no enumerable properties).
    const contextValues: ContextValues = { stored: {}, key: {} }
    for (const field of contextFields) {
      const value = assembled[field]
      contextValues.stored[field] = encodeWith(encoders.stored, field, value)
      contextValues.key[field] = encodeWith(encoders.key, field, value)
    }

    // Root item: fields not claimed by edges
    const edgeFieldNames = new Set(rootNode.children.map((c) => c.fieldName).filter(Boolean))
    const rootAttrs: Record<string, unknown> = {}
    const rootKeyAttrs: Record<string, unknown> = {}
    // A context field is a root field, so this names it too.
    const rootAsGiven: Array<string> = []
    for (const [key, value] of Object.entries(assembled)) {
      if (edgeFieldNames.has(key)) continue
      rootAttrs[key] = encodeWith(encoders.stored, key, value, () => rootAsGiven.push(key))
      rootKeyAttrs[key] = encodeWith(encoders.key, key, value)
    }

    items.push({
      entityType: rootNode.entityType,
      attributes: rootAttrs,
      keyAttributes: rootKeyAttrs,
      transactionGroup: "root",
      skComposites: [],
      skCompositesOther: () => [],
      member: rootNode.entityType,
      rowStamps: rootNode.rowStamps,
      storedAsGiven: rootAsGiven,
      node: rootNode,
    })

    // Decompose each edge
    for (const child of rootNode.children) {
      const fieldValue = assembled[child.fieldName!]
      yield* decomposeNode(
        items,
        child,
        fieldValue,
        contextValues,
        "root",
        { current: [], other: () => [] },
        aggregateName,
        schema,
        writtenField(written, child.fieldName!),
      )
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
              ` between its elements: ${item.member}: Aggregate.many({ …, sk: { composite: [...] } }).`
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
 * An entity type a row carries, and the fixed text its sort keys begin with, cased as they are.
 * `any`: the row can carry any type, because its member stores another attribute under
 * `__edd_e__` (`via` names it).
 */
interface RowType {
  readonly type: string
  readonly label: string
  readonly any?: { readonly via: string } | undefined
}

/**
 * A channel through which a member of a table writes an attribute (DESIGN.md §7 "Which rows in its
 * partition are an aggregate's"), as the row holds it after the last write of each: the attribute
 * (`field`; undefined, any attribute but `except`), the fixed text its value begins with (`head`,
 * `$<schema>#v<version>#<label>` cased as the key is; undefined, any text), whether the value is
 * exactly that text (`exact`: true, exactly it; false, it continued after `#`; undefined, either),
 * the rows it's written on (`types`), the table it writes (`table`, a table's tag), and what it is,
 * for a refusal to name (`channel`).
 */
export interface AttributeWriter {
  readonly field: string | undefined
  readonly except?: ReadonlyArray<string>
  readonly head: string | undefined
  readonly exact?: boolean | undefined
  readonly types: ReadonlyArray<RowType>
  readonly table: unknown
  readonly channel: string
}

/** What an aggregate declaring `ownsRows` is checked against at bind. */
export interface Ownership {
  readonly pkField: string
  readonly pkComposite: ReadonlyArray<string>
  readonly partitionHead: string
  readonly schema: DynamoSchemaModule.DynamoSchema
  readonly table: unknown
  readonly types: ReadonlyArray<RowType>
  /** The members the aggregate's table declares. */
  readonly declared: ReadonlyArray<{ readonly name: string; readonly member: unknown }>
}

/**
 * Whether two keys beginning with these fixed texts can be one text: the texts are equal, or one
 * continues the other after a `#`. A composite value is taken to be any text (with `escapeKeys`
 * off one may hold `#`), so this never misses a key that can be the other's.
 */
const headsOverlap = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}#`) || b.startsWith(`${a}#`)

/**
 * Whether a writer's text can be the aggregate's partition key: any text can, and composed text
 * can when it and the key can be one text ({@link headsOverlap}). The aggregate's partition key is
 * its head continued after `#` when it has composites, and exactly its head when it has none (a
 * singleton): text that continues its own head can be that only when its head and a `#` begin it.
 */
const canBePartitionKey = (writer: AttributeWriter, ownership: Ownership): boolean => {
  const head = writer.head
  if (head === undefined) return true
  const partition = ownership.partitionHead
  if (ownership.pkComposite.length === 0) {
    const equal = head === partition
    const continued = partition.startsWith(`${head}#`)
    return writer.exact === true ? equal : writer.exact === false ? continued : equal || continued
  }
  return writer.exact === true ? head.startsWith(`${partition}#`) : headsOverlap(head, partition)
}

/**
 * Whether a row of `theirs` can be taken for a row of `ours`: it can carry any type, it's the same
 * type, or keys of the two can be one text, each cased as its member's keys are. A bind-time
 * comparison only: ownership and assembly match `__edd_e__` exactly.
 */
const typesCollide = (theirs: RowType, ours: RowType): boolean =>
  theirs.any !== undefined || theirs.type === ours.type || headsOverlap(theirs.label, ours.label)

/**
 * A member's writers, every row type of them made any when one stores an attribute under
 * `__edd_e__` other than the library's marker, or any attribute: its rows can carry any type. An
 * aggregate's timestamp so named does, since it's written last. An entity can't (`EDD-9140`).
 */
const withTypeOverwrites = (
  writers: ReadonlyArray<AttributeWriter>,
): ReadonlyArray<AttributeWriter> => {
  const marker = writers.find(
    (writer) =>
      writer.field === "__edd_e__" ||
      (writer.field === undefined && writer.except?.includes("__edd_e__") !== true),
  )
  if (marker === undefined) return writers
  const any = { via: `${marker.channel}, stored under "__edd_e__"` }
  return writers.map((writer) => ({
    ...writer,
    types: writer.types.map((type) => ({ ...type, any })),
  }))
}

/**
 * The attributes an entity writes (DESIGN.md §7 "Which rows in its partition are an aggregate's"),
 * as each row holds them after the last write of each:
 * - its primary key on every row it writes under it: live rows, version snapshots, soft-delete
 *   tombstones, time-series events, projection tombstones and outbox items;
 * - each secondary index's partition key on its live rows, and each vector index's partition;
 * - its unique sentinels, under their own key, with back-pointers to the owning row's key;
 * - any sort key, its timestamps, `deletedAt`, and the attributes a projection writes on its
 *   tombstones and outbox items, as any text;
 * - its model attributes, on its rows and kept on its projection tombstones: any name holding any
 *   text, but `__edd_e__` and its table key attributes, which it writes after them (`EDD-9109` and
 *   `EDD-9140` refuse a model attribute stored under them).
 * None of its rows is an aggregate node's: it composes each composite with its field's name
 * (`id_p`), which an aggregate never does, and its primary key has at least one. An entity whose
 * keys can't be read is taken to write any attribute.
 */
const entityWriters = (entity: unknown): ReadonlyArray<AttributeWriter> => {
  const e = entity as {
    readonly entityType: string
    readonly indexes: Record<string, KeyComposer.IndexDefinition>
    readonly unique?: Record<string, unknown> | undefined
    readonly softDelete?: unknown
    readonly systemFields?: {
      readonly createdAt: string | null
      readonly updatedAt: string | null
    }
    readonly _vectorIndexes?: Record<
      string,
      {
        readonly partitionField: string
        readonly compose: unknown
        readonly casing?: DynamoSchemaModule.Casing
      }
    >
    readonly _projectionTombstones?: unknown
    /** Every projection's outbox on this read model, one per projection defined on it. */
    readonly _projectionOutboxes?: ReadonlyArray<{
      /** Undefined: on the row table, under the row's own key attributes. */
      readonly table: { readonly Tag: unknown } | undefined
      readonly pk: string
      readonly sk: string
      readonly index?: { readonly pk: string; readonly sk: string } | undefined
    }>
    readonly _schema: DynamoSchemaModule.DynamoSchema
    readonly _tableTag: unknown
  }
  const type = e.entityType
  const table = e._tableTag
  try {
    const schema = e._schema
    const typed = (name: string, casing?: DynamoSchemaModule.Casing): RowType => ({
      type: name,
      label: composeKey(schema, name, [], { casing }),
    })
    const labelOf = (index: KeyComposer.IndexDefinition): string => {
      const collection = index.collection
      return collection === undefined
        ? type
        : Array.isArray(collection)
          ? collection[0]!
          : (collection as string)
    }
    // A partition key with composites, or a shard, continues its head after `#`.
    const exactOf = (index: KeyComposer.IndexDefinition): false | undefined =>
      index.pk.composite.length > 0 || index.shards !== undefined ? false : undefined
    const primary = e.indexes.primary!
    const tableKeys = [
      primary.pk.field,
      ...(primary.sk?.field === undefined ? [] : [primary.sk.field]),
    ]
    const stamps = [e.systemFields?.createdAt, e.systemFields?.updatedAt].filter(
      (name): name is string => typeof name === "string",
    )
    const writers: Array<AttributeWriter> = []
    const anyText = (
      fields: ReadonlyArray<string>,
      types: ReadonlyArray<RowType>,
      on: unknown,
      channel: (field: string) => string,
    ): void => {
      for (const field of fields) {
        writers.push({ field, head: undefined, types, table: on, channel: channel(field) })
      }
    }
    const projectionTypes: Array<RowType> = []
    for (const [name, index] of Object.entries(e.indexes)) {
      const head = composeKey(schema, labelOf(index), [], { casing: index.casing })
      const exact = exactOf(index)
      const own = typed(type, index.casing)
      if (name !== "primary") {
        // A half on a table key attribute holds the primary key's text (an inverted index): two
        // halves of one entity share an attribute only with the same fields (`EDD-9106`).
        if (!tableKeys.includes(index.pk.field)) {
          writers.push({
            field: index.pk.field,
            head,
            exact,
            types: [own],
            table,
            channel: `its index "${name}"`,
          })
        }
        if (index.sk?.field !== undefined && !tableKeys.includes(index.sk.field)) {
          writers.push({
            field: index.sk.field,
            head: undefined,
            types: [own],
            table,
            channel: `its index "${name}"'s sort key`,
          })
        }
        continue
      }
      // Its live rows, version snapshots, soft-delete tombstones, time-series events and projection
      // rows. None is an aggregate node's row: an entity composes each composite with its field's
      // name (`id_p`), which an aggregate never does, and its primary key has at least one.
      const tombstone =
        e._projectionTombstones !== undefined ? typed(`${type}#tombstone`, index.casing) : undefined
      const outboxConfigs = e._projectionOutboxes ?? []
      const outboxHere = outboxConfigs.some((outbox) => outbox.table === undefined)
        ? typed(`${type}#outbox`, index.casing)
        : undefined
      if (tombstone !== undefined) projectionTypes.push(tombstone)
      const rows = [
        own,
        ...(tombstone === undefined ? [] : [tombstone]),
        ...(outboxHere === undefined ? [] : [outboxHere]),
      ]
      writers.push({
        field: index.pk.field,
        head,
        exact,
        types: rows,
        table,
        channel: "its primary key",
      })
      if (index.sk?.field !== undefined) {
        writers.push({
          field: index.sk.field,
          head: undefined,
          types: rows,
          table,
          channel: "its sort key",
        })
      }
      if (e.softDelete !== undefined && e.softDelete !== false) {
        anyText(["deletedAt"], [own], table, () => "its soft-delete tombstones' `deletedAt`")
      }
      if (tombstone !== undefined) {
        anyText(
          ["__edd_removed__", KEY_TEXT],
          [tombstone],
          table,
          (field) => `its projection tombstones' "${field}"`,
        )
      }
      for (const constraint of Object.keys(e.unique ?? {})) {
        const sentinel = composeUniqueKey(schema, type, constraint, [], {
          casing: index.casing,
        }).sk
        const rowType = { type: `${type}._unique.${constraint}`, label: sentinel }
        const channel = `its unique constraint "${constraint}"`
        writers.push({
          field: index.pk.field,
          head: sentinel,
          exact: false,
          types: [rowType],
          table,
          channel,
        })
        if (index.sk?.field !== undefined) {
          writers.push({
            field: index.sk.field,
            head: sentinel,
            exact: true,
            types: [rowType],
            table,
            channel,
          })
        }
        // Written after the sentinel's key: one named as a key attribute replaces it.
        writers.push({
          field: "_entity_pk",
          head,
          exact,
          types: [rowType],
          table,
          channel: `${channel}'s back-pointer "_entity_pk"`,
        })
        anyText(["_entity_sk"], [rowType], table, () => `${channel}'s back-pointer "_entity_sk"`)
      }
      // Each projection's outbox items: under the row's partition key, on the row table or another.
      const outboxes = outboxConfigs.map((outbox) =>
        outbox.table === undefined
          ? { on: table, pk: index.pk.field, sk: index.sk?.field, index: outbox.index }
          : { on: outbox.table.Tag, pk: outbox.pk, sk: outbox.sk, index: outbox.index },
      )
      for (const outbox of outboxes) {
        const outboxType = typed(`${type}#outbox`, index.casing)
        const channel = "its projection outbox"
        for (const field of [outbox.pk, OUTBOX_ROW_PK]) {
          writers.push({ field, head, exact, types: [outboxType], table: outbox.on, channel })
        }
        anyText(
          [
            ...(outbox.sk === undefined ? [] : [outbox.sk]),
            OUTBOX_ROW_SK,
            "effect",
            "source",
            "streamId",
            "eventType",
            KEY_TEXT,
            OUTBOX_CLAIM,
            OUTBOX_CLAIMED_UNTIL,
            ...(outbox.index === undefined ? [] : [outbox.index.pk, outbox.index.sk]),
          ],
          [outboxType],
          outbox.on,
          (field) => `${channel}'s "${field}"`,
        )
      }
    }
    for (const [name, vector] of Object.entries(e._vectorIndexes ?? {})) {
      writers.push({
        field: vector.partitionField,
        head:
          vector.compose === undefined
            ? composeKey(schema, type, [], { casing: vector.casing })
            : undefined,
        types: [typed(type)],
        table,
        channel: `its vector index "${name}"`,
      })
    }
    anyText([...stamps, INCARNATION_TOKEN], [typed(type)], table, (field) => `its "${field}"`)
    // Its model attributes: on its rows, and kept on its projection tombstones. Whatever its model
    // declares, these are any name holding any text, but the ones it writes after them.
    writers.push({
      field: undefined,
      except: ["__edd_e__", ...tableKeys],
      head: undefined,
      types: [typed(type), ...projectionTypes],
      table,
      channel: "its model attributes",
    })
    return withTypeOverwrites(writers)
  } catch {
    return [
      {
        field: undefined,
        head: undefined,
        types: [{ type, label: type, any: { via: "its keys can't be read" } }],
        table,
        channel: "its keys, which can't be read",
      },
    ]
  }
}

/**
 * The first member that can write a row of one of the aggregate's types into its partition, if
 * any (DESIGN.md §7 "Which rows in its partition are an aggregate's"): `DynamoClient.make` refuses
 * an aggregate declaring `ownsRows` for it (`EDD-9130`). A member can when one of its attribute
 * writers ({@link entityWriters}, an aggregate's own) writes the aggregate's `pk.field` on the same
 * physical table (`sameTable`), with text that can be the aggregate's partition key
 * ({@link canBePartitionKey}), on a row whose type collides with one of the aggregate's
 * ({@link typesCollide}). The aggregate itself isn't one.
 */
export const ownershipConflict = (
  aggregate: unknown,
  members: ReadonlyArray<{ readonly name: string; readonly member: unknown }>,
  sameTable: (table: unknown) => boolean,
): { readonly member: string; readonly type: string; readonly channel: string } | undefined => {
  const ownership = (aggregate as { readonly _ownership?: Ownership })._ownership
  if (ownership === undefined) return undefined
  const seen = new Set<unknown>([aggregate])
  for (const { name, member } of [...ownership.declared, ...members]) {
    if (member === null || typeof member !== "object" || seen.has(member)) continue
    seen.add(member)
    const writers =
      (member as { readonly _attributeWriters?: ReadonlyArray<AttributeWriter> })
        ._attributeWriters ??
      ((member as { readonly _tag?: unknown })._tag === "Entity" ? entityWriters(member) : [])
    for (const writer of writers) {
      if (!sameTable(writer.table)) continue
      if (
        writer.field === undefined
          ? writer.except?.includes(ownership.pkField) === true
          : writer.field !== ownership.pkField
      ) {
        continue
      }
      if (!canBePartitionKey(writer, ownership)) continue
      for (const theirs of writer.types) {
        const ours = ownership.types.find((type) => typesCollide(theirs, type))
        if (ours === undefined) continue
        return theirs.any === undefined
          ? { member: name, type: theirs.type, channel: writer.channel }
          : { member: name, type: ours.type, channel: `${writer.channel}; ${theirs.any.via}` }
      }
    }
  }
  return undefined
}

/** Discriminator `name#value` pairs for a sort key: its text, and the other setting's. */
interface DiscriminatorValues {
  readonly current: ReadonlyArray<string>
  readonly other: () => ReadonlyArray<string>
}

/** A sort key value in the text of the setting `schema` isn't using. */
const otherKeyText = (schema: DynamoSchemaModule.DynamoSchema, value: unknown): string =>
  KeyComposer.keyValueText(
    schema.escapeKeys === true ? KeyText136.schema136(schema) : KeyText136.schemaEscaped(schema),
    value,
    schema.casing,
  )

/** A decomposed row's sort key under the other setting; `sk`, if a value has no text there. */
const otherSortKey = (
  schema: DynamoSchemaModule.DynamoSchema,
  item: DecomposedItem,
  sk: string,
): string => {
  try {
    return composeKey(schema, item.entityType, [...item.skCompositesOther()])
  } catch {
    return sk
  }
}

/** A node's own static discriminator values as {@link DiscriminatorValues}. */
const ownDiscriminatorValues = (
  node: ResolvedNode,
  schema: DynamoSchemaModule.DynamoSchema,
): DiscriminatorValues => {
  const entries =
    node.ownDiscriminator === undefined
      ? []
      : Object.entries(node.ownDiscriminator).filter(([, v]) => typeof v !== "function")
  return {
    current: entries.flatMap(([k, v]) => [k, KeyComposer.keyValueText(schema, v, schema.casing)]),
    other: () => entries.flatMap(([k, v]) => [k, otherKeyText(schema, v)]),
  }
}

/**
 * Recursively decompose a node's value into DynamoDB items. Sort key values
 * are escaped with the schema's `casing` (`KeyComposer.keyText`); the
 * discriminator names between them are field names, kept as they are.
 */
const decomposeNode = (
  items: DecomposedItem[],
  node: ResolvedNode,
  value: unknown,
  contextValues: ContextValues,
  parentGroup: string,
  /** The parent's discriminator values, in today's text and in 1.36's (#171). */
  parentDiscriminators: DiscriminatorValues,
  aggregateName: string,
  schema: DynamoSchemaModule.DynamoSchema,
  /** The caller's own value here, on a write (see {@link Written}). */
  written: Written | undefined,
): Effect.Effect<void, AggregateDecompositionError> =>
  Effect.gen(function* () {
    // Optional edges may have null/undefined values — skip decomposition
    if (value == null) return

    if (node.cardinality === "one" && node.children.length > 0) {
      // Sub-aggregate — becomes its own transaction group
      const subValue = value as Record<string, unknown>
      // A nested sub-aggregate is its own transaction group, named by its path
      // (`club2.squad`) so the two bindings of its parent stay distinct groups.
      const ownName = node.fieldName ?? node.entityType
      const txGroup = parentGroup === "root" ? ownName : `${parentGroup}.${ownName}`

      // Discriminator values for SK composition: the parent sub-aggregate's
      // (name#value pairs, empty at the top level) then this node's own, so a
      // nested sub-aggregate's rows are keyed apart per binding of its parent.
      const own = ownDiscriminatorValues(node, schema)
      const discValues: DiscriminatorValues = {
        current: [...parentDiscriminators.current, ...own.current],
        other: () => [...parentDiscriminators.other(), ...own.other()],
      }

      // Sub-aggregate root item: fields not claimed by child edges
      const childEdgeNames = new Set(node.children.map((c) => c.fieldName).filter(Boolean))
      const subRootAttrs: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(subValue)) {
        if (childEdgeNames.has(key)) continue
        subRootAttrs[key] = val
      }

      // Serialize this node's own date fields to their wire primitive (#72).
      const storedAsGiven = applyNodeAttrEncoders(subRootAttrs, node.attrEncoders)

      // Inject context and discriminator
      mergeContextValues(subRootAttrs, contextValues.stored)
      if (node.discriminator) {
        for (const [k, v] of Object.entries(node.discriminator)) {
          if (typeof v !== "function") subRootAttrs[k] = v
        }
      }

      items.push({
        entityType: node.entityType,
        attributes: subRootAttrs,
        transactionGroup: txGroup,
        skComposites: discValues.current,
        skCompositesOther: discValues.other,
        member: node.fieldName ?? node.entityType,
        rowStamps: node.rowStamps,
        storedAsGiven,
        node,
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
          schema,
          writtenField(written, child.fieldName!),
        )
      }
    } else if (node.cardinality === "one") {
      // Simple one-to-one edge (no children)
      const attrs = { ...(value as Record<string, unknown>) }
      // Serialize this edge entity's own date fields to their wire primitive (#72).
      const storedAsGiven = applyNodeAttrEncoders(attrs, node.attrEncoders)
      mergeContextValues(attrs, contextValues.stored)
      if (node.discriminator) {
        for (const [k, v] of Object.entries(node.discriminator)) {
          if (typeof v !== "function") attrs[k] = v
        }
      }

      // Own discriminator values as name#value pairs for SK composition
      const own = ownDiscriminatorValues(node, schema)

      items.push({
        entityType: node.entityType,
        attributes: attrs,
        transactionGroup: parentGroup,
        skComposites: [...parentDiscriminators.current, ...own.current],
        skCompositesOther: () => [...parentDiscriminators.other(), ...own.other()],
        member: node.fieldName ?? node.entityType,
        rowStamps: node.rowStamps,
        storedAsGiven,
        node,
      })
    } else {
      // Many edge
      const handed =
        written === undefined || node.decomposeInput === undefined
          ? value
          : Option.getOrElse(node.decomposeInput(written), () => value)
      const arrayItems = node.decompose
        ? node.decompose(handed)
        : Array.isArray(value)
          ? (value as ReadonlyArray<unknown>)
          : []

      const withContext = (attrs: Record<string, unknown>, context: Record<string, unknown>) => {
        mergeContextValues(attrs, context)
        if (node.discriminator) {
          for (const [k, v] of Object.entries(node.discriminator)) {
            if (typeof v !== "function") attrs[k] = v
          }
        }
        return attrs
      }

      for (const elem of arrayItems) {
        // The element's attributes in their STORED form — every nested date,
        // transformed scalar and hydrated ref encoded (#72, #133).
        const attrs = { ...(elem as Record<string, unknown>) }
        const storedAsGiven = applyNodeAttrEncoders(attrs, node.attrEncoders)
        withContext(attrs, contextValues.stored)

        // The sort key is read from the element as the pre-#133 encoders left
        // it, NOT from `attrs`: encoding a ref's nested `NumberFromString` turns
        // a padded `0000000000000005` key segment into `5`, so composing from
        // the stored form would re-spell (and orphan) existing rows.
        const keyAttrs = { ...(elem as Record<string, unknown>) }
        applyNodeAttrEncoders(keyAttrs, node.keyAttrEncoders)
        withContext(keyAttrs, contextValues.key)

        const values = yield* manyEdgeSkComposites(node, keyAttrs, aggregateName)

        items.push({
          entityType: node.entityType,
          attributes: attrs,
          transactionGroup: parentGroup,
          skComposites: [
            ...parentDiscriminators.current,
            ...values.map((value) => KeyComposer.keyValueText(schema, value, schema.casing)),
          ],
          skCompositesOther: () => [
            ...parentDiscriminators.other(),
            ...values.map((value) => otherKeyText(schema, value)),
          ],
          otherKindSortKey: (targets) => {
            const slots = values.map((_, i) => String(i))
            const settings: ReadonlyArray<
              readonly [() => ReadonlyArray<string>, (value: unknown) => string]
            > = [
              [
                () => parentDiscriminators.current,
                (value) => KeyComposer.keyValueText(schema, value, schema.casing),
              ],
              [() => parentDiscriminators.other(), (value) => otherKeyText(schema, value)],
            ]
            for (const [parents, text] of settings) {
              const sortKey = (record: Record<string, unknown>) =>
                composeKey(schema, node.entityType, [
                  ...parents(),
                  ...slots.map((slot) => text(record[slot])),
                ])
              const reading = kindReadingOf(
                { ...values },
                slots,
                () => undefined,
                ({ record }) => sortKey(record),
                targets,
              )
              if (reading !== undefined && reading.asOther.size > 0) return sortKey(reading.record)
            }
            return undefined
          },
          skTextFor: (taker, path) => {
            try {
              let from = keyAttrs
              if (taker !== node) {
                from = { ...(elem as Record<string, unknown>) }
                applyNodeAttrEncoders(from, taker.keyAttrEncoders)
                mergeContextValues(from, contextValues.key)
              }
              const value = readCompositePath(from, path)
              return value == null || !isScalarComposite(value)
                ? undefined
                : KeyComposer.keyValueText(schema, value, schema.casing)
            } catch {
              // What `taker` can't compose a key from isn't a key it writes.
              return undefined
            }
          },
          member: node.fieldName ?? node.entityType,
          rowStamps: node.rowStamps,
          storedAsGiven,
          node,
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
): Effect.Effect<ReadonlyArray<unknown>, AggregateDecompositionError> =>
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

    return values
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

/** What a node's rows do with each timestamp: see `rowStampsOf`. A null name isn't stamped. */
interface RowStamps {
  readonly createdAt: string | null
  readonly createdEncoding: DynamoEncoding | null
  readonly createdDeclared: boolean
  readonly createdRequired: boolean
  readonly updatedAt: string | null
  readonly updatedEncoding: DynamoEncoding | null
  readonly updatedDeclared: boolean
  readonly updatedRequired: boolean
}

/**
 * A `many` value's rows, each through `fill`, put back in the shape the value has. A custom
 * `decompose` says what the rows are, and only its `assemble` can put them back: with no `assemble`,
 * a value that isn't an array has no way back, so its rows can't be filled. This runs before the
 * input is decoded, so a value they can't take apart or put back is left for the schema to report.
 */
const fillRows = (
  child: ResolvedNode,
  value: unknown,
  fill: (row: unknown) => unknown,
): unknown => {
  const filledOf = (rows: ReadonlyArray<unknown>) => {
    const filled = rows.map(fill)
    return filled.some((row, i) => row !== rows[i]) ? filled : undefined
  }
  if (child.decompose !== undefined && child.assemble !== undefined) {
    try {
      const filled = value === undefined ? undefined : filledOf(child.decompose(value))
      return filled === undefined ? value : child.assemble(filled)
    } catch {
      return value
    }
  }
  return Array.isArray(value) ? (filledOf(value) ?? value) : value
}

/**
 * `value` with the dates its rows declare and it doesn't supply, walking the graph: a stamped date is
 * never the input's to supply, as on an entity. `"required"` leaves one a schema doesn't require,
 * which a rewrite stamps anyway: a mutation that changes nothing still has nothing to write. A value
 * with nothing to add comes back as it is.
 */
const fillStamps = (
  node: ResolvedNode,
  value: unknown,
  now: DateTime.Utc,
  which: "declared" | "required",
): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const given = value as Record<string, unknown>
  const added: Record<string, unknown> = {}
  const row = node.rowStamps
  const fill = (
    name: string | null,
    declared: boolean | undefined,
    required: boolean | undefined,
    encoding: DynamoEncoding | null | undefined,
  ) => {
    if (name === null || given[name] !== undefined) return
    if (which === "declared" ? declared === true : required === true) {
      added[name] = generateTimestampPrimitive(now, encoding ?? null)
    }
  }
  if (row !== undefined) {
    fill(row.createdAt, row.createdDeclared, row.createdRequired, row.createdEncoding)
    fill(row.updatedAt, row.updatedDeclared, row.updatedRequired, row.updatedEncoding)
  }
  for (const child of node.children) {
    const current = given[child.fieldName!]
    const next =
      child.cardinality === "many"
        ? fillRows(child, current, (row) => fillStamps(child, row, now, which))
        : fillStamps(child, current, now, which)
    if (next !== current) added[child.fieldName!] = next
  }
  return Object.keys(added).length === 0 ? value : { ...given, ...added }
}

/**
 * A key's composites, in key text. One with no value has no key text, so this throws: `[EDD-9123]`,
 * a `KeyValueError` that `composeKeysOrFail` makes a `ValidationError` before anything is written.
 * Only for a key the aggregate can't do without: a list's keys are sparse (`buildDynamoItems`).
 */
const keyCompositesOrThrow = (
  aggregateName: string,
  key: string,
  schema: DynamoSchemaModule.DynamoSchema,
  composite: ReadonlyArray<string>,
  record: Record<string, unknown>,
): ReadonlyArray<string> => {
  const absent = composite.filter((attr) => record[attr] === undefined || record[attr] === null)
  if (absent.length > 0) {
    const names = absent.map((attr) => `"${attr}"`).join(", ")
    throw new KeyValueError({
      value: undefined,
      reason: `no value for ${names}`,
      message:
        `[EDD-9123] Aggregate "${aggregateName}": ${key} is composed from ${names}, which has no ` +
        `value here. An aggregate can't be read without this key, so nothing was sent. Supply it, ` +
        `or compose the key from a field that always has one.`,
    })
  }
  return KeyComposer.extractKeyComposites(schema, {}, composite, record)
}

/** A single write's stamp: when, and what `created` to preserve. */
interface Stamp {
  readonly now: DateTime.Utc
  readonly existingCreated: ReadonlyMap<string, unknown>
  /**
   * Stored `updated` values to keep, by sk: `rekey` moves rows without
   * changing them (#171). Absent — every other write — stamps `now`.
   */
  readonly existingUpdated?: ReadonlyMap<string, unknown> | undefined
  /** Each row's declared `updated` before an `update`'s mutation, by sk. */
  readonly updatedBefore?: ReadonlyMap<string, unknown> | undefined
}

const EMPTY_CREATED: ReadonlyMap<string, unknown> = new Map()

const hasKeyValue = (value: unknown): boolean => value !== undefined && value !== null

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
  /**
   * The root's value, the collection sort key's composites read from. Undefined: the caller wants
   * each row's identity (`pk`, `sk`) only, and neither that key nor the list keys are composed.
   */
  rootValue: Record<string, unknown> | undefined,
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

      // System timestamps. Written last, so a generated value wins over the same-named field
      // propagated onto edge items via `context`; known first, so a key over one holds what the row
      // holds. A date the row declares is as an entity's: a supplied value wins, and `created` stays
      // what's stored whatever the mutation did to it.
      const stamped: Record<string, unknown> = {}
      const row = item.rowStamps
      if (stamp && row !== undefined) {
        const { existingCreated, now } = stamp
        const sk = attrs.sk as string
        if (row.createdAt !== null) {
          const held = row.createdDeclared ? item.attributes[row.createdAt] : undefined
          stamped[row.createdAt] =
            existingCreated.get(sk) ?? held ?? generateTimestampPrimitive(now, row.createdEncoding)
        }
        if (row.updatedAt !== null) {
          const held = row.updatedDeclared ? item.attributes[row.updatedAt] : undefined
          const before = stamp.updatedBefore
          const supplied =
            held !== undefined && !(before?.has(sk) && deepEqual(before.get(sk), held))
          stamped[row.updatedAt] =
            stamp.existingUpdated?.get(sk) ??
            (supplied ? held : generateTimestampPrimitive(now, row.updatedEncoding))
        }
      }

      // Collection SK mirror — only written when an index is actually provisioned.
      // Root items get the collection key; every other item's value is a verbatim copy
      // of its own `sk`. With no index there is nothing to sort, so the attribute is
      // omitted entirely rather than duplicating `sk` on every item.
      const isRootItem =
        item.entityType === config.root.entityType && item.skComposites.length === 0
      const collectionSk = config.collection.sk
      if (
        rootValue !== undefined &&
        config.collection.index !== undefined &&
        collectionSk !== undefined
      ) {
        attrs[collectionSk.field] = isRootItem
          ? composeCollectionKey(
              config.schema,
              config.collection.name,
              keyCompositesOrThrow(
                config.root.entityType,
                "its collection sort key",
                config.schema,
                collectionSk.composite,
                keyRecord({ ...rootValue, ...stamped }),
              ),
            )
          : composeKey(config.schema, item.entityType, [...item.skComposites])
      }

      // List collection GSI keys (root items only). Sparse, as an entity index is: a row with no
      // value for a composite isn't in the list, whole index or nothing, and a later write that
      // gives it one puts it there. Every aggregate write is a whole-row Put, so leaving both
      // attributes off is also what takes it out.
      if (rootValue !== undefined && isRootItem && config.list) {
        const listKeyValues = keyRecord({
          ...(item.keyAttributes ?? item.attributes),
          ...stamped,
        })
        const listComposites = [...config.list.pk.composite, ...config.list.sk.composite]
        if (listComposites.every((attr) => hasKeyValue(listKeyValues[attr]))) {
          const listPkComposites = KeyComposer.extractKeyComposites(
            config.schema,
            {},
            config.list.pk.composite,
            listKeyValues,
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
          const listSkComposites = KeyComposer.extractKeyComposites(
            config.schema,
            {},
            config.list.sk.composite,
            listKeyValues,
          )
          attrs[config.list.sk.field] = composeCollectionKey(
            config.schema,
            config.list.name,
            listSkComposites,
          )
        }
      }

      return toAttributeMap({ ...attrs, ...stamped })
    }),
  }))

// ---------------------------------------------------------------------------
// Internal: Write transaction groups to DynamoDB
// ---------------------------------------------------------------------------

type WriteGroups = ReadonlyArray<{
  group: string
  puts: ReadonlyArray<Record<string, AttributeValue>>
  deletes: ReadonlyArray<Record<string, AttributeValue>>
}>

/**
 * `create`: the first group's first Put is the root item, written only when it
 * doesn't exist (`attribute_not_exists`); its cancellation for that reason is
 * `ConditionalCheckFailed` (#134). A later group still commits on its own, as
 * every multi-group write always has.
 */
interface RootGuard {
  readonly pkField: string
  readonly entityType: string
  readonly key: Record<string, unknown>
}

type WriteGroupsError =
  | AggregateTransactionOverflow
  | DynamoClientError
  | TransactionCancelled
  | ValidationError

/** The aggregate's item keys, to name an item in a diagnosed rejection (#144). */
interface GroupKeys {
  readonly pkField: string
  /** Key attributes the items carry: the table's, the collection index's and the list index's. */
  readonly keys: KeyAttributes
}

function writeTransactionGroups(
  client: DynamoClientService,
  tableName: string,
  groups: WriteGroups,
  aggregateName: string,
  keys: GroupKeys,
): Effect.Effect<void, WriteGroupsError>
function writeTransactionGroups(
  client: DynamoClientService,
  tableName: string,
  groups: WriteGroups,
  aggregateName: string,
  keys: GroupKeys,
  rootGuard: RootGuard,
): Effect.Effect<void, WriteGroupsError | ConditionalCheckFailed>
function writeTransactionGroups(
  client: DynamoClientService,
  tableName: string,
  groups: WriteGroups,
  aggregateName: string,
  keys: GroupKeys,
  rootGuard?: RootGuard,
): Effect.Effect<void, WriteGroupsError | ConditionalCheckFailed> {
  return Effect.gen(function* () {
    // Each group is its own transaction (DynamoDB: 100 items per
    // TransactWriteItems, Puts AND Deletes together). DynamoDB's limits are
    // not pre-checked (#144): a group over one is sent, rejected whole, and
    // diagnosed — naming the sub-aggregates earlier groups already committed,
    // since a multi-group write was never atomic.
    const committed: Array<string> = []
    for (const [groupIndex, group] of groups.entries()) {
      // Each group is one transaction — Puts AND Deletes applied atomically, so an
      // edge add and a sibling edge removal in the same sub-aggregate commit together.
      const itemCount = group.puts.length + group.deletes.length
      if (itemCount === 0) continue
      // The root item, in the first transaction only.
      const rootIndex =
        rootGuard !== undefined && groupIndex === 0
          ? group.puts.findIndex((item) => item.sk?.S === rootGuard.key.sk)
          : -1

      // Build TransactWriteItems request — Puts first, then Deletes for orphans.
      const transactItems: Array<TransactWriteItem> = [
        ...group.puts.map((item, i) => ({
          Put: {
            TableName: tableName,
            Item: item,
            ...(rootGuard !== undefined && i === rootIndex
              ? {
                  ConditionExpression: "attribute_not_exists(#pk)",
                  ExpressionAttributeNames: { "#pk": rootGuard.pkField },
                }
              : {}),
          },
        })),
        ...group.deletes.map((key) => ({ Delete: { TableName: tableName, Key: key } })),
      ]

      // Named once, for both diagnoses below.
      const sent = () => ({
        _tag: "Transaction" as const,
        items: transactItems,
        targets: () =>
          transactItems.map((item) => {
            const entityType = item.Put?.Item?.__edd_e__?.S ?? aggregateName
            return transactItemTarget(
              item,
              tableName,
              [keys.pkField, "sk"],
              entityType,
              `the ${item.Put !== undefined ? entityType : "removed"} item of ` +
                `sub-aggregate "${group.group}"`,
            )
          }),
      })
      const already = [...committed]
      const diagnosed = (
        diagnosis: Diagnosis,
        original: unknown,
      ): AggregateTransactionOverflow | ValidationError =>
        diagnosis._tag === "TooManyItems"
          ? new AggregateTransactionOverflow({
              aggregate: aggregateName,
              subgraph: group.group,
              itemCount: diagnosis.count,
              limit: diagnosis.limit,
              committed: already,
              operation: rootGuard !== undefined ? "create" : "update",
              cause: original,
            })
          : diagnosedValidationError(diagnosis, original, {
              operation: `Aggregate.write(${aggregateName})`,
              entityType: aggregateName,
              // Each group commits on its own: say exactly what already did.
              ...(already.length > 0 && {
                committed:
                  `earlier transactions of this write already committed sub-aggregates ` +
                  already.map((name) => `"${name}"`).join(", ") +
                  (rootGuard !== undefined
                    ? ", so a retried create fails on the existing root: update or delete " +
                      "the partial aggregate instead"
                    : ""),
              }),
            })

      yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
        // One operation per item (#144): diagnosed BEFORE the root guard's
        // mapping, which would read a repeat's conditional failure as an
        // existing root.
        diagnoseFailure({ sent, only: ["RepeatedItem"], rewrite: diagnosed }),
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
            const reasons = cancelled.CancellationReasons
            if (
              rootGuard !== undefined &&
              rootIndex >= 0 &&
              reasons?.[rootIndex]?.Code === "ConditionalCheckFailed"
            ) {
              return new ConditionalCheckFailed({
                entityType: rootGuard.entityType,
                key: rootGuard.key,
              })
            }
            return new TransactionCancelled({
              operation: "TransactWriteItems",
              reasons: (cancelled.CancellationReasons ?? []).map((r) => ({
                code: r?.Code,
                message: r?.Message,
              })),
              cause: error.cause,
            })
          }
          return error
        }),
        // A limit DynamoDB enforced (#144), named — after the root guard's
        // mapping, which a conditional failure always takes.
        diagnoseFailure({ sent, keys: () => keys.keys, rewrite: diagnosed }),
      )
      committed.push(group.group)
    }
  })
}

/** A row `update`'s cleanup deletes with `ownsRows`: its key, and the type it was read with. */
interface OwnedRow {
  readonly pk: string
  readonly sk: string
  readonly entityType: string
}

/**
 * `update`'s cleanup Deletes with `ownsRows` (DESIGN.md §7 "Which rows in its partition are an
 * aggregate's"), sent after the update's groups have committed, up to {@link TRANSACT_WRITE_ITEMS_LIMIT} to a
 * request: Deletes of keys already stored reach no other limit of a transaction. Each holds while
 * its row is gone or still of the type read, so a row another write removed in between is fine,
 * and one replaced with a row of another type is left. A cancelled request is sent once more
 * without the Deletes whose condition failed; the mutation isn't run again and nothing is read
 * again. A failure is reported as a later group's is: the update's groups have committed, and the
 * rows it didn't delete stay until the next update of their node.
 */
const deleteOwnedRows = (
  client: DynamoClientService,
  tableName: string,
  pkField: string,
  rows: ReadonlyArray<OwnedRow>,
): Effect.Effect<void, DynamoClientError | TransactionCancelled> =>
  Effect.gen(function* () {
    const deleteOf = (row: OwnedRow): TransactWriteItem => ({
      Delete: {
        TableName: tableName,
        Key: toAttributeMap({ [pkField]: row.pk, sk: row.sk }),
        ConditionExpression: "attribute_not_exists(#pk) OR #e = :e",
        ExpressionAttributeNames: { "#pk": pkField, "#e": "__edd_e__" },
        ExpressionAttributeValues: { ":e": { S: row.entityType } },
      },
    })
    for (let start = 0; start < rows.length; start += TRANSACT_WRITE_ITEMS_LIMIT) {
      const chunk = rows.slice(start, start + TRANSACT_WRITE_ITEMS_LIMIT)
      const reasons = yield* client
        .transactWriteItems({ TransactItems: chunk.map((row) => deleteOf(row)) })
        .pipe(
          Effect.as(undefined),
          Effect.catch((error: DynamoClientError) =>
            isAwsTransactionCancelled(error.cause)
              ? Effect.succeed(error.cause.CancellationReasons ?? [])
              : Effect.fail(error),
          ),
        )
      if (reasons === undefined) continue
      const rest = chunk.filter((_, i) => reasons[i]?.Code !== "ConditionalCheckFailed")
      if (rest.length === 0) continue
      yield* client.transactWriteItems({ TransactItems: rest.map((row) => deleteOf(row)) }).pipe(
        Effect.mapError((error) =>
          isAwsTransactionCancelled(error.cause)
            ? new TransactionCancelled({
                operation: "TransactWriteItems",
                reasons: (error.cause.CancellationReasons ?? []).map((r) => ({
                  code: r?.Code,
                  message: r?.Message,
                })),
                cause: error.cause,
              })
            : error,
        ),
      )
    }
  })

// ---------------------------------------------------------------------------
// Internal: Rows under other key text (#171, #183)
// ---------------------------------------------------------------------------

/**
 * Where an aggregate's row is stored (#171): under its current key, its 1.36
 * key, both, neither (`missing`), or — in a chain of aliasing keys — not
 * decidable from which keys are held (`ambiguous`).
 */
type RowPlacement = "current" | "old" | "both" | "ambiguous" | "missing"

/**
 * Place an aggregate's rows from the keys that hold a row (#171). Each row has
 * a `current` and an `old` position. Off doesn't escape sort key text,
 * so in one partition a row's unescaped key can be another row's escaped key —
 * `a%20b`'s unescaped sort key is `a b`'s escaped one — and the rows' keys chain:
 * `a b` → `a%20b` → `a%2520b`. A chain of n rows has n + 1 keys. With exactly
 * one of them free, the rows before it are under their old keys and those
 * after it under their current keys. With every key held, a lone row is
 * stored under `both` keys, and a longer chain is `ambiguous`; with more than
 * one free, a row with neither key held is `missing` and the rest are
 * `ambiguous`. Escaping only lengthens a value's text, so keys never cycle.
 */
const placeRows = (
  slots: ReadonlyArray<{ readonly current: string; readonly old: string }>,
  held: (position: string) => boolean,
): ReadonlyArray<RowPlacement> => {
  const placements: Array<RowPlacement> = slots.map((slot) =>
    slot.current !== slot.old ? "ambiguous" : held(slot.current) ? "current" : "missing",
  )
  const byOld = new Map<string, number>()
  const currents = new Set<string>()
  for (const [i, slot] of slots.entries()) {
    if (slot.current === slot.old) continue
    byOld.set(slot.old, i)
    currents.add(slot.current)
  }
  for (const [head, slot] of slots.entries()) {
    // A chain starts at a row whose old key is no other row's current key.
    if (slot.current === slot.old || currents.has(slot.old)) continue
    const chain: Array<number> = []
    for (
      let i: number | undefined = head;
      i !== undefined && !chain.includes(i);
      i = byOld.get(slots[i]!.current)
    ) {
      chain.push(i)
    }
    const keys = [slot.old, ...chain.map((i) => slots[i]!.current)]
    const free = keys.flatMap((key, k) => (held(key) ? [] : [k]))
    chain.forEach((i, k) => {
      placements[i] =
        free.length === 1
          ? k < free[0]!
            ? "old"
            : "current"
          : free.length === 0
            ? chain.length === 1
              ? "both"
              : "ambiguous"
            : !held(slots[i]!.old) && !held(slots[i]!.current)
              ? "missing"
              : "ambiguous"
    })
  }
  return placements
}

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

    // Chunk into batches of 25 (DynamoDB batchWriteItem limit). Items DynamoDB
    // leaves unprocessed (throttling) are retried with exponential backoff, as
    // `Batch.write` retries them; a bounded number of retries, then a clear
    // failure — never a silent partial delete (#134). By count alone: 25 stored keys (at most
    // 2048 + 1024 bytes each, so at most about 0.5 MB as JSON) can't reach the 16 MB request limit.
    for (let i = 0; i < deleteRequests.length; i += 25) {
      let pending: ReadonlyArray<unknown> = deleteRequests.slice(i, i + 25)
      let retries = 0
      while (pending.length > 0) {
        // Not diagnosed (#144): these are deletes of keys that were stored, so
        // they cannot meet a size or sort-key limit, and `delete`'s error
        // channel has no `ValidationError` to carry one.
        const response = yield* client.batchWriteItem({
          RequestItems: { [tableName]: pending as Array<never> },
        })
        pending = (response.UnprocessedItems?.[tableName] ?? []) as ReadonlyArray<unknown>
        if (pending.length === 0) break
        retries++
        if (retries > DELETE_MAX_RETRIES) {
          return yield* new DynamoError({
            operation: "BatchWriteItem",
            cause: new Error(
              `Aggregate delete: ${pending.length} unprocessed item(s) remain after ` +
                `${DELETE_MAX_RETRIES} retries; the partition is partly deleted.`,
            ),
          })
        }
        yield* Effect.sleep(`${DELETE_BASE_DELAY_MS * 2 ** (retries - 1)} millis`)
      }
    }
  })

/** `Batch.write`'s bound and backoff, for `deleteAllItems`' unprocessed items. */
const DELETE_MAX_RETRIES = 5
const DELETE_BASE_DELAY_MS = 100

// ---------------------------------------------------------------------------
// Internal: list filter compilation
// ---------------------------------------------------------------------------

/**
 * @internal Compile a {@link ListFilter} to a `FilterExpression` fragment.
 *
 * Both forms route through the same `Expr` compiler `BoundQuery.filter()` uses,
 * so `{ status: "shipped" }` and `(t, { eq }) => eq(t.status, "shipped")` mean
 * the same thing here as they do on an entity query, under the same empty-part
 * rules (#134): a filter that asserts nothing (`{}`, `and()`) is no filter, an
 * empty part directly under `and` is left out, and one anywhere else — or an
 * `or()` with no parts — is refused with a `ValidationError` before anything
 * is sent. An `isIn` with no values is sent, and DynamoDB's rejection of its
 * `IN ()` diagnosed (#144).
 */
const compileListFilter = <Model>(
  filter: ListFilter<Model> | undefined,
  aggregateName: string,
): Effect.Effect<CompileResult | undefined, ValidationError> => {
  if (filter === undefined) return Effect.succeed(undefined)
  const expr =
    typeof filter === "function"
      ? filter(
          createPathBuilder<Model>() as PathBuilder<Model, Model, never>,
          createConditionOps<Model>(),
        )
      : parseSimpleShorthand(filter)
  const problem = emptyPartProblem(expr)
  if (problem !== undefined) {
    return Effect.fail(
      new ValidationError({
        entityType: aggregateName,
        operation: "list.filter",
        cause: `list filter: ${problem} Nothing was sent.`,
      }),
    )
  }
  return Effect.succeed(isEmptyExpr(expr) ? undefined : compileExpr(expr))
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

/** How `rekey` reads an aggregate: from where its root was found, keeping each row as stored. */
interface RekeyRead {
  /** Each item as stored ({@link queryAllItems}). */
  readonly stored?: Array<Record<string, AttributeValue>> | undefined
  /** The partition the root was found in, when it isn't the current one. */
  readonly from?: string | undefined
  /** Read only `from`. */
  readonly fromOnly?: boolean | undefined
}

interface ListPartitionOptions {
  /** Composed GSI partition key value. */
  readonly pkValue: string
  /** Serialized leading SK composites of the filter (may be empty). */
  readonly skValues: ReadonlyArray<string>
  /** Whether `skValues` holds every list SK composite: the key is complete. */
  readonly skComplete: boolean
  /** At most this many items — accumulated across requests, filter or not. */
  readonly limit?: number | undefined
  /** DynamoDB `Limit` per request (rows examined). */
  readonly pageSize?: number | undefined
  readonly startKey?: Record<string, AttributeValue> | undefined
  readonly filter?: CompileResult | undefined
  /** Client-side predicate on the raw root item — see `ListOptions.filterBy`. */
  readonly accept?: ((rootItem: Record<string, unknown>) => boolean) | undefined
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
  // A client-side predicate rejects rows even later than a FilterExpression
  // does, so it disqualifies the budget for exactly the same reason.
  if (options.filter !== undefined || options.accept !== undefined) return options.pageSize
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
  aggregateName: string,
): Effect.Effect<ListPartitionResult, DynamoClientError | ValidationError> =>
  Effect.gen(function* () {
    const { filter, limit, pkValue, skValues } = options

    const exprNames: Record<string, string> = { "#pk": listConfig.pk.field }
    const exprValues: Record<string, AttributeValue> = { ":pk": toAttributeValue(pkValue) }
    let keyCondition = "#pk = :pk"

    // The rule `KeyComposer.composeSortKeyCondition` applies to entity
    // accessors: a complete key is matched with `=`, a partial one with
    // `begins_with` on the prefix and the delimiter. A bare `begins_with` on
    // the composed values matches longer siblings — `alice` also matching
    // `alicex`, and `rate: 3` matching 3.5, whose key text extends 3's.
    if (skValues.length > 0) {
      const skText = composeCollectionKey(schema, listConfig.name, skValues)
      exprNames["#sk"] = listConfig.sk.field
      if (options.skComplete) {
        exprValues[":sk"] = toAttributeValue(skText)
        keyCondition += " AND #sk = :sk"
      } else {
        exprValues[":skPrefix"] = toAttributeValue(`${skText}${KEY_DELIMITER}`)
        keyCondition += " AND begins_with(#sk, :skPrefix)"
      }
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
      const input = {
        TableName: tableConfig.name,
        IndexName: listConfig.index,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ExclusiveStartKey: startKey,
        ...(filter !== undefined ? { FilterExpression: filter.expression } : {}),
        ...(requestLimit !== undefined ? { Limit: requestLimit } : {}),
        ...(options.reverse === true ? { ScanIndexForward: false } : {}),
      }
      const result = yield* client.query(input).pipe(
        // DynamoDB's rejection of the filter's `IN ()` (an `isIn` with no
        // values), not pre-checked, is named (#144).
        diagnoseFailure({
          sent: () => ({ _tag: "Read", scan: false, input }),
          only: ["EmptyIn"],
          rewrite: (diagnosis, original) =>
            new ValidationError({
              entityType: aggregateName,
              operation: "list.filter",
              cause: withCause(
                explainDiagnosis(diagnosis, `Aggregate "${aggregateName}" list`),
                original,
              ),
            }),
        }),
      )

      const returned = (result.Items ?? []) as Array<Record<string, AttributeValue>>
      const lastEvaluatedKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined
      // Without a client-side predicate every returned row is kept, so the take
      // window is known up front. With one, acceptance is only known after the
      // row is unmarshalled, so every returned row is examined and the loop
      // stops once the budget fills (#122).
      const accept = options.accept
      const take =
        remaining === undefined || accept !== undefined
          ? returned.length
          : Math.min(remaining, returned.length)

      /** Index of the last row examined when the limit was reached, else -1. */
      let stoppedAt = -1
      for (let i = 0; i < take; i++) {
        const item = fromAttributeMap(returned[i]!)
        if (accept !== undefined && !accept(item)) continue
        items.push(item)
        if (limit !== undefined && items.length >= limit) {
          stoppedAt = i
          break
        }
      }

      // Over-read — a filtered request returns whatever survives the filter, not
      // `Limit` rows. The surplus is dropped, so `LastEvaluatedKey` (the last row
      // EXAMINED) would skip past items the caller never saw. Resume from the
      // last item actually handed back instead. `stoppedAt` is the last row
      // ACCEPTED, which is what keeps this correct under a predicate too.
      if (stoppedAt >= 0 && stoppedAt < returned.length - 1) {
        lastKey =
          listKeyFromItem(
            returned[stoppedAt]!,
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
