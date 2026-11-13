/**
 * A write given `undefined` for a field with a decoding default (a sparse map's) beside a field
 * with a transform (`n: Schema.NumberFromString`), its other values in the domain form (`n: 1`):
 * `{ id, n: 1, data: undefined }` (#236). Every write that encodes an input takes it as it takes
 * the same input beside `n: Schema.Number`: `data` holds its default, `{ d: 1 }`, which a `put`
 * or `create` stores in place of what the row held and an `upsert` stores beside the stored
 * entries. 1.40.0 refused it beside the transform with a `ValidationError` and nothing written, on
 * every path (`put.decode` / `upsert.decode`: "Expected object at ["data"]"; in a transaction
 * `transactWrite.put`, in a batch `batchWrite.put`: "Expected string at ["n"]"): the input was
 * neither wholly in the domain form (`data: undefined`) nor wholly in the stored form (`n: 1`).
 * The same input beside `n: Schema.Number`, and leaving `data` out beside either, are unchanged
 * on every path. The cases run on the recording table
 * (`UndefinedBesideTransform.test.ts`) and on DynamoDB Local
 * (`connected.undefined-beside-transform.test.ts`).
 */

import { Effect, Schema } from "effect"

export type Neighbour = "n: Schema.NumberFromString" | "n: Schema.Number"
export type WritePath = "plain" | "unique" | "retain"
export type Write =
  | "put"
  | "create"
  | "upsert"
  | "put in a transaction"
  | "create in a transaction"
  | "put in a batch"
export type Input = "data: undefined" | "data left out"

const NEIGHBOURS: Record<Neighbour, Schema.Top> = {
  "n: Schema.NumberFromString": Schema.NumberFromString,
  "n: Schema.Number": Schema.Number,
}

const PATHS: Record<WritePath, Record<string, unknown>> = {
  plain: {},
  unique: { unique: { email: ["email"] } },
  retain: { versioned: { retain: true } },
}

export const INPUTS: Record<Input, Record<string, unknown>> = {
  "data: undefined": { id: "a", n: 1, data: undefined },
  "data left out": { id: "a", n: 1 },
}

const WRITES: ReadonlyArray<Write> = [
  "put",
  "create",
  "upsert",
  "put in a transaction",
  "create in a transaction",
  "put in a batch",
]

export interface UndefinedCase {
  readonly neighbour: Neighbour
  readonly path: WritePath
  readonly write: Write
  readonly input: Input
  /** Whether item `a` is there before the write. */
  readonly overRow: boolean
}

export const cases: ReadonlyArray<UndefinedCase> = (
  Object.keys(NEIGHBOURS) as Array<Neighbour>
).flatMap((neighbour) =>
  (Object.keys(PATHS) as Array<WritePath>).flatMap((path) =>
    // A batch takes a put of neither a unique nor a retained entity.
    WRITES.filter((write) => write !== "put in a batch" || path === "plain").flatMap((write) =>
      (Object.keys(INPUTS) as Array<Input>).flatMap((input) =>
        [false, true]
          .filter((overRow) => !(overRow && write.startsWith("create")))
          .map((overRow) => ({ neighbour, path, write, input, overRow })),
      ),
    ),
  ),
)

export interface Expected {
  /** `data` as a read returns it afterwards. */
  readonly data: Record<string, number>
}

/** What a case stores: the same beside either neighbour. */
export const expected = (each: UndefinedCase): Expected => {
  const stored = each.overRow ? { s: 5 } : {}
  const given = each.input === "data: undefined" ? { d: 1 } : {}
  // An upsert keeps the stored entries; a put or create writes the row whole.
  return { data: each.write === "upsert" ? { ...stored, ...given } : given }
}

/** What 1.40.0 did, measured on DynamoDB Local. */
export const on140 = (each: UndefinedCase): string => {
  if (each.neighbour !== "n: Schema.NumberFromString" || each.input !== "data: undefined") {
    return "the same"
  }
  const operation = each.write.endsWith("in a transaction")
    ? "transactWrite.put"
    : each.write === "put in a batch"
      ? "batchWrite.put"
      : each.write === "upsert"
        ? "upsert.decode"
        : "put.decode"
  return `ValidationError (${operation}), nothing written`
}

export const nameOf = (each: UndefinedCase) =>
  `${each.neighbour} | ${each.path} | ${each.write} | ${each.input} | ${each.overRow ? "over a row" : "no row"} | stores data ${JSON.stringify(expected(each).data)} | 1.40.0: ${on140(each)}`

/** The library's public modules. */
export interface Api {
  readonly Batch: any
  readonly DynamoModel: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly Table: any
  readonly Transaction: any
}

/** The entity and table of a case. */
export const definitions = (api: Api, each: UndefinedCase) => {
  const E = api.Entity.make({
    entityType: "E",
    model: api.DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        n: NEIGHBOURS[each.neighbour],
        email: Schema.optional(Schema.String),
        data: Schema.Record(Schema.String, Schema.Number).pipe(
          Schema.withDecodingDefault(Effect.succeed({ d: 1 })),
        ),
      }),
      { data: { storedAs: api.DynamoModel.SparseMap() } },
    ),
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...PATHS[each.path],
  })
  const Main = api.Table.make({
    schema: api.DynamoSchema.make({ name: "undefs", version: 1 }),
    entities: { E },
  })
  return { E, Main }
}

/** Item `a` as seeded, where a case is over a row. */
export const seed = (db: any) =>
  db.entities.E.put({ id: "a", n: 7, email: "e", data: { s: 5 } }).asEffect()

/** The write of a case. */
export const send = (api: Api, db: any, each: UndefinedCase) =>
  Effect.suspend(() => {
    const input = INPUTS[each.input]
    switch (each.write) {
      case "put":
        return db.entities.E.put(input).asEffect()
      case "create":
        return db.entities.E.create(input).asEffect()
      case "upsert":
        return db.entities.E.upsert(input).asEffect()
      case "put in a transaction":
        return api.Transaction.transactWrite([db.entities.E.put(input)])
      case "create in a transaction":
        return api.Transaction.transactWrite([db.entities.E.create(input)])
      case "put in a batch":
        return api.Batch.write([db.entities.E.put(input)])
    }
  }) as Effect.Effect<unknown, unknown>
