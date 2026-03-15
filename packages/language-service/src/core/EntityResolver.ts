import type ts from "typescript"

export type Casing = "lowercase" | "uppercase" | "preserve"

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

export interface SchemaConfig {
  readonly name: string
  readonly version: number
  readonly casing: Casing
}

export interface ResolvedEntity {
  readonly variableName: string
  readonly entityType: string
  readonly schema: SchemaConfig
  readonly indexes: Record<string, IndexDefinition>
  readonly timestamps: boolean | object
  readonly versioned: boolean | object
  readonly softDelete: boolean | object
  readonly unique: object | undefined
}

export function resolveEntities(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  program?: ts.Program,
): ReadonlyArray<ResolvedEntity> {
  const entities: Array<ResolvedEntity> = []

  // First pass: collect variable declarations and their initializers for reference tracing
  const varDecls = new Map<string, ts.Expression>()
  collectVarDecls(ts, sourceFile, varDecls)

  // Second pass: find Entity.make() calls
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isIdentifier(decl.name)) {
          const entity = tryResolveEntityMake(
            ts,
            decl.name.text,
            decl.initializer,
            varDecls,
            program,
          )
          if (entity) entities.push(entity)
        }
      }
    }
    ts.forEachChild(node, visit)
  })

  return entities
}

function collectVarDecls(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  out: Map<string, ts.Expression>,
): void {
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          out.set(decl.name.text, decl.initializer)
        }
      }
    }
    ts.forEachChild(node, visit)
  })
}

/**
 * Resolve a variable reference to its initializer expression.
 * Tries same-file varDecls first, then cross-file via TypeChecker.
 */
function resolveVariable(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  varDecls: Map<string, ts.Expression>,
  program?: ts.Program,
): ts.Expression {
  if (!ts.isIdentifier(expr)) return expr

  // Try local (same-file) first
  const local = varDecls.get(expr.text)
  if (local) return local

  // Try cross-file via TypeChecker
  if (!program) return expr
  const checker = program.getTypeChecker()
  const symbol = checker.getSymbolAtLocation(expr)
  if (!symbol) return expr

  // Follow alias chain (imports, re-exports, barrel exports)
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol

  const decls = resolved.getDeclarations()
  if (!decls) return expr

  for (const decl of decls) {
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      return decl.initializer
    }
  }

  return expr
}

function tryResolveEntityMake(
  ts: typeof import("typescript"),
  varName: string,
  expr: ts.Expression,
  varDecls: Map<string, ts.Expression>,
  program?: ts.Program,
): ResolvedEntity | undefined {
  // Match: Entity.make({ ... })
  if (!ts.isCallExpression(expr)) return undefined
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== "make") return undefined

  // Check if the target is "Entity" (imported namespace or destructured import)
  const target = callee.expression
  if (!ts.isIdentifier(target)) return undefined
  if (target.text !== "Entity") return undefined

  const args = expr.arguments
  if (args.length < 1) return undefined
  const configArg = args[0]!
  if (!ts.isObjectLiteralExpression(configArg)) return undefined

  return resolveEntityConfig(ts, varName, configArg, varDecls, program)
}

function resolveEntityConfig(
  ts: typeof import("typescript"),
  varName: string,
  config: ts.ObjectLiteralExpression,
  varDecls: Map<string, ts.Expression>,
  program?: ts.Program,
): ResolvedEntity | undefined {
  let entityType: string | undefined
  let tableExpr: ts.Expression | undefined
  let indexes: Record<string, IndexDefinition> | undefined
  let timestamps: boolean | object = false
  let versioned: boolean | object = false
  let softDelete: boolean | object = false
  let unique: object | undefined

  for (const prop of config.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    const name = prop.name.text

    switch (name) {
      case "entityType":
        entityType = extractStringLiteral(ts, prop.initializer)
        break
      case "table":
        tableExpr = prop.initializer
        break
      case "indexes":
        indexes = resolveIndexes(ts, prop.initializer)
        break
      case "timestamps":
        timestamps = extractBoolOrObject(ts, prop.initializer)
        break
      case "versioned":
        versioned = extractBoolOrObject(ts, prop.initializer)
        break
      case "softDelete":
        softDelete = extractBoolOrObject(ts, prop.initializer)
        break
      case "unique":
        unique = extractObjectLiteral(ts, prop.initializer) ?? undefined
        break
    }
  }

  if (!entityType || !indexes) return undefined

  // Resolve schema from table -> Table.make({ schema }) -> DynamoSchema.make({ name, version })
  const schema = resolveSchemaFromTable(ts, tableExpr, varDecls, program)
  if (!schema) return undefined

  return {
    variableName: varName,
    entityType,
    schema,
    indexes,
    timestamps,
    versioned,
    softDelete,
    unique,
  }
}

function resolveSchemaFromTable(
  ts: typeof import("typescript"),
  tableExpr: ts.Expression | undefined,
  varDecls: Map<string, ts.Expression>,
  program?: ts.Program,
): SchemaConfig | undefined {
  if (!tableExpr) return undefined

  // Follow variable reference (same-file or cross-file)
  const tableInit = resolveVariable(ts, tableExpr, varDecls, program)

  // Match: Table.make({ schema: <schemaExpr> })
  if (!ts.isCallExpression(tableInit)) return undefined
  const callee = tableInit.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== "make") return undefined

  const args = tableInit.arguments
  if (args.length < 1) return undefined
  const tableConfig = args[0]!
  if (!ts.isObjectLiteralExpression(tableConfig)) return undefined

  let schemaExpr: ts.Expression | undefined
  for (const prop of tableConfig.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    if (prop.name.text === "schema") {
      schemaExpr = prop.initializer
      break
    }
  }

  if (!schemaExpr) return undefined

  // Follow variable reference (same-file or cross-file)
  const schemaInit = resolveVariable(ts, schemaExpr, varDecls, program)

  return resolveDynamoSchema(ts, schemaInit)
}

function resolveDynamoSchema(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): SchemaConfig | undefined {
  // Match: DynamoSchema.make({ name: "...", version: N, casing?: "..." })
  if (!ts.isCallExpression(expr)) return undefined
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== "make") return undefined

  const args = expr.arguments
  if (args.length < 1) return undefined
  const configObj = args[0]!
  if (!ts.isObjectLiteralExpression(configObj)) return undefined

  let name: string | undefined
  let version: number | undefined
  let casing: Casing = "lowercase"

  for (const prop of configObj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    switch (prop.name.text) {
      case "name":
        name = extractStringLiteral(ts, prop.initializer)
        break
      case "version":
        version = extractNumberLiteral(ts, prop.initializer)
        break
      case "casing":
        casing = (extractStringLiteral(ts, prop.initializer) as Casing) ?? "lowercase"
        break
    }
  }

  if (!name || version === undefined) return undefined
  return { name, version, casing }
}

function resolveIndexes(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): Record<string, IndexDefinition> | undefined {
  if (!ts.isObjectLiteralExpression(expr)) return undefined
  const result: Record<string, IndexDefinition> = {}

  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    const indexDef = resolveIndexDefinition(ts, prop.initializer)
    if (indexDef) {
      result[prop.name.text] = indexDef
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function resolveIndexDefinition(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): IndexDefinition | undefined {
  if (!ts.isObjectLiteralExpression(expr)) return undefined

  let index: string | undefined
  let collection: string | ReadonlyArray<string> | undefined
  let type: "isolated" | "clustered" | undefined
  let pk: KeyPart | undefined
  let sk: KeyPart | undefined
  let casing: Casing | undefined

  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    switch (prop.name.text) {
      case "index":
        index = extractStringLiteral(ts, prop.initializer)
        break
      case "collection":
        collection = extractStringOrStringArray(ts, prop.initializer)
        break
      case "type":
        type = extractStringLiteral(ts, prop.initializer) as "isolated" | "clustered" | undefined
        break
      case "pk":
        pk = resolveKeyPart(ts, prop.initializer)
        break
      case "sk":
        sk = resolveKeyPart(ts, prop.initializer)
        break
      case "casing":
        casing = extractStringLiteral(ts, prop.initializer) as Casing | undefined
        break
    }
  }

  if (!pk || !sk) return undefined
  return { index, collection, type, pk, sk, casing }
}

function resolveKeyPart(ts: typeof import("typescript"), expr: ts.Expression): KeyPart | undefined {
  if (!ts.isObjectLiteralExpression(expr)) return undefined

  let field: string | undefined
  let composite: ReadonlyArray<string> | undefined

  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    switch (prop.name.text) {
      case "field":
        field = extractStringLiteral(ts, prop.initializer)
        break
      case "composite":
        composite = extractStringArray(ts, prop.initializer)
        break
    }
  }

  if (!field || !composite) return undefined
  return { field, composite }
}

// --- Extraction helpers ---

function extractStringLiteral(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text
  }
  return undefined
}

function extractNumberLiteral(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): number | undefined {
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text)
  }
  // Handle negative: -N
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text)
  }
  return undefined
}

function extractBoolOrObject(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): boolean | object {
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isObjectLiteralExpression(expr)) {
    return extractObjectLiteral(ts, expr) ?? true
  }
  return false
}

function extractObjectLiteral(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): Record<string, unknown> | undefined {
  if (!ts.isObjectLiteralExpression(expr)) return undefined
  const result: Record<string, unknown> = {}
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    result[prop.name.text] = extractLiteralValue(ts, prop.initializer)
  }
  return result
}

function extractLiteralValue(ts: typeof import("typescript"), expr: ts.Expression): unknown {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isNumericLiteral(expr)) return Number(expr.text)
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.map((e) => extractLiteralValue(ts, e))
  if (ts.isObjectLiteralExpression(expr)) return extractObjectLiteral(ts, expr)
  return undefined
}

function extractStringArray(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): ReadonlyArray<string> | undefined {
  if (!ts.isArrayLiteralExpression(expr)) return undefined
  const result: Array<string> = []
  for (const el of expr.elements) {
    const s = extractStringLiteral(ts, el)
    if (s === undefined) return undefined
    result.push(s)
  }
  return result
}

function extractStringOrStringArray(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): string | ReadonlyArray<string> | undefined {
  const str = extractStringLiteral(ts, expr)
  if (str !== undefined) return str
  return extractStringArray(ts, expr)
}

export {
  extractStringLiteral,
  extractNumberLiteral,
  extractLiteralValue,
  extractStringArray,
  extractObjectLiteral,
}
