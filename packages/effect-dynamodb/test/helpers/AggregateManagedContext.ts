/**
 * `context` naming an attribute the library manages on each row (#241): a discriminator, a
 * timestamp it stamps, a key attribute, a member's own field, a key composite. Such an attribute is
 * never a context copy for the stale-context repair, so an aggregate nobody left half-written sends
 * exactly 1.40.0's requests: ten no-op updates send ten `Query`s and nothing else, before and after
 * an update of the root alone. `fixtures/aggregate-managed-context-1.40.0.json` holds what published
 * 1.40.0 sent for each step and the rows its `create` wrote, captured by running this module with
 * its modules.
 *
 * No runtime import: every schema is made with the release's own modules (`ManagedLib`).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { Cause, Effect, Exit, Layer, Schema } from "effect"

export type Row = Record<string, AttributeValue>
export type Request = { readonly command: string; readonly input: unknown }
export type Outcome = { readonly ok?: true; readonly failed?: string; readonly cause?: string }
export type Recorded = {
  readonly create: Outcome
  readonly created: ReadonlyArray<Row>
  readonly steps: ReadonlyArray<{
    readonly step: string
    readonly update: Outcome
    readonly requests: ReadonlyArray<Request>
  }>
}

export type ManagedLib = {
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

type Built = { readonly Main: any; readonly Agg: any; readonly input: unknown }

const base = (lib: ManagedLib) => {
  // The setting the fixture was captured under (1.40.0's default), whatever this run's default is.
  const schema = lib.DynamoSchema.make({ name: "mgd", version: 1, escapeKeys: false })
  const Main = lib.Table.make({ schema, entities: {} })
  return { schema, Main, common: { schema, table: Main, pk: { field: "pk", composite: ["id"] } } }
}

const shapes: Readonly<Record<string, (lib: ManagedLib) => Built>> = {
  "a sub-aggregate's discriminator": (lib) => {
    const { Aggregate: A, Schema } = lib
    const { Main, common } = base(lib)
    const Part = Schema.Struct({ name: Schema.String, tag: Schema.Unknown })
    const Agg = A.make(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        side: Schema.Number,
        part: Part,
        note: Schema.Unknown,
      }),
      {
        ...common,
        collection: { name: "agg" },
        root: { entityType: "Root" },
        context: ["side"],
        edges: {
          note: A.one({ entityType: "Note" }),
          part: A.make(Part, {
            root: { entityType: "Part" },
            edges: { tag: A.one({ entityType: "Tag" }) },
          }).with({ discriminator: { side: 1 } }),
        },
      },
    )
    return {
      Main,
      Agg,
      input: { id: "a", title: "t", side: 7, part: { name: "p", tag: { text: "x" } }, note: {} },
    }
  },
  "a one edge's own discriminator": (lib) => {
    const { Aggregate: A, Schema } = lib
    const { Main, common } = base(lib)
    const Agg = A.make(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        slot: Schema.String,
        note: Schema.Unknown,
      }),
      {
        ...common,
        collection: { name: "agg" },
        root: { entityType: "Root" },
        context: ["slot"],
        edges: { note: A.one({ entityType: "Note", discriminator: { slot: "main" } }) },
      },
    )
    return { Main, Agg, input: { id: "a", title: "t", slot: "x", note: { text: "n" } } }
  },
  ...Object.fromEntries(
    (
      [
        ["updatedAt, declared on the root", "updatedAt", true, true],
        ["updatedAt, not declared on the root", "updatedAt", true, false],
        ["createdAt, declared on the root", "createdAt", true, true],
        ["a renamed updated stamp", "modified", { updated: "modified" }, true],
      ] as const
    ).map(([name, field, timestamps, declared]) => [
      `the timestamp ${name}`,
      (lib: ManagedLib) => {
        const { Aggregate: A, Schema } = lib
        const { Main, common } = base(lib)
        const Line = Schema.Struct({ k: Schema.String, qty: Schema.Number })
        const Agg = A.make(
          Schema.Struct({
            id: Schema.String,
            title: Schema.String,
            ...(declared && { [field]: Schema.optional(Schema.DateTimeUtc) }),
            note: Schema.Unknown,
            lines: Schema.Array(Line),
          }),
          {
            ...common,
            collection: { name: "agg" },
            root: { entityType: "Root" },
            timestamps,
            context: [field],
            edges: {
              note: A.one({ entityType: "Note" }),
              lines: A.many({ entityType: "Line", sk: { composite: ["k"] } }),
            },
          },
        )
        return {
          Main,
          Agg,
          input: { id: "a", title: "t", note: { text: "n" }, lines: [{ k: "k1", qty: 1 }] },
        }
      },
    ]),
  ),
  ...Object.fromEntries(
    (
      [
        ["the sort key attribute sk", "sk"],
        ["the collection sort key's mirror csk", "csk"],
        ["the list partition key attribute status", "status"],
      ] as const
    ).map(([name, field]) => [
      `the key attribute: ${name}`,
      (lib: ManagedLib) => {
        const { Aggregate: A, Schema } = lib
        const { Main, common } = base(lib)
        const Agg = A.make(
          Schema.Struct({
            id: Schema.String,
            title: Schema.String,
            ...(field === "status" && { status: Schema.String }),
            note: Schema.Unknown,
          }),
          {
            ...common,
            collection:
              field === "csk"
                ? { name: "agg", index: "lsi1", sk: { field: "csk", composite: [] } }
                : { name: "agg" },
            root: { entityType: "Root" },
            ...(field === "status" && {
              list: {
                index: "gsi1",
                name: "byStatus",
                pk: { field: "status", composite: ["status"] },
                sk: { field: "gsi1sk", composite: ["id"] },
              },
            }),
            context: [field],
            edges: { note: A.one({ entityType: "Note" }) },
          },
        )
        return {
          Main,
          Agg,
          input: {
            id: "a",
            title: "t",
            ...(field === "status" && { status: "open" }),
            note: { text: "n" },
          },
        }
      },
    ]),
  ),
  "a member's own declared field, given the root's value": (lib) => {
    const { Aggregate: A, Schema } = lib
    const { Main, common } = base(lib)
    const Note = Schema.Struct({ text: Schema.String, code: Schema.String })
    const Agg = A.make(
      Schema.Struct({ id: Schema.String, title: Schema.String, code: Schema.String, note: Note }),
      {
        ...common,
        collection: { name: "agg" },
        root: { entityType: "Root" },
        context: ["code"],
        edges: { note: A.one({ entityType: "Note" }) },
      },
    )
    return { Main, Agg, input: { id: "a", title: "t", code: "c", note: { text: "n", code: "c" } } }
  },
  "a many edge's key composite, the element's equal to the root's": (lib) => {
    const { Aggregate: A, Schema } = lib
    const { Main, common } = base(lib)
    const Line = Schema.Struct({ k: Schema.String, qty: Schema.Number })
    const Agg = A.make(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        k: Schema.String,
        lines: Schema.Array(Line),
      }),
      {
        ...common,
        collection: { name: "agg" },
        root: { entityType: "Root" },
        context: ["k"],
        edges: { lines: A.many({ entityType: "Line", sk: { composite: ["k"] } }) },
      },
    )
    return { Main, Agg, input: { id: "a", title: "t", k: "k1", lines: [{ k: "k1", qty: 1 }] } }
  },
}

export const shapeNames: ReadonlyArray<string> = Object.keys(shapes)

const noops = (from: number) =>
  Array.from({ length: 10 }, (_, i) => ({ step: `no change ${from + i}`, change: (s: any) => s }))

/** Ten no-op updates, an update of the root alone, ten no-op updates. */
export const steps: ReadonlyArray<{ readonly step: string; readonly change: (s: any) => any }> = [
  ...noops(1),
  { step: "root title", change: (s: any) => ({ ...s, title: "t2" }) },
  ...noops(11),
]

export type ManagedIo = {
  readonly tableName: string
  readonly client: any
  readonly take: () => ReadonlyArray<Request>
  readonly scan: () => Effect.Effect<ReadonlyArray<Row>, unknown>
  readonly seed?: ((rows: ReadonlyArray<Row>) => Effect.Effect<void, unknown>) | undefined
}

const outcomeOf = (lib: ManagedLib, exit: any): Outcome => {
  if (lib.Exit.isSuccess(exit)) return { ok: true }
  const error = lib.Cause.squash(exit.cause) as { _tag?: string; cause?: unknown }
  const cause = error.cause instanceof Error ? error.cause.message : undefined
  return { failed: error._tag ?? "defect", ...(cause !== undefined && { cause }) }
}

const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`
export const sortRows = (rows: ReadonlyArray<Row>): Array<Row> =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

/** `create`, or `created` stored as given; then every step in turn. */
export const runManaged = (
  lib: ManagedLib,
  name: string,
  io: ManagedIo,
  created?: ReadonlyArray<Row>,
): Effect.Effect<Recorded, unknown> => {
  const { Effect, Layer } = lib
  const { Main, Agg, input } = shapes[name]!(lib)
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
    let create: Outcome = { ok: true }
    if (created !== undefined) yield* io.seed!(created)
    else create = outcomeOf(lib, yield* Effect.exit(agg.create(input)))
    const rows = sortRows(yield* io.scan())
    io.take()
    const recorded: Array<Recorded["steps"][number]> = []
    for (const { step, change } of steps) {
      const update = outcomeOf(
        lib,
        yield* Effect.exit(agg.update({ id: "a" }, ({ state }: any) => change(state))),
      )
      recorded.push({ step, update, requests: io.take() })
    }
    return { create, created: rows, steps: recorded }
  }) as unknown as Effect.Effect<Recorded, unknown>
}
