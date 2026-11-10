/**
 * Which `many` element values `create` fetches the edge's entity for, and what the element's input
 * schema takes, decided from the element's definition alone. An id of the key composite's type is
 * fetched only where the definition says the element holds the entity: the element is the entity, or
 * a plain struct or class whose field of the entity's name is the entity's own model (under
 * `optional` / `optionalKey` at most), and which declares no `${field}Id` itself. Every other element
 * is judged as 1.39.0 judged it: a string `${field}Id`, whatever the element declares. The hydration
 * itself is `effect-dynamodb`'s `AggregateRefHydration.test.ts`.
 */

import { Exit, Option, Schema, SchemaGetter } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"
import type { RefEntity } from "../src/internal/AggregateEdges.js"
import {
  deriveElementInputSchema,
  elementHoldsRef,
  entityFieldOf,
  given,
  holdsRefId,
  isEntityElement,
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

/** A struct entity keyed by a number: `create` takes it in the field its `entityType` names. */
const Row = Schema.Struct({ lineId: Schema.Number, f: Schema.Number })
const Rows = Entity.make({
  model: Row,
  entityType: "Row",
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

/** An identity transformation, whatever the two sides' types. */
const identity = {
  decode: SchemaGetter.transform((x: unknown) => x),
  encode: SchemaGetter.transform((x: unknown) => x),
} as never
const ownOrRef = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("own"),
    line: Schema.String,
    lineId: Schema.optional(Schema.String),
    qty: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("ref"), line, qty: Schema.Number }),
])

/** Elements with no fields of their own: unions, transformations, `suspend`. */
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
  [
    "two members of one domain type",
    Schema.Union([
      Schema.Struct({ line, qty: Schema.Number }),
      Schema.Struct({ line, qty: Schema.NumberFromString }),
    ]),
  ],
  [
    "a union through a transformation to Unknown",
    ownOrRef.pipe(Schema.decodeTo(Schema.Unknown, identity)) as unknown as Schema.Top,
  ],
  [
    "a union through a transformation to a struct",
    ownOrRef.pipe(
      Schema.decodeTo(
        Schema.Struct({
          kind: Schema.String,
          line: Schema.Unknown,
          lineId: Schema.optional(Schema.String),
          qty: Schema.Number,
        }),
        identity,
      ),
    ) as unknown as Schema.Top,
  ],
  ["a suspended union", Schema.suspend(() => ownOrRef)],
  [
    "a struct through a transformation",
    Schema.Struct({ line, qty: Schema.Number }).pipe(
      Schema.decodeTo(Schema.Struct({ line, qty: Schema.Number }), identity),
    ) as unknown as Schema.Top,
  ],
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

describe("an element with no fields of its own is judged as on 1.39.0", () => {
  for (const [name, element] of unions) {
    it(`${name}: a string id, whatever the member`, () => {
      expect(isEntityElement(element, Lines)).toBe(false)
      expect(entityFieldOf(element, Lines)).toBeUndefined()
      for (const value of values) {
        expect(holdsRef(element, value)).toBe(typeof value.lineId === "string")
      }
    })

    it(`${name}: its input is the element as declared`, () => {
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

describe("an element naming the field holding the entity takes an id of the key composite", () => {
  it("a struct wrapping the entity: an id of the key composite's type, a number included", () => {
    const element = Schema.Struct({ numbered: Numbered, qty: Schema.Number })
    expect(entityFieldOf(element, NumberedLines)).toBe("numbered")
    expect(elementHoldsRef(element, NumberedLines, { numberedId: 5, qty: 1 })).toBe(true)
    expect(elementHoldsRef(element, NumberedLines, { numberedId: "5", qty: 1 })).toBe(true)
    expect(elementHoldsRef(element, NumberedLines, { qty: 1 })).toBe(false)
    expect(elementHoldsRef(element, NumberedLines, { numberedId: null, qty: 1 })).toBe(false)
  })

  it("through optional, optionalKey, a ref annotation, a check, a brand and a class", () => {
    class Wrapped extends Schema.Class<Wrapped>("Wrapped")({
      line: Schema.optional(line),
      qty: Schema.Number,
    }) {}
    for (const element of [
      Wrapped,
      Schema.Struct({ line: Schema.optional(line), qty: Schema.Number }),
      Schema.Struct({ line: Schema.optionalKey(Line), qty: Schema.Number }),
      Schema.Struct({ line: Line.check(Schema.makeFilter(() => true)), qty: Schema.Number }),
      Schema.Struct({ line: line.pipe(Schema.brand("LineRef")), qty: Schema.Number }),
    ]) {
      expect(entityFieldOf(element, Lines)).toBe("line")
      expect(holdsRef(element, { lineId: "l", qty: 1 })).toBe(true)
      expect(holdsRef(element, { qty: 1 })).toBe(false)
    }
  })

  it("a struct entity's model, as declared, annotated or checked", () => {
    for (const field of [
      Row,
      Row.annotate({ title: "row" }),
      Row.check(Schema.makeFilter(() => true)),
      Schema.optional(Row),
    ]) {
      const element = Schema.Struct({ row: field, qty: Schema.Number })
      expect(entityFieldOf(element, Rows)).toBe("row")
      expect(elementHoldsRef(element, Rows, { rowId: 5, qty: 1 })).toBe(true)
    }
  })

  it("its input: the element whole, the id beside it or not, or the id in the field's place", () => {
    const element = Schema.Struct({ row: Row, qty: Schema.Number })
    const input = Schema.Array(deriveElementInputSchema(Schema.Array(element), Rows)! as never)
    const decode = Schema.decodeUnknownExit(input as Schema.Codec<unknown>)
    expect(decode([{ row: { lineId: 5, f: 1 }, qty: 1 }])._tag).toBe("Success")
    expect(decode([{ rowId: 5, qty: 1 }])._tag).toBe("Success")
    // Given both, both are kept: `create` keeps the entity given whole (`elementHoldsRef`).
    const both = { row: { lineId: 6, f: 99 }, rowId: 5, qty: 1 }
    expect(decode([both])).toStrictEqual(Exit.succeed([both]))
    expect(elementHoldsRef(element, Rows, both)).toBe(false)
    expect(decode([{ row: { lineId: 5, f: 1 }, rowId: undefined, qty: 1 }])._tag).toBe("Success")
    expect(decode([{ rowId: "5", qty: 1 }])._tag).toBe("Failure")
    expect(decode([{ qty: 1 }])._tag).toBe("Failure")
  })
})

describe("any other element is judged as on 1.39.0: a string id, its input as 1.39.0's", () => {
  const fields: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["a string", Schema.String],
    ["an Option", Schema.Option(Schema.String)],
    ["an Option of the entity", Schema.Option(Row)],
    ["a Result", Schema.Result(Schema.String, Schema.Number)],
    ["another struct", Schema.Struct({ payload: Schema.String })],
    ["the entity or null", Schema.NullOr(Row)],
    ["the entity or null, optional", Schema.optional(Schema.NullOr(Row))],
    ["a struct declared again with the entity's fields", Schema.Struct(Row.fields)],
    ["the entity's fields mapped", Row.mapFields((own) => own)],
  ]
  for (const [name, field] of fields) {
    it(`a field of the entity's name declared ${name}`, () => {
      const element = Schema.Struct({ row: field, qty: Schema.Number })
      expect(entityFieldOf(element, Rows)).toBeUndefined()
      expect(elementHoldsRef(element, Rows, { rowId: 5, qty: 1 })).toBe(false)
      expect(elementHoldsRef(element, Rows, { rowId: "5", qty: 1 })).toBe(true)
      // 1.39.0's input: the field taken as `rowId: string`.
      const input = deriveElementInputSchema(Schema.Array(element), Rows)!
      const decode = Schema.decodeUnknownExit(input as Schema.Codec<unknown>)
      expect(decode({ rowId: "5", qty: 1 })._tag).toBe("Success")
      expect(decode({ rowId: 5, qty: 1 })._tag).toBe("Failure")
    })
  }

  it("an element declaring its own `rowId`: its own data, as declared there", () => {
    for (const field of [Row, Schema.Option(Schema.String)]) {
      const element = Schema.Struct({
        row: field,
        rowId: Schema.optional(Schema.Number),
        qty: Schema.Number,
      })
      expect(entityFieldOf(element, Rows)).toBeUndefined()
      expect(elementHoldsRef(element, Rows, { row: Option.some("KEEP"), rowId: 5, qty: 1 })).toBe(
        false,
      )
      expect(elementHoldsRef(element, Rows, { rowId: "5", qty: 1 })).toBe(true)
    }
  })

  it("a field of another name than the entity's holds no reference", () => {
    const element = Schema.Struct({ captain: Row, qty: Schema.Number })
    expect(entityFieldOf(element, Rows)).toBeUndefined()
    expect(elementHoldsRef(element, Rows, { captainId: 5, qty: 1 })).toBe(false)
    expect(elementHoldsRef(element, Rows, { rowId: "5", qty: 1 })).toBe(true)
  })
})

describe("an element that is the entity", () => {
  it("is the entity's own model, by reference: never a class of the entity's identifier", () => {
    // A class of the entity's identifier is another schema, wrapping the entity or declaring its
    // fields again: an identifier is never identity.
    class Wrapper extends Schema.Class<Wrapper>("Line")({
      line: Schema.optional(Line),
      qty: Schema.Number,
    }) {}
    class Lookalike extends Schema.Class<Lookalike>("Line")({
      lineId: Schema.String,
      f: Schema.Number,
    }) {}
    for (const element of [Wrapper, Lookalike, Schema.Struct(Line.fields)]) {
      expect(isEntityElement(element, Lines)).toBe(false)
    }
    // The wrapper names the field holding the entity: its string `lineId` is fetched, as on 1.39.0.
    expect(entityFieldOf(Wrapper, Lines)).toBe("line")
    expect(holdsRef(Wrapper, { lineId: "l", qty: 1 })).toBe(true)
    // The lookalike declares `lineId` and no `line`: its string `lineId` is fetched, as on 1.39.0.
    expect(holdsRef(Lookalike, { lineId: "l", f: 1 })).toBe(true)
    // So is an optional one an element declares, which 1.39.0 fetched and took out of the value.
    const declaresId = Schema.Struct({ lineId: Schema.optional(Schema.String), qty: Schema.Number })
    expect(holdsRef(declaresId, { lineId: "l", qty: 1 })).toBe(true)
    expect(holdsRef(declaresId, { qty: 1 })).toBe(false)
    // A copy that changes only annotations, checks or a brand is the entity's model.
    for (const element of [
      Line,
      line,
      Line.annotate({ title: "line" }),
      Line.check(Schema.makeFilter(() => true)),
      line.pipe(Schema.brand("LineRef")),
    ]) {
      expect(isEntityElement(element, Lines)).toBe(true)
    }
    for (const element of [
      Row,
      Row.annotate({ title: "row" }),
      Row.check(Schema.makeFilter(() => true)),
    ]) {
      expect(isEntityElement(element, Rows)).toBe(true)
    }
  })

  it("the entity's own model, given whole, holds its own id", () => {
    expect(isEntityElement(Line, Lines)).toBe(true)
    expect(holdsRef(Line, { lineId: "l", f: 1 })).toBe(false)
    expect(isEntityElement(Row, Rows)).toBe(true)
    expect(elementHoldsRef(Row, Rows, { lineId: 5, f: 1 })).toBe(false)
    // An entity keyed by another field, with an optional field of the id's name: a string in it is
    // fetched, as on 1.39.0. It isn't the entity's own key.
    class Keyed extends Schema.Class<Keyed>("Line")({
      id: Schema.String,
      lineId: Schema.optional(Schema.String),
    }) {}
    const KeyedLines = Entity.make({
      model: DynamoModel.configure(Keyed, { id: { identifier: true } }),
      entityType: "Line",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    }) as unknown as RefEntity
    expect(isEntityElement(Keyed, KeyedLines)).toBe(true)
    expect(elementHoldsRef(Keyed, KeyedLines, { id: "x", lineId: "l" })).toBe(true)
    expect(elementHoldsRef(Keyed, KeyedLines, { id: "x" })).toBe(false)
  })

  it("its input: an id of the key composite's type, or the entity whole", () => {
    const input = deriveElementInputSchema(Schema.Array(Row), Rows)!
    const decode = Schema.decodeUnknownExit(input as Schema.Codec<unknown>)
    expect(decode(5)._tag).toBe("Success")
    expect(decode({ lineId: 5, f: 1 })._tag).toBe("Success")
    expect(decode("5")._tag).toBe("Failure")
  })
})

describe("a `one` edge's id follows the rule a `many` element's does (`holdsRefId`)", () => {
  const whole = { lineId: 6, f: 99 }

  it("an id of the key composite's type, where the model holds the entity's own model", () => {
    const fields = { numbered: Numbered, qty: Schema.Number }
    expect(holdsRefId(fields, "numbered", NumberedLines, { numberedId: 5 })).toBe(true)
    // The entity given whole is never replaced or read again.
    expect(holdsRefId(fields, "numbered", NumberedLines, { numbered: whole, numberedId: 5 })).toBe(
      false,
    )
    expect(holdsRefId(fields, "numbered", NumberedLines, { numberedId: null })).toBe(false)
  })

  it("an id the model declares (`numberedId`) is its own data, never an id of another type", () => {
    for (const id of [Schema.optional(Schema.Number), Schema.Number]) {
      const fields = { numbered: Numbered, numberedId: id }
      expect(
        holdsRefId(fields, "numbered", NumberedLines, { numbered: whole, numberedId: 5 }),
      ).toBe(false)
      expect(holdsRefId(fields, "numbered", NumberedLines, { numberedId: 5 })).toBe(false)
    }
  })

  it("a field of another schema holds no id of another type", () => {
    const fields = {
      numbered: Schema.Struct({ payload: Schema.String }),
      numberedId: Schema.optional(Schema.Number),
    }
    expect(holdsRefId(fields, "numbered", NumberedLines, { numberedId: 5 })).toBe(false)
    expect(holdsRefId(undefined, "numbered", NumberedLines, { numberedId: 5 })).toBe(false)
  })

  it("a string is fetched as on 1.39.0, whatever the model declares beside the field", () => {
    const fields = { numbered: Numbered, numberedId: Schema.optional(Schema.String) }
    expect(
      holdsRefId(fields, "numbered", NumberedLines, { numbered: whole, numberedId: "5" }),
    ).toBe(true)
    expect(holdsRefId(undefined, "numbered", NumberedLines, { numberedId: "5" })).toBe(true)
  })

  it("a field every object inherits isn't declared, and an id a class gives its input is given", () => {
    // `constructor` is a member of every object: a model that doesn't declare it holds no entity
    // there, and an edge of that name is no declared field.
    expect(holdsRefId({}, "constructor", NumberedLines, { constructorId: 5 })).toBe(false)
    const fields = { numbered: Numbered }
    // An id on the input's prototype, or one a getter of its class gives, is given, as on 1.39.0.
    expect(holdsRefId(fields, "numbered", NumberedLines, Object.create({ numberedId: 5 }))).toBe(
      true,
    )
    expect(holdsRefId(fields, "numbered", NumberedLines, Object.create({ numberedId: "5" }))).toBe(
      true,
    )
    class Command {
      get numberedId() {
        return 5
      }
    }
    expect(
      holdsRefId(fields, "numbered", NumberedLines, new Command() as unknown as Record<string, 5>),
    ).toBe(true)
    // So is the entity whole: beside it, an id of another type than a string isn't fetched.
    const inherits = Object.assign(Object.create({ numbered: whole }), { numberedId: 5 })
    expect(holdsRefId(fields, "numbered", NumberedLines, inherits)).toBe(false)
    // Only a member every object inherits from `Object.prototype` isn't given.
    expect(given({ id: "a" }, "constructor")).toBeUndefined()
    expect(given({ id: "a" }, "toString")).toBeUndefined()
    expect(given(Object.create({ toString: "x" }), "toString")).toBe("x")
    expect(given(Object.create(null), "id")).toBeUndefined()
  })
})
