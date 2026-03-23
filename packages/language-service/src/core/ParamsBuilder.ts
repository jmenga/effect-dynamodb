import type {
  Casing,
  IndexDefinition,
  ResolvedCollection,
  ResolvedEntity,
  SchemaConfig,
} from "./EntityResolver"
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
      return buildEntityAccessorParams(op.entity, op.collection, op.collectionName, op.arguments)
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
    skComposites ? `  SK: ${skComposites} (optional begins_with)` : undefined,
    `  Returns: BoundQuery<${entity.entityType}>`,
  ]
    .filter(Boolean)
    .join("\n")

  // Build actual query params if we have arguments
  if (args && entity.schema) {
    const indexDef: IndexDefinition = {
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

    return {
      command: "QueryCommand",
      TableName: "<table>",
      IndexName: collection.index,
      KeyConditionExpression: "#pk = :pk",
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
  const entityType = op.entity?.entityType ?? op.collection?.collectionName ?? "unknown"

  return {
    command: op.terminalName === "count" ? "QueryCommand (SELECT: COUNT)" : "QueryCommand",
    TableName: "<table>",
    IndexName: op.collection?.index,
    entityType,
    info: `BoundQuery terminal: .${op.terminalName}()\n  ${desc}`,
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
