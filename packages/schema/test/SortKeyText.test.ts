/**
 * Sort key text (#171): `KeyComposer.escapeKeyText` escapes every code point
 * U+0000–U+0025 of a composite value's cased text as `%` and two hex digits,
 * so that the key's UTF-8 byte order is the cased values' order — a value
 * followed by the delimiter `#` sorts before every extension of it — and a
 * value is a prefix of another exactly when its key text is. A value without
 * such a character keeps its 1.36 bytes.
 */
import { describe, expect, it } from "@effect/vitest"
import { Arbitrary, DateTime, Schema } from "effect"
import * as DynamoSchema from "../src/DynamoSchema.js"
import { compareBytes, utf8 } from "../src/internal/ZOrderCurve.js"
import * as KeyComposer from "../src/KeyComposer.js"

const Int = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const casings = ["lowercase", "uppercase", "preserve"] as const

/** DynamoDB's sort key order: UTF-8 bytes. */
const byteOrder = (a: string, b: string): number => Math.sign(compareBytes(utf8(a), utf8(b)))

// -- arbitraries --

/**
 * Every code point U+0000–U+0026 (the escaped ones, and `&` just above),
 * digits, letters of both cases, non-ASCII BMP letters casing maps unevenly
 * (`ß` upper-cases to `SS`, `İ` lower-cases to two code points, `Σ` to `σ` or
 * `ς` by context), CJK, and astral characters (UTF-8 `F0 …`).
 */
const ALPHABET = [
  ...Array.from({ length: 0x27 }, (_, code) => String.fromCharCode(code)),
  "0",
  "9",
  "A",
  "F",
  "Z",
  "a",
  "f",
  "z",
  "É",
  "é",
  "ß",
  "İ",
  "Σ",
  "σ",
  "ς",
  "中",
  "�",
  "😀",
  "𝔸",
]

/** Any Unicode scalar value but the surrogates. */
const scalar = Arbitrary.schema(Int(0, 0x10ffff - 0x800)).pipe(
  Arbitrary.map((n) => String.fromCodePoint(n < 0xd800 ? n : n + 0x800)),
)

const fromAlphabet = Arbitrary.schema(
  Schema.Array(Int(0, ALPHABET.length - 1)).check(Schema.isBetweenLength(0, 8)),
).pipe(Arbitrary.map((letters) => letters.map((i) => ALPHABET[i]!).join("")))

/** Words from the alphabet, now and then with an arbitrary scalar value in them. */
const word = Arbitrary.all([fromAlphabet, scalar, fromAlphabet, Arbitrary.schema(Int(0, 2))]).pipe(
  Arbitrary.map(([head, odd, tail, shape]) =>
    shape === 0 ? head : shape === 1 ? `${head}${odd}` : `${head}${odd}${tail}`,
  ),
)

/** Words without an escaped character: their key text is 1.36's. */
const plain = fromAlphabet.pipe(
  Arbitrary.map((text) =>
    Array.from(text)
      .filter((char) => char.codePointAt(0)! > 0x25)
      .join(""),
  ),
)

const cased = (text: string, casing: DynamoSchema.Casing) => DynamoSchema.applyCasing(text, casing)

/** Decode escaped text: `%XX` back to its code point. */
const unescape = (text: string) =>
  text.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )

// -- composition --

const nameFirst: KeyComposer.IndexDefinition = {
  pk: { field: "pk", composite: ["store"] },
  sk: { field: "sk", composite: ["name", "tag"] },
}
const nameLast: KeyComposer.IndexDefinition = {
  pk: { field: "pk", composite: ["store"] },
  sk: { field: "sk", composite: ["tag", "name"] },
}

describe("sort key text (#171)", () => {
  it.prop(
    "(a) escaped text holds nothing below '%', and every '%' starts a well-formed escape",
    { a: word },
    ({ a }) => {
      for (const casing of casings) {
        const text = KeyComposer.escapeKeyText(a, casing)
        for (const char of text) {
          expect(char.codePointAt(0)! >= 0x25, JSON.stringify({ a, text, casing })).toBe(true)
        }
        const hex = casing === "lowercase" ? "[0-9a-f]" : "[0-9A-F]"
        const escapes = text.match(/%../g) ?? []
        expect(text.split("%").length - 1).toBe(escapes.length)
        for (const escape of escapes) {
          expect(escape, JSON.stringify({ a, text, casing })).toMatch(new RegExp(`^%${hex}{2}$`))
          expect(Number.parseInt(escape.slice(1), 16)).toBeLessThanOrEqual(0x25)
        }
        // Escaping loses nothing: decoded, it is the cased value.
        expect(unescape(text), JSON.stringify({ a, casing })).toBe(cased(a, casing))
      }
    },
    { arbitrary: { runs: 2000 } },
  )

  for (const casing of casings) {
    const schema = DynamoSchema.make({ name: "Shop-App", version: 1, casing, escapeKeys: true })
    const key = (index: KeyComposer.IndexDefinition, name: string, tag: string) =>
      KeyComposer.composeSk(schema, "Item", 1, index, { name, tag })

    it.prop(
      `(b) composed keys sort as the cased values, non-last and last (${casing})`,
      { a: word, b: word, ta: word, tb: word },
      ({ a, b, ta, tb }) => {
        const values = byteOrder(cased(a, casing), cased(b, casing))
        const tags = byteOrder(cased(ta, casing), cased(tb, casing))
        const context = JSON.stringify({ a, b, ta, tb })
        // `name` followed by `#` and a cased string composite…
        expect(byteOrder(key(nameFirst, a, ta), key(nameFirst, b, tb)), context).toBe(
          values || tags,
        )
        // …and `name` last.
        expect(byteOrder(key(nameLast, a, ta), key(nameLast, b, ta)), context).toBe(values)
      },
      { arbitrary: { runs: 1000 } },
    )

    it.prop(
      `(c) a value is a prefix of another exactly when its key text is (${casing})`,
      { a: word, b: word, tail: word },
      ({ a, b, tail }) => {
        for (const [x, y] of [
          [a, b],
          [a, `${a}${tail}`],
        ] as const) {
          const prefix = cased(y, casing).startsWith(cased(x, casing))
          const context = JSON.stringify({ x, y })
          expect(
            KeyComposer.escapeKeyText(y, casing).startsWith(KeyComposer.escapeKeyText(x, casing)),
            context,
          ).toBe(prefix)
          // A `beginsWith` on the last composite is a prefix of the stored key.
          expect(key(nameLast, y, "t").startsWith(key(nameLast, x, "t")), context).toBe(prefix)
        }
      },
      { arbitrary: { runs: 1000 } },
    )

    it.prop(
      `(d) a value without an escaped character keeps its 1.36 bytes (${casing})`,
      { a: plain, b: plain },
      ({ a, b }) => {
        expect(KeyComposer.escapeKeyText(a, casing)).toBe(cased(a, casing))
        // 1.36's `composeSk`: the serialized values, cased by the composer.
        const legacy = DynamoSchema.composeKey(schema, "Item", [a, b], { names: ["name", "tag"] })
        expect(key(nameFirst, a, b)).toBe(legacy)
      },
      { arbitrary: { runs: 1000 } },
    )
  }

  it.prop(
    "(d) numbers, bigints, booleans and dates compose no escape",
    {
      n: Schema.Number.check(Schema.isFinite()),
      big: Schema.BigInt,
      flag: Schema.Boolean,
      ms: Int(-8.64e15, 8.64e15),
    },
    ({ n, big, flag, ms }) => {
      const schema = DynamoSchema.make({ name: "app", version: 1, escapeKeys: true })
      for (const value of [n, big, flag, new Date(ms), DateTime.makeUnsafe(ms)]) {
        for (const casing of casings) {
          expect(KeyComposer.keyValueText(schema, value, casing)).toBe(
            cased(KeyComposer.serializeValue(value), casing),
          )
        }
      }
    },
  )

  it("escapes every code point up to '%' and nothing above", () => {
    expect(KeyComposer.escapeKeyText("new york", "preserve")).toBe("new%20york")
    expect(KeyComposer.escapeKeyText("a#b", "preserve")).toBe("a%23b")
    expect(KeyComposer.escapeKeyText("50%", "preserve")).toBe("50%25")
    expect(KeyComposer.escapeKeyText("$&'", "preserve")).toBe("%24&'")
    expect(KeyComposer.escapeKeyText("Line\nTwo", "lowercase")).toBe("line%0atwo")
    expect(KeyComposer.escapeKeyText("Line\nTwo", "uppercase")).toBe("LINE%0ATWO")
    expect(KeyComposer.escapeKeyText("\u0000\u001f", "preserve")).toBe("%00%1F")
    // Cased first: an escape is never re-read by the casing's context rules.
    expect(KeyComposer.escapeKeyText("\nΣ", "lowercase")).toBe("%0aσ")
  })

  it("applies to every key composition, partition and sort", () => {
    const schema = DynamoSchema.make({ name: "app", version: 1, escapeKeys: true })
    const index: KeyComposer.IndexDefinition = {
      pk: { field: "pk", composite: ["city"] },
      sk: { field: "sk", composite: ["city", "zone"] },
    }
    const record = { city: "New York", zone: "a#b" }
    expect(KeyComposer.composePk(schema, "Place", index, record)).toBe(
      "$app#v1#place#city_new%20york",
    )
    expect(KeyComposer.composeSk(schema, "Place", 1, index, record)).toBe(
      "$app#v1#place#city_new%20york#zone_a%23b",
    )
    expect(KeyComposer.composeSortKeyBeginsWith(schema, "Place", 1, index, { city: "A B" })).toBe(
      "$app#v1#place#city_a%20b#",
    )
    expect(KeyComposer.composeSkPrefixUpTo(schema, "Place", 1, index, record, 1)).toBe(
      "$app#v1#place#city_new%20york",
    )
    expect(KeyComposer.composeEventSk(schema, "$app#v1#place", "2026 Q1", "lowercase")).toBe(
      "$app#v1#place#e#2026%20q1",
    )
  })

  it("index keys and policy-aware GSI updates escape both halves (shapes 2 and 6)", () => {
    const schema = DynamoSchema.make({ name: "app", version: 1, escapeKeys: true })
    const indexes: Record<string, KeyComposer.IndexDefinition> = {
      // shape 2: composites entirely the entity primary key's
      byChannel: {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["channel"] },
        sk: { field: "gsi1sk", composite: ["deviceId"] },
      },
      // shape 6: an empty-composite half
      byBinding: {
        index: "gsi2",
        pk: { field: "gsi2pk", composite: ["binding"] },
        sk: { field: "gsi2sk", composite: [] },
      },
    }
    const record = { channel: "North East", deviceId: "a#b 1", binding: "x y" }
    expect(KeyComposer.composeIndexKeys(schema, "Device", 1, indexes.byChannel!, record)).toEqual({
      gsi1pk: "$app#v1#device#channel_north%20east",
      gsi1sk: "$app#v1#device#deviceid_a%23b%201",
    })
    const { sets, removes } = KeyComposer.composeGsiKeysForUpdatePolicyAware(
      schema,
      "Device",
      1,
      indexes,
      { binding: "x y" },
      record,
    )
    expect(removes).toEqual([])
    expect(sets).toEqual({
      gsi1pk: "$app#v1#device#channel_north%20east",
      gsi1sk: "$app#v1#device#deviceid_a%23b%201",
      gsi2pk: "$app#v1#device#binding_x%20y",
      gsi2sk: "$app#v1#device",
    })
  })
})

describe("the names before every key escaped (deprecated since 1.39.0)", () => {
  const schema = DynamoSchema.make({ name: "app", version: 1, escapeKeys: true })

  it("sortKeyText is escapeKeyText", () => {
    expect(KeyComposer.sortKeyText("A b%", "lowercase")).toBe("a%20b%25")
    expect(KeyComposer.sortKeyText("A b%", "preserve")).toBe(
      KeyComposer.escapeKeyText("A b%", "preserve"),
    )
  })

  it("serializeSortKeyValue escapes a value's serialized text", () => {
    expect(KeyComposer.serializeSortKeyValue("A b", "lowercase")).toBe("a%20b")
    expect(KeyComposer.serializeSortKeyValue(5, "lowercase")).toBe(
      KeyComposer.keyValueText(schema, 5, "lowercase"),
    )
  })

  it("composeEventSk still takes the current sort key first", () => {
    expect(KeyComposer.composeEventSk("$x", "value", "preserve")).toBe("$x#e#value")
    expect(KeyComposer.composeEventSk("$x", "A b")).toBe("$x#e#a%20b")
    expect(KeyComposer.composeEventSk("$x", 42)).toBe(
      KeyComposer.composeEventSk(schema, "$x", 42, "lowercase"),
    )
  })

  it("with the schema first, composeEventSk honours escapeKeys", () => {
    const off = DynamoSchema.make({ name: "app", version: 1, escapeKeys: false })
    expect(KeyComposer.composeEventSk(off, "$x", "a b")).toBe("$x#e#a b")
    expect(KeyComposer.composeEventSk(schema, "$x", "a b")).toBe("$x#e#a%20b")
  })
})
