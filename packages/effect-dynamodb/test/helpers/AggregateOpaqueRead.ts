/**
 * `create`'s judgement (#241, `EDD-9159`) on a root or sub-aggregate whose schema can't place a
 * field exactly: a union or a suspended schema. Such a node is read whole, by the schema `get`
 * decodes it with, from the rows the create builds. Each case gives, at the top of such a node's
 * value, a name the library writes on its row (the sort key attribute `sk`, the context attribute
 * `tenant`), with a value of its own or the library's. `fixtures/aggregate-opaque-read-1.40.0.json`
 * holds what published 1.40.0 did: its create's result, the rows it wrote and its `get`.
 *
 * No runtime import: every schema is made with the release's own modules (`OpaqueLib`).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { Cause, Effect, Exit, Layer, Schema } from "effect"

export type Row = Record<string, AttributeValue>
export type Outcome = { readonly ok?: unknown; readonly failed?: string; readonly cause?: string }
export type Recorded = {
  readonly create: Outcome
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
}

export type OpaqueLib = {
  readonly Aggregate: any
  readonly DynamoClient: any
  readonly Table: any
  readonly DynamoSchema: any
  readonly Schema: typeof Schema
  readonly Effect: typeof Effect
  readonly Exit: typeof Exit
  readonly Cause: typeof Cause
  readonly Layer: typeof Layer
}

type Kind = "union root" | "suspended root" | "union sub-aggregate" | "union sub-aggregate, an edge"

export type Case = {
  readonly name: string
  readonly kind: Kind
  readonly escapeKeys: boolean
  /** The value given for the name the library writes: `sk` on a root, `tenant` on a sub-aggregate. */
  readonly given: string | undefined
}

const givens: Readonly<Record<Kind, ReadonlyArray<string | undefined>>> = {
  // A root's `sk`: the library writes its own sort key there.
  "union root": ["caller", undefined],
  "suspended root": ["caller", undefined],
  // A sub-aggregate's `tenant`: the root's, copied by `context`.
  "union sub-aggregate": ["different", "t", undefined],
  "union sub-aggregate, an edge": ["different", "t", undefined],
}

export const cases: ReadonlyArray<Case> = (Object.keys(givens) as ReadonlyArray<Kind>).flatMap(
  (kind) =>
    [false, true].flatMap((escapeKeys) =>
      givens[kind].map((given) => ({
        name: `${kind}, given ${given === undefined ? "none" : JSON.stringify(given)}, escapeKeys ${escapeKeys ? "on" : "off"}`,
        kind,
        escapeKeys,
        given,
      })),
    ),
)

export const define = (lib: OpaqueLib, c: Case) => {
  const { Aggregate: A, Schema } = lib
  const schema = lib.DynamoSchema.make({ name: "opq", version: 1, escapeKeys: c.escapeKeys })
  const Main = lib.Table.make({ schema, entities: {} })
  const common = {
    schema,
    table: Main,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "agg" },
    root: { entityType: "Root" },
    context: ["tenant"],
  }
  if (c.kind === "union root" || c.kind === "suspended root") {
    const struct = Schema.Struct({
      id: Schema.String,
      tenant: Schema.String,
      sk: Schema.optional(Schema.String),
    })
    const model =
      c.kind === "union root"
        ? Schema.Union([struct, Schema.Struct({ id: Schema.Number, tenant: Schema.String })])
        : Schema.suspend(() => struct)
    const Agg = A.make(model, { ...common, edges: {} })
    const input = { id: "a", tenant: "t", ...(c.given !== undefined && { sk: c.given }) }
    return { Main, Agg, input }
  }
  const member = (x: string) =>
    Schema.Struct({
      tenant: Schema.optional(Schema.String),
      x: Schema.Literal(x),
      ...(c.kind === "union sub-aggregate, an edge" && {
        tag: Schema.Struct({ text: Schema.String }),
      }),
    })
  const Part = Schema.Union([member("a"), member("b")])
  const Agg = A.make(Schema.Struct({ id: Schema.String, tenant: Schema.String, part: Part }), {
    ...common,
    edges: {
      part: A.make(Part, {
        root: { entityType: "Part" },
        edges:
          c.kind === "union sub-aggregate, an edge" ? { tag: A.one({ entityType: "Tag" }) } : {},
      }).with({ discriminator: { side: 1 } }),
    },
  })
  const input = {
    id: "a",
    tenant: "t",
    part: {
      ...(c.given !== undefined && { tenant: c.given }),
      x: "a",
      ...(c.kind === "union sub-aggregate, an edge" && { tag: { text: "n" } }),
    },
  }
  return { Main, Agg, input }
}

const outcomeOf = (lib: OpaqueLib, exit: any): Outcome => {
  if (lib.Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const error = lib.Cause.squash(exit.cause) as { _tag?: string; cause?: unknown; reason?: unknown }
  const cause =
    typeof error.reason === "string"
      ? error.reason
      : error.cause instanceof Error
        ? error.cause.message
        : undefined
  return { failed: error._tag ?? "defect", ...(cause !== undefined && { cause }) }
}

export type OpaqueIo = {
  readonly tableName: string
  readonly client: any
  readonly scan: () => Effect.Effect<ReadonlyArray<Row>, unknown>
}

const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`
export const sortRows = (rows: ReadonlyArray<Row>): Array<Row> =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

/** The case's `create`, the rows after it, and a `get`. */
export const runOpaque = (
  lib: OpaqueLib,
  c: Case,
  io: OpaqueIo,
): Effect.Effect<Recorded, unknown> => {
  const { Effect, Layer } = lib
  const { Main, Agg, input } = define(lib, c)
  return Effect.gen(function* () {
    const db: any = yield* lib.DynamoClient.make({
      entities: {},
      aggregates: { Agg },
      tables: { Main },
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(lib.DynamoClient, io.client), Main.layer({ name: io.tableName })),
      ),
    )
    const agg = db.aggregates.Agg
    const create = outcomeOf(lib, yield* Effect.exit(agg.create(input)))
    const rows = sortRows(yield* io.scan())
    const get = outcomeOf(lib, yield* Effect.exit(agg.get({ id: "a" })))
    return { create, rows, get }
  }) as unknown as Effect.Effect<Recorded, unknown>
}
