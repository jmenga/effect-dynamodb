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
import type { IndexDefinition } from "@effect-dynamodb/schema/KeyComposer.js"
import type { VectorIndexDefinition } from "@effect-dynamodb/schema/VectorIndex.js"
import {
  MAX_INLINE_FILTERS,
  MAX_VECTOR_INDEXES_PER_TABLE,
  toWireDistanceFunction,
} from "@effect-dynamodb/schema/VectorIndex.js"
import { type Config, Context, Effect, Layer } from "effect"
import type { DynamoClientError } from "./DynamoClient.js"

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
 * MainTable.layerConfig({ name: Config.string("TABLE_NAME") })
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

  // Configure all entities with this table's schema and tag
  for (const entity of Object.values(entities)) {
    if (typeof entity._configure === "function") {
      entity._configure(config.schema, Tag)
    }
  }

  // Cross-entity vector index agreement. `Dimensions` and `DistanceFunction` are
  // immutable at the DynamoDB level, so two entities sharing a physical vector
  // index cannot disagree — catch it at definition time rather than on the
  // CreateTable round trip.
  validateSharedVectorIndexes(entities)

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
 * designs — the quota is 5 per table — and it is safe precisely because the
 * composed `__edd_vp_<name>__` partition value carries the entity type, so a
 * search never crosses entity boundaries (see `DESIGN.md §14`).
 *
 * @throws when two entities disagree on `dimensions` or `distance` (EDD-9035),
 *   or when more than {@link MAX_VECTOR_INDEXES_PER_TABLE} distinct physical
 *   indexes are declared (EDD-9034).
 */
export const mergeVectorIndexes = (
  entities: Record<string, EntityLike>,
): Map<string, MergedVectorIndex> => {
  const merged = new Map<
    string,
    {
      definition: VectorIndexDefinition
      owner: string
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
        existing.filterStoredTypes[stored] = storedType
        if (existing.filters.some((f) => existing.resolveDbName(f) === stored)) continue
        existing.filters.push(filter)
      }
    }
  }

  for (const [indexName, entry] of merged) {
    if (entry.filters.length > MAX_INLINE_FILTERS) {
      throw new Error(
        `[EDD-9032] Vector index "${indexName}" resolves to ${entry.filters.length} INLINE_FILTER ` +
          `attributes once unioned across the entities sharing it ` +
          `(${[...entry.filters].sort().join(", ")}). DynamoDB allows at most ` +
          `${MAX_INLINE_FILTERS} per vector index.`,
      )
    }
  }

  if (merged.size > MAX_VECTOR_INDEXES_PER_TABLE) {
    throw new Error(
      `[EDD-9034] Table declares ${merged.size} vector indexes ` +
        `(${[...merged.keys()].sort().join(", ")}). DynamoDB allows at most ` +
        `${MAX_VECTOR_INDEXES_PER_TABLE} per table.`,
    )
  }

  return merged
}

/** A physical vector index resolved across every entity that declares it. */
export interface MergedVectorIndex {
  /** The first declaring entity's definition — authoritative for dimensions/distance. */
  readonly definition: VectorIndexDefinition
  /** Entity type of the first declarer, used in conflict messages. */
  readonly owner: string
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
 * Resolve the table's primary PK/SK field names from the first entity carrying a
 * primary index. Aggregates are skipped — they borrow the table's primary key
 * rather than declaring one.
 *
 * Returns `undefined` when no entity declares a primary index (a table registering
 * only aggregates). Callers that require the primary key must treat that as an error;
 * callers performing best-effort validation should skip their check instead.
 */
export const resolvePrimaryKey = (
  entities: Record<string, EntityLike>,
): { readonly pk: string; readonly sk: string | undefined } | undefined => {
  for (const entity of Object.values(entities)) {
    const primary = entity.indexes.primary
    if (primary) {
      return { pk: primary.pk.field, sk: primary.sk.field }
    }
  }
  return undefined
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
 * All key attributes are typed as "S" (String) since generated keys are always strings.
 *
 * LSI auto-detection: an aggregate's `collection` GSI config is emitted as an LSI
 * iff `agg.pkField` equals the table's primary PK field (determined from the first
 * entity's primary index). This matches DynamoDB semantics — any index that shares
 * the base table's partition key IS an LSI — and makes `lsi1`..`lsi5`-style indexes
 * on aggregates work transparently with `db.tables.*.create()`.
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

  // Pass 2: collect attribute names and classify indexes (GSI vs LSI).
  const attributeNames = new Set<string>()
  const gsiMap = new Map<string, { pk: string; sk: string }>()
  const lsiMap = new Map<string, { pk: string; sk: string }>()

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
        if (agg.pkField === primaryPk) {
          if (!lsiMap.has(collectionIndex) && !gsiMap.has(collectionIndex)) {
            lsiMap.set(collectionIndex, { pk: agg.pkField, sk: collectionSk.field })
          }
        } else {
          if (!gsiMap.has(collectionIndex) && !lsiMap.has(collectionIndex)) {
            gsiMap.set(collectionIndex, { pk: agg.pkField, sk: collectionSk.field })
          }
        }
      }

      // List GSI (if configured) — always a GSI; has its own PK attribute.
      if (agg.listIndex) {
        attributeNames.add(agg.listIndex.pk.field)
        attributeNames.add(agg.listIndex.sk.field)
        if (!gsiMap.has(agg.listIndex.index) && !lsiMap.has(agg.listIndex.index)) {
          gsiMap.set(agg.listIndex.index, {
            pk: agg.listIndex.pk.field,
            sk: agg.listIndex.sk.field,
          })
        }
      }
    } else {
      // Entity — scan index definitions
      const entity = member as EntityLike
      for (const [indexName, index] of Object.entries(entity.indexes)) {
        if (!index) continue

        attributeNames.add(index.pk.field)
        attributeNames.add(index.sk.field)

        if (indexName === "primary") {
          // Primary key already captured in pass 1.
          continue
        }
        if (index.index) {
          // Entity-declared secondary index — always a GSI. Entity index definitions
          // don't carry LSI semantics; LSIs are only introduced via aggregate collections.
          if (!gsiMap.has(index.index) && !lsiMap.has(index.index)) {
            gsiMap.set(index.index, { pk: index.pk.field, sk: index.sk.field })
          }
        }
      }
    }
  }

  const KeySchema: Array<KeySchemaElement> = [{ AttributeName: primaryPk, KeyType: "HASH" }]
  if (primarySk !== undefined && primarySk !== primaryPk) {
    KeySchema.push({ AttributeName: primarySk, KeyType: "RANGE" })
  }

  const AttributeDefinitions: Array<AttributeDefinition> = Array.from(attributeNames)
    .sort()
    .map((name) => ({ AttributeName: name, AttributeType: "S" as const }))

  // Every SearchSchema element must appear in AttributeDefinitions (verified
  // against the live service; DynamoDB Local silently accepts their absence).
  // The composed HASH partition attribute is always a string; filter types are
  // derived from the model schema at Entity.make (EDD-9039).
  const vectorAttributeDefs = (
    merged: Map<string, MergedVectorIndex>,
  ): Array<AttributeDefinition> => {
    const defs = new Map<string, "S" | "N">()
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
