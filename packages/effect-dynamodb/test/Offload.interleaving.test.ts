/**
 * Interleavings of offloaded writes with GC (#179, design §6.4, §19.2): two
 * writers over one table, the second scripted between the first's read and
 * its write by the in-memory tables' hooks, and the reaper freeing what the
 * second superseded before the first writes. The scenarios a "carry the
 * pointer when the content is equal" rule got wrong: a write never re-points
 * a row at a version the reaper may already have freed — it uploads its own,
 * or it carries a read pointer only under a condition that the row still
 * holds it.
 *
 * - an unversioned entity with a unique constraint, whose update reads the
 *   row first: naming the field uploads afresh; carrying it (the read-merge
 *   wide fallback) is guarded, so the write is refused;
 * - an aggregate edge: an update diffs against its read, and a changed row
 *   re-uploads every offloaded value — freed before its eager decode, the
 *   read fails and nothing is written; changed (and freed) after it, the
 *   row's guard refuses the write (#168) and its upload is deleted.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ConcurrentModification } from "@effect-dynamodb/schema/Errors.js"
import type { BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Clock, Effect, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as BlobGc from "../src/BlobGc.js"
import { BlobStore } from "../src/BlobStore.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { pointerOf } from "../src/internal/GcSupport.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import type { StreamRecordLike } from "../src/internal/OffloadChange.js"
import * as Table from "../src/Table.js"
import {
  hooks,
  InMemoryClient,
  type Item,
  resetStore,
  store as rows,
} from "./helpers/InMemoryTables.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "race", version: 1, escapeKeys: true })
const MAIN = "main"

const Text = Schema.Struct({ text: Schema.String })
const text = (jsonBytes: number, fill = "x") => ({ text: fill.repeat(jsonBytes - 11) })
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)
const overflow = DynamoModel.Packed({ format: "json", external: { threshold: 64 } })

class Account extends Schema.Class<Account>("Account")({
  id: Schema.String,
  email: Schema.String,
  totals: Schema.Record(Schema.String, Schema.Number),
  body: Schema.optional(Text),
}) {}

/** Unversioned, with a unique constraint (its update reads the row first). */
const Accounts = Entity.make({
  model: DynamoModel.configure(Account, {
    totals: { storedAs: DynamoModel.SparseMap() },
    body: { storedAs: overflow },
  }),
  entityType: "Account",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  unique: { email: ["email"] },
})

class Venue extends Schema.Class<Venue>("Venue")({
  venueId: Schema.String,
  name: Schema.String,
  plan: Schema.Uint8Array,
}) {}
const Venues = Entity.make({
  model: DynamoModel.configure(Venue, {
    venueId: { identifier: true },
    plan: { storedAs: DynamoModel.External() },
  }),
  entityType: "Venue",
  primaryKey: { pk: { field: "pk", composite: ["venueId"] }, sk: { field: "sk", composite: [] } },
})
class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  name: Schema.String,
  venue: Venue,
}) {}

const MainTable = Table.make({ schema: AppSchema, entities: { Accounts, Venues } })
const Matches = Aggregate.make(Match, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "match" },
  root: { entityType: "MatchItem" },
  edges: { venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: Venues }) },
})

let blobs: MemoryBlobStore = BlobStore.memory()
const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(InMemoryClient, MainTable.layer({ name: MAIN }), BlobStore.layer(blobs)),
      ),
    ),
  )

beforeEach(() => {
  resetStore()
  blobs = BlobStore.memory()
})

const client = DynamoClient.make({
  entities: { Accounts },
  aggregates: { Matches },
  tables: { MainTable },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The stream records of the rows that changed from `before` to now. */
const recordsSince = (before: ReadonlyMap<string, Item>) =>
  Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis
    const out: Array<StreamRecordLike> = []
    for (const key of new Set([...before.keys(), ...rows.keys()])) {
      const old = before.get(key)
      const now = rows.get(key)
      if (old === now) continue
      out.push({
        eventName: old === undefined ? "INSERT" : now === undefined ? "REMOVE" : "MODIFY",
        dynamodb: {
          StreamViewType: "NEW_AND_OLD_IMAGES",
          ApproximateCreationDateTime: new Date(at),
          ...(old === undefined ? {} : { OldImage: old }),
          ...(now === undefined ? {} : { NewImage: now }),
        },
      })
    }
    return out
  })

/** Run `effect`, and the stream records of the rows it changed. */
const recorded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = new Map(rows)
    yield* effect
    return yield* recordsSince(before)
  })

const rowOf = (entityType: string): Item =>
  [...rows.values()].find((row) => row.__edd_e__?.S === entityType)!
const refOf = (value: AttributeValue | undefined): BlobRef => {
  const pointer = pointerOf(value)
  if (pointer === undefined) throw new Error("not a pointer")
  return pointer.ref
}
const exists = (ref: BlobRef) =>
  blobs.inspect().versions.some((v) => v.ref.key === ref.key && v.ref.version === ref.version)
const same = (a: BlobRef, b: BlobRef) => a.key === b.key && a.version === b.version

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Offload interleavings with the reaper", () => {
  it.effect("a unique-constrained update naming the field uploads its own version", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Accounts }, reaper: { gracePeriod: 0 } })
        yield* db.entities.Accounts.put({ id: "a-1", email: "a@x.io", totals: {}, body: text(100) })
        const v1 = refOf(rowOf("Account").body)
        // Writer B replaces the body between A's read and A's write, and the
        // reaper frees v1.
        hooks.afterGetEffect.push(() =>
          Effect.orDie(
            Effect.gen(function* () {
              const records = yield* recorded(
                db.entities.Accounts.update({ id: "a-1" })
                  .set({ body: text(120, "b") })
                  .asEffect(),
              )
              expect((yield* gc.reap(records)).freed).toBe(1)
            }),
          ),
        )
        // Writer A restates v1's content: it uploads afresh, never re-pointing at v1.
        const result = yield* db.entities.Accounts.update({ id: "a-1" }).set({
          email: "b@x.io",
          body: text(100),
        })
        expect(hooks.afterGetEffect).toEqual([])
        expect(exists(v1)).toBe(false)
        const now = refOf(rowOf("Account").body)
        expect(same(now, v1)).toBe(false)
        expect(exists(now)).toBe(true)
        expect(result.body).toEqual(text(100))
        expect((yield* db.entities.Accounts.get({ id: "a-1" })).body).toEqual(text(100))
      }),
    ),
  )

  it.effect("a unique-constrained update carrying the read pointer is refused", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ entities: { Accounts }, reaper: { gracePeriod: 0 } })
        const totals = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]))
        yield* db.entities.Accounts.put({ id: "a-1", email: "a@x.io", totals, body: text(100) })
        const v1 = refOf(rowOf("Account").body)
        let v2: BlobRef | undefined
        hooks.afterGetEffect.push(() =>
          Effect.orDie(
            Effect.gen(function* () {
              const records = yield* recorded(
                db.entities.Accounts.update({ id: "a-1" })
                  .set({ body: text(120, "b") })
                  .asEffect(),
              )
              v2 = refOf(rowOf("Account").body)
              expect((yield* gc.reap(records)).freed).toBe(1)
            }),
          ),
        )
        // The read-merge wide fallback carries the body it read (v1) under a
        // guard that the row still holds it: B's write makes the guard fail
        // (only the wide fallback guards `body`, which A does not name).
        const more = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`m${i}`, i]))
        const refused = yield* Effect.flip(
          db.entities.Accounts.update({ id: "a-1" })
            .set({ email: "b@x.io", totals: more })
            .asEffect(),
        )
        expect(hooks.afterGetEffect).toEqual([])
        expect(refused).toBeInstanceOf(ConcurrentModification)
        expect((refused as ConcurrentModification).attributes).toContain("body")
        expect(exists(v1)).toBe(false)
        const now = refOf(rowOf("Account").body)
        expect(same(now, v1)).toBe(false)
        expect(same(now, v2!)).toBe(true)
        expect(exists(now)).toBe(true)
        expect((yield* db.entities.Accounts.get({ id: "a-1" })).body).toEqual(text(120, "b"))
      }),
    ),
  )

  /** Writer B: change the venue's plan, and reap what it superseded. */
  const writerB = (
    db: Effect.Success<typeof client>,
    gc: Pick<BlobGc.Collector<unknown, unknown, unknown>, "reap">,
  ): Effect.Effect<void> =>
    Effect.orDie(
      Effect.gen(function* () {
        const records = yield* recorded(
          db.aggregates.Matches.update({ matchId: "m-1" }, ({ state }) => ({
            ...state,
            venue: { ...state.venue, plan: bytes(6, 2) },
          })),
        )
        expect((yield* gc.reap(records)).freed).toBe(1)
      }),
    )
  /** Writer A: rename the venue — its group changes, so its plan is re-uploaded. */
  const writerA = (db: Effect.Success<typeof client>) =>
    db.aggregates.Matches.update({ matchId: "m-1" }, ({ state }) => ({
      ...state,
      venue: { ...state.venue, name: "Stadium" },
    }))
  const seedMatch = (db: Effect.Success<typeof client>) =>
    Effect.gen(function* () {
      yield* db.aggregates.Matches.create({
        matchId: "m-1",
        name: "Final",
        venue: { venueId: "v-1", name: "Arena", plan: bytes(6, 1) },
      } as never)
      return refOf(rowOf("MatchVenue").plan)
    })

  it.effect("an aggregate read whose version was freed fails its eager read, writing nothing", () =>
    withStore(
      Effect.gen(function* () {
        const db = yield* client
        const gc = yield* BlobGc.make({ aggregates: { Matches }, reaper: { gracePeriod: 0 } })
        const v1 = yield* seedMatch(db)
        // B and the reaper run between A's partition read and its eager decode.
        hooks.afterQueryEffect.push(() => writerB(db, gc))
        const failure = yield* Effect.flip(writerA(db))
        expect(hooks.afterQueryEffect).toEqual([])
        expect(failure).toMatchObject({ _tag: "BlobStoreError", reason: "NotFound" })
        expect(exists(v1)).toBe(false)
        const now = refOf(rowOf("MatchVenue").plan)
        expect(same(now, v1)).toBe(false)
        expect(exists(now)).toBe(true)
        expect(rowOf("MatchVenue").name?.S).toBe("Arena")
        expect((yield* db.aggregates.Matches.get({ matchId: "m-1" })).venue.plan).toEqual(
          bytes(6, 2),
        )
      }),
    ),
  )

  it.effect(
    "an aggregate update whose edge another writer changed after its read is refused: its upload is deleted, never the freed version",
    () => {
      // B and the reaper run after A's eager decode, as A uploads its changed row.
      let beforeUpload: Effect.Effect<void> | undefined
      blobs = BlobStore.memory({
        failures: (call) => {
          if (call.action !== "put" || beforeUpload === undefined) return undefined
          const run = beforeUpload
          beforeUpload = undefined
          return Effect.as(run, undefined)
        },
      })
      return withStore(
        Effect.gen(function* () {
          const db = yield* client
          const gc = yield* BlobGc.make({ aggregates: { Matches }, reaper: { gracePeriod: 0 } })
          const v1 = yield* seedMatch(db)
          let v2: BlobRef | undefined
          beforeUpload = Effect.map(writerB(db, gc), () => {
            v2 = refOf(rowOf("MatchVenue").plan)
          })
          // A's row is guarded on the row it read (#168): B changed it in between, so A's
          // write is refused, naming the attribute, and B's change stays. 1.43.0 committed
          // A's own upload over B's (last writer wins).
          const refused = yield* Effect.flip(writerA(db))
          expect(beforeUpload).toBeUndefined()
          expect(refused).toBeInstanceOf(ConcurrentModification)
          expect((refused as ConcurrentModification).attributes).toEqual(["venue.plan"])
          expect(exists(v1)).toBe(false)
          const now = refOf(rowOf("MatchVenue").plan)
          expect(same(now, v2!)).toBe(true)
          expect(exists(now)).toBe(true)
          expect(rowOf("MatchVenue").name?.S).toBe("Arena")
          // A's upload of the cancelled write is deleted: the only version left is B's.
          expect(blobs.inspect().versions.map((v) => v.ref)).toEqual([now])
          // A retry reads B's change and commits its own rename over it.
          const match = yield* writerA(db)
          expect(match.venue).toMatchObject({ name: "Stadium", plan: bytes(6, 2) })
          expect((yield* db.aggregates.Matches.get({ matchId: "m-1" })).venue.plan).toEqual(
            bytes(6, 2),
          )
        }),
      )
    },
  )
})
