import type ts from "typescript"
import type { ResolvedEntity } from "./EntityResolver"

export type OperationType = "get" | "put" | "create" | "update" | "delete" | "query" | "scan"

export interface DetectedOperation {
  readonly entity: ResolvedEntity
  readonly type: OperationType
  readonly indexName?: string | undefined
  readonly arguments?: Record<string, unknown> | undefined
  readonly updateCombinators?: UpdateCombinators | undefined
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
): DetectedOperation | undefined {
  const token = findTokenAtPosition(ts, sourceFile, position)
  if (!token) return undefined

  // Walk up from the token to find the operation-relevant call
  let node: ts.Node = token

  // Try to detect from current node and parents
  while (node) {
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
    if (ts.isIdentifier(target)) {
      const entity = findEntity(target.text, entities)
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
      }
    }

    // Query pattern: Users.query.byRole(...)
    if (ts.isPropertyAccessExpression(target)) {
      const indexName = methodName // byRole, byUser, etc.
      const queryProp = target.name.text // "query"
      const entityId = target.expression

      if (queryProp === "query" && ts.isIdentifier(entityId)) {
        const entity = findEntity(entityId.text, entities)
        if (entity) {
          const args =
            call.arguments.length > 0 ? extractCallArgs(ts, call.arguments[0]!) : undefined
          return { entity, type: "query", indexName, arguments: args }
        }
      }
    }
  }

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
