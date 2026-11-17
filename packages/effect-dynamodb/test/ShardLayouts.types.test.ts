/**
 * `ShardLayouts.of` types (#287, design §10.3): it takes exactly the indexes an entity declares
 * `shards: { layouts: "provided" }`, every one of them, and each table's `match` names exactly
 * that index's partition key composites. A decoded `ShardLayouts.Table` and a `Config` of a
 * table are accepted as they are. Compiled by `pnpm check`; the runtime checks behind each
 * refusal are exercised here too.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as SchemaEntity from "@effect-dynamodb/schema/Entity.js"
import * as ShardLayouts from "@effect-dynamodb/schema/ShardLayouts.js"
import { Config, Schema } from "effect"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

class Device extends Schema.Class<Device>("Device")({
  tenantId: Schema.String,
  regionId: Schema.String,
  deviceId: Schema.String,
  groupId: Schema.String,
}) {}

const definition = {
  model: Device,
  entityType: "Device",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId", "regionId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      shards: { layouts: "provided" },
    },
    byGroup: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["groupId"] },
      sk: { field: "gsi2sk", composite: ["deviceId"] },
      shards: { layouts: "provided" },
    },
    static: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["tenantId"] },
      sk: { field: "gsi3sk", composite: ["deviceId"] },
      shards: 4,
    },
  },
} as const

const Devices = Entity.make(definition)
const PureDevices = SchemaEntity.make(definition)
Table.make({
  schema: DynamoSchema.make({ name: "types", version: 1 }),
  entities: { Devices, PureDevices },
})

const tenant = { default: 1, values: [{ match: { tenantId: "t", regionId: "r" }, layout: 8 }] }
const group = { default: { count: 4, previous: 1 } }

describe("ShardLayouts.of types", () => {
  it("accepts a table for every provided index, from a runtime or a pure entity", () => {
    const registry = ShardLayouts.make([
      ShardLayouts.of(Devices, { byTenant: tenant, byGroup: group }),
    ])
    expect(registry.tables.size).toBe(2)
    expect(
      ShardLayouts.make([ShardLayouts.of(PureDevices, { byTenant: tenant, byGroup: group })]).tables
        .size,
    ).toBe(2)
  })

  it("accepts a decoded table and a Config of either", () => {
    const decoded = Schema.decodeUnknownSync(ShardLayouts.Table)({ default: 1 })
    ShardLayouts.of(Devices, {
      byTenant: decoded,
      byGroup: Config.succeed(group),
    })
    ShardLayouts.of(Devices, {
      byTenant: Config.schema(Schema.fromJsonString(ShardLayouts.Table), "DEVICE_SHARDS"),
      byGroup: group,
    })
  })

  it("refuses an index not declared provided", () => {
    expect(() =>
      ShardLayouts.make([
        ShardLayouts.of(Devices, {
          byTenant: tenant,
          byGroup: group,
          // @ts-expect-error `static` declares a count, not `layouts: "provided"`
          static: group,
        }),
      ]),
    ).toThrow("[EDD-9182]")
  })

  it("refuses an unknown index", () => {
    expect(() =>
      ShardLayouts.make([
        ShardLayouts.of(Devices, {
          byTenant: tenant,
          byGroup: group,
          // @ts-expect-error no such index
          byTenantt: group,
        }),
      ]),
    ).toThrow("[EDD-9182]")
  })

  it("requires every provided index", () => {
    expect(() =>
      // @ts-expect-error byGroup is provided and left out
      ShardLayouts.make([ShardLayouts.of(Devices, { byTenant: tenant })]),
    ).toThrow("[EDD-9182]")
  })

  it("a match names exactly the partition key composites", () => {
    expect(() =>
      ShardLayouts.make([
        ShardLayouts.of(Devices, {
          byTenant: {
            default: 1,
            values: [
              {
                match: {
                  tenantId: "t",
                  regionId: "r",
                  // @ts-expect-error a typo beside the right names
                  regionID: "r",
                },
                layout: 8,
              },
            ],
          },
          byGroup: group,
        }),
      ]),
    ).toThrow("[EDD-9099]")
    expect(() =>
      ShardLayouts.make([
        ShardLayouts.of(Devices, {
          byTenant: {
            default: 1,
            // @ts-expect-error regionId is a partition key composite, left out
            values: [{ match: { tenantId: "t" }, layout: 8 }],
          },
          byGroup: group,
        }),
      ]),
    ).toThrow("[EDD-9099]")
    expect(() =>
      ShardLayouts.make([
        ShardLayouts.of(Devices, {
          byTenant: tenant,
          byGroup: {
            default: 1,
            values: [
              {
                // @ts-expect-error tenantId is another index's composite
                match: { groupId: "g", tenantId: "t" },
                layout: 8,
              },
            ],
          },
        }),
      ]),
    ).toThrow("[EDD-9099]")
  })

  it("a match value is the model field's type", () => {
    expect(() =>
      ShardLayouts.make([
        ShardLayouts.of(Devices, {
          byTenant: {
            default: 1,
            values: [
              // @ts-expect-error tenantId is a string: 123 composes another key than "123"
              { match: { tenantId: 123, regionId: "r" }, layout: 8 },
            ],
          },
          byGroup: group,
        }),
      ]),
    ).toThrow(/\[EDD-9099\].*tenantId.*string/)
    // A decoded table's values are known only at run time: refused when the layer builds.
    const decoded = Schema.decodeUnknownSync(ShardLayouts.Table)({
      default: 1,
      values: [{ match: { tenantId: 123, regionId: "r" }, layout: 8 }],
    })
    expect(() =>
      ShardLayouts.make([ShardLayouts.of(Devices, { byTenant: decoded, byGroup: group })]),
    ).toThrow(/\[EDD-9099\].*tenantId.*string/)
  })
})
