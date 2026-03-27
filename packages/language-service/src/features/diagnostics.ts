import type ts from "typescript"
import {
  type ResolvedEntity,
  resolveEntities,
  extractStringArray,
  extractStringLiteral,
} from "../core/EntityResolver"

// ---------------------------------------------------------------------------
// Error codes — structured identifiers for each diagnostic rule
// ---------------------------------------------------------------------------

export const DiagnosticCode = {
  /** Entity.make: primary key must have at least one composite attribute */
  EMPTY_PRIMARY_KEY: 9001,
  /** Entity.make: composite attribute references a field not in the model */
  UNKNOWN_COMPOSITE_ATTR: 9002,
  /** Entity.make: GSI index must use new format { name, pk: { field, composite }, sk: { field, composite } } */
  INVALID_GSI_FORMAT: 9003,
  /** Query accessor: SK composites violate prefix ordering */
  SK_PREFIX_VIOLATION: 9004,
  /** Query accessor: SK composite used in .filter() instead of query input */
  SK_IN_FILTER: 9005,
  /** Query accessor: unknown property in query input */
  UNKNOWN_QUERY_PROPERTY: 9006,
  /** DynamoModel.configure: field rename target collides with existing model field */
  FIELD_RENAME_COLLISION: 9007,
} as const

// ---------------------------------------------------------------------------
// Main diagnostic entry point
// ---------------------------------------------------------------------------

export function getDiagnostics(
  typescript: typeof ts,
  info: ts.server.PluginCreateInfo,
  fileName: string,
  prior: ts.Diagnostic[],
): ts.Diagnostic[] {
  try {
    const program = info.languageService.getProgram()
    if (!program) return prior

    const sourceFile = program.getSourceFile(fileName)
    if (!sourceFile) return prior

    const diagnostics: ts.Diagnostic[] = [...prior]

    // 1. Validate Entity.make() calls
    diagnostics.push(...validateEntityMakeCalls(typescript, sourceFile, program))

    // 2. Validate DynamoModel.configure() field rename collisions
    diagnostics.push(...validateConfigureCalls(typescript, sourceFile, program))

    // 3. Validate query accessor calls
    const entities = resolveEntities(typescript, sourceFile, program)
    diagnostics.push(...validateQueryAccessorCalls(typescript, sourceFile, entities))

    return diagnostics
  } catch {
    return prior
  }
}

// ---------------------------------------------------------------------------
// DynamoModel.configure() field rename collision validation
// ---------------------------------------------------------------------------

function validateConfigureCalls(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  program: ts.Program,
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = []
  const checker = program.getTypeChecker()

  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      // Match DynamoModel.configure(Model, { ... })
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "configure" &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "DynamoModel" &&
        node.arguments.length >= 2
      ) {
        const modelArg = node.arguments[0]!
        const configArg = node.arguments[1]!

        // Extract model field names from the first argument's type
        const modelType = checker.getTypeAtLocation(modelArg)
        const modelFields = new Set<string>()
        const typeSymbol = modelType.getProperty("Type")
        if (typeSymbol) {
          const typeType = checker.getTypeOfSymbolAtLocation(typeSymbol, modelArg)
          for (const p of typeType.getProperties()) {
            modelFields.add(p.name)
          }
        }
        if (modelFields.size === 0) {
          // Fallback: try direct properties
          for (const p of modelType.getProperties()) {
            if (!p.name.startsWith("_") && p.name !== "constructor") {
              modelFields.add(p.name)
            }
          }
        }

        // Walk the config object for { fieldName: { field: "targetName" } }
        if (ts.isObjectLiteralExpression(configArg) && modelFields.size > 0) {
          for (const prop of configArg.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
            const sourceField = prop.name.text
            if (!ts.isObjectLiteralExpression(prop.initializer)) continue

            for (const innerProp of prop.initializer.properties) {
              if (
                ts.isPropertyAssignment(innerProp) &&
                ts.isIdentifier(innerProp.name) &&
                innerProp.name.text === "field" &&
                ts.isStringLiteral(innerProp.initializer)
              ) {
                const targetField = innerProp.initializer.text
                // Check if target field name collides with another model field
                if (targetField !== sourceField && modelFields.has(targetField)) {
                  diagnostics.push(
                    makeDiagnostic(
                      sourceFile,
                      innerProp.initializer,
                      DiagnosticCode.FIELD_RENAME_COLLISION,
                      `DynamoModel.configure: renaming \`${sourceField}\` to \`${targetField}\` collides with existing model field \`${targetField}\`. This will cause both fields to map to the same DynamoDB attribute.`,
                      ts.DiagnosticCategory.Error,
                    ),
                  )
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  })

  return diagnostics
}

// ---------------------------------------------------------------------------
// Entity.make() validations
// ---------------------------------------------------------------------------

function validateEntityMakeCalls(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  program: ts.Program,
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = []

  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isIdentifier(decl.name)) {
          const diags = tryValidateEntityMake(ts, sourceFile, decl.initializer, program)
          diagnostics.push(...diags)
        }
      }
    }
    ts.forEachChild(node, visit)
  })

  return diagnostics
}

function tryValidateEntityMake(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  expr: ts.Expression,
  program: ts.Program,
): ts.Diagnostic[] {
  if (!ts.isCallExpression(expr)) return []
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return []
  if (callee.name.text !== "make") return []

  const target = callee.expression
  if (!ts.isIdentifier(target) || target.text !== "Entity") return []

  const args = expr.arguments
  if (args.length < 1) return []
  const configArg = args[0]!
  if (!ts.isObjectLiteralExpression(configArg)) return []

  const diagnostics: ts.Diagnostic[] = []

  // Extract model field names via TypeChecker
  const modelFields = extractModelFields(ts, configArg, program)

  // Extract entityType for error messages
  let entityType = "unknown"
  let primaryKeyNode: ts.Expression | undefined
  let indexesNode: ts.Expression | undefined

  for (const prop of configArg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    switch (prop.name.text) {
      case "entityType":
        entityType = extractStringLiteral(ts, prop.initializer) ?? "unknown"
        break
      case "primaryKey":
        primaryKeyNode = prop.initializer
        break
      case "indexes":
        indexesNode = prop.initializer
        break
    }
  }

  // Validate primary key
  if (primaryKeyNode && ts.isObjectLiteralExpression(primaryKeyNode)) {
    diagnostics.push(
      ...validatePrimaryKey(ts, sourceFile, entityType, primaryKeyNode, modelFields),
    )
  }

  // Validate GSI indexes
  if (indexesNode && ts.isObjectLiteralExpression(indexesNode)) {
    diagnostics.push(
      ...validateGsiIndexes(ts, sourceFile, entityType, indexesNode, modelFields),
    )
  }

  return diagnostics
}

function validatePrimaryKey(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  entityType: string,
  pkNode: ts.ObjectLiteralExpression,
  modelFields: ReadonlySet<string> | undefined,
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = []
  let pkComposites: ReadonlyArray<string> = []
  let skComposites: ReadonlyArray<string> = []
  let pkCompositeNode: ts.Node | undefined
  let skCompositeNode: ts.Node | undefined

  for (const prop of pkNode.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    if (prop.name.text === "pk" && ts.isObjectLiteralExpression(prop.initializer)) {
      for (const pkProp of prop.initializer.properties) {
        if (
          ts.isPropertyAssignment(pkProp) &&
          ts.isIdentifier(pkProp.name) &&
          pkProp.name.text === "composite"
        ) {
          pkComposites = extractStringArray(ts, pkProp.initializer) ?? []
          pkCompositeNode = pkProp.initializer
        }
      }
    }
    if (prop.name.text === "sk" && ts.isObjectLiteralExpression(prop.initializer)) {
      for (const skProp of prop.initializer.properties) {
        if (
          ts.isPropertyAssignment(skProp) &&
          ts.isIdentifier(skProp.name) &&
          skProp.name.text === "composite"
        ) {
          skComposites = extractStringArray(ts, skProp.initializer) ?? []
          skCompositeNode = skProp.initializer
        }
      }
    }
  }

  // EDD-9001: Empty primary key
  if (pkComposites.length === 0 && skComposites.length === 0) {
    diagnostics.push(
      makeDiagnostic(
        sourceFile,
        pkNode,
        DiagnosticCode.EMPTY_PRIMARY_KEY,
        `Entity \`${entityType}\`: primary key must have at least one composite attribute in \`pk\` or \`sk\`.`,
        ts.DiagnosticCategory.Error,
      ),
    )
  }

  // EDD-9002: Unknown composite attributes
  if (modelFields) {
    for (const attr of pkComposites) {
      if (!modelFields.has(attr)) {
        diagnostics.push(
          makeDiagnostic(
            sourceFile,
            pkCompositeNode ?? pkNode,
            DiagnosticCode.UNKNOWN_COMPOSITE_ATTR,
            `Entity \`${entityType}\`: primary key references unknown attribute \`${attr}\`. Valid attributes: ${[...modelFields].map((f) => `\`${f}\``).join(", ")}`,
            ts.DiagnosticCategory.Error,
          ),
        )
      }
    }
    for (const attr of skComposites) {
      if (!modelFields.has(attr)) {
        diagnostics.push(
          makeDiagnostic(
            sourceFile,
            skCompositeNode ?? pkNode,
            DiagnosticCode.UNKNOWN_COMPOSITE_ATTR,
            `Entity \`${entityType}\`: primary key references unknown attribute \`${attr}\`. Valid attributes: ${[...modelFields].map((f) => `\`${f}\``).join(", ")}`,
            ts.DiagnosticCategory.Error,
          ),
        )
      }
    }
  }

  return diagnostics
}

function validateGsiIndexes(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  entityType: string,
  indexesNode: ts.ObjectLiteralExpression,
  modelFields: ReadonlySet<string> | undefined,
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = []

  for (const prop of indexesNode.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    const indexName = prop.name.text
    if (!ts.isObjectLiteralExpression(prop.initializer)) continue

    let nameProp: ts.Expression | undefined
    let pkNode: ts.Expression | undefined
    let skNode: ts.Expression | undefined
    let pkCompositeNode: ts.Node | undefined
    let skCompositeNode: ts.Node | undefined
    let pkCompositeAttrs: ReadonlyArray<string> = []
    let skCompositeAttrs: ReadonlyArray<string> = []
    let hasOldIndexProp = false

    for (const idxProp of prop.initializer.properties) {
      if (!ts.isPropertyAssignment(idxProp) || !ts.isIdentifier(idxProp.name)) continue
      switch (idxProp.name.text) {
        case "name":
          nameProp = idxProp.initializer
          break
        case "index":
          // Detect old format: index: { name, pk, sk }
          hasOldIndexProp = true
          break
        case "pk":
          pkNode = idxProp.initializer
          if (ts.isObjectLiteralExpression(idxProp.initializer)) {
            for (const pkProp of idxProp.initializer.properties) {
              if (
                ts.isPropertyAssignment(pkProp) &&
                ts.isIdentifier(pkProp.name) &&
                pkProp.name.text === "composite"
              ) {
                pkCompositeAttrs = extractStringArray(ts, pkProp.initializer) ?? []
                pkCompositeNode = pkProp.initializer
              }
            }
          }
          break
        case "sk":
          skNode = idxProp.initializer
          if (ts.isObjectLiteralExpression(idxProp.initializer)) {
            for (const skProp of idxProp.initializer.properties) {
              if (
                ts.isPropertyAssignment(skProp) &&
                ts.isIdentifier(skProp.name) &&
                skProp.name.text === "composite"
              ) {
                skCompositeAttrs = extractStringArray(ts, skProp.initializer) ?? []
                skCompositeNode = skProp.initializer
              }
            }
          }
          break
      }
    }

    // EDD-9003: Old format detection (index: { name, pk, sk } instead of name/pk/sk)
    if (hasOldIndexProp) {
      diagnostics.push(
        makeDiagnostic(
          sourceFile,
          prop.initializer,
          DiagnosticCode.INVALID_GSI_FORMAT,
          `Entity \`${entityType}\`: index \`${indexName}\` uses old format. Use: \`{ name: "gsi1", pk: { field: "gsi1pk", composite: [...] }, sk: { field: "gsi1sk", composite: [...] } }\``,
          ts.DiagnosticCategory.Error,
        ),
      )
    }

    // EDD-9002: Unknown composite attributes on GSI
    if (modelFields) {
      for (const attr of pkCompositeAttrs) {
        if (!modelFields.has(attr)) {
          diagnostics.push(
            makeDiagnostic(
              sourceFile,
              pkCompositeNode ?? pkNode ?? prop.initializer,
              DiagnosticCode.UNKNOWN_COMPOSITE_ATTR,
              `Entity \`${entityType}\`: index \`${indexName}\` references unknown attribute \`${attr}\`. Valid attributes: ${[...modelFields].map((f) => `\`${f}\``).join(", ")}`,
              ts.DiagnosticCategory.Error,
            ),
          )
        }
      }
      for (const attr of skCompositeAttrs) {
        if (!modelFields.has(attr)) {
          diagnostics.push(
            makeDiagnostic(
              sourceFile,
              skCompositeNode ?? skNode ?? prop.initializer,
              DiagnosticCode.UNKNOWN_COMPOSITE_ATTR,
              `Entity \`${entityType}\`: index \`${indexName}\` references unknown attribute \`${attr}\`. Valid attributes: ${[...modelFields].map((f) => `\`${f}\``).join(", ")}`,
              ts.DiagnosticCategory.Error,
            ),
          )
        }
      }
    }
  }

  return diagnostics
}

// ---------------------------------------------------------------------------
// Query accessor validations
// ---------------------------------------------------------------------------

function validateQueryAccessorCalls(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  entities: ReadonlyArray<ResolvedEntity>,
): ts.Diagnostic[] {
  if (entities.length === 0) return []
  const diagnostics: ts.Diagnostic[] = []

  ts.forEachChild(sourceFile, function visit(node) {
    // Look for: db.entities.<Entity>.<indexName>({ ... }).filter({ ... })
    if (ts.isCallExpression(node)) {
      const diags = tryValidateQueryChain(ts, sourceFile, node, entities)
      diagnostics.push(...diags)
    }
    ts.forEachChild(node, visit)
  })

  return diagnostics
}

function tryValidateQueryChain(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  callExpr: ts.CallExpression,
  entities: ReadonlyArray<ResolvedEntity>,
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = []

  // Check for .filter() calls on a query chain
  if (!ts.isPropertyAccessExpression(callExpr.expression)) return []
  const methodName = callExpr.expression.name.text

  if (methodName === "filter" && callExpr.arguments.length > 0) {
    // Walk up to find the root query accessor
    const rootInfo = findQueryAccessorRoot(ts, callExpr.expression.expression, entities)
    if (rootInfo) {
      const filterArg = callExpr.arguments[0]!
      if (ts.isObjectLiteralExpression(filterArg)) {
        // EDD-9005: Check if any filter keys are SK composites
        for (const filterProp of filterArg.properties) {
          if (!ts.isPropertyAssignment(filterProp) || !ts.isIdentifier(filterProp.name)) continue
          const filterKey = filterProp.name.text
          const skIdx = rootInfo.skComposites.indexOf(filterKey)
          if (skIdx !== -1) {
            diagnostics.push(
              makeDiagnostic(
                sourceFile,
                filterProp.name,
                DiagnosticCode.SK_IN_FILTER,
                `\`${filterKey}\` is a sort key composite for index \`${rootInfo.indexName}\` — include it in the query input for efficient key-based filtering instead of post-read \`.filter()\`.`,
                ts.DiagnosticCategory.Warning,
              ),
            )
          }
        }
      }
    }
  }

  // Check query accessor calls directly: db.entities.Tasks.byProject({...})
  const chain = buildChain(ts, callExpr.expression)
  if (chain.length >= 4 && chain[1]?.text === "entities") {
    const entityName = chain[2]?.text
    const indexName = chain[3]?.text
    if (entityName && indexName) {
      const entity = entities.find((e) => e.variableName === entityName)
      if (entity) {
        const indexDef = entity.indexes[indexName]
        if (indexDef && indexName !== "primary" && callExpr.arguments.length > 0) {
          const queryArg = callExpr.arguments[0]!
          if (ts.isObjectLiteralExpression(queryArg)) {
            diagnostics.push(
              ...validateQueryInput(ts, sourceFile, indexName, indexDef, queryArg),
            )
          }
        }
      }
    }
  }

  return diagnostics
}

interface QueryAccessorInfo {
  entity: ResolvedEntity
  indexName: string
  skComposites: ReadonlyArray<string>
  providedArgs: Set<string>
}

function findQueryAccessorRoot(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  entities: ReadonlyArray<ResolvedEntity>,
): QueryAccessorInfo | undefined {
  // Walk through intermediate BoundQuery combinator calls
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression
    if (ts.isPropertyAccessExpression(callee)) {
      const chain = buildChain(ts, callee)
      // db.entities.Tasks.byProject(...)
      if (chain.length >= 4 && chain[1]?.text === "entities") {
        const entityName = chain[2]?.text
        const indexName = chain[3]?.text
        if (entityName && indexName) {
          const entity = entities.find((e) => e.variableName === entityName)
          if (entity) {
            const indexDef = entity.indexes[indexName]
            if (indexDef) {
              const providedArgs = new Set<string>()
              if (expr.arguments.length > 0 && ts.isObjectLiteralExpression(expr.arguments[0]!)) {
                for (const p of expr.arguments[0]!.properties) {
                  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                    providedArgs.add(p.name.text)
                  }
                }
              }
              return {
                entity,
                indexName,
                skComposites: indexDef.sk.composite,
                providedArgs,
              }
            }
          }
        }
      }

      // Intermediate combinator: .limit(10).filter(...) → recurse
      const combinator = callee.name.text
      if (
        combinator === "limit" ||
        combinator === "reverse" ||
        combinator === "select" ||
        combinator === "where" ||
        combinator === "maxPages" ||
        combinator === "startFrom" ||
        combinator === "consistentRead"
      ) {
        return findQueryAccessorRoot(ts, callee.expression, entities)
      }
    }
  }

  // Property access (chaining through non-call)
  if (ts.isPropertyAccessExpression(expr)) {
    return findQueryAccessorRoot(ts, expr.expression, entities)
  }

  return undefined
}

function validateQueryInput(
  ts: typeof import("typescript"),
  sourceFile: ts.SourceFile,
  indexName: string,
  indexDef: { pk: { composite: ReadonlyArray<string> }; sk: { composite: ReadonlyArray<string> } },
  queryArg: ts.ObjectLiteralExpression,
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = []
  const validKeys = new Set([...indexDef.pk.composite, ...indexDef.sk.composite])
  const providedKeys = new Map<string, ts.Node>()

  for (const prop of queryArg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      providedKeys.set(prop.name.text, prop.name)
    }
  }

  // EDD-9006: Unknown properties
  for (const [key, node] of providedKeys) {
    if (!validKeys.has(key)) {
      diagnostics.push(
        makeDiagnostic(
          sourceFile,
          node,
          DiagnosticCode.UNKNOWN_QUERY_PROPERTY,
          `Unknown composite attribute \`${key}\` for index \`${indexName}\`. Valid attributes: ${[...validKeys].map((k) => `\`${k}\``).join(", ")}`,
          ts.DiagnosticCategory.Error,
        ),
      )
    }
  }

  // EDD-9004: SK prefix ordering violation
  const skComposites = indexDef.sk.composite
  let lastProvided = -1
  for (let i = 0; i < skComposites.length; i++) {
    if (providedKeys.has(skComposites[i]!)) {
      if (i !== lastProvided + 1) {
        const missing = skComposites.slice(lastProvided + 1, i)
        diagnostics.push(
          makeDiagnostic(
            sourceFile,
            providedKeys.get(skComposites[i]!)!,
            DiagnosticCode.SK_PREFIX_VIOLATION,
            `Sort key composite \`${skComposites[i]}\` for index \`${indexName}\` requires prior composites: ${missing.map((m) => `\`${m}\``).join(", ")}. Sort key composites must follow prefix ordering.`,
            ts.DiagnosticCategory.Error,
          ),
        )
      }
      lastProvided = i
    }
  }

  return diagnostics
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildChain(
  ts: typeof import("typescript"),
  node: ts.Expression,
): Array<ts.Identifier> {
  const parts: Array<ts.Identifier> = []
  let current: ts.Expression = node
  while (ts.isPropertyAccessExpression(current)) {
    if (ts.isIdentifier(current.name)) {
      parts.unshift(current.name)
    }
    current = current.expression
  }
  if (ts.isIdentifier(current)) {
    parts.unshift(current)
  }
  return parts
}

/** Extract model field names from the `model` property of Entity.make() config. */
function extractModelFields(
  ts: typeof import("typescript"),
  config: ts.ObjectLiteralExpression,
  program: ts.Program,
): ReadonlySet<string> | undefined {
  for (const prop of config.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    if (prop.name.text !== "model") continue

    // Use TypeChecker to resolve the model type and extract field names
    const checker = program.getTypeChecker()
    const type = checker.getTypeAtLocation(prop.initializer)
    if (!type) return undefined

    const fields = extractFieldsFromSchemaType(checker, type, prop.initializer)
    if (fields && fields.size > 0) return fields
  }

  return undefined
}

/** Extract field names from a Schema.Class type or ConfiguredModel type. */
function extractFieldsFromSchemaType(
  checker: import("typescript").TypeChecker,
  type: import("typescript").Type,
  location: import("typescript").Node,
): Set<string> | undefined {
  const fields = new Set<string>()

  // Try direct Schema.Class: has a `Type` property with the model fields
  const typeSymbol = type.getProperty("Type")
  if (typeSymbol) {
    const typeType = checker.getTypeOfSymbolAtLocation(typeSymbol, location)
    for (const p of typeType.getProperties()) {
      fields.add(p.name)
    }
    if (fields.size > 0) return fields
  }

  // Try ConfiguredModel: has a `model` property that is the Schema.Class
  const modelSymbol = type.getProperty("model")
  if (modelSymbol) {
    const modelType = checker.getTypeOfSymbolAtLocation(modelSymbol, location)
    const innerTypeSymbol = modelType.getProperty("Type")
    if (innerTypeSymbol) {
      const innerTypeType = checker.getTypeOfSymbolAtLocation(innerTypeSymbol, location)
      for (const p of innerTypeType.getProperties()) {
        fields.add(p.name)
      }
      if (fields.size > 0) return fields
    }
  }

  // Fallback: try prototype properties
  for (const p of type.getProperties()) {
    if (p.name.startsWith("_") || p.name === "constructor") continue
    fields.add(p.name)
  }
  if (fields.size > 0) return fields

  return undefined
}

function makeDiagnostic(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  code: number,
  message: string,
  category: ts.DiagnosticCategory,
): ts.Diagnostic {
  return {
    file: sourceFile,
    start: node.getStart(sourceFile),
    length: node.getWidth(sourceFile),
    messageText: `[EDD-${code}] ${message}`,
    category,
    code,
    source: "effect-dynamodb",
  }
}
