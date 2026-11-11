/**
 * An aggregate keyed by a codec `encode` takes on its own output keeps 1.39.0's keys. Only its own
 * operations compose them, each from the value it holds, so nothing missed what 1.39.0 wrote and
 * no row moves (`text139` in `Aggregate.ts`). `fixtures/aggregate-codec-keys-1.39.0.json` holds what
 * published 1.39.0 sent, stored and returned on DynamoDB Local for a root composite and `many` edge
 * sort-key composites of a prefix codec and of `Schema.StringFromBase64`, a sub-aggregate's edge
 * among them, under `escapeKeys` off and on: `create`, `get`, `update`, `get`, `delete`, `get`.
 * Each step here sends those requests, leaves those rows and returns that result.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema, SchemaGetter, SchemaIssue } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>
type Step = {
  readonly result: unknown
  readonly requests: ReadonlyArray<{ readonly op: string; readonly input: unknown }>
  readonly rows: ReadonlyArray<Row>
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-codec-keys-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly shapes: Record<"prefix" | "base64", Record<"off" | "on", Record<string, Step>>>
}

/** A prefix codec: `"Mi X"` is stored `"x:Mi X"`, and only a stored text decodes. */
const Prefixed = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformEffect((s: string) =>
      s.startsWith("x:")
        ? Effect.succeed(s.slice(2))
        : Effect.fail(new SchemaIssue.InvalidValue({ message: "not stored text" }, s)),
    ),
    encode: SchemaGetter.transform((s: string) => `x:${s}`),
  }),
)

const codecs = { prefix: Prefixed, base64: Schema.StringFromBase64 } as const

/** A value as the fixture's generator wrote it: JSON. */
const json = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v)) ?? "null")

const outcome = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return { ok: json(exit.value) }
  const error = Cause.squash(exit.cause) as { readonly _tag?: string; readonly message?: string }
  return {
    [Cause.hasDies(exit.cause) ? "died" : "failed"]: error?._tag ?? "Error",
    message: String(error?.message ?? error).slice(0, 300),
  }
}

/** The rows, in key order, as the generator scanned them. */
const sorted = (rows: Iterable<Row>) =>
  json([...rows].sort((a, b) => `${a.pk?.S}|${a.sk?.S}`.localeCompare(`${b.pk?.S}|${b.sk?.S}`)))

const run = (codec: keyof typeof codecs, setting: "off" | "on") =>
  Effect.gen(function* () {
    const Code = codecs[codec]
    const Line = Schema.Struct({ code: Code, qty: Schema.Number })
    const Part = Schema.Struct({ label: Schema.String, lines: Schema.Array(Line) })
    const Sheet = Schema.Struct({
      sheetId: Code,
      title: Schema.String,
      lines: Schema.Array(Line),
      part: Part,
    })
    const schema = DynamoSchema.make({ name: "aggcodec", version: 1, escapeKeys: setting === "on" })
    const Base = Table.make({ schema, entities: {} })
    const lineEdge = (entityType: string) =>
      Aggregate.many({ entityType, sk: { composite: ["code"] } } as never)
    const PartAgg = (Aggregate.make as any)(Part, {
      root: { entityType: "Part" },
      edges: { lines: lineEdge("PartLine") },
    })
    const A = (Aggregate.make as any)(Sheet, {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["sheetId"] },
      collection: { name: "sheet" },
      root: { entityType: "Sheet" },
      edges: { lines: lineEdge("SheetLine"), part: PartAgg.with({ discriminator: { side: 1 } }) },
    })
    const table = makeRecordingTable()
    const provide = <X, E>(effect: Effect.Effect<X, E, any>) =>
      effect.pipe(
        Effect.provide(Base.layer({ name: "<table>" })),
        Effect.provide(table.layer),
      ) as Effect.Effect<X, E, never>
    const db: any = yield* provide(
      DynamoClient.make({
        entities: {},
        aggregates: { A },
        tables: { Tb: { ...Base, aggregates: { A } } },
      } as never),
    )
    const step = (effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.gen(function* () {
        table.take()
        const result = outcome(yield* Effect.exit(effect))
        const requests = table.take().map(({ command, input }) => ({
          op: command.charAt(0).toLowerCase() + command.slice(1),
          input: json(input),
        }))
        return { result, requests, rows: sorted(table.items.values()) }
      })
    const key = { sheetId: "Mi X" }
    return {
      create: yield* step(
        db.aggregates.A.create({
          sheetId: "Mi X",
          title: "t1",
          lines: [
            { code: "C 1", qty: 1 },
            { code: "C 2", qty: 2 },
          ],
          part: { label: "p", lines: [{ code: "D 1", qty: 3 }] },
        }),
      ),
      get: yield* step(db.aggregates.A.get(key)),
      update: yield* step(
        db.aggregates.A.update(key, ({ state }: { state: any }) => ({
          ...state,
          title: "t2",
          lines: [
            ...state.lines.filter((line: { code: string }) => line.code !== "C 1"),
            { code: "C 3", qty: 9 },
          ],
        })),
      ),
      "get after update": yield* step(db.aggregates.A.get(key)),
      delete: yield* step(db.aggregates.A.delete(key)),
      "get after delete": yield* step(db.aggregates.A.get(key)),
    } as Record<string, Step>
  })

describe("an aggregate keyed by a codec encode takes on its own output keeps 1.39.0's keys", () => {
  it("the fixture is published 1.39.0's", () => {
    expect(fixture.generatedFrom).toBe("effect-dynamodb@1.39.0")
  })

  for (const codec of ["prefix", "base64"] as const) {
    for (const setting of ["off", "on"] as const) {
      it.effect(
        `${codec}, escapeKeys ${setting}: each step sends, stores and returns what 1.39.0 did`,
        () =>
          Effect.gen(function* () {
            const steps = yield* run(codec, setting)
            const expected = fixture.shapes[codec][setting]
            expect(Object.keys(steps)).toEqual(Object.keys(expected))
            for (const [name, step] of Object.entries(expected)) {
              expect({ name, ...steps[name] }).toEqual({ name, ...step })
            }
          }),
      )
    }
  }
})
