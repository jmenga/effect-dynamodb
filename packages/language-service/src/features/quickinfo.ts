import type ts from "typescript"
import * as Cache from "../core/Cache"
import { resolveCollections, resolveEntities } from "../core/EntityResolver"
import { detectOperation } from "../core/OperationDetector"
import { buildParams } from "../core/ParamsBuilder"
import { formatTooltip } from "../formatters/tooltip"

export function enhanceQuickInfo(
  typescript: typeof ts,
  info: ts.server.PluginCreateInfo,
  fileName: string,
  position: number,
  prior: ts.QuickInfo | undefined,
): ts.QuickInfo | undefined {
  try {
    const program = info.languageService.getProgram()
    if (!program) return prior

    const sourceFile = program.getSourceFile(fileName)
    if (!sourceFile) return prior

    // Get or resolve entity + collection configs for this file (with version-based caching)
    const scriptInfo = info.project.getScriptInfo(fileName)
    const version = scriptInfo ? Number(scriptInfo.getLatestVersion()) : 0
    let entities = Cache.getEntities(fileName, version)
    let collections = Cache.getCollections(fileName, version)

    if (!entities) {
      entities = resolveEntitiesFromAllSources(typescript, program, sourceFile)
      collections = resolveCollectionsFromAllSources(typescript, program, sourceFile)
      Cache.setEntities(fileName, version, entities, collections ?? [])
    }

    if (entities.length === 0 && (!collections || collections.length === 0)) return prior

    // Detect operation at cursor (pass both entities and collections)
    const operation = detectOperation(typescript, sourceFile, position, entities, collections ?? [])
    if (!operation) return prior

    // Build DynamoDB params and format tooltip
    const params = buildParams(operation)
    if (!params) return prior
    const tooltip = formatTooltip(params)

    // Append to existing quickinfo
    return appendToQuickInfo(typescript, prior, tooltip, sourceFile, position)
  } catch {
    // Graceful degradation — never break the language service
    return prior
  }
}

function resolveEntitiesFromAllSources(
  typescript: typeof ts,
  program: ts.Program,
  currentFile: ts.SourceFile,
) {
  // Resolve from current file (with cross-file variable resolution)
  const entities = [...resolveEntities(typescript, currentFile, program)]
  const resolvedFiles = new Set<string>([currentFile.fileName])
  const checker = program.getTypeChecker()

  for (const stmt of currentFile.statements) {
    if (!typescript.isImportDeclaration(stmt)) continue
    if (!typescript.isStringLiteral(stmt.moduleSpecifier)) continue

    const filesToCheck = new Set<string>()

    // Follow the module specifier to its source file
    const moduleSym = checker.getSymbolAtLocation(stmt.moduleSpecifier)
    if (moduleSym) {
      for (const decl of moduleSym.getDeclarations() ?? []) {
        filesToCheck.add(decl.getSourceFile().fileName)
      }
    }

    // Follow named imports to their actual declaration files (handles barrel re-exports)
    if (
      stmt.importClause?.namedBindings &&
      typescript.isNamedImports(stmt.importClause.namedBindings)
    ) {
      for (const specifier of stmt.importClause.namedBindings.elements) {
        const sym = checker.getSymbolAtLocation(specifier.name)
        if (!sym) continue
        const aliased =
          sym.flags & typescript.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
        for (const decl of aliased.getDeclarations() ?? []) {
          filesToCheck.add(decl.getSourceFile().fileName)
        }
      }
    }

    for (const fileName of filesToCheck) {
      if (resolvedFiles.has(fileName)) continue
      resolvedFiles.add(fileName)
      const importedFile = program.getSourceFile(fileName)
      if (importedFile) {
        entities.push(...resolveEntities(typescript, importedFile, program))
      }
    }
  }

  return entities
}

function resolveCollectionsFromAllSources(
  typescript: typeof ts,
  program: ts.Program,
  currentFile: ts.SourceFile,
) {
  const collections = [...resolveCollections(typescript, currentFile)]
  const resolvedFiles = new Set<string>([currentFile.fileName])
  const checker = program.getTypeChecker()

  for (const stmt of currentFile.statements) {
    if (!typescript.isImportDeclaration(stmt)) continue
    if (!typescript.isStringLiteral(stmt.moduleSpecifier)) continue

    const filesToCheck = new Set<string>()

    const moduleSym = checker.getSymbolAtLocation(stmt.moduleSpecifier)
    if (moduleSym) {
      for (const decl of moduleSym.getDeclarations() ?? []) {
        filesToCheck.add(decl.getSourceFile().fileName)
      }
    }

    if (
      stmt.importClause?.namedBindings &&
      typescript.isNamedImports(stmt.importClause.namedBindings)
    ) {
      for (const specifier of stmt.importClause.namedBindings.elements) {
        const sym = checker.getSymbolAtLocation(specifier.name)
        if (!sym) continue
        const aliased =
          sym.flags & typescript.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
        for (const decl of aliased.getDeclarations() ?? []) {
          filesToCheck.add(decl.getSourceFile().fileName)
        }
      }
    }

    for (const fileName of filesToCheck) {
      if (resolvedFiles.has(fileName)) continue
      resolvedFiles.add(fileName)
      const importedFile = program.getSourceFile(fileName)
      if (importedFile) {
        collections.push(...resolveCollections(typescript, importedFile))
      }
    }
  }

  return collections
}

function appendToQuickInfo(
  typescript: typeof ts,
  prior: ts.QuickInfo | undefined,
  tooltip: string,
  _sourceFile: ts.SourceFile,
  position: number,
): ts.QuickInfo {
  const displayParts: Array<ts.SymbolDisplayPart> = [...(prior?.displayParts ?? [])]

  const documentationParts: Array<ts.SymbolDisplayPart> = [...(prior?.documentation ?? [])]

  // Add separator if there's existing documentation
  if (documentationParts.length > 0) {
    documentationParts.push({
      kind: "lineBreak",
      text: "\n",
    })
    documentationParts.push({
      kind: "lineBreak",
      text: "\n",
    })
  }

  // Add our DynamoDB info with a heading and code block
  documentationParts.push({
    kind: "text",
    text: `---\n**effect-dynamodb** — Native DynamoDB operation\n\`\`\`\n${tooltip}\n\`\`\``,
  })

  // Use prior's text span or create one
  const textSpan = prior?.textSpan ?? { start: position, length: 0 }

  return {
    kind: prior?.kind ?? typescript.ScriptElementKind.unknown,
    kindModifiers: prior?.kindModifiers ?? "",
    textSpan,
    displayParts,
    documentation: documentationParts,
    tags: prior?.tags ?? [],
  }
}
