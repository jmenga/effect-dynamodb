/**
 * Browser-safe playground engine — ports key composition and expression building
 * from the core library without any Node.js or AWS SDK dependencies.
 */

// --- DynamoSchema (verbatim from core) ---

export type Casing = "lowercase" | "uppercase" | "preserve"

export interface DynamoSchema {
  readonly name: string
  readonly version: number
  readonly casing: Casing
}

export const makeSchema = (config: {
  readonly name: string
  readonly version: number
  readonly casing?: Casing | undefined
}): DynamoSchema => ({
  name: config.name,
  version: config.version,
  casing: config.casing ?? "lowercase",
})

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

export const schemaPrefix = (schema: DynamoSchema): string => {
  const name = applyCasing(schema.name, schema.casing)
  return `$${name}#v${schema.version}`
}

export const composeKey = (
  schema: DynamoSchema,
  entityType: string,
  composites: ReadonlyArray<string>,
  options?: { readonly casing?: Casing | undefined },
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = schemaPrefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  if (composites.length === 0) return `${pre}#${type}`
  return `${pre}#${type}#${composites.join("#")}`
}

export const composeCollectionKey = (
  schema: DynamoSchema,
  collectionName: string,
  composites: ReadonlyArray<string>,
  options?: { readonly casing?: Casing | undefined },
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = schemaPrefix(schema)
  const collection = applyCasing(collectionName, effectiveCasing)
  if (composites.length === 0) return `${pre}#${collection}`
  return `${pre}#${collection}#${composites.join("#")}`
}

export const composeClusteredSortKey = (
  schema: DynamoSchema,
  collectionName: string,
  entityType: string,
  entityVersion: number,
  composites: ReadonlyArray<string>,
  options?: { readonly casing?: Casing | undefined },
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = schemaPrefix(schema)
  const collection = applyCasing(collectionName, effectiveCasing)
  const type = applyCasing(entityType, effectiveCasing)
  const entityPrefix = `${type}_${entityVersion}`
  const parts = [pre, collection, entityPrefix, ...composites].filter((p) => p.length > 0)
  return parts.join("#")
}

export const composeIsolatedSortKey = (
  schema: DynamoSchema,
  entityType: string,
  entityVersion: number,
  composites: ReadonlyArray<string>,
  options?: { readonly casing?: Casing | undefined },
): string => {
  const effectiveCasing = options?.casing ?? schema.casing
  const pre = schemaPrefix(schema)
  const type = applyCasing(entityType, effectiveCasing)
  const entityPrefix = `${type}_${entityVersion}`
  const parts = [pre, entityPrefix, ...composites].filter((p) => p.length > 0)
  return parts.join("#")
}

// --- KeyComposer (simplified — string/number/boolean only, no DateTime) ---

export interface KeyPart {
  readonly field: string
  readonly composite: ReadonlyArray<string>
}

export interface IndexDefinition {
  readonly index?: string | undefined
  readonly collection?: string | ReadonlyArray<string> | undefined
  readonly type?: "isolated" | "clustered" | undefined
  readonly pk: KeyPart
  readonly sk: KeyPart
  readonly casing?: Casing | undefined
}

const serializeValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

const extractComposites = (
  composite: ReadonlyArray<string>,
  record: Record<string, unknown>,
): ReadonlyArray<string> =>
  composite.map((attr) => {
    const value = record[attr]
    if (value === undefined || value === null) {
      throw new Error(`Missing composite attribute "${attr}"`)
    }
    return serializeValue(value)
  })

export const composePk = (
  schema: DynamoSchema,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  const composites = extractComposites(index.pk.composite, record)
  const collection = index.collection
  if (collection !== undefined) {
    const collectionName = Array.isArray(collection) ? collection[0]! : collection
    return composeCollectionKey(schema, collectionName, composites, { casing: index.casing })
  }
  return composeKey(schema, entityType, composites, { casing: index.casing })
}

export const composeSk = (
  schema: DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  const composites = extractComposites(index.sk.composite, record)
  const collection = index.collection
  const collectionType = index.type ?? "clustered"
  if (collection !== undefined) {
    if (collectionType === "clustered") {
      const collectionName = Array.isArray(collection) ? collection[0]! : collection
      return composeClusteredSortKey(
        schema,
        collectionName,
        entityType,
        entityVersion,
        composites,
        {
          casing: index.casing,
        },
      )
    }
    return composeIsolatedSortKey(schema, entityType, entityVersion, composites, {
      casing: index.casing,
    })
  }
  return composeKey(schema, entityType, composites, { casing: index.casing })
}

export const composeIndexKeys = (
  schema: DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Record<string, string> => ({
  [index.pk.field]: composePk(schema, entityType, index, record),
  [index.sk.field]: composeSk(schema, entityType, entityVersion, index, record),
})

export const composeAllKeys = (
  schema: DynamoSchema,
  entityType: string,
  entityVersion: number,
  indexes: Record<string, IndexDefinition>,
  record: Record<string, unknown>,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const index of Object.values(indexes)) {
    try {
      Object.assign(result, composeIndexKeys(schema, entityType, entityVersion, index, record))
    } catch {
      // Skip indexes with missing composites (sparse GSI)
    }
  }
  return result
}

// --- Simplified Expression Builder (no AWS SDK dependency) ---

export interface SimpleExpressionResult {
  readonly expression: string
  readonly names: Record<string, string>
  readonly values: Record<string, unknown>
}

export interface ConditionInput {
  readonly eq?: Record<string, unknown>
  readonly ne?: Record<string, unknown>
  readonly lt?: Record<string, unknown>
  readonly le?: Record<string, unknown>
  readonly gt?: Record<string, unknown>
  readonly ge?: Record<string, unknown>
  readonly between?: Record<string, readonly [unknown, unknown]>
  readonly beginsWith?: Record<string, string>
  readonly attributeExists?: string | ReadonlyArray<string>
  readonly attributeNotExists?: string | ReadonlyArray<string>
}

const buildConditionExpression = (input: ConditionInput): SimpleExpressionResult => {
  let counter = 0
  const next = () => `v${counter++}`
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const clauses: Array<string> = []

  const comparison = (op: string, attrs: Record<string, unknown>) => {
    for (const [attr, val] of Object.entries(attrs)) {
      const nameKey = `#${attr}`
      const valKey = `:${next()}`
      names[nameKey] = attr
      values[valKey] = val
      clauses.push(`${nameKey} ${op} ${valKey}`)
    }
  }

  if (input.eq) comparison("=", input.eq)
  if (input.ne) comparison("<>", input.ne)
  if (input.lt) comparison("<", input.lt)
  if (input.le) comparison("<=", input.le)
  if (input.gt) comparison(">", input.gt)
  if (input.ge) comparison(">=", input.ge)

  if (input.between) {
    for (const [attr, [low, high]] of Object.entries(input.between)) {
      const nameKey = `#${attr}`
      const lowKey = `:${next()}`
      const highKey = `:${next()}`
      names[nameKey] = attr
      values[lowKey] = low
      values[highKey] = high
      clauses.push(`${nameKey} BETWEEN ${lowKey} AND ${highKey}`)
    }
  }

  if (input.beginsWith) {
    for (const [attr, prefix] of Object.entries(input.beginsWith)) {
      const nameKey = `#${attr}`
      const valKey = `:${next()}`
      names[nameKey] = attr
      values[valKey] = prefix
      clauses.push(`begins_with(${nameKey}, ${valKey})`)
    }
  }

  if (input.attributeExists) {
    const attrs = Array.isArray(input.attributeExists)
      ? input.attributeExists
      : [input.attributeExists]
    for (const attr of attrs) {
      names[`#${attr}`] = attr
      clauses.push(`attribute_exists(#${attr})`)
    }
  }

  if (input.attributeNotExists) {
    const attrs = Array.isArray(input.attributeNotExists)
      ? input.attributeNotExists
      : [input.attributeNotExists]
    for (const attr of attrs) {
      names[`#${attr}`] = attr
      clauses.push(`attribute_not_exists(#${attr})`)
    }
  }

  return { expression: clauses.join(" AND "), names, values }
}

// --- High-Level Generators ---

export interface GeneratedPutItem {
  readonly TableName: string
  readonly Item: Record<string, unknown>
}

export interface GeneratedQuery {
  readonly TableName: string
  readonly IndexName?: string
  readonly KeyConditionExpression: string
  readonly FilterExpression: string
  readonly ExpressionAttributeNames: Record<string, string>
  readonly ExpressionAttributeValues: Record<string, unknown>
}

export const generatePutItemParams = (
  schema: DynamoSchema,
  entityType: string,
  entityVersion: number,
  indexes: Record<string, IndexDefinition>,
  record: Record<string, unknown>,
  tableName: string,
): GeneratedPutItem => {
  const keys = composeAllKeys(schema, entityType, entityVersion, indexes, record)
  const now = new Date().toISOString()
  return {
    TableName: tableName,
    Item: {
      ...record,
      ...keys,
      __edd_e__: entityType,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
  }
}

export const generateQueryParams = (
  schema: DynamoSchema,
  entityType: string,
  entityVersion: number,
  indexName: string,
  index: IndexDefinition,
  pkRecord: Record<string, unknown>,
  tableName: string,
): GeneratedQuery => {
  const pk = composePk(schema, entityType, index, pkRecord)

  // Build SK prefix for begins_with (entity type filtering)
  const skPrefix = index.collection
    ? (() => {
        const collectionName = Array.isArray(index.collection)
          ? index.collection[0]!
          : index.collection
        const collectionType = index.type ?? "clustered"
        if (collectionType === "clustered") {
          return composeClusteredSortKey(schema, collectionName, entityType, entityVersion, [], {
            casing: index.casing,
          })
        }
        return composeIsolatedSortKey(schema, entityType, entityVersion, [], {
          casing: index.casing,
        })
      })()
    : composeKey(schema, entityType, [], { casing: index.casing })

  return {
    TableName: tableName,
    ...(indexName !== "primary" && index.index ? { IndexName: index.index } : {}),
    KeyConditionExpression: `#pk = :pk AND begins_with(#sk, :skPrefix)`,
    FilterExpression: `#edd_e = :edd_e`,
    ExpressionAttributeNames: {
      "#pk": index.pk.field,
      "#sk": index.sk.field,
      "#edd_e": "__edd_e__",
    },
    ExpressionAttributeValues: {
      ":pk": pk,
      ":skPrefix": skPrefix,
      ":edd_e": entityType,
    },
  }
}

export { buildConditionExpression as buildCondition }
