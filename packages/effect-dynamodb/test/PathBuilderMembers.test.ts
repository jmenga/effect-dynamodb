/**
 * A model field named like one of the path builder's accessors: `size`, `at` or `entry`. In a path
 * callback `t.size` is the field, at the root and below a struct (`t.box.size`); called, the name is
 * the accessor on the path before it (`t.box.size()`, `t.tags.size()`, `t.roster.at(0)`,
 * `t.zones.entry("east")`). Through 1.41.0 it was only the accessor: `eq(t.size, 5)` sent
 * `:e0 = :e1` with nothing behind `:e0`, which DynamoDB rejects, and `.select((t) => [t.size])` died
 * with a `TypeError` before sending. Expressions over a model with no such field send what 1.41.0
 * sent (the pins below were recorded on 1.41.0).
 *
 * The builder's other members (`segments`, `_tag`, `pipe`, `then`, `toJSON`) are still the member,
 * as through 1.41.0: an equality shorthand (`{ eq: { segments: 1 } }`, `.filter({ segments: 1 })`),
 * a record operation (`.set({ segments })`) and a path operation's segments (`["segments"]`) reach
 * a field of that name.
 */

import { it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Expression from "../src/Expression.js"
import * as Lib from "../src/index.js"
import { compileExpr, createConditionOps } from "../src/internal/Expr.js"
import { createPathBuilder, pathBuilderOf } from "../src/internal/PathBuilder.js"
import { makeRecordingTable, type Request } from "./helpers/RecordingTable.js"

const Model = Schema.Struct({
  id: Schema.String,
  size: Schema.Number,
  at: Schema.String,
  entry: Schema.String,
  box: Schema.Struct({ size: Schema.Number, label: Schema.String }),
  tags: Schema.Array(Schema.String),
  roster: Schema.Array(Schema.Struct({ name: Schema.String, at: Schema.String })),
  zones: Schema.Record(Schema.String, Schema.Number),
})
type Model = typeof Model.Type
const Configured = Lib.DynamoModel.configure(Model, {
  zones: { storedAs: Lib.DynamoModel.SparseMap() },
})

const row = {
  id: "a",
  size: 5,
  at: "x",
  entry: "y",
  box: { size: 5, label: "l" },
  tags: ["t1", "t2"],
  roster: [{ name: "Ann", at: "home" }],
  zones: { east: 1 },
}

/** Each request's expressions: what these tests compare. */
const expressionsOf = (sent: ReadonlyArray<Request>) =>
  sent.map(({ command, input }) => ({
    command,
    UpdateExpression: input.UpdateExpression,
    ConditionExpression: input.ConditionExpression,
    FilterExpression: input.FilterExpression,
    ProjectionExpression: input.ProjectionExpression,
    ExpressionAttributeNames: input.ExpressionAttributeNames,
    ExpressionAttributeValues: input.ExpressionAttributeValues,
  }))

/** Runs `body` against a recording table holding `put`'s row, with `entity` bound. */
const onTable = <A>(
  entity: any,
  put: unknown,
  body: (db: any, take: () => Array<Request>) => Effect.Effect<A, unknown, any>,
) => {
  const Main = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "names", version: 1 }),
    entities: { Docs: entity },
  })
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* Lib.DynamoClient.make({ entities: { Docs: entity }, tables: { Main } })
    yield* db.entities.Docs.put(put).asEffect()
    table.take()
    return yield* body(db, table.take)
  }).pipe(
    Effect.provide(Layer.merge(table.layer, Main.layer({ name: "names" })) as never),
  ) as Effect.Effect<A, unknown>
}

describe("a model field named size, at or entry", () => {
  it("is the field's path, at the root and below a struct", () => {
    const t = pathBuilderOf<Model>([Configured])
    const { and, eq } = createConditionOps<Model>()
    expect(
      compileExpr(and(eq(t.size, 5), eq(t.at, "x"), eq(t.entry, "y"), eq(t.box.size, 5))),
    ).toEqual({
      expression: "(#e0 = :e1) AND (#e2 = :e3) AND (#e4 = :e5) AND (#e6.#e7 = :e8)",
      names: {
        "#e0": "size",
        "#e2": "at",
        "#e4": "entry",
        "#e6": "box",
        "#e7": "size",
      },
      values: { ":e1": { N: "5" }, ":e3": { S: "x" }, ":e5": { S: "y" }, ":e8": { N: "5" } },
    })
  })

  it("is the accessor where it is called", () => {
    const t = pathBuilderOf<Model>([Configured])
    const { and, eq, gt } = createConditionOps<Model>()
    expect(
      compileExpr(
        and(
          gt(t.box.size(), 1),
          gt(t.tags.size(), 1),
          eq(t.roster.at(0).at, "home"),
          eq(t.zones.entry("east"), 1),
        ),
      ),
    ).toEqual({
      expression: "(size(#e0) > :e1) AND (size(#e2) > :e3) AND (#e4[0].#e5 = :e6) AND (#e7 = :e8)",
      names: { "#e0": "box", "#e2": "tags", "#e4": "roster", "#e5": "at", "#e7": "zones#east" },
      values: { ":e1": { N: "1" }, ":e3": { N: "1" }, ":e6": { S: "home" }, ":e8": { N: "1" } },
    })
    // `.entry()` still names a sparse map only.
    expect(() => (t.box as any).entry("k")).toThrow(/not configured as a sparse map/)
  })

  it.effect("is reached by a condition, a filter and a select, beside a path operation", () =>
    onTable(
      Lib.Entity.make({
        model: Configured,
        entityType: "Doc",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      }),
      row,
      (db, take) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.update({ id: "a" })
            .pathSet({ segments: ["box", "size"], value: 6, isPath: false })
            .condition((t: any, { and, eq }: any) => and(eq(t.size, 5), eq(t.box.size, 5)))
            .asEffect()
          expect(expressionsOf(take())).toEqual([
            {
              command: "UpdateItem",
              UpdateExpression: "SET #ps0.#ps1 = :ps2",
              ConditionExpression:
                "((#e0 = :e1) AND (#e2.#e3 = :e4)) AND attribute_exists(#exists)",
              FilterExpression: undefined,
              ProjectionExpression: undefined,
              ExpressionAttributeNames: {
                "#ps0": "box",
                "#ps1": "size",
                "#e0": "size",
                "#e2": "box",
                "#e3": "size",
                "#exists": "pk",
              },
              ExpressionAttributeValues: {
                ":ps2": { N: "6" },
                ":e1": { N: "5" },
                ":e4": { N: "5" },
              },
            },
          ])
          const refused = yield* db.entities.Docs.update({ id: "a" })
            .set({ at: "z" })
            .condition((t: any, { eq }: any) => eq(t.size, 6))
            .asEffect()
            .pipe(Effect.flip)
          expect(refused._tag).toBe("ConditionalCheckFailed")
          const found = yield* db.entities.Docs.scan()
            .filter((t: any, { and, eq }: any) =>
              and(eq(t.size, 5), eq(t.at, "x"), eq(t.entry, "y"), eq(t.box.size, 6)),
            )
            .collect()
          expect(found.map((doc: any) => doc.id)).toEqual(["a"])
          const selected = yield* db.entities.Docs.scan()
            .select((t: any) => [t.size, t.at, t.entry, t.box.size])
            .collect()
          expect(selected).toEqual([{ size: 5, at: "x", entry: "y", box: { size: 6 } }])
        }),
    ),
  )

  it("is reached by an equality shorthand, as through 1.41.0", () => {
    const { expression, names } = Expression.condition({ eq: { at: 1, size: 2 } })
    expect(Object.values(names).sort()).toEqual(["at", "size"])
    expect(expression).toContain("=")
  })
})

describe("the builder's other members", () => {
  it("are still the member, as through 1.41.0", () => {
    const t = createPathBuilder<{ readonly segments: string }>() as unknown as Record<
      string,
      unknown
    >
    expect(t.segments).toEqual([])
    expect(t.then).toBeUndefined()
    expect(t.pipe).toBeUndefined()
    expect(t.toJSON).toBeUndefined()
  })
})

const Plain = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  tags: Schema.Array(Schema.String),
  roster: Schema.Array(Schema.Struct({ name: Schema.String })),
  box: Schema.Struct({ width: Schema.Number }),
})

describe("a model with no field named like an accessor", () => {
  it.effect("sends what 1.41.0 sent", () =>
    onTable(
      Lib.Entity.make({
        model: Plain,
        entityType: "Doc",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      }),
      { id: "a", status: "open", tags: ["t1", "t2"], roster: [{ name: "Ann" }], box: { width: 2 } },
      (db, take) =>
        Effect.gen(function* () {
          const scan = {
            command: "Scan",
            UpdateExpression: undefined,
            ConditionExpression: undefined,
          }
          const filtered = { ...scan, ProjectionExpression: undefined }
          yield* db.entities.Docs.update({ id: "a" })
            .set({ status: "done" })
            .condition((t: any, { eq }: any) => eq(t.status, "open"))
            .asEffect()
          expect(expressionsOf(take())).toEqual([
            {
              command: "UpdateItem",
              UpdateExpression: "SET #u0 = :u0",
              ConditionExpression: "(#e0 = :e1) AND attribute_exists(#exists)",
              FilterExpression: undefined,
              ProjectionExpression: undefined,
              ExpressionAttributeNames: { "#u0": "status", "#e0": "status", "#exists": "pk" },
              ExpressionAttributeValues: { ":u0": { S: "done" }, ":e1": { S: "open" } },
            },
          ])
          yield* db.entities.Docs.scan()
            .filter((t: any, { gt }: any) => gt(t.tags.size(), 1))
            .collect()
          expect(expressionsOf(take())).toEqual([
            {
              ...filtered,
              FilterExpression: "#eddE IN (:et0) AND (size(#e0) > :e1)",
              ExpressionAttributeNames: { "#eddE": "__edd_e__", "#e0": "tags" },
              ExpressionAttributeValues: { ":et0": { S: "Doc" }, ":e1": { N: "1" } },
            },
          ])
          yield* db.entities.Docs.scan()
            .filter((t: any, { eq }: any) => eq(t.roster.at(0).name, "Ann"))
            .collect()
          expect(expressionsOf(take())).toEqual([
            {
              ...filtered,
              FilterExpression: "#eddE IN (:et0) AND (#e0[0].#e1 = :e2)",
              ExpressionAttributeNames: { "#eddE": "__edd_e__", "#e0": "roster", "#e1": "name" },
              ExpressionAttributeValues: { ":et0": { S: "Doc" }, ":e2": { S: "Ann" } },
            },
          ])
          yield* db.entities.Docs.scan()
            .select((t: any) => [t.box.width, t.roster.at(0).name, t.tags.at(1)])
            .collect()
          expect(expressionsOf(take())).toEqual([
            {
              ...scan,
              FilterExpression: "#eddE IN (:et0)",
              ProjectionExpression: "#proj0.#proj1, #proj2[0].#proj3, #proj4[1], #proj5",
              ExpressionAttributeNames: {
                "#eddE": "__edd_e__",
                "#proj0": "box",
                "#proj1": "width",
                "#proj2": "roster",
                "#proj3": "name",
                "#proj4": "tags",
                "#proj5": "__edd_e__",
              },
              ExpressionAttributeValues: { ":et0": { S: "Doc" } },
            },
          ])
          yield* db.entities.Docs.update({ id: "a" })
            .pathSet({ segments: ["box", "width"], value: 3, isPath: false })
            .condition((t: any, { gt }: any) => gt(t.box.size(), 0))
            .asEffect()
          expect(expressionsOf(take())).toEqual([
            {
              command: "UpdateItem",
              UpdateExpression: "SET #ps0.#ps1 = :ps2",
              ConditionExpression: "(size(#e0) > :e1) AND attribute_exists(#exists)",
              FilterExpression: undefined,
              ProjectionExpression: undefined,
              ExpressionAttributeNames: {
                "#ps0": "box",
                "#ps1": "width",
                "#e0": "box",
                "#exists": "pk",
              },
              ExpressionAttributeValues: { ":ps2": { N: "3" }, ":e1": { N: "0" } },
            },
          ])
        }),
    ),
  )
})
