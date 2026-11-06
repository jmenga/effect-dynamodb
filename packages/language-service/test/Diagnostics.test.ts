import ts from "typescript"
import { describe, expect, it } from "vitest"
import { resolveEntities } from "../src/core/EntityResolver"
import { DiagnosticCode, getDiagnostics } from "../src/features/diagnostics"

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

// Mock that simulates ConfiguredModel (has .model.Type, not .Type directly)
function mockInfoWithConfiguredModel(sourceFile: ts.SourceFile, fieldNames: string[]) {
  const properties = fieldNames.map((name) => ({
    name,
    getName: () => name,
    getEscapedName: () => name as ts.__String,
  }))

  const typeType = {
    getProperties: () => properties,
  }

  const innerTypeSymbol = {
    name: "Type",
    getName: () => "Type",
    getEscapedName: () => "Type" as ts.__String,
  }

  const innerModelType = {
    getProperty: (name: string) => (name === "Type" ? innerTypeSymbol : undefined),
    getProperties: () => properties,
  }

  const modelSymbol = {
    name: "model",
    getName: () => "model",
    getEscapedName: () => "model" as ts.__String,
  }

  // ConfiguredModel type: has "model" property (not "Type" directly)
  const configuredModelType = {
    getProperty: (name: string) => (name === "model" ? modelSymbol : undefined),
    getProperties: () => [
      { name: "model", getName: () => "model", getEscapedName: () => "model" as ts.__String },
      {
        name: "attributes",
        getName: () => "attributes",
        getEscapedName: () => "attributes" as ts.__String,
      },
    ],
  }

  const program = {
    getSourceFile: () => sourceFile,
    getTypeChecker: () => ({
      getTypeAtLocation: () => configuredModelType,
      getTypeOfSymbolAtLocation: (sym: any) => {
        if (sym.name === "model") return innerModelType
        if (sym.name === "Type") return typeType
        return typeType
      },
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
      const _entities = resolveEntities(ts, sf)
      const info = mockInfo(sf)
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const filterDiag = diagnostics.filter((d) => d.code === DiagnosticCode.SK_IN_FILTER)
      expect(filterDiag).toHaveLength(1)
      expect(filterDiag[0]!.messageText).toContain("`status`")
      expect(filterDiag[0]!.messageText).toContain("query input")
      expect(filterDiag[0]!.category).toBe(ts.DiagnosticCategory.Warning)
    })

    it("EDD-9005: detects SK composite in .filter() after other combinators", () => {
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

        const active = db.entities.Tasks.byProject({ projectId: "p-1" })
          .onRequest(log)
          .filterBy(keep)
          .filter({ title: "x" })
          .ignoreOwnership()
          .filter({ status: "active" })
          .collect()
      `
      const sf = parseSource(source)
      const info = mockInfo(sf)
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const filterDiag = diagnostics.filter((d) => d.code === DiagnosticCode.SK_IN_FILTER)
      expect(filterDiag).toHaveLength(1)
      expect(filterDiag[0]!.messageText).toContain("`status`")
    })

    it("EDD-9005: detects SK composite in .filter() after .within(), and names .within()", () => {
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
              sk: { field: "gsi1sk", composite: ["status", "priority"] },
            },
          },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Tasks } })

        const urgent = db.entities.Tasks.byProject({ projectId: "p-1" })
          .within({ priority: { gte: 3 } })
          .filter({ status: "active" })
          .collect()
      `
      const sf = parseSource(source)
      const info = mockInfo(sf)
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const filterDiag = diagnostics.filter((d) => d.code === DiagnosticCode.SK_IN_FILTER)
      expect(filterDiag).toHaveLength(1)
      expect(filterDiag[0]!.messageText).toContain("`status`")
      expect(filterDiag[0]!.messageText).toContain("`.within()`")
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

    it("resolves model fields through DynamoModel.configure (ConfiguredModel)", () => {
      const source = `
        const Teams = Entity.make({
          model: DynamoModel.configure(Team, { id: { field: "teamId" } }),
          entityType: "Team",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
        })
      `
      const sf = parseSource(source)
      // Use ConfiguredModel mock — type has .model.Type, not .Type directly
      const info = mockInfoWithConfiguredModel(sf, ["id", "name", "country", "ranking"])
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      // Should NOT produce EDD-9002 for "id" — it should resolve through ConfiguredModel
      const unknownAttr = diagnostics.filter(
        (d) => d.code === DiagnosticCode.UNKNOWN_COMPOSITE_ATTR,
      )
      expect(unknownAttr).toHaveLength(0)
    })

    it("EDD-9002: no false positive for ref-derived <field>Id composites (#54)", () => {
      const source = `
        const TeamPlayerSelections = Entity.make({
          model: TeamPlayerSelection,
          entityType: "TeamPlayerSelection",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byTeam: {
              name: "gsi6",
              pk: { field: "gsi6pk", composite: ["teamId"] },
              sk: { field: "gsi6sk", composite: ["league", "season"] },
            },
            byPlayer: {
              name: "gsi7",
              pk: { field: "gsi7pk", composite: ["playerId"] },
              sk: { field: "gsi7sk", composite: ["league"] },
            },
          },
          refs: {
            team: { entity: Teams },
            player: { entity: Players },
          },
        })
      `
      const sf = parseSource(source)
      // Model exposes the bare ref fields `team` / `player` (no `teamId`/`playerId`)
      const info = mockInfoWithModelFields(sf, [
        "id",
        "team",
        "player",
        "league",
        "season",
        "series",
        "matchType",
        "role",
      ])
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const unknownAttr = diagnostics.filter(
        (d) => d.code === DiagnosticCode.UNKNOWN_COMPOSITE_ATTR,
      )
      expect(unknownAttr).toHaveLength(0)
    })

    it("EDD-9002: ref substitution also accepts ref-derived composite in the primary key", () => {
      const source = `
        const Memberships = Entity.make({
          model: Membership,
          entityType: "Membership",
          primaryKey: {
            pk: { field: "pk", composite: ["teamId"] },
            sk: { field: "sk", composite: ["playerId"] },
          },
          refs: {
            team: { entity: Teams },
            player: { entity: Players },
          },
        })
      `
      const sf = parseSource(source)
      const info = mockInfoWithModelFields(sf, ["team", "player", "joinedAt"])
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const unknownAttr = diagnostics.filter(
        (d) => d.code === DiagnosticCode.UNKNOWN_COMPOSITE_ATTR,
      )
      expect(unknownAttr).toHaveLength(0)
    })

    it("EDD-9002: still flags the bare ref field name (replaced by <field>Id)", () => {
      const source = `
        const Memberships = Entity.make({
          model: Membership,
          entityType: "Membership",
          primaryKey: {
            pk: { field: "pk", composite: ["team"] },
            sk: { field: "sk", composite: [] },
          },
          refs: {
            team: { entity: Teams },
          },
        })
      `
      const sf = parseSource(source)
      const info = mockInfoWithModelFields(sf, ["team", "joinedAt"])
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      // The bare `team` is removed from the valid set (replaced by `teamId`), so
      // referencing it is a genuine error — mirrors what `tsc` rejects.
      const unknownAttr = diagnostics.filter(
        (d) => d.code === DiagnosticCode.UNKNOWN_COMPOSITE_ATTR,
      )
      expect(unknownAttr).toHaveLength(1)
      expect(unknownAttr[0]!.messageText).toContain("`team`")
    })

    it("EDD-9002: still flags genuinely unknown attributes when refs are present", () => {
      const source = `
        const TeamPlayerSelections = Entity.make({
          model: TeamPlayerSelection,
          entityType: "TeamPlayerSelection",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byTeam: {
              name: "gsi6",
              pk: { field: "gsi6pk", composite: ["teamId"] },
              sk: { field: "gsi6sk", composite: ["nonExistent"] },
            },
          },
          refs: {
            team: { entity: Teams },
          },
        })
      `
      const sf = parseSource(source)
      const info = mockInfoWithModelFields(sf, ["id", "team", "league"])
      const diagnostics = getDiagnostics(ts, info, "test.ts", [])

      const unknownAttr = diagnostics.filter(
        (d) => d.code === DiagnosticCode.UNKNOWN_COMPOSITE_ATTR,
      )
      expect(unknownAttr).toHaveLength(1)
      expect(unknownAttr[0]!.messageText).toContain("`nonExistent`")
    })
  })

  describe("Z-order sort keys (#171)", () => {
    const listings = (usage: string) => `
      const AppSchema = DynamoSchema.make({ name: "test", version: 1 })

      const Listings = Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: {
          pk: { field: "pk", composite: ["listingId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          search: {
            name: "gsi2",
            pk: { field: "gsi2pk", composite: ["region"] },
            sk: {
              field: "gsi2sk",
              prefix: ["agencyId"],
              zorder: [{ field: "price", min: 0, max: 5000000, step: 1000 }, { field: "bedrooms", min: 0, max: 15 }],
            },
          },
        },
      })

      const MainTable = Table.make({ schema: AppSchema, entities: { Listings } })

      ${usage}
    `
    const diagnose = (source: string, fields?: string[]) => {
      const sf = parseSource(source)
      const info = fields === undefined ? mockInfo(sf) : mockInfoWithModelFields(sf, fields)
      return getDiagnostics(ts, info, "test.ts", [])
    }

    it("EDD-9093: a dimension or prefix composite passed to the accessor", () => {
      const diagnostics = diagnose(
        listings(
          `const r = db.entities.Listings.search({ region: "north", agencyId: "ag-1", price: 5 }).collect()`,
        ),
      )
      const misplaced = diagnostics.filter(
        (d) => d.code === DiagnosticCode.ZORDER_FIELD_IN_ACCESSOR,
      )
      expect(misplaced).toHaveLength(2)
      expect(misplaced[0]!.messageText).toContain("`agencyId` feeds the Z-order sort key")
      expect(misplaced[1]!.messageText).toContain("`price`")
      expect(misplaced[0]!.messageText).toContain(".within()")
      expect(misplaced[0]!.category).toBe(ts.DiagnosticCategory.Error)
      // No prefix-ordering complaint: a Z-order key has no text prefix.
      expect(diagnostics.filter((d) => d.code === DiagnosticCode.SK_PREFIX_VIOLATION)).toEqual([])
    })

    it("EDD-9093: a dimension declared by reference is still a Z-order field", () => {
      const source = listings(
        `const r = db.entities.Listings.search({ region: "north", listedAt: 5 }).collect()`,
      ).replace('{ field: "bedrooms", min: 0, max: 15 }]', "bedrooms, listed]")
      const diagnostics = diagnose(
        `const bedrooms = { field: "bedrooms", min: 0, max: 15 }
        const listed = { field: "listedAt", from: "2024-01-01", unit: "hours", bits: 16 }
        ${source}`,
      )
      const misplaced = diagnostics.filter(
        (d) => d.code === DiagnosticCode.ZORDER_FIELD_IN_ACCESSOR,
      )
      expect(misplaced).toHaveLength(1)
      expect(misplaced[0]!.messageText).toContain("`listedAt` feeds the Z-order sort key")
    })

    it("EDD-9006: an unknown attribute on a Z-order accessor lists the partition key composites", () => {
      const diagnostics = diagnose(
        listings(
          `const r = db.entities.Listings.search({ region: "north", colour: "red" }).collect()`,
        ),
      )
      const unknown = diagnostics.filter((d) => d.code === DiagnosticCode.UNKNOWN_QUERY_PROPERTY)
      expect(unknown).toHaveLength(1)
      expect(unknown[0]!.messageText).toContain("Valid attributes: `region`")
    })

    it("no diagnostic for an accessor given the partition key composites", () => {
      const diagnostics = diagnose(
        listings(`const r = db.entities.Listings.search({ region: "north" }).collect()`),
      )
      expect(diagnostics).toEqual([])
    })

    it("EDD-9005: a Z-order field in .filter() points at .within()", () => {
      const diagnostics = diagnose(
        listings(
          `const r = db.entities.Listings.search({ region: "north" }).filter({ price: 5 }).collect()`,
        ),
      )
      const filterDiag = diagnostics.filter((d) => d.code === DiagnosticCode.SK_IN_FILTER)
      expect(filterDiag).toHaveLength(1)
      expect(filterDiag[0]!.messageText).toContain("`price` feeds the Z-order sort key")
      expect(filterDiag[0]!.messageText).toContain(".within()")
      expect(filterDiag[0]!.messageText).not.toContain("query input")
    })

    it("EDD-9002: an unknown dimension or prefix field", () => {
      const diagnostics = diagnose(listings(""), ["listingId", "region", "agencyId", "price"])
      const unknown = diagnostics.filter((d) => d.code === DiagnosticCode.UNKNOWN_COMPOSITE_ATTR)
      expect(unknown).toHaveLength(1)
      expect(unknown[0]!.messageText).toContain("`bedrooms`")
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
