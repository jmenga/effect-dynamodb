/**
 * KeyComposer — Composite key composition for DynamoDB keys.
 *
 * v2 uses attribute-list composition (composite: ["userId"]) instead of
 * template strings ("USER#${userId}"). The DynamoSchema module handles
 * the key format; KeyComposer extracts attribute values and delegates.
 */

import { DateTime } from "effect"
import type * as DynamoSchema from "./DynamoSchema.js"
import {
  composeClusteredSortKey,
  composeCollectionKey,
  composeIsolatedSortKey,
  composeKey,
} from "./DynamoSchema.js"

/** Index key part definition (pk or sk of an index) */
export interface KeyPart {
  readonly field: string
  readonly composite: ReadonlyArray<string>
}

/** Index definition for primary or secondary index (internal format) */
export interface IndexDefinition {
  readonly index?: string | undefined // Physical GSI name (omit for primary)
  readonly collection?: string | ReadonlyArray<string> | undefined
  readonly type?: "isolated" | "clustered" | undefined // Default: "isolated"
  readonly pk: KeyPart
  readonly sk: KeyPart
  readonly casing?: DynamoSchema.Casing | undefined
}

/** GSI definition as specified on Entity.make() indexes config.
 * Mirrors the primaryKey structure with an added `name` for the physical GSI. */
export interface GsiConfig {
  /** Physical GSI name (e.g., `"gsi1"`). */
  readonly name: string
  /** Optional collection name. String for single, array for sub-collections. */
  readonly collection?: string | ReadonlyArray<string> | undefined
  /** SK ordering mode. `"isolated"` (default) puts entity type before composites; `"clustered"` puts entity type after composites (required for sub-collections). */
  readonly type?: "isolated" | "clustered" | undefined
  /** Partition key: physical field name + composite attributes. */
  readonly pk: KeyPart
  /** Sort key: physical field name + composite attributes. */
  readonly sk: KeyPart
}

/** Normalize a GsiConfig (entity input) to an IndexDefinition (internal format). */
export const normalizeGsiConfig = (config: GsiConfig): IndexDefinition => {
  // Detect old format and give helpful migration error
  if ("index" in config && typeof (config as Record<string, unknown>).index === "object") {
    throw new Error(
      `[EDD-9003] GsiConfig uses old format with "index" property. ` +
        `Migrate to: { name: "gsi1", pk: { field: "gsi1pk", composite: [...] }, sk: { field: "gsi1sk", composite: [...] } }`,
    )
  }
  if (!config.name || !config.pk || !config.sk) {
    throw new Error(
      `[EDD-9003] Invalid GsiConfig: requires name, pk: { field, composite }, sk: { field, composite }`,
    )
  }
  return {
    index: config.name,
    collection: config.collection,
    type: config.type ?? "isolated",
    pk: { field: config.pk.field, composite: [...config.pk.composite] },
    sk: { field: config.sk.field, composite: [...config.sk.composite] },
  }
}

/**
 * Extract composite attribute values from an entity record.
 *
 * Given composite: ["tenantId", "email"] and record: { tenantId: "t-1", email: "a@b.com" }
 * Returns: ["t-1", "a@b.com"]
 */
export const extractComposites = (
  composite: ReadonlyArray<string>,
  record: Record<string, unknown>,
): ReadonlyArray<string> =>
  composite.map((attr) => {
    const value = record[attr]
    if (value === undefined || value === null) {
      throw new Error(`Missing composite attribute "${attr}" in record`)
    }
    return serializeValue(value)
  })

/**
 * Non-throwing variant of extractComposites. Returns undefined when any
 * composite attribute is missing or null. Used for sparse GSI support —
 * if a GSI's composites aren't all present, the index is simply skipped.
 */
export const tryExtractComposites = (
  composite: ReadonlyArray<string>,
  record: Record<string, unknown>,
): ReadonlyArray<string> | undefined => {
  const values: Array<string> = []
  for (const attr of composite) {
    const value = record[attr]
    if (value === undefined || value === null) return undefined
    values.push(serializeValue(value))
  }
  return values
}

/**
 * Serialize a value for use in a composite key.
 *
 * Numeric values are zero-padded for correct lexicographic sort order:
 * - number → 16-digit zero-padded string (covers Number.MAX_SAFE_INTEGER)
 * - bigint → 38-digit zero-padded string (covers DynamoDB's max precision)
 *
 * DateTime values are formatted as ISO strings for correct sort order:
 * - DateTime.Zoned → ISO string with offset (preserves timezone info)
 * - DateTime.Utc → ISO string
 * - Date → ISO string
 */
export const serializeValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value).padStart(16, "0")
  if (typeof value === "bigint") return String(value).padStart(38, "0")
  if (typeof value === "boolean") return value ? "true" : "false"
  // DateTime types → ISO string (Zoned normalized to UTC for sort order)
  if (typeof value === "object" && value !== null && DateTime.isDateTime(value)) {
    return DateTime.formatIso(value)
  }
  // Native Date
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/**
 * Compose a partition key for an entity index.
 *
 * For non-collection indexes: `$schema#v<version>#entityType#attr1#attr2`
 * For collection indexes: `$schema#v<version>#collectionName#attr1#attr2`
 */
export const composePk = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  const composites = extractComposites(index.pk.composite, record)
  const names = [...index.pk.composite]
  const collection = index.collection

  if (collection !== undefined) {
    // Collection index — PK uses collection name
    const collectionName = Array.isArray(collection) ? collection[0]! : collection
    return composeCollectionKey(schema, collectionName, composites, { casing: index.casing, names })
  }

  // Regular entity index — PK uses entity type
  return composeKey(schema, entityType, composites, { casing: index.casing, names })
}

/**
 * Compose a sort key for an entity index.
 *
 * For isolated indexes: `$schema#v<version>#entityType_version#attr1#attr2`
 * For clustered indexes: `$schema#v<version>#collectionName#entityType_version#attr1#attr2`
 * For non-collection indexes: `$schema#v<version>#entityType#attr1#attr2`
 */
export const composeSk = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  const composites = extractComposites(index.sk.composite, record)
  const names = [...index.sk.composite]
  const collection = index.collection
  const collectionType = index.type ?? "isolated"

  if (collection !== undefined) {
    if (collectionType === "clustered") {
      // For sub-collections (collection: ["parent", "child"]) the FULL hierarchy
      // is written into the SK so a begins_with query at any level matches.
      return composeClusteredSortKey(
        schema,
        collection,
        entityType,
        entityVersion,
        composites,
        { casing: index.casing, names },
      )
    }
    // Isolated
    return composeIsolatedSortKey(schema, entityType, entityVersion, composites, {
      casing: index.casing,
      names,
    })
  }

  // Non-collection — simple entity key
  return composeKey(schema, entityType, composites, { casing: index.casing, names })
}

/**
 * Compose all key attributes for a single index.
 * Returns a record mapping field names to composed key values.
 */
export const composeIndexKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Record<string, string> => ({
  [index.pk.field]: composePk(schema, entityType, index, record),
  [index.sk.field]: composeSk(schema, entityType, entityVersion, index, record),
})

/**
 * Non-throwing variant of composeIndexKeys. Returns undefined if any composite
 * attribute is missing. Used for sparse GSI support.
 */
export const tryComposeIndexKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Record<string, string> | undefined => {
  if (tryExtractComposites(index.pk.composite, record) === undefined) return undefined
  if (tryExtractComposites(index.sk.composite, record) === undefined) return undefined
  return composeIndexKeys(schema, entityType, entityVersion, index, record)
}

/**
 * Compose keys for all indexes of an entity.
 * Returns a flat record of all key field -> value mappings.
 */
export const composeAllKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  indexes: Record<string, IndexDefinition>,
  record: Record<string, unknown>,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [indexName, index] of Object.entries(indexes)) {
    if (indexName === "primary") {
      // Primary index always required — throws on missing composites
      Object.assign(result, composeIndexKeys(schema, entityType, entityVersion, index, record))
    } else {
      // GSI — sparse-aware: skip if any composite is missing
      const keys = tryComposeIndexKeys(schema, entityType, entityVersion, index, record)
      if (keys !== undefined) Object.assign(result, keys)
    }
  }
  return result
}

/**
 * Compose GSI keys for indexes whose composites appear in an update payload.
 * For each non-primary index, checks if ANY of its composite attributes are in
 * the update payload. If so, composes the full GSI keys using values merged from
 * keyRecord (primary key composites) and updatePayload.
 *
 * Used by Entity.update to recompose GSI keys when the update touches GSI composites.
 * Callers should filter out indexes whose composites are targeted by REMOVE operations
 * before calling — otherwise `extractComposites` will throw on the missing values.
 */
export const composeGsiKeysForUpdate = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  indexes: Record<string, IndexDefinition>,
  updatePayload: Record<string, unknown>,
  keyRecord: Record<string, unknown>,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [indexName, index] of Object.entries(indexes)) {
    if (indexName === "primary") continue
    const allComposites = [...index.pk.composite, ...index.sk.composite]
    const touchedComposites = allComposites.filter((attr) => attr in updatePayload)
    if (touchedComposites.length > 0) {
      const merged = { ...keyRecord, ...updatePayload }
      const missingComposites = allComposites.filter(
        (attr) => merged[attr] === undefined || merged[attr] === null,
      )
      if (missingComposites.length > 0) {
        throw new PartialGsiCompositeError(
          indexName,
          touchedComposites,
          missingComposites,
          allComposites,
        )
      }
      Object.assign(result, composeIndexKeys(schema, entityType, entityVersion, index, merged))
    }
  }
  return result
}

/**
 * Thrown when an update provides some but not all composite attributes for a GSI.
 * Caught by Entity.update and converted to a tagged `ValidationError`.
 */
export class PartialGsiCompositeError extends Error {
  readonly indexName: string
  readonly provided: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
  readonly required: ReadonlyArray<string>

  constructor(
    indexName: string,
    provided: ReadonlyArray<string>,
    missing: ReadonlyArray<string>,
    required: ReadonlyArray<string>,
  ) {
    super(
      `Partial GSI composite update on index "${indexName}": ` +
        `provided [${provided.join(", ")}] but missing [${missing.join(", ")}]. ` +
        `When updating any composite for a GSI, all composites must be provided: [${required.join(", ")}]`,
    )
    this.name = "PartialGsiCompositeError"
    this.indexName = indexName
    this.provided = provided
    this.missing = missing
    this.required = required
  }
}

/**
 * Compose a partial sort key prefix for query operations.
 * Used when not all SK composite attributes are provided.
 *
 * For example, if SK composite is ["department", "hireDate"] and only "department"
 * is provided, this generates a begins_with prefix.
 */
export const composeSortKeyPrefix = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  // Collect available composites and their names (stop at first missing)
  const available: Array<string> = []
  const names: Array<string> = []
  for (const attr of index.sk.composite) {
    const value = record[attr]
    if (value === undefined || value === null) break
    available.push(serializeValue(value))
    names.push(attr)
  }

  const collection = index.collection
  const collectionType = index.type ?? "isolated"

  if (collection !== undefined) {
    if (collectionType === "clustered") {
      // For sub-collections, pass the full hierarchy so the SK prefix matches
      // the same hierarchy written by composeSk during put.
      return composeClusteredSortKey(schema, collection, entityType, entityVersion, available, {
        casing: index.casing,
        names,
      })
    }
    return composeIsolatedSortKey(schema, entityType, entityVersion, available, {
      casing: index.casing,
      names,
    })
  }

  return composeKey(schema, entityType, available, { casing: index.casing, names })
}
