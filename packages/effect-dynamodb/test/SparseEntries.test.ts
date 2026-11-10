/**
 * A sparse map's entries, stored one attribute each as `<prefix>#<key>`, as its writer and its
 * reader take them (`internal/SparseKey.ts` in the schema package).
 *
 * - Each write of an entry checks the key as it did on 1.39.0. `put`, and a retained entity's
 *   update, which builds the whole item, run the writer's check (`validateSparseKey`): a non-empty
 *   key without `#`, and an attribute name of at most 255 bytes. An update's `.set()` and `upsert`
 *   refuse an empty key and one holding `#`. An operation naming an entry's attribute checks
 *   nothing. So an entry under a 256-byte name, or under `x#y` by its attribute's name, is written
 *   and read back, with the requests 1.39.0 sent
 *   (`fixtures/sparse-entry-writes-1.39.0.json`, from `helpers/SparseEntryWrites.ts`).
 * - Everything that decides which stored attributes are entries asks the reader (`sparseReader`:
 *   `<prefix>#` and a non-empty key). `clearMap` removed any attribute starting `<prefix>#`, so
 *   `<prefix>#` itself too, which the reader never reads as an entry; `removeEntries` refused a key
 *   holding `#`, which the reader reads.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { afterEach, beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Lib from "../src/index.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { capture, cases } from "./helpers/SparseEntryWrites.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sparse-entry-writes-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, { readonly requests: unknown; readonly read: unknown }> }

beforeEach(() => {
  // The fixture was captured with the clock and the random bytes fixed.
  vi.spyOn(Date, "now").mockReturnValue(1700000000000)
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    ;(array as Uint8Array).fill(7)
    return array
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

const schema = DynamoSchema.make({ name: "entries", version: 1 })
const model = DynamoModel.configure(
  Schema.Struct({ id: Schema.String, data: Schema.Record(Schema.String, Schema.Number) }),
  { data: { storedAs: DynamoModel.SparseMap() } },
)
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}

const world = (retain: boolean) => {
  const Docs = Entity.make({
    model,
    entityType: "Doc",
    primaryKey,
    ...(retain ? { versioned: { retain: true } } : {}),
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Docs } } as never) as any
  return { Docs, MainTable }
}

const run = <A>(
  retain: boolean,
  body: (db: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, unknown, any>,
) => {
  const { Docs, MainTable } = world(retain)
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } } as never)
    return yield* body(db, table)
  }).pipe(
    Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "entries" }))),
  ) as Effect.Effect<A, unknown>
}

/** `data#` and 250 characters: 255 bytes, the most the writer takes. */
const LONGEST = "k".repeat(250)
/** One byte more. */
const TOO_LONG = "k".repeat(251)

/** Each write of an entry, under the key `key`, of the row `a` (which exists). */
const WRITERS: ReadonlyArray<
  readonly [name: string, retain: boolean, write: (db: any, key: string) => any]
> = [
  ["put", false, (db, key) => db.entities.Docs.put({ id: "a", data: { [key]: 1 } }).asEffect()],
  [
    "Transaction.transactWrite of a put",
    false,
    (db, key) => Transaction.transactWrite([db.entities.Docs.put({ id: "a", data: { [key]: 1 } })]),
  ],
  [
    "update .set()",
    false,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .set({ data: { [key]: 1 } })
        .asEffect(),
  ],
  [
    "update .set() of a retained entity",
    true,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .set({ data: { [key]: 1 } })
        .asEffect(),
  ],
  [
    "put of a retained entity",
    true,
    (db, key) => db.entities.Docs.put({ id: "a", data: { [key]: 1 } }).asEffect(),
  ],
  [
    "Transaction.transactWrite of an update .set()",
    false,
    (db, key) =>
      Transaction.transactWrite([db.entities.Docs.update({ id: "a" }).set({ data: { [key]: 1 } })]),
  ],
  [
    "upsert",
    false,
    (db, key) => db.entities.Docs.upsert({ id: "a", data: { [key]: 1 } }).asEffect(),
  ],
  [
    "upsert of a retained entity",
    true,
    (db, key) => db.entities.Docs.upsert({ id: "a", data: { [key]: 1 } }).asEffect(),
  ],
  [
    "pathSet of the entry's attribute",
    false,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .pathSet({ segments: [`data#${key}`], value: 1 })
        .asEffect(),
  ],
  [
    "pathAdd of the entry's attribute",
    false,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .pathAdd({ segments: [`data#${key}`], value: 1 })
        .asEffect(),
  ],
  [
    ".add() of the entry's attribute",
    false,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .add({ [`data#${key}`]: 1 })
        .asEffect(),
  ],
]

describe("a write of an entry that 1.39.0 stored sends what 1.39.0 sent, and reads back", () => {
  it("the fixture holds every case", () => {
    expect(Object.keys(fixture.cases)).toEqual(cases.map((each) => each.key))
  })
  for (const each of cases) {
    it.effect(each.key, () =>
      Effect.gen(function* () {
        const got = yield* capture(Lib as never, each)
        expect(got.error === undefined ? undefined : Cause.squash(got.error as never)).toBe(
          undefined,
        )
        expect(got.requests).toEqual(fixture.cases[each.key]!.requests)
        expect(got.read).toEqual(fixture.cases[each.key]!.read)
        if (each.entry !== undefined) {
          expect((got.read as { data: Record<string, number> }).data[each.entry]).toBe(2)
        }
      }),
    )
  }
})

/** What each write refuses, as on 1.39.0: `sent` says whether it's refused before any request. */
const REFUSED: ReadonlyArray<
  readonly [writer: string, what: string, key: string, sent: "nothing" | "a read"]
> = [
  ["put", "a key holding '#'", "a#b", "nothing"],
  ["put", "an attribute name over 255 bytes", TOO_LONG, "nothing"],
  ["Transaction.transactWrite of a put", "a key holding '#'", "a#b", "nothing"],
  ["Transaction.transactWrite of a put", "an attribute name over 255 bytes", TOO_LONG, "nothing"],
  ["put of a retained entity", "a key holding '#'", "a#b", "nothing"],
  ["put of a retained entity", "an attribute name over 255 bytes", TOO_LONG, "nothing"],
  ["update .set()", "a key holding '#'", "a#b", "nothing"],
  ["Transaction.transactWrite of an update .set()", "a key holding '#'", "a#b", "a read"],
  ["upsert", "a key holding '#'", "a#b", "nothing"],
  // A retained entity's update builds the whole item, as a put does, after reading the row.
  ["update .set() of a retained entity", "a key holding '#'", "a#b", "a read"],
  ["update .set() of a retained entity", "an attribute name over 255 bytes", TOO_LONG, "a read"],
  ["upsert of a retained entity", "a key holding '#'", "a#b", "a read"],
  ["upsert of a retained entity", "an attribute name over 255 bytes", TOO_LONG, "a read"],
]

describe("a write of an entry refuses the keys it refused on 1.39.0", () => {
  for (const [writer, what, key, sent] of REFUSED) {
    const [, retain, write] = WRITERS.find(([name]) => name === writer)!
    it.effect(`${writer}: ${what} is refused, writing nothing`, () =>
      run(retain, (db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.put({ id: "a", data: { ok: 1 } }).asEffect()
          table.take()
          const stored = structuredClone([...table.items])
          const exit = yield* Effect.exit(Effect.suspend(() => write(db, key)))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons[0]!._tag).toBe("Fail")
            expect((Cause.squash(exit.cause) as any)._tag).toBe("ValidationError")
          }
          const commands = table.requests.map((request) => request.command)
          if (sent === "nothing") expect(commands).toEqual([])
          else expect(commands.every((command) => command === "GetItem")).toBe(true)
          expect([...table.items]).toEqual(stored)
        }),
      ),
    )
  }

  for (const [name, retain, write] of WRITERS) {
    it.effect(`${name}: an attribute name of 255 bytes is written and read back`, () =>
      run(retain, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.put({ id: "a", data: { ok: 1 } }).asEffect()
          yield* write(db, LONGEST)
          const read = yield* db.entities.Docs.get({ id: "a" })
          expect(read.data[LONGEST]).toBeGreaterThanOrEqual(1)
        }),
      ),
    )
  }
})

describe("an operation naming a field is judged by the attribute the field is stored in", () => {
  // A field named `data#x#y`, as an entry of `data` would be, and stored as `counter`.
  const Docs = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        data: Schema.Record(Schema.String, Schema.Number),
        "data#x#y": Schema.optional(Schema.Number),
      }),
      { data: { storedAs: DynamoModel.SparseMap() }, "data#x#y": { field: "counter" } },
    ),
    entityType: "Doc",
    primaryKey,
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Docs } } as never) as any
  const onRow = <A>(
    body: (db: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, unknown, any>,
  ) => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Docs },
        tables: { MainTable },
      } as never)
      yield* db.entities.Docs.put({ id: "a", data: { ok: 1 }, "data#x#y": 1 }).asEffect()
      table.take()
      return yield* body(db, table)
    }).pipe(
      Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "entries" }))),
    ) as Effect.Effect<A, unknown>
  }

  it.effect(".remove() of the field removes `counter`: it isn't an entry", () =>
    onRow((db, table) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.update({ id: "a" }).remove(["data#x#y"]).asEffect()
        const [update] = table.requests
        expect(update!.input.UpdateExpression).toMatch(/^REMOVE #\w+$/)
        expect(Object.values(update!.input.ExpressionAttributeNames)).toContain("counter")
        expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({ id: "a", data: { ok: 1 } })
      }),
    ),
  )

  for (const [name, remove] of [
    [".remove() of an entry's attribute", (update: any) => update.remove(["data#ok"])],
    ["pathRemove of an entry's attribute", (update: any) => update.pathRemove(["data#ok"])],
    // A path's segment holding `#` is the attribute's own name: this names the entry `x#y`.
    ["pathRemove of the attribute the field is named as", (u: any) => u.pathRemove(["data#x#y"])],
  ] as const) {
    it.effect(`${name} is refused, pointing at removeEntries, sending nothing`, () =>
      onRow((db, table) =>
        Effect.gen(function* () {
          const error: any = yield* Effect.flip(
            Effect.suspend(() => remove(db.entities.Docs.update({ id: "a" })).asEffect()),
          )
          expect(error._tag).toBe("ValidationError")
          expect(String(error.cause)).toContain(".removeEntries(")
          expect(table.requests).toEqual([])
        }),
      ),
    )
  }
})

describe("which attributes are a sparse map's entries is the reader's to say", () => {
  /** The row `a`, with entries the reader reads under `#` and `x#y`, and `data#`, which it doesn't. */
  const seeded = (db: any, table: ReturnType<typeof makeRecordingTable>) =>
    Effect.gen(function* () {
      yield* db.entities.Docs.put({ id: "a", data: { ok: 1 } }).asEffect()
      const [key, row] = [...table.items][0] as [string, Record<string, any>]
      table.items.set(key, {
        ...row,
        "data##": { N: "2" },
        "data#x#y": { N: "3" },
        "data#": { S: "not an entry" },
      })
      table.take()
      return key
    })

  it.effect("a get reads `data##` and `data#x#y` as entries, and not `data#`", () =>
    run(false, (db, table) =>
      Effect.gen(function* () {
        yield* seeded(db, table)
        expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({
          id: "a",
          data: { ok: 1, "#": 2, "x#y": 3 },
        })
      }),
    ),
  )

  it.effect("clearMap removes exactly the entries the reader reads", () =>
    run(false, (db, table) =>
      Effect.gen(function* () {
        const key = yield* seeded(db, table)
        yield* db.entities.Docs.update({ id: "a" }).clearMap("data").asEffect()
        const update = table.requests.find((request) => request.command === "UpdateItem")!
        const removed = /REMOVE (.*)$/
          .exec(update.input.UpdateExpression)![1]!
          .split(", ")
          .map((name) => update.input.ExpressionAttributeNames[name])
        expect(removed.sort()).toEqual(["data##", "data#ok", "data#x#y"])
        expect(table.items.get(key)!["data#"]).toEqual({ S: "not an entry" })
        expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({ id: "a", data: {} })
      }),
    ),
  )

  it.effect("removeEntries removes an entry the reader reads under a key holding '#'", () =>
    run(false, (db, table) =>
      Effect.gen(function* () {
        yield* seeded(db, table)
        yield* db.entities.Docs.update({ id: "a" }).removeEntries("data", ["x#y"]).asEffect()
        expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({
          id: "a",
          data: { ok: 1, "#": 2 },
        })
      }),
    ),
  )

  it.effect("removeEntries refuses the empty key, which names `data#`, sending nothing", () =>
    run(false, (db, table) =>
      Effect.gen(function* () {
        yield* seeded(db, table)
        const error: any = yield* Effect.flip(
          db.entities.Docs.update({ id: "a" }).removeEntries("data", [""]).asEffect(),
        )
        expect(error._tag).toBe("ValidationError")
        expect(error.operation).toBe("update.removeEntries")
        expect(table.requests).toEqual([])
      }),
    ),
  )
})
