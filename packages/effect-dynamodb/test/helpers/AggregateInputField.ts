/**
 * A `many` edge given under its `inputField` (#241, `EDD-9159`): a `create` whose input names the
 * edge's value by its alias (`entries` for `lines`), at the root and beneath a sub-aggregate, with a
 * ref the `create` hydrates and without one. Each element declares the root's `context` attribute
 * `tenant`, given the root's value or another. `runInputField` creates the aggregate and reads it,
 * recording what was sent, stored and returned, under each `escapeKeys` setting; `fixtures/aggregate-input-field-1.40.0.json` holds
 * what published 1.40.0 did, captured by running this module with its modules.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { Effect } from "effect"

export type Row = Record<string, AttributeValue>
export type Request = { readonly command: string; readonly input: unknown }
export type Outcome = {
  readonly ok?: unknown
  readonly failed?: string
  readonly member?: string
  readonly reason?: string
}
export type Recorded = {
  readonly create: Outcome
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
}
export type InputFieldLib = {
  readonly Aggregate: any
  readonly Entity: any
  readonly DynamoClient: any
  readonly Table: any
  readonly DynamoSchema: any
  readonly DynamoModel: any
  readonly Schema: any
  readonly Effect: any
  readonly Exit: any
  readonly Cause: any
  readonly Layer: any
}
export type InputFieldIo = {
  readonly tableName: string
  readonly client: any
  readonly take: () => ReadonlyArray<Request>
  readonly scan: () => Effect.Effect<ReadonlyArray<Row>, unknown>
}
export type Case = {
  readonly escape: boolean
  readonly alias: boolean
  readonly sub: boolean
  readonly ref: boolean
  readonly tenant: "root" | "other"
}

export const cases: ReadonlyArray<Case & { readonly label: string }> = [false, true].flatMap(
  (escape) =>
    [false, true].flatMap((alias) =>
      [false, true].flatMap((sub) =>
        [false, true].flatMap((ref) =>
          (["root", "other"] as const).map((tenant) => ({
            escape,
            alias,
            sub,
            ref,
            tenant,
            label:
              `escapeKeys ${escape ? "on" : "off"}, ` +
              `${alias ? "under its inputField" : "under its field"}, ` +
              `${sub ? "beneath a sub-aggregate" : "at the root"}, ` +
              `${ref ? "with a ref hydrated" : "no ref"}, element tenant ${tenant}`,
          })),
        ),
      ),
    ),
)

export const defineInputField = (lib: InputFieldLib, c: Case) => {
  const { Aggregate: A, Schema, DynamoModel: M } = lib
  const Target = Schema.Struct({ tid: Schema.String.pipe(M.identifier), text: Schema.String })
  const Targets = lib.Entity.make({
    model: Target,
    entityType: "Target",
    primaryKey: { pk: { field: "pk", composite: ["tid"] }, sk: { field: "sk", composite: [] } },
  })
  const schema = lib.DynamoSchema.make({ name: "alias", version: 1, escapeKeys: c.escape })
  const Main = lib.Table.make({ schema, entities: { Targets } })
  const Line = Schema.Struct({ id: Schema.String, tenant: Schema.String })
  const Part = Schema.Struct({ lines: Schema.Array(Line) })
  const edges = {
    lines: A.many({
      entityType: "Line",
      sk: { composite: ["id"] },
      ...(c.alias ? { inputField: "entries" } : {}),
    }),
  }
  const model = Schema.Struct({
    id: Schema.String,
    tenant: Schema.String,
    ...(c.ref ? { ref: Target } : {}),
    ...(c.sub ? { part: Part } : { lines: Schema.Array(Line) }),
  })
  const Agg = A.make(model, {
    schema,
    table: Main,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "alias" },
    root: { entityType: "Root" },
    context: ["tenant"],
    edges: {
      ...(c.ref ? { ref: A.one({ entity: Targets, entityType: "Ref" }) } : {}),
      ...(c.sub
        ? {
            part: A.make(Part, { root: { entityType: "Part" }, edges }).with({
              discriminator: { side: 1 },
            }),
          }
        : edges),
    },
  })
  return { Targets, Main, Agg }
}

export const inputOf = (c: Case) => {
  const lines = {
    [c.alias ? "entries" : "lines"]: [{ id: "l", tenant: c.tenant === "root" ? "t1" : "t2" }],
  }
  return {
    id: "a",
    tenant: "t1",
    ...(c.ref ? { refId: "r" } : {}),
    ...(c.sub ? { part: lines } : lines),
  }
}

const outcomeOf = (lib: InputFieldLib, exit: any): Outcome => {
  if (lib.Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const error = lib.Cause.squash(exit.cause) as { _tag?: string; member?: string; reason?: string }
  return {
    failed: error._tag ?? "defect",
    ...(error.member !== undefined && { member: error.member }),
    ...(error.reason !== undefined && { reason: error.reason }),
  }
}
const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`

export const runInputField = (
  lib: InputFieldLib,
  c: Case,
  io: InputFieldIo,
): Effect.Effect<Recorded, unknown> => {
  const { Effect, Layer } = lib
  const { Targets, Main, Agg } = defineInputField(lib, c)
  return Effect.gen(function* () {
    const db: any = yield* lib.DynamoClient.make({
      entities: { Targets },
      aggregates: { Agg },
      tables: { Main },
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(lib.DynamoClient, io.client), Main.layer({ name: io.tableName })),
      ),
    )
    const provided = (effect: any) =>
      effect.pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(lib.DynamoClient, io.client),
            Main.layer({ name: io.tableName }),
          ),
        ),
      )
    yield* provided(db.entities.Targets.put({ tid: "r", text: "ref" }).asEffect())
    io.take()
    const create = outcomeOf(lib, yield* Effect.exit(db.aggregates.Agg.create(inputOf(c))))
    const requests = io.take()
    const rows = [...(yield* io.scan())]
      .filter((row) => row.__edd_e__?.S !== "Target")
      .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
    const get = outcomeOf(lib, yield* Effect.exit(db.aggregates.Agg.get({ id: "a" })))
    io.take()
    return { create, requests, rows, get }
  }) as Effect.Effect<Recorded, unknown>
}
