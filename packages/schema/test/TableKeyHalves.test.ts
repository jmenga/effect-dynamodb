/**
 * An index half that is a half of the table's key (#183, D62, canonical shape 14): which
 * halves are, what the composers do with one, and that nothing else changes. Entity-level
 * and connected coverage is in `packages/effect-dynamodb/test/helpers/TableKeyHalves.ts`.
 */

import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as KeyText136 from "../src/internal/KeyText136.js"
import { refuseSharedKeyAttribute } from "../src/internal/SharedKeyAttribute.js"
import * as KeyComposer from "../src/KeyComposer.js"

const schema = DynamoSchema.make({ name: "halves", version: 1 })

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

const VALUES = ["plain", "a b", "50%", "a#b", "MiXeD Case", "Zürich 東京", "x!y", "\u0000", "~"]

const recordOf = (value: string) => ({
  tenant: value,
  id: `${value}1`,
  group: `${value}2`,
  kind: `${value}3`,
  region: "r",
})

describe("which halves are the table's key", () => {
  it("an inverted index: both", () => {
    expect(make({ inverted }).indexes.inverted?.tableKey).toEqual({ pk: "sk", sk: "pk" })
  })

  it("a local index: its partition key", () => {
    const made = make({
      local: {
        name: "lsi",
        pk: { field: "pk", composite: ["tenant", "id"] },
        sk: { field: "lsk", composite: ["region"] },
      },
    })
    expect(made.indexes.local?.tableKey).toEqual({ pk: "pk" })
  })

  it("a sort key shared with the table", () => {
    const made = make({
      shared: {
        name: "gsi",
        pk: { field: "gpk", composite: ["region"] },
        sk: { field: "sk", composite: ["group", "kind"] },
      },
    })
    expect(made.indexes.shared?.tableKey).toEqual({ sk: "sk" })
  })

  it("an index in attributes of its own: neither", () => {
    const made = make({
      own: {
        name: "gsi",
        pk: { field: "gpk", composite: ["tenant", "id"] },
        sk: { field: "gsk", composite: ["group", "kind"] },
      },
    })
    expect(made.indexes.own?.tableKey).toBeUndefined()
    const all: Readonly<Record<string, KeyComposer.IndexDefinition>> = made.indexes
    expect(all.primary?.tableKey).toBeUndefined()
  })
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
      "a sharded index's sort key across kinds",
      {
        name: "gsi",
        pk: { field: "gpk", composite: ["region"] },
        sk: { field: "pk", composite: ["tenant", "id"] },
        shards: 8,
      },
      /a sort key escapes what a partition key doesn't/,
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
    const fields = Row.fields as unknown as Record<string, Schema.Top>
    expect(() => refuseSharedKeyAttribute(schema, "Row", made.indexes, fields)).toThrow(
      /\[EDD-9106\].*"lowercase" and "uppercase"/,
    )
    expect(() =>
      refuseSharedKeyAttribute(
        DynamoSchema.make({ name: "halves", version: 1, casing: "uppercase" }),
        "Row",
        made.indexes,
        fields,
      ),
    ).not.toThrow()
  })
})

describe("an inverted index composes the table's text", () => {
  const made = make({ inverted })
  const index = made.indexes.inverted!
  const primary = made.indexes.primary!

  describe.each(
    (["lowercase", "uppercase", "preserve"] as const).map((casing) => ({
      casing,
      on: DynamoSchema.make({ name: "halves", version: 1, casing }),
    })),
  )("under a $casing schema", ({ on }) => {
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

    it.each(VALUES)("a prefix, for %j", (value) => {
      const record = { tenant: value, group: "g", kind: "k" }
      const text = KeyComposer.composeSkPrefixUpTo(on, "Row", 1, index, { ...record, id: "i" }, 1)
      const label = DynamoSchema.applyCasing("tenant", on.casing)
      expect(text.endsWith(`${label}_${DynamoSchema.applyCasing(value, on.casing)}`)).toBe(true)
      expect(KeyComposer.composeSortKeyPrefix(on, "Row", 1, index, record)).toBe(text)
      expect(KeyComposer.composeSortKeyBeginsWith(on, "Row", 1, index, record)).toBe(`${text}#`)
      expect(KeyComposer.composeSortKeyCondition(on, "Row", 1, index, record)).toEqual({
        beginsWith: `${text}#`,
      })
    })
  })

  it("a partition key prefix, for a row missing a trailing composite", () => {
    const text = KeyComposer.composeStoredPk(schema, "Row", index, { group: "a b" })
    expect(text).toBe("$halves#v1#row#group_a%20b")
  })

  it("the table's own text doesn't change: its partition key unescaped, its sort key escaped", () => {
    const keys = KeyComposer.composeIndexKeys(schema, "Row", 1, primary, recordOf("a b"))
    expect(keys).toEqual({
      pk: "$halves#v1#row#tenant_a b#id_a b1",
      sk: "$halves#v1#row#group_a%20b2#kind_a%20b3",
    })
  })

  describe("nothing is written through it", () => {
    it("composeIndexKeys leaves out what is the table's", () => {
      expect(KeyComposer.composeIndexKeys(schema, "Row", 1, index, recordOf("a b"))).toEqual({})
      const local = make({
        local: {
          name: "lsi",
          pk: { field: "pk", composite: ["tenant", "id"] },
          sk: { field: "lsk", composite: ["region"] },
        },
      }).indexes.local!
      expect(
        Object.keys(KeyComposer.composeIndexKeys(schema, "Row", 1, local, recordOf("a"))),
      ).toEqual(["lsk"])
    })

    it.each(VALUES)("composeAllKeys holds the table's text, for %j", (value) => {
      const record = recordOf(value)
      expect(KeyComposer.composeAllKeys(schema, "Row", 1, made.indexes, record)).toEqual(
        KeyComposer.composeIndexKeys(schema, "Row", 1, primary, record),
      )
    })

    it("nor by an update, or the 1.36 text it left", () => {
      const result = KeyComposer.composeGsiKeysForUpdatePolicyAware(
        schema,
        "Row",
        1,
        made.indexes,
        { region: "r" },
        recordOf("a b"),
      )
      expect(result).toEqual({ sets: {}, removes: [] })
    })
  })

  it("a partial pin never takes a longer sibling: rows aren't truncated here", () => {
    const pin = { group: "g", kind: "k", tenant: "new" }
    expect(KeyComposer.sortKeyTruncates(index)).toBe(false)
    expect(KeyComposer.composeSortKeyCondition(schema, "Row", 1, index, pin)).toEqual({
      beginsWith: "$halves#v1#row#tenant_new#",
    })
    expect(KeyText136.composeSortKeyCondition(schema, "Row", 1, index, pin)).toEqual({
      beginsWith: "$halves#v1#row#tenant_new#",
    })
    const bound = KeyText136.composeBoundCondition(schema, "Row", 1, index, {}, "tenant", {
      eq: "new",
    })
    expect(bound).toEqual({ beginsWith: "$halves#v1#row#tenant_new#" })
  })

  it("1.36's text has no halves, so it isn't changed", () => {
    const record = recordOf("a b")
    expect(KeyText136.composePk(schema, "Row", index, record)).toBe(
      KeyText136.composeSk(schema, "Row", 1, primary, record),
    )
    expect(KeyText136.composeSk(schema, "Row", 1, index, record)).toBe(
      KeyText136.composePk(schema, "Row", primary, record),
    )
  })
})

/**
 * The key text of definitions with no half across kinds, spelled out: this rule must not
 * move a byte of any of them, and 1.37.0 stored the same keys.
 */
describe("every other definition composes the bytes it did", () => {
  const record = {
    tenant: "T 1",
    id: "I%2",
    group: "G#3",
    kind: "K 4",
    region: "Zürich R",
    n: -3,
  }
  const SHAPES: ReadonlyArray<
    readonly [string, Record<string, unknown>, Record<string, string>, string | undefined]
  > = [
    [
      "an index of its own",
      {
        name: "gsi",
        pk: { field: "gpk", composite: ["tenant", "id"] },
        sk: { field: "gsk", composite: ["group", "kind"] },
      },
      {
        gpk: "$halves#v1#row#tenant_t 1#id_i%2",
        gsk: "$halves#v1#row#group_g%233#kind_k%204",
      },
      "$halves#v1#row#group_g%233#",
    ],
    [
      "a local index",
      {
        name: "lsi",
        pk: { field: "pk", composite: ["tenant", "id"] },
        sk: { field: "lsk", composite: ["group", "region"] },
      },
      { lsk: "$halves#v1#row#group_g%233#region_zürich%20r" },
      "$halves#v1#row#group_g%233#",
    ],
    [
      "a sort key shared with the table",
      {
        name: "gsi",
        pk: { field: "gpk", composite: ["region"] },
        sk: { field: "sk", composite: ["group", "kind"] },
      },
      { gpk: "$halves#v1#row#region_zürich r" },
      "$halves#v1#row#group_g%233#",
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
      undefined,
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
        gpk: "$halves#v1#things#tenant_t 1",
        gsk: "$halves#v1#row_1#group_g%233#kind_k%204",
      },
      undefined,
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
        gpk: "$halves#v1#things#tenant_t 1",
        gsk: "$halves#v1#things#row_1#group_g%233#kind_k%204",
      },
      undefined,
    ],
  ]

  it.each(SHAPES)("%s", (_name, index, golden, subtree) => {
    const made = make({ x: index })
    const x = made.indexes.x!
    const keys = KeyComposer.composeAllKeys(schema, "Row", 1, made.indexes, record)
    expect(keys).toEqual({
      pk: "$halves#v1#row#tenant_t 1#id_i%2",
      sk: "$halves#v1#row#group_g%233#kind_k%204",
      ...golden,
    })
    if (subtree !== undefined) {
      const prefix = subtree.slice(0, -1)
      expect(
        KeyComposer.composeSortKeyCondition(schema, "Row", 1, x, { group: record.group }),
      ).toEqual({ between: [prefix, `${prefix}#${KeyComposer.SORT_KEY_MAX}`] })
    }
  })
})
