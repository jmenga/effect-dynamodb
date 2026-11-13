/**
 * `storedSegments`: the names a path below a field is stored under (#238). A segment that is a
 * property's own name, in a struct that renames its keys as it's stored (`Schema.encodeKeys`), is
 * named as stored; a segment that is a stored name is kept as it is, even where it's also another
 * property's own name; and from any node whose stored names aren't known, the rest is kept.
 */
import { Schema, SchemaGetter, SchemaTransformation } from "effect"
import { describe, expect, it } from "vitest"
import { storedSegments } from "../src/internal/SchemaAccessors.js"

const Amount = Schema.Struct({
  amount: Schema.Number,
  note: Schema.optional(Schema.String),
}).pipe(Schema.encodeKeys({ amount: "am" }))
const Swap = Schema.Struct({ a: Schema.Number, b: Schema.Number }).pipe(
  Schema.encodeKeys({ a: "b", b: "a" }),
)
const Deep = Schema.Struct({ deep: Schema.Number }).pipe(Schema.encodeKeys({ deep: "dp" }))
const Outer = Schema.Struct({ inner: Deep, list: Schema.Array(Deep) }).pipe(
  Schema.encodeKeys({ inner: "in" }),
)
const HeldFields = Schema.Struct({ amount: Schema.Number })
// A class takes a struct whose keys are renamed, though its type names only a bare one.
class Held extends Schema.Class<Held>("StoredSegmentsHeld")(
  HeldFields.pipe(Schema.encodeKeys({ amount: "am" })) as unknown as typeof HeldFields,
) {}

type Case = readonly [
  name: string,
  field: Schema.Top,
  path: ReadonlyArray<string | number>,
  stored: ReadonlyArray<string | number>,
]

const CASES: ReadonlyArray<Case> = [
  ["a property's own name", Amount, ["amount"], ["am"]],
  ["its stored name", Amount, ["am"], ["am"]],
  ["a property kept as it is", Amount, ["note"], ["note"]],
  ["a name the struct doesn't have", Amount, ["other"], ["other"]],
  ["keys renamed onto each other's names: a", Swap, ["a"], ["a"]],
  ["keys renamed onto each other's names: b", Swap, ["b"], ["b"]],
  ["two levels down", Outer, ["inner", "deep"], ["in", "dp"]],
  ["two levels down, by stored names", Outer, ["in", "dp"], ["in", "dp"]],
  ["two levels down, the stored name then the own one", Outer, ["in", "deep"], ["in", "dp"]],
  ["through a list", Outer, ["list", 1, "deep"], ["list", 1, "dp"]],
  ["through a record", Schema.Record(Schema.String, Deep), ["k", "deep"], ["k", "dp"]],
  ["through a class", Held, ["amount"], ["am"]],
  [
    "through an optional, nullable struct",
    Schema.optional(Schema.NullOr(Amount)),
    ["amount"],
    ["am"],
  ],
  [
    "through a union whose other member doesn't hold it",
    Schema.Union([Amount, Schema.Struct({ x: Schema.Number })]),
    ["amount"],
    ["am"],
  ],
  [
    "through a union whose members name it differently: kept",
    Schema.Union([Amount, Schema.Struct({ amount: Schema.Number })]),
    ["amount"],
    ["amount"],
  ],
  [
    "below a struct stored as JSON: kept",
    Schema.Struct({ j: Schema.fromJsonString(Amount) }),
    ["j", "amount"],
    ["j", "amount"],
  ],
  [
    "below a node it doesn't know: the rest kept",
    Schema.Struct({ u: Schema.Union([Schema.Unknown, Amount]) }),
    ["u", "amount"],
    ["u", "amount"],
  ],
  ["below a scalar: kept", Schema.Struct({ s: Schema.String }), ["s", "amount"], ["s", "amount"]],
  [
    "a struct of plain keys: as it is",
    Schema.Struct({ a: Schema.Struct({ b: Schema.Array(Schema.Number) }) }),
    ["a", "b", 0],
    ["a", "b", 0],
  ],
  [
    "a struct checked after its keys are renamed",
    Amount.check(Schema.makeFilter(() => true)),
    ["amount"],
    ["am"],
  ],
  [
    "a struct whose step only maps values: kept",
    Schema.Struct({ amount: Schema.Number }).pipe(
      Schema.decodeTo(
        Schema.Struct({ amount: Schema.Number }),
        SchemaTransformation.transform({
          decode: (value: { readonly amount: number }) => ({ amount: value.amount + 1 }),
          encode: (value: { readonly amount: number }) => ({ amount: value.amount - 1 }),
        }),
      ),
    ),
    ["amount"],
    ["amount"],
  ],
  [
    "a struct whose step defaults a key its stored struct may leave out: kept",
    Schema.Struct({ amount: Schema.optionalKey(Schema.Number) }).pipe(
      Schema.decodeTo(Schema.Struct({ amount: Schema.Number }), {
        decode: SchemaGetter.transform((value: { readonly amount?: number }) => ({
          amount: value.amount ?? 0,
        })),
        encode: SchemaGetter.transform((value: { readonly amount: number }) => ({
          amount: value.amount,
        })),
      }),
    ),
    ["amount"],
    ["amount"],
  ],
  [
    "a struct whose step renames a key it stores optional: kept, the step isn't run",
    Schema.Struct({ am: Schema.optionalKey(Schema.Number) }).pipe(
      Schema.decodeTo(Schema.Struct({ amount: Schema.Number }), {
        decode: SchemaGetter.transform((value: { readonly am?: number }) => ({
          amount: value.am ?? 0,
        })),
        encode: SchemaGetter.transform((value: { readonly amount: number }) => ({
          am: value.amount,
        })),
      }),
    ),
    ["amount"],
    ["amount"],
  ],
  [
    "a struct naming a key JavaScript lists first: kept",
    Schema.Struct({ a: Schema.Number, "0": Schema.Number }).pipe(Schema.encodeKeys({ a: "1" })),
    ["a"],
    ["a"],
  ],
]

describe("storedSegments", () => {
  for (const [name, field, path, stored] of CASES) {
    it(name, () => expect(storedSegments(field, path)).toEqual(stored))
  }
})
