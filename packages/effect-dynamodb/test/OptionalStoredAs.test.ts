/**
 * The storage `DynamoModel.configure` gives a date (`storedAs`) beneath an optional or nullable
 * wrapper, on a recording table: the wrapper is kept as declared and the date is stored in the
 * configured form, one case per wrapper. Up to 1.41.0 a `Schema.optionalKey` date became required
 * (a `put` leaving it out failed), and the storage was left unapplied to a `Schema.optional` date
 * and the date of a `Schema.optionalKey(Schema.NullOr(…))`, which were stored as ISO text. A model
 * that doesn't put the two together sends what 1.41.0 sent, and a date a key is composed from keeps
 * its stored form and key text. The suite is `helpers/OptionalStoredAs.ts`; connected twin:
 * `connected.optional-stored-as.test.ts`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Equal, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { type Harness, INDEXES } from "./helpers/EntityRefKeys.js"
import { suite } from "./helpers/OptionalStoredAs.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tables = new Map<string, ReturnType<typeof makeRecordingTable>>()
let made = 0

const harness: Harness = {
  onTable: (body) => {
    const tableName = `optional-stored-as-${made++}`
    tables.set(tableName, makeRecordingTable({ indexes: INDEXES }))
    return body(tableName) as Effect.Effect<any, unknown>
  },
  provide: (tableName, main, effect) =>
    effect.pipe(
      Effect.provide(Layer.merge(tables.get(tableName)!.layer, main.layer({ name: tableName }))),
    ) as Effect.Effect<any, any>,
  rows: (tableName) => Effect.sync(() => [...tables.get(tableName)!.items.values()] as never),
  requests: (tableName) =>
    Effect.sync(() =>
      tables
        .get(tableName)!
        .take()
        .map(({ command, input }) => ({
          command,
          input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
        })),
    ),
}

suite(harness)

const schema = DynamoSchema.make({ name: "optstored", version: 1 })
const ON = "2001-02-03T04:05:06.000Z"
const LATER = "2002-03-04T05:06:07.000Z"
const SECONDS = { N: "981173106" }
const prefix = "$optstored#v1#row"

/**
 * An entity of `fields` (beside `id`) configured with `configure`, on a recording table: its client,
 * a step running an op with the requests it sent, and the table.
 */
const rows = (
  fields: Record<string, Schema.Top>,
  configure: Record<string, unknown>,
  options: Record<string, unknown> = {},
) => {
  const Rows: any = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({ id: Schema.String, ...fields }) as any,
      configure as never,
    ),
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...options,
  } as never)
  const table = makeRecordingTable({ indexes: INDEXES })
  const Main = Table.make({ schema, entities: { Rows } } as never) as any
  const layer = Layer.merge(table.layer, Main.layer({ name: "t" }))
  const exec = (op: any): Effect.Effect<any, any> =>
    (typeof op.asEffect === "function" ? op.asEffect() : op).pipe(Effect.provide(layer))
  const R = Effect.runSync(
    exec(DynamoClient.make({ entities: { Rows }, tables: { Main } } as never)),
  ).entities.Rows
  const step = (op: any) => {
    table.take()
    const exit = Effect.runSync(Effect.exit(exec(op)))
    return { exit, sent: table.take().map(({ command, input }) => ({ command, input })) }
  }
  return { R, step, table }
}
const value = (exit: Exit.Exit<any, any>) => {
  if (Exit.isFailure(exit)) throw exit
  return exit.value
}
const stored = (table: ReturnType<typeof makeRecordingTable>, id: string) =>
  table.items.get(`${prefix}#id_${id}|${prefix}`) as Record<string, AttributeValue> | undefined
const same = (a: unknown, b: unknown) => expect(Equal.equals(a, b)).toBe(true)

describe("each wrapper keeps its declaration and stores the date as configured", () => {
  const utc = DateTime.makeUnsafe(ON)
  const date = new Date(ON)
  const E = DynamoModel.DateEpochSeconds
  const cases = [
    { name: "Schema.optionalKey(DateTimeUtc)", f: Schema.optionalKey(Schema.DateTimeUtc) },
    { name: "Schema.optional(DateTimeUtc)", f: Schema.optional(Schema.DateTimeUtc) },
    { name: "Schema.NullOr(DateTimeUtc)", f: Schema.NullOr(Schema.DateTimeUtc), required: true },
    {
      name: "Schema.optionalKey(Schema.NullOr(DateTimeUtc))",
      f: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc)),
    },
    {
      name: "Schema.UndefinedOr(DateTimeUtc)",
      f: Schema.UndefinedOr(Schema.DateTimeUtc),
      required: true,
    },
    { name: "Schema.optionalKey(Date)", f: Schema.optionalKey(Schema.Date), date: true },
    { name: "Schema.optional(Date)", f: Schema.optional(Schema.Date), date: true },
  ]
  for (const each of cases) {
    it(each.name, () => {
      const { R, step, table } = rows(
        { f: each.f },
        { f: { storedAs: each.date ? DynamoModel.UnsafeDateEpochSeconds : E } },
      )
      const given = each.date ? date : utc
      // Given: stored, and read back, as epoch seconds.
      same(value(step(R.put({ id: "b", f: given })).exit).f, given)
      expect(stored(table, "b")!.f).toEqual(SECONDS)
      same(value(step(R.get({ id: "b" })).exit).f, given)
      // Left out where the key is optional, and refused where it's required, as declared.
      const leftOut = step(R.put({ id: "a" }))
      if (each.required) {
        expect(Exit.isFailure(leftOut.exit)).toBe(true)
        expect(leftOut.sent).toEqual([])
      } else {
        expect("f" in value(leftOut.exit)).toBe(false)
        expect("f" in stored(table, "a")!).toBe(false)
      }
      // A null is stored as one.
      if (each.name.includes("NullOr")) {
        expect(value(step(R.put({ id: "n", f: null })).exit).f).toBeNull()
        expect(stored(table, "n")!.f).toEqual({ NULL: true })
      }
      // A row stored before, as ISO text, reads as the date it holds.
      table.items.set(`${prefix}#id_c|${prefix}`, {
        ...stored(table, "b")!,
        id: { S: "c" },
        pk: { S: `${prefix}#id_c` },
        f: { S: ON },
      })
      same(value(step(R.get({ id: "c" })).exit).f, given)
    })
  }
})

describe("a model that doesn't put storedAs and an optional date together sends what 1.41.0 sent", () => {
  const key = { pk: { S: `${prefix}#id_a` }, sk: { S: prefix } }
  for (const [name, fields, configure, form] of [
    [
      "a required date stored as epoch seconds",
      { at: Schema.DateTimeUtc },
      { at: { storedAs: DynamoModel.DateEpochSeconds } },
      (iso: string) => ({ N: String(Date.parse(iso) / 1000) }),
    ],
    [
      "an optional date without storedAs",
      { at: Schema.optional(Schema.DateTimeUtc) },
      {},
      (iso: string) => ({ S: iso }),
    ],
  ] as const) {
    it(name, () => {
      const { R, step } = rows({ ...fields, note: Schema.String }, configure)
      expect(step(R.put({ id: "a", note: "n", at: DateTime.makeUnsafe(ON) })).sent).toEqual([
        {
          command: "PutItem",
          input: {
            TableName: "t",
            Item: {
              id: { S: "a" },
              at: form(ON),
              note: { S: "n" },
              __edd_e__: { S: "Row" },
              ...key,
            },
          },
        },
      ])
      expect(step(R.get({ id: "a" })).sent).toEqual([
        { command: "GetItem", input: { TableName: "t", Key: key } },
      ])
      const updated = step(
        R.update({ id: "a" })
          .set({ at: DateTime.makeUnsafe(LATER) })
          .condition((t: any, { eq }: any) => eq(t.at, DateTime.makeUnsafe(ON))),
      )
      same(value(updated.exit).at, DateTime.makeUnsafe(LATER))
      expect(updated.sent).toEqual([
        {
          command: "UpdateItem",
          input: {
            TableName: "t",
            Key: key,
            UpdateExpression: "SET #u0 = :u0",
            ExpressionAttributeNames: { "#u0": "at", "#e0": "at", "#exists": "pk" },
            ExpressionAttributeValues: { ":u0": form(LATER), ":e1": form(ON) },
            ConditionExpression: "(#e0 = :e1) AND attribute_exists(#exists)",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            ReturnValues: "ALL_NEW",
          },
        },
      ])
    })
  }
})

it("an optional date a key is composed from keeps its stored form and key text", () => {
  // Storing it as configured would move the key of every row holding it: it's held as 1.41.0
  // held it, ISO text.
  const { R, step } = rows(
    { g: Schema.String, at: Schema.optional(Schema.DateTimeUtc) },
    { at: { storedAs: DynamoModel.DateEpochSeconds } },
    {
      indexes: {
        byAt: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["g"] },
          sk: { field: "gsi1sk", composite: ["at"] },
        },
      },
    },
  )
  const put = step(R.put({ id: "a", g: "x", at: DateTime.makeUnsafe(ON) }))
  expect(put.sent).toEqual([
    {
      command: "PutItem",
      input: {
        TableName: "t",
        Item: {
          id: { S: "a" },
          g: { S: "x" },
          at: { S: ON },
          __edd_e__: { S: "Row" },
          pk: { S: `${prefix}#id_a` },
          sk: { S: prefix },
          gsi1pk: { S: `${prefix}#g_x` },
          gsi1sk: { S: `${prefix}#at_2001-02-03t04:05:06.000z` },
        },
      },
    },
  ])
  const found = step(R.byAt({ g: "x", at: DateTime.makeUnsafe(ON) }).collect())
  expect(value(found.exit).map((row: { id: string }) => row.id)).toEqual(["a"])
})

it("a model's own optional timestamp stored as epoch seconds reads back as the date stamped", () => {
  // Up to 1.41.0 a `Schema.optional` one was read as epoch milliseconds: a date in January 1970.
  const { R, step, table } = rows(
    {
      note: Schema.String,
      createdAt: Schema.optional(Schema.DateTimeUtc),
      updatedAt: Schema.optional(Schema.DateTimeUtc),
    },
    {
      createdAt: { storedAs: DynamoModel.DateEpochSeconds },
      updatedAt: { storedAs: DynamoModel.DateEpochSeconds },
    },
    { timestamps: true },
  )
  const before = Math.floor(Date.now() / 1000)
  value(step(R.put({ id: "a", note: "n" })).exit)
  const seconds = Number(stored(table, "a")!.createdAt!.N)
  expect(seconds).toBeGreaterThanOrEqual(before)
  const read = value(step(R.get({ id: "a" })).exit)
  expect(DateTime.toEpochMillis(read.createdAt)).toBe(seconds * 1000)
})
