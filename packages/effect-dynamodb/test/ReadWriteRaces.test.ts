/**
 * Ops that read a row and then write items derived from it, with a concurrent write landing
 * between the read and the write (#132), and the updates that resolve to no write.
 *
 * Every case runs against the in-memory tables, whose `afterGetEffect` hook runs the concurrent
 * writer (a bound library op, as another process would run it) straight after the op's FIRST read,
 * so the read's answer is the stale one. Each test asserts the CORRECT outcome: the op either
 * commits against the row as it now is, or is refused, and in neither case leaves an orphaned
 * sentinel, loses the concurrent write, resurrects a deleted row or writes a second tombstone.
 * One scenario per test, named after the path and the interleaving.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  calls,
  hooks,
  InMemoryClient,
  rejection,
  resetCalls,
  resetStore,
  sent,
  store,
  tableIndexes,
} from "./helpers/InMemoryTables.js"
import { awsValidationException, DDB_TOO_MANY_ITEMS } from "./helpers/MockDynamoClient.js"

const TABLE = "races"
const AppSchema = DynamoSchema.make({ name: "app", version: 1 })

class Account extends Schema.Class<Account>("Account")({
  accountId: Schema.String,
  email: Schema.String,
  name: Schema.String,
}) {}

const key = {
  pk: { field: "pk", composite: ["accountId"] },
  sk: { field: "sk", composite: [] },
} as const

/** Unversioned, unique email: hard delete and update read the row first. */
const Accounts = Entity.make({
  model: Account,
  entityType: "Account",
  primaryKey: key,
  unique: { email: ["email"] },
})
/** Versioned, unique email. */
const VersionedAccounts = Entity.make({
  model: Account,
  entityType: "VersionedAccount",
  primaryKey: key,
  unique: { email: ["email"] },
  versioned: true,
})
/** Versioned with retained history, unique email. */
const RetainedAccounts = Entity.make({
  model: Account,
  entityType: "RetainedAccount",
  primaryKey: key,
  unique: { email: ["email"] },
  versioned: { retain: true },
})
/** Retained history, no unique constraint. */
const RetainedNotes = Entity.make({
  model: Account,
  entityType: "RetainedNote",
  primaryKey: key,
  versioned: { retain: true },
})
/** Versioned, nothing else. */
const VersionedNotes = Entity.make({
  model: Account,
  entityType: "VersionedNote",
  primaryKey: key,
  versioned: true,
})
/** Unversioned soft delete. */
const SoftAccounts = Entity.make({
  model: Account,
  entityType: "SoftAccount",
  primaryKey: key,
  softDelete: true,
})
/** Versioned soft delete. */
const SoftVersionedAccounts = Entity.make({
  model: Account,
  entityType: "SoftVersionedAccount",
  primaryKey: key,
  softDelete: true,
  versioned: true,
})
/** Plain: nothing multi-item. */
const Plain = Entity.make({
  model: Account,
  entityType: "Plain",
  primaryKey: key,
})

class Team extends Schema.Class<Team>("Team")({
  teamId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
class Player extends Schema.Class<Player>("Player")({
  playerId: Schema.String,
  team: Team.pipe(DynamoModel.ref),
}) {}
const Teams = Entity.make({
  model: Team,
  entityType: "Team",
  primaryKey: { pk: { field: "pk", composite: ["teamId"] }, sk: { field: "sk", composite: [] } },
})
/** A ref to a team, found by the team through `gsi1`: a cascade's target. */
const Players = Entity.make({
  model: Player,
  entityType: "Player",
  primaryKey: { pk: { field: "pk", composite: ["playerId"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byTeam: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["teamId"] },
      sk: { field: "gsi1sk", composite: ["playerId"] },
    },
  },
  refs: { team: { entity: Teams } },
})
/** A ref to a team that keys no index: `.keepRefs()` sets nothing on it. */
const Members = Entity.make({
  model: Player,
  entityType: "Member",
  primaryKey: { pk: { field: "pk", composite: ["playerId"] }, sk: { field: "sk", composite: [] } },
  refs: { team: { entity: Teams } },
})

/** Plain, with an immutable email: an update may restate it, never change it. */
const Immutables = Entity.make({
  model: DynamoModel.configure(Account, { email: { immutable: true } }),
  entityType: "Immutable",
  primaryKey: key,
})

const entities = {
  Immutables,
  Accounts,
  VersionedAccounts,
  RetainedAccounts,
  RetainedNotes,
  VersionedNotes,
  SoftAccounts,
  SoftVersionedAccounts,
  Plain,
  Teams,
  Players,
  Members,
}
const MainTable = Table.make({ schema: AppSchema, entities })
const database = DynamoClient.make({ entities, tables: { MainTable } })

tableIndexes.set(TABLE, { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } })

/** Every request sent, by command, in order (`resetStore` doesn't clear it: `beforeEach` does). */
const requests: Array<{ readonly command: string; readonly input: any }> = []
/** Answer the next `TransactWriteItems` (`undefined`: send it). */
let interceptTransaction: ((input: any) => Effect.Effect<never, unknown> | undefined) | undefined
/** Answer each `BatchWriteItem` (`undefined`: send it). */
let interceptBatch: ((input: any) => Effect.Effect<unknown, unknown> | undefined) | undefined
const Recording = Layer.effect(
  DynamoClient,
  Effect.gen(function* () {
    const real = yield* DynamoClient
    return new Proxy(real, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" && typeof property === "string"
          ? (input: unknown, ...rest: ReadonlyArray<unknown>) => {
              requests.push({
                command: property[0]!.toUpperCase() + property.slice(1),
                input: structuredClone(input),
              })
              if (property === "transactWriteItems") {
                const answer = interceptTransaction?.(input)
                if (answer !== undefined) return answer
              }
              if (property === "batchWriteItem") {
                const answer = interceptBatch?.(input)
                if (answer !== undefined) return answer
              }
              return value.apply(target, [input, ...rest])
            }
          : value
      },
    }) as DynamoClientService
  }),
).pipe(Layer.provide(InMemoryClient))

const run = <A, E>(effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>) =>
  Effect.suspend(() =>
    effect.pipe(Effect.provide(Layer.merge(Recording, MainTable.layer({ name: TABLE })))),
  )

beforeEach(() => {
  resetStore()
  requests.length = 0
  interceptTransaction = undefined
  interceptBatch = undefined
})

/** A bound builder, or a plain effect. */
type Runnable =
  | Effect.Effect<any, any, any>
  | { readonly asEffect: () => Effect.Effect<any, any, any> }
const asEffect = (op: Runnable): Effect.Effect<any, any, any> =>
  "asEffect" in op ? Effect.suspend(() => op.asEffect()) : op

const rowsOf = (entityType: string) =>
  [...store.values()].filter((row) => row.__edd_e__?.S === entityType)
const text = (value: AttributeValue | undefined) => value?.S
/** The unique sentinels of `entityType` still stored, as the email each one reserves. */
const sentinelEmails = (entityType: string) =>
  [...store.values()]
    .filter((row) => row.__edd_e__?.S === `${entityType}._unique.email`)
    .map((row) => String(row.pk?.S).split("#").at(-1))
    .sort()
/** A live row: not a retained snapshot. */
const liveRows = (entityType: string) =>
  rowsOf(entityType).filter(
    (row) => row.sk?.S?.includes("#v#") !== true && row.deletedAt === undefined,
  )
const tombstones = (entityType: string) =>
  rowsOf(entityType).filter((row) => row.deletedAt !== undefined)
const snapshots = (entityType: string) =>
  rowsOf(entityType).filter((row) => row.sk?.S?.includes("#v#") === true)

const create = (accountId: string, email: string) => ({ accountId, email, name: "n" })

/** Run `concurrent` straight after the op's next read, before its write. */
const afterNextRead = (concurrent: Runnable) => {
  hooks.afterGetEffect.push(() => Effect.orDie(asEffect(concurrent)) as Effect.Effect<void>)
}
/** Run `concurrent` straight after the op's next query (purge and restore read with one). */
const afterNextQuery = (concurrent: Runnable) => {
  hooks.afterQueryEffect.push(() => Effect.orDie(asEffect(concurrent)) as Effect.Effect<void>)
}
/** The tag of the failure of `op`, or "ok". */
const outcome = (op: Runnable): Effect.Effect<string, never, DynamoClient | Table.TableConfig> =>
  asEffect(op).pipe(
    Effect.map(() => "ok"),
    Effect.catch((error: { readonly _tag: string }) => Effect.succeed(error._tag)),
  )
/** Run `op` with `concurrent` landing after its read; the tag of its failure, or "ok". */
const racing = (
  when: typeof afterNextRead,
  concurrent: Runnable,
  op: Runnable,
): Effect.Effect<string, never, DynamoClient | Table.TableConfig> =>
  Effect.gen(function* () {
    when(concurrent)
    const result = yield* asEffect(op).pipe(
      Effect.map(() => "ok"),
      Effect.catch((error: { readonly _tag: string }) => Effect.succeed(error._tag)),
    )
    // The scenario must have happened: the hook ran.
    expect(hooks.afterGetEffect).toEqual([])
    expect(hooks.afterQueryEffect).toEqual([])
    return result
  })

// ---------------------------------------------------------------------------
// delete of a unique entity (hard delete)
// ---------------------------------------------------------------------------

describe("hard delete of a unique entity", () => {
  it.effect("an unversioned delete racing an update of the unique field orphans no sentinel", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        // The delete reads email A; the update moves it to B before the delete writes.
        const result = yield* racing(
          afterNextRead,
          db.entities.Accounts.update({ accountId: "a1" }).set({ email: "b@x.io" }),
          db.entities.Accounts.delete({ accountId: "a1" }),
        )
        // No condition of the caller's: the lost race is planned again and the row is deleted.
        expect(result).toBe("ok")
        expect(rowsOf("Account")).toHaveLength(0)
        expect(sentinelEmails("Account")).toEqual([])
      }),
    ),
  )

  it.effect("a versioned delete racing an update of the unique field orphans no sentinel", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.VersionedAccounts.put(create("a1", "a@x.io"))
        const result = yield* racing(
          afterNextRead,
          db.entities.VersionedAccounts.update({ accountId: "a1" }).set({ email: "b@x.io" }),
          db.entities.VersionedAccounts.delete({ accountId: "a1" }),
        )
        expect(result).toBe("ok")
        expect(rowsOf("VersionedAccount")).toHaveLength(0)
        expect(sentinelEmails("VersionedAccount")).toEqual([])
      }),
    ),
  )

  it.effect("a retain delete racing an update of the unique field orphans no sentinel", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.RetainedAccounts.put(create("a1", "a@x.io"))
        const result = yield* racing(
          afterNextRead,
          db.entities.RetainedAccounts.update({ accountId: "a1" }).set({ email: "b@x.io" }),
          db.entities.RetainedAccounts.delete({ accountId: "a1" }),
        )
        expect(result).toBe("ok")
        expect(liveRows("RetainedAccount")).toHaveLength(0)
        expect(sentinelEmails("RetainedAccount")).toEqual([])
      }),
    ),
  )

  it.effect("a delete racing another delete fails ItemNotFound and leaves nothing behind", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        const result = yield* racing(
          afterNextRead,
          db.entities.Accounts.delete({ accountId: "a1" }),
          db.entities.Accounts.delete({ accountId: "a1" }),
        )
        expect(result).toBe("ItemNotFound")
        expect(rowsOf("Account")).toHaveLength(0)
        expect(sentinelEmails("Account")).toEqual([])
      }),
    ),
  )

  it.effect("a retain delete snapshots the row's final state (the FAQ's claim)", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.RetainedNotes.put(create("a1", "a@x.io"))
        yield* db.entities.RetainedNotes.update({ accountId: "a1" }).set({ name: "last" })
        yield* db.entities.RetainedNotes.delete({ accountId: "a1" })
        const kept = snapshots("RetainedNote").map((row) => text(row.name))
        expect(kept).toContain("last")
      }),
    ),
  )

  it.effect("a unique + retain delete snapshots the row's final state", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.RetainedAccounts.put(create("a1", "a@x.io"))
        yield* db.entities.RetainedAccounts.update({ accountId: "a1" }).set({ name: "last" })
        yield* db.entities.RetainedAccounts.delete({ accountId: "a1" })
        expect(snapshots("RetainedAccount").map((row) => text(row.name))).toContain("last")
        expect(sentinelEmails("RetainedAccount")).toEqual([])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// delete of a softDelete entity
// ---------------------------------------------------------------------------

describe("soft delete", () => {
  it.effect("an unversioned soft delete keeps a concurrent change in its tombstone", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.SoftAccounts.put(create("a1", "a@x.io"))
        const result = yield* racing(
          afterNextRead,
          db.entities.SoftAccounts.update({ accountId: "a1" }).set({ name: "changed" }),
          db.entities.SoftAccounts.delete({ accountId: "a1" }),
        )
        expect(result).toBe("ok")
        expect(tombstones("SoftAccount").map((row) => text(row.name))).toEqual(["changed"])
        expect(liveRows("SoftAccount")).toHaveLength(0)
      }),
    ),
  )

  it.effect("a versioned soft delete keeps a concurrent change in its tombstone", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.SoftVersionedAccounts.put(create("a1", "a@x.io"))
        const result = yield* racing(
          afterNextRead,
          db.entities.SoftVersionedAccounts.update({ accountId: "a1" }).set({ name: "changed" }),
          db.entities.SoftVersionedAccounts.delete({ accountId: "a1" }),
        )
        expect(result).toBe("ok")
        expect(tombstones("SoftVersionedAccount").map((row) => text(row.name))).toEqual(["changed"])
      }),
    ),
  )

  it.effect("an unversioned soft delete racing another soft delete writes one tombstone", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.SoftAccounts.put(create("a1", "a@x.io"))
        yield* racing(
          afterNextRead,
          db.entities.SoftAccounts.delete({ accountId: "a1" }),
          db.entities.SoftAccounts.delete({ accountId: "a1" }),
        )
        expect(tombstones("SoftAccount")).toHaveLength(1)
      }),
    ),
  )

  it.effect("a versioned soft delete racing another soft delete writes one tombstone", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.SoftVersionedAccounts.put(create("a1", "a@x.io"))
        yield* racing(
          afterNextRead,
          db.entities.SoftVersionedAccounts.delete({ accountId: "a1" }),
          db.entities.SoftVersionedAccounts.delete({ accountId: "a1" }),
        )
        expect(tombstones("SoftVersionedAccount")).toHaveLength(1)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// update touching a unique field (read-merge), and a retain update
// ---------------------------------------------------------------------------

describe("update of a unique field", () => {
  it.effect(
    "an unversioned update racing an update of the same unique field orphans no sentinel",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* database
          yield* db.entities.Accounts.put(create("a1", "a@x.io"))
          // Reads email A; a concurrent update moves it to B; this one moves it to C.
          yield* racing(
            afterNextRead,
            db.entities.Accounts.update({ accountId: "a1" }).set({ email: "b@x.io" }),
            db.entities.Accounts.update({ accountId: "a1" }).set({ email: "c@x.io" }),
          )
          // Whichever won, exactly one sentinel, reserving the email the row holds.
          const [row] = rowsOf("Account")
          expect(sentinelEmails("Account")).toEqual([text(row?.email)])
        }),
      ),
  )

  it.effect(
    "a versioned update racing an update of the same unique field orphans no sentinel",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* database
          yield* db.entities.VersionedAccounts.put(create("a1", "a@x.io"))
          yield* racing(
            afterNextRead,
            db.entities.VersionedAccounts.update({ accountId: "a1" }).set({ email: "b@x.io" }),
            db.entities.VersionedAccounts.update({ accountId: "a1" }).set({ email: "c@x.io" }),
          )
          const [row] = rowsOf("VersionedAccount")
          expect(sentinelEmails("VersionedAccount")).toEqual([text(row?.email)])
        }),
      ),
  )

  it.effect("an unversioned update of the unique field does not undo a concurrent delete", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        yield* racing(
          afterNextRead,
          db.entities.Accounts.delete({ accountId: "a1" }),
          db.entities.Accounts.update({ accountId: "a1" }).set({ email: "c@x.io" }),
        )
        // The delete won: the update must not re-create the row, nor leave a sentinel.
        expect(rowsOf("Account")).toHaveLength(0)
        expect(sentinelEmails("Account")).toEqual([])
      }),
    ),
  )

  it.effect("a versioned update of the unique field does not undo a concurrent delete", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.VersionedAccounts.put(create("a1", "a@x.io"))
        yield* racing(
          afterNextRead,
          db.entities.VersionedAccounts.delete({ accountId: "a1" }),
          db.entities.VersionedAccounts.update({ accountId: "a1" }).set({ email: "c@x.io" }),
        )
        expect(rowsOf("VersionedAccount")).toHaveLength(0)
        expect(sentinelEmails("VersionedAccount")).toEqual([])
      }),
    ),
  )

  it.effect("a retain update (no unique field) does not undo a concurrent delete", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.RetainedNotes.put(create("a1", "a@x.io"))
        yield* racing(
          afterNextRead,
          db.entities.RetainedNotes.delete({ accountId: "a1" }),
          db.entities.RetainedNotes.update({ accountId: "a1" }).set({ name: "late" }),
        )
        expect(liveRows("RetainedNote")).toHaveLength(0)
      }),
    ),
  )

  it.effect("a retain update keeps a concurrent change to another field", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.RetainedNotes.put(create("a1", "a@x.io"))
        // The update reads the row (retain) and writes it back whole: the concurrent change to
        // `email` must survive.
        const result = yield* racing(
          afterNextRead,
          db.entities.RetainedNotes.update({ accountId: "a1" }).set({ email: "b@x.io" }),
          db.entities.RetainedNotes.update({ accountId: "a1" }).set({ name: "late" }),
        )
        const [live] = liveRows("RetainedNote")
        expect(text(live?.email)).toBe("b@x.io")
        if (result === "ok") expect(text(live?.name)).toBe("late")
      }),
    ),
  )

  it.effect(
    "a retain update racing a put that brings the version back to 1 writes no stale content",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* database
          yield* db.entities.RetainedNotes.put(create("a1", "a@x.io"))
          // A put overwrites the row, and the version is 1 again (the ABA of the issue's second
          // item): the update's version check holds against a row it never read.
          const result = yield* racing(
            afterNextRead,
            db.entities.RetainedNotes.put({
              accountId: "a1",
              email: "b@x.io",
              name: "overwritten",
            }),
            db.entities.RetainedNotes.update({ accountId: "a1" }).set({ name: "late" }),
          )
          const [live] = liveRows("RetainedNote")
          // Either the update was refused, or it was planned again on the overwritten row.
          expect(text(live?.email)).toBe("b@x.io")
          if (result === "ok") expect(text(live?.name)).toBe("late")
        }),
      ),
  )
})

// ---------------------------------------------------------------------------
// a no-op update inside transactWrite
// ---------------------------------------------------------------------------

describe("an update that sets nothing, in transactWrite", () => {
  const nothing = (op: ReturnType<typeof Plain.update>) => op.pipe(Entity.set({}))

  it.effect("standalone, on a missing row, fails ItemNotFound (the semantics to keep)", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        const result = yield* outcome(db.entities.Plain.update({ accountId: "ghost" }).set({}))
        expect(result).toBe("ItemNotFound")
      }),
    ),
  )

  it.effect("beside another write, on a row missing from the start, fails and writes nothing", () =>
    run(
      Effect.gen(function* () {
        const result = yield* outcome(
          Transaction.transactWrite([
            nothing(Plain.update({ accountId: "ghost" })),
            Plain.put({ accountId: "other", email: "o@x.io", name: "n" }),
          ]),
        )
        expect(result).toBe("ItemNotFound")
        expect(rowsOf("Plain")).toHaveLength(0)
      }),
    ),
  )

  it.effect("beside another write, on a row deleted after the plan read it, commits nothing", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Plain.put(create("a1", "a@x.io"))
        const result = yield* racing(
          afterNextRead,
          db.entities.Plain.delete({ accountId: "a1" }),
          Transaction.transactWrite([
            nothing(Plain.update({ accountId: "a1" })),
            Plain.put({ accountId: "other", email: "o@x.io", name: "n" }),
          ]),
        )
        // The row the update targets is gone: the standalone semantics are ItemNotFound, and the
        // other write must not commit.
        expect(result).toBe("ItemNotFound")
        expect(rowsOf("Plain").map((row) => text(row.accountId))).not.toContain("other")
      }),
    ),
  )
})

describe("a versioned update that sets nothing, in transactWrite", () => {
  it.effect("pinned to a version the row left after the plan read it, commits nothing", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.VersionedAccounts.put(create("a1", "a@x.io"))
        const result = yield* racing(
          afterNextRead,
          db.entities.VersionedAccounts.update({ accountId: "a1" }).set({ name: "moved on" }),
          Transaction.transactWrite([
            VersionedAccounts.update({ accountId: "a1" }).pipe(
              Entity.set({}),
              Entity.expectedVersion(1),
            ),
            Plain.put({ accountId: "other", email: "o@x.io", name: "n" }),
          ]),
        )
        // Standalone, the pin is checked against the row as read; a transaction that commits
        // other writes beside it must hold the pin at commit, or refuse.
        expect(result).not.toBe("ok")
        expect(rowsOf("Plain").map((row) => text(row.accountId))).not.toContain("other")
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// other read-then-write paths on the scout's map
// ---------------------------------------------------------------------------

describe("put over an existing row of a unique entity", () => {
  it.effect("a put racing an update of the unique field orphans no sentinel", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        yield* racing(
          afterNextRead,
          db.entities.Accounts.update({ accountId: "a1" }).set({ email: "b@x.io" }),
          db.entities.Accounts.put(create("a1", "c@x.io")),
        )
        const [row] = rowsOf("Account")
        expect(sentinelEmails("Account")).toEqual([text(row?.email)])
      }),
    ),
  )
})

describe("upsert of a unique entity", () => {
  it.effect("an upsert racing an update of the unique field orphans no sentinel", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        yield* racing(
          afterNextRead,
          db.entities.Accounts.update({ accountId: "a1" }).set({ email: "b@x.io" }),
          db.entities.Accounts.upsert(create("a1", "c@x.io")),
        )
        const [row] = rowsOf("Account")
        expect(sentinelEmails("Account")).toEqual([text(row?.email)])
      }),
    ),
  )

  it.effect("an upsert racing a delete does not leave a sentinel behind a missing row", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        yield* racing(
          afterNextRead,
          db.entities.Accounts.delete({ accountId: "a1" }),
          db.entities.Accounts.upsert(create("a1", "c@x.io")),
        )
        // Either the row exists with its own sentinel, or neither does.
        const rows = rowsOf("Account")
        expect(sentinelEmails("Account")).toEqual(rows.map((row) => text(row.email)))
      }),
    ),
  )
})

describe("purge of a unique entity", () => {
  it.effect("a purge racing an update of the unique field orphans no sentinel", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        // Purge reads the partition's rows (one query); the update moves the email to B after
        // that read, so purge's sentinel list names A only.
        yield* racing(
          afterNextQuery,
          db.entities.Accounts.update({ accountId: "a1" }).set({ email: "b@x.io" }),
          db.entities.Accounts.purge({ accountId: "a1" }),
        )
        // Whatever purge did, no sentinel may outlive the row it reserves for.
        const rows = rowsOf("Account")
        expect(sentinelEmails("Account")).toEqual(rows.map((row) => text(row.email)))
      }),
    ),
  )
})

describe("restore of a soft-deleted item", () => {
  it.effect("a restore racing another restore leaves one live row and no tombstone", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.SoftAccounts.put(create("a1", "a@x.io"))
        yield* db.entities.SoftAccounts.delete({ accountId: "a1" })
        const result = yield* racing(
          afterNextQuery,
          db.entities.SoftAccounts.restore({ accountId: "a1" }),
          db.entities.SoftAccounts.restore({ accountId: "a1" }),
        )
        expect(result).not.toBe("ok")
        expect(liveRows("SoftAccount")).toHaveLength(1)
        expect(tombstones("SoftAccount")).toHaveLength(0)
      }),
    ),
  )

  it.effect("a restore racing a restore, an edit and a second delete restores nothing stale", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.SoftAccounts.put(create("a1", "a@x.io"))
        yield* db.entities.SoftAccounts.delete({ accountId: "a1" })
        // The first restore read tombstone T1. Meanwhile the item is restored, edited and deleted
        // again: T2 holds the edit. The first restore must not bring back T1's content.
        yield* racing(
          afterNextQuery,
          Effect.gen(function* () {
            yield* TestClock.adjust("1 second")
            yield* db.entities.SoftAccounts.restore({ accountId: "a1" })
            yield* db.entities.SoftAccounts.update({ accountId: "a1" }).set({ name: "edited" })
            yield* TestClock.adjust("1 second")
            yield* db.entities.SoftAccounts.delete({ accountId: "a1" })
          }),
          db.entities.SoftAccounts.restore({ accountId: "a1" }),
        )
        for (const row of liveRows("SoftAccount")) expect(text(row.name)).toBe("edited")
      }),
    ),
  )
})

describe("an update that sets nothing, returning nothing", () => {
  it.effect("standalone on a missing row", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        const result = yield* outcome(
          db.entities.Plain.update({ accountId: "ghost" }).set({}).returnValues("none"),
        )
        expect(result).toBe("ItemNotFound")
      }),
    ),
  )
  it.effect("in transactWrite beside a put, on a missing row", () =>
    run(
      Effect.gen(function* () {
        const result = yield* outcome(
          Transaction.transactWrite([
            Plain.update({ accountId: "ghost" }).pipe(Entity.set({}), Entity.returnValues("none")),
            Plain.put({ accountId: "other", email: "o@x.io", name: "n" }),
          ]),
        )
        expect(result).toBe("ItemNotFound")
        expect(rowsOf("Plain")).toHaveLength(0)
      }),
    ),
  )
  it.effect("standalone no-op with a failing condition on a present row", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Plain.put(create("a1", "a@x.io"))
        const result = yield* outcome(
          db.entities.Plain.update({ accountId: "a1" }).set({}).condition({ name: "zzz" }),
        )
        expect(result).toBe("ConditionalCheckFailed")
      }),
    ),
  )
})

describe("a patch that sets nothing", () => {
  it.effect("standalone on a missing row", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        const result = yield* outcome(db.entities.Plain.patch({ accountId: "ghost" }).set({}))
        expect(result).toBe("ConditionalCheckFailed")
      }),
    ),
  )
  it.effect("in transactWrite on a missing row", () =>
    run(
      Effect.gen(function* () {
        const result = yield* outcome(
          Transaction.transactWrite([
            Plain.patch({ accountId: "ghost" }).pipe(Entity.set({})),
            Plain.put({ accountId: "other", email: "o@x.io", name: "n" }),
          ]),
        )
        expect(result).toBe("ConditionalCheckFailed")
        expect(rowsOf("Plain")).toHaveLength(0)
      }),
    ),
  )
})

describe("purge of a unique entity, after its row read", () => {
  it.effect("a purge racing an update after reading the live row orphans no sentinel", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        yield* racing(
          afterNextRead,
          db.entities.Accounts.update({ accountId: "a1" }).set({ email: "b@x.io" }),
          db.entities.Accounts.purge({ accountId: "a1" }),
        )
        const rows = rowsOf("Account")
        expect(sentinelEmails("Account")).toEqual(rows.map((row) => text(row.email)))
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// an update that sets nothing: what it sends
// ---------------------------------------------------------------------------

const commands = () => requests.map((request) => request.command)

describe("an update that sets nothing, what it sends", () => {
  for (const mode of ["allNew", "allOld", "none", "updatedNew", "updatedOld"] as const) {
    it.effect(`reads its row with one consistent GetItem (returnValues ${mode})`, () =>
      run(
        Effect.gen(function* () {
          const db = yield* database
          yield* db.entities.Plain.put(create("a1", "a@x.io"))
          resetCalls()
          requests.length = 0
          const result = yield* db.entities.Plain.update({ accountId: "a1" })
            .set({})
            .returnValues(mode)
          expect(commands()).toEqual(["GetItem"])
          expect(sent.getItem[0]!.ConsistentRead).toBe(true)
          if (mode === "allNew" || mode === "allOld") {
            expect(result).toEqual({ accountId: "a1", email: "a@x.io", name: "n" })
          } else if (mode === "none") {
            expect(result).toBeUndefined()
          } else {
            expect(result).toEqual({})
          }
        }),
      ),
    )
  }

  it.effect("finds the row the put before it wrote", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Plain.put(create("a1", "a@x.io"))
        const found = yield* db.entities.Plain.update({ accountId: "a1" }).set({})
        expect(found).toEqual({ accountId: "a1", email: "a@x.io", name: "n" })
      }),
    ),
  )

  it.effect(
    "with a condition, sends one UpdateItem with no UpdateExpression and returns its item",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* database
          yield* db.entities.Plain.put(create("a1", "a@x.io"))
          requests.length = 0
          const found = yield* db.entities.Plain.update({ accountId: "a1" })
            .set({})
            .condition({ name: "n" })
          expect(found).toEqual({ accountId: "a1", email: "a@x.io", name: "n" })
          // No GetItem after it: the item comes back in the same response.
          expect(commands()).toEqual(["UpdateItem"])
          const [update] = requests
          expect(update!.input.UpdateExpression).toBeUndefined()
          expect(update!.input.ConditionExpression).toContain("attribute_exists(#exists)")
          expect(update!.input.ReturnValues).toBe("ALL_NEW")
          expect(update!.input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
          // Nothing changed.
          expect(rowsOf("Plain").map((row) => text(row.name))).toEqual(["n"])
        }),
      ),
  )

  it.effect("with a condition and returnValues('none'), asks for nothing back", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Plain.put(create("a1", "a@x.io"))
        requests.length = 0
        const result = yield* db.entities.Plain.update({ accountId: "a1" })
          .set({})
          .condition({ name: "n" })
          .returnValues("none")
        expect(result).toBeUndefined()
        expect(commands()).toEqual(["UpdateItem"])
        expect(requests[0]!.input.ReturnValues).toBe("NONE")
      }),
    ),
  )

  it.effect("with a condition, on a missing row, is ItemNotFound and creates nothing", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        // An UpdateItem with no UpdateExpression creates a key-only item at a missing key unless
        // its condition requires the row: it does.
        const result = yield* outcome(
          db.entities.Plain.update({ accountId: "ghost" })
            .set({})
            .condition((t, { notExists }) => notExists(t.email)),
        )
        expect(result).toBe("ItemNotFound")
        expect(store.size).toBe(0)
      }),
    ),
  )

  it.effect("a patch with a condition, on a missing row, is ConditionalCheckFailed", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        const result = yield* outcome(
          db.entities.Plain.patch({ accountId: "ghost" }).set({}).condition({ name: "n" }),
        )
        expect(result).toBe("ConditionalCheckFailed")
        expect(store.size).toBe(0)
      }),
    ),
  )

  it.effect(
    "with .keepRefs() naming a ref the row no longer holds, is ConditionalCheckFailed",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* database
          yield* db.entities.Teams.put({ teamId: "t1", name: "One" })
          yield* db.entities.Teams.put({ teamId: "t2", name: "Two" })
          yield* db.entities.Members.put({ playerId: "m1", teamId: "t2" })
          requests.length = 0
          const result = yield* outcome(
            db.entities.Members.update({ playerId: "m1" }).set({}).keepRefs({ teamId: "t1" }),
          )
          expect(result).toBe("ConditionalCheckFailed")
          expect(commands()).toEqual(["UpdateItem"])
          expect(requests[0]!.input.UpdateExpression).toBeUndefined()
          // Held: the same no-op naming the ref the row holds.
          const held = yield* db.entities.Members.update({ playerId: "m1" })
            .set({})
            .keepRefs({ teamId: "t2" })
          expect(held.team.name).toBe("Two")
        }),
      ),
  )

  it.effect("with a condition and .cascade(), cascades nothing", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Teams.put({ teamId: "t1", name: "One" })
        yield* db.entities.Players.put({ playerId: "p1", teamId: "t1" })
        requests.length = 0
        yield* db.entities.Teams.update({ teamId: "t1" })
          .set({})
          .condition({ name: "One" })
          .cascade({ targets: [Players] })
        expect(commands()).toEqual(["UpdateItem"])
      }),
    ),
  )
})

describe("an update that sets nothing, in transactWrite, what it sends", () => {
  const other = Plain.put({ accountId: "other", email: "o@x.io", name: "n" })

  it.effect("holds the row it read to the commit with an existence ConditionCheck", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Plain.put(create("a1", "a@x.io"))
        requests.length = 0
        yield* Transaction.transactWrite([
          Plain.update({ accountId: "a1" }).pipe(Entity.set({})),
          other,
        ])
        expect(commands()).toEqual(["GetItem", "TransactWriteItems"])
        expect(requests[0]!.input.ConsistentRead).toBe(true)
        const [check, put] = requests[1]!.input.TransactItems
        expect(check).toEqual({
          ConditionCheck: {
            TableName: TABLE,
            Key: requests[0]!.input.Key,
            ConditionExpression: "attribute_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        })
        expect(put.Put).toBeDefined()
        expect(rowsOf("Plain")).toHaveLength(2)
      }),
    ),
  )

  it.effect("with a condition, records a ConditionCheck with the update's key and condition", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Plain.put(create("a1", "a@x.io"))
        // Standalone: the request the transaction records.
        requests.length = 0
        yield* db.entities.Plain.update({ accountId: "a1" }).set({}).condition({ name: "n" })
        const standalone = requests[0]!.input
        requests.length = 0
        yield* Transaction.transactWrite([
          Plain.update({ accountId: "a1" }).pipe(Entity.set({}), Plain.condition({ name: "n" })),
          other,
        ])
        const transaction = requests.find((request) => request.command === "TransactWriteItems")!
        expect(transaction.input.TransactItems[0]).toEqual({
          ConditionCheck: {
            TableName: TABLE,
            Key: standalone.Key,
            ConditionExpression: standalone.ConditionExpression,
            ExpressionAttributeNames: standalone.ExpressionAttributeNames,
            ExpressionAttributeValues: standalone.ExpressionAttributeValues,
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        })
        expect(rowsOf("Plain")).toHaveLength(2)
      }),
    ),
  )

  it.effect(
    "with a condition the unchanged row fails, is TransactionCancelled, commits nothing",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* database
          yield* db.entities.Plain.put(create("a1", "a@x.io"))
          const result = yield* outcome(
            Transaction.transactWrite([
              Plain.update({ accountId: "a1" }).pipe(
                Entity.set({}),
                Plain.condition({ name: "zzz" }),
              ),
              other,
            ]),
          )
          expect(result).toBe("TransactionCancelled")
          expect(rowsOf("Plain").map((row) => text(row.accountId))).toEqual(["a1"])
        }),
      ),
  )

  it.effect("with a condition, on a row deleted after the plan read it, is ItemNotFound", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Plain.put(create("a1", "a@x.io"))
        const result = yield* racing(
          afterNextRead,
          db.entities.Plain.delete({ accountId: "a1" }),
          Transaction.transactWrite([
            Plain.update({ accountId: "a1" }).pipe(Entity.set({}), Plain.condition({ name: "n" })),
            other,
          ]),
        )
        expect(result).toBe("ItemNotFound")
        expect(rowsOf("Plain")).toHaveLength(0)
      }),
    ),
  )

  it.effect("beside 100 other writes, is counted in the transaction DynamoDB refuses", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Plain.put(create("a1", "a@x.io"))
        // Nothing is counted before sending: DynamoDB refuses 101 items, and the diagnosis
        // confirms the count against the request, the no-op's check included.
        interceptTransaction = () =>
          Effect.fail(
            new DynamoError({
              operation: "TransactWriteItems",
              cause: awsValidationException(DDB_TOO_MANY_ITEMS),
            }),
          )
        const others = Array.from({ length: 100 }, (_, n) =>
          Plain.put({ accountId: `o${n}`, email: "o@x.io", name: "n" }),
        )
        const error = yield* Transaction.transactWrite([
          Plain.update({ accountId: "a1" }).pipe(Entity.set({})),
          ...others,
        ]).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect(String((error as DynamoError).cause)).toContain(
          "101 operation(s) expanded to 101 items",
        )
        const sentItems = requests.find((request) => request.command === "TransactWriteItems")!
        expect(sentItems.input.TransactItems).toHaveLength(101)
        expect(sentItems.input.TransactItems[0].ConditionCheck).toBeDefined()
      }),
    ),
  )

  it.effect("beside a check on the same key, is a repeated item, diagnosed", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Plain.put(create("a1", "a@x.io"))
        const error = yield* Transaction.transactWrite([
          Plain.update({ accountId: "a1" }).pipe(Entity.set({})),
          Transaction.check(
            Plain.get({ accountId: "a1" }),
            Expression.condition({ attributeExists: "pk" }),
          ),
        ]).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String((error as { cause?: unknown }).cause)).toMatch(/more than once|repeat/i)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// purge
// ---------------------------------------------------------------------------

describe("purge", () => {
  it.effect("reads the item's rows with consistent queries", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.RetainedNotes.put(create("a1", "a@x.io"))
        yield* db.entities.RetainedNotes.update({ accountId: "a1" }).set({ name: "later" })
        requests.length = 0
        yield* db.entities.RetainedNotes.purge({ accountId: "a1" })
        const queries = requests.filter((request) => request.command === "Query")
        expect(queries.length).toBeGreaterThan(0)
        for (const query of queries) expect(query.input.ConsistentRead).toBe(true)
        // The live row and the snapshot the update wrote.
        expect(rowsOf("RetainedNote")).toHaveLength(0)
      }),
    ),
  )

  it.effect("of a unique entity deletes the live row with its sentinels, guarded", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        requests.length = 0
        yield* db.entities.Accounts.purge({ accountId: "a1" })
        const transaction = requests.find((request) => request.command === "TransactWriteItems")!
        const [live, sentinel] = transaction.input.TransactItems
        expect(live.Delete.ConditionExpression).toBeDefined()
        expect(live.Delete.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
        expect(sentinel.Delete.ConditionExpression).toBe("#epk = :epk AND #esk = :esk")
        // Not batch-deleted again.
        expect(commands()).not.toContain("BatchWriteItem")
        expect(rowsOf("Account")).toHaveLength(0)
        expect(sentinelEmails("Account")).toEqual([])
      }),
    ),
  )

  it.effect(
    "of a unique entity losing every attempt fails ConcurrentModification, deletes nothing",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* database
          yield* db.entities.Accounts.put(create("a1", "a@x.io"))
          resetCalls()
          rejection.all = true
          const result = yield* outcome(db.entities.Accounts.purge({ accountId: "a1" }))
          rejection.all = false
          expect(result).toBe("ConcurrentModification")
          expect(calls.transactWriteItems).toBe(3)
          expect(calls.batchWriteItem).toBe(0)
          expect(rowsOf("Account")).toHaveLength(1)
          expect(sentinelEmails("Account")).toEqual(["a@x.io"])
        }),
      ),
  )

  it.effect("of a versioned unique entity losing every attempt fails OptimisticLockError", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.VersionedAccounts.put(create("a1", "a@x.io"))
        rejection.all = true
        const result = yield* outcome(db.entities.VersionedAccounts.purge({ accountId: "a1" }))
        rejection.all = false
        expect(result).toBe("OptimisticLockError")
        expect(rowsOf("VersionedAccount")).toHaveLength(1)
      }),
    ),
  )

  it.effect("of a retained unique entity reads the live row before the partition", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.RetainedAccounts.put(create("a1", "a@x.io"))
        requests.length = 0
        yield* db.entities.RetainedAccounts.purge({ accountId: "a1" })
        expect(commands().slice(0, 2)).toEqual(["GetItem", "Query"])
      }),
    ),
  )

  it.effect(
    "of a retained unique entity, a write after its partition query is purged with its snapshot",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* database
          yield* db.entities.RetainedAccounts.put(create("a1", "a@x.io"))
          yield* db.entities.RetainedAccounts.update({ accountId: "a1" }).set({ name: "v2" })
          // The update lands after the partition query: it moves the version and writes the
          // snapshot of version 2, which the query didn't see. The live row was read before the
          // query, so the guarded transaction is refused, and the next attempt's query sees it.
          const result = yield* racing(
            afterNextQuery,
            db.entities.RetainedAccounts.update({ accountId: "a1" }).set({ name: "v3" }),
            db.entities.RetainedAccounts.purge({ accountId: "a1" }),
          )
          expect(result).toBe("ok")
          expect(rowsOf("RetainedAccount")).toEqual([])
          expect(sentinelEmails("RetainedAccount")).toEqual([])
        }),
      ),
  )

  it.effect("of a unique entity whose batch runs out of retries counts the live row deleted", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.RetainedAccounts.put(create("a1", "a@x.io"))
        yield* db.entities.RetainedAccounts.update({ accountId: "a1" }).set({ name: "v2" })
        // Every batch delete comes back unprocessed: the snapshot stays, after the transaction
        // deleted the live row and released its email.
        interceptBatch = (input) =>
          Effect.succeed({ $metadata: {}, UnprocessedItems: input.RequestItems })
        const pending = yield* Effect.forkChild(
          db.entities.RetainedAccounts.purge({ accountId: "a1" }).pipe(Effect.flip),
        )
        yield* TestClock.adjust("10 seconds")
        const error = yield* Fiber.join(pending)
        expect(error).toBeInstanceOf(DynamoError)
        expect(String((error as DynamoError).cause)).toContain(
          "purge: 1 of the partition's 2 items were still unprocessed after 5 retries; the " +
            "purge had already deleted 1 of the partition's 2 items, the live item among them, " +
            "with the reservations of its unique values.",
        )
        expect(liveRows("RetainedAccount")).toEqual([])
        expect(snapshots("RetainedAccount")).toHaveLength(1)
        expect(sentinelEmails("RetainedAccount")).toEqual([])
      }),
    ),
  )

  it.effect("of a unique entity racing a delete of the row purges what is left", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.put(create("a1", "a@x.io"))
        const result = yield* racing(
          afterNextRead,
          db.entities.Accounts.delete({ accountId: "a1" }),
          db.entities.Accounts.purge({ accountId: "a1" }),
        )
        expect(result).toBe("ok")
        expect(rowsOf("Account")).toHaveLength(0)
        expect(sentinelEmails("Account")).toEqual([])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// cascade
// ---------------------------------------------------------------------------

const playerRows = () =>
  Object.fromEntries(
    rowsOf("Player").map((row) => [text(row.playerId), text(row.team?.M?.name)] as const),
  )
/** Keys holding no `__edd_e__`: what an unconditioned update of a deleted target left. */
const partialItems = () => [...store.values()].filter((row) => row.__edd_e__ === undefined)

describe("cascade", () => {
  for (const mode of ["eventual", "transactional"] as const) {
    const seed = Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Teams.put({ teamId: "t1", name: "One" })
      yield* db.entities.Teams.put({ teamId: "t2", name: "Two" })
      for (const playerId of ["p1", "p2", "p3"]) {
        yield* db.entities.Players.put({ playerId, teamId: "t1" })
      }
      return db
    })
    const rename = (db: Effect.Success<typeof database>) =>
      db.entities.Teams.update({ teamId: "t1" })
        .set({ name: "Renamed" })
        .cascade({ targets: [Players], mode })

    it.effect(`${mode}: a target deleted after the query is not created again`, () =>
      run(
        Effect.gen(function* () {
          const db = yield* seed
          resetCalls()
          const result = yield* racing(
            afterNextQuery,
            db.entities.Players.delete({ playerId: "p1" }),
            rename(db),
          )
          expect(result).toBe("ok")
          expect(partialItems()).toEqual([])
          expect(playerRows()).toEqual({ p2: "Renamed", p3: "Renamed" })
          // Transactional: the refused target dropped, the rest sent again.
          if (mode === "transactional") expect(calls.transactWriteItems).toBe(2)
        }),
      ),
    )

    it.effect(`${mode}: a target moved to another team after the query keeps its team`, () =>
      run(
        Effect.gen(function* () {
          const db = yield* seed
          const result = yield* racing(
            afterNextQuery,
            db.entities.Players.update({ playerId: "p2" }).set({ teamId: "t2" }),
            rename(db),
          )
          expect(result).toBe("ok")
          expect(playerRows()).toEqual({ p1: "Renamed", p2: "Two", p3: "Renamed" })
        }),
      ),
    )
  }

  it.effect("transactional: refused on every send, fails CascadePartialFailure", () =>
    run(
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Teams.put({ teamId: "t1", name: "One" })
        for (const playerId of ["p1", "p2", "p3", "p4"]) {
          yield* db.entities.Players.put({ playerId, teamId: "t1" })
        }
        // Each send's first target refused, as if moved since the query.
        let sends = 0
        interceptTransaction = (input) => {
          sends++
          return Effect.fail(
            new DynamoError({
              operation: "TransactWriteItems",
              cause: Object.assign(new Error("Transaction cancelled"), {
                name: "TransactionCanceledException",
                CancellationReasons: input.TransactItems.map((_: unknown, index: number) => ({
                  Code: index === 0 ? "ConditionalCheckFailed" : "None",
                })),
              }),
            }),
          )
        }
        const error = yield* db.entities.Teams.update({ teamId: "t1" })
          .set({ name: "Renamed" })
          .cascade({ targets: [Players], mode: "transactional" })
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("CascadePartialFailure")
        expect(error).toMatchObject({ succeeded: 0, failed: 1 })
        expect(sends).toBe(3)
        // Each send one item smaller.
        const sizes = requests
          .filter((request) => request.command === "TransactWriteItems")
          .map((request) => request.input.TransactItems.length)
        expect(sizes).toEqual([4, 3, 2])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// restated immutable values
// ---------------------------------------------------------------------------

describe("an update restating an immutable value", () => {
  const seeded = Effect.gen(function* () {
    const db = yield* database
    yield* db.entities.Immutables.put(create("a1", "a@x.io"))
    requests.length = 0
    return db
  })

  it.effect("setting nothing else, as stored, reads the row once and sends nothing", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seeded
        const found = yield* db.entities.Immutables.update({ accountId: "a1" }).set({
          email: "a@x.io",
        })
        expect(found).toEqual({ accountId: "a1", email: "a@x.io", name: "n" })
        expect(commands()).toEqual(["GetItem"])
        expect(requests[0]!.input.ConsistentRead).toBe(true)
      }),
    ),
  )

  it.effect("setting nothing else, changing it, is ValidationError after one read", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seeded
        const result = yield* outcome(
          db.entities.Immutables.update({ accountId: "a1" }).set({ email: "b@x.io" }),
        )
        expect(result).toBe("ValidationError")
        expect(commands()).toEqual(["GetItem"])
      }),
    ),
  )

  it.effect("setting nothing else, in a transaction: as stored commits, changed is refused", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seeded
        const changed = yield* outcome(
          Transaction.transactWrite([
            db.entities.Immutables.update({ accountId: "a1" }).set({ email: "b@x.io" }),
            Plain.put(create("other", "o@x.io")),
          ]),
        )
        expect(changed).toBe("ValidationError")
        expect(commands()).toEqual(["GetItem"])
        expect(rowsOf("Plain")).toEqual([])
        const kept = yield* outcome(
          Transaction.transactWrite([
            db.entities.Immutables.update({ accountId: "a1" }).set({ email: "a@x.io" }),
            Plain.put(create("other", "o@x.io")),
          ]),
        )
        expect(kept).toBe("ok")
        expect(rowsOf("Plain")).toHaveLength(1)
      }),
    ),
  )

  it.effect("setting nothing else, with a condition, sends the value in the condition", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seeded
        const result = yield* outcome(
          db.entities.Immutables.update({ accountId: "a1" })
            .set({ email: "b@x.io" })
            .condition({ name: "n" }),
        )
        expect(result).toBe("ValidationError")
        expect(commands()).toEqual(["UpdateItem"])
        expect(requests[0]!.input.UpdateExpression).toBeUndefined()
        expect(requests[0]!.input.ConditionExpression).toContain("#imm0 = :imm0")
      }),
    ),
  )
})
