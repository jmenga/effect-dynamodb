/**
 * An `upsert` given `undefined` for a sparse map with a decoding default, over a row that's there
 * (#236 section 6, resolved as intended behaviour): every upsert path stores the default's
 * entries beside the stored ones, the rule of 1.40.0 ("A default no key holds is stored on both
 * paths").
 *
 * The paths: the expression path (an entity with none of the below, sent as one `UpdateItem`), and
 * the paths that read the row first: an entity with `unique` naming a field outside the primary
 * key (the unique value restated or changed), one with `unique` naming only a primary-key
 * composite, one with `versioned: { retain: true }`, and an input leaving out a defaulted index
 * composite. 1.39.0 gave one input three outcomes by configuration: the expression path stored
 * the default's entries; `unique` outside the primary key and `retain` removed every entry and
 * wrote none; `unique` on the primary key and the defaulted-composite path left the entries alone
 * and wrote none. The read-first paths give the expression path's. Leaving `data` out leaves the
 * stored entries alone on every path.
 *
 * A default holding a key the write refuses is refused, citing the default, with nothing sent, as
 * each path does on 1.40.0: an empty key and one holding `#` on every path (the expression path
 * always refused them; 1.39.0 wrote none of the default on the others), and an attribute name over
 * 255 bytes where the upsert writes the row whole: `unique` outside the primary key, and `retain`.
 * The expression path, `unique` on the primary key and the defaulted-composite path store that one.
 */

import { Effect, Schema } from "effect"

export type UpsertPath =
  | "expression"
  | "unique"
  | "unique on the primary key"
  | "retain"
  | "defaulted composite"
export type DefaultKind =
  | "no refused key"
  | "an empty key"
  | "a key holding #"
  | "an attribute name over 255 bytes"
export type UpsertInput = "data: undefined" | "data: undefined, note changed" | "data left out"

export const LONG = "k".repeat(260)

export const DEFAULTS: Record<DefaultKind, Record<string, number>> = {
  "no refused key": { d1: 1, d2: 2 },
  "an empty key": { "": 1 },
  "a key holding #": { "a#b": 1 },
  "an attribute name over 255 bytes": { [LONG]: 1 },
}

export const INPUTS: Record<UpsertInput, Record<string, unknown>> = {
  "data: undefined": { id: "a", note: "x", data: undefined },
  "data: undefined, note changed": { id: "a", note: "y", data: undefined },
  "data left out": { id: "a", note: "x" },
}

const PATHS: Record<UpsertPath, Record<string, unknown>> = {
  expression: {},
  unique: { unique: { note: ["note"] } },
  "unique on the primary key": { unique: { id: ["id"] } },
  retain: { versioned: { retain: true } },
  // `status` has a decoding default and no input gives it.
  "defaulted composite": {
    indexes: {
      byStatus: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["status"] },
        sk: { field: "gsi1sk", composite: ["id"] },
      },
    },
  },
}

export interface UpsertCase {
  readonly path: UpsertPath
  readonly kind: DefaultKind
  readonly input: UpsertInput
}

export const cases: ReadonlyArray<UpsertCase> = (Object.keys(PATHS) as Array<UpsertPath>).flatMap(
  (path) =>
    (Object.keys(DEFAULTS) as Array<DefaultKind>).flatMap((kind) =>
      (Object.keys(INPUTS) as Array<UpsertInput>).map((input) => ({ path, kind, input })),
    ),
)

export const nameOf = (each: UpsertCase) =>
  `${each.path}, a default with ${each.kind}, ${each.input}`

/** The library's public modules, `src` or a release. */
export interface Api {
  readonly DynamoClient: any
  readonly DynamoModel: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly Table: any
}

/** The entity and table of a case. */
export const definitions = (api: Api, each: UpsertCase) => {
  const E = api.Entity.make({
    entityType: "E",
    model: api.DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        note: Schema.String,
        status: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("open"))),
        data: Schema.Record(Schema.String, Schema.Number).pipe(
          Schema.withDecodingDefault(Effect.succeed(DEFAULTS[each.kind])),
        ),
      }),
      { data: { storedAs: api.DynamoModel.SparseMap() } },
    ),
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...PATHS[each.path],
  })
  const Main = api.Table.make({
    schema: api.DynamoSchema.make({ name: "upserts", version: 1 }),
    entities: { E },
  })
  return { E, Main }
}

/** Item `a`'s key. */
export const ROW_KEY = { pk: { S: "$upserts#v1#e#id_a" }, sk: { S: "$upserts#v1#e" } }

/** Seeds item `a` with one entry, `data#k`. */
export const seed = (db: any) =>
  db.entities.E.put({ id: "a", note: "x", status: "open", data: { k: 5 } }).asEffect()

/** The upsert of a case. */
export const upsert = (db: any, each: UpsertCase) =>
  Effect.suspend(() => db.entities.E.upsert(INPUTS[each.input]).asEffect())

/** A row's sparse entries, by attribute name, sorted. */
export const entriesOf = (row: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  Object.keys(row ?? {})
    .filter((name) => name.startsWith("data#"))
    .sort()

export interface UpsertExpected {
  /** The failure's tag and operation; `undefined` where the upsert completes. */
  readonly failure: { readonly error: string; readonly operation: string } | undefined
  /** `data` as a read returns it afterwards. */
  readonly data: Record<string, number>
}

export const expected = (each: UpsertCase): UpsertExpected => {
  const writesDefault = each.input !== "data left out"
  const refused =
    writesDefault &&
    (each.kind === "an empty key" ||
      each.kind === "a key holding #" ||
      (each.kind === "an attribute name over 255 bytes" &&
        (each.path === "unique" || each.path === "retain")))
  return refused
    ? { failure: { error: "ValidationError", operation: "upsert.sparse" }, data: { k: 5 } }
    : {
        failure: undefined,
        data: writesDefault ? { k: 5, ...DEFAULTS[each.kind] } : { k: 5 },
      }
}

/** `data`'s entries as stored, sorted. */
export const storedEntries = (data: Record<string, number>): ReadonlyArray<string> =>
  Object.keys(data)
    .map((key) => `data#${key}`)
    .sort()
