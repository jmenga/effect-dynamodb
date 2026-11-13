/**
 * Operations on a sparse map's entries, and what the published 1.39.0 did for each.
 *
 * `test/fixtures/sparse-entry-ops-1.39.0.json` holds, for every case here, what 1.39.0 stored and
 * how the operation ended, captured by running `capture` against it.
 * `test/fixtures/sparse-entry-ops-requests-1.40.0.json` holds every request the published 1.40.0
 * sent for each case, whole, captured by running `captureWithRequests` against it.
 * `test/SparseEntryOps.test.ts` runs the same cases against this source.
 *
 * - `entryOps`: every operation that changes one entry by its attribute's name (the record
 *   operations and the path operations), on a plain, a retained and a unique entity, alone and
 *   in a transaction, with the entry present and absent, under keys that include the names every
 *   object inherits (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__proto__`).
 * - `conditional`: operations carrying a sparse map's entry key that they write only into some
 *   rows, or into none: an upsert's and an update's value for an immutable map.
 * - `refRead`: a write that reads a ref first, carrying an entry key every such write refuses.
 * - `ttlNamed`: an operation naming the table's TTL attribute on an entity that never writes it.
 *
 * The library is taken as a parameter, so one definition serves both.
 */

import { Cause, Effect, Exit, Layer, Schema } from "effect"
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

export const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}

/** JSON as a fixture holds it. */
export const plain = <A>(value: A): A =>
  JSON.parse(JSON.stringify(value, (_key, held) => (held instanceof Set ? [...held].sort() : held)))

/** What an operation did. */
export interface Outcome {
  readonly ok: boolean
  /** The failure's tag and operation, when it failed. */
  readonly error?: string
  /** The commands sent, in order. */
  readonly commands: ReadonlyArray<string>
  /** The stored attribute the case is about, afterwards. */
  readonly stored?: unknown
  /** Item `a` as a read returns it afterwards, or `undefined` when the read fails. */
  readonly read?: unknown
}

export interface Case {
  readonly key: string
  /** The entity's configuration, beyond its model. */
  readonly entity: (api: Api) => Record<string, unknown>
  /** Other entities the table holds. */
  readonly others?: (api: Api) => Record<string, any>
  readonly ttlAttribute?: string
  /** Rows written before the operation: through `db`, and straight into the table. */
  readonly seed: (db: any) => Effect.Effect<unknown, unknown, any>
  readonly inject?: (row: Record<string, any>) => void
  readonly run: (db: any, api: Api) => Effect.Effect<unknown, unknown, any>
  /** The attribute of item `a`'s row the case is about. */
  readonly attribute?: string
}

/** A request as sent, as a fixture holds it. */
export interface SentRequest {
  readonly command: string
  readonly input: unknown
}

/** What an operation did, and every request it sent. */
export interface Captured {
  readonly outcome: Outcome
  readonly requests: ReadonlyArray<SentRequest>
}

const run = (api: Api, each: Case): Effect.Effect<Captured> => {
  const table = makeRecordingTable()
  return Effect.suspend(() => {
    // The others first: an entity with a ref names one of them.
    const others = each.others?.(api) ?? {}
    const Docs = api.Entity.make({ entityType: "Doc", primaryKey, ...each.entity(api) })
    const Main = api.Table.make({
      schema: api.DynamoSchema.make({ name: "ops", version: 1 }),
      entities: { Docs, ...others },
    })
    return Effect.gen(function* () {
      const db: any = yield* api.DynamoClient.make({
        entities: { Docs, ...others },
        tables: { Main },
      })
      yield* each.seed(db)
      const live = () =>
        [...table.items.values()].find(
          (row: any) => row.__edd_e__?.S === "Doc" && row.sk?.S === "$ops#v1#doc",
        ) as Record<string, any> | undefined
      const row = live()
      if (row !== undefined) each.inject?.(row)
      table.take()
      const exit = yield* Effect.exit(Effect.suspend(() => each.run(db, api)))
      const sent = table.take()
      const commands = sent.map((request) => request.command)
      const read = yield* Effect.exit(db.entities.Docs.get({ id: "a" }))
      const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
      const outcome = plain({
        ok: Exit.isSuccess(exit),
        ...(failure === undefined
          ? {}
          : {
              error: `${failure._tag ?? "defect"}${failure.operation ? ` ${failure.operation}` : ""}`,
            }),
        commands,
        ...(each.attribute === undefined ? {} : { stored: live()?.[each.attribute] }),
        ...(Exit.isSuccess(read) ? { read: read.value } : {}),
      }) as Outcome
      return { outcome, requests: plain(sent) }
    }).pipe(
      Effect.provide(
        Main.layer({
          name: "t",
          ...(each.ttlAttribute === undefined ? {} : { ttlAttributeName: each.ttlAttribute }),
        }),
      ),
      Effect.provide(Layer.succeed(api.DynamoClient, table.client)),
      Effect.provide(
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((n) => new Uint8Array(n).fill(7)),
        ),
      ),
    )
  }) as unknown as Effect.Effect<Captured>
}

/**
 * Runs a case, and returns what it did and every request it sent. A definition the library refuses
 * is an outcome too, sending nothing.
 */
export const captureWithRequests = (api: Api, each: Case): Effect.Effect<Captured> =>
  run(api, each).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        outcome: {
          ok: false,
          error: `defect ${String(Cause.squash(cause)).slice(0, 80)}`,
          commands: [],
        },
        requests: [],
      }),
    ),
  ) as Effect.Effect<Captured>

/** Runs a case, and returns what it did. */
export const capture = (api: Api, each: Case): Effect.Effect<Outcome> =>
  Effect.map(captureWithRequests(api, each), (captured) => captured.outcome)

// ---------------------------------------------------------------------------
// Entry operations
// ---------------------------------------------------------------------------

export const counted = (
  api: Api,
  value: Schema.Top = Schema.Unknown,
  extra: Record<string, unknown> = {},
) =>
  api.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      note: Schema.String,
      data: Schema.Record(Schema.String, value),
    }),
    { data: { storedAs: api.DynamoModel.SparseMap(), ...extra } },
  )

/** Entry keys: an ordinary one, and the names every object inherits. */
export const KEYS = ["views", "constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]

export const WORLDS = ["plain", "retain", "unique"] as const
export type World = (typeof WORLDS)[number]

interface EntryOp {
  readonly name: string
  /** What the entry holds when it's present, as stored, and as a value to write there. */
  readonly seeded: unknown
  readonly seedValue: unknown
  readonly apply: (update: any, attribute: string) => any
  /** What the entry holds afterwards, as stored: with the entry present, and with it absent. */
  readonly present: unknown
  /** Left out: DynamoDB refuses the operation on an attribute that isn't there. */
  readonly absent?: unknown
}

export const ENTRY_OPS: ReadonlyArray<EntryOp> = [
  {
    name: ".add() of a number",
    seeded: { N: "9" },
    seedValue: 9,
    apply: (u, a) => u.add({ [a]: 2 }),
    present: { N: "11" },
    absent: { N: "2" },
  },
  {
    name: ".subtract()",
    seeded: { N: "9" },
    seedValue: 9,
    apply: (u, a) => u.subtract({ [a]: 2 }),
    present: { N: "7" },
  },
  {
    name: ".append()",
    seeded: { L: [{ N: "1" }] },
    seedValue: [1],
    apply: (u, a) => u.append({ [a]: [2] }),
    present: { L: [{ N: "1" }, { N: "2" }] },
  },
  {
    name: ".add() of a set",
    seeded: { SS: ["a", "b"] },
    seedValue: new Set(["a", "b"]),
    apply: (u, a) => u.add({ [a]: new Set(["a", "c"]) }),
    present: { SS: ["a", "b", "c"] },
    absent: { SS: ["a", "c"] },
  },
  {
    name: ".deleteFromSet()",
    seeded: { SS: ["a", "b"] },
    seedValue: new Set(["a", "b"]),
    apply: (u, a) => u.deleteFromSet({ [a]: new Set(["a", "c"]) }),
    present: { SS: ["b"] },
    absent: undefined,
  },
  {
    name: "pathSet",
    seeded: { N: "9" },
    seedValue: 9,
    apply: (u, a) => u.pathSet({ segments: [a], value: 5, isPath: false }),
    present: { N: "5" },
    absent: { N: "5" },
  },
  {
    name: "pathAdd",
    seeded: { N: "9" },
    seedValue: 9,
    apply: (u, a) => u.pathAdd({ segments: [a], value: 2 }),
    present: { N: "11" },
    absent: { N: "2" },
  },
  {
    name: "pathAppend",
    seeded: { L: [{ N: "1" }] },
    seedValue: [1],
    apply: (u, a) => u.pathAppend({ segments: [a], value: [2] }),
    present: { L: [{ N: "1" }, { N: "2" }] },
  },
]

export interface EntryCase extends Case {
  /** What the entry holds afterwards, when the operation has a defined result. */
  readonly expected: { readonly stored: unknown } | undefined
  /** Whether the operation goes through the update that reads the row and writes it whole. */
  readonly whole: boolean
}

export const entryOps: ReadonlyArray<EntryCase> = KEYS.flatMap((key) =>
  ENTRY_OPS.flatMap((op) =>
    WORLDS.flatMap((world: World) =>
      [false, true].flatMap((transaction) =>
        [true, false].map((present): EntryCase => {
          const attribute = `data#${key}`
          const record = op.name.startsWith(".")
          return {
            key: `${op.name} of \`${attribute}\`, ${world}, ${transaction ? "in a transaction" : "alone"}, ${present ? "present" : "absent"}`,
            entity: (api) => ({
              model: counted(api),
              ...(world === "retain" ? { versioned: { retain: true } } : {}),
              ...(world === "unique" ? { unique: { note: ["note"] } } : {}),
            }),
            seed: (db) => db.entities.Docs.put({ id: "a", note: "before", data: {} }).asEffect(),
            ...(present
              ? {
                  inject: (row: Record<string, any>) => {
                    row[attribute] = op.seeded
                  },
                }
              : {}),
            run: (db, api) => {
              // A unique entity writes the row whole when the update touches the unique field.
              const base = db.entities.Docs.update({ id: "a" })
              const update = op.apply(
                world === "unique" && record ? base.set({ note: "after" }) : base,
                attribute,
              )
              return transaction ? api.Transaction.transactWrite([update]) : update.asEffect()
            },
            attribute,
            expected: present
              ? { stored: op.present }
              : "absent" in op
                ? { stored: op.absent }
                : undefined,
            whole: record && world !== "plain",
          }
        }),
      ),
    ),
  ),
)

// ---------------------------------------------------------------------------
// A value written only into some rows
// ---------------------------------------------------------------------------

const BAD_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["a key holding `#`", "bad#key"],
  ["an attribute name over 255 bytes", "k".repeat(251)],
]

/** An immutable sparse map: an update never writes it, and an upsert only into a row that isn't there. */
export const conditional: ReadonlyArray<Case> = BAD_KEYS.flatMap(([what, key]) =>
  (["plain", "retain", "unique"] as const).flatMap((world) =>
    [true, false].flatMap((present): ReadonlyArray<Case> => {
      const entity = (api: Api) => ({
        model: counted(api, Schema.Number, { immutable: true }),
        ...(world === "retain" ? { versioned: { retain: true } } : {}),
        ...(world === "unique" ? { unique: { note: ["note"] } } : {}),
      })
      const seed = (db: any) =>
        present
          ? db.entities.Docs.put({ id: "a", note: "before", data: { ok: 1 } }).asEffect()
          : db.entities.Docs.put({ id: "other", note: "other", data: { ok: 1 } }).asEffect()
      const where = `${world}, the row ${present ? "present" : "missing"}`
      return [
        {
          key: `upsert of an immutable map with ${what}, ${where}`,
          entity,
          seed,
          run: (db) =>
            db.entities.Docs.upsert({ id: "a", note: "after", data: { [key]: 3 } }).asEffect(),
        },
        {
          key: `update restating an immutable map with ${what}, ${where}`,
          entity,
          seed,
          run: (db) =>
            db.entities.Docs.update({ id: "a" })
              .set({ note: "after", data: { [key]: 3 } })
              .asEffect(),
        },
      ]
    }),
  ),
)

// ---------------------------------------------------------------------------
// A write that reads a ref first
// ---------------------------------------------------------------------------

class Project extends Schema.Class<Project>("Project")({
  projectId: Schema.String,
  name: Schema.String,
}) {}

/** A retained entity with a ref and a sparse map: each write reads the ref before it writes. */
export const refRead: ReadonlyArray<Case> = (
  ["update", "patch", "a transaction's update", "put", "create", "upsert"] as const
).map((op): Case => {
  const projects = (api: Api) =>
    api.Entity.make({
      entityType: "Project",
      model: api.DynamoModel.configure(Project, { projectId: { identifier: true } }),
      primaryKey: {
        pk: { field: "pk", composite: ["projectId"] },
        sk: { field: "sk", composite: [] },
      },
    })
  let Projects: any
  const payload = { id: "a", projectId: "p", data: { "bad#key": 2 } }
  return {
    key: `${op} with a ref and an entry key holding \`#\``,
    others: (api) => {
      Projects = projects(api)
      return { Projects }
    },
    entity: (api) => ({
      model: api.DynamoModel.configure(
        Schema.Struct({
          id: Schema.String,
          project: Project.pipe(api.DynamoModel.ref),
          data: Schema.Record(Schema.String, Schema.Number),
        }),
        { data: { storedAs: api.DynamoModel.SparseMap() } },
      ),
      versioned: { retain: true },
      refs: { project: { entity: Projects ?? projects(api) } },
    }),
    seed: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Projects.put({ projectId: "p", name: "Project" }).asEffect()
        yield* db.entities.Docs.put({ id: "a", projectId: "p", data: { ok: 1 } }).asEffect()
      }),
    run: (db, api) => {
      const docs = db.entities.Docs
      if (op === "put" || op === "create" || op === "upsert") return docs[op](payload).asEffect()
      const update = (op === "patch" ? docs.patch({ id: "a" }) : docs.update({ id: "a" })).set(
        payload,
      )
      return op === "a transaction's update"
        ? api.Transaction.transactWrite([update])
        : update.asEffect()
    },
  }
})

// ---------------------------------------------------------------------------
// The table's TTL attribute, on an entity that doesn't write it
// ---------------------------------------------------------------------------

/** `versioned: { ttl }` without `retain` writes no snapshot, so no TTL attribute. */
export const ttlNamed: ReadonlyArray<Case> = [false, true].map(
  (transaction): Case => ({
    key: `.add() of the table's TTL attribute on an entity that never writes it, ${transaction ? "in a transaction" : "alone"}`,
    entity: (api) => ({ model: counted(api, Schema.Number), versioned: { ttl: "1 day" } }),
    ttlAttribute: "data#expires",
    seed: (db) => db.entities.Docs.put({ id: "a", note: "before", data: { ok: 1 } }).asEffect(),
    run: (db, api) => {
      const update = db.entities.Docs.update({ id: "a" }).add({ "data#expires": 2 })
      return transaction ? api.Transaction.transactWrite([update]) : update.asEffect()
    },
    attribute: "data#expires",
  }),
)

export const cases: ReadonlyArray<Case> = [...entryOps, ...conditional, ...refRead, ...ttlNamed]
