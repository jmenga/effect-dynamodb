/**
 * Upserts carrying a sparse map's entry key, and what the published 1.39.0 did for each.
 *
 * `test/fixtures/upsert-entry-keys-1.39.0.json` holds, for every case here, the requests 1.39.0
 * sent, how the upsert ended, the row it left and what a read returns, captured by running
 * `capture` against it. `test/UpsertEntryKeys.test.ts` runs the same cases against this source.
 *
 * The matrix: an upsert of a document whose sparse map `data` has a decoding default holding the
 * key under test, on a plain, versioned, retained, soft-delete entity and two unique ones (on a
 * field the upsert writes, and on the key), with and without a ref, with and without a secondary
 * index over a field with a decoding default the upsert omits, under a key holding `#`, an empty
 * key and one whose attribute name is over 255 bytes, with `data` given, omitted and `undefined`,
 * over a row that is there and one that isn't.
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
}

/** JSON as a fixture holds it. */
const plain = <A>(value: A): A =>
  JSON.parse(
    JSON.stringify(value, (_key, held) =>
      held instanceof Set ? [...held].sort() : held === undefined ? null : held,
    ),
  )

/** What an upsert did. */
export interface Outcome {
  readonly ok: boolean
  /** The failure's tag, operation and cause, when it failed. */
  readonly failure?: { readonly error: string; readonly operation?: string; readonly says: string }
  /** The requests sent, whole, in order. */
  readonly requests: ReadonlyArray<{ readonly command: string; readonly input: unknown }>
  /** Item `a`'s row afterwards, as stored. */
  readonly row?: Record<string, unknown>
  /** Item `a` as a read returns it afterwards, or the read's failure. */
  readonly read: unknown
}

export const WORLDS = ["plain", "versioned", "retain", "unique", "uniqueKey", "softDelete"] as const
export type World = (typeof WORLDS)[number]
export const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["a key holding `#`", "bad#key"],
  ["an empty key", ""],
  ["an attribute name over 255 bytes", "k".repeat(251)],
]
export const SUPPLIES = ["given", "omitted", "undefined"] as const
export type Supply = (typeof SUPPLIES)[number]

export interface Case {
  readonly key: string
  readonly world: World
  readonly refs: boolean
  readonly defaultedIndex: boolean
  readonly entryKey: string
  readonly supply: Supply
  readonly present: boolean
}

export const matrix: ReadonlyArray<Case> = WORLDS.flatMap((world) =>
  [false, true].flatMap((refs) =>
    [false, true].flatMap((defaultedIndex) =>
      KEYS.flatMap(([what, entryKey]) =>
        SUPPLIES.flatMap((supply) =>
          [true, false].map(
            (present): Case => ({
              key: [
                world,
                refs ? "a ref" : "no ref",
                defaultedIndex ? "a defaulted index composite" : "no defaulted index composite",
                what,
                `data ${supply}`,
                present ? "the row present" : "the row missing",
              ].join(", "),
              world,
              refs,
              defaultedIndex,
              entryKey,
              supply,
              present,
            }),
          ),
        ),
      ),
    ),
  ),
)

class Project extends Schema.Class<Project>("UpsertEntryKeysProject")({
  projectId: Schema.String,
  name: Schema.String,
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}

const definitions = (api: Api, each: Case) => {
  const Projects = api.Entity.make({
    entityType: "Project",
    model: api.DynamoModel.configure(Project, { projectId: { identifier: true } }),
    primaryKey: {
      pk: { field: "pk", composite: ["projectId"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const data = Schema.Record(Schema.String, Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed({ [each.entryKey]: 3 })),
  )
  const Docs = api.Entity.make({
    entityType: "Doc",
    primaryKey,
    model: api.DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        note: Schema.String,
        data,
        group: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("default"))),
        ...(each.refs ? { project: Project.pipe(api.DynamoModel.ref) } : {}),
      }),
      { data: { storedAs: api.DynamoModel.SparseMap() } },
    ),
    ...(each.world === "versioned" ? { versioned: true } : {}),
    ...(each.world === "retain" ? { versioned: { retain: true } } : {}),
    ...(each.world === "unique" ? { unique: { note: ["note"] } } : {}),
    ...(each.world === "uniqueKey" ? { unique: { id: ["id"] } } : {}),
    ...(each.world === "softDelete" ? { softDelete: true } : {}),
    ...(each.refs ? { refs: { project: { entity: Projects } } } : {}),
    ...(each.defaultedIndex
      ? {
          indexes: {
            byGroup: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["group"] },
              sk: { field: "gsi1sk", composite: ["id"] },
            },
          },
        }
      : {}),
  })
  const Main = api.Table.make({
    schema: api.DynamoSchema.make({ name: "upserts", version: 1 }),
    entities: { Docs, Projects },
  })
  return { Docs, Projects, Main }
}

/** The upsert's input: the defaulted index composite is never given, so an index over it is omitted. */
const payload = (each: Case): Record<string, unknown> => ({
  id: "a",
  note: "after",
  ...(each.refs ? { projectId: "p" } : {}),
  ...(each.supply === "given"
    ? { data: { [each.entryKey]: 3 } }
    : each.supply === "undefined"
      ? { data: undefined }
      : {}),
  ...(each.defaultedIndex ? {} : { group: "given" }),
})

const failureOf = (exit: Exit.Exit<unknown, unknown>): Outcome["failure"] => {
  if (Exit.isSuccess(exit)) return undefined
  const squashed = Cause.squash(exit.cause) as any
  if (exit.cause.reasons[0]?._tag !== "Fail") return { error: "defect", says: String(squashed) }
  return {
    error: String(squashed?._tag),
    ...(typeof squashed?.operation === "string" ? { operation: squashed.operation } : {}),
    says: String(squashed?.cause ?? squashed?.message ?? ""),
  }
}

/** Seeds the rows, runs the upsert, and returns what it did. */
export const capture = (api: Api, each: Case): Effect.Effect<Outcome> => {
  const table = makeRecordingTable()
  return Effect.suspend(() => {
    const { Docs, Projects, Main } = definitions(api, each)
    return Effect.gen(function* () {
      const db: any = yield* api.DynamoClient.make({
        entities: { Docs, Projects },
        tables: { Main },
      })
      yield* db.entities.Projects.put({ projectId: "p", name: "Project" }).asEffect()
      yield* db.entities.Docs.put({
        id: each.present ? "a" : "other",
        note: "before",
        data: { ok: 1 },
        group: "stored",
        ...(each.refs ? { projectId: "p" } : {}),
      }).asEffect()
      table.take()
      const exit = yield* Effect.exit(
        Effect.suspend(() => db.entities.Docs.upsert(payload(each)).asEffect()),
      )
      const requests = table.take()
      const read = yield* Effect.exit(db.entities.Docs.get({ id: "a" }))
      const row = [...table.items.values()].find(
        (item: any) =>
          item.__edd_e__?.S === "Doc" &&
          item.pk?.S === "$upserts#v1#doc#id_a" &&
          item.sk?.S === "$upserts#v1#doc",
      )
      const failure = failureOf(exit)
      return plain({
        ok: Exit.isSuccess(exit),
        ...(failure === undefined ? {} : { failure }),
        requests,
        ...(row === undefined ? {} : { row }),
        read: Exit.isSuccess(read) ? read.value : failureOf(read),
      }) as Outcome
    }).pipe(
      Effect.provide(Main.layer({ name: "t" })),
      Effect.provide(Layer.succeed(api.DynamoClient, table.client)),
      Effect.provide(
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((n) => new Uint8Array(n).fill(7)),
        ),
      ),
    )
  }) as unknown as Effect.Effect<Outcome>
}
