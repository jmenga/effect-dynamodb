/**
 * Table — Groups entities sharing a physical DynamoDB table and application namespace.
 *
 * The Table holds a DynamoSchema reference for key prefix generation and
 * a record of named entities (and optionally aggregates).
 * The physical table name is provided at runtime via Effect Layers.
 *
 * Use `DynamoClient.make(table)` to get a typed client with bound entity operations.
 */

import type { DescribeTableCommandOutput } from "@aws-sdk/client-dynamodb"
import { type Config, Effect, Layer, ServiceMap } from "effect"
import type { DynamoClientError } from "./DynamoClient.js"
import type * as DynamoSchema from "./DynamoSchema.js"
import type { IndexDefinition } from "./KeyComposer.js"

/** Runtime table configuration injected via Effect Layer. */
export interface TableConfig {
  /** Physical DynamoDB table name. */
  readonly name: string
}

/**
 * Counter for generating unique Tag identifiers.
 * Each `make()` call increments this to ensure distinct ServiceMap.Service tags.
 */
let tableCounter = 0

/** Minimal entity shape for Table membership (avoids circular import with Entity.ts) */
interface EntityLike {
  readonly _tag: "Entity"
  readonly indexes: Record<string, IndexDefinition>
  readonly _configure: (
    schema: DynamoSchema.DynamoSchema,
    tableTag: ServiceMap.Service<TableConfig, TableConfig>,
  ) => void
}

/** Minimal aggregate shape for Table membership (avoids circular import with Aggregate.ts) */
interface AggregateLike {
  readonly _tag: "Aggregate"
  readonly pkField: string
  readonly collection: {
    readonly index: string
    readonly sk: { readonly field: string }
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
  /** Effect ServiceMap.Service tag for this table's runtime config */
  readonly Tag: ServiceMap.Service<TableConfig, TableConfig>
  /** Provide the physical table name */
  readonly layer: (config: TableConfig) => Layer.Layer<TableConfig>
  /** Provide the physical table name from Effect Config */
  readonly layerConfig: (config: {
    readonly name: Config.Config<string>
  }) => Layer.Layer<TableConfig, Config.ConfigError>
}

/**
 * Create a new Table definition with optional entity and aggregate members.
 *
 * Each call to `make` creates a new unique ServiceMap.Service, so different tables
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
  const Tag = ServiceMap.Service<TableConfig>(`@effect-dynamodb/Table/${config.schema.name}/${id}`)

  const entities = (config.entities ?? {}) as TEntities
  const aggregates = (config.aggregates ?? {}) as TAggregates

  // Configure all entities with this table's schema and tag
  for (const entity of Object.values(entities)) {
    if (typeof entity._configure === "function") {
      entity._configure(config.schema, Tag)
    }
  }

  return {
    _tag: "Table" as const,
    schema: config.schema,
    entities,
    aggregates,
    Tag,
    layer: (tableConfig: TableConfig) => Layer.succeed(Tag, tableConfig),
    layerConfig: (configDef: { readonly name: Config.Config<string> }) =>
      Layer.effect(
        Tag,
        Effect.gen(function* () {
          const tableName = yield* configDef.name
          return { name: tableName }
        }),
      ),
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

/**
 * Derived CreateTable input (minus TableName) computed from entity index definitions.
 * Produced by {@link definition}. Mutable arrays for direct compatibility with
 * the AWS SDK's `CreateTableCommandInput`.
 */
export interface TableDefinition {
  readonly KeySchema: Array<KeySchemaElement>
  readonly AttributeDefinitions: Array<AttributeDefinition>
  readonly GlobalSecondaryIndexes?: Array<GlobalSecondaryIndex> | undefined
}

/**
 * Derive CreateTable input from a table's registered members.
 *
 * Scans all entity index definitions and aggregate GSI configs to produce:
 * - KeySchema (from primary index)
 * - AttributeDefinitions (all unique key attributes)
 * - GlobalSecondaryIndexes (from non-primary indexes + aggregate collection/list indexes)
 *
 * The physical table name is omitted — that's deployment config.
 * All key attributes are typed as "S" (String) since generated keys are always strings.
 */
export const definition = (table: Table): TableDefinition => {
  const members: ReadonlyArray<EntityLike | AggregateLike> = [
    ...Object.values(table.entities),
    ...Object.values(table.aggregates),
  ]

  if (members.length === 0) {
    throw new Error("Table.definition requires at least one entity or aggregate")
  }

  // Collect all unique key field names and GSI definitions
  const attributeNames = new Set<string>()
  const gsiMap = new Map<string, { pk: string; sk: string }>()
  let primaryPk: string | undefined
  let primarySk: string | undefined

  for (const member of members) {
    if ("_tag" in member && member._tag === "Aggregate") {
      // Aggregate — extract collection and list GSI configs
      const agg = member as AggregateLike

      // Collection GSI: PK = aggregate's pkField, SK = collection sk field
      const collectionIndex = agg.collection.index
      attributeNames.add(agg.pkField)
      attributeNames.add(agg.collection.sk.field)
      if (!gsiMap.has(collectionIndex)) {
        gsiMap.set(collectionIndex, { pk: agg.pkField, sk: agg.collection.sk.field })
      }

      // List GSI (if configured)
      if (agg.listIndex) {
        attributeNames.add(agg.listIndex.pk.field)
        attributeNames.add(agg.listIndex.sk.field)
        if (!gsiMap.has(agg.listIndex.index)) {
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
          // First entity's primary index determines table key schema
          if (primaryPk === undefined) {
            primaryPk = index.pk.field
            primarySk = index.sk.field
          }
        } else if (index.index) {
          // GSI — collect by physical index name
          if (!gsiMap.has(index.index)) {
            gsiMap.set(index.index, { pk: index.pk.field, sk: index.sk.field })
          }
        }
      }
    }
  }

  if (primaryPk === undefined) {
    throw new Error("No primary index found on any entity")
  }

  const KeySchema: Array<KeySchemaElement> = [{ AttributeName: primaryPk, KeyType: "HASH" }]
  if (primarySk !== undefined && primarySk !== primaryPk) {
    KeySchema.push({ AttributeName: primarySk, KeyType: "RANGE" })
  }

  const AttributeDefinitions: Array<AttributeDefinition> = Array.from(attributeNames)
    .sort()
    .map((name) => ({ AttributeName: name, AttributeType: "S" as const }))

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

  return GlobalSecondaryIndexes
    ? { KeySchema, AttributeDefinitions, GlobalSecondaryIndexes }
    : { KeySchema, AttributeDefinitions }
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
 * @internal Used by `DynamoClient.make(table)`.
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
