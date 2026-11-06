/**
 * `internal/KeyText136.ts` composes exactly the key text 1.36.0 wrote.
 *
 * `fixtures/key-text-1.36.0.json` holds golden vectors generated ONCE from the
 * PUBLISHED packages — `effect-dynamodb@1.36.0` and
 * `@effect-dynamodb/schema@1.36.0` (with `effect@4.0.0`), installed outside the
 * repo and run by a scratch script (never a dependency of this repo). The
 * script drew values and records from a seeded PRNG (mulberry32, seed
 * 0x1360171) over every code point U+0000–U+0026, letters in both cases,
 * digits, non-ASCII BMP and astral characters, numbers, bigints, booleans and
 * dates, plus fixed edge cases (`-3`, `2.5`, `1e21`, `NaN`, `±Infinity`, 39-
 * and 45-digit bigints, `new york`, `a#b`, `50%`, …), and recorded what the
 * 1.36.0 composer returned for each input. The fixture's `generated` field
 * says the same. Do not regenerate it from this repo: its whole point is that
 * the bytes came from 1.36.0.
 *
 * JSON has no bigint, Date or DateTime, so each value is tagged with its type
 * (`{ t: "bigint", v: "42" }`) and revived here.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as KeyText136 from "../src/internal/KeyText136.js"
import * as KeyComposer from "../src/KeyComposer.js"

type Tagged = { readonly t: string; readonly v: string }

const revive = ({ t, v }: Tagged): unknown => {
  switch (t) {
    case "string":
      return v
    case "number":
      return Number(v)
    case "bigint":
      return BigInt(v)
    case "boolean":
      return v === "true"
    case "date":
      return new Date(v)
    case "datetime":
      return DateTime.makeUnsafe(v)
  }
  throw new Error(`unknown tag ${t}`)
}
const revived = (record: Record<string, Tagged>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, revive(v)]))

type Schema = DynamoSchema.DynamoSchema
type Index = KeyComposer.IndexDefinition

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/key-text-1.36.0.json", import.meta.url)), "utf8"),
) as {
  readonly generated: string
  readonly serializeValue: ReadonlyArray<{ readonly value: Tagged; readonly text: string }>
  readonly keys: ReadonlyArray<{
    readonly schema: Schema
    readonly entityType: string
    readonly entityVersion: number
    readonly index: Index
    readonly record: Record<string, Tagged>
    readonly leading: number
    readonly pk: string
    readonly sk: string
    readonly prefix: string
    readonly beginsWith: string | null
  }>
  readonly allKeys: ReadonlyArray<{
    readonly schema: Schema
    readonly entityType: string
    readonly entityVersion: number
    readonly indexes: Record<string, Index>
    readonly record: Record<string, Tagged>
    readonly keys: Record<string, string>
  }>
  readonly eventSk: ReadonlyArray<{
    readonly currentSk: string
    readonly orderBy: Tagged
    readonly casing: DynamoSchema.Casing
    readonly eventSk: string
    readonly prefix: string
  }>
  readonly unique: ReadonlyArray<{
    readonly schema: Schema
    readonly constraintName: string
    readonly values: ReadonlyArray<Tagged>
    readonly pk: string
    readonly sk: string
  }>
  readonly history: ReadonlyArray<{
    readonly schema: Schema
    readonly primary: Index
    readonly record: Record<string, Tagged>
    readonly liveSk: string
    readonly version: number
    readonly timestamp: string
    readonly item: string | null
    readonly versionKey: string
    readonly deletedKey: string
  }>
  readonly vectorPartition: ReadonlyArray<{
    readonly schema: Schema
    readonly index: {
      readonly partition: ReadonlyArray<string>
      readonly casing?: DynamoSchema.Casing
    }
    readonly record: Record<string, Tagged>
    readonly partition: string | undefined
  }>
  readonly collection: ReadonlyArray<{
    readonly schema: Schema
    readonly composite: ReadonlyArray<string>
    readonly record: Record<string, Tagged>
    readonly values: ReadonlyArray<Tagged>
    readonly casing: DynamoSchema.Casing | null
    readonly collectionKey: string
    readonly key: string
    readonly streamKey: string
  }>
}

describe("KeyText136 — golden vectors from the published 1.36.0", () => {
  it("the fixture says how it was generated and covers every key kind", () => {
    expect(vectors.generated).toContain("effect-dynamodb@1.36.0")
    expect(vectors.serializeValue.length).toBeGreaterThan(300)
    expect(vectors.keys.length).toBeGreaterThan(100)
    for (const kind of [
      vectors.allKeys,
      vectors.eventSk,
      vectors.unique,
      vectors.history,
      vectors.vectorPartition,
      vectors.collection,
    ]) {
      expect(kind.length).toBeGreaterThan(10)
    }
  })

  it("serializeValue", () => {
    for (const { value, text } of vectors.serializeValue) {
      expect(KeyText136.serializeValue(revive(value)), JSON.stringify(value)).toBe(text)
    }
  })

  it("partition keys, sort keys, sort key prefixes and begins_with operands", () => {
    for (const v of vectors.keys) {
      const record = revived(v.record)
      const partial = { ...record }
      for (const name of v.index.sk.composite.slice(v.leading)) delete partial[name]
      const at = JSON.stringify(v)
      expect(KeyText136.composePk(v.schema, v.entityType, v.index, record), at).toBe(v.pk)
      expect(
        KeyText136.composeSk(v.schema, v.entityType, v.entityVersion, v.index, record),
        at,
      ).toBe(v.sk)
      expect(
        KeyText136.composeSortKeyPrefix(v.schema, v.entityType, v.entityVersion, v.index, partial),
        at,
      ).toBe(v.prefix)
      if (v.beginsWith !== null) {
        expect(
          KeyText136.composeSortKeyBeginsWith(
            v.schema,
            v.entityType,
            v.entityVersion,
            v.index,
            partial,
          ),
          at,
        ).toBe(v.beginsWith)
      }
    }
  })

  it("a key read back: one reading, which composes it and the values' 1.37 key", () => {
    const kinds: Record<string, KeyText136.ValueKind> = {
      number: "number",
      bigint: "bigint",
      boolean: "boolean",
    }
    for (const v of vectors.keys) {
      const at = JSON.stringify(v)
      const record = revived(v.record)
      const read = KeyText136.readIndexKeys(
        v.schema,
        v.entityType,
        v.entityVersion,
        v.index,
        { [v.index.pk.field]: v.pk, [v.index.sk.field]: v.sk },
        (attr) => kinds[v.record[attr]!.t] ?? "string",
      )
      expect(read, at).toBeDefined()
      expect(
        KeyText136.composeIndexKeys(v.schema, v.entityType, v.entityVersion, v.index, read!),
        at,
      ).toEqual({ [v.index.pk.field]: v.pk, [v.index.sk.field]: v.sk })
      let current: Record<string, unknown> | undefined
      try {
        current = KeyComposer.composeIndexKeys(
          v.schema,
          v.entityType,
          v.entityVersion,
          v.index,
          record,
        )
      } catch {
        // `NaN` has no 1.37 key ([EDD-9096]).
        continue
      }
      expect(
        KeyComposer.composeIndexKeys(v.schema, v.entityType, v.entityVersion, v.index, read!),
        at,
      ).toEqual(current)
    }
  })

  it("every index's keys, sparse GSIs left out", () => {
    for (const v of vectors.allKeys) {
      expect(
        KeyText136.composeAllKeys(
          v.schema,
          v.entityType,
          v.entityVersion,
          v.indexes,
          revived(v.record),
        ),
        JSON.stringify(v),
      ).toEqual(v.keys)
    }
  })

  it("time-series event keys carry the encoded orderBy value", () => {
    for (const v of vectors.eventSk) {
      expect(KeyText136.composeEventSk(v.currentSk, revive(v.orderBy), v.casing)).toBe(v.eventSk)
      // The prefix is structural: unchanged in 1.37.
      expect(KeyComposer.composeEventSkPrefix(v.currentSk, v.casing)).toBe(v.prefix)
    }
  })

  it("unique-constraint sentinels", () => {
    for (const v of vectors.unique) {
      expect(
        KeyText136.composeUniqueKey(v.schema, "User", v.constraintName, v.values.map(revive)),
        JSON.stringify(v),
      ).toEqual({ pk: v.pk, sk: v.sk })
    }
  })

  it("version snapshot and tombstone keys, through the 1.36 live sort key", () => {
    for (const v of vectors.history) {
      const liveSk = KeyText136.composeSk(v.schema, "Doc", 1, v.primary, revived(v.record))
      expect(liveSk).toBe(v.liveSk)
      // The item segment and the history layout are structural: unchanged.
      const item = KeyComposer.composeHistoryItemSegment(v.schema, "Doc", 1, v.primary, liveSk)
      expect(item ?? null).toBe(v.item)
      const options = item === undefined ? undefined : { item }
      expect(DynamoSchema.composeVersionKey(v.schema, "Doc", v.version, options)).toBe(v.versionKey)
      expect(DynamoSchema.composeDeletedKey(v.schema, "Doc", v.timestamp, options)).toBe(
        v.deletedKey,
      )
    }
  })

  it("vector index partitions", () => {
    for (const v of vectors.vectorPartition) {
      expect(
        KeyText136.tryComposeVectorPartition(v.schema, "Doc", v.index, revived(v.record)),
      ).toBe(v.partition)
    }
  })

  it("aggregate and EventStore keys: collection, list and stream keys", () => {
    for (const v of vectors.collection) {
      const options = v.casing === null ? undefined : { casing: v.casing }
      const composites = KeyText136.extractComposites(v.composite, revived(v.record))
      expect(DynamoSchema.composeCollectionKey(v.schema, "Match", composites, options)).toBe(
        v.collectionKey,
      )
      expect(
        DynamoSchema.composeKey(
          v.schema,
          "Innings",
          v.values.flatMap((value, j) => [`d${j}`, KeyText136.serializeValue(revive(value))]),
          options,
        ),
      ).toBe(v.key)
      expect(DynamoSchema.composeKey(v.schema, "Account", composites, options)).toBe(v.streamKey)
    }
  })
})

describe("KeyText136 — what changed in 1.37", () => {
  const schema = DynamoSchema.make({ name: "app", version: 1 })
  const primary: Index = {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["seq"] },
  }
  const current = (record: Record<string, unknown>) =>
    KeyComposer.composeIndexKeys(schema, "Item", 1, primary, record)

  it("a key whose text did not change has no 1.36 key to fall back to", () => {
    for (const record of [
      { tenant: "acme", seq: "a" },
      { tenant: "acme", seq: 0 },
      { tenant: "acme", seq: Number.MAX_SAFE_INTEGER },
      { tenant: "acme", seq: 99_999_999_999_999_999_999_999_999_999_999_999_999n },
    ]) {
      expect(
        KeyText136.changedPrimaryKey(schema, "Item", 1, primary, record, current(record)),
      ).toBeUndefined()
    }
  })

  it("a changed number or an escaped key value has its 1.36 key", () => {
    for (const record of [
      { tenant: "new york", seq: 42 },
      { tenant: "acme", seq: -3 },
      { tenant: "acme", seq: 2.5 },
      { tenant: "acme", seq: 1e16 },
      { tenant: "acme", seq: -1n },
      { tenant: "acme", seq: "new york" },
      { tenant: -1, seq: "a" },
    ]) {
      expect(
        KeyText136.changedPrimaryKey(schema, "Item", 1, primary, record, current(record)),
      ).toEqual(KeyText136.composeIndexKeys(schema, "Item", 1, primary, record))
    }
    expect(
      KeyText136.changedPrimaryKey(
        schema,
        "Item",
        1,
        primary,
        { tenant: "acme", seq: -3 },
        current({ tenant: "acme", seq: -3 }),
      ),
    ).toEqual({ pk: "$app#v1#item#tenant_acme", sk: "$app#v1#item#seq_00000000000000-3" })
  })

  it("legacyKeys: false turns the fallback off", () => {
    const off = DynamoSchema.make({ name: "app", version: 1, legacyKeys: false })
    expect(KeyText136.enabled(off)).toBe(false)
    expect(KeyText136.enabled(schema)).toBe(true)
    expect(schema).toEqual({ name: "app", version: 1, casing: "lowercase" })
    const record = { tenant: "acme", seq: -3 }
    expect(
      KeyText136.changedPrimaryKey(off, "Item", 1, primary, record, current(record)),
    ).toBeUndefined()
  })

  it("a query's pins and its eq / beginsWith bound under 1.36's text", () => {
    const byPlace: Index = {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenant"] },
      sk: { field: "gsi1sk", composite: ["city", "seq"] },
    }
    const full = { tenant: "acme", city: "new york", seq: -3 }
    const sk136 = KeyText136.composeSk(schema, "Item", 1, byPlace, full)
    // The pins: a complete key is `eq`; a partial one the prefix and what's below it.
    expect(KeyText136.composeSortKeyCondition(schema, "Item", 1, byPlace, full)).toEqual({
      eq: sk136,
    })
    const pinned = KeyText136.composeSortKeyCondition(schema, "Item", 1, byPlace, {
      city: "new york",
    })
    expect(pinned).toEqual({
      between: ["$app#v1#item#city_new york", "$app#v1#item#city_new york#\uFFFF"],
    })
    expect(sk136.startsWith("$app#v1#item#city_new york#")).toBe(true)
    // On the primary index, nothing is truncated: the prefix ending on the delimiter.
    const { index: _gsi, ...primary } = byPlace
    expect(
      KeyText136.composeSortKeyCondition(schema, "Item", 1, primary, { city: "new york" }),
    ).toEqual({ beginsWith: "$app#v1#item#city_new york#" })
    expect(
      KeyText136.composeBoundCondition(schema, "Item", 1, primary, {}, "city", { eq: "new york" }),
    ).toEqual({ beginsWith: "$app#v1#item#city_new york#" })
    // Text that did not change composes as the current composer does.
    const same = { city: "boston" }
    expect(KeyText136.composeSortKeyCondition(schema, "Item", 1, byPlace, same)).toEqual(
      KeyComposer.composeSortKeyCondition(schema, "Item", 1, byPlace, same),
    )
    // A bound: `eq` on the last composite is its key; on another, its subtree.
    const bound = (field: string, value: { eq: unknown } | { beginsWith: unknown }) =>
      KeyText136.composeBoundCondition(
        schema,
        "Item",
        1,
        byPlace,
        field === "seq" ? { city: "new york" } : {},
        field,
        value,
      )
    expect(bound("seq", { eq: -3 })).toEqual({ eq: sk136 })
    expect(bound("city", { eq: "new york" })).toEqual(pinned)
    // A string `beginsWith` is a text prefix; a number has none, so it is `eq`.
    expect(bound("city", { beginsWith: "new " })).toEqual({
      beginsWith: "$app#v1#item#city_new ",
    })
    expect(bound("seq", { beginsWith: -3 })).toEqual({ eq: sk136 })
  })

  it("a key is read back only as the 1.36 text of exactly one set of values", () => {
    const kindOf = (attr: string): KeyText136.ValueKind => (attr === "seq" ? "number" : "string")
    const read = (pk: string, sk: string) =>
      KeyText136.readIndexKeys(schema, "Item", 1, primary, { pk, sk }, kindOf)
    // 1.36's padded text of a number, and a sort key value as it was stored, cased.
    expect(read("$app#v1#item#tenant_acme", "$app#v1#item#seq_00000000000000-3")).toEqual({
      tenant: "acme",
      seq: -3,
    })
    // 1.37's text of a changed number is no 1.36 text.
    const moved = current({ tenant: "acme", seq: -3 })
    expect(read(String(moved.pk), String(moved.sk))).toBeUndefined()
    // A string holding the delimiter and the next label reads two ways.
    const two: Index = {
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "sk", composite: ["a", "b"] },
    }
    expect(
      KeyText136.readIndexKeys(
        schema,
        "Item",
        1,
        two,
        { pk: "$app#v1#item#tenant_t", sk: "$app#v1#item#a_x#b_y#b_z" },
        () => "string",
      ),
    ).toBeUndefined()
    expect(
      KeyText136.readIndexKeys(
        schema,
        "Item",
        1,
        two,
        { pk: "$app#v1#item#tenant_t", sk: "$app#v1#item#a_x#b_y" },
        () => "string",
      ),
    ).toEqual({ tenant: "t", a: "x", b: "y" })
    // Another entity's key, or text past the key, is not this one's.
    expect(read("$app#v1#other#tenant_acme", "$app#v1#item#seq_0000000000000001")).toBeUndefined()
    expect(read("$app#v1#item#tenant_acme", "$app#v1#item#seq_0000000000000001#x")).toBeUndefined()
  })

  it("a Z-order index has no 1.36 key", () => {
    const indexes: Record<string, Index> = {
      primary,
      near: {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["tenant"] },
        sk: {
          field: "gsi1sk",
          composite: ["x", "y"],
          zorderHalf: { prefix: [], dimensions: [], layout: undefined },
        },
      },
    }
    expect(
      Object.keys(
        KeyText136.composeAllKeys(schema, "Item", 1, indexes, { tenant: "a", seq: 1, x: 1, y: 2 }),
      ),
    ).toEqual(["pk", "sk"])
  })
})
