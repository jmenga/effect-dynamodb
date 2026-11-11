/**
 * Aggregate fields and `many` elements whose schema is a union with a transformed member, or a
 * transformation from a struct or a record, as `fixtures/aggregate-union-members-1.39.0.json` holds
 * them: each shape's model, the entity rows seeded first, and its `create` input. The fixture holds
 * what published 1.39.0 sent, stored and returned for each on DynamoDB Local: `create`, `get`, an
 * `update` handing the state back, `get`. `runShape` does the same on any table and reports it in
 * the fixture's form. `createResultFieldShapes` and `renameShapes` are the shapes
 * `fixtures/aggregate-create-result-1.39.0.json` holds, compared by `compareCreateResult`. Shared by
 * `AggregateUnionMembers.test.ts` (a recording table) and its connected twin.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema, SchemaGetter } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"

type Row = Record<string, AttributeValue>

export type Shape = {
  readonly schema: DynamoSchema.DynamoSchema
  readonly entities: Record<string, any>
  readonly make: (base: any) => any
  readonly seed: ReadonlyArray<readonly [string, unknown]>
  readonly input: unknown
  readonly update: (context: { readonly state: any }) => unknown
}

export type Outcome = {
  readonly ok?: unknown
  readonly failed?: string
  readonly died?: string
  readonly operation?: string | undefined
}

export type Recorded = {
  readonly make: string
  readonly create: Outcome
  readonly requests: ReadonlyArray<{ readonly op: string; readonly input: unknown }>
  readonly rows: ReadonlyArray<unknown>
  readonly get: Outcome
  readonly update: Outcome
  readonly updateRequests: ReadonlyArray<{ readonly op: string; readonly input: unknown }>
  readonly updateRows: ReadonlyArray<unknown>
  readonly getAfterUpdate: Outcome
}

/** A value as the fixture's generator wrote it: JSON, with an instance named by its class. */
const tagged = (value: unknown): unknown => {
  if (typeof value === "bigint") return `${value}n`
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const proto = Object.getPrototypeOf(value)
  if (proto === Object.prototype || proto === null) return value
  const body =
    value instanceof Map
      ? [...value]
      : value instanceof Set
        ? [...value]
        : value instanceof Error
          ? value.message
          : ArrayBuffer.isView(value)
            ? [...(value as Uint8Array)]
            : { ...value }
  return { [`<${(value as object).constructor?.name ?? "?"}>`]: body }
}

export const json = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, v) => tagged(v)) ?? "null")

const outcome = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: json(exit.value) }
  const error = Cause.squash(exit.cause) as { readonly _tag?: string; readonly operation?: string }
  return {
    [Cause.hasDies(exit.cause) ? "died" : "failed"]: error?._tag ?? "Error",
    operation: error?.operation,
  }
}

/** The rows, in key order, as the generator scanned them. */
export const sortedRows = (rows: Iterable<Row>) =>
  json([...rows].sort((a, b) => `${a.pk?.S}|${a.sk?.S}`.localeCompare(`${b.pk?.S}|${b.sk?.S}`)))

/**
 * An aggregate keyed by `id` whose `lines` (on the root, or in a sub-aggregate `part` with the
 * discriminator `side: 1`) is a `many` edge of `element`s over the `Line` entity keyed by `id`,
 * with `Line` `L` seeded, created from `input` and updated with its own state.
 */
const manyShape =
  (schema: DynamoSchema.DynamoSchema) =>
  (element: (line: Schema.Top) => Schema.Top, input: unknown, sub: boolean) =>
  (): Shape => {
    class Line extends Schema.Class<Line>("Line")({ id: Schema.String, f: Schema.Number }) {}
    const Lines = Entity.make({
      model: DynamoModel.configure(Line, { id: { identifier: true } }),
      entityType: "Line",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
    } as never)
    const El = element(Line) as Schema.Codec<any>
    const edge = () =>
      Aggregate.many({ entityType: "Sheet", entity: Lines, sk: { composite: ["qty"] } } as never)
    const aggregate = (Model: Schema.Top, Base: unknown, edges: unknown) =>
      (Aggregate.make as any)(Model, {
        table: Base,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "agg" },
        root: { entityType: "Root" },
        edges,
      })
    return {
      schema,
      entities: { Lines },
      make: (Base) => {
        if (!sub) {
          return aggregate(Schema.Struct({ id: Schema.String, lines: Schema.Array(El) }), Base, {
            lines: edge(),
          })
        }
        const Part = Schema.Struct({ lines: Schema.Array(El) })
        const Sub = (Aggregate.make as any)(Part, {
          root: { entityType: "Part" },
          edges: { lines: edge() },
        })
        return aggregate(Schema.Struct({ id: Schema.String, part: Part }), Base, {
          part: Sub.with({ discriminator: { side: 1 } }),
        })
      },
      seed: [["Lines", { id: "L", f: 1 }]],
      input: sub ? { id: "a", part: { lines: [input] } } : { id: "a", lines: [input] },
      update: ({ state }) => ({ ...state }),
    }
  }

/** A `many` edge's elements: a union, or a struct, over the `Line` entity keyed by `id`. */
export const elementShapes = (): Record<string, () => Shape> => {
  const build = manyShape(DynamoSchema.make({ name: "union", version: 1 }))
  const copy = SchemaGetter.transform((x: object) => ({ ...x }))
  const toUnknown = (member: Schema.Top) =>
    (member as any).pipe(Schema.decodeTo(Schema.Unknown, { decode: copy, encode: copy } as never))
  const toDeclare = (member: Schema.Top) =>
    (member as any).pipe(
      Schema.decodeTo(
        Schema.declare((x: unknown) => typeof x === "object" && x !== null),
        { decode: copy, encode: copy } as never,
      ),
    )
  const T: Record<string, (member: Schema.Top) => Schema.Top> = {
    none: (member) => member,
    unknown: toUnknown,
    declare: toDeclare,
  }
  const out: Record<string, () => Shape> = {}
  for (const sub of [false, true]) {
    const at = (label: string) => (sub ? `sub-aggregate, ${label}` : label)
    // The two shapes found: a member's value given a string `lineId`, which the edge fetches as
    // `line`, and the other member given to a union whose wrapping member transforms to `Unknown`.
    const sharedA = { kind: "a", lineId: "L", qty: 1, line: "KEEP" }
    out[
      at(
        "members to Unknown and a declaration, decoding to one value, given the second member with a string lineId",
      )
    ] = build(
      () =>
        Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("ref"),
            lineId: Schema.String,
            qty: Schema.Number,
          }).pipe(
            Schema.decodeTo(Schema.Unknown, {
              decode: SchemaGetter.transform(() => sharedA),
              encode: SchemaGetter.transform((x: any) => ({ ...x, kind: "ref" })),
            } as never),
          ),
          Schema.Struct({
            kind: Schema.Literal("a"),
            lineId: Schema.String,
            qty: Schema.Number,
            line: Schema.String,
          }).pipe(
            Schema.decodeTo(
              Schema.declare((x: unknown): x is unknown => x === sharedA),
              {
                decode: SchemaGetter.transform(() => sharedA),
                encode: SchemaGetter.transform((x: any) => ({ ...x })),
              } as never,
            ),
          ),
        ] as never) as unknown as Schema.Top,
      { ...sharedA },
      sub,
    )
    out[at("the wrapping member to Unknown, given the other member")] = build(
      (Line) =>
        Schema.Union([
          toUnknown(Schema.Struct({ kind: Schema.Literal("ref"), qty: Schema.Number, line: Line })),
          Schema.Struct({ kind: Schema.Literal("own"), qty: Schema.Number, line: Schema.String }),
        ] as never) as unknown as Schema.Top,
      { kind: "own", qty: 1, line: "KEEP" },
      sub,
    )
    // Their neighbours: each member untransformed, to `Unknown` or to a declaration.
    for (const [t1, f1] of Object.entries(T)) {
      for (const [t2, f2] of Object.entries(T)) {
        const wraps = (Line: Schema.Top) =>
          Schema.Union([
            f1(Schema.Struct({ kind: Schema.Literal("ref"), qty: Schema.Number, line: Line })),
            f2(
              Schema.Struct({
                kind: Schema.Literal("own"),
                qty: Schema.Number,
                line: Schema.String,
              }),
            ),
          ] as never) as unknown as Schema.Top
        const tag = `wrapping member ${t1}, other member ${t2}`
        out[at(`${tag}, given the wrapping member by id`)] = build(
          wraps,
          { kind: "ref", qty: 1, lineId: "L" },
          sub,
        )
        out[at(`${tag}, given the wrapping member whole`)] = build(
          wraps,
          { kind: "ref", qty: 2, line: { id: "L", f: 7 } },
          sub,
        )
        out[at(`${tag}, given the other member`)] = build(
          wraps,
          { kind: "own", qty: 3, line: "KEEP" },
          sub,
        )
        out[at(`${tag}, given the other member with a string lineId`)] = build(
          wraps,
          { kind: "own", qty: 4, line: "KEEP", lineId: "L" },
          sub,
        )
        const declares = () =>
          Schema.Union([
            f1(
              Schema.Struct({
                kind: Schema.Literal("ref"),
                lineId: Schema.String,
                qty: Schema.Number,
              }),
            ),
            f2(
              Schema.Struct({
                kind: Schema.Literal("a"),
                lineId: Schema.String,
                qty: Schema.Number,
                line: Schema.String,
              }),
            ),
          ] as never) as unknown as Schema.Top
        const dtag = `members declaring lineId, first ${t1}, second ${t2}`
        out[at(`${dtag}, given the first member`)] = build(
          declares,
          { kind: "ref", lineId: "L", qty: 5 },
          sub,
        )
        out[at(`${dtag}, given the second member`)] = build(
          declares,
          { kind: "a", lineId: "L", qty: 6, line: "KEEP" },
          sub,
        )
      }
    }
  }
  return out
}

/**
 * A field whose schema is a transformation from a struct or a record to `Unknown`, alone, under
 * `NullOr` or `optional`, or a member of a union with a tagged struct, on the root and in a
 * sub-aggregate, given each of `valuesFor(wrapper)`: by default a value that's neither form.
 */
export const fieldShapes = (
  valuesFor: (wrapper: string) => Record<string, unknown> = () => ({
    "garbage 5": 5,
    "garbage object": { b: 1 },
  }),
): Record<string, () => Shape> => {
  const schema = DynamoSchema.make({ name: "nbr", version: 1 })
  const kinds: Record<string, () => Schema.Top> = {
    "struct to Unknown": () =>
      Schema.Struct({ a: Schema.String }).pipe(
        Schema.decodeTo(Schema.Unknown, {
          decode: SchemaGetter.transform((w: any) => ({ A: w.a })),
          encode: SchemaGetter.transform((d: any) => ({ a: d.A })),
        } as never),
      ) as unknown as Schema.Top,
    "record to Unknown": () =>
      Schema.Record(Schema.String, Schema.String).pipe(
        Schema.decodeTo(Schema.Unknown, {
          decode: SchemaGetter.transform((r: unknown) => ({ marked: r })),
          encode: SchemaGetter.transform((d: any) => d.marked),
        } as never),
      ) as unknown as Schema.Top,
  }
  const tagged = Schema.Struct({ kind: Schema.Literal("own"), line: Schema.String })
  const wrappers: Record<string, (field: Schema.Top) => Schema.Top> = {
    alone: (field) => field,
    NullOr: (field) => Schema.NullOr(field as Schema.Codec<any>) as unknown as Schema.Top,
    optional: (field) => Schema.optional(field as Schema.Codec<any>) as unknown as Schema.Top,
    "union before a tagged struct": (field) =>
      Schema.Union([field, tagged] as never) as unknown as Schema.Top,
    "union after a tagged struct": (field) =>
      Schema.Union([tagged, field] as never) as unknown as Schema.Top,
  }
  const out: Record<string, () => Shape> = {}
  for (const sub of [false, true]) {
    for (const [kname, kind] of Object.entries(kinds)) {
      for (const [wname, wrap] of Object.entries(wrappers)) {
        for (const [vname, value] of Object.entries(valuesFor(wname))) {
          out[`${sub ? "sub-aggregate, " : ""}${kname}, ${wname}, given ${vname}`] = () => {
            const field = wrap(kind()) as Schema.Codec<any>
            return {
              schema,
              entities: {},
              make: (Base) => {
                const common = {
                  table: Base,
                  schema,
                  pk: { field: "pk", composite: ["id"] },
                  collection: { name: "agg" },
                  root: { entityType: "Root" },
                }
                const make = Aggregate.make as any
                if (!sub) {
                  return make(
                    Schema.Struct({ id: Schema.String, title: Schema.String, f: field }),
                    {
                      ...common,
                      edges: {},
                    },
                  )
                }
                const Part = Schema.Struct({ f: field })
                const Sub = make(Part, { root: { entityType: "Part" }, edges: {} })
                return make(
                  Schema.Struct({ id: Schema.String, title: Schema.String, part: Part }),
                  {
                    ...common,
                    edges: { part: Sub.with({ discriminator: { side: 1 } }) },
                  },
                )
              },
              seed: [],
              input: sub
                ? { id: "a", title: "t1", part: { f: value } }
                : { id: "a", title: "t1", f: value },
              update: ({ state }) => ({ ...state, title: "t2" }),
            }
          }
        }
      }
    }
  }
  return out
}

/**
 * The field shapes given their stored form, or a union's tagged struct: 1.39.0 returned the value
 * `create` was given decoded, and couldn't update most of them.
 */
export const createResultFieldShapes = (): Record<string, () => Shape> =>
  fieldShapes((wrapper) => ({
    wire: { a: "x" },
    ...(wrapper.startsWith("union") ? { "the tagged struct": { kind: "own", line: "KEEP" } } : {}),
  }))

/**
 * A `many` edge's elements, in a union whose other member renames a field (`line` stored, `text`
 * held), given the wrapping member whole or the other member's stored form. 1.39.0 stored the
 * latter as `create` decoded it, `text` and all, and couldn't read it back.
 */
export const renameShapes = (): Record<string, () => Shape> => {
  const build = manyShape(DynamoSchema.make({ name: "ren", version: 1 }))
  const copy = SchemaGetter.transform((x: object) => ({ ...x }))
  const rename = {
    decode: SchemaGetter.transform(({ line, ...rest }: any) => ({ ...rest, text: line })),
    encode: SchemaGetter.transform(({ text, ...rest }: any) => ({ ...rest, line: text })),
  }
  const ref = (Line: Schema.Top) =>
    Schema.Struct({ kind: Schema.Literal("ref"), qty: Schema.Number, line: Line })
  const members: Record<string, (Line: Schema.Top) => Schema.Top> = {
    "wrapping member to Unknown": (Line) =>
      (ref(Line) as any).pipe(
        Schema.decodeTo(Schema.Unknown, { decode: copy, encode: copy } as never),
      ),
    "wrapping member untransformed": ref,
  }
  const own = () =>
    Schema.Struct({ kind: Schema.Literal("own"), qty: Schema.Number, line: Schema.String })
  const others: Record<string, () => Schema.Top> = {
    "renaming to Unknown": () =>
      (own() as any).pipe(Schema.decodeTo(Schema.Unknown, rename as never)),
    "renaming to a declaration": () =>
      (own() as any).pipe(
        Schema.decodeTo(
          Schema.declare(
            (x: unknown): x is { readonly text: string } =>
              typeof x === "object" && x !== null && typeof (x as any).text === "string",
          ),
          rename as never,
        ),
      ),
  }
  const values: Record<string, unknown> = {
    "its stored form": { kind: "own", qty: 3, line: "KEEP" },
    "the wrapping member whole": { kind: "ref", qty: 2, line: { id: "L", f: 7 } },
  }
  const out: Record<string, () => Shape> = {}
  for (const sub of [false, true]) {
    for (const [member, other, value] of [
      ["wrapping member to Unknown", "renaming to Unknown", "its stored form"],
      ["wrapping member untransformed", "renaming to Unknown", "its stored form"],
      ["wrapping member to Unknown", "renaming to Unknown", "the wrapping member whole"],
      ["wrapping member to Unknown", "renaming to a declaration", "the wrapping member whole"],
    ] as const) {
      out[`${sub ? "sub-aggregate, " : ""}${member}, other member ${other}, given ${value}`] =
        build(
          (Line) =>
            Schema.Union([
              members[member]!(Line),
              others[other]!(),
            ] as never) as unknown as Schema.Top,
          values[value],
          sub,
        )
    }
  }
  return out
}

/** Where a shape runs: the client layer, and what it sent and holds. */
export type Place = {
  readonly layer: any
  readonly tableName: string
  /** The requests sent since the last call, and forget them: the operation and its input. */
  readonly take: () => ReadonlyArray<{ readonly op: string; readonly input: unknown }>
  readonly rows: () => Effect.Effect<ReadonlyArray<unknown>>
}

/** Runs a shape as the generator did and reports it in the fixture's form. */
export const runShape = (define: () => Shape, place: Place) =>
  Effect.gen(function* () {
    const shape = define()
    const Base = Table.make({ schema: shape.schema, entities: shape.entities } as never) as any
    const A = shape.make(Base)
    const Tb = { ...Base, aggregates: { A } }
    const run = <X, E>(effect: Effect.Effect<X, E, any>) =>
      effect.pipe(
        Effect.provide(Base.layer({ name: place.tableName })),
        Effect.provide(place.layer),
      ) as Effect.Effect<X, E, never>
    const edb: any = yield* run(
      DynamoClient.make({ entities: shape.entities, tables: { Base } } as never),
    )
    for (const [member, item] of shape.seed) yield* run(edb.entities[member].put(item).asEffect())
    const db: any = yield* run(
      DynamoClient.make({ entities: {}, aggregates: { A }, tables: { Tb } } as never),
    )
    place.take()
    const create = outcome(yield* Effect.exit(run(db.aggregates.A.create(shape.input))))
    const requests = place.take()
    const rows = yield* place.rows()
    const get = outcome(yield* Effect.exit(run(db.aggregates.A.get({ id: "a" }))))
    place.take()
    const update = outcome(
      yield* Effect.exit(run(db.aggregates.A.update({ id: "a" }, shape.update))),
    )
    const updateRequests = place.take()
    const updateRows = yield* place.rows()
    const getAfterUpdate = outcome(yield* Effect.exit(run(db.aggregates.A.get({ id: "a" }))))
    return {
      make: "ok",
      create,
      requests,
      rows,
      get,
      update,
      updateRequests,
      updateRows,
      getAfterUpdate,
    } satisfies Recorded
  })

/** An outcome as the test compares it: a value as JSON text (key order too), a failure by its tag. */
export const judged = (result: Outcome) =>
  result.ok !== undefined || !("failed" in result || "died" in result)
    ? { ok: JSON.stringify(result.ok) }
    : { failed: result.failed, died: result.died, operation: result.operation }

/** `rows` after an update setting the root's `title` to "t2". */
const retitled = (rows: ReadonlyArray<unknown>) =>
  rows.map((row: any) => (row.title === undefined ? row : { ...row, title: { S: "t2" } }))

/**
 * A `createResultFieldShapes` or `renameShapes` run against what 1.39.0 did
 * (`fixtures/aggregate-create-result-1.39.0.json`). `create`, its requests and rows, and `get` are
 * 1.39.0's, and so is the update where 1.39.0's went through. Where 1.39.0 refused the update, it
 * goes through and sets the title. A renaming member given its stored form reads back, where 1.39.0
 * couldn't, with the row's attributes in their stored order. A sub-aggregate's discriminator is
 * stored beside the element and stays out of it on a read (#241); 1.40.0 handed it back inside.
 */
export const compareCreateResult = (
  group: "fields" | "renames",
  label: string,
  actual: Recorded,
  expected: Recorded,
) => {
  const as139 = (step: "create" | "get" | "update" | "getAfterUpdate") =>
    expect({ step, ...judged(actual[step]) }).toEqual({ step, ...judged(expected[step]) })
  as139("create")
  expect(actual.requests).toEqual(expected.requests)
  expect(actual.rows).toEqual(expected.rows)
  if (group === "renames" && label.endsWith("given its stored form")) {
    expect(actual.updateRequests).toEqual(expected.updateRequests)
    expect(actual.updateRows).toEqual(expected.updateRows)
    const element = { kind: "own", qty: 3, text: "KEEP" }
    const read = label.startsWith("sub-aggregate, ")
      ? { id: "a", part: { lines: [element] } }
      : { id: "a", lines: [element] }
    for (const step of ["get", "update", "getAfterUpdate"] as const) {
      expect({ step, failed: expected[step].failed }).toEqual({ step, failed: "ValidationError" })
      expect({ step, ok: actual[step].ok }).toEqual({ step, ok: read })
    }
    return
  }
  as139("get")
  if (expected.update.ok !== undefined) {
    as139("update")
    as139("getAfterUpdate")
    expect(actual.updateRequests).toEqual(expected.updateRequests)
    expect(actual.updateRows).toEqual(expected.updateRows)
    return
  }
  const after = { ok: { ...(expected.get.ok as object), title: "t2" } }
  for (const step of ["update", "getAfterUpdate"] as const) {
    expect({ step, ...judged(actual[step]) }).toEqual({ step, ...judged(after) })
  }
  expect(actual.updateRequests.slice(0, expected.updateRequests.length)).toEqual(
    expected.updateRequests,
  )
  expect(actual.updateRows).toEqual(retitled(expected.rows))
}
