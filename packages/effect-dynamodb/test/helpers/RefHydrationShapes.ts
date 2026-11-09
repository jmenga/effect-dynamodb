/**
 * The shapes of `fixtures/ref-hydration-1.39.0.json`, as its generator declared them: each way an
 * aggregate edge names an `entity`, over an entity with a `DynamoModel.identifier`, one without, one
 * whose identifier is a field other than its key, and one keyed by two composites; a `many` element
 * that is a union wrapping the entity (at the root and in a sub-aggregate); an entity whose key
 * composite is in both halves of its key; entities keyed by a number, a bigint, a `Date`, a
 * `NumberFromString` and a string codec, alone or in a wrapper; an element declaring the entity's
 * field a string; union elements with a nullable discriminator, members sharing a discriminator, a
 * nested union, a checked nested union first and a member typing its own id (at the root and in a
 * sub-aggregate); ids no item is keyed by, and ids `put` refuses inside a struct, an `Option` or a
 * `Result`, keys escaped or not; two edges, the second over an entity no one id keys; union elements
 * whose earlier member would take a value with the id left over, a checked union holding the ref, a
 * class given a `Date` and a stray id (at the root and in a sub-aggregate); and a `NumberFromString`
 * id given an infinity as its encoded string, keys escaped or not; over an entity keyed by a number,
 * a union element through a transformation or `suspend`, an element declaring the entity's field an
 * `Option`, a `Result` or another struct and its id a number (each at the root and in a
 * sub-aggregate), an element declaring the entity's field an `Option`, given it or a number id, and a
 * union of two members of one domain type, given it whole or a number id; and, each at the root and
 * in a sub-aggregate, an element of a class of the entity's identifier that isn't the entity's model
 * (wrapping it, or declaring its fields again, over a string or a number key), and a `one` edge given
 * the entity whole and an id, over a struct and a class model, its model declaring the id a number
 * (optional or required) or a string, the field another struct, or no id, with the requests
 * `create` sent.
 * Shared by `AggregateRefHydration.test.ts` (a recording table) and
 * `connected.aggregate-ref-hydration.test.ts` (DynamoDB Local).
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Exit, Option, Result, Schema, SchemaGetter } from "effect"
import * as Aggregate from "../../src/Aggregate.js"
import * as Entity from "../../src/Entity.js"

export type Row = Record<string, AttributeValue>

export const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/ref-hydration-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly shapes: Record<
    string,
    {
      readonly make: string
      readonly seeded: ReadonlyArray<Row>
      readonly create: string
      readonly get: string
      readonly rows: ReadonlyArray<Row>
      /** The `DynamoClient` operations `create` called, where the generator recorded them. */
      readonly requests?: ReadonlyArray<string>
    }
  >
}

/** A value as the fixture's generator wrote it: JSON, a bigint as its digits and `n`. */
export const json = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v))

// The fixture's definitions: they must stay what its generator declared.
export const schema = DynamoSchema.make({ name: "hydrate", version: 1 })
export const singleKey = {
  pk: { field: "pk", composite: ["lineId"] },
  sk: { field: "sk", composite: [] },
}
const twoKey = {
  pk: { field: "pk", composite: ["tenant"] },
  sk: { field: "sk", composite: ["lineId"] },
}
/** The same application namespace, its keys escaped (`escapeKeys: true`). */
export const escapedSchema = DynamoSchema.make({ name: "hydrate", version: 1, escapeKeys: true })
/**
 * The same application namespace, its keys not escaped whatever the default is: for rows whose key
 * text holds a character `escapeKeys: true` escapes (a struct's `[object object]`), which the
 * `test:escape-on` runs would otherwise key elsewhere than the rows 1.39.0 wrote.
 */
export const unescapedSchema = DynamoSchema.make({
  name: "hydrate",
  version: 1,
  escapeKeys: false,
})
export const aggregate = (
  model: Schema.Top,
  base: unknown,
  edges: Record<string, unknown>,
  over: DynamoSchema.DynamoSchema = schema,
) =>
  (Aggregate.make as any)(model, {
    table: base,
    schema: over,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "agg" },
    root: { entityType: "Root" },
    edges,
  })
const lineStruct = () =>
  Schema.Struct({ lineId: Schema.String, f: Schema.Number, note: Schema.optional(Schema.String) })
export const lineClass = (identifier: boolean) => {
  class Line extends Schema.Class<Line>("Line")({ lineId: Schema.String, f: Schema.Number }) {}
  return {
    Line,
    model: identifier ? DynamoModel.configure(Line, { lineId: { identifier: true } }) : Line,
  }
}
export const lines = (model: unknown, primaryKey: unknown) =>
  Entity.make({ model, entityType: "Line", primaryKey } as never) as any

export type Shape = {
  /** The application namespace, when not {@link schema}. */
  readonly schema?: DynamoSchema.DynamoSchema
  readonly entities: Record<string, unknown>
  readonly make: (base: unknown) => unknown
  /** Each row to seed, as the entity member that puts it and the item. */
  readonly seed: ReadonlyArray<readonly [string, Record<string, unknown>]>
  readonly input: Record<string, unknown>
}

const withAndWithout = (identifier: boolean): Record<string, () => Shape> => {
  const tag = identifier ? "with an identifier" : "without an identifier"
  return {
    [`many, element wraps the entity, ${tag}`]: () => {
      const { Line, model } = lineClass(identifier)
      const Lines = lines(model, singleKey)
      const Sheet = Schema.Struct({ line: Line.pipe(DynamoModel.ref), qty: Schema.Number })
      const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) })
      return {
        entities: { Lines },
        make: (base) =>
          aggregate(Model, base, {
            lines: Aggregate.many({
              entityType: "SheetLine",
              entity: Lines,
              sk: { composite: ["line.lineId"] },
            } as never),
          }),
        seed: [["Lines", { lineId: "l", f: 5 }]],
        input: { id: "a", lines: [{ lineId: "l", qty: 2 }] },
      }
    },
    [`many, element the entity's class, given ids, ${tag}`]: () => {
      const { Line, model } = lineClass(identifier)
      const Lines = lines(model, singleKey)
      const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) })
      return {
        entities: { Lines },
        make: (base) =>
          aggregate(Model, base, {
            lines: Aggregate.many({
              entityType: "AggLine",
              entity: Lines,
              sk: { composite: ["lineId"] },
            } as never),
          }),
        seed: [["Lines", { lineId: "l", f: 5 }]],
        input: { id: "a", lines: ["l"] },
      }
    },
    [`one, ${tag}`]: () => {
      const { Line, model } = lineClass(identifier)
      const Lines = lines(model, singleKey)
      const Model = Schema.Struct({ id: Schema.String, line: Line })
      return {
        entities: { Lines },
        make: (base) =>
          aggregate(Model, base, {
            line: Aggregate.one({ entityType: "AggLine", entity: Lines } as never),
          }),
        seed: [["Lines", { lineId: "l", f: 5 }]],
        input: { id: "a", lineId: "l" },
      }
    },
    [`ref, ${tag}`]: () => {
      const { Line, model } = lineClass(identifier)
      const Lines = lines(model, singleKey)
      const Model = Schema.Struct({ id: Schema.String, line: Line })
      return {
        entities: { Lines },
        make: (base) => aggregate(Model, base, { line: Aggregate.ref(Lines) }),
        seed: [["Lines", { lineId: "l", f: 5 }]],
        input: { id: "a", lineId: "l" },
      }
    },
  }
}

/** An entity with a field besides its key, its identifier on the key (`lineId`) or on that field. */
const withACode = (identifier: "lineId" | "code"): Record<string, () => Shape> => {
  const tag = identifier === "lineId" ? "with an identifier" : "its identifier another field"
  const codedLine = () => {
    class Line extends Schema.Class<Line>("Line")({
      lineId: Schema.String,
      code: Schema.String,
      f: Schema.Number,
    }) {}
    return {
      Line,
      model:
        identifier === "lineId"
          ? DynamoModel.configure(Line, { lineId: { identifier: true } })
          : DynamoModel.configure(Line, { code: { identifier: true } }),
    }
  }
  return {
    [`many, element wraps an entity with a code, ${tag}`]: () => {
      const { Line, model } = codedLine()
      const Lines = lines(model, singleKey)
      const Sheet = Schema.Struct({ line: Line.pipe(DynamoModel.ref), qty: Schema.Number })
      const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) })
      return {
        entities: { Lines },
        make: (base) =>
          aggregate(Model, base, {
            lines: Aggregate.many({
              entityType: "SheetLine",
              entity: Lines,
              sk: { composite: ["line.lineId"] },
            } as never),
          }),
        seed: [["Lines", { lineId: "l", code: "c", f: 5 }]],
        input: { id: "a", lines: [{ lineId: "l", qty: 2 }] },
      }
    },
    [`one, an entity with a code, ${tag}`]: () => {
      const { Line, model } = codedLine()
      const Lines = lines(model, singleKey)
      const Model = Schema.Struct({ id: Schema.String, line: Line })
      return {
        entities: { Lines },
        make: (base) =>
          aggregate(Model, base, {
            line: Aggregate.one({ entityType: "AggLine", entity: Lines } as never),
          }),
        seed: [["Lines", { lineId: "l", code: "c", f: 5 }]],
        input: { id: "a", lineId: "l" },
      }
    },
  }
}

const twoComposites = (edge: "many" | "one"): Shape => {
  class Line extends Schema.Class<Line>("Line")({
    tenant: Schema.String,
    lineId: Schema.String,
    f: Schema.Number,
  }) {}
  const Lines = lines(DynamoModel.configure(Line, { lineId: { identifier: true } }), twoKey)
  const Sheet = Schema.Struct({ line: Line.pipe(DynamoModel.ref), qty: Schema.Number })
  const Model =
    edge === "many"
      ? Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) })
      : Schema.Struct({ id: Schema.String, line: Line })
  return {
    entities: { Lines },
    make: (base) =>
      aggregate(
        Model,
        base,
        edge === "many"
          ? {
              lines: Aggregate.many({
                entityType: "SheetLine",
                entity: Lines,
                sk: { composite: ["line.lineId"] },
              } as never),
            }
          : { line: Aggregate.one({ entityType: "AggLine", entity: Lines } as never) },
      ),
    seed: [["Lines", { tenant: "t", lineId: "l", f: 5 }]],
    input:
      edge === "many" ? { id: "a", lines: [{ lineId: "l", qty: 2 }] } : { id: "a", lineId: "l" },
  }
}

/** A `many` element that is a union of structs, each holding the entity (optionally, or not). */
const unionOfStructs = (optional: boolean): Shape => {
  const { Line, model } = lineClass(true)
  const Lines = lines(model, singleKey)
  const line = optional ? Schema.optional(Line.pipe(DynamoModel.ref)) : Line.pipe(DynamoModel.ref)
  const Sheet = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("a"), line, qty: Schema.Number }),
    Schema.Struct({ kind: Schema.Literal("b"), line, qty: Schema.Number }),
  ])
  const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) })
  return {
    entities: { Lines },
    make: (base) =>
      aggregate(Model, base, {
        lines: Aggregate.many({
          entityType: "SheetLine",
          entity: Lines,
          sk: { composite: ["qty"] },
        } as never),
      }),
    seed: [["Lines", { lineId: "l", f: 5 }]],
    input: { id: "a", lines: [{ kind: "a", lineId: "l", qty: 2 }] },
  }
}

/** A codec whose `encode` takes its own output: `"MiX"` is stored `"x:MiX"`. */
export const Prefixed = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => s.slice(2)),
    encode: SchemaGetter.transform((s: string) => `x:${s}`),
  }),
)

/** A `one` edge over an entity keyed by `lineId` of `keySchema`, seeded with `id`, given `given`. */
export const keyedBy =
  (
    keySchema: Schema.Top,
    id: unknown,
    given: unknown,
    optional = false,
    over: DynamoSchema.DynamoSchema = schema,
  ) =>
  (): Shape => {
    class Line extends Schema.Class<Line>("Line")({
      lineId: keySchema as never,
      f: Schema.Number,
    }) {}
    const Lines = lines(
      DynamoModel.configure(Line, { lineId: { identifier: true } } as never),
      singleKey,
    )
    const Model = Schema.Struct({
      id: Schema.String,
      line: optional ? Schema.optional(Line) : Line,
    })
    return {
      ...(over === schema ? {} : { schema: over }),
      entities: { Lines },
      make: (base) =>
        aggregate(
          Model,
          base,
          { line: Aggregate.one({ entityType: "AggLine", entity: Lines } as never) },
          over,
        ),
      seed: [["Lines", { lineId: id, f: 5 }]],
      input: { id: "a", lineId: given },
    }
  }

/** A `many` edge whose element is the class of an entity keyed by `lineId` of `keySchema`, given ids. */
const idsKeyedBy = (keySchema: Schema.Top, id: unknown, given: unknown) => (): Shape => {
  class Line extends Schema.Class<Line>("Line")({ lineId: keySchema as never, f: Schema.Number }) {}
  const Lines = lines(
    DynamoModel.configure(Line, { lineId: { identifier: true } } as never),
    singleKey,
  )
  const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) })
  return {
    entities: { Lines },
    make: (base) =>
      aggregate(Model, base, {
        lines: Aggregate.many({
          entityType: "AggLine",
          entity: Lines,
          sk: { composite: ["lineId"] },
        } as never),
      }),
    seed: [["Lines", { lineId: id, f: 5 }]],
    input: { id: "a", lines: [given] },
  }
}

const ISO = "2024-01-02T03:04:05.000Z"

/** Shapes a review of the first fix found: ones 1.39.0 hydrated, and ids it took wrong. */
const reviewed: Record<string, () => Shape> = {
  "many, element a union of structs wrapping the entity": () => unionOfStructs(false),
  "many, element a union whose members may hold the entity": () => unionOfStructs(true),
  "sub-aggregate, many, element a union of structs wrapping the entity": () => {
    const { Line, model } = lineClass(true)
    const Lines = lines(model, singleKey)
    const Sheet = Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("a"),
        line: Line.pipe(DynamoModel.ref),
        qty: Schema.Number,
      }),
      Schema.Struct({
        kind: Schema.Literal("b"),
        line: Line.pipe(DynamoModel.ref),
        qty: Schema.Number,
      }),
    ])
    const Part = Schema.Struct({ lines: Schema.Array(Sheet) })
    return {
      entities: { Lines },
      make: (base) => {
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: {
            lines: Aggregate.many({
              entityType: "SheetLine",
              entity: Lines,
              sk: { composite: ["qty"] },
            } as never),
          },
        })
        return aggregate(Schema.Struct({ id: Schema.String, part: Part }), base, {
          part: Sub.with({ discriminator: { side: 1 } }),
        })
      },
      seed: [["Lines", { lineId: "l", f: 5 }]],
      input: { id: "a", part: { lines: [{ kind: "a", lineId: "l", qty: 2 }] } },
    }
  },
  "one, an entity whose key composite is in its pk and its sk": () => {
    const { Line, model } = lineClass(true)
    const Lines = lines(model, {
      pk: { field: "pk", composite: ["lineId"] },
      sk: { field: "sk", composite: ["lineId"] },
    })
    const Model = Schema.Struct({ id: Schema.String, line: Line })
    return {
      entities: { Lines },
      make: (base) =>
        aggregate(Model, base, {
          line: Aggregate.one({ entityType: "AggLine", entity: Lines } as never),
        }),
      seed: [["Lines", { lineId: "l", f: 5 }]],
      input: { id: "a", lineId: "l" },
    }
  },
  "one, an entity keyed by a Date, given its ISO string": keyedBy(Schema.Date, new Date(ISO), ISO),
  "one, an entity keyed by a NumberFromString, given its encoded string": keyedBy(
    Schema.NumberFromString,
    5,
    "5",
  ),
  "one, an entity keyed by a number, given a number": keyedBy(Schema.Number, 5, 5),
  "one, an entity keyed by a number, given a numeric string": keyedBy(Schema.Number, 5, "5"),
  "one, an entity keyed by a bigint, given a bigint": keyedBy(Schema.BigInt, 5n, 5n),
  "one, an entity keyed by a number, the edge optional": keyedBy(Schema.Number, 5, 5, true),
  "one, an entity keyed by a bigint, the edge optional": keyedBy(Schema.BigInt, 5n, 5n, true),
  "one, an entity keyed by a string codec": keyedBy(Prefixed, "MiX", "MiX"),
  "many, ids of an entity keyed by a NumberFromString, given encoded strings": idsKeyedBy(
    Schema.NumberFromString,
    5,
    "5",
  ),
  "many, ids of an entity keyed by a number, given numbers": idsKeyedBy(Schema.Number, 5, 5),
  "many, element declares the entity's field a string, given it and a lineId": () => {
    const { model } = lineClass(true)
    const Lines = lines(model, singleKey)
    const Sheet = Schema.Struct({ line: Schema.String, qty: Schema.Number })
    const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) })
    return {
      entities: { Lines },
      make: (base) =>
        aggregate(Model, base, {
          lines: Aggregate.many({
            entityType: "SheetLine",
            entity: Lines,
            sk: { composite: ["qty"] },
          } as never),
        }),
      seed: [["Lines", { lineId: "l", f: 5 }]],
      input: { id: "a", lines: [{ line: "label", lineId: "l", qty: 2 }] },
    }
  },
  "one and one, the second an entity keyed by two composites": () => {
    const { Line, model } = lineClass(true)
    const Lines = lines(model, singleKey)
    class Pair extends Schema.Class<Pair>("Pair")({
      tenant: Schema.String,
      lineId: Schema.String,
      f: Schema.Number,
    }) {}
    const Pairs = Entity.make({
      model: DynamoModel.configure(Pair, { lineId: { identifier: true } }),
      entityType: "Pair",
      primaryKey: twoKey,
    } as never) as any
    const Model = Schema.Struct({ id: Schema.String, line: Line, pair: Pair })
    return {
      entities: { Lines, Pairs },
      make: (base) =>
        aggregate(Model, base, {
          line: Aggregate.one({ entityType: "AggLine", entity: Lines } as never),
          pair: Aggregate.one({ entityType: "AggPair", entity: Pairs } as never),
        }),
      seed: [
        ["Lines", { lineId: "l", f: 5 }],
        ["Pairs", { tenant: "t", lineId: "p", f: 6 }],
      ],
      input: { id: "a", lineId: "l", pairId: "p" },
    }
  },
}

/** A union element over `Lines` whose wrapping member's discriminator is nullable. */
const nullableDiscriminator = (optional: boolean) => {
  const { Line, model } = lineClass(true)
  const Lines = lines(model, singleKey)
  const line = Line.pipe(DynamoModel.ref)
  const Sheet = Schema.Union([
    Schema.Struct({
      kind: Schema.NullOr(Schema.Literal("a")),
      line: optional ? Schema.optional(line) : line,
      qty: Schema.Number,
    }),
    Schema.Struct({ kind: Schema.String, line: Schema.String, qty: Schema.Number }),
  ])
  return { Lines, Sheet }
}

/**
 * Shapes a second review found: union elements judged by the member a value is (a nullable
 * discriminator, a discriminator two members share, a nested union), ids of codecs inside a wrapper,
 * and ids no item can be keyed by.
 */
const reviewedAgain: Record<string, () => Shape> = {
  ...Object.fromEntries(
    [false, true].map((optional) => [
      optional
        ? "many, element a union with a nullable discriminator, the entity optional"
        : "many, element a union with a nullable discriminator",
      (): Shape => {
        const { Lines, Sheet } = nullableDiscriminator(optional)
        const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) })
        return {
          entities: { Lines },
          make: (base) =>
            aggregate(Model, base, {
              lines: Aggregate.many({
                entityType: "SheetLine",
                entity: Lines,
                sk: { composite: ["qty"] },
              } as never),
            }),
          seed: [["Lines", { lineId: "l", f: 5 }]],
          input: { id: "a", lines: [{ kind: null, lineId: "l", qty: 1 }] },
        }
      },
    ]),
  ),
  "sub-aggregate, many, element a union with a nullable discriminator, the entity optional": () => {
    const { Lines, Sheet } = nullableDiscriminator(true)
    const Part = Schema.Struct({ lines: Schema.Array(Sheet) })
    return {
      entities: { Lines },
      make: (base) => {
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: {
            lines: Aggregate.many({
              entityType: "SheetLine",
              entity: Lines,
              sk: { composite: ["qty"] },
            } as never),
          },
        })
        return aggregate(Schema.Struct({ id: Schema.String, part: Part }), base, {
          part: Sub.with({ discriminator: { side: 1 } }),
        })
      },
      seed: [["Lines", { lineId: "l", f: 5 }]],
      input: { id: "a", part: { lines: [{ kind: null, lineId: "l", qty: 1 }] } },
    }
  },
  "many, element members sharing a discriminator, one declaring the entity's field a string and its id":
    () => sharedDiscriminator(false),
  "many, element a nested union wrapping the entity": () => {
    const { Line, model } = lineClass(true)
    const Lines = lines(model, singleKey)
    const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(nestedSheet(Line)) })
    return {
      entities: { Lines },
      make: (base) =>
        aggregate(Model, base, {
          lines: Aggregate.many({
            entityType: "SheetLine",
            entity: Lines,
            sk: { composite: ["qty"] },
          } as never),
        }),
      seed: [["Lines", { lineId: "l", f: 5 }]],
      input: {
        id: "a",
        lines: [
          { kind: "a", lineId: "l", qty: 1 },
          { kind: "c", line: "label", qty: 2 },
        ],
      },
    }
  },
  "one, an entity keyed by an optional NumberFromString, given its encoded string": keyedBy(
    Schema.optional(Schema.NumberFromString),
    5,
    "5",
  ),
  "one, an entity keyed by an optional BigIntFromString, given its encoded string": keyedBy(
    Schema.optional(Schema.BigIntFromString),
    5n,
    "5",
  ),
  "one, an entity keyed by a NumberFromString or a literal, given its encoded string": keyedBy(
    Schema.Union([Schema.NumberFromString, Schema.Literal("none")]),
    5,
    "5",
  ),
  "one, an entity keyed by an optional NumberFromString, given a number": keyedBy(
    Schema.optional(Schema.NumberFromString),
    5,
    5,
  ),
  "one, an entity keyed by an optional string codec": keyedBy(
    Schema.optional(Prefixed),
    "MiX",
    "MiX",
  ),
  "one, an entity keyed by a number, given Infinity": keyedBy(Schema.Number, 5, Infinity),
  "one, an entity keyed by a string, given an object whose toString is text": keyedBy(
    Schema.String,
    "l",
    JSON.parse('{"toString":"x"}'),
  ),
}

/** A struct, holding a number: `{ a: Infinity }` and `{ a: 5 }` compose one key text. */
const Pair = () => Schema.Struct({ a: Schema.Number })

/** A `many` element whose first member is a checked union of members declaring the field a string. */
export const checkedNestedSheet = (Line: Schema.Top) =>
  Schema.Union([
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
    Schema.Struct({
      kind: Schema.Literal("a"),
      line: Line.pipe(DynamoModel.ref),
      qty: Schema.Number,
    }),
  ])

/** A `many` element whose later member declares the entity's field a string and its id a number. */
export const typedIdSheet = (Line: Schema.Top) =>
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("a"),
      line: Line.pipe(DynamoModel.ref),
      qty: Schema.Number,
    }),
    Schema.Struct({
      kind: Schema.Literal("a"),
      line: Schema.String,
      lineId: Schema.Number,
      qty: Schema.Number,
    }),
  ])

/** A `many` edge over `Lines` with `sheet`'s element, at the root or in a sub-aggregate `part`. */
const sheetShape =
  (sheet: (Line: Schema.Top) => Schema.Top, element: unknown, seeded: boolean, sub: boolean) =>
  (): Shape => {
    const { Line, model } = lineClass(true)
    const Lines = lines(model, singleKey)
    const edge = () =>
      Aggregate.many({
        entityType: "SheetLine",
        entity: Lines,
        sk: { composite: ["qty"] },
      } as never)
    const Part = Schema.Struct({ lines: Schema.Array(sheet(Line)) })
    return {
      entities: { Lines },
      make: (base) => {
        if (!sub) {
          return aggregate(
            Schema.Struct({ id: Schema.String, lines: Schema.Array(sheet(Line)) }),
            base,
            { lines: edge() },
          )
        }
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: { lines: edge() },
        })
        return aggregate(Schema.Struct({ id: Schema.String, part: Part }), base, {
          part: Sub.with({ discriminator: { side: 1 } }),
        })
      },
      seed: seeded ? [["Lines", { lineId: "l", f: 5 }]] : [],
      input: sub ? { id: "a", part: { lines: [element] } } : { id: "a", lines: [element] },
    }
  }

/**
 * A sub-aggregate `part` with a `one` edge over an entity keyed by `lineId` of `keySchema`, seeded
 * with `id`, given `given`.
 */
const subKeyedBy =
  (keySchema: Schema.Top, id: unknown, given: unknown, over: DynamoSchema.DynamoSchema = schema) =>
  (): Shape => {
    class Line extends Schema.Class<Line>("Line")({
      lineId: keySchema as never,
      f: Schema.Number,
    }) {}
    const Lines = lines(
      DynamoModel.configure(Line, { lineId: { identifier: true } } as never),
      singleKey,
    )
    const Part = Schema.Struct({ line: Line })
    return {
      ...(over === schema ? {} : { schema: over }),
      entities: { Lines },
      make: (base) => {
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: { line: Aggregate.one({ entityType: "AggLine", entity: Lines } as never) },
        })
        return aggregate(
          Schema.Struct({ id: Schema.String, part: Part }),
          base,
          { part: Sub.with({ discriminator: { side: 1 } }) },
          over,
        )
      },
      seed: [["Lines", { lineId: id, f: 5 }]],
      input: { id: "a", part: { lineId: given } },
    }
  }

/**
 * Shapes a third review found: ids `put` refuses as DynamoDB can't store them, deeper than a number
 * (their key text names an item of another value: `{ a: Infinity }` and `{ a: 5 }` compose one), a
 * union element whose first member is a checked union, and one whose later member types its own id.
 */
const reviewedThird: Record<string, () => Shape> = {
  "one, an entity keyed by a struct, given one holding Infinity": keyedBy(
    Pair(),
    { a: 5 },
    { a: Infinity },
    false,
    unescapedSchema,
  ),
  "one, an entity keyed by a struct, given one holding Infinity, its keys escaped": keyedBy(
    Pair(),
    { a: 5 },
    { a: Infinity },
    false,
    escapedSchema,
  ),
  "one, an entity keyed by an Option, given Some(Infinity)": keyedBy(
    Schema.Option(Schema.Number),
    Option.some(5),
    Option.some(Infinity),
  ),
  "one, an entity keyed by a Result, given a success of Infinity": keyedBy(
    Schema.Result(Schema.Number, Schema.String),
    Result.succeed(5),
    Result.succeed(Infinity),
  ),
  "sub-aggregate, one, an entity keyed by a struct, given one holding Infinity": subKeyedBy(
    Pair(),
    { a: 5 },
    { a: Infinity },
    unescapedSchema,
  ),
  "many, element a union whose first member is a checked union of members holding no ref":
    sheetShape(checkedNestedSheet, { kind: "a", lineId: "l", qty: 1 }, true, false),
  "sub-aggregate, many, element a union whose first member is a checked union of members holding no ref":
    sheetShape(checkedNestedSheet, { kind: "a", lineId: "l", qty: 1 }, true, true),
  "many, element a union whose later member declares the entity's field a string and its id a number":
    sheetShape(typedIdSheet, { kind: "a", line: "KEEP", lineId: 123, qty: 1 }, false, false),
  "sub-aggregate, many, element a union whose later member declares the entity's field a string and its id a number":
    sheetShape(typedIdSheet, { kind: "a", line: "KEEP", lineId: 123, qty: 1 }, false, true),
}

/** A union element whose earlier member holds no ref and transforms a field the later one doesn't. */
export const transformingSheet = (asClass: boolean) => (Line: Schema.Top) => {
  const scalar = {
    kind: Schema.Literal("a"),
    line: Schema.optional(Schema.String),
    n: Schema.NumberFromString,
    qty: Schema.Number,
  }
  const wrapping = {
    kind: Schema.Literal("a"),
    line: Line.pipe(DynamoModel.ref),
    n: Schema.Number,
    qty: Schema.Number,
  }
  if (!asClass) return Schema.Union([Schema.Struct(scalar), Schema.Struct(wrapping)])
  class Scalar extends Schema.Class<Scalar>("Scalar")(scalar) {}
  class Wrapping extends Schema.Class<Wrapping>("Wrapping")(wrapping) {}
  return Schema.Union([Scalar, Wrapping])
}

/** A union element whose first member is a checked union holding the ref, its check reading it. */
export const checkedRefSheet = (Line: Schema.Top) =>
  Schema.Union([
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("a"),
        line: Line.pipe(DynamoModel.ref),
        qty: Schema.Number,
      }),
      Schema.Struct({ kind: Schema.Literal("b"), qty: Schema.Number }),
    ]).check(
      Schema.makeFilter(
        (sheet: { readonly kind: string; readonly line?: unknown }) =>
          sheet.kind === "b" || (sheet.line as { readonly f?: number } | undefined)?.f === 5,
      ),
    ),
    Schema.Struct({
      kind: Schema.Literal("a"),
      line: Schema.optional(Schema.String),
      qty: Schema.Number,
    }),
  ])

/** A union element whose earlier member, holding no ref, declares `earlier`'s fields. */
const earlierSheet = (earlier: Record<string, Schema.Top>) => (Line: Schema.Top) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("a"), ...earlier, qty: Schema.Number }),
    Schema.Struct({
      kind: Schema.Literal("a"),
      line: Line.pipe(DynamoModel.ref),
      qty: Schema.Number,
    }),
  ])

/** A union of classes: the earlier declares the entity's field a string, its id and a date. */
const datedClassSheet = (Line: Schema.Top) => {
  class Scalar extends Schema.Class<Scalar>("Scalar")({
    kind: Schema.Literal("a"),
    line: Schema.String,
    lineId: Schema.String,
    at: Schema.Date,
    qty: Schema.Number,
  }) {}
  class Wrapping extends Schema.Class<Wrapping>("Wrapping")({
    kind: Schema.Literal("a"),
    line: Line.pipe(DynamoModel.ref),
    qty: Schema.Number,
  }) {}
  return Schema.Union([Scalar, Wrapping])
}

/** A union element whose member holding no ref declares the entity's field a string. */
const discriminatedSheet = (Line: Schema.Top) =>
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("a"),
      line: Line.pipe(DynamoModel.ref),
      qty: Schema.Number,
    }),
    Schema.Struct({ kind: Schema.Literal("b"), line: Schema.String, qty: Schema.Number }),
  ])

/** Each shape at the root and in a sub-aggregate, seeded with the line. */
const atRootAndSub = (
  shapes: ReadonlyArray<readonly [string, (Line: Schema.Top) => Schema.Top, unknown]>,
): Record<string, () => Shape> =>
  Object.fromEntries(
    shapes.flatMap(([label, sheet, element]) =>
      [false, true].map((sub) => [
        sub ? `sub-aggregate, ${label}` : label,
        sheetShape(sheet, element, true, sub),
      ]),
    ),
  )

/**
 * Shapes a fourth review found: union elements whose earlier member would take a value with the id
 * left over (transforming a field, declaring the entity's field an optional string, declaring
 * neither, a checked union whose check passes), a checked union holding the ref, a class given a
 * `Date`, a stray id on a member holding no ref, and a `NumberFromString` id given an infinity as
 * its encoded string, which `put` stores. An infinity's key text differs with `escapeKeys` on, so
 * the shapes 1.39.0 ran with it off say so ({@link unescapedSchema}).
 */
const reviewedFourth: Record<string, () => Shape> = {
  ...atRootAndSub([
    [
      "many, element a union whose earlier member holds no ref and transforms a field",
      transformingSheet(false),
      { kind: "a", lineId: "l", n: 5, qty: 1 },
    ],
    [
      "many, element a union of classes whose earlier member holds no ref and transforms a field",
      transformingSheet(true),
      { kind: "a", lineId: "l", n: 5, qty: 1 },
    ],
    [
      "many, element a union whose first member is a checked union holding the ref, a later member declaring the entity's field an optional string",
      checkedRefSheet,
      { kind: "a", lineId: "l", qty: 1 },
    ],
    [
      "many, element a union whose earlier member declares neither the entity's field nor its id",
      earlierSheet({}),
      { kind: "a", lineId: "l", qty: 1 },
    ],
    [
      "many, element a union whose earlier member declares the entity's field an optional string",
      earlierSheet({ line: Schema.optional(Schema.String) }),
      { kind: "a", lineId: "l", qty: 1 },
    ],
    [
      "many, element a union whose first member is a checked union of members holding no ref, its check passing",
      checkedNestedSheet,
      { kind: "a", lineId: "l", qty: 11 },
    ],
    [
      "many, element a union of classes, the earlier declaring the entity's field a string, its id and a date, given a Date",
      datedClassSheet,
      { kind: "a", line: "KEEP", lineId: "l", at: new Date(ISO), qty: 1 },
    ],
    [
      "many, element a union whose member holding no ref is given a lineId",
      discriminatedSheet,
      { kind: "b", line: "label", lineId: "l", qty: 2 },
    ],
  ]),
  "one, an entity keyed by a NumberFromString, given Infinity as its encoded string": keyedBy(
    Schema.NumberFromString,
    Infinity,
    "Infinity",
    false,
    unescapedSchema,
  ),
  "one, an entity keyed by a NumberFromString, given -Infinity as its encoded string": keyedBy(
    Schema.NumberFromString,
    -Infinity,
    "-Infinity",
    false,
    unescapedSchema,
  ),
  "one, an entity keyed by a NumberFromString, given Infinity as its encoded string, its keys escaped":
    keyedBy(Schema.NumberFromString, Infinity, "Infinity", false, escapedSchema),
  "one, an entity keyed by a NumberFromString, given -Infinity as its encoded string, its keys escaped":
    keyedBy(Schema.NumberFromString, -Infinity, "-Infinity", false, escapedSchema),
  "sub-aggregate, one, an entity keyed by a NumberFromString, given Infinity as its encoded string":
    subKeyedBy(Schema.NumberFromString, Infinity, "Infinity", unescapedSchema),
}

/**
 * A union element whose two members share `kind: "a"`: one declares the entity's field a string and
 * a `lineId` of its own, the other wraps the entity. `refFirst` puts the wrapping member first.
 */
export const sharedDiscriminator = (refFirst: boolean): Shape => {
  const { Line, model } = lineClass(true)
  const Lines = lines(model, singleKey)
  const scalar = Schema.Struct({
    kind: Schema.Literal("a"),
    line: Schema.String,
    lineId: Schema.String,
    qty: Schema.Number,
  })
  const wrapping = Schema.Struct({
    kind: Schema.Literal("a"),
    line: Line.pipe(DynamoModel.ref),
    qty: Schema.Number,
  })
  const Sheet = Schema.Union(refFirst ? [wrapping, scalar] : [scalar, wrapping])
  const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) })
  return {
    entities: { Lines },
    make: (base) =>
      aggregate(Model, base, {
        lines: Aggregate.many({
          entityType: "SheetLine",
          entity: Lines,
          sk: { composite: ["qty"] },
        } as never),
      }),
    seed: [["Lines", { lineId: "l", f: 5 }]],
    input: { id: "a", lines: [{ kind: "a", line: "KEEP", lineId: "l", qty: 1 }] },
  }
}

/** A union element nesting a union: two members wrapping the entity, and one declaring it a string. */
export const nestedSheet = (Line: Schema.Top) =>
  Schema.Union([
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("a"),
        line: Line.pipe(DynamoModel.ref),
        qty: Schema.Number,
      }),
      Schema.Struct({
        kind: Schema.Literal("b"),
        line: Schema.optional(Line.pipe(DynamoModel.ref)),
        qty: Schema.Number,
      }),
    ]),
    Schema.Struct({ kind: Schema.Literal("c"), line: Schema.String, qty: Schema.Number }),
  ])

/** An entity class keyed by a number, its key its identifier. */
const numberLine = () => {
  class Line extends Schema.Class<Line>("Line")({ lineId: Schema.Number, f: Schema.Number }) {}
  return { Line, model: DynamoModel.configure(Line, { lineId: { identifier: true } }) }
}

/**
 * A `many` edge over a number-keyed `Lines` with `sheet`'s element, at the root or in a sub-aggregate
 * `part`, seeded with line 5.
 */
const numberSheet =
  (sheet: (Line: Schema.Top) => Schema.Top, element: unknown, sub: boolean) => (): Shape => {
    const { Line, model } = numberLine()
    const Lines = lines(model, singleKey)
    const edge = () =>
      Aggregate.many({
        entityType: "SheetLine",
        entity: Lines,
        sk: { composite: ["qty"] },
      } as never)
    const Part = Schema.Struct({ lines: Schema.Array(sheet(Line)) })
    return {
      entities: { Lines },
      make: (base) => {
        if (!sub) {
          return aggregate(
            Schema.Struct({ id: Schema.String, lines: Schema.Array(sheet(Line)) }),
            base,
            { lines: edge() },
          )
        }
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: { lines: edge() },
        })
        return aggregate(Schema.Struct({ id: Schema.String, part: Part }), base, {
          part: Sub.with({ discriminator: { side: 1 } }),
        })
      },
      seed: [["Lines", { lineId: 5, f: 1 }]],
      input: sub ? { id: "a", part: { lines: [element] } } : { id: "a", lines: [element] },
    }
  }

/** A union of a member declaring the entity's field a string and its id a number, and one holding it. */
const ownOrRef = (Line: Schema.Top) =>
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("own"),
      line: Schema.String,
      lineId: Schema.optional(Schema.Number),
      qty: Schema.Number,
    }),
    Schema.Struct({
      kind: Schema.Literal("ref"),
      line: Line.pipe(DynamoModel.ref),
      qty: Schema.Number,
    }),
  ])

/** {@link ownOrRef} through a transformation to `Unknown` or to a struct, or `suspend`ed. */
export const wrappedUnion = (wrap: "unknown" | "struct" | "suspend") => (Line: Schema.Top) => {
  const union = ownOrRef(Line)
  if (wrap === "suspend") return Schema.suspend(() => union)
  const target =
    wrap === "unknown"
      ? Schema.Unknown
      : Schema.Struct({
          kind: Schema.String,
          line: Schema.Unknown,
          lineId: Schema.optional(Schema.Number),
          qty: Schema.Number,
        })
  return union.pipe(
    Schema.decodeTo(
      target as Schema.Codec<unknown>,
      {
        decode: SchemaGetter.transform((x: unknown) => x),
        encode: SchemaGetter.transform((x: unknown) => x),
      } as never,
    ),
  ) as unknown as Schema.Top
}

/** A struct declaring the entity's field `field`, and its id a number when `id`. */
const declaredSheet = (field: () => Schema.Top, id: boolean) => () =>
  Schema.Struct({
    line: field(),
    ...(id ? { lineId: Schema.optional(Schema.Number) } : {}),
    qty: Schema.Number,
  })

/** A union of two members holding the entity, whose domain types are one. */
const sameDomainUnion = (Line: Schema.Top) =>
  Schema.Union([
    Schema.Struct({ line: Line.pipe(DynamoModel.ref), qty: Schema.Number }),
    Schema.Struct({ line: Line.pipe(DynamoModel.ref), qty: Schema.NumberFromString }),
  ])

const ownLine = { kind: "own", line: "KEEP", lineId: 5, qty: 1 }

/**
 * Shapes a fifth review found, over an entity keyed by a number: an element whose schema doesn't
 * name the field holding the entity, given a number `lineId`. A union through a transformation or
 * `suspend`, a member declaring the entity's field a string and its id a number; a struct declaring
 * the entity's field an `Option`, a `Result` or another struct, and its id a number; an `Option`
 * field given its value or a number id; a union whose members have one domain type.
 */
const reviewedFifth: Record<string, () => Shape> = Object.fromEntries([
  ...(
    [
      [
        "many, element a union through a transformation to Unknown, a member declaring the entity's field a string and its id a number",
        wrappedUnion("unknown"),
        ownLine,
      ],
      [
        "many, element a union through a transformation to a struct, a member declaring the entity's field a string and its id a number",
        wrappedUnion("struct"),
        ownLine,
      ],
      [
        "many, element a suspended union, a member declaring the entity's field a string and its id a number",
        wrappedUnion("suspend"),
        ownLine,
      ],
      [
        "many, element declares the entity's field an Option and its id a number",
        declaredSheet(() => Schema.Option(Schema.String), true),
        { line: Option.some("KEEP"), lineId: 5, qty: 1 },
      ],
      [
        "many, element declares the entity's field a Result and its id a number",
        declaredSheet(() => Schema.Result(Schema.String, Schema.Number), true),
        { line: Result.succeed("KEEP"), lineId: 5, qty: 1 },
      ],
      [
        "many, element declares the entity's field another struct and its id a number",
        declaredSheet(() => Schema.Struct({ payload: Schema.String }), true),
        { line: { payload: "KEEP" }, lineId: 5, qty: 1 },
      ],
    ] as const
  ).flatMap(([label, sheet, element]) =>
    [false, true].map((sub) => [
      sub ? `sub-aggregate, ${label}` : label,
      numberSheet(sheet, element, sub),
    ]),
  ),
  [
    "many, element declares the entity's field an Option, given it",
    numberSheet(
      declaredSheet(() => Schema.Option(Schema.String), false),
      { line: Option.some("KEEP"), qty: 1 },
      false,
    ),
  ],
  [
    "many, element declares the entity's field an Option, given a number id",
    numberSheet(
      declaredSheet(() => Schema.Option(Schema.String), false),
      { lineId: 5, qty: 1 },
      false,
    ),
  ],
  [
    "many, element a union of two members of one domain type, given a number id",
    numberSheet(sameDomainUnion, { lineId: 5, qty: 1 }, false),
  ],
  [
    "many, element a union of two members of one domain type, given it whole",
    numberSheet(sameDomainUnion, { line: { lineId: 5, f: 1 }, qty: 1 }, false),
  ],
])

/**
 * An entity keyed by `lineId` of `key`, its model a struct, or a class with a `DynamoModel.identifier`
 * on its key.
 */
const keyedLine = (key: Schema.Top, kind: "struct" | "class") => {
  if (kind === "struct") {
    const Line = Schema.Struct({ lineId: key as never, f: Schema.Number })
    return { Line: Line as Schema.Top, model: Line as unknown }
  }
  class Line extends Schema.Class<Line>("Line")({ lineId: key as never, f: Schema.Number }) {}
  return {
    Line: Line as Schema.Top,
    model: DynamoModel.configure(Line, { lineId: { identifier: true } } as never) as unknown,
  }
}

/**
 * A `many` edge over `Lines` keyed by `lineId` of `key` (a class with an identifier) whose element is
 * `sheet(Line)`, at the root or in a sub-aggregate `part`, seeded with line `seedId`.
 */
const classSheet =
  (
    sheet: (Line: Schema.Top) => Schema.Top,
    element: unknown,
    sub: boolean,
    key: Schema.Top = Schema.String,
    seedId: unknown = "l",
  ) =>
  (): Shape => {
    const { Line, model } = keyedLine(key, "class")
    const Lines = lines(model, singleKey)
    const edge = () =>
      Aggregate.many({
        entityType: "SheetLine",
        entity: Lines,
        sk: { composite: ["qty"] },
      } as never)
    const Element = sheet(Line)
    const Part = Schema.Struct({ lines: Schema.Array(Element) })
    return {
      entities: { Lines },
      make: (base) => {
        if (!sub) {
          return aggregate(
            Schema.Struct({ id: Schema.String, lines: Schema.Array(Element) }),
            base,
            { lines: edge() },
          )
        }
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: { lines: edge() },
        })
        return aggregate(Schema.Struct({ id: Schema.String, part: Part }), base, {
          part: Sub.with({ discriminator: { side: 1 } }),
        })
      },
      seed: [["Lines", { lineId: seedId, f: 5 }]],
      input: sub ? { id: "a", part: { lines: [element] } } : { id: "a", lines: [element] },
    }
  }

/** A class of the entity's identifier, `"Line"`, wrapping the entity: another schema than its model. */
const wrapperOf = (Line: Schema.Top) => {
  class Wrapper extends Schema.Class<Wrapper>("Line")({
    line: Schema.optional(Line as Schema.Codec<unknown>),
    qty: Schema.Number,
  }) {}
  return Wrapper as unknown as Schema.Top
}

/** A class of the entity's identifier declaring the entity's fields again: another schema. */
const lookalike = (key: Schema.Top) => () => {
  class Look extends Schema.Class<Look>("Line")({
    lineId: key as never,
    f: Schema.Number,
    qty: Schema.Number,
  }) {}
  return Look as unknown as Schema.Top
}

/**
 * A `one` edge over `Lines` keyed by `lineId` of `key` (a struct or a class), the model's fields
 * `fields(Line)`, at the root or in a sub-aggregate `part`.
 */
const oneEdge =
  (
    key: Schema.Top,
    kind: "struct" | "class",
    fields: (Line: Schema.Top) => Record<string, Schema.Top>,
    seed: Record<string, unknown>,
    input: Record<string, unknown>,
    sub: boolean,
  ) =>
  (): Shape => {
    const { Line, model } = keyedLine(key, kind)
    const Lines = lines(model, singleKey)
    const edge = () => Aggregate.one({ entityType: "AggLine", entity: Lines } as never)
    return {
      entities: { Lines },
      make: (base) => {
        if (!sub) {
          return aggregate(Schema.Struct({ id: Schema.String, ...fields(Line) }), base, {
            line: edge(),
          })
        }
        const Part = Schema.Struct(fields(Line))
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: { line: edge() },
        })
        return aggregate(Schema.Struct({ id: Schema.String, part: Part }), base, {
          part: Sub.with({ discriminator: { side: 1 } }),
        })
      },
      seed: [["Lines", seed]],
      input: sub ? { id: "a", part: input } : { id: "a", ...input },
    }
  }

const declaresId = (id: Schema.Top) => (Line: Schema.Top) => ({ line: Line, lineId: id })
const declaresOtherAndId = () => ({
  line: Schema.Struct({ payload: Schema.String }),
  lineId: Schema.optional(Schema.Number),
})
const holdsIt = (Line: Schema.Top) => ({ line: Line })

/**
 * Shapes a sixth review found, each at the root and in a sub-aggregate: a `many` element that is a
 * class of the entity's identifier but not the entity's model (wrapping it, or declaring its fields
 * again), whose identifier was taken for identity; and a `one` edge, over an entity whose model is a
 * struct or a class, given the entity whole and an id: its model declaring `${field}Id` a number
 * (optional or required) or a string, its field another struct, or no `${field}Id` at all.
 */
const reviewedSixth: Record<string, () => Shape> = Object.fromEntries(
  [false, true].flatMap((sub) => {
    const at = (label: string) => (sub ? `sub-aggregate, ${label}` : label)
    return [
      [
        at("many, element a class of the entity's identifier wrapping it, given a string id"),
        classSheet(wrapperOf, { lineId: "l", qty: 1 }, sub),
      ],
      [
        at("many, element a class of the entity's identifier and fields, given a string id"),
        classSheet(lookalike(Schema.String), "l", sub),
      ],
      [
        at("many, element a class of the entity's identifier and fields, given it whole"),
        classSheet(lookalike(Schema.String), { lineId: "l", f: 5, qty: 1 }, sub),
      ],
      [
        at(
          "many, element a class of the entity's identifier and fields over a number key, given a number id",
        ),
        classSheet(lookalike(Schema.Number), 5, sub, Schema.Number, 5),
      ],
      ...(["struct", "class"] as const).flatMap((kind) => {
        const of = (label: string) => at(`${label} (${kind})`)
        return [
          [
            of("one, model declares the edge's id a number, given the entity whole and that id"),
            oneEdge(
              Schema.Number,
              kind,
              declaresId(Schema.optional(Schema.Number)),
              { lineId: 5, f: 1 },
              { line: { lineId: 6, f: 99 }, lineId: 5 },
              sub,
            ),
          ],
          [
            of(
              "one, model declares the edge's id a required number, given the entity whole and that id",
            ),
            oneEdge(
              Schema.Number,
              kind,
              declaresId(Schema.Number),
              { lineId: 5, f: 1 },
              { line: { lineId: 6, f: 99 }, lineId: 5 },
              sub,
            ),
          ],
          [
            of("one, model declares the edge's field another struct and its id a number"),
            oneEdge(
              Schema.Number,
              kind,
              declaresOtherAndId,
              { lineId: 5, f: 1 },
              { line: { payload: "KEEP" }, lineId: 5 },
              sub,
            ),
          ],
          [
            of("one, given the entity whole and a number id"),
            oneEdge(
              Schema.Number,
              kind,
              holdsIt,
              { lineId: 5, f: 1 },
              { line: { lineId: 6, f: 99 }, lineId: 5 },
              sub,
            ),
          ],
          [
            of("one, model declares the edge's id a string, given the entity whole and that id"),
            oneEdge(
              Schema.String,
              kind,
              declaresId(Schema.optional(Schema.String)),
              { lineId: "l", f: 1 },
              { line: { lineId: "x", f: 99 }, lineId: "l" },
              sub,
            ),
          ],
        ]
      }),
    ]
  }),
)

/** A `many` element declaring the entity's id (`lineId`) and not its field: a struct, and a class. */
const declaresIdStruct = () =>
  Schema.Struct({ lineId: Schema.optional(Schema.String), qty: Schema.Number }) as Schema.Top
const declaresIdClass = () => {
  class Item extends Schema.Class<Item>("Item")({
    lineId: Schema.optional(Schema.String),
    qty: Schema.Number,
  }) {}
  return Item as unknown as Schema.Top
}
const wraps = (Line: Schema.Top) =>
  Schema.Struct({ line: Line as Schema.Codec<unknown>, qty: Schema.Number }) as Schema.Top

/**
 * A `many` edge whose element is the entity, keyed by `id`, with an optional `lineId` beside its key
 * (the name `create` reads an id of the entity under), at the root or in a sub-aggregate `part`.
 */
const entityWithOwnId = (sub: boolean) => (): Shape => {
  class Line extends Schema.Class<Line>("Line")({
    id: Schema.String,
    f: Schema.Number,
    lineId: Schema.optional(Schema.String),
  }) {}
  const Lines = lines(DynamoModel.configure(Line, { id: { identifier: true } }), {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  })
  const edge = () =>
    Aggregate.many({ entityType: "SheetLine", entity: Lines, sk: { composite: ["id"] } } as never)
  const Part = Schema.Struct({ lines: Schema.Array(Line) })
  const element = { id: "x", f: 9, lineId: "l" }
  return {
    entities: { Lines },
    make: (base) => {
      if (!sub) {
        return aggregate(Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }), base, {
          lines: edge(),
        })
      }
      const Sub = (Aggregate.make as any)(Part, {
        root: { entityType: "Part" },
        edges: { lines: edge() },
      })
      return aggregate(Schema.Struct({ id: Schema.String, part: Part }), base, {
        part: Sub.with({ discriminator: { side: 1 } }),
      })
    },
    seed: [["Lines", { id: "l", f: 5 }]],
    input: sub ? { id: "a", part: { lines: [element] } } : { id: "a", lines: [element] },
  }
}

/**
 * A `one` edge over `Lines` (string-keyed, a class with an identifier), the holder of its field (the
 * input, or its sub-aggregate `part`) made by `holder` from its own properties.
 */
const oneEdgeHeld =
  (
    holder: (own: Record<string, unknown>) => Record<string, unknown>,
    sub: boolean,
    optional = false,
  ) =>
  (): Shape => {
    const { Line, model } = keyedLine(Schema.String, "class")
    const Lines = lines(model, singleKey)
    const edge = () => Aggregate.one({ entityType: "AggLine", entity: Lines } as never)
    const field = optional ? Schema.optional(Line as Schema.Codec<unknown>) : Line
    return {
      entities: { Lines },
      make: (base) => {
        if (!sub) {
          return aggregate(Schema.Struct({ id: Schema.String, line: field }), base, {
            line: edge(),
          })
        }
        const Part = Schema.Struct({ line: field })
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: { line: edge() },
        })
        return aggregate(Schema.Struct({ id: Schema.String, part: Part }), base, {
          part: Sub.with({ discriminator: { side: 1 } }),
        })
      },
      seed: [["Lines", { lineId: "l", f: 5 }]],
      input: sub ? { id: "a", part: holder({}) } : holder({ id: "a" }),
    }
  }

/** A holder of its own properties `own`, its `lineId` given by a getter of its class. */
const byGetter = (own: Record<string, unknown>): Record<string, unknown> => {
  class Command {
    constructor(given: Record<string, unknown>) {
      Object.assign(this, given)
    }
    get lineId() {
      return "l"
    }
  }
  return new Command(own) as unknown as Record<string, unknown>
}

/** A holder of its own properties `own`, `inherited` on its prototype. */
const inheriting =
  (inherited: Record<string, unknown>) =>
  (own: Record<string, unknown>): Record<string, unknown> =>
    Object.assign(Object.create(inherited), own)

/**
 * Shapes an eighth review found, each at the root and in a sub-aggregate: a `many` element that
 * declares the entity's id (`lineId`) and not its field, given a string id, which 1.39.0 fetched
 * (and failed on, where it names no item); an element that is the entity, with an optional field of
 * that name beside its key; and an id, or the entity whole, that the input holds through its class
 * (a getter) or its prototype, which 1.39.0 read.
 */
const reviewedEighth: Record<string, () => Shape> = Object.fromEntries(
  [false, true].flatMap((sub) => {
    const at = (label: string) => (sub ? `sub-aggregate, ${label}` : label)
    return [
      [
        at("many, element a struct declaring the entity's id and not its field, given a string id"),
        classSheet(declaresIdStruct, { lineId: "l", qty: 1 }, sub),
      ],
      [
        at(
          "many, element a struct declaring the entity's id and not its field, given a string id naming no item",
        ),
        classSheet(declaresIdStruct, { lineId: "nope", qty: 1 }, sub),
      ],
      [
        at("many, element a class declaring the entity's id and not its field, given a string id"),
        classSheet(declaresIdClass, { lineId: "l", qty: 1 }, sub),
      ],
      [
        at(
          "many, element the entity with an optional field of its id's name beside its key, given whole with a string in it",
        ),
        entityWithOwnId(sub),
      ],
      [
        at("many, element wraps the entity, its id inherited from the element's prototype"),
        classSheet(wraps, inheriting({ lineId: "l" })({ qty: 1 }), sub),
      ],
      [at("one, its id given by a getter of the input's class"), oneEdgeHeld(byGetter, sub)],
      [
        at("one, its id inherited from the input's prototype"),
        oneEdgeHeld(inheriting({ lineId: "l" }), sub),
      ],
      [
        at("one, the entity whole inherited from the input's prototype"),
        oneEdgeHeld(inheriting({ line: { lineId: "x", f: 2 } }), sub),
      ],
    ] as const
  }),
)

/** A holder of its own properties `own`, its `lineId` answered by a proxy's `get` trap. */
const byProxy = (own: Record<string, unknown>): Record<string, unknown> =>
  new Proxy(own, {
    get: (target, key, receiver) => (key === "lineId" ? "l" : Reflect.get(target, key, receiver)),
  })

/** A holder of its own properties `own`, its class with a method named `lineId`. */
const withMethod = (own: Record<string, unknown>): Record<string, unknown> => {
  class Command {
    constructor(given: Record<string, unknown>) {
      Object.assign(this, given)
    }
    lineId() {
      return "l"
    }
  }
  return new Command(own) as unknown as Record<string, unknown>
}
const wrapsOptionally = (Line: Schema.Top) =>
  Schema.Struct({
    line: Schema.optional(Line as Schema.Codec<unknown>),
    qty: Schema.Number,
  }) as Schema.Top

/**
 * A `many` edge whose element is the entity, keyed by `lineId` (its identifier), which its model (a
 * struct or a class) declares `key`, given `element` whole, at the root or in a sub-aggregate `part`.
 */
const entityKeyedByItsId =
  (kind: "struct" | "class", key: Schema.Top, element: Record<string, unknown>, sub: boolean) =>
  (): Shape => {
    const fields = { lineId: key as never, f: Schema.Number }
    class LineClass extends Schema.Class<LineClass>("Line")(fields) {}
    const Line = (kind === "struct" ? Schema.Struct(fields) : LineClass) as unknown as Schema.Top
    const Lines = lines(
      DynamoModel.configure(Line as never, { lineId: { identifier: true } } as never),
      singleKey,
    )
    const edge = () =>
      Aggregate.many({ entityType: "SheetLine", entity: Lines, sk: { composite: ["f"] } } as never)
    const Part = Schema.Struct({ lines: Schema.Array(Line) })
    return {
      entities: { Lines },
      make: (base) => {
        if (!sub) {
          return aggregate(Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }), base, {
            lines: edge(),
          })
        }
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: { lines: edge() },
        })
        return aggregate(Schema.Struct({ id: Schema.String, part: Part }), base, {
          part: Sub.with({ discriminator: { side: 1 } }),
        })
      },
      seed: [["Lines", { lineId: "l", f: 5 }]],
      input: sub ? { id: "a", part: { lines: [element] } } : { id: "a", lines: [element] },
    }
  }

/**
 * Shapes a ninth review found, each at the root and in a sub-aggregate: an id a proxy's `get` trap
 * answers for, which 1.39.0 read; a method of the id's name on the payload's class, which 1.39.0
 * took for no id; and an element that is the entity, keyed by its id's own name (`lineId`), given
 * whole: 1.39.0 fetched it and completed where its model declares the key optional, and refused it
 * where the key is required.
 */
const reviewedNinth: Record<string, () => Shape> = Object.fromEntries(
  [false, true].flatMap((sub) => {
    const at = (label: string) => (sub ? `sub-aggregate, ${label}` : label)
    return [
      [at("one, its id answered by a proxy's get trap"), oneEdgeHeld(byProxy, sub)],
      [at("one, optional, its id answered by a proxy's get trap"), oneEdgeHeld(byProxy, sub, true)],
      [
        at("many, element wraps the entity, its id answered by a proxy's get trap"),
        classSheet(wraps, byProxy({ qty: 1 }), sub),
      ],
      [
        at("one, optional, not given, the input's class with a method of its id's name"),
        oneEdgeHeld(withMethod, sub, true),
      ],
      [
        at(
          "many, element wraps the entity optionally, the element's class with a method of its id's name",
        ),
        classSheet(wrapsOptionally, withMethod({ qty: 1 }), sub),
      ],
      ...(["struct", "class"] as const).flatMap(
        (kind) =>
          [
            [
              at(`many, element the entity keyed by its optional id (${kind}), given whole`),
              entityKeyedByItsId(kind, Schema.optional(Schema.String), { lineId: "l", f: 9 }, sub),
            ],
            [
              at(
                `many, element the entity keyed by its optional id (${kind}), given whole, its id naming no item`,
              ),
              entityKeyedByItsId(
                kind,
                Schema.optional(Schema.String),
                { lineId: "nope", f: 9 },
                sub,
              ),
            ],
            [
              at(
                `many, element the entity keyed by its required id (${kind}), with an identifier, given whole`,
              ),
              entityKeyedByItsId(kind, Schema.String, { lineId: "l", f: 9 }, sub),
            ],
          ] as const,
      ),
    ] as const
  }),
)

export const SHAPES: Record<string, () => Shape> = {
  "many, element the entity's struct, given whole": () => {
    const Line = lineStruct()
    const Lines = lines(Line, singleKey)
    const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) })
    return {
      entities: { Lines },
      make: (base) =>
        aggregate(Model, base, {
          lines: Aggregate.many({
            entityType: "AggLine",
            entity: Lines,
            sk: { composite: ["lineId"] },
          } as never),
        }),
      seed: [],
      input: { id: "a", lines: [{ lineId: "l", f: 5 }] },
    }
  },
  "many, element the entity's struct, given ids": () => {
    const Line = lineStruct()
    const Lines = lines(Line, singleKey)
    const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) })
    return {
      entities: { Lines },
      make: (base) =>
        aggregate(Model, base, {
          lines: Aggregate.many({
            entityType: "AggLine",
            entity: Lines,
            sk: { composite: ["lineId"] },
          } as never),
        }),
      seed: [["Lines", { lineId: "l", f: 5 }]],
      input: { id: "a", lines: ["l"] },
    }
  },
  ...withAndWithout(false),
  ...withAndWithout(true),
  ...withACode("lineId"),
  ...withACode("code"),
  "many, element wraps an entity keyed by two composites": () => twoComposites("many"),
  "one, an entity keyed by two composites": () => twoComposites("one"),
  ...reviewed,
  ...reviewedAgain,
  ...reviewedThird,
  ...reviewedFourth,
  ...reviewedFifth,
  ...reviewedSixth,
  ...reviewedEighth,
  ...reviewedNinth,
}

export const byKey = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((p, q) => `${p.pk?.S}|${p.sk?.S}`.localeCompare(`${q.pk?.S}|${q.sk?.S}`))

/** The 1.39.0 shape whose rows the shape now writes: the same shape over an entity with an identifier. */
export const WRITES_AS: Record<string, string> = {
  "many, element the entity's struct, given ids":
    "many, element the entity's class, given ids, with an identifier",
  "many, element wraps the entity, without an identifier":
    "many, element wraps the entity, with an identifier",
  "many, element the entity's class, given ids, without an identifier":
    "many, element the entity's class, given ids, with an identifier",
  "one, without an identifier": "one, with an identifier",
  "ref, without an identifier": "ref, with an identifier",
  "many, element wraps an entity with a code, its identifier another field":
    "many, element wraps an entity with a code, with an identifier",
  "one, an entity with a code, its identifier another field":
    "one, an entity with a code, with an identifier",
  ...Object.fromEntries(
    ["", "sub-aggregate, "].map((at) => [
      `${at}one, model declares the edge's id a string, given the entity whole and that id (struct)`,
      `${at}one, model declares the edge's id a string, given the entity whole and that id (class)`,
    ]),
  ),
}
/**
 * Every union element shape. `create` judges a union element as 1.39.0 judged it (a string `lineId`
 * is fetched, whatever member the value is), so each fetches, writes and reads what 1.39.0 did:
 * `create` succeeding or failing as it did, the same rows, the same `get`.
 */
export const UNIONS = Object.keys(fixture.shapes).filter((label) =>
  /, element (a union|a nested union|members sharing)/.test(label),
)
/** Every string `lineId` a shape's `many` elements are given: what 1.39.0 fetched. */
export const stringIds = (input: Record<string, any>): ReadonlyArray<string> =>
  ((input.part?.lines ?? input.lines ?? []) as ReadonlyArray<Record<string, unknown>>)
    .map((element) => element.lineId)
    .filter((id): id is string => typeof id === "string")
/** An exit as the fixture's generator wrote it. */
export const outcomeOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return `ok ${json(exit.value)}`
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
  return error === undefined
    ? `died: ${String(Cause.squash(exit.cause))}`
    : `failed: ${(error as { readonly _tag?: string })._tag}`
}
/** Shapes 1.39.0 hydrated as it should, a union element aside: each writes and reads what it did. */
export const CONTROLS = [
  ...Object.keys(fixture.shapes).filter((label) => label.endsWith("with an identifier")),
  "one, an entity whose key composite is in its pk and its sk",
  "one, an entity keyed by a Date, given its ISO string",
  "one, an entity keyed by a NumberFromString, given its encoded string",
  "many, ids of an entity keyed by a NumberFromString, given encoded strings",
  "one, an entity keyed by an optional NumberFromString, given its encoded string",
  "one, an entity keyed by an optional BigIntFromString, given its encoded string",
  "one, an entity keyed by a NumberFromString or a literal, given its encoded string",
  ...Object.keys(reviewedFourth).filter((label) => !UNIONS.includes(label)),
]
export const UNFETCHABLE = [
  "many, element wraps an entity keyed by two composites",
  "one, an entity keyed by two composites",
]
/**
 * An id of the key composite's own type, which 1.39.0 dropped (so a required edge failed decoding
 * and an optional one was created without it), or fetched under a key `Entity.put` never wrote (a
 * string codec, or one inside a wrapper, which `put` keys by its stored text): each is now fetched
 * by the key `put` wrote.
 */
/**
 * Shapes keyed by a codec `encode` takes on its own output, which 1.39.0's `put` keyed by its stored
 * text encoded once more (`lineid_x:x:mix`). A `put` now keys the stored text (`lineid_x:mix`), where
 * `create` fetches it, and `rekey` moves 1.39.0's rows there (`KeyCodecPaths.test.ts`).
 */
export const KEYED_TWICE_BY_139: ReadonlySet<string> = new Set([
  "one, an entity keyed by a string codec",
])
/** A row 1.39.0 wrote for one of {@link KEYED_TWICE_BY_139}, at the key a `put` gives it now. */
export const keyedOnce = (row: Row): Row => ({
  ...row,
  pk: { S: row.pk!.S!.replace("#lineid_x:x:", "#lineid_x:") },
})
export const NOW_FETCHED = [
  "one, an entity keyed by a number, given a number",
  "one, an entity keyed by a bigint, given a bigint",
  "one, an entity keyed by a number, the edge optional",
  "one, an entity keyed by a bigint, the edge optional",
  "one, an entity keyed by a string codec",
  "many, ids of an entity keyed by a number, given numbers",
  "one, an entity keyed by an optional NumberFromString, given a number",
  "one, an entity keyed by an optional string codec",
]
/**
 * Ids `put` refuses as DynamoDB can't store them, deeper than a number, each with an item of another
 * value seeded under the key text the id composes (`{ a: Infinity }` and `{ a: 5 }` compose one):
 * each fails with `EDD-9131` naming what `put` refuses, nothing fetched, where 1.39.0 refused it
 * as no string.
 */
export const UNSTORABLE = {
  "one, an entity keyed by a struct, given one holding Infinity": '"lineId.a"',
  "one, an entity keyed by a struct, given one holding Infinity, its keys escaped": '"lineId.a"',
  "one, an entity keyed by an Option, given Some(Infinity)": '"lineId.value"',
  "one, an entity keyed by a Result, given a success of Infinity": '"lineId.success"',
  "sub-aggregate, one, an entity keyed by a struct, given one holding Infinity": '"lineId.a"',
} as const
/** Ids no item can be keyed by, which 1.39.0 dropped: each fails with `EDD-9131`, nothing fetched. */
export const UNKEYABLE = {
  "one, an entity keyed by a number, given Infinity": "is given Infinity",
  "one, an entity keyed by a string, given an object whose toString is text":
    'is given an object ({"toString":"x"})',
} as const
/**
 * The fifth review's shapes but its unions ({@link UNIONS}): elements whose schema doesn't name the
 * field holding the entity, judged as 1.39.0 judged them, so each fetches, writes and reads what
 * 1.39.0 did. A number `lineId` is the element's own, never an id to fetch.
 */
export const JUDGED_AS_139 = Object.keys(reviewedFifth).filter((label) => !UNIONS.includes(label))
/**
 * The sixth review's shapes, each sending the requests 1.39.0 sent and writing and reading what it
 * did, but those {@link WRITES_AS} names.
 */
export const SIXTH = Object.keys(reviewedSixth).filter((label) => !(label in WRITES_AS))
/** The eighth review's shapes, each sending the requests 1.39.0 sent, writing and reading what it did. */
export const EIGHTH = Object.keys(reviewedEighth)
/**
 * An element that is the entity, keyed by its id's own name and requiring it, given whole: stored as
 * given, nothing fetched. 1.39.0 took its key for an id, fetched it, and refused the element without
 * its key.
 */
export const OWN_KEY_WHOLE = Object.keys(reviewedNinth).filter((label) =>
  label.includes("keyed by its required id"),
)
/** The ninth review's other shapes, each sending the requests 1.39.0 sent, writing and reading what it did. */
export const NINTH = Object.keys(reviewedNinth).filter((label) => !OWN_KEY_WHOLE.includes(label))
