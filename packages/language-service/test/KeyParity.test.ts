import { DynamoSchema, KeyComposer } from "@effect-dynamodb/schema"
import { describe, expect, it } from "vitest"
import type { Casing, IndexDefinition, ResolvedEntity } from "../src/core/EntityResolver"
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
