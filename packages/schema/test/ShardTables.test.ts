/**
 * Per-value shard layouts (#287, `docs/designs/shard-layouts.md`): a sharded index's
 * table of layouts, looked up by the unsharded partition key text a value composes.
 *
 * Golden vectors: a value at 1 composes exactly the key an index without `shards`
 * composes, on every path; a value at N composes the `!N.s` key a static `shards: N`
 * composes. Rules stay per index: the update gate decides as on any sharded index.
 */

import { DateTime, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import {
  refuseSharedKeyAttribute,
  refuseSharedKeyAttributeOnEverySchema,
} from "../src/internal/SharedKeyAttribute.js"
import * as KeyComposer from "../src/KeyComposer.js"

const schema = DynamoSchema.make({ name: "fleet-db", version: 1 })
const escaped = DynamoSchema.make({ name: "fleet-db", version: 1, escapeKeys: true })
const preserve = DynamoSchema.make({ name: "fleet-db", version: 1, casing: "preserve" })
const uppercase = DynamoSchema.make({ name: "fleet-db", version: 1, casing: "uppercase" })

const plainIndex = (overrides: Partial<KeyComposer.IndexDefinition> = {}) =>
  ({
    index: "gsi5",
    pk: { field: "gsi5pk", composite: ["tenantId"] },
    sk: { field: "gsi5sk", composite: ["groupId", "deviceId"] },
    ...overrides,
  }) as KeyComposer.IndexDefinition

/** `def` sharded by `declared` (a table), bound with an identity key form. */
const tabled = (
  declared: unknown,
  options: {
    readonly by?: ReadonlyArray<string>
    readonly def?: KeyComposer.IndexDefinition
  } = {},
): KeyComposer.IndexDefinition => {
  const def = options.def ?? plainIndex()
  const table = KeyComposer.bindShardTable(
    def.index ?? "gsi5",
    def,
    KeyComposer.normalizeShardTable(def.index ?? "gsi5", declared),
    (record) => ({ ...record }),
  )
  return {
    ...def,
    shards: {
      count: table.default.count,
      previous: table.default.previous,
      by: options.by,
      source: options.by ?? ["channel", "deviceId"],
      layouts: table,
    },
  }
}

const staticIndex = (count: number, previous?: number, by?: ReadonlyArray<string>) => ({
  ...plainIndex(),
  shards: {
    count,
    previous,
    by,
    source: by ?? ["channel", "deviceId"],
  } satisfies KeyComposer.IndexShards,
})

const hot = { default: 1, values: [{ match: { tenantId: "t-big" }, layout: 20 }] }
const item = (tenantId: string) => ({ tenantId, groupId: "g", deviceId: "d", channel: "c" })

describe("golden vectors (design §4)", () => {
  const def = tabled(hot)
  const plain = plainIndex()
  const sharded20 = staticIndex(20)

  it("a value at 1 composes exactly the unsharded key, never !1.", () => {
    const pk = KeyComposer.composePk(schema, "DeviceState", def, item("t-small"))
    expect(pk).toBe(KeyComposer.composePk(schema, "DeviceState", plain, item("t-small")))
    expect(pk).toBe("$fleet-db#v1#devicestate#tenantid_t-small")
    expect(pk).not.toContain("!1.")
  })

  it("a value at N composes the !N.s key a static shards: N composes", () => {
    const pk = KeyComposer.composePk(schema, "DeviceState", def, item("t-big"))
    expect(pk).toBe(KeyComposer.composePk(schema, "DeviceState", sharded20, item("t-big")))
    expect(pk).toMatch(/^\$fleet-db#v1#devicestate#!20\.\d\d#tenantid_t-big$/)
  })

  it("every composer agrees: composeAllKeys, composeKnownHalves, composeIndexKeys", () => {
    const indexes = (gsi: KeyComposer.IndexDefinition) => ({
      primary: {
        pk: { field: "pk", composite: ["channel"] },
        sk: { field: "sk", composite: ["deviceId"] },
      },
      gsi,
    })
    for (const tenant of ["t-small", "t-big"]) {
      const reference = tenant === "t-big" ? sharded20 : plain
      expect(
        KeyComposer.composeAllKeys(schema, "DeviceState", 1, indexes(def), item(tenant)),
      ).toEqual(
        KeyComposer.composeAllKeys(schema, "DeviceState", 1, indexes(reference), item(tenant)),
      )
      expect(KeyComposer.composeKnownHalves(schema, "DeviceState", 1, def, item(tenant))).toEqual(
        KeyComposer.composeKnownHalves(schema, "DeviceState", 1, reference, item(tenant)),
      )
    }
  })

  it("the update gate's SET composes the value's layout", () => {
    const compose = (gsi: KeyComposer.IndexDefinition, tenant: string) =>
      KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "DeviceState",
        1,
        {
          primary: { pk: { field: "pk", composite: [] }, sk: { field: "sk", composite: [] } },
          gsi,
        },
        { tenantId: tenant },
        { channel: "c", deviceId: "d" },
      )
    expect(compose(def, "t-small").sets.gsi5pk).toBe(compose(plain, "t-small").sets.gsi5pk)
    expect(compose(def, "t-big").sets.gsi5pk).toBe(compose(sharded20, "t-big").sets.gsi5pk)
  })

  it("a truncated partition key takes the default: no entry composes truncated text", () => {
    const two = { pk: { field: "gsi5pk", composite: ["tenantId", "region"] } }
    const def2 = tabled(
      { default: 4, values: [{ match: { tenantId: "t-big", region: "eu" }, layout: 1 }] },
      { def: plainIndex(two) },
    )
    const truncated = KeyComposer.composeStoredPk(schema, "DeviceState", def2, {
      tenantId: "t-big",
      channel: "c",
      deviceId: "d",
    })
    expect(truncated).toMatch(/^\$fleet-db#v1#devicestate#!4\.\d#tenantid_t-big$/)
    // The value itself, whole, composes its own layout: 1.
    expect(
      KeyComposer.composePk(schema, "DeviceState", def2, {
        tenantId: "t-big",
        region: "eu",
        channel: "c",
        deviceId: "d",
      }),
    ).toBe("$fleet-db#v1#devicestate#tenantid_t-big#region_eu")
  })

  it("a missing shard source throws EDD-9100 at every count, 1 included (D4)", () => {
    expect(() =>
      KeyComposer.composePk(schema, "DeviceState", def, { tenantId: "t-small" }),
    ).toThrow("[EDD-9100]")
    expect(() => KeyComposer.composePk(schema, "DeviceState", def, { tenantId: "t-big" })).toThrow(
      "[EDD-9100]",
    )
    // A put without the source writes no entry, whatever the count.
    expect(
      KeyComposer.tryComposeIndexKeys(schema, "DeviceState", 1, tabled(hot, { by: ["groupId"] }), {
        tenantId: "t-small",
        deviceId: "d",
      }),
    ).toBeUndefined()
  })

  it("under escapeKeys too", () => {
    expect(KeyComposer.composePk(escaped, "DeviceState", def, item("t-small"))).toBe(
      KeyComposer.composePk(escaped, "DeviceState", plain, item("t-small")),
    )
    expect(KeyComposer.composePk(escaped, "DeviceState", def, item("t-big"))).toBe(
      KeyComposer.composePk(escaped, "DeviceState", sharded20, item("t-big")),
    )
  })
})

describe("composeReadPartitions per value (design §4, §6.1)", () => {
  const read = (declared: unknown, tenant: string, record: Record<string, unknown> = {}) =>
    KeyComposer.composeReadPartitions(schema, "DeviceState", tabled(declared), {
      tenantId: tenant,
      ...record,
    })
  const unsharded = (tenant: string) =>
    KeyComposer.composeReadPartitions(schema, "DeviceState", plainIndex(), { tenantId: tenant })
  const statically = (count: number, previous?: number) =>
    KeyComposer.composeReadPartitions(schema, "DeviceState", staticIndex(count, previous), {
      tenantId: "t-big",
    })

  it("a value at 1: one unsharded partition, no fan-out, the layout reported", () => {
    const at1 = read(hot, "t-small")
    expect(at1.partitions).toEqual(unsharded("t-small").partitions)
    expect(at1.fanOut).toBeUndefined()
    expect(at1.layout).toEqual({ count: 1, previous: undefined })
  })

  it("a value at 20: the fan-out a static shards: 20 reads", () => {
    const at20 = read(hot, "t-big")
    expect(at20.partitions).toEqual(statically(20).partitions)
    expect(at20.fanOut).toEqual(statically(20).fanOut)
    expect(at20.layout).toEqual({ count: 20, previous: undefined })
  })

  it("{ 20, previous: 1 }: the 20 shards, then the unsharded key", () => {
    const moving = read(
      {
        default: 1,
        values: [{ match: { tenantId: "t-big" }, layout: { count: 20, previous: 1 } }],
      },
      "t-big",
    )
    expect(moving.partitions).toEqual(statically(20, 1).partitions)
    expect(moving.partitions.at(-1)).toBe(unsharded("t-big").partitions[0])
    expect(moving.fanOut).toMatchObject({ count: 20, previous: 1 })
  })

  it("{ 1, previous: 20 }: the unsharded key, then the 20 shards", () => {
    const back = read(
      {
        default: 1,
        values: [{ match: { tenantId: "t-big" }, layout: { count: 1, previous: 20 } }],
      },
      "t-big",
    )
    expect(back.partitions).toEqual([
      unsharded("t-big").partitions[0],
      ...statically(20).partitions,
    ])
    expect(back.fanOut).toEqual({
      count: 1,
      source: ["channel", "deviceId"],
      previous: 20,
      pruned: false,
      everyPartition: undefined,
    })
  })

  it("pruning stays within the resolved count", () => {
    const def = tabled(hot, { by: ["groupId"] })
    const pinned = (tenant: string) =>
      KeyComposer.composeReadPartitions(schema, "DeviceState", def, {
        tenantId: tenant,
        groupId: "g",
      })
    expect(pinned("t-big").partitions).toHaveLength(1)
    expect(pinned("t-big").partitions[0]).toMatch(/#!20\.\d\d#/)
    expect(pinned("t-big").fanOut?.pruned).toBe(true)
    // At 1 there is nothing to prune: one partition, a plain query.
    expect(pinned("t-small").fanOut).toBeUndefined()
    expect(pinned("t-small").partitions).toEqual(unsharded("t-small").partitions)
  })

  it("the static { count: 1, previous: 20 } un-shards a whole index", () => {
    const back = KeyComposer.composeReadPartitions(schema, "DeviceState", staticIndex(1, 20), {
      tenantId: "t",
    })
    expect(back.partitions[0]).toBe(unsharded("t").partitions[0])
    expect(back.partitions).toHaveLength(21)
    expect(KeyComposer.composePk(schema, "DeviceState", staticIndex(1, 20), item("t"))).toBe(
      unsharded("t").partitions[0],
    )
  })

  it("mixed values in one index: two layouts, one index", () => {
    const two = {
      default: 4,
      values: [
        { match: { tenantId: "t-big" }, layout: 20 },
        { match: { tenantId: "t-cold" }, layout: 1 },
      ],
    }
    expect(read(two, "t-big").partitions).toHaveLength(20)
    expect(read(two, "t-cold").partitions).toEqual(unsharded("t-cold").partitions)
    expect(read(two, "t-other").partitions).toHaveLength(4)
  })
})

describe("lookup by unsharded key text (design §3)", () => {
  it("T-BIG and t-big are one value under lowercase and uppercase", () => {
    const def = tabled({ default: 1, values: [{ match: { tenantId: "T-BIG" }, layout: 20 }] })
    for (const s of [schema, uppercase]) {
      for (const spelling of ["T-BIG", "t-big", "T-big"]) {
        expect(
          KeyComposer.composeReadPartitions(s, "DeviceState", def, { tenantId: spelling }).layout,
        ).toEqual({ count: 20, previous: undefined })
      }
    }
  })

  it("two values under preserve: each spelling its own layout", () => {
    const def = tabled({
      default: 1,
      values: [
        { match: { tenantId: "T-BIG" }, layout: 20 },
        { match: { tenantId: "t-big" }, layout: 4 },
      ],
    })
    const layout = (tenant: string) =>
      KeyComposer.composeReadPartitions(preserve, "DeviceState", def, { tenantId: tenant }).layout
    expect(layout("T-BIG")?.count).toBe(20)
    expect(layout("t-big")?.count).toBe(4)
    expect(layout("T-big")?.count).toBe(1)
    // The same two entries are one key under lowercase: refused there.
    expect(() => KeyComposer.checkShardTables(schema, "DeviceState", { gsi: def })).toThrow(
      /\[EDD-9099\].*compose one key/,
    )
    expect(() => KeyComposer.checkShardTables(preserve, "DeviceState", { gsi: def })).not.toThrow()
  })

  it("the schema's casing spells its prefix: one table looked up under two schemas", () => {
    // The index's own casing leaves the schema name's casing to the schema.
    const def = tabled(hot, { def: plainIndex({ casing: "preserve" }) })
    const lower = DynamoSchema.make({ name: "Fleet", version: 1 })
    const upper = DynamoSchema.make({ name: "Fleet", version: 1, casing: "uppercase" })
    for (const s of [lower, upper, lower]) {
      expect(
        KeyComposer.composeReadPartitions(s, "DeviceState", def, { tenantId: "t-big" }).layout
          ?.count,
      ).toBe(20)
    }
  })

  it("a collection index looks up the collection's key", () => {
    const def = tabled(hot, { def: plainIndex({ collection: "fleet" }) })
    expect(KeyComposer.composePk(schema, "DeviceState", def, item("t-small"))).toBe(
      KeyComposer.composePk(schema, "Other", plainIndex({ collection: "fleet" }), item("t-small")),
    )
    expect(KeyComposer.composePk(schema, "DeviceState", def, item("t-big"))).toMatch(
      /^\$fleet-db#v1#fleet#!20\.\d\d#tenantid_t-big$/,
    )
  })

  describe("a match in domain form and in stored form is one entry", () => {
    class Reading extends Schema.Class<Reading>("Reading")({
      readingId: Schema.String,
      day: Schema.DateTimeUtcFromString,
      sensor: Schema.Number,
      value: Schema.Number,
    }) {}
    const make = (match: Record<string, unknown>) =>
      Entity.make({
        model: Reading,
        entityType: "Reading",
        primaryKey: {
          pk: { field: "pk", composite: ["readingId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byDay: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["day", "sensor"] },
            sk: { field: "gsi1sk", composite: ["readingId"] },
            shards: { layouts: { default: 1, values: [{ match: match as never, layout: 8 }] } },
          },
        },
      })
    const day = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")
    const stored = { readingId: "r", day: "2026-01-02T00:00:00.000Z", sensor: 7 }

    it.each([
      ["domain", { day, sensor: 7 }],
      ["stored", { day: "2026-01-02T00:00:00.000Z", sensor: 7 }],
    ])("%s form", (_name, match) => {
      const entity = make(match)
      const pk = KeyComposer.composePk(schema, "Reading", entity.indexes.byDay, stored)
      expect(pk).toMatch(/#!8\.\d#/)
    })

    it("both forms in one table compose one key: refused", () => {
      const both = Entity.make({
        model: Reading,
        entityType: "Reading",
        primaryKey: {
          pk: { field: "pk", composite: ["readingId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byDay: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["day", "sensor"] },
            sk: { field: "gsi1sk", composite: ["readingId"] },
            shards: {
              layouts: {
                default: 1,
                values: [
                  { match: { day, sensor: 7 }, layout: 8 },
                  { match: { day: "2026-01-02T00:00:00.000Z" as never, sensor: 7 }, layout: 4 },
                ],
              },
            },
          },
        },
      })
      expect(() => KeyComposer.checkShardTables(schema, "Reading", both.indexes)).toThrow(
        /\[EDD-9099\].*compose one key/,
      )
    })
  })
})

describe("isCurrentShardLayout against the resolved layout (design §9.2)", () => {
  const def = tabled(hot)
  const head = "$fleet-db#v1#devicestate"
  const holds = (stored: string, record?: Record<string, unknown>) =>
    KeyComposer.isCurrentShardLayout(schema, "DeviceState", def, stored, record)

  it("a value at 1: the unsharded text is current, a marker isn't", () => {
    const record = { tenantId: "t-small" }
    expect(holds(`${head}#tenantid_t-small`, record)).toBe(true)
    expect(holds(`${head}#!20.07#tenantid_t-small`, record)).toBe(false)
  })

  it("a value at 20: its marker is current, the unsharded text isn't", () => {
    const record = { tenantId: "t-big" }
    expect(holds(`${head}#!20.07#tenantid_t-big`, record)).toBe(true)
    expect(holds(`${head}#tenantid_t-big`, record)).toBe(false)
    expect(holds(`${head}#!4.1#tenantid_t-big`, record)).toBe(false)
  })

  it("a hole: the default's layout or an agreeing entry's (D34)", () => {
    const two = { pk: { field: "gsi5pk", composite: ["tenantId", "region"] } }
    const def2 = tabled(
      { default: 1, values: [{ match: { tenantId: "t-big", region: "eu" }, layout: 20 }] },
      { def: plainIndex(two) },
    )
    const holes = (stored: string, record: Record<string, unknown>) =>
      KeyComposer.isCurrentShardLayout(schema, "DeviceState", def2, stored, record)
    // `tenantId` gone under preserve, `region` held: t-big's entry agrees with `eu`.
    expect(holes(`${head}#!20.07#tenantid_t-big#region_eu`, { region: "eu" })).toBe(true)
    expect(holes(`${head}#tenantid_t-big#region_eu`, { region: "eu" })).toBe(true)
    // An entry that doesn't agree with what the row holds is no candidate.
    expect(holes(`${head}#!20.07#tenantid_x#region_us`, { region: "us" })).toBe(false)
  })

  it("without a record: the default's layout, today's test for a static declaration", () => {
    expect(holds(`${head}#tenantid_t-big`)).toBe(true)
    expect(holds(`${head}#!20.07#tenantid_t-big`)).toBe(false)
    expect(
      KeyComposer.isCurrentShardLayout(schema, "DeviceState", staticIndex(20), `${head}#!20.07#x`),
    ).toBe(true)
  })
})

describe("a provided table (design §2.4, D36)", () => {
  const def = {
    ...plainIndex(),
    shards: {
      count: 0,
      previous: undefined,
      by: undefined,
      source: ["channel", "deviceId"],
      layouts: "provided",
    } satisfies KeyComposer.IndexShards,
  }

  it("composing without a supplied table throws EDD-9181: nothing falls back", () => {
    expect(() => KeyComposer.composePk(schema, "DeviceState", def, item("t"))).toThrow("[EDD-9181]")
    expect(() =>
      KeyComposer.composeReadPartitions(schema, "DeviceState", def, { tenantId: "t" }),
    ).toThrow("[EDD-9181]")
    expect(() => KeyComposer.tryComposeIndexKeys(schema, "DeviceState", 1, def, item("t"))).toThrow(
      "[EDD-9181]",
    )
  })

  it("the schema an operation composes under carries it", () => {
    const table = KeyComposer.bindShardTable(
      "gsi5",
      def,
      KeyComposer.normalizeShardTable("gsi5", hot),
      (record) => ({ ...record }),
    )
    const supplied = KeyComposer.withShardTables(schema, new Map([[def.shards, table]]))
    expect(KeyComposer.composePk(supplied, "DeviceState", def, item("t-small"))).toBe(
      KeyComposer.composePk(schema, "DeviceState", plainIndex(), item("t-small")),
    )
    expect(KeyComposer.composePk(supplied, "DeviceState", def, item("t-big"))).toMatch(/#!20\./)
    // A schema derived by spreading keeps it.
    expect(
      KeyComposer.composePk({ ...supplied, numericKeyText: true }, "DeviceState", def, item("t")),
    ).toBe(KeyComposer.composePk(schema, "DeviceState", plainIndex(), item("t")))
  })
})

describe("Entity.make (design §2.1, §2.3)", () => {
  class Device extends Schema.Class<Device>("Device")({
    channel: Schema.String,
    deviceId: Schema.String,
    tenantId: Schema.String,
    region: Schema.String,
    groupId: Schema.String,
    rank: Schema.Number,
  }) {}
  const make = (shards: unknown, pk: ReadonlyArray<string> = ["tenantId"]) =>
    Entity.make({
      model: Device,
      entityType: "Device",
      primaryKey: {
        pk: { field: "pk", composite: ["channel", "deviceId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byTenant: {
          name: "gsi5",
          pk: { field: "gsi5pk", composite: pk },
          sk: { field: "gsi5sk", composite: ["groupId", "deviceId"] },
          shards,
        } as never,
      },
    })

  it("accepts a table, a table at 1, a provided table and { count: 1, previous }", () => {
    const table = make({ by: ["groupId"], layouts: hot }).indexes.byTenant.shards!
    expect(table.source).toEqual(["groupId"])
    expect(table.count).toBe(1)
    expect(KeyComposer.shardLayoutsOf(table)).toMatchObject({
      default: { count: 1, previous: undefined },
      values: [{ keyRecord: { tenantId: "t-big" }, layout: { count: 20, previous: undefined } }],
    })
    expect(make({ layouts: { default: 1 } }).indexes.byTenant.shards?.count).toBe(1)
    expect(make({ layouts: "provided" }).indexes.byTenant.shards?.layouts).toBe("provided")
    expect(make({ layouts: "provided" }).indexes.byTenant.shards?.count).toBe(0)
    expect(make({ count: 1, previous: 20 }).indexes.byTenant.shards?.previous).toBe(20)
    expect(
      make({ layouts: { default: { count: 1, previous: 20 } } }).indexes.byTenant.shards?.previous,
    ).toBe(20)
  })

  it.each([
    ["shards: 1", 1],
    ["{ count: 1 }", { count: 1 }],
    ["count 0", { layouts: { default: 0 } }],
    ["count 1.5", { layouts: { default: 1.5 } }],
    ["count 257", { layouts: { default: 257 } }],
    ['count "20"', { layouts: { default: "20" } }],
    ["previous 0", { layouts: { default: { count: 20, previous: 0 } } }],
    ["previous equal to count", { layouts: { default: { count: 20, previous: 20 } } }],
    ["previous 257", { layouts: { default: { count: 20, previous: 257 } } }],
    [
      "an entry's bad layout",
      { layouts: { default: 1, values: [{ match: { tenantId: "t" }, layout: 0 }] } },
    ],
    ["unknown key in shards", { layouts: hot, bu: ["groupId"] }],
    ["unknown key in layouts", { layouts: { ...hot, defaults: 1 } }],
    ["unknown key in a layout", { layouts: { default: { count: 20, prev: 1 } } }],
    [
      "unknown key in an entry",
      { layouts: { default: 1, values: [{ match: { tenantId: "t" }, layout: 2, x: 1 }] } },
    ],
    ["layouts beside count", { count: 20, layouts: hot }],
    ["layouts beside previous", { previous: 1, layouts: hot }],
    ["no default", { layouts: { values: hot.values } }],
    ["layouts not a table", { layouts: "declared" }],
    [
      "a match missing a composite",
      { layouts: { default: 1, values: [{ match: {}, layout: 20 }] } },
    ],
    [
      "a match naming a non-composite",
      { layouts: { default: 1, values: [{ match: { tenantId: "t", rank: 1 }, layout: 20 }] } },
    ],
    [
      "a match naming another index's composite",
      { layouts: { default: 1, values: [{ match: { groupId: "g" }, layout: 20 }] } },
    ],
    [
      "a match value with no key text",
      { layouts: { default: 1, values: [{ match: { tenantId: Number.NaN }, layout: 20 }] } },
    ],
    [
      "a match value that is an object",
      { layouts: { default: 1, values: [{ match: { tenantId: { a: 1 } }, layout: 20 }] } },
    ],
    [
      "a null match value",
      { layouts: { default: 1, values: [{ match: { tenantId: null }, layout: 20 }] } },
    ],
  ])("EDD-9099: %s", (_name, shards) => {
    expect(() => make(shards)).toThrow("[EDD-9099]")
  })

  it("EDD-9099: values on an empty partition key half (D19)", () => {
    expect(() => make({ by: ["groupId"], layouts: hot }, [])).toThrow(/\[EDD-9099\].*no composites/)
    expect(
      make({ by: ["groupId"], layouts: { default: 20 } }, []).indexes.byTenant.shards?.count,
    ).toBe(20)
  })

  it("EDD-9101 and EDD-9102 apply to a table as to any sharded index (D4)", () => {
    expect(() => make({ layouts: { default: 1 } }, ["channel", "deviceId"])).toThrow("[EDD-9101]")
    expect(() => make({ by: ["rank"], layouts: { default: 1 } })).toThrow("[EDD-9102]")
  })

  it("compileShardTable: a supplied table bound to its provided index", () => {
    const entity = make({ layouts: "provided" })
    const table = entity._data.compileShardTable("byTenant", hot)
    expect(table.values[0]?.keyRecord).toEqual({ tenantId: "t-big" })
    expect(() => entity._data.compileShardTable("byTenant", { default: 0 })).toThrow("[EDD-9099]")
    expect(() =>
      entity._data.compileShardTable("byTenant", {
        default: 1,
        values: [{ match: { tenantID: "x" }, layout: 2 }],
      }),
    ).toThrow("[EDD-9099]")
    expect(() => make({ layouts: hot })._data.compileShardTable("byTenant", hot)).toThrow(
      "[EDD-9182]",
    )
    expect(() => entity._data.compileShardTable("nope", hot)).toThrow("[EDD-9182]")
  })
})

describe("collections compare tables by content (design §11)", () => {
  const member = (key: string, def: KeyComposer.IndexDefinition, s = schema) => ({
    key,
    index: def,
    schema: s,
  })
  const coll = (declared: unknown, by?: ReadonlyArray<string>) =>
    tabled(declared, { def: plainIndex({ collection: "fleet" }), ...(by && { by }) })

  it("equal tables, spelled differently, agree", () => {
    expect(() =>
      KeyComposer.assertCollectionShardsAgreement("fleet", [
        member("a", coll(hot)),
        member(
          "b",
          coll({ default: 1, values: [{ match: { tenantId: "T-BIG" }, layout: 20 }] }, ["groupId"]),
        ),
      ]),
    ).not.toThrow()
  })

  it("a static member and a table with only that default agree", () => {
    expect(() =>
      KeyComposer.assertCollectionShardsAgreement("fleet", [
        member("a", { ...staticIndex(20), collection: "fleet" }),
        member("b", coll({ default: 20 })),
      ]),
    ).not.toThrow()
  })

  it.each([
    [
      "another entry",
      coll({ default: 1, values: [{ match: { tenantId: "t-other" }, layout: 20 }] }),
    ],
    ["another layout", coll({ default: 1, values: [{ match: { tenantId: "t-big" }, layout: 4 }] })],
    ["another default", coll({ default: 2, values: hot.values })],
    [
      "no shards, though every value reads one partition (D39)",
      plainIndex({ collection: "fleet" }),
    ],
  ])("EDD-9103: %s", (_name, other) => {
    expect(() =>
      KeyComposer.assertCollectionShardsAgreement("fleet", [
        member("a", coll(hot)),
        member("b", other),
      ]),
    ).toThrow("[EDD-9103]")
  })

  it("an unsharded member never agrees with { default: 1 }", () => {
    expect(() =>
      KeyComposer.assertCollectionShardsAgreement("fleet", [
        member("a", plainIndex({ collection: "fleet" })),
        member("b", coll({ default: 1 })),
      ]),
    ).toThrow("[EDD-9103]")
  })

  it("under preserve, T-BIG and t-big are two values", () => {
    expect(() =>
      KeyComposer.assertCollectionShardsAgreement("fleet", [
        member("a", coll(hot), preserve),
        member(
          "b",
          coll({ default: 1, values: [{ match: { tenantId: "T-BIG" }, layout: 20 }] }),
          preserve,
        ),
      ]),
    ).toThrow("[EDD-9103]")
  })
})

describe("EDD-9106: a shared attribute (design §12)", () => {
  const shared = (a: KeyComposer.IndexDefinition, b: KeyComposer.IndexDefinition) => ({
    primary: {
      pk: { field: "pk", composite: ["channel", "deviceId"] },
      sk: { field: "sk", composite: [] },
    },
    one: { ...a, index: "gsi5" },
    two: { ...b, index: "gsi6" },
  })

  it("the same table: fine; another table: refused", () => {
    expect(() =>
      refuseSharedKeyAttributeOnEverySchema("DeviceState", shared(tabled(hot), tabled(hot))),
    ).not.toThrow()
    expect(() =>
      refuseSharedKeyAttribute(
        schema,
        "DeviceState",
        shared(
          tabled(hot),
          tabled({ default: 1, values: [{ match: { tenantId: "x" }, layout: 20 }] }),
        ),
      ),
    ).toThrow("[EDD-9106]")
    // A static declaration keeps its form: a table with only that default is the same.
    expect(() =>
      refuseSharedKeyAttribute(
        schema,
        "DeviceState",
        shared(staticIndex(20), tabled({ default: 20 })),
      ),
    ).not.toThrow()
  })

  it("a provided half has no provable form: refused (D23)", () => {
    const provided = {
      ...plainIndex(),
      shards: {
        count: 0,
        previous: undefined,
        by: undefined,
        source: ["channel", "deviceId"],
        layouts: "provided",
      } satisfies KeyComposer.IndexShards,
    }
    expect(() =>
      refuseSharedKeyAttributeOnEverySchema("DeviceState", shared(provided, provided)),
    ).toThrow("[EDD-9106]")
  })
})

describe("the update gate is per index (design §7, D4)", () => {
  const compose = (
    def: KeyComposer.IndexDefinition,
    payload: Record<string, unknown>,
    keyRecord: Record<string, unknown>,
    options?: { readonly removedSet?: ReadonlySet<string> },
  ) =>
    KeyComposer.composeGsiKeysForUpdatePolicyAware(
      schema,
      "DeviceState",
      1,
      {
        primary: { pk: { field: "pk", composite: [] }, sk: { field: "sk", composite: [] } },
        gsi: def,
      },
      payload,
      keyRecord,
      options,
    )
  const pkOf = (def: KeyComposer.IndexDefinition, record: Record<string, unknown>) =>
    KeyComposer.composePk(schema, "DeviceState", def, record)
  const sparse: KeyComposer.IndexPolicy = { pk: "sparse", sk: "sparse" }

  describe("shape 9 — a table with `by`, a value at 1 and a value at 20", () => {
    const def = tabled(hot, { by: ["groupId"] })
    it.each([
      "t-small",
      "t-big",
    ])("%s: a touched `by` moves with the partition key composites", (tenant) => {
      const { sets } = compose(def, { tenantId: tenant, groupId: "g2", deviceId: "d" }, {})
      expect(sets.gsi5pk).toBe(pkOf(def, { tenantId: tenant, groupId: "g2" }))
      expect(sets.gsi5pk?.toString().includes("!20.")).toBe(tenant === "t-big")
    })
    it("a `by`-only update fails EDD-9100 at 1 too", () => {
      expect(() => compose(def, { groupId: "g2", deviceId: "d" }, {})).toThrow("[EDD-9100]")
    })
    it(".remove(['groupId']) drops the entry at 1", () => {
      const { removes } = compose(
        def,
        {},
        { tenantId: "t-small" },
        { removedSet: new Set(["groupId"]) },
      )
      expect(removes).toContain("gsi5pk")
    })
    it("an unrelated update is a noop", () => {
      const { sets, removes } = compose(def, { rank: 1 }, { channel: "c" })
      expect(sets.gsi5pk).toBeUndefined()
      expect(removes).toEqual([])
    })
    it("a partition key value change moves to the new value's layout, and back", () => {
      const toBig = compose(def, { tenantId: "t-big", groupId: "g", deviceId: "d" }, {})
      const toSmall = compose(def, { tenantId: "t-small", groupId: "g", deviceId: "d" }, {})
      expect(toBig.sets.gsi5pk).toMatch(/#!20\./)
      expect(toSmall.sets.gsi5pk).toBe("$fleet-db#v1#devicestate#tenantid_t-small")
    })
  })

  it("9a — an empty partition key half with `by`: { 1, previous: 20 } and 20", () => {
    const empty = plainIndex({ pk: { field: "gsi5pk", composite: [] } })
    for (const declared of [{ default: { count: 1, previous: 20 } }, { default: 20 }]) {
      const def = tabled(declared, { by: ["groupId"], def: empty })
      expect(compose(def, { rank: 1 }, { deviceId: "d" }).sets.gsi5pk).toBeUndefined()
      const moved = compose(def, { groupId: "g" }, { deviceId: "d" })
      expect(moved.sets.gsi5pk).toBe(pkOf(def, { groupId: "g" }))
    }
    expect(
      compose(
        tabled({ default: { count: 1, previous: 20 } }, { by: ["groupId"], def: empty }),
        {
          groupId: "g",
        },
        {},
      ).sets.gsi5pk,
    ).toBe("$fleet-db#v1#devicestate")
  })

  it("9b — a `by` attribute also in the primary key arrives through keyRecord", () => {
    const def = tabled(hot, { by: ["deviceId"] })
    for (const tenant of ["t-small", "t-big"]) {
      expect(compose(def, { rank: 1 }, { deviceId: "d" }).sets.gsi5pk).toBeUndefined()
      expect(compose(def, { tenantId: tenant }, { deviceId: "d" }).sets.gsi5pk).toBe(
        pkOf(def, { tenantId: tenant, deviceId: "d" }),
      )
    }
  })

  it("9c — a default source with an empty partition key half: the default variants", () => {
    const empty = plainIndex({
      pk: { field: "gsi5pk", composite: [] },
      sk: { field: "gsi5sk", composite: ["rank"] },
    })
    for (const declared of [{ default: { count: 1, previous: 20 } }, { default: 20 }]) {
      const def = tabled(declared, { def: empty })
      const one = compose(def, { rank: 1 }, { channel: "c", deviceId: "d1" })
      expect(one.sets.gsi5pk).toBe(pkOf(def, { channel: "c", deviceId: "d1" }))
      expect(compose(def, { rank: 1 }, {}).sets.gsi5pk).toBeUndefined()
    }
  })

  describe("9d — `by` after a composite the update can't supply, at 1 too", () => {
    const def = tabled(hot, {
      by: ["group"],
      def: plainIndex({ sk: { field: "gsi5sk", composite: ["region", "group"] } }),
    })
    it.each(["t-small", "t-big"])("%s: refused under preserve", (tenant) => {
      expect(() => compose(def, { tenantId: tenant, group: "b" }, {})).toThrow("[EDD-9100]")
    })
    it.each(["t-small", "t-big"])("%s: under sparse the sort key leaves", (tenant) => {
      const { sets, removes } = compose(
        { ...def, indexPolicy: sparse },
        { tenantId: tenant, group: "b" },
        {},
      )
      expect(sets.gsi5pk).toBe(pkOf(def, { tenantId: tenant, group: "b" }))
      expect(removes).toEqual(["gsi5sk"])
    })
    it.each(["t-small", "t-big"])("%s: removing the gap cascades", (tenant) => {
      const { removes } = compose(
        def,
        { tenantId: tenant, group: "b" },
        {},
        {
          removedSet: new Set(["region"]),
        },
      )
      expect(removes).toEqual(["gsi5sk"])
    })
  })
})
