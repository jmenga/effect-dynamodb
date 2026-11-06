/**
 * DynamoSchema — Application namespace for key prefixing.
 *
 * Every generated DynamoDB key starts with `$<schema>#v<version>#` followed by
 * entity-specific parts. The `$` sentinel identifies ORM-managed keys.
 */

/**
 * Delimiter separating the segments of a composed key
 * (`$schema#v1#entity#a_1#b_2`).
 *
 * Exported so key *consumers* (query prefix bounds, `begins_with` operands)
 * agree with the composer on where one segment ends and the next begins — a
 * `begins_with` that stops mid-segment silently matches sibling values
 * (`status_done` also matching `status_done_archived`).
 */
export const KEY_DELIMITER = "#"

export type Casing = "lowercase" | "uppercase" | "preserve"

export interface DynamoSchema {
  readonly name: string
  readonly version: number
  readonly casing: Casing
  /**
   * `true` composes key text that sorts as its values: numbers in numeric order, and strings
   * escaped. Absent (the default throughout 1.x) composes the key text 1.36 composed. See
   * {@link make}.
   */
  readonly escapeKeys?: boolean | undefined
  /**
   * @internal Numbers in numeric order and strings as they are: the partition keys 1.37.0
   * and 1.38.0 composed. Nothing sets it but `rekey`, which composes that text to find rows there.
   */
  readonly numericKeyText?: true | undefined
}

/**
 * Create a DynamoSchema instance.
 *
 * `escapeKeys` chooses the key text, in every key, partition and sort: table keys, index keys,
 * collections, aggregates, event streams, unique sentinels and vector partitions. It's all or
 * nothing, and a table's rows are written under one setting.
 *
 * - **Off, the default throughout 1.x, is the key text 1.36 composed**, for strings and numbers.
 *   Nothing is needed to upgrade from 1.36 or earlier. Its limitations: a `.where()` or
 *   `.within()` range on a sort key composite before the last can return wrong rows when a value
 *   holds a character below `#` (`new york` sorts below `new#...`), a `#` in a value can imitate
 *   a segment, a skip-scan over free-form strings can hide rows, and a number sorts in numeric
 *   order only when it is a non-negative integer below 1e16 (bigint: 1e38).
 * - **`escapeKeys: true`** escapes each character U+0000-U+0025 of a composite value as `%` and
 *   two hex digits (`KeyComposer.escapeKeyText`) and encodes numbers in numeric order, so a key
 *   sorts as its values and no value can imitate a delimiter. On is the planned default of the
 *   next major.
 *
 * Changing the setting changes the key of every row whose text differs: such rows aren't found
 * by any read until `db.tables.<Table>.rekey()` has moved them to the text the setting composes.
 * Run it before serving traffic.
 */
export const make = (config: {
  readonly name: string
  readonly version: number
  readonly casing?: Casing | undefined
  readonly escapeKeys?: boolean | undefined
}): DynamoSchema => ({
  name: config.name,
  version: config.version,
  casing: config.casing ?? "lowercase",
  ...(config.escapeKeys === true && { escapeKeys: true as const }),
})

/**
 * Apply casing to a key part (structural or composite value).
 *
 * Matches ElectroDB behavior: casing is applied to the entire composed key,
 * including composite attribute values. With the default `"lowercase"` casing,
 * `"Male"` becomes `"male"` in the key, ensuring case-insensitive key matching.
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
 * Format composite values with optional field name prefixes.
 * With names: `fieldname_value1#fieldname_value2`
 * Without names: `value1#value2`
 */
const formatComposites = (
  composites: ReadonlyArray<string>,
  casing: Casing,
  names?: ReadonlyArray<string> | undefined,
): string => formatCompositeParts(composites, casing, names).join("#")

/** Format composite values as individual parts (for use in array spreading). */
const formatCompositeParts = (
  composites: ReadonlyArray<string>,
  casing: Casing,
  names?: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> =>
  composites.map((v, i) => {
    const casedValue = applyCasing(v, casing)
    const name = names?.[i]
    return name ? `${applyCasing(name, casing)}_${casedValue}` : casedValue
  })

/**
 * Build the schema prefix: `$<schema>#v<version>`
 * This is prepended to every generated key.
 */
export const prefix = (schema: DynamoSchema): string => {
  const name = applyCasing(schema.name, schema.casing)
  return `$${name}#v${schema.version}`
}

/**
 * @internal Resolve casing and build the common key prefix parts.
 */
const resolveKeyPrefix = (
  schema: DynamoSchema,
  label: string,
  options?: { readonly casing?: Casing | undefined } | undefined,
): { readonly casing: Casing; readonly pre: string; readonly label: string } => {
  const casing = options?.casing ?? schema.casing
  return { casing, pre: prefix(schema), label: applyCasing(label, casing) }
}

/**
 * Compose a full key from schema, entity type, and composite attribute values.
 *
 * Format: `$<schema>#v<version>#<entityType>#<attr1>#<attr2>`
 *
 * Both the entityType and composite values are cased according to the schema's casing setting.
 * This matches ElectroDB behavior where the entire key is uniformly cased.
 */
export const composeKey = (
  schema: DynamoSchema,
  entityType: string,
  composites: ReadonlyArray<string>,
  options?:
    | { readonly casing?: Casing | undefined; readonly names?: ReadonlyArray<string> | undefined }
    | undefined,
): string => {
  const {
    casing: effectiveCasing,
    pre,
    label: type,
  } = resolveKeyPrefix(schema, entityType, options)

  if (composites.length === 0) {
    return `${pre}#${type}`
  }
  const formatted = formatComposites(composites, effectiveCasing, options?.names)
  return `${pre}#${type}#${formatted}`
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
  options?:
    | { readonly casing?: Casing | undefined; readonly names?: ReadonlyArray<string> | undefined }
    | undefined,
): string => {
  const {
    casing: effectiveCasing,
    pre,
    label: collection,
  } = resolveKeyPrefix(schema, collectionName, options)

  if (composites.length === 0) {
    return `${pre}#${collection}`
  }
  const formatted = formatComposites(composites, effectiveCasing, options?.names)
  return `${pre}#${collection}#${formatted}`
}

/**
 * Compose a sort key for clustered collection indexes.
 *
 * Format (single collection):
 *   `$<schema>#v<version>#<collectionName>#<entityType>_<entityVersion>#<attr1>#<attr2>`
 *
 * Format (sub-collection — when `collectionName` is an array):
 *   `$<schema>#v<version>#<parent>#<child>#<entityType>_<entityVersion>#<attr1>#<attr2>`
 *
 * The hierarchy elements are joined with `#` so a `begins_with` query at any level
 * matches every entity in that subtree.
 *
 * The entityVersion is the schema version for the entity type within the collection.
 * This allows different entity types in a collection to have their own sort key namespace.
 */
export const composeClusteredSortKey = (
  schema: DynamoSchema,
  collectionName: string | ReadonlyArray<string>,
  entityType: string,
  entityVersion: number,
  composites: ReadonlyArray<string>,
  options?:
    | { readonly casing?: Casing | undefined; readonly names?: ReadonlyArray<string> | undefined }
    | undefined,
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = prefix(schema)
  const namesArray = Array.isArray(collectionName) ? collectionName : [collectionName]
  const collectionParts = namesArray.map((n) => applyCasing(n, effectiveCasing))
  const type = applyCasing(entityType, effectiveCasing)
  const entityPrefix = `${type}_${entityVersion}`

  const formattedComposites = formatCompositeParts(composites, effectiveCasing, options?.names)
  const parts = [pre, ...collectionParts, entityPrefix, ...formattedComposites].filter(
    (p) => p.length > 0,
  )
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
  options?:
    | { readonly casing?: Casing | undefined; readonly names?: ReadonlyArray<string> | undefined }
    | undefined,
): string => {
  const {
    casing: effectiveCasing,
    pre,
    label: type,
  } = resolveKeyPrefix(schema, entityType, options)
  const entityPrefix = `${type}_${entityVersion}`

  const formattedComposites = formatCompositeParts(composites, effectiveCasing, options?.names)
  const parts = [pre, entityPrefix, ...formattedComposites].filter((p) => p.length > 0)
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
  const {
    casing: effectiveCasing,
    pre,
    label: type,
  } = resolveKeyPrefix(schema, entityType, options)
  const casedConstraintName = applyCasing(constraintName, effectiveCasing)
  const constraint = `${type}.${casedConstraintName}`

  return {
    pk: `${pre}#${constraint}#${fieldValues.map((v) => applyCasing(v, effectiveCasing)).join("#")}`,
    sk: `${pre}#${constraint}`,
  }
}

/**
 * Options of the history keys (version snapshots and soft-delete tombstones).
 *
 * `item` — the item's identity within its partition, for an entity whose
 * primary sort key has composites (several items per partition): the
 * composite part of its sort key (see `KeyComposer.composeHistoryItemSegment`).
 * Inserted after the history marker, so each item has its own history; an
 * entity without sort key composites passes none, and its keys are exactly
 * the partition-wide ones.
 */
export interface HistoryKeyOptions {
  readonly casing?: Casing | undefined
  readonly item?: string | undefined
}

const itemPart = (options: HistoryKeyOptions | undefined): string =>
  options?.item === undefined || options.item === "" ? "" : `${options.item}#`

/**
 * Compose a version snapshot sort key.
 *
 * Format: `$<schema>#v<version>#<entityType>#v#[<item>#]<zeroPaddedVersion>`
 */
export const composeVersionKey = (
  schema: DynamoSchema,
  entityType: string,
  version: number,
  options?: HistoryKeyOptions | undefined,
): string =>
  `${composeVersionKeyPrefix(schema, entityType, options)}${String(version).padStart(7, "0")}`

/**
 * Compose a soft-deleted item sort key.
 *
 * Format: `$<schema>#v<version>#<entityType>#deleted#[<item>#]<isoTimestamp>`
 */
export const composeDeletedKey = (
  schema: DynamoSchema,
  entityType: string,
  timestamp: string,
  options?: HistoryKeyOptions | undefined,
): string => `${composeDeletedKeyPrefix(schema, entityType, options)}${timestamp}`

/**
 * Compose the version key prefix for `begins_with` queries — of one item's
 * history with `item`, of the partition's without.
 *
 * Format: `$<schema>#v<version>#<entityType>#v#[<item>#]`
 */
export const composeVersionKeyPrefix = (
  schema: DynamoSchema,
  entityType: string,
  options?: HistoryKeyOptions | undefined,
): string => {
  const { pre, label: type } = resolveKeyPrefix(schema, entityType, options)
  return `${pre}#${type}#v#${itemPart(options)}`
}

/**
 * Compose the deleted key prefix for `begins_with` queries — of one item's
 * tombstones with `item`, of the partition's without.
 *
 * Format: `$<schema>#v<version>#<entityType>#deleted#[<item>#]`
 */
export const composeDeletedKeyPrefix = (
  schema: DynamoSchema,
  entityType: string,
  options?: HistoryKeyOptions | undefined,
): string => {
  const { pre, label: type } = resolveKeyPrefix(schema, entityType, options)
  return `${pre}#${type}#deleted#${itemPart(options)}`
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
  const { pre, label: type } = resolveKeyPrefix(schema, entityType, options)
  return `${pre}#${type}_1#${String(version).padStart(10, "0")}`
}

/**
 * The maximum event version representable by {@link composeEventVersionKey}'s
 * 10-digit zero-padded encoding. Used as the inclusive upper bound of event
 * sort-key ranges.
 */
export const MAX_EVENT_VERSION = 9_999_999_999

/**
 * Compose the event version key prefix for `begins_with` queries.
 *
 * Format: `$<schema>#v<version>#<entityType>_1#`
 *
 * Every event sort key produced by {@link composeEventVersionKey} begins with
 * this prefix, and no other key shape in the partition does — so it bounds an
 * event query to event items at the key-condition level rather than relying on
 * the `__edd_e__` FilterExpression alone (which DynamoDB applies *after*
 * `Limit`).
 */
export const composeEventVersionKeyPrefix = (
  schema: DynamoSchema,
  entityType: string,
  options?: { readonly casing?: Casing | undefined } | undefined,
): string => {
  const { pre, label: type } = resolveKeyPrefix(schema, entityType, options)
  return `${pre}#${type}_1#`
}
