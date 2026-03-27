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

// Mock that provides model fields via TypeChecker
function mockInfoWithModelFields(sourceFile: ts.SourceFile, fieldNames: string[]) {
  const properties = fieldNames.map((name) => ({
    name,
    getName: () => name,
    getEscapedName: () => name as ts.__String,
  }))

  const typeType = {
    getProperties: () => properties,
  }

  const typeSymbol = {
    name: "Type",
    getName: () => "Type",
    getEscapedName: () => "Type" as ts.__String,
  }

  const modelType = {
    getProperty: (name: string) => (name === "Type" ? typeSymbol : undefined),
    getProperties: () => properties,
  }

  const program = {
    getSourceFile: () => sourceFile,
    getTypeChecker: () => ({
      getTypeAtLocation: () => modelType,
      getTypeOfSymbolAtLocation: () => typeType,
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

  describe("DynamoModel.configure validations", () => {
    it("EDD-9007: detects field rename collision with existing model field", () => {
      const source = `
        class Bar extends Schema.Class<Bar>("Bar")({
          id: Schema.String,
          name: Schema.String,
        }) {}

        const BarModel = DynamoModel.configure(Bar, { id: { field: "name" } })
      `
      const sf = parseSource(source)
      const info = mockInfoWithModelFields(sf, ["id", "name"])
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const collisionDiag = diagnostics.filter(
        (d) => d.code === DiagnosticCode.FIELD_RENAME_COLLISION,
      )
      expect(collisionDiag).toHaveLength(1)
      expect(collisionDiag[0]!.messageText).toContain("`id`")
      expect(collisionDiag[0]!.messageText).toContain("`name`")
      expect(collisionDiag[0]!.messageText).toContain("collides")
      expect(collisionDiag[0]!.category).toBe(ts.DiagnosticCategory.Error)
    })

    it("EDD-9007: no diagnostic when rename target is unique", () => {
      const source = `
        class Team extends Schema.Class<Team>("Team")({
          id: Schema.String,
          name: Schema.String,
        }) {}

        const TeamModel = DynamoModel.configure(Team, { id: { field: "teamId" } })
      `
      const sf = parseSource(source)
      const info = mockInfoWithModelFields(sf, ["id", "name"])
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const collisionDiag = diagnostics.filter(
        (d) => d.code === DiagnosticCode.FIELD_RENAME_COLLISION,
      )
      expect(collisionDiag).toHaveLength(0)
    })

    it("EDD-9007: no diagnostic when renaming to same name", () => {
      const source = `
        class Foo extends Schema.Class<Foo>("Foo")({
          id: Schema.String,
          name: Schema.String,
        }) {}

        const FooModel = DynamoModel.configure(Foo, { id: { field: "id" } })
      `
      const sf = parseSource(source)
      const info = mockInfoWithModelFields(sf, ["id", "name"])
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const collisionDiag = diagnostics.filter(
        (d) => d.code === DiagnosticCode.FIELD_RENAME_COLLISION,
      )
      expect(collisionDiag).toHaveLength(0)
    })
  })
})
