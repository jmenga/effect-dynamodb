/**
 * `DynamoClient.make({ blobStore })` (#179, design §3.6): the store a typed
 * client's operations upload to and read from, observed from inside the
 * requests they send.
 *
 * - An explicit `blobStore` is bundled into the client's captured context and
 *   wins over a `BlobStore` in context at bind time.
 * - Without one, a `BlobStore` in context at bind time is captured; with
 *   neither, the operation sees whatever store its caller provides.
 * - The option is validated as `BlobStore.layer` validates a store
 *   (`[EDD-9116]`).
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { BlobStore, type BlobStoreService } from "../src/BlobStore.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

const AppSchema = DynamoSchema.make({ name: "blobs", version: 1 })

const Note = Schema.Struct({ noteId: Schema.String, text: Schema.String })
const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
})
const MainTable = Table.make({ schema: AppSchema, entities: { Notes } })

/** The store in context of each request sent. */
const seen: Array<BlobStoreService | undefined> = []

const TestLayer = Layer.mergeAll(
  mockDynamoClientLayer({
    putItem: () =>
      Effect.map(Effect.serviceOption(BlobStore), (store) => {
        seen.push(Option.getOrUndefined(store))
        return {} as never
      }),
  }),
  MainTable.layer({ name: "main" }),
)

const put = (db: { readonly entities: { readonly Notes: any } }) =>
  db.entities.Notes.put({ noteId: "n-1", text: "hello" }).asEffect() as Effect.Effect<unknown>

describe("DynamoClient.make({ blobStore })", () => {
  it.effect("an explicit store reaches the bound operations, over an ambient one", () =>
    Effect.gen(function* () {
      seen.length = 0
      const explicit = BlobStore.memory()
      const ambient = BlobStore.memory()
      const db = yield* DynamoClient.make({
        entities: { Notes },
        tables: { MainTable },
        blobStore: explicit,
      }).pipe(Effect.provide(BlobStore.layer(ambient)))
      yield* put(db)
      // Run under yet another store: the captured one still wins.
      yield* put(db).pipe(Effect.provide(BlobStore.layer(BlobStore.memory())))
      expect(seen).toEqual([explicit, explicit])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("without one, a store in context at bind time is captured", () =>
    Effect.gen(function* () {
      seen.length = 0
      const ambient = BlobStore.memory()
      const db = yield* DynamoClient.make({ entities: { Notes }, tables: { MainTable } }).pipe(
        Effect.provide(BlobStore.layer(ambient)),
      )
      yield* put(db)
      expect(seen).toEqual([ambient])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("with neither, the operation sees its caller's store, or none", () =>
    Effect.gen(function* () {
      seen.length = 0
      const db = yield* DynamoClient.make({ entities: { Notes }, tables: { MainTable } })
      yield* put(db)
      const later = BlobStore.memory()
      yield* put(db).pipe(Effect.provide(BlobStore.layer(later)))
      expect(seen).toEqual([undefined, later])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an invalid store is refused at make (EDD-9116)", () =>
    Effect.gen(function* () {
      const invalid = { ...BlobStore.memory(), writeConcurrency: 0 }
      const exit = yield* Effect.exit(
        DynamoClient.make({ entities: { Notes }, tables: { MainTable }, blobStore: invalid }),
      )
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : "")).toMatch(
        /\[EDD-9116\] DynamoClient\.make/,
      )
    }).pipe(Effect.provide(TestLayer)),
  )
})
