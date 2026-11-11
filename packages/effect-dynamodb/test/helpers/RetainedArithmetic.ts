/**
 * Record operations that compute a value from the row's own: `.add()` of a number or a set,
 * `.subtract()` and `.deleteFromSet()`. An update sends each as an expression (`ADD`,
 * `SET #f = #f - :v`, `DELETE`) and DynamoDB computes it, except one that reads the row first
 * (`helpers/ReadFirstUpdates.ts`: a retained entity's, one changing a unique field, one computing
 * an index composite), which computes it from the row it read (#236). Each case is one input, and
 * `stored` is the attribute DynamoDB stores for it (`undefined`: DynamoDB refuses the write),
 * checked against DynamoDB Local by `connected.retained-arithmetic.test.ts`, which runs both paths.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Schema } from "effect"

export const arithmeticModel = Schema.Struct({
  id: Schema.String,
  // What `helpers/ReadFirstUpdates.ts`'s configurations name.
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  rank: Schema.optional(Schema.Number),
  big: Schema.optional(Schema.BigInt),
  n: Schema.optional(Schema.Number),
  bigs: Schema.optional(Schema.ReadonlySet(Schema.BigInt)),
  ns: Schema.optional(Schema.ReadonlySet(Schema.Number)),
  bins: Schema.optional(Schema.ReadonlySet(Schema.Uint8Array)),
})

export interface ArithmeticCase {
  readonly name: string
  /** Item `a` as put, before the update. */
  readonly seed: Record<string, unknown>
  readonly apply: (update: any) => any
  /** The attribute the case is about. */
  readonly attribute: string
  /** What DynamoDB stores there, or `undefined` where it refuses the update. */
  readonly stored: AttributeValue | undefined
}

const ABOVE = 9007199254740993n // 2^53 + 1
const DIGITS_38 = 12345678901234567890123456789012345678n
const NINES_38 = 99999999999999999999999999999999999999n
const bytes = (...values: ReadonlyArray<number>) => new Uint8Array(values)

export const arithmeticCases: ReadonlyArray<ArithmeticCase> = [
  // A bigint field, below 2^53.
  {
    name: "bigint 5 + 2",
    seed: { big: 5n },
    apply: (u) => u.add({ big: 2n }),
    attribute: "big",
    stored: { N: "7" },
  },
  {
    name: "bigint 5 - 2",
    seed: { big: 5n },
    apply: (u) => u.subtract({ big: 2n }),
    attribute: "big",
    stored: { N: "3" },
  },
  {
    name: "bigint 5 - 7, negative",
    seed: { big: 5n },
    apply: (u) => u.subtract({ big: 7n }),
    attribute: "big",
    stored: { N: "-2" },
  },
  {
    name: "bigint absent + 2",
    seed: {},
    apply: (u) => u.add({ big: 2n }),
    attribute: "big",
    stored: { N: "2" },
  },
  // Across and above 2^53.
  {
    name: "bigint 2^53 - 3 + 10, across 2^53",
    seed: { big: 9007199254740989n },
    apply: (u) => u.add({ big: 10n }),
    attribute: "big",
    stored: { N: "9007199254740999" },
  },
  {
    name: "bigint 2^53 + 1 + 2",
    seed: { big: ABOVE },
    apply: (u) => u.add({ big: 2n }),
    attribute: "big",
    stored: { N: "9007199254740995" },
  },
  {
    name: "bigint 2^53 + 1 - 2, back below 2^53",
    seed: { big: ABOVE },
    apply: (u) => u.subtract({ big: 2n }),
    attribute: "big",
    stored: { N: "9007199254740991" },
  },
  {
    name: "bigint -(2^53 + 1) - 10, negative",
    seed: { big: -ABOVE },
    apply: (u) => u.subtract({ big: 10n }),
    attribute: "big",
    stored: { N: "-9007199254741003" },
  },
  {
    name: "bigint 5 - (2^53 + 1), negative",
    seed: { big: 5n },
    apply: (u) => u.subtract({ big: ABOVE }),
    attribute: "big",
    stored: { N: "-9007199254740988" },
  },
  {
    name: "bigint 38 digits + 1",
    seed: { big: DIGITS_38 },
    apply: (u) => u.add({ big: 1n }),
    attribute: "big",
    stored: { N: "12345678901234567890123456789012345679" },
  },
  // DynamoDB refuses a number of 39 significant digits.
  {
    name: "bigint 38 nines + 2, over 38 digits",
    seed: { big: NINES_38 },
    apply: (u) => u.add({ big: 2n }),
    attribute: "big",
    stored: undefined,
  },
  // A number field.
  {
    name: "number 5 + 2",
    seed: { n: 5 },
    apply: (u) => u.add({ n: 2 }),
    attribute: "n",
    stored: { N: "7" },
  },
  {
    name: "number 0.2 + 0.1",
    seed: { n: 0.2 },
    apply: (u) => u.add({ n: 0.1 }),
    attribute: "n",
    stored: { N: "0.3" },
  },
  {
    name: "number 0.3 - 0.1",
    seed: { n: 0.3 },
    apply: (u) => u.subtract({ n: 0.1 }),
    attribute: "n",
    stored: { N: "0.2" },
  },
  {
    name: "number 1.5 - 4, negative",
    seed: { n: 1.5 },
    apply: (u) => u.subtract({ n: 4 }),
    attribute: "n",
    stored: { N: "-2.5" },
  },
  // Sets: a union and a difference are of values, whatever type a read gives each.
  {
    name: "bigint set {5} + {2, 5}",
    seed: { bigs: new Set([5n]) },
    apply: (u) => u.add({ bigs: new Set([2n, 5n]) }),
    attribute: "bigs",
    stored: { NS: ["2", "5"] },
  },
  {
    name: "bigint set {5, 7} less {5}",
    seed: { bigs: new Set([5n, 7n]) },
    apply: (u) => u.deleteFromSet({ bigs: new Set([5n]) }),
    attribute: "bigs",
    stored: { NS: ["7"] },
  },
  {
    name: "bigint set {2^53 + 1} + {2^53 + 1, 1}",
    seed: { bigs: new Set([ABOVE]) },
    apply: (u) => u.add({ bigs: new Set([ABOVE, 1n]) }),
    attribute: "bigs",
    stored: { NS: ["1", "9007199254740993"] },
  },
  {
    name: "number set {1, 2} + {2, 3}",
    seed: { ns: new Set([1, 2]) },
    apply: (u) => u.add({ ns: new Set([2, 3]) }),
    attribute: "ns",
    stored: { NS: ["1", "2", "3"] },
  },
  {
    name: "binary set {[1]} + {[1], [2]}",
    seed: { bins: new Set([bytes(1)]) },
    apply: (u) => u.add({ bins: new Set([bytes(1), bytes(2)]) }),
    attribute: "bins",
    stored: { BS: [bytes(1), bytes(2)] },
  },
  {
    name: "binary set {[1], [2]} less {[1]}",
    seed: { bins: new Set([bytes(1), bytes(2)]) },
    apply: (u) => u.deleteFromSet({ bins: new Set([bytes(1)]) }),
    attribute: "bins",
    stored: { BS: [bytes(2)] },
  },
]

/** An attribute with a set's members in one order, to compare two stored sets. */
export const sorted = (value: AttributeValue | undefined): unknown => {
  if (value === undefined) return undefined
  const key = (member: unknown) =>
    member instanceof Uint8Array ? [...member].join(",") : String(member)
  for (const kind of ["NS", "SS", "BS"] as const) {
    const members = (value as unknown as Record<string, ReadonlyArray<unknown> | undefined>)[kind]
    if (members !== undefined) {
      return { [kind]: [...members].map(key).sort() }
    }
  }
  return value
}
