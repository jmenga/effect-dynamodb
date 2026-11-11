/**
 * `pathIfNotExists` with an operand a check refuses, on every write path an update with a path
 * operation takes (#236): the table of cases `PathIfNotExistsFallback.test.ts` runs on the
 * recording table and `connected.path-if-not-exists.test.ts` on DynamoDB Local.
 *
 * DynamoDB stores a `pathIfNotExists` operand only where the row lacks the path; where the path is
 * there it keeps the stored value. So the operand is refused only where the row lacks the path: an
 * update that reads its row decides on that read, one that doesn't sends its write requiring the
 * path, and decides on the row DynamoDB's refusal returns.
 *
 * What 1.40.0 did, measured on DynamoDB Local, is each position's `on140`: it refused the operand
 * at a top-level attribute and a struct's property wherever the path was, before sending anything
 * (a retained update after its read), even with a version the row isn't at; at a sparse map's
 * entry's property it didn't check it, so it kept the stored value where the row held the path,
 * stored `-1` where it didn't (a row that no longer reads), and refused a version the row isn't at
 * with `OptimisticLockError`.
 */

import { Schema } from "effect"
import * as Lib from "../../src/index.js"

const Positive = Schema.Number.check(Schema.isGreaterThan(0))
const Counted = Schema.Struct({ n: Schema.optional(Positive) })

export const model = Lib.DynamoModel.configure(
  Schema.Struct({
    id: Schema.String,
    email: Schema.optional(Schema.String),
    n: Schema.optional(Positive),
    meta: Schema.optional(Counted),
    entries: Schema.Record(Schema.String, Counted),
    tags: Schema.Record(Schema.String, Schema.Number),
    blob: Schema.Struct({ v: Schema.Number }),
  }),
  {
    entries: { storedAs: Lib.DynamoModel.SparseMap() },
    tags: { storedAs: Lib.DynamoModel.SparseMap() },
    blob: { immutable: true, storedAs: Lib.DynamoModel.Packed({ format: "json" }) },
  },
)

/** Each write path: the entity's configuration and what the update carries besides the operation. */
export const paths: ReadonlyArray<{
  readonly name: string
  readonly entity: Record<string, unknown>
  readonly prefix: (update: any) => any
}> = [
  { name: "plain", entity: {}, prefix: (u) => u },
  { name: "retained", entity: { versioned: { retain: true } }, prefix: (u) => u },
  {
    name: "versioned, expecting the row's version",
    entity: { versioned: true },
    prefix: (u) => u.expectedVersion(1),
  },
  {
    name: "unique, not setting the unique field",
    entity: { unique: { email: ["email"] } },
    prefix: (u) => u,
  },
  {
    name: "restating a packed immutable",
    entity: {},
    prefix: (u) => u.set({ blob: { v: 1 } }),
  },
  { name: "clearing a sparse map", entity: {}, prefix: (u) => u.clearMap("tags") },
]

const REFUSED = "ValidationError (update.pathIfNotExists)"

/** Where the operand goes: each position held by row `here`, and lacked by row `absent`. */
export const positions: ReadonlyArray<{
  readonly name: string
  readonly segments: ReadonlyArray<string | number>
  /** What 1.40.0 did where the row held the path, where it lacked it, and at another version. */
  readonly on140: { readonly here: string; readonly absent: string; readonly stale: string }
}> = [
  {
    name: "a top-level attribute",
    segments: ["n"],
    on140: { here: REFUSED, absent: REFUSED, stale: REFUSED },
  },
  {
    name: "a struct's property",
    segments: ["meta", "n"],
    on140: { here: REFUSED, absent: REFUSED, stale: REFUSED },
  },
  {
    name: "a sparse map's entry's property",
    segments: ["entries#x", "n"],
    on140: {
      here: "written, value kept",
      absent: "stored -1, the row no longer reads",
      stale: "OptimisticLockError",
    },
  },
]

/**
 * The rows: `here` holds every position, `absent` none, `orphan` not even `meta`; `other` is the
 * row a transaction's other update writes.
 */
export const rows = {
  here: { id: "here", n: 1, meta: { n: 1 }, entries: { x: { n: 1 } }, tags: { t: 1 } },
  absent: { id: "absent", meta: {}, entries: { x: {} }, tags: { t: 1 } },
  orphan: { id: "orphan", entries: {}, tags: {} },
  other: { id: "other", entries: {}, tags: {} },
} as const

export const seed = (id: keyof typeof rows) => ({ ...rows[id], blob: { v: 1 } })

/** The entity a path's cases run on, with its table. */
export const definitions = (path: (typeof paths)[number]) => {
  const E = Lib.Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...path.entity,
  } as never) as any
  const Main = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "fallback", version: 1 }),
    entities: { E },
  } as never) as any
  return { E, Main }
}

/** The update of `id` a case sends, alone or in a transaction after another update. */
export const send = (
  db: any,
  path: (typeof paths)[number],
  segments: ReadonlyArray<string | number>,
  id: string,
  value: unknown,
  transaction: boolean,
) => {
  const op = path.prefix(db.entities.E.update({ id })).pathIfNotExists({ segments, value })
  return transaction
    ? Lib.Transaction.transactWrite([db.entities.E.update({ id: "other" }).set({ n: 2 }), op])
    : op.asEffect()
}

/** The value at `segments` in a row as it reads (`entries#x` the entry `x`). */
export const valueAt = (row: any, segments: ReadonlyArray<string | number>): unknown => {
  let at = row
  for (const segment of segments) {
    const [field, entry] = String(segment).split("#")
    at = at?.[field!]
    if (entry !== undefined) at = at?.[entry]
  }
  return at
}
