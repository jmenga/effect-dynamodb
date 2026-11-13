/**
 * Table — Groups entities sharing a physical DynamoDB table and application namespace.
 *
 * The Table holds a DynamoSchema reference for key prefix generation and
 * a record of named entities (and optionally aggregates).
 * The physical table name is provided at runtime via Effect Layers.
 *
 * Use `DynamoClient.make()` to get a typed client with bound entity operations.
 */

import type { DescribeTableCommandOutput } from "@aws-sdk/client-dynamodb"
import type * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { setOwn } from "@effect-dynamodb/schema/internal/OwnNames.js"
import { refuseSharedKeyAttribute } from "@effect-dynamodb/schema/internal/SharedKeyAttribute.js"
import { type IndexDefinition, isZOrderHalf } from "@effect-dynamodb/schema/KeyComposer.js"
import type { VectorIndexDefinition } from "@effect-dynamodb/schema/VectorIndex.js"
import { toWireDistanceFunction } from "@effect-dynamodb/schema/VectorIndex.js"
import { type Config, Context, Effect, Layer, type Option } from "effect"
import type { DynamoClientError } from "./DynamoClient.js"
import type { BoundEventStream, EventStream } from "./EventStore.js"
import type { CapacityTotals } from "./internal/Capacity.js"

/** Runtime table configuration injected via Effect Layer. */
export interface TableConfig {
  /** Physical DynamoDB table name. */
  readonly name: string
  /**
   * Attribute name used for DynamoDB TTL (`TimeToLiveSpecification.AttributeName`).
   * Lifecycle features (`versioned: { retain, ttl }`, `softDelete: { ttl }`,
   * `timeSeries: { ttl }`) write the epoch-seconds expiry to this attribute, and
   * `Entity.restore()` strips it. Defaults to `"_ttl"`. Set this to align with a
   * pre-existing or migrated table whose TTL attribute is named differently
   * (e.g. `"ttl"`). DynamoDB allows only one TTL attribute per physical table,
   * so a single value applies to all lifecycle features on this table.
   */
  readonly ttlAttributeName?: string | undefined
}

/** Default attribute name used for DynamoDB TTL when {@link TableConfig.ttlAttributeName} is unset. */
export const DEFAULT_TTL_ATTRIBUTE_NAME = "_ttl"

/** Resolve the effective TTL attribute name from a TableConfig. */
export const resolveTtlAttributeName = (tc: TableConfig): string =>
  tc.ttlAttributeName ?? DEFAULT_TTL_ATTRIBUTE_NAME

const keyAttributesByTag = new WeakMap<object, Set<string>>()
// A service key is a function as much as an object.
const isTagObject = (tag: unknown): tag is object =>
  (typeof tag === "object" && tag !== null) || typeof tag === "function"

/**
 * @internal The attributes a table's members write keys under, by its service (#237): the
 * primary key's, every secondary index's (entity and aggregate) and every vector index's
 * partition and filter attributes, as {@link resolveKeyAttributeTypes} lists them, and those of
 * every aggregate made on the table without being registered on it and every event stream's
 * index on it ({@link addTableKeyAttributes}). Any item holding one of them is indexed by it, so
 * the library adds no attribute of its own under such a name. `undefined` for a service `make`
 * didn't create.
 */
export const tableKeyAttributes = (tag: unknown): ReadonlySet<string> | undefined =>
  isTagObject(tag) ? keyAttributesByTag.get(tag) : undefined

/**
 * @internal Adds the attributes an aggregate made on a table, or an event stream's indexes on it,
 * write keys under (#237): neither is registered on the table, and their items are on it all the
 * same.
 */
export const addTableKeyAttributes = (tag: unknown, names: Iterable<string>): void => {
  if (!isTagObject(tag)) return
  const known = keyAttributesByTag.get(tag) ?? new Set<string>()
  for (const name of names) known.add(name)
  keyAttributesByTag.set(tag, known)
}

/**
 * Counter for generating unique Tag identifiers.
 * Each `make()` call increments this to ensure distinct Context.Service tags.
 */
let tableCounter = 0

/** Minimal entity shape for Table membership (avoids circular import with Entity.ts) */
interface EntityLike {
  readonly _tag: "Entity"
  readonly entityType?: string | undefined
  readonly indexes: Record<string, IndexDefinition>
  /** Normalized vector index definitions (absent on entities without any). */
  readonly _vectorIndexes?: Record<string, VectorIndexDefinition> | undefined
  /** Domain field name → stored DynamoDB attribute name (`storedAs` renames). */
  readonly _resolveDbName?: ((domainName: string) => string) | undefined
  readonly _configure: (
    schema: DynamoSchema.DynamoSchema,
    tableTag: Context.Service<TableConfig, TableConfig>,
  ) => void
}

/** Minimal aggregate shape for Table membership (avoids circular import with Aggregate.ts) */
interface AggregateLike {
  readonly _tag: "Aggregate"
  readonly pkField: string
  readonly collection: {
    /**
     * Physical index backing the collection query. `undefined` means the aggregate
     * assembles straight off the base table — no secondary index is provisioned and
     * no collection SK mirror attribute is written.
     */
    readonly index: string | undefined
    readonly sk: { readonly field: string } | undefined
  }
  readonly listIndex:
    | {
        readonly index: string
        readonly pk: { readonly field: string }
        readonly sk: { readonly field: string }
      }
    | undefined
}

/**
 * A Table groups entities sharing a physical DynamoDB table and application namespace.
 * Created via {@link make}. The physical table name is provided at runtime via
 * {@link Table.layer} or {@link Table.layerConfig}.
 *
 * @typeParam TEntities - Named entity record (e.g., `{ Users: typeof Users }`)
 * @typeParam TAggregates - Named aggregate record (e.g., `{ Matches: typeof Matches }`)
 */
export interface Table<
  TEntities extends Record<string, EntityLike> = Record<string, EntityLike>,
  TAggregates extends Record<string, AggregateLike> = Record<string, AggregateLike>,
> {
  readonly _tag: "Table"
  readonly schema: DynamoSchema.DynamoSchema
  /** Named entity members registered on this table. */
  readonly entities: TEntities
  /** Named aggregate members registered on this table. */
  readonly aggregates: TAggregates
  /** Effect Context.Service tag for this table's runtime config */
  readonly Tag: Context.Service<TableConfig, TableConfig>
  /** Provide the physical table name */
  readonly layer: (config: TableConfig) => Layer.Layer<TableConfig>
  /**
   * Provide the physical table name (and optional TTL attribute name) from Effect Config.
   *
   * `ttlAttributeName` is optional — omit it to use the `"_ttl"` default.
   */
  readonly layerConfig: (config: {
    readonly name: Config.Config<string>
    readonly ttlAttributeName?: Config.Config<string> | undefined
  }) => Layer.Layer<TableConfig, Config.ConfigError>
}

/**
 * Create a new Table definition with optional entity and aggregate members.
 *
 * Each call to `make` creates a new unique Context.Service, so different tables
 * produce independent runtime configurations even when sharing the same schema.
 *
 * Entities are automatically configured with the table's schema and tag.
 *
 * Members are checked against each other at definition time: entities sharing a
 * physical vector index must agree on its settings (EDD-9035), every member
 * declaring one physical secondary index must agree on its key attributes and
 * GSI/LSI classification, and every entity must declare the same primary-key
 * fields (EDD-9069).
 *
 * @example
 * ```typescript
 * const MainTable = Table.make({
 *   schema: AppSchema,
 *   entities: { Users, Tasks },
 *   aggregates: { Matches },
 * })
 *
 * // Provide physical table name at the edge
 * MainTable.layer({ name: "my-prod-table" })
 *
 * // Or from environment variables via Effect Config
 * MainTable.layerConfig({ name: Config.String("TABLE_NAME") })
 * ```
 */
export const make = <
  const TEntities extends Record<string, EntityLike> = {},
  const TAggregates extends Record<string, AggregateLike> = {},
>(config: {
  readonly schema: DynamoSchema.DynamoSchema
  readonly entities?: TEntities
  readonly aggregates?: TAggregates
}): Table<TEntities, TAggregates> => {
  const id = tableCounter++
  const Tag = Context.Service<TableConfig>(`@effect-dynamodb/Table/${config.schema.name}/${id}`)

  const entities = (config.entities ?? {}) as TEntities
  const aggregates = (config.aggregates ?? {}) as TAggregates

  // Cross-entity vector index agreement. `Dimensions` and `DistanceFunction` are
  // immutable at the DynamoDB level, so two entities sharing a physical vector
  // index cannot disagree — catch it at definition time rather than on the
  // CreateTable round trip.
  validateSharedVectorIndexes(entities)

  // One physical secondary index has one key schema, and every entity on one
  // table shares its primary key. Refuse members that disagree (EDD-9069) here,
  // so tables deployed with CDK or Terraform — which never call
  // `Table.definition` — fail at definition time too.
  const primary = resolvePrimaryKey(entities)
  mergeSecondaryIndexes(entities, aggregates, primary)
  // One attribute has one `AttributeDefinitions` type: a Z-order (`B`) sort key
  // can't share its attribute with a string key half or a vector filter
  // attribute of another type (EDD-9091).
  const keyAttributes = resolveKeyAttributeTypes(entities, aggregates, primary)
  // Two of an entity's key halves in one attribute must have the same fields, order and
  // casing (EDD-9106). `Entity.make` refused what no schema can reconcile; a casing an index
  // leaves to the schema resolves only here.
  for (const entity of Object.values(entities)) {
    refuseSharedKeyAttribute(config.schema, entity.entityType ?? "(unnamed)", entity.indexes)
  }

  // Configure all entities with this table's schema and tag — only once the
  // table is valid, so a rejected `Table.make` leaves its members bound to
  // whatever table they were registered on before.
  for (const entity of Object.values(entities)) {
    if (typeof entity._configure === "function") {
      entity._configure(config.schema, Tag)
    }
  }
  addTableKeyAttributes(Tag, keyAttributes.keys())

  return {
    _tag: "Table" as const,
    schema: config.schema,
    entities,
    aggregates,
    Tag,
    layer: (tableConfig: TableConfig) => Layer.succeed(Tag, tableConfig),
    layerConfig: (configDef: {
      readonly name: Config.Config<string>
      readonly ttlAttributeName?: Config.Config<string> | undefined
    }) =>
      Layer.effect(
        Tag,
        Effect.gen(function* () {
          const tableName = yield* configDef.name
          const ttlAttributeName = configDef.ttlAttributeName
            ? yield* configDef.ttlAttributeName
            : undefined
          const result: TableConfig =
            ttlAttributeName !== undefined
              ? { name: tableName, ttlAttributeName }
              : { name: tableName }
          return result
        }),
      ),
  }
}

// ---------------------------------------------------------------------------
// Vector index merging + validation
// ---------------------------------------------------------------------------

/**
 * Merge every registered entity's vector index declarations into one map keyed
 * by physical index name, validating that all sharers agree.
 *
 * Sharing a physical vector index across entities is the norm in single-table
 * designs — the default quota is 5 per table — and it is safe precisely because the
 * composed `__edd_vp_<name>__` partition value carries the entity type, so a
 * search never crosses entity boundaries (see `DESIGN.md §14`).
 *
 * @throws when two entities disagree on `dimensions` or `distance` (EDD-9035),
 *   or on a shared filter attribute's type (EDD-9040).
 */
export const mergeVectorIndexes = (
  entities: Record<string, EntityLike>,
): Map<string, MergedVectorIndex> => {
  const merged = new Map<
    string,
    {
      definition: VectorIndexDefinition
      owner: string
      sharers: Array<string>
      filters: Array<string>
      resolveDbName: (domainName: string) => string
      filterStoredTypes: Record<string, "S" | "N">
    }
  >()

  for (const [entityKey, entity] of Object.entries(entities)) {
    const declared = entity._vectorIndexes
    if (!declared) continue
    const owner = entity.entityType ?? entityKey
    const resolveDbName = entity._resolveDbName ?? ((domainName: string) => domainName)
    for (const definition of Object.values(declared)) {
      const existing = merged.get(definition.index)
      if (existing === undefined) {
        merged.set(definition.index, {
          definition,
          owner,
          sharers: [owner],
          filters: [...definition.filters],
          resolveDbName,
          filterStoredTypes: Object.fromEntries(
            definition.filters.map((f) => [resolveDbName(f), definition.filterTypes[f] ?? "S"]),
          ),
        })
        continue
      }
      if (
        existing.definition.dimensions !== definition.dimensions ||
        existing.definition.distance !== definition.distance
      ) {
        throw new Error(
          `[EDD-9035] Vector index "${definition.index}" is shared by entities "${existing.owner}" ` +
            `and "${owner}" with conflicting settings: ` +
            `${existing.definition.dimensions}/${existing.definition.distance} vs ` +
            `${definition.dimensions}/${definition.distance}. Dimensions and distance function are ` +
            `immutable on a DynamoDB vector index — every entity sharing one must agree.`,
        )
      }
      if (!existing.sharers.includes(owner)) existing.sharers.push(owner)
      // Filters, unlike dimensions/distance, are per-entity access patterns
      // rather than a shared physical property — one index can serve several
      // entities filtering on different attributes. Union them; keeping only
      // the first entity's set would silently leave the other sharers' filter
      // attributes out of the SearchSchema (and un-filterable at runtime).
      for (const filter of definition.filters) {
        const stored = resolveDbName(filter)
        const storedType = definition.filterTypes[filter] ?? "S"
        const existingType = existing.filterStoredTypes[stored]
        if (existingType !== undefined && existingType !== storedType) {
          throw new Error(
            `[EDD-9040] Vector index "${definition.index}" filter attribute "${stored}" is ` +
              `declared with AttributeDefinitions type "${existingType}" by entity ` +
              `"${existing.owner}" and "${storedType}" by entity "${owner}". A shared ` +
              `SearchSchema attribute must have one scalar type.`,
          )
        }
        setOwn(existing.filterStoredTypes, stored, storedType)
        if (existing.filters.some((f) => existing.resolveDbName(f) === stored)) continue
        existing.filters.push(filter)
      }
    }
  }

  // DynamoDB's own vector-index limits — inline filters per index (after the
  // union above), vector indexes per table (an adjustable quota) — are not
  // pre-checked: `db.tables.*.create()` / `addVectorIndex` diagnose DynamoDB's
  // rejection, naming the index and the entities sharing it (#144).
  return merged
}

/** A physical vector index resolved across every entity that declares it. */
export interface MergedVectorIndex {
  /** The first declaring entity's definition — authoritative for dimensions/distance. */
  readonly definition: VectorIndexDefinition
  /** Entity type of the first declarer, used in conflict messages. */
  readonly owner: string
  /** Entity type of every entity declaring the index, in registration order. */
  readonly sharers: ReadonlyArray<string>
  /** Union of every sharer's declared `filters` (domain names). */
  readonly filters: ReadonlyArray<string>
  /** Stored-name resolver for the first declarer's `storedAs` renames. */
  readonly resolveDbName: (domainName: string) => string
  /**
   * `AttributeDefinitions` scalar type per STORED filter attribute name,
   * merged across sharers (EDD-9040 on conflict). CreateTable/UpdateTable must
   * declare every SearchSchema element in `AttributeDefinitions`.
   */
  readonly filterStoredTypes: Readonly<Record<string, "S" | "N">>
}

/** @internal Run {@link mergeVectorIndexes} purely for its validation effect. */
const validateSharedVectorIndexes = (entities: Record<string, EntityLike>): void => {
  mergeVectorIndexes(entities)
}

/** Vector index definition for CreateTable / UpdateTable input. */
export interface VectorIndexSpec {
  readonly IndexName: string
  readonly VectorAttribute: { readonly AttributeName: string }
  readonly Dimensions: number
  readonly DistanceFunction: "COSINE" | "EUCLIDEAN" | "DOT_PRODUCT"
  readonly Projection: { readonly ProjectionType: "ALL" }
  readonly SearchSchema?:
    | Array<{
        readonly AttributeName: string
        readonly SearchSchemaElementType: "HASH" | "INLINE_FILTER"
      }>
    | undefined
}

/**
 * Map a normalized {@link VectorIndexDefinition} onto the AWS `VectorIndex`
 * shape. The composed partition attribute is always the single `HASH` element;
 * declared filters follow as `INLINE_FILTER` elements.
 *
 * `filters` may be supplied pre-unioned across every entity that shares the
 * physical index (see {@link mergeVectorIndexes}) — a shared index must declare
 * the union, or a sharer's filter attribute would simply not be indexed.
 *
 * Filter names are emitted as STORED attribute names: an entity may rename a
 * field with `storedAs`, and the index has to point at what is actually on disk.
 */
export const toVectorIndexSpec = (
  definition: VectorIndexDefinition,
  options?: {
    readonly filters?: ReadonlyArray<string> | undefined
    readonly resolveDbName?: ((domainName: string) => string) | undefined
  },
): VectorIndexSpec => {
  const resolveDbName = options?.resolveDbName ?? ((domainName: string) => domainName)
  const filters = options?.filters ?? definition.filters
  const SearchSchema: Array<{
    AttributeName: string
    SearchSchemaElementType: "HASH" | "INLINE_FILTER"
  }> = [{ AttributeName: definition.partitionField, SearchSchemaElementType: "HASH" }]
  for (const filter of filters) {
    SearchSchema.push({
      AttributeName: resolveDbName(filter),
      SearchSchemaElementType: "INLINE_FILTER",
    })
  }
  return {
    IndexName: definition.index,
    VectorAttribute: { AttributeName: definition.vectorField },
    Dimensions: definition.dimensions,
    DistanceFunction: toWireDistanceFunction(definition.distance),
    Projection: { ProjectionType: "ALL" },
    SearchSchema,
  }
}

// ---------------------------------------------------------------------------
// Table.definition — derive CreateTable input from table members
// ---------------------------------------------------------------------------

/** A single key schema element for CreateTable input. */
export interface KeySchemaElement {
  readonly AttributeName: string
  readonly KeyType: "HASH" | "RANGE"
}

/** A single attribute definition for CreateTable input. */
export interface AttributeDefinition {
  readonly AttributeName: string
  readonly AttributeType: "S" | "N" | "B"
}

/** GSI definition for CreateTable input. */
export interface GlobalSecondaryIndex {
  readonly IndexName: string
  readonly KeySchema: Array<KeySchemaElement>
  readonly Projection: { readonly ProjectionType: "ALL" }
}

/** LSI definition for CreateTable input. */
export interface LocalSecondaryIndex {
  readonly IndexName: string
  readonly KeySchema: Array<KeySchemaElement>
  readonly Projection: { readonly ProjectionType: "ALL" }
}

/**
 * Derived CreateTable input (minus TableName) computed from entity index definitions.
 * Produced by {@link definition}. Mutable arrays for direct compatibility with
 * the AWS SDK's `CreateTableCommandInput`.
 */
export interface TableDefinition {
  readonly KeySchema: Array<KeySchemaElement>
  readonly AttributeDefinitions: Array<AttributeDefinition>
  readonly GlobalSecondaryIndexes?: Array<GlobalSecondaryIndex> | undefined
  readonly LocalSecondaryIndexes?: Array<LocalSecondaryIndex> | undefined
  /**
   * Merged vector indexes from every registered entity, deduplicated by physical
   * name. Every `SearchSchema` element (the composed HASH partition attribute
   * and each INLINE_FILTER attribute) is also added to `AttributeDefinitions` —
   * the live service rejects the table otherwise ("One element in SearchSchema
   * is not defined in attribute definitions"). The vector attribute itself is
   * NOT declared; DynamoDB derives it from the `VectorIndex` declaration.
   */
  readonly VectorIndexes?: Array<VectorIndexSpec> | undefined
}

/**
 * Resolve the table's primary PK/SK field names from the entities' primary
 * indexes. Aggregates are skipped — they borrow the table's primary key rather
 * than declaring one.
 *
 * Returns `undefined` when no entity declares a primary index (a table registering
 * only aggregates). Callers that require the primary key must treat that as an error;
 * callers performing best-effort validation should skip their check instead.
 *
 * @throws when two entities declare different primary-key fields (EDD-9069). A
 *   table has one key schema; an entity keyed by other attributes would write
 *   items lacking the table's key attributes.
 */
export const resolvePrimaryKey = (
  entities: Record<string, EntityLike>,
): { readonly pk: string; readonly sk: string | undefined } | undefined => {
  let resolved: { readonly pk: string; readonly sk: string | undefined } | undefined
  let owner = ""
  for (const [entityKey, entity] of Object.entries(entities)) {
    const primary = entity.indexes.primary
    if (!primary) continue
    const current = { pk: primary.pk.field, sk: primary.sk.field }
    const name = entity.entityType ?? entityKey
    if (resolved === undefined) {
      resolved = current
      owner = name
      continue
    }
    if (resolved.pk !== current.pk || resolved.sk !== current.sk) {
      throw new Error(
        `[EDD-9069] The table's primary key is declared as (${keyList(resolved)}) by entity ` +
          `"${owner}" and as (${keyList(current)}) by entity "${name}". One table has one key ` +
          `schema: every entity registered on it must declare the same primary-key fields.`,
      )
    }
  }
  return resolved
}

const keyList = (keys: { readonly pk: string; readonly sk: string | undefined }): string =>
  keys.sk === undefined ? keys.pk : `${keys.pk}, ${keys.sk}`

// ---------------------------------------------------------------------------
// Secondary index merging + validation
// ---------------------------------------------------------------------------

/** A physical secondary index resolved across every member that declares it. */
export interface MergedSecondaryIndex {
  /**
   * `"gsi"` or `"lsi"`; `undefined` only for an aggregate collection index on a
   * table with no entity primary key, where the classification is unknown.
   */
  readonly kind: "gsi" | "lsi" | undefined
  readonly pk: string
  readonly sk: string
  /** The first declarer, as named in conflict messages. */
  readonly owner: string
}

const describeIndexKind = (kind: MergedSecondaryIndex["kind"]): string =>
  kind === "gsi" ? "a GSI" : kind === "lsi" ? "an LSI" : "an index"

/**
 * Merge every member's secondary index declarations into one map keyed by
 * physical index name, refusing members that disagree on its key schema.
 *
 * Declarers:
 * - every non-primary entity index (the auto-generated `_cascade_<field>`
 *   indexes included) — always a GSI;
 * - an aggregate's `collection.index` — an LSI when the aggregate's `pkField` is
 *   the table's primary partition key, a GSI otherwise (unknown when `primary`
 *   is `undefined`);
 * - an aggregate's list index — always a GSI.
 *
 * Several members sharing one physical index is the norm in single-table
 * designs (index overloading). They must agree on its key attributes and its
 * GSI/LSI classification: DynamoDB keys a physical index one way, and a member
 * writing other attributes would never appear in it.
 *
 * @throws on a disagreement (EDD-9069), naming both declarers and both shapes.
 */
export const mergeSecondaryIndexes = (
  entities: Record<string, EntityLike>,
  aggregates: Record<string, AggregateLike>,
  primary: { readonly pk: string; readonly sk: string | undefined } | undefined,
): Map<string, MergedSecondaryIndex> => {
  const merged = new Map<string, MergedSecondaryIndex>()

  const declare = (indexName: string, declared: MergedSecondaryIndex): void => {
    const existing = merged.get(indexName)
    if (existing === undefined) {
      merged.set(indexName, declared)
      return
    }
    const kindsDisagree =
      existing.kind !== undefined && declared.kind !== undefined && existing.kind !== declared.kind
    if (existing.pk !== declared.pk || existing.sk !== declared.sk || kindsDisagree) {
      throw new Error(
        `[EDD-9069] Secondary index "${indexName}" is declared as ` +
          `${describeIndexKind(existing.kind)} keyed (${existing.pk}, ${existing.sk}) by ` +
          `${existing.owner} and as ${describeIndexKind(declared.kind)} keyed ` +
          `(${declared.pk}, ${declared.sk}) by ${declared.owner}. One physical index has one ` +
          `key schema: every member declaring it must agree.`,
      )
    }
    // A declarer whose classification was unknown takes the known one.
    if (existing.kind === undefined && declared.kind !== undefined) {
      merged.set(indexName, { ...existing, kind: declared.kind })
    }
  }

  for (const [entityKey, entity] of Object.entries(entities)) {
    const owner = `entity "${entity.entityType ?? entityKey}"`
    for (const [name, index] of Object.entries(entity.indexes)) {
      if (!index || name === "primary" || !index.index) continue
      // Entity index definitions carry no LSI semantics: always a GSI.
      declare(index.index, { kind: "gsi", pk: index.pk.field, sk: index.sk.field, owner })
    }
  }

  for (const [aggregateKey, agg] of Object.entries(aggregates)) {
    const collectionIndex = agg.collection.index
    const collectionSk = agg.collection.sk
    if (collectionIndex !== undefined && collectionSk !== undefined) {
      declare(collectionIndex, {
        // DynamoDB LSIs share the base table's partition key; any index that
        // does IS an LSI.
        kind: primary === undefined ? undefined : agg.pkField === primary.pk ? "lsi" : "gsi",
        pk: agg.pkField,
        sk: collectionSk.field,
        owner: `aggregate "${aggregateKey}" (collection index)`,
      })
    }
    if (agg.listIndex) {
      declare(agg.listIndex.index, {
        kind: "gsi",
        pk: agg.listIndex.pk.field,
        sk: agg.listIndex.sk.field,
        owner: `aggregate "${aggregateKey}" (list index)`,
      })
    }
  }

  return merged
}

// ---------------------------------------------------------------------------
// Key attribute types
// ---------------------------------------------------------------------------

/** An `AttributeDefinitions` scalar type. */
export type KeyAttributeType = "S" | "N" | "B"

const describeAttributeType = (type: KeyAttributeType): string =>
  type === "B" ? `"B" (a Z-order sort key)` : `"${type}"`

/**
 * The `AttributeDefinitions` type of every attribute the table's members use
 * in a key or a vector index's `SearchSchema`, by attribute name:
 *
 * - primary key halves, entity index halves and every aggregate index half:
 *   `S` — composed key text;
 * - a Z-order sort key half (#171): `B` — a binary address;
 * - a vector index's partition attribute: `S`; its filter attributes: the type
 *   derived from the model (`S` | `N`, EDD-9039).
 *
 * DynamoDB types an attribute once per table, so two members declaring one
 * attribute with different types can't both be served: a GSI keyed on it would
 * leave one member's items out (index-key violations) and reject its writes.
 *
 * @throws when one attribute is declared with two types (EDD-9091), naming
 *   both declarers.
 */
export const resolveKeyAttributeTypes = (
  entities: Record<string, EntityLike>,
  aggregates: Record<string, AggregateLike>,
  primary: { readonly pk: string; readonly sk: string | undefined } | undefined,
): Map<string, KeyAttributeType> => {
  const declared = new Map<string, { readonly type: KeyAttributeType; readonly owner: string }>()
  const add = (name: string, type: KeyAttributeType, owner: string): void => {
    const existing = declared.get(name)
    if (existing === undefined) {
      declared.set(name, { type, owner })
      return
    }
    if (existing.type !== type) {
      throw new Error(
        `[EDD-9091] Attribute "${name}" is declared with type ` +
          `${describeAttributeType(existing.type)} by ${existing.owner} and with type ` +
          `${describeAttributeType(type)} by ${owner}. DynamoDB types an attribute once per ` +
          `table, so every member using it must agree — give one of them its own attribute name.`,
      )
    }
  }

  if (primary !== undefined) {
    add(primary.pk, "S", "the table's primary key")
    if (primary.sk !== undefined) add(primary.sk, "S", "the table's primary key")
  }
  for (const [entityKey, entity] of Object.entries(entities)) {
    const name = entity.entityType ?? entityKey
    for (const [indexName, index] of Object.entries(entity.indexes)) {
      if (!index) continue
      const owner = `entity "${name}" (index "${indexName}")`
      add(index.pk.field, "S", owner)
      add(index.sk.field, isZOrderHalf(index.sk) ? "B" : "S", owner)
    }
  }
  for (const [aggregateKey, agg] of Object.entries(aggregates)) {
    add(agg.pkField, "S", `aggregate "${aggregateKey}"`)
    if (agg.collection.index !== undefined && agg.collection.sk !== undefined) {
      add(agg.collection.sk.field, "S", `aggregate "${aggregateKey}" (collection index)`)
    }
    if (agg.listIndex) {
      const owner = `aggregate "${aggregateKey}" (list index)`
      add(agg.listIndex.pk.field, "S", owner)
      add(agg.listIndex.sk.field, "S", owner)
    }
  }
  for (const [indexName, entry] of mergeVectorIndexes(entities)) {
    const owner = `vector index "${indexName}" (entity "${entry.owner}")`
    add(entry.definition.partitionField, "S", owner)
    for (const [stored, type] of Object.entries(entry.filterStoredTypes)) add(stored, type, owner)
  }

  return new Map(Array.from(declared, ([name, { type }]) => [name, type]))
}

/**
 * Derive CreateTable input from a table's registered members.
 *
 * Scans all entity index definitions and aggregate GSI configs to produce:
 * - KeySchema (from primary index)
 * - AttributeDefinitions (all unique key attributes)
 * - GlobalSecondaryIndexes (from non-primary entity indexes + aggregate list indexes,
 *   plus aggregate collection indexes whose PK does not match the base table PK)
 * - LocalSecondaryIndexes (from aggregate collection indexes whose PK equals the base
 *   table PK — DynamoDB LSIs by definition share the base table's partition key)
 *
 * The physical table name is omitted — that's deployment config.
 * Every key attribute is typed "S" (String) — generated keys are strings — or "B"
 * for a Z-order sort key (#171); vector filter attributes take their model's
 * type. One attribute declared with two types fails (EDD-9091, see
 * {@link resolveKeyAttributeTypes}).
 *
 * LSI auto-detection: an aggregate's `collection` GSI config is emitted as an LSI
 * iff `agg.pkField` equals the table's primary PK field (determined from the first
 * entity's primary index). This matches DynamoDB semantics — any index that shares
 * the base table's partition key IS an LSI — and makes `lsi1`..`lsi5`-style indexes
 * on aggregates work transparently with `db.tables.*.create()`.
 *
 * @throws when members disagree on one physical secondary index's key attributes or
 *   GSI/LSI classification, or entities disagree on the primary-key fields (EDD-9069,
 *   see {@link mergeSecondaryIndexes}). {@link make} refuses the same tables.
 */
export const definition = (table: Table): TableDefinition => {
  const members: ReadonlyArray<EntityLike | AggregateLike> = [
    ...Object.values(table.entities),
    ...Object.values(table.aggregates),
  ]

  if (members.length === 0) {
    throw new Error("Table.definition requires at least one entity or aggregate")
  }

  // Pass 1: determine the table's primary PK/SK from the first entity's primary index.
  // This is needed before we can classify aggregate collection indexes as LSI vs GSI.
  const primary = resolvePrimaryKey(table.entities)

  if (primary === undefined) {
    throw new Error("No primary index found on any entity")
  }

  const primaryPk = primary.pk
  const primarySk = primary.sk

  // Pass 2: classify secondary indexes (GSI vs LSI), refusing members that
  // disagree on one physical index's key schema (EDD-9069).
  const secondaryIndexes = mergeSecondaryIndexes(table.entities, table.aggregates, primary)
  // Every attribute's one type: S, or B for a Z-order sort key (EDD-9091 on a
  // conflict). Also reached by the synthetic tables `DynamoClient.make` builds.
  const attributeTypes = resolveKeyAttributeTypes(table.entities, table.aggregates, primary)
  const gsiMap = new Map<string, { pk: string; sk: string }>()
  const lsiMap = new Map<string, { pk: string; sk: string }>()
  for (const [indexName, index] of secondaryIndexes) {
    const target = index.kind === "lsi" ? lsiMap : gsiMap
    target.set(indexName, { pk: index.pk, sk: index.sk })
  }

  // Pass 3: collect attribute names.
  const attributeNames = new Set<string>()

  // Always include the primary key fields in attribute definitions.
  attributeNames.add(primaryPk)
  if (primarySk !== undefined && primarySk !== primaryPk) {
    attributeNames.add(primarySk)
  }

  for (const member of members) {
    if ("_tag" in member && member._tag === "Aggregate") {
      // Aggregate — extract collection and list index configs
      const agg = member as AggregateLike

      // Collection index: PK = aggregate's pkField, SK = collection sk field.
      // If pkField matches the table's primary PK, emit as an LSI (DynamoDB requires
      // LSIs to share the base table's HASH key). Otherwise fall back to GSI — this
      // preserves behaviour for any user whose collection uses a distinct PK attribute.
      //
      // An aggregate with no `collection.index` assembles off the base table: it writes
      // no collection SK mirror attribute, so neither the index nor that attribute's
      // definition is emitted. Declaring an unused AttributeDefinition would be rejected
      // by DynamoDB ("attribute definitions include inappropriate attributes").
      const collectionIndex = agg.collection.index
      const collectionSk = agg.collection.sk
      attributeNames.add(agg.pkField)
      if (collectionIndex !== undefined && collectionSk !== undefined) {
        attributeNames.add(collectionSk.field)
      }

      // List GSI (if configured) — always a GSI; has its own PK attribute.
      if (agg.listIndex) {
        attributeNames.add(agg.listIndex.pk.field)
        attributeNames.add(agg.listIndex.sk.field)
      }
    } else {
      // Entity — scan index definitions
      const entity = member as EntityLike
      for (const index of Object.values(entity.indexes)) {
        if (!index) continue
        attributeNames.add(index.pk.field)
        attributeNames.add(index.sk.field)
      }
    }
  }

  const KeySchema: Array<KeySchemaElement> = [{ AttributeName: primaryPk, KeyType: "HASH" }]
  if (primarySk !== undefined && primarySk !== primaryPk) {
    KeySchema.push({ AttributeName: primarySk, KeyType: "RANGE" })
  }

  const AttributeDefinitions: Array<AttributeDefinition> = Array.from(attributeNames)
    .sort()
    .map((name) => ({ AttributeName: name, AttributeType: attributeTypes.get(name) ?? "S" }))

  // Every SearchSchema element must appear in AttributeDefinitions (verified
  // against the live service; DynamoDB Local silently accepts their absence).
  // The composed HASH partition attribute is always a string; filter types are
  // derived from the model schema at Entity.make (EDD-9039). An attribute
  // already defined above is skipped: `resolveKeyAttributeTypes` refused any
  // whose types differ (EDD-9091).
  const vectorAttributeDefs = (
    merged: Map<string, MergedVectorIndex>,
  ): Array<AttributeDefinition> => {
    const defs = new Map<string, KeyAttributeType>()
    for (const entry of merged.values()) {
      if (!attributeNames.has(entry.definition.partitionField)) {
        defs.set(entry.definition.partitionField, "S")
      }
      for (const [stored, type] of Object.entries(entry.filterStoredTypes)) {
        if (!attributeNames.has(stored)) defs.set(stored, type)
      }
    }
    return Array.from(defs.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType }))
  }

  const GlobalSecondaryIndexes: Array<GlobalSecondaryIndex> | undefined =
    gsiMap.size > 0
      ? Array.from(gsiMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([indexName, keys]) => ({
            IndexName: indexName,
            KeySchema: [
              { AttributeName: keys.pk, KeyType: "HASH" as const },
              { AttributeName: keys.sk, KeyType: "RANGE" as const },
            ],
            Projection: { ProjectionType: "ALL" as const },
          }))
      : undefined

  const LocalSecondaryIndexes: Array<LocalSecondaryIndex> | undefined =
    lsiMap.size > 0
      ? Array.from(lsiMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([indexName, keys]) => ({
            IndexName: indexName,
            KeySchema: [
              { AttributeName: keys.pk, KeyType: "HASH" as const },
              { AttributeName: keys.sk, KeyType: "RANGE" as const },
            ],
            Projection: { ProjectionType: "ALL" as const },
          }))
      : undefined

  const mergedVectorIndexes = mergeVectorIndexes(table.entities)
  const VectorIndexes: Array<VectorIndexSpec> | undefined =
    mergedVectorIndexes.size > 0
      ? Array.from(mergedVectorIndexes.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, entry]) =>
            toVectorIndexSpec(entry.definition, {
              filters: entry.filters,
              resolveDbName: entry.resolveDbName,
            }),
          )
      : undefined
  AttributeDefinitions.push(...vectorAttributeDefs(mergedVectorIndexes))

  const result: {
    KeySchema: Array<KeySchemaElement>
    AttributeDefinitions: Array<AttributeDefinition>
    GlobalSecondaryIndexes?: Array<GlobalSecondaryIndex>
    LocalSecondaryIndexes?: Array<LocalSecondaryIndex>
    VectorIndexes?: Array<VectorIndexSpec>
  } = { KeySchema, AttributeDefinitions }
  if (GlobalSecondaryIndexes) result.GlobalSecondaryIndexes = GlobalSecondaryIndexes
  if (LocalSecondaryIndexes) result.LocalSecondaryIndexes = LocalSecondaryIndexes
  if (VectorIndexes) result.VectorIndexes = VectorIndexes
  return result
}

// ---------------------------------------------------------------------------
// Table binding — BoundTable with create, delete, describe
// ---------------------------------------------------------------------------

/** Options for table creation. */
export interface CreateTableOptions {
  readonly billingMode?: "PAY_PER_REQUEST" | "PROVISIONED" | undefined
}

// ---------------------------------------------------------------------------
// rekey — move rows under other key text to what the setting composes (#171, #183)
// ---------------------------------------------------------------------------

/**
 * The rows `db.tables.<Table>.rekey()` moves, by kind:
 *
 * - `item` — an entity's item (its unique sentinels move with it, counted in
 *   {@link RekeyReport.sentinelsMoved})
 * - `snapshot` — a version snapshot (`versioned: { retain: true }`)
 * - `tombstone` — a soft-deleted item (the unique sentinels it kept,
 *   `preserveUnique`, move to their current keys and name the item's current
 *   key, counted in {@link RekeyReport.sentinelsMoved}), or a projection's
 *   row tombstone
 * - `outbox` — a projection's outbox item, to its read-model row's current
 *   key (an outbox on another table moves with that table's `rekey`)
 * - `event` — a time-series event
 * - `aggregate` — a row of an aggregate
 * - `stream` — a row of an event stream: events, snapshot, command sentinels
 */
export type RekeyRowKind =
  | "item"
  | "snapshot"
  | "tombstone"
  | "outbox"
  | "event"
  | "aggregate"
  | "stream"

/** Rows moved (or, in a dry run, that would move), by kind. */
export type RekeyCounts = { readonly [K in RekeyRowKind]: number }

/**
 * Why `rekey` left a row alone without judging its keys:
 *
 * - `notLibrary` — it has no `__edd_e__`: the library did not write it
 * - `unregistered` — its `__edd_e__` names no entity, aggregate or stream
 *   the client knows (pass event streams in {@link RekeyOptions.streams}),
 *   or it is an outbox item on another table than its read model's, of a
 *   projection not defined where `rekey` runs
 * - `unrecognizedKey` — its member's, but stored neither under the key its
 *   values compose now nor under the one 1.36 composed for them. A unique
 *   sentinel of a constraint the entity doesn't declare, or one not under the
 *   schema's own key prefix, is counted here too (a sentinel of a declared
 *   constraint that no row holds is in {@link RekeyReport.reservations}). When several
 *   members claim its `__edd_e__` (read models of one entity type whose outboxes
 *   share a table), it names none of them, and its row's key is no key any of
 *   them writes
 * - `rootNotSeen` — a row of an aggregate with no root in its partition, met by
 *   a run that didn't read the whole table (`maxPages` or `resume`). A root at
 *   its old key on a page the run didn't read could still claim it, so nothing
 *   is said of it. A run over the whole table judges it: a dry run will do
 * - `ambiguousOwner` — a projection's outbox item that more than one read model
 *   of its entity type sharing its table could have written, which they would
 *   move to different keys, and whose read-model row doesn't say whose it is:
 *   each one is in {@link RekeyReport.ambiguous}, with the reason
 */
export type RekeySkipReason =
  | "notLibrary"
  | "unregistered"
  | "unrecognizedKey"
  | "rootNotSeen"
  | "ambiguousOwner"

/**
 * A projection's outbox item `rekey` left where it is because it can't tell whose it is. Read
 * models of one entity type whose outboxes share a table can write one key: a value holding `#`
 * spells a longer key's text (`shop` = `x#branch_y` beside `shop` = `x`, `branch` = `y`). From
 * 1.41.0 an item names its read model (`__edd_rm__`), and that decides. An item written before
 * names none: it is the read model's whose rows' keys it can be, when only one can have written
 * it, and moves as any other when every one that can would move it to one key. Otherwise the row
 * it names (`__edd_row_pk__`, `__edd_row_sk__`) is read from each one's table, at that key and at
 * the key that read model would move it to: the item is the read model's whose own row is there
 * (its values compose that key), when exactly one finds one and none finds a tombstone. Otherwise
 * it's left, and a rerun leaves it again:
 *
 * - `rowGone` — no read model has that row
 * - `unsettled` — the row doesn't say whose the item is: a tombstone is there, which holds no
 *   values, or more than one read model finds a row of its own, or a read model's table isn't
 *   provided where `rekey` runs
 */
export interface RekeyAmbiguity {
  /** The entity type of the read models that can have written it. */
  readonly member: string
  /** The item's primary key, as stored. */
  readonly key: Readonly<Record<string, unknown>>
  /** Where each of them would move it: its key as stored for one that finds it current. */
  readonly targets: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly reason: "rowGone" | "unsettled"
  readonly message: string
}

/**
 * A row `rekey` did not move, and why. A row is moved only where nothing is
 * (or, a stream's snapshot, over an older one), and deleted only while it is
 * as `rekey` read it, so a write that lands in between wins:
 *
 * - `bothKeys` — the same row (the same item, version, event, …) is also
 *   under its current key — for an aggregate, any of its rows is, or which
 *   of them are where can't be told; both are left as they are
 * - `taken` — another row holds its current key — for an aggregate, a row
 *   that isn't one of its own holds one of its rows' current keys, and doesn't
 *   move out of the way in this run
 * - `contended` — concurrent writes changed it on every attempt
 * - `failed` — it could not be moved as stored (its values no longer decode,
 *   a stream id reads as more than one id, or a write was refused);
 *   `message` says why
 * - `uncomposable` — its values can't compose a current key: a composite holds a
 *   value with no key text (`NaN`) or one no form of its schema takes
 *   (`EDD-9050`); `message` says which. Or its key on a sharded index is from
 *   another layout, and its values can't compose a current one (a `by`
 *   attribute was cleared) (#183)
 * - `unguarded` — it can't be proven unchanged when it moves: guarded whole, it's
 *   over DynamoDB's limits on one expression, and it has no version or
 *   `updatedAt` to stand in (its member is neither `versioned` nor `timestamps`,
 *   or it's a stream's row or a projection's row tombstone or outbox item). A
 *   write landing between the read and the move would be lost, so it's left, in
 *   a dry run too (for an aggregate or a stream nothing of which has moved, every
 *   row of it; one already part-moved is finished under the strongest guard that
 *   fits, as on 1.39.0). Stop writes to the table and run with
 *   {@link RekeyOptions.writesStopped}
 */
export interface RekeyConflict {
  /** The entity type, aggregate or stream name. */
  readonly member: string
  readonly kind: RekeyRowKind
  readonly reason: "bothKeys" | "taken" | "contended" | "failed" | "uncomposable" | "unguarded"
  /** The row's primary key, as stored. */
  readonly key: Readonly<Record<string, unknown>>
  /** Its current key: where it would move. */
  readonly target: Readonly<Record<string, unknown>> | undefined
  readonly message: string
}

/**
 * The index keys of live items that aren't what a `put` of their stored values writes (#185). Keys,
 * not rows: a row can count more than once. The first four are counted on every run, for no extra
 * read, and the last two only with {@link RekeyOptions.repairIndexKeys}.
 *
 * - `missing` — every composite is on the row, and no key
 * - `truncated` — every composite is on the row, and the key stops at a leading run of them
 * - `lagging` — the key holds other values: a composite changed under `preserve`, or a `sparse` half
 *   holds a key its values no longer compose
 * - `ambiguous` — a `sparse` half with no key and two or more composites outside the primary key on
 *   the row. A writer naming only a later composite takes a row out of the index on purpose, and
 *   that leaves the same bytes, so these are never written
 * - `repaired` — keys written: `missing`, `truncated` and `lagging`, less those a writer changed
 *   first. A dry run writes none, so it counts none: what it finds is what a run would write
 * - `skipped` — keys a writer changed the row under, twice: the writer won
 */
export interface RekeyIndexKeys {
  readonly missing: number
  readonly truncated: number
  readonly lagging: number
  readonly ambiguous: number
  readonly repaired: number
  readonly skipped: number
}

/**
 * Rows `rekey` moved under a guard that can miss a write landing between its read and the move,
 * with writes to the table going on (counted only without {@link RekeyOptions.writesStopped}). The
 * move puts the row back as it read it, so a write the guard doesn't see is lost (DESIGN.md §7,
 * "What 'as read' proves"):
 *
 * - `stamp` — an entity's row too wide to guard whole, guarded on its `updatedAt` (held, or absent)
 *   and what else fits: a write that leaves `updatedAt` as it was isn't seen when it changes an
 *   attribute the guard leaves out. A library write within the stamp's resolution (the same
 *   millisecond, or second for epoch seconds) is one: on an item, an update; on a tombstone, a soft
 *   delete of the item put again; on a time-series event, an `append` made after its current item
 *   was deleted. So is a `reembed`, which stamps nothing.
 * - `sparse` — an entity's row with a sparse map (`storedAs: DynamoModel.SparseMap()`), guarded
 *   whole: a write that only adds an entry adds an attribute no declaration names, so the guard
 *   can't hold it absent. A library write stamps `updatedAt`, which the guard holds, so with
 *   timestamps only one within the stamp's resolution goes unseen.
 * - `strongest` — a row of an aggregate or stream already part-moved, too wide to guard whole and
 *   finished under the strongest guard that fits: a write to an attribute it leaves out isn't seen.
 *
 * A row is counted only where a library write can be missed. A write from outside the library is
 * seen only through the guard's terms, so these are never seen, on any row moved with writes going
 * on, counted or not:
 *
 * - on a versioned item's row (live, snapshot or tombstone), one that leaves the version, the
 *   incarnation token and the vector attributes as they were, whatever else it changes;
 * - on a unique sentinel, one that leaves the row it names as it was;
 * - on an entity's other rows and an aggregate's rows, one that only adds attributes the member
 *   doesn't declare; on an event stream's row, one that only adds attributes; on a projection's row
 *   tombstone or outbox item, one that only adds attributes other than a drainer's claim;
 * - on a row counted here, what its count says.
 *
 * Stopping writes and running with `writesStopped: true` closes every one of these.
 */
export interface RekeyGuardGaps {
  readonly stamp: number
  readonly sparse: number
  readonly strongest: number
}

/** A row counted in {@link RekeyGuardGaps}, named so it can be checked. */
export interface RekeyGuardGapRow {
  /** The entity type, aggregate or stream name. */
  readonly member: string
  readonly kind: RekeyRowKind
  /** The count it's in. */
  readonly gap: keyof RekeyGuardGaps
  /** The row's primary key, as stored when the run read it. */
  readonly key: Readonly<Record<string, unknown>>
  /** Its current key: where the run moved it (a dry run: where it would). */
  readonly target: Readonly<Record<string, unknown>>
}

/** {@link RekeyGuardGaps}, and the rows counted. */
export interface RekeyGuardGapReport extends RekeyGuardGaps {
  /**
   * The rows counted, by member, kind and key: at most 100, the first in that order, so the list
   * is the same whatever order the run met them in. The counts are exact.
   */
  readonly rows: ReadonlyArray<RekeyGuardGapRow>
}

/**
 * What `rekey` did with a unique sentinel no row holds, or one it couldn't judge
 * ({@link RekeyReservation}):
 *
 * - `orphaned` — no row holds it, and it was left: the run didn't ask for
 *   {@link RekeyOptions.releaseOrphanedReservations}
 * - `released` — deleted, or with `dryRun`, would be
 * - `skipped` — left to a write that changed it or its row between the read and the release, twice
 * - `raced` — no row held it when read, but a write got there before the release: it claimed the
 *   sentinel, gave the row it names its value, or deleted it. Read again, it is held or gone, so it
 *   was left, and it isn't counted `orphaned`
 * - `undecided` — left, since nothing says whether a row holds it: it names no row, it names a row
 *   of another type whose attributes don't compose its key (one whose do is taken to hold it, as
 *   1.40.0 took it, and isn't counted), or that row's values compose no sentinel key
 */
export type RekeyReservationOutcome = "orphaned" | "released" | "skipped" | "raced" | "undecided"

/**
 * A unique sentinel of a known entity and constraint that no row holds, or that `rekey` couldn't
 * judge. A sentinel is held by the row its back-pointer (`_entity_pk` / `_entity_sk`) names, when
 * that row's values compose the sentinel's key under any key text. With `softDelete: {
 * preserveUnique: true }` a tombstone of that row holds it the same way: the soft delete kept the
 * reservation on purpose.
 */
export interface RekeyReservation {
  /** The entity type. */
  readonly member: string
  /** The unique constraint's name. */
  readonly constraint: string
  /** The sentinel's primary key, as stored. */
  readonly key: Readonly<Record<string, unknown>>
  /** The key its back-pointer names, as stored: `undefined` when it names none. */
  readonly owner: Readonly<Record<string, unknown>> | undefined
  readonly outcome: RekeyReservationOutcome
  readonly message: string
}

/**
 * Unique sentinels no row holds, and ones `rekey` couldn't judge, counted only with
 * {@link RekeyOptions.reservations} (or `releaseOrphanedReservations`): without, every count is 0,
 * and such a sentinel is counted in `skipped.unrecognizedKey`, as 1.40.0 counted it. `released`,
 * `skipped` and `raced` are counted only with {@link RekeyOptions.releaseOrphanedReservations}.
 * `orphaned` counts every one found and still orphaned when released or left, so it includes those
 * `released` and `skipped`, and not those `raced`. Each sentinel is judged once a run, however the
 * run reaches it.
 */
export interface RekeyReservationCounts {
  readonly orphaned: number
  readonly released: number
  readonly skipped: number
  readonly raced: number
  readonly undecided: number
}

/** {@link RekeyReservationCounts}, and each sentinel counted. */
export interface RekeyReservations extends RekeyReservationCounts {
  /** One per sentinel counted, by member and then key. */
  readonly entries: ReadonlyArray<RekeyReservation>
}

/** One member's share of a {@link RekeyReport}. */
export interface RekeyMemberReport {
  readonly unchanged: number
  readonly moved: RekeyCounts
  readonly indexKeysRewritten: number
  readonly zonesRewritten: number
  readonly sentinelsMoved: number
  readonly conflicts: number
  readonly indexKeys: RekeyIndexKeys
  readonly reservations: RekeyReservationCounts
  readonly guardGaps: RekeyGuardGaps
}

/**
 * What a `rekey` run did — or, with `dryRun`, would do. Each row is judged once a run, however
 * many times the scan and the moves of other rows reach it, and the report and the rows left
 * don't depend on the order the scan returns rows in, its segment count or its `concurrency`.
 * Counts are of rows stored when the run met them, never of rows the run wrote: the scan passes
 * a row the run moved there. A row an application write moved between the scan and the move is
 * `unchanged`: `moved` counts the rows this run moved.
 */
export interface RekeyReport {
  readonly dryRun: boolean
  /**
   * Rows the table held that the run met: each once, when the scan returned it or when the run
   * moved it out of another row's way first. Rows the run put aren't counted, nor is a row the
   * scan returned from a page read before the run moved it.
   */
  readonly scanned: number
  /**
   * Rows of a known member already under their current keys, with nothing to rewrite. A row the
   * run moved isn't, whichever member meets it after.
   */
  readonly unchanged: number
  /** Rows moved to their current keys (a dry run: rows that would move), by kind. */
  readonly moved: RekeyCounts
  /**
   * Items under their current table key whose index keys or vector partition
   * held 1.36 text, rewritten in place (`UpdateItem`).
   */
  readonly indexKeysRewritten: number
  /**
   * Rows of an entity (items, snapshots, tombstones, time-series events) holding a named zone or a
   * zoned date's text that isn't what a write of its value stores now, rewritten (a dry run: rows
   * that would be): a zone 1.38.0 to 1.40.0 stored on Effect 4.1.3 with its `resolvedId`, which an
   * equality condition or filter doesn't match. Rewritten in place, or in the row's move.
   */
  readonly zonesRewritten: number
  /** Unique-constraint sentinels moved to their current keys. */
  readonly sentinelsMoved: number
  /** Index keys that aren't what a `put` of their row's values writes: {@link RekeyIndexKeys}. */
  readonly indexKeys: RekeyIndexKeys
  /** Unique sentinels no row holds, and ones that couldn't be judged: {@link RekeyReservations}. */
  readonly reservations: RekeyReservations
  /** Rows moved under a guard that can miss a write, and up to 100 of them: {@link RekeyGuardGapReport}. */
  readonly guardGaps: RekeyGuardGapReport
  /** Rows left where they are — see {@link RekeyConflict}. */
  readonly conflicts: ReadonlyArray<RekeyConflict>
  /** Rows no member owns, by reason. */
  readonly skipped: { readonly [R in RekeySkipReason]: number }
  /**
   * The outbox items counted in `skipped.ambiguousOwner`, each with why it was left: see
   * {@link RekeyAmbiguity}.
   */
  readonly ambiguous: ReadonlyArray<RekeyAmbiguity>
  /** Per entity type, aggregate and stream name. */
  readonly byMember: Readonly<Record<string, RekeyMemberReport>>
  /** What the run consumed — always measured, whatever `ConsumedCapacity` reporting is set to. */
  readonly capacity: CapacityTotals
  /** What the run remembered, and whether it ran out of room: {@link RekeyJournal}. */
  readonly journal: RekeyJournal
  /**
   * Where the scan stopped, when it stopped before the end of the table
   * (`maxPages`): pass it as {@link RekeyOptions.resume} to go on.
   * `None` when the run covered the whole table.
   */
  readonly resume: Option.Option<string>
}

/** The counts of a {@link RekeyReport}, by name. */
export type RekeyCountName =
  | "scanned"
  | "unchanged"
  | "moved"
  | "indexKeysRewritten"
  | "sentinelsMoved"
  | "indexKeys"
  | "reservations"
  | "guardGaps"
  | "conflicts"
  | "skipped"

/**
 * What a `rekey` run remembers ({@link RekeyOptions.journalCapacity}): the keys it wrote to, the
 * units it judged, and what it counted once, each a 128-bit digest with a few flags, never key
 * text or a row. A row it doesn't move, write or report costs nothing; an aggregate's rows, which
 * its root's move may take after the scan meets them, cost an entry each, moved or not. Moving a
 * row costs about five entries. A real run keeps no row's image (only the last few it put); a dry
 * run keeps each row it plans to put, which its reads see, and that row takes an entry for every
 * 256 bytes of it.
 *
 * Under the capacity every count is exact, and the same whatever order the run meets the rows in.
 * Once it's reached (`full`), the run carries on — its writes are guarded as ever, so no row is
 * lost or overwritten — but what it forgets it can't pass or count once: `inexact` names the counts
 * that may be off. A real run then meets a row it put as a row stored there (`scanned`, `unchanged`,
 * `indexKeys` count it, as 1.40.0 counted every such row), judges a unit reached again once more
 * (`unchanged`, `reservations`), may count a row stored under two old key texts as two moves
 * (`moved`), may report a row in another's way that a run with room moves after it (`conflicts`; a
 * rerun moves it), and doesn't report a row with no aggregate root found (`skipped`). A dry run's
 * reads no longer see its whole plan, so any count may be off.
 */
export interface RekeyJournal {
  /** {@link RekeyOptions.journalCapacity}, as used. */
  readonly capacity: number
  /** The entries the run kept: at most `capacity`. */
  readonly used: number
  /** Whether the run had more to keep than `capacity` entries. */
  readonly full: boolean
  /** The counts that may be off: none while the journal isn't full. */
  readonly inexact: ReadonlyArray<RekeyCountName>
}

/** Options for `db.tables.<Table>.rekey()`. */
export interface RekeyOptions {
  /**
   * Count what would move, reading but writing nothing. Default `false`. What holds a
   * row's destination is judged too, so what would stop the row stops it here as well.
   */
  readonly dryRun?: boolean | undefined
  /**
   * Also write the index keys {@link RekeyReport.indexKeys} finds differing, except `ambiguous`
   * ones. Default `false`: the run counts them and writes nothing new. Each row is one conditional
   * `UpdateItem`, guarded on every key it writes and every composite it composes them from as read,
   * so a writer changing any of them wins; on a failed condition the row is read once and judged
   * again, then counted in `skipped`. A table with nothing to repair costs the scan alone.
   */
  readonly repairIndexKeys?: boolean | undefined
  /**
   * Judge the unique sentinels no row holds, and count them in {@link RekeyReport.reservations}.
   * Default `false`: the run sends what 1.40.0 sent, and counts such a sentinel in
   * `skipped.unrecognizedKey`, as 1.40.0 did. Judging reads more than that: under `preserveUnique`,
   * a sentinel whose item is gone or holds another value costs a query for the item's tombstones,
   * and one that looks orphaned is read again. It writes nothing.
   */
  readonly reservations?: boolean | undefined
  /**
   * Also delete the unique sentinels {@link RekeyReport.reservations} finds no row holding
   * (`orphaned`), so their values can be taken again. Implies {@link reservations}. Default
   * `false`: nothing is deleted. A maintenance step: it needs {@link writesStopped}, with every
   * writer to the table stopped — another run releasing reservations counts as one — and fails
   * with a `ValidationError` (`EDD-9098`) before anything is read without it. Each release is one
   * transaction: the sentinel's `Delete`, conditioned on its back-pointer (and TTL, when it has
   * one) as read, so another row's claim in between is never deleted, and a `ConditionCheck`
   * that the row it names is still absent, or still holds the values read. These don't make it
   * safe while the application writes, hence `writesStopped`: the row it names can take the value
   * again in between, put again and soft-deleted under `preserveUnique`, leaving the sentinel as
   * read and its tombstone holding the value, and the release deletes a reservation in use. On a
   * failed condition the sentinel is read once and judged again. Only a sentinel of a known entity and constraint,
   * under the schema's own key prefix, is ever judged. An orphaned sentinel holding the current
   * key of another item's sentinel is judged, and released, before that sentinel moves there.
   */
  readonly releaseOrphanedReservations?: boolean | undefined
  /**
   * Writes to the table are stopped for this run. A row `rekey` can't prove unchanged when it
   * moves (`unguarded`: too wide to guard whole, with no version or stamped `updatedAt` to stand in) then
   * moves under the strongest guard that fits, as on 1.39.0. Default `false`: such a row is
   * left where it is and reported `unguarded`, since a write landing between the read and the move
   * would be lost, unless its aggregate or stream is already part-moved. Run with this only while
   * nothing else writes to the table.
   */
  readonly writesStopped?: boolean | undefined
  /** Parallel scan segments (`TotalSegments`), each scanned by its own fiber. Default 1. */
  readonly segments?: number | undefined
  /** Rows of one scan page handled at once, per segment. Default 4. */
  readonly concurrency?: number | undefined
  /** The scan's page size (`Limit`). Default: DynamoDB's (1 MB pages). */
  readonly pageSize?: number | undefined
  /**
   * How many entries the run's journal holds at most ({@link RekeyJournal}): one for each key it
   * writes to, unit it judges and row it counts once; a row it doesn't move, write or report costs
   * none. Default 1,000,000: about 145 bytes an entry, so about 138 MiB when full, and exact counts
   * for about 200,000 moved rows. Past it the run goes on, its counts named in
   * {@link RekeyReport.journal} may be off, and a smaller run (`maxPages`, then `resume`) keeps
   * them exact. A positive integer up to 16,000,000.
   */
  readonly journalCapacity?: number | undefined
  /**
   * Stop after this many scan pages (all segments together) and return a
   * {@link RekeyReport.resume} token: bound a run to a time slot and go on
   * in the next one.
   */
  readonly maxPages?: number | undefined
  /**
   * A {@link RekeyReport.resume} token — of an earlier run, or the last one
   * {@link onProgress} received before a run was interrupted. Its segment
   * count wins; a different `segments` fails (`EDD-9098`).
   */
  readonly resume?: string | undefined
  /**
   * The event streams on the table, bound or not. `DynamoClient.make` does
   * not register streams, so a stream's rows are `unregistered` (skipped)
   * unless it is listed here. A stream on another table is ignored.
   */
  readonly streams?:
    | ReadonlyArray<
        | EventStream<any, any, any, any, any, any, any>
        | BoundEventStream<any, any, any, any, any, any, any>
      >
    | undefined
  /**
   * Called after each scan page, once every row of it is handled, with the
   * report so far and a `resume` token from that point: a run that is
   * interrupted resumes from the last token it delivered, redoing at most
   * the pages in flight (`rekey` is idempotent).
   */
  readonly onProgress?: ((progress: RekeyReport) => Effect.Effect<void>) | undefined
}

/**
 * A bound table with executable operations (`R = never`).
 *
 * @internal Used by `DynamoClient.make()`.
 */
export interface BoundTable {
  /** Physical table name. */
  readonly name: string

  /**
   * Create the physical DynamoDB table from the table's registered members.
   */
  readonly create: (options?: CreateTableOptions) => Effect.Effect<void, DynamoClientError>

  /** Delete the physical DynamoDB table. */
  readonly delete: Effect.Effect<void, DynamoClientError>

  /** Describe the table (status, stream specification, item count, etc.). */
  readonly describe: Effect.Effect<DescribeTableCommandOutput, DynamoClientError>
}
