import type { Casing, IndexDefinition, ResolvedEntity, SchemaConfig } from "./EntityResolver"
import type { DetectedOperation, UpdateCombinators } from "./OperationDetector"

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
}

export function buildParams(op: DetectedOperation): DynamoDBParams {
  const { entity, type } = op

  switch (type) {
    case "get":
      return buildGetParams(entity, op.arguments)
    case "put":
      return buildPutParams(entity, op.arguments)
    case "create":
      return buildCreateParams(entity, op.arguments)
    case "update":
      return buildUpdateParams(entity, op.arguments, op.updateCombinators)
    case "delete":
      return buildDeleteParams(entity, op.arguments)
    case "query":
      return buildQueryParams(entity, op.indexName, op.arguments)
    case "scan":
      return buildScanParams(entity)
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
  const skPrefix = composeSkPrefixValue(entity.schema, entity.entityType, index, args)

  names["#pk"] = index.pk.field
  values[":pk"] = pkValue
  let keyCondition = "#pk = :pk"

  if (skPrefix) {
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

function composeKey(
  schema: SchemaConfig,
  entityType: string,
  composites: ReadonlyArray<string>,
  casing?: Casing,
): string {
  const effectiveCasing = casing ?? schema.casing
  const pre = schemaPrefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  if (composites.length === 0) return `${pre}#${type}`
  return `${pre}#${type}#${composites.join("#")}`
}

function composeCollectionKey(
  schema: SchemaConfig,
  collectionName: string,
  composites: ReadonlyArray<string>,
  casing?: Casing,
): string {
  const effectiveCasing = casing ?? schema.casing
  const pre = schemaPrefix(schema)
  const collection = applyCasing(collectionName, effectiveCasing)
  if (composites.length === 0) return `${pre}#${collection}`
  return `${pre}#${collection}#${composites.join("#")}`
}

function composeClusteredSortKey(
  schema: SchemaConfig,
  collectionName: string,
  entityType: string,
  entityVersion: number,
  composites: ReadonlyArray<string>,
  casing?: Casing,
): string {
  const effectiveCasing = casing ?? schema.casing
  const pre = schemaPrefix(schema)
  const collection = applyCasing(collectionName, effectiveCasing)
  const type = applyCasing(entityType, effectiveCasing)
  const entityPrefix = `${type}_${entityVersion}`
  const parts = [pre, collection, entityPrefix, ...composites].filter((p) => p.length > 0)
  return parts.join("#")
}

function composeIsolatedSortKey(
  schema: SchemaConfig,
  entityType: string,
  entityVersion: number,
  composites: ReadonlyArray<string>,
  casing?: Casing,
): string {
  const effectiveCasing = casing ?? schema.casing
  const pre = schemaPrefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  const entityPrefix = `${type}_${entityVersion}`
  const parts = [pre, entityPrefix, ...composites].filter((p) => p.length > 0)
  return parts.join("#")
}

function composePkValue(
  schema: SchemaConfig,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown> | undefined,
): string {
  const composites = extractCompositeValues(index.pk.composite, record)
  const collection = index.collection
  if (collection !== undefined) {
    const collectionName = Array.isArray(collection) ? collection[0]! : collection
    return composeCollectionKey(schema, collectionName, composites, index.casing)
  }
  return composeKey(schema, entityType, composites, index.casing)
}

function composeSkValue(
  schema: SchemaConfig,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown> | undefined,
): string {
  const composites = extractCompositeValues(index.sk.composite, record)
  const collection = index.collection
  const collectionType = index.type ?? "clustered"
  const entityVersion = 1

  if (collection !== undefined) {
    if (collectionType === "clustered") {
      const collectionName = Array.isArray(collection) ? collection[0]! : collection
      return composeClusteredSortKey(
        schema,
        collectionName,
        entityType,
        entityVersion,
        composites,
        index.casing,
      )
    }
    return composeIsolatedSortKey(schema, entityType, entityVersion, composites, index.casing)
  }
  return composeKey(schema, entityType, composites, index.casing)
}

function composeSkPrefixValue(
  schema: SchemaConfig,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown> | undefined,
): string | undefined {
  const available: Array<string> = []
  for (const attr of index.sk.composite) {
    const value = record?.[attr]
    if (value === undefined || value === null) break
    available.push(String(value))
  }

  const collection = index.collection
  const collectionType = index.type ?? "clustered"
  const entityVersion = 1

  if (collection !== undefined) {
    if (collectionType === "clustered") {
      const collectionName = Array.isArray(collection) ? collection[0]! : collection
      return composeClusteredSortKey(
        schema,
        collectionName,
        entityType,
        entityVersion,
        available,
        index.casing,
      )
    }
    return composeIsolatedSortKey(schema, entityType, entityVersion, available, index.casing)
  }
  return composeKey(schema, entityType, available, index.casing)
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

function extractCompositeValues(
  composite: ReadonlyArray<string>,
  record: Record<string, unknown> | undefined,
): ReadonlyArray<string> {
  return composite.map((attr) => {
    const value = record?.[attr]
    if (value === undefined || value === null) return `{${attr}}`
    return String(value)
  })
}
