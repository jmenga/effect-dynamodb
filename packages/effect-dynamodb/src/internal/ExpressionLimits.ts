/**
 * @internal DynamoDB's limits on one expression, and how DynamoDB measures an
 * expression against them (#133, #144).
 *
 * Used two ways, neither of them a pre-check:
 *
 * - by strategies that pick a request that fits — `Entity`'s wide-update split
 *   and its strongest-guard fallback ({@link expressionFits}), the guard on a
 *   1.36 row's move ({@link asReadGuard}), the whole-row guard that proves a
 *   row unchanged or isn't sent ({@link wholeRowGuard}) — refusing nothing;
 * - by `WriteDiagnosis.ts`, to confirm DynamoDB's rejection of an expression
 *   against the request that was sent and name it.
 *
 * Measured against DynamoDB Local (3.1.0, 2026-10-10): an expression of 4,096
 * characters is accepted and 4,097 rejected; 300 operators accepted and 301
 * rejected; an `IN` of 100 operands accepted and 101 rejected. The length is
 * the expression string's own, placeholders unexpanded.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"

/** DynamoDB's limit on one expression's length, in characters. */
export const EXPRESSION_MAX_LENGTH = 4096
/** DynamoDB's limit on one expression's operators and functions. */
export const EXPRESSION_MAX_OPERATORS = 300
/** DynamoDB's limit on the operands of one `IN`. */
export const IN_MAX_OPERANDS = 100

/**
 * The tokens of a compiled expression. Names and values are placeholders
 * (`#…`, `:…`), so no operator can hide inside one.
 */
const EXPRESSION_TOKEN = /#\w+|:\w+|<>|<=|>=|[=<>()+\-,.[\]]|[A-Za-z_]\w*|\d+/g

/**
 * The operators DynamoDB counts against an expression's 300 (#133), measured
 * against DynamoDB: in a condition, each comparison (`=`, `<>`, `<`, `<=`,
 * `>`, `>=`), `AND` / `OR` / `NOT`, `BETWEEN` (whose own `AND` is part of it,
 * not another operator), `IN`, and each function; in an update, each `+` /
 * `-` and each function (`if_not_exists`, `list_append`) — a `SET` clause's
 * `=` is not an operator.
 */
export const countOperators = (expression: string, kind: "condition" | "update"): number => {
  const tokens = expression.match(EXPRESSION_TOKEN) ?? []
  let count = 0
  let betweens = 0
  for (const [i, token] of tokens.entries()) {
    const word = token.toUpperCase()
    const isFunction = /^[A-Za-z_]\w*$/.test(token) && tokens[i + 1] === "("
    if (kind === "update") {
      if (token === "+" || token === "-" || isFunction) count++
      continue
    }
    if (isFunction) count++
    else if (["=", "<>", "<", "<=", ">", ">="].includes(token)) count++
    else if (word === "BETWEEN") {
      count++
      betweens++
    } else if (word === "AND" && betweens > 0) betweens--
    else if (word === "AND" || word === "OR" || word === "NOT" || word === "IN") count++
  }
  return count
}

/** The most operands any one `IN (…)` of `expression` holds (0 when it has none). */
export const largestInOperands = (expression: string): number => {
  let largest = 0
  for (const match of expression.matchAll(/\bIN\s*\(([^()]*)\)/gi)) {
    const list = match[1]!.trim()
    const operands = list === "" ? 0 : list.split(",").length
    if (operands > largest) largest = operands
  }
  return largest
}

/** What DynamoDB counts against an expression's limits. */
export const expressionCost = (
  expression: string | undefined,
  kind: "condition" | "update" = "condition",
): { readonly length: number; readonly operators: number } =>
  expression === undefined
    ? { length: 0, operators: 0 }
    : { length: expression.length, operators: countOperators(expression, kind) }

/**
 * Whether `expression` is within DynamoDB's limits on one expression — for a
 * strategy choosing a request that fits, never to refuse one.
 */
export const expressionFits = (
  expression: string,
  kind: "condition" | "update" = "condition",
): boolean => {
  const cost = expressionCost(expression, kind)
  return (
    cost.length <= EXPRESSION_MAX_LENGTH &&
    cost.operators <= EXPRESSION_MAX_OPERATORS &&
    largestInOperands(expression) <= IN_MAX_OPERANDS
  )
}

/**
 * The condition that a stored row is still as it was read (#171): it exists,
 * and every attribute but its table key (`pkField`, `sk`) holds the value
 * read — `prefer`'s first (an `updatedAt`), then the rest by name, as many as
 * fit DynamoDB's limits on one expression (all of any row but a very wide
 * one). A Delete of a 1.36 row carries it, so a row a write changed in
 * between cancels the move instead of being lost. `absent` names attributes
 * the read did not have that a write may add without changing any other (an
 * outbox drainer's claim): each must still be absent.
 */
export const asReadGuard = (
  stored: Record<string, AttributeValue>,
  pkField: string,
  prefer: ReadonlyArray<string>,
  absent: ReadonlyArray<string> = [],
): {
  readonly ConditionExpression: string
  readonly ExpressionAttributeNames: Record<string, string>
  readonly ExpressionAttributeValues?: Record<string, AttributeValue>
} => {
  const names: Record<string, string> = { "#gpk": pkField }
  const values: Record<string, AttributeValue> = {}
  let expression = "attribute_exists(#gpk)"
  for (const [i, attr] of absent.filter((attr) => stored[attr] === undefined).entries()) {
    names[`#ga${i}`] = attr
    expression = `${expression} AND attribute_not_exists(#ga${i})`
  }
  const attrs = [...new Set([...prefer, ...Object.keys(stored).sort()])].filter(
    (attr) => attr !== pkField && attr !== "sk" && stored[attr] !== undefined,
  )
  for (const [i, attr] of attrs.entries()) {
    const clause = `#g${i} = :g${i}`
    if (!expressionFits(`${expression} AND ${clause}`)) continue
    names[`#g${i}`] = attr
    values[`:g${i}`] = stored[attr]!
    expression = `${expression} AND ${clause}`
  }
  return {
    ConditionExpression: expression,
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
  }
}

/**
 * The condition that a stored row is still exactly the row read: it exists, every attribute but its
 * table key (`pkField`, `sk`) holds the value read, and each of `absent` the read didn't have is
 * still absent. Never weakened to fit: undefined when the whole condition doesn't fit DynamoDB's
 * limits on one expression, so a caller that can't prove the row unchanged leaves it alone.
 */
export const wholeRowGuard = (
  stored: Record<string, AttributeValue>,
  pkField: string,
  absent: ReadonlyArray<string>,
):
  | {
      readonly ConditionExpression: string
      readonly ExpressionAttributeNames: Record<string, string>
      readonly ExpressionAttributeValues?: Record<string, AttributeValue>
    }
  | undefined => {
  const names: Record<string, string> = { "#gpk": pkField }
  const values: Record<string, AttributeValue> = {}
  const clauses = ["attribute_exists(#gpk)"]
  const missing = [...new Set(absent)].filter(
    (attr) => attr !== pkField && attr !== "sk" && stored[attr] === undefined,
  )
  for (const [i, attr] of missing.entries()) {
    names[`#ga${i}`] = attr
    clauses.push(`attribute_not_exists(#ga${i})`)
  }
  const attrs = Object.keys(stored)
    .sort()
    .filter((attr) => attr !== pkField && attr !== "sk" && stored[attr] !== undefined)
  for (const [i, attr] of attrs.entries()) {
    names[`#g${i}`] = attr
    values[`:g${i}`] = stored[attr]!
    clauses.push(`#g${i} = :g${i}`)
  }
  const expression = clauses.join(" AND ")
  if (!expressionFits(expression)) return undefined
  return {
    ConditionExpression: expression,
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
  }
}
