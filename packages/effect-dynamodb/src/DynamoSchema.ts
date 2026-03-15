/**
 * DynamoSchema — Application namespace for key prefixing.
 *
 * Every generated DynamoDB key starts with `$<schema>#v<version>#` followed by
 * entity-specific parts. The `$` sentinel identifies ORM-managed keys.
 */

export type Casing = "lowercase" | "uppercase" | "preserve"

export interface DynamoSchema {
  readonly name: string
  readonly version: number
  readonly casing: Casing
}

/**
 * Create a DynamoSchema instance.
 */
export const make = (config: {
  readonly name: string
  readonly version: number
  readonly casing?: Casing | undefined
}): DynamoSchema => ({
  name: config.name,
  version: config.version,
  casing: config.casing ?? "lowercase",
})

/**
 * Apply casing to a structural key part.
 * Attribute values are NEVER cased — only structural parts (schema name, version prefix, entity type, collection name).
 */
export const applyCasing = (value: string, casing: Casing): string => {
  switch (casing) {
    case "lowercase":
      return value.toLowerCase()
    case "uppercase":
      return value.toUpperCase()
    case "preserve":
      return value
  }
}

/**
 * Build the schema prefix: `$<schema>#v<version>`
 * This is prepended to every generated key.
 */
export const prefix = (schema: DynamoSchema): string => {
  const name = applyCasing(schema.name, schema.casing)
  return `$${name}#v${schema.version}`
}

/**
 * Compose a full key from schema, entity type, and composite attribute values.
 *
 * Format: `$<schema>#v<version>#<entityType>#<attr1>#<attr2>`
 *
 * The entityType is cased according to the schema's casing setting.
 * Attribute values are ALWAYS preserved as-is.
 */
export const composeKey = (
  schema: DynamoSchema,
  entityType: string,
  composites: ReadonlyArray<string>,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const type = applyCasing(entityType, effectiveCasing)

  if (composites.length === 0) {
    return `${pre}#${type}`
  }
  return `${pre}#${type}#${composites.join("#")}`
}

/**
 * Compose a collection key prefix (for clustered collections).
 *
 * Format: `$<schema>#v<version>#<collectionName>#<attr1>#<attr2>`
 */
export const composeCollectionKey = (
  schema: DynamoSchema,
  collectionName: string,
  composites: ReadonlyArray<string>,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const collection = applyCasing(collectionName, effectiveCasing)

  if (composites.length === 0) {
    return `${pre}#${collection}`
  }
  return `${pre}#${collection}#${composites.join("#")}`
}

/**
 * Compose a sort key for clustered collection indexes.
 *
 * Format: `$<schema>#v<version>#<collectionName>#<entityType>_<entityVersion>#<attr1>#<attr2>`
 *
 * The entityVersion is the schema version for the entity type within the collection.
 * This allows different entity types in a collection to have their own sort key namespace.
 */
export const composeClusteredSortKey = (
  schema: DynamoSchema,
  collectionName: string,
  entityType: string,
  entityVersion: number,
  composites: ReadonlyArray<string>,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const collection = applyCasing(collectionName, effectiveCasing)
  const type = applyCasing(entityType, effectiveCasing)
  const entityPrefix = `${type}_${entityVersion}`

  const parts = [pre, collection, entityPrefix, ...composites].filter((p) => p.length > 0)
  return parts.join("#")
}

/**
 * Compose a sort key for isolated indexes.
 *
 * Format: `$<schema>#v<version>#<entityType>_<entityVersion>#<attr1>#<attr2>`
 */
export const composeIsolatedSortKey = (
  schema: DynamoSchema,
  entityType: string,
  entityVersion: number,
  composites: ReadonlyArray<string>,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  const entityPrefix = `${type}_${entityVersion}`

  const parts = [pre, entityPrefix, ...composites].filter((p) => p.length > 0)
  return parts.join("#")
}

/**
 * Compose a unique constraint sentinel key.
 *
 * PK format: `$<schema>#v<version>#<entityType>.<constraintName>#<fieldValues>`
 * SK format: `$<schema>#v<version>#<entityType>.<constraintName>`
 */
export const composeUniqueKey = (
  schema: DynamoSchema,
  entityType: string,
  constraintName: string,
  fieldValues: ReadonlyArray<string>,
  options?: { readonly casing?: Casing | undefined } | undefined,
): { readonly pk: string; readonly sk: string } => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  const casedConstraintName = applyCasing(constraintName, effectiveCasing)
  const constraint = `${type}.${casedConstraintName}`

  return {
    pk: `${pre}#${constraint}#${fieldValues.join("#")}`,
    sk: `${pre}#${constraint}`,
  }
}

/**
 * Compose a version snapshot sort key.
 *
 * Format: `$<schema>#v<version>#<entityType>#v#<zeroPaddedVersion>`
 */
export const composeVersionKey = (
  schema: DynamoSchema,
  entityType: string,
  version: number,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  return `${pre}#${type}#v#${String(version).padStart(7, "0")}`
}

/**
 * Compose a soft-deleted item sort key.
 *
 * Format: `$<schema>#v<version>#<entityType>#deleted#<isoTimestamp>`
 */
export const composeDeletedKey = (
  schema: DynamoSchema,
  entityType: string,
  timestamp: string,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  return `${pre}#${type}#deleted#${timestamp}`
}

/**
 * Compose the version key prefix for `begins_with` queries.
 *
 * Format: `$<schema>#v<version>#<entityType>#v#`
 */
export const composeVersionKeyPrefix = (
  schema: DynamoSchema,
  entityType: string,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  return `${pre}#${type}#v#`
}

/**
 * Compose the deleted key prefix for `begins_with` queries.
 *
 * Format: `$<schema>#v<version>#<entityType>#deleted#`
 */
export const composeDeletedKeyPrefix = (
  schema: DynamoSchema,
  entityType: string,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  return `${pre}#${type}#deleted#`
}

/**
 * Compose an event version sort key (10-digit zero-padded).
 *
 * Format: `$<schema>#v<version>#<entityType>_1#<zeroPaddedVersion>`
 *
 * Uses isolated sort key format with 10-digit padding (supports ~10B events per stream).
 */
export const composeEventVersionKey = (
  schema: DynamoSchema,
  entityType: string,
  version: number,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  return `${pre}#${type}_1#${String(version).padStart(10, "0")}`
}
