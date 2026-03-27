import type ts from "typescript"
import type { ResolvedCollection, ResolvedEntity } from "./EntityResolver"

export type OperationType =
  | "get"
  | "put"
  | "create"
  | "update"
  | "delete"
  | "query"
  | "scan"
  | "entity-query-accessor"
  | "collection-accessor"
  | "bound-query-terminal"
  | "table-accessor"

export interface WhereCondition {
  readonly op: "eq" | "lt" | "lte" | "gt" | "gte" | "beginsWith" | "between"
  readonly field: string
  readonly value: string
  readonly value2?: string // for between
}

export interface DetectedOperation {
  readonly entity?: ResolvedEntity | undefined
  readonly type: OperationType
  readonly indexName?: string | undefined
  readonly arguments?: Record<string, unknown> | undefined
  readonly updateCombinators?: UpdateCombinators | undefined
  readonly whereCondition?: WhereCondition | undefined
  // v2 fields
  readonly collection?: ResolvedCollection | undefined
  readonly collectionName?: string | undefined
  readonly terminalName?: string | undefined
  readonly tableName?: string | undefined
}

export interface UpdateCombinators {
  readonly set?: Record<string, unknown> | undefined
  readonly remove?: ReadonlyArray<string> | undefined
  readonly add?: Record<string, number> | undefined
  readonly subtract?: Record<string, number> | undefined
  readonly append?: Record<string, ReadonlyArray<unknown>> | undefined
  readonly deleteFromSet?: Record<string, unknown> | undefined
  readonly expectedVersion?: number | undefined
  readonly condition?: unknown
}

export function detectOperation(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  position: number,
  entities: ReadonlyArray<ResolvedEntity>,
  collections: ReadonlyArray<ResolvedCollection> = [],
): DetectedOperation | undefined {
  const token = findTokenAtPosition(ts, sourceFile, position)
  if (!token) return undefined

  // Walk up from the token to find the operation-relevant call
  let node: ts.Node = token

  // Try to detect from current node and parents
  while (node) {
    // Try v2 patterns first (more specific), then fall back to v1
    const v2Result = tryDetectV2Pattern(ts, node, entities, collections)
    if (v2Result) return v2Result

    const result = tryDetectFromNode(ts, node, entities)
    if (result) return result
    if (node === sourceFile) break
    node = node.parent
  }

  return undefined
}

function findTokenAtPosition(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  position: number,
): ts.Node | undefined {
  function find(node: ts.Node): ts.Node | undefined {
    if (position < node.getStart(sourceFile) || position >= node.getEnd()) {
      return undefined
    }
    const child = ts.forEachChild(node, find)
    return child ?? node
  }
  return find(sourceFile)
}

// ---------------------------------------------------------------------------
// V2 pattern detection — db.entities.*, db.collections.*, BoundQuery terminals
// ---------------------------------------------------------------------------

function tryDetectV2Pattern(
  ts: typeof import("typescript"),
  node: ts.Node,
  entities: ReadonlyArray<ResolvedEntity>,
  collections: ReadonlyArray<ResolvedCollection>,
): DetectedOperation | undefined {
  // Only process call expressions and property access expressions
  if (!ts.isCallExpression(node) && !ts.isPropertyAccessExpression(node)) return undefined

  // For call expressions, check the callee chain
  const callNode = ts.isCallExpression(node) ? node : undefined
  const accessNode = callNode
    ? ts.isPropertyAccessExpression(callNode.expression)
      ? callNode.expression
      : undefined
    : ts.isPropertyAccessExpression(node)
      ? node
      : undefined

  if (!accessNode) return undefined

  // Walk the property access chain to build the path
  const chain = buildPropertyAccessChain(ts, accessNode)

  // Pattern 1: db.entities.Tasks.byProject(...) — 4+ segments: [db, entities, Tasks, byProject]
  if (chain.length >= 4 && chain[1] === "entities" && callNode) {
    const entityName = chain[2]!
    const accessorName = chain[3]!
    const entity = findEntity(entityName, entities)

    if (entity) {
      // Check if accessorName matches a collection name
      const collection = collections.find((c) => c.collectionName === accessorName)
      if (collection) {
        const args =
          callNode.arguments.length > 0 ? extractCallArgs(ts, callNode.arguments[0]!) : undefined
        return {
          entity,
          type: "entity-query-accessor",
          collection,
          collectionName: accessorName,
          arguments: args,
        }
      }

      // Check for scan()
      if (accessorName === "scan") {
        return { entity, type: "scan" }
      }

      // Check for CRUD methods via entities namespace: db.entities.Users.get(...)
      const opType = methodToOpType(accessorName)
      if (opType) {
        const args =
          callNode.arguments.length > 0 ? extractCallArgs(ts, callNode.arguments[0]!) : undefined
        const updateCombs = opType === "update" ? extractUpdateCombinators(ts, callNode) : undefined
        return { entity, type: opType, arguments: args, updateCombinators: updateCombs }
      }

      // Check for entity index accessor: db.entities.Tasks.byProject(...)
      // Matches any non-primary index name defined on the entity
      if (entity.indexes[accessorName] && accessorName !== "primary") {
        const args =
          callNode.arguments.length > 0 ? extractCallArgs(ts, callNode.arguments[0]!) : undefined
        return {
          entity,
          type: "entity-query-accessor",
          indexName: accessorName,
          arguments: args,
        }
      }
    }
  }

  // Pattern 2: db.collections.Assignments(...) — 3+ segments: [db, collections, Assignments]
  if (chain.length >= 3 && chain[1] === "collections" && callNode) {
    const collectionVarName = chain[2]!
    const collection = collections.find((c) => c.variableName === collectionVarName)
    if (collection) {
      const args =
        callNode.arguments.length > 0 ? extractCallArgs(ts, callNode.arguments[0]!) : undefined
      return {
        type: "collection-accessor",
        collection,
        collectionName: collection.collectionName,
        arguments: args,
      }
    }
  }

  // Pattern 3: BoundQuery terminals — .collect(), .fetch(), .paginate(), .count() on a chain
  if (callNode && chain.length >= 1) {
    const terminalName = chain[chain.length - 1]
    if (
      terminalName === "collect" ||
      terminalName === "fetch" ||
      terminalName === "paginate" ||
      terminalName === "count"
    ) {
      // Walk up to find if this is chained on an entity accessor or collection accessor
      const parentOp = tryDetectV2ChainRoot(ts, accessNode.expression, entities, collections)
      if (parentOp) {
        return {
          ...parentOp,
          type: "bound-query-terminal",
          terminalName,
        }
      }
    }
  }

  // Pattern 4: db.tables.TableName — 3 segments: [db, tables, TableName]
  if (chain.length >= 3 && chain[1] === "tables") {
    const tableName = chain[2]!
    return { type: "table-accessor", tableName }
  }

  return undefined
}

/**
 * Build a property access chain from a PropertyAccessExpression.
 * e.g., `db.entities.Tasks.byProject` → ["db", "entities", "Tasks", "byProject"]
 */
function buildPropertyAccessChain(
  ts: typeof import("typescript"),
  node: ts.Expression,
): ReadonlyArray<string> {
  const parts: string[] = []
  let current: ts.Expression = node
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text)
    current = current.expression
  }
  if (ts.isIdentifier(current)) {
    parts.unshift(current.text)
  }
  return parts
}

/**
 * Try to find the root of a BoundQuery chain (entity accessor or collection accessor).
 */
function tryDetectV2ChainRoot(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  entities: ReadonlyArray<ResolvedEntity>,
  collections: ReadonlyArray<ResolvedCollection>,
): DetectedOperation | undefined {
  // If it's a call expression, recurse into it
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression
    if (ts.isPropertyAccessExpression(callee)) {
      const chain = buildPropertyAccessChain(ts, callee)

      // db.entities.Tasks.byProject(...)
      if (chain.length >= 4 && chain[1] === "entities") {
        const entityName = chain[2]!
        const accessorName = chain[3]!
        const entity = findEntity(entityName, entities)
        if (entity) {
          const collection = collections.find((c) => c.collectionName === accessorName)
          if (collection) {
            const args =
              expr.arguments.length > 0 ? extractCallArgs(ts, expr.arguments[0]!) : undefined
            return {
              entity,
              type: "entity-query-accessor",
              collection,
              collectionName: accessorName,
              arguments: args,
            }
          }
          if (accessorName === "scan") {
            return { entity, type: "scan" }
          }
          // Entity index accessor (no collection match needed)
          if (entity.indexes[accessorName] && accessorName !== "primary") {
            const args =
              expr.arguments.length > 0 ? extractCallArgs(ts, expr.arguments[0]!) : undefined
            return {
              entity,
              type: "entity-query-accessor",
              indexName: accessorName,
              arguments: args,
            }
          }
        }
      }

      // db.collections.Assignments(...)
      if (chain.length >= 3 && chain[1] === "collections") {
        const collectionVarName = chain[2]!
        const collection = collections.find((c) => c.variableName === collectionVarName)
        if (collection) {
          const args =
            expr.arguments.length > 0 ? extractCallArgs(ts, expr.arguments[0]!) : undefined
          return {
            type: "collection-accessor",
            collection,
            collectionName: collection.collectionName,
            arguments: args,
          }
        }
      }

      // Intermediate chain: .limit(10).collect() → try the chain's own parent
      const methodName = chain[chain.length - 1]
      if (methodName === "where") {
        // Extract .where() condition and attach to the root operation
        const rootOp = tryDetectV2ChainRoot(ts, callee.expression, entities, collections)
        if (rootOp && expr.arguments.length > 0) {
          const whereCondition = extractWhereCondition(ts, expr.arguments[0]!)
          if (whereCondition) return { ...rootOp, whereCondition }
        }
        return rootOp
      }
      if (
        methodName === "limit" ||
        methodName === "reverse" ||
        methodName === "filter" ||
        methodName === "select" ||
        methodName === "maxPages" ||
        methodName === "startFrom" ||
        methodName === "consistentRead" ||
        methodName === "ignoreOwnership"
      ) {
        return tryDetectV2ChainRoot(ts, callee.expression, entities, collections)
      }
    }
  }

  // If it's a property access on a call (chaining through a combinator result)
  if (ts.isPropertyAccessExpression(expr)) {
    return tryDetectV2ChainRoot(ts, expr.expression, entities, collections)
  }

  return undefined
}

function tryDetectFromNode(
  ts: typeof import("typescript"),
  node: ts.Node,
  entities: ReadonlyArray<ResolvedEntity>,
): DetectedOperation | undefined {
  // Case 1: Direct entity operation — Users.get(...), Users.put(...), etc.
  if (ts.isCallExpression(node)) {
    return tryDetectDirectCall(ts, node, entities)
  }

  // Case 2: We're on an identifier that's part of a property access
  if (ts.isIdentifier(node) && node.parent) {
    // Check if parent is a property access that's part of a call
    if (ts.isPropertyAccessExpression(node.parent)) {
      const callExpr = node.parent.parent
      if (callExpr && ts.isCallExpression(callExpr)) {
        return tryDetectDirectCall(ts, callExpr, entities)
      }
      // Check if grandparent property access is part of a call (Entity.query.byIndex())
      const grandParent = node.parent.parent
      if (grandParent && ts.isPropertyAccessExpression(grandParent)) {
        const outerCall = grandParent.parent
        if (outerCall && ts.isCallExpression(outerCall)) {
          return tryDetectDirectCall(ts, outerCall, entities)
        }
      }
    }
  }

  return undefined
}

function tryDetectDirectCall(
  ts: typeof import("typescript"),
  call: ts.CallExpression,
  entities: ReadonlyArray<ResolvedEntity>,
): DetectedOperation | undefined {
  const callee = call.expression

  // Pattern: <Entity>.scan()
  if (ts.isPropertyAccessExpression(callee)) {
    const methodName = callee.name.text
    const target = callee.expression

    // Direct method: Users.get(...), Users.put(...), etc.
    // Also handles typed client: db.Users.get(...), db.Users.put(...), etc.
    const entityName = resolveEntityName(ts, target)
    if (entityName) {
      const entity = findEntity(entityName, entities)
      if (entity) {
        const opType = methodToOpType(methodName)
        if (opType) {
          const args =
            call.arguments.length > 0 ? extractCallArgs(ts, call.arguments[0]!) : undefined
          const updateCombs = opType === "update" ? extractUpdateCombinators(ts, call) : undefined
          return { entity, type: opType, arguments: args, updateCombinators: updateCombs }
        }

        // scan() is on the entity directly
        if (methodName === "scan") {
          return { entity, type: "scan" }
        }

        // collect/paginate: db.Entity.collect(Entity.query.index(pk), ...)
        if ((methodName === "collect" || methodName === "paginate") && call.arguments.length > 0) {
          const queryArg = call.arguments[0]!
          if (ts.isCallExpression(queryArg)) {
            return tryDetectDirectCall(ts, queryArg, entities)
          }
        }
      }
    }

    // Query pattern: Users.query.byRole(...)
    if (ts.isPropertyAccessExpression(target)) {
      const indexName = methodName // byRole, byUser, etc.
      const queryProp = target.name.text // "query"
      const entityId = target.expression

      if (queryProp === "query") {
        const queryEntityName = resolveEntityName(ts, entityId)
        if (queryEntityName) {
          const entity = findEntity(queryEntityName, entities)
          if (entity) {
            const args =
              call.arguments.length > 0 ? extractCallArgs(ts, call.arguments[0]!) : undefined
            return { entity, type: "query", indexName, arguments: args }
          }
        }
      }
    }
  }

  return undefined
}

/**
 * Extract the entity name from the target expression.
 * Handles both `Users` (identifier) and `db.Users` (property access).
 */
function resolveEntityName(
  ts: typeof import("typescript"),
  node: ts.Expression,
): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

function methodToOpType(name: string): OperationType | undefined {
  switch (name) {
    case "get":
    case "getVersion":
      return "get"
    case "put":
      return "put"
    case "create":
      return "create"
    case "update":
      return "update"
    case "delete":
      return "delete"
    case "scan":
      return "scan"
    default:
      return undefined
  }
}

function findEntity(
  name: string,
  entities: ReadonlyArray<ResolvedEntity>,
): ResolvedEntity | undefined {
  return entities.find((e) => e.variableName === name)
}

function extractCallArgs(
  ts: typeof import("typescript"),
  arg: ts.Expression,
): Record<string, unknown> | undefined {
  if (!ts.isObjectLiteralExpression(arg)) return undefined
  const result: Record<string, unknown> = {}
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    result[prop.name.text] = extractArgValue(ts, prop.initializer)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function extractArgValue(ts: typeof import("typescript"), expr: ts.Expression): unknown {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isNumericLiteral(expr)) return Number(expr.text)
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false
  // For non-literal expressions, return placeholder
  return undefined
}

function extractUpdateCombinators(
  ts: typeof import("typescript"),
  updateCall: ts.CallExpression,
): UpdateCombinators | undefined {
  // Look for .pipe() calls on the update result
  // Pattern: Users.update({ key }).pipe(Users.set({...}), Users.expectedVersion(N))
  let current: ts.Node = updateCall
  while (current.parent) {
    if (ts.isCallExpression(current.parent)) {
      const parentCall = current.parent
      const parentCallee = parentCall.expression
      if (ts.isPropertyAccessExpression(parentCallee) && parentCallee.name.text === "pipe") {
        return parsePipeArgs(ts, parentCall)
      }
    }
    // Also check: used as argument inside .pipe()
    if (ts.isPropertyAccessExpression(current.parent)) {
      const outerCall = current.parent.parent
      if (
        outerCall &&
        ts.isCallExpression(outerCall) &&
        ts.isPropertyAccessExpression(outerCall.expression) &&
        outerCall.expression.name.text === "pipe"
      ) {
        return parsePipeArgs(ts, outerCall)
      }
    }
    current = current.parent
  }
  return undefined
}

function parsePipeArgs(
  ts: typeof import("typescript"),
  pipeCall: ts.CallExpression,
): UpdateCombinators {
  const result: {
    set?: Record<string, unknown>
    remove?: string[]
    add?: Record<string, number>
    subtract?: Record<string, number>
    expectedVersion?: number
  } = {}

  for (const arg of pipeCall.arguments) {
    if (!ts.isCallExpression(arg)) continue
    const callee = arg.expression
    if (!ts.isPropertyAccessExpression(callee)) continue
    const methodName = callee.name.text

    switch (methodName) {
      case "set": {
        if (arg.arguments.length > 0) {
          const setArg = arg.arguments[0]!
          if (ts.isObjectLiteralExpression(setArg)) {
            result.set = {}
            for (const p of setArg.properties) {
              if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                result.set[p.name.text] = extractArgValue(ts, p.initializer)
              }
            }
          }
        }
        break
      }
      case "remove": {
        if (arg.arguments.length > 0) {
          const removeArg = arg.arguments[0]!
          if (ts.isArrayLiteralExpression(removeArg)) {
            result.remove = []
            for (const el of removeArg.elements) {
              if (ts.isStringLiteral(el)) {
                result.remove.push(el.text)
              }
            }
          }
        }
        break
      }
      case "add": {
        if (arg.arguments.length > 0) {
          const addArg = arg.arguments[0]!
          if (ts.isObjectLiteralExpression(addArg)) {
            result.add = {}
            for (const p of addArg.properties) {
              if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                const val = extractArgValue(ts, p.initializer)
                if (typeof val === "number") result.add[p.name.text] = val
              }
            }
          }
        }
        break
      }
      case "subtract": {
        if (arg.arguments.length > 0) {
          const subArg = arg.arguments[0]!
          if (ts.isObjectLiteralExpression(subArg)) {
            result.subtract = {}
            for (const p of subArg.properties) {
              if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                const val = extractArgValue(ts, p.initializer)
                if (typeof val === "number") result.subtract[p.name.text] = val
              }
            }
          }
        }
        break
      }
      case "expectedVersion": {
        if (arg.arguments.length > 0) {
          const versionArg = arg.arguments[0]!
          if (ts.isNumericLiteral(versionArg)) {
            result.expectedVersion = Number(versionArg.text)
          }
        }
        break
      }
    }
  }

  return Object.keys(result).length > 0 ? result : {}
}

/**
 * Extract a WhereCondition from a .where() callback argument.
 * Parses: (t, { beginsWith }) => beginsWith(t.status, "d")
 * Or: (t, { eq }) => eq(t.status, "done")
 */
function extractWhereCondition(
  ts: typeof import("typescript"),
  arg: ts.Expression,
): WhereCondition | undefined {
  // Must be an arrow function or function expression
  let body: ts.Expression | undefined
  if (ts.isArrowFunction(arg)) {
    body = ts.isBlock(arg.body) ? undefined : arg.body
  }
  if (!body || !ts.isCallExpression(body)) return undefined

  // The call should be like: beginsWith(t.field, "value") or eq(t.field, "value")
  const callee = body.expression
  let opName: string | undefined
  if (ts.isIdentifier(callee)) {
    opName = callee.text
  }
  if (!opName) return undefined

  const validOps = new Set(["eq", "lt", "lte", "gt", "gte", "beginsWith", "between"])
  if (!validOps.has(opName)) return undefined

  // First arg: t.field (property access on the first param)
  if (body.arguments.length < 2) return undefined
  const fieldArg = body.arguments[0]!
  let fieldName: string | undefined
  if (ts.isPropertyAccessExpression(fieldArg) && ts.isIdentifier(fieldArg.name)) {
    fieldName = fieldArg.name.text
  }
  if (!fieldName) return undefined

  // Second arg: value (string literal)
  const valueArg = body.arguments[1]!
  const value = extractArgValue(ts, valueArg)
  if (typeof value !== "string") return undefined

  // For between, extract third arg
  if (opName === "between") {
    if (body.arguments.length < 3) return undefined
    const value2Arg = body.arguments[2]!
    const value2 = extractArgValue(ts, value2Arg)
    if (typeof value2 !== "string") return undefined
    return { op: "between", field: fieldName, value, value2 }
  }

  return { op: opName as WhereCondition["op"], field: fieldName, value }
}
