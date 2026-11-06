/**
 * An inverted index (#183, canonical shape 14) and every other half stored in a table key
 * attribute: one rule composes both roles, with `escapeKeys` on or off, so they build the
 * same text with no case of their own. Entity-level and connected coverage is in
 * `packages/effect-dynamodb/test/helpers/InvertedIndexes.ts`.
 */

import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { refuseSharedKeyAttribute } from "../src/internal/SharedKeyAttribute.js"
import * as KeyComposer from "../src/KeyComposer.js"

const schema = DynamoSchema.make({ name: "halves", version: 1, escapeKeys: true })

class Row extends Schema.Class<Row>("Row")({
  tenant: Schema.String,
  id: Schema.String,
  group: Schema.String,
  kind: Schema.String,
  region: Schema.String,
  n: Schema.Number,
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["tenant", "id"] },
  sk: { field: "sk", composite: ["group", "kind"] },
}

const make = (indexes: Record<string, unknown>) =>
  Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey: primaryKey as never,
    indexes: indexes as never,
  })

const inverted = {
  name: "gsi",
  pk: { field: "sk", composite: ["group", "kind"] },
  sk: { field: "pk", composite: ["tenant", "id"] },
}

const VALUES = [
  "plain",
  "u 1",
  "a b",
  "50%",
  "a#b",
  "MiXeD Case",
  "Zürich 東京",
  "x!y",
  "\u0000",
  "~",
]

const recordOf = (value: string) => ({
  tenant: value,
  id: `${value}1`,
  group: `${value}2`,
  kind: `${value}3`,
  region: "r",
})

describe("what stays refused", () => {
  it.each([
    [
      "other composites",
      { ...inverted, pk: { field: "sk", composite: ["region"] } },
      /sort key and index "x"'s partition key.*"sk"/,
    ],
    [
      "the same composites in another order",
      { ...inverted, pk: { field: "sk", composite: ["kind", "group"] } },
      /sort key and index "x"'s partition key.*"sk"/,
    ],
    [
      "fewer composites",
      { ...inverted, sk: { field: "pk", composite: ["tenant"] } },
      /partition key and index "x"'s sort key.*"pk"/,
    ],
    ["a collection's label", { ...inverted, collection: "things" }, /"(pk|sk)"/],
    [
      "a clustered collection's label",
      { ...inverted, collection: "things", type: "clustered" },
      /"(pk|sk)"/,
    ],
    [
      "a sharded partition key",
      {
        name: "gsi",
        pk: { field: "sk", composite: ["group", "kind"] },
        sk: { field: "gsk", composite: ["region"] },
        shards: 8,
      },
      /shard marker/,
    ],
    [
      "a Z-order half",
      {
        name: "gsi",
        pk: { field: "gpk", composite: ["region"] },
        sk: { field: "pk", zorder: [{ field: "n", min: 0, max: 100 }] },
      },
      /binary Z-order/,
    ],
  ])("%s", (_name, index, why) => {
    expect(() => make({ x: index })).toThrow("[EDD-9106]")
    expect(() => make({ x: index })).toThrow(why)
  })

  it("a casing no schema can reconcile", () => {
    expect(() =>
      Entity.make({
        model: Row,
        entityType: "Row",
        primaryKey: { ...primaryKey, casing: "uppercase" } as never,
        indexes: { x: { ...inverted, casing: "preserve" } } as never,
      }),
    ).toThrow(/\[EDD-9106\].*"uppercase" and "preserve"/)
  })

  it("a casing only the schema can judge: Table.make's half of the check", () => {
    const made = make({ x: { ...inverted, casing: "uppercase" } })
    expect(() => refuseSharedKeyAttribute(schema, "Row", made.indexes)).toThrow(
      /\[EDD-9106\].*"lowercase" and "uppercase"/,
    )
    expect(() =>
      refuseSharedKeyAttribute(
        DynamoSchema.make({ name: "halves", version: 1, casing: "uppercase" }),
        "Row",
        made.indexes,
      ),
    ).not.toThrow()
  })
})

describe("an inverted index builds the table's text, with the flag on or off", () => {
  const made = make({ inverted })
  const index = made.indexes.inverted!
  const primary = made.indexes.primary!

  describe.each(
    (["lowercase", "uppercase", "preserve"] as const).flatMap((casing) =>
      [true, false].map((escapeKeys) => ({
        casing,
        escapeKeys,
        on: DynamoSchema.make({ name: "halves", version: 1, casing, escapeKeys }),
      })),
    ),
  )("under a $casing schema, escapeKeys $escapeKeys", ({ on }) => {
    it.each(VALUES)("the full key, for %j", (value) => {
      const record = recordOf(value)
      const pk = KeyComposer.composePk(on, "Row", primary, record)
      const sk = KeyComposer.composeSk(on, "Row", 1, primary, record)
      expect(KeyComposer.composePk(on, "Row", index, record)).toBe(sk)
      expect(KeyComposer.composeSk(on, "Row", 1, index, record)).toBe(pk)
      expect(KeyComposer.composeSkValue(on, "Row", 1, index, record)).toBe(pk)
      expect(KeyComposer.composeStoredPk(on, "Row", index, record)).toBe(sk)
      expect(KeyComposer.tryComposeStructuralKeys(on, "Row", 1, index, record)).toEqual({
        pk: sk,
        sk: pk,
      })
      expect(KeyComposer.composeSortKeyPrefix(on, "Row", 1, index, record)).toBe(pk)
      expect(KeyComposer.composeSortKeyBeginsWith(on, "Row", 1, index, record)).toBe(pk)
      expect(KeyComposer.composeSortKeyCondition(on, "Row", 1, index, record)).toEqual({ eq: pk })
      expect(KeyComposer.composeReadPartitions(on, "Row", index, record).partitions).toEqual([sk])
    })

    it.each(VALUES)("composeAllKeys holds the table's text, for %j", (value) => {
      const record = recordOf(value)
      expect(KeyComposer.composeAllKeys(on, "Row", 1, made.indexes, record)).toEqual(
        KeyComposer.composeIndexKeys(on, "Row", 1, primary, record),
      )
    })
  })

  it("an update sets none of it", () => {
    for (const on of [schema, DynamoSchema.make({ name: "h", version: 1, escapeKeys: false })]) {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        on,
        "Row",
        1,
        made.indexes,
        { region: "r" },
        recordOf("a b"),
      )
      expect(result).toEqual({ sets: {}, removes: [] })
    }
  })

  it("off, each role's text is the other's too", () => {
    const off = DynamoSchema.make({ name: "halves", version: 1, escapeKeys: false })
    const record = recordOf("a b")
    expect(KeyComposer.composePk(off, "Row", index, record)).toBe(
      KeyComposer.composeSk(off, "Row", 1, primary, record),
    )
    expect(KeyComposer.composeSk(off, "Row", 1, index, record)).toBe(
      KeyComposer.composePk(off, "Row", primary, record),
    )
  })
})

describe("one entity can't use a physical index twice (EDD-9108)", () => {
  const own = (field: string) => ({
    name: "gsi1",
    pk: { field: `${field}pk`, composite: ["tenant"] },
    sk: { field: `${field}sk`, composite: ["id"] },
  })

  it("over the same fields", () => {
    expect(() => make({ a: own("g"), b: own("g") })).toThrow(/\[EDD-9108\].*"a" and "b".*"gsi1"/)
  })

  it("over other fields", () => {
    expect(() => make({ a: own("g"), b: { ...own("h"), name: "gsi1" } })).toThrow("[EDD-9108]")
  })

  it("two indexes are fine", () => {
    expect(() => make({ a: own("g"), b: { ...own("h"), name: "gsi2" } })).not.toThrow()
  })

  it("two entities can share one", () => {
    const other = Entity.make({
      model: Row,
      entityType: "Other",
      primaryKey: primaryKey as never,
      indexes: { a: own("g") } as never,
    })
    expect(() => make({ a: own("g") })).not.toThrow()
    expect(other.indexes.a).toBeDefined()
  })
})

/**
 * Every definition's key text, spelled out under both settings. `off` is byte for byte what the
 * real 1.36.0 package composes, strings and numbers alike.
 */
describe("every definition's bytes", () => {
  const record = {
    tenant: "T 1",
    id: "I%2",
    group: "G#3",
    kind: "K 4",
    region: "Zürich R",
    n: -3,
  }
  const off = DynamoSchema.make({ name: "halves", version: 1, escapeKeys: false })
  const SHAPES: ReadonlyArray<
    readonly [string, Record<string, unknown>, Record<string, string>, Record<string, string>]
  > = [
    [
      "an index of its own",
      {
        name: "gsi",
        pk: { field: "gpk", composite: ["tenant", "id"] },
        sk: { field: "gsk", composite: ["group", "kind"] },
      },
      {
        gpk: "$halves#v1#row#tenant_t%201#id_i%252",
        gsk: "$halves#v1#row#group_g%233#kind_k%204",
      },
      {
        gpk: "$halves#v1#row#tenant_t 1#id_i%2",
        gsk: "$halves#v1#row#group_g#3#kind_k 4",
      },
    ],
    [
      "a local index",
      {
        name: "lsi",
        pk: { field: "pk", composite: ["tenant", "id"] },
        sk: { field: "lsk", composite: ["group", "region"] },
      },
      { lsk: "$halves#v1#row#group_g%233#region_zürich%20r" },
      { lsk: "$halves#v1#row#group_g#3#region_zürich r" },
    ],
    [
      "a sort key shared with the table",
      {
        name: "gsi",
        pk: { field: "gpk", composite: ["region"] },
        sk: { field: "sk", composite: ["group", "kind"] },
      },
      { gpk: "$halves#v1#row#region_zürich%20r" },
      { gpk: "$halves#v1#row#region_zürich r" },
    ],
    [
      "numbers",
      {
        name: "gsi",
        pk: { field: "gpk", composite: ["n"] },
        sk: { field: "gsk", composite: ["n"] },
      },
      {
        gpk: "$halves#v1#row#n_-9999999999999996:",
        gsk: "$halves#v1#row#n_-9999999999999996:",
      },
      {
        gpk: "$halves#v1#row#n_00000000000000-3",
        gsk: "$halves#v1#row#n_00000000000000-3",
      },
    ],
    [
      "a collection",
      {
        name: "gsi",
        collection: "things",
        pk: { field: "gpk", composite: ["tenant"] },
        sk: { field: "gsk", composite: ["group", "kind"] },
      },
      {
        gpk: "$halves#v1#things#tenant_t%201",
        gsk: "$halves#v1#row_1#group_g%233#kind_k%204",
      },
      {
        gpk: "$halves#v1#things#tenant_t 1",
        gsk: "$halves#v1#row_1#group_g#3#kind_k 4",
      },
    ],
    [
      "a clustered collection",
      {
        name: "gsi",
        collection: "things",
        type: "clustered",
        pk: { field: "gpk", composite: ["tenant"] },
        sk: { field: "gsk", composite: ["group", "kind"] },
      },
      {
        gpk: "$halves#v1#things#tenant_t%201",
        gsk: "$halves#v1#things#row_1#group_g%233#kind_k%204",
      },
      {
        gpk: "$halves#v1#things#tenant_t 1",
        gsk: "$halves#v1#things#row_1#group_g#3#kind_k 4",
      },
    ],
  ]

  it.each(SHAPES)("%s", (_name, index, escaped, unescaped) => {
    const made = make({ x: index })
    expect(KeyComposer.composeAllKeys(schema, "Row", 1, made.indexes, record)).toEqual({
      pk: "$halves#v1#row#tenant_t%201#id_i%252",
      sk: "$halves#v1#row#group_g%233#kind_k%204",
      ...escaped,
    })
    expect(KeyComposer.composeAllKeys(off, "Row", 1, made.indexes, record)).toEqual({
      pk: "$halves#v1#row#tenant_t 1#id_i%2",
      sk: "$halves#v1#row#group_g#3#kind_k 4",
      ...unescaped,
    })
  })

  it("a value with nothing to escape composes the same under both", () => {
    const plain = { tenant: "T1", id: "I2", group: "G3", kind: "K4", region: "Zürich", n: 7 }
    for (const [, index] of SHAPES) {
      const made = make({ x: index })
      expect(KeyComposer.composeAllKeys(off, "Row", 1, made.indexes, plain)).toEqual(
        KeyComposer.composeAllKeys(schema, "Row", 1, made.indexes, plain),
      )
    }
  })
})
