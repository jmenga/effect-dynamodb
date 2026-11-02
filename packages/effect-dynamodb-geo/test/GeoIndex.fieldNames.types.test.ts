/**
 * `GeoIndex.make` names the entity's index and model fields: typed from the
 * entity, so a misspelled index, geo field or timestamp source is a compile
 * error. The runtime check on the index stays for untyped callers.
 */
import { Schema } from "effect"
import { DynamoSchema, Entity, Table } from "effect-dynamodb"
import { describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"

class Vehicle extends Schema.Class<Vehicle>("Vehicle")({
  vehicleId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
}) {}

const Vehicles = Entity.make({
  model: Vehicle,
  entityType: "Vehicle",
  primaryKey: {
    pk: { field: "pk", composite: ["vehicleId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCell: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "timePartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
  },
})

Table.make({ schema: DynamoSchema.make({ name: "geo-types", version: 1 }), entities: { Vehicles } })

const coordinates = (item: {
  readonly latitude?: number | undefined
  readonly longitude?: number | undefined
}) =>
  item.latitude !== undefined && item.longitude !== undefined
    ? { latitude: item.latitude, longitude: item.longitude }
    : undefined

describe("GeoIndex.make names are typed from the entity", () => {
  it("accepts the entity's index and model fields", () => {
    const geo = GeoIndex.make({
      entity: Vehicles,
      index: "byCell",
      coordinates,
      fields: {
        cell: { field: "cell", resolution: 15 },
        parentCell: { field: "parentCell", resolution: 3 },
        timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
      },
    })
    expect(typeof geo.nearby).toBe("function")
  })

  it("refuses a misspelled index, field or source", () => {
    expect(() =>
      GeoIndex.make({
        entity: Vehicles,
        // @ts-expect-error not an index of the entity
        index: "byCel",
        coordinates,
        fields: {
          cell: { field: "cell", resolution: 15 },
          parentCell: { field: "parentCell", resolution: 3 },
          timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
        },
      }),
    ).toThrow('index "byCel" not found')
    const typeOnly = (_: () => unknown) => undefined
    typeOnly(() =>
      GeoIndex.make({
        entity: Vehicles,
        index: "byCell",
        coordinates,
        fields: {
          // @ts-expect-error not a model field
          cell: { field: "cel", resolution: 15 },
          parentCell: { field: "parentCell", resolution: 3 },
          // @ts-expect-error not a model field
          timePartition: { field: "timePartition", source: "timestamps", bucket: "hourly" },
        },
      }),
    )
  })
})
