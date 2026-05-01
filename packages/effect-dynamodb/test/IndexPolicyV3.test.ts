/**
 * Entity-level integration tests for indexPolicy v3 semantics (refs #39).
 *
 * Covers the wiring through `Entity.update` (standard updateItem path),
 * `Entity.update` retain path, and `.append()`. KeyComposer-level unit tests
 * live in `KeyComposer.test.ts`; this file proves the v3 semantics make it
 * through the Entity layer to the wire (UpdateExpression / TransactItems).
 *
 * The tests are mock-based (no DynamoDB) — they capture the request payload
 * sent to `client.updateItem` / `client.transactWriteItems` and assert on
 * the SET / REMOVE clauses and key composition.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { CompositeKeyHoleError, CompositeNullableError } from "../src/Errors.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Mock client capture helpers
// ---------------------------------------------------------------------------

type Capture = {
  updateItem?: Record<string, unknown>
  transactWriteItems?: Record<string, unknown>
}

const makeMockClient = (capture: Capture) => ({
  putItem: () => Effect.die("putItem not used"),
  getItem: () =>
    Effect.succeed({
      Item: {
        // Pretend the stored item has the full hierarchy populated.
        pk: { S: "$app#v1#asset#a-1" } as AttributeValue,
        sk: { S: "$app#v1#asset" } as AttributeValue,
        assetId: { S: "a-1" } as AttributeValue,
        region: { S: "americas" } as AttributeValue,
        country: { S: "us" } as AttributeValue,
        city: { S: "sf" } as AttributeValue,
        site: { S: "datacenter-1" } as AttributeValue,
        gsi1pk: { S: "$app#v1#asset#region_americas" } as AttributeValue,
        gsi1sk: {
          S: "$app#v1#asset#country_us#city_sf#site_datacenter-1",
        } as AttributeValue,
        version: { N: "1" } as AttributeValue,
        __edd_e__: { S: "Asset" } as AttributeValue,
        createdAt: { S: "2026-01-01T00:00:00.000Z" } as AttributeValue,
        updatedAt: { S: "2026-01-01T00:00:00.000Z" } as AttributeValue,
      },
    }),
  updateItem: (input: Record<string, unknown>) => {
    capture.updateItem = input
    return Effect.succeed({
      Attributes: {
        pk: { S: "$app#v1#x" } as AttributeValue,
        sk: { S: "$app#v1#x" } as AttributeValue,
        pageId: { S: "p-1" } as AttributeValue,
        assetId: { S: "a-1" } as AttributeValue,
        __edd_e__: { S: "X" } as AttributeValue,
      },
    })
  },
  transactWriteItems: (input: Record<string, unknown>) => {
    capture.transactWriteItems = input
    return Effect.succeed({})
  },
  deleteItem: () => Effect.die("deleteItem not used"),
  query: () => Effect.die("query not used"),
  scan: () => Effect.die("scan not used"),
  batchGetItem: () => Effect.die("batchGetItem not used"),
  batchWriteItem: () => Effect.die("batchWriteItem not used"),
  transactGetItems: () => Effect.die("transactGetItems not used"),
  createTable: () => Effect.die("createTable not used"),
  deleteTable: () => Effect.die("deleteTable not used"),
  describeTable: () => Effect.die("describeTable not used"),
  updateTimeToLive: () => Effect.die("updateTimeToLive not used"),
  describeTimeToLive: () => Effect.die("describeTimeToLive not used"),
  updateContinuousBackups: () => Effect.die("updateContinuousBackups not used"),
  describeContinuousBackups: () => Effect.die("describeContinuousBackups not used"),
  createBackup: () => Effect.die("createBackup not used"),
  describeBackup: () => Effect.die("describeBackup not used"),
  deleteBackup: () => Effect.die("deleteBackup not used"),
  restoreTableFromBackup: () => Effect.die("restoreTableFromBackup not used"),
  restoreTableToPointInTime: () => Effect.die("restoreTableToPointInTime not used"),
  exportTableToPointInTime: () => Effect.die("exportTableToPointInTime not used"),
  describeExport: () => Effect.die("describeExport not used"),
  listExports: () => Effect.die("listExports not used"),
  tagResource: () => Effect.die("tagResource not used"),
  untagResource: () => Effect.die("untagResource not used"),
  listTagsOfResource: () => Effect.die("listTagsOfResource not used"),
})

const makeLayer = (capture: Capture) => Layer.succeed(DynamoClient, makeMockClient(capture) as any)

// ---------------------------------------------------------------------------
// Fixture: geographic asset hierarchy
// ---------------------------------------------------------------------------

class Asset extends Schema.Class<Asset>("Asset")({
  assetId: Schema.String,
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  site: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
}) {}

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })

const Assets = Entity.make({
  model: Asset,
  entityType: "Asset",
  primaryKey: {
    pk: { field: "pk", composite: ["assetId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byLocation: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", composite: ["country", "city", "site"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
  timestamps: true,
  versioned: { retain: true },
})

const AppTable = Table.make({ schema: AppSchema, entities: { Assets } })

const TableLayer = AppTable.layer({ name: "app-table" })

// ---------------------------------------------------------------------------
// Tests — retain path uses transactWriteItems; the standard path uses updateItem.
// The Asset fixture uses retain: true so retain-path semantics are exercised.
// ---------------------------------------------------------------------------

describe("Entity update — indexPolicy v3 wiring (retain path)", () => {
  it.effect("Entity.remove(['site']) cascades — drops both GSI keys", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Assets },
        tables: { AppTable },
      })
      yield* db.entities.Assets.update({ assetId: "a-1" }).remove(["site"])

      const tx = capture.transactWriteItems
      expect(tx).toBeDefined()
      const items = (tx as { TransactItems?: Array<unknown> }).TransactItems
      expect(items?.length).toBeGreaterThan(0)
      const mainPut = items?.[0] as { Put?: { Item?: Record<string, AttributeValue> } }
      const item = mainPut.Put?.Item
      expect(item).toBeDefined()
      expect(item!.gsi1pk).toBeUndefined()
      expect(item!.gsi1sk).toBeUndefined()
    }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
  })

  it.effect("Entity.remove(['country']) cascades the whole GSI", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Assets },
        tables: { AppTable },
      })
      yield* db.entities.Assets.update({ assetId: "a-1" }).remove(["country"])
      const tx = capture.transactWriteItems
      const item = (
        tx as { TransactItems: Array<{ Put: { Item: Record<string, AttributeValue> } }> }
      ).TransactItems[0]!.Put.Item
      expect(item.gsi1pk).toBeUndefined()
      expect(item.gsi1sk).toBeUndefined()
    }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
  })
})

// ---------------------------------------------------------------------------
// Standard update path tests — Pages fixture (no retain)
// ---------------------------------------------------------------------------

class Page extends Schema.Class<Page>("Page")({
  pageId: Schema.String,
  X: Schema.optional(Schema.String),
  Y: Schema.optional(Schema.String),
  Z: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
}) {}

const Pages = Entity.make({
  model: Page,
  entityType: "Page",
  primaryKey: {
    pk: { field: "pk", composite: ["pageId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    gA: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["X"] },
      sk: { field: "gsi1sk", composite: ["pageId"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
    gB: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["Y"] },
      sk: { field: "gsi2sk", composite: ["pageId"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
    gC: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["Z"] },
      sk: { field: "gsi3sk", composite: ["pageId"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
})

const PagesTable = Table.make({ schema: AppSchema, entities: { Pages } })
const PagesTableLayer = PagesTable.layer({ name: "pages-table" })

const makePagesMock = (capture: Capture) => ({
  ...makeMockClient(capture),
  // No retain on Pages, so getItem isn't called. Only updateItem matters.
  getItem: () => Effect.die("getItem not expected on standard path"),
})

describe("Entity update — standard path migration regression (issue #36 / #39)", () => {
  it.effect(
    "partial update that omits preserve-policied composites does NOT generate REMOVE",
    () => {
      const capture: Capture = {}
      const layer = Layer.mergeAll(
        Layer.succeed(DynamoClient, makePagesMock(capture) as any),
        PagesTableLayer,
      )
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Pages },
          tables: { PagesTable },
        })
        // Update only `name` — never mentions X, Y, Z. Pre-1.6 with sparse on
        // those composites generated REMOVE gsi1pk/sk + gsi2pk/sk + gsi3pk/sk
        // (six unwanted REMOVEs). Under v3 with all halves preserve, a partial
        // update that doesn't touch X/Y/Z is a no-op for those PK halves (the
        // SK halves recompose because they share the primary key composite
        // pageId).
        yield* db.entities.Pages.update({ pageId: "p-1" }).set({ name: "new-name" })
        const ui = capture.updateItem as {
          UpdateExpression?: string
          ExpressionAttributeNames?: Record<string, string>
        }
        expect(ui.UpdateExpression).toBeDefined()
        const expr = ui.UpdateExpression!
        const removeClause = expr.match(/REMOVE\s+([^A-Z]*)/i)?.[1] ?? ""
        const physicalRemoves = removeClause
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((alias) => ui.ExpressionAttributeNames?.[alias] ?? alias)
        for (const name of physicalRemoves) {
          expect(name).not.toMatch(/^gsi\d(pk|sk)$/)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)
    },
  )
})

// ---------------------------------------------------------------------------
// Hole detection — preserve throws, sparse truncates
// ---------------------------------------------------------------------------

class HoleAsset extends Schema.Class<HoleAsset>("HoleAsset")({
  assetId: Schema.String,
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  site: Schema.optional(Schema.String),
}) {}

const PreserveHoles = Entity.make({
  model: HoleAsset,
  entityType: "HoleAsset",
  primaryKey: {
    pk: { field: "pk", composite: ["assetId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byLoc: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["country"] },
      sk: { field: "gsi1sk", composite: ["city", "site"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
})

const SparseHoles = Entity.make({
  model: HoleAsset,
  entityType: "SparseHoleAsset",
  primaryKey: {
    pk: { field: "pk", composite: ["assetId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byLoc: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["country"] },
      sk: { field: "gsi1sk", composite: ["city", "site"] },
      indexPolicy: { pk: "preserve", sk: "sparse" },
    },
  },
})

const HolesTable = Table.make({ schema: AppSchema, entities: { PreserveHoles, SparseHoles } })
const HolesTableLayer = HolesTable.layer({ name: "holes-table" })

const makeHolesMock = (capture: Capture) => ({
  ...makeMockClient(capture),
  getItem: () => Effect.die("getItem not expected (no retain)"),
})

describe("Entity update — hole detection (v3 policy-aware)", () => {
  it.effect("preserve + hole pattern surfaces as CompositeKeyHoleError (EDD-9024)", () => {
    const capture: Capture = {}
    const layer = Layer.mergeAll(
      Layer.succeed(DynamoClient, makeHolesMock(capture) as any),
      HolesTableLayer,
    )
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { PreserveHoles, SparseHoles },
        tables: { HolesTable },
      })
      // city absent (omitted), site present → hole on SK at position 0.
      const error = yield* db.entities.PreserveHoles.update({ assetId: "a-1" })
        .set({ country: "us", site: "datacenter-2" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(CompositeKeyHoleError)
      const e = error as CompositeKeyHoleError
      expect(e.indexName).toBe("gsi1")
      expect(e.clearedComposite).toBe("city")
      expect(e.trailingComposite).toBe("site")
      expect(e.half).toBe("sk")
    }).pipe(Effect.provide(layer), Effect.scoped)
  })

  it.effect("sparse + hole pattern with empty leading prefix → drops both halves (no error)", () => {
    const capture: Capture = {}
    const layer = Layer.mergeAll(
      Layer.succeed(DynamoClient, makeHolesMock(capture) as any),
      HolesTableLayer,
    )
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { PreserveHoles, SparseHoles },
        tables: { HolesTable },
      })
      // Same hole pattern (city absent, site present), but sk is sparse and
      // the leading prefix is empty → collapses to whole-half-empty + drop.
      yield* db.entities.SparseHoles.update({ assetId: "a-1" }).set({
        country: "us",
        site: "datacenter-2",
      })
      const ui = capture.updateItem as {
        UpdateExpression?: string
        ExpressionAttributeNames?: Record<string, string>
      }
      // gsi1pk + gsi1sk should be REMOVE'd, not SET. Pull the REMOVE-clause
      // tokens directly: they're the aliases whose names map back to gsi1pk
      // and gsi1sk. The expression has shape "SET ... REMOVE #r0, #r1".
      expect(ui.UpdateExpression).toMatch(/\bREMOVE\b/)
      const expr = ui.UpdateExpression!
      const removeIdx = expr.indexOf("REMOVE")
      const removeTail = expr.slice(removeIdx + "REMOVE".length).trim()
      const removeAliases = removeTail
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.startsWith("#"))
      const removed = removeAliases.map((a) => ui.ExpressionAttributeNames?.[a] ?? a)
      expect(removed).toContain("gsi1pk")
      expect(removed).toContain("gsi1sk")
    }).pipe(Effect.provide(layer), Effect.scoped)
  })
})

// ---------------------------------------------------------------------------
// EDD-9025 — Entity.make() rejects nullable composites
// ---------------------------------------------------------------------------

describe("Entity.make() — EDD-9025 composite null check", () => {
  it("throws CompositeNullableError when a primary-key composite uses Schema.NullOr", () => {
    class BadModel extends Schema.Class<BadModel>("BadModel")({
      id: Schema.NullOr(Schema.String),
      name: Schema.String,
    }) {}
    expect(() =>
      Entity.make({
        model: BadModel,
        entityType: "BadModel",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    ).toThrow(/EDD-9025/)
  })

  it("throws CompositeNullableError when a primary-key composite uses Schema.NullishOr", () => {
    class BadModel extends Schema.Class<BadModel>("BadModel")({
      id: Schema.NullishOr(Schema.String),
      name: Schema.String,
    }) {}
    expect(() =>
      Entity.make({
        model: BadModel,
        entityType: "BadModel",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    ).toThrow(/EDD-9025/)
  })

  it("throws CompositeNullableError when a primary-key composite uses Schema.Union with Null", () => {
    class BadModel extends Schema.Class<BadModel>("BadModel")({
      id: Schema.Union([Schema.String, Schema.Null]),
      name: Schema.String,
    }) {}
    expect(() =>
      Entity.make({
        model: BadModel,
        entityType: "BadModel",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    ).toThrow(/EDD-9025/)
  })

  it("throws CompositeNullableError when a GSI composite is nullable", () => {
    class BadModel extends Schema.Class<BadModel>("BadModel")({
      id: Schema.String,
      tenantId: Schema.NullOr(Schema.String),
    }) {}
    expect(() =>
      Entity.make({
        model: BadModel,
        entityType: "BadModel",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byTenant: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      }),
    ).toThrow(/EDD-9025/)
  })

  it("throws CompositeNullableError when a unique constraint composite is nullable", () => {
    class BadModel extends Schema.Class<BadModel>("BadModel")({
      id: Schema.String,
      email: Schema.NullOr(Schema.String),
    }) {}
    expect(() =>
      Entity.make({
        model: BadModel,
        entityType: "BadModel",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        unique: {
          byEmail: ["email"],
        },
      }),
    ).toThrow(/EDD-9025/)
  })

  it("error names the entity, surface, and composite attribute", () => {
    class BadModel extends Schema.Class<BadModel>("BadModel")({
      id: Schema.String,
      tenantId: Schema.NullOr(Schema.String),
    }) {}
    try {
      Entity.make({
        model: BadModel,
        entityType: "BadModel",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byTenant: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      })
    } catch (e) {
      expect(e).toBeInstanceOf(CompositeNullableError)
      const err = e as CompositeNullableError
      expect(err.entityType).toBe("BadModel")
      expect(err.surface).toBe('index "byTenant"')
      expect(err.compositeAttribute).toBe("tenantId")
      expect(err.message).toContain("EDD-9025")
      expect(err.message).toContain("Schema.optional")
      return
    }
    throw new Error("expected throw")
  })

  it("allows Schema.optional(Schema.String) on a composite (T | undefined, no null)", () => {
    class OkModel extends Schema.Class<OkModel>("OkModel")({
      id: Schema.String,
      tenantId: Schema.optional(Schema.String),
    }) {}
    expect(() =>
      Entity.make({
        model: OkModel,
        entityType: "OkModel",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byTenant: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      }),
    ).not.toThrow()
  })

  it("allows plain non-nullable schemas on composites", () => {
    class OkModel extends Schema.Class<OkModel>("OkModel")({
      id: Schema.String,
      tenantId: Schema.String,
    }) {}
    expect(() =>
      Entity.make({
        model: OkModel,
        entityType: "OkModel",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byTenant: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      }),
    ).not.toThrow()
  })

  it("permits a non-composite, model-declared nullable attribute (only composites are gated)", () => {
    class OkModel extends Schema.Class<OkModel>("OkModel")({
      id: Schema.String,
      // Non-composite — nullable is allowed on the model. EDD-9025 only checks
      // composites.
      label: Schema.NullOr(Schema.String),
    }) {}
    expect(() =>
      Entity.make({
        model: OkModel,
        entityType: "OkModel",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    ).not.toThrow()
  })
})
