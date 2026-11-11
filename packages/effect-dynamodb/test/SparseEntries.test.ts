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
  ["Transaction.transactWrite of an update .set()", "a key holding '#'", "a#b", "nothing"],
  ["upsert", "a key holding '#'", "a#b", "nothing"],
  // A retained entity's update builds the whole item, as a put does, after reading the row.
  ["update .set() of a retained entity", "a key holding '#'", "a#b", "nothing"],
  ["update .set() of a retained entity", "an attribute name over 255 bytes", TOO_LONG, "nothing"],
  ["upsert of a retained entity", "a key holding '#'", "a#b", "nothing"],
  ["upsert of a retained entity", "an attribute name over 255 bytes", TOO_LONG, "nothing"],
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

  // A path names a model field by its rename, a first segment holding `#` included, as a filter
  // and a projection do (#238): `pathRemove(["data#x#y"])` names the field, not the entry `x#y`.
  // 1.40.0 refused it as an entry; 1.39.0 removed the entry and left `counter` as it was.
  for (const [name, remove] of [
    [".remove()", (update: any) => update.remove(["data#x#y"])],
    ["pathRemove", (update: any) => update.pathRemove(["data#x#y"])],
  ] as const) {
    it.effect(`${name} of the field removes \`counter\`: it isn't an entry`, () =>
      onRow((db, table) =>
        Effect.gen(function* () {
          yield* remove(db.entities.Docs.update({ id: "a" })).asEffect()
          const [update] = table.requests
          expect(update!.input.UpdateExpression).toMatch(/^REMOVE #\w+$/)
          expect(Object.values(update!.input.ExpressionAttributeNames)).toContain("counter")
          expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({ id: "a", data: { ok: 1 } })
        }),
      ),
    )
  }

  // The field wins only for a bare `data#x#y` segment: named through the map, `x#y` is the
  // entry, stored as `data#x#y` beside `counter`. A put refuses a key holding `#`, so the row gets
  // the entry by hand, as an entry written by its attribute stores it.
  const withEntry = (table: ReturnType<typeof makeRecordingTable>) => {
    const [key, row] = [...table.items][0] as [string, Record<string, any>]
    table.items.set(key, { ...row, "data#x#y": { N: "3" } })
    return key
  }

  it.effect("a get reads the field from `counter` and the entry `x#y` from `data#x#y`", () =>
    onRow((db, table) =>
      Effect.gen(function* () {
        withEntry(table)
        expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({
          id: "a",
          data: { ok: 1, "x#y": 3 },
          "data#x#y": 1,
        })
      }),
    ),
  )

  it.effect("removeEntries of `x#y` removes the entry and leaves the field", () =>
    onRow((db, table) =>
      Effect.gen(function* () {
        const key = withEntry(table)
        yield* db.entities.Docs.update({ id: "a" }).removeEntries("data", ["x#y"]).asEffect()
        const [update] = table.requests
        expect(update!.input.UpdateExpression).toMatch(/^REMOVE #\w+$/)
        // Beside the guard's `pk`.
        expect(Object.values(update!.input.ExpressionAttributeNames)).toEqual(["data#x#y", "pk"])
        expect(table.items.get(key)!.counter).toEqual({ N: "1" })
        expect(table.items.get(key)!["data#x#y"]).toBeUndefined()
        expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({
          id: "a",
          data: { ok: 1 },
          "data#x#y": 1,
        })
      }),
    ),
  )

  it.effect("`.entry()` refuses the key `x#y`, as it refuses any key holding '#'", () =>
    onRow((db) =>
      Effect.gen(function* () {
        expect(() =>
          db.entities.Docs.scan().filter((t: any, { eq }: any) => eq(t.data.entry("x#y"), 3)),
        ).toThrow(/must not contain '#'/)
      }),
    ),
  )

  for (const [name, remove] of [
    [".remove() of an entry's attribute", (update: any) => update.remove(["data#ok"])],
    ["pathRemove of an entry's attribute", (update: any) => update.pathRemove(["data#ok"])],
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

describe("a stored row is read in one order: its sparse entries, then its names", () => {
  // A field named `data#x`, as the entry `x` of `data` is, and stored as `counter`. The row holds
  // both: `counter` = 7 and the entry `data#x` = 99.
  const fields = (name: string) => ({
    id: Schema.String,
    note: Schema.String,
    data: Schema.Record(Schema.String, Schema.Number),
    [name]: Schema.optionalKey(Schema.Number),
  })
  const named = (name: string, config: Record<string, unknown>) => {
    const Docs = Entity.make({
      model: DynamoModel.configure(Schema.Struct(fields(name)), {
        data: { storedAs: DynamoModel.SparseMap() },
        [name]: { field: "counter" },
      } as never),
      entityType: "Doc",
      primaryKey,
      ...config,
    } as never) as any
    const MainTable = Table.make({ schema, entities: { Docs } } as never) as any
    return { Docs, MainTable }
  }
  const onRow = <A>(
    name: string,
    config: Record<string, unknown>,
    seed: Record<string, unknown>,
    body: (db: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, unknown, any>,
  ) => {
    const { Docs, MainTable } = named(name, config)
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Docs },
        tables: { MainTable },
      } as never)
      yield* db.entities.Docs.put({ id: "a", note: "ok", ...seed }).asEffect()
      table.take()
      return yield* body(db, table)
    }).pipe(
      Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "entries" }))),
    ) as Effect.Effect<A, unknown>
  }
  const live = (table: ReturnType<typeof makeRecordingTable>): Record<string, any> =>
    [...table.items.values()].find(
      (row: any) => row.__edd_e__.S === "Doc" && !row.sk.S.includes("#v#"),
    ) as Record<string, any>
  const retained = { versioned: { retain: true } }
  const both = { data: { safe: 1, x: 99 }, "data#x": 7 }

  // A bare `data#x` segment names the field (`counter`); `.entry("x")` and `removeEntries` name the
  // entry (`data#x`), each on a plain entity.
  describe("the field wins for a bare segment, the entry through the map", () => {
    const names = (table: ReturnType<typeof makeRecordingTable>) =>
      table.requests
        .filter((request) => request.command === "UpdateItem" || request.command === "Scan")
        .flatMap((request) => Object.values(request.input.ExpressionAttributeNames ?? {}))
        // The update's guard names `pk`, the scan's ownership filter `__edd_e__`.
        .filter((name) => name !== "pk" && name !== "__edd_e__")

    it.effect("pathSet of the bare segment `data#x` sets the field", () =>
      onRow("data#x", {}, both, (db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.update({ id: "a" })
            .pathSet({ segments: ["data#x"], value: 8, isPath: false })
            .asEffect()
          expect(names(table)).toEqual(["counter"])
          expect(live(table).counter).toEqual({ N: "8" })
          expect(live(table)["data#x"]).toEqual({ N: "99" })
        }),
      ),
    )

    it.effect("removeEntries of `x` removes the entry and leaves the field", () =>
      onRow("data#x", {}, both, (db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.update({ id: "a" }).removeEntries("data", ["x"]).asEffect()
          expect(names(table)).toEqual(["data#x"])
          expect(live(table).counter).toEqual({ N: "7" })
          expect(live(table)["data#x"]).toBeUndefined()
        }),
      ),
    )

    it.effect('a condition on `.entry("x")` tests the entry, not the field', () =>
      onRow("data#x", {}, both, (db, table) =>
        Effect.gen(function* () {
          const update = (value: number) =>
            db.entities.Docs.update({ id: "a" })
              .set({ note: "new" })
              .condition((t: any, { eq }: any) => eq(t.data.entry("x"), value))
              .asEffect()
          const refused: any = yield* Effect.flip(update(7))
          expect(refused._tag).toBe("ConditionalCheckFailed")
          yield* update(99)
          expect(names(table)).toContain("data#x")
          expect(names(table)).not.toContain("counter")
          expect(live(table).note).toEqual({ S: "new" })
        }),
      ),
    )

    it.effect('a scan\'s filter on `.entry("x")` tests the entry, not the field', () =>
      onRow("data#x", {}, both, (db, table) =>
        Effect.gen(function* () {
          const scan = (value: number) =>
            db.entities.Docs.scan()
              .filter((t: any, { eq }: any) => eq(t.data.entry("x"), value))
              .collect()
          expect(yield* scan(7)).toEqual([])
          expect(yield* scan(99)).toEqual([
            { id: "a", note: "ok", data: { safe: 1, x: 99 }, "data#x": 7 },
          ])
          expect(names(table)).toContain("data#x")
          expect(names(table)).not.toContain("counter")
        }),
      ),
    )
  })

  // A retained entity's update reads the row and writes it whole. It mapped the names first, so
  // `counter` became `data#x` and was then taken for the entry: the entry got the field's value
  // and the field was lost, on 1.39.0 too.
  for (const transaction of [false, true]) {
    const where = transaction ? "in a transaction" : "alone"
    for (const [name, apply, counter, read] of [
      ["a .set() of another field", (u: any) => u.set({ note: "new" }), { N: "7" }, 7],
      ["a .set() of another entry", (u: any) => u.set({ data: { z: 5 } }), { N: "7" }, 7],
      ["a .set() of the field", (u: any) => u.set({ "data#x": 8 }), { N: "8" }, 8],
      ["an .add() to the field", (u: any) => u.add({ "data#x": 1 }), { N: "8" }, 8],
      ["a .remove() of the field", (u: any) => u.remove(["data#x"]), undefined, undefined],
    ] as const) {
      it.effect(
        `a retained entity's update keeps the field and the entry apart: ${name}, ${where}`,
        () =>
          onRow("data#x", retained, both, (db, table) =>
            Effect.gen(function* () {
              const update = apply(db.entities.Docs.update({ id: "a" }))
              yield* transaction ? Transaction.transactWrite([update]) : update.asEffect()
              const row = live(table)
              expect(row.counter).toEqual(counter)
              expect(row["data#x"]).toEqual({ N: "99" })
              const got = yield* db.entities.Docs.get({ id: "a" })
              expect(got["data#x"]).toBe(read)
              expect(got.data.x).toBe(99)
              expect(got.data.safe).toBe(1)
            }),
          ),
      )
    }

    it.effect(`a retained removal of a field named \`data#x#y\` succeeds, ${where}`, () =>
      onRow("data#x#y", retained, { data: { safe: 1 }, "data#x#y": 7 }, (db, table) =>
        Effect.gen(function* () {
          const update = db.entities.Docs.update({ id: "a" }).remove(["data#x#y"])
          yield* transaction ? Transaction.transactWrite([update]) : update.asEffect()
          expect(live(table).counter).toBeUndefined()
          expect(yield* db.entities.Docs.get({ id: "a" })).toMatchObject({ data: { safe: 1 } })
        }),
      ),
    )

    it.effect(
      `a retained update writes an entry it read back under its own attribute, whatever its key, ${where}`,
      () =>
        onRow("counter", retained, { data: { safe: 1 } }, (db, table) =>
          Effect.gen(function* () {
            // An entry named by its attribute, under a key a put refuses.
            yield* db.entities.Docs.update({ id: "a" })
              .pathSet({ segments: ["data#x#y"], value: 3, isPath: false })
              .asEffect()
            table.take()
            const update = db.entities.Docs.update({ id: "a" }).set({ note: "new" })
            yield* transaction ? Transaction.transactWrite([update]) : update.asEffect()
            expect(live(table)["data#x#y"]).toEqual({ N: "3" })
            expect(yield* db.entities.Docs.get({ id: "a" })).toMatchObject({
              note: "new",
              data: { safe: 1, "x#y": 3 },
            })
          }),
        ),
    )
  }

  // A record operation naming an entry by its attribute, on an update that reads the row and
  // writes it whole. It was applied beside the map and overwritten when the map was flattened:
  // the update reported success and the entry kept its value, on 1.39.0 too. With an entry in the
  // row under a key a put refuses, 1.39.0 refused the update after its read.
  for (const transaction of [false, true]) {
    for (const key of ["views", "x#y"]) {
      for (const [name, seeded, apply, stored] of [
        ["add", 9, (u: any, a: string) => u.add({ [a]: 2 }), { N: "11" }],
        ["subtract", 9, (u: any, a: string) => u.subtract({ [a]: 2 }), { N: "7" }],
        ["append", [1, 2], (u: any, a: string) => u.append({ [a]: [3] }), [1, 2, 3]],
        [
          "deleteFromSet",
          new Set(["a", "b"]),
          (u: any, a: string) => u.deleteFromSet({ [a]: new Set(["a"]) }),
          { SS: ["b"] },
        ],
      ] as const) {
        it.effect(
          `a retained .${name}() of the entry \`data#${key}\` reaches the entry, ${transaction ? "in a transaction" : "alone"}`,
          () => {
            const Docs = Entity.make({
              model: DynamoModel.configure(
                Schema.Struct({
                  id: Schema.String,
                  data: Schema.Record(Schema.String, Schema.Unknown),
                }),
                { data: { storedAs: DynamoModel.SparseMap() } },
              ),
              entityType: "Doc",
              primaryKey,
              versioned: { retain: true },
            } as never) as any
            const MainTable = Table.make({ schema, entities: { Docs } } as never) as any
            const table = makeRecordingTable()
            return Effect.gen(function* () {
              const db: any = yield* DynamoClient.make({
                entities: { Docs },
                tables: { MainTable },
              } as never)
              yield* db.entities.Docs.put({ id: "a", data: { safe: 1 } }).asEffect()
              yield* db.entities.Docs.update({ id: "a" })
                .pathSet({ segments: [`data#${key}`], value: seeded, isPath: false })
                .asEffect()
              const update = apply(db.entities.Docs.update({ id: "a" }), `data#${key}`)
              yield* transaction ? Transaction.transactWrite([update]) : update.asEffect()
              const row = live(table)[`data#${key}`]
              expect(
                Array.isArray(stored) ? row.L.map((entry: any) => Number(entry.N)) : row,
              ).toEqual(stored)
              // The version before the update keeps what the entry held then.
              const before = yield* db.entities.Docs.getVersion({ id: "a" }, 2)
              expect(before.data[key]).toEqual(seeded)
            }).pipe(
              Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "entries" }))),
            ) as Effect.Effect<void, unknown>
          },
        )
      }
    }
  }

  // Everything that reads a stored row by field name reads it the same way. A unique constraint
  // on the field: the row lacks `counter`, and the entry `data#x` isn't the field's value.
  it.effect("a unique field the row lacks isn't read from the entry of its name", () =>
    onRow("data#x", { unique: { code: ["data#x"] } }, { data: { safe: 1, x: 99 } }, (db, table) =>
      Effect.gen(function* () {
        const sentinels = () =>
          [...table.items.values()].filter((row: any) => row.__edd_e__.S.includes("._unique."))
        expect(sentinels()).toEqual([])
        // Setting another field, then deleting the row, reserves and releases nothing.
        yield* db.entities.Docs.update({ id: "a" }).set({ note: "new" }).asEffect()
        expect(sentinels()).toEqual([])
        yield* db.entities.Docs.delete({ id: "a" }).asEffect()
        expect(
          table.requests.flatMap((request) =>
            request.command === "TransactWriteItems"
              ? request.input.TransactItems.flatMap((item: any) =>
                  item.Delete?.Key.pk.S.includes("_unique") ? [item.Delete.Key] : [],
                )
              : [],
          ),
        ).toEqual([])
      }),
    ),
  )
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
