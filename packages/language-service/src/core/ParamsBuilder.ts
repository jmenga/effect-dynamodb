import {
  type Casing,
  type IndexDefinition,
  type IndexShards,
  isZOrderHalf,
  type ResolvedCollection,
  type ResolvedEntity,
  type SchemaConfig,
} from "./EntityResolver"
import type { DetectedOperation, UpdateCombinators, WhereCondition } from "./OperationDetector"

export interface DynamoDBParams {
  readonly command: string
  readonly TableName: string
  readonly Key?: Record<string, string> | undefined
  readonly Item?: Record<string, string> | undefined
  readonly IndexName?: string | undefined
  readonly KeyConditionExpression?: string | undefined
  readonly FilterExpression?: string | undefined
  readonly ConditionExpression?: string | undefined
  readonly UpdateExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
  readonly ExpressionAttributeValues?: Record<string, string> | undefined
  readonly entityType: string
  // v2 fields
  readonly info?: string | undefined
}

export function buildParams(op: DetectedOperation): DynamoDBParams | undefined {
  const { entity, type } = op

  switch (type) {
    case "get":
      return entity ? buildGetParams(entity, op.arguments) : undefined
    case "put":
      return entity ? buildPutParams(entity, op.arguments) : undefined
    case "create":
      return entity ? buildCreateParams(entity, op.arguments) : undefined
    case "update":
      return entity ? buildUpdateParams(entity, op.arguments, op.updateCombinators) : undefined
    case "delete":
      return entity ? buildDeleteParams(entity, op.arguments) : undefined
    case "query":
      return entity ? buildQueryParams(entity, op.indexName, op.arguments) : undefined
    case "scan":
      return entity ? buildScanParams(entity) : undefined
    case "entity-query-accessor":
      return op.collection
        ? buildEntityAccessorParams(op.entity, op.collection, op.collectionName, op.arguments)
        : buildEntityIndexAccessorParams(op.entity, op.indexName, op.arguments, op.whereCondition)
    case "collection-accessor":
      return buildCollectionAccessorParams(op.collection, op.collectionName, op.arguments)
    case "bound-query-terminal":
      return buildBoundQueryTerminalParams(op)
    case "table-accessor":
      return buildTableAccessorParams(op.tableName)
  }
}

function buildGetParams(
  entity: ResolvedEntity,
  args: Record<string, unknown> | undefined,
): DynamoDBParams {
  const primaryIndex = entity.indexes.primary!
  const key = composePrimaryKey(entity, primaryIndex, args)

  return {
    command: "GetItemCommand",
    TableName: "{TableName}",
    Key: key,
    entityType: entity.entityType,
  }
}

function buildPutParams(
  entity: ResolvedEntity,
  args: Record<string, unknown> | undefined,
): DynamoDBParams {
  const item = buildItemFields(entity, args)
  const hasUnique = entity.unique !== undefined

  return {
    command: hasUnique ? "TransactWriteItemsCommand" : "PutItemCommand",
    TableName: "{TableName}",
    Item: item,
    entityType: entity.entityType,
  }
}

function buildCreateParams(
  entity: ResolvedEntity,
  args: Record<string, unknown> | undefined,
): DynamoDBParams {
  const item = buildItemFields(entity, args)
  const hasUnique = entity.unique !== undefined
  const names: Record<string, string> = {}
  const primaryIndex = entity.indexes.primary!

  names["#pk"] = primaryIndex.pk.field
  let condition = "attribute_not_exists(#pk)"
  if (primaryIndex.sk.field) {
    names["#sk"] = primaryIndex.sk.field
    condition += " AND attribute_not_exists(#sk)"
  }

  return {
    command: hasUnique ? "TransactWriteItemsCommand" : "PutItemCommand",
    TableName: "{TableName}",
    Item: item,
    ConditionExpression: condition,
    ExpressionAttributeNames: names,
    entityType: entity.entityType,
  }
}

function buildUpdateParams(
  entity: ResolvedEntity,
  args: Record<string, unknown> | undefined,
  combinators: UpdateCombinators | undefined,
): DynamoDBParams {
  const primaryIndex = entity.indexes.primary!
  const key = composePrimaryKey(entity, primaryIndex, args)
  const expr = buildUpdateExpression(entity, combinators)

  return {
    command: "UpdateItemCommand",
    TableName: "{TableName}",
    Key: key,
    UpdateExpression: expr.expression ?? undefined,
    ConditionExpression: expr.condition ?? undefined,
    ExpressionAttributeNames: Object.keys(expr.names).length > 0 ? expr.names : undefined,
    ExpressionAttributeValues: Object.keys(expr.values).length > 0 ? expr.values : undefined,
    entityType: entity.entityType,
  }
}

function buildDeleteParams(
  entity: ResolvedEntity,
  args: Record<string, unknown> | undefined,
): DynamoDBParams {
  const primaryIndex = entity.indexes.primary!
  const key = composePrimaryKey(entity, primaryIndex, args)
  const isSoftDelete = entity.softDelete !== false

  return {
    command: isSoftDelete ? "TransactWriteItemsCommand" : "DeleteItemCommand",
    TableName: "{TableName}",
    Key: key,
    entityType: entity.entityType,
  }
}

function buildQueryParams(
  entity: ResolvedEntity,
  indexName: string | undefined,
  args: Record<string, unknown> | undefined,
): DynamoDBParams {
  const resolvedIndex = indexName ? entity.indexes[indexName] : entity.indexes.primary
  const index = resolvedIndex ?? entity.indexes.primary!

  const names: Record<string, string> = {}
  const values: Record<string, string> = {}

  const pkValue = composePkValue(entity.schema, entity.entityType, index, args)
  const skPrefix = composeSkBeginsWithValue(entity.schema, entity.entityType, index, args)

  names["#pk"] = index.pk.field
  values[":pk"] = pkValue
  let keyCondition = "#pk = :pk"

  // Mirrors `KeyComposer.composeSortKeyCondition`: a complete key is an exact
  // `=` — `begins_with` on it would also match longer values (`seq: 3`
  // matching 3.14) — and a partial prefix selects its subtree.
  const pinned = isZOrderHalf(index.sk) ? 0 : availableSkSlots(entity.schema, index, args).length
  const accessor =
    pinned > 0 && args
      ? accessorSkCondition(entity.schema, entity.entityType, index, args)
      : undefined
  if (accessor) {
    names["#sk"] = accessor.name
    Object.assign(values, accessor.values)
    keyCondition += accessor.keyCondition
  } else if (skPrefix) {
    names["#sk"] = index.sk.field
    values[":skPrefix"] = skPrefix
    keyCondition += " AND begins_with(#sk, :skPrefix)"
  }

  names["#et"] = "__edd_e__"
  values[":et0"] = entity.entityType

  return {
    command: "QueryCommand",
    TableName: "{TableName}",
    IndexName: index.index ?? undefined,
    KeyConditionExpression: keyCondition,
    FilterExpression: "#et IN (:et0)",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    entityType: entity.entityType,
  }
}

function buildScanParams(entity: ResolvedEntity): DynamoDBParams {
  return {
    command: "ScanCommand",
    TableName: "{TableName}",
    FilterExpression: "#et IN (:et0)",
    ExpressionAttributeNames: { "#et": "__edd_e__" },
    ExpressionAttributeValues: { ":et0": entity.entityType },
    entityType: entity.entityType,
  }
}

// --- Item builder (for put/create) ---

function buildItemFields(
  entity: ResolvedEntity,
  args: Record<string, unknown> | undefined,
): Record<string, string> {
  const item: Record<string, string> = {}

  // Compose key fields for all indexes
  for (const [indexName, index] of Object.entries(entity.indexes)) {
    if (indexName.startsWith("_cascade_")) continue
    item[index.pk.field] = composePkValue(entity.schema, entity.entityType, index, args)
    item[index.sk.field] = composeSkValue(entity.schema, entity.entityType, index, args)
  }

  // Entity type discriminator
  item.__edd_e__ = entity.entityType

  // System fields
  if (entity.timestamps) {
    item.createdAt = "{now}"
    item.updatedAt = "{now}"
  }
  if (entity.versioned) {
    item.__edd_v__ = "1"
  }

  return item
}

// --- Update expression builder ---

interface UpdateExprResult {
  expression: string | undefined
  condition: string | undefined
  names: Record<string, string>
  values: Record<string, string>
}

function buildUpdateExpression(
  entity: ResolvedEntity,
  combinators: UpdateCombinators | undefined,
): UpdateExprResult {
  const names: Record<string, string> = {}
  const values: Record<string, string> = {}
  const setParts: Array<string> = []
  const removeParts: Array<string> = []
  const addParts: Array<string> = []

  // User-provided SET fields
  if (combinators?.set) {
    for (const [k, v] of Object.entries(combinators.set)) {
      names[`#${k}`] = k
      values[`:${k}`] = v !== undefined ? String(v) : `{${k}}`
      setParts.push(`#${k} = :${k}`)
    }
  }

  // Auto SET fields
  if (entity.timestamps) {
    names["#updatedAt"] = "updatedAt"
    values[":updatedAt"] = "{now}"
    setParts.push("#updatedAt = :updatedAt")
  }
  if (entity.versioned) {
    names["#__edd_v__"] = "__edd_v__"
    values[":one"] = "1"
    setParts.push("#__edd_v__ = #__edd_v__ + :one")
  }

  // REMOVE fields
  if (combinators?.remove) {
    for (const f of combinators.remove) {
      names[`#${f}`] = f
      removeParts.push(`#${f}`)
    }
  }

  // ADD fields (atomic increment)
  if (combinators?.add) {
    for (const [k, v] of Object.entries(combinators.add)) {
      names[`#${k}`] = k
      values[`:${k}`] = String(v)
      addParts.push(`#${k} :${k}`)
    }
  }

  // Build expression string
  const exprParts: Array<string> = []
  if (setParts.length > 0) exprParts.push(`SET ${setParts.join(", ")}`)
  if (removeParts.length > 0) exprParts.push(`REMOVE ${removeParts.join(", ")}`)
  if (addParts.length > 0) exprParts.push(`ADD ${addParts.join(", ")}`)

  // Condition (optimistic locking)
  let condition: string | undefined
  if (combinators?.expectedVersion !== undefined) {
    names["#__edd_v__"] = "__edd_v__"
    values[":expectedVersion"] = String(combinators.expectedVersion)
    condition = "#__edd_v__ = :expectedVersion"
  }

  return {
    expression: exprParts.length > 0 ? exprParts.join(" ") : undefined,
    condition,
    names,
    values,
  }
}

// --- Key composition (mirrors DynamoSchema + KeyComposer) ---
//
// This package is CommonJS and cannot load the ESM-only `@effect-dynamodb/schema`,
// so key composition is mirrored here. `test/KeyParity.test.ts` checks it against
// the library on every run — change both together.

/**
 * One composite slot. `placeholder` marks a value only known at runtime, shown
 * as `{attr}` and left uncased so it still names the attribute.
 */
interface CompositeSlot {
  readonly name: string
  readonly value: string
  readonly placeholder: boolean
}

function applyCasing(value: string, casing: Casing): string {
  switch (casing) {
    case "lowercase":
      return value.toLowerCase()
    case "uppercase":
      return value.toUpperCase()
    case "preserve":
      return value
  }
}

function schemaPrefix(schema: SchemaConfig): string {
  return `$${applyCasing(schema.name, schema.casing)}#v${schema.version}`
}

/**
 * Mirrors `KeyComposer.compositeText` for the values a source literal can hold: numbers zero-padded
 * as they have always been, or in numeric order with `escapeKeys: true`.
 */
function serializeValue(schema: SchemaConfig, value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number") {
    return schema.escapeKeys === true ? encodeNumber(value) : String(value).padStart(16, "0")
  }
  if (typeof value === "bigint") {
    return schema.escapeKeys === true ? encodeBigInt(value) : String(value).padStart(38, "0")
  }
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

// With `escapeKeys: true`, mirrors `@effect-dynamodb/schema/internal/NumericKey.ts`, which documents
// the format: numeric key text that sorts in numeric order, keeping the zero-padded
// text of a non-negative integer below the pad width. A hover never throws, so
// what the library refuses (`NaN`, a bigint past 1,000 digits) is shown as is.

/** `x = 0.<digits> × 10^point` for the shortest round-trip decimal of positive `x`. */
function decimalOf(x: number): { readonly digits: string; readonly point: number } {
  const [mantissa = "", exponent = "0"] = String(x).split("e")
  const [int = "", frac = ""] = mantissa.split(".")
  const all = `${int}${frac}`
  const significant = all.replace(/^0+/, "")
  return {
    digits: significant.replace(/0+$/, ""),
    point: int.length + Number(exponent) - (all.length - significant.length),
  }
}

function magnitude(digits: string, point: number, width: number): string {
  if (point > width) return `:${String(point - 1).padStart(3, "0")}${digits}`
  const int = point <= 0 ? "" : digits.slice(0, point).padEnd(point, "0")
  const frac = `${"0".repeat(Math.max(0, -point))}${digits.slice(Math.max(0, point))}`
  return `${int.padStart(width, "0")}${frac === "" ? "" : `.${frac}`}`
}

function negate(text: string): string {
  const complement = (t: string) => t.replace(/[0-9]/g, (digit) => String(9 - Number(digit)))
  return text.startsWith(":") ? `-*${complement(text.slice(1))}:` : `-${complement(text)}:`
}

function encodeNumber(n: number): string {
  if (Number.isNaN(n)) return String(n)
  if (n === Number.POSITIVE_INFINITY) return ";"
  if (n === Number.NEGATIVE_INFINITY) return "-)"
  if (n === 0) return "0".repeat(16)
  const { digits, point } = decimalOf(Math.abs(n))
  const text = magnitude(digits, point, 16)
  return n < 0 ? negate(text) : text
}

function encodeBigInt(n: bigint): string {
  if (n === 0n) return "0".repeat(38)
  const abs = (n < 0n ? -n : n).toString()
  if (abs.length > 1000) return String(n)
  const text = magnitude(abs.replace(/0+$/, ""), abs.length, 38)
  return n < 0n ? negate(text) : text
}

function formatComposites(
  slots: ReadonlyArray<CompositeSlot>,
  casing: Casing,
): ReadonlyArray<string> {
  return slots.map(
    (slot) =>
      `${applyCasing(slot.name, casing)}_${slot.placeholder ? slot.value : applyCasing(slot.value, casing)}`,
  )
}

function composeKey(
  schema: SchemaConfig,
  label: string,
  slots: ReadonlyArray<CompositeSlot>,
  casing?: Casing,
  marker?: string,
): string {
  const effectiveCasing = casing ?? schema.casing
  return [
    schemaPrefix(schema),
    applyCasing(label, effectiveCasing),
    ...(marker === undefined ? [] : [marker]),
    ...formatComposites(slots, effectiveCasing),
  ].join("#")
}

function composeClusteredSortKey(
  schema: SchemaConfig,
  collection: string | ReadonlyArray<string>,
  entityType: string,
  entityVersion: number,
  slots: ReadonlyArray<CompositeSlot>,
  casing?: Casing,
): string {
  const effectiveCasing = casing ?? schema.casing
  const hierarchy = typeof collection === "string" ? [collection] : collection
  return [
    schemaPrefix(schema),
    ...hierarchy.map((name) => applyCasing(name, effectiveCasing)),
    `${applyCasing(entityType, effectiveCasing)}_${entityVersion}`,
    ...formatComposites(slots, effectiveCasing),
  ]
    .filter((part) => part.length > 0)
    .join("#")
}

function composeIsolatedSortKey(
  schema: SchemaConfig,
  entityType: string,
  entityVersion: number,
  slots: ReadonlyArray<CompositeSlot>,
  casing?: Casing,
): string {
  const effectiveCasing = casing ?? schema.casing
  return [
    schemaPrefix(schema),
    `${applyCasing(entityType, effectiveCasing)}_${entityVersion}`,
    ...formatComposites(slots, effectiveCasing),
  ].join("#")
}

/**
 * Mirrors `KeyComposer.keyText`: a key composite's text cased and, with
 * `escapeKeys: true`, each code point U+0000–U+0025 escaped as `%` and two hex
 * digits (lower case under `"lowercase"` casing).
 */
function keyText(schema: SchemaConfig, text: string, casing: Casing): string {
  if (schema.escapeKeys !== true) return applyCasing(text, casing)
  let escaped = ""
  for (const char of applyCasing(text, casing)) {
    const code = char.charCodeAt(0)
    if (code > 0x25) {
      escaped += char
      continue
    }
    const hex = code.toString(16).padStart(2, "0")
    escaped += `%${casing === "lowercase" ? hex : hex.toUpperCase()}`
  }
  return escaped
}

function composeSkFromSlots(
  schema: SchemaConfig,
  entityType: string,
  index: IndexDefinition,
  given: ReadonlyArray<CompositeSlot>,
): string {
  const entityVersion = 1
  const casing = index.casing ?? schema.casing
  const slots = given.map((slot) =>
    slot.placeholder ? slot : { ...slot, value: keyText(schema, slot.value, casing) },
  )
  if (index.collection !== undefined) {
    if ((index.type ?? "isolated") === "clustered") {
      return composeClusteredSortKey(
        schema,
        index.collection,
        entityType,
        entityVersion,
        slots,
        index.casing,
      )
    }
    return composeIsolatedSortKey(schema, entityType, entityVersion, slots, index.casing)
  }
  return composeKey(schema, entityType, slots, index.casing)
}

function composePkValue(
  schema: SchemaConfig,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown> | undefined,
): string {
  const casing = index.casing ?? schema.casing
  const slots = extractCompositeSlots(schema, index.pk.composite, record).map((slot) =>
    slot.placeholder ? slot : { ...slot, value: keyText(schema, slot.value, casing) },
  )
  const collection = index.collection
  const marker = index.shards === undefined ? undefined : shardMarkerText(index.shards)
  if (collection !== undefined) {
    const collectionName = typeof collection === "string" ? collection : collection[0]!
    return composeKey(schema, collectionName, slots, index.casing, marker)
  }
  return composeKey(schema, entityType, slots, index.casing, marker)
}

/** What a sharded partition key's shard shows: a hover has no item to hash (#183). */
export const SHARD_PLACEHOLDER = "{shard}"

/** Mirrors `Shards.shardMarker`, with the shard as a placeholder. No casing reaches it. */
const shardMarkerText = (shards: IndexShards): string =>
  `!${shards.count ?? "{count}"}.${SHARD_PLACEHOLDER}`

/** A hover's line about a sharded index. */
const shardsInfo = (shards: IndexShards): string =>
  `  Shards: ${shards.count ?? "{count}"}${
    shards.by.length > 0
      ? ` by ${shards.by.join(", ")} (one shard when all are given, else all merged)`
      : " (every shard read, merged)"
  }${shards.previous === undefined ? "" : `; also reads previous layout of ${shards.previous}`}`

/** What a Z-order sort key (#171) shows: its value is bytes, not text. */
export const ZORDER_KEY_PLACEHOLDER = "<binary Z-order key>"

function composeSkValue(
  schema: SchemaConfig,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown> | undefined,
): string {
  if (isZOrderHalf(index.sk)) return ZORDER_KEY_PLACEHOLDER
  return composeSkFromSlots(
    schema,
    entityType,
    index,
    extractCompositeSlots(schema, index.sk.composite, record),
  )
}

/** Leading SK composites present in `record`, stopping at the first missing one. */
function availableSkSlots(
  schema: SchemaConfig,
  index: IndexDefinition,
  record: Record<string, unknown> | undefined,
): ReadonlyArray<CompositeSlot> {
  const slots: Array<CompositeSlot> = []
  for (const attr of index.sk.composite) {
    const value = record?.[attr]
    if (value === undefined || value === null) break
    slots.push({ name: attr, value: serializeValue(schema, value), placeholder: false })
  }
  return slots
}

/** Mirrors `KeyComposer.composeSortKeyPrefix` — the raw value, no trailing delimiter. */
function composeSkPrefixValue(
  schema: SchemaConfig,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown> | undefined,
): string {
  // A Z-order sort key has no text prefix.
  if (isZOrderHalf(index.sk)) return ""
  return composeSkFromSlots(schema, entityType, index, availableSkSlots(schema, index, record))
}

/**
 * Mirrors `KeyComposer.composeSortKeyBeginsWith` — the prefix plus a trailing
 * delimiter iff SK composites remain, so `status_done` cannot match
 * `status_done_archived`.
 */
function composeSkBeginsWithValue(
  schema: SchemaConfig,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown> | undefined,
): string {
  // A Z-order sort key has no text prefix.
  if (isZOrderHalf(index.sk)) return ""
  const slots = availableSkSlots(schema, index, record)
  const prefix = composeSkFromSlots(schema, entityType, index, slots)
  return slots.length === index.sk.composite.length ? prefix : `${prefix}#`
}

/**
 * The sort key condition an accessor sends for the composites it is given —
 * mirrors the library's accessor (`KeyComposer.composeSortKeyCondition`): none
 * when no composite is given (or the key is Z-order), `=` on the complete key
 * when every one is, on a leading prefix a terminated `begins_with` — or, with
 * `escapeKeys: true` on a secondary index, whose rows can be truncated there, a
 * `BETWEEN` of the prefix and all below it.
 */
function accessorSkCondition(
  schema: SchemaConfig,
  entityType: string,
  index: IndexDefinition,
  args: Record<string, unknown>,
):
  | {
      readonly keyCondition: string
      readonly name: string
      readonly values: Readonly<Record<string, string>>
    }
  | undefined {
  if (isZOrderHalf(index.sk)) return undefined
  if (!index.sk.composite.some((attr) => args[attr] !== undefined)) return undefined
  return index.sk.composite.every((attr) => args[attr] !== undefined)
    ? {
        keyCondition: " AND #sk = :sk",
        name: index.sk.field,
        values: { ":sk": composeSkValue(schema, entityType, index, args) },
      }
    : index.index === undefined || schema.escapeKeys !== true
      ? {
          keyCondition: " AND begins_with(#sk, :skPrefix)",
          name: index.sk.field,
          values: { ":skPrefix": composeSkBeginsWithValue(schema, entityType, index, args) },
        }
      : {
          keyCondition: " AND #sk BETWEEN :skLow AND :skHigh",
          name: index.sk.field,
          values: {
            ":skLow": composeSkPrefixValue(schema, entityType, index, args),
            ":skHigh": `${composeSkBeginsWithValue(schema, entityType, index, args)}\uFFFF`,
          },
        }
}

function composePrimaryKey(
  entity: ResolvedEntity,
  index: IndexDefinition,
  args: Record<string, unknown> | undefined,
): Record<string, string> {
  return {
    [index.pk.field]: composePkValue(entity.schema, entity.entityType, index, args),
    [index.sk.field]: composeSkValue(entity.schema, entity.entityType, index, args),
  }
}

function extractCompositeSlots(
  schema: SchemaConfig,
  composite: ReadonlyArray<string>,
  record: Record<string, unknown> | undefined,
): ReadonlyArray<CompositeSlot> {
  return composite.map((attr) => {
    const value = record?.[attr]
    if (value === undefined || value === null) {
      return { name: attr, value: `{${attr}}`, placeholder: true }
    }
    return { name: attr, value: serializeValue(schema, value), placeholder: false }
  })
}

// ---------------------------------------------------------------------------
// V2 param builders — entity accessors, collection accessors, BoundQuery terminals
// ---------------------------------------------------------------------------

function buildEntityAccessorParams(
  entity: ResolvedEntity | undefined,
  collection: ResolvedCollection | undefined,
  collectionName: string | undefined,
  args: Record<string, unknown> | undefined,
): DynamoDBParams {
  if (!entity || !collection) {
    return {
      command: "QueryCommand",
      TableName: "<table>",
      entityType: entity?.entityType ?? "unknown",
      info: `Query accessor '${collectionName ?? "unknown"}'`,
    }
  }

  const pkComposites = collection.pk.composite.join(", ")
  const memberEntry = Object.entries(collection.members).find(
    ([, m]) => m.entityVariableName === entity.variableName,
  )
  const skComposites = memberEntry ? memberEntry[1].sk.composite.join(", ") : ""

  const info = [
    `Query accessor '${collectionName}'`,
    `  Index: ${collection.index} (collection: ${collection.collectionName}, ${collection.type})`,
    `  PK: ${pkComposites} (required)`,
    skComposites ? `  SK: ${skComposites} (optional: a prefix, or = when all given)` : undefined,
    `  Returns: BoundQuery<${entity.entityType}>`,
  ]
    .filter(Boolean)
    .join("\n")

  // Build actual query params if we have arguments
  if (args && entity.schema) {
    // The entity's own index, when it declares the collection: it carries
    // what the collection doesn't — every collection of a sub-collection
    // path, which a clustered key spells out, and an index-level casing.
    const own = Object.values(entity.indexes).find(
      (index) =>
        index.index === collection.index &&
        (typeof index.collection === "string"
          ? [index.collection]
          : (index.collection ?? [])
        ).includes(collection.collectionName),
    )
    const indexDef: IndexDefinition = own ?? {
      index: collection.index,
      collection: collection.collectionName,
      type: collection.type,
      pk: collection.pk,
      sk: {
        field: collection.sk.field,
        composite: memberEntry ? [...memberEntry[1].sk.composite] : [],
      },
    }
    const pkValue = composePkValue(entity.schema, entity.entityType, indexDef, args)
    const names: Record<string, string> = { "#pk": indexDef.pk.field }
    const values: Record<string, string> = { ":pk": pkValue }
    let keyCondition = "#pk = :pk"
    const sk = accessorSkCondition(entity.schema, entity.entityType, indexDef, args)
    if (sk) {
      names["#sk"] = sk.name
      Object.assign(values, sk.values)
      keyCondition += sk.keyCondition
    }

    return {
      command: "QueryCommand",
      TableName: "<table>",
      IndexName: collection.index,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      entityType: entity.entityType,
      info,
    }
  }

  return {
    command: "QueryCommand",
    TableName: "<table>",
    IndexName: collection.index,
    entityType: entity.entityType,
    info,
  }
}

function buildEntityIndexAccessorParams(
  entity: ResolvedEntity | undefined,
  indexName: string | undefined,
  args: Record<string, unknown> | undefined,
  whereCondition?: WhereCondition | undefined,
): DynamoDBParams {
  if (!entity || !indexName) {
    return {
      command: "QueryCommand",
      TableName: "<table>",
      entityType: entity?.entityType ?? "unknown",
      info: `Query accessor '${indexName ?? "unknown"}'`,
    }
  }

  const indexDef = entity.indexes[indexName]
  if (!indexDef) {
    return {
      command: "QueryCommand",
      TableName: "<table>",
      entityType: entity.entityType,
      info: `Query accessor '${indexName}' (index not found)`,
    }
  }

  const pkComposites = indexDef.pk.composite.join(", ")
  const skComposites = indexDef.sk.composite.join(", ")
  const zorder = isZOrderHalf(indexDef.sk)

  const info = [
    `Query accessor '${indexName}'`,
    `  Index: ${indexDef.index ?? "primary"} (isolated)`,
    `  PK: ${pkComposites} (required)`,
    zorder
      ? `  SK: ${ZORDER_KEY_PLACEHOLDER} over ${skComposites} (bound with .within())`
      : skComposites
        ? `  SK: ${skComposites} (optional: a prefix, or = when all given)`
        : undefined,
    indexDef.shards === undefined ? undefined : shardsInfo(indexDef.shards),
    `  Returns: BoundQuery<${entity.entityType}>`,
  ]
    .filter(Boolean)
    .join("\n")

  // Build actual query params if we have arguments
  if (args && entity.schema) {
    const pkValue = composePkValue(entity.schema, entity.entityType, indexDef, args)
    const names: Record<string, string> = { "#pk": indexDef.pk.field }
    const values: Record<string, string> = { ":pk": pkValue }
    let keyCondition = "#pk = :pk"

    // Merge .where() condition value into args for SK composition
    const mergedArgs = whereCondition
      ? { ...args, [whereCondition.field]: whereCondition.value }
      : args

    // Without `.where()`: the accessor's own condition — none, `=` on a
    // complete key, or a prefix's subtree.
    const sk = whereCondition
      ? undefined
      : accessorSkCondition(entity.schema, entity.entityType, indexDef, args)
    if (sk) {
      names["#sk"] = sk.name
      Object.assign(values, sk.values)
      keyCondition += sk.keyCondition
    }

    // `.where()` bounds the composite after the pinned ones. An approximation:
    // the library's `composeRangeUnder` also pushes an inclusive upper bound
    // past a non-last composite's subtree and clamps under pinned composites.
    const skPrefix =
      whereCondition &&
      !zorder &&
      indexDef.sk.composite.some((attr) => mergedArgs[attr] !== undefined)
        ? composeSkPrefixValue(entity.schema, entity.entityType, indexDef, mergedArgs)
        : ""
    if (whereCondition && skPrefix) {
      names["#sk"] = indexDef.sk.field
      switch (whereCondition.op) {
        case "beginsWith":
          values[":skPrefix"] = composeSkBeginsWithValue(
            entity.schema,
            entity.entityType,
            indexDef,
            mergedArgs,
          )
          keyCondition += " AND begins_with(#sk, :skPrefix)"
          break
        case "eq":
          values[":sk"] = skPrefix
          keyCondition += " AND #sk = :sk"
          break
        case "gt":
          values[":sk"] = skPrefix
          keyCondition += " AND #sk > :sk"
          break
        case "gte":
          values[":sk"] = skPrefix
          keyCondition += " AND #sk >= :sk"
          break
        case "lt":
          values[":sk"] = skPrefix
          keyCondition += " AND #sk < :sk"
          break
        case "lte":
          values[":sk"] = skPrefix
          keyCondition += " AND #sk <= :sk"
          break
        case "between": {
          const skPrefix2 = whereCondition.value2
            ? composeSkPrefixValue(entity.schema, entity.entityType, indexDef, {
                ...args,
                [whereCondition.field]: whereCondition.value2,
              })
            : skPrefix
          values[":skLow"] = skPrefix
          values[":skHigh"] = skPrefix2 ?? skPrefix
          keyCondition += " AND #sk BETWEEN :skLow AND :skHigh"
          break
        }
      }
    }

    return {
      command: "QueryCommand",
      TableName: "<table>",
      IndexName: indexDef.index,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      entityType: entity.entityType,
      info,
    }
  }

  return {
    command: "QueryCommand",
    TableName: "<table>",
    IndexName: indexDef.index,
    entityType: entity.entityType,
    info,
  }
}

function buildCollectionAccessorParams(
  collection: ResolvedCollection | undefined,
  collectionName: string | undefined,
  _args: Record<string, unknown> | undefined,
): DynamoDBParams {
  if (!collection) {
    return {
      command: "QueryCommand",
      TableName: "<table>",
      entityType: "collection",
      info: `Collection '${collectionName ?? "unknown"}'`,
    }
  }

  const memberLines = Object.entries(collection.members).map(
    ([key, m]) => `    ${key}: ${m.entityVariableName} (sk: [${m.sk.composite.join(", ")}])`,
  )

  const info = [
    `Collection '${collection.collectionName}'`,
    `  Index: ${collection.index} (${collection.type})`,
    `  PK: ${collection.pk.composite.join(", ")} (required)`,
    `  Members:`,
    ...memberLines,
    `  Returns: { ${Object.keys(collection.members).join(", ")} }`,
  ].join("\n")

  return {
    command: "QueryCommand",
    TableName: "<table>",
    IndexName: collection.index,
    entityType: "collection",
    info,
  }
}

function buildBoundQueryTerminalParams(op: DetectedOperation): DynamoDBParams {
  const terminalDescriptions: Record<string, string> = {
    collect: "Collect all pages into Array",
    fetch: "Execute single DynamoDB page → Page<T> with cursor",
    paginate: "Lazy Stream of items, auto-paginates",
    count: "Count-only query (no items returned)",
  }

  const desc = terminalDescriptions[op.terminalName ?? ""] ?? op.terminalName ?? "unknown"
  const terminalInfo = `BoundQuery terminal: .${op.terminalName}()\n  ${desc}`

  // Build the root query params (without info text)
  const rootParams = op.collection
    ? buildEntityAccessorParams(op.entity, op.collection, op.collectionName, op.arguments)
    : op.entity && op.indexName
      ? buildEntityIndexAccessorParams(op.entity, op.indexName, op.arguments, op.whereCondition)
      : undefined

  if (rootParams) {
    return {
      ...rootParams,
      command: op.terminalName === "count" ? "QueryCommand (SELECT: COUNT)" : rootParams.command,
      info: undefined,
    }
  }

  const entityType = op.entity?.entityType ?? op.collection?.collectionName ?? "unknown"
  return {
    command: op.terminalName === "count" ? "QueryCommand (SELECT: COUNT)" : "QueryCommand",
    TableName: "<table>",
    IndexName: op.collection?.index,
    entityType,
    info: terminalInfo,
  }
}

function buildTableAccessorParams(tableName: string | undefined): DynamoDBParams {
  return {
    command: "TableOperations",
    TableName: tableName ?? "<table>",
    entityType: "table",
    info: `Table '${tableName ?? "unknown"}'\n  Operations: create, delete, describe, update, backup, enableTTL, tag, ...`,
  }
}
