import { DynamoSchema, KeyComposer } from "@effect-dynamodb/schema"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  type Casing,
  type IndexDefinition,
  type ResolvedEntity,
  resolveEntities,
} from "../src/core/EntityResolver"
import { buildParamsOrThrow } from "./helpers/params"

// The plugin mirrors the library's key composition (it is CommonJS and cannot
// load the ESM-only schema package). These cases pin the mirror to the library:
// any change to key composition must land in both, or this fails.

const indexes = {
  primary: {
    pk: { field: "pk", composite: ["orgId", "seq"] },
    sk: { field: "sk", composite: [] },
  },
  byTeam: {
    index: "gsi1",
    pk: { field: "gsi1pk", composite: ["teamId"] },
    sk: { field: "gsi1sk", composite: ["status", "title"] },
  },
  byOrg: {
    index: "gsi2",
    collection: "OrgData",
    pk: { field: "gsi2pk", composite: ["orgId"] },
    sk: { field: "gsi2sk", composite: ["title"] },
  },
  byRegion: {
    index: "gsi3",
    collection: ["Region", "Site"],
    type: "clustered",
    pk: { field: "gsi3pk", composite: ["regionId"] },
    sk: { field: "gsi3sk", composite: ["status"] },
  },
  byOwner: {
    index: "gsi4",
    casing: "preserve",
    pk: { field: "gsi4pk", composite: ["ownerId"] },
    sk: { field: "gsi4sk", composite: [] },
  },
} satisfies Record<string, IndexDefinition>

const record = {
  orgId: "Org-A",
  seq: 42,
  teamId: "Team-B",
  status: "Open",
  title: "Fix Keys",
  regionId: "EU-1",
  ownerId: "Owner-C",
  active: true,
}

const entityFor = (casing: Casing): ResolvedEntity => ({
  variableName: "Tickets",
  entityType: "Ticket",
  schema: { name: "Help-Desk", version: 3, casing },
  indexes,
  timestamps: false,
  versioned: false,
  softDelete: false,
  unique: undefined,
})

describe("key composition parity with @effect-dynamodb/schema", () => {
  for (const casing of ["lowercase", "uppercase", "preserve"] as const) {
    describe(`casing: "${casing}"`, () => {
      const entity = entityFor(casing)
      const schema = DynamoSchema.make({ name: "Help-Desk", version: 3, casing })

      it("put writes the same keys for every index", () => {
        const params = buildParamsOrThrow({ entity, type: "put", arguments: record })
        const expected = KeyComposer.composeAllKeys(schema, "Ticket", 1, indexes, record)
        for (const [field, value] of Object.entries(expected)) {
          expect(params.Item![field], field).toBe(value)
        }
      })

      it("get uses the same primary key", () => {
        const params = buildParamsOrThrow({
          entity,
          type: "get",
          arguments: { orgId: "Org-A", seq: 42 },
        })
        expect(params.Key).toEqual(
          KeyComposer.composeIndexKeys(schema, "Ticket", 1, indexes.primary, record),
        )
      })

      for (const [name, args] of [
        ["byTeam", { teamId: "Team-B" }],
        ["byTeam", { teamId: "Team-B", status: "Open" }],
        ["byOrg", { orgId: "Org-A" }],
        ["byRegion", { regionId: "EU-1" }],
      ] as const) {
        it(`query ${name} ${JSON.stringify(args)} uses the same PK and begins_with operand`, () => {
          const index = indexes[name]
          const params = buildParamsOrThrow({
            entity,
            type: "query",
            indexName: name,
            arguments: args,
          })
          expect(params.ExpressionAttributeValues![":pk"]).toBe(
            KeyComposer.composePk(schema, "Ticket", index, args),
          )
          expect(params.ExpressionAttributeValues![":skPrefix"]).toBe(
            KeyComposer.composeSortKeyBeginsWith(schema, "Ticket", 1, index, args),
          )
        })
      }
    })
  }
})

// Index-level `casing` read from source must reach the keys the same way
// `Entity.make` carries it: as-is on `primaryKey`, via `normalizeGsiConfig` on
// each GSI.
describe("index-level casing from source matches Entity.make", () => {
  const primaryKey = {
    pk: { field: "pk", composite: ["orgId"] },
    sk: { field: "sk", composite: [] },
    casing: "uppercase",
  } as const
  const gsis = {
    byTeam: {
      name: "gsi1",
      casing: "preserve",
      pk: { field: "gsi1pk", composite: ["teamId"] },
      sk: { field: "gsi1sk", composite: ["status"] },
    },
  } as const

  // Same configuration as above, as the plugin sees it in source.
  const source = `
    const AppSchema = DynamoSchema.make({ name: "Help-Desk", version: 3 })
    const Tickets = Entity.make({
      model: Ticket,
      entityType: "Ticket",
      primaryKey: {
        pk: { field: "pk", composite: ["orgId"] },
        sk: { field: "sk", composite: [] },
        casing: "uppercase",
      },
      indexes: {
        byTeam: {
          name: "gsi1",
          casing: "preserve",
          pk: { field: "gsi1pk", composite: ["teamId"] },
          sk: { field: "gsi1sk", composite: ["status"] },
        },
      },
    })
    const MainTable = Table.make({ schema: AppSchema, entities: { Tickets } })
  `

  it("put writes the same keys", () => {
    const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const entity = resolveEntities(ts, sf)[0]!
    const params = buildParamsOrThrow({ entity, type: "put", arguments: record })

    const schema = DynamoSchema.make({ name: "Help-Desk", version: 3 })
    const indexes = {
      primary: primaryKey,
      byTeam: KeyComposer.normalizeGsiConfig(gsis.byTeam),
    }
    const expected = KeyComposer.composeAllKeys(schema, "Ticket", 1, indexes, record)
    expect(expected.gsi1pk).toBe("$help-desk#v3#Ticket#teamId_Team-B")
    for (const [field, value] of Object.entries(expected)) {
      expect(params.Item![field], field).toBe(value)
    }
  })
})
