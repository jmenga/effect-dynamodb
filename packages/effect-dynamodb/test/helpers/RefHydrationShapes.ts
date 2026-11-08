/**
 * The shapes of `fixtures/ref-hydration-1.39.0.json`, as its generator declared them: each way an
 * aggregate edge names an `entity`, over an entity with a `DynamoModel.identifier`, one without, one
 * whose identifier is a field other than its key, and one keyed by two composites. Shared by `AggregateRefHydration.test.ts` (a recording table) and
 * `connected.aggregate-ref-hydration.test.ts` (DynamoDB Local).
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Schema } from "effect"
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
      readonly create: string
      readonly get: string
      readonly rows: ReadonlyArray<Row>
    }
  >
}

// The fixture's definitions: they must stay what its generator declared.
export const schema = DynamoSchema.make({ name: "hydrate", version: 1 })
const singleKey = { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } }
const twoKey = {
  pk: { field: "pk", composite: ["tenant"] },
  sk: { field: "sk", composite: ["lineId"] },
}
const aggregate = (model: Schema.Top, base: unknown, edges: Record<string, unknown>) =>
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
const lineClass = (identifier: boolean) => {
  class Line extends Schema.Class<Line>("Line")({ lineId: Schema.String, f: Schema.Number }) {}
  return {
    Line,
    model: identifier ? DynamoModel.configure(Line, { lineId: { identifier: true } }) : Line,
  }
}
const lines = (model: unknown, primaryKey: unknown) =>
  Entity.make({ model, entityType: "Line", primaryKey } as never) as any

export type Shape = {
  readonly entities: Record<string, unknown>
  readonly make: (base: unknown) => unknown
  readonly seed: ReadonlyArray<Record<string, unknown>>
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
        seed: [{ lineId: "l", f: 5 }],
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
        seed: [{ lineId: "l", f: 5 }],
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
        seed: [{ lineId: "l", f: 5 }],
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
        seed: [{ lineId: "l", f: 5 }],
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
        seed: [{ lineId: "l", code: "c", f: 5 }],
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
        seed: [{ lineId: "l", code: "c", f: 5 }],
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
    seed: [{ tenant: "t", lineId: "l", f: 5 }],
    input:
      edge === "many" ? { id: "a", lines: [{ lineId: "l", qty: 2 }] } : { id: "a", lineId: "l" },
  }
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
      seed: [{ lineId: "l", f: 5 }],
      input: { id: "a", lines: ["l"] },
    }
  },
  ...withAndWithout(false),
  ...withAndWithout(true),
  ...withACode("lineId"),
  ...withACode("code"),
  "many, element wraps an entity keyed by two composites": () => twoComposites("many"),
  "one, an entity keyed by two composites": () => twoComposites("one"),
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
export const CONTROLS = Object.keys(fixture.shapes).filter((label) =>
  label.endsWith("with an identifier"),
)
export const UNFETCHABLE = [
  "many, element wraps an entity keyed by two composites",
  "one, an entity keyed by two composites",
]
