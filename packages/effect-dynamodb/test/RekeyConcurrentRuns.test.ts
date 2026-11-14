/**
 * `rekey` runs started together (#240). Each move is conditioned on what it read, so two or three
 * runs over one table end where one run ends, and no unique sentinel is left naming a key its row
 * left: a move holds every sentinel key it read and doesn't write as it read it, so a sentinel
 * brought to its current key between the move's reads fails the move, which reads again and takes
 * it along; and a sentinel moved by itself, naming its row where it is, holds that row there. Up to
 * 1.40.0 about one table in 240 kept such a sentinel, which a run releasing orphans would take for
 * an orphan and release, letting a second item take its value. A table already in that state is
 * repaired: the sentinel is brought to the row holding its value, whichever the scan meets first,
 * and never released.
 *
 * The tables that once kept such a sentinel are pinned by seed below; the sweep over random tables
 * runs ten a direction (at one in 240, forty never reliably met one either).
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import { Deferred, Effect, Layer, Schema } from "effect"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { type Around, gatedLayer, putsAt } from "./helpers/GatedClient.js"
import {
  jittered,
  type Row,
  randomWorld,
  rekeyOnce,
  rekeyRuns,
  scanShuffled,
  strayed,
  tableOf,
  takenValues,
  takeValue,
  takeValueOn,
  writeRandom,
  yieldingFirst,
} from "./helpers/RandomTables.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"
import { storedRows } from "./helpers/StoredRows.js"

const RUNS = [
  { segments: 2, pageSize: 3 },
  { segments: 3, pageSize: 2 },
  { segments: 1, pageSize: 4 },
] as const

/** Release what no row holds, then try to take every value a row holds: each must be refused. */
const valuesStillReserved = (escapeKeys: boolean, table: ReturnType<typeof makeRecordingTable>) =>
  Effect.gen(function* () {
    const release = yield* rekeyOnce(escapeKeys, table, {
      releaseOrphanedReservations: true,
      writesStopped: true,
    })
    const taken = takenValues(table.items.values())
    const accepted: Array<string> = []
    for (const [n, value] of taken.entries()) {
      const outcome = yield* takeValue(escapeKeys, table, value, n)
      if (outcome !== "refused") accepted.push(`${value.member} ${value.value}: ${outcome}`)
    }
    return { reservations: release.reservations, accepted }
  })

const SEEDS = 10

describe.each([
  ["to on", true],
  ["to off", false],
] as const)("rekey runs started together, %s", (_direction, escapeKeys) => {
  for (const together of [2, 3]) {
    it.effect(
      `${together} runs at once over ${SEEDS} random tables end where one run ends`,
      () =>
        Effect.gen(function* () {
          for (let seed = 1; seed <= SEEDS; seed++) {
            const at = `seed ${seed}`
            const rows = yield* writeRandom(!escapeKeys, seed)
            const alone = tableOf(rows)
            yield* rekeyOnce(escapeKeys, alone, RUNS[0])
            const table = tableOf(rows)
            yield* rekeyRuns(escapeKeys, table, RUNS.slice(0, together), yieldingFirst)
            // Before any later run could repair one, no sentinel names a key its row left.
            expect(strayed([...table.items.values()]), `${at}, right after`).toEqual([])
            // What a conflict left, one run alone takes.
            yield* rekeyOnce(escapeKeys, table, RUNS[0])
            expect(strayed([...table.items.values()]), at).toEqual([])
            expect(storedRows(table.items.values()), at).toEqual(storedRows(alone.items.values()))
            const after = yield* valuesStillReserved(escapeKeys, table)
            expect(after.reservations, at).toMatchObject({
              orphaned: 0,
              released: 0,
              undecided: 0,
            })
            expect(after.accepted, at).toEqual([])
          }
        }),
      120_000,
    )
  }
})

/**
 * Runs at once that, before a move held the sentinel keys it read and a re-point the row it names,
 * left a sentinel naming the key its row left, found over 120 random tables in each direction with
 * two and three runs, each request yielding first or a random number of times: each must leave
 * every sentinel naming its row before any later run, then a run releasing orphans must release
 * none, and every value a row holds must still be refused to a new item.
 */
const LEFT_A_SENTINEL_BEHIND = [
  { escapeKeys: true, seed: 12, together: 2, jitter: true },
  { escapeKeys: true, seed: 62, together: 2, jitter: true },
  { escapeKeys: true, seed: 76, together: 2, jitter: true },
  { escapeKeys: true, seed: 110, together: 3, jitter: false },
  { escapeKeys: false, seed: 4, together: 2, jitter: true },
  { escapeKeys: false, seed: 18, together: 2, jitter: false },
  { escapeKeys: false, seed: 36, together: 2, jitter: true },
  { escapeKeys: false, seed: 59, together: 2, jitter: true },
] as const

describe("runs at once that once left a sentinel behind", () => {
  for (const { escapeKeys, seed, together, jitter } of LEFT_A_SENTINEL_BEHIND) {
    it.effect(
      `to ${escapeKeys ? "on" : "off"}, seed ${seed}, ${together} runs, ${jitter ? "yielding at random" : "yielding first"}`,
      () =>
        Effect.gen(function* () {
          const rows = yield* writeRandom(!escapeKeys, seed)
          const table = tableOf(rows)
          yield* rekeyRuns(
            escapeKeys,
            table,
            RUNS.slice(0, together),
            jitter ? jittered(seed * 7 + together) : yieldingFirst,
          )
          expect(strayed([...table.items.values()])).toEqual([])
          const after = yield* valuesStillReserved(escapeKeys, table)
          expect(after.reservations).toMatchObject({ orphaned: 0, released: 0, undecided: 0 })
          expect(after.accepted).toEqual([])
        }),
    )
  }
})

/**
 * A sentinel brought by itself to the row it names, a row that stays where it is, holds the row as
 * read. An update giving the row another value between the pass's read and its write fails the
 * write, and the sentinel is left under its old key text, where the update didn't see it: brought
 * to the current key naming a row that no longer holds its value, it would refuse that value to
 * every new item.
 */
describe("a sentinel brought to a row that stays, the row given another value meanwhile", () => {
  it.effect("is left where it was, and its value can be taken again", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const off = randomWorld(false)
      const on = randomWorld(true)
      // The id's key text is the same both ways, so the row stays; its email's isn't.
      yield* Effect.gen(function* () {
        const db = yield* off.client
        yield* db.entities.Members.put({ id: "plain", email: "a b", nick: "n" }).asEffect()
      }).pipe(Effect.provide(Layer.merge(table.layer, off.MainTable.layer({ name: "t" }))))
      const update = Effect.gen(function* () {
        const db = yield* on.client
        yield* db.entities.Members.update({ id: "plain" }).set({ email: "c d" }).asEffect()
      }).pipe(Effect.provide(Layer.merge(table.layer, on.MainTable.layer({ name: "t" }))))
      let raced = false
      const around: Around = (command, input, send) => {
        const brings =
          command === "transactWriteItems" &&
          ((input as any).TransactItems ?? []).some(
            (item: any) => item.Put?.Item?.pk?.S === "$fz#v1#member.email#a%20b",
          )
        if (raced || !brings) return send
        raced = true
        return Effect.andThen(update, send)
      }
      const report = yield* rekeyOnce(true, table, {}, around)
      expect(raced).toBe(true)
      expect(report.conflicts).toEqual([])
      const sentinels = [...table.items.values()]
        .filter((row) => row.__edd_e__?.S === "Member._unique.email")
        .map((row) => row.pk?.S)
        .sort()
      expect(sentinels).toEqual(["$fz#v1#member.email#a b", "$fz#v1#member.email#c%20d"])
      const take = (value: string, n: number) =>
        takeValueOn(true, table.layer, "t", { member: "Members", value: `email:${value}` }, n)
      expect(yield* take("a b", 1)).toBe("accepted")
      expect(yield* take("c d", 2)).toBe("refused")
    }),
  )
})

/**
 * Runs started together with their requests answered at random speeds (`jittered`), over the tables
 * where that once left rows a later run couldn't move. An aggregate whose root another run had just
 * moved read its old partition, where a third aggregate's move had brought that one's rows (the old
 * partition being where its values compose a key now), and took them for its own: moved into its
 * partition, or refused as two elements at one sort key. A stream another run had moved away was
 * flipped on its old partition, where another stream's move had brought its first event: that
 * event carried the moved mark ever after, under both keys, and its stream was reported `bothKeys`
 * or its partition `taken` on every run. Rows under an aggregate's old partition are its own only
 * while its root is there, and a flip marks only the stream's own first event.
 */
describe.each([
  ["to on", true],
  ["to off", false],
] as const)("rekey runs started together, answered at random speeds, %s", (_direction, escapeKeys) => {
  for (const seed of [2, 10, 16, 36, 46, 48]) {
    it.effect(
      `seed ${seed}: end where one run ends, however their requests interleave`,
      () =>
        Effect.gen(function* () {
          const rows = yield* writeRandom(!escapeKeys, seed)
          const options = { segments: 2, concurrency: 4, pageSize: 3 }
          const alone = tableOf(rows)
          yield* rekeyOnce(escapeKeys, alone, options)
          for (let jitter = 1; jitter <= 8; jitter++) {
            const at = `jitter ${jitter}`
            const table = tableOf(rows)
            const runs = [options, { ...RUNS[1], concurrency: 4 }, { ...RUNS[2], concurrency: 4 }]
            yield* rekeyRuns(
              escapeKeys,
              table,
              runs.slice(0, 2 + (jitter % 2)),
              jittered(seed * 1000 + jitter),
            )
            const after = yield* rekeyOnce(escapeKeys, table, options)
            expect(after.conflicts, at).toEqual([])
            expect(strayed([...table.items.values()]), at).toEqual([])
            expect(storedRows(table.items.values()), at).toEqual(storedRows(alone.items.values()))
          }
        }),
      60_000,
    )
  }
})

/**
 * Two Members whose ids, emails and nicks chain: two runs at once once left one's nick sentinel at
 * its current key naming the key its row had left, in either direction.
 */
const twoMembers = (escapeKeys: boolean) =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    const world = randomWorld(escapeKeys)
    yield* Effect.gen(function* () {
      const db = yield* world.client
      yield* db.entities.Members.put({
        id: "a%252520b",
        email: "a%20b",
        nick: "a%2520b",
      }).asEffect()
      yield* db.entities.Members.put({ id: "a b", email: "a%2520b", nick: "a%20b" }).asEffect()
    }).pipe(Effect.provide(table.layer), Effect.provide(world.MainTable.layer({ name: "t" })))
    return [...table.items.values()]
  })

describe("two rekey runs at once over two Members whose keys chain", () => {
  for (const escapeKeys of [true, false]) {
    it.effect(`leave each sentinel naming its row, to ${escapeKeys ? "on" : "off"}`, () =>
      Effect.gen(function* () {
        const rows = yield* twoMembers(!escapeKeys)
        const alone = tableOf(rows)
        yield* rekeyOnce(escapeKeys, alone, RUNS[0])
        const table = tableOf(rows)
        yield* rekeyRuns(escapeKeys, table, RUNS.slice(0, 2), yieldingFirst)
        expect(strayed([...table.items.values()])).toEqual([])
        expect(storedRows(table.items.values())).toEqual(storedRows(alone.items.values()))
        const after = yield* valuesStillReserved(escapeKeys, table)
        expect(after.reservations).toMatchObject({ orphaned: 0, released: 0, undecided: 0 })
        expect(after.accepted).toEqual([])
      }),
    )
  }
})

/**
 * Two 1.40.0 runs at once over one random table (`rekey-two-runs-1.40.0.json`) left a `preserveUnique`
 * tombstone's sentinel naming a key where no row of its entity is: one run brings it to the
 * tombstone, ending where one run over the written table ends, and a run releasing orphans then
 * releases nothing.
 */
describe("a table two 1.40.0 runs at once left with a sentinel naming no row", () => {
  it.effect("is repaired by one run", () =>
    Effect.gen(function* () {
      const fixture: {
        readonly written: ReadonlyArray<Row>
        readonly leftBy140: ReadonlyArray<Row>
      } = JSON.parse(
        readFileSync(new URL("./fixtures/rekey-two-runs-1.40.0.json", import.meta.url), "utf8"),
      )
      expect(strayed(fixture.leftBy140)).toHaveLength(1)
      const alone = tableOf(fixture.written)
      yield* rekeyOnce(false, alone, RUNS[0])
      const table = tableOf(fixture.leftBy140)
      const report = yield* rekeyOnce(false, table, RUNS[0])
      expect(report.sentinelsMoved).toBe(1)
      expect(report.conflicts).toEqual([])
      expect(strayed([...table.items.values()])).toEqual([])
      expect(storedRows(table.items.values())).toEqual(storedRows(alone.items.values()))
      const after = yield* valuesStillReserved(false, table)
      expect(after.reservations).toMatchObject({ orphaned: 0, released: 0, undecided: 0 })
      expect(after.accepted).toEqual([])
    }),
  )
})

/** What a run decided, conflicts in an order of their own. */
const decided = (report: Parameters<typeof rekeyOutcome>[0]) => {
  const { conflicts, ...rest } = rekeyOutcome(report)
  return {
    ...rest,
    conflicts: [...conflicts].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  }
}

/**
 * A table a run before this fix left with a sentinel naming the key its row left: the row moved to
 * its current key, its sentinel under `where` (its current key, or its old key text) naming the
 * row's old key. Built from one clean run by pointing the sentinel back.
 */
const leftDangling = (where: "current" | "old") =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    const off = randomWorld(false)
    yield* Effect.gen(function* () {
      const db = yield* off.client
      yield* db.entities.Members.put({ id: "a b", email: "x y", nick: "plain" }).asEffect()
      yield* db.entities.Members.put({ id: "other", email: "other", nick: "z z" }).asEffect()
    }).pipe(Effect.provide(table.layer), Effect.provide(off.MainTable.layer({ name: "t" })))
    yield* rekeyOnce(true, table, {})
    const oldKey = { pk: "$fz#v1#member#id_a b", sk: "$fz#v1#member" }
    const current = "$fz#v1#member.email#x%20y|$fz#v1#member.email"
    const sentinel = table.items.get(current)!
    table.items.delete(current)
    const stored =
      where === "current"
        ? sentinel
        : {
            ...sentinel,
            pk: { S: "$fz#v1#member.email#x y" },
          }
    table.items.set(`${stored.pk!.S}|${stored.sk!.S}`, {
      ...stored,
      _entity_pk: { S: oldKey.pk },
      _entity_sk: { S: oldKey.sk },
    })
    return [...table.items.values()]
  })

describe.each([
  ["under its current key", "current"],
  ["under its old key text", "old"],
] as const)("a sentinel left naming the key its row left, %s", (_, where) => {
  const first = new Map<string, unknown>()
  for (const segments of [1, 2, 4, 8]) {
    for (const order of [0, 1, 2]) {
      it.effect(`is brought to its row: ${segments} segment(s), order ${order}`, () =>
        Effect.gen(function* () {
          const rows = yield* leftDangling(where)
          const table = tableOf(rows)
          const options = { segments, concurrency: 4, pageSize: 2 }
          const dry = yield* rekeyOnce(
            true,
            table,
            { ...options, dryRun: true },
            scanShuffled(order),
          )
          expect(storedRows(table.items.values())).toEqual(storedRows(rows))
          const real = yield* rekeyOnce(true, table, options, scanShuffled(order))
          expect(decided(dry)).toEqual(decided(real))
          expect(real.sentinelsMoved).toBe(1)
          expect(real.skipped.unrecognizedKey).toBe(0)
          expect(real.conflicts).toEqual([])
          expect(strayed([...table.items.values()])).toEqual([])
          const sentinel = table.items.get("$fz#v1#member.email#x%20y|$fz#v1#member.email")
          expect(sentinel?._entity_pk?.S).toBe("$fz#v1#member#id_a%20b")
          const again = yield* rekeyOnce(true, table, options)
          expect(again.sentinelsMoved).toBe(0)
          const outcome = { report: decided(real), rows: storedRows(table.items.values()) }
          const seen = first.get("outcome")
          if (seen === undefined) first.set("outcome", outcome)
          else expect(outcome).toEqual(seen)
        }),
      )
    }
  }

  it.effect("is held, not released, by a run releasing orphans, then brought to its row", () =>
    Effect.gen(function* () {
      const rows = yield* leftDangling(where)
      for (const order of [0, 1, 2]) {
        const table = tableOf(rows)
        const release = yield* rekeyOnce(
          true,
          table,
          { releaseOrphanedReservations: true, writesStopped: true, pageSize: 2 },
          scanShuffled(order),
        )
        expect(release.reservations).toMatchObject({ orphaned: 0, released: 0, undecided: 0 })
        expect(strayed([...table.items.values()])).toEqual([])
        const outcome = yield* takeValue(true, table, { member: "Members", value: "email:x y" }, 0)
        expect(outcome).toBe("refused")
      }
    }),
  )
})

const badgeKey = {
  pk: { field: "pk", composite: ["team"] },
  sk: { field: "sk", composite: ["id"] },
} as const

/** Badges, keyed by team and id: a row with a space in both has three key texts. */
const badges = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "ad", version: 1, escapeKeys })
  const Badges = Entity.make({
    model: Schema.Struct({ team: Schema.String, id: Schema.String, email: Schema.String }),
    entityType: "Badge",
    primaryKey: badgeKey,
    unique: { email: ["email"] },
  })
  const MainTable = Table.make({ schema, entities: { Badges } })
  return {
    schema,
    MainTable,
    client: DynamoClient.make({ entities: { Badges }, tables: { MainTable } }),
  }
}

/**
 * A badge written by 1.36 (`team_t u`, `id_a b`) and moved to its 1.37 text (`id_a%20b`) by a run
 * that left its sentinel naming the 1.36 key, as runs of 1.37 to 1.40 at once could.
 */
const leftAt137 = Effect.gen(function* () {
  const table = makeRecordingTable()
  const off = badges(false)
  yield* Effect.gen(function* () {
    const db = yield* off.client
    yield* db.entities.Badges.put({ team: "t u", id: "a b", email: "x y" }).asEffect()
  }).pipe(Effect.provide(Layer.merge(table.layer, off.MainTable.layer({ name: "t" }))))
  const rows = [...table.items.values()]
  const row = rows.find((one) => one.__edd_e__?.S === "Badge")!
  const at137 = KeyText136.composeAt(KeyText136.forms(off.schema)[1]!, "Badge", 1, badgeKey, {
    team: "t u",
    id: "a b",
  })
  return [
    ...rows.filter((one) => one !== row),
    { ...row, pk: { S: at137.pk! }, sk: { S: at137.sk! } },
  ]
})

const rekeyBadges = (
  escapeKeys: boolean,
  table: ReturnType<typeof makeRecordingTable>,
  options: Table.RekeyOptions,
  order: number,
) => {
  const now = badges(escapeKeys)
  return Effect.gen(function* () {
    const db = yield* now.client
    return yield* db.tables.MainTable.rekey(options)
  }).pipe(
    Effect.provide(
      Layer.merge(
        gatedLayer(table.client as DynamoClientService, scanShuffled(order)),
        now.MainTable.layer({ name: "t" }),
      ),
    ),
  )
}

/**
 * The row moves, and its pass takes the sentinel along though it names another of the row's keys:
 * one where no row is, found under any key text (`Adopt` `all`). To on, the sentinel moves to its
 * current key naming the row's; to off, the row moves to the key the sentinel names, which stays.
 */
describe.each([
  [
    "to on",
    true,
    "$ad#v1#badge.email#x%20y",
    "$ad#v1#badge#team_t%20u",
    "$ad#v1#badge#id_a%20b",
    1,
  ],
  ["to off", false, "$ad#v1#badge.email#x y", "$ad#v1#badge#team_t u", "$ad#v1#badge#id_a b", 0],
] as const)("a row at its 1.37 text whose sentinel names its 1.36 key, %s", (_, escapeKeys, sentinelPk, rowPk, rowSk, sentinelsMoved) => {
  const first = new Map<string, unknown>()
  for (const segments of [1, 2, 4]) {
    for (const order of [0, 1, 2]) {
      it.effect(`moves with its sentinel: ${segments} segment(s), order ${order}`, () =>
        Effect.gen(function* () {
          const table = tableOf(yield* leftAt137)
          const options = { segments, concurrency: 4, pageSize: 1 }
          const dry = yield* rekeyBadges(escapeKeys, table, { ...options, dryRun: true }, order)
          const real = yield* rekeyBadges(escapeKeys, table, options, order)
          expect(decided(dry)).toEqual(decided(real))
          expect(real.conflicts).toEqual([])
          expect(real.moved.item).toBe(1)
          expect(real.sentinelsMoved).toBe(sentinelsMoved)
          const rows = [...table.items.values()]
          expect(strayed(rows)).toEqual([])
          const sentinel = rows.find((row) => row._entity_pk !== undefined)
          expect(sentinel?.pk?.S).toBe(sentinelPk)
          expect([sentinel?._entity_pk?.S, sentinel?._entity_sk?.S]).toEqual([rowPk, rowSk])
          const again = yield* rekeyBadges(escapeKeys, table, options, 0)
          expect(again).toMatchObject({ sentinelsMoved: 0, moved: { item: 0 }, conflicts: [] })
          const outcome = { report: decided(real), rows: storedRows(table.items.values()) }
          const seen = first.get("outcome")
          if (seen === undefined) first.set("outcome", outcome)
          else expect(outcome).toEqual(seen)
        }),
      )
    }
  }
})

/**
 * Two runs at once, to off: `foo%20bar`'s sentinel goes where `foo bar`'s is stored. Run X's pass
 * for `a` reads that key, holding `b`'s sentinel, and run Y moves the sentinel out of the way before
 * X does. X's move of it finds it gone and writes nothing; X reads the key again before refusing,
 * finds it empty and moves `a`'s sentinel there, and Y's move of `a`'s sentinel, held until then,
 * finds that done. Without that read X reported the key `taken`, which no run alone does.
 */
describe("a sentinel moved out of the way by another run between a pass's reads", () => {
  for (const concurrency of [1, 4]) {
    it.effect(`the pass reads the key again and moves (${concurrency} at once)`, () =>
      Effect.gen(function* () {
        const table = makeRecordingTable()
        const on = randomWorld(true)
        yield* Effect.gen(function* () {
          const db = yield* on.client
          yield* db.entities.Members.put({ id: "a", email: "foo%20bar", nick: "na" }).asEffect()
          yield* db.entities.Members.put({ id: "b", email: "foo bar", nick: "nb" }).asEffect()
        }).pipe(Effect.provide(Layer.merge(table.layer, on.MainTable.layer({ name: "t" }))))
        const current = "$fz#v1#member.email#foo%20bar"
        const out = "$fz#v1#member.email#foo bar"
        const xRead = yield* Deferred.make<void>()
        const yOut = yield* Deferred.make<void>()
        const xIn = yield* Deferred.make<void>()
        let xWaited = false
        let yWaited = false
        const orFallBack = (deferred: Deferred.Deferred<void>) =>
          Effect.raceFirst(
            Deferred.await(deferred),
            Effect.forEach(Array.from({ length: 4000 }), () => Effect.yieldNow, { discard: true }),
          )
        // X: once its first read of `a`'s current key is answered, the rest waits for Y's move.
        const x: Around = (command, input, send) => {
          if (Deferred.isDoneUnsafe(xRead)) {
            return orFallBack(yOut).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  xWaited ||= Deferred.isDoneUnsafe(yOut)
                }),
              ),
              Effect.andThen(send),
              Effect.tap(() =>
                command === "transactWriteItems" && putsAt(input, current)
                  ? Deferred.succeed(xIn, undefined)
                  : Effect.void,
              ),
            )
          }
          if (command !== "getItem" || input?.Key?.pk?.S !== current) return send
          return Effect.tap(send, () => Deferred.succeed(xRead, undefined))
        }
        // Y: starts after that read; its move into `a`'s current key waits for X's.
        const y: Around = (command, input, send) =>
          orFallBack(xRead).pipe(
            Effect.andThen(
              command === "transactWriteItems" && putsAt(input, current)
                ? Effect.tap(orFallBack(xIn), () =>
                    Effect.sync(() => {
                      yWaited ||= Deferred.isDoneUnsafe(xIn)
                    }),
                  )
                : Effect.void,
            ),
            Effect.andThen(send),
            Effect.tap(() =>
              command === "transactWriteItems" && putsAt(input, out)
                ? Deferred.succeed(yOut, undefined)
                : Effect.void,
            ),
          )
        const [byX, byY] = yield* Effect.all(
          [
            rekeyOnce(false, table, { concurrency }, x),
            rekeyOnce(false, table, { concurrency }, y),
          ],
          { concurrency: 2 },
        )
        expect({ xWaited, yWaited }).toEqual({ xWaited: true, yWaited: true })
        expect(byX.conflicts).toEqual([])
        expect(byY.conflicts).toEqual([])
        expect(byX.sentinelsMoved + byY.sentinelsMoved).toBe(2)
        expect(strayed([...table.items.values()])).toEqual([])
        const again = yield* rekeyOnce(false, table, {})
        expect(again).toMatchObject({ sentinelsMoved: 0, conflicts: [] })
      }),
    )
  }
})

/**
 * Two runs at once, to off: row `a%20b` goes where row `a b` is stored. Run X's pass for `a%20b`
 * reads that key, holding `a b`'s row, and run Y moves that row out of the way before X's move of
 * it (held) gets to it. X judges the row as its own unit, finds it gone and writes nothing; X reads
 * the key again before refusing, finds it empty and moves. Without that read X reported the key
 * `taken` (`A row that can't move holds its current key`), which no run alone does: over 960 random
 * cases of two and three runs at once, 459 such reports.
 */
describe("a row moved out of the way by another run between a pass's reads", () => {
  for (const concurrency of [2, 4]) {
    it.effect(`the pass reads the key again and moves (${concurrency} at once)`, () =>
      Effect.gen(function* () {
        const table = makeRecordingTable()
        const on = randomWorld(true)
        yield* Effect.gen(function* () {
          const db = yield* on.client
          yield* db.entities.Rows.put({ id: "a%20b", note: "a" }).asEffect()
          yield* db.entities.Rows.put({ id: "a b", note: "b" }).asEffect()
        }).pipe(Effect.provide(Layer.merge(table.layer, on.MainTable.layer({ name: "t" }))))
        const pk = "$fz#v1#row"
        const moving = "$fz#v1#row#id_a%2520b"
        const to = "$fz#v1#row#id_a%20b"
        const out = "$fz#v1#row#id_a b"
        const xRead = yield* Deferred.make<void>()
        const yOut = yield* Deferred.make<void>()
        const xIn = yield* Deferred.make<void>()
        let xWaited = false
        const orFallBack = (deferred: Deferred.Deferred<void>) =>
          Effect.raceFirst(
            Deferred.await(deferred),
            Effect.forEach(Array.from({ length: 4000 }), () => Effect.yieldNow, { discard: true }),
          )
        // X: the moving row's pass (the fiber that read it) reads its current key, holding the
        // other row; X's own move of that row waits for Y's.
        let movingPass: number | undefined
        const x: Around = (command, input, send) =>
          Effect.flatMap(Effect.fiberId, (fiber) => {
            const sk = input?.Key?.sk?.S
            if (command === "getItem" && sk === moving) movingPass ??= fiber
            if (command === "getItem" && sk === to && fiber === movingPass) {
              return Effect.tap(send, (answer: any) =>
                answer?.Item === undefined ? Effect.void : Deferred.succeed(xRead, undefined),
              )
            }
            if (command === "transactWriteItems" && putsAt(input, pk, out)) {
              return orFallBack(yOut).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    xWaited ||= Deferred.isDoneUnsafe(yOut)
                  }),
                ),
                Effect.andThen(send),
              )
            }
            return command === "transactWriteItems" && putsAt(input, pk, to)
              ? Effect.tap(send, () => Deferred.succeed(xIn, undefined))
              : send
          })
        // Y: starts after that read; its move into the key waits for X's.
        const y: Around = (command, input, send) =>
          orFallBack(xRead).pipe(
            Effect.andThen(
              command === "transactWriteItems" && putsAt(input, pk, to)
                ? orFallBack(xIn)
                : Effect.void,
            ),
            Effect.andThen(send),
            Effect.tap(() =>
              command === "transactWriteItems" && putsAt(input, pk, out)
                ? Deferred.succeed(yOut, undefined)
                : Effect.void,
            ),
          )
        const [byX, byY] = yield* Effect.all(
          [
            rekeyOnce(false, table, { concurrency }, x),
            rekeyOnce(false, table, { concurrency }, y),
          ],
          { concurrency: 2 },
        )
        expect(Deferred.isDoneUnsafe(xRead)).toBe(true)
        expect(xWaited).toBe(true)
        expect(byX.conflicts).toEqual([])
        expect(byY.conflicts).toEqual([])
        expect(byX.moved.item + byY.moved.item).toBe(2)
        expect([...table.items.keys()].sort()).toEqual([`${pk}|${out}`, `${pk}|${to}`])
        const again = yield* rekeyOnce(false, table, {})
        expect(again).toMatchObject({ moved: { item: 0 }, conflicts: [] })
      }),
    )
  }
})
