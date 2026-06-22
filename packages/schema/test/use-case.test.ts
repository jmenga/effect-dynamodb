/**
 * Use-case verification — a consumer imports `Entity.make` / `Aggregate.make`
 * from `@effect-dynamodb/schema` (this package, no AWS SDK), builds entities and
 * aggregates, and reads the derived `inputSchema` / `updateSchema` / `createSchema`
 * with full types. Confirms #61's branded-id derivation holds from the schema
 * package.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"

const TeamId = Schema.String.pipe(Schema.brand("TeamId"))
const PlayerId = Schema.String.pipe(Schema.brand("PlayerId"))

class Team extends Schema.Class<Team>("Team")({
  teamId: TeamId,
  name: Schema.NonEmptyString,
}) {}

class Player extends Schema.Class<Player>("Player")({
  playerId: PlayerId,
  team: Team,
  displayName: Schema.NonEmptyString,
}) {}

const Teams = Entity.make({
  model: DynamoModel.configure(Team, { teamId: { identifier: true } }),
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["teamId"] },
    sk: { field: "sk", composite: [] },
  },
})

const Players = Entity.make({
  model: DynamoModel.configure(Player, {
    playerId: { identifier: true },
    team: { ref: true },
  }),
  entityType: "Player",
  primaryKey: {
    pk: { field: "pk", composite: ["playerId"] },
    sk: { field: "sk", composite: [] },
  },
  refs: { team: { entity: Teams } },
})

describe("@effect-dynamodb/schema use-case", () => {
  it("Entity.make returns a pure definition carrying derived schemas", () => {
    expect(Teams._tag).toBe("Entity")
    expect(Teams.entityType).toBe("Team")
    expect(Teams.inputSchema).toBeDefined()
    expect(Teams.updateSchema).toBeDefined()
    expect(Teams.createSchema).toBeDefined()
    // No CRUD operations on the pure definition.
    expect((Teams as unknown as { get?: unknown }).get).toBeUndefined()
    expect((Teams as unknown as { put?: unknown }).put).toBeUndefined()
  })

  it.effect("inputSchema decodes input and preserves the branded id type (#61)", () =>
    Effect.gen(function* () {
      // typeof Teams.inputSchema.Type — the derived input payload type.
      type TeamInput = typeof Teams.inputSchema.Type
      const decoded: TeamInput = yield* Schema.decodeUnknownEffect(Teams.inputSchema)({
        teamId: "t-1",
        name: "Hurricanes",
      })
      // Brand is preserved at the value level (TeamId string).
      expect(decoded.teamId).toBe("t-1")
      expect(decoded.name).toBe("Hurricanes")
      // Static brand assertion — must compile.
      const brandCheck: import("effect").Brand.Brand<"TeamId"> & string = decoded.teamId
      expect(typeof brandCheck).toBe("string")
    }),
  )

  it.effect("ref-aware inputSchema replaces ref with a branded fieldId (#61)", () =>
    Effect.gen(function* () {
      type PlayerInput = typeof Players.inputSchema.Type
      const decoded: PlayerInput = yield* Schema.decodeUnknownEffect(Players.inputSchema)({
        playerId: "p-1",
        teamId: "t-1",
        displayName: "Ada",
      })
      expect(decoded.playerId).toBe("p-1")
      // ref field "team" is replaced with branded "teamId" on input.
      const teamId: import("effect").Brand.Brand<"TeamId"> & string = decoded.teamId
      expect(teamId).toBe("t-1")
      // The model field "team" is NOT on the input payload.
      expect((decoded as Record<string, unknown>).team).toBeUndefined()
    }),
  )

  it("Aggregate.make returns a pure definition carrying derived schemas", () => {
    const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
    const Roster = Aggregate.make(Team, {
      table: { Tag: Symbol.for("test/table") },
      schema: AppSchema,
      pk: { field: "pk", composite: ["teamId"] },
      collection: { index: "gsi1", name: "roster", sk: { field: "gsi1sk", composite: [] } },
      root: { entityType: "Team" },
      edges: {},
    })
    expect(Roster._tag).toBe("Aggregate")
    expect(Roster.inputSchema).toBeDefined()
    expect(Roster.updateSchema).toBeDefined()
    expect(Roster.createSchema).toBeDefined()
    // typeof Roster.inputSchema.Type — the derived aggregate input type (must compile).
    type _RosterInput = typeof Roster.inputSchema.Type
    // No operational members on the pure aggregate definition.
    expect((Roster as unknown as { get?: unknown }).get).toBeUndefined()
  })

  it("authors aggregate edges from pure entity definitions (#66)", () => {
    // The pure edge constructors must accept pure `EntityDefinition`s — which
    // have no runtime `get` — so the aggregate edge graph can be built entirely
    // from `@effect-dynamodb/schema` (no AWS runtime). Before the fix these
    // failed to type-check ("Property 'get' is missing"). The tsconfig.test.json
    // gate type-checks this file, so a regression fails the build.
    const refEdge = Aggregate.ref(Teams)
    const oneEdge = Aggregate.one("captain", { entityType: "Player", entity: Players })
    const manyEdge = Aggregate.many("players", { entityType: "Player", entity: Players })
    expect(refEdge._tag).toBe("RefEdge")
    expect(oneEdge._tag).toBe("OneEdge")
    expect(manyEdge._tag).toBe("ManyEdge")

    // ...and they compose into an aggregate authored purely from definitions.
    const AppSchema = DynamoSchema.make({ name: "squadapp", version: 1 })
    const Squad = Aggregate.make(Player, {
      table: { Tag: Symbol.for("test/squad-table") },
      schema: AppSchema,
      pk: { field: "pk", composite: ["playerId"] },
      collection: { index: "gsi1", name: "squad", sk: { field: "gsi1sk", composite: [] } },
      root: { entityType: "Player" },
      edges: { team: Aggregate.ref(Teams) },
    })
    expect(Squad.inputSchema).toBeDefined()
  })

  it("deriveAggregateSchemas is typed without a table tag (#67)", () => {
    // Table-free, AWS-free: no stub `table` tag and no GSI key config — just the
    // model, edges, and pk composites. The returned schemas must be precisely
    // typed (NOT `Schema.Top`/`unknown`), so a contract package can read the
    // derived create payload type directly. Also exercises #66 (pure ref edge).
    const derived = Aggregate.deriveAggregateSchemas(Player, { team: Aggregate.ref(Teams) }, [
      "playerId",
    ])
    expect(derived.inputSchema).toBeDefined()
    expect(derived.createSchema).toBeDefined()
    expect(derived.updateSchema).toBeDefined()

    // Regression guard for #67: the derived input is a precise object type, so
    // accessing known fields type-checks. If it collapsed to `unknown` (the bug)
    // these would be compile errors — the schema `tsconfig.test.json` gate
    // type-checks this file, so a regression fails the build.
    type DerivedInput = typeof derived.inputSchema.Type
    const readDisplayName = (i: DerivedInput): string => i.displayName
    const readTeamId = (i: DerivedInput): string => i.teamId // ref "team" flattened to "teamId"
    void readDisplayName
    void readTeamId
  })

  it.effect("aggregate inputSchema decodes a typed payload", () =>
    Effect.gen(function* () {
      const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
      const Roster = Aggregate.make(Team, {
        table: { Tag: Symbol.for("test/table") },
        schema: AppSchema,
        pk: { field: "pk", composite: ["teamId"] },
        collection: { index: "gsi1", name: "roster", sk: { field: "gsi1sk", composite: [] } },
        root: { entityType: "Team" },
        edges: {},
      })
      const decoded = yield* Schema.decodeUnknownEffect(Roster.inputSchema)({ name: "Hurricanes" })
      expect((decoded as Record<string, unknown>).name).toBe("Hurricanes")
    }),
  )
})
