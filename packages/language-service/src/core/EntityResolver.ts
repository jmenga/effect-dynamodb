import type ts from "typescript"

export type Casing = "lowercase" | "uppercase" | "preserve"

export interface KeyPart {
  readonly field: string
  /**
   * The fields feeding the key. For a Z-order sort key, derived as its prefix
   * composites, then its dimensions (as the library derives it).
   */
  readonly composite: ReadonlyArray<string>
  /** Present on a Z-order sort key (#171): the key is a binary address. */
  readonly zorder?: ZOrderMarker | undefined
}

/** The parts of a Z-order sort key, by field name. */
export interface ZOrderMarker {
  readonly prefix: ReadonlyArray<string>
  readonly dimensions: ReadonlyArray<string>
  /**
   * Present when a part couldn't be read statically (an entry computed at run
   * time, or a shared list declared without `as const`, whose field names the
   * checker widened to `string`): `prefix` and `dimensions` then list only the
   * parts that could. The index is kept — the half is still binary.
   */
  readonly unresolved?: true
}

/** Mirrors `KeyComposer.isZOrderHalf`: is this half a Z-order (binary) sort key? */
export const isZOrderHalf = (part: KeyPart): boolean => part.zorder !== undefined

/**
 * A sharded index's layout (#183), as far as a source literal shows it. A hover
 * has no item to hash, so it shows the marker with a shard placeholder.
 */
export interface IndexShards {
  /** `undefined` when the count isn't a literal. */
  readonly count: number | undefined
  /** The `by` attributes; empty for the default source. */
  readonly by: ReadonlyArray<string>
  readonly previous: number | undefined
}

export interface IndexDefinition {
  readonly index?: string | undefined
  readonly collection?: string | ReadonlyArray<string> | undefined
  readonly type?: "isolated" | "clustered" | undefined
  readonly pk: KeyPart
  readonly sk: KeyPart
  readonly casing?: Casing | undefined
  readonly shards?: IndexShards | undefined
}

export interface SchemaConfig {
  readonly name: string
  readonly version: number
  readonly casing: Casing
  readonly escapeKeys?: true | undefined
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
  const lookup = lookupOver(ts, varDecls, program)

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
          const partial = tryResolveEntityMake(ts, decl.name.text, decl.initializer, lookup)
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

/**
 * How an entity's config follows a name to what it stands for: same-file
 * declarations first, then the type checker (imports, re-exports).
 */
export interface ExpressionLookup {
  /** The initializer `expr` names, through `as const` and the like; `expr` when there is none. */
  readonly resolve: (expr: ts.Expression) => ts.Expression
  readonly checker: ts.TypeChecker | undefined
}

/** A lookup over `sourceFile`'s declarations and, given one, `program`'s. */
export function makeLookup(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  program?: ts.Program,
): ExpressionLookup {
  const varDecls = new Map<string, ts.Expression>()
  collectVarDecls(ts, sourceFile, varDecls)
  return lookupOver(ts, varDecls, program)
}

function lookupOver(
  ts: typeof import("typescript"),
  varDecls: Map<string, ts.Expression>,
  program: ts.Program | undefined,
): ExpressionLookup {
  const unwrap = (expr: ts.Expression): ts.Expression =>
    ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)
      ? unwrap(expr.expression)
      : expr
  return {
    resolve: (expr) => {
      let current = unwrap(expr)
      // A few hops: `const facets = dims`, `const dims = [...]`; never a cycle.
      for (let hop = 0; hop < 8 && ts.isIdentifier(current); hop++) {
        const next = unwrap(resolveVariable(ts, current, varDecls, program))
        if (next === current) break
        current = next
      }
      return current
    },
    checker: program?.getTypeChecker(),
  }
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
  lookup?: ExpressionLookup,
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

  return resolveEntityConfig(ts, varName, configArg, lookup)
}

function resolveEntityConfig(
  ts: typeof import("typescript"),
  varName: string,
  config: ts.ObjectLiteralExpression,
  lookup?: ExpressionLookup,
): PartialEntity | undefined {
  let entityType: string | undefined
  let indexes: Record<string, IndexDefinition> | undefined
  let timestamps: boolean | object = false
  let versioned: boolean | object = false
  let softDelete: boolean | object = false
  let unique: object | undefined

  let primaryKeyDef: IndexDefinition | undefined
  let gsiIndexes: Record<string, IndexDefinition> | undefined

  for (const prop of config.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    const name = prop.name.text

    switch (name) {
      case "entityType":
        entityType = extractStringLiteral(ts, prop.initializer)
        break
      case "indexes":
        // Try new GsiConfig format first, fall back to old IndexDefinition format
        gsiIndexes =
          resolveGsiIndexes(ts, prop.initializer, lookup) ??
          resolveIndexes(ts, prop.initializer, lookup)
        break
      case "primaryKey": {
        primaryKeyDef = resolveIndexDefinition(ts, prop.initializer, lookup)
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

  // Merge primaryKey + indexes (new API) or use indexes alone (old API)
  if (primaryKeyDef) {
    indexes = { primary: primaryKeyDef, ...gsiIndexes }
  } else if (gsiIndexes) {
    indexes = gsiIndexes
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

  // New signature: Table.make({ schema, entities }) — first arg is string name
  // Legacy signature: Table.make({ schema, entities }) — first arg is config object
  let tableConfig: ts.ObjectLiteralExpression | undefined
  if (args.length >= 2 && ts.isStringLiteral(args[0]!) && ts.isObjectLiteralExpression(args[1]!)) {
    tableConfig = args[1]!
  } else if (ts.isObjectLiteralExpression(args[0]!)) {
    tableConfig = args[0]! as ts.ObjectLiteralExpression
  }
  if (!tableConfig) return undefined

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
  // Match: DynamoSchema.make({ name: "...", version: N, casing?: "...", escapeKeys?: true })
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
  let escapeKeys: true | undefined

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
      case "escapeKeys":
        if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) escapeKeys = true
        break
    }
  }

  if (!name || version === undefined) return undefined
  return { name, version, casing, ...(escapeKeys === true ? { escapeKeys } : {}) }
}

function resolveIndexes(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  lookup?: ExpressionLookup,
): Record<string, IndexDefinition> | undefined {
  if (!ts.isObjectLiteralExpression(expr)) return undefined
  const result: Record<string, IndexDefinition> = {}

  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    const indexDef = resolveIndexDefinition(ts, prop.initializer, lookup)
    if (indexDef) {
      result[prop.name.text] = indexDef
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Parse indexes in GsiConfig format:
 * { byRole: { name: "gsi1", pk: { field, composite }, sk: { field, composite }, collection? } }
 * Normalizes to IndexDefinition format.
 */
function resolveGsiIndexes(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  lookup?: ExpressionLookup,
): Record<string, IndexDefinition> | undefined {
  if (!ts.isObjectLiteralExpression(expr)) return undefined
  const result: Record<string, IndexDefinition> = {}

  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    const indexDef = resolveGsiConfig(ts, prop.initializer, lookup)
    if (indexDef) {
      result[prop.name.text] = indexDef
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Parse a single GsiConfig:
 * { name: "gsi1", pk: { field: "gsi1pk", composite: [...] }, sk: { field: "gsi1sk", composite: [...] }, collection? }
 * Returns normalized IndexDefinition.
 */
function resolveGsiConfig(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  lookup?: ExpressionLookup,
): IndexDefinition | undefined {
  if (!ts.isObjectLiteralExpression(expr)) return undefined

  let gsiName: string | undefined
  let pk: KeyPart | undefined
  let sk: KeyPart | undefined
  let collection: string | ReadonlyArray<string> | undefined
  let type: "isolated" | "clustered" | undefined
  let casing: Casing | undefined
  let shards: IndexShards | undefined

  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    switch (prop.name.text) {
      case "name":
        gsiName = extractStringLiteral(ts, prop.initializer)
        break
      case "shards":
        shards = resolveShards(ts, prop.initializer)
        break
      case "pk":
        pk = resolveKeyPart(ts, prop.initializer, lookup)
        break
      case "sk":
        sk = resolveKeyPart(ts, prop.initializer, lookup)
        break
      case "collection":
        collection = extractStringOrStringArray(ts, prop.initializer)
        break
      case "type":
        type = extractStringLiteral(ts, prop.initializer) as "isolated" | "clustered" | undefined
        break
      case "casing":
        casing = extractStringLiteral(ts, prop.initializer) as Casing | undefined
        break
    }
  }

  if (!gsiName || !pk || !sk) return undefined

  return {
    index: gsiName,
    collection,
    type: type ?? "isolated",
    pk,
    sk,
    casing,
    ...(shards === undefined ? {} : { shards }),
  }
}

/** Parse `shards: 20` or `shards: { count: 20, by: [...], previous: 1 }`. */
function resolveShards(ts: typeof import("typescript"), expr: ts.Expression): IndexShards {
  if (!ts.isObjectLiteralExpression(expr)) {
    return { count: extractNumberLiteral(ts, expr), by: [], previous: undefined }
  }
  let count: number | undefined
  let by: ReadonlyArray<string> = []
  let previous: number | undefined
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    switch (prop.name.text) {
      case "count":
        count = extractNumberLiteral(ts, prop.initializer)
        break
      case "by": {
        const names = extractStringOrStringArray(ts, prop.initializer)
        by = names === undefined ? [] : typeof names === "string" ? [names] : names
        break
      }
      case "previous":
        previous = extractNumberLiteral(ts, prop.initializer)
        break
    }
  }
  return { count, by, previous }
}

function resolveIndexDefinition(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  lookup?: ExpressionLookup,
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
        pk = resolveKeyPart(ts, prop.initializer, lookup)
        break
      case "sk":
        sk = resolveKeyPart(ts, prop.initializer, lookup)
        break
      case "casing":
        casing = extractStringLiteral(ts, prop.initializer) as Casing | undefined
        break
    }
  }

  if (!pk || !sk) return undefined
  return { index, collection, type, pk, sk, casing }
}

function resolveKeyPart(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  lookup?: ExpressionLookup,
): KeyPart | undefined {
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

  if (!field) return undefined
  if (composite) return { field, composite }
  // A Z-order sort key (#171): `zorder` (and an optional `prefix`) instead of `composite`.
  const zorder = resolveZOrderFields(ts, expr, lookup)
  if (zorder === undefined) return undefined
  return { field, composite: [...zorder.prefix, ...zorder.dimensions], zorder }
}

/**
 * Parse a Z-order sort key's `zorder` / `prefix` from its object literal:
 *
 * - `zorder: [{ field: "price", min: 0, max: 100 }, "status"]` — each entry is
 *   a bare field name or an object naming its `field`;
 * - `prefix: ["agencyId", { field: "officeId", hash: 8 }]`, the same two forms.
 *
 * An entry or list held in a variable is followed through `lookup`, and
 * failing that read from its type (a `"status"` literal, or an entry type
 * whose `field` is one). `undefined` when the half declares no `zorder`. A
 * part that can't be read leaves the marker `unresolved`, never guessed.
 */
export function resolveZOrderFields(
  ts: typeof import("typescript"),
  expr: ts.ObjectLiteralExpression,
  lookup?: ExpressionLookup,
): ZOrderMarker | undefined {
  let dimensions: Fields | undefined
  let prefix: Fields = { fields: [], complete: true }
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    if (prop.name.text === "zorder") dimensions = extractListFields(ts, prop.initializer, lookup)
    if (prop.name.text === "prefix") prefix = extractListFields(ts, prop.initializer, lookup)
  }
  if (dimensions === undefined || (dimensions.complete && dimensions.fields.length === 0)) {
    return undefined
  }
  return {
    prefix: prefix.fields,
    dimensions: dimensions.fields,
    ...(dimensions.complete && prefix.complete ? {} : { unresolved: true as const }),
  }
}

/** Field names read from a list; `complete` when every element was read. */
interface Fields {
  readonly fields: ReadonlyArray<string>
  readonly complete: boolean
}

/** The fields of a `zorder` or `prefix` list (both take the same two entry forms). */
function extractListFields(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  lookup: ExpressionLookup | undefined,
): Fields {
  const list = lookup?.resolve(expr) ?? expr
  if (!ts.isArrayLiteralExpression(list)) {
    // Not written as a list: the checker may still know its tuple of entries.
    return entryTupleFields(lookup?.checker, list) ?? { fields: [], complete: false }
  }
  return extractEntryFields(ts, list, lookup)
}

/** The field of each entry of a `zorder` / `prefix` list: a bare name or `{ field, … }`. */
function extractEntryFields(
  ts: typeof import("typescript"),
  list: ts.ArrayLiteralExpression,
  lookup: ExpressionLookup | undefined,
): Fields {
  const fields: Array<string> = []
  let complete = true
  for (const el of list.elements) {
    const field = entryField(ts, el, lookup)
    if (field === undefined) complete = false
    else fields.push(field)
  }
  return { fields, complete }
}

function entryField(
  ts: typeof import("typescript"),
  el: ts.Expression,
  lookup: ExpressionLookup | undefined,
): string | undefined {
  const part = lookup?.resolve(el) ?? el
  const name = extractStringLiteral(ts, part)
  if (name !== undefined) return name
  if (ts.isObjectLiteralExpression(part)) {
    const fieldProp = part.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "field",
    )
    const field = fieldProp
      ? extractStringLiteral(ts, lookup?.resolve(fieldProp.initializer) ?? fieldProp.initializer)
      : undefined
    if (field !== undefined) return field
  }
  const checker = lookup?.checker
  return checker === undefined
    ? undefined
    : entryFieldOfType(checker, checker.getTypeAtLocation(el), el)
}

/** An entry's field from its type: a string literal, or an object whose `field` is one. */
function entryFieldOfType(checker: ts.TypeChecker, type: ts.Type | undefined, node: ts.Node) {
  if (type === undefined) return undefined
  if (type.isStringLiteral()) return type.value
  const field = type.getProperty("field")
  if (field === undefined) return undefined
  const fieldType = checker.getTypeOfSymbolAtLocation(field, node)
  return fieldType.isStringLiteral() ? fieldType.value : undefined
}

/** The fields of a tuple of entries, from the type of `node`. */
function entryTupleFields(checker: ts.TypeChecker | undefined, node: ts.Node): Fields | undefined {
  if (checker === undefined) return undefined
  const type = checker.getTypeAtLocation(node)
  if (type === undefined || !checker.isTupleType(type)) return undefined
  const read = checker
    .getTypeArguments(type as ts.TypeReference)
    .map((element) => entryFieldOfType(checker, element, node))
  const fields = read.filter((field): field is string => field !== undefined)
  return { fields, complete: fields.length === read.length }
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
  // Match: Collections.make({ name, index: { name, pk, sk }, composite, members })
  if (!ts.isCallExpression(expr)) return undefined
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== "make") return undefined

  const target = callee.expression
  if (!ts.isIdentifier(target) || target.text !== "Collections") return undefined

  const args = expr.arguments
  if (args.length < 1) return undefined

  const configArg = args[0]!
  if (!ts.isObjectLiteralExpression(configArg)) return undefined

  let collectionName: string | undefined
  let indexName: string | undefined
  let pkField: string | undefined
  let skField: string | undefined
  let type: "clustered" | "isolated" = "clustered"
  let composite: ReadonlyArray<string> | undefined
  let membersExpr: ts.Expression | undefined

  for (const prop of configArg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    switch (prop.name.text) {
      case "name":
        collectionName = extractStringLiteral(ts, prop.initializer)
        break
      case "index": {
        // index: { name: "gsi3", pk: "gsi3pk", sk: "gsi3sk" }
        if (ts.isObjectLiteralExpression(prop.initializer)) {
          for (const idxProp of prop.initializer.properties) {
            if (!ts.isPropertyAssignment(idxProp) || !ts.isIdentifier(idxProp.name)) continue
            switch (idxProp.name.text) {
              case "name":
                indexName = extractStringLiteral(ts, idxProp.initializer)
                break
              case "pk":
                pkField = extractStringLiteral(ts, idxProp.initializer)
                break
              case "sk":
                skField = extractStringLiteral(ts, idxProp.initializer)
                break
            }
          }
        }
        break
      }
      case "type":
        type =
          (extractStringLiteral(ts, prop.initializer) as "clustered" | "isolated") ?? "clustered"
        break
      case "composite":
        composite = extractStringArray(ts, prop.initializer)
        break
      case "members":
        membersExpr = prop.initializer
        break
    }
  }

  if (!collectionName || !indexName || !pkField || !skField || !composite || !membersExpr)
    return undefined

  // Parse members: { Name: Collections.member(Entity, [...skComposites]) }
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
    index: indexName,
    type,
    pk: { field: pkField, composite: [...composite] },
    sk: { field: skField },
    members,
  }
}

function tryResolveCollectionMember(
  ts: typeof import("typescript"),
  expr: ts.Expression,
): ResolvedCollectionMember | undefined {
  // Match: Collections.member(EntityRef, [...skComposites])
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

  // Second arg: string array of SK composites
  const compositeArg = args[1]!
  const composite = extractStringArray(ts, compositeArg)
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
