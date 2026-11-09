/**
 * The declarations and the rows published 1.39.0 stored (`fixtures/read-back-keys-1.39.0.json`)
 * that `RekeyExactKinds`, `AggregateDottedKeyJudge`, `AggregateRootKeyReadBack` and
 * `HistoryWhereOperand` run against a recording table, and `connected.read-back-keys` against
 * DynamoDB Local. The rule they hold: the key written is the key composed again from the row as it
 * reads back.
 */

import { readFileSync } from "node:fs"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Option, Schema, SchemaGetter } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"

export type Row = Record<string, any> & {
  readonly pk: { readonly S: string }
  readonly sk: { readonly S: string }
}

const fixture = (
  JSON.parse(
    readFileSync(new URL("../fixtures/read-back-keys-1.39.0.json", import.meta.url), "utf8"),
  ) as {
    readonly rows: {
      readonly exactKinds: ReadonlyArray<Row>
      readonly dottedParent: Record<string, ReadonlyArray<Row>>
      readonly rootKeys: ReadonlyArray<Row>
      readonly history: ReadonlyArray<Row>
    }
  }
).rows

/** Rows sorted by key. */
export const byKey = (rows: ReadonlyArray<Row>): Array<Row> =>
  [...rows].sort((a, b) => `${a.pk.S}|${a.sk.S}`.localeCompare(`${b.pk.S}|${b.sk.S}`))

/** A number stored divided by ten. */
export const x10 = Schema.Number.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((n: number) => n * 10),
    encode: SchemaGetter.transform((n: number) => n / 10),
  }),
)

// --- A number the declared kind can't hold exactly -------------------------------------------

/** Items keyed by `bigint`s past 2^53 and fractions, declared `Union([Number, BigInt])`. */
export const exactKindRows = fixture.exactKinds

/** The fixture's entity, its key composite declared `Kind`. */
export const exactKindDefinitions = (Kind: Schema.Top) => {
  // The fixture was stored with `escapeKeys` off, the default.
  const schema = DynamoSchema.make({ name: "exact", version: 1, escapeKeys: false })
  const E = Entity.make({
    model: Schema.Struct({ id: Schema.String, n: Kind, note: Schema.String }),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["n"] } },
    unique: { byN: ["n"] },
  } as never) as any
  const Main = Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}

/** The ids of the fixture's items: `bigint`s past 2^53, and fractions. */
export const unsafeIds = ["b53", "b53p1", "nb53p1", "b60p1"] as const
export const fractionIds = ["f15", "fm15"] as const

/** Each declaration, the items whose value it can't hold, and the items it reads. */
export const exactKindCases = [
  {
    name: "Schema.Number",
    Kind: Schema.Number,
    kind: "number",
    refused: unsafeIds,
    read: fractionIds,
  },
  {
    name: "Schema.BigInt",
    Kind: Schema.BigInt,
    kind: "bigint",
    refused: fractionIds,
    read: unsafeIds,
  },
] as const

/** The fixture's row for item `id`. */
export const itemRow = (id: string): Row =>
  exactKindRows.find((row) => row.pk.S === `$exact#v1#e#id_${id}`)!

/** What a run reports for an item no key composes from: its key, and the refusal. */
export const refusedConflicts = (ids: ReadonlyArray<string>, kind: string) =>
  [...ids]
    .sort((a, b) => itemRow(a).pk.S.localeCompare(itemRow(b).pk.S))
    .map((id) =>
      expect.objectContaining({
        member: "E",
        kind: "item",
        reason: "uncomposable",
        key: { pk: itemRow(id).pk.S, sk: itemRow(id).sk.S },
        message: expect.stringContaining(`is a value no ${kind} holds exactly`),
      }),
    )

/** A run's conflicts in key order. */
export const conflictsByKey = <C extends { readonly key: { readonly pk: string } }>(
  conflicts: ReadonlyArray<C>,
) => [...conflicts].sort((a, b) => a.key.pk.localeCompare(b.key.pk))

// --- A dotted edge key under a transformed parent --------------------------------------------

/** The edge rows 1.39.0 stored, per shape (`required flat` … `optional deep`). */
export const dottedParentRows = fixture.dottedParent

/** `{ n }` stored as a `bigint` and decoded to a number. */
export const toNumber = Schema.Struct({ n: Schema.Unknown }).pipe(
  Schema.decodeTo(Schema.Struct({ n: Schema.Unknown }), {
    decode: SchemaGetter.transform((x: any) => ({ n: Number(x.n) })),
    encode: SchemaGetter.transform((x: any) => ({ n: BigInt(x.n) })),
  }),
)
/** `{ n }` stored as given and decoded as it comes back. */
export const asGiven = Schema.Struct({ n: Schema.Unknown }).pipe(
  Schema.decodeTo(Schema.Struct({ n: Schema.Unknown }), {
    decode: SchemaGetter.transform((x: any) => ({ n: x.n })),
    encode: SchemaGetter.transform((x: any) => ({ n: x.n })),
  }),
)

export const dottedShapes = [false, true].flatMap((optional) =>
  [false, true].map((deep) => ({
    optional,
    deep,
    shape: `${optional ? "optional" : "required"} ${deep ? "deep" : "flat"}`,
    path: deep ? "nested.child.n" : "nested.n",
    value: deep ? { child: { n: 5 } } : { n: 5 },
    held: deep ? { child: { n: 5n } } : { n: 5n },
  })),
)

/** An aggregate whose `many` edge is keyed by `nested.n` (or `nested.child.n`) under `parent`. */
export const dottedDefinitions = (parent: Schema.Top, optional: boolean, deep: boolean) => {
  const schema = DynamoSchema.make({ name: "parent", version: 1, escapeKeys: false })
  const Main = Table.make({ schema, entities: {} } as never) as any
  const field = deep ? Schema.Struct({ child: parent }) : parent
  const nested = optional ? Schema.optional(field) : field
  const Roots = (Aggregate.make as any)(
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
        lines: Aggregate.many({
          entityType: "Line",
          sk: { composite: [deep ? "nested.child.n" : "nested.n"] },
        }),
      },
    },
  )
  return { Main, Roots }
}

// --- An aggregate's partition key composed from its stored root -------------------------------

/** The roots 1.39.0 stored keyed by `Option(x10)` and `x10`. */
export const rootKeyRows = fixture.rootKeys

export const rootKeyShapes = [
  { name: "optionx10", Kind: Schema.Option(x10), n: Option.some(50), text: "some(50)" },
  {
    name: "optionbfs",
    Kind: Schema.Option(Schema.BigIntFromString),
    n: Option.some(5n),
    text: "some(5n)",
  },
  { name: "x10", Kind: x10, n: 50, text: "0000000000000005" },
] as const

/** The list index the root key aggregates use. */
export const rootKeyIndexes = { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } as const

export const rootKeyDefinitions = (name: string, Kind: Schema.Top, escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name, version: 1, escapeKeys })
  const Main = Table.make({ schema, entities: {} } as never) as any
  const Roots = (Aggregate.make as any)(
    Schema.Struct({ id: Schema.String, n: Kind, note: Schema.String }),
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id", "n"] },
      collection: { name: "roots" },
      root: { entityType: "Root" },
      edges: {},
      list: {
        index: "gsi1",
        name: "rootlist",
        pk: { field: "gsi1pk", composite: [] },
        sk: { field: "gsi1sk", composite: ["id"] },
      },
    },
  )
  return { Main, Roots }
}

// --- History bounds on a time-series orderBy --------------------------------------------------

/** Each declared `orderBy`, and the values appended, in order. */
export const historyShapes = [
  { name: "nfs", Kind: Schema.NumberFromString, values: [9, 10] },
  { name: "bfs", Kind: Schema.BigIntFromString, values: [9n, 10n] },
  { name: "x10", Kind: x10, values: [90, 100] },
  { name: "optbfs", Kind: Schema.Option(Schema.BigIntFromString), values: [Option.some(5n)] },
  { name: "optx10", Kind: Schema.Option(x10), values: [Option.some(50)] },
] as const

/** The schema name the fixture stored a shape under. */
export const historySchemaName = (name: string, escapeKeys: boolean) =>
  `h${name}${escapeKeys ? "e" : ""}`

/** The fixture's rows for a shape, its event key prefix, and its event rows in append order. */
export const historyRows = (name: string, escapeKeys: boolean) => {
  const schemaName = historySchemaName(name, escapeKeys)
  const pk = `$${schemaName}#v1#e#id_x`
  const prefix = `$${schemaName}#v1#e#e#`
  const rows = fixture.history.filter((row) => row.pk.S === pk)
  // Appended in ascending order, each stored as a number or a string holding one.
  const events = rows
    .filter((row) => row.sk.S.startsWith(prefix))
    .sort((a, b) => Number(a.n.S ?? a.n.N) - Number(b.n.S ?? b.n.N))
  return { rows, prefix, events }
}

export const historyDefinitions = (name: string, Kind: Schema.Top, escapeKeys: boolean) => {
  const schema = DynamoSchema.make({
    name: historySchemaName(name, escapeKeys),
    version: 1,
    escapeKeys,
  })
  const model = Schema.Struct({ id: Schema.String, n: Kind })
  const E = Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    timeSeries: { orderBy: "n", appendInput: model },
  } as never) as any
  const Main = Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}
