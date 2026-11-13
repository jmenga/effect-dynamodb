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
import { ownValue } from "@effect-dynamodb/schema/internal/OwnNames.js"
import { attributeBytes, utf8Bytes } from "./ItemSize.js"

/** DynamoDB's limit on one expression's length, in characters. */
export const EXPRESSION_MAX_LENGTH = 4096
/** DynamoDB's limit on one expression's operators and functions. */
export const EXPRESSION_MAX_OPERATORS = 300
/** DynamoDB's limit on the operands of one `IN`. */
export const IN_MAX_OPERANDS = 100
/**
 * DynamoDB's limit on all of one expression's substitution variables: its `ExpressionAttributeNames`
 * and `ExpressionAttributeValues` together.
 */
export const EXPRESSION_MAX_SUBSTITUTION_BYTES = 2 * 1024 * 1024

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
 * The size of an expression's substitution variables as {@link EXPRESSION_MAX_SUBSTITUTION_BYTES}
 * measures it, counted generously: each placeholder's own text with the name's UTF-8 bytes, or with
 * the value's size by the exact item size model.
 */
export const substitutionBytes = (
  names: Readonly<Record<string, string>>,
  values: Readonly<Record<string, AttributeValue>>,
): number => {
  let bytes = 0
  for (const [placeholder, name] of Object.entries(names)) {
    bytes += utf8Bytes(placeholder) + utf8Bytes(name)
  }
  for (const [placeholder, value] of Object.entries(values)) {
    bytes += utf8Bytes(placeholder) + attributeBytes(value)
  }
  return bytes
}

/** Whether substitution variables are within DynamoDB's limit for one expression. */
export const substitutionsFit = (
  names: Readonly<Record<string, string>>,
  values: Readonly<Record<string, AttributeValue>>,
): boolean => substitutionBytes(names, values) <= EXPRESSION_MAX_SUBSTITUTION_BYTES

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
  for (const [i, attr] of absent.filter((attr) => ownValue(stored, attr) === undefined).entries()) {
    names[`#ga${i}`] = attr
    expression = `${expression} AND attribute_not_exists(#ga${i})`
  }
  const attrs = [...new Set([...prefer, ...Object.keys(stored).sort()])].filter(
    (attr) => attr !== pkField && attr !== "sk" && ownValue(stored, attr) !== undefined,
  )
  // Its substitutions stay far below EXPRESSION_MAX_SUBSTITUTION_BYTES: a row's names and values
  // are at most 400 KB, and an expression that fits names at most a few hundred placeholders.
  for (const [i, attr] of attrs.entries()) {
    const clause = `#g${i} = :g${i}`
    if (!expressionFits(`${expression} AND ${clause}`)) continue
    names[`#g${i}`] = attr
    values[`:g${i}`] = ownValue(stored, attr)!
    expression = `${expression} AND ${clause}`
  }
  return {
    ConditionExpression: expression,
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
  }
}

/**
 * The condition that a stored row is still exactly the row read, or undefined when it doesn't fit
 * DynamoDB's limits on one expression whole: never weakened to fit, so a caller that can't prove the
 * row unchanged leaves it alone. It is {@link asReadGuard}'s condition, byte for byte, with none of
 * its terms left out (`prefer` first, `absent` the read didn't have still absent, then every other
 * attribute but the table key holding the value read), followed by each of `extra` the read didn't
 * have still absent: the attributes a write to the row could add. With none to add it is the
 * request 1.39.0 sent.
 */
export const wholeRowGuard = (
  stored: Record<string, AttributeValue>,
  pkField: string,
  prefer: ReadonlyArray<string>,
  absent: ReadonlyArray<string>,
  extra: ReadonlyArray<string>,
):
  | {
      readonly ConditionExpression: string
      readonly ExpressionAttributeNames: Record<string, string>
      readonly ExpressionAttributeValues?: Record<string, AttributeValue>
    }
  | undefined => {
  const keyed = (attr: string) => attr !== pkField && attr !== "sk"
  const held = new Set([...prefer, ...Object.keys(stored)].filter((attr) => keyed(attr)))
  const guard = asReadGuard(stored, pkField, prefer, absent)
  const names: Record<string, string> = { ...guard.ExpressionAttributeNames }
  const values: Record<string, AttributeValue> = { ...guard.ExpressionAttributeValues }
  // `asReadGuard` leaves out what doesn't fit: whole, it named every attribute the read had.
  const named = Object.keys(names).filter((placeholder) => /^#g\d+$/.test(placeholder)).length
  if (named !== [...held].filter((attr) => ownValue(stored, attr) !== undefined).length)
    return undefined
  const inGuard = new Set(Object.values(names))
  let expression = guard.ConditionExpression
  const missing = [...new Set(extra)].filter(
    (attr) => keyed(attr) && ownValue(stored, attr) === undefined && !inGuard.has(attr),
  )
  for (const [i, attr] of missing.entries()) {
    names[`#gx${i}`] = attr
    expression = `${expression} AND attribute_not_exists(#gx${i})`
  }
  if (!expressionFits(expression) || !substitutionsFit(names, values)) return undefined
  return {
    ConditionExpression: expression,
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
  }
}

/**
 * The guard on a row too wide to guard whole ({@link wholeRowGuard}) of a member that stamps
 * `prefer` (an `updatedAt`): {@link asReadGuard}'s condition with `prefer` first, held or, when
 * the read didn't have it, still absent (for a row holding it, the request 1.39.0 sent, byte for
 * byte: then as many other attributes as fit), followed by as many of `absent` the read didn't
 * have still absent as fit DynamoDB's limits on one expression. A write that changes `prefer`
 * cancels the move; one that changes only what's left out, and not `prefer`, isn't seen.
 */
export const preferredGuard = (
  stored: Record<string, AttributeValue>,
  pkField: string,
  prefer: ReadonlyArray<string>,
  absent: ReadonlyArray<string>,
): {
  readonly ConditionExpression: string
  readonly ExpressionAttributeNames: Record<string, string>
  readonly ExpressionAttributeValues?: Record<string, AttributeValue>
} => {
  const guard = asReadGuard(stored, pkField, prefer, prefer)
  const names: Record<string, string> = { ...guard.ExpressionAttributeNames }
  const values: Record<string, AttributeValue> = { ...guard.ExpressionAttributeValues }
  let expression = guard.ConditionExpression
  const missing = [...new Set(absent)].filter(
    (attr) =>
      attr !== pkField &&
      attr !== "sk" &&
      ownValue(stored, attr) === undefined &&
      !prefer.includes(attr),
  )
  for (const [i, attr] of missing.entries()) {
    const clause = `attribute_not_exists(#gx${i})`
    if (!expressionFits(`${expression} AND ${clause}`)) continue
    if (!substitutionsFit({ ...names, [`#gx${i}`]: attr }, values)) continue
    names[`#gx${i}`] = attr
    expression = `${expression} AND ${clause}`
  }
  return {
    ConditionExpression: expression,
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
  }
}

/**
 * What `rekey`'s move does with a row it can't prove unchanged: one whose whole guard ({@link
 * wholeRowGuard}) doesn't fit DynamoDB's limits on one expression, with no version or `updatedAt`
 * the library stamps to stand in (its member is neither `versioned` nor `timestamps`, it's an
 * aggregate row whose node declares its own `updatedAt` other than a date, or it's a stream's row or
 * a projection's row tombstone or outbox item). Every move that meets such a row switches on it, so
 * a new answer is a type error at each:
 *
 * - `"report"` — the default: the row isn't moved, and is reported `unguarded`. An aggregate or a
 *   stream already part-moved is finished as under `"strongest"`.
 * - `"strongest"` — with `writesStopped`, as 1.39.0: the strongest guard that fits is sent, so a
 *   concurrent write changing only what it leaves out would land unseen. A soft, retain or unique
 *   delete always sends it.
 */
export type UnprovableRow = "report" | "strongest"
