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
 * Canonical shapes 7 and 8 (#171, Z-order sort keys) close the file: the
 * same three write paths, with the binary half's values compared as bytes.
 *
 * Renamed scenarios from the v1.7.0 file:
 *   - "GSI-wide cascade" → "per-half cascade" (v1.7.1 bug-1 fix)
 *   - "EDD-9024 throw under preserve" → "noop or REMOVE depending on cascade
 *     override" (v1.7.1 bug-2 fix)
 *   - "always-evaluated under policy" → "per-half evaluation gate" (v1.7.1
 *     bug-3 fix)
 */

import type {
  AttributeValue,
  GetItemCommandOutput,
  TransactWriteItemsCommandInput,
  TransactWriteItemsCommandOutput,
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { CompositeNullableError } from "@effect-dynamodb/schema/Errors.js"
import { shardOf } from "@effect-dynamodb/schema/internal/Shards.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DateTime, Duration, Effect, Layer, Schema } from "effect"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { applyUpdate, mockDynamoClient, mockOutput } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Mock client capture helpers
// ---------------------------------------------------------------------------

// Pretend the stored item has the full hierarchy populated.
const storedAsset: Record<string, AttributeValue> = {
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
}

/** The item a read-then-write update leaves: its guarded Update applied to the stored item. */
const writtenItem = (tx: unknown): Record<string, AttributeValue> =>
  applyUpdate(
    storedAsset,
    (tx as { TransactItems: Array<{ Update: Parameters<typeof applyUpdate>[1] }> })
      .TransactItems[0]!.Update,
  )!

type Capture = {
  updateItem?: UpdateItemCommandInput
  transactWriteItems?: TransactWriteItemsCommandInput
}

const makeMockClient = (capture: Capture): DynamoClientService =>
  mockDynamoClient({
    getItem: () =>
      Effect.succeed(
        mockOutput<GetItemCommandOutput>({
          Item: storedAsset,
        }),
      ),
    updateItem: (input) => {
      capture.updateItem = input
      return Effect.succeed(
        mockOutput<UpdateItemCommandOutput>({
          Attributes: {
            pk: { S: "$app#v1#x" } as AttributeValue,
            sk: { S: "$app#v1#x" } as AttributeValue,
            pageId: { S: "p-1" } as AttributeValue,
            assetId: { S: "a-1" } as AttributeValue,
            __edd_e__: { S: "X" } as AttributeValue,
          },
        }),
      )
    },
    transactWriteItems: (input) => {
      capture.transactWriteItems = input
      return Effect.succeed(mockOutput<TransactWriteItemsCommandOutput>({}))
    },
  })

const makeLayer = (capture: Capture) => Layer.succeed(DynamoClient, makeMockClient(capture))

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
        const item = writtenItem(tx)
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
        const item = writtenItem(tx)
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
      const item = writtenItem(tx)
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
        const item = writtenItem(tx)
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

const makePagesMock = (capture: Capture): DynamoClientService =>
  mockDynamoClient({
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
        Layer.succeed(DynamoClient, makePagesMock(capture)),
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

const makeHolesMock = (capture: Capture): DynamoClientService =>
  mockDynamoClient({
    ...makeMockClient(capture),
    getItem: () => Effect.die("getItem not expected (no retain)"),
  })

// Helper for parsing the captured UpdateExpression's REMOVE clause into a
// set of physical attribute names.
const parseRemoves = (ui: {
  readonly UpdateExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
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
        Layer.succeed(DynamoClient, makeHolesMock(capture)),
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
        Layer.succeed(DynamoClient, makeHolesMock(capture)),
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
        Layer.succeed(DynamoClient, makeHolesMock(capture)),
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
const makeSensorMock = (capture: Capture): DynamoClientService =>
  mockDynamoClient({
    ...makeMockClient(capture),
    getItem: () =>
      Effect.succeed(
        mockOutput<GetItemCommandOutput>({
          Item: {
            pk: { S: "$sensor-test#v1#sensor#channel_c-1#deviceid_d-1" } as AttributeValue,
            sk: { S: "$sensor-test#v1#sensor" } as AttributeValue,
            channel: { S: "c-1" } as AttributeValue,
            deviceId: { S: "d-1" } as AttributeValue,
            __edd_e__: { S: "Sensor" } as AttributeValue,
          },
        }),
      ),
    updateItem: (input) => {
      capture.updateItem = input
      return Effect.succeed(
        mockOutput<UpdateItemCommandOutput>({
          Attributes: {
            pk: { S: "$sensor-test#v1#sensor#channel_c-1#deviceid_d-1" } as AttributeValue,
            sk: { S: "$sensor-test#v1#sensor" } as AttributeValue,
            channel: { S: "c-1" } as AttributeValue,
            deviceId: { S: "d-1" } as AttributeValue,
            otherField: { S: "X" } as AttributeValue,
            __edd_e__: { S: "Sensor" } as AttributeValue,
          },
        }),
      )
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
        Layer.succeed(DynamoClient, makeSensorMock(capture)),
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

const makeTelemetryFixtureMock = (capture: Capture): DynamoClientService =>
  mockDynamoClient({
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
        Layer.succeed(DynamoClient, makeTelemetryFixtureMock(capture)),
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

const makeVehicleMock = (capture: Capture): DynamoClientService =>
  mockDynamoClient({
    ...makeMockClient(capture),
    getItem: () =>
      Effect.succeed(
        mockOutput<GetItemCommandOutput>({
          Item: {
            pk: { S: "$vehicle-test#v1#vehicle#id_veh-1" } as AttributeValue,
            sk: { S: "$vehicle-test#v1#vehicle" } as AttributeValue,
            id: { S: "veh-1" } as AttributeValue,
            __edd_e__: { S: "Vehicle" } as AttributeValue,
          },
        }),
      ),
    updateItem: (input) => {
      capture.updateItem = input
      return Effect.succeed(
        mockOutput<UpdateItemCommandOutput>({
          Attributes: {
            pk: { S: "$vehicle-test#v1#vehicle#id_veh-1" } as AttributeValue,
            sk: { S: "$vehicle-test#v1#vehicle" } as AttributeValue,
            id: { S: "veh-1" } as AttributeValue,
            deviceBinding: { S: "cloud#dev-1" } as AttributeValue,
            __edd_e__: { S: "Vehicle" } as AttributeValue,
          },
        }),
      )
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
        Layer.succeed(DynamoClient, makeVehicleMock(capture)),
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
        Layer.succeed(DynamoClient, makeVehicleMock(capture)),
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

// ---------------------------------------------------------------------------
// #171 — Z-order halves: canonical shapes 7 and 8 (entity-level wiring)
// ---------------------------------------------------------------------------
//
// A Z-order sort key is a binary address (`{ B: Uint8Array }`) interleaved
// from every dimension, after any `sk.prefix` segments. It has no truncated
// form, so the half is all or nothing: every field present → SET the bytes;
// otherwise `sparse` REMOVEs, `preserve` is a noop unless a field is in
// `remove()` (cascade override), and a half none of whose fields is in the
// payload or key record is skipped. KeyComposer.test.ts pins the composer;
// these tests prove the outcome reaches the wire through `Entity.update`
// (standard path), the retain path and `.append()`.
//
// One entity carries a GSI per shape so every update is also checked against
// the neighbouring shapes it must not disturb.
// ---------------------------------------------------------------------------

class ZListing extends Schema.Class<ZListing>("ZListing")({
  listingId: Schema.String,
  region: Schema.optional(Schema.String),
  agencyId: Schema.optional(Schema.String),
  officeId: Schema.optional(Schema.String),
  price: Schema.optional(Schema.Number),
  bedrooms: Schema.optional(Schema.Number),
  listedAt: Schema.optional(DynamoModel.DateString),
  status: Schema.optional(Schema.Literals(["draft", "live"])),
  title: Schema.optional(Schema.String),
}) {}

const ZSchema = DynamoSchema.make({ name: "zorder-policy", version: 1 })

const facets = [
  { field: "price", min: 0, max: 5_000_000, step: 1_000 },
  { field: "bedrooms", min: 0, max: 15 },
  { field: "listedAt", from: "2024-01-01", unit: "hours", bits: 16 },
] as const

/** Every dimension of `facets`, as `.set()` takes them. */
const zdims = {
  price: 250_000,
  bedrooms: 3,
  listedAt: DateTime.makeUnsafe("2024-01-02T00:00:00.000Z"),
}
/** `zdims` in key form — what the composer reads. */
const zdimsKeyForm = { price: 250_000, bedrooms: 3, listedAt: "2024-01-02T00:00:00.000Z" }
/** `zdims` interleaved: price level 250 (13 bits), bedrooms 3 (4), listedAt hour 24 (16). */
const ZDIMS_BYTES = Uint8Array.of(0x00, 0x02, 0x45, 0x54, 0x68)

const ZListings = Entity.make({
  model: ZListing,
  entityType: "ZListing",
  primaryKey: {
    pk: { field: "pk", composite: ["listingId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    // Shape 7 — every dimension a mutable model field ('preserve', the default).
    byFacets: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["region"] },
      sk: { field: "gsi2sk", zorder: facets },
    },
    // Shape 7 under 'sparse'.
    byFacetsSparse: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["region"] },
      sk: { field: "gsi3sk", zorder: facets },
      indexPolicy: { sk: "sparse" },
    },
    // Shape 8 — a prefix (one segment hashed) before the address.
    byAgency: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["region"] },
      sk: { field: "gsi4sk", prefix: ["agencyId", { field: "officeId", hash: 8 }], zorder: facets },
    },
    // Shape 8c — a hierarchical prefix under 'sparse'.
    byOffice: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["region"] },
      sk: { field: "gsi5sk", prefix: ["agencyId", "officeId"], zorder: [facets[0]] },
      indexPolicy: { sk: "sparse" },
    },
    // Shape 7a — one 2-member literals dimension: 1 bit, 1 byte.
    byStatus: {
      name: "gsi6",
      pk: { field: "gsi6pk", composite: ["region"] },
      sk: { field: "gsi6sk", zorder: [{ field: "status", values: ["draft", "live"] }] },
    },
    // Shape 7a′ — 1-bit literals + 13-bit int: 14 bits, 2 bytes.
    byStatusPrice: {
      name: "gsi7",
      pk: { field: "gsi7pk", composite: ["region"] },
      sk: {
        field: "gsi7sk",
        zorder: [
          { field: "status", values: ["draft", "live"] },
          { field: "price", min: 0, max: 8191 },
        ],
      },
    },
    // Shape 7b — constant (empty-composite) PK half over a Z-order SK, 'sparse'.
    byFacetsAll: {
      name: "gsi8",
      pk: { field: "gsi8pk", composite: [] },
      sk: { field: "gsi8sk", zorder: facets },
      indexPolicy: { pk: "sparse", sk: "sparse" },
    },
  },
})

const ZTable = Table.make({ schema: ZSchema, entities: { ZListings } })
const ZTableLayer = ZTable.layer({ name: "zorder-policy-table" })

/** The stored listing: every field present, every Z-order half composed. */
const zStoredRecord = {
  listingId: "l-1",
  region: "North",
  agencyId: "AG-1",
  officeId: "Office-9",
  status: "live",
  title: "Garden flat",
  ...zdimsKeyForm,
}

const zStoredItem = (
  entityType: string,
  extra: Record<string, AttributeValue> = {},
): Record<string, AttributeValue> => ({
  pk: { S: `$zorder-policy#v1#${entityType.toLowerCase()}#listingid_l-1` },
  sk: { S: `$zorder-policy#v1#${entityType.toLowerCase()}` },
  listingId: { S: "l-1" },
  region: { S: "North" },
  agencyId: { S: "AG-1" },
  officeId: { S: "Office-9" },
  price: { N: "250000" },
  bedrooms: { N: "3" },
  listedAt: { S: "2024-01-02T00:00:00.000Z" },
  status: { S: "live" },
  title: { S: "Garden flat" },
  __edd_e__: { S: entityType },
  ...extra,
})

const makeZMock = (capture: Capture, stored: Record<string, AttributeValue>): DynamoClientService =>
  mockDynamoClient({
    ...makeMockClient(capture),
    getItem: () => Effect.succeed(mockOutput<GetItemCommandOutput>({ Item: stored })),
    updateItem: (input) => {
      capture.updateItem = input
      return Effect.succeed(mockOutput<UpdateItemCommandOutput>({ Attributes: stored }))
    },
  })

/** The SETs (physical name → value) and REMOVEs of an UpdateExpression. */
const wireOf = (update: {
  readonly UpdateExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
  readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
}): { sets: Record<string, AttributeValue>; removes: Set<string> } => {
  const expr = update.UpdateExpression ?? ""
  const names = update.ExpressionAttributeNames ?? {}
  const values = update.ExpressionAttributeValues ?? {}
  const setClause = expr.match(/SET\s+(.*?)(?:\s+REMOVE|$)/i)?.[1] ?? ""
  const sets: Record<string, AttributeValue> = {}
  for (const [, name, value] of setClause.matchAll(/(#\w+) = (:\w+)(?=,|$)/g)) {
    sets[names[name!] ?? name!] = values[value!]!
  }
  return { sets, removes: parseRemoves(update) }
}

/** An update builder, run through `.asEffect()`. */
type ZWrite = { readonly asEffect: () => Effect.Effect<unknown, unknown> }

const zClient = DynamoClient.make({ entities: { ZListings }, tables: { ZTable } })

/** Run `f` against the standard-path entity; the wire form of its UpdateItem. */
const zUpdate = (f: (db: Effect.Success<typeof zClient>) => ZWrite) => {
  const capture: Capture = {}
  const layer = Layer.mergeAll(
    Layer.succeed(DynamoClient, makeZMock(capture, zStoredItem("ZListing"))),
    ZTableLayer,
  )
  return Effect.gen(function* () {
    const db = yield* zClient
    yield* f(db).asEffect()
    expect(capture.updateItem).toBeDefined()
    return wireOf(capture.updateItem!)
  }).pipe(Effect.provide(layer), Effect.scoped)
}

const zSk = (index: KeyComposer.IndexDefinition, record: Record<string, unknown>) =>
  KeyComposer.composeZOrderSk(ZSchema, index, record)

const untouched = (wire: ReturnType<typeof wireOf>, field: string) => {
  expect(wire.sets).not.toHaveProperty(field)
  expect(wire.removes.has(field)).toBe(false)
}

describe("Entity update — Z-order halves, canonical shapes 7 and 8 (#171)", () => {
  describe("shape 7 — Z-order half over mutable fields", () => {
    it.effect(
      "full dimensions → SET { B } with the address bytes; the untouched PK half is skipped",
      () =>
        Effect.gen(function* () {
          const wire = yield* zUpdate((db) =>
            db.entities.ZListings.update({ listingId: "l-1" }).set(zdims),
          )
          expect(wire.sets.gsi2sk).toEqual({ B: ZDIMS_BYTES })
          expect((wire.sets.gsi2sk as { B: unknown }).B).toBeInstanceOf(Uint8Array)
          expect(wire.sets.gsi3sk).toEqual({ B: ZDIMS_BYTES })
          untouched(wire, "gsi2pk")
          untouched(wire, "gsi3pk")
          // Neighbouring shapes: byAgency lacks its prefix ('preserve' noop),
          // byOffice lacks its prefix ('sparse' REMOVE), byStatus has none of its
          // fields (skipped), byStatusPrice lacks status ('preserve' noop).
          untouched(wire, "gsi4sk")
          expect(wire.removes.has("gsi5sk")).toBe(true)
          untouched(wire, "gsi6sk")
          untouched(wire, "gsi7sk")
        }),
    )

    it.effect("partial dimensions → 'preserve' noop, 'sparse' REMOVE; never a truncated SET", () =>
      Effect.gen(function* () {
        const wire = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({ price: 300_000, bedrooms: 2 }),
        )
        untouched(wire, "gsi2sk")
        expect(wire.removes.has("gsi3sk")).toBe(true)
        expect(wire.sets).not.toHaveProperty("gsi3sk")
      }),
    )

    it.effect("'preserve' + remove([dimension]) → REMOVE (cascade override)", () =>
      Effect.gen(function* () {
        const wire = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" })
            .set({ price: 300_000, bedrooms: 2 })
            .remove(["listedAt"]),
        )
        expect(wire.removes.has("gsi2sk")).toBe(true)
        expect(wire.removes.has("gsi3sk")).toBe(true)
        expect(wire.sets).not.toHaveProperty("gsi2sk")
      }),
    )

    it.effect("no dimension touched → every Z-order SK half skipped, even under 'sparse'", () =>
      Effect.gen(function* () {
        const wire = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({ title: "Renovated" }),
        )
        for (const n of [2, 3, 4, 5, 6, 7, 8]) untouched(wire, `gsi${n}sk`)
      }),
    )

    it.effect(
      "a change within one level writes identical bytes; crossing a level changes them",
      () =>
        Effect.gen(function* () {
          const at = (dims: Partial<typeof zdims>) =>
            zUpdate((db) =>
              db.entities.ZListings.update({ listingId: "l-1" }).set({ ...zdims, ...dims }),
            ).pipe(Effect.map((wire) => wire.sets.gsi2sk))
          expect(yield* at({ price: 250_999 })).toEqual({ B: ZDIMS_BYTES })
          expect(yield* at({ listedAt: DateTime.makeUnsafe("2024-01-02T00:59:59.999Z") })).toEqual({
            B: ZDIMS_BYTES,
          })
          const moved = yield* at({ price: 251_000 })
          expect(moved).not.toEqual({ B: ZDIMS_BYTES })
          expect(moved).toEqual({
            B: zSk(ZListings.indexes.byFacets, { ...zdimsKeyForm, price: 251_000 }),
          })
        }),
    )
  })

  describe("shapes 7a / 7a′ — layout edges", () => {
    it.effect("7a: a single 1-bit dimension writes one byte, 0x00 or 0x01", () =>
      Effect.gen(function* () {
        const draft = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({ status: "draft" }),
        )
        const live = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({ status: "live" }),
        )
        expect(draft.sets.gsi6sk).toEqual({ B: Uint8Array.of(0x00) })
        expect(live.sets.gsi6sk).toEqual({ B: Uint8Array.of(0x01) })
        // byStatusPrice shares `status` but lacks `price` → 'preserve' noop.
        untouched(live, "gsi7sk")
      }),
    )

    it.effect("7a′: 1-bit literals + 13-bit int → two right-aligned bytes", () =>
      Effect.gen(function* () {
        const low = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({ status: "draft", price: 0 }),
        )
        const high = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({ status: "live", price: 8191 }),
        )
        expect(low.sets.gsi7sk).toEqual({ B: Uint8Array.of(0x00, 0x00) })
        expect(high.sets.gsi7sk).toEqual({ B: Uint8Array.of(0x3f, 0xff) })
      }),
    )
  })

  describe("shape 7b — constant PK half over a Z-order SK (shape 6 analogue)", () => {
    const constantPk = KeyComposer.composePk(ZSchema, "ZListing", ZListings.indexes.byFacetsAll, {})

    it.effect(
      "'sparse' + partial dimensions → PK SET + SK REMOVE (the item leaves the index)",
      () =>
        Effect.gen(function* () {
          const wire = yield* zUpdate((db) =>
            db.entities.ZListings.update({ listingId: "l-1" }).set({ price: 300_000 }),
          )
          expect(wire.sets.gsi8pk).toEqual({ S: constantPk })
          expect(wire.removes.has("gsi8sk")).toBe(true)
          expect(wire.sets).not.toHaveProperty("gsi8sk")
        }),
    )

    it.effect("full dimensions → PK SET + SK SET", () =>
      Effect.gen(function* () {
        const wire = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set(zdims),
        )
        expect(wire.sets.gsi8pk).toEqual({ S: constantPk })
        expect(wire.sets.gsi8sk).toEqual({ B: ZDIMS_BYTES })
      }),
    )

    it.effect("no dimension touched → the constant PK is still SET; the SK half is skipped", () =>
      Effect.gen(function* () {
        const wire = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({ title: "Renovated" }),
        )
        expect(wire.sets.gsi8pk).toEqual({ S: constantPk })
        untouched(wire, "gsi8sk")
      }),
    )
  })

  describe("shape 8 — Z-order half with sk.prefix", () => {
    it.effect("prefix + every dimension → SET the prefix segments followed by the address", () =>
      Effect.gen(function* () {
        const wire = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({
            agencyId: "AG-1",
            officeId: "Office-9",
            ...zdims,
          }),
        )
        const bytes = (wire.sets.gsi4sk as { B: Uint8Array }).B
        // u16be(4) ‖ "ag-1" (lowercase casing) ‖ 8 hash bytes of "office-9" ‖ address.
        expect(Array.from(bytes.slice(0, 6))).toEqual([0x00, 0x04, 0x61, 0x67, 0x2d, 0x31])
        expect(bytes.length).toBe(6 + 8 + 5)
        expect(bytes.slice(-5)).toEqual(ZDIMS_BYTES)
        expect(bytes).toEqual(
          zSk(ZListings.indexes.byAgency, {
            agencyId: "AG-1",
            officeId: "Office-9",
            ...zdimsKeyForm,
          }),
        )
      }),
    )

    it.effect("a prefix change moves the entry (different bytes, same address)", () =>
      Effect.gen(function* () {
        const wire = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({
            agencyId: "AG-2",
            officeId: "Office-9",
            ...zdims,
          }),
        )
        const bytes = (wire.sets.gsi4sk as { B: Uint8Array }).B
        expect(bytes).toEqual(
          zSk(ZListings.indexes.byAgency, {
            agencyId: "AG-2",
            officeId: "Office-9",
            ...zdimsKeyForm,
          }),
        )
        expect(bytes).not.toEqual(
          zSk(ZListings.indexes.byAgency, {
            agencyId: "AG-1",
            officeId: "Office-9",
            ...zdimsKeyForm,
          }),
        )
        expect(bytes.slice(-5)).toEqual(ZDIMS_BYTES)
      }),
    )
  })

  describe("shape 8b — prefix and dimensions owned by different writers (#41 analogue)", () => {
    it.effect(
      "writer A updates the prefix alone → never a SET ('preserve' noop, 'sparse' REMOVE)",
      () =>
        Effect.gen(function* () {
          const wire = yield* zUpdate((db) =>
            db.entities.ZListings.update({ listingId: "l-1" }).set({
              agencyId: "AG-2",
              officeId: "Office-1",
            }),
          )
          untouched(wire, "gsi4sk")
          expect(wire.removes.has("gsi5sk")).toBe(true)
          expect(wire.sets).not.toHaveProperty("gsi5sk")
        }),
    )

    it.effect("writer B's dimensions SET only with the prefix in the payload; else policy", () =>
      Effect.gen(function* () {
        const without = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set(zdims),
        )
        untouched(without, "gsi4sk")
        const withPrefix = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" }).set({
            ...zdims,
            agencyId: "AG-1",
            officeId: "Office-9",
          }),
        )
        expect(withPrefix.sets.gsi4sk).toEqual({
          B: zSk(ZListings.indexes.byAgency, {
            agencyId: "AG-1",
            officeId: "Office-9",
            ...zdimsKeyForm,
          }),
        })
      }),
    )
  })

  describe("shape 8c — hierarchical prefix never truncates (shape 3 analogue)", () => {
    it.effect("set({ agencyId }).remove(['officeId']) → REMOVE under 'sparse' and 'preserve'", () =>
      Effect.gen(function* () {
        const wire = yield* zUpdate((db) =>
          db.entities.ZListings.update({ listingId: "l-1" })
            .set({ agencyId: "AG-2", price: 250_000 })
            .remove(["officeId"]),
        )
        // byOffice ('sparse'): the rule REMOVEs.
        expect(wire.removes.has("gsi5sk")).toBe(true)
        expect(wire.sets).not.toHaveProperty("gsi5sk")
        // byAgency ('preserve'): the cascade override REMOVEs.
        expect(wire.removes.has("gsi4sk")).toBe(true)
        expect(wire.sets).not.toHaveProperty("gsi4sk")
      }),
    )
  })
})

// Shape 8a — every prefix composite and dimension is also a primary-key
// composite (#43 analogue): recomposed from the key record on every write.

class ZKeyedListing extends Schema.Class<ZKeyedListing>("ZKeyedListing")({
  region: Schema.String,
  agencyId: Schema.String,
  price: Schema.Number,
  bedrooms: Schema.Number,
  listedAt: DynamoModel.DateString,
  title: Schema.optional(Schema.String),
}) {}

const ZKeyedListings = Entity.make({
  model: ZKeyedListing,
  entityType: "ZKeyedListing",
  primaryKey: {
    pk: { field: "pk", composite: ["region"] },
    sk: { field: "sk", composite: ["agencyId", "price", "bedrooms", "listedAt"] },
  },
  indexes: {
    byAgency: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["region"] },
      sk: { field: "gsi3sk", prefix: ["agencyId"], zorder: facets },
      indexPolicy: { pk: "sparse", sk: "sparse" },
    },
  },
})

const ZKeyedTable = Table.make({ schema: ZSchema, entities: { ZKeyedListings } })

describe("Entity update — shape 8a: every Z-order field is a primary-key composite (#43 analogue)", () => {
  it.effect("an update touching none of them SETs both halves from the key record", () => {
    const capture: Capture = {}
    const stored = zStoredItem("ZKeyedListing")
    const layer = Layer.mergeAll(
      Layer.succeed(DynamoClient, makeZMock(capture, stored)),
      ZKeyedTable.layer({ name: "zorder-keyed-table" }),
    )
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { ZKeyedListings },
        tables: { ZKeyedTable },
      })
      yield* db.entities.ZKeyedListings.update({
        region: "North",
        agencyId: "AG-1",
        ...zdims,
      }).set({ title: "Renovated" })
      const wire = wireOf(capture.updateItem!)
      const keyRecord = { region: "North", agencyId: "AG-1", ...zdimsKeyForm }
      expect(wire.sets.gsi3pk).toEqual({
        S: KeyComposer.composePk(
          ZSchema,
          "ZKeyedListing",
          ZKeyedListings.indexes.byAgency,
          keyRecord,
        ),
      })
      expect(wire.sets.gsi3sk).toEqual({ B: zSk(ZKeyedListings.indexes.byAgency, keyRecord) })
      expect(wire.removes.size).toBe(0)
    }).pipe(Effect.provide(layer), Effect.scoped)
  })
})

// Retain path — read-then-write: the composer sees the merged item, so a half
// whose fields are all stored recomposes from one changed dimension.

const ZRetainListings = Entity.make({
  model: ZListing,
  entityType: "ZRetainListing",
  primaryKey: {
    pk: { field: "pk", composite: ["listingId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byFacets: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["region"] },
      sk: { field: "gsi2sk", zorder: facets },
    },
    byOffice: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["region"] },
      sk: { field: "gsi5sk", prefix: ["agencyId", "officeId"], zorder: [facets[0]] },
      indexPolicy: { sk: "sparse" },
    },
  },
  versioned: { retain: true },
})

const ZRetainTable = Table.make({ schema: ZSchema, entities: { ZRetainListings } })

const zRetainStored = zStoredItem("ZRetainListing", {
  version: { N: "1" },
  gsi2pk: { S: "$zorder-policy#v1#zretainlisting#region_north" },
  gsi2sk: { B: ZDIMS_BYTES },
  gsi5pk: { S: "$zorder-policy#v1#zretainlisting#region_north" },
  gsi5sk: { B: zSk(ZListings.indexes.byOffice, zStoredRecord) },
})

const zRetainClient = DynamoClient.make({
  entities: { ZRetainListings },
  tables: { ZRetainTable },
})

const zRetainUpdate = (f: (db: Effect.Success<typeof zRetainClient>) => ZWrite) => {
  const capture: Capture = {}
  const layer = Layer.mergeAll(
    Layer.succeed(DynamoClient, makeZMock(capture, zRetainStored)),
    ZRetainTable.layer({ name: "zorder-retain-table" }),
  )
  return Effect.gen(function* () {
    const db = yield* zRetainClient
    yield* f(db).asEffect()
    const tx = capture.transactWriteItems as {
      TransactItems: Array<{
        Update?: Parameters<typeof applyUpdate>[1]
        Put?: { Item: Record<string, AttributeValue> }
      }>
    }
    expect(tx).toBeDefined()
    const update = tx.TransactItems.find((item) => item.Update !== undefined)!.Update!
    return { written: applyUpdate(zRetainStored, update)!, tx }
  }).pipe(Effect.provide(layer), Effect.scoped)
}

describe("Entity update — Z-order halves on the retain path (#171)", () => {
  it.effect("one changed dimension recomposes the address from the stored fields", () =>
    Effect.gen(function* () {
      const { written, tx } = yield* zRetainUpdate((db) =>
        db.entities.ZRetainListings.update({ listingId: "l-1" }).set({ price: 300_000 }),
      )
      expect(written.gsi2sk).toEqual({
        B: zSk(ZRetainListings.indexes.byFacets, { ...zdimsKeyForm, price: 300_000 }),
      })
      expect(written.gsi2sk).not.toEqual({ B: ZDIMS_BYTES })
      expect(written.gsi5sk).toEqual({
        B: zSk(ZRetainListings.indexes.byOffice, { ...zStoredRecord, price: 300_000 }),
      })
      // The version snapshot strips every GSI key, the binary one included.
      const snapshot = tx.TransactItems.find((item) => item.Put !== undefined)?.Put?.Item
      expect(snapshot).toBeDefined()
      expect(snapshot).not.toHaveProperty("gsi2sk")
      expect(snapshot).not.toHaveProperty("gsi5sk")
    }),
  )

  it.effect("remove([dimension]) → REMOVE under 'preserve' (cascade override) and 'sparse'", () =>
    Effect.gen(function* () {
      const { written } = yield* zRetainUpdate((db) =>
        db.entities.ZRetainListings.update({ listingId: "l-1" }).remove(["price"]),
      )
      expect(written.gsi2sk).toBeUndefined()
      expect(written.gsi5sk).toBeUndefined()
      expect(written.gsi2pk).toEqual(zRetainStored.gsi2pk)
    }),
  )

  it.effect("8c: set({ agencyId }).remove(['officeId']) REMOVEs, never truncates", () =>
    Effect.gen(function* () {
      const { written } = yield* zRetainUpdate((db) =>
        db.entities.ZRetainListings.update({ listingId: "l-1" })
          .set({ agencyId: "AG-2" })
          .remove(["officeId"]),
      )
      expect(written.gsi5sk).toBeUndefined()
      // byFacets has neither field → untouched, the stored address stays.
      expect(written.gsi2sk).toEqual({ B: ZDIMS_BYTES })
    }),
  )

  it.effect("an update touching no Z-order field leaves the stored addresses", () =>
    Effect.gen(function* () {
      const { written } = yield* zRetainUpdate((db) =>
        db.entities.ZRetainListings.update({ listingId: "l-1" }).set({ title: "Renovated" }),
      )
      expect(written.gsi2sk).toEqual({ B: ZDIMS_BYTES })
      expect(written.gsi5sk).toEqual(zRetainStored.gsi5sk)
    }),
  )
})

// `.append()` — the current row's UpdateItem: a Z-order half recomposes iff
// `appendInput` carries every one of its fields; otherwise the policy decides.

class ZObservation extends Schema.Class<ZObservation>("ZObservation")({
  listingId: Schema.String,
  region: Schema.String,
  price: Schema.Number,
  bedrooms: Schema.Number,
  observedAt: Schema.DateTimeUtc,
  agencyId: Schema.optional(Schema.String),
}) {}

const ZObservationAppendInput = Schema.Struct({
  listingId: Schema.String,
  region: Schema.String,
  price: Schema.Number,
  bedrooms: Schema.Number,
  observedAt: Schema.DateTimeUtc,
})

const ZObservations = Entity.make({
  model: ZObservation,
  entityType: "ZObservation",
  primaryKey: {
    pk: { field: "pk", composite: ["listingId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byFacets: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["region"] },
      sk: { field: "gsi2sk", zorder: [facets[0], facets[1]] },
    },
    byAgency: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["region"] },
      sk: { field: "gsi3sk", prefix: ["agencyId"], zorder: [facets[0]] },
      indexPolicy: { sk: "sparse" },
    },
  },
  timeSeries: {
    orderBy: "observedAt",
    ttl: Duration.days(7),
    appendInput: ZObservationAppendInput,
  },
})

const ZObservationTable = Table.make({ schema: ZSchema, entities: { ZObservations } })

describe("Entity append — Z-order halves (#171)", () => {
  it.effect(
    "appendInput with every dimension SETs the address; a half needing a field outside it follows its policy",
    () => {
      const capture: Capture = {}
      const layer = Layer.mergeAll(
        Layer.succeed(
          DynamoClient,
          mockDynamoClient({
            ...makeMockClient(capture),
            getItem: () => Effect.die("getItem not used on append path"),
          }),
        ),
        ZObservationTable.layer({ name: "zorder-append-table" }),
      )
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { ZObservations },
          tables: { ZObservationTable },
        })
        yield* db.entities.ZObservations.append({
          listingId: "l-1",
          region: "North",
          price: 250_000,
          bedrooms: 3,
          observedAt: DateTime.makeUnsafe("2026-04-30T10:00:00.000Z"),
        }).skipFollowUp()
        const tx = capture.transactWriteItems as {
          TransactItems: Array<{
            Update?: Parameters<typeof wireOf>[0]
            Put?: { Item: Record<string, AttributeValue> }
          }>
        }
        const wire = wireOf(tx.TransactItems[0]!.Update!)
        expect(wire.sets.gsi2sk).toEqual({
          B: zSk(ZObservations.indexes.byFacets, { price: 250_000, bedrooms: 3 }),
        })
        expect(wire.sets.gsi2pk).toBeDefined()
        // byAgency needs agencyId, which appendInput doesn't carry → 'sparse' REMOVE.
        expect(wire.removes.has("gsi3sk")).toBe(true)
        expect(wire.sets).not.toHaveProperty("gsi3sk")
        // The event item carries no GSI key.
        const event = tx.TransactItems[1]!.Put!.Item
        expect(event).not.toHaveProperty("gsi2sk")
        expect(event).not.toHaveProperty("gsi3sk")
      }).pipe(Effect.provide(layer), Effect.scoped)
    },
  )
})

// ---------------------------------------------------------------------------
// Sharded indexes (#183): the canonical shapes through the standard, retain and
// append paths, with the new degenerate fixtures 9a–9c.
// ---------------------------------------------------------------------------

describe("Entity update — sharded indexes, canonical shapes (#183)", () => {
  const ShardedSchema = DynamoSchema.make({ name: "fleet", version: 1 })

  class Fleet extends Schema.Class<Fleet>("Fleet")({
    channel: Schema.String,
    deviceId: Schema.String,
    accountId: Schema.optional(Schema.String),
    alertState: Schema.optional(Schema.String),
    timestamp: Schema.optional(Schema.Number),
    region: Schema.optional(Schema.String),
    country: Schema.optional(Schema.String),
    city: Schema.optional(Schema.String),
    deviceBinding: Schema.optional(Schema.String),
    zone: Schema.optional(Schema.String),
    hubId: Schema.optional(Schema.String),
    tenantId: Schema.optional(Schema.String),
    groupId: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
  }) {}

  const primaryKey = {
    pk: { field: "pk", composite: ["channel"] },
    sk: { field: "sk", composite: ["deviceId"] },
  } as const

  const shapes = {
    // Shape 1: multi-writer. The account is one writer's, the alert another's.
    multiWriter: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["accountId"] },
      sk: { field: "gsi1sk", composite: ["alertState", "timestamp"] },
      shards: 8,
    },
    // Shape 2: PK-composites-only. Every value arrives through the key (#43).
    keyOnly: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["channel"] },
      sk: { field: "gsi2sk", composite: ["deviceId"] },
      shards: 8,
    },
    // Shape 3: hierarchical.
    hierarchy: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["region"] },
      sk: { field: "gsi3sk", composite: ["country", "city"] },
      shards: 8,
    },
    // Shape 4: hole. An optional leading composite, a present trailing one.
    hole: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["zone", "hubId"] },
      sk: { field: "gsi4sk", composite: ["status"] },
      shards: 8,
    },
    // Shape 6: an empty sort key half: a constant prefix (#46).
    binding: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["deviceBinding"] },
      sk: { field: "gsi5sk", composite: [] },
      shards: 8,
    },
  } as const

  const degenerate = {
    // Shape 5: all composites mutable, with `by`.
    byGroup: {
      name: "gsi6",
      pk: { field: "gsi6pk", composite: ["tenantId"] },
      sk: { field: "gsi6sk", composite: ["groupId", "status"] },
      shards: { count: 8, by: ["groupId"] },
    },
    // 9a: an empty partition key half with `by`: no longer a constant.
    emptyPkBy: {
      name: "gsi7",
      pk: { field: "gsi7pk", composite: [] },
      sk: { field: "gsi7sk", composite: ["groupId"] },
      shards: { count: 8, by: ["groupId"] },
    },
    // 9b: a `by` attribute that is also in the primary key.
    keyedBy: {
      name: "gsi8",
      pk: { field: "gsi8pk", composite: ["zone"] },
      sk: { field: "gsi8sk", composite: ["deviceId"] },
      shards: { count: 8, by: ["deviceId"] },
    },
    // 9c: an empty partition key half with the default source: varies per item.
    emptyPk: {
      name: "gsi9",
      pk: { field: "gsi9pk", composite: [] },
      sk: { field: "gsi9sk", composite: ["status"] },
      shards: 8,
    },
  } as const

  const Fleets = Entity.make({
    model: Fleet,
    entityType: "Fleet",
    primaryKey,
    indexes: { ...shapes, ...degenerate },
  })
  const Retained = Entity.make({
    model: Fleet,
    entityType: "Retained",
    primaryKey,
    indexes: { ...shapes, ...degenerate },
    versioned: { retain: true },
  })
  const ShardedTable = Table.make({ schema: ShardedSchema, entities: { Fleets, Retained } })
  const ShardedLayer = ShardedTable.layer({ name: "fleet-table" })

  const stored = (entityType: string, extra: Record<string, AttributeValue> = {}) => ({
    pk: { S: "pk" },
    sk: { S: "sk" },
    channel: { S: "channel-a" },
    deviceId: { S: "device-1" },
    version: { N: "1" },
    __edd_e__: { S: entityType },
    ...extra,
  })

  const client = DynamoClient.make({ entities: { Fleets, Retained }, tables: { ShardedTable } })

  const updateOf = (
    entity: "Fleets" | "Retained",
    f: (update: any) => { readonly asEffect: () => Effect.Effect<unknown, unknown> },
    extra: Record<string, AttributeValue> = {},
  ) => {
    const capture: Capture = {}
    const row = stored(entity === "Fleets" ? "Fleet" : "Retained", extra)
    const layer = Layer.mergeAll(Layer.succeed(DynamoClient, makeZMock(capture, row)), ShardedLayer)
    return Effect.gen(function* () {
      const db: any = yield* client
      yield* f(
        db.entities[entity].update({ channel: "channel-a", deviceId: "device-1" }),
      ).asEffect()
      const written =
        entity === "Fleets"
          ? capture.updateItem
          : (capture.transactWriteItems?.TransactItems?.[0]?.Update as UpdateItemCommandInput)
      expect(written).toBeDefined()
      return wireOf(written!)
    }).pipe(Effect.provide(layer), Effect.scoped)
  }

  const standard = (f: Parameters<typeof updateOf>[1]) => updateOf("Fleets", f)
  const retained = (f: Parameters<typeof updateOf>[1], extra?: Record<string, AttributeValue>) =>
    updateOf("Retained", f, extra)

  /** The sharded text of a partition key: its marker, then its values. */
  const shardedText = (entityType: string, shard: number, rest = "") =>
    `$fleet#v1#${entityType}#!8.${shard}${rest}`
  const keySource = shardOf(["channel-a", "device-1"], 8)
  const groupShard = (group: string) => shardOf([group], 8)

  describe("shape 1 — multi-writer", () => {
    it.effect("a writer's SK half alone: the sharded PK half is skipped", () =>
      Effect.gen(function* () {
        const wire = yield* standard((u) => u.set({ alertState: "ok", timestamp: 5 }))
        untouched(wire, "gsi1pk")
        expect(wire.sets.gsi1sk?.S).toBe(
          `$fleet#v1#fleet#alertstate_ok#timestamp_${KeyComposer.serializeValue(5)}`,
        )
      }),
    )

    it.effect("the other writer's PK half: SET sharded, SK untouched", () =>
      Effect.gen(function* () {
        const wire = yield* standard((u) => u.set({ accountId: "acct" }))
        expect(wire.sets.gsi1pk?.S).toBe(shardedText("fleet", keySource, "#accountid_acct"))
        untouched(wire, "gsi1sk")
      }),
    )
  })

  describe("shape 2 — PK-composites-only (#43)", () => {
    it.effect("every write SETs the sharded key, from the key alone", () =>
      Effect.gen(function* () {
        const wire = yield* standard((u) => u.set({ status: "on" }))
        expect(wire.sets.gsi2pk?.S).toBe(shardedText("fleet", keySource, "#channel_channel-a"))
        expect(wire.sets.gsi2sk?.S).toBe("$fleet#v1#fleet#deviceid_device-1")
      }),
    )
  })

  describe("shape 3 — hierarchical", () => {
    it.effect("a truncated PK half keeps the marker; the SK truncates", () =>
      Effect.gen(function* () {
        const wire = yield* standard((u) => u.set({ region: "r", country: "c" }).remove(["city"]))
        expect(wire.sets.gsi3pk?.S).toBe(shardedText("fleet", keySource, "#region_r"))
        expect(wire.sets.gsi3sk?.S).toBe("$fleet#v1#fleet#country_c")
        expect(wire.removes.has("gsi3pk")).toBe(false)
      }),
    )
  })

  describe("shape 4 — hole", () => {
    it.effect("'preserve' leaves the half; `.remove()` cascades", () =>
      Effect.gen(function* () {
        const left = yield* standard((u) => u.set({ hubId: "h" }))
        untouched(left, "gsi4pk")
        const cascaded = yield* standard((u) => u.set({ hubId: "h" }).remove(["zone"]))
        expect(cascaded.removes.has("gsi4pk")).toBe(true)
      }),
    )
  })

  describe("shape 5 — all composites mutable", () => {
    it.effect("the payload carries them: the entry moves to its new shard", () =>
      Effect.gen(function* () {
        const wire = yield* standard((u) => u.set({ tenantId: "t", groupId: "g", status: "on" }))
        expect(wire.sets.gsi6pk?.S).toBe(shardedText("fleet", groupShard("g"), "#tenantid_t"))
        expect(wire.sets.gsi6sk?.S).toBe("$fleet#v1#fleet#groupid_g#status_on")
      }),
    )
  })

  describe("shape 6 — empty sort key half (#46)", () => {
    it.effect("the constant prefix always SETs; the sharded PK when bound", () =>
      Effect.gen(function* () {
        const unbound = yield* standard((u) => u.set({ status: "on" }))
        expect(unbound.sets.gsi5sk?.S).toBe("$fleet#v1#fleet")
        untouched(unbound, "gsi5pk")
        const bound = yield* standard((u) => u.set({ deviceBinding: "b" }))
        expect(bound.sets.gsi5pk?.S).toBe(shardedText("fleet", keySource, "#devicebinding_b"))
        expect(bound.sets.gsi5sk?.S).toBe("$fleet#v1#fleet")
      }),
    )
  })

  describe("the update gate with `by` (finding 2)", () => {
    it.effect("a `by`-only update fails with nothing written", () => {
      const capture: Capture = {}
      const layer = Layer.mergeAll(
        Layer.succeed(DynamoClient, makeZMock(capture, stored("Fleet"))),
        ShardedLayer,
      )
      return Effect.gen(function* () {
        const db: any = yield* client
        const error: any = yield* db.entities.Fleets.update({
          channel: "channel-a",
          deviceId: "device-1",
        })
          .set({ groupId: "g" })
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String(error.cause)).toContain("[EDD-9100]")
        expect(capture.updateItem).toBeUndefined()
      }).pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<void, unknown>
    })

    it.effect("moving the tenant without `by` fails rather than go unsharded", () => {
      const capture: Capture = {}
      const layer = Layer.mergeAll(
        Layer.succeed(DynamoClient, makeZMock(capture, stored("Fleet"))),
        ShardedLayer,
      )
      return Effect.gen(function* () {
        const db: any = yield* client
        const error: any = yield* db.entities.Fleets.update({
          channel: "channel-a",
          deviceId: "device-1",
        })
          .set({ tenantId: "t" })
          .asEffect()
          .pipe(Effect.flip)
        expect(String(error.cause)).toContain("[EDD-9100]")
        expect(capture.updateItem).toBeUndefined()
      }).pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<void, unknown>
    })

    it.effect("`.remove(['groupId'])` drops the sharded half and writes no unsharded key", () =>
      Effect.gen(function* () {
        const wire = yield* standard((u) => u.remove(["groupId"]))
        expect(wire.removes.has("gsi6pk")).toBe(true)
        expect(wire.sets).not.toHaveProperty("gsi6pk")
      }),
    )

    it.effect("an unrelated update leaves it alone", () =>
      Effect.gen(function* () {
        const wire = yield* standard((u) => u.set({ zone: "z" }))
        untouched(wire, "gsi6pk")
      }),
    )

    it.effect("the retain path reads the item, so a `by`-only update composes", () =>
      Effect.gen(function* () {
        const wire = yield* retained((u) => u.set({ groupId: "g" }), {
          tenantId: { S: "t" },
          status: { S: "on" },
        })
        expect(wire.sets.gsi6pk?.S).toBe(shardedText("retained", groupShard("g"), "#tenantid_t"))
      }),
    )

    it.effect("the retain path's whole item doesn't count as touching `by`", () =>
      Effect.gen(function* () {
        const wire = yield* retained((u) => u.set({ zone: "z" }), {
          tenantId: { S: "t" },
          status: { S: "on" },
        })
        expect(wire.removes.has("gsi6pk")).toBe(false)
      }),
    )
  })

  describe("new degenerate fixtures", () => {
    it.effect("9a — empty PK half with `by`: skipped until `by` is written", () =>
      Effect.gen(function* () {
        const unrelated = yield* standard((u) => u.set({ zone: "z" }))
        untouched(unrelated, "gsi7pk")
        const moved = yield* standard((u) => u.set({ tenantId: "t", groupId: "g" }))
        expect(moved.sets.gsi7pk?.S).toBe(shardedText("fleet", groupShard("g")))
        expect(moved.sets.gsi7sk?.S).toBe("$fleet#v1#fleet#groupid_g")
        const removed = yield* standard((u) => u.remove(["groupId"]))
        expect(removed.removes.has("gsi7pk")).toBe(true)
      }),
    )

    it.effect("9b — `by` in the primary key: composes from the key record", () =>
      Effect.gen(function* () {
        const untouchedHalf = yield* standard((u) => u.set({ status: "on" }))
        untouched(untouchedHalf, "gsi8pk")
        const moved = yield* standard((u) => u.set({ zone: "z" }))
        expect(moved.sets.gsi8pk?.S).toBe(shardedText("fleet", shardOf(["device-1"], 8), "#zone_z"))
      }),
    )

    it.effect("9c — empty PK half with the default source: varies per item", () =>
      Effect.gen(function* () {
        const wire = yield* standard((u) => u.set({ status: "on" }))
        expect(wire.sets.gsi9pk?.S).toBe(shardedText("fleet", keySource))
        expect(wire.sets.gsi9sk?.S).toBe("$fleet#v1#fleet#status_on")
      }),
    )
  })

  describe("the Z-order shapes", () => {
    class Listing extends Schema.Class<Listing>("Listing")({
      listingId: Schema.String,
      region: Schema.optional(Schema.String),
      agencyId: Schema.optional(Schema.String),
      price: Schema.optional(Schema.Number),
      bedrooms: Schema.optional(Schema.Number),
    }) {}
    const zorder = [
      { field: "price", min: 0, max: 1000, step: 1 },
      { field: "bedrooms", min: 0, max: 15, step: 1 },
    ] as const
    const Listings = Entity.make({
      model: Listing,
      entityType: "Listing",
      primaryKey: {
        pk: { field: "pk", composite: ["listingId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        // Shape 7: a sharded PK half beside a Z-order SK.
        byFacets: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["region"] },
          sk: { field: "gsi1sk", zorder },
          shards: 4,
        },
        // Shape 8: a composite prefix before the bytes.
        byAgency: {
          name: "gsi2",
          pk: { field: "gsi2pk", composite: ["region"] },
          sk: { field: "gsi2sk", prefix: ["agencyId"], zorder },
          shards: 4,
        },
      },
    })
    const ZShardedTable = Table.make({ schema: ShardedSchema, entities: { Listings } })

    const write = (payload: Record<string, unknown>) => {
      const capture: Capture = {}
      const layer = Layer.mergeAll(
        Layer.succeed(
          DynamoClient,
          makeZMock(capture, {
            pk: { S: "pk" },
            sk: { S: "sk" },
            listingId: { S: "l-1" },
            __edd_e__: { S: "Listing" },
          }),
        ),
        ZShardedTable.layer({ name: "z-table" }),
      )
      return Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Listings },
          tables: { ZShardedTable },
        })
        yield* db.entities.Listings.update({ listingId: "l-1" }).set(payload).asEffect()
        return wireOf(capture.updateItem!)
      }).pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<
        ReturnType<typeof wireOf>,
        unknown
      >
    }

    it.effect("shape 7: the sharded PK beside the bytes, each half on its own", () =>
      Effect.gen(function* () {
        const full = yield* write({ region: "r", price: 5, bedrooms: 2 })
        expect(full.sets.gsi1pk?.S).toMatch(/^\$fleet#v1#listing#!4\.\d#region_r$/)
        expect(full.sets.gsi1sk?.B).toBeInstanceOf(Uint8Array)
        const dimensions = yield* write({ price: 5, bedrooms: 2 })
        untouched(dimensions, "gsi1pk")
        expect(dimensions.sets.gsi1sk?.B).toBeInstanceOf(Uint8Array)
      }),
    )

    it.effect("shape 8: a prefix change isn't a shard change without `by`", () =>
      Effect.gen(function* () {
        const wire = yield* write({ agencyId: "a", price: 5, bedrooms: 2 })
        untouched(wire, "gsi2pk")
        expect(wire.sets.gsi2sk?.B).toBeInstanceOf(Uint8Array)
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Canonical shape 10 (#183): a half mixing a primary key composite with a mutable
// one. One composite in the key record is no claim on the half: an update that
// names no composite of it must leave the stored key byte for byte, on every path.
// ---------------------------------------------------------------------------

class MixedDevice extends Schema.Class<MixedDevice>("MixedDevice")({
  channel: Schema.String,
  deviceId: Schema.String,
  at: Schema.DateTimeUtc,
  zone: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}) {}

const mixedIndexes = {
  leadingSparse: {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["channel"] },
    sk: { field: "gsi1sk", composite: ["zone", "deviceId"] },
    indexPolicy: { sk: "sparse" },
  },
  leadingPreserve: {
    name: "gsi2",
    pk: { field: "gsi2pk", composite: ["channel"] },
    sk: { field: "gsi2sk", composite: ["zone", "deviceId"] },
  },
  trailing: {
    name: "gsi3",
    pk: { field: "gsi3pk", composite: ["channel"] },
    sk: { field: "gsi3sk", composite: ["deviceId", "zone"] },
  },
  mixedPk: {
    name: "gsi4",
    pk: { field: "gsi4pk", composite: ["channel", "zone"] },
    sk: { field: "gsi4sk", composite: ["deviceId"] },
  },
  sharded: {
    name: "gsi5",
    pk: { field: "gsi5pk", composite: ["channel", "zone"] },
    sk: { field: "gsi5sk", composite: ["deviceId"] },
    shards: 8,
  },
} as const

const mixedPrimary = {
  pk: { field: "pk", composite: ["channel"] },
  sk: { field: "sk", composite: ["deviceId"] },
} as const

const MixedSchema = DynamoSchema.make({ name: "mixed", version: 1 })
const MixedDevices = Entity.make({
  model: MixedDevice,
  entityType: "MixedDevice",
  primaryKey: mixedPrimary,
  indexes: mixedIndexes,
})
const MixedRetained = Entity.make({
  model: MixedDevice,
  entityType: "MixedRetained",
  primaryKey: mixedPrimary,
  indexes: mixedIndexes,
  versioned: { retain: true },
})
const MixedSeries = Entity.make({
  model: MixedDevice,
  entityType: "MixedSeries",
  primaryKey: mixedPrimary,
  indexes: mixedIndexes,
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      channel: Schema.String,
      deviceId: Schema.String,
      at: Schema.DateTimeUtc,
      status: Schema.optional(Schema.String),
    }),
  },
})
const MixedSeriesWithZone = Entity.make({
  model: MixedDevice,
  entityType: "MixedSeries",
  primaryKey: mixedPrimary,
  indexes: mixedIndexes,
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      channel: Schema.String,
      deviceId: Schema.String,
      at: Schema.DateTimeUtc,
      zone: Schema.optional(Schema.String),
    }),
  },
})
const MixedTable = Table.make({
  schema: MixedSchema,
  entities: { MixedDevices, MixedRetained, MixedSeries },
})
const MixedZoneTable = Table.make({
  schema: MixedSchema,
  entities: { MixedSeriesWithZone },
})

/** Every half the unrelated writes below must not touch. */
const MIXED_HALVES = ["gsi1sk", "gsi2sk", "gsi3sk", "gsi4pk", "gsi5pk"] as const

const mixedStored = (entityType: string, zone?: string): Record<string, AttributeValue> => ({
  pk: { S: `$mixed#v1#${entityType.toLowerCase()}#channel_c-1` },
  sk: { S: `$mixed#v1#${entityType.toLowerCase()}#deviceid_d-1` },
  channel: { S: "c-1" },
  deviceId: { S: "d-1" },
  at: { S: "2026-04-30T10:00:00.000Z" },
  version: { N: "1" },
  __edd_e__: { S: entityType },
  ...(zone === undefined ? {} : { zone: { S: zone } }),
})

const mixedLayer = (capture: Capture, stored: Record<string, AttributeValue>) =>
  Layer.mergeAll(
    Layer.succeed(
      DynamoClient,
      mockDynamoClient({
        ...makeMockClient(capture),
        getItem: () => Effect.succeed(mockOutput<GetItemCommandOutput>({ Item: stored })),
        updateItem: (input) => {
          capture.updateItem = input
          return Effect.succeed(mockOutput<UpdateItemCommandOutput>({ Attributes: stored }))
        },
      }),
    ),
    MixedTable.layer({ name: "mixed-table" }),
    MixedZoneTable.layer({ name: "mixed-table" }),
  )

const mixedClient = DynamoClient.make({
  entities: { MixedDevices, MixedRetained, MixedSeries },
  tables: { MixedTable },
})

const standardMixed = (
  f: (devices: Effect.Success<typeof mixedClient>["entities"]["MixedDevices"]) => ZWrite,
) => {
  const capture: Capture = {}
  return Effect.gen(function* () {
    const db = yield* mixedClient
    yield* f(db.entities.MixedDevices).asEffect()
    return wireOf(capture.updateItem!)
  }).pipe(Effect.provide(mixedLayer(capture, mixedStored("MixedDevice"))), Effect.scoped)
}

const expectUntouched = (wire: ReturnType<typeof wireOf>) => {
  for (const half of MIXED_HALVES) {
    expect(wire.sets, half).not.toHaveProperty(half)
    expect(wire.removes.has(half), half).toBe(false)
  }
}

describe("Entity writes — shape 10: a half mixing a primary key composite with a mutable one", () => {
  describe("the standard path", () => {
    it.effect("an unrelated update leaves every mixed half alone, under both policies", () =>
      Effect.gen(function* () {
        const wire = yield* standardMixed((devices) =>
          devices.update({ channel: "c-1", deviceId: "d-1" }).set({ status: "on" }),
        )
        expectUntouched(wire)
        // The halves wholly in the primary key still compose (#43).
        expect(wire.sets.gsi1pk?.S).toBe("$mixed#v1#mixeddevice#channel_c-1")
        expect(wire.sets.gsi4sk?.S).toBe("$mixed#v1#mixeddevice#deviceid_d-1")
      }),
    )

    it.effect("naming the mutable composite composes each half", () =>
      Effect.gen(function* () {
        const wire = yield* standardMixed((devices) =>
          devices.update({ channel: "c-1", deviceId: "d-1" }).set({ zone: "z" }),
        )
        expect(wire.sets.gsi1sk?.S).toBe("$mixed#v1#mixeddevice#zone_z#deviceid_d-1")
        expect(wire.sets.gsi2sk?.S).toBe("$mixed#v1#mixeddevice#zone_z#deviceid_d-1")
        expect(wire.sets.gsi3sk?.S).toBe("$mixed#v1#mixeddevice#deviceid_d-1#zone_z")
        expect(wire.sets.gsi4pk?.S).toBe("$mixed#v1#mixeddevice#channel_c-1#zone_z")
        expect(wire.sets.gsi5pk?.S).toBe(
          `$mixed#v1#mixeddevice#!8.${shardOf(["c-1", "d-1"], 8)}#channel_c-1#zone_z`,
        )
        expect(wire.removes.size).toBe(0)
      }),
    )

    it.effect("`.remove()` cascades: a leading hole drops, a trailing one truncates", () =>
      Effect.gen(function* () {
        const wire = yield* standardMixed((devices) =>
          devices.update({ channel: "c-1", deviceId: "d-1" }).remove(["zone"]),
        )
        expect(wire.removes.has("gsi1sk")).toBe(true)
        expect(wire.removes.has("gsi2sk")).toBe(true)
        expect(wire.sets.gsi3sk?.S).toBe("$mixed#v1#mixeddevice#deviceid_d-1")
        expect(wire.sets.gsi4pk?.S).toBe("$mixed#v1#mixeddevice#channel_c-1")
      }),
    )
  })

  describe("the retain path", () => {
    const retained = (zone?: string) => {
      const capture: Capture = {}
      const stored = mixedStored("MixedRetained", zone)
      return Effect.gen(function* () {
        const db = yield* mixedClient
        yield* db.entities.MixedRetained.update({ channel: "c-1", deviceId: "d-1" }).set({
          status: "on",
        })
        const tx = capture.transactWriteItems as {
          TransactItems: Array<{ Update?: Parameters<typeof wireOf>[0] }>
        }
        return wireOf(tx.TransactItems.find((item) => item.Update !== undefined)!.Update!)
      }).pipe(Effect.provide(mixedLayer(capture, stored)), Effect.scoped)
    }

    it.effect("an item lacking the mutable composite gets no such half", () =>
      Effect.gen(function* () {
        const wire = yield* retained()
        for (const half of MIXED_HALVES) expect(wire.sets, half).not.toHaveProperty(half)
      }),
    )

    it.effect("an item holding it recomposes the key it already has: idempotent", () =>
      Effect.gen(function* () {
        const wire = yield* retained("z")
        expect(wire.sets.gsi1sk?.S).toBe("$mixed#v1#mixedretained#zone_z#deviceid_d-1")
        expect(wire.sets.gsi3sk?.S).toBe("$mixed#v1#mixedretained#deviceid_d-1#zone_z")
        expect(wire.sets.gsi4pk?.S).toBe("$mixed#v1#mixedretained#channel_c-1#zone_z")
        expect(wire.removes.size).toBe(0)
      }),
    )
  })

  describe("the append path", () => {
    const at = DateTime.makeUnsafe("2026-04-30T11:00:00.000Z")

    it.effect("appendInput repeating the primary key claims no mixed half", () => {
      const capture: Capture = {}
      return Effect.gen(function* () {
        const db = yield* mixedClient
        yield* db.entities.MixedSeries.append({
          channel: "c-1",
          deviceId: "d-1",
          at,
          status: "on",
        }).skipFollowUp()
        const tx = capture.transactWriteItems as {
          TransactItems: Array<{ Update?: Parameters<typeof wireOf>[0] }>
        }
        const wire = wireOf(tx.TransactItems[0]!.Update!)
        expectUntouched(wire)
        // Wholly primary halves still compose (#43).
        expect(wire.sets.gsi1pk?.S).toBe("$mixed#v1#mixedseries#channel_c-1")
        expect(wire.sets.gsi4sk?.S).toBe("$mixed#v1#mixedseries#deviceid_d-1")
      }).pipe(Effect.provide(mixedLayer(capture, mixedStored("MixedSeries"))), Effect.scoped)
    })

    it.effect("an appendInput carrying the mutable composite composes them", () => {
      const capture: Capture = {}
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { MixedSeriesWithZone },
          tables: { MixedZoneTable },
        })
        yield* db.entities.MixedSeriesWithZone.append({
          channel: "c-1",
          deviceId: "d-1",
          at,
          zone: "z",
        }).skipFollowUp()
        const tx = capture.transactWriteItems as {
          TransactItems: Array<{ Update?: Parameters<typeof wireOf>[0] }>
        }
        const wire = wireOf(tx.TransactItems[0]!.Update!)
        expect(wire.sets.gsi1sk?.S).toBe("$mixed#v1#mixedseries#zone_z#deviceid_d-1")
        expect(wire.sets.gsi3sk?.S).toBe("$mixed#v1#mixedseries#deviceid_d-1#zone_z")
        expect(wire.sets.gsi4pk?.S).toBe("$mixed#v1#mixedseries#channel_c-1#zone_z")
      }).pipe(Effect.provide(mixedLayer(capture, mixedStored("MixedSeries"))), Effect.scoped)
    })
  })
})
