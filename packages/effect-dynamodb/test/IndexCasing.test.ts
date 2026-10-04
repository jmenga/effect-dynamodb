/**
 * Index-level `casing` — an index's own `casing` overrides the schema's for
 * that index's keys, on every path that composes them: put, the query
 * accessors (PK, `begins_with`, `.where()` operands), policy-aware updates and
 * collection queries. Collection members must agree on it (EDD-9055).
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Collection from "../src/Collection.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

const AppSchema = DynamoSchema.make({ name: "App", version: 1 })

class Device extends Schema.Class<Device>("Device")({
  deviceId: Schema.String,
  ownerId: Schema.String,
  serial: Schema.String,
  site: Schema.String,
}) {}

const devicesWith = (casing: DynamoSchema.Casing | undefined) =>
  Entity.make({
    model: Device,
    entityType: "Device",
    primaryKey: {
      pk: { field: "pk", composite: ["deviceId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byOwner: {
        name: "gsi1",
        casing: "preserve",
        pk: { field: "gsi1pk", composite: ["ownerId"] },
        sk: { field: "gsi1sk", composite: ["serial", "deviceId"] },
      },
      bySite: {
        name: "gsi2",
        collection: "Fleet",
        ...(casing !== undefined ? { casing } : {}),
        pk: { field: "gsi2pk", composite: ["site"] },
        sk: { field: "gsi2sk", composite: ["deviceId"] },
      },
    },
  })

const Devices = devicesWith("preserve")

class Gateway extends Schema.Class<Gateway>("Gateway")({
  gatewayId: Schema.String,
  site: Schema.String,
}) {}

const gatewaysWith = (casing: DynamoSchema.Casing | undefined) =>
  Entity.make({
    model: Gateway,
    entityType: "Gateway",
    primaryKey: {
      pk: { field: "pk", composite: ["gatewayId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      bySite: {
        name: "gsi2",
        collection: "Fleet",
        ...(casing !== undefined ? { casing } : {}),
        pk: { field: "gsi2pk", composite: ["site"] },
        sk: { field: "gsi2sk", composite: ["gatewayId"] },
      },
    },
  })

const Gateways = gatewaysWith("preserve")
const AppTable = Table.make({ schema: AppSchema, entities: { Devices, Gateways } })

const mockPutItem = vi.fn()
const mockQuery = vi.fn()
const mockUpdateItem = vi.fn()

const ClientLayer = mockDynamoClientLayer({
  // No stored item: a versioned / unique put reads first (#133).
  getItem: () => Effect.succeed({} as any),
  putItem: (input) => Effect.sync(() => mockPutItem(input) ?? {}),
  query: (input) => Effect.sync(() => mockQuery(input) ?? { Items: [] }),
  updateItem: (input) => Effect.sync(() => mockUpdateItem(input)),
})
const TestLayer = Layer.merge(ClientLayer, AppTable.layer({ name: "app-table" }))

const device = { deviceId: "Dev-1", ownerId: "Own-A", serial: "SN-9", site: "Site-X" }

beforeEach(() => {
  vi.resetAllMocks()
})

describe("index-level casing", () => {
  it.effect("put composes the index's keys with its casing; other keys keep the schema's", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Devices }, tables: { AppTable } })
      yield* db.entities.Devices.put(device)

      const item = fromAttributeMap(mockPutItem.mock.calls[0]![0].Item)
      expect(item.pk).toBe("$app#v1#device#deviceid_dev-1")
      expect(item.gsi1pk).toBe("$app#v1#Device#ownerId_Own-A")
      expect(item.gsi1sk).toBe("$app#v1#Device#serial_SN-9#deviceId_Dev-1")
      expect(item.gsi2pk).toBe("$app#v1#Fleet#site_Site-X")
      expect(item.gsi2sk).toBe("$app#v1#Device_1#deviceId_Dev-1")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("query accessors compose the PK, begins_with and .where() operands with it", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Devices }, tables: { AppTable } })

      yield* db.entities.Devices.byOwner({ ownerId: "Own-A", serial: "SN-9" }).collect()
      const partial = mockQuery.mock.calls[0]![0]
      expect(partial.ExpressionAttributeValues[":pk"].S).toBe("$app#v1#Device#ownerId_Own-A")
      expect(Object.values(partial.ExpressionAttributeValues).map((v: any) => v.S)).toContain(
        "$app#v1#Device#serial_SN-9#",
      )

      yield* db.entities.Devices.byOwner({ ownerId: "Own-A" })
        .where((t, { eq }) => eq(t.serial, "SN-9"))
        .collect()
      const where = mockQuery.mock.calls[1]![0]
      expect(Object.values(where.ExpressionAttributeValues).map((v: any) => v.S)).toContain(
        "$app#v1#Device#serial_SN-9#",
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("update recomposes the index's keys with its casing", () =>
    Effect.gen(function* () {
      mockUpdateItem.mockReturnValue({
        Attributes: toAttributeMap({ ...device, ownerId: "Own-B" }),
      })
      const db = yield* DynamoClient.make({ entities: { Devices }, tables: { AppTable } })

      yield* db.entities.Devices.update({ deviceId: "Dev-1" }).set({
        ownerId: "Own-B",
        serial: "SN-9",
      })

      const values = Object.values(
        fromAttributeMap(mockUpdateItem.mock.calls[0]![0].ExpressionAttributeValues),
      )
      expect(values).toContain("$app#v1#Device#ownerId_Own-B")
      expect(values).toContain("$app#v1#Device#serial_SN-9#deviceId_Dev-1")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an auto-discovered collection queries with its members' casing", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Devices, Gateways },
        tables: { AppTable },
      })
      yield* db.collections.Fleet!({ site: "Site-X" }).collect()
      expect(mockQuery.mock.calls[0]![0].ExpressionAttributeValues[":pk"].S).toBe(
        "$app#v1#Fleet#site_Site-X",
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  describe("collection members must agree on casing (EDD-9055)", () => {
    // Own entities and schema: registering an entity on a table binds it there.
    const MixedSchema = DynamoSchema.make({ name: "Mixed", version: 1 })
    const MixedDevices = devicesWith("preserve")
    const LowerGateways = gatewaysWith(undefined)
    const MixedTable = Table.make({
      schema: MixedSchema,
      entities: { MixedDevices, LowerGateways },
    })

    it.effect("DynamoClient.make rejects members with different casings", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          DynamoClient.make({
            entities: { MixedDevices, LowerGateways },
            tables: { MixedTable },
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("[EDD-9055]")
          expect(Cause.pretty(exit.cause)).toContain(
            "MixedDevices: preserve, LowerGateways: lowercase",
          )
        }
      }).pipe(Effect.provide(Layer.merge(ClientLayer, MixedTable.layer({ name: "mixed" })))),
    )

    it("Collection.make rejects members with different casings", () => {
      expect(() => Collection.make("Fleet", { MixedDevices, LowerGateways })).toThrow("[EDD-9055]")
    })

    it("an index casing equal to the schema's agrees with an index that has none", () => {
      const ExplicitLower = gatewaysWith("lowercase")
      const Implicit = devicesWith(undefined)
      Table.make({
        schema: DynamoSchema.make({ name: "Agree", version: 1 }),
        entities: { ExplicitLower, Implicit },
      })
      expect(() => Collection.make("Fleet", { ExplicitLower, Implicit })).not.toThrow()
    })
  })
})
