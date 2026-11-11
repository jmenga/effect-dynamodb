/**
 * A key written must be the key composed again from the row as it reads back: the scenarios, over
 * the rows published 1.39.0 stored (`fixtures/key-read-back-1.39.0.json`), for the unit test on a
 * recording table (`KeyReadBack.test.ts`) and its connected twin (`connected.key-read-back.test.ts`).
 * Each scenario has its own schema name, and its table holds that schema's fixture rows.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, type Layer, Schema, SchemaGetter } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"

export type Row = Record<string, AttributeValue>

/** What published 1.39.0 stored, from its own `put` and `append`. */
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/key-read-back-1.39.0.json", import.meta.url), "utf8"),
) as { readonly generatedFrom: string; readonly rows: ReadonlyArray<Row> }

/** The fixture's rows of one schema name. */
export const rowsOf = (name: string): ReadonlyArray<Row> =>
  fixture.rows.filter((row) => row.pk?.S?.startsWith(`$${name}#`))

/** A table holding a scenario's rows. */
export interface KeyReadBackTable {
  readonly name: string
  readonly layer: Layer.Layer<DynamoClient>
  readonly rows: Effect.Effect<ReadonlyArray<Row>>
  readonly close: Effect.Effect<void>
}

export type OpenTable = (seed: ReadonlyArray<Row>) => Effect.Effect<KeyReadBackTable>

/** A row's key, for comparing tables. */
const keyOf = (row: Row) => `${row.pk?.S}|${row.sk?.S}`
const keysOf = (rows: ReadonlyArray<Row>) => rows.map(keyOf).sort()

const Both = Schema.Union([Schema.Number, Schema.BigInt])

type Definitions = {
  readonly entities: Record<string, any>
  readonly aggregates?:
    | ((Main: any, schema: DynamoSchema.DynamoSchema) => Record<string, any>)
    | undefined
}

/**
 * Run `body` against a client over `define`'s members under the schema `name`, on a table holding
 * `seed` (the fixture's rows of that name, unless given).
 */
const on = <A>(
  open: OpenTable,
  options: {
    readonly name: string
    readonly escapeKeys?: boolean
    readonly seed?: ReadonlyArray<Row>
  },
  define: (schema: DynamoSchema.DynamoSchema) => Definitions,
  body: (db: any, table: KeyReadBackTable) => Effect.Effect<A, unknown, any>,
): Effect.Effect<A, unknown> =>
  Effect.acquireUseRelease(
    open(options.seed ?? rowsOf(options.name)),
    (table) => {
      const schema = DynamoSchema.make({
        name: options.name,
        version: 1,
        escapeKeys: options.escapeKeys ?? false,
      })
      const { entities, aggregates } = define(schema)
      const Main = Table.make({ schema, entities })
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities,
          aggregates: aggregates?.(Main, schema) ?? {},
          tables: { Main },
        } as never) as Effect.Effect<any, never, any>
        return yield* body(db, table)
      }).pipe(
        Effect.provide(Main.layer({ name: table.name })),
        Effect.provide(table.layer),
      ) as Effect.Effect<A, unknown>
    },
    (table) => table.close,
  )

/** `Schema.Struct({ n: encoded })` decoded to `Schema.Struct({ n: decoded })` with `Number`. */
const nestedOf = (encoded: Schema.Top, decoded: Schema.Top) =>
  Schema.Struct({ n: encoded }).pipe(
    Schema.decodeTo(Schema.Struct({ n: decoded }), {
      decode: SchemaGetter.transform((x: any) => ({ n: Number(x.n) })),
      encode: SchemaGetter.transform((x: any) => ({ n: x.n })),
    }),
  ) as Schema.Top

/** An aggregate whose `many` edge is keyed by `nested.n`, a path into a transformed struct. */
export const nestedKeyAggregate = (
  Main: any,
  schema: DynamoSchema.DynamoSchema,
  nested: Schema.Top,
) =>
  Aggregate.make(
    Schema.Struct({
      id: Schema.String,
      lines: Schema.Array(Schema.Struct({ nested, note: Schema.String })),
    }),
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "roots" },
      root: { entityType: "Root" },
      edges: {
        lines: Aggregate.many({ entityType: "Line", sk: { composite: ["nested.n"] } }),
      },
    } as never,
  )

/** The two transformed structs of {@link nestedOf}: the one storing a number, the one storing both. */
export const storesNumber = nestedOf(Schema.Number, Both)
export const storesBoth = nestedOf(Both, Schema.Number)

/** The scenarios, each a test against a table `open` makes. */
export const keyReadBackSuite = (open: OpenTable) => {
  it.effect(
    "a composite in both halves of a key, stored by 1.39.0 as a bigint, moves to number text",
    () =>
      on(
        open,
        { name: "repeat" },
        () => ({
          entities: {
            E: Entity.make({
              model: Schema.Struct({ a: Schema.Number, b: Schema.Number, note: Schema.String }),
              entityType: "E",
              primaryKey: {
                pk: { field: "pk", composite: ["a", "b"] },
                sk: { field: "sk", composite: ["a", "b"] },
              },
            }),
          },
        }),
        (db, table) =>
          Effect.gen(function* () {
            const report = yield* db.tables.Main.rekey()
            expect(report.skipped.unrecognizedKey).toBe(0)
            expect(report.moved.item).toBe(1)
            expect(report.conflicts).toEqual([])
            const n = (value: number) => String(value).padStart(16, "0")
            expect(keysOf(yield* table.rows)).toEqual([
              `$repeat#v1#e#a_${n(3)}#b_${n(5)}|$repeat#v1#e#a_${n(3)}#b_${n(5)}`,
            ])
            expect((yield* db.entities.E.get({ a: 3, b: 5 })).note).toBe("preserve")
            // A second run finds every row where it belongs.
            const again = yield* db.tables.Main.rekey()
            expect(again.moved.item).toBe(0)
            expect(again.skipped.unrecognizedKey).toBe(0)
          }),
      ),
  )

  it.effect(
    "a key path into a struct stored as a number and decoded to both kinds loads and round-trips",
    () =>
      on(
        open,
        { name: "nested", seed: [] },
        () => ({
          entities: {},
          aggregates: (Main, schema) => ({ Roots: nestedKeyAggregate(Main, schema, storesNumber) }),
        }),
        (db, table) =>
          Effect.gen(function* () {
            yield* db.aggregates.Roots.create({
              id: "x",
              lines: [{ nested: { n: 5 }, note: "before" }],
            })
            yield* db.aggregates.Roots.update({ id: "x" }, ({ state }: any) => ({
              ...state,
              lines: state.lines.map((line: any) => ({ ...line, note: "after" })),
            }))
            const got = yield* db.aggregates.Roots.get({ id: "x" })
            expect(got.lines).toEqual([{ nested: { n: 5 }, note: "after" }])
            expect(keysOf(yield* table.rows)).toEqual([
              `$nested#v1#roots#x|$nested#v1#line#${String(5).padStart(16, "0")}`,
              "$nested#v1#roots#x|$nested#v1#root",
            ])
          }),
      ),
  )
}
