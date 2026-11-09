/**
 * How `create` judges a `many` element value: whether it holds a ref of the edge's entity, by the
 * member of the element's schema the element's input (`inputSchema`'s) decodes it as. Unions are
 * walked as declared, each union's checks and mode kept, and an id is taken as a value of the
 * entity's key composite. A value the input takes as no member is judged by its literal properties.
 * The hydration itself is `effect-dynamodb`'s `AggregateRefHydration.test.ts`.
 */

import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"
import type { RefEntity } from "../src/internal/AggregateEdges.js"
import { aggregateStamps, elementHoldsRef } from "../src/internal/AggregateSchemas.js"

class Line extends Schema.Class<Line>("Line")({ lineId: Schema.String, f: Schema.Number }) {}
const Lines = Entity.make({
  model: DynamoModel.configure(Line, { lineId: { identifier: true } }),
  entityType: "Line",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
}) as unknown as RefEntity
const line = Line.pipe(DynamoModel.ref)

const holdsRef = (element: Schema.Top, value: Record<string, unknown>) =>
  elementHoldsRef(element, Lines, value)

describe("a many element is judged as its input decodes it", () => {
  it("a checked union first: its check, not only its members, decides", () => {
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
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 11 })).toBe(false)
  })

  it("a check on the whole element's union: a value it refuses is judged by its literals", () => {
    const element = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
      Schema.Struct({ kind: Schema.Literal("b"), line: Schema.String, qty: Schema.Number }),
    ]).check(Schema.makeFilter((sheet: { readonly qty: number }) => sheet.qty > 0))
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 1 })).toBe(true)
    expect(holdsRef(element, { kind: "b", line: "x", lineId: "l", qty: 1 })).toBe(false)
    // Refused by the check: no member is decoded, so the discriminator names the member.
    expect(holdsRef(element, { kind: "b", line: "x", lineId: "l", qty: 0 })).toBe(false)
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 0 })).toBe(true)
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
    // Both take it, so the input refuses it: judged by its literals, which leave both.
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

  it("class members, one with a transformed field: decoded as the class it is", () => {
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
    expect(holdsRef(element, { kind: "a", line: "KEEP", lineId: "l", at, qty: 1 })).toBe(false)
    expect(
      holdsRef(element, { kind: "a", line: "KEEP", lineId: "l", at: at.toISOString(), qty: 1 }),
    ).toBe(false)
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

  it("a refinement reading the entity's field, which the input holds as an id: judged by literals", () => {
    const element = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
      Schema.Struct({ kind: Schema.Literal("b"), line: Schema.String, qty: Schema.Number }),
    ]).check(Schema.makeFilter((sheet) => sheet.kind !== "a" || (sheet.line as Line).f > 0))
    expect(holdsRef(element, { kind: "a", lineId: "l", qty: 1 })).toBe(true)
    expect(holdsRef(element, { kind: "b", line: "x", qty: 1 })).toBe(false)
  })
})
