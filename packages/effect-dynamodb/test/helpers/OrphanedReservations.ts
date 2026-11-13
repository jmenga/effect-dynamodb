/**
 * `rekey`'s report of unique sentinels no row holds, and `releaseOrphanedReservations`.
 *
 * `fixtures/orphaned-reservations-1.39.0.json` holds what the published 1.39.0 stored for a unique
 * field holding a `Schema.BigInt`, by the writes each scenario names: a delete and an update that
 * left the old value's sentinel behind, a soft delete without `preserveUnique` that did too, and
 * the states that look like it and aren't (a live item, a tombstone under `preserveUnique`). The
 * scenarios seed those exact bytes, or a state only a writer outside the library leaves, on a
 * recording table (`OrphanedReservations.test.ts`) and on DynamoDB Local
 * (`connected.orphaned-reservations.test.ts`).
 */

import { readFileSync } from "node:fs"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Duration, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import { rekeyOutcome } from "./RekeyOutcome.js"
import type { Harness, RepairScenario, RepairTable } from "./RekeyRepair.js"
import { bothSettings } from "./RekeyRepair.js"

type StoredRow = Record<string, any>

const fixture: {
  readonly rows: ReadonlyArray<StoredRow>
} = JSON.parse(
  readFileSync(new URL("../fixtures/orphaned-reservations-1.39.0.json", import.meta.url), "utf8"),
)

/** The fixture's rows. */
export const ROWS_139 = fixture.rows

/**
 * What 1.39.0 stored for a unique `Schema.Duration`: a live row (`p1`, 5 s), the map it stored for
 * the value, and its sentinel, whose text is the instance's own (`5000 millis`); and the sentinel a
 * delete left (`p2`, 7 s), since 1.39.0 composed `[object object]` from the stored map to release it.
 */
const DURATION_ROWS_139: ReadonlyArray<StoredRow> = JSON.parse(
  readFileSync(new URL("../fixtures/duration-reservations-1.39.0.json", import.meta.url), "utf8"),
).rows

const Holding = Schema.Struct({ id: Schema.String, n: Schema.BigInt })
const Seat = Schema.Struct({ venue: Schema.String, seat: Schema.String, n: Schema.BigInt })
const Handle = Schema.Struct({ id: Schema.String, handle: Schema.String })
const Plan = Schema.Struct({ id: Schema.String, length: Schema.Duration })
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

/** The entities the fixture's rows were written by, on the fixture's schema name, and a few more. */
export const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "vu", version: 1, escapeKeys })
  const Accounts = Entity.make({
    model: Holding,
    entityType: "Account",
    primaryKey,
    unique: { number: ["n"] },
  })
  const Members = Entity.make({
    model: Holding,
    entityType: "Member",
    primaryKey,
    unique: { number: ["n"] },
    softDelete: true,
  })
  const Holders = Entity.make({
    model: Holding,
    entityType: "Holder",
    primaryKey,
    unique: { number: ["n"] },
    softDelete: { preserveUnique: true },
  })
  const Passes = Entity.make({
    model: Holding,
    entityType: "Pass",
    primaryKey,
    unique: { number: { fields: ["n"], ttl: Duration.hours(1) } },
  })
  const Renamed = Entity.make({
    model: DynamoModel.configure(Holding, { n: { field: "num" } }),
    entityType: "Renamed",
    primaryKey,
    unique: { number: ["n"] },
  })
  const Seats = Entity.make({
    model: Seat,
    entityType: "Seat",
    primaryKey: {
      pk: { field: "pk", composite: ["venue"] },
      sk: { field: "sk", composite: ["seat"] },
    },
    unique: { number: ["n"] },
    softDelete: { preserveUnique: true },
  })
  const Handles = Entity.make({
    model: Handle,
    entityType: "Handle",
    primaryKey,
    unique: { handle: ["handle"] },
  })
  const Tags = Entity.make({
    model: Handle,
    entityType: "Tag",
    primaryKey,
    unique: { handle: ["handle"] },
    softDelete: true,
  })
  const Plans = Entity.make({
    model: Plan,
    entityType: "Plan",
    primaryKey,
    unique: { length: ["length"] },
  })
  const entities = { Accounts, Members, Holders, Passes, Renamed, Seats, Handles, Tags, Plans }
  const MainTable = Table.make({ schema, entities })
  const client = DynamoClient.make({ entities, tables: { MainTable } })
  return { schema, MainTable, client }
}

const seedAll = (table: RepairTable, rows: ReadonlyArray<StoredRow> = ROWS_139) =>
  Effect.forEach(rows, (row) => table.seed(row), { discard: true })

const pk = (row: StoredRow) => row.pk?.S as string

/** The sentinel of `value` for `entity`'s `number` constraint, as the fixture's rows hold it. */
export const sentinelKey = (entity: string, value: number) => ({
  pk: `$vu#v1#${entity}.number#${String(value).padStart(38, "0")}`,
  sk: `$vu#v1#${entity}.number`,
})

export const sentinelRow = (
  entity: string,
  value: number,
  owner: { readonly pk: string; readonly sk: string } | undefined,
  extra: StoredRow = {},
): StoredRow => {
  const key = sentinelKey(entity, value)
  return {
    pk: { S: key.pk },
    sk: { S: key.sk },
    __edd_e__: { S: `${entity[0]!.toUpperCase()}${entity.slice(1)}._unique.number` },
    ...(owner !== undefined && { _entity_pk: { S: owner.pk }, _entity_sk: { S: owner.sk } }),
    ...extra,
  }
}

export const itemKey = (entity: string, id: string) => ({
  pk: `$vu#v1#${entity}#id_${id}`,
  sk: `$vu#v1#${entity}`,
})

export const itemRow = (
  entity: string,
  id: string,
  value: StoredRow,
  attribute = "n",
): StoredRow => ({
  pk: { S: itemKey(entity, id).pk },
  sk: { S: itemKey(entity, id).sk },
  id: { S: id },
  [attribute]: value,
  __edd_e__: { S: `${entity[0]!.toUpperCase()}${entity.slice(1)}` },
})

const has = (rows: ReadonlyArray<StoredRow>, key: { readonly pk: string; readonly sk: string }) =>
  rows.some((row) => row.pk?.S === key.pk && row.sk?.S === key.sk)

const WRITES = new Set([
  "putItem",
  "updateItem",
  "deleteItem",
  "batchWriteItem",
  "transactWriteItems",
])
const writesOf = (table: RepairTable) => table.requests().filter((r) => WRITES.has(r.command))
const transactsOf = (table: RepairTable) =>
  table.requests().filter((r) => r.command === "transactWriteItems")

const succeeds = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.map(Effect.exit(effect), (exit) => Exit.isSuccess(exit))
const failsWith = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isSuccess(exit)
      ? "ok"
      : ((exit.cause.reasons.find((r: any) => r._tag === "Fail") as any)?.error?._tag ?? "died"),
  )

const ZERO = { orphaned: 0, released: 0, skipped: 0, raced: 0, undecided: 0 }

const rekey = (db: any, options: Table.RekeyOptions = {}) =>
  db.tables.MainTable.rekey(options) as Effect.Effect<Table.RekeyReport, unknown>

/** Judge reservations and report them, deleting nothing. */
const JUDGE = { reservations: true } as const

/** Release orphaned reservations: a maintenance step, with writes stopped. */
const RELEASE = { releaseOrphanedReservations: true, writesStopped: true } as const

// ---------------------------------------------------------------------------
// The rows 1.39.0 left
// ---------------------------------------------------------------------------

/** The three the fixture's writes left behind, by key. */
const ORPHANS_139 = [
  {
    key: sentinelKey("account", 5),
    owner: itemKey("account", "a"),
    member: "Account",
    message: "The row it names doesn't exist.",
  },
  {
    key: sentinelKey("account", 7),
    owner: itemKey("account", "c"),
    member: "Account",
    message: `The row it names holds another value, whose sentinel is ${JSON.stringify(sentinelKey("account", 8))}.`,
  },
  {
    key: sentinelKey("member", 9),
    owner: itemKey("member", "m"),
    member: "Member",
    message: "The row it names doesn't exist.",
  },
]

const entriesOf = (report: Table.RekeyReport) =>
  [...report.reservations.entries].sort((a, b) =>
    (a.key.pk as string) < (b.key.pk as string) ? -1 : 1,
  )

export const fixtureScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings(
    "the rows 1.39.0 left are counted on every run that judges reservations, and nothing is written",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          yield* seedAll(table)
          const db = yield* w.client
          // Without `reservations`, as 1.40.0 counted them: the two no row names are
          // `unrecognizedKey`, and the one a tombstone names is left to it.
          const plain = yield* rekey(db)
          expect(plain.reservations).toEqual({ ...ZERO, entries: [] })
          expect(plain.skipped.unrecognizedKey).toBe(2)
          expect(writesOf(table)).toEqual([])
          const report = yield* rekey(db, JUDGE)
          expect(report.reservations).toMatchObject({ ...ZERO, orphaned: 3 })
          // By member, then key, whatever order the scan met them in.
          expect(report.reservations.entries).toEqual(entriesOf(report))
          expect(entriesOf(report)).toEqual(
            ORPHANS_139.map(({ key, owner, member, message }) => ({
              member,
              constraint: "number",
              key,
              owner,
              outcome: "orphaned",
              message,
            })),
          )
          expect(report.byMember.Account!.reservations).toEqual({ ...ZERO, orphaned: 2 })
          expect(report.byMember.Member!.reservations).toEqual({ ...ZERO, orphaned: 1 })
          expect(report.skipped.unrecognizedKey).toBe(0)
          expect(report.conflicts).toEqual([])
          expect(writesOf(table)).toEqual([])
          expect(yield* table.rows()).toEqual(ROWS_139)
          // And again: counting changes nothing.
          expect((yield* rekey(db, JUDGE)).reservations).toMatchObject({ ...ZERO, orphaned: 3 })
        }),
      )
    },
  ),
  ...bothSettings(
    "releaseOrphanedReservations releases them, and a dry run says so first",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          yield* seedAll(table)
          const db = yield* w.client
          const dry = yield* rekey(db, { ...RELEASE, dryRun: true })
          expect(dry.reservations).toMatchObject({ ...ZERO, orphaned: 3, released: 3 })
          expect(entriesOf(dry).map((entry) => entry.outcome)).toEqual([
            "released",
            "released",
            "released",
          ])
          expect(writesOf(table)).toEqual([])
          table.clear()
          const real = yield* rekey(db, RELEASE)
          expect(rekeyOutcome(real)).toEqual(rekeyOutcome(dry))
          const rows = yield* table.rows()
          for (const { key } of ORPHANS_139) expect(has(rows, key), key.pk).toBe(false)
          // Everything else is as 1.39.0 left it: the live values' sentinels, the preserved one.
          expect(rows).toEqual(
            ROWS_139.filter((row) => !ORPHANS_139.some(({ key }) => key.pk === pk(row))),
          )
          // One transaction each: the sentinel's conditioned Delete, and its row's ConditionCheck.
          const transacts = transactsOf(table)
          expect(transacts).toHaveLength(3)
          for (const { input } of transacts) {
            const [release, check] = input.TransactItems
            expect(release.Delete.ConditionExpression).toBe(
              "#epk = :epk AND #esk = :esk AND attribute_not_exists(#ttl)",
            )
            expect(check.ConditionCheck).toBeDefined()
          }
          expect(writesOf(table)).toHaveLength(3)
          // The values can be taken again; the rest stay reserved.
          expect(yield* failsWith(db.entities.Accounts.put({ id: "b", n: 5n }).asEffect())).toBe(
            "ok",
          )
          expect(yield* failsWith(db.entities.Accounts.put({ id: "x", n: 7n }).asEffect())).toBe(
            "ok",
          )
          expect(yield* failsWith(db.entities.Members.restore({ id: "m" }))).toBe("ok")
          expect(yield* failsWith(db.entities.Accounts.put({ id: "y", n: 8n }).asEffect())).toBe(
            "UniqueConstraintViolation",
          )
          expect(yield* failsWith(db.entities.Accounts.put({ id: "y", n: 13n }).asEffect())).toBe(
            "UniqueConstraintViolation",
          )
          expect(yield* failsWith(db.entities.Holders.put({ id: "k", n: 11n }).asEffect())).toBe(
            "UniqueConstraintViolation",
          )
          expect((yield* rekey(db, RELEASE)).reservations).toEqual({
            ...ZERO,
            entries: [],
          })
        }),
      )
    },
  ),
]

// ---------------------------------------------------------------------------
// Reservations a row holds
// ---------------------------------------------------------------------------

export const heldScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings(
    "a tombstone under preserveUnique keeps its reservation, and can be restored",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Holders.put({ id: "h2", n: 41n }).asEffect()
          yield* db.entities.Holders.delete({ id: "h2" }).asEffect()
          const before = yield* table.rows()
          expect(has(before, sentinelKey("holder", 41))).toBe(true)
          const report = yield* rekey(db, RELEASE)
          expect(report.reservations).toEqual({ ...ZERO, entries: [] })
          expect(yield* table.rows()).toEqual(before)
          expect(yield* failsWith(db.entities.Holders.put({ id: "z", n: 41n }).asEffect())).toBe(
            "UniqueConstraintViolation",
          )
          expect(yield* succeeds(db.entities.Holders.restore({ id: "h2" }))).toBe(true)
        }),
      )
    },
  ),
  ...bothSettings("a sibling's tombstone in the partition holds only its own value", (h, on) => {
    const w = world(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Seats.put({ venue: "hall", seat: "1", n: 31n }).asEffect()
        yield* db.entities.Seats.delete({ venue: "hall", seat: "1" }).asEffect()
        const rows = yield* table.rows()
        const kept = rows.find((row) => row.__edd_e__?.S === "Seat._unique.number")!
        // Seat 2's reservation, left by a write outside the library: no seat 2 row is anywhere.
        const seat2 = { pk: kept._entity_pk.S, sk: kept._entity_sk.S.replace(/1$/, "2") }
        expect(seat2.sk).not.toBe(kept._entity_sk.S)
        yield* table.seed(sentinelRow("seat", 32, seat2))
        const report = yield* rekey(db, RELEASE)
        expect(report.reservations).toMatchObject({ ...ZERO, orphaned: 1, released: 1 })
        expect(report.reservations.entries[0]).toMatchObject({
          key: sentinelKey("seat", 32),
          owner: seat2,
          message: "The row it names doesn't exist, nor does a tombstone of it.",
        })
        const after = yield* table.rows()
        expect(has(after, sentinelKey("seat", 32))).toBe(false)
        expect(has(after, sentinelKey("seat", 31))).toBe(true)
      }),
    )
  }),
  ...bothSettings(
    "a sibling's tombstone holding the value doesn't hold a sentinel naming another seat",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Seats.put({ venue: "hall", seat: "1", n: 31n }).asEffect()
          yield* db.entities.Seats.delete({ venue: "hall", seat: "1" }).asEffect()
          const kept = (yield* table.rows()).find(
            (row) => row.__edd_e__?.S === "Seat._unique.number",
          )!
          // A write outside the library pointed seat 1's reservation at seat 2, which isn't there.
          const seat2 = { pk: kept._entity_pk.S, sk: kept._entity_sk.S.replace(/1$/, "2") }
          yield* table.seed(sentinelRow("seat", 31, seat2))
          const report = yield* rekey(db, RELEASE)
          expect(report.reservations).toMatchObject({ ...ZERO, orphaned: 1, released: 1 })
          expect(has(yield* table.rows(), sentinelKey("seat", 31))).toBe(false)
          // Seat 1's tombstone takes the value back when it is restored.
          expect(yield* succeeds(db.entities.Seats.restore({ venue: "hall", seat: "1" }))).toBe(
            true,
          )
          expect(has(yield* table.rows(), sentinelKey("seat", 31))).toBe(true)
        }),
      )
    },
  ),
  ...bothSettings(
    "a tombstone in the partition that can't be told to be the item's leaves it undecided",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Seats.put({ venue: "hall", seat: "1", n: 31n }).asEffect()
          const live = (yield* table.rows()).find((row) => row.__edd_e__?.S === "Seat")!
          const seat2 = { pk: live.pk.S, sk: live.sk.S.replace(/1$/, "2") }
          // A tombstone with no seat: whose it is, nothing says.
          yield* table.seed({
            pk: live.pk,
            sk: { S: "$vu#v1#seat#deleted#2026-01-02T03:04:05.000Z" },
            venue: { S: "hall" },
            n: { N: "32" },
            deletedAt: { S: "2026-01-02T03:04:05.000Z" },
            __edd_e__: { S: "Seat" },
          })
          yield* table.seed(sentinelRow("seat", 32, seat2))
          table.clear()
          const report = yield* rekey(db, RELEASE)
          expect(report.reservations).toMatchObject({ ...ZERO, undecided: 1 })
          expect(report.reservations.entries[0]).toMatchObject({
            key: sentinelKey("seat", 32),
            owner: seat2,
            outcome: "undecided",
          })
          expect(writesOf(table)).toEqual([])
        }),
      )
    },
  ),
  ...bothSettings(
    "a sentinel under other key text its row holds is held, and moves with its row",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          // As the other setting stored them: the item's key has nothing to escape, the value has.
          const other = DynamoSchema.make({ name: "vu", version: 1, escapeKeys: !on })
          const text = (under: DynamoSchema.DynamoSchema) =>
            KeyComposer.keyText(under, KeyComposer.compositeText(under, "x y"), under.casing)
          const stored = DynamoSchema.composeUniqueKey(other, "Handle", "handle", [text(other)])
          const current = DynamoSchema.composeUniqueKey(w.schema, "Handle", "handle", [
            text(w.schema),
          ])
          expect(stored.pk).not.toBe(current.pk)
          yield* table.seed({ ...itemRow("handle", "a", { S: "x y" }, "handle") })
          yield* table.seed({
            pk: { S: stored.pk },
            sk: { S: stored.sk },
            __edd_e__: { S: "Handle._unique.handle" },
            _entity_pk: { S: itemKey("handle", "a").pk },
            _entity_sk: { S: itemKey("handle", "a").sk },
          })
          const dry = yield* rekey(db, { ...RELEASE, dryRun: true })
          expect(dry.reservations).toEqual({ ...ZERO, entries: [] })
          const real = yield* rekey(db, RELEASE)
          expect(real.reservations).toEqual({ ...ZERO, entries: [] })
          expect(real.sentinelsMoved).toBe(1)
          const rows = yield* table.rows()
          expect(has(rows, current)).toBe(true)
          expect(has(rows, stored)).toBe(false)
        }),
      )
    },
  ),
  ...bothSettings(
    "a sentinel naming a tombstone without preserveUnique moves with it, and is reported",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          // Soft-deleted without preserveUnique: the delete released the value.
          yield* db.entities.Tags.put({ id: "t", handle: "x y" }).asEffect()
          yield* db.entities.Tags.delete({ id: "t" }).asEffect()
          const other = DynamoSchema.make({ name: "vu", version: 1, escapeKeys: !on })
          const text = (under: DynamoSchema.DynamoSchema) =>
            KeyComposer.keyText(under, KeyComposer.compositeText(under, "x y"), under.casing)
          const stored = DynamoSchema.composeUniqueKey(other, "Tag", "handle", [text(other)])
          const current = DynamoSchema.composeUniqueKey(w.schema, "Tag", "handle", [text(w.schema)])
          expect(stored.pk).not.toBe(current.pk)
          // As an earlier release's soft delete left it, under the other setting's text.
          yield* table.seed({
            pk: { S: stored.pk },
            sk: { S: stored.sk },
            __edd_e__: { S: "Tag._unique.handle" },
            _entity_pk: { S: itemKey("tag", "t").pk },
            _entity_sk: { S: itemKey("tag", "t").sk },
          })
          const entry = {
            member: "Tag",
            constraint: "handle",
            key: stored,
            owner: itemKey("tag", "t"),
            message: "The row it names doesn't exist.",
          }
          // Released, it doesn't move.
          const dry = yield* rekey(db, { ...RELEASE, dryRun: true })
          expect(dry.sentinelsMoved).toBe(0)
          expect(dry.reservations).toEqual({
            ...ZERO,
            orphaned: 1,
            released: 1,
            entries: [{ ...entry, outcome: "released" }],
          })
          // Otherwise it moves as it did, the value still reserved, and is reported.
          const counted = yield* rekey(db, JUDGE)
          expect(counted.sentinelsMoved).toBe(1)
          expect(counted.reservations).toEqual({
            ...ZERO,
            orphaned: 1,
            entries: [{ ...entry, outcome: "orphaned" }],
          })
          expect(has(yield* table.rows(), current)).toBe(true)
          expect(
            yield* failsWith(db.entities.Tags.put({ id: "u", handle: "x y" }).asEffect()),
          ).toBe("UniqueConstraintViolation")
          const released = yield* rekey(db, RELEASE)
          expect(released.sentinelsMoved).toBe(0)
          expect(released.reservations).toEqual({
            ...ZERO,
            orphaned: 1,
            released: 1,
            entries: [{ ...entry, key: current, outcome: "released" }],
          })
          const rows = yield* table.rows()
          expect(has(rows, stored)).toBe(false)
          expect(has(rows, current)).toBe(false)
          expect(yield* succeeds(db.entities.Tags.put({ id: "u", handle: "x y" }).asEffect())).toBe(
            true,
          )
        }),
      )
    },
  ),
  ...bothSettings(
    "a field renamed by configure is read and guarded under its stored name",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Renamed.put({ id: "c", n: 7n }).asEffect()
          // A write outside the library changed the value: the old sentinel is left.
          yield* table.seed(itemRow("renamed", "c", { N: "8" }, "num"))
          table.clear()
          const report = yield* rekey(db, RELEASE)
          expect(report.reservations).toMatchObject({ ...ZERO, orphaned: 1, released: 1 })
          const [release] = transactsOf(table)
          const check = release!.input.TransactItems[1].ConditionCheck
          expect(Object.values(check.ExpressionAttributeNames)).toContain("num")
          expect(Object.values(check.ExpressionAttributeNames)).not.toContain("n")
          expect(has(yield* table.rows(), sentinelKey("renamed", 7))).toBe(false)
        }),
      )
    },
  ),
]

// ---------------------------------------------------------------------------
// A writer in between
// ---------------------------------------------------------------------------

export const orphanOf5 = sentinelRow("account", 5, itemKey("account", "a"))

export const racingScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings(
    "a reservation another item claims before the release is never deleted",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          yield* table.seed(orphanOf5)
          const db = yield* w.client
          const claimed = sentinelRow("account", 5, itemKey("account", "z"))
          let writes = 0
          table.beforeTransact(() => {
            writes++
            return writes === 1
              ? Effect.andThen(table.seed(itemRow("account", "z", { N: "5" })), table.seed(claimed))
              : Effect.void
          })
          const report = yield* rekey(db, RELEASE)
          expect(writes).toBe(1)
          // As it is now, a row holds it: not orphaned, and never counted so.
          expect(report.reservations).toMatchObject({ ...ZERO, raced: 1 })
          expect(report.reservations.entries[0]!.outcome).toBe("raced")
          expect(report.reservations.entries[0]!.message).toContain(
            "A write claimed it, or gave the row it names its value, before the release",
          )
          expect(
            (yield* table.rows()).find((row) => pk(row) === sentinelKey("account", 5).pk),
          ).toEqual(claimed)
        }),
      )
    },
  ),
  ...bothSettings(
    "a reservation a write deletes before the release is raced, not orphaned",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          yield* table.seed(orphanOf5)
          const db = yield* w.client
          let writes = 0
          table.beforeTransact(() => {
            writes++
            return writes === 1 ? table.remove(orphanOf5) : Effect.void
          })
          const report = yield* rekey(db, RELEASE)
          expect(writes).toBe(1)
          expect(report.reservations).toMatchObject({ ...ZERO, raced: 1 })
          expect(report.reservations.entries[0]!.outcome).toBe("raced")
          expect(report.reservations.entries[0]!.message).toContain(
            "A write deleted it before the release",
          )
          expect(has(yield* table.rows(), sentinelKey("account", 5))).toBe(false)
        }),
      )
    },
  ),
  ...bothSettings(
    "the row it names, put again with the value before the release, keeps it",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          yield* table.seed(orphanOf5)
          const db = yield* w.client
          let writes = 0
          // The back-pointer still names `a`: only the row's ConditionCheck can tell.
          table.beforeTransact(() => {
            writes++
            return writes === 1 ? table.seed(itemRow("account", "a", { N: "5" })) : Effect.void
          })
          const report = yield* rekey(db, RELEASE)
          expect(writes).toBe(1)
          expect(report.reservations).toMatchObject({ ...ZERO, raced: 1 })
          expect(has(yield* table.rows(), sentinelKey("account", 5))).toBe(true)
        }),
      )
    },
  ),
  ...bothSettings("its row, given the value back before the release, keeps it", (h, on) => {
    const w = world(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Renamed.put({ id: "c", n: 7n }).asEffect()
        yield* table.seed(itemRow("renamed", "c", { N: "8" }, "num"))
        let writes = 0
        table.beforeTransact(() => {
          writes++
          return writes === 1 ? table.seed(itemRow("renamed", "c", { N: "7" }, "num")) : Effect.void
        })
        const report = yield* rekey(db, RELEASE)
        expect(writes).toBe(1)
        expect(report.reservations).toMatchObject({ ...ZERO, raced: 1 })
        expect(has(yield* table.rows(), sentinelKey("renamed", 7))).toBe(true)
      }),
    )
  }),
  ...bothSettings(
    "a writer changing its row every time wins: counted skipped, and left",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          yield* seedAll(table)
          const db = yield* w.client
          let writes = 0
          table.beforeTransact((input) => {
            const release = input.TransactItems[0].Delete
            if (release.Key.pk.S !== sentinelKey("account", 7).pk) return Effect.void
            writes++
            // Still holding 8, so still not 7: only what the row's ConditionCheck guards changes.
            return table.seed({
              ...itemRow("account", "c", { N: "8" }),
              __edd_d__: { SS: [`other${writes}`] },
            })
          })
          const report = yield* rekey(db, RELEASE)
          expect(writes).toBe(2)
          expect(report.reservations).toMatchObject({
            ...ZERO,
            orphaned: 3,
            released: 2,
            skipped: 1,
          })
          const skipped = report.reservations.entries.find((entry) => entry.outcome === "skipped")!
          expect(skipped.key).toEqual(sentinelKey("account", 7))
          expect(skipped.message).toContain("before each release")
          expect(has(yield* table.rows(), sentinelKey("account", 7))).toBe(true)
        }),
      )
    },
  ),
  ...bothSettings(
    "a TTL'd reservation taken again under the same back-pointer is judged again",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const owner = itemKey("pass", "p")
          yield* table.seed(sentinelRow("pass", 5, owner, { _ttl: { N: "1000" } }))
          const db = yield* w.client
          let writes = 0
          table.beforeTransact(() => {
            writes++
            return writes === 1
              ? table.seed(sentinelRow("pass", 5, owner, { _ttl: { N: "2000" } }))
              : Effect.void
          })
          const report = yield* rekey(db, RELEASE)
          // The first release named the expiry it read, and lost; the second names the new one.
          const transacts = transactsOf(table)
          expect(transacts).toHaveLength(2)
          expect(
            transacts[0]!.input.TransactItems[0].Delete.ExpressionAttributeValues[":ttl"],
          ).toEqual({
            N: "1000",
          })
          expect(
            transacts[1]!.input.TransactItems[0].Delete.ExpressionAttributeValues[":ttl"],
          ).toEqual({
            N: "2000",
          })
          expect(report.reservations).toMatchObject({ ...ZERO, orphaned: 1, released: 1 })
          expect(has(yield* table.rows(), sentinelKey("pass", 5))).toBe(false)
        }),
      )
    },
  ),
]

// ---------------------------------------------------------------------------
// What isn't judged, and what can't be
// ---------------------------------------------------------------------------

export const untouchedScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings(
    "a sentinel of a value without key text of its own (a Duration 1.39.0 stored) is undecided, and left",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          yield* seedAll(table, DURATION_ROWS_139)
          const db = yield* w.client
          const options = { releaseOrphanedReservations: true, writesStopped: true } as const
          const dry = yield* rekey(db, { ...options, dryRun: true })
          const real = yield* rekey(db, options)
          expect(rekeyOutcome(real)).toEqual(rekeyOutcome(dry))
          expect(real.reservations).toMatchObject({ ...ZERO, undecided: 1 })
          // p1 is live, and the map 1.39.0 stored reads back as the Duration whose text composed
          // its sentinel's key: it holds it, and isn't listed (with escapeKeys on, the sentinel
          // moves to the text the value composes now). p2 is gone, and a Duration composes no text
          // that finds its sentinel, so p2 may live under another key: nothing proves it orphaned.
          expect(real.sentinelsMoved).toBe(on ? 1 : 0)
          expect(
            entriesOf(real).map(({ owner, outcome, message }) => ({ owner, outcome, message })),
          ).toEqual([
            {
              owner: itemKey("plan", "p2"),
              outcome: "undecided",
              message:
                "The row it names doesn't exist, and the constraint's values can be ones without " +
                "key text of their own, so the row may have moved without its sentinel.",
            },
          ])
          const rows = yield* table.rows()
          if (on) {
            const expected = DURATION_ROWS_139.map((row) =>
              row.pk?.S === "$vu#v1#plan.length#5000 millis"
                ? { ...row, pk: { S: "$vu#v1#plan.length#5000%20millis" } }
                : row,
            )
            expect(rows).toHaveLength(expected.length)
            expect(rows).toEqual(expect.arrayContaining(expected))
          } else {
            expect(writesOf(table)).toEqual([])
            expect(rows).toEqual(DURATION_ROWS_139)
          }
          const p1 = (yield* db.entities.Plans.get({ id: "p1" })) as { length: Duration.Duration }
          expect(Duration.toMillis(p1.length)).toBe(5000)
        }),
      )
    },
  ),
  ...bothSettings("a sentinel naming no row is undecided, and left", (h, on) => {
    const w = world(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* table.seed(sentinelRow("account", 21, undefined))
        const report = yield* rekey(db, RELEASE)
        expect(report.reservations).toMatchObject({ ...ZERO, undecided: 1 })
        expect(report.reservations.entries[0]).toMatchObject({
          key: sentinelKey("account", 21),
          owner: undefined,
          outcome: "undecided",
        })
        expect(writesOf(table)).toEqual([])
        expect(has(yield* table.rows(), sentinelKey("account", 21))).toBe(true)
      }),
    )
  }),
  ...bothSettings("a sentinel naming a row of another type is undecided, and left", (h, on) => {
    const w = world(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Members.put({ id: "q", n: 50n }).asEffect()
        yield* table.seed(sentinelRow("account", 22, itemKey("member", "q")))
        table.clear()
        const report = yield* rekey(db, RELEASE)
        expect(report.reservations).toMatchObject({ ...ZERO, undecided: 1 })
        expect(report.reservations.entries[0]!.message).toBe(
          'The row it names is a "Member" row, not a "Account".',
        )
        expect(writesOf(table)).toEqual([])
      }),
    )
  }),
  ...bothSettings(
    "a sentinel of a constraint the entity doesn't declare is never touched",
    (h, on) => {
      const w = world(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          const row = {
            pk: { S: "$vu#v1#account.retired#x" },
            sk: { S: "$vu#v1#account.retired" },
            __edd_e__: { S: "Account._unique.retired" },
            _entity_pk: { S: itemKey("account", "gone").pk },
            _entity_sk: { S: itemKey("account", "gone").sk },
          }
          // A name every object answers to isn't a constraint either.
          const inherited = {
            pk: { S: `$vu#v1#account.constructor#${"5".padStart(38, "0")}` },
            sk: { S: "$vu#v1#account.constructor" },
            __edd_e__: { S: "Account._unique.constructor" },
            _entity_pk: { S: itemKey("account", "gone").pk },
            _entity_sk: { S: itemKey("account", "gone").sk },
          }
          yield* table.seed(row)
          yield* table.seed(inherited)
          const report = yield* rekey(db, RELEASE)
          expect(report.reservations).toEqual({ ...ZERO, entries: [] })
          expect(report.skipped.unrecognizedKey).toBe(2)
          expect(yield* table.rows()).toEqual([inherited, row])
        }),
      )
    },
  ),
  ...bothSettings("a sentinel under another schema's prefix is never touched", (h, on) => {
    const w = world(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const row = {
          pk: { S: `$other#v1#account.number#${"5".padStart(38, "0")}` },
          sk: { S: "$other#v1#account.number" },
          __edd_e__: { S: "Account._unique.number" },
          _entity_pk: { S: "$other#v1#account#id_a" },
          _entity_sk: { S: "$other#v1#account" },
        }
        // And one whose sort key is this schema's, but whose partition key isn't.
        const halfway = { ...row, sk: { S: "$vu#v1#account.number" } }
        yield* table.seed(row)
        yield* table.seed(halfway)
        const report = yield* rekey(db, RELEASE)
        expect(report.reservations).toEqual({ ...ZERO, entries: [] })
        expect(report.skipped.unrecognizedKey).toBe(2)
        expect(yield* table.rows()).toEqual([row, halfway])
      }),
    )
  }),
]

/**
 * A row whose values compose no sentinel key under some text: a number DynamoDB itself can't
 * store (`NaN`), so only on the recording table.
 */
export const recordingOnlyScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("a row whose values compose no sentinel key is undecided, and left", (h, on) => {
    const w = world(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* table.seed(itemRow("account", "a", { N: "NaN" }))
        yield* table.seed(orphanOf5)
        const report = yield* rekey(db, RELEASE)
        expect(report.reservations).toMatchObject({ ...ZERO, undecided: 1 })
        expect(report.reservations.entries[0]!.owner).toEqual(itemKey("account", "a"))
        expect(writesOf(table)).toEqual([])
      }),
    )
  }),
]

export type { Harness }
