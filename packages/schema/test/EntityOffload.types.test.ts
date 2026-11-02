/**
 * A sharded index's `shards.by` (#183) on an entity that offloads (#179): the
 * names are typed from the index's sort key composites as on any entity, so a
 * misspelled name is a compile error and the editor completes them. Naming an
 * `External` field there type-checks, as every other key position of an
 * offloaded field does, and `Entity.make` refuses it (`EDD-9142`): the shard
 * hash would read the stored pointer.
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"

class Scan extends Schema.Class<Scan>("Scan")({
  scanId: Schema.String,
  tenantId: Schema.String,
  label: Schema.String,
  image: Schema.Uint8Array,
}) {}

const model = DynamoModel.configure(Scan, { image: { storedAs: DynamoModel.External() } })

const primaryKey = {
  pk: { field: "pk", composite: ["scanId"] },
  sk: { field: "sk", composite: [] },
} as const

describe("shards.by on an offloading entity", () => {
  it("names a scalar sort key composite (positive)", () => {
    const Scans = Entity.make({
      model,
      entityType: "Scan",
      primaryKey,
      indexes: {
        byTenant: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["tenantId"] },
          sk: { field: "gsi1sk", composite: ["label"] },
          shards: { count: 4, by: ["label"] },
        },
      },
    })
    expect(Scans.indexes.byTenant.shards?.source).toEqual(["label"])
  })

  it("refuses a misspelled name at compile time (typo)", () => {
    expect(() =>
      Entity.make({
        model,
        entityType: "Scan",
        primaryKey,
        indexes: {
          byTenant: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: ["label"] },
            // @ts-expect-error — not a sort key composite of this index
            shards: { count: 4, by: ["labl"] },
          },
        },
      }),
    ).toThrow(/\[EDD-9102\]/)
  })

  it("refuses an External field at Entity.make, before its composite", () => {
    expect(() =>
      Entity.make({
        model,
        entityType: "Scan",
        primaryKey,
        indexes: {
          byTenant: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: ["label", "image"] },
            shards: { count: 4, by: ["image"] },
          },
        },
      }),
    ).toThrow(/\[EDD-9142\].*"image" cannot be a shards\.by source of index "byTenant"/)
  })
})
