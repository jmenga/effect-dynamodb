/**
 * GSI write sharding (#183, `docs/designs/gsi-write-sharding.md`): the shard
 * function, the marker, where it sits in a key, and how `composeReadPartitions`
 * and the update composer use them.
 *
 * The golden vectors were computed by an independent implementation of FNV-1a-32,
 * not by this code. Stored index keys depend on them: changing one is a breaking
 * change.
 */

import { DateTime, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import {
  foldShardText,
  isShardSourceError,
  MAX_SHARD_COUNT,
  shardHash,
  shardMarker,
  shardOf,
} from "../src/internal/Shards.js"
import {
  refuseSharedKeyAttribute,
  refuseSharedKeyAttributeOnEverySchema,
} from "../src/internal/SharedKeyAttribute.js"
import * as KeyComposer from "../src/KeyComposer.js"

const schema = DynamoSchema.make({ name: "fleet-db", version: 1 })

const index = (
  shards: KeyComposer.IndexShards | undefined,
  overrides: Partial<KeyComposer.IndexDefinition> = {},
): KeyComposer.IndexDefinition => ({
  index: "gsi5",
  pk: { field: "gsi5pk", composite: ["tenantId"] },
  sk: { field: "gsi5sk", composite: ["groupId", "deviceId"] },
  ...(shards === undefined ? {} : { shards }),
  ...overrides,
})

const defaultSource = (count = 20, previous?: number): KeyComposer.IndexShards => ({
  count,
  by: undefined,
  previous,
  source: ["channel", "deviceId"],
})

const byGroup = (count = 20, previous?: number): KeyComposer.IndexShards => ({
  count,
  by: ["groupId"],
  previous,
  source: ["groupId"],
})

describe("the shard function", () => {
  it.each([
    [[], 0x811c9dc5],
    [[""], 0x811c9dc5],
    [["a"], 0xc40bf6cc],
    [["A"], 0xc40bf6cc],
    [["foobar"], 0x9de507a8],
    [["device-1"], 0x5ad377d1],
    [["channel-a", "device-1"], 0x3cca2437],
    [["ab", "c"], 0xd346db04],
    [["a", "bc"], 0xe4dec156],
    [["ß"], 0x66029ae3],
    [["SS"], 0x66029ae3],
    [["ẞ"], 0x66029ae3],
    [["t-123#07"], 0xb5a28a56],
    [["日本語"], 0x805f5ce7],
    [["😀"], 0x33a29608],
    [["0000000000000007"], 0xa79fce00],
    [["2024-01-01T00:00:00.000Z"], 0xb04e7281],
  ] as ReadonlyArray<
    readonly [ReadonlyArray<string>, number]
  >)("hashes %j to its golden value", (texts, expected) => {
    expect(shardHash(texts)).toBe(expected)
  })

  it.each([
    [["device-1"], 20, 9],
    [["channel-a", "device-1"], 20, 3],
    [["foobar"], 16, 8],
    [["日本語"], 256, 231],
  ] as ReadonlyArray<
    readonly [ReadonlyArray<string>, number, number]
  >)("takes %j mod %i to shard %i", (texts, count, expected) => {
    expect(shardOf(texts, count)).toBe(expected)
  })

  it("keeps values apart across a composite boundary", () => {
    expect(shardHash(["ab", "c"])).not.toBe(shardHash(["a", "bc"]))
    expect(shardHash(["a", ""])).not.toBe(shardHash(["", "a"]))
    expect(shardHash(["a", ""])).not.toBe(shardHash(["a"]))
  })

  it("never spells the separator: 0xFF is not a UTF-8 byte", () => {
    const encoder = new TextEncoder()
    for (const text of ["ÿ", "￿", "\u{10ffff}", "\ud800"]) {
      expect(encoder.encode(foldShardText(text)).includes(0xff)).toBe(false)
    }
  })

  describe("the fold treats every spelling the key text treats as one value as one", () => {
    // Under `lowercase` two spellings are one key when they lowercase alike;
    // under `uppercase`, when they uppercase alike. Neither may reach two shards.
    it("over every code point", () => {
      const failures: Array<string> = []
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue
        const text = String.fromCodePoint(cp)
        const folded = foldShardText(text)
        if (
          foldShardText(text.toLowerCase()) !== folded ||
          foldShardText(text.toUpperCase()) !== folded
        ) {
          failures.push(`U+${cp.toString(16)}`)
        }
      }
      expect(failures).toEqual([])
    })

    it.each([
      ["ΑΣ", "ασ"],
      ["ΑΣ", "ας"],
      ["straße", "STRASSE"],
      ["ß", "SS"],
      ["ß", "ẞ"],
      ["K", "K"], // Kelvin sign
      ["k", "K"],
      ["i̇", "İ"], // İ
      ["ı", "I"],
      ["ſ", "S"],
      ["GROUP-A", "group-a"],
    ])("%s and %s hash alike", (a, b) => {
      expect(shardHash([a])).toBe(shardHash([b]))
    })

    it("the other order of the fold would fail: ß and ẞ", () => {
      const other = (text: string) => text.toUpperCase().toLowerCase()
      expect(other("ß")).not.toBe(other("ẞ"))
      expect("ß".toLowerCase()).toBe("ẞ".toLowerCase())
    })

    it("values that differ under `preserve` only bias the hash: their keys still differ", () => {
      const preserve = DynamoSchema.make({ name: "app", version: 1, casing: "preserve" })
      const def = index(byGroup(), { casing: "preserve" })
      const pk = (tenantId: string, groupId: string) =>
        KeyComposer.composePk(preserve, "Device", def, { tenantId, groupId })
      expect(pk("T", "group-a")).not.toBe(pk("t", "GROUP-A"))
      expect(pk("T", "group-a")).toBe(pk("T", "GROUP-A"))
    })
  })

  it("is independent of the key format options", () => {
    const pk = (casing: DynamoSchema.Casing) =>
      KeyComposer.composePk(schema, "DeviceState", index(defaultSource(), { casing }), {
        tenantId: "T",
        channel: "Channel-A",
        deviceId: "Device-1",
      })
    const marker = (text: string) => text.toLowerCase().split("#")[3]
    expect(marker(pk("lowercase"))).toBe(marker(pk("uppercase")))
    expect(marker(pk("lowercase"))).toBe(marker(pk("preserve")))
  })
})

describe("the marker", () => {
  it.each([
    [2, 0, "!2.0"],
    [2, 1, "!2.1"],
    [10, 9, "!10.9"],
    [11, 10, "!11.10"],
    [11, 0, "!11.00"],
    [20, 7, "!20.07"],
    [100, 99, "!100.99"],
    [101, 7, "!101.007"],
    [256, 255, "!256.255"],
    [256, 0, "!256.000"],
  ])("count %i, shard %i → %s", (count, shard, expected) => {
    expect(shardMarker(count, shard)).toBe(expected)
  })
})

describe("the partition key text", () => {
  const record = { tenantId: "t-123", channel: "channel-a", deviceId: "device-1" }
  // ("channel-a", "device-1") hashes to shard 3 of 20.

  it("is unchanged on an unsharded index", () => {
    expect(KeyComposer.composePk(schema, "DeviceState", index(undefined), record)).toBe(
      "$fleet-db#v1#devicestate#tenantid_t-123",
    )
  })

  it("carries the marker before any value", () => {
    expect(KeyComposer.composePk(schema, "DeviceState", index(defaultSource()), record)).toBe(
      "$fleet-db#v1#devicestate#!20.03#tenantid_t-123",
    )
  })

  it("on an empty partition key half", () => {
    const empty = index(defaultSource(), { pk: { field: "gsi5pk", composite: [] } })
    expect(KeyComposer.composePk(schema, "DeviceState", empty, record)).toBe(
      "$fleet-db#v1#devicestate#!20.03",
    )
  })

  it("on a collection's", () => {
    const collection = index(defaultSource(), { collection: "assignments" })
    expect(KeyComposer.composePk(schema, "DeviceState", collection, record)).toBe(
      "$fleet-db#v1#assignments#!20.03#tenantid_t-123",
    )
    const sub = index(defaultSource(), { collection: ["assignments", "open"] })
    expect(KeyComposer.composePk(schema, "DeviceState", sub, record)).toBe(
      "$fleet-db#v1#assignments#!20.03#tenantid_t-123",
    )
  })

  it("under each casing", () => {
    const upper = index(defaultSource(), { casing: "uppercase" })
    expect(KeyComposer.composePk(schema, "DeviceState", upper, record)).toBe(
      "$fleet-db#v1#DEVICESTATE#!20.03#TENANTID_T-123",
    )
    const shouting = DynamoSchema.make({ name: "fleet-db", version: 1, casing: "uppercase" })
    expect(KeyComposer.composePk(shouting, "DeviceState", index(defaultSource()), record)).toBe(
      "$FLEET-DB#v1#DEVICESTATE#!20.03#TENANTID_T-123",
    )
    const preserve = index(defaultSource(), { casing: "preserve" })
    expect(KeyComposer.composePk(schema, "DeviceState", preserve, record)).toBe(
      "$fleet-db#v1#DeviceState#!20.03#tenantId_t-123",
    )
  })

  it("composes a date, number, boolean and bigint source by its key text", () => {
    const def = index({ count: 16, by: undefined, previous: undefined, source: ["a"] })
    const marker = (a: unknown) =>
      KeyComposer.composePk(schema, "X", def, { tenantId: "t", a }).split("#")[3]
    const shard = (text: string) => shardMarker(16, shardOf([text], 16))
    expect(marker(7)).toBe(shard("0000000000000007"))
    expect(marker(-3.14)).toBe(shard(KeyComposer.serializeValue(-3.14)))
    expect(marker(7n)).toBe(shard(KeyComposer.serializeValue(7n)))
    expect(marker(true)).toBe(shard("true"))
    const iso = "2024-01-01T00:00:00.000Z"
    expect(marker(DateTime.makeUnsafe(iso))).toBe(shard(iso))
    expect(marker(new Date(iso))).toBe(shard(iso))
  })

  describe("can't collide with another layout's, whatever a value spells (finding 3)", () => {
    const pk = (def: KeyComposer.IndexDefinition, tenantId: string) =>
      KeyComposer.composePk(schema, "DeviceState", def, {
        tenantId,
        channel: "channel-a",
        deviceId: "device-1",
      })

    it("an unsharded key's value can't spell a sharded key", () => {
      const sharded = pk(index(defaultSource()), "t-123")
      for (const value of [
        "t-123#07",
        "t-123#03",
        "t-123#!20.03",
        "!20.03",
        "!20.03#tenantid_t-123",
        "x#!20.03#tenantid_t-123",
      ]) {
        const unsharded = pk(index(undefined), value)
        expect(unsharded).not.toBe(sharded)
        // The fourth segment always holds the composite's label.
        expect(unsharded.split("#")[3]).toMatch(/^tenantid_/)
      }
    })

    it("a sharded key's value can't spell another's", () => {
      expect(pk(index(defaultSource()), "!20.04#tenantid_t")).not.toBe(
        pk(index(defaultSource()), "t"),
      )
    })

    it("two counts never share a partition", () => {
      const twenty = KeyComposer.composeReadPartitions(
        schema,
        "DeviceState",
        index(defaultSource(20)),
        { tenantId: "t" },
      ).partitions
      const two = KeyComposer.composeReadPartitions(
        schema,
        "DeviceState",
        index(defaultSource(2)),
        {
          tenantId: "t",
        },
      ).partitions
      expect(new Set([...twenty, ...two]).size).toBe(22)
    })

    it("widths don't collide: !20.1 isn't !201", () => {
      expect(shardMarker(20, 1)).not.toBe(shardMarker(201, 1))
      expect(shardMarker(20, 1).startsWith("!201")).toBe(false)
    })
  })

  describe("there is no unsharded fallback", () => {
    it("a missing default source throws EDD-9100", () => {
      const thrown = (record: Record<string, unknown>) => {
        try {
          KeyComposer.composePk(schema, "DeviceState", index(defaultSource()), record)
        } catch (error) {
          return error
        }
        return undefined
      }
      const error = thrown({ tenantId: "t", channel: "channel-a" })
      expect(isShardSourceError(error)).toBe(true)
      expect((error as Error).message).toContain("[EDD-9100]")
      expect((error as Error).message).toContain('"deviceId"')
      expect(isShardSourceError(thrown({ tenantId: "t", channel: null, deviceId: "d" }))).toBe(true)
    })

    it("a missing `by` throws EDD-9100", () => {
      expect(() =>
        KeyComposer.composePk(schema, "DeviceState", index(byGroup()), { tenantId: "t" }),
      ).toThrow("[EDD-9100]")
    })

    it("an index never bound to an entity can't compose", () => {
      const unbound = index({ count: 20, by: undefined, previous: undefined, source: undefined })
      expect(() =>
        KeyComposer.composePk(schema, "DeviceState", unbound, { tenantId: "t" }),
      ).toThrow("never bound")
      expect(() =>
        KeyComposer.composeReadPartitions(schema, "DeviceState", unbound, { tenantId: "t" }),
      ).toThrow("never bound")
    })

    it("a put without `by` leaves the entry out: sparse, not a failure", () => {
      expect(
        KeyComposer.tryComposeIndexKeys(schema, "DeviceState", 1, index(byGroup()), {
          tenantId: "t",
          deviceId: "d",
        }),
      ).toBeUndefined()
    })

    it("a put with its source writes the sharded key", () => {
      const keys = KeyComposer.tryComposeIndexKeys(schema, "DeviceState", 1, index(byGroup()), {
        tenantId: "t",
        groupId: "group-a",
        deviceId: "d",
      })
      expect(keys?.gsi5pk).toMatch(/^\$fleet-db#v1#devicestate#!20\.\d\d#tenantid_t$/)
      expect(keys?.gsi5sk).toBe("$fleet-db#v1#devicestate#groupid_group-a#deviceid_d")
    })
  })
})

describe("composeReadPartitions", () => {
  const read = (def: KeyComposer.IndexDefinition, pins: Record<string, unknown>) =>
    KeyComposer.composeReadPartitions(schema, "DeviceState", def, pins)
  const shardsOf = (partitions: ReadonlyArray<string>) => partitions.map((pk) => pk.split("#")[3])

  it("reads the one partition of an unsharded index", () => {
    expect(read(index(undefined), { tenantId: "t" })).toEqual({
      partitions: ["$fleet-db#v1#devicestate#tenantid_t"],
      fanOut: undefined,
    })
  })

  it("reads every shard, in shard order", () => {
    const { partitions, fanOut } = read(index(defaultSource(4)), { tenantId: "t" })
    expect(partitions).toEqual([
      "$fleet-db#v1#devicestate#!4.0#tenantid_t",
      "$fleet-db#v1#devicestate#!4.1#tenantid_t",
      "$fleet-db#v1#devicestate#!4.2#tenantid_t",
      "$fleet-db#v1#devicestate#!4.3#tenantid_t",
    ])
    expect(fanOut).toEqual({
      count: 4,
      source: ["channel", "deviceId"],
      previous: undefined,
      pruned: false,
      unsharded: undefined,
    })
  })

  describe("a default source prunes when the accessor pins the whole primary key", () => {
    const pinsPrimary = index(defaultSource(8), {
      sk: { field: "gsi5sk", composite: ["groupId", "channel", "deviceId"] },
    })
    const stored = KeyComposer.composePk(schema, "DeviceState", pinsPrimary, {
      tenantId: "t",
      channel: "c-1",
      deviceId: "d-1",
    })
    const pins = { tenantId: "t", groupId: "g", channel: "c-1", deviceId: "d-1" }

    it("reads the one shard the write stored", () => {
      const { partitions, fanOut } = read(pinsPrimary, pins)
      expect(partitions).toEqual([stored])
      expect(fanOut?.pruned).toBe(true)
      expect(fanOut?.source).toEqual(["channel", "deviceId"])
    })

    it("a partial pin fans out", () => {
      for (const partial of [
        { tenantId: "t" },
        { tenantId: "t", groupId: "g" },
        { tenantId: "t", groupId: "g", channel: "c-1" },
      ]) {
        const { partitions, fanOut } = read(pinsPrimary, partial)
        expect(partitions).toHaveLength(8)
        expect(fanOut?.pruned).toBe(false)
      }
    })

    it("an input in another case reaches the stored shard", () => {
      for (const [channel, deviceId] of [
        ["C-1", "D-1"],
        ["c-1", "D-1"],
        ["C-1", "d-1"],
      ]) {
        expect(read(pinsPrimary, { ...pins, channel, deviceId }).partitions).toEqual([stored])
      }
    })

    it("a primary key composite outside the sort key never prunes: it can't be pinned", () => {
      const { partitions, fanOut } = read(index(defaultSource(4)), {
        tenantId: "t",
        groupId: "g",
        channel: "c",
        deviceId: "d",
      })
      expect(partitions).toHaveLength(4)
      expect(fanOut?.pruned).toBe(false)
    })

    it("a value past a hole selects nothing, so it doesn't prune", () => {
      const { partitions, fanOut } = read(pinsPrimary, {
        tenantId: "t",
        channel: "c-1",
        deviceId: "d-1",
      })
      expect(partitions).toHaveLength(8)
      expect(fanOut?.pruned).toBe(false)
      const hashedPastHole = index({
        count: 4,
        by: ["deviceId"],
        previous: undefined,
        source: ["deviceId"],
      })
      expect(read(hashedPastHole, { tenantId: "t", deviceId: "d" }).partitions).toHaveLength(4)
    })

    it("a source composite in the partition key half is pinned as well", () => {
      const spread = index(defaultSource(8), {
        pk: { field: "gsi5pk", composite: ["tenantId", "channel"] },
        sk: { field: "gsi5sk", composite: ["deviceId"] },
      })
      const record = { tenantId: "t", channel: "c-1", deviceId: "d-1" }
      expect(read(spread, record).partitions).toEqual([
        KeyComposer.composePk(schema, "DeviceState", spread, record),
      ])
      expect(read(spread, { tenantId: "t", channel: "c-1" }).partitions).toHaveLength(8)
    })

    it("hashes non-string values as the write does", () => {
      const typed = index(
        { count: 8, by: undefined, previous: undefined, source: ["seq", "at", "wide"] },
        { sk: { field: "gsi5sk", composite: ["seq", "at", "wide"] } },
      )
      const record = {
        tenantId: "t",
        seq: -3,
        at: DateTime.makeUnsafe("2026-01-02T03:04:05.000Z"),
        wide: 42n,
      }
      expect(read(typed, record).partitions).toEqual([
        KeyComposer.composePk(schema, "DeviceState", typed, record),
      ])
    })

    it("`previous` stays unpruned, and `prune: false` reads every shard", () => {
      const moving = index(defaultSource(8, 2), {
        sk: { field: "gsi5sk", composite: ["groupId", "channel", "deviceId"] },
      })
      const { partitions } = read(moving, pins)
      expect(shardsOf(partitions).slice(1)).toEqual(["!2.0", "!2.1"])
      expect(partitions).toHaveLength(3)
      expect(
        KeyComposer.composeReadPartitions(schema, "DeviceState", pinsPrimary, pins, {
          prune: false,
        }).partitions,
      ).toHaveLength(8)
    })

    it("a Z-order sort key never prunes: an accessor can't pin it", () => {
      const zorder = {
        ...index(defaultSource(4)),
        sk: {
          field: "gsi5sk",
          composite: ["channel", "deviceId"],
          zorderHalf: { prefix: [], dimensions: [], layout: undefined },
        },
      } as unknown as KeyComposer.IndexDefinition
      expect(
        read(zorder, { tenantId: "t", channel: "c-1", deviceId: "d-1" }).partitions,
      ).toHaveLength(4)
    })
  })

  it("prunes to one shard when every `by` attribute is pinned", () => {
    const { partitions, fanOut } = read(index(byGroup(20)), { tenantId: "t", groupId: "group-a" })
    expect(partitions).toHaveLength(1)
    expect(fanOut?.pruned).toBe(true)
    const written = KeyComposer.composePk(schema, "DeviceState", index(byGroup(20)), {
      tenantId: "t",
      groupId: "group-a",
    })
    expect(partitions[0]).toBe(written)
  })

  it("prunes a query input differing in case to the stored shard (finding 1)", () => {
    const written = KeyComposer.composePk(schema, "DeviceState", index(byGroup(20)), {
      tenantId: "t",
      groupId: "group-a",
    })
    for (const groupId of ["GROUP-A", "Group-A", "group-a"]) {
      expect(read(index(byGroup(20)), { tenantId: "t", groupId }).partitions).toEqual([written])
    }
  })

  it("doesn't prune with only some of `by` pinned", () => {
    const def = index({
      count: 3,
      by: ["groupId", "deviceId"],
      previous: undefined,
      source: ["groupId", "deviceId"],
    })
    expect(read(def, { tenantId: "t", groupId: "g" }).partitions).toHaveLength(3)
    expect(read(def, { tenantId: "t", groupId: "g", deviceId: "d" }).partitions).toHaveLength(1)
  })

  it("`prune: false` reads every shard, whatever is pinned", () => {
    const { partitions, fanOut } = KeyComposer.composeReadPartitions(
      schema,
      "DeviceState",
      index(byGroup(3)),
      { tenantId: "t", groupId: "g" },
      { prune: false },
    )
    expect(partitions).toHaveLength(3)
    expect(fanOut?.pruned).toBe(false)
  })

  it("`previous: 1` adds the unsharded partition", () => {
    const { partitions } = read(index(defaultSource(2, 1)), { tenantId: "t" })
    expect(partitions).toEqual([
      "$fleet-db#v1#devicestate#!2.0#tenantid_t",
      "$fleet-db#v1#devicestate#!2.1#tenantid_t",
      "$fleet-db#v1#devicestate#tenantid_t",
    ])
  })

  it("`previous: m` adds m partitions: N + M, all distinct", () => {
    const { partitions } = read(index(defaultSource(4, 2)), { tenantId: "t" })
    expect(shardsOf(partitions)).toEqual(["!4.0", "!4.1", "!4.2", "!4.3", "!2.0", "!2.1"])
    expect(new Set(partitions).size).toBe(6)
  })

  it("prunes the current layout, never `previous`", () => {
    const { partitions } = read(index(byGroup(20, 2)), { tenantId: "t", groupId: "g" })
    expect(partitions).toHaveLength(3)
    expect(shardsOf(partitions).slice(1)).toEqual(["!2.0", "!2.1"])
    expect(read(index(byGroup(20, 1)), { tenantId: "t", groupId: "g" }).partitions).toHaveLength(2)
  })

  it("still needs the partition key composites", () => {
    expect(() => read(index(defaultSource()), {})).toThrow('Missing composite attribute "tenantId"')
  })

  it("`unshardedView` is the unsharded layout", () => {
    const view = KeyComposer.unshardedView(index(defaultSource()))
    expect(KeyComposer.composePk(schema, "DeviceState", view, { tenantId: "t" })).toBe(
      "$fleet-db#v1#devicestate#tenantid_t",
    )
    const plain = index(undefined)
    expect(KeyComposer.unshardedView(plain)).toBe(plain)
  })
})

describe("Entity.make's checks on `shards`", () => {
  class Device extends Schema.Class<Device>("Device")({
    channel: Schema.String,
    deviceId: Schema.String,
    tenantId: Schema.String,
    groupId: Schema.String,
    rank: Schema.Number,
    status: Schema.String,
  }) {}

  const make = (gsi: Record<string, unknown>, primary?: Record<string, unknown>) =>
    Entity.make({
      model: Device,
      entityType: "Device",
      primaryKey: {
        pk: { field: "pk", composite: ["channel", "deviceId"] },
        sk: { field: "sk", composite: [] },
        ...primary,
      } as never,
      indexes: {
        byTenant: {
          name: "gsi5",
          pk: { field: "gsi5pk", composite: ["tenantId"] },
          sk: { field: "gsi5sk", composite: ["groupId", "deviceId"] },
          ...gsi,
        } as never,
      },
    })

  it("normalises the shorthand and binds the primary key as the source", () => {
    const entity = make({ shards: 20 })
    expect(entity.indexes.byTenant.shards).toEqual({
      count: 20,
      by: undefined,
      previous: undefined,
      source: ["channel", "deviceId"],
    })
  })

  it("binds `by` as the source, keeping `previous`", () => {
    const entity = make({ shards: { count: 20, by: ["groupId"], previous: 1 } })
    expect(entity.indexes.byTenant.shards).toEqual({
      count: 20,
      by: ["groupId"],
      previous: 1,
      source: ["groupId"],
    })
  })

  it("source order is primary key composites, partition then sort", () => {
    const entity = Entity.make({
      model: Device,
      entityType: "Device",
      primaryKey: {
        pk: { field: "pk", composite: ["channel"] },
        sk: { field: "sk", composite: ["deviceId"] },
      },
      indexes: {
        byTenant: {
          name: "gsi5",
          pk: { field: "gsi5pk", composite: ["tenantId"] },
          sk: { field: "gsi5sk", composite: ["deviceId"] },
          shards: 2,
        },
      },
    })
    expect(entity.indexes.byTenant.shards?.source).toEqual(["channel", "deviceId"])
  })

  it.each([
    [1],
    [0],
    [-2],
    [2.5],
    [Number.NaN],
    [MAX_SHARD_COUNT + 1],
    ["20"],
  ])("EDD-9099: count %s", (count) => {
    expect(() => make({ shards: { count } })).toThrow("[EDD-9099]")
    if (typeof count === "number") expect(() => make({ shards: count })).toThrow("[EDD-9099]")
  })

  it("accepts the count limits", () => {
    expect(make({ shards: 2 }).indexes.byTenant.shards?.count).toBe(2)
    expect(make({ shards: MAX_SHARD_COUNT }).indexes.byTenant.shards?.count).toBe(256)
  })

  it.each([
    [0],
    [-1],
    [1.5],
    ["1"],
    [20],
    [MAX_SHARD_COUNT + 1],
  ])("EDD-9099: previous %s with count 20", (previous) => {
    expect(() => make({ shards: { count: 20, previous } })).toThrow("[EDD-9099]")
  })

  it("EDD-9099: an unknown option or a non-object", () => {
    expect(() => make({ shards: { count: 20, bu: ["groupId"] } })).toThrow("[EDD-9099]")
    expect(() => make({ shards: "20" })).toThrow("[EDD-9099]")
    expect(() => make({ shards: [20] })).toThrow("[EDD-9099]")
  })

  it("EDD-9099: on the primary key", () => {
    expect(() => make({}, { shards: 20 })).toThrow("[EDD-9099]")
  })

  describe("EDD-9101: nothing to spread", () => {
    it("every primary key composite is a partition key composite of the index", () => {
      const makeWith = (shards: unknown) =>
        Entity.make({
          model: Device,
          entityType: "Device",
          primaryKey: {
            pk: { field: "pk", composite: ["channel"] },
            sk: { field: "sk", composite: ["deviceId"] },
          },
          indexes: {
            one: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["deviceId", "channel", "tenantId"] },
              sk: { field: "gsi1sk", composite: ["groupId"] },
              shards: shards as never,
            },
          },
        })
      expect(() => makeWith(2)).toThrow("[EDD-9101]")
      expect(() => makeWith({ count: 2, by: ["groupId"] })).toThrow("[EDD-9101]")
    })

    it("a primary key composite in the sort key is something to spread", () => {
      const made = Entity.make({
        model: Device,
        entityType: "Device",
        primaryKey: {
          pk: { field: "pk", composite: ["channel"] },
          sk: { field: "sk", composite: ["deviceId"] },
        },
        indexes: {
          one: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["channel"] },
            sk: { field: "gsi1sk", composite: ["deviceId"] },
            shards: 2,
          },
        },
      })
      expect(made.indexes.one.shards?.count).toBe(2)
    })
  })

  describe("EDD-9102: `by`", () => {
    it.each([
      ["empty", []],
      ["not a list", "groupId"],
      ["duplicated", ["groupId", "groupId"]],
      ["a partition key composite", ["tenantId"]],
      ["not a composite of the index", ["status"]],
      ["not a model field", ["nope"]],
    ])("%s", (_name, by) => {
      expect(() => make({ shards: { count: 2, by } })).toThrow("[EDD-9102]")
    })

    it("on a Z-order sort key", () => {
      expect(() =>
        Entity.make({
          model: Device,
          entityType: "Device",
          primaryKey: {
            pk: { field: "pk", composite: ["channel", "deviceId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byRank: {
              name: "gsi5",
              pk: { field: "gsi5pk", composite: ["tenantId"] },
              sk: { field: "gsi5sk", zorder: [{ field: "rank", min: 0, max: 15, step: 1 }] },
              shards: { count: 2, by: ["rank"] as never },
            },
          },
        }),
      ).toThrow("[EDD-9102]")
    })
  })

  it("a Z-order sort key may be sharded by the primary key", () => {
    const made = Entity.make({
      model: Device,
      entityType: "Device",
      primaryKey: {
        pk: { field: "pk", composite: ["channel", "deviceId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byRank: {
          name: "gsi5",
          pk: { field: "gsi5pk", composite: ["tenantId"] },
          sk: { field: "gsi5sk", zorder: [{ field: "rank", min: 0, max: 15, step: 1 }] },
          shards: 4,
        },
      },
    })
    expect(made.indexes.byRank.shards?.source).toEqual(["channel", "deviceId"])
  })

  it("composes on a configured model, by the domain name", () => {
    const made = Entity.make({
      model: DynamoModel.configure(Device, { deviceId: { field: "device_id" } }),
      entityType: "Device",
      primaryKey: {
        pk: { field: "pk", composite: ["channel", "deviceId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byTenant: {
          name: "gsi5",
          pk: { field: "gsi5pk", composite: ["tenantId"] },
          sk: { field: "gsi5sk", composite: ["deviceId"] },
          shards: 2,
        },
      },
    })
    expect(made.indexes.byTenant.shards?.source).toEqual(["channel", "deviceId"])
  })
})

describe("EDD-9106: two key halves in one attribute", () => {
  class Row extends Schema.Class<Row>("Row")({
    tenant: Schema.String,
    id: Schema.String,
    region: Schema.String,
    group: Schema.String,
  }) {}

  const primaryKey = {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["id"] },
  }
  const make = (indexes: Record<string, unknown>, primary: unknown = primaryKey) =>
    Entity.make({
      model: Row,
      entityType: "Row",
      primaryKey: primary as never,
      indexes: indexes as never,
    })
  const gsi = (overrides: Record<string, unknown> = {}) => ({
    name: "gsi1",
    pk: { field: "gpk", composite: ["tenant"] },
    sk: { field: "gsk", composite: ["region"] },
    ...overrides,
  })

  describe("a sharded partition key can't share an attribute", () => {
    it.each([
      ["with the table's partition key", { pk: { field: "pk", composite: ["tenant"] } }],
      ["with the table's sort key", { pk: { field: "sk", composite: ["tenant"] } }],
      ["with its own sort key", { sk: { field: "gpk", composite: ["region"] } }],
    ])("%s", (_name, overrides) => {
      expect(() => make({ byRegion: gsi({ ...overrides, shards: 8 }) })).toThrow("[EDD-9106]")
      expect(() =>
        make({ byRegion: gsi({ ...overrides, shards: { count: 8, by: ["region"] } }) }),
      ).toThrow("[EDD-9106]")
    })

    it("with another index's partition key, unsharded", () => {
      expect(() =>
        make({
          byRegion: gsi({ shards: 8 }),
          byGroup: gsi({ name: "gsi2", sk: { field: "gsk2", composite: ["group"] } }),
        }),
      ).toThrow("[EDD-9106]")
    })

    it("with another index's sort key", () => {
      expect(() =>
        make({
          byRegion: gsi({ shards: 8 }),
          byGroup: gsi({
            name: "gsi2",
            pk: { field: "gpk2", composite: ["tenant"] },
            sk: { field: "gpk", composite: ["group"] },
          }),
        }),
      ).toThrow("[EDD-9106]")
    })

    it.each([
      ["a different count", { shards: 16 }],
      ["a different source", { shards: { count: 8, by: ["group"] } }],
      ["different composites", { shards: 8, pk: { field: "gpk", composite: ["region"] } }],
      ["a collection's text", { shards: 8, collection: "things" }],
    ])("with another sharded index's, under %s", (_name, overrides) => {
      expect(() =>
        make({
          byRegion: gsi({ shards: 8 }),
          byGroup: gsi({
            name: "gsi2",
            sk: { field: "gsk2", composite: ["group"] },
            ...overrides,
          }),
        }),
      ).toThrow("[EDD-9106]")
    })

    // Two of any three sources land on one of 2 shards, so one made-up item can't tell
    // every pair apart: the sources themselves have to be compared.
    it("with another sharded index's, under a source that hashes the same", () => {
      const indexes = [
        gsi({ shards: { count: 2, by: ["region"] } }),
        gsi({
          name: "gsi2",
          sk: { field: "gsk2", composite: ["group"] },
          shards: { count: 2, by: ["group"] },
        }),
        gsi({ name: "gsi3", sk: { field: "gsk3", composite: ["region", "group"] }, shards: 2 }),
      ]
      for (const [i, a] of indexes.entries()) {
        for (const b of indexes.slice(i + 1)) {
          expect(() => make({ a, b })).toThrow("[EDD-9106]")
        }
      }
    })

    it("names both halves and the attribute", () => {
      expect(() =>
        make({ byRegion: gsi({ pk: { field: "pk", composite: ["tenant"] }, shards: 8 }) }),
      ).toThrow(
        /the primary key's partition key and index "byRegion"'s partition key .* "pk".*shard marker/,
      )
    })
  })

  describe("what agrees is fine", () => {
    it("two indexes sharded the same way share a partition key attribute", () => {
      const made = make({
        byRegion: gsi({ shards: 8 }),
        byGroup: gsi({ name: "gsi2", sk: { field: "gsk2", composite: ["group"] }, shards: 8 }),
      })
      expect(made.indexes.byRegion?.shards?.count).toBe(8)
      expect(made.indexes.byGroup?.shards?.count).toBe(8)
    })

    it("a sharded index's sort key may be the table's when it composes the same text", () => {
      const made = make({
        byRegion: gsi({ sk: { field: "sk", composite: ["id"] }, shards: 8 }),
      })
      expect(made.indexes.byRegion?.sk.field).toBe("sk")
    })

    it("an unsharded index on the table's partition key with the same composites", () => {
      const made = make({ local: gsi({ pk: { field: "pk", composite: ["tenant"] } }) })
      const keys = KeyComposer.composeAllKeys(schema, "Row", 1, made.indexes, {
        tenant: "t",
        id: "1",
        region: "r",
      })
      expect(keys.pk).toBe("$fleet-db#v1#row#tenant_t")
    })

    it("an inverted index, whose halves compose what the table's do", () => {
      const made = make({
        inverted: {
          name: "gsi1",
          pk: { field: "sk", composite: ["id"] },
          sk: { field: "pk", composite: ["tenant"] },
        },
      })
      const keys = KeyComposer.composeAllKeys(schema, "Row", 1, made.indexes, {
        tenant: "t",
        id: "1",
      })
      expect(keys).toEqual({ pk: "$fleet-db#v1#row#tenant_t", sk: "$fleet-db#v1#row#id_1" })
    })

    it("a casing one half leaves to the schema is not held against it", () => {
      const made = make({
        local: gsi({ pk: { field: "pk", composite: ["tenant"] }, casing: "preserve" }),
      })
      expect(made.indexes.local?.casing).toBe("preserve")
    })
  })

  describe("a pair with nothing sharded is judged too (D61)", () => {
    it.each([
      ["the table's partition key", { pk: { field: "pk", composite: ["region"] } }],
      ["the table's sort key", { pk: { field: "sk", composite: ["region"] } }],
      ["the table's sort key, as a sort key", { sk: { field: "sk", composite: ["region"] } }],
      ["the table's partition key, as a sort key", { sk: { field: "pk", composite: ["region"] } }],
    ])("%s, over other composites", (_name, overrides) => {
      expect(() => make({ byRegion: gsi(overrides) })).toThrow("[EDD-9106]")
    })

    it("two accessors on one index are refused before their attributes are judged (EDD-9108)", () => {
      expect(() =>
        make({
          byRegion: gsi(),
          byGroup: gsi({ sk: { field: "gsk", composite: ["group"] } }),
        }),
      ).toThrow("[EDD-9108]")
    })

    it("two indexes sharing an attribute over other composites", () => {
      expect(() =>
        make({
          byRegion: gsi(),
          byGroup: gsi({ name: "gsi2", sk: { field: "gsk", composite: ["group"] } }),
        }),
      ).toThrow("[EDD-9106]")
    })

    it("two indexes swapping each other's attributes", () => {
      expect(() =>
        make({
          a: gsi(),
          b: gsi({
            name: "gsi2",
            pk: { field: "gsk", composite: ["tenant"] },
            sk: { field: "gpk", composite: ["region"] },
          }),
        }),
      ).toThrow("[EDD-9106]")
    })

    it("a difference of casing", () => {
      expect(() =>
        make({
          byRegion: gsi({ casing: "uppercase" }),
          byGroup: gsi({
            name: "gsi2",
            sk: { field: "gsk2", composite: ["group"] },
            casing: "lowercase",
          }),
        }),
      ).toThrow(/\[EDD-9106\].*"uppercase" and "lowercase"/)
    })

    it("a partition key and a sort key over the same composites build the same text", () => {
      expect(() =>
        make({
          a: gsi({ pk: { field: "shared", composite: ["region"] } }),
          b: gsi({
            name: "gsi2",
            pk: { field: "gpk2", composite: ["tenant"] },
            sk: { field: "shared", composite: ["region"] },
          }),
        }),
      ).not.toThrow()
    })

    it("names the attribute and says what to do, for an unsharded pair too", () => {
      expect(() =>
        make({
          byRegion: gsi(),
          byGroup: gsi({ name: "gsi2", sk: { field: "gsk", composite: ["group"] } }),
        }),
      ).toThrow(/"gsk".*overwrites the other.*Give each its own attribute/)
    })
  })
})

describe("EDD-9106: a shared attribute needs the same fields, order and casing", () => {
  class Item extends Schema.Class<Item>("Item")({
    id: Schema.String,
    tenant: Schema.String,
    Tenant: Schema.String,
    region: Schema.String,
    n: Schema.Number,
    big: Schema.BigInt,
    x: Schema.Number,
    y: Schema.Number,
    at: DynamoModel.DateString,
  }) {}

  /** One half under test: what it is, and whether its index is sharded. */
  type Half = { readonly half: "pk" | "sk"; readonly def: Record<string, unknown> }
  const sk = (part: Record<string, unknown>, rest: Record<string, unknown> = {}): Half => ({
    half: "sk",
    def: { sk: part, shards: 8, ...rest },
  })
  const pk = (composite: ReadonlyArray<string>, rest: Record<string, unknown> = {}): Half => ({
    half: "pk",
    def: { pk: { composite }, shards: 8, ...rest },
  })
  const X100 = [{ field: "x", min: 0, max: 100 }]

  const HALVES: Record<string, Half> = {
    "sk region": sk({ composite: ["region"] }),
    "sk region, uppercase": sk({ composite: ["region"] }, { casing: "uppercase" }),
    "sk region, preserve": sk({ composite: ["region"] }, { casing: "preserve" }),
    "sk region, a collection": sk({ composite: ["region"] }, { collection: "things" }),
    "sk region, clustered": sk(
      { composite: ["region"] },
      { collection: "things", type: "clustered" },
    ),
    "sk tenant": sk({ composite: ["tenant"] }),
    "sk Tenant": sk({ composite: ["Tenant"] }),
    "sk n": sk({ composite: ["n"] }),
    "sk n, preserve": sk({ composite: ["n"] }, { casing: "preserve" }),
    "sk n, uppercase": sk({ composite: ["n"] }, { casing: "uppercase" }),
    "sk big, preserve": sk({ composite: ["big"] }, { casing: "preserve" }),
    "sk big": sk({ composite: ["big"] }),
    "sk n region": sk({ composite: ["n", "region"] }),
    "sk region n": sk({ composite: ["region", "n"] }),
    "pk n": pk(["n"]),
    "pk n, unsharded": pk(["n"], { shards: undefined }),
    "pk region, unsharded": pk(["region"], { shards: undefined }),
    "pk tenant": pk(["tenant"]),
    "pk Tenant": pk(["Tenant"]),
    "pk tenant, by count": pk(["tenant"], { shards: 16 }),
    "pk tenant, previous": pk(["tenant"], { shards: { count: 8, previous: 4 } }),
    "pk tenant, uppercase": pk(["tenant"], { casing: "uppercase" }),
    "pk tenant, a collection": pk(["tenant"], { collection: "things" }),
    "z x 0..100": sk({ zorder: X100 }),
    "z x 0..100 again": sk({ zorder: [{ field: "x", min: 0, max: 100, step: 1 }] }),
    "z x 0..100, uppercase": sk({ zorder: X100 }, { casing: "uppercase" }),
    "z x 0..1000": sk({ zorder: [{ field: "x", min: 0, max: 1000 }] }),
    "z x 0..100 step 5": sk({ zorder: [{ field: "x", min: 0, max: 100, step: 5 }] }),
    "z y 0..100": sk({ zorder: [{ field: "y", min: 0, max: 100 }] }),
    "z x y": sk({
      zorder: [
        { field: "x", min: 0, max: 100 },
        { field: "y", min: 0, max: 100 },
      ],
    }),
    "z y x": sk({
      zorder: [
        { field: "y", min: 0, max: 100 },
        { field: "x", min: 0, max: 100 },
      ],
    }),
    "z string": sk({ zorder: [{ field: "region", bytes: 4 }] }),
    "z string, uppercase": sk({ zorder: [{ field: "region", bytes: 4 }] }, { casing: "uppercase" }),
    "z string longer": sk({ zorder: [{ field: "region", bytes: 5 }] }),
    "z date": sk({ zorder: [{ field: "at", from: "2024-01-01", unit: "days", bits: 12 }] }),
    "z date, spelled out": sk({
      zorder: [{ field: "at", from: "2024-01-01T00:00:00.000Z", unit: "days", bits: 12 }],
    }),
    "z date, another day": sk({
      zorder: [{ field: "at", from: "2024-01-02", unit: "days", bits: 12 }],
    }),
    "z prefix tenant": sk({ prefix: ["tenant"], zorder: X100 }),
    "z prefix tenant, uppercase": sk({ prefix: ["tenant"], zorder: X100 }, { casing: "uppercase" }),
    "z prefix Tenant": sk({ prefix: ["Tenant"], zorder: X100 }),
    "z prefix hashed": sk({ prefix: [{ field: "tenant", hash: 4 }], zorder: X100 }),
    "z prefix n": sk({ prefix: ["n"], zorder: X100 }),
    "z prefix n, uppercase": sk({ prefix: ["n"], zorder: X100 }, { casing: "uppercase" }),
  }

  /** The index a half sits on, every other attribute its own: it can be composed alone. */
  const indexOf = (name: string, { half, def }: Half) => {
    const {
      pk: pkPart,
      sk: skPart,
      ...rest
    } = def as {
      readonly pk?: Record<string, unknown>
      readonly sk?: Record<string, unknown>
    }
    return {
      name,
      pk: { field: `${name}pk`, composite: ["id"], ...(half === "pk" ? pkPart : {}) },
      sk: { field: `${name}sk`, ...(half === "sk" ? skPart : { composite: ["id"] }) },
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    }
  }

  const definitionOf = (a: Half, b: Half) =>
    Entity.make({
      model: Item,
      entityType: "row",
      primaryKey: {
        pk: { field: "pk", composite: ["tenant"] },
        sk: { field: "sk", composite: ["id"] },
      },
      indexes: { a: indexOf("a", a), b: indexOf("b", b) } as never,
    })

  const RECORDS = ["x", "y", "z", "w"].flatMap((id, i) =>
    [-3, 0, 2.5, 1e21].map((n, j) => ({
      id: `${id}${j}`,
      tenant: `Mixed Case %${i}`,
      Tenant: `Other ${j}`,
      region: `Region ${String.fromCharCode(65 + i)}${j} `,
      n,
      big: BigInt(i * 10 - 15),
      x: i * 7 + j,
      y: i + j * 11,
      at: `2024-02-0${i + 1}T00:00:00.000Z`,
    })),
  )

  const text = (value: KeyComposer.KeyValue): string =>
    typeof value === "string" ? value : [...value].join(",")

  /** The bytes each half really composes, for a spread of items. */
  const composed = (
    on: DynamoSchema.DynamoSchema,
    definition: ReturnType<typeof definitionOf>,
    name: "a" | "b",
    half: Half,
  ) =>
    RECORDS.map((record) => {
      const index = definition.indexes[name]!
      return text(
        half.half === "pk"
          ? KeyComposer.composePk(on, "row", index, record)
          : KeyComposer.composeSkValue(on, "row", 1, index, record),
      )
    })

  /** Both halves of a pair moved into one attribute, as a definition would have them. */
  const sharing = (definition: ReturnType<typeof definitionOf>, a: Half, b: Half) => {
    const moved = (index: KeyComposer.IndexDefinition, half: Half) =>
      half.half === "pk"
        ? { ...index, pk: { ...index.pk, field: "shared" } }
        : { ...index, sk: { ...index.sk, field: "shared" } }
    return {
      primary: definition.indexes.primary!,
      a: moved(definition.indexes.a!, a),
      b: moved(definition.indexes.b!, b),
    } as Record<string, KeyComposer.IndexDefinition>
  }

  const names = Object.keys(HALVES)
  const pairs = names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b] as const))

  // The rule against its own truth: compose real items. What it passes must compose the same
  // bytes, so it can't pass what differs. What it refuses with the same bytes must be a
  // difference of casing where nothing is cased, as the rule compares casing itself.
  it.each([
    "lowercase",
    "uppercase",
    "preserve",
  ] as const)("under a %s schema, every pair is refused exactly when the real bytes differ", (casing) => {
    const on = DynamoSchema.make({ name: "truth", version: 1, casing })
    const wrong: Array<string> = []
    for (const [nameA, nameB] of pairs) {
      const a = HALVES[nameA]!
      const b = HALVES[nameB]!
      const definition = definitionOf(a, b)
      const same =
        JSON.stringify(composed(on, definition, "a", a)) ===
        JSON.stringify(composed(on, definition, "b", b))
      let refused = false
      try {
        refuseSharedKeyAttribute(on, "row", sharing(definition, a, b))
      } catch (error) {
        expect(String(error)).toContain("[EDD-9106]")
        refused = true
      }
      const casingDiffers = (a.def.casing ?? casing) !== (b.def.casing ?? casing)
      if (refused ? same && !casingDiffers : !same) {
        wrong.push(`${nameA} / ${nameB}: refused ${refused}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it("Entity.make refuses only what no schema's casing can reconcile", () => {
    const wrong: Array<string> = []
    for (const [nameA, nameB] of pairs) {
      const a = HALVES[nameA]!
      const b = HALVES[nameB]!
      const definition = definitionOf(a, b)
      const indexes = sharing(definition, a, b)
      const refusedBy = (casing: DynamoSchema.Casing) => {
        try {
          refuseSharedKeyAttribute(
            DynamoSchema.make({ name: "any", version: 1, casing }),
            "row",
            indexes,
          )
          return false
        } catch {
          return true
        }
      }
      let refused = false
      try {
        refuseSharedKeyAttributeOnEverySchema("row", indexes)
      } catch {
        refused = true
      }
      const everywhere = refusedBy("lowercase") && refusedBy("uppercase") && refusedBy("preserve")
      if (refused !== everywhere) wrong.push(`${nameA} / ${nameB}: refused ${refused}`)
    }
    expect(wrong).toEqual([])
  })

  const primaryKey = {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["id"] },
  }
  const entity = (indexes: Record<string, unknown>, primary: unknown = primaryKey) =>
    Entity.make({
      model: Item,
      entityType: "Row",
      primaryKey: primary as never,
      indexes: indexes as never,
    })
  const gsi = (name: string, overrides: Record<string, unknown>) => ({
    name,
    pk: { field: `${name}pk`, composite: ["tenant"] },
    sk: { field: `${name}sk`, composite: ["id"] },
    shards: 8,
    ...overrides,
  })

  describe("the shapes that came through a probe", () => {
    it("two composites told apart only by case: one label, two values", () => {
      expect(() =>
        entity({
          a: gsi("a", { pk: { field: "gpk", composite: ["tenant"] } }),
          b: gsi("b", { pk: { field: "gpk", composite: ["Tenant"] } }),
        }),
      ).toThrow("[EDD-9106]")
    })

    it("the same Z-order composite over different ranges", () => {
      expect(() =>
        entity({
          a: gsi("a", { sk: { field: "zsk", zorder: [{ field: "x", min: 0, max: 100 }] } }),
          b: gsi("b", { sk: { field: "zsk", zorder: [{ field: "x", min: 0, max: 1000 }] } }),
        }),
      ).toThrow(/\[EDD-9106\].*Z-order layouts differ/)
    })

    it("a casing one half leaves to the schema: only the table can say", () => {
      const made = entity({
        byTenant: gsi("gsi", { sk: { field: "sk", composite: ["id"] }, casing: "uppercase" }),
      })
      expect(() =>
        refuseSharedKeyAttribute(DynamoSchema.make({ name: "s", version: 1 }), "Row", made.indexes),
      ).toThrow(/\[EDD-9106\].*"lowercase" and "uppercase"/)
      expect(() =>
        refuseSharedKeyAttribute(
          DynamoSchema.make({ name: "s", version: 1, casing: "uppercase" }),
          "Row",
          made.indexes,
        ),
      ).not.toThrow()
    })
  })

  describe("a casing is a difference, whatever it reaches", () => {
    it("identical numeric Z-order halves", () => {
      const zorder = [{ field: "x", min: 0, max: 100 }]
      expect(() =>
        entity({
          a: gsi("a", { sk: { field: "zsk", zorder }, casing: "lowercase" }),
          b: gsi("b", { sk: { field: "zsk", zorder }, casing: "uppercase" }),
        }),
      ).toThrow(/\[EDD-9106\].*"lowercase" and "uppercase"/)
    })

    it("a numeric prefix, and a text one", () => {
      const half = (prefix: string, casing: string) =>
        gsi(casing, {
          sk: { field: "zsk", prefix: [prefix], zorder: [{ field: "x", min: 0, max: 100 }] },
          casing,
        })
      for (const prefix of ["n", "tenant"]) {
        expect(() =>
          entity({ a: half(prefix, "lowercase"), b: half(prefix, "uppercase") }),
        ).toThrow("[EDD-9106]")
      }
    })
  })

  describe("a sort key half and a partition key half build the same text", () => {
    it("over a number or a string", () => {
      const onN = { pk: { field: "pk", composite: ["n"] }, sk: { field: "sk", composite: ["id"] } }
      expect(() =>
        entity({ a: gsi("a", { sk: { field: "pk", composite: ["n"] } }) }, onN),
      ).not.toThrow()
      expect(() =>
        entity({ a: gsi("a", { sk: { field: "pk", composite: ["tenant"] } }) }, primaryKey),
      ).not.toThrow()
    })
  })

  it("two partition keys that write the same text may disagree on what they read", () => {
    const shared = { pk: { field: "gpk", composite: ["tenant"] } }
    expect(() =>
      entity({
        a: gsi("a", { ...shared, shards: { count: 8, previous: 4 } }),
        b: gsi("b", { ...shared, shards: 8 }),
      }),
    ).not.toThrow()
  })
})

describe("composeGsiKeysForUpdatePolicyAware on a sharded index", () => {
  const compose = (
    def: KeyComposer.IndexDefinition,
    payload: Record<string, unknown>,
    keyRecord: Record<string, unknown>,
    options?: {
      readonly removedSet?: ReadonlySet<string>
      readonly onMissingShardSource?: "fail" | "keep"
    },
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
  const sparse: KeyComposer.IndexPolicy = { pk: "sparse", sk: "sparse" }
  const pkOf = (def: KeyComposer.IndexDefinition, record: Record<string, unknown>) =>
    KeyComposer.composePk(schema, "DeviceState", def, record)
  const key = { channel: "c", deviceId: "d" }

  describe("the decision table (design §5)", () => {
    const by = index(byGroup(20))
    const bySparse = index(byGroup(20), { indexPolicy: sparse })

    it("case 1: `by` in `.remove()` drops the partition key half, under both policies", () => {
      for (const def of [by, bySparse]) {
        const { sets, removes } = compose(def, {}, key, { removedSet: new Set(["groupId"]) })
        expect(removes).toContain("gsi5pk")
        expect(sets.gsi5pk).toBeUndefined()
      }
    })

    it("case 1: drops it even when the payload holds the partition key composite", () => {
      const { sets, removes } = compose(by, { tenantId: "t" }, key, {
        removedSet: new Set(["groupId"]),
      })
      expect(removes).toContain("gsi5pk")
      expect(sets.gsi5pk).toBeUndefined()
    })

    it("case 2: a `by`-only update fails under `sparse`: it can't name the new shard", () => {
      expect(() => compose(bySparse, { groupId: "g" }, key)).toThrow("[EDD-9100]")
    })

    it("case 3: `sparse` with the partition key composite explicitly gone drops the half", () => {
      expect(compose(bySparse, { tenantId: null }, key).removes).toContain("gsi5pk")
      expect(compose(bySparse, { tenantId: null, groupId: "g" }, key).removes).toContain("gsi5pk")
      const removed = compose(bySparse, { groupId: "g" }, key, {
        removedSet: new Set(["tenantId"]),
      })
      expect(removed.removes).toContain("gsi5pk")
    })

    it("case 3: `preserve` with the composite in `.remove()` drops the half (cascade)", () => {
      const { removes } = compose(by, { groupId: "g" }, key, { removedSet: new Set(["tenantId"]) })
      expect(removes).toContain("gsi5pk")
    })

    it("case 4: a `by`-only update fails under `preserve`: the shard would go stale (finding 2)", () => {
      expect(() => compose(by, { groupId: "g" }, key)).toThrow("[EDD-9100]")
    })

    it("case 5: `preserve`, can't compose, `by` untouched: noop", () => {
      const def = index(byGroup(20), { pk: { field: "gsi5pk", composite: ["tenantId", "zone"] } })
      expect(compose(def, { zone: "z" }, key).sets.gsi5pk).toBeUndefined()
      expect(compose(def, { zone: "z" }, key).removes).not.toContain("gsi5pk")
    })

    it("case 6: the source present: SET sharded", () => {
      const { sets } = compose(by, { tenantId: "t", groupId: "g" }, key)
      expect(sets.gsi5pk).toBe(pkOf(by, { tenantId: "t", groupId: "g" }))
      expect(sets.gsi5pk).toMatch(/#!20\.\d\d#tenantid_t$/)
    })

    it("case 6: `by` moves the entry to its new shard", () => {
      const shardFor = (groupId: string) => compose(by, { tenantId: "t", groupId }, key).sets.gsi5pk
      // These two hash to different shards of 20.
      expect(shardFor("group-a")).not.toBe(shardFor("group-b"))
    })

    it("case 7: `by` explicitly cleared beside a partition key change under `sparse`: drop", () => {
      expect(compose(bySparse, { tenantId: "t", groupId: null }, key).removes).toContain("gsi5pk")
      expect(compose(bySparse, { tenantId: "t", groupId: undefined }, key).removes).toContain(
        "gsi5pk",
      )
    })

    it("case 7: `by` explicitly cleared under `sparse`, its partition key in `keyRecord`: drop", () => {
      const def = index(byGroup(20), {
        indexPolicy: sparse,
        pk: { field: "gsi5pk", composite: ["channel"] },
      })
      expect(compose(def, { groupId: null }, key).removes).toContain("gsi5pk")
    })

    it("case 8: moving the tenant without `by` fails: the issue's silent fallback", () => {
      expect(() => compose(by, { tenantId: "t" }, key)).toThrow("[EDD-9100]")
      expect(() => compose(bySparse, { tenantId: "t" }, key)).toThrow("[EDD-9100]")
      expect(() => compose(by, { tenantId: "t", groupId: null }, key)).toThrow("[EDD-9100]")
    })

    it("case 8: changing one `by` attribute without the other fails", () => {
      const def = index(
        {
          count: 20,
          by: ["groupId", "deviceId"],
          previous: undefined,
          source: ["groupId", "deviceId"],
        },
        { pk: { field: "gsi5pk", composite: ["channel"] } },
      )
      expect(() => compose(def, { groupId: "g" }, { channel: "c" })).toThrow("[EDD-9100]")
    })

    it("case 9: an update touching nothing it depends on: noop under both policies", () => {
      const inKeyRecord = { pk: { field: "gsi5pk", composite: ["channel"] } }
      for (const policy of [{}, { indexPolicy: sparse }]) {
        const def = index(byGroup(20), { ...inKeyRecord, ...policy })
        const { sets, removes } = compose(def, { status: "on" }, key)
        // The partition key half. `deviceId` in the key record wakes the sort key
        // half, and `sparse` drops its hole there exactly as on an unsharded index.
        expect(sets.gsi5pk).toBeUndefined()
        expect(removes).not.toContain("gsi5pk")
      }
    })

    it("an unrelated update on a half it doesn't touch is skipped", () => {
      for (const def of [by, bySparse]) {
        const { sets, removes } = compose(def, { status: "on" }, key)
        expect(sets.gsi5pk).toBeUndefined()
        expect(removes).not.toContain("gsi5pk")
      }
    })

    it('`onMissingShardSource: "keep"` turns each failure into a noop', () => {
      const keep = { onMissingShardSource: "keep" } as const
      for (const payload of [
        { groupId: "g" },
        { tenantId: "t" },
        { tenantId: "t", groupId: null },
      ]) {
        const { sets, removes } = compose(by, payload, key, keep)
        expect(sets.gsi5pk).toBeUndefined()
        expect(removes).not.toContain("gsi5pk")
      }
      expect(compose(bySparse, { groupId: "g" }, key, keep).removes).not.toContain("gsi5pk")
    })

    it("never writes an unsharded key", () => {
      const unsharded = KeyComposer.composePk(schema, "DeviceState", index(undefined), {
        tenantId: "t",
      })
      const payloads = [
        {},
        { tenantId: "t" },
        { groupId: "g" },
        { tenantId: "t", groupId: "g" },
        { tenantId: "t", groupId: null },
        { tenantId: null, groupId: "g" },
        { deviceId: "d2" },
      ]
      for (const def of [by, bySparse, index(defaultSource())]) {
        for (const payload of payloads) {
          for (const removedSet of [undefined, new Set(["groupId"]), new Set(["tenantId"])]) {
            try {
              const { sets } = compose(def, payload, key, removedSet ? { removedSet } : undefined)
              expect(sets.gsi5pk).not.toBe(unsharded)
              if (sets.gsi5pk !== undefined) expect(sets.gsi5pk).toContain("#!20.")
            } catch (error) {
              expect(isShardSourceError(error)).toBe(true)
            }
          }
        }
      }
    })
  })

  describe("a default source is not a gate dependency", () => {
    const def = index(defaultSource(20))

    it("an update to a composite of the source that isn't a composite of this half", () => {
      const { sets } = compose(def, { groupId: "g", deviceId: "d" }, key)
      expect(sets.gsi5pk).toBeUndefined()
      expect(sets.gsi5sk).toBe("$fleet-db#v1#devicestate#groupid_g#deviceid_d")
    })

    it("the partition key composite composes from the key record's source", () => {
      const { sets } = compose(def, { tenantId: "t" }, key)
      expect(sets.gsi5pk).toBe(pkOf(def, { tenantId: "t", ...key }))
    })

    it("a key record without the source fails rather than falling back", () => {
      expect(() => compose(def, { tenantId: "t" }, {})).toThrow("[EDD-9100]")
    })
  })

  describe("canonical shapes", () => {
    it("shape 1 — multi-writer: each writer composes only its own half", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi6",
        pk: { field: "gsi6pk", composite: ["accountId"] },
        sk: { field: "gsi6sk", composite: ["alertState", "timestamp"] },
        shards: { count: 8, by: undefined, previous: undefined, source: ["deviceId"] },
      }
      const telemetry = compose(def, { alertState: "ok", timestamp: 5 }, { deviceId: "d" })
      expect(telemetry.sets.gsi6pk).toBeUndefined()
      expect(telemetry.removes).toEqual([])
      expect(telemetry.sets.gsi6sk).toContain("alertstate_ok")

      const enrichment = compose(def, { accountId: "a" }, { deviceId: "d" })
      expect(enrichment.sets.gsi6pk).toBe(pkOf(def, { accountId: "a", deviceId: "d" }))
      expect(enrichment.sets.gsi6sk).toBeUndefined()
      expect(enrichment.removes).toEqual([])
    })

    it("shape 1 with `by`: the telemetry writer's `by` needs the account too", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi6",
        pk: { field: "gsi6pk", composite: ["accountId"] },
        sk: { field: "gsi6sk", composite: ["alertState", "timestamp"] },
        shards: { count: 8, by: ["alertState"], previous: undefined, source: ["alertState"] },
      }
      // Its partition key half can't be composed, so it fails rather than go stale.
      expect(() => compose(def, { alertState: "ok", timestamp: 5 }, { deviceId: "d" })).toThrow(
        "[EDD-9100]",
      )
      // A sort key composite outside `by` still leaves the partition key alone.
      const onlyTime = compose(def, { timestamp: 5 }, { deviceId: "d" })
      expect(onlyTime.sets.gsi6pk).toBeUndefined()
      expect(onlyTime.removes).toEqual([])
    })

    it("shape 2 — PK-composites-only: SET on every write, idempotent, from the key record (#43)", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi2",
        pk: { field: "gsi2pk", composite: ["channel"] },
        sk: { field: "gsi2sk", composite: ["deviceId"] },
        shards: { count: 4, by: undefined, previous: undefined, source: ["channel", "deviceId"] },
      }
      const first = compose(def, { status: "on" }, key)
      const second = compose(def, { other: 1 }, key)
      expect(first.sets.gsi2pk).toBe(pkOf(def, key))
      expect(first.sets.gsi2pk).toMatch(/#!4\.\d#channel_c$/)
      expect(second.sets).toEqual(first.sets)
    })

    it("shape 3 — hierarchical: a truncated key still carries the marker", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi3",
        pk: { field: "gsi3pk", composite: ["region", "country"] },
        sk: { field: "gsi3sk", composite: ["city", "site"] },
        shards: { count: 4, by: undefined, previous: undefined, source: ["deviceId"] },
      }
      const { sets, removes } = compose(
        def,
        { region: "r", city: "x" },
        { deviceId: "d" },
        {
          removedSet: new Set(["country", "site"]),
        },
      )
      expect(removes).toEqual([])
      const marker = shardMarker(4, shardOf(["d"], 4))
      expect(sets.gsi3pk).toBe(`$fleet-db#v1#devicestate#${marker}#region_r`)
      expect(sets.gsi3sk).toBe("$fleet-db#v1#devicestate#city_x")
    })

    it("shape 3 with `by`: a truncated sort key with `by` still present moves the shard", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi3",
        pk: { field: "gsi3pk", composite: ["tenantId"] },
        sk: { field: "gsi3sk", composite: ["region", "country", "city"] },
        shards: { count: 4, by: ["region"], previous: undefined, source: ["region"] },
      }
      const { sets } = compose(
        def,
        { tenantId: "t", region: "r", country: "c" },
        {},
        {
          removedSet: new Set(["city"]),
        },
      )
      expect(sets.gsi3pk).toBe(pkOf(def, { tenantId: "t", region: "r" }))
      expect(sets.gsi3sk).toBe("$fleet-db#v1#devicestate#region_r#country_c")
    })

    it("shape 4 — hole: sparse drops, preserve leaves, cascade overrides", () => {
      const pk = { field: "gsi5pk", composite: ["zone", "tenantId"] }
      const preserve = index(defaultSource(), { pk })
      const dropped = index(defaultSource(), { pk, indexPolicy: sparse })
      expect(compose(preserve, { tenantId: "t" }, key).sets.gsi5pk).toBeUndefined()
      expect(compose(preserve, { tenantId: "t" }, key).removes).toEqual([])
      expect(compose(dropped, { tenantId: "t" }, key).removes).toContain("gsi5pk")
      const cascade = compose(preserve, { tenantId: "t" }, key, { removedSet: new Set(["zone"]) })
      expect(cascade.removes).toContain("gsi5pk")
    })

    it("shape 5 — all composites mutable: the payload carries them", () => {
      const def = index(defaultSource())
      const { sets } = compose(def, { tenantId: "t", groupId: "g", deviceId: "d" }, key)
      expect(sets.gsi5pk).toBe(pkOf(def, { tenantId: "t", ...key }))
      expect(sets.gsi5sk).toBe("$fleet-db#v1#devicestate#groupid_g#deviceid_d")
    })

    it("shape 6 — empty sort key half: always evaluated, beside the sharded partition key (#46)", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi7",
        pk: { field: "gsi7pk", composite: ["deviceBinding"] },
        sk: { field: "gsi7sk", composite: [] },
        shards: { count: 4, by: undefined, previous: undefined, source: ["deviceId"] },
      }
      const untouched = compose(def, { status: "on" }, { deviceId: "d" })
      expect(untouched.sets).toEqual({ gsi7sk: "$fleet-db#v1#devicestate" })
      const bound = compose(def, { deviceBinding: "b" }, { deviceId: "d" })
      expect(bound.sets.gsi7pk).toBe(pkOf(def, { deviceBinding: "b", deviceId: "d" }))
      expect(bound.sets.gsi7sk).toBe("$fleet-db#v1#devicestate")
    })

    describe("Z-order sort keys", () => {
      class Listing extends Schema.Class<Listing>("Listing")({
        listingId: Schema.String,
        region: Schema.String,
        agencyId: Schema.String,
        price: Schema.Number,
        bedrooms: Schema.Number,
      }) {}
      const zorder = [
        { field: "price" as const, min: 0, max: 1000, step: 1 },
        { field: "bedrooms" as const, min: 0, max: 15, step: 1 },
      ]
      const Listings = Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: {
          pk: { field: "pk", composite: ["listingId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byFacets: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["region"] },
            sk: { field: "gsi1sk", zorder },
            shards: 4,
          },
          byAgency: {
            name: "gsi2",
            pk: { field: "gsi2pk", composite: ["region"] },
            sk: { field: "gsi2sk", prefix: ["agencyId"], zorder },
            shards: 4,
          },
        },
      })
      const composeZ = (
        def: KeyComposer.IndexDefinition,
        payload: Record<string, unknown>,
        keyRecord: Record<string, unknown>,
      ) =>
        KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          "Listing",
          1,
          { primary: Listings.indexes.primary, gsi: def },
          payload,
          keyRecord,
        )

      it("shape 7: a sharded partition key beside the bytes; untouched halves skipped", () => {
        const def = Listings.indexes.byFacets
        const full = composeZ(def, { region: "r", price: 5, bedrooms: 2 }, { listingId: "l" })
        expect(full.sets.gsi1pk).toMatch(/^\$fleet-db#v1#listing#!4\.\d#region_r$/)
        expect(full.sets.gsi1sk).toBeInstanceOf(Uint8Array)
        const dimensions = composeZ(def, { price: 5, bedrooms: 2 }, { listingId: "l" })
        expect(dimensions.sets.gsi1pk).toBeUndefined()
        expect(dimensions.sets.gsi1sk).toBeInstanceOf(Uint8Array)
      })

      it("shape 8: a prefix change isn't a shard change without `by`", () => {
        const def = Listings.indexes.byAgency
        const { sets, removes } = composeZ(
          def,
          { agencyId: "a", price: 5, bedrooms: 2 },
          { listingId: "l" },
        )
        expect(sets.gsi2pk).toBeUndefined()
        expect(sets.gsi2sk).toBeInstanceOf(Uint8Array)
        expect(removes).toEqual([])
      })
    })
  })

  describe("new degenerate fixtures", () => {
    it("9a — an empty partition key half with `by`: no longer a constant", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi9",
        pk: { field: "gsi9pk", composite: [] },
        sk: { field: "gsi9sk", composite: ["groupId", "deviceId"] },
        shards: { count: 8, by: ["groupId"], previous: undefined, source: ["groupId"] },
      }
      // Without `by` in scope the half is skipped, not composed as a constant.
      const unrelated = compose(def, { status: "on" }, { deviceId: "d" })
      expect(unrelated.sets.gsi9pk).toBeUndefined()
      expect(unrelated.removes).toEqual([])
      // With it, the half has no composites to wait for, so a `by`-only update
      // composes: it is the one `by`-only update that can.
      const moved = compose(def, { groupId: "g" }, { deviceId: "d" })
      expect(moved.sets.gsi9pk).toBe(pkOf(def, { groupId: "g" }))
      expect(moved.sets.gsi9pk).toMatch(/^\$fleet-db#v1#devicestate#!8\.\d$/)
      expect(compose(def, {}, {}, { removedSet: new Set(["groupId"]) }).removes).toContain("gsi9pk")
    })

    it("9b — a `by` attribute also in the primary key: not touched by being addressed", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi9",
        pk: { field: "gsi9pk", composite: ["tenantId"] },
        sk: { field: "gsi9sk", composite: ["deviceId"] },
        shards: { count: 8, by: ["deviceId"], previous: undefined, source: ["deviceId"] },
      }
      // `deviceId` arrives through the key record on every write. That isn't this
      // writer changing it, so the half stays skipped and no failure is raised.
      const untouched = compose(def, { status: "on" }, { deviceId: "d" })
      expect(untouched.sets.gsi9pk).toBeUndefined()
      expect(untouched.removes).toEqual([])
      // Naming the tenant composes it from the key record's `by`.
      const moved = compose(def, { tenantId: "t" }, { deviceId: "d" })
      expect(moved.sets.gsi9pk).toBe(pkOf(def, { tenantId: "t", deviceId: "d" }))
    })

    it("9c — an empty partition key half with a default source: varies per item", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi9",
        pk: { field: "gsi9pk", composite: [] },
        sk: { field: "gsi9sk", composite: ["status"] },
        shards: { count: 8, by: undefined, previous: undefined, source: ["deviceId"] },
      }
      const one = compose(def, { status: "on" }, { deviceId: "device-1" })
      const two = compose(def, { status: "on" }, { deviceId: "device-2" })
      expect(one.sets.gsi9pk).toBe(pkOf(def, { deviceId: "device-1" }))
      expect(two.sets.gsi9pk).toBe(pkOf(def, { deviceId: "device-2" }))
      expect(one.sets.gsi9pk).not.toBe(two.sets.gsi9pk)
      // A caller without the source (the partial knowledge of a pre-check): no
      // composition and no failure.
      const unknown = compose(def, { status: "on" }, {})
      expect(unknown.sets.gsi9pk).toBeUndefined()
      expect(unknown.removes).toEqual([])
    })

    describe("9d — a `by` attribute after a composite the update can't supply", () => {
      const def: KeyComposer.IndexDefinition = {
        index: "gsi9",
        pk: { field: "gsi9pk", composite: ["tenant"] },
        sk: { field: "gsi9sk", composite: ["region", "group"] },
        shards: { count: 8, by: ["group"], previous: undefined, source: ["group"] },
      }
      const skOf = (record: Record<string, unknown>) =>
        KeyComposer.composeSk(schema, "DeviceState", 1, def, record)

      it("refuses: the shard would move and the sort key stay at the old value", () => {
        expect(() => compose(def, { tenant: "t", group: "b" }, { deviceId: "d" })).toThrow(
          /\[EDD-9100\].*its sort key can't be composed without "region"/,
        )
      })

      it("a complete update moves both, together", () => {
        const all = { tenant: "t", region: "r", group: "b" }
        const { sets, removes } = compose(def, all, { deviceId: "d" })
        expect(sets.gsi9pk).toBe(pkOf(def, all))
        expect(sets.gsi9sk).toBe(skOf(all))
        expect(removes).toEqual([])
      })

      it("a key record holding the rest composes too", () => {
        const { sets } = compose(def, { group: "b" }, { tenant: "t", region: "r" })
        expect(sets.gsi9pk).toBe(pkOf(def, { tenant: "t", group: "b" }))
        expect(sets.gsi9sk).toBe(skOf({ region: "r", group: "b" }))
      })

      it("under `sparse` the sort key leaves, so there is nothing to disagree with", () => {
        const { sets, removes } = compose(
          { ...def, indexPolicy: { sk: "sparse" } },
          { tenant: "t", group: "b" },
          {},
        )
        expect(sets.gsi9pk).toBe(pkOf(def, { tenant: "t", group: "b" }))
        expect(removes).toEqual(["gsi9sk"])
      })

      it("removing the gap cascades, so there is nothing to disagree with", () => {
        const { sets, removes } = compose(
          def,
          { tenant: "t", group: "b" },
          {},
          {
            removedSet: new Set(["region"]),
          },
        )
        expect(sets.gsi9pk).toBe(pkOf(def, { tenant: "t", group: "b" }))
        expect(removes).toEqual(["gsi9sk"])
      })

      it('`onMissingShardSource: "keep"` leaves both halves: a pre-check, or a move', () => {
        const { sets, removes } = compose(
          def,
          { tenant: "t", group: "b" },
          { tenant: "t", group: "b" },
          { onMissingShardSource: "keep" },
        )
        expect(sets).toEqual({})
        expect(removes).toEqual([])
      })

      it("a partition key alone, with no `by` value named, leaves the stored sort key", () => {
        const { sets } = compose(def, { tenant: "t2" }, { group: "a" })
        expect(sets.gsi9pk).toBe(pkOf(def, { tenant: "t2", group: "a" }))
        expect(sets.gsi9sk).toBeUndefined()
      })

      it("an update of the gap alone truncates, naming no `by` value: the shard stays", () => {
        const { sets } = compose(def, { region: "r2" }, {})
        expect(sets.gsi9pk).toBeUndefined()
        expect(sets.gsi9sk).toBe("$fleet-db#v1#devicestate#region_r2")
      })

      it("`by` before the gap truncates after it: the sort key still holds its value", () => {
        const leading: KeyComposer.IndexDefinition = {
          ...def,
          sk: { field: "gsi9sk", composite: ["group", "region"] },
        }
        const { sets } = compose(leading, { tenant: "t", group: "b" }, {})
        expect(sets.gsi9pk).toBe(pkOf(leading, { tenant: "t", group: "b" }))
        expect(sets.gsi9sk).toBe("$fleet-db#v1#devicestate#group_b")
      })

      it("every `by` attribute named, with a gap between: refused", () => {
        const several: KeyComposer.IndexDefinition = {
          ...def,
          sk: { field: "gsi9sk", composite: ["region", "zone", "group"] },
          shards: {
            count: 8,
            by: ["region", "group"],
            previous: undefined,
            source: ["region", "group"],
          },
        }
        expect(() => compose(several, { tenant: "t", region: "r", group: "b" }, {})).toThrow(
          /\[EDD-9100\].*"zone"/,
        )
      })
    })
  })

  describe("rekey's helpers", () => {
    it("composeStoredPk: the full and truncated keys, or nothing", () => {
      const def = index(defaultSource(4), { pk: { field: "gsi5pk", composite: ["a", "b"] } })
      const stored = (record: Record<string, unknown>) =>
        KeyComposer.composeStoredPk(schema, "DeviceState", def, record)
      expect(stored({ a: "1", b: "2", ...key })).toBe(pkOf(def, { a: "1", b: "2", ...key }))
      expect(stored({ a: "1", ...key })).toMatch(/#!4\.\d#a_1$/)
      expect(stored({ b: "2", ...key })).toBeUndefined() // a hole
      expect(stored(key)).toBeUndefined() // no leading composite
      expect(stored({ a: "1", b: "2" })).toBeUndefined() // no source
    })

    it("isCurrentShardLayout: this count's marker, any shard", () => {
      const def = index(defaultSource(20))
      const holds = (stored: string) =>
        KeyComposer.isCurrentShardLayout(schema, "DeviceState", def, stored)
      expect(holds("$fleet-db#v1#devicestate#!20.07#tenantid_t")).toBe(true)
      expect(holds("$fleet-db#v1#devicestate#!4.1#tenantid_t")).toBe(false)
      expect(holds("$fleet-db#v1#devicestate#!200.007#tenantid_t")).toBe(false)
      expect(holds("$fleet-db#v1#devicestate#tenantid_t")).toBe(false)
      expect(
        KeyComposer.isCurrentShardLayout(
          schema,
          "DeviceState",
          index(undefined),
          "$fleet-db#v1#devicestate#!20.07#tenantid_t",
        ),
      ).toBe(false)
    })
  })
})

describe("assertCollectionShardsAgreement", () => {
  const member = (key: string, shards: KeyComposer.IndexShards | undefined) => ({
    key,
    index: index(shards),
  })

  it("accepts members agreeing on count and previous, with different `by`", () => {
    expect(() =>
      KeyComposer.assertCollectionShardsAgreement("c", [
        member("a", defaultSource(4, 1)),
        member("b", byGroup(4, 1)),
      ]),
    ).not.toThrow()
    expect(() =>
      KeyComposer.assertCollectionShardsAgreement("c", [
        member("a", undefined),
        member("b", undefined),
      ]),
    ).not.toThrow()
  })

  it.each([
    ["count", defaultSource(4), defaultSource(8)],
    ["sharded and unsharded", defaultSource(4), undefined],
    ["previous", defaultSource(4, 1), defaultSource(4, 2)],
    ["previous declared by one", defaultSource(4, 1), defaultSource(4)],
  ])("EDD-9103: %s", (_name, a, b) => {
    expect(() =>
      KeyComposer.assertCollectionShardsAgreement("c", [member("a", a), member("b", b)]),
    ).toThrow("[EDD-9103]")
  })
})
