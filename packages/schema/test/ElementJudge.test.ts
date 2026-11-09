/**
 * How `create` judges a `many` element value: whether it holds a ref of the edge's entity, by
 * `inputSchema`'s own decode of it. The value is hydrated when that decode is a reference member's,
 * so the member, a union's order and mode, and every check are the decode's own. In an element that
 * has a reference member, a member that doesn't declare `${field}Id` refuses one, and a union holding
 * a reference member keeps no check of its own: up to 1.39.0 `create` hydrated every such value and
 * then decoded it. A value `inputSchema` refuses as given is read in the form `create` takes it, and
 * one neither takes is judged by 1.39.0's rule: a string `${field}Id`. The hydration itself is
 * `effect-dynamodb`'s `AggregateRefHydration.test.ts`.
 */

import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"
import type { RefEntity } from "../src/internal/AggregateEdges.js"
import {
  aggregateStamps,
  deriveElementInputSchema,
  elementHoldsRef,
} from "../src/internal/AggregateSchemas.js"

class Line extends Schema.Class<Line>("Line")({ lineId: Schema.String, f: Schema.Number }) {}
const Lines = Entity.make({
  model: DynamoModel.configure(Line, { lineId: { identifier: true } }),
  entityType: "Line",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
}) as unknown as RefEntity
const line = Line.pipe(DynamoModel.ref)

const holdsRef = (element: Schema.Top, value: Record<string, unknown>) =>
  elementHoldsRef(element, Lines, value)

/** `inputSchema`'s own decode of an element value: its JSON codec, as `Aggregate.make` builds it. */
const decoded = (element: Schema.Top, value: Record<string, unknown>) => {
  const input = deriveElementInputSchema(Schema.Array(element), Lines)!
  return Option.map(
    Schema.decodeUnknownOption(Schema.toCodecJson(Schema.Array(input as Schema.Codec<unknown>)))([
      value,
    ]),
    (values) => (values as ReadonlyArray<unknown>)[0],
  )
}

describe("a many element is judged as its input decodes it", () => {
  it("a checked union first: hydrated whenever its members don't take the id", () => {
    const element = Schema.Union([
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("a"),
          line: Schema.optional(Schema.String),
          qty: Schema.Number,
        }),
        Schema.Struct({
          kind: Schema.Literal("b"),
          line: Schema.optional(Schema.String),
          qty: Schema.Number,
        }),
      ]).check(Schema.makeFilter((sheet: { readonly qty: number }) => sheet.qty > 10)),
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
    ])
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 1 })).toBe(true)
    // Its check passes, but its members refuse the id: 1.39.0 hydrated it, the first member
    // refused the fetched record as a string, and the reference member stored it.
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 11 })).toBe(true)
    expect(decoded(element, { kind: "a", lineId: "l", qty: 11 })).toEqual(
      Option.some({ kind: "a", lineId: "l", qty: 11 }),
    )
    expect(holdsRef(element, { kind: "a", qty: 11 })).toBe(false)
  })

  it("a check on the whole element's union runs on the hydrated value, never on the id", () => {
    const element = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
      Schema.Struct({ kind: Schema.Literal("b"), line: Schema.String, qty: Schema.Number }),
    ]).check(Schema.makeFilter((sheet: { readonly qty: number }) => sheet.qty > 0))
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 1 })).toBe(true)
    expect(holdsRef(element, { kind: "b", line: "x", qty: 1 })).toBe(false)
    // Refused by its check once hydrated, as 1.39.0 refused it.
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 0 })).toBe(true)
    // A stray id on the member holding no ref: the input refuses it, so 1.39.0's rule holds, and
    // `create` hydrates it and fails decoding, as 1.39.0 did.
    expect(decoded(element, { kind: "b", line: "x", lineId: "l", qty: 1 })).toEqual(Option.none())
    expect(holdsRef(element, { kind: "b", line: "x", lineId: "l", qty: 1 })).toBe(true)
  })

  it("the id as the entity's key composite: a member typing its own id takes another type", () => {
    for (const refFirst of [true, false]) {
      const wrapping = Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number })
      const typed = Schema.Struct({
        kind: Schema.Literal("a"),
        line: Schema.String,
        lineId: Schema.Number,
        qty: Schema.Number,
      })
      const element = Schema.Union(refFirst ? [wrapping, typed] : [typed, wrapping])
      expect(holdsRef(element, { kind: "a", line: "KEEP", lineId: 123, qty: 1 })).toBe(false)
      expect(holdsRef(element, { kind: "a", lineId: "l", qty: 1 })).toBe(true)
    }
  })

  it("a `oneOf` union: a value two members take is no member's", () => {
    const element = Schema.Union(
      [
        Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
        Schema.Struct({ kind: Schema.Literal("a"), lineId: Schema.String, qty: Schema.Number }),
      ],
      { mode: "oneOf" },
    )
    // Both take it, so the input refuses it: 1.39.0's rule holds.
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 1 })).toBe(true)
    const distinct = Schema.Union(
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
    )
    expect(holdsRef(distinct, { kind: "b", line: "x", lineId: "l", qty: 1 })).toBe(false)
    expect(holdsRef(distinct, { kind: "a", lineId: "l", qty: 1 })).toBe(true)
  })

  it("class members, one with a transformed field: decoded as the input decodes it", () => {
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
    const element = Schema.Union([Scalar, Wrapping])
    const at = new Date("2024-01-02T03:04:05.000Z")
    // Its encoded date is a string: the input takes the value as the scalar member.
    const given = { kind: "a", line: "KEEP", lineId: "l", at: at.toISOString(), qty: 1 }
    expect(holdsRef(element, given)).toBe(false)
    expect(Option.map(decoded(element, given), (value) => value instanceof Scalar)).toEqual(
      Option.some(true),
    )
    // Given a `Date`, the input refuses the scalar member and takes the wrapping one: hydrated,
    // as 1.39.0 hydrated it.
    expect(holdsRef(element, { ...given, at })).toBe(true)
    expect(decoded(element, { ...given, at })).toEqual(
      Option.some({ kind: "a", lineId: "l", qty: 1 }),
    )
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 1 })).toBe(true)
  })

  it("a stamped date a member declares is optional, as its input takes it", () => {
    const element = Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("a"),
        line: Schema.String,
        lineId: Schema.String,
        createdAt: Schema.DateTimeUtc,
        qty: Schema.Number,
      }),
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
    ])
    const stamps = aggregateStamps(true, undefined)
    expect(
      elementHoldsRef(element, Lines, { kind: "a", line: "KEEP", lineId: "l", qty: 1 }, stamps),
    ).toBe(false)
    // Without the stamp, the first member needs the date: the value is the second's.
    expect(holdsRef(element, { kind: "a", line: "KEEP", lineId: "l", qty: 1 })).toBe(true)
  })

  it("a refinement reading the entity's field runs on the hydrated value", () => {
    const element = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
      Schema.Struct({ kind: Schema.Literal("b"), line: Schema.String, qty: Schema.Number }),
    ]).check(Schema.makeFilter((sheet) => sheet.kind !== "a" || (sheet.line as Line).f > 0))
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 1 })).toBe(true)
    expect(holdsRef(element, { kind: "b", line: "x", qty: 1 })).toBe(false)
  })
})

describe("the judge and inputSchema agree by construction", () => {
  for (const refFirst of [false, true]) {
    for (const asClass of [false, true]) {
      it(`a transformed field on the member holding no ref (refFirst=${refFirst}, class=${asClass})`, () => {
        const scalarFields = {
          kind: Schema.Literal("a"),
          line: Schema.optional(Schema.String),
          n: Schema.NumberFromString,
          qty: Schema.Number,
        }
        const refFields = { kind: Schema.Literal("a"), line, n: Schema.Number, qty: Schema.Number }
        class Scalar extends Schema.Class<Scalar>("Scalar")(scalarFields) {}
        class Ref extends Schema.Class<Ref>("Ref")(refFields) {}
        const scalar = asClass ? Scalar : Schema.Struct(scalarFields)
        const ref = asClass ? Ref : Schema.Struct(refFields)
        const element = Schema.Union(refFirst ? [ref, scalar] : [scalar, ref])
        const value = { kind: "a", lineId: "L", n: 5, qty: 1 }
        expect(decoded(element, value)).toEqual(Option.some(value))
        expect(holdsRef(element, value)).toBe(true)
        // The scalar member's own value: its encoded number, no id.
        const own = { kind: "a", line: "x", n: "5", qty: 1 }
        expect(holdsRef(element, own)).toBe(false)
      })
    }
  }

  it("a check on a nested union holding the ref runs on the hydrated value", () => {
    for (const checked of [false, true]) {
      const nested = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
        Schema.Struct({ kind: Schema.Literal("b"), qty: Schema.Number }),
      ])
      const element = Schema.Union([
        checked
          ? nested.check(
              Schema.makeFilter(
                (sheet: { readonly kind: string; readonly line?: Line }) =>
                  sheet.kind === "b" || sheet.line?.f === 1,
              ),
            )
          : nested,
        Schema.Struct({
          kind: Schema.Literal("a"),
          line: Schema.optional(Schema.String),
          qty: Schema.Number,
        }),
      ])
      const value = { kind: "a", lineId: "L", qty: 1 }
      expect(decoded(element, value)).toEqual(Option.some(value))
      expect(holdsRef(element, value)).toBe(true)
    }
  })

  it("an earlier member holding no ref refuses the id, whether or not it declares the field", () => {
    for (const declared of [false, true]) {
      const element = Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("a"),
          ...(declared ? { line: Schema.optional(Schema.String) } : {}),
          qty: Schema.Number,
        }),
        Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
      ])
      expect(decoded(element, { kind: "a", lineId: "L", qty: 1 })).toEqual(
        Option.some({ kind: "a", lineId: "L", qty: 1 }),
      )
      expect(holdsRef(element, { kind: "a", lineId: "L", qty: 1 })).toBe(true)
      expect(holdsRef(element, { kind: "a", qty: 1 })).toBe(false)
    }
  })

  it("a member refusing the id keeps its class, checks and annotations", () => {
    class Plain extends Schema.Class<Plain>("Plain")(
      Schema.Struct({ kind: Schema.Literal("b"), at: Schema.Date, qty: Schema.Number }).check(
        Schema.makeFilter((sheet: { readonly qty: number }) => sheet.qty > 10),
      ),
    ) {}
    const element = Schema.Union([
      Plain,
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
    ])
    const at = "2024-01-02T03:04:05.000Z"
    const plain = decoded(element, { kind: "b", at, qty: 11 })
    expect(Option.map(plain, (value) => value instanceof Plain)).toEqual(Option.some(true))
    expect(decoded(element, { kind: "b", at, qty: 1 })).toEqual(Option.none())
    expect(decoded(element, { kind: "b", at, lineId: "L", qty: 11 })).toEqual(Option.none())
    expect(holdsRef(element, { kind: "b", at, qty: 11 })).toBe(false)
  })

  it("a value the input refuses as given is read in the form create takes it", () => {
    class Plain extends Schema.Class<Plain>("Plain")({
      kind: Schema.Literal("a"),
      at: Schema.Date,
      qty: Schema.Number,
    }) {}
    const element = Schema.Union([
      Plain,
      Schema.Struct({ kind: Schema.Literal("a"), line, at: Schema.Date, qty: Schema.Number }),
    ])
    const at = new Date("2024-01-02T03:04:05.000Z")
    // A `Date` its JSON codec refuses: the domain form takes the reference member, as 1.39.0's
    // decode of the hydrated value did, the first member refusing the id.
    expect(decoded(element, { kind: "a", lineId: "L", at, qty: 1 })).toEqual(Option.none())
    expect(holdsRef(element, { kind: "a", lineId: "L", at, qty: 1 })).toBe(true)
    expect(holdsRef(element, { kind: "a", at, qty: 1 })).toBe(false)
  })
})
