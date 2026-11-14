/**
 * @internal Expr — Expression ADT for type-safe DynamoDB condition/filter expressions.
 *
 * Provides a discriminated union of expression nodes that compile to DynamoDB
 * ConditionExpression / FilterExpression strings with attribute name/value placeholders.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { ConditionInput } from "../Expression.js"
import { isEmptySet, toAttributeValue, type UnstorableValue, unstorableIn } from "../Marshaller.js"
import {
  compilePath,
  isPath,
  type PackedPath,
  type Path,
  type SizeOperand,
  type StoredBelow,
} from "./PathBuilder.js"

// ---------------------------------------------------------------------------
// An `Expression` builder's result compiled without a map entry keyed `__proto__`
// ---------------------------------------------------------------------------

/**
 * Each result an `Expression` builder compiled from an operand holding a map entry keyed
 * `__proto__` (`EDD-9165`), and the first such entry's refusal. The builder compiles it as
 * 1.40.0 did, without that entry, and the library refuses the result where it would send it
 * (`Transaction.check`'s condition in a transaction). Keyed by identity, so nothing a caller
 * builds is taken for one.
 */
const unsent = new WeakMap<object, UnstorableValue>()

/** Records that `result` was compiled without a map entry keyed `__proto__`. */
export const markUnsent = (result: object, refusal: UnstorableValue): void => {
  if (!unsent.has(result)) unsent.set(result, refusal)
}

/** The refusal recorded for this very `result` ({@link markUnsent}), or `undefined`. */
export const unsentIn = (result: object): UnstorableValue | undefined => unsent.get(result)

// ---------------------------------------------------------------------------
// Operand — either a path reference, a literal value, or a size() function
// ---------------------------------------------------------------------------

export type Operand =
  | { readonly _tag: "path"; readonly segments: ReadonlyArray<string | number> }
  | { readonly _tag: "value"; readonly value: unknown }
  | { readonly _tag: "size"; readonly segments: ReadonlyArray<string | number> }

/** Convert a Path, SizeOperand, or raw value to an Operand */
const toOperand = (v: unknown): Operand => {
  // A path ending in `size`, `at` or `entry` is a function (`isPath`).
  if (isPath(v)) return { _tag: "path", segments: v.segments }
  if (typeof v === "object" && v !== null) {
    if ("_tag" in v && (v as { _tag: string })._tag === "size") {
      return { _tag: "size", segments: (v as SizeOperand).segments }
    }
  }
  return { _tag: "value", value: v }
}

// ---------------------------------------------------------------------------
// Expr — Discriminated union of expression nodes
// ---------------------------------------------------------------------------

export const ExprTag: unique symbol = Symbol.for("effect-dynamodb/Expr")
export type ExprTag = typeof ExprTag

export type Expr =
  | ExprComparison
  | ExprBetween
  | ExprIn
  | ExprExists
  | ExprNotExists
  | ExprAttributeType
  | ExprBeginsWith
  | ExprContains
  | ExprAnd
  | ExprOr
  | ExprNot

interface ExprComparison {
  readonly [ExprTag]: ExprTag
  readonly _tag: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"
  readonly left: Operand
  readonly right: Operand
}

interface ExprBetween {
  readonly [ExprTag]: ExprTag
  readonly _tag: "between"
  readonly operand: Operand
  readonly low: Operand
  readonly high: Operand
}

interface ExprIn {
  readonly [ExprTag]: ExprTag
  readonly _tag: "in"
  readonly operand: Operand
  readonly values: ReadonlyArray<Operand>
}

interface ExprExists {
  readonly [ExprTag]: ExprTag
  readonly _tag: "exists"
  readonly operand: Operand
}

interface ExprNotExists {
  readonly [ExprTag]: ExprTag
  readonly _tag: "notExists"
  readonly operand: Operand
}

interface ExprAttributeType {
  readonly [ExprTag]: ExprTag
  readonly _tag: "type"
  readonly operand: Operand
  readonly attributeType: string
}

interface ExprBeginsWith {
  readonly [ExprTag]: ExprTag
  readonly _tag: "beginsWith"
  readonly operand: Operand
  readonly prefix: Operand
}

interface ExprContains {
  readonly [ExprTag]: ExprTag
  readonly _tag: "contains"
  readonly operand: Operand
  readonly value: Operand
}

interface ExprAnd {
  readonly [ExprTag]: ExprTag
  readonly _tag: "and"
  readonly exprs: ReadonlyArray<Expr>
}

interface ExprOr {
  readonly [ExprTag]: ExprTag
  readonly _tag: "or"
  readonly exprs: ReadonlyArray<Expr>
}

interface ExprNot {
  readonly [ExprTag]: ExprTag
  readonly _tag: "not"
  readonly expr: Expr
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export const isExpr = (u: unknown): u is Expr => typeof u === "object" && u !== null && ExprTag in u

// ---------------------------------------------------------------------------
// ConditionOps — the operations object passed to callback-style conditions
// ---------------------------------------------------------------------------

/**
 * Operations available in condition/filter callbacks.
 * Each function accepts paths and values, returning an Expr node.
 */
export interface ConditionOps<Model> {
  readonly eq: <V>(left: Path<Model, V> | SizeOperand<Model>, right: V | Path<Model, V>) => Expr
  readonly ne: <V>(left: Path<Model, V> | SizeOperand<Model>, right: V | Path<Model, V>) => Expr
  readonly lt: <V>(left: Path<Model, V> | SizeOperand<Model>, right: V | Path<Model, V>) => Expr
  readonly lte: <V>(left: Path<Model, V> | SizeOperand<Model>, right: V | Path<Model, V>) => Expr
  readonly gt: <V>(left: Path<Model, V> | SizeOperand<Model>, right: V | Path<Model, V>) => Expr
  readonly gte: <V>(left: Path<Model, V> | SizeOperand<Model>, right: V | Path<Model, V>) => Expr
  readonly between: <V>(operand: Path<Model, V>, low: V, high: V) => Expr
  readonly isIn: <V>(operand: Path<Model, V>, values: ReadonlyArray<V>) => Expr
  /** `attribute_exists` — also accepts a packed field ({@link PackedPath}) as a whole. */
  readonly exists: (operand: Path<Model, any> | PackedPath<Model, any>) => Expr
  /** `attribute_not_exists` — also accepts a packed field ({@link PackedPath}) as a whole. */
  readonly notExists: (operand: Path<Model, any> | PackedPath<Model, any>) => Expr
  readonly attributeType: (operand: Path<Model, any>, type: string) => Expr
  readonly beginsWith: (operand: Path<Model, string>, prefix: string) => Expr
  readonly contains: (operand: Path<Model, string | ReadonlyArray<any>>, value: unknown) => Expr
  readonly and: (...exprs: ReadonlyArray<Expr>) => Expr
  readonly or: (...exprs: ReadonlyArray<Expr>) => Expr
  readonly not: (expr: Expr) => Expr
}

/**
 * Create a ConditionOps object that builds Expr nodes.
 */
export const createConditionOps = <Model>(): ConditionOps<Model> => ({
  eq: (left, right) => ({
    [ExprTag]: ExprTag,
    _tag: "eq",
    left: toOperand(left),
    right: toOperand(right),
  }),
  ne: (left, right) => ({
    [ExprTag]: ExprTag,
    _tag: "ne",
    left: toOperand(left),
    right: toOperand(right),
  }),
  lt: (left, right) => ({
    [ExprTag]: ExprTag,
    _tag: "lt",
    left: toOperand(left),
    right: toOperand(right),
  }),
  lte: (left, right) => ({
    [ExprTag]: ExprTag,
    _tag: "lte",
    left: toOperand(left),
    right: toOperand(right),
  }),
  gt: (left, right) => ({
    [ExprTag]: ExprTag,
    _tag: "gt",
    left: toOperand(left),
    right: toOperand(right),
  }),
  gte: (left, right) => ({
    [ExprTag]: ExprTag,
    _tag: "gte",
    left: toOperand(left),
    right: toOperand(right),
  }),
  between: (operand, low, high) => ({
    [ExprTag]: ExprTag,
    _tag: "between",
    operand: toOperand(operand),
    low: toOperand(low),
    high: toOperand(high),
  }),
  isIn: (operand, values) => ({
    [ExprTag]: ExprTag,
    _tag: "in",
    operand: toOperand(operand),
    values: values.map((v) => toOperand(v)),
  }),
  exists: (operand) => ({
    [ExprTag]: ExprTag,
    _tag: "exists",
    operand: toOperand(operand),
  }),
  notExists: (operand) => ({
    [ExprTag]: ExprTag,
    _tag: "notExists",
    operand: toOperand(operand),
  }),
  attributeType: (operand, type) => ({
    [ExprTag]: ExprTag,
    _tag: "type",
    operand: toOperand(operand),
    attributeType: type,
  }),
  beginsWith: (operand, prefix) => ({
    [ExprTag]: ExprTag,
    _tag: "beginsWith",
    operand: toOperand(operand),
    prefix: toOperand(prefix),
  }),
  contains: (operand, value) => ({
    [ExprTag]: ExprTag,
    _tag: "contains",
    operand: toOperand(operand),
    value: toOperand(value),
  }),
  and: (...exprs) => ({
    [ExprTag]: ExprTag,
    _tag: "and",
    exprs,
  }),
  or: (...exprs) => ({
    [ExprTag]: ExprTag,
    _tag: "or",
    exprs,
  }),
  not: (expr) => ({
    [ExprTag]: ExprTag,
    _tag: "not",
    expr,
  }),
})

// ---------------------------------------------------------------------------
// Standalone constructors (untyped, for library-internal use)
// ---------------------------------------------------------------------------

export const eq = (left: unknown, right: unknown): Expr => ({
  [ExprTag]: ExprTag,
  _tag: "eq",
  left: toOperand(left),
  right: toOperand(right),
})

export const ne = (left: unknown, right: unknown): Expr => ({
  [ExprTag]: ExprTag,
  _tag: "ne",
  left: toOperand(left),
  right: toOperand(right),
})

export const and = (...exprs: ReadonlyArray<Expr>): Expr => ({
  [ExprTag]: ExprTag,
  _tag: "and",
  exprs,
})

export const or = (...exprs: ReadonlyArray<Expr>): Expr => ({
  [ExprTag]: ExprTag,
  _tag: "or",
  exprs,
})

export const not = (expr: Expr): Expr => ({
  [ExprTag]: ExprTag,
  _tag: "not",
  expr,
})

// ---------------------------------------------------------------------------
// Operands in the form the attribute holds (#242)
// ---------------------------------------------------------------------------

/**
 * A condition's or filter's operand as the attribute at the path `segments` (domain names) holds
 * it: the value there (`"value"`), or what `contains` compares, an element of what's stored there
 * (`"contained"`: an element of a list, a member of a set, a substring of text). `value` itself
 * where the schema alone doesn't determine the stored form, or the path's schema doesn't take it.
 * Each entity supplies its own (`Entity._storedFormAt`, the path encoder's `operand`); an
 * aggregate its root's.
 */
export type StoredFormAt = (
  segments: ReadonlyArray<string | number>,
  value: unknown,
  kind: "value" | "contained",
) => unknown

/**
 * An instance a write puts into a form of its own: one of Effect's (a `DateTime`, a zone, a
 * `Duration`, a `BigDecimal`, a `Redacted`, an `Option`, …: an object whose prototype carries one
 * of Effect's markers, `~effect/…`) or a `Date`. The map DynamoDB hands back for one of Effect's
 * carries its marker as its own, so it isn't one. Reads the value's prototype once, and property
 * names of the prototypes above it, never a value.
 */
const isInstanceOperand = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  for (
    let at = Object.getPrototypeOf(value);
    at !== null && at !== Object.prototype;
    at = Object.getPrototypeOf(at)
  ) {
    if (at === Date.prototype) return true
    if (Object.getOwnPropertyNames(at).some((key) => key.startsWith("~effect/"))) return true
  }
  return false
}

/**
 * One operand compared with the attribute at `segments`, in the form it holds there (#242): an
 * instance ({@link isInstanceOperand}) as `storedAt` gives it, and any other value as given. Every
 * operand position goes through it: {@link operandsAsStored} for an expression, a vector search's
 * equality filters for theirs.
 */
export const operandAsStored = (
  storedAt: StoredFormAt,
  segments: ReadonlyArray<string | number>,
  value: unknown,
  kind: "value" | "contained",
): unknown => (isInstanceOperand(value) ? storedAt(segments, value, kind) : value)

/**
 * A condition's or filter's operands in the form the attribute each is compared with holds
 * (#242). An operand that is one of Effect's instances or a `Date` is sent as `storedAt` gives it
 * for the path it's compared with: what a write of it there stores. It was sent as the instance's
 * map, which no row holds where the field stores the value another way: `eq(t.at, at)` on a
 * `Schema.DateTimeZoned` compared that map with the ISO text the row holds, and never matched.
 * A comparison, `between` and `in` compare the path's value; `contains` an element of it. Where
 * the schema alone doesn't determine the stored form, `storedAt` hands the operand back and it is
 * sent as 1.40.0 sent it. Every other operand (a primitive, a plain object or list, even one
 * holding instances, one compared with no path, a `begins_with` prefix) is sent as given, and an
 * expression holding none is returned as it is.
 */
export const operandsAsStored = (expr: Expr, storedAt: StoredFormAt): Expr => {
  const asStored = (
    operand: Operand,
    path: Operand | undefined,
    kind: "value" | "contained",
  ): Operand => {
    if (path?._tag !== "path" || operand._tag !== "value") return operand
    const stored = operandAsStored(storedAt, path.segments, operand.value, kind)
    return Object.is(stored, operand.value) ? operand : { _tag: "value", value: stored }
  }
  const same = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean =>
    a.every((item, at) => item === b[at])
  switch (expr._tag) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const left = asStored(expr.left, expr.right, "value")
      const right = asStored(expr.right, expr.left, "value")
      return left === expr.left && right === expr.right ? expr : { ...expr, left, right }
    }
    case "between": {
      const low = asStored(expr.low, expr.operand, "value")
      const high = asStored(expr.high, expr.operand, "value")
      return low === expr.low && high === expr.high ? expr : { ...expr, low, high }
    }
    case "in": {
      const values = expr.values.map((value) => asStored(value, expr.operand, "value"))
      return same(values, expr.values) ? expr : { ...expr, values }
    }
    case "contains": {
      const value = asStored(expr.value, expr.operand, "contained")
      return value === expr.value ? expr : { ...expr, value }
    }
    case "and":
    case "or": {
      const exprs = expr.exprs.map((part) => operandsAsStored(part, storedAt))
      return same(exprs, expr.exprs) ? expr : { ...expr, exprs }
    }
    case "not": {
      const inner = operandsAsStored(expr.expr, storedAt)
      return inner === expr.expr ? expr : { ...expr, expr: inner }
    }
    default:
      return expr
  }
}

/**
 * The operands a compiled condition (`Expression.condition`) compares with a field, kept on it
 * under this key, not enumerable (#236): each value placeholder with the attribute name it was
 * built for and the value as given. The builder has no entity; `Transaction.check` has one, and
 * sends each operand in the form its field stores it ({@link operandAsStored}).
 */
export const ComparedOperandsKey: unique symbol = Symbol.for(
  "effect-dynamodb/Expression/ComparedOperands",
)

export type ComparedOperand = {
  readonly placeholder: string
  readonly name: string
  readonly value: unknown
}

/** The operands a compiled condition carries, if it was built by `Expression.condition`. */
export const comparedOperandsOf = (result: object): ReadonlyArray<ComparedOperand> | undefined =>
  Object.getOwnPropertyDescriptor(result, ComparedOperandsKey)?.value as
    | ReadonlyArray<ComparedOperand>
    | undefined

// ---------------------------------------------------------------------------
// Compiler — convert Expr ADT to DynamoDB expression string
// ---------------------------------------------------------------------------

export interface CompileResult {
  readonly expression: string
  readonly names: globalThis.Record<string, string>
  readonly values: globalThis.Record<string, AttributeValue>
}

/**
 * Compile an Expr node to a DynamoDB expression string with name/value placeholders.
 */
export const compileExpr = (
  expr: Expr,
  resolveDbName?: (name: string) => string,
  below?: StoredBelow,
): CompileResult => {
  // Every user-facing entry point refuses these with a `ValidationError`
  // before compiling (#133); reaching here with one is a library bug, and
  // compiling it would silently send a widened or invalid expression.
  const problem = emptyPartProblem(expr)
  if (problem !== undefined) {
    throw new Error(`compileExpr: ${problem} (refuse it with emptyPartProblem before compiling)`)
  }
  const names: globalThis.Record<string, string> = {}
  const values: globalThis.Record<string, AttributeValue> = {}
  const counter = { value: 0 }

  const compileOperand = (op: Operand): string => {
    switch (op._tag) {
      case "path":
        return compilePath(op.segments, names, "e", counter, resolveDbName, below)
      case "value": {
        const key = `:e${counter.value++}`
        values[key] = toAttributeValue(op.value)
        return key
      }
      case "size":
        return `size(${compilePath(op.segments, names, "e", counter, resolveDbName, below)})`
    }
  }

  const compile = (node: Expr): string => {
    switch (node._tag) {
      case "eq":
      case "ne":
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const ops = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const
        // DynamoDB has no empty set: a row holding one is a row without the attribute.
        const emptySide = isEmptySetOperand(node.left) || isEmptySetOperand(node.right)
        if (emptySide && (node._tag === "eq" || node._tag === "ne")) {
          const other = isEmptySetOperand(node.left) ? node.right : node.left
          const test = node._tag === "eq" ? "attribute_not_exists" : "attribute_exists"
          return `${test}(${compileOperand(other)})`
        }
        return `${compileOperand(node.left)} ${ops[node._tag]} ${compileOperand(node.right)}`
      }
      case "between":
        return `${compileOperand(node.operand)} BETWEEN ${compileOperand(node.low)} AND ${compileOperand(node.high)}`
      // No values compiles to `IN ()`, which DynamoDB rejects; the rejection
      // is diagnosed, naming the `isIn()` (#144).
      case "in": {
        const vals = node.values.map(compileOperand).join(", ")
        return `${compileOperand(node.operand)} IN (${vals})`
      }
      case "exists":
        return `attribute_exists(${compileOperand(node.operand)})`
      case "notExists":
        return `attribute_not_exists(${compileOperand(node.operand)})`
      case "type": {
        const pathStr = compileOperand(node.operand)
        const typeKey = `:e${counter.value++}`
        values[typeKey] = toAttributeValue(node.attributeType)
        return `attribute_type(${pathStr}, ${typeKey})`
      }
      case "beginsWith":
        return `begins_with(${compileOperand(node.operand)}, ${compileOperand(node.prefix)})`
      case "contains":
        return `contains(${compileOperand(node.operand)}, ${compileOperand(node.value)})`
      // An empty part (`and()`, a `{}` shorthand) directly under `and` is no
      // condition: it is left out, never compiled to `()`, which DynamoDB
      // rejects (#133). Under `or` or `not` it has no meaning that would not
      // widen the expression — `emptyPartProblem` refuses it, above.
      case "and": {
        const parts = node.exprs.map((e) => compile(e)).filter((part) => part !== "")
        if (parts.length === 0) return ""
        if (parts.length === 1) return parts[0]!
        return parts.map((part) => `(${part})`).join(" AND ")
      }
      case "or": {
        const parts = node.exprs.map((e) => compile(e))
        if (parts.length === 1) return parts[0]!
        return parts.map((part) => `(${part})`).join(" OR ")
      }
      case "not":
        return `NOT (${compile(node.expr)})`
    }
  }

  return { expression: compile(expr), names, values }
}

// ---------------------------------------------------------------------------
// Empty parts (#133)
// ---------------------------------------------------------------------------

/**
 * Whether an expression asserts nothing: `and()` — a `{}` shorthand — or an
 * `and` of only such parts. A whole condition or filter that is empty is no
 * condition, and an empty part directly under `and` is left out.
 */
export const isEmptyExpr = (expr: Expr): boolean =>
  expr._tag === "and" && expr.exprs.every((part) => isEmptyExpr(part))

/**
 * Why an expression cannot be sent, or `undefined`: an empty part anywhere but
 * directly under `and` or as the whole expression (#133). `or(x, {})` and
 * `not({})` have no reading that does not widen what the caller wrote — `{}`
 * asserts nothing, so `or(x, {})` would match everything and `not({})`
 * nothing — and `or()` with no parts matches nothing at all. Each is refused
 * with a `ValidationError` before anything is sent, never dropped.
 *
 * An operand naming the path builder itself (`t`, or `t.size()`) names the
 * whole item, not an attribute, and would compile to an empty name: refused
 * the same way (`EDD-9149`, #238).
 *
 * An `isIn()` with no values is not refused here (#144): it compiles to
 * `IN ()`, which DynamoDB rejects as a syntax error, and the rejection is
 * diagnosed (`internal/WriteDiagnosis.ts`, `EmptyIn`) naming the attribute.
 */
export const emptyPartProblem = (expr: Expr): string | undefined => {
  switch (expr._tag) {
    case "and": {
      for (const part of expr.exprs) {
        const problem = emptyPartProblem(part)
        if (problem !== undefined) return problem
      }
      return undefined
    }
    case "or": {
      if (expr.exprs.length === 0) {
        return "or() has no parts — it would match nothing. Give it at least one condition."
      }
      for (const part of expr.exprs) {
        if (isEmptyExpr(part)) {
          return (
            "an empty part ({} or and()) under or() would match everything. " +
            "Remove it, or give it a condition."
          )
        }
        const problem = emptyPartProblem(part)
        if (problem !== undefined) return problem
      }
      return undefined
    }
    case "not":
      if (isEmptyExpr(expr.expr)) {
        return (
          "not() of an empty part ({} or and()) would match nothing. " +
          "Remove it, or give it a condition."
        )
      }
      return emptyPartProblem(expr.expr)
    default:
      if (namedOperands(expr).some(namesNoAttribute)) {
        return (
          "a path with no attribute in it (the path builder itself) names the whole item, " +
          "which an expression can't compare. Name an attribute, such as t.status. [EDD-9149]"
        )
      }
      return emptySetOperands(expr).some(isEmptySetOperand)
        ? "DynamoDB has no empty set, so a row holding one is a row without the attribute. " +
            "Only eq() and ne() can compare with one, by whether the attribute exists. [EDD-9124]"
        : unstorableOperandProblem(expr)
  }
}

/** A value a comparison holds that DynamoDB can't store: compiling it would throw. */
const unstorableOperandProblem = (expr: Expr): string | undefined => {
  const operands = comparedOperands(expr)
  for (const operand of operands) {
    if (operand._tag !== "value") continue
    const unstorable = unstorableIn({ value: operand.value })
    if (unstorable === undefined) continue
    const named = operands.find((other) => other._tag === "path")
    const field = named === undefined ? "a value" : `"${named.segments.join(".")}"`
    return `Comparing ${field} with a value DynamoDB can't store: ${unstorable.describe()}`
  }
  return undefined
}

/** Whether an operand is an empty set, which marshals to nothing. */
const isEmptySetOperand = (operand: Operand): boolean =>
  operand._tag === "value" && isEmptySet(operand.value)

/** The operands of a comparison. */
const comparedOperands = (expr: Expr): ReadonlyArray<Operand> => {
  switch (expr._tag) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return [expr.left, expr.right]
    case "between":
      return [expr.operand, expr.low, expr.high]
    case "in":
      return [expr.operand, ...expr.values]
    case "beginsWith":
      return [expr.operand, expr.prefix]
    case "contains":
      return [expr.operand, expr.value]
    default:
      return []
  }
}

/** Every operand a leaf expression names: a comparison's, and an existence or type test's. */
const namedOperands = (expr: Expr): ReadonlyArray<Operand> =>
  expr._tag === "exists" || expr._tag === "notExists" || expr._tag === "type"
    ? [expr.operand]
    : comparedOperands(expr)

/** Whether an operand is a path (or its size) with no segment: the item itself. */
const namesNoAttribute = (operand: Operand): boolean =>
  operand._tag !== "value" && operand.segments.length === 0

/** The operands that can't take an empty set: `eq` and `ne` compile it to an existence test. */
const emptySetOperands = (expr: Expr): ReadonlyArray<Operand> =>
  expr._tag === "eq" || expr._tag === "ne" ? [] : comparedOperands(expr)

/**
 * The two places a row can hold what one path names (#238): `whole` where the row holds the
 * attribute `holder` names, `entries` where it doesn't. Both paths, and `holder`, as a path the
 * expression names (a field's domain name first).
 */
export interface PathForms {
  readonly holder: ReadonlyArray<string | number>
  readonly whole: ReadonlyArray<string | number>
  readonly entries: ReadonlyArray<string | number>
}

/** An expression with each operand replaced by `f` of it. */
const mapOperands = (expr: Expr, f: (operand: Operand) => Operand): Expr => {
  switch (expr._tag) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return { ...expr, left: f(expr.left), right: f(expr.right) }
    case "between":
      return { ...expr, operand: f(expr.operand), low: f(expr.low), high: f(expr.high) }
    case "in":
      return { ...expr, operand: f(expr.operand), values: expr.values.map(f) }
    case "exists":
    case "notExists":
    case "type":
      return { ...expr, operand: f(expr.operand) }
    case "beginsWith":
      return { ...expr, operand: f(expr.operand), prefix: f(expr.prefix) }
    case "contains":
      return { ...expr, operand: f(expr.operand), value: f(expr.value) }
    case "and":
    case "or":
    case "not":
      return expr
  }
}

/**
 * An expression with each condition naming a path a row can hold in two places ({@link PathForms})
 * asked of both, each beside the test that tells which one the row holds (#238):
 * `(attribute_exists(sr) AND sr.a = :v) OR (attribute_not_exists(sr) AND counts#a = :v)`. A row
 * holds one of the two, so the condition is the one the caller wrote, asked where that row holds
 * the value, and `not()` of it the negation. A condition naming no such path is returned as it is.
 */
export const splitByForms = (
  expr: Expr,
  formsOf: (segments: ReadonlyArray<string | number>) => PathForms | undefined,
): Expr => {
  switch (expr._tag) {
    // Unchanged, the same expression: a caller can tell it names no such path.
    case "and":
    case "or": {
      const exprs = expr.exprs.map((part) => splitByForms(part, formsOf))
      return exprs.every((part, i) => part === expr.exprs[i]) ? expr : { ...expr, exprs }
    }
    case "not": {
      const inner = splitByForms(expr.expr, formsOf)
      return inner === expr.expr ? expr : { ...expr, expr: inner }
    }
    default: {
      const holders = new Map<string, ReadonlyArray<string | number>>()
      for (const operand of namedOperands(expr)) {
        if (operand._tag === "value") continue
        const forms = formsOf(operand.segments)
        if (forms !== undefined) holders.set(JSON.stringify(forms.holder), forms.holder)
      }
      if (holders.size === 0) return expr
      // Every way the row can hold them: each holder present (whole) or absent (entries).
      const keys = [...holders.keys()]
      const branches: Array<Expr> = []
      for (let mask = 0; mask < 2 ** keys.length; mask++) {
        const whole = (key: string) => (mask & (1 << keys.indexOf(key))) === 0
        const tests = keys.map(
          (key): Expr => ({
            [ExprTag]: ExprTag,
            _tag: whole(key) ? "exists" : "notExists",
            operand: { _tag: "path", segments: holders.get(key)! },
          }),
        )
        const asked = mapOperands(expr, (operand) => {
          if (operand._tag === "value") return operand
          const forms = formsOf(operand.segments)
          if (forms === undefined) return operand
          return {
            ...operand,
            segments: whole(JSON.stringify(forms.holder)) ? forms.whole : forms.entries,
          }
        })
        branches.push({ [ExprTag]: ExprTag, _tag: "and", exprs: [...tests, asked] })
      }
      return { [ExprTag]: ExprTag, _tag: "or", exprs: branches }
    }
  }
}

/** A condition or filter as an `Expr`: shorthand records are parsed. */
export const toExpr = (cond: Expr | ConditionInput): Expr =>
  isExpr(cond) ? cond : parseShorthand(cond)

/**
 * The one place an empty condition becomes no condition (#133): a whole
 * condition that asserts nothing (`{}`, `and()`) is `undefined`; anything
 * else — including one `emptyPartProblem` will refuse — is kept as given.
 */
export const nonEmptyCondition = <C extends Expr | ConditionInput>(
  cond: C | undefined,
): C | undefined => (cond === undefined || isEmptyExpr(toExpr(cond)) ? undefined : cond)

// ---------------------------------------------------------------------------
// Shorthand parser — convert ConditionInput-like objects to Expr
// ---------------------------------------------------------------------------

/**
 * Convert a ConditionInput shorthand object to an Expr ADT node.
 */
export const parseShorthand = (input: ConditionInput): Expr => {
  const exprs: Array<Expr> = []

  const pathOp = (path: string): Operand => ({ _tag: "path", segments: [path] })
  const valOp = (v: unknown): Operand => ({ _tag: "value", value: v })

  const comparison = (
    tag: "eq" | "ne" | "lt" | "lte" | "gt" | "gte",
    attrs: globalThis.Record<string, unknown>,
  ) => {
    for (const [attr, val] of Object.entries(attrs)) {
      exprs.push({
        [ExprTag]: ExprTag,
        _tag: tag,
        left: pathOp(attr),
        right: valOp(val),
      })
    }
  }

  if (input.eq) comparison("eq", input.eq)
  if (input.ne) comparison("ne", input.ne)
  if (input.lt) comparison("lt", input.lt)
  if (input.le) comparison("lte", input.le)
  if (input.gt) comparison("gt", input.gt)
  if (input.ge) comparison("gte", input.ge)

  if (input.between) {
    for (const [attr, [low, high]] of Object.entries(input.between)) {
      exprs.push({
        [ExprTag]: ExprTag,
        _tag: "between",
        operand: pathOp(attr),
        low: valOp(low),
        high: valOp(high),
      })
    }
  }

  if (input.beginsWith) {
    for (const [attr, prefix] of Object.entries(input.beginsWith)) {
      exprs.push({
        [ExprTag]: ExprTag,
        _tag: "beginsWith",
        operand: pathOp(attr),
        prefix: valOp(prefix),
      })
    }
  }

  if (input.attributeExists) {
    const attrs = Array.isArray(input.attributeExists)
      ? input.attributeExists
      : [input.attributeExists]
    for (const attr of attrs) {
      exprs.push({
        [ExprTag]: ExprTag,
        _tag: "exists",
        operand: pathOp(attr),
      })
    }
  }

  if (input.attributeNotExists) {
    const attrs = Array.isArray(input.attributeNotExists)
      ? input.attributeNotExists
      : [input.attributeNotExists]
    for (const attr of attrs) {
      exprs.push({
        [ExprTag]: ExprTag,
        _tag: "notExists",
        operand: pathOp(attr),
      })
    }
  }

  if (exprs.length === 0) return { [ExprTag]: ExprTag, _tag: "and", exprs: [] }
  if (exprs.length === 1) return exprs[0]!
  return { [ExprTag]: ExprTag, _tag: "and", exprs }
}

// ---------------------------------------------------------------------------
// Condition shorthand — simple object syntax for AND-only conditions
// ---------------------------------------------------------------------------

/**
 * A simplified condition shorthand where keys are attribute names and values
 * are equality matches. Example: `{ status: "active", role: "admin" }`
 */
export type ConditionShorthand = globalThis.Record<string, unknown>

/**
 * Parse a simple shorthand object into an Expr. Each key-value pair becomes
 * an equality comparison, ANDed together.
 */
export const parseSimpleShorthand = (input: ConditionShorthand): Expr => {
  const exprs: Array<Expr> = []
  for (const [attr, val] of Object.entries(input)) {
    if (val === undefined) continue
    exprs.push({
      [ExprTag]: ExprTag,
      _tag: "eq",
      left: { _tag: "path", segments: [attr] },
      right: { _tag: "value", value: val },
    })
  }
  if (exprs.length === 0) return { [ExprTag]: ExprTag, _tag: "and", exprs: [] }
  if (exprs.length === 1) return exprs[0]!
  return { [ExprTag]: ExprTag, _tag: "and", exprs }
}
