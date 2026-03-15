/**
 * Expression — Type-safe builders for DynamoDB expressions.
 *
 * Produces expression strings with attribute name/value placeholders,
 * matching the shape used by DynamoDB query/put/update/delete operations.
 *
 * Three builder types:
 * - condition: For conditional puts/deletes (ConditionExpression)
 * - filter: For query result filtering (FilterExpression)
 * - update: For update operations (UpdateExpression)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { toAttributeValue } from "./Marshaller.js"

// --- Output shape ---

export interface ExpressionResult {
  readonly expression: string
  readonly names: Record<string, string>
  readonly values: Record<string, AttributeValue>
}

// --- Condition Expression Builder ---

export interface ConditionInput {
  readonly eq?: Record<string, unknown> | undefined
  readonly ne?: Record<string, unknown> | undefined
  readonly lt?: Record<string, unknown> | undefined
  readonly le?: Record<string, unknown> | undefined
  readonly gt?: Record<string, unknown> | undefined
  readonly ge?: Record<string, unknown> | undefined
  readonly between?: Record<string, readonly [unknown, unknown]> | undefined
  readonly beginsWith?: Record<string, string> | undefined
  readonly attributeExists?: string | ReadonlyArray<string> | undefined
  readonly attributeNotExists?: string | ReadonlyArray<string> | undefined
}

// Counter for unique placeholder names within a build
let _counter = 0
const nextPlaceholder = (): string => `v${_counter++}`
const resetCounter = (): void => {
  _counter = 0
}

const buildComparisonClauses = (
  op: string,
  attrs: Record<string, unknown>,
  names: Record<string, string>,
  values: Record<string, AttributeValue>,
): ReadonlyArray<string> => {
  const clauses: Array<string> = []
  for (const [attr, val] of Object.entries(attrs)) {
    const nameKey = `#${attr}`
    const valKey = `:${nextPlaceholder()}`
    names[nameKey] = attr
    values[valKey] = toAttributeValue(val)
    clauses.push(`${nameKey} ${op} ${valKey}`)
  }
  return clauses
}

const buildFromInput = (input: ConditionInput): ExpressionResult => {
  resetCounter()
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const clauses: Array<string> = []

  if (input.eq) {
    clauses.push(...buildComparisonClauses("=", input.eq, names, values))
  }
  if (input.ne) {
    clauses.push(...buildComparisonClauses("<>", input.ne, names, values))
  }
  if (input.lt) {
    clauses.push(...buildComparisonClauses("<", input.lt, names, values))
  }
  if (input.le) {
    clauses.push(...buildComparisonClauses("<=", input.le, names, values))
  }
  if (input.gt) {
    clauses.push(...buildComparisonClauses(">", input.gt, names, values))
  }
  if (input.ge) {
    clauses.push(...buildComparisonClauses(">=", input.ge, names, values))
  }

  if (input.between) {
    for (const [attr, [low, high]] of Object.entries(input.between)) {
      const nameKey = `#${attr}`
      const lowKey = `:${nextPlaceholder()}`
      const highKey = `:${nextPlaceholder()}`
      names[nameKey] = attr
      values[lowKey] = toAttributeValue(low)
      values[highKey] = toAttributeValue(high)
      clauses.push(`${nameKey} BETWEEN ${lowKey} AND ${highKey}`)
    }
  }

  if (input.beginsWith) {
    for (const [attr, prefix] of Object.entries(input.beginsWith)) {
      const nameKey = `#${attr}`
      const valKey = `:${nextPlaceholder()}`
      names[nameKey] = attr
      values[valKey] = toAttributeValue(prefix)
      clauses.push(`begins_with(${nameKey}, ${valKey})`)
    }
  }

  if (input.attributeExists) {
    const attrs = Array.isArray(input.attributeExists)
      ? input.attributeExists
      : [input.attributeExists]
    for (const attr of attrs) {
      const nameKey = `#${attr}`
      names[nameKey] = attr
      clauses.push(`attribute_exists(${nameKey})`)
    }
  }

  if (input.attributeNotExists) {
    const attrs = Array.isArray(input.attributeNotExists)
      ? input.attributeNotExists
      : [input.attributeNotExists]
    for (const attr of attrs) {
      const nameKey = `#${attr}`
      names[nameKey] = attr
      clauses.push(`attribute_not_exists(${nameKey})`)
    }
  }

  return {
    expression: clauses.join(" AND "),
    names,
    values,
  }
}

/**
 * Build a ConditionExpression for conditional puts/deletes.
 * All clauses are ANDed together.
 */
export const condition = (input: ConditionInput): ExpressionResult => buildFromInput(input)

/**
 * Build a FilterExpression for query result filtering.
 * Same syntax as condition expressions.
 */
export const filter = (input: ConditionInput): ExpressionResult => buildFromInput(input)

// --- Update Expression Builder ---

export interface UpdateInput {
  readonly set?: Record<string, unknown> | undefined
  readonly remove?: ReadonlyArray<string> | undefined
  readonly add?: Record<string, number> | undefined
  readonly delete?: Record<string, unknown> | undefined
}

/**
 * Build an UpdateExpression with SET, REMOVE, ADD, DELETE clauses.
 */
export const update = (input: UpdateInput): ExpressionResult => {
  resetCounter()
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const parts: Array<string> = []

  if (input.set) {
    const setClauses: Array<string> = []
    for (const [attr, val] of Object.entries(input.set)) {
      const nameKey = `#${attr}`
      const valKey = `:${nextPlaceholder()}`
      names[nameKey] = attr
      values[valKey] = toAttributeValue(val)
      setClauses.push(`${nameKey} = ${valKey}`)
    }
    if (setClauses.length > 0) {
      parts.push(`SET ${setClauses.join(", ")}`)
    }
  }

  if (input.remove && input.remove.length > 0) {
    const removeClauses = input.remove.map((attr) => {
      const nameKey = `#${attr}`
      names[nameKey] = attr
      return nameKey
    })
    parts.push(`REMOVE ${removeClauses.join(", ")}`)
  }

  if (input.add) {
    const addClauses: Array<string> = []
    for (const [attr, val] of Object.entries(input.add)) {
      const nameKey = `#${attr}`
      const valKey = `:${nextPlaceholder()}`
      names[nameKey] = attr
      values[valKey] = toAttributeValue(val)
      addClauses.push(`${nameKey} ${valKey}`)
    }
    if (addClauses.length > 0) {
      parts.push(`ADD ${addClauses.join(", ")}`)
    }
  }

  if (input.delete) {
    const deleteClauses: Array<string> = []
    for (const [attr, val] of Object.entries(input.delete)) {
      const nameKey = `#${attr}`
      const valKey = `:${nextPlaceholder()}`
      names[nameKey] = attr
      values[valKey] = toAttributeValue(val)
      deleteClauses.push(`${nameKey} ${valKey}`)
    }
    if (deleteClauses.length > 0) {
      parts.push(`DELETE ${deleteClauses.join(", ")}`)
    }
  }

  return {
    expression: parts.join(" "),
    names,
    values,
  }
}
