/**
 * The `ShardLayouts` module (#287, design §10): the `Table` schema checks a table's shape and
 * ranges; `make` / `layer` compile each table against its entity, refusing a malformed one
 * (`EDD-9099`) or a misuse of `of` (`EDD-9182`); composition under a fiber holding the service
 * reads its table; without it, `EDD-9181`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as KeyComposer from "../src/KeyComposer.js"
import * as ShardLayouts from "../src/ShardLayouts.js"

class Device extends Schema.Class<Device>("Device")({
  tenantId: Schema.String,
  deviceId: Schema.String,
}) {}

const Devices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      shards: { layouts: "provided" },
    },
  },
})
const schema = DynamoSchema.make({ name: "app", version: 1 })
Devices._configure(schema, undefined as never)

const decode = Schema.decodeUnknownExit(ShardLayouts.Table)
const hot = { default: 1, values: [{ match: { tenantId: "T-BIG" }, layout: 8 }] }

describe("ShardLayouts.Table", () => {
  it("accepts tables a JSON variable holds", () => {
    for (const table of [
      { default: 1 },
      { default: 20, values: [] },
      { default: { count: 1, previous: 20 } },
      hot,
      { default: 1, values: [{ match: { tenantId: "a", n: 3, b: true }, layout: { count: 4 } }] },
    ]) {
      expect(decode(table)._tag).toBe("Success")
    }
  })

  it("refuses a bad shape or range", () => {
    for (const table of [
      {},
      { default: 0 },
      { default: 257 },
      { default: 1.5 },
      { default: "20" },
      { default: { count: 4, previous: 4 } },
      { default: { count: 4, previous: 0 } },
      { default: 1, values: [{ match: { tenantId: "a" } }] },
      { default: 1, values: [{ match: { tenantId: { nested: 1 } }, layout: 2 }] },
    ]) {
      expect(decode(table)._tag).toBe("Failure")
    }
  })

  it("refuses a key it doesn't declare, at every level", () => {
    // Stripped, a misspelt `previous` would leave a table read without it.
    for (const [table, key] of [
      [{ default: 1, defualt: 2 }, "defualt"],
      [{ default: { count: 8, previuos: 1 } }, "previuos"],
      [{ default: 1, values: [{ match: { tenantId: "a" }, layout: 2, layuot: 4 }] }, "layuot"],
      [
        { default: 1, values: [{ match: { tenantId: "a" }, layout: { count: 8, previuos: 1 } }] },
        "previuos",
      ],
    ] as const) {
      const exit = decode(table)
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain(key)
    }
  })
})

describe("ShardLayouts.make", () => {
  it("compiles each table against its entity and index", () => {
    const registry = ShardLayouts.make([ShardLayouts.of(Devices, { byTenant: hot })])
    const table = registry.tables.get(Devices.indexes.byTenant.shards!)!
    expect(table.default).toEqual({ count: 1, previous: undefined })
    expect(table.values[0]!.layout).toEqual({ count: 8, previous: undefined })
  })

  it("refuses two entries composing one key under the entity's casing (EDD-9099)", () => {
    expect(() =>
      ShardLayouts.make([
        ShardLayouts.of(Devices, {
          byTenant: {
            default: 1,
            values: [
              { match: { tenantId: "T-BIG" }, layout: 8 },
              { match: { tenantId: "t-big" }, layout: 4 },
            ],
          },
        }),
      ]),
    ).toThrow("[EDD-9099]")
  })
})

describe("composing under the service", () => {
  const index = Devices.indexes.byTenant
  const record = { tenantId: "t-big", deviceId: "d-1" }
  const compose = Effect.sync(() => KeyComposer.composePk(schema, "Device", index, record))

  it.effect("reads the table of the context it runs in", () =>
    Effect.gen(function* () {
      const pk = yield* compose
      expect(pk).toMatch(/#!8\.\d#tenantid_t-big$/)
    }).pipe(Effect.provide(ShardLayouts.layer([ShardLayouts.of(Devices, { byTenant: hot })]))),
  )

  it.effect("a value at 1 composes the unsharded key", () =>
    Effect.gen(function* () {
      const pk = yield* Effect.sync(() =>
        KeyComposer.composePk(schema, "Device", index, { ...record, tenantId: "t-small" }),
      )
      expect(pk).toBe("$app#v1#device#tenantid_t-small")
    }).pipe(Effect.provide(ShardLayouts.layer([ShardLayouts.of(Devices, { byTenant: hot })]))),
  )

  it.effect("without the service: EDD-9181, nothing falls back", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(compose)
      expect(String(exit)).toContain("[EDD-9181]")
    }),
  )

  it("outside a fiber: EDD-9181", () => {
    expect(() => KeyComposer.composePk(schema, "Device", index, record)).toThrow("[EDD-9181]")
  })

  it.effect("layerEffect's failure is the layer's", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Layer.build(ShardLayouts.layerEffect(Effect.fail("unreadable" as const))).pipe(
          Effect.scoped,
        ),
      )
      expect(String(exit)).toContain("unreadable")
    }),
  )
})
