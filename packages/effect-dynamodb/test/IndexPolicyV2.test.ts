/**
 * Entity-level integration tests for indexPolicy v2 semantics (refs #36).
 *
 * Covers the wiring through `Entity.update` (standard updateItem path) and
 * `Entity.update` retain path. KeyComposer-level unit tests live alongside
 * `KeyComposer.test.ts`; this file proves the semantics make it through the
 * Entity layer to the wire (UpdateExpression / TransactItems).
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
import { CompositeKeyHoleError } from "../src/Errors.js"
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
        gsi1pk: { S: "$app#v1#asset#americas" } as AttributeValue,
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
    // Return a minimal item that decodes as either Asset or Page (whichever
    // entity issued the update). Both share `pageId`/`assetId` keys; we
    // include both so a single mock works for both fixtures.
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
      indexPolicy: () => ({
        region: "preserve" as const,
        country: "preserve" as const,
        city: "preserve" as const,
        site: "preserve" as const,
      }),
    },
  },
  timestamps: true,
  versioned: { retain: true },
})

const AppTable = Table.make({ schema: AppSchema, entities: { Assets } })

const TableLayer = AppTable.layer({ name: "app-table" })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Entity update — indexPolicy v2 wiring", () => {
  it.effect("explicit clear of trailing SK composite truncates gsi1sk on retain path", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Assets },
        tables: { AppTable },
      })
      // Asset leaves the datacenter — clear `site`.
      yield* db.entities.Assets.update({ assetId: "a-1" }).set({ site: null })

      // Retain path uses transactWriteItems.
      const tx = capture.transactWriteItems
      expect(tx).toBeDefined()
      const items = (tx as { TransactItems?: Array<unknown> }).TransactItems
      expect(items?.length).toBeGreaterThan(0)
      const mainPut = items?.[0] as { Put?: { Item?: Record<string, AttributeValue> } }
      const item = mainPut.Put?.Item
      expect(item).toBeDefined()
      // SK truncated at site (position 2): leading prefix [country, city] →
      // "$app#v1#asset#country_us#city_sf"
      expect(item!.gsi1sk).toEqual({ S: "$app#v1#asset#country_us#city_sf" })
      // PK side is unchanged (region still present from stored value).
      expect(item!.gsi1pk).toEqual({ S: "$app#v1#asset#region_americas" })
      // The site attribute itself: cleared by user via null. It writes NULL.
      // (Not the focus of this test, just noting it.)
    }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
  })

  it.effect("explicit clear of multiple trailing SK composites truncates further", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Assets },
        tables: { AppTable },
      })
      yield* db.entities.Assets.update({ assetId: "a-1" }).set({ city: null, site: null })
      const tx = capture.transactWriteItems
      const item = (
        tx as { TransactItems: Array<{ Put: { Item: Record<string, AttributeValue> } }> }
      ).TransactItems[0]!.Put.Item
      expect(item.gsi1sk).toEqual({ S: "$app#v1#asset#country_us" })
      expect(item.gsi1pk).toEqual({ S: "$app#v1#asset#region_americas" })
    }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
  })

  it.effect("explicit Entity.remove cascade still drops the GSI fully", () => {
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
      // Both GSI key fields should be absent from the Put item (full drop).
      expect(item.gsi1pk).toBeUndefined()
      expect(item.gsi1sk).toBeUndefined()
    }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
  })

  it.effect("hole pattern surfaces as CompositeKeyHoleError", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Assets },
        tables: { AppTable },
      })
      // Clear `city` while setting `site` → hole at position 1 with present at 2.
      const error = yield* db.entities.Assets.update({ assetId: "a-1" })
        .set({ city: null, site: "datacenter-2" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(CompositeKeyHoleError)
      const e = error as CompositeKeyHoleError
      expect(e.indexName).toBe("gsi1")
      expect(e.clearedComposite).toBe("city")
      expect(e.trailingComposite).toBe("site")
    }).pipe(Effect.provide(Layer.mergeAll(makeLayer(capture), TableLayer)), Effect.scoped)
  })
})

// ---------------------------------------------------------------------------
// Reproducer scenario from issue #36
// ---------------------------------------------------------------------------

class Page extends Schema.Class<Page>("Page")({
  pageId: Schema.String,
  // Three "enrichment-owned" attrs that the consumer does not always touch.
  X: Schema.optional(Schema.String),
  Y: Schema.optional(Schema.String),
  Z: Schema.optional(Schema.String),
  // The thing the consumer touches in the partial update.
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
      // Pre-1.6 the consumer set this to "sparse" thinking it would mean
      // "drop on actual absence"; instead it dropped on every partial
      // update that did not mention X. Switching to "preserve" under v2 is
      // the canonical fix.
      indexPolicy: () => ({ X: "preserve" as const }),
    },
    gB: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["Y"] },
      sk: { field: "gsi2sk", composite: ["pageId"] },
      indexPolicy: () => ({ Y: "preserve" as const }),
    },
    gC: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["Z"] },
      sk: { field: "gsi3sk", composite: ["pageId"] },
      indexPolicy: () => ({ Z: "preserve" as const }),
    },
  },
})

const PagesTable = Table.make({ schema: AppSchema, entities: { Pages } })
const PagesTableLayer = PagesTable.layer({ name: "pages-table" })

// Standard-path mock (no retain — uses updateItem).
const makePagesMock = (capture: Capture) => ({
  ...makeMockClient(capture),
  // No retain on Pages, so getItem isn't called. Only updateItem matters.
  getItem: () => Effect.die("getItem not expected on standard path"),
})

describe("Entity update — issue #36 footgun reproducer", () => {
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
        // Update only `name` — never mentions X, Y, Z. Pre-1.6 with
        // sparse-policied X/Y/Z, this generated REMOVE gsi1pk/sk + gsi2pk/sk
        // + gsi3pk/sk (six unwanted REMOVEs). v2 with preserve policy
        // generates none.
        yield* db.entities.Pages.update({ pageId: "p-1" }).set({ name: "new-name" })
        const ui = capture.updateItem as {
          UpdateExpression?: string
          ExpressionAttributeNames?: Record<string, string>
        }
        expect(ui.UpdateExpression).toBeDefined()
        // No REMOVE clause should mention gsiNpk/gsiNsk.
        const expr = ui.UpdateExpression!
        const removeClause = expr.match(/REMOVE\s+([^A-Z]*)/i)?.[1] ?? ""
        // Translate alias names back to physical names via EAN.
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
