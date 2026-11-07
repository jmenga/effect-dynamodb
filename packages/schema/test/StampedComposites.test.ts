/**
 * What `Entity.make` says of keys over values the library stamps (`DESIGN.md` §7, "Composites the
 * library stamps"): `EDD-9121` for a value no key can follow, `EDD-9122` for a version attribute
 * renamed, the rest allowed. The writes themselves are `helpers/StampedComposites.ts` in
 * `effect-dynamodb`.
 */

import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"

const Model = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  price: Schema.optional(Schema.Number),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  version: Schema.Number,
  rev: Schema.Number,
})

const primary = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}

const make = (config: Record<string, unknown>) => () =>
  Entity.make({ model: Model, entityType: "E", primaryKey: primary, ...config } as never)

const over = (composite: ReadonlyArray<string>, extra: Record<string, unknown> = {}) => ({
  byOwner: {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["owner"] },
    sk: { field: "gsi1sk", composite },
    ...extra,
  },
})

describe("EDD-9121, a key over a value the library changes on every write", () => {
  it("`version` in an index without `retain`: no write knows the next value", () => {
    expect(make({ versioned: true, indexes: over(["version"]) })).toThrow(/EDD-9121.*"version"/)
    expect(make({ versioned: true, indexes: over(["owner", "version"]) })).toThrow(/EDD-9121/)
    expect(
      make({
        versioned: true,
        indexes: {
          byVersion: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["version"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      }),
    ).toThrow(/EDD-9121/)
    // The message says why and what to do.
    expect(make({ versioned: true, indexes: over(["version"]) })).toThrow(/retain: true/)
  })

  it("the attribute `versioned` names, whatever it's called", () => {
    expect(make({ versioned: { field: "rev" }, indexes: over(["rev"]) })).toThrow(/EDD-9121.*"rev"/)
    // Then `version` is an ordinary field of the model's.
    expect(make({ versioned: { field: "rev" }, indexes: over(["version"]) })).not.toThrow()
    // And without `versioned`, so is it.
    expect(make({ indexes: over(["version"]) })).not.toThrow()
  })

  it("a Z-order dimension or prefix holding `version`", () => {
    const zorder = (sk: Record<string, unknown>) => ({
      search: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["owner"] },
        sk: { field: "gsi1sk", ...sk },
      },
    })
    expect(
      make({
        versioned: true,
        indexes: zorder({ zorder: [{ field: "version", min: 0, max: 1000 }] }),
      }),
    ).toThrow(/EDD-9121/)
    expect(
      make({
        versioned: true,
        indexes: zorder({
          prefix: ["version"],
          zorder: [{ field: "price", min: 0, max: 1000 }],
        }),
      }),
    ).toThrow(/EDD-9121/)
  })

  it("`retain` reads the item on every write, so the value is known", () => {
    expect(make({ versioned: { retain: true }, indexes: over(["version"]) })).not.toThrow()
    // `retain: false` doesn't.
    expect(make({ versioned: { retain: false }, indexes: over(["version"]) })).toThrow(/EDD-9121/)
  })

  it("a primary key over either: a primary key never changes, whatever `retain` says", () => {
    const sortedBy = (composite: ReadonlyArray<string>) => ({
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite },
    })
    expect(make({ versioned: true, primaryKey: sortedBy(["version"]) })).toThrow(/EDD-9121/)
    expect(make({ versioned: { retain: true }, primaryKey: sortedBy(["version"]) })).toThrow(
      /EDD-9121/,
    )
    expect(make({ timestamps: true, primaryKey: sortedBy(["updatedAt"]) })).toThrow(/EDD-9121/)
    expect(
      make({
        timestamps: { updated: "changed" },
        primaryKey: sortedBy(["changed"]),
        model: Schema.Struct({
          id: Schema.String,
          changed: Schema.DateTimeUtc,
        }),
      }),
    ).toThrow(/EDD-9121.*"changed"/)
    expect(
      make({
        versioned: true,
        primaryKey: {
          pk: { field: "pk", composite: ["version"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    ).toThrow(/EDD-9121/)
  })

  it("`shards.by` over either: the shard would go stale on every write", () => {
    expect(
      make({
        timestamps: true,
        indexes: over(["id"], { shards: { count: 4, by: ["updatedAt"] } }),
      }),
    ).toThrow(/EDD-9121.*shards\.by/)
    expect(
      make({
        versioned: { retain: true },
        indexes: over(["id"], { shards: { count: 4, by: ["version"] } }),
      }),
    ).toThrow(/EDD-9121.*shards\.by/)
  })

  it("`createdAt` never changes, and `updatedAt` in an index moves with the update", () => {
    const sortedBy = {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: ["createdAt"] },
    }
    expect(make({ timestamps: true, primaryKey: sortedBy })).not.toThrow()
    expect(make({ timestamps: true, indexes: over(["createdAt"]) })).not.toThrow()
    expect(make({ timestamps: true, indexes: over(["updatedAt"]) })).not.toThrow()
    expect(make({ timestamps: true, indexes: over(["owner", "updatedAt"]) })).not.toThrow()
    expect(
      make({
        timestamps: true,
        indexes: over(["createdAt"], { shards: { count: 4, by: ["createdAt"] } }),
      }),
    ).not.toThrow()
  })

  it("an `updatedAt` the library doesn't manage is any other field", () => {
    const sortedBy = {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: ["updatedAt"] },
    }
    // No timestamps.
    expect(make({ primaryKey: sortedBy })).not.toThrow()
    // A non-date is the caller's.
    expect(
      make({
        timestamps: true,
        primaryKey: sortedBy,
        model: Schema.Struct({ id: Schema.String, updatedAt: Schema.String }),
      }),
    ).not.toThrow()
    // A time series' `orderBy` is its clock, so it doesn't stamp one.
    expect(
      make({
        timestamps: true,
        primaryKey: sortedBy,
        timeSeries: {
          orderBy: "at",
          appendInput: Schema.Struct({
            id: Schema.String,
            updatedAt: Schema.DateTimeUtc,
            at: Schema.Number,
          }),
        },
        model: Schema.Struct({
          id: Schema.String,
          updatedAt: Schema.DateTimeUtc,
          at: Schema.Number,
        }),
      }),
    ).not.toThrow()
  })
})

describe("EDD-9122, a renamed version attribute", () => {
  const renamed = (attribute: string) =>
    DynamoModel.configure(Model, { [attribute]: { field: "ver" } } as never)

  it("refuses a `field:` rename of the attribute `versioned` keeps it in", () => {
    expect(make({ model: renamed("version"), versioned: true })).toThrow(/EDD-9122.*"version"/)
    expect(make({ model: renamed("version"), versioned: { retain: true } })).toThrow(/EDD-9122/)
    expect(make({ model: renamed("rev"), versioned: { field: "rev" } })).toThrow(/EDD-9122.*"rev"/)
    expect(make({ model: renamed("version"), versioned: true })).toThrow(/versioned: \{ field/)
  })

  it("anything else of that name, or any other rename, is fine", () => {
    expect(make({ model: renamed("version") })).not.toThrow()
    expect(make({ model: renamed("version"), versioned: { field: "rev" } })).not.toThrow()
    expect(make({ model: renamed("createdAt"), timestamps: true })).not.toThrow()
    expect(make({ model: renamed("updatedAt"), timestamps: true })).not.toThrow()
    expect(
      make({
        versioned: true,
        model: DynamoModel.configure(Model, { version: { immutable: false } } as never),
      }),
    ).not.toThrow()
  })
})
