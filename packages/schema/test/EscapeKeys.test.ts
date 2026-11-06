/**
 * `DynamoSchema.make({ escapeKeys })` (#183): one rule for every key, full on or full off.
 *
 * Off, string text is byte for byte what the published 1.36.0 composed (`fixtures/
 * key-text-1.36.0.json`, see `KeyText136.test.ts` for how it was generated), and numbers keep the
 * encoding 1.37 gave them. On, a value with nothing to escape composes the same bytes.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as KeyText136 from "../src/internal/KeyText136.js"
import * as KeyComposer from "../src/KeyComposer.js"

type Tagged = { readonly t: string; readonly v: string }
type Schema = DynamoSchema.DynamoSchema
type Index = KeyComposer.IndexDefinition

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

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/key-text-1.36.0.json", import.meta.url)), "utf8"),
) as {
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
}

/** Did the value's text stay as 1.36 wrote it? Only a number's can have changed. */
const unchanged = (value: unknown): boolean => {
  try {
    return KeyComposer.serializeValue(value) === KeyText136.serializeValue(value)
  } catch {
    return false
  }
}

/** Does `value`'s text hold nothing to escape, in any casing? */
const nothingToEscape = (value: unknown): boolean =>
  unchanged(value) &&
  (["lowercase", "uppercase", "preserve"] as const).every((casing) => {
    const text = KeyComposer.serializeValue(value)
    return KeyComposer.escapeKeyText(text, casing) === DynamoSchema.applyCasing(text, casing)
  })

const off = (schema: Schema): Schema => ({ ...schema, escapeKeys: false })

/** Each setting, with the records whose text it must keep as 1.36 wrote it. */
const SETTINGS = [
  { name: "off, any string", at: off, keeps: unchanged },
  { name: "on, a value with nothing to escape", at: (s: Schema) => s, keeps: nothingToEscape },
] as const

describe("key text against the published 1.36.0", () => {
  for (const { name, at, keeps } of SETTINGS) {
    describe(name, () => {
      const keptRecord = (record: Record<string, unknown>) => Object.values(record).every(keeps)

      it("partition keys, sort keys, prefixes and begins_with operands", () => {
        let compared = 0
        for (const v of vectors.keys) {
          const record = revived(v.record)
          if (!keptRecord(record)) continue
          compared++
          const schema = at(v.schema)
          const partial = { ...record }
          for (const attr of v.index.sk.composite.slice(v.leading)) delete partial[attr]
          const label = JSON.stringify(v)
          expect(KeyComposer.composePk(schema, v.entityType, v.index, record), label).toBe(v.pk)
          expect(
            KeyComposer.composeSk(schema, v.entityType, v.entityVersion, v.index, record),
            label,
          ).toBe(v.sk)
          expect(
            KeyComposer.composeSortKeyPrefix(
              schema,
              v.entityType,
              v.entityVersion,
              v.index,
              partial,
            ),
            label,
          ).toBe(v.prefix)
          if (v.beginsWith !== null) {
            expect(
              KeyComposer.composeSortKeyBeginsWith(
                schema,
                v.entityType,
                v.entityVersion,
                v.index,
                partial,
              ),
              label,
            ).toBe(v.beginsWith)
          }
        }
        expect(compared).toBeGreaterThan(20)
      })

      it("every index's keys, a sparse index left out", () => {
        let compared = 0
        for (const v of vectors.allKeys) {
          const record = revived(v.record)
          if (!keptRecord(record)) continue
          compared++
          expect(
            KeyComposer.composeAllKeys(
              at(v.schema),
              v.entityType,
              v.entityVersion,
              v.indexes,
              record,
            ),
            JSON.stringify(v),
          ).toEqual(v.keys)
        }
        expect(compared).toBeGreaterThan(3)
      })

      it("a time-series event's sort key", () => {
        const base = DynamoSchema.make({ name: "app", version: 1 })
        let compared = 0
        for (const v of vectors.eventSk) {
          const orderBy = revive(v.orderBy)
          if (!keeps(orderBy)) continue
          compared++
          expect(KeyComposer.composeEventSk(at(base), v.currentSk, orderBy, v.casing)).toBe(
            v.eventSk,
          )
        }
        expect(compared).toBeGreaterThan(5)
      })

      it("a vector index's partition", () => {
        let compared = 0
        for (const v of vectors.vectorPartition) {
          if (v.partition === undefined) continue
          const record = revived(v.record)
          if (!keptRecord(record)) continue
          compared++
          expect(
            KeyComposer.composeVectorPartition(at(v.schema), "Doc", v.index, record),
            JSON.stringify(v),
          ).toBe(v.partition)
        }
        expect(compared).toBeGreaterThan(3)
      })
    })
  }
})

describe("what the flag changes", () => {
  const on = DynamoSchema.make({ name: "app", version: 1 })
  const flagOff = DynamoSchema.make({ name: "app", version: 1, escapeKeys: false })
  const index: Index = {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["label"] },
  }

  it("is left off a schema unless it turns escaping off", () => {
    expect(on.escapeKeys).toBeUndefined()
    expect(DynamoSchema.make({ name: "app", version: 1, escapeKeys: true }).escapeKeys).toBe(
      undefined,
    )
    expect(flagOff.escapeKeys).toBe(false)
  })

  it("escapes every key half, or none", () => {
    const record = { tenant: "a b", label: "x#y" }
    expect(KeyComposer.composePk(on, "E", index, record)).toBe("$app#v1#e#tenant_a%20b")
    expect(KeyComposer.composeSk(on, "E", 1, index, record)).toBe("$app#v1#e#label_x%23y")
    expect(KeyComposer.composePk(flagOff, "E", index, record)).toBe("$app#v1#e#tenant_a b")
    expect(KeyComposer.composeSk(flagOff, "E", 1, index, record)).toBe("$app#v1#e#label_x#y")
  })

  it("covers strings: a number's encoding from 1.37 stays either way", () => {
    const record = { tenant: -3, label: 2.5 }
    const pk = (schema: Schema) => KeyComposer.composePk(schema, "E", index, record)
    const sk = (schema: Schema) => KeyComposer.composeSk(schema, "E", 1, index, record)
    expect(pk(flagOff)).toBe(pk(on))
    expect(sk(flagOff)).toBe(sk(on))
    expect(pk(flagOff)).toBe(`$app#v1#e#tenant_${KeyComposer.serializeValue(-3)}`)
    expect(pk(flagOff)).not.toBe(`$app#v1#e#tenant_${KeyText136.serializeValue(-3)}`)
  })

  it("keeps the shard marker before every value, and the shard the value hashes to", () => {
    const sharded: Index = {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenant"] },
      sk: { field: "gsi1sk", composite: ["label"] },
      shards: { count: 8, by: undefined, previous: undefined, source: ["tenant"] },
    }
    const record = { tenant: "a b", label: "x" }
    const escaped = KeyComposer.composePk(on, "E", sharded, record)
    const raw = KeyComposer.composePk(flagOff, "E", sharded, record)
    expect(escaped).toMatch(/^\$app#v1#e#![0-9]+\.[0-9]+#tenant_a%20b$/)
    expect(raw).toMatch(/^\$app#v1#e#![0-9]+\.[0-9]+#tenant_a b$/)
    // The hash reads the value, not the key's text: a shard doesn't depend on the flag.
    expect(escaped.split("#tenant_")[0]).toBe(raw.split("#tenant_")[0])
  })

  it("gives a value holding an escape its own key, on; off it's a literal", () => {
    const pk = (schema: Schema, tenant: string) =>
      KeyComposer.composePk(schema, "E", index, { tenant })
    expect(pk(on, "foo bar")).not.toBe(pk(on, "foo%20bar"))
    expect(pk(flagOff, "foo bar")).not.toBe(pk(flagOff, "foo%20bar"))
    expect(pk(on, "foo%20bar")).toBe("$app#v1#e#tenant_foo%2520bar")
    expect(pk(flagOff, "foo%20bar")).toBe("$app#v1#e#tenant_foo%20bar")
  })

  it("escapes a partition key truncated at its last present composite, or doesn't", () => {
    const hierarchy: Index = {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["region", "area"] },
      sk: { field: "gsi1sk", composite: ["id"] },
    }
    const record = { region: "a b", id: "x" }
    expect(KeyComposer.composeStoredPk(on, "E", hierarchy, record)).toBe("$app#v1#e#region_a%20b")
    expect(KeyComposer.composeStoredPk(flagOff, "E", hierarchy, record)).toBe(
      "$app#v1#e#region_a b",
    )
    expect(KeyComposer.tryComposeStructuralKeys(on, "E", 1, hierarchy, record)?.pk).toBe(
      "$app#v1#e#region_a%20b",
    )
    expect(KeyComposer.tryComposeStructuralKeys(flagOff, "E", 1, hierarchy, record)?.pk).toBe(
      "$app#v1#e#region_a b",
    )
  })

  it("escapes a vector partition on both its composers, or doesn't", () => {
    const index = { partition: ["tenant"] }
    const record = { tenant: "a b" }
    for (const compose of [
      KeyComposer.composeVectorPartition,
      KeyComposer.tryComposeVectorPartition,
    ]) {
      expect(compose(on, "E", index, record)).toBe("$app#v1#e#tenant_a%20b")
      expect(compose(flagOff, "E", index, record)).toBe("$app#v1#e#tenant_a b")
    }
  })

  it("has no 1.36 spelling to read alongside, off: it composes that text already", () => {
    expect(KeyText136.canSpell(on)).toBe(true)
    expect(KeyText136.canSpell(flagOff)).toBe(false)
    expect(KeyText136.schema137(on).escapeKeys).toBe(false)
    expect(KeyComposer.composePk(KeyText136.schema137(on), "E", index, { tenant: "a b" })).toBe(
      "$app#v1#e#tenant_a b",
    )
  })
})

/**
 * The canonical GSI shapes (`CLAUDE.md`), composing values that hold what a key escapes. Each
 * shape's outcome doesn't depend on the flag: only the text of what's composed does.
 */
describe("the canonical GSI shapes, at the composer, under both settings", () => {
  const halves = (pk: ReadonlyArray<string>, sk: ReadonlyArray<string>): Index => ({
    index: "gsi",
    pk: { field: "gpk", composite: [...pk] },
    sk: { field: "gsk", composite: [...sk] },
  })
  const on = DynamoSchema.make({ name: "s", version: 1 })
  const flagOff = DynamoSchema.make({ name: "s", version: 1, escapeKeys: false })

  const compose = (
    schema: Schema,
    index: Index,
    payload: Record<string, unknown>,
    keyRecord: Record<string, unknown>,
    removed?: ReadonlyArray<string>,
  ) =>
    KeyComposer.composeGsiKeysForUpdatePolicyAware(
      schema,
      "E",
      1,
      { gsi: index },
      payload,
      keyRecord,
      removed === undefined ? undefined : { removedSet: new Set(removed) },
    )

  const shapes: ReadonlyArray<{
    readonly name: string
    readonly index: Index
    readonly payload: Record<string, unknown>
    readonly keyRecord: Record<string, unknown>
    readonly removed?: ReadonlyArray<string>
    readonly on: { readonly sets: Record<string, string>; readonly removes: ReadonlyArray<string> }
    readonly off: { readonly sets: Record<string, string>; readonly removes: ReadonlyArray<string> }
  }> = [
    {
      name: "1, multi-writer: the writer's half alone",
      index: halves(["owner"], ["state", "at"]),
      payload: { owner: "a b" },
      keyRecord: { id: "1" },
      on: { sets: { gpk: "$s#v1#e#owner_a%20b" }, removes: [] },
      off: { sets: { gpk: "$s#v1#e#owner_a b" }, removes: [] },
    },
    {
      name: "2, PK-composites-only: both halves, from the key record",
      index: halves(["channel"], ["deviceId"]),
      payload: { note: "n" },
      keyRecord: { channel: "c d", deviceId: "x#y" },
      on: {
        sets: { gpk: "$s#v1#e#channel_c%20d", gsk: "$s#v1#e#deviceid_x%23y" },
        removes: [],
      },
      off: {
        sets: { gpk: "$s#v1#e#channel_c d", gsk: "$s#v1#e#deviceid_x#y" },
        removes: [],
      },
    },
    {
      name: "3, hierarchical: a removed level truncates",
      index: halves(["region"], ["country", "city"]),
      payload: { region: "r s", country: "5%" },
      keyRecord: { id: "1" },
      removed: ["city"],
      on: {
        sets: { gpk: "$s#v1#e#region_r%20s", gsk: "$s#v1#e#country_5%25" },
        removes: [],
      },
      off: {
        sets: { gpk: "$s#v1#e#region_r s", gsk: "$s#v1#e#country_5%" },
        removes: [],
      },
    },
    {
      name: "4, a hole: nothing to compose, the half stays",
      index: halves(["zone", "hub"], ["status"]),
      payload: { hub: "h i" },
      keyRecord: { id: "1" },
      on: { sets: {}, removes: [] },
      off: { sets: {}, removes: [] },
    },
    {
      name: "5, all mutable: the payload composes both",
      index: halves(["tenant"], ["group", "status"]),
      payload: { tenant: "t u", group: "g#h", status: "on" },
      keyRecord: { id: "1" },
      on: {
        sets: { gpk: "$s#v1#e#tenant_t%20u", gsk: "$s#v1#e#group_g%23h#status_on" },
        removes: [],
      },
      off: {
        sets: { gpk: "$s#v1#e#tenant_t u", gsk: "$s#v1#e#group_g#h#status_on" },
        removes: [],
      },
    },
    {
      name: "6, an empty half: the constant prefix",
      index: halves(["binding"], []),
      payload: { binding: "b c" },
      keyRecord: { id: "1" },
      on: { sets: { gpk: "$s#v1#e#binding_b%20c", gsk: "$s#v1#e" }, removes: [] },
      off: { sets: { gpk: "$s#v1#e#binding_b c", gsk: "$s#v1#e" }, removes: [] },
    },
    {
      name: "a new degenerate one: both halves over one composite, only what a key escapes",
      index: halves(["tag"], ["tag"]),
      payload: { tag: "#%" },
      keyRecord: { id: "1" },
      on: {
        sets: { gpk: "$s#v1#e#tag_%23%25", gsk: "$s#v1#e#tag_%23%25" },
        removes: [],
      },
      off: { sets: { gpk: "$s#v1#e#tag_#%", gsk: "$s#v1#e#tag_#%" }, removes: [] },
    },
  ]

  for (const shape of shapes) {
    it(shape.name, () => {
      const onResult = compose(on, shape.index, shape.payload, shape.keyRecord, shape.removed)
      const offResult = compose(flagOff, shape.index, shape.payload, shape.keyRecord, shape.removed)
      expect(onResult.sets).toEqual(shape.on.sets)
      expect(onResult.removes).toEqual(shape.on.removes)
      expect(offResult.sets).toEqual(shape.off.sets)
      expect(offResult.removes).toEqual(shape.off.removes)
    })
  }
})
