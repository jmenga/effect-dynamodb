/**
 * @internal DynamoDB's limits on one expression, and how DynamoDB measures an
 * expression against them (#133, #144).
 *
 * Used two ways, neither of them a pre-check:
 *
 * - by strategies that pick a request that fits — `Entity`'s wide-update split
 *   and its strongest-guard fallback ({@link expressionFits}) — refusing
 *   nothing;
 * - by `WriteDiagnosis.ts`, to confirm DynamoDB's rejection of an expression
 *   against the request that was sent and name it.
 *
 * Measured against DynamoDB Local (3.1.0, 2026-10-10): an expression of 4,096
 * characters is accepted and 4,097 rejected; 300 operators accepted and 301
 * rejected; an `IN` of 100 operands accepted and 101 rejected. The length is
 * the expression string's own, placeholders unexpanded.
 */

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
