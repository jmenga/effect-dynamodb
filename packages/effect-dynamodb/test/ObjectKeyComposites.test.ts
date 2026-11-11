/**
 * An object as a key composite (#242, `EDD-9162`): every object nothing gives other text to composes
 * `[object Object]`, so up to 1.40.0 items written with different values shared one key and
 * overwrote each other. A write composing a key from one is refused, naming the composite, with
 * nothing written: `put`, `create`, `upsert`, an update recomposing an index key, a time-series
 * `append`, a transaction's and a batch's put. A key-taking read or delete composes the text as it
 * always did, so a row an earlier release wrote under it is still reached. A value with a key form is
 * untouched.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { defaultObjectText } from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import { Cause, Data, Duration, Effect, Exit, Schema } from "effect"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Point extends Data.Class<{ readonly x: number }> {}
class Named {
  constructor(readonly name: string) {}
  toString() {
    return `named:${this.name}`
  }
}

// The text 1.40.0 composed, with `escapeKeys` off.
const schema = DynamoSchema.make({ name: "ok", version: 1, escapeKeys: false })
const Keyed = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    k: Schema.Unknown,
    g: Schema.optional(Schema.Unknown),
    s: Schema.optional(Schema.Struct({ a: Schema.Number })),
    d: Schema.optional(Schema.Duration),
    n: Schema.optional(Schema.String),
  }),
  entityType: "K",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["k"] } },
  indexes: {
    byG: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["id"] },
      sk: { field: "gsi1sk", composite: ["g"] },
    },
    byS: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["id"] },
      sk: { field: "gsi2sk", composite: ["s"] },
    },
    byD: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["id"] },
      sk: { field: "gsi3sk", composite: ["d"] },
    },
  },
})
const Series = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    at: Schema.Unknown,
    n: Schema.optional(Schema.String),
  }),
  entityType: "S",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({ id: Schema.String, at: Schema.Unknown }),
  },
})
const Main = Table.make({ schema, entities: { Keyed, Series } })

const run = <A>(
  body: (db: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, unknown, any>,
) => {
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { Keyed, Series }, tables: { Main } })
    return yield* body(db, table)
  }).pipe(Effect.provide(Main.layer({ name: "ok" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

const refusal = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "written"
  const error = Cause.squash(exit.cause) as ValidationError
  expect(error).toBeInstanceOf(ValidationError)
  return String(error.cause)
}

const object = { a: 1 }

describe("[EDD-9162] a write composing a key from an object is refused", () => {
  const WRITES: ReadonlyArray<readonly [string, string, (db: any) => any]> = [
    [
      "put, the primary sort key",
      "the primary key",
      (db) => db.entities.Keyed.put({ id: "a", k: object }),
    ],
    [
      "put, a class instance",
      "the primary key",
      (db) => db.entities.Keyed.put({ id: "a", k: new Point({ x: 1 }) }),
    ],
    [
      "put, an index's sort key",
      'index "byG"',
      (db) => db.entities.Keyed.put({ id: "a", k: "k", g: object }),
    ],
    [
      "put, a typed struct",
      'index "byS"',
      (db) => db.entities.Keyed.put({ id: "a", k: "k", s: { a: 1 } }),
    ],
    ["create", "the primary key", (db) => db.entities.Keyed.create({ id: "a", k: object })],
    ["upsert", "the primary key", (db) => db.entities.Keyed.upsert({ id: "a", k: object })],
    [
      "update .set, recomposing an index key",
      'index "byG"',
      (db) => db.entities.Keyed.update({ id: "a", k: "k" }).set({ g: object }),
    ],
    [
      "a time series' append",
      "an event's sort key (timeSeries.orderBy)",
      (db) => db.entities.Series.append({ id: "a", at: object }),
    ],
    [
      "a transaction's put",
      "the primary key",
      (db) => Transaction.transactWrite([db.entities.Keyed.put({ id: "a", k: object })]),
    ],
    [
      "a batch's put",
      "the primary key",
      (db) => Batch.write([db.entities.Keyed.put({ id: "a", k: object })]),
    ],
  ]
  for (const [name, into, write] of WRITES) {
    it.effect(name, () =>
      run((db, table) =>
        Effect.gen(function* () {
          const op = write(db)
          const exit = yield* Effect.exit(typeof op.asEffect === "function" ? op.asEffect() : op)
          const said = refusal(exit)
          expect(said).toContain(`is composed into ${into}`)
          expect(said).toContain('composes the key text "[object Object]"')
          expect(said).toContain("[EDD-9162]")
          expect(table.items.size).toBe(0)
        }),
      ),
    )
  }
})

describe("a key-taking read or delete composes the text as it always did", () => {
  /** A row as 1.40.0 wrote it for `{ id: "a", k: { a: 1 }, n: "kept" }`. */
  const seed = (table: ReturnType<typeof makeRecordingTable>) =>
    table.items.set("$ok#v1#k#id_a|$ok#v1#k#k_[object object]", {
      pk: { S: "$ok#v1#k#id_a" },
      sk: { S: "$ok#v1#k#k_[object object]" },
      __edd_e__: { S: "K" },
      gsi1pk: { S: "$ok#v1#k#id_a" },
      gsi1sk: { S: "$ok#v1#k#g_[object object]" },
      id: { S: "a" },
      k: { M: { a: { N: "1" } } },
      g: { M: { a: { N: "1" } } },
      n: { S: "kept" },
    })

  it.effect("get, an update's own key record and delete reach the row", () =>
    run((db, table) =>
      Effect.gen(function* () {
        seed(table)
        const got = yield* db.entities.Keyed.get({ id: "a", k: { b: 2 } })
        expect(got).toEqual({ id: "a", k: { a: 1 }, g: { a: 1 }, n: "kept" })
        yield* db.entities.Keyed.update({ id: "a", k: { b: 2 } })
          .set({ n: "changed" })
          .asEffect()
        expect(table.items.get("$ok#v1#k#id_a|$ok#v1#k#k_[object object]")?.n).toEqual({
          S: "changed",
        })
        yield* db.entities.Keyed.delete({ id: "a", k: { b: 2 } }).asEffect()
        expect(table.items.size).toBe(0)
      }),
    ),
  )

  it.effect("a query given the value composes its condition from the text", () =>
    run((db, table) =>
      Effect.gen(function* () {
        seed(table)
        table.take()
        const found = yield* db.entities.Keyed.scan().collect()
        expect(found).toHaveLength(1)
        const exit = yield* Effect.exit(
          db.entities.Keyed.byG({ id: "a", g: { a: 1 } }).collect() as Effect.Effect<unknown>,
        )
        expect(Exit.isSuccess(exit) && exit.value).toHaveLength(1)
        const sent = table.take().find(({ command }) => command === "Query")!
        expect(JSON.stringify(sent.input.ExpressionAttributeValues)).toContain("g_[object object]")
      }),
    ),
  )
})

describe("a value with a key form is untouched", () => {
  it.effect("a Duration, which composes its own text", () =>
    run((db, table) =>
      Effect.gen(function* () {
        yield* db.entities.Keyed.put({ id: "a", k: "k", d: Duration.millis(5) }).asEffect()
        expect([...table.items.values()][0]?.gsi3sk).toEqual({ S: "$ok#v1#k#d_5 millis" })
      }),
    ),
  )

  it.effect("a list, which composes its elements' text", () =>
    run((db, table) =>
      Effect.gen(function* () {
        yield* db.entities.Keyed.put({ id: "a", k: ["x", "y"] }).asEffect()
        expect([...table.items.values()][0]?.sk).toEqual({ S: "$ok#v1#k#k_x,y" })
      }),
    ),
  )

  it("defaultObjectText is the one decision", () => {
    expect(defaultObjectText({}, "[object Object]")).toBe("[object Object]")
    expect(defaultObjectText(new Map(), "[object Map]")).toBe("[object Map]")
    expect(defaultObjectText("[object Object]", "[object Object]")).toBeUndefined()
    expect(defaultObjectText(new Named("x"), "named:x")).toBeUndefined()
  })
})
