/**
 * When a field's decoding default runs. Published 1.39.0 ran it only to read a row without the
 * field: never to define or bind an entity, once per such row read. Defining an entity decides
 * how each field's absence is judged from its schema and runs nothing, so it stays that way; the
 * schema package's `LackDecision.test.ts` has the matrix of shapes.
 */
import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const clearOutcomes139 = JSON.parse(
  readFileSync(new URL("./fixtures/clear-outcomes-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly outcomes: ReadonlyArray<{
    readonly case: string
    readonly clear: string
    readonly rowHoldsFieldAfter: boolean
    readonly readAfter: string
    readonly fieldReadAfter?: string
  }>
  readonly sites: Record<string, Record<string, object>>
}

const schema = DynamoSchema.make({ name: "app", version: 1 })
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}

describe("a field's decoding default", () => {
  for (const [label, configure] of [
    ["a plain model", (model: Schema.Top) => model],
    [
      "a configured model, the field renamed",
      (model: Schema.Top) =>
        DynamoModel.configure(model as never, { p: { field: "stored_p" } } as never),
    ],
  ] as const) {
    it.effect(
      `${label}: runs at no definition or bind, and once per read of a row without it`,
      () =>
        Effect.gen(function* () {
          const calls = { count: 0 }
          const Raw = Entity.make({
            model: Schema.Struct({ id: Schema.String, n: Schema.Number }),
            entityType: "Row",
            primaryKey,
          } as never) as any
          const Read = Entity.make({
            model: configure(
              Schema.Struct({
                id: Schema.String,
                n: Schema.Number,
                p: Schema.String.pipe(
                  Schema.withDecodingDefaultKey(
                    Effect.sync(() => {
                      calls.count++
                      return "default"
                    }),
                  ),
                ),
              }),
            ),
            entityType: "Row",
            primaryKey,
          } as never) as any
          expect(calls.count).toBe(0)
          const Main = Table.make({ schema, entities: { Raw, Read } } as never) as any
          const table = makeRecordingTable()
          yield* Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: { Raw, Read },
              tables: { Main },
            } as never)
            expect(calls.count).toBe(0)
            yield* db.entities.Raw.put({ id: "a", n: 1 }).asEffect()
            expect(calls.count).toBe(0)

            expect((yield* db.entities.Read.get({ id: "a" })).p).toBe("default")
            expect(calls.count).toBe(1)
            yield* db.entities.Read.get({ id: "a" })
            expect(calls.count).toBe(2)

            // Judging an update's fields runs nothing either: a row holding the field reads it.
            yield* db.entities.Read.update({ id: "a" }).set({ p: "given" }).asEffect()
            expect((yield* db.entities.Read.get({ id: "a" })).p).toBe("given")
            expect(calls.count).toBe(2)
          }).pipe(
            Effect.provide(Main.layer({ name: "t" })),
            Effect.provide(table.layer),
          ) as Effect.Effect<void>
        }),
    )
  }
})

/**
 * A write that leaves a field out of a row decides whether the row can be read without it:
 * from the field's schema where nothing the model runs takes part, and by reading the absence
 * once, as the next read would, where the model's code does. A row that couldn't be read is
 * refused before any request.
 */
describe("a write that clears a field", () => {
  const counted = () => {
    const calls = { count: 0 }
    return {
      calls,
      default: Effect.sync(() => {
        calls.count++
        return "default"
      }),
      check: Schema.makeFilter(() => {
        calls.count++
        return true
      }),
    }
  }
  const scenario = <A>(
    fields: Record<string, Schema.Top>,
    row: Record<string, unknown>,
    body: (db: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, unknown, any>,
    options: { readonly retain?: boolean } = {},
  ) => {
    const Row = Entity.make({
      model: Schema.Struct({ id: Schema.String, ...fields }),
      entityType: "Row",
      primaryKey,
      ...(options.retain === true ? { versioned: { retain: true } } : {}),
    } as never) as any
    const Main = Table.make({ schema, entities: { Row } } as never) as any
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({ entities: { Row }, tables: { Main } } as never)
      yield* db.entities.Row.put({ id: "a", ...row }).asEffect()
      table.take()
      return yield* body(db, table)
    }).pipe(
      Effect.provide(Main.layer({ name: "t" })),
      Effect.provide(table.layer),
    ) as Effect.Effect<A>
  }

  it.effect("decided by the schema: nothing the model holds runs", () => {
    const { calls, check } = counted()
    return scenario(
      {
        optional: Schema.optional(Schema.String.check(check)),
        note: Schema.UndefinedOr(Schema.String),
        labels: Schema.ReadonlySet(Schema.String),
      },
      { optional: "o", note: "n", labels: new Set(["l"]) },
      (db, table) =>
        Effect.gen(function* () {
          calls.count = 0
          yield* db.entities.Row.update({ id: "a" })
            .remove(["optional", "note", "labels"])
            .asEffect()
          expect(calls.count).toBe(0)
          expect(table.take().map((request) => request.command)).toEqual(["UpdateItem"])
        }),
    )
  })

  for (const [label, clear] of [
    [".remove()", (update: any) => update.remove(["p"])],
    [".set() of undefined", (update: any) => update.set({ p: undefined })],
    ["pathRemove", (update: any) => update.pathRemove(["p"])],
  ] as const) {
    it.effect(`a decoding default is run once by the ${label} that leaves its field out`, () => {
      const { calls, default: fill } = counted()
      return scenario(
        { p: Schema.String.pipe(Schema.withDecodingDefaultKey(fill)) },
        { p: "given" },
        (db, table) =>
          Effect.gen(function* () {
            calls.count = 0
            yield* clear(db.entities.Row.update({ id: "a" }))
              .returnValues("none")
              .asEffect()
            expect(calls.count).toBe(1)
            expect(table.take().map((request) => request.command)).toEqual(["UpdateItem"])
          }),
      )
    })
  }

  it.effect("a check on the value an absent attribute stands for is run once by the clear", () => {
    const { calls, check } = counted()
    return scenario(
      { labels: Schema.ReadonlySet(Schema.String).check(check) },
      { labels: new Set(["l"]) },
      (db, table) =>
        Effect.gen(function* () {
          calls.count = 0
          yield* db.entities.Row.update({ id: "a" })
            .remove(["labels"])
            .returnValues("none")
            .asEffect()
          expect(calls.count).toBe(1)
          expect(table.take().map((request) => request.command)).toEqual(["UpdateItem"])
        }),
    )
  })

  /**
   * What published 1.39.0 did with each (`fixtures/clear-outcomes-1.39.0.json`, from running the
   * same clears with the published packages against DynamoDB Local): it wrote the row without
   * the field, failed to read back what it had written, and no later read could read the row.
   * Only the set to an empty set was refused, by the set's own check.
   */
  const REFUSED: ReadonlyArray<
    readonly [string, Schema.Top, unknown, (update: any) => any, "written" | "refused"]
  > = [
    [
      "a default its own check refuses",
      Schema.String.check(Schema.makeFilter((s: string) => s.length > 5)).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("x")),
      ),
      "long enough",
      (update) => update.remove(["f"]),
      "written",
    ],
    [
      "a default that fails",
      Schema.String.pipe(
        Schema.withDecodingDefaultKey(
          Effect.fail(new SchemaIssue.InvalidValue(undefined)) as unknown as Effect.Effect<string>,
        ),
      ),
      "given",
      (update) => update.remove(["f"]),
      "written",
    ],
    [
      "a step refusing an absent key",
      Schema.optionalKey(Schema.String).pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.required(),
          encode: SchemaGetter.passthrough(),
        } as never),
      ),
      "given",
      (update) => update.remove(["f"]),
      "written",
    ],
    [
      "a step leaving an absent key absent",
      Schema.optionalKey(Schema.String).pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transformOptional((o) => o),
          encode: SchemaGetter.passthrough(),
        } as never),
      ),
      "given",
      (update) => update.remove(["f"]),
      "written",
    ],
    [
      "a middleware failing a missing key",
      Schema.optionalKey(Schema.String).pipe(
        Schema.middlewareDecoding((read) =>
          Effect.flatMap(read, (value) =>
            Option.isNone(value)
              ? Effect.fail(new SchemaIssue.InvalidValue(Option.none() as never))
              : Effect.succeed(value),
          ),
        ),
      ),
      "given",
      (update) => update.remove(["f"]),
      "written",
    ],
    [
      "a set that mustn't be empty, removed",
      Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(1)),
      new Set(["a"]),
      (update) => update.remove(["f"]),
      "written",
    ],
    [
      "a set that mustn't be empty, set to the empty set",
      Schema.ReadonlySet(Schema.String).check(Schema.isMinSize(1)),
      new Set(["a"]),
      (update) => update.set({ f: new Set() }),
      "refused",
    ],
  ]

  for (const [name, field, value, clear, on139] of REFUSED) {
    it.effect(`${name}: refused before any request`, () =>
      scenario({ f: field }, { f: value }, (db, table) =>
        Effect.gen(function* () {
          const before = clearOutcomes139.outcomes.find((outcome) => outcome.case === name)
          expect(before).toEqual(
            on139 === "written"
              ? {
                  case: name,
                  clear: "ValidationError",
                  rowHoldsFieldAfter: false,
                  readAfter: "ValidationError",
                }
              : { case: name, clear: "ValidationError", rowHoldsFieldAfter: true, readAfter: "ok" },
          )

          const refused = yield* Effect.flip(clear(db.entities.Row.update({ id: "a" })).asEffect())
          expect((refused as { readonly _tag: string })._tag).toBe("ValidationError")
          expect(table.take()).toEqual([])
          // The row is as it was, and reads.
          expect((yield* db.entities.Row.get({ id: "a" })).f).toEqual(value)
        }),
      ),
    )
  }

  /**
   * The clears published 1.39.0 was measured on for the shapes below (`sites` in the same
   * fixture), each the label here and the fixture's name for it.
   */
  const SITES: ReadonlyArray<
    readonly [string, string, boolean, (db: any) => Effect.Effect<unknown, unknown, any>]
  > = [
    [".remove()", "remove", false, (db) => db.entities.Row.update({ id: "a" }).remove(["f"])],
    [
      ".set() of undefined",
      "set undefined",
      false,
      (db) => db.entities.Row.update({ id: "a" }).set({ f: undefined }),
    ],
    [
      "pathRemove",
      "pathRemove",
      false,
      (db) => db.entities.Row.update({ id: "a" }).pathRemove(["f"]),
    ],
    ["patch", "patch remove", false, (db) => db.entities.Row.patch({ id: "a" }).remove(["f"])],
    [
      "a retained update",
      "retained remove",
      true,
      (db) => db.entities.Row.update({ id: "a" }).remove(["f"]),
    ],
    [
      "an update in a transaction",
      "transactWrite remove",
      false,
      (db) => Transaction.transactWrite([db.entities.Row.update({ id: "a" }).remove(["f"])]),
    ],
  ]
  const run = (op: any): Effect.Effect<unknown, unknown, any> =>
    typeof op?.asEffect === "function" ? op.asEffect() : op
  const liveRow = (table: ReturnType<typeof makeRecordingTable>) =>
    [...table.items.values()].find((item) => item.sk?.S === "$app#v1#row")!

  /**
   * Fields a row reads without, though nothing in the schema's shape says so, or though the
   * stored side's key is required: only reading the absence, or the read side's key, does.
   * Published 1.39.0 cleared each at every site and read the row back, and so does the head.
   */
  const READS: ReadonlyArray<readonly [string, Schema.Top, string | undefined]> = [
    [
      "a middleware filling a missing key",
      Schema.optionalKey(Schema.String).pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.passthrough(),
        } as never),
        Schema.middlewareDecoding((read) =>
          Effect.map(read, (value) => (Option.isNone(value) ? Option.some("fallback") : value)),
        ),
      ),
      "fallback",
    ],
    [
      "a default inside a suspension",
      Schema.suspend(() => Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("d")))),
      "d",
    ],
    [
      "a step filling a required key",
      Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transformOptional((value: Option.Option<string>) =>
            Option.orElse(value, () => Option.some("filled")),
          ),
          encode: SchemaGetter.passthrough(),
        } as never),
      ),
      "filled",
    ],
    [
      "a middleware filling a required key",
      Schema.String.pipe(
        Schema.middlewareDecoding((read) =>
          Effect.map(read, (value) => (Option.isNone(value) ? Option.some("fallback") : value)),
        ),
      ),
      "fallback",
    ],
    [
      "a stored key read as optional",
      Schema.String.pipe(
        Schema.decodeTo(Schema.optionalKey(Schema.String), {
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.passthrough(),
        } as never),
      ),
      undefined,
    ],
  ]

  for (const [name, field, readsAs] of READS) {
    for (const [site, measured, retain, clear] of SITES) {
      it.effect(`${name}, cleared by ${site}: written, and the row reads back`, () =>
        scenario(
          { f: field },
          { f: "given" },
          (db, table) =>
            Effect.gen(function* () {
              expect(clearOutcomes139.sites[name]?.[measured]).toEqual({
                clear: "ok",
                rowHoldsFieldAfter: false,
                readAfter: "ok",
                fieldReadAfter: readsAs ?? null,
              })
              yield* run(clear(db))
              expect(table.take().filter(({ command }) => command !== "GetItem")).toHaveLength(1)
              expect("f" in liveRow(table)).toBe(false)
              expect((yield* db.entities.Row.get({ id: "a" })).f).toBe(readsAs)
            }),
          { retain },
        ),
      )
    }
  }

  /**
   * The mirror: a middleware failing a missing key. Published 1.39.0 wrote the row without the
   * field at every site (`sites`), and no read could read it after; the release branch refused
   * each before any request, and so does the head.
   */
  const failing = Schema.optionalKey(Schema.String).pipe(
    Schema.middlewareDecoding((read) =>
      Effect.flatMap(read, (value) =>
        Option.isNone(value)
          ? Effect.fail(new SchemaIssue.InvalidValue(Option.none() as never))
          : Effect.succeed(value),
      ),
    ),
  )
  for (const [site, measured, retain, clear] of SITES) {
    it.effect(`a middleware failing a missing key, cleared by ${site}: refused`, () =>
      scenario(
        { f: failing },
        { f: "given" },
        (db, table) =>
          Effect.gen(function* () {
            const before = clearOutcomes139.sites["a middleware failing a missing key"]?.[
              measured
            ] as { readonly rowHoldsFieldAfter: boolean; readonly readAfter: string }
            expect([before.rowHoldsFieldAfter, before.readAfter]).toEqual([
              false,
              "ValidationError",
            ])
            const refused = yield* Effect.flip(run(clear(db)))
            expect((refused as { readonly _tag: string })._tag).toBe("ValidationError")
            expect(table.take().filter(({ command }) => command !== "GetItem")).toEqual([])
            expect((yield* db.entities.Row.get({ id: "a" })).f).toBe("given")
          }),
        { retain },
      ),
    )
  }

  it.effect("a middleware on a missing key runs once for the clear that leaves the key out", () => {
    const calls = { count: 0 }
    const field = Schema.optionalKey(Schema.String).pipe(
      Schema.middlewareDecoding((read) =>
        Effect.map(read, (value) => {
          calls.count++
          return value
        }),
      ),
    )
    return scenario({ f: field }, { f: "given" }, (db) =>
      Effect.gen(function* () {
        calls.count = 0
        yield* db.entities.Row.update({ id: "a" }).remove(["f"]).returnValues("none").asEffect()
        expect(calls.count).toBe(1)
      }),
    )
  })
})

/**
 * A field whose absent attribute stands for a value is read as that value, through the field's own
 * steps. A step that throws on it killed the read, where published 1.39.0 failed on the missing key
 * (`fixtures/history-absent-1.39.0.json`, from the published packages against DynamoDB Local). The
 * read fails that way again; a defect that isn't about a missing field is still a defect.
 */
describe("a read of a row without a field whose absent value its step throws on", () => {
  const history139 = JSON.parse(
    readFileSync(new URL("./fixtures/history-absent-1.39.0.json", import.meta.url), "utf8"),
  ) as {
    readonly history: object
    readonly get: object
    readonly getWithout: object
    readonly deletedGet: object
    readonly deletedList: object
    readonly decodeMarshalledItem: object
  }
  const upper = Schema.Unknown.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((u: unknown) => (u as string).toUpperCase()),
      encode: SchemaGetter.transform((s: string) => s.toLowerCase()),
    } as never),
  )
  const world = (lifecycle: "timeSeries" | "softDelete" = "timeSeries") => {
    const Row = Entity.make({
      model: Schema.Struct({ id: Schema.String, name: Schema.String, n: Schema.Number, f: upper }),
      entityType: "Row",
      primaryKey,
      ...(lifecycle === "timeSeries"
        ? {
            timeSeries: {
              orderBy: "n",
              appendInput: Schema.Struct({
                id: Schema.String,
                n: Schema.Number,
                name: Schema.String,
              }),
            },
          }
        : { softDelete: true }),
    } as never) as any
    const Main = Table.make({ schema, entities: { Row } } as never) as any
    const table = makeRecordingTable()
    const run = <A>(body: (db: any) => Effect.Effect<A, unknown, any>) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Row }, tables: { Main } } as never)
        return yield* body(db)
      }).pipe(
        Effect.provide(Main.layer({ name: "t" })),
        Effect.provide(table.layer),
      ) as Effect.Effect<A>
    return { table, run, Row }
  }
  const describeExit = (exit: Exit.Exit<unknown, unknown>) => {
    if (Exit.isSuccess(exit)) return { outcome: "ok" }
    if (!Exit.hasFails(exit)) return { outcome: "defect" }
    const error = Cause.squash(exit.cause) as {
      readonly _tag: string
      readonly operation: string
      readonly cause: { readonly message: string }
    }
    return { outcome: error._tag, operation: error.operation, message: error.cause.message }
  }

  it.effect("a time-series history over event rows: the missing key, as on 1.39.0", () => {
    const { run } = world()
    return run((db) =>
      Effect.gen(function* () {
        yield* db.entities.Row.put({ id: "a", name: "nm", n: 1, f: "X" }).asEffect()
        yield* db.entities.Row.append({ id: "a", n: 2, name: "nm" }).asEffect()
        const history = yield* Effect.exit(db.entities.Row.history({ id: "a" }).collect())
        expect(history139.history).toEqual({
          outcome: "ValidationError",
          operation: "history.decode",
          message: 'Missing key\n  at ["f"]',
        })
        expect(describeExit(history)).toEqual(history139.history)
        expect(describeExit(yield* Effect.exit(db.entities.Row.get({ id: "a" })))).toEqual(
          history139.get,
        )
      }),
    )
  })

  it.effect("a get of a row stored without the field: the missing key, as on 1.39.0", () => {
    const { run, table } = world()
    return run((db) =>
      Effect.gen(function* () {
        yield* db.entities.Row.put({ id: "a", name: "nm", n: 1, f: "X" }).asEffect()
        const [key, row] = [...table.items.entries()][0]!
        const { f: _f, ...without } = row
        table.items.set(key, without)
        expect(history139.getWithout).toEqual({
          outcome: "ValidationError",
          operation: "decode",
          message: 'Missing key\n  at ["f"]',
        })
        expect(describeExit(yield* Effect.exit(db.entities.Row.get({ id: "a" })))).toEqual(
          history139.getWithout,
        )
      }),
    )
  })

  it.effect("a soft-deleted row stored without the field: the missing key, as on 1.39.0", () => {
    const { run, table } = world("softDelete")
    return run((db) =>
      Effect.gen(function* () {
        yield* db.entities.Row.put({ id: "a", name: "nm", n: 1, f: "X" }).asEffect()
        yield* db.entities.Row.delete({ id: "a" }).asEffect()
        const [key, row] = [...table.items.entries()][0]!
        const { f: _f, ...without } = row
        table.items.set(key, without)
        expect(history139.deletedGet).toEqual({
          outcome: "ValidationError",
          operation: "deleted.get.decode",
          message: 'Missing key\n  at ["f"]',
        })
        expect(describeExit(yield* Effect.exit(db.entities.Row.deleted.get({ id: "a" })))).toEqual(
          history139.deletedGet,
        )
        expect(history139.deletedList).toEqual({
          outcome: "ValidationError",
          operation: "deleted.list.decode",
          message: 'Missing key\n  at ["f"]',
        })
        expect(
          describeExit(yield* Effect.exit(db.entities.Row.deleted.list({ id: "a" }).collect())),
        ).toEqual(history139.deletedList)
      }),
    )
  })

  it.effect("a stream image without the field: the missing key, as on 1.39.0", () => {
    const { Row } = world()
    return Effect.gen(function* () {
      expect(history139.decodeMarshalledItem).toEqual({
        outcome: "ValidationError",
        operation: "decodeMarshalledItem",
        message: 'Missing key\n  at ["f"]',
      })
      const image = {
        pk: { S: "x" },
        sk: { S: "y" },
        __edd_e__: { S: "Row" },
        id: { S: "b" },
        name: { S: "nm" },
        n: { N: "1" },
      }
      expect(
        describeExit(yield* Effect.exit(Entity.decodeMarshalledItem(Row, image as never))),
      ).toEqual(history139.decodeMarshalledItem)
    })
  })

  it.effect("a step that throws on a value the row holds is still a defect", () => {
    const { run, table } = world()
    return run((db) =>
      Effect.gen(function* () {
        yield* db.entities.Row.put({ id: "a", name: "nm", n: 1, f: "X" }).asEffect()
        const [key, row] = [...table.items.entries()][0]!
        table.items.set(key, { ...row, f: { N: "5" } })
        expect(describeExit(yield* Effect.exit(db.entities.Row.get({ id: "a" })))).toEqual({
          outcome: "defect",
        })
      }),
    )
  })
})
