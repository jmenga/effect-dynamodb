/**
 * @internal Expr — Expression ADT for type-safe DynamoDB condition/filter expressions.
 *
 * Provides a discriminated union of expression nodes that compile to DynamoDB
 * ConditionExpression / FilterExpression strings with attribute name/value placeholders.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { ConditionInput } from "../Expression.js"
import { toAttributeValue } from "../Marshaller.js"
import { compilePath, type Path, PathTag, type SizeOperand } from "./PathBuilder.js"

// ---------------------------------------------------------------------------
// Operand — either a path reference, a literal value, or a size() function
// ---------------------------------------------------------------------------

export type Operand =
  | { readonly _tag: "path"; readonly segments: ReadonlyArray<string | number> }
  | { readonly _tag: "value"; readonly value: unknown }
  | { readonly _tag: "size"; readonly segments: ReadonlyArray<string | number> }

/** Convert a Path, SizeOperand, or raw value to an Operand */
const toOperand = (v: unknown): Operand => {
  if (typeof v === "object" && v !== null) {
    if (PathTag in v) {
      return { _tag: "path", segments: (v as Path).segments }
    }
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
  readonly exists: (operand: Path<Model, any>) => Expr
  readonly notExists: (operand: Path<Model, any>) => Expr
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
): CompileResult => {
  const names: globalThis.Record<string, string> = {}
  const values: globalThis.Record<string, AttributeValue> = {}
  const counter = { value: 0 }

  const compileOperand = (op: Operand): string => {
    switch (op._tag) {
      case "path":
        return compilePath(op.segments, names, "e", counter, resolveDbName)
      case "value": {
        const key = `:e${counter.value++}`
        values[key] = toAttributeValue(op.value)
        return key
      }
      case "size":
        return `size(${compilePath(op.segments, names, "e", counter, resolveDbName)})`
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
        return `${compileOperand(node.left)} ${ops[node._tag]} ${compileOperand(node.right)}`
      }
      case "between":
        return `${compileOperand(node.operand)} BETWEEN ${compileOperand(node.low)} AND ${compileOperand(node.high)}`
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
      case "and": {
        if (node.exprs.length === 0) return ""
        if (node.exprs.length === 1) return compile(node.exprs[0]!)
        return node.exprs.map((e) => `(${compile(e)})`).join(" AND ")
      }
      case "or": {
        if (node.exprs.length === 0) return ""
        if (node.exprs.length === 1) return compile(node.exprs[0]!)
        return node.exprs.map((e) => `(${compile(e)})`).join(" OR ")
      }
      case "not":
        return `NOT (${compile(node.expr)})`
    }
  }

  return { expression: compile(expr), names, values }
}

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
