/**
 * Writes of a sparse map's entry that 1.39.0 stored and read back, and the requests each sends.
 *
 * `test/fixtures/sparse-entry-writes-1.39.0.json` holds what the published 1.39.0 sent and read
 * back for every case here, captured by running `capture` against it. `test/SparseEntries.test.ts`
 * runs the same cases against this source and compares them whole.
 *
 * The library is taken as a parameter, so one definition serves both.
 */

import { Effect, Exit, Layer, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { makeRecordingTable } from "./RecordingTable.js"

/** The library's public modules, of whichever release is under test. */
export interface Api {
  readonly DynamoClient: any
  readonly DynamoModel: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly Table: any
  readonly Transaction: any
}

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}

export type World = "plain" | "retain" | "renamed"

/**
 * `plain` and `retain`: a sparse map `data` of numbers. `renamed`: the same beside a numeric field
 * named `data#x#y` and stored as `counter`, so its name looks like an entry's and its attribute
 * isn't one.
 */
export const definitions = (api: Api, world: World) => {
  const model = api.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      data: Schema.Record(Schema.String, Schema.Number),
      ...(world === "renamed" ? { "data#x#y": Schema.Number } : {}),
    }),
    {
      data: { storedAs: api.DynamoModel.SparseMap() },
      ...(world === "renamed" ? { "data#x#y": { field: "counter" } } : {}),
    },
  )
  const Docs = api.Entity.make({
    model,
    entityType: "Doc",
    primaryKey,
    ...(world === "retain" ? { versioned: { retain: true } } : {}),
  })
  const MainTable = api.Table.make({
    schema: api.DynamoSchema.make({ name: "entries", version: 1 }),
    entities: { Docs },
  })
  return { Docs, MainTable }
}

/** `data#` and 251 characters: an attribute name of 256 bytes. */
export const LONG = "k".repeat(251)
/** `data#` and 126 two-byte characters: an attribute name of 257 bytes. */
export const WIDE = "é".repeat(126)

export interface Case {
  readonly key: string
  readonly world: World
  readonly write: (db: any, api: Api) => Effect.Effect<unknown, unknown, any>
  /** The entry the write stores, as a read returns it under `data`. */
  readonly entry?: string
}

const update = (db: any) => db.entities.Docs.update({ id: "a" })

/**
 * A write of the entry `key` from a payload, which names the map's field. A retained entity's
 * builds the whole item, as a put does, and so runs put's check: it isn't one of these.
 */
const payloads = (name: string, key: string): ReadonlyArray<Case> => [
  {
    key: `update .set(), ${name}`,
    world: "plain",
    entry: key,
    write: (db) =>
      update(db)
        .set({ data: { [key]: 2 } })
        .asEffect(),
  },
  {
    key: `update .set() in a transaction, ${name}`,
    world: "plain",
    entry: key,
    write: (db, api) => api.Transaction.transactWrite([update(db).set({ data: { [key]: 2 } })]),
  },
  {
    key: `upsert, ${name}`,
    world: "plain",
    entry: key,
    write: (db) => db.entities.Docs.upsert({ id: "a", data: { [key]: 2 } }).asEffect(),
  },
]

/** A write of the entry `key` by the name of its attribute. */
const raws = (name: string, key: string): ReadonlyArray<Case> => [
  {
    key: `pathSet, ${name}`,
    world: "plain",
    entry: key,
    write: (db) =>
      update(db)
        .pathSet({ segments: [`data#${key}`], value: 2, isPath: false })
        .asEffect(),
  },
  {
    key: `pathAdd, ${name}`,
    world: "plain",
    entry: key,
    write: (db) =>
      update(db)
        .pathAdd({ segments: [`data#${key}`], value: 2 })
        .asEffect(),
  },
  {
    key: `.add(), ${name}`,
    world: "plain",
    entry: key,
    write: (db) =>
      update(db)
        .add({ [`data#${key}`]: 2 })
        .asEffect(),
  },
  {
    key: `.add() in a transaction, ${name}`,
    world: "plain",
    entry: key,
    write: (db, api) => api.Transaction.transactWrite([update(db).add({ [`data#${key}`]: 2 })]),
  },
  {
    key: `pathAdd of a retained entity, ${name}`,
    world: "retain",
    entry: key,
    write: (db) =>
      update(db)
        .pathAdd({ segments: [`data#${key}`], value: 2 })
        .asEffect(),
  },
]

export const cases: ReadonlyArray<Case> = [
  ...payloads("an attribute name of 256 bytes", LONG),
  ...payloads("a multibyte attribute name of 257 bytes", WIDE),
  ...raws("an attribute name of 256 bytes", LONG),
  ...raws("a multibyte attribute name of 257 bytes", WIDE),
  ...raws("a key holding '#'", "x#y"),
  ...raws("a multibyte key holding '#'", "雪#y"),
  // A field whose name reads as an entry's and whose attribute is `counter`.
  {
    key: ".add() of a field named as an entry and stored elsewhere",
    world: "renamed",
    write: (db) => update(db).add({ "data#x#y": 3 }).asEffect(),
  },
  {
    key: ".add() of a field named as an entry and stored elsewhere, in a transaction",
    world: "renamed",
    write: (db, api) => api.Transaction.transactWrite([update(db).add({ "data#x#y": 3 })]),
  },
  {
    key: ".set() of a field named as an entry and stored elsewhere",
    world: "renamed",
    write: (db) => update(db).set({ "data#x#y": 5 }).asEffect(),
  },
]

/** JSON as a fixture holds it. */
export const plain = <A>(value: A): A => JSON.parse(JSON.stringify(value))

export interface Captured {
  readonly ok: boolean
  readonly requests: ReadonlyArray<{ readonly command: string; readonly input: unknown }>
  /** Item `a` as a read returns it afterwards, or `undefined` when the read fails. */
  readonly read: Record<string, unknown> | undefined
  readonly error: unknown
}

/** Puts item `a`, runs `each.write`, and returns what was sent and what a read returns. */
export const capture = (api: Api, each: Case): Effect.Effect<Captured> => {
  const { Docs, MainTable } = definitions(api, each.world)
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* api.DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
    yield* db.entities.Docs.put({
      id: "a",
      data: { ok: 1 },
      ...(each.world === "renamed" ? { "data#x#y": 1 } : {}),
    }).asEffect()
    table.take()
    const exit = yield* Effect.exit(Effect.suspend(() => each.write(db, api)))
    const requests = plain(table.take())
    const read = yield* Effect.exit(db.entities.Docs.get({ id: "a" }))
    return {
      ok: Exit.isSuccess(exit),
      requests,
      read: Exit.isSuccess(read) ? plain(read.value as Record<string, unknown>) : undefined,
      error: Exit.isFailure(exit) ? exit.cause : undefined,
    }
  }).pipe(
    Effect.provide(MainTable.layer({ name: "entries" })),
    Effect.provide(Layer.succeed(api.DynamoClient, table.client)),
    Effect.provide(
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((n) => new Uint8Array(n).fill(7)),
      ),
    ),
  ) as unknown as Effect.Effect<Captured>
}
