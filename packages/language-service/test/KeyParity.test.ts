import { DynamoSchema, KeyComposer } from "@effect-dynamodb/schema"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  type Casing,
  type IndexDefinition,
  type ResolvedCollection,
  type ResolvedEntity,
  resolveEntities,
} from "../src/core/EntityResolver"
import type { DetectedOperation } from "../src/core/OperationDetector"
import { buildParamsOrThrow } from "./helpers/params"

// The plugin mirrors the library's key composition (it is CommonJS and cannot
// load the ESM-only schema package). These cases pin the mirror to the library:
// any change to key composition must land in both, or this fails.
//
// String keys only. A Z-order sort key (#171) is a binary address the plugin
// never composes — it shows `<binary Z-order key>` (see ParamsBuilder.test.ts) —
// so there is no text for parity to pin.

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

      // Every SK composite given: the library sends `=` on the complete key.
      for (const [name, args] of [
        ["byTeam", { teamId: "Team-B", status: "Open", title: "Fix Keys" }],
        ["byOrg", { orgId: "Org-A", title: "Fix Keys" }],
        ["byRegion", { regionId: "EU-1", status: "Open" }],
      ] as const) {
        it(`query ${name} ${JSON.stringify(args)} uses the same exact sort key condition`, () => {
          const index = indexes[name]
          const params = buildParamsOrThrow({
            entity,
            type: "query",
            indexName: name,
            arguments: args,
          })
          const condition = KeyComposer.composeSortKeyCondition(schema, "Ticket", 1, index, args)
          expect(params.KeyConditionExpression).toBe("#pk = :pk AND #sk = :sk")
          expect(params.ExpressionAttributeValues![":sk"]).toBe(
            "eq" in condition ? condition.eq : undefined,
          )
        })
      }

      // The bound accessor (`db.entities.Tickets.<index>(…)`) — through the
      // index, and through a collection its index belongs to — sends the
      // library accessor's condition: none without a sort key composite (an
      // empty-composite half among them), `=` on a complete key, and a
      // terminated `begins_with` on a prefix.
      const collectionOf = (name: "byOrg" | "byRegion"): ResolvedCollection => {
        const index = indexes[name]
        const collectionName = typeof index.collection === "string" ? index.collection : "Region"
        return {
          variableName: collectionName,
          collectionName,
          index: index.index,
          type: name === "byRegion" ? "clustered" : "isolated",
          pk: index.pk,
          sk: { field: index.sk.field },
          members: {
            Tickets: { entityVariableName: "Tickets", sk: { composite: index.sk.composite } },
          },
        }
      }
      for (const [name, args] of [
        ["primary", { orgId: "Org-A", seq: 42 }],
        ["byOwner", { ownerId: "Owner-C" }],
        ["byTeam", { teamId: "Team-B" }],
        ["byTeam", { teamId: "Team-B", status: "Open" }],
        ["byTeam", { teamId: "Team-B", status: "Open", title: "Fix Keys" }],
        ["byOrg", { orgId: "Org-A" }],
        ["byOrg", { orgId: "Org-A", title: "Fix Keys" }],
        ["byRegion", { regionId: "EU-1" }],
        ["byRegion", { regionId: "EU-1", status: "Open" }],
      ] as const) {
        const index = indexes[name]
        const given = index.sk.composite.filter(
          (attr) => (args as Record<string, unknown>)[attr] !== undefined,
        )
        const expected =
          given.length === 0
            ? undefined
            : KeyComposer.composeSortKeyCondition(schema, "Ticket", 1, index, args)
        const ops: Array<[string, DetectedOperation]> = [
          ["index", { entity, type: "entity-query-accessor", indexName: name, arguments: args }],
        ]
        if (name === "byOrg" || name === "byRegion") {
          ops.push([
            "collection",
            {
              entity,
              type: "entity-query-accessor",
              collection: collectionOf(name),
              collectionName: collectionOf(name).collectionName,
              arguments: args,
            },
          ])
        }
        for (const [via, op] of ops) {
          it(`accessor ${name} ${JSON.stringify(args)} via the ${via} sends the library's sort key condition`, () => {
            const params = buildParamsOrThrow(op)
            expect(params.ExpressionAttributeValues![":pk"]).toBe(
              KeyComposer.composePk(schema, "Ticket", index, args),
            )
            if (expected === undefined) {
              expect(params.KeyConditionExpression).toBe("#pk = :pk")
            } else if ("eq" in expected) {
              expect(params.KeyConditionExpression).toBe("#pk = :pk AND #sk = :sk")
              expect(params.ExpressionAttributeValues![":sk"]).toBe(expected.eq)
            } else {
              expect(params.KeyConditionExpression).toBe(
                "#pk = :pk AND begins_with(#sk, :skPrefix)",
              )
              expect(params.ExpressionAttributeValues![":skPrefix"]).toBe(expected.beginsWith)
            }
          })
        }
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

// Numeric composites (#171 E8): the mirror's order-preserving numeric encoding
// against the library's, over the edge values and a seeded spread of doubles
// and bigints (this package has no property-test runner).
describe("numeric key text parity with @effect-dynamodb/schema", () => {
  const numericIndexes = {
    primary: {
      pk: { field: "pk", composite: ["n"] },
      sk: { field: "sk", composite: ["b", "n"] },
    },
  } satisfies Record<string, IndexDefinition>
  const schema = DynamoSchema.make({ name: "Help-Desk", version: 3 })
  const entity: ResolvedEntity = {
    ...entityFor("lowercase"),
    indexes: numericIndexes,
  }

  // A deterministic xorshift spread: doubles from raw bit patterns (every
  // exponent, subnormals included) and bigints of up to 60 digits.
  let state = 0x2545f491
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
  const view = new DataView(new ArrayBuffer(8))
  const doubles: Array<number> = []
  while (doubles.length < 300) {
    view.setUint32(0, next())
    view.setUint32(4, next())
    const x = view.getFloat64(0)
    if (Number.isFinite(x)) doubles.push(x)
  }
  const bigints = Array.from({ length: 100 }, (_, i) => {
    const digits = Array.from({ length: 1 + (next() % 60) }, () => String(next() % 10)).join("")
    return (i % 2 === 0 ? 1n : -1n) * BigInt(digits)
  })
  const edges = [
    0,
    -0,
    1,
    -1,
    3,
    3.1,
    3.14,
    -3,
    -3.1,
    -3.14,
    0.5,
    -0.5,
    1e-7,
    -1e-7,
    10.5,
    19.99,
    2 ** 53 - 1,
    2 ** 53 + 2,
    1e16 - 2,
    1e16,
    1e16 + 2,
    -1e16,
    -1.5e16,
    1e21,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
  ]
  const bigEdges = [0n, 1n, -1n, 10n ** 38n - 1n, 10n ** 38n, 10n ** 38n + 1n, -(10n ** 38n)]

  it("put composes the library's keys for every value", () => {
    for (const n of [...edges, ...doubles]) {
      for (const b of [...bigEdges, ...bigints.slice(0, 3)]) {
        const record = { n, b }
        const params = buildParamsOrThrow({ entity, type: "put", arguments: record })
        const expected = KeyComposer.composeAllKeys(schema, "Ticket", 1, numericIndexes, record)
        expect(params.Item!.pk, String(n)).toBe(expected.pk)
        expect(params.Item!.sk, `${b} ${n}`).toBe(expected.sk)
      }
    }
    for (const b of bigints) {
      const record = { n: 1, b }
      const params = buildParamsOrThrow({ entity, type: "put", arguments: record })
      expect(params.Item!.sk, String(b)).toBe(
        KeyComposer.composeAllKeys(schema, "Ticket", 1, numericIndexes, record).sk,
      )
    }
  })
})

describe("sort key text escaping parity with @effect-dynamodb/schema (#171)", () => {
  // Every escaped code point (U+0000–U+0025), the first one that isn't, and
  // values casing maps unevenly: a sort key escapes them, a partition key
  // keeps them as they are.
  const values = [
    ...Array.from({ length: 0x27 }, (_, code) => `a${String.fromCharCode(code)}b`),
    "New York",
    "a#b",
    "50%",
    "$Root",
    "Line\nTwo",
    "\nΣ",
    "Straße",
    "😀 Grin",
  ]
  const textIndexes = {
    primary: {
      pk: { field: "pk", composite: ["title"] },
      sk: { field: "sk", composite: ["status", "title"] },
    },
    byStatus: {
      index: "gsi1",
      collection: ["Region", "Site"],
      type: "clustered",
      pk: { field: "gsi1pk", composite: ["teamId"] },
      sk: { field: "gsi1sk", composite: ["status", "title"] },
    },
  } satisfies Record<string, IndexDefinition>

  for (const casing of ["lowercase", "uppercase", "preserve"] as const) {
    const schema = DynamoSchema.make({ name: "Help-Desk", version: 3, casing })
    const entity: ResolvedEntity = { ...entityFor(casing), indexes: textIndexes }

    it(`put, the begins_with operand and the exact key match the library (${casing})`, () => {
      for (const status of values) {
        for (const title of ["T", "a#b c"]) {
          const record = { title, status, teamId: "Team-B" }
          const params = buildParamsOrThrow({ entity, type: "put", arguments: record })
          const expected = KeyComposer.composeAllKeys(schema, "Ticket", 1, textIndexes, record)
          for (const [field, value] of Object.entries(expected)) {
            expect(params.Item![field], `${field} ${JSON.stringify(record)}`).toBe(value)
          }
          const partial = buildParamsOrThrow({
            entity,
            type: "query",
            indexName: "byStatus",
            arguments: { teamId: "Team-B", status },
          })
          expect(partial.ExpressionAttributeValues![":skPrefix"], JSON.stringify(status)).toBe(
            KeyComposer.composeSortKeyBeginsWith(schema, "Ticket", 1, textIndexes.byStatus, {
              status,
            }),
          )
          const complete = buildParamsOrThrow({
            entity,
            type: "query",
            indexName: "byStatus",
            arguments: record,
          })
          expect(complete.ExpressionAttributeValues![":sk"], JSON.stringify(record)).toBe(
            KeyComposer.composeSk(schema, "Ticket", 1, textIndexes.byStatus, record),
          )
        }
      }
    })
  }
})
