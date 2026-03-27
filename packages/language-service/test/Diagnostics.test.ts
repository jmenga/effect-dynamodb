import ts from "typescript"
import { describe, expect, it } from "vitest"
import { DiagnosticCode, getDiagnostics } from "../src/features/diagnostics"
import { resolveEntities } from "../src/core/EntityResolver"

function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

// Minimal mock for PluginCreateInfo
function mockInfo(sourceFile: ts.SourceFile) {
  const program = {
    getSourceFile: () => sourceFile,
    getTypeChecker: () => ({
      getTypeAtLocation: () => undefined,
      getSymbolAtLocation: () => undefined,
    }),
  } as unknown as ts.Program

  return {
    languageService: {
      getProgram: () => program,
      getSemanticDiagnostics: () => [],
    },
  } as unknown as ts.server.PluginCreateInfo
}

describe("Diagnostics", () => {
  describe("Entity.make validations", () => {
    it("EDD-9003: detects old GSI index format (string instead of object)", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "test", version: 1 })

        const Users = Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byEmail: {
              index: "gsi1",
              composite: ["email"],
              sk: [],
            },
          },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Users } })
      `
      const sf = parseSource(source)
      const info = mockInfo(sf)
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const gsiDiag = diagnostics.filter((d) => d.code === DiagnosticCode.INVALID_GSI_FORMAT)
      expect(gsiDiag).toHaveLength(1)
      expect(gsiDiag[0]!.messageText).toContain("old format")
      expect(gsiDiag[0]!.messageText).toContain("`byEmail`")
    })

    it("EDD-9005: detects SK composite used in .filter()", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "test", version: 1 })

        const Tasks = Entity.make({
          model: Task,
          entityType: "Task",
          primaryKey: {
            pk: { field: "pk", composite: ["taskId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byProject: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["projectId"] },
              sk: { field: "gsi1sk", composite: ["status"] },
            },
          },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Tasks } })

        const active = db.entities.Tasks.byProject({ projectId: "p-1" }).filter({ status: "active" }).collect()
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)
      const info = mockInfo(sf)
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const filterDiag = diagnostics.filter((d) => d.code === DiagnosticCode.SK_IN_FILTER)
      expect(filterDiag).toHaveLength(1)
      expect(filterDiag[0]!.messageText).toContain("`status`")
      expect(filterDiag[0]!.messageText).toContain("query input")
      expect(filterDiag[0]!.category).toBe(ts.DiagnosticCategory.Warning)
    })

    it("EDD-9004: detects SK prefix ordering violation", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "test", version: 1 })

        const Tasks = Entity.make({
          model: Task,
          entityType: "Task",
          primaryKey: {
            pk: { field: "pk", composite: ["taskId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byProject: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["projectId"] },
              sk: { field: "gsi1sk", composite: ["status", "title"] },
            },
          },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Tasks } })

        const results = db.entities.Tasks.byProject({ projectId: "p-1", title: "hello" }).collect()
      `
      const sf = parseSource(source)
      const info = mockInfo(sf)
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const prefixDiag = diagnostics.filter((d) => d.code === DiagnosticCode.SK_PREFIX_VIOLATION)
      expect(prefixDiag).toHaveLength(1)
      expect(prefixDiag[0]!.messageText).toContain("`title`")
      expect(prefixDiag[0]!.messageText).toContain("`status`")
      expect(prefixDiag[0]!.category).toBe(ts.DiagnosticCategory.Error)
    })
  })
})
