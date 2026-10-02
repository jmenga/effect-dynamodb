/**
 * Browser-safe playground engine — key composition comes straight from
 * `@effect-dynamodb/schema` (pure, AWS-free), so the playground shows exactly
 * the keys the library writes. Expression building is a simplified port with no
 * AWS SDK dependency.
 */

import * as DynamoSchemaModule from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"

// --- DynamoSchema / KeyComposer (from the library) ---

export type Casing = DynamoSchemaModule.Casing
export type DynamoSchema = DynamoSchemaModule.DynamoSchema
export type KeyPart = KeyComposer.KeyPart
export type IndexDefinition = KeyComposer.IndexDefinition

export const makeSchema = DynamoSchemaModule.make
export const applyCasing = DynamoSchemaModule.applyCasing
export const schemaPrefix = DynamoSchemaModule.prefix
export const composeKey = DynamoSchemaModule.composeKey
export const composeClusteredSortKey = DynamoSchemaModule.composeClusteredSortKey
export const composeIsolatedSortKey = DynamoSchemaModule.composeIsolatedSortKey
export const composePk = KeyComposer.composePk
export const composeSk = KeyComposer.composeSk
export const composeIndexKeys = KeyComposer.composeIndexKeys

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
        if (index.type === "clustered") {
          return composeClusteredSortKey(schema, index.collection, entityType, entityVersion, [], {
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
