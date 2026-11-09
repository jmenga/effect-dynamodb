/**
 * Which `many` element values `create` fetches the edge's entity for, and what the element's input
 * schema takes. A union element is judged as 1.39.0 judged it: a string `${field}Id`, whatever member
 * the value is, its input the union as declared. Any other element is fetched for when its field of
 * the entity's name can hold the entity's record and it's given a `${field}Id`, of the key
 * composite's type. The hydration itself is `effect-dynamodb`'s `AggregateRefHydration.test.ts`.
 */

import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"
import type { RefEntity } from "../src/internal/AggregateEdges.js"
import {
  deriveElementInputSchema,
  elementHoldsRef,
  isUnionElement,
} from "../src/internal/AggregateSchemas.js"

class Line extends Schema.Class<Line>("Line")({ lineId: Schema.String, f: Schema.Number }) {}
const Lines = Entity.make({
  model: DynamoModel.configure(Line, { lineId: { identifier: true } }),
  entityType: "Line",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
}) as unknown as RefEntity
const line = Line.pipe(DynamoModel.ref)

class Numbered extends Schema.Class<Numbered>("Numbered")({
  lineId: Schema.Number,
  f: Schema.Number,
}) {}
const NumberedLines = Entity.make({
  model: Numbered,
  entityType: "Numbered",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
}) as unknown as RefEntity

const holdsRef = (element: Schema.Top, value: Record<string, unknown>) =>
  elementHoldsRef(element, Lines, value)

class Scalar extends Schema.Class<Scalar>("Scalar")({
  kind: Schema.Literal("a"),
  line: Schema.String,
  lineId: Schema.String,
  at: Schema.Date,
  qty: Schema.Number,
}) {}
class Wrapping extends Schema.Class<Wrapping>("Wrapping")({
  kind: Schema.Literal("a"),
  line,
  qty: Schema.Number,
}) {}

/** Union elements of every shape the earlier rounds judged by member. */
const unions: ReadonlyArray<readonly [string, Schema.Top]> = [
  [
    "a checked nested union first",
    Schema.Union([
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("a"),
          line: Schema.optional(Schema.String),
          qty: Schema.Number,
        }),
        Schema.Struct({ kind: Schema.Literal("b"), line: Schema.String, qty: Schema.Number }),
      ]).check(Schema.makeFilter((sheet: { readonly qty: number }) => sheet.qty > 10)),
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
    ]),
  ],
  [
    "a checked union",
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
      Schema.Struct({ kind: Schema.Literal("b"), line: Schema.String, qty: Schema.Number }),
    ]).check(Schema.makeFilter((sheet: { readonly qty: number }) => sheet.qty > 0)),
  ],
  [
    "a member typing its own id",
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("a"),
        line: Schema.String,
        lineId: Schema.Number,
        qty: Schema.Number,
      }),
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
    ]),
  ],
  [
    "a oneOf union",
    Schema.Union(
      [
        Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
        Schema.Struct({
          kind: Schema.Literal("b"),
          line: Schema.String,
          lineId: Schema.String,
          qty: Schema.Number,
        }),
      ],
      { mode: "oneOf" },
    ),
  ],
  ["class members", Schema.Union([Scalar, Wrapping])],
  [
    "a member declaring the field a scalar first",
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("a"),
        line: Schema.optional(Schema.String),
        qty: Schema.Number,
      }),
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
    ]),
  ],
  ["a nullable reference", Schema.NullOr(Schema.Struct({ line, qty: Schema.Number }))],
]

const values: ReadonlyArray<Record<string, unknown>> = [
  { kind: "a", lineId: "l", qty: 1 },
  { kind: "a", lineId: "l", qty: 11 },
  { kind: "b", line: "x", lineId: "l", qty: 1 },
  { kind: "a", line: "KEEP", lineId: "l", at: "2024-01-02T03:04:05.000Z", qty: 1 },
  { kind: "a", line: "KEEP", lineId: 123, qty: 1 },
  { kind: "a", lineId: 5n, qty: 1 },
  { kind: "a", lineId: null, qty: 1 },
  { kind: "b", line: "x", qty: 1 },
  { kind: "a", qty: 1 },
]

describe("a union element is judged as on 1.39.0", () => {
  for (const [name, element] of unions) {
    it(`${name}: a string id, whatever the member`, () => {
      expect(isUnionElement(element)).toBe(true)
      for (const value of values) {
        expect(holdsRef(element, value)).toBe(typeof value.lineId === "string")
      }
    })

    it(`${name}: its input is the union as declared`, () => {
      expect(deriveElementInputSchema(Schema.Array(element), Lines)).toBe(element)
    })
  }

  it("an entity keyed by a number: still a string id, as 1.39.0 fetched it", () => {
    const element = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), numbered: Numbered, qty: Schema.Number }),
      Schema.Struct({ kind: Schema.Literal("b"), qty: Schema.Number }),
    ])
    expect(elementHoldsRef(element, NumberedLines, { kind: "a", numberedId: "5", qty: 1 })).toBe(
      true,
    )
    expect(elementHoldsRef(element, NumberedLines, { kind: "a", numberedId: 5, qty: 1 })).toBe(
      false,
    )
  })
})

describe("any other element holds a reference when its field can hold the entity's record", () => {
  it("a struct wrapping the entity: an id of the key composite's type, a number included", () => {
    const element = Schema.Struct({ numbered: Numbered, qty: Schema.Number })
    expect(elementHoldsRef(element, NumberedLines, { numberedId: 5, qty: 1 })).toBe(true)
    expect(elementHoldsRef(element, NumberedLines, { numberedId: "5", qty: 1 })).toBe(true)
    expect(elementHoldsRef(element, NumberedLines, { qty: 1 })).toBe(false)
    expect(elementHoldsRef(element, NumberedLines, { numberedId: null, qty: 1 })).toBe(false)
  })

  it("through optional, a brand and a class", () => {
    class Wrapped extends Schema.Class<Wrapped>("Wrapped")({
      line: Schema.optional(line),
      qty: Schema.Number,
    }) {}
    for (const element of [
      Wrapped,
      Schema.Struct({ line: Schema.optional(line), qty: Schema.Number }),
      Schema.Struct({ line: line.pipe(Schema.brand("LineRef")), qty: Schema.Number }),
    ]) {
      expect(isUnionElement(element)).toBe(false)
      expect(holdsRef(element, { lineId: "l", qty: 1 })).toBe(true)
      expect(holdsRef(element, { qty: 1 })).toBe(false)
    }
  })

  it("a field of the entity's name declared a scalar holds no reference", () => {
    const element = Schema.Struct({
      line: Schema.String,
      lineId: Schema.String,
      qty: Schema.Number,
    })
    expect(holdsRef(element, { line: "x", lineId: "l", qty: 1 })).toBe(false)
    expect(deriveElementInputSchema(Schema.Array(element), Lines)).toBe(element)
  })

  it("the entity's own model, given whole, holds its own id", () => {
    expect(holdsRef(Line, { lineId: "l", f: 1 })).toBe(false)
  })
})
