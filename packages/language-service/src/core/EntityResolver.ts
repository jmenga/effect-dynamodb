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

// ---------------------------------------------------------------------------
// Resolved Collection — from Collections.make()
// ---------------------------------------------------------------------------

export interface ResolvedCollectionMember {
  readonly entityVariableName: string
  readonly sk: { readonly composite: ReadonlyArray<string> }
}

export interface ResolvedCollection {
  readonly variableName: string
  readonly collectionName: string
  readonly index: string
  readonly type: "clustered" | "isolated"
  readonly pk: KeyPart
  readonly sk: { readonly field: string }
  readonly members: Record<string, ResolvedCollectionMember>
}

export function resolveEntities(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  program?: ts.Program,
): ReadonlyArray<ResolvedEntity> {
  // First pass: collect variable declarations and their initializers for reference tracing
  const varDecls = new Map<string, ts.Expression>()
  collectVarDecls(ts, sourceFile, varDecls)

  // Second pass: find Entity.make() calls (partial — no schema yet)
  const partials: Array<{
    varName: string
    entityType: string
    indexes: Record<string, IndexDefinition>
    timestamps: boolean | object
    versioned: boolean | object
    softDelete: boolean | object
    unique: object | undefined
  }> = []

  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isIdentifier(decl.name)) {
          const partial = tryResolveEntityMake(ts, decl.name.text, decl.initializer)
          if (partial) partials.push(partial)
        }
      }
    }
    ts.forEachChild(node, visit)
  })

  if (partials.length === 0) return []

  // Third pass: find Table.make() calls and resolve schemas for registered entities
  const entitySchemas = resolveEntitySchemas(ts, sourceFile, varDecls, program)

  // Combine partials with resolved schemas
  const entities: Array<ResolvedEntity> = []
  for (const partial of partials) {
    const schema = entitySchemas.get(partial.varName)
    if (!schema) continue
    entities.push({ ...partial, variableName: partial.varName, schema })
  }

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

interface PartialEntity {
  readonly varName: string
  readonly entityType: string
  readonly indexes: Record<string, IndexDefinition>
  readonly timestamps: boolean | object
  readonly versioned: boolean | object
  readonly softDelete: boolean | object
  readonly unique: object | undefined
}

function tryResolveEntityMake(
  ts: typeof import("typescript"),
  varName: string,
  expr: ts.Expression,
): PartialEntity | undefined {
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

  return resolveEntityConfig(ts, varName, configArg)
}

function resolveEntityConfig(
  ts: typeof import("typescript"),
  varName: string,
  config: ts.ObjectLiteralExpression,
): PartialEntity | undefined {
  let entityType: string | undefined
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
      case "indexes":
        indexes = resolveIndexes(ts, prop.initializer)
        break
      case "primaryKey": {
        // v2 API: primaryKey is wrapped as { primary: <def> }
        const pkDef = resolveIndexDefinition(ts, prop.initializer)
        if (pkDef) indexes = { primary: pkDef }
        break
      }
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

  return { varName, entityType, indexes, timestamps, versioned, softDelete, unique }
}

/**
 * Scan for Table.make({ schema, entities: { ... } }) calls and build a map
 * from entity variable name → SchemaConfig.
 */
function resolveEntitySchemas(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  varDecls: Map<string, ts.Expression>,
  program?: ts.Program,
): Map<string, SchemaConfig> {
  const result = new Map<string, SchemaConfig>()

  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!decl.initializer) continue
        const tableInfo = tryResolveTableMake(ts, decl.initializer, varDecls, program)
        if (tableInfo) {
          for (const entityName of tableInfo.entityNames) {
            result.set(entityName, tableInfo.schema)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  })

  return result
}

function tryResolveTableMake(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  varDecls: Map<string, ts.Expression>,
  program?: ts.Program,
): { schema: SchemaConfig; entityNames: ReadonlyArray<string> } | undefined {
  // Match: Table.make({ schema: <schemaExpr>, entities: { ... } })
  if (!ts.isCallExpression(expr)) return undefined
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== "make") return undefined

  const target = callee.expression
  if (!ts.isIdentifier(target) || target.text !== "Table") return undefined

  const args = expr.arguments
  if (args.length < 1) return undefined
  const tableConfig = args[0]!
  if (!ts.isObjectLiteralExpression(tableConfig)) return undefined

  let schemaExpr: ts.Expression | undefined
  let entitiesExpr: ts.Expression | undefined

  for (const prop of tableConfig.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    if (prop.name.text === "schema") schemaExpr = prop.initializer
    if (prop.name.text === "entities") entitiesExpr = prop.initializer
  }

  if (!schemaExpr || !entitiesExpr) return undefined

  // Resolve schema
  const schemaInit = resolveVariable(ts, schemaExpr, varDecls, program)
  const schema = resolveDynamoSchema(ts, schemaInit)
  if (!schema) return undefined

  // Extract entity names from the entities record
  const entityNames: Array<string> = []
  if (ts.isObjectLiteralExpression(entitiesExpr)) {
    for (const prop of entitiesExpr.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        // { Todos } — shorthand, variable name = property name
        entityNames.push(prop.name.text)
      } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        // { Todos: TodoEntity } — the key is the client accessor, value is the entity variable
        if (ts.isIdentifier(prop.initializer)) {
          entityNames.push(prop.initializer.text)
        }
      }
    }
  }

  return entityNames.length > 0 ? { schema, entityNames } : undefined
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

// ---------------------------------------------------------------------------
// Collections.make() resolution
// ---------------------------------------------------------------------------

/**
 * Resolve all Collections.make() calls in a source file.
 */
export function resolveCollections(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
): ReadonlyArray<ResolvedCollection> {
  const collections: Array<ResolvedCollection> = []

  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isIdentifier(decl.name)) {
          const coll = tryResolveCollectionMake(ts, decl.name.text, decl.initializer)
          if (coll) collections.push(coll)
        }
      }
    }
    ts.forEachChild(node, visit)
  })

  return collections
}

function tryResolveCollectionMake(
  ts: typeof import("typescript"),
  varName: string,
  expr: ts.Expression,
): ResolvedCollection | undefined {
  // Match: Collections.make("name", { index, pk, sk, members })
  if (!ts.isCallExpression(expr)) return undefined
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== "make") return undefined

  const target = callee.expression
  if (!ts.isIdentifier(target) || target.text !== "Collections") return undefined

  const args = expr.arguments
  if (args.length < 2) return undefined

  const collectionName = extractStringLiteral(ts, args[0]!)
  if (!collectionName) return undefined

  const configArg = args[1]!
  if (!ts.isObjectLiteralExpression(configArg)) return undefined

  let index: string | undefined
  let type: "clustered" | "isolated" = "clustered"
  let pk: KeyPart | undefined
  let skField: string | undefined
  let membersExpr: ts.Expression | undefined

  for (const prop of configArg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    switch (prop.name.text) {
      case "index":
        index = extractStringLiteral(ts, prop.initializer)
        break
      case "type":
        type =
          (extractStringLiteral(ts, prop.initializer) as "clustered" | "isolated") ?? "clustered"
        break
      case "pk":
        pk = resolveKeyPart(ts, prop.initializer)
        break
      case "sk": {
        // sk: { field: "gsi3sk" } — just a field, no composite
        if (ts.isObjectLiteralExpression(prop.initializer)) {
          for (const skProp of prop.initializer.properties) {
            if (
              ts.isPropertyAssignment(skProp) &&
              ts.isIdentifier(skProp.name) &&
              skProp.name.text === "field"
            ) {
              skField = extractStringLiteral(ts, skProp.initializer)
            }
          }
        }
        break
      }
      case "members":
        membersExpr = prop.initializer
        break
    }
  }

  if (!index || !pk || !skField || !membersExpr) return undefined

  // Parse members: { Name: Collections.member(Entity, { sk: { composite: [...] } }) }
  const members: Record<string, ResolvedCollectionMember> = {}
  if (ts.isObjectLiteralExpression(membersExpr)) {
    for (const prop of membersExpr.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
      const memberName = prop.name.text
      const member = tryResolveCollectionMember(ts, prop.initializer)
      if (member) members[memberName] = member
    }
  }

  if (Object.keys(members).length === 0) return undefined

  return {
    variableName: varName,
    collectionName,
    index,
    type,
    pk,
    sk: { field: skField },
    members,
  }
}

function tryResolveCollectionMember(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): ResolvedCollectionMember | undefined {
  // Match: Collections.member(EntityRef, { sk: { composite: [...] } })
  if (!ts.isCallExpression(expr)) return undefined
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== "member") return undefined

  const args = expr.arguments
  if (args.length < 2) return undefined

  // First arg: entity reference (identifier)
  const entityArg = args[0]!
  let entityVariableName: string | undefined
  if (ts.isIdentifier(entityArg)) {
    entityVariableName = entityArg.text
  }
  if (!entityVariableName) return undefined

  // Second arg: { sk: { composite: [...] } }
  const configArg = args[1]!
  if (!ts.isObjectLiteralExpression(configArg)) return undefined

  let composite: ReadonlyArray<string> | undefined

  for (const prop of configArg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    if (prop.name.text === "sk" && ts.isObjectLiteralExpression(prop.initializer)) {
      for (const skProp of prop.initializer.properties) {
        if (
          ts.isPropertyAssignment(skProp) &&
          ts.isIdentifier(skProp.name) &&
          skProp.name.text === "composite"
        ) {
          composite = extractStringArray(ts, skProp.initializer)
        }
      }
    }
  }

  if (!composite) return undefined

  return { entityVariableName, sk: { composite } }
}

export {
  extractStringLiteral,
  extractNumberLiteral,
  extractLiteralValue,
  extractStringArray,
  extractObjectLiteral,
}
