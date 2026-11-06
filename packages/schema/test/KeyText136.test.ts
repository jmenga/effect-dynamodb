/**
 * With `escapeKeys` off, the default, the real composers compose exactly the key text 1.36.0 wrote,
 * and `internal/KeyText136.ts` reads a stored key back under each form `rekey` recognises.
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

/** What a schema that doesn't set the flag composes: the fixture's own schemas, through `make`. */
const defaulted = (schema: Schema): Schema => DynamoSchema.make(schema)

describe("the default composes the golden vectors from the published 1.36.0", () => {
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

  it("a composite value's text", () => {
    const schema = DynamoSchema.make({ name: "app", version: 1 })
    const of136 = KeyText136.schema136(schema)
    for (const { value, text } of vectors.serializeValue) {
      const revived = revive(value)
      expect(KeyComposer.compositeText(of136, revived), JSON.stringify(value)).toBe(text)
      // The one vector the default refuses: nothing can be stored under it from here on.
      if (typeof revived === "number" && Number.isNaN(revived)) {
        expect(() => KeyComposer.compositeText(schema, revived)).toThrow("[EDD-9096]")
      } else {
        expect(KeyComposer.compositeText(schema, revived), JSON.stringify(value)).toBe(text)
      }
    }
  })

  it("partition keys, sort keys, sort key prefixes and begins_with operands", () => {
    for (const v of vectors.keys) {
      const schema = defaulted(v.schema)
      const record = revived(v.record)
      const partial = { ...record }
      for (const name of v.index.sk.composite.slice(v.leading)) delete partial[name]
      const at = JSON.stringify(v)
      expect(KeyComposer.composePk(schema, v.entityType, v.index, record), at).toBe(v.pk)
      expect(
        KeyComposer.composeSk(schema, v.entityType, v.entityVersion, v.index, record),
        at,
      ).toBe(v.sk)
      expect(
        KeyComposer.composeSortKeyPrefix(schema, v.entityType, v.entityVersion, v.index, partial),
        at,
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
          at,
        ).toBe(v.beginsWith)
      }
    }
  })

  it("a key read back: one reading, which composes it and the values' key under each setting", () => {
    const kinds: Record<string, KeyText136.ValueKind> = {
      number: "number",
      bigint: "bigint",
      boolean: "boolean",
    }
    for (const v of vectors.keys) {
      const at = JSON.stringify(v)
      const schema = defaulted(v.schema)
      const form = { pk: schema, sk: schema }
      const record = revived(v.record)
      const read = KeyText136.readIndexKeys(
        form,
        v.entityType,
        v.entityVersion,
        v.index,
        { [v.index.pk.field]: v.pk, [v.index.sk.field]: v.sk },
        (attr) => kinds[v.record[attr]!.t] ?? "string",
      )
      expect(read, at).toBeDefined()
      expect(KeyText136.composeAt(form, v.entityType, v.entityVersion, v.index, read!), at).toEqual(
        { [v.index.pk.field]: v.pk, [v.index.sk.field]: v.sk },
      )
      const on = DynamoSchema.make({ ...v.schema, escapeKeys: true })
      let current: Record<string, unknown> | undefined
      try {
        current = KeyComposer.composeIndexKeys(on, v.entityType, v.entityVersion, v.index, record)
      } catch {
        // `NaN` has no key with `escapeKeys: true` ([EDD-9096]).
        continue
      }
      expect(
        KeyComposer.composeIndexKeys(on, v.entityType, v.entityVersion, v.index, read!),
        at,
      ).toEqual(current)
    }
  })

  it("every index's keys, sparse GSIs left out", () => {
    for (const v of vectors.allKeys) {
      expect(
        KeyComposer.composeAllKeys(
          defaulted(v.schema),
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
    const schema = DynamoSchema.make({ name: "app", version: 1 })
    for (const v of vectors.eventSk) {
      expect(KeyComposer.composeEventSk(schema, v.currentSk, revive(v.orderBy), v.casing)).toBe(
        v.eventSk,
      )
      expect(KeyComposer.composeEventSkPrefix(v.currentSk, v.casing)).toBe(v.prefix)
    }
  })

  it("unique-constraint sentinels", () => {
    for (const v of vectors.unique) {
      const schema = defaulted(v.schema)
      expect(
        DynamoSchema.composeUniqueKey(
          schema,
          "User",
          v.constraintName,
          v.values.map((value) => KeyComposer.keyValueText(schema, revive(value), schema.casing)),
        ),
        JSON.stringify(v),
      ).toEqual({ pk: v.pk, sk: v.sk })
    }
  })

  it("version snapshot and tombstone keys, through the live sort key", () => {
    for (const v of vectors.history) {
      const schema = defaulted(v.schema)
      const liveSk = KeyComposer.composeSk(schema, "Doc", 1, v.primary, revived(v.record))
      expect(liveSk).toBe(v.liveSk)
      const item = KeyComposer.composeHistoryItemSegment(schema, "Doc", 1, v.primary, liveSk)
      expect(item ?? null).toBe(v.item)
      const options = item === undefined ? undefined : { item }
      expect(DynamoSchema.composeVersionKey(schema, "Doc", v.version, options)).toBe(v.versionKey)
      expect(DynamoSchema.composeDeletedKey(schema, "Doc", v.timestamp, options)).toBe(v.deletedKey)
    }
  })

  it("vector index partitions", () => {
    for (const v of vectors.vectorPartition) {
      expect(
        KeyComposer.tryComposeVectorPartition(
          defaulted(v.schema),
          "Doc",
          v.index,
          revived(v.record),
        ),
      ).toBe(v.partition)
    }
  })

  it("aggregate and EventStore keys: collection, list and stream keys", () => {
    for (const v of vectors.collection) {
      const schema = defaulted(v.schema)
      const options = v.casing === null ? undefined : { casing: v.casing }
      // These keys cased their values once, by their own rule: the composer's casing is the key's.
      const composites = KeyComposer.extractKeyComposites(
        schema,
        { casing: "preserve" },
        v.composite,
        revived(v.record),
      )
      expect(DynamoSchema.composeCollectionKey(schema, "Match", composites, options)).toBe(
        v.collectionKey,
      )
      expect(
        DynamoSchema.composeKey(
          schema,
          "Innings",
          v.values.flatMap((value, j) => [
            `d${j}`,
            KeyComposer.compositeText(schema, revive(value)),
          ]),
          options,
        ),
      ).toBe(v.key)
      expect(DynamoSchema.composeKey(schema, "Account", composites, options)).toBe(v.streamKey)
    }
  })
})

describe("KeyText136 — the forms `rekey` recognises", () => {
  const schema = DynamoSchema.make({ name: "app", version: 1, escapeKeys: false })
  const on = DynamoSchema.make({ name: "app", version: 1, escapeKeys: true })
  const primary: Index = {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["seq"] },
  }

  it("a value with nothing to escape and no number 1.37 changed has one key under every form", () => {
    for (const record of [
      { tenant: "acme", seq: "a" },
      { tenant: "acme", seq: 0 },
      { tenant: "acme", seq: Number.MAX_SAFE_INTEGER },
      { tenant: "acme", seq: 99_999_999_999_999_999_999_999_999_999_999_999_999n },
    ]) {
      const keys = KeyText136.forms(schema).map((form) =>
        JSON.stringify(KeyText136.composeAt(form, "Item", 1, primary, record)),
      )
      expect(new Set(keys).size).toBe(1)
    }
  })

  it("a changed number or an escaped key value has a key of its own under some form", () => {
    for (const record of [
      { tenant: "new york", seq: 42 },
      { tenant: "acme", seq: -3 },
      { tenant: "acme", seq: 2.5 },
      { tenant: "acme", seq: 1e16 },
      { tenant: "acme", seq: -1n },
      { tenant: "acme", seq: "new york" },
      { tenant: -1, seq: "a" },
    ]) {
      const keys = KeyText136.forms(schema).map((form) =>
        JSON.stringify(KeyText136.composeAt(form, "Item", 1, primary, record)),
      )
      expect(new Set(keys).size).toBeGreaterThan(1)
    }
    expect(
      KeyText136.composeAt(KeyText136.forms(schema)[0]!, "Item", 1, primary, {
        tenant: "acme",
        seq: -3,
      }),
    ).toEqual({ pk: "$app#v1#item#tenant_acme", sk: "$app#v1#item#seq_00000000000000-3" })
  })

  it("a row holding no values is marked only under text off doesn't compose", () => {
    const plain = { tenant: "acme", seq: 1 }
    const spelled = { tenant: "a b", seq: 1 }
    expect(KeyText136.markOf(schema, "Item", 1, primary, spelled)).toBeUndefined()
    expect(KeyText136.markOf(on, "Item", 1, primary, plain)).toBeUndefined()
    expect(KeyText136.markOf(on, "Item", 1, primary, spelled)).toBe(2)
    expect(
      KeyText136.composeAt(KeyText136.formOfMark(on, "2"), "Item", 1, primary, spelled),
    ).toEqual(KeyText136.composeAt({ pk: on, sk: on }, "Item", 1, primary, spelled))
    expect(
      KeyText136.composeAt(KeyText136.formOfMark(on, undefined), "Item", 1, primary, spelled),
    ).toEqual(KeyText136.composeAt({ pk: schema, sk: schema }, "Item", 1, primary, spelled))
    expect(KeyText136.formOfMark(on, "1").pk).toEqual(KeyText136.schema137(on))
  })

  it("a key is read back only as the text of exactly one set of values", () => {
    const form = { pk: schema, sk: schema }
    const kindOf = (attr: string): KeyText136.ValueKind => (attr === "seq" ? "number" : "string")
    const read = (pk: string, sk: string) =>
      KeyText136.readIndexKeys(form, "Item", 1, primary, { pk, sk }, kindOf)
    // 1.36's padded text of a number, and a sort key value as it was stored, cased.
    expect(read("$app#v1#item#tenant_acme", "$app#v1#item#seq_00000000000000-3")).toEqual({
      tenant: "acme",
      seq: -3,
    })
    // 1.37's text of a changed number is no 1.36 text.
    const moved = KeyComposer.composeIndexKeys(on, "Item", 1, primary, { tenant: "acme", seq: -3 })
    expect(read(String(moved.pk), String(moved.sk))).toBeUndefined()
    // A string holding the delimiter and the next label reads two ways.
    const two: Index = {
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "sk", composite: ["a", "b"] },
    }
    expect(
      KeyText136.readIndexKeys(
        form,
        "Item",
        1,
        two,
        { pk: "$app#v1#item#tenant_t", sk: "$app#v1#item#a_x#b_y#b_z" },
        () => "string",
      ),
    ).toBeUndefined()
    expect(
      KeyText136.readIndexKeys(
        form,
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
})
