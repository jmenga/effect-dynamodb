/**
 * CompositeCodec — read-path composite encoding.
 *
 * Key composition runs on the ENCODED record (`Entity.put` encodes, then
 * composes). Query accessors and `.where()` receive DECODED model values, so
 * they must take the same encode step or the two sides produce different key
 * strings for a transformed composite.
 */

import { DateTime, Effect, Option, Schema, SchemaGetter } from "effect"
import { describe, expect, it } from "vitest"
import { DateEpochMs } from "../src/DynamoModel.js"
import {
  bothKindsKeyRefusal,
  fieldAtPath,
  keyFormValueKind,
  kindReadingOf,
  kindTargets,
  makeCompositeKeyForm,
  otherNumericKind,
  readBackUnsure,
  readsBackOtherwise,
  storedFieldAtPath,
  storedNumericForm,
  storedNumericKinds,
  toCompositeKeyRecord,
} from "../src/internal/CompositeCodec.js"
import { serializeValue } from "../src/KeyComposer.js"

const Model = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["todo", "active", "done"]),
  seq: Schema.Number,
  ok: Schema.Boolean,
  at: Schema.Date,
  utc: Schema.DateTimeUtc,
  // Genuine `decodeTo`: Type is bigint, Encoded is string.
  txn: Schema.BigIntFromString,
  epoch: DateEpochMs,
})

const refuse = (attr: string, value: unknown): never => {
  throw new Error(`[EDD-9050] ${attr} ${String(value)}`)
}

describe("CompositeCodec", () => {
  const encode = makeCompositeKeyForm(Model, refuse)

  describe("case 1 — attribute is not a model field", () => {
    it("passes the value through untouched", () => {
      // Ref-derived `<ref>Id` composites are not model fields; they are already
      // wire-shaped strings.
      expect(encode("teamId", "t-1")).toBe("t-1")
    })
  })

  describe("case 2 — field has no encoding transformation", () => {
    it("passes strings, numbers and booleans through", () => {
      expect(encode("id", "abc")).toBe("abc")
      expect(encode("seq", 42)).toBe(42)
      expect(encode("ok", true)).toBe(true)
    })

    it("passes an open bound that is NOT a valid value", () => {
      // `gte(t.status, "d")` on a literal union: a bound is deliberately not a
      // member of the union. Attempting an encode here would reject a
      // legitimate query, which is why case 2 short-circuits.
      expect(encode("status", "d")).toBe("d")
      expect(encode("status", "zzz")).toBe("zzz")
    })
  })

  describe("case 3 — field has an encoding transformation", () => {
    it("keeps a numeric-Type/string-Encoded composite on the TYPE side so it pads", () => {
      // THE EXCEPTION. `serializeValue` pads a bigint to 38 digits but leaves a
      // string alone, so composing the encoded "420" stored `txn_420` beside
      // `txn_100` and `txn_5` — which DynamoDB orders 100 < 42 < 5.
      expect(encode("txn", 420n)).toBe(420n)
      expect(serializeValue(encode("txn", 420n))).toBe("420".padStart(38, "0"))
    })

    it("lifts the encoded string back to the Type side, so both inputs agree", () => {
      // The write path holds the encoded record, the read path the domain
      // value; both must land on the same key.
      expect(encode("txn", "420")).toBe(420n)
      expect(encode("txn", encode("txn", 420n))).toBe(420n)
    })

    it("padding makes mixed-width values sort numerically", () => {
      const keys = [5n, 42n, 100n].map((v) => serializeValue(encode("txn", v)))
      expect([...keys].sort()).toEqual(keys)
    })

    it("a numeric ENCODED form is used as-is — the exception does not apply", () => {
      // `DateEpochMs`: Type is DateTime, Encoded is a number, already padded by
      // `serializeValue`.
      const dt = DateTime.makeUnsafe("2026-02-11T00:00:00.000Z")
      expect(encode("epoch", dt)).toBe(DateTime.toEpochMillis(dt))
      expect(serializeValue(encode("epoch", dt))).toBe(
        String(DateTime.toEpochMillis(dt)).padStart(16, "0"),
      )
    })

    it("round-trips Date and DateTime to a value that serialises identically", () => {
      const d = new Date("2026-02-11T00:00:00.000Z")
      expect(serializeValue(encode("at", d))).toBe(serializeValue(d))
      const dt = DateTime.makeUnsafe("2026-02-11T00:00:00.000Z")
      expect(serializeValue(encode("utc", dt))).toBe(serializeValue(dt))
    })

    it("refuses a value that resolves under neither route (EDD-9050)", () => {
      // A prefix is not a bigint and does not decode as one, so it cannot be
      // placed in a key at all. Refuse loudly rather than compose a string that
      // silently matches nothing.
      expect(() => encode("txn", "not-a-number")).toThrow(/EDD-9050.*txn/)
    })
  })

  describe("a stored row's numbers take their field's kind (#171)", () => {
    // A stored `N` unmarshalls as a number below 2^53 and a bigint above, so a
    // key re-derived from a stored row (the live-row check, a move from a 1.36
    // key) must reach the declared kind, or it composes at the other width.
    const Stored = Schema.Struct({ small: Schema.BigInt, big: Schema.Number, label: Schema.String })
    const fromRow = makeCompositeKeyForm(Stored, refuse)

    it("a Schema.BigInt read back as a number is a bigint again", () => {
      expect(fromRow("small", 5)).toBe(5n)
      expect(serializeValue(fromRow("small", 5))).toBe(serializeValue(5n))
      expect(fromRow("small", 5n)).toBe(5n)
      // Not an integer: left for the composer to refuse, never truncated.
      expect(fromRow("small", 2.5)).toBe(2.5)
    })

    it("a Schema.Number read back as a bigint is a number again", () => {
      expect(fromRow("big", 12n)).toBe(12)
      expect(fromRow("big", 12)).toBe(12)
    })

    it("a non-numeric field is untouched", () => {
      expect(fromRow("label", 5)).toBe(5)
    })
  })

  describe("the numeric kinds a field stores", () => {
    it("a union storing one numeric kind is that kind read back", () => {
      // A stored `N` of `Union([String, BigInt])` can only have been a bigint.
      const Mixed = Schema.Struct({
        sb: Schema.Union([Schema.String, Schema.BigInt]),
        sn: Schema.Union([Schema.String, Schema.Number]),
      })
      const fromRow = makeCompositeKeyForm(Mixed, refuse)
      expect(fromRow("sb", 5)).toBe(5n)
      expect(serializeValue(fromRow("sb", 5))).toBe(serializeValue(5n))
      expect(fromRow("sb", "a")).toBe("a")
      expect(fromRow("sn", 12n)).toBe(12)
      expect(fromRow("sn", "a")).toBe("a")
    })

    it("a suspended schema is the schema it suspends", () => {
      const Suspended = Schema.Struct({
        b: Schema.suspend(() => Schema.BigInt),
        n: Schema.suspend(() => Schema.Number),
      })
      const fromRow = makeCompositeKeyForm(Suspended, refuse)
      expect(fromRow("b", 5)).toBe(5n)
      expect(serializeValue(fromRow("b", 5))).toBe(serializeValue(5n))
      expect(fromRow("n", 12n)).toBe(12)
      expect(keyFormValueKind(Schema.suspend(() => Schema.BigInt))).toBe("bigint")
    })

    it("a union storing both kinds is left: its value alone can't say", () => {
      const Both = Schema.Struct({ n: Schema.Union([Schema.Number, Schema.BigInt]) })
      const fromRow = makeCompositeKeyForm(Both, refuse)
      expect(fromRow("n", 5)).toBe(5)
      expect(fromRow("n", 5n)).toBe(5n)
    })

    it("names the kinds of each Encoded side", () => {
      const kinds = (field: Schema.Top) => [...storedNumericKinds(field)].sort()
      expect(kinds(Schema.BigInt)).toEqual(["bigint"])
      expect(kinds(Schema.Number)).toEqual(["number"])
      expect(kinds(Schema.BigIntFromString)).toEqual([])
      expect(kinds(Schema.OptionFromNullOr(Schema.BigInt))).toEqual(["bigint"])
      expect(kinds(Schema.Union([Schema.String, Schema.BigInt]))).toEqual(["bigint"])
      expect(kinds(Schema.Union([Schema.Number, Schema.BigInt]))).toEqual(["bigint", "number"])
      expect(kinds(Schema.Unknown)).toEqual(["bigint", "number"])
      expect(kinds(Schema.Literals([1, 2]))).toEqual(["number"])
      expect(kinds(Schema.Literal(2n))).toEqual(["bigint"])
      expect(kinds(Schema.Union([Schema.Literal(1), Schema.Literal(2n)]))).toEqual([
        "bigint",
        "number",
      ])
      expect(kinds(Schema.Enum({ A: 1, B: "b" }))).toEqual(["number"])
      expect(kinds(Schema.Enum({ A: "a" }))).toEqual([])
      expect(kinds(Schema.Union([Schema.Enum({ A: 1 }), Schema.BigInt]))).toEqual([
        "bigint",
        "number",
      ])
      expect(kinds(Schema.Any)).toEqual(["bigint", "number"])
      expect(kinds(Schema.suspend(() => Schema.BigInt))).toEqual(["bigint"])
      expect(kinds(Schema.suspend(() => Schema.Union([Schema.String, Schema.Number])))).toEqual([
        "number",
      ])
      expect(kinds(Schema.String)).toEqual([])
      expect(storedNumericForm(Schema.Union([Schema.Number, Schema.BigInt]))).toBeUndefined()
      expect(storedNumericForm(Schema.Union([Schema.String, Schema.BigInt]))?.(5)).toBe(5n)
    })

    it("judges a value of a field whose kinds can't be read by the value DynamoDB returns", () => {
      // What DynamoDB hands back, as the marshaller and the unmarshaller do: a safe-integer bigint
      // as a number, and -0 as 0. A number past 2^53 the marshaller refuses.
      const asRead = (stored: unknown): unknown => {
        if (typeof stored === "bigint") {
          return Number.isSafeInteger(Number(stored)) ? Number(stored) : stored
        }
        if (typeof stored === "number") {
          if (Object.is(stored, -0)) return 0
          if (Number.isInteger(stored) && !Number.isSafeInteger(stored)) {
            throw new Error(`Number ${stored} is greater than Number.MAX_SAFE_INTEGER.`)
          }
          return stored
        }
        return stored
      }
      const judge = (field: Schema.Top) => readsBackOtherwise(field, { asRead })
      const readsOther = judge(Schema.Unknown)!
      expect(readsOther(5n)).toBe("a number")
      expect(readsOther(-5n)).toBe("a number")
      expect(readsOther(2n ** 60n + 1n)).toBeUndefined()
      expect(readsOther(5)).toBeUndefined()
      expect(readsOther(1.5)).toBeUndefined()
      // The write's own marshalling refuses it, as in any attribute (EDD-9124).
      expect(readsOther(2 ** 60)).toBeUndefined()
      expect(readsOther("5")).toBeUndefined()
      expect(judge(Schema.Any)).toBeDefined()
      // A transform whose stored side can't be read is judged through its decode: a bigint that
      // decodes the number DynamoDB returns to the same bigint is read back as written.
      const toBigInt = Schema.Unknown.pipe(
        Schema.decodeTo(Schema.BigInt, {
          decode: SchemaGetter.transform((n) => BigInt(n as number)),
          encode: SchemaGetter.transform((n) => n),
        }),
      )
      expect(judge(toBigInt)?.(5n)).toBeUndefined()
      const declared = Schema.declare(
        (v): v is number | bigint => typeof v === "number" || typeof v === "bigint",
      )
      expect(judge(declared)?.(5n)).toBe("a number")
      expect(judge(declared)?.(5)).toBeUndefined()
      // A field storing one numeric kind reads the number DynamoDB returns as that kind, as every
      // read does: the bigint written is read back.
      expect(judge(Schema.OptionFromNullOr(Schema.BigInt))?.(5n)).toBeUndefined()
      expect(
        judge(Schema.BigInt.pipe(Schema.withDecodingDefault(Effect.succeed(7n))))?.(5n),
      ).toBeUndefined()
      // Kinds known at load are never judged at write.
      expect(judge(Schema.BigInt)).toBeUndefined()
      expect(judge(Schema.String)).toBeUndefined()
      expect(judge(Schema.Union([Schema.Number, Schema.BigInt]))).toBeUndefined()
      // -0 reads back as 0: the same key text for a field reading both alike, and refused by one that
      // decodes them to different values.
      expect(readsOther(-0)).toBeUndefined()
      const zero = Schema.Unknown.pipe(
        Schema.decodeTo(Schema.Literals([1n, 2n]), {
          decode: SchemaGetter.transform((x) => (Object.is(x, -0) ? 1n : 2n)),
          encode: SchemaGetter.transform((x) => (x === 1n ? -0 : 1)),
        }),
      )
      expect(judge(zero)?.(-0)).toBe("2n")
      expect(judge(zero)?.(1)).toBeUndefined()
    })

    it("follows a dotted composite through what holds each segment", () => {
      class Holder extends Schema.Class<Holder>("Holder")({ n: Schema.BigInt }) {}
      const inner = Schema.Struct({ n: Schema.BigInt })
      const kindsAt = (holder: Schema.Top) => {
        const field = fieldAtPath({ nested: holder }, "nested.n")
        return field === undefined ? undefined : [...storedNumericKinds(field)].sort()
      }
      for (const holder of [
        inner,
        Schema.optional(inner),
        Schema.optionalKey(inner),
        Schema.NullOr(inner),
        Schema.Union([inner, Schema.Null, Schema.Undefined]),
        Schema.suspend(() => inner),
        Holder,
        Schema.NullOr(Holder),
      ]) {
        expect(kindsAt(holder)).toEqual(["bigint"])
      }
      // A union of structs naming the segment in two members gives both their fields.
      expect(kindsAt(Schema.Union([inner, Schema.Struct({ n: Schema.Number })]))).toEqual([
        "bigint",
        "number",
      ])
      expect(fieldAtPath({ nested: inner }, "nested.m")).toBeUndefined()
      expect(fieldAtPath({ nested: Schema.String }, "nested.n")).toBeUndefined()
      expect(fieldAtPath({ n: Schema.Number }, "n")).toBeDefined()
    })

    it("follows a dotted composite on the stored side through a transformed struct", () => {
      const Both = Schema.Union([Schema.Number, Schema.BigInt])
      const nested = (encoded: Schema.Top, decoded: Schema.Top) =>
        Schema.Struct({ n: encoded }).pipe(
          Schema.decodeTo(Schema.Struct({ n: decoded }), {
            decode: SchemaGetter.transform((x: any) => ({ n: Number(x.n) })),
            encode: SchemaGetter.transform((x: any) => ({ n: x.n })),
          }),
        ) as Schema.Top
      const kinds = (holder: Schema.Top, at: typeof fieldAtPath) => {
        const field = at({ nested: holder }, "nested.n")
        return field === undefined ? undefined : [...storedNumericKinds(field)].sort()
      }
      // Stored as a number, decoded to either kind: the row holds a number.
      expect(kinds(nested(Schema.Number, Both), storedFieldAtPath)).toEqual(["number"])
      expect(kinds(nested(Schema.Number, Both), fieldAtPath)).toEqual(["bigint", "number"])
      // Stored as either kind, decoded to a number: the row holds either.
      expect(kinds(nested(Both, Schema.Number), storedFieldAtPath)).toEqual(["bigint", "number"])
      // Untransformed, both sides agree.
      const plain = Schema.Struct({ n: Schema.BigInt })
      expect(kinds(plain, storedFieldAtPath)).toEqual(kinds(plain, fieldAtPath))
      expect(storedFieldAtPath({ n: Schema.Number }, "n")).toBeDefined()
    })

    it("judges at write only a key composite that may not read back as itself", () => {
      for (const field of [
        Schema.Unknown,
        Schema.Any,
        Schema.declare((n: unknown): n is number => typeof n === "number"),
        Schema.NumberFromString,
        Schema.BigIntFromString,
        Schema.DateTimeUtcFromString,
        Schema.Union([Schema.String, Schema.NumberFromString]),
        Schema.Struct({ n: Schema.NumberFromString }),
      ]) {
        expect(readBackUnsure(field)).toBe(true)
      }
      for (const field of [
        Schema.Number,
        Schema.BigInt,
        Schema.String,
        Schema.Union([Schema.String, Schema.BigInt]),
        Schema.Literals(["a", "b"]),
        Schema.Number.pipe(Schema.brand("N")),
      ]) {
        expect(readBackUnsure(field)).toBe(false)
      }
    })

    it("gives a numeric value as the other kind, from the digits stored", () => {
      expect(otherNumericKind(5, undefined)).toBe(5n)
      expect(otherNumericKind(7n, undefined)).toBe(7)
      expect(otherNumericKind(1.5, undefined)).toBeUndefined()
      expect(otherNumericKind("5", undefined)).toBeUndefined()
      // The digits stored, not the number they read back as.
      expect(otherNumericKind(Number(2n ** 60n + 1n), String(2n ** 60n + 1n))).toBe(2n ** 60n + 1n)
      expect(otherNumericKind(1.5, "1.5")).toBeUndefined()
    })

    describe("the reading a key was composed from", () => {
      // A key of `width` numeric composites, each as its own kind's text.
      const composite = (value: unknown) =>
        typeof value === "bigint" ? `b${String(value).padStart(6, "0")}` : `n${value}`
      const fields = (width: number) => Array.from({ length: width }, (_, i) => `f${i}`)
      const counting = (width: number, values: (i: number) => unknown) => {
        let compositions = 0
        const record = Object.fromEntries(fields(width).map((field, i) => [field, values(i)]))
        const compose = ({ record: given }: { record: Record<string, unknown> }) => {
          compositions++
          return `$app#v1#e#${fields(width)
            .map((field) => composite(given[field]))
            .join("#")}`
        }
        return { record, compose, count: () => compositions }
      }

      it("composes the values once when that is the key", () => {
        const { record, compose, count } = counting(18, () => 5)
        const reading = kindReadingOf(
          record,
          fields(18),
          () => undefined,
          compose,
          compose({ record }),
        )
        expect(reading?.asOther.size).toBe(0)
        // One composition here, one for the key the test built.
        expect(count()).toBe(2)
      })

      it("finds a mix of kinds composing once per field, not once per combination", () => {
        const width = 18
        const { record, compose, count } = counting(width, () => 5)
        const mixed = Object.fromEntries(
          fields(width).map((field, i) => [field, i % 3 === 0 ? 5n : 5]),
        )
        const stored = compose({ record: mixed })
        const before = count()
        const reading = kindReadingOf(record, fields(width), () => undefined, compose, stored)
        expect([...(reading?.asOther ?? [])].sort()).toEqual(
          fields(width)
            .filter((_, i) => i % 3 === 0)
            .sort(),
        )
        expect(reading?.record).toEqual(mixed)
        // The values, each field alone as the other kind, and the reading found.
        expect(count() - before).toBe(1 + width + 1)
      })

      it("finds one field alone as soon as it is composed", () => {
        const { record, compose, count } = counting(4, () => 5)
        const stored = compose({ record: { ...record, f2: 5n } })
        const before = count()
        expect([
          ...(kindReadingOf(record, fields(4), () => undefined, compose, stored)?.asOther ?? []),
        ]).toEqual(["f2"])
        expect(count() - before).toBe(1 + 3)
      })

      it("finds none for a key no reading composes", () => {
        const { record, compose } = counting(4, () => 5)
        expect(
          kindReadingOf(record, fields(4), () => undefined, compose, "$app#v1#e#n5#n6#n5#n5"),
        ).toBeUndefined()
        expect(
          kindReadingOf(
            record,
            fields(4),
            () => undefined,
            () => undefined,
            "x",
          ),
        ).toBeUndefined()
      })

      it("looks for a reading among several texts", () => {
        const { record, compose } = counting(3, () => 5)
        const texts = kindTargets([
          compose({ record: { ...record, f0: 5n, f2: 5n } }),
          "$app#v1#e#n5#n5#n5",
          "$app#v1#f",
        ])
        expect(texts.has("$app#v1#f")).toBe(true)
        expect(texts.hasPrefix("$app#v1#e#b")).toBe(true)
        expect(texts.hasPrefix("$app#v1#g")).toBe(false)
        const others = {
          has: (text: string) => text !== compose({ record }) && texts.has(text),
          hasPrefix: texts.hasPrefix,
        }
        expect(
          [
            ...(kindReadingOf(record, fields(3), () => undefined, compose, others)?.asOther ?? []),
          ].sort(),
        ).toEqual(["f0", "f2"])
      })

      it("reads a field in several segments as one kind in all of them", () => {
        // A key whose two halves both hold `a` and `b`, as `pk [a, b], sk [a, b]` does.
        const record = { a: 3, b: 5 }
        let compositions = 0
        const halves = ({ record: given }: { record: Record<string, unknown> }) => {
          compositions++
          const text = `${composite(given.a)}#${composite(given.b)}`
          return [`pk=${text}`, `|sk=${text}`]
        }
        const both = { a: 3n, b: 5n }
        const stored = halves({ record: both }).join("")
        compositions = 0
        const reading = kindReadingOf(record, ["a", "b"], () => undefined, halves, stored)
        expect([...(reading?.asOther ?? [])].sort()).toEqual(["a", "b"])
        expect(reading?.record).toEqual(both)
        // The values, each field alone, and the reading found.
        expect(compositions).toBe(1 + 2 + 1)
        // A field read as one kind in one half and the other kind in the other is no reading.
        const split = `pk=${composite(3n)}#${composite(5)}|sk=${composite(3)}#${composite(5)}`
        expect(kindReadingOf(record, ["a", "b"], () => undefined, halves, split)).toBeUndefined()
        // The same composer as one text can't tell `a`'s stretches from `b`'s.
        const whole = (reading: { record: Record<string, unknown> }) => halves(reading).join("")
        expect(kindReadingOf(record, ["a", "b"], () => undefined, whole, stored)).toBeUndefined()
      })

      it("reads each field alone as the other kind when a composer doesn't keep values apart", () => {
        // Every value's kind shows in one character at the end: no field has a stretch of its own.
        const record = { a: 5, b: 5 }
        const compose = ({ record: given }: { record: Record<string, unknown> }) =>
          `k${Object.values(given).filter((value) => typeof value === "bigint").length}`
        expect([
          ...(kindReadingOf(record, ["a", "b"], () => undefined, compose, "k1")?.asOther ?? []),
        ]).toEqual(["a"])
        expect(kindReadingOf(record, ["a", "b"], () => undefined, compose, "k2")).toBeUndefined()
      })
    })

    it("refuses a key over a field storing both, and only that (EDD-9128)", () => {
      const refusal = (field: Schema.Top) =>
        bothKindsKeyRefusal('Entity "E"', "the primary key", "n", field)?.message
      expect(refusal(Schema.Union([Schema.Number, Schema.BigInt]))).toMatch(
        /^\[EDD-9128\] Entity "E": the primary key can't be composed from "n", which stores both/,
      )
      // Unknown and Any declare no kind: their values are judged at write.
      expect(refusal(Schema.Unknown)).toBeUndefined()
      expect(refusal(Schema.Any)).toBeUndefined()
      expect(refusal(Schema.Union([Schema.Literal(1), Schema.Literal(2n)]))).toMatch(/EDD-9128/)
      expect(refusal(Schema.BigInt)).toBeUndefined()
      expect(refusal(Schema.Number)).toBeUndefined()
      expect(refusal(Schema.Union([Schema.String, Schema.BigInt]))).toBeUndefined()
      expect(refusal(Schema.BigIntFromString)).toBeUndefined()
    })
  })

  describe("a transformed field read back from its stored form", () => {
    // `OptionFromNullOr(BigInt)` and a `BigInt` under a decoding default store a bigint as `N`,
    // which the unmarshaller hands back as a number below 2^53. Neither encode nor decode takes
    // a number, so the rule tries the bigint it was stored from.
    const BIG = 2n ** 60n + 1n
    const Stored = Schema.Struct({
      opt: Schema.OptionFromNullOr(Schema.BigInt),
      dflt: Schema.BigInt.pipe(Schema.withDecodingDefault(Effect.succeed(7n))),
      optNum: Schema.OptionFromNullOr(Schema.Number),
      bfs: Schema.BigIntFromString,
    })
    const fromRow = makeCompositeKeyForm(Stored, refuse)

    it("a safe-integer number is the bigint put composed from", () => {
      expect(fromRow("opt", 5)).toBe(5n)
      expect(fromRow("opt", Option.some(5n))).toBe(5n)
      expect(serializeValue(fromRow("opt", 5))).toBe(
        serializeValue(fromRow("opt", Option.some(5n))),
      )
      expect(fromRow("dflt", 5)).toBe(5n)
      expect(fromRow("dflt", 5n)).toBe(5n)
    })

    it("past 2^53 the unmarshaller already hands back a bigint", () => {
      expect(fromRow("opt", BIG)).toBe(BIG)
      expect(fromRow("opt", Option.some(BIG))).toBe(BIG)
      expect(fromRow("dflt", BIG)).toBe(BIG)
    })

    it("a number Encoded side takes a bigint as a number", () => {
      expect(fromRow("optNum", 12n)).toBe(12)
      expect(fromRow("optNum", 12)).toBe(12)
    })

    it("the stored value takes the steps put's value took", () => {
      // One type on both sides. The write path hands the rule the encoded record, 5n for a domain
      // 50n, stored as `{N:"5"}`: read back as 5, it composes what put composed from 5n.
      const Tenfold = Schema.BigInt.pipe(
        Schema.decodeTo(Schema.BigInt, {
          decode: SchemaGetter.transform((n: bigint) => n * 10n),
          encode: SchemaGetter.transform((n: bigint) => n / 10n),
        }),
      )
      const form = makeCompositeKeyForm(Schema.Struct({ t: Tenfold }), refuse)
      expect(form("t", 5)).toBe(form("t", 5n))
    })

    it("a value as given is tried before its stored form", () => {
      // A domain bigint stored as a number: encoded, never taken for the number it's stored as.
      const Tenth = Schema.Number.pipe(
        Schema.decodeTo(Schema.BigInt, {
          decode: SchemaGetter.transform((n: number) => BigInt(n) * 10n),
          encode: SchemaGetter.transform((n: bigint) => Number(n / 10n)),
        }),
      )
      const form = makeCompositeKeyForm(Schema.Struct({ t: Tenth }), refuse)
      expect(form("t", 50n)).toBe(5)
    })

    it("a stored value no form takes is still refused", () => {
      const Positive = Schema.OptionFromNullOr(Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)))
      const form = makeCompositeKeyForm(Schema.Struct({ p: Positive }), refuse)
      expect(form("p", 5)).toBe(5n)
      expect(() => form("p", -5)).toThrow(/EDD-9050.*p/)
    })

    it("a value that was never stored is still refused", () => {
      expect(() => fromRow("opt", 2.5)).toThrow(/EDD-9050.*opt/)
      expect(() => fromRow("opt", Number.MAX_SAFE_INTEGER + 2)).toThrow(/EDD-9050.*opt/)
      expect(() => fromRow("opt", "abc")).toThrow(/EDD-9050.*opt/)
    })

    it("`reads` refuses only an attribute a key is composed from", () => {
      const keyed = makeCompositeKeyForm(Stored, refuse, { reads: (attr) => attr === "opt" })
      expect(() => keyed("opt", "abc")).toThrow(/EDD-9050.*opt/)
      // Not key text: left as it is, in both the Encoded and the numeric-Type branch.
      expect(keyed("dflt", "abc")).toBe("abc")
      expect(keyed("bfs", "abc")).toBe("abc")
      expect(() => fromRow("bfs", "abc")).toThrow(/EDD-9050.*bfs/)
      expect(keyed("bfs", 2.5)).toBe(2.5)
      expect(() => fromRow("bfs", 2.5)).toThrow(/EDD-9050.*bfs/)
      // A value either form takes is the same whatever `reads` says.
      expect(keyed("dflt", 5)).toBe(5n)
      expect(keyed("bfs", "5")).toBe(5n)
    })
  })

  describe("null and undefined", () => {
    it("passes through so sparse-composite handling stays with KeyComposer", () => {
      expect(encode("txn", undefined)).toBeUndefined()
      expect(encode("txn", null)).toBeNull()
    })
  })

  describe("encodeCompositeRecord", () => {
    it("encodes every entry, leaving untransformed ones alone", () => {
      expect(toCompositeKeyRecord(encode, { id: "a", status: "done", txn: 7n })).toEqual({
        id: "a",
        status: "done",
        txn: 7n,
      })
    })

    it("returns an empty record unchanged", () => {
      expect(toCompositeKeyRecord(encode, {})).toEqual({})
    })
  })

  describe("models without a fields record", () => {
    it("passes everything through", () => {
      const encodeAny = makeCompositeKeyForm(Schema.String, refuse)
      expect(encodeAny("whatever", 1)).toBe(1)
    })
  })
})
