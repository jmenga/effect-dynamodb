/**
 * Paths below a top-level field, on a model that renames top-level fields, and the requests each
 * operation sends for them.
 *
 * `count`, `list`, `tags` and `name` are stored as `renamed`, `items`, `labels` and `label`, and
 * `meta` holds properties of the same four names. A rename is a top-level attribute's name: `put`
 * stores `meta.count` as `count`.
 *
 * `test/fixtures/nested-path-requests-1.39.0.json` holds what the published 1.39.0 sent for every
 * case in `unaffected`: a path with no segment below the first that is spelled as a renamed field.
 * `test/NestedPathRename.test.ts` runs them against this source and compares the requests whole.
 * The cases in `affected` name such a segment, where 1.39.0 renamed it.
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

export const variants = ["plain", "retain"] as const
export type Variant = (typeof variants)[number]

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}

class Owner extends Schema.Class<Owner>("Owner")({
  id: Schema.String,
  name: Schema.String,
  count: Schema.Number,
}) {}

const fields = (api: Api) => ({
  id: Schema.String,
  name: Schema.String,
  count: Schema.Number,
  list: Schema.Array(Schema.Number),
  tags: Schema.ReadonlySet(Schema.String),
  meta: Schema.Struct({
    count: Schema.Number,
    list: Schema.Array(Schema.Number),
    tags: Schema.optionalKey(Schema.ReadonlySet(Schema.String)),
    name: Schema.optionalKey(Schema.String),
    n: Schema.Number,
    steps: Schema.Array(Schema.Number),
    flags: Schema.ReadonlySet(Schema.String),
    opt: Schema.optionalKey(Schema.Number),
    inner: Schema.Struct({ count: Schema.Number, n: Schema.Number }),
  }),
  // A ref is stored as the map of the entity it names, under that entity's own field names.
  owner: Owner.pipe(api.DynamoModel.ref),
})

export const definitions = (api: Api, variant: Variant) => {
  const Owners = api.Entity.make({
    model: api.DynamoModel.configure(Owner, { id: { identifier: true } }),
    entityType: "Owner",
    primaryKey,
  })
  const Docs = api.Entity.make({
    model: api.DynamoModel.configure(Schema.Struct(fields(api)), {
      name: { field: "label" },
      count: { field: "renamed" },
      list: { field: "items" },
      tags: { field: "labels" },
    }),
    entityType: "Doc",
    primaryKey,
    refs: { owner: { entity: Owners } },
    ...(variant === "retain" ? { versioned: { retain: true } } : {}),
  })
  const Main = api.Table.make({
    schema: api.DynamoSchema.make({ name: "nested", version: 1 }),
    entities: { Docs, Owners },
  })
  return { Docs, Owners, Main }
}

export const seed = (id: string): Record<string, unknown> => ({
  id,
  name: "doc",
  count: 1,
  list: [1],
  tags: new Set(["a", "b"]),
  meta: {
    count: 5,
    list: [5],
    tags: new Set(["a", "b"]),
    n: 6,
    steps: [6],
    flags: new Set(["a", "b"]),
    inner: { count: 7, n: 8 },
  },
  ownerId: "o",
})

type Segments = ReadonlyArray<string | number>
/** What a case runs: an operation on item `a`, built from the bound client. */
export type Run = (db: any, api: Api) => any

const update = (db: any) => db.entities.Docs.update({ id: "a" })
const set =
  (segments: Segments, value: unknown): Run =>
  (db) =>
    update(db).pathSet({ segments, value, isPath: false })
const copy =
  (segments: Segments, valueSegments: Segments): Run =>
  (db) =>
    update(db).pathSet({ segments, value: undefined, isPath: true, valueSegments })
const add =
  (segments: Segments, value: unknown): Run =>
  (db) =>
    update(db).pathAdd({ segments, value })
const subtract =
  (segments: Segments, value: number): Run =>
  (db) =>
    update(db).pathSubtract({ segments, value, isPath: false })
const append =
  (segments: Segments, value: unknown): Run =>
  (db) =>
    update(db).pathAppend({ segments, value })
const prepend =
  (segments: Segments, value: unknown): Run =>
  (db) =>
    update(db).pathPrepend({ segments, value })
const ifNotExists =
  (segments: Segments, value: unknown): Run =>
  (db) =>
    update(db).pathIfNotExists({ segments, value })
const remove =
  (segments: Segments): Run =>
  (db) =>
    update(db).pathRemove(segments)
const del =
  (segments: Segments, value: unknown): Run =>
  (db) =>
    update(db).pathDelete({ segments, value })
/** An update of another field under a condition on the path `pick` names. */
const where =
  (pick: (t: any) => any, value: unknown): Run =>
  (db) =>
    update(db)
      .set({ name: "next" })
      .condition((t: any, { eq }: any) => eq(pick(t), value))

export interface Case {
  readonly name: string
  readonly run: Run
  /** A query: collected, not written. */
  readonly reads?: true
  /** A put of an entity with a ref, which a transaction doesn't take. */
  readonly aloneOnly?: true
}

/** No segment below the first is spelled as a renamed field: the requests are 1.39.0's. */
export const unaffected: ReadonlyArray<Case> = [
  { name: "pathSet", run: set(["meta", "n"], 9) },
  { name: "pathAdd", run: add(["meta", "n"], 1) },
  { name: "pathSubtract", run: subtract(["meta", "n"], 1) },
  { name: "pathAppend", run: append(["meta", "steps"], [7]) },
  { name: "pathPrepend", run: prepend(["meta", "steps"], [7]) },
  { name: "pathIfNotExists", run: ifNotExists(["meta", "opt"], 3) },
  { name: "pathRemove", run: remove(["meta", "opt"]) },
  { name: "pathDelete", run: del(["meta", "flags"], new Set(["a"])) },
  { name: "pathSet of a copy", run: copy(["meta", "n"], ["meta", "inner", "n"]) },
  { name: "pathSet two levels down", run: set(["meta", "inner", "n"], 9) },
  { name: "pathSet of a renamed field", run: set(["count"], 2) },
  { name: "pathAdd to a renamed field", run: add(["count"], 1) },
  { name: "pathAppend to a renamed field", run: append(["list"], [2]) },
  { name: "pathSet of an element of a renamed field", run: set(["list", 0], 9) },
  { name: "pathDelete from a renamed field", run: del(["tags"], new Set(["a"])) },
  { name: "pathSet of a copy of a renamed field", run: copy(["meta", "n"], ["count"]) },
  { name: "a condition on a path", run: where((t) => t.meta.n, 6) },
  { name: "a condition on a path two levels down", run: where((t) => t.meta.inner.n, 8) },
  { name: "a condition on a renamed field", run: where((t) => t.count, 1) },
  {
    name: "a shorthand condition on a renamed field",
    run: (db) => update(db).set({ count: 2 }).condition({ name: "doc" }),
  },
  {
    name: "a delete's condition on a path",
    run: (db) =>
      db.entities.Docs.delete({ id: "a" }).condition((t: any, { eq }: any) => eq(t.meta.n, 6)),
  },
  {
    name: "a put's condition on a path",
    run: (db) =>
      db.entities.Docs.put({ ...seed("a"), name: "next" }).condition((t: any, { eq }: any) =>
        eq(t.meta.n, 6),
      ),
    aloneOnly: true,
  },
  {
    name: "a filter on a path",
    reads: true,
    run: (db) => db.entities.Docs.scan().filter((t: any, { eq }: any) => eq(t.meta.n, 6)),
  },
  {
    name: "a filter on a renamed field",
    reads: true,
    run: (db) => db.entities.Docs.scan().filter((t: any, { eq }: any) => eq(t.count, 1)),
  },
  {
    name: "a select of a path and a renamed field",
    reads: true,
    run: (db) => db.entities.Docs.scan().select((t: any) => [t.meta.n, t.count]),
  },
]

/** What a case in `affected` leaves: the stored value at a path of item `a`'s row. */
export interface Affected extends Case {
  /** The path in the stored row, by stored names, and the attribute value there afterwards. */
  readonly at: ReadonlyArray<string>
  /** `undefined`: the attribute is gone. Left out: the row is gone, or the case writes nothing. */
  readonly stored?: unknown
  /** The path the case's expression names, where it isn't `at`. */
  readonly named?: string
  /** The mock table can't evaluate the expression: only the names are checked. */
  readonly namesOnly?: true
}

/**
 * A segment below the first is spelled as a renamed field. Each names the property `put` stored
 * (`meta.count`), where 1.39.0 named the renamed attribute's (`meta.renamed`).
 */
export const affected: ReadonlyArray<Affected> = [
  { name: "pathSet", run: set(["meta", "count"], 9), at: ["meta", "count"], stored: { N: "9" } },
  { name: "pathAdd", run: add(["meta", "count"], 1), at: ["meta", "count"], stored: { N: "6" } },
  {
    name: "pathSubtract",
    run: subtract(["meta", "count"], 1),
    at: ["meta", "count"],
    stored: { N: "4" },
  },
  {
    name: "pathAppend",
    run: append(["meta", "list"], [7]),
    at: ["meta", "list"],
    stored: { L: [{ N: "5" }, { N: "7" }] },
  },
  {
    name: "pathPrepend",
    run: prepend(["meta", "list"], [7]),
    at: ["meta", "list"],
    stored: { L: [{ N: "7" }, { N: "5" }] },
  },
  {
    name: "pathIfNotExists",
    run: ifNotExists(["meta", "name"], "x"),
    at: ["meta", "name"],
    stored: { S: "x" },
  },
  { name: "pathRemove", run: remove(["meta", "tags"]), at: ["meta", "tags"], stored: undefined },
  {
    name: "pathDelete",
    run: del(["meta", "tags"], new Set(["a"])),
    at: ["meta", "tags"],
    stored: { SS: ["b"] },
  },
  {
    name: "pathSet of a copy to it",
    run: copy(["meta", "count"], ["meta", "inner", "count"]),
    at: ["meta", "count"],
    stored: { N: "7" },
  },
  {
    name: "pathSet of a copy from it",
    run: copy(["meta", "n"], ["meta", "count"]),
    at: ["meta", "n"],
    stored: { N: "5" },
  },
  {
    name: "pathSet two levels down",
    run: set(["meta", "inner", "count"], 9),
    at: ["meta", "inner", "count"],
    stored: { N: "9" },
  },
  {
    // The ref's map holds the owner under the owner's own names.
    name: "pathSet below a ref",
    run: set(["owner", "name"], "Oz"),
    at: ["owner", "name"],
    stored: { S: "Oz" },
  },
  {
    name: "a condition on it",
    run: where((t) => t.meta.count, 5),
    named: "meta.count",
    at: ["label"],
    stored: { S: "next" },
  },
  {
    name: "a condition on it two levels down",
    run: where((t) => t.meta.inner.count, 7),
    named: "meta.inner.count",
    at: ["label"],
    stored: { S: "next" },
  },
  {
    name: "a condition on the size of it",
    run: (db) =>
      update(db)
        .set({ name: "next" })
        .condition((t: any, { gt }: any) => gt(t.meta.list.size(), 0)),
    at: ["meta", "list"],
    namesOnly: true,
  },
  {
    name: "a delete's condition on it",
    run: (db) =>
      db.entities.Docs.delete({ id: "a" }).condition((t: any, { eq }: any) => eq(t.meta.count, 5)),
    at: ["meta", "count"],
  },
  {
    name: "a put's condition on it",
    run: (db) =>
      db.entities.Docs.put({ ...seed("a"), name: "next" }).condition((t: any, { eq }: any) =>
        eq(t.meta.count, 5),
      ),
    named: "meta.count",
    at: ["label"],
    stored: { S: "next" },
    aloneOnly: true,
  },
  {
    name: "a filter on it",
    reads: true,
    run: (db) => db.entities.Docs.scan().filter((t: any, { eq }: any) => eq(t.meta.count, 5)),
    at: ["meta", "count"],
  },
  {
    name: "a select of it",
    reads: true,
    run: (db) => db.entities.Docs.scan().select((t: any) => [t.meta.count]),
    at: ["meta", "count"],
  },
]

/** Each case, on each variant, alone and (for a write) in a transaction. */
export const matrix: ReadonlyArray<{
  readonly key: string
  readonly variant: Variant
  readonly transaction: boolean
  readonly each: Case
}> = unaffected.flatMap((each) =>
  variants.flatMap((variant) =>
    (each.reads || each.aloneOnly ? [false] : [false, true]).map((transaction) => ({
      key: `${each.name} / ${variant} / ${transaction ? "in a transaction" : "alone"}`,
      variant,
      transaction,
      each,
    })),
  ),
)

/** JSON as a fixture holds it. */
export const plain = <A>(value: A): A =>
  JSON.parse(JSON.stringify(value, (_key, held) => (held instanceof Set ? [...held] : held)))

export interface Captured {
  readonly ok: boolean
  readonly requests: ReadonlyArray<{ readonly command: string; readonly input: any }>
  /** The row of item `a` afterwards. */
  readonly row: Record<string, any> | undefined
  /** Item `a` as a read returns it afterwards, or `undefined` when the read fails. */
  readonly read: Record<string, any> | undefined
  /** What a query collected. */
  readonly collected: unknown
  readonly error: unknown
}

/** Seeds items `a` and `b`, runs the case on `a`, and returns what was sent and stored. */
export const capture = (
  api: Api,
  variant: Variant,
  transaction: boolean,
  each: Case,
): Effect.Effect<Captured> => {
  const { Docs, Owners, Main } = definitions(api, variant)
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* api.DynamoClient.make({ entities: { Docs, Owners }, tables: { Main } })
    yield* db.entities.Owners.put({ id: "o", name: "Olive", count: 3 }).asEffect()
    yield* db.entities.Docs.put(seed("a")).asEffect()
    yield* db.entities.Docs.put(seed("b")).asEffect()
    table.take()
    const exit = yield* Effect.exit(
      Effect.suspend(() => {
        const op = each.run(db, api)
        if (each.reads) return op.collect()
        return transaction
          ? api.Transaction.transactWrite([
              db.entities.Docs.update({ id: "b" }).set({ count: 2 }),
              op,
            ])
          : op.asEffect()
      }),
    )
    const requests = plain(table.take())
    const read = yield* Effect.exit(db.entities.Docs.get({ id: "a" }))
    const row = [...table.items.values()].find(
      (item) => item.id?.S === "a" && item.sk?.S === "$nested#v1#doc",
    )
    return {
      ok: Exit.isSuccess(exit),
      requests,
      row: row === undefined ? undefined : plain(row),
      read: Exit.isSuccess(read) ? plain(read.value as Record<string, any>) : undefined,
      collected: each.reads && Exit.isSuccess(exit) ? plain(exit.value) : undefined,
      error: Exit.isFailure(exit) ? exit.cause : undefined,
    }
  }).pipe(
    Effect.provide(Main.layer({ name: "t" })),
    Effect.provide(Layer.succeed(api.DynamoClient, table.client)),
    Effect.provide(
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((n) => new Uint8Array(n).fill(7)),
      ),
    ),
  ) as unknown as Effect.Effect<Captured>
}
