/**
 * Entity-level integration tests for indexPolicy v1.7.1 semantics (closes #41).
 *
 * Covers the wiring through `Entity.update` (standard updateItem path),
 * `Entity.update` retain path, and `.append()`. KeyComposer-level unit tests
 * live in `KeyComposer.test.ts`; this file proves the v1.7.1 semantics make it
 * through the Entity layer to the wire (UpdateExpression / TransactItems).
 *
 * The tests are mock-based (no DynamoDB) — they capture the request payload
 * sent to `client.updateItem` / `client.transactWriteItems` and assert on
 * the SET / REMOVE clauses and key composition.
 *
 * Renamed scenarios from the v1.7.0 file:
 *   - "GSI-wide cascade" → "per-half cascade" (v1.7.1 bug-1 fix)
 *   - "EDD-9024 throw under preserve" → "noop or REMOVE depending on cascade
 *     override" (v1.7.1 bug-2 fix)
 *   - "always-evaluated under policy" → "per-half evaluation gate" (v1.7.1
 *     bug-3 fix)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { CompositeNullableError } from "../src/Errors.js"
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

describe("Entity update — indexPolicy v1.7.1 wiring (retain path)", () => {
  it.effect(
    "Entity.remove(['site']) — per-half cascade on SK; structural rule truncates from stored composites",
    () => {
      // v1.7.1: cascade is per-half. `site` is in the SK composite list only.
      // SK touched via removedSet → on the RETAIN path the stored country/city
      // are available in newItem (read-then-write), so the structural rule
      // composes the leading prefix [country, city] → SET sk truncated. The
      // cascade override fires only when the rule CAN'T compose; here it can.
      //
      // This is the retain-path-specific outcome — on the standard path
      // without surviving composites in the same call, `Entity.remove(['site'])`
      // alone REMOVEs sk (set/remove asymmetry — see KeyComposer tests).
      //
      // PK untouched (region not in removedSet, not in payload) → noop,
      // keeps the stored value.
      //
      // (v1.7.0 would have REMOVE'd both gsi1pk AND gsi1sk via the GSI-wide
      // cascade. This test asserts the v1.7.1 behavior change — pk preserved,
      // sk truncates not drops.)
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
        // gsi1pk preserved (region untouched). v1.7.1 critical assertion.
        expect(item!.gsi1pk).toBeDefined()
        expect(item!.gsi1pk).toEqual({ S: "$app#v1#asset#region_americas" })
        // gsi1sk truncated to [country, city] via structural rule (the retain
        // path supplies surviving composites from stored attrs).
        expect(item!.gsi1sk).toBeDefined()
        expect((item!.gsi1sk as { S: string }).S).toBe("$app#v1#asset#country_us#city_sf")
      }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
    },
  )

  it.effect(
    "Entity.remove(['country']) — per-half cascade on SK; can't compose (hole) → REMOVE sk; PK preserved",
    () => {
      // country is at sk[0]. Removing it leaves [_, city, site] — hole at
      // sk[0]. Hole = can't compose. Preserve + cascade override (country in
      // removedSet) → REMOVE sk. PK preserved (region untouched).
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
        // gsi1pk preserved (region untouched).
        expect(item.gsi1pk).toBeDefined()
        // gsi1sk REMOVE'd via per-half cascade override (preserve + can't-
        // compose + country in removedSet).
        expect(item.gsi1sk).toBeUndefined()
      }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
    },
  )

  it.effect("Entity.remove(['region']) — per-half cascade on PK; SK preserved", () => {
    // region is in pk only. Per-half cascade hits PK; SK preserved.
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Assets },
        tables: { AppTable },
      })
      yield* db.entities.Assets.update({ assetId: "a-1" }).remove(["region"])
      const tx = capture.transactWriteItems
      const item = (
        tx as { TransactItems: Array<{ Put: { Item: Record<string, AttributeValue> } }> }
      ).TransactItems[0]!.Put.Item
      // gsi1pk REMOVE'd via per-half cascade override (preserve + can't-
      // compose + region in removedSet).
      expect(item.gsi1pk).toBeUndefined()
      // gsi1sk preserved (untouched). v1.7.1 critical assertion.
      expect(item.gsi1sk).toBeDefined()
    }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
  })

  it.effect(
    "Hierarchical demote — set surviving composites + remove leaf → SET sk truncated",
    () => {
      // Set/remove asymmetry. Supply country+city via set, invalidate site via
      // remove. SK touched (set + removedSet), structural rule succeeds with
      // leading prefix [country, city] → SET sk truncated (no cascade — the
      // rule composed something).
      const capture: Capture = {}
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Assets },
          tables: { AppTable },
        })
        yield* db.entities.Assets.update({ assetId: "a-1" })
          .set({ country: "us", city: "sf" })
          .remove(["site"])
        const tx = capture.transactWriteItems
        const item = (
          tx as { TransactItems: Array<{ Put: { Item: Record<string, AttributeValue> } }> }
        ).TransactItems[0]!.Put.Item
        // gsi1pk preserved (region untouched, not in payload, not in removedSet).
        expect(item.gsi1pk).toBeDefined()
        // gsi1sk SET to truncated leading prefix [country, city].
        expect(item.gsi1sk).toBeDefined()
        expect((item.gsi1sk as { S: string }).S).toBe("$app#v1#asset#country_us#city_sf")
      }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
    },
  )
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

describe("Entity update — standard path migration regression (issue #36 / #41 / #43)", () => {
  it.effect(
    "partial update that omits preserve-policied composites does NOT generate REMOVE for any GSI key (footgun stays closed); SK halves SET via keyRecord membership (v1.7.2 — closes #43)",
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
        // Update only `name` — never mentions X, Y, Z, or pageId in the
        // payload. Under v1.7.1 the per-half evaluation gate skipped ALL
        // halves of all three GSIs because the gate only consulted
        // `updatePayload`. Under v1.7.2 (closes #43) the gate also counts
        // `keyRecord` membership: `pageId` is in keyRecord (it's the
        // entity-PK composite), so all three SK halves are touched →
        // structural rule composes from `pageId` → SET. The PK halves
        // (X/Y/Z) are non-PK composites — not in payload, not in keyRecord
        // → noop. The original footgun stays closed: zero gsi*pk REMOVEs.
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
        // Footgun assertion: no GSI key REMOVE'd. Stays closed under v1.7.2.
        for (const name of physicalRemoves) {
          expect(name).not.toMatch(/^gsi\d(pk|sk)$/)
        }
        // Per-half partition (v1.7.2): PK halves (X/Y/Z — non-PK composites,
        // not in keyRecord, not in payload) → noop. SK halves (pageId — the
        // entity-PK composite, in keyRecord) → touched → SET.
        const setClause = expr.match(/SET\s+(.*?)(?:\s+REMOVE|$)/i)?.[1] ?? ""
        const setNames = setClause
          .split(",")
          .map((s) => s.split("=")[0]?.trim() ?? "")
          .filter((s) => s.startsWith("#"))
          .map((alias) => ui.ExpressionAttributeNames?.[alias] ?? alias)
        const setSet = new Set(setNames)
        // No SET on PK halves of any GSI.
        expect(setSet.has("gsi1pk")).toBe(false)
        expect(setSet.has("gsi2pk")).toBe(false)
        expect(setSet.has("gsi3pk")).toBe(false)
        // SET on every GSI's SK half via keyRecord membership.
        expect(setSet.has("gsi1sk")).toBe(true)
        expect(setSet.has("gsi2sk")).toBe(true)
        expect(setSet.has("gsi3sk")).toBe(true)
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

// Helper for parsing the captured UpdateExpression's REMOVE clause into a
// set of physical attribute names.
const parseRemoves = (ui: {
  UpdateExpression?: string
  ExpressionAttributeNames?: Record<string, string>
}): Set<string> => {
  const expr = ui.UpdateExpression ?? ""
  const removeIdx = expr.indexOf("REMOVE")
  if (removeIdx === -1) return new Set()
  const removeTail = expr.slice(removeIdx + "REMOVE".length).trim()
  const removeAliases = removeTail
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith("#"))
  return new Set(removeAliases.map((a) => ui.ExpressionAttributeNames?.[a] ?? a))
}

describe("Entity update — hole pattern under v1.7.1 (no throw, unified can't-compose)", () => {
  it.effect(
    "preserve + hole pattern (no removedSet) → noop sk (NOT a throw — EDD-9024 deprecated)",
    () => {
      // city absent (omitted), site present → hole on SK at position 0.
      // v1.7.0 threw EDD-9024 here. v1.7.1: hole collapses into can't-
      // compose; preserve + no removedSet → noop sk. PK touched (country in
      // payload) → SET pk. Critical assertion: no error AND no gsi1sk REMOVE.
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
        yield* db.entities.PreserveHoles.update({ assetId: "a-1" }).set({
          country: "us",
          site: "datacenter-2",
        })
        const ui = capture.updateItem as {
          UpdateExpression?: string
          ExpressionAttributeNames?: Record<string, string>
        }
        const removed = parseRemoves(ui)
        // No EDD-9024. No gsi1sk REMOVE (preserve + no cascade → noop).
        expect(removed.has("gsi1sk")).toBe(false)
        // gsi1pk is touched (country in payload, where country IS a pk
        // composite for PreserveHoles? checking — yes, pk = [country]) →
        // SET. No REMOVE on gsi1pk.
        expect(removed.has("gsi1pk")).toBe(false)
      }).pipe(Effect.provide(layer), Effect.scoped)
    },
  )

  it.effect(
    "preserve + hole pattern + Entity.remove(['city']) → REMOVE sk via cascade override",
    () => {
      // Same hole pattern, but now city is in removedSet. SK touched (set has
      // site, removedSet has city), can't compose → preserve + cascade
      // override → REMOVE sk only. (Per-half cascade — pk untouched per the
      // gate on this fixture; country is the pk composite and IS in the
      // payload, so pk is also touched and SETs.)
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
        yield* db.entities.PreserveHoles.update({ assetId: "a-1" })
          .set({ country: "us", site: "datacenter-2" })
          .remove(["city"])
        const ui = capture.updateItem as {
          UpdateExpression?: string
          ExpressionAttributeNames?: Record<string, string>
        }
        const removed = parseRemoves(ui)
        // gsi1sk REMOVE'd via cascade override (preserve + can't-compose +
        // city in removedSet).
        expect(removed.has("gsi1sk")).toBe(true)
        // gsi1pk NOT removed — country is the pk composite, touched, SETs.
        expect(removed.has("gsi1pk")).toBe(false)
        // city itself is also REMOVE'd from the item (the standard remove
        // clause).
        expect(removed.has("city")).toBe(true)
      }).pipe(Effect.provide(layer), Effect.scoped)
    },
  )

  it.effect(
    "sparse + hole pattern (empty leading prefix) → REMOVE sk only (per-half, NOT GSI-wide)",
    () => {
      // SparseHoles: pk preserve, sk sparse. city absent + site present →
      // hole + sparse → REMOVE sk only. Critical v1.7.1 assertion: gsi1pk
      // is NOT REMOVE'd (the v1.7.0 GSI-wide cascade is gone).
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
        yield* db.entities.SparseHoles.update({ assetId: "a-1" }).set({
          country: "us",
          site: "datacenter-2",
        })
        const ui = capture.updateItem as {
          UpdateExpression?: string
          ExpressionAttributeNames?: Record<string, string>
        }
        expect(ui.UpdateExpression).toMatch(/\bREMOVE\b/)
        const removed = parseRemoves(ui)
        // sk REMOVE'd via sparse + can't-compose.
        expect(removed.has("gsi1sk")).toBe(true)
        // pk NOT REMOVE'd — preserve + the country composite of pk is in
        // payload → pk touched, SETs. v1.7.1 critical: NOT GSI-wide cascade.
        expect(removed.has("gsi1pk")).toBe(false)
      }).pipe(Effect.provide(layer), Effect.scoped)
    },
  )
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

  it("allows plain non-nullable schemas on composites (sanity)", () => {
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

// ---------------------------------------------------------------------------
// Issue #43 — PK-composites-only GSI shape (entity-level wiring)
// ---------------------------------------------------------------------------
//
// The bug: GSIs whose composites are entirely entity-PK composites (e.g.
// `byChannel: { pk: [channel], sk: [deviceId] }` on an entity with
// `primaryKey: [channel, deviceId]`) had their `gsi*pk` / `gsi*sk` keys
// silently skipped under v1.7.0 / v1.7.1 — the per-half evaluation gate
// only consulted `updatePayload`, and PK composites never appear there.
// v1.7.2 broadens the gate to also count `keyRecord` membership AND
// removes the PK-composite filter from `Entity.append()`'s payload.
//
// These tests prove the wiring through both Entity.update (standard path)
// and Entity.append (time-series path) — verifying the resulting wire-form
// expressions carry SETs for the PK-composite-only GSI keys.
// ---------------------------------------------------------------------------

class Sensor extends Schema.Class<Sensor>("Sensor")({
  channel: Schema.String,
  deviceId: Schema.String,
  // A non-composite payload field used to trigger updates without restating
  // the PK composites. Modeled as Schema.optional so updates can include it
  // selectively.
  otherField: Schema.optional(Schema.String),
}) {}

const SensorSchema = DynamoSchema.make({ name: "sensor-test", version: 1 })

const Sensors = Entity.make({
  model: Sensor,
  entityType: "Sensor",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    // PK-composites-only GSI shape — the #43 repro.
    byChannel: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["channel"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
})

const SensorTable = Table.make({ schema: SensorSchema, entities: { Sensors } })
const SensorTableLayer = SensorTable.layer({ name: "sensor-table" })

// Mock client that pretends a stored Sensor exists with no GSI keys (mirrors
// items written under v1.7.0 / v1.7.1 — the bug state). Returns
// Sensor-shaped Attributes from updateItem so the Schema decode succeeds.
const makeSensorMock = (capture: Capture) => ({
  ...makeMockClient(capture),
  getItem: () =>
    Effect.succeed({
      Item: {
        pk: { S: "$sensor-test#v1#sensor#channel_c-1#deviceid_d-1" } as AttributeValue,
        sk: { S: "$sensor-test#v1#sensor" } as AttributeValue,
        channel: { S: "c-1" } as AttributeValue,
        deviceId: { S: "d-1" } as AttributeValue,
        __edd_e__: { S: "Sensor" } as AttributeValue,
      },
    }),
  updateItem: (input: Record<string, unknown>) => {
    capture.updateItem = input
    return Effect.succeed({
      Attributes: {
        pk: { S: "$sensor-test#v1#sensor#channel_c-1#deviceid_d-1" } as AttributeValue,
        sk: { S: "$sensor-test#v1#sensor" } as AttributeValue,
        channel: { S: "c-1" } as AttributeValue,
        deviceId: { S: "d-1" } as AttributeValue,
        otherField: { S: "X" } as AttributeValue,
        __edd_e__: { S: "Sensor" } as AttributeValue,
      },
    })
  },
})

describe("Entity update — PK-composites-only GSI shape (closes #43)", () => {
  it.effect(
    "Entity.update().set({ otherField }) on entity with byChannel: {pk:[channel], sk:[deviceId]} produces SET clauses for gsi1pk AND gsi1sk",
    () => {
      // Standard update path. `set({ otherField: ... })` doesn't mention
      // channel or deviceId in the payload — they live in keyRecord. Pre-
      // v1.7.2 the per-half gate skipped both halves of byChannel and the
      // UpdateExpression had no SET for gsi1pk / gsi1sk. v1.7.2 fixes this.
      const capture: Capture = {}
      const layer = Layer.mergeAll(
        Layer.succeed(DynamoClient, makeSensorMock(capture) as any),
        SensorTableLayer,
      )
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Sensors },
          tables: { SensorTable },
        })
        yield* db.entities.Sensors.update({ channel: "c-1", deviceId: "d-1" }).set({
          otherField: "X",
        })
        const ui = capture.updateItem as {
          UpdateExpression?: string
          ExpressionAttributeNames?: Record<string, string>
          ExpressionAttributeValues?: Record<string, AttributeValue>
        }
        expect(ui.UpdateExpression).toBeDefined()
        const expr = ui.UpdateExpression!
        // Parse the SET clause and resolve aliases to physical names.
        const setClause = expr.match(/SET\s+(.*?)(?:\s+REMOVE|$)/i)?.[1] ?? ""
        const setAssignments = setClause.split(",").map((s) => s.trim())
        const setNames = setAssignments
          .map((s) => s.split("=")[0]?.trim() ?? "")
          .filter((s) => s.startsWith("#"))
          .map((alias) => ui.ExpressionAttributeNames?.[alias] ?? alias)
        const setSet = new Set(setNames)
        // v1.7.2 critical assertions: both halves of byChannel SET via the
        // per-half gate's keyRecord branch.
        expect(setSet.has("gsi1pk")).toBe(true)
        expect(setSet.has("gsi1sk")).toBe(true)
        // No REMOVE on either half.
        const removed = parseRemoves(ui)
        expect(removed.has("gsi1pk")).toBe(false)
        expect(removed.has("gsi1sk")).toBe(false)
      }).pipe(Effect.provide(layer), Effect.scoped)
    },
  )
})

// Time-series append path uses transactWriteItems. Same entity shape but
// with `timeSeries` configuration. The SET clauses live in the
// TransactItems[0].Update.UpdateExpression.

class TelemetryFixture extends Schema.Class<TelemetryFixture>("TelemetryFixture")({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  reading: Schema.optional(Schema.Number),
}) {}

const TelemetryFixtureAppendInput = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  reading: Schema.optional(Schema.Number),
})

const TelemetryFixtureSchema = DynamoSchema.make({ name: "telemetry-fixture", version: 1 })

const TelemetryFixtureEntity = Entity.make({
  model: TelemetryFixture,
  entityType: "TelemetryFixture",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byChannel: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["channel"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
  timestamps: true,
  timeSeries: {
    orderBy: "timestamp",
    ttl: Duration.days(7),
    appendInput: TelemetryFixtureAppendInput,
  },
})

const TelemetryFixtureTable = Table.make({
  schema: TelemetryFixtureSchema,
  entities: { TelemetryFixtureEntity },
})
const TelemetryFixtureTableLayer = TelemetryFixtureTable.layer({ name: "telemetry-fixture-table" })

const makeTelemetryFixtureMock = (capture: Capture) => ({
  ...makeMockClient(capture),
  getItem: () => Effect.die("getItem not used on append path"),
  // The append path's follow-up GET (when not skipFollowUp) needs a stored
  // record. Provide a minimally complete one — the test only inspects the
  // captured TransactWriteItems.
  // The follow-up uses getItem too, but we can return the same shape.
})

describe("Entity append — PK-composites-only GSI shape (closes #43)", () => {
  it.effect(
    "Entity.append() on time-series entity with byChannel: {pk:[channel], sk:[deviceId]} produces SET clauses for gsi1pk AND gsi1sk in the current-row UpdateItem",
    () => {
      const capture: Capture = {}
      const layer = Layer.mergeAll(
        Layer.succeed(DynamoClient, makeTelemetryFixtureMock(capture) as any),
        TelemetryFixtureTableLayer,
      )
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { TelemetryFixtureEntity },
          tables: { TelemetryFixtureTable },
        })
        // Use skipFollowUp so the test doesn't need to mock the follow-up
        // GetItem. We're only inspecting the TransactWriteItems wire form.
        yield* db.entities.TelemetryFixtureEntity.append({
          channel: "c-1",
          deviceId: "d-1",
          timestamp: DateTime.makeUnsafe("2026-04-30T10:00:00.000Z"),
          reading: 42,
        }).skipFollowUp()

        const tx = capture.transactWriteItems
        expect(tx).toBeDefined()
        const items = (tx as { TransactItems?: Array<unknown> }).TransactItems
        expect(items?.length).toBe(2) // Update current + Put event
        const update = (items?.[0] as { Update?: Record<string, unknown> }).Update
        expect(update).toBeDefined()
        const expr = (update as { UpdateExpression?: string }).UpdateExpression!
        const names = (update as { ExpressionAttributeNames?: Record<string, string> })
          .ExpressionAttributeNames!
        // Parse SET clause and resolve aliases.
        const setClause = expr.match(/SET\s+(.*?)(?:\s+REMOVE|$)/i)?.[1] ?? ""
        const setNames = setClause
          .split(",")
          .map((s) => s.trim())
          .map((s) => s.split("=")[0]?.trim() ?? "")
          .filter((s) => s.startsWith("#"))
          .map((alias) => names[alias] ?? alias)
        const setSet = new Set(setNames)
        // v1.7.2 critical assertions for #43: both halves of byChannel SET
        // via the per-half gate's keyRecord branch (Option B) AND because
        // append no longer filters PK composites out of its payload (Option
        // A). v1.7.0 / v1.7.1 had neither SET — items invisible to GSI.
        expect(setSet.has("gsi1pk")).toBe(true)
        expect(setSet.has("gsi1sk")).toBe(true)
      }).pipe(Effect.provide(layer), Effect.scoped)
    },
  )
})

// ---------------------------------------------------------------------------
// v1.7.3 — empty-composite halves are always evaluated (closes #46)
// ---------------------------------------------------------------------------
//
// Canonical fixture for #46: a Vehicle entity with the exact reproducer
// shape — `byDeviceBinding: { pk: [deviceBinding], sk: { composite: [] } }`.
// The SK half is a constant entity prefix. Pre-v1.7.3 the gate skipped this
// half on every update, leaving items with `gsi3pk` SET and `gsi3sk` missing
// → invisible to the GSI. Post-v1.7.3 the skip-predicate's `length > 0`
// short-circuit keeps empty halves un-skipped, and `classifyHalf` (which
// already handled empty composites correctly as `{ kind: 'set', length: 0 }`)
// is finally reached.

class Vehicle extends Schema.Class<Vehicle>("Vehicle")({
  id: Schema.String,
  deviceBinding: Schema.optional(Schema.String),
  // Mixed-shape companion: a tenant-scoped GSI to prove other GSIs on the
  // same entity continue to follow multi-writer protection.
  tenantId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}) {}

const VehicleSchema = DynamoSchema.make({ name: "vehicle-test", version: 1 })

const Vehicles = Entity.make({
  model: Vehicle,
  entityType: "Vehicle",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    // Empty-composite-SK GSI — the #46 repro shape.
    byDeviceBinding: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["deviceBinding"] },
      sk: { field: "gsi3sk", composite: [] },
    },
    // Multi-writer-protected companion GSI to prove other halves still
    // follow the skip-predicate's multi-writer protection. tenantId is NOT
    // an entity-PK composite, so the gate must skip both halves when no
    // payload mentions them — preserving the v1.7.1 #41 fix.
    byTenant: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["tenantId"] },
      sk: { field: "gsi4sk", composite: ["status"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
})

const VehicleTable = Table.make({ schema: VehicleSchema, entities: { Vehicles } })
const VehicleTableLayer = VehicleTable.layer({ name: "vehicle-table" })

const makeVehicleMock = (capture: Capture) => ({
  ...makeMockClient(capture),
  getItem: () =>
    Effect.succeed({
      Item: {
        pk: { S: "$vehicle-test#v1#vehicle#id_veh-1" } as AttributeValue,
        sk: { S: "$vehicle-test#v1#vehicle" } as AttributeValue,
        id: { S: "veh-1" } as AttributeValue,
        __edd_e__: { S: "Vehicle" } as AttributeValue,
      },
    }),
  updateItem: (input: Record<string, unknown>) => {
    capture.updateItem = input
    return Effect.succeed({
      Attributes: {
        pk: { S: "$vehicle-test#v1#vehicle#id_veh-1" } as AttributeValue,
        sk: { S: "$vehicle-test#v1#vehicle" } as AttributeValue,
        id: { S: "veh-1" } as AttributeValue,
        deviceBinding: { S: "cloud#dev-1" } as AttributeValue,
        __edd_e__: { S: "Vehicle" } as AttributeValue,
      },
    })
  },
})

describe("Entity update — empty-composite-half GSI shape (closes #46)", () => {
  it.effect(
    "Entity.update().set({ deviceBinding }) on entity with sk: { composite: [] } produces SET clauses for BOTH gsi3pk AND gsi3sk",
    () => {
      // The exact #46 reproducer. Pre-v1.7.3: gsi3pk SET, gsi3sk skipped
      // → vehicle invisible to byDeviceBinding queries. Post-v1.7.3:
      // both halves SET; the empty SK composite produces the constant
      // entity prefix.
      const capture: Capture = {}
      const layer = Layer.mergeAll(
        Layer.succeed(DynamoClient, makeVehicleMock(capture) as any),
        VehicleTableLayer,
      )
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Vehicles },
          tables: { VehicleTable },
        })
        yield* db.entities.Vehicles.update({ id: "veh-1" }).set({
          deviceBinding: "cloud#dev-1",
        })
        const ui = capture.updateItem as {
          UpdateExpression?: string
          ExpressionAttributeNames?: Record<string, string>
          ExpressionAttributeValues?: Record<string, AttributeValue>
        }
        expect(ui.UpdateExpression).toBeDefined()
        const expr = ui.UpdateExpression!
        const setClause = expr.match(/SET\s+(.*?)(?:\s+REMOVE|$)/i)?.[1] ?? ""
        const setNames = setClause
          .split(",")
          .map((s) => s.trim())
          .map((s) => s.split("=")[0]?.trim() ?? "")
          .filter((s) => s.startsWith("#"))
          .map((alias) => ui.ExpressionAttributeNames?.[alias] ?? alias)
        const setSet = new Set(setNames)
        // v1.7.3 critical assertions for #46.
        expect(setSet.has("gsi3pk")).toBe(true)
        expect(setSet.has("gsi3sk")).toBe(true)
        // No REMOVE on either half.
        const removed = parseRemoves(ui)
        expect(removed.has("gsi3pk")).toBe(false)
        expect(removed.has("gsi3sk")).toBe(false)
        // Mixed-shape negative: byTenant is NOT touched on this update —
        // tenantId / status are absent from payload AND keyRecord, so the
        // multi-writer protection path skips both halves (#41 preserved).
        expect(setSet.has("gsi4pk")).toBe(false)
        expect(setSet.has("gsi4sk")).toBe(false)
        expect(removed.has("gsi4pk")).toBe(false)
        expect(removed.has("gsi4sk")).toBe(false)
      }).pipe(Effect.provide(layer), Effect.scoped)
    },
  )

  it.effect(
    "Entity.update().set({ unrelated }) — empty SK composite still SET (constant prefix); gsi3pk skipped (multi-writer protection)",
    () => {
      // Negative test for the empty-composite shape. The PK half of
      // byDeviceBinding is NOT touched (deviceBinding is absent from
      // payload AND keyRecord) — multi-writer protection applies → gsi3pk
      // skipped. But the SK half IS empty-composite → always evaluated →
      // constant prefix SET regardless. This proves the per-half nature
      // of the gate is preserved under the reframe.
      //
      // Note: this asymmetry (one half SET, the other not) is correct
      // behavior — the SK is a constant prefix that's safe to re-write
      // every time, while the PK belongs to a writer that owns the
      // deviceBinding attribute. If the GSI was previously composed,
      // gsi3pk's stored value is preserved (preserve policy default);
      // gsi3sk gets re-stamped with the same constant.
      const capture: Capture = {}
      const layer = Layer.mergeAll(
        Layer.succeed(DynamoClient, makeVehicleMock(capture) as any),
        VehicleTableLayer,
      )
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Vehicles },
          tables: { VehicleTable },
        })
        yield* db.entities.Vehicles.update({ id: "veh-1" }).set({
          status: "active", // touches byTenant.sk only — but tenantId absent
        })
        const ui = capture.updateItem as {
          UpdateExpression?: string
          ExpressionAttributeNames?: Record<string, string>
        }
        const expr = ui.UpdateExpression!
        const setClause = expr.match(/SET\s+(.*?)(?:\s+REMOVE|$)/i)?.[1] ?? ""
        const setNames = setClause
          .split(",")
          .map((s) => s.trim())
          .map((s) => s.split("=")[0]?.trim() ?? "")
          .filter((s) => s.startsWith("#"))
          .map((alias) => ui.ExpressionAttributeNames?.[alias] ?? alias)
        const setSet = new Set(setNames)
        // PK half of byDeviceBinding skipped (multi-writer protection).
        expect(setSet.has("gsi3pk")).toBe(false)
        // SK half (empty composite) ALWAYS evaluated → constant prefix SET.
        expect(setSet.has("gsi3sk")).toBe(true)
        // byTenant.sk is touched (status in payload), but tenantId is NOT
        // in payload OR keyRecord. Per the structural rule on the SK half
        // alone: the SK half evaluates, but the PK half is skipped. SK
        // value composes (status alone — see existing v1.7.1 truncation
        // semantics). PK gsi4pk skipped (multi-writer protection).
        expect(setSet.has("gsi4pk")).toBe(false)
      }).pipe(Effect.provide(layer), Effect.scoped)
    },
  )
})
