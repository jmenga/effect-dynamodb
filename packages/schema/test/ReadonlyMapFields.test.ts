/**
 * `[EDD-9125]`: a model whose stored side holds a `Schema.ReadonlyMap` fails at load, at any depth,
 * on the pure `Entity.make` and `Aggregate.make`. What's read is the stored side, so a map stored as
 * something else stays. The operational makes are in `effect-dynamodb`'s test of the same name, and
 * the forms that stay are stored and read back in its connected suite.
 */

import { Schema, SchemaGetter } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })
const table = { Tag: Symbol.for("test/table") }

const Counts = Schema.ReadonlyMap(Schema.String, Schema.Number)
const Text = Schema.Record(Schema.String, Schema.Number)

class Held extends Schema.Class<Held>("Held")({ counts: Counts }) {}

interface Tree {
  readonly children: ReadonlyArray<Tree>
  readonly counts: ReadonlyMap<string, number>
}
const Tree: Schema.Codec<Tree> = Schema.Struct({
  children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
  counts: Counts,
})

interface Plain {
  readonly children: ReadonlyArray<Plain>
}
const Plain: Schema.Codec<Plain> = Schema.Struct({
  children: Schema.Array(Schema.suspend((): Schema.Codec<Plain> => Plain)),
})

const fromText = Text.pipe(
  Schema.decodeTo(Counts, {
    decode: SchemaGetter.transform((text) => new Map(Object.entries(text))),
    encode: SchemaGetter.transform((counts) => Object.fromEntries(counts)),
  }),
)
const toMap = Counts.pipe(
  Schema.decodeTo(Text, {
    decode: SchemaGetter.transform((counts) => Object.fromEntries(counts)),
    encode: SchemaGetter.transform((text) => new Map(Object.entries(text))),
  }),
)

/** A field, and the path a refusal names in it. */
const REFUSED: ReadonlyArray<readonly [string, Schema.Top, string]> = [
  ["a field", Counts, "f"],
  ["Schema.optional", Schema.optional(Counts), "f"],
  ["Schema.optionalKey", Schema.optionalKey(Counts), "f"],
  ["Schema.UndefinedOr", Schema.UndefinedOr(Counts), "f"],
  ["Schema.NullOr", Schema.NullOr(Counts), "f"],
  ["a union member", Schema.Union([Schema.String, Counts]), "f"],
  ["Schema.Option", Schema.Option(Counts), "f"],
  ["a struct's field", Schema.Struct({ a: Schema.String, m: Counts }), "f.m"],
  ["a class's field", Held, "f.counts"],
  ["two structs down", Schema.Struct({ a: Schema.Struct({ b: Counts }) }), "f.a.b"],
  ["an array's element", Schema.Array(Counts), "f[]"],
  ["a tuple's position", Schema.Tuple([Schema.String, Counts]), "f[]"],
  ["a tuple's rest", Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Counts]), "f[]"],
  ["a record's value", Schema.Record(Schema.String, Counts), "f[key]"],
  ["a struct in an array", Schema.Array(Schema.Struct({ m: Counts })), "f[].m"],
  ["a set of them", Schema.ReadonlySet(Counts), "f"],
  ["inside a recursive schema", Tree, "f.children[].counts"],
  ["under Schema.suspend", Schema.suspend(() => Counts), "f"],
  ["a transform stored as a map", toMap, "f"],
  ["packed", Schema.Struct({ m: Counts }), "f.m"],
]

const ALLOWED: ReadonlyArray<readonly [string, Schema.Top]> = [
  ["a record", Text],
  ["a record of records", Schema.Record(Schema.String, Text)],
  ["a set", Schema.ReadonlySet(Schema.String)],
  ["a date", Schema.DateTimeUtc],
  ["Schema.Option of something else", Schema.Option(Schema.String)],
  ["a map decoded from a record", fromText],
  ["Schema.toCodecJson of a map", Schema.toCodecJson(Counts)],
  ["a recursive schema without one", Plain],
  ["Schema.Unknown", Schema.Unknown],
  ["a struct", Schema.Struct({ a: Schema.Array(Schema.String) })],
]

const modelOf = (field: Schema.Top) => Schema.Struct({ id: Schema.String, f: field as never })

const entity = (model: unknown) =>
  Entity.make({
    model: model as never,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never)

const aggregate = (model: unknown) =>
  (Aggregate.make as any)(model, {
    table,
    schema: AppSchema,
    pk: { field: "pk", composite: ["id"] },
    collection: { index: "gsi1", name: "agg", sk: { field: "gsi1sk", composite: [] } },
    root: { entityType: "Agg" },
    edges: {},
  })

const subAggregate = (model: unknown) =>
  (Aggregate.make as any)(model, { root: { entityType: "Sub" }, edges: {} })

const MAKES: ReadonlyArray<readonly [string, (model: unknown) => unknown, string]> = [
  ["Entity.make", entity, 'Entity "E"'],
  ["Aggregate.make", aggregate, 'Aggregate "Agg"'],
  ["Aggregate.make, a sub-aggregate", subAggregate, 'Aggregate "Sub"'],
]

/** What a refused definition throws, with where it says the map is. */
const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return String((error as Error).message)
  }
  return "nothing refused"
}

for (const [make, build, owner] of MAKES) {
  describe(`[EDD-9125] ${make}`, () => {
    for (const [name, field, path] of REFUSED) {
      it(`refuses ${name}, naming "${path}"`, () => {
        const message = refusal(() =>
          build(
            name === "packed"
              ? DynamoModel.configure(
                  modelOf(field) as never,
                  {
                    f: { storedAs: DynamoModel.Packed({ format: "json" }) },
                  } as never,
                )
              : modelOf(field),
          ),
        )
        expect(message).toContain("[EDD-9125]")
        expect(message).toContain(owner)
        expect(message).toContain(`field "${path}" is a Schema.ReadonlyMap`)
        expect(message).toContain("Use Schema.Record")
      })
    }

    for (const [name, field] of ALLOWED) {
      it(`takes ${name}`, () => {
        expect(refusal(() => build(modelOf(field)))).toBe("nothing refused")
      })
    }
  })
}

describe("[EDD-9125] what's refused", () => {
  it("a class model's own field", () => {
    class Model extends Schema.Class<Model>("MapModel")({ id: Schema.String, counts: Counts }) {}
    expect(refusal(() => entity(Model))).toContain('field "counts"')
    expect(refusal(() => aggregate(Model))).toContain('field "counts"')
  })

  it("a configured model's field", () => {
    const configured = DynamoModel.configure(
      modelOf(Counts) as never,
      {
        id: { immutable: true },
      } as never,
    )
    expect(refusal(() => entity(configured))).toContain('field "f"')
    expect(refusal(() => aggregate(configured))).toContain('field "f"')
    expect(refusal(() => subAggregate(configured))).toContain('field "f"')
  })

  it("a model that is one says so", () => {
    expect(refusal(() => subAggregate(Counts))).toContain("the model is a Schema.ReadonlyMap")
  })

  it("a many edge over one isn't: its collection is rows, and only the rows are stored", () => {
    const Line = Schema.Struct({ sku: Schema.String })
    const message = refusal(() =>
      (Aggregate.make as any)(
        Schema.Struct({ id: Schema.String, lines: Schema.ReadonlyMap(Schema.String, Line) }),
        {
          table,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { index: "gsi1", name: "agg", sk: { field: "gsi1sk", composite: [] } },
          root: { entityType: "Agg" },
          edges: {
            lines: Aggregate.many({
              entityType: "Line",
              sk: { composite: ["sku"] },
              decompose: (rows: ReadonlyMap<string, unknown>) => [...rows.values()],
              assemble: (rows: ReadonlyArray<never>) => new Map(rows),
            } as never),
          },
        },
      ),
    )
    expect(message).toBe("nothing refused")
  })
})
