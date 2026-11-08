/**
 * The shapes of `fixtures/ref-hydration-1.39.0.json`, as its generator declared them: each way an
 * aggregate edge names an `entity`, over an entity with a `DynamoModel.identifier`, one without, one
 * whose identifier is a field other than its key, and one keyed by two composites; a `many` element
 * that is a union wrapping the entity (at the root and in a sub-aggregate); an entity whose key
 * composite is in both halves of its key; entities keyed by a number, a bigint, a `Date`, a
 * `NumberFromString` and a string codec; an element declaring the entity's field a string; and two
 * edges, the second over an entity no one id keys. Shared by `AggregateRefHydration.test.ts` (a
 * recording table) and `connected.aggregate-ref-hydration.test.ts` (DynamoDB Local).
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Schema, SchemaGetter } from "effect"
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
    }
  >
}

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
export const aggregate = (model: Schema.Top, base: unknown, edges: Record<string, unknown>) =>
  (Aggregate.make as any)(model, {
    table: base,
    schema,
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
const keyedBy =
  (keySchema: Schema.Top, id: unknown, given: unknown, optional = false) =>
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
      entities: { Lines },
      make: (base) =>
        aggregate(Model, base, {
          line: Aggregate.one({ entityType: "AggLine", entity: Lines } as never),
        }),
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
}
/** Shapes 1.39.0 hydrated as it should: each writes and reads exactly what 1.39.0 did. */
export const CONTROLS = [
  ...Object.keys(fixture.shapes).filter((label) => label.endsWith("with an identifier")),
  "many, element a union of structs wrapping the entity",
  "many, element a union whose members may hold the entity",
  "sub-aggregate, many, element a union of structs wrapping the entity",
  "one, an entity whose key composite is in its pk and its sk",
  "one, an entity keyed by a Date, given its ISO string",
  "one, an entity keyed by a NumberFromString, given its encoded string",
  "many, ids of an entity keyed by a NumberFromString, given encoded strings",
]
export const UNFETCHABLE = [
  "many, element wraps an entity keyed by two composites",
  "one, an entity keyed by two composites",
]
/**
 * An id of the key composite's own type, which 1.39.0 dropped (so a required edge failed decoding
 * and an optional one was created without it), or fetched under a key `Entity.put` never wrote (a
 * string codec, which `put` applies twice): each is now fetched by the key `put` wrote.
 */
export const NOW_FETCHED = [
  "one, an entity keyed by a number, given a number",
  "one, an entity keyed by a bigint, given a bigint",
  "one, an entity keyed by a number, the edge optional",
  "one, an entity keyed by a bigint, the edge optional",
  "one, an entity keyed by a string codec",
  "many, ids of an entity keyed by a number, given numbers",
]
