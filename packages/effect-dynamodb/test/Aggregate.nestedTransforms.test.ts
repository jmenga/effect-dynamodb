/**
 * Aggregate write + read of transformed values NESTED in containers (#133).
 *
 * An aggregate decomposes its decoded domain object into one item per node and
 * marshals each item. Every value that has a wire form (a date, a bigint, a
 * `Date`, …) must be put into that wire form first, through the same encoders as
 * a root scalar date. Before #133 only TOP-LEVEL transformed attributes were
 * encoded, and `many`-edge encoders were built from the wrong schema, so:
 *
 * - `Schema.Array(DateTimeUtcFromString)` and `Schema.Array(SomeClass)` root
 *   attributes stored each `DateTime` as a marshalled `{ epochMilliseconds, … }`
 *   map;
 * - a ref inside a `many` element (root or sub-aggregate) did the same;
 * - a `DynamoModel.ref`-annotated element field was decoded strictly, so a fresh
 *   write could not even be read back;
 * - the legacy maps read back (when they read back at all) as PLAIN OBJECTS that
 *   only duck-type as `DateTime`.
 *
 * These tests run the aggregate against an in-memory mock of the raw client so
 * they can assert the STORED attribute types (`S` / `N`), not merely that `get`
 * succeeds, and so they can plant the legacy map forms in stored rows.
 *
 * Matrix: shape {root array of a date transform; root array of a class with
 * dates; ref in a root `many` element with a declared `sk.composite`; ref in a
 * sub-aggregate `many` element bound twice} × element field kind {plain class
 * matched by name; `DynamoModel.ref`-annotated} × stored form {wire; rc-era map;
 * 4.0.0-era map}.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Duration, Effect, Equal, Layer, Option, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// In-memory raw client
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>

const store = new Map<string, Item>()
/** Every TransactWriteItems call, in order — sub-aggregates write separately. */
const transactCalls: Array<ReadonlyArray<Record<string, any>>> = []

const keyOf = (item: Record<string, any>): string => `${item.pk?.S}|${item.sk?.S}`

const InMemoryClient = mockDynamoClientLayer({
  putItem: (input) =>
    Effect.sync(() => {
      store.set(keyOf(input.Item!), input.Item as Item)
      return {} as any
    }),
  batchGetItem: (input) =>
    Effect.sync(() => {
      const Responses: Record<string, Array<Item>> = {}
      for (const [table, request] of Object.entries(input.RequestItems ?? {})) {
        Responses[table] = (request.Keys ?? [])
          .map((key) => store.get(keyOf(key)))
          .filter((item): item is Item => item !== undefined)
      }
      return { Responses } as any
    }),
  transactWriteItems: (input) =>
    Effect.sync(() => {
      const items = (input.TransactItems ?? []) as ReadonlyArray<Record<string, any>>
      transactCalls.push(items)
      for (const op of items) {
        if (op.Put) store.set(keyOf(op.Put.Item), op.Put.Item)
        if (op.Delete) store.delete(keyOf(op.Delete.Key))
      }
      return {} as any
    }),
  query: (input) =>
    Effect.sync(() => {
      const pk = (input.ExpressionAttributeValues?.[":pk"] as { S?: string } | undefined)?.S
      return { Items: [...store.values()].filter((item) => item.pk?.S === pk) } as any
    }),
  batchWriteItem: (input) =>
    Effect.sync(() => {
      for (const requests of Object.values(input.RequestItems ?? {})) {
        for (const request of requests) {
          if (request.DeleteRequest?.Key) store.delete(keyOf(request.DeleteRequest.Key))
          if (request.PutRequest?.Item) {
            store.set(keyOf(request.PutRequest.Item), request.PutRequest.Item as Item)
          }
        }
      }
      return {} as any
    }),
})

beforeEach(() => {
  store.clear()
  transactCalls.length = 0
})

// ---------------------------------------------------------------------------
// Values + legacy forms
// ---------------------------------------------------------------------------

const DOB = "2000-01-01T00:00:00.000Z"
const DOB_MS = 946684800000
const DAY2 = "2000-01-02T00:00:00.000Z"
const DAY2_MS = 946771200000
const FINISH = "2000-01-01T06:00:00.000Z"
const FINISH_MS = DOB_MS + 6 * 3600 * 1000

/** The map effect-dynamodb <= 1.20.1 stored on effect 4.0.0-rc.x. */
const rcMap = (ms: number): AttributeValue => ({
  M: {
    epochMilliseconds: { N: String(ms) },
    "~effect/time/DateTime": { S: "~effect/time/DateTime" },
    _tag: { S: "Utc" },
  },
})

/** The map 1.22.0 stored on effect 4.0.0 — only the type-id key differs. */
const v4Map = (ms: number): AttributeValue => ({
  M: {
    epochMilliseconds: { N: String(ms) },
    "~effect/DateTime": { S: "~effect/DateTime" },
    _tag: { S: "Utc" },
  },
})

const legacyForms = [
  ["rc-era map", rcMap],
  ["4.0.0-era map", v4Map],
] as const

/** A REAL `DateTime.Utc` for `ms` — not a plain object that duck-types as one. */
const isRealUtc = (value: unknown, ms: number): boolean =>
  DateTime.isDateTime(value) &&
  Object.getPrototypeOf(value) !== Object.prototype &&
  Equal.equals(value, DateTime.makeUnsafe(ms))

// ---------------------------------------------------------------------------
// Entities — configured models with an identifier rename, as reported in #133
// ---------------------------------------------------------------------------

const PersonFields = {
  id: Schema.String,
  name: Schema.String,
  dateOfBirth: Schema.DateTimeUtcFromString.pipe(
    Schema.withDecodingDefault(Effect.succeed("1800-01-01")),
  ),
}

class Team extends Schema.Class<Team>("Team")({ id: Schema.String, name: Schema.String }) {}
class Coach extends Schema.Class<Coach>("Coach")({ ...PersonFields }) {}
class Player extends Schema.Class<Player>("Player")({ ...PersonFields }) {}
class Umpire extends Schema.Class<Umpire>("Umpire")({
  ...PersonFields,
  rank: Schema.NumberFromString,
}) {}

const pkSk = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

const Teams = Entity.make({
  model: DynamoModel.configure(Team, { id: { field: "teamId", identifier: true } }),
  entityType: "Team",
  primaryKey: pkSk,
})
const Coaches = Entity.make({
  model: DynamoModel.configure(Coach, { id: { field: "coachId", identifier: true } }),
  entityType: "Coach",
  primaryKey: pkSk,
})
const Players = Entity.make({
  model: DynamoModel.configure(Player, { id: { field: "playerId", identifier: true } }),
  entityType: "Player",
  primaryKey: pkSk,
})
const Umpires = Entity.make({
  model: DynamoModel.configure(Umpire, { id: { field: "umpireId", identifier: true } }),
  entityType: "Umpire",
  primaryKey: pkSk,
})

const ReproSchema = DynamoSchema.make({ name: "issue133", version: 1 })
const ReproTable = Table.make({
  schema: ReproSchema,
  entities: { Teams, Coaches, Players, Umpires },
})
const TestLayer = Layer.merge(InMemoryClient, ReproTable.layer({ name: "issue133" }))

/** Seed the referenced entities through the real entity write path. */
const seed = Effect.gen(function* () {
  const dob = DateTime.makeUnsafe(DOB)
  yield* Teams.put({ id: "team-1", name: "Team One" }).asEffect()
  yield* Teams.put({ id: "team-2", name: "Team Two" }).asEffect()
  yield* Coaches.put({ id: "coach-1", name: "Coach One", dateOfBirth: dob }).asEffect()
  yield* Coaches.put({ id: "coach-2", name: "Coach Two", dateOfBirth: dob }).asEffect()
  yield* Players.put({ id: "player-1", name: "Player One", dateOfBirth: dob }).asEffect()
  yield* Players.put({ id: "player-2", name: "Player Two", dateOfBirth: dob }).asEffect()
  yield* Umpires.put({ id: "umpire-1", name: "Umpire One", dateOfBirth: dob, rank: 5 }).asEffect()
  yield* Umpires.put({ id: "umpire-2", name: "Umpire Two", dateOfBirth: dob, rank: 12 }).asEffect()
})

// ---------------------------------------------------------------------------
// Aggregate fixtures — one per element field kind
// ---------------------------------------------------------------------------

/** Element of a root-level `Schema.Array` of classes (no edge). */
class Session extends Schema.Class<Session>("Session")({
  number: Schema.Number,
  startTime: Schema.DateTimeUtcFromString,
  finishTime: Schema.optionalKey(Schema.DateTimeUtcFromString),
}) {}

type Kind = "plain" | "ref"

const makeMatch = (kind: Kind) => {
  // The element's ref field: the PLAIN entity class (matched by field name, as
  // in the downstream report) or the `DynamoModel.ref`-annotated class (whose
  // `.fields` `Schema.annotate` drops).
  const playerField = kind === "plain" ? Player : Player.pipe(DynamoModel.ref)
  const umpireField = kind === "plain" ? Umpire : Umpire.pipe(DynamoModel.ref)

  class PlayerSheet extends Schema.Class<PlayerSheet>(`PlayerSheet-${kind}`)({
    player: playerField as typeof Player,
    isCaptain: Schema.optionalKey(Schema.Boolean),
  }) {}
  class TeamSheet extends Schema.Class<TeamSheet>(`TeamSheet-${kind}`)({
    team: Team,
    coach: Coach,
    homeTeam: Schema.Boolean,
    players: Schema.Array(PlayerSheet),
  }) {}
  class UmpireSheet extends Schema.Class<UmpireSheet>(`UmpireSheet-${kind}`)({
    umpire: umpireField as typeof Umpire,
    role: Schema.Literals(["onfield", "third"]),
  }) {}
  class Match extends Schema.Class<Match>(`Match-${kind}`)({
    id: Schema.String,
    name: Schema.String,
    startDate: Schema.DateTimeUtcFromString,
    matchDays: Schema.optionalKey(Schema.Array(Schema.DateTimeUtcFromString)),
    sessions: Schema.optionalKey(Schema.Array(Session)),
    team1: TeamSheet,
    team2: TeamSheet,
    umpires: Schema.optionalKey(Schema.Array(UmpireSheet)),
  }) {}

  const TeamSheetAggregate = Aggregate.make(TeamSheet, {
    root: { entityType: "MatchTeam" },
    edges: {
      team: Aggregate.ref(Teams),
      coach: Aggregate.one("coach", { entityType: "MatchCoach", entity: Coaches }),
      players: Aggregate.many("players", { entityType: "MatchPlayer", entity: Players }),
    },
  })

  return Aggregate.make(Match, {
    table: ReproTable,
    schema: ReproSchema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "match" },
    root: { entityType: "MatchItem" },
    edges: {
      team1: TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
      team2: TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
      umpires: Aggregate.many("umpires", {
        entityType: "MatchUmpire",
        entity: Umpires,
        sk: { composite: ["role", "umpire.id"] },
      }),
    },
  })
}

const matchInput = (id: string) => ({
  id,
  name: "Match",
  startDate: DOB,
  matchDays: [DOB, DAY2],
  sessions: [
    { number: 1, startTime: DOB, finishTime: FINISH },
    { number: 2, startTime: DAY2 },
  ],
  team1: {
    teamId: "team-1",
    coachId: "coach-1",
    homeTeam: true,
    players: [{ playerId: "player-1", isCaptain: true }],
  },
  team2: {
    teamId: "team-2",
    coachId: "coach-2",
    homeTeam: false,
    players: [{ playerId: "player-2" }],
  },
  umpires: [
    { umpireId: "umpire-1", role: "onfield" },
    { umpireId: "umpire-2", role: "third" },
  ],
})

// ---------------------------------------------------------------------------
// Stored-item helpers
// ---------------------------------------------------------------------------

const partition = (id: string): Array<Item> =>
  [...store.values()].filter((item) => item.pk?.S === `$issue133#v1#match#${id}`)

const itemsOf = (id: string, entityType: string): Array<Item> =>
  partition(id).filter((item) => item.__edd_e__?.S === entityType)

const itemOf = (id: string, entityType: string, predicate: (item: Item) => boolean = () => true) =>
  itemsOf(id, entityType).find(predicate)!

/** Every key attribute of every stored item in the partition, sorted. */
const keysOf = (id: string): Array<string> =>
  partition(id)
    .map((item) => `${item.__edd_e__?.S} ${item.pk?.S} ${item.sk?.S}`)
    .sort()

const S = (value: string): AttributeValue => ({ S: value })

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

for (const kind of ["plain", "ref"] as const) {
  describe(`#133 nested transforms — ${kind === "plain" ? "plain class" : "DynamoModel.ref"} element field`, () => {
    const MatchAggregate = makeMatch(kind)
    const create = (id: string) => MatchAggregate.create(matchInput(id) as any)
    const get = (id: string) => MatchAggregate.get({ id } as any) as Effect.Effect<any, any, any>

    it.effect("stores every date leaf in wire form (S)", () =>
      Effect.gen(function* () {
        yield* seed
        yield* create("m1")

        const root = itemOf("m1", "MatchItem")
        // Controls: root scalar date and the `one` edge's flattened date.
        expect(root.startDate).toEqual(S(DOB))
        expect(itemOf("m1", "MatchCoach").dateOfBirth).toEqual(S(DOB))
        // Root array of a date transform.
        expect(root.matchDays).toEqual({ L: [S(DOB), S(DAY2)] })
        // Root array of a class with dates, including an optionalKey date.
        expect(root.sessions).toEqual({
          L: [
            { M: { number: { N: "1" }, startTime: S(DOB), finishTime: S(FINISH) } },
            { M: { number: { N: "2" }, startTime: S(DAY2) } },
          ],
        })
        // Ref in a sub-aggregate `many` element — both bindings.
        const players = itemsOf("m1", "MatchPlayer")
        expect(players).toHaveLength(2)
        for (const player of players) {
          expect(player.player?.M?.dateOfBirth).toEqual(S(DOB))
        }
        // Ref in a root `many` element with a declared sk.composite — including a
        // non-date transform (`rank: NumberFromString`) inside the ref.
        const umpires = itemsOf("m1", "MatchUmpire")
        expect(umpires).toHaveLength(2)
        for (const umpire of umpires) {
          expect(umpire.umpire?.M?.dateOfBirth).toEqual(S(DOB))
          expect(umpire.umpire?.M?.rank?.S).toMatch(/^\d+$/)
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("composes byte-identical keys", () =>
      Effect.gen(function* () {
        yield* seed
        yield* create("m1")
        expect(keysOf("m1")).toEqual([
          "MatchCoach $issue133#v1#match#m1 $issue133#v1#matchcoach#teamnumber#0000000000000001",
          "MatchCoach $issue133#v1#match#m1 $issue133#v1#matchcoach#teamnumber#0000000000000002",
          "MatchItem $issue133#v1#match#m1 $issue133#v1#matchitem",
          "MatchPlayer $issue133#v1#match#m1 $issue133#v1#matchplayer#teamnumber#0000000000000001#player-1",
          "MatchPlayer $issue133#v1#match#m1 $issue133#v1#matchplayer#teamnumber#0000000000000002#player-2",
          "MatchTeam $issue133#v1#match#m1 $issue133#v1#matchteam#teamnumber#0000000000000001",
          "MatchTeam $issue133#v1#match#m1 $issue133#v1#matchteam#teamnumber#0000000000000002",
          "MatchUmpire $issue133#v1#match#m1 $issue133#v1#matchumpire#onfield#umpire-1",
          "MatchUmpire $issue133#v1#match#m1 $issue133#v1#matchumpire#third#umpire-2",
        ])
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("reads a fresh write back as real DateTime.Utc instances", () =>
      Effect.gen(function* () {
        yield* seed
        yield* create("m1")
        const got = yield* get("m1")

        expect(isRealUtc(got.startDate, DOB_MS)).toBe(true)
        expect(isRealUtc(got.matchDays[0], DOB_MS)).toBe(true)
        expect(isRealUtc(got.matchDays[1], DAY2_MS)).toBe(true)
        expect(isRealUtc(got.sessions[0].startTime, DOB_MS)).toBe(true)
        expect(isRealUtc(got.sessions[0].finishTime, FINISH_MS)).toBe(true)
        expect(got.sessions[1].finishTime).toBeUndefined()
        expect(isRealUtc(got.team1.coach.dateOfBirth, DOB_MS)).toBe(true)
        expect(isRealUtc(got.team1.players[0].player.dateOfBirth, DOB_MS)).toBe(true)
        expect(isRealUtc(got.team2.players[0].player.dateOfBirth, DOB_MS)).toBe(true)
        expect(got.team1.players[0].player).toBeInstanceOf(Player)
        expect(isRealUtc(got.umpires[0].umpire.dateOfBirth, DOB_MS)).toBe(true)
        expect(got.umpires[0].umpire).toBeInstanceOf(Umpire)
        expect(got.umpires.map((u: any) => u.umpire.rank).sort()).toEqual([12, 5].sort())
      }).pipe(Effect.provide(TestLayer)),
    )

    for (const [formName, form] of legacyForms) {
      describe(`reads a stored ${formName}`, () => {
        it.effect("in MatchItem.matchDays[]", () =>
          Effect.gen(function* () {
            yield* seed
            yield* create("m1")
            const root = itemOf("m1", "MatchItem")
            root.matchDays = { L: [form(DOB_MS), form(DAY2_MS)] }
            const got = yield* get("m1")
            expect(isRealUtc(got.matchDays[0], DOB_MS)).toBe(true)
            expect(isRealUtc(got.matchDays[1], DAY2_MS)).toBe(true)
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("in MatchItem.sessions[].startTime / finishTime", () =>
          Effect.gen(function* () {
            yield* seed
            yield* create("m1")
            const root = itemOf("m1", "MatchItem")
            const first = (root.sessions as any).L[0].M
            first.startTime = form(DOB_MS)
            first.finishTime = form(FINISH_MS)
            const got = yield* get("m1")
            expect(isRealUtc(got.sessions[0].startTime, DOB_MS)).toBe(true)
            expect(isRealUtc(got.sessions[0].finishTime, FINISH_MS)).toBe(true)
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("in MatchPlayer.player.dateOfBirth (sub-aggregate many element)", () =>
          Effect.gen(function* () {
            yield* seed
            yield* create("m1")
            for (const player of itemsOf("m1", "MatchPlayer")) {
              ;(player.player as any).M.dateOfBirth = form(DOB_MS)
            }
            const got = yield* get("m1")
            expect(isRealUtc(got.team1.players[0].player.dateOfBirth, DOB_MS)).toBe(true)
            expect(isRealUtc(got.team2.players[0].player.dateOfBirth, DOB_MS)).toBe(true)
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("in MatchUmpire.umpire.dateOfBirth (root many element)", () =>
          Effect.gen(function* () {
            yield* seed
            yield* create("m1")
            for (const umpire of itemsOf("m1", "MatchUmpire")) {
              ;(umpire.umpire as any).M.dateOfBirth = form(DOB_MS)
            }
            const got = yield* get("m1")
            expect(isRealUtc(got.umpires[0].umpire.dateOfBirth, DOB_MS)).toBe(true)
            expect(isRealUtc(got.umpires[1].umpire.dateOfBirth, DOB_MS)).toBe(true)
          }).pipe(Effect.provide(TestLayer)),
        )

        it.effect("update over a legacy row rewrites only what changed, in wire form", () =>
          Effect.gen(function* () {
            yield* seed
            yield* create("m1")
            const root = itemOf("m1", "MatchItem")
            root.matchDays = { L: [form(DOB_MS), form(DAY2_MS)] }
            for (const umpire of itemsOf("m1", "MatchUmpire")) {
              ;(umpire.umpire as any).M.dateOfBirth = form(DOB_MS)
            }
            transactCalls.length = 0

            const updated = yield* MatchAggregate.update({ id: "m1" } as any, (c: any) => ({
              ...c.state,
              name: "Renamed",
            }))
            expect((updated as any).name).toBe("Renamed")
            expect(isRealUtc((updated as any).matchDays[0], DOB_MS)).toBe(true)

            // The root group changed (name); the legacy root row is rewritten in
            // wire form along with it. Its umpire edge items sit in the same
            // (root) group, so they are rewritten too.
            const after = itemOf("m1", "MatchItem")
            expect(after.matchDays).toEqual({ L: [S(DOB), S(DAY2)] })
            for (const umpire of itemsOf("m1", "MatchUmpire")) {
              expect(umpire.umpire?.M?.dateOfBirth).toEqual(S(DOB))
            }
            // The two sub-aggregate groups did not change, so they were not written.
            expect(transactCalls).toHaveLength(1)
            expect(keysOf("m1")).toHaveLength(9)
          }).pipe(Effect.provide(TestLayer)),
        )
      })
    }

    it.effect("a no-op update writes nothing (decomposed groups compare equal)", () =>
      Effect.gen(function* () {
        yield* seed
        yield* create("m1")
        transactCalls.length = 0
        yield* MatchAggregate.update({ id: "m1" } as any, (c: any) => c.state)
        expect(transactCalls).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an update touching one sub-aggregate rewrites only that group, in wire form", () =>
      Effect.gen(function* () {
        yield* seed
        yield* create("m1")
        transactCalls.length = 0
        yield* MatchAggregate.update({ id: "m1" } as any, (c: any) => ({
          ...c.state,
          team2: { ...c.state.team2, homeTeam: true },
        }))
        expect(transactCalls).toHaveLength(1)
        const written = transactCalls[0]!.map((op) => op.Put?.Item?.__edd_e__?.S).sort()
        expect(written).toEqual(["MatchCoach", "MatchPlayer", "MatchTeam"])
        const player = itemOf("m1", "MatchPlayer", (item) => item.teamNumber?.N === "2")
        expect(player.player?.M?.dateOfBirth).toEqual(S(DOB))
      }).pipe(Effect.provide(TestLayer)),
    )
  })
}

// ---------------------------------------------------------------------------
// Non-date nested transforms and self schemas
// ---------------------------------------------------------------------------

class Ledger extends Schema.Class<Ledger>("Ledger")({
  id: Schema.String,
  amounts: Schema.Array(Schema.BigIntFromString),
  seen: Schema.Array(Schema.Date),
  stamps: Schema.Array(Schema.DateTimeUtc),
  maybeDays: Schema.optional(Schema.Array(Schema.DateTimeUtcFromString)),
  tags: Schema.Array(Schema.String),
}) {}

const LedgerAggregate = Aggregate.make(Ledger, {
  table: ReproTable,
  schema: ReproSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "ledger" },
  root: { entityType: "LedgerItem" },
  edges: {},
})

describe("#133 nested transforms — non-date and self-schema leaves", () => {
  it.effect("stores each element in wire form and reads real domain values back", () =>
    Effect.gen(function* () {
      yield* LedgerAggregate.create({
        id: "l1",
        amounts: ["5", "12345678901234567890"],
        seen: [new Date(DOB_MS)],
        stamps: [DateTime.makeUnsafe(DOB_MS)],
        maybeDays: [DOB],
        tags: ["a"],
      } as any)

      const item = [...store.values()].find((i) => i.__edd_e__?.S === "LedgerItem")!
      expect(item.amounts).toEqual({ L: [S("5"), S("12345678901234567890")] })
      expect(item.seen).toEqual({ L: [S(DOB)] })
      expect(item.stamps).toEqual({ L: [S(DOB)] })
      expect(item.maybeDays).toEqual({ L: [S(DOB)] })
      // Untransformed containers are stored exactly as before.
      expect(item.tags).toEqual({ L: [S("a")] })

      const got = (yield* LedgerAggregate.get({ id: "l1" } as any)) as Ledger
      expect(got.amounts).toEqual([5n, 12345678901234567890n])
      expect(got.seen[0]).toBeInstanceOf(Date)
      expect(got.seen[0]!.getTime()).toBe(DOB_MS)
      expect(isRealUtc(got.stamps[0], DOB_MS)).toBe(true)
      expect(isRealUtc(got.maybeDays?.[0], DOB_MS)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an update round-trips domain values without re-encoding twice", () =>
    Effect.gen(function* () {
      yield* LedgerAggregate.create({
        id: "l1",
        amounts: ["5"],
        seen: [new Date(DOB_MS)],
        stamps: [DateTime.makeUnsafe(DOB_MS)],
        tags: [],
      } as any)
      yield* LedgerAggregate.update({ id: "l1" } as any, (c: any) => ({
        ...c.state,
        amounts: [...c.state.amounts, 7n],
      }))
      const item = [...store.values()].find((i) => i.__edd_e__?.S === "LedgerItem")!
      expect(item.amounts).toEqual({ L: [S("5"), S("7")] })
      expect(item.seen).toEqual({ L: [S(DOB)] })
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Key composition: transformed composites read off a ref must keep their bytes
// ---------------------------------------------------------------------------

class RankSheet extends Schema.Class<RankSheet>("RankSheet")({
  umpire: Umpire.pipe(DynamoModel.ref),
  seq: Schema.NumberFromString,
}) {}
class Roster extends Schema.Class<Roster>("Roster")({
  id: Schema.String,
  byDob: Schema.Array(RankSheet),
  byRank: Schema.Array(RankSheet),
  bySeq: Schema.Array(RankSheet),
  flat: Schema.Array(Umpire),
}) {}

const RosterAggregate = Aggregate.make(Roster, {
  table: ReproTable,
  schema: ReproSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "roster" },
  root: { entityType: "RosterItem" },
  edges: {
    byDob: Aggregate.many("byDob", {
      entityType: "RosterDob",
      entity: Umpires,
      sk: { composite: ["umpire.dateOfBirth", "umpire.id"] },
    }),
    byRank: Aggregate.many("byRank", {
      entityType: "RosterRank",
      entity: Umpires,
      sk: { composite: ["umpire.rank"] },
    }),
    bySeq: Aggregate.many("bySeq", {
      entityType: "RosterSeq",
      entity: Umpires,
      sk: { composite: ["seq"] },
    }),
    // Element IS the entity: its own `rank` (NumberFromString) is the composite.
    flat: Aggregate.many("flat", {
      entityType: "RosterFlat",
      entity: Umpires,
      sk: { composite: ["rank"] },
    }),
  },
})

describe("#133 nested transforms — key composition is unchanged", () => {
  it.effect("date and numeric transform composites inside a ref keep their key bytes", () =>
    Effect.gen(function* () {
      yield* seed
      yield* RosterAggregate.create({
        id: "r1",
        byDob: [{ umpireId: "umpire-1", seq: "1" }],
        byRank: [
          { umpireId: "umpire-1", seq: "1" },
          { umpireId: "umpire-2", seq: "2" },
        ],
        bySeq: [{ umpireId: "umpire-2", seq: "3" }],
        flat: ["umpire-2"],
      } as any)

      const sks = [...store.values()]
        .filter((i) => i.pk?.S === "$issue133#v1#roster#r1")
        .map((i) => i.sk?.S)
        .sort()
      expect(sks).toEqual([
        "$issue133#v1#rosterdob#2000-01-01t00:00:00.000z#umpire-1",
        "$issue133#v1#rosterflat#12",
        "$issue133#v1#rosteritem",
        "$issue133#v1#rosterrank#0000000000000005",
        "$issue133#v1#rosterrank#0000000000000012",
        "$issue133#v1#rosterseq#0000000000000003",
      ])

      const dobItem = [...store.values()].find((i) => i.__edd_e__?.S === "RosterDob")!
      expect(dobItem.umpire?.M?.dateOfBirth).toEqual(S(DOB))
      expect(dobItem.umpire?.M?.rank).toEqual(S("5"))
      expect(dobItem.seq).toEqual(S("1"))

      const got = (yield* RosterAggregate.get({ id: "r1" } as any)) as Roster
      expect(isRealUtc(got.byDob[0]!.umpire.dateOfBirth, DOB_MS)).toBe(true)
      expect(got.byRank.map((s) => s.umpire.rank)).toEqual([5, 12])
      expect(got.bySeq[0]!.seq).toBe(3)
      expect(got.flat[0]!.rank).toBe(12)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Ref resolution is by field identity, not field name
// ---------------------------------------------------------------------------

/** A nested field that shares its NAME with a root `one` edge, but not its schema. */
class Shift extends Schema.Class<Shift>("Shift")({
  coach: Schema.String,
  at: Schema.DateTimeUtcFromString,
}) {}
class Training extends Schema.Class<Training>("Training")({
  id: Schema.String,
  coach: Coach.pipe(DynamoModel.ref),
  shifts: Schema.Array(Shift),
}) {}

const TrainingAggregate = Aggregate.make(Training, {
  table: ReproTable,
  schema: ReproSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "training" },
  root: { entityType: "TrainingItem" },
  edges: { coach: Aggregate.one("coach", { entityType: "TrainingCoach", entity: Coaches }) },
})

describe("#133 nested transforms — ref resolution", () => {
  it.effect("does not re-point a nested field that merely shares a ref edge's name", () =>
    Effect.gen(function* () {
      yield* seed
      yield* TrainingAggregate.create({
        id: "t1",
        coachId: "coach-1",
        shifts: [{ coach: "assistant", at: DOB }],
      } as any)
      const item = [...store.values()].find((i) => i.__edd_e__?.S === "TrainingItem")!
      expect(item.shifts).toEqual({ L: [{ M: { coach: S("assistant"), at: S(DOB) } }] })

      const got = (yield* TrainingAggregate.get({ id: "t1" } as any)) as Training
      expect(got.shifts[0]!.coach).toBe("assistant")
      expect(isRealUtc(got.shifts[0]!.at, DOB_MS)).toBe(true)
      expect(isRealUtc(got.coach.dateOfBirth, DOB_MS)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("#133 nested transforms — create input with refs", () => {
  it.effect("keeps domain DateTime values intact while ref ids are replaced", () =>
    Effect.gen(function* () {
      yield* seed
      yield* TrainingAggregate.create({
        id: "t2",
        coachId: "coach-1",
        shifts: [{ coach: "assistant", at: DateTime.makeUnsafe(DOB_MS) }],
      } as any)
      const item = [...store.values()].find(
        (i) => i.__edd_e__?.S === "TrainingItem" && i.id?.S === "t2",
      )!
      expect(item.shifts).toEqual({ L: [{ M: { coach: S("assistant"), at: S(DOB) } }] })
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Edges without an entity encode from the aggregate model's own schema
// ---------------------------------------------------------------------------

class Note extends Schema.Class<Note>("Note")({
  noteId: Schema.String,
  at: Schema.DateTimeUtcFromString,
}) {}
class Summary extends Schema.Class<Summary>("Summary")({
  days: Schema.Array(Schema.DateTimeUtcFromString),
}) {}
class Journal extends Schema.Class<Journal>("Journal")({
  id: Schema.String,
  notes: Schema.Array(Note),
  summary: Summary,
}) {}

const JournalAggregate = Aggregate.make(Journal, {
  table: ReproTable,
  schema: ReproSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "journal" },
  root: { entityType: "JournalItem" },
  edges: {
    notes: Aggregate.many("notes", { entityType: "JournalNote", sk: { composite: ["noteId"] } }),
    summary: Aggregate.one("summary", { entityType: "JournalSummary" }),
  },
})

describe("#133 nested transforms — edges without an entity", () => {
  it.effect("stores many-element and one-edge dates in wire form and reads them back", () =>
    Effect.gen(function* () {
      yield* JournalAggregate.create({
        id: "j1",
        notes: [{ noteId: "n1", at: DOB }],
        summary: { days: [DOB, DAY2] },
      } as any)
      const note = [...store.values()].find((i) => i.__edd_e__?.S === "JournalNote")!
      expect(note.at).toEqual(S(DOB))
      expect(note.sk).toEqual(S("$issue133#v1#journalnote#n1"))
      const summary = [...store.values()].find((i) => i.__edd_e__?.S === "JournalSummary")!
      expect(summary.days).toEqual({ L: [S(DOB), S(DAY2)] })

      const got = (yield* JournalAggregate.get({ id: "j1" } as any)) as Journal
      expect(isRealUtc(got.notes[0]!.at, DOB_MS)).toBe(true)
      expect(isRealUtc(got.summary.days[1], DAY2_MS)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Root list-index composites keep their key bytes
// ---------------------------------------------------------------------------

class Invoice extends Schema.Class<Invoice>("Invoice")({
  id: Schema.String,
  // A transform under a Union: no top-level encoding, so it was stored as a
  // number and its list key was composed (padded) from the bigint.
  amount: Schema.optional(Schema.BigIntFromString),
}) {}

const InvoiceAggregate = Aggregate.make(Invoice, {
  table: ReproTable,
  schema: ReproSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "invoice" },
  list: {
    index: "gsi1",
    name: "invoices",
    pk: { field: "gsi1pk", composite: [] },
    sk: { field: "gsi1sk", composite: ["amount"] },
  },
  root: { entityType: "InvoiceItem" },
  edges: {},
})

describe("#133 nested transforms — list-index key composition is unchanged", () => {
  it.effect("stores the encoded value but keys on the same bytes as before", () =>
    Effect.gen(function* () {
      yield* InvoiceAggregate.create({ id: "i1", amount: "5" } as any)
      const item = [...store.values()].find((i) => i.__edd_e__?.S === "InvoiceItem")!
      expect(item.amount).toEqual(S("5"))
      expect(item.gsi1sk).toEqual(S(`$issue133#v1#invoices#${"5".padStart(38, "0")}`))
      const got = (yield* InvoiceAggregate.get({ id: "i1" } as any)) as Invoice
      expect(got.amount).toBe(5n)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Union / Record / Tuple containers
// ---------------------------------------------------------------------------
//
// The read path's schema walk (`substituteSchemaDeep`) used to stop at a Union,
// a Record or a Tuple, so the date leaves inside kept their strict decoders: a
// self date in a `NullOr` was written as a string but read back as
// "Expected DateTime.Utc", and every update — even a no-op — re-decoded the
// domain values with an encoded-only decoder and failed.

const LATER = "2000-01-01T00:00:01.000Z"
const LATER_MS = DOB_MS + 1000

class Slot extends Schema.Class<Slot>("Slot")({ at: Schema.DateTimeUtcFromString }) {}

interface ContainerCase {
  readonly name: string
  readonly schema: Schema.Top
  /** Create input (wire-shaped, as an HTTP payload would be). */
  readonly input: unknown
  readonly stored: AttributeValue
  readonly read: (value: any) => boolean
  /** A mutation on the decoded domain value. */
  readonly mutate: (value: any) => unknown
  readonly storedAfter: AttributeValue
}

const later = () => DateTime.makeUnsafe(LATER_MS)
const containerCases: ReadonlyArray<ContainerCase> = [
  {
    name: "NullOr(DateTimeUtc)",
    schema: Schema.NullOr(Schema.DateTimeUtc),
    input: DateTime.makeUnsafe(DOB_MS),
    stored: S(DOB),
    read: (v) => isRealUtc(v, DOB_MS),
    mutate: later,
    storedAfter: S(LATER),
  },
  {
    name: "NullOr(DateTimeUtcFromString)",
    schema: Schema.NullOr(Schema.DateTimeUtcFromString),
    input: DOB,
    stored: S(DOB),
    read: (v) => isRealUtc(v, DOB_MS),
    mutate: () => null,
    storedAfter: { NULL: true },
  },
  {
    name: "NullOr(Class)",
    schema: Schema.NullOr(Slot),
    input: { at: DOB },
    stored: { M: { at: S(DOB) } },
    read: (v) => v instanceof Slot && isRealUtc(v.at, DOB_MS),
    mutate: () => new Slot({ at: later() }),
    storedAfter: { M: { at: S(LATER) } },
  },
  {
    name: "Array(NullOr(DateTimeUtc))",
    schema: Schema.Array(Schema.NullOr(Schema.DateTimeUtc)),
    input: [DateTime.makeUnsafe(DOB_MS), null],
    stored: { L: [S(DOB), { NULL: true }] },
    read: (v) => isRealUtc(v[0], DOB_MS) && v[1] === null,
    mutate: (v) => [...v, later()],
    storedAfter: { L: [S(DOB), { NULL: true }, S(LATER)] },
  },
  {
    name: "Array(NullOr(DateTimeUtcFromString))",
    schema: Schema.Array(Schema.NullOr(Schema.DateTimeUtcFromString)),
    input: [DOB, null],
    stored: { L: [S(DOB), { NULL: true }] },
    read: (v) => isRealUtc(v[0], DOB_MS) && v[1] === null,
    mutate: (v) => [v[0], later()],
    storedAfter: { L: [S(DOB), S(LATER)] },
  },
  {
    name: "Record(String, DateTimeUtcFromString)",
    schema: Schema.Record(Schema.String, Schema.DateTimeUtcFromString),
    input: { a: DOB },
    stored: { M: { a: S(DOB) } },
    read: (v) => isRealUtc(v.a, DOB_MS),
    mutate: (v) => ({ ...v, b: later() }),
    storedAfter: { M: { a: S(DOB), b: S(LATER) } },
  },
  {
    name: "Tuple([String, DateTimeUtcFromString])",
    schema: Schema.Tuple([Schema.String, Schema.DateTimeUtcFromString]),
    input: ["x", DOB],
    stored: { L: [S("x"), S(DOB)] },
    read: (v) => v[0] === "x" && isRealUtc(v[1], DOB_MS),
    mutate: (v) => [v[0], later()],
    storedAfter: { L: [S("x"), S(LATER)] },
  },
  {
    name: "Union([Class, String])",
    schema: Schema.Union([Slot, Schema.String]),
    input: { at: DOB },
    stored: { M: { at: S(DOB) } },
    read: (v) => v instanceof Slot && isRealUtc(v.at, DOB_MS),
    mutate: () => "none",
    storedAfter: S("none"),
  },
]

const makeHolder = (name: string, schema: Schema.Top) => {
  class Holder extends Schema.Class<Holder>(`Holder-${name}`)({
    id: Schema.String,
    f: schema as Schema.Codec<unknown>,
  }) {}
  return Aggregate.make(Holder, {
    table: ReproTable,
    schema: ReproSchema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "holder" },
    root: { entityType: "HolderItem" },
    edges: {},
  })
}
const holderItem = () => [...store.values()].find((i) => i.__edd_e__?.S === "HolderItem")!

describe("#133 nested transforms — Union / Record / Tuple containers", () => {
  for (const c of containerCases) {
    describe(c.name, () => {
      const Holder = makeHolder(c.name, c.schema)

      it.effect("stores wire form, reads real instances, and updates", () =>
        Effect.gen(function* () {
          yield* Holder.create({ id: "h1", f: c.input } as any)
          expect(holderItem().f).toEqual(c.stored)

          const got = (yield* Holder.get({ id: "h1" } as any)) as any
          expect(c.read(got.f)).toBe(true)

          transactCalls.length = 0
          yield* Holder.update({ id: "h1" } as any, (ctx: any) => ctx.state)
          expect(transactCalls).toHaveLength(0)

          yield* Holder.update({ id: "h1" } as any, (ctx: any) => ({
            ...ctx.state,
            f: c.mutate(ctx.state.f),
          }))
          expect(holderItem().f).toEqual(c.storedAfter)
          // The key is untouched by any of it.
          expect(holderItem().sk).toEqual(S("$issue133#v1#holderitem"))
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  }

  for (const [formName, form] of legacyForms) {
    it.effect(`reads a stored ${formName} inside a NullOr and a Record`, () =>
      Effect.gen(function* () {
        const NullHolder = makeHolder("legacy-null", Schema.NullOr(Schema.DateTimeUtcFromString))
        yield* NullHolder.create({ id: "h1", f: DOB } as any)
        holderItem().f = form(DOB_MS)
        const got = (yield* NullHolder.get({ id: "h1" } as any)) as any
        expect(isRealUtc(got.f, DOB_MS)).toBe(true)

        store.clear()
        const RecHolder = makeHolder(
          "legacy-rec",
          Schema.Record(Schema.String, Schema.DateTimeUtcFromString),
        )
        yield* RecHolder.create({ id: "h1", f: { a: DOB } } as any)
        holderItem().f = { M: { a: form(DOB_MS) } }
        const rec = (yield* RecHolder.get({ id: "h1" } as any)) as any
        expect(isRealUtc(rec.f.a, DOB_MS)).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )
  }

  it.effect("a date member does not claim a value that belongs to a later member", () =>
    Effect.gen(function* () {
      const Holder = makeHolder(
        "mixed",
        Schema.Union([Schema.DateTimeUtcFromString, Schema.Number]),
      )
      yield* Holder.create({ id: "h1", f: 5 } as any)
      expect(holderItem().f).toEqual({ N: "5" })
      const asNumber = (yield* Holder.get({ id: "h1" } as any)) as any
      expect(asNumber.f).toBe(5)

      yield* Holder.update({ id: "h1" } as any, (ctx: any) => ({ ...ctx.state, f: later() }))
      expect(holderItem().f).toEqual(S(LATER))
      const asDate = (yield* Holder.get({ id: "h1" } as any)) as any
      expect(isRealUtc(asDate.f, LATER_MS)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// A many edge whose ELEMENT is a DynamoModel.ref-annotated entity class
// ---------------------------------------------------------------------------

class RefRoster extends Schema.Class<RefRoster>("RefRoster")({
  id: Schema.String,
  players: Schema.Array(Player.pipe(DynamoModel.ref)),
}) {}

const RefRosterAggregate = Aggregate.make(RefRoster, {
  table: ReproTable,
  schema: ReproSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "refroster" },
  root: { entityType: "RefRosterItem" },
  edges: { players: Aggregate.many("players", { entityType: "RefRosterPlayer", entity: Players }) },
})

describe("#133 nested transforms — many edge of annotated refs", () => {
  const playerItems = () => [...store.values()].filter((i) => i.__edd_e__?.S === "RefRosterPlayer")

  it.effect("stores, reads, updates and reads legacy maps", () =>
    Effect.gen(function* () {
      yield* seed
      yield* RefRosterAggregate.create({ id: "rr1", players: ["player-1", "player-2"] } as any)
      expect(playerItems().map((i) => i.dateOfBirth)).toEqual([S(DOB), S(DOB)])
      expect(playerItems().map((i) => i.sk?.S)).toEqual([
        "$issue133#v1#refrosterplayer#player-1",
        "$issue133#v1#refrosterplayer#player-2",
      ])

      const got = (yield* RefRosterAggregate.get({ id: "rr1" } as any)) as RefRoster
      expect(got.players[0]).toBeInstanceOf(Player)
      expect(isRealUtc(got.players[0]!.dateOfBirth, DOB_MS)).toBe(true)

      transactCalls.length = 0
      yield* RefRosterAggregate.update({ id: "rr1" } as any, (c: any) => c.state)
      expect(transactCalls).toHaveLength(0)

      yield* RefRosterAggregate.update({ id: "rr1" } as any, (c: any) => ({
        ...c.state,
        players: [c.state.players[0]],
      }))
      expect(playerItems()).toHaveLength(1)

      for (const [, form] of legacyForms) {
        playerItems()[0]!.dateOfBirth = form(DOB_MS)
        const legacy = (yield* RefRosterAggregate.get({ id: "rr1" } as any)) as RefRoster
        expect(isRealUtc(legacy.players[0]!.dateOfBirth, DOB_MS)).toBe(true)
      }
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Container refinements survive substitution
// ---------------------------------------------------------------------------

interface CheckedCase {
  readonly name: string
  readonly schema: Schema.Top
  readonly valid: unknown
  readonly stored: AttributeValue
  readonly read: (value: any) => boolean
  readonly invalid: unknown
}

const checkedCases: ReadonlyArray<CheckedCase> = [
  {
    name: "Record.check(isMaxProperties(1))",
    schema: Schema.Record(Schema.String, Schema.DateTimeUtcFromString).check(
      Schema.isMaxProperties(1),
    ),
    valid: { a: DOB },
    stored: { M: { a: S(DOB) } },
    read: (v) => isRealUtc(v.a, DOB_MS),
    invalid: { a: DOB, b: DOB },
  },
  {
    name: "TupleWithRest.check(isMaxLength(2))",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
      Schema.DateTimeUtcFromString,
    ]).check(Schema.isMaxLength(2)),
    valid: ["x", DOB],
    stored: { L: [S("x"), S(DOB)] },
    read: (v) => v[0] === "x" && isRealUtc(v[1], DOB_MS),
    invalid: ["x", DOB, DOB],
  },
  {
    name: "StructWithRest.check(isMaxProperties(2))",
    schema: Schema.StructWithRest(Schema.Struct({ at: Schema.DateTimeUtcFromString }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]).check(Schema.isMaxProperties(2)),
    valid: { at: DOB, note: "n" },
    stored: { M: { at: S(DOB), note: S("n") } },
    read: (v) => isRealUtc(v.at, DOB_MS) && v.note === "n",
    invalid: { at: DOB, note: "n", extra: "e" },
  },
  {
    name: "Tuple.check(...)",
    schema: Schema.Tuple([Schema.String, Schema.DateTimeUtcFromString]).check(
      Schema.makeFilter((t: readonly [string, unknown]) => t[0] !== "bad" || "no bad"),
    ),
    valid: ["x", DOB],
    stored: { L: [S("x"), S(DOB)] },
    read: (v) => isRealUtc(v[1], DOB_MS),
    invalid: ["bad", DOB],
  },
  {
    name: "NullOr.check(...)",
    schema: Schema.NullOr(Schema.DateTimeUtcFromString).check(
      Schema.makeFilter((v: unknown) => v !== null || "no nulls"),
    ),
    valid: DOB,
    stored: S(DOB),
    read: (v) => isRealUtc(v, DOB_MS),
    invalid: null,
  },
]

describe("#133 nested transforms — container refinements are kept", () => {
  for (const c of checkedCases) {
    it.effect(c.name, () =>
      Effect.gen(function* () {
        const Holder = makeHolder(`checked-${c.name}`, c.schema)
        yield* Holder.create({ id: "h1", f: c.valid } as any)
        expect(holderItem().f).toEqual(c.stored)
        const got = (yield* Holder.get({ id: "h1" } as any)) as any
        expect(c.read(got.f)).toBe(true)

        const badCreate = yield* Effect.flip(Holder.create({ id: "h2", f: c.invalid } as any))
        expect(badCreate._tag).toBe("ValidationError")
        const badUpdate = yield* Effect.flip(
          Holder.update({ id: "h1" } as any, (ctx: any) => ({ ...ctx.state, f: c.invalid })),
        )
        expect(badUpdate._tag).toBe("ValidationError")
        expect(holderItem().f).toEqual(c.stored)
      }).pipe(Effect.provide(TestLayer)),
    )
  }
})

// ---------------------------------------------------------------------------
// Create input with a ref edge: Effect values and cycles
// ---------------------------------------------------------------------------

class Kit extends Schema.Class<Kit>("Kit")({
  id: Schema.String,
  coach: Coach.pipe(DynamoModel.ref),
  nickname: Schema.Option(Schema.String),
  warmup: Schema.Duration,
  inner: Schema.Struct({ n: Schema.Number }),
}) {}

const KitAggregate = Aggregate.make(Kit, {
  table: ReproTable,
  schema: ReproSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "kit" },
  root: { entityType: "KitItem" },
  edges: { coach: Aggregate.one("coach", { entityType: "KitCoach", entity: Coaches }) },
})

describe("#133 nested transforms — create input values survive ref replacement", () => {
  for (const [label, nickname] of [
    ["Option.some", Option.some("Coachy")],
    ["Option.none", Option.none()],
  ] as const) {
    it.effect(`keeps an ${label} and a Duration`, () =>
      Effect.gen(function* () {
        yield* seed
        const input = {
          id: "k1",
          coachId: "coach-1",
          nickname,
          warmup: Duration.minutes(5),
          inner: { n: 1 },
        }
        const created = (yield* KitAggregate.create(input as any)) as Kit
        expect(Equal.equals(created.nickname, nickname)).toBe(true)
        expect(Equal.equals(created.warmup, Duration.minutes(5))).toBe(true)
        // The caller's input is not mutated by ref replacement.
        expect("coachId" in input).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )
  }

  it.effect("copies a cyclic input instead of overflowing the stack", () =>
    Effect.gen(function* () {
      yield* seed
      const input: any = {
        id: "k2",
        coachId: "coach-1",
        nickname: Option.none(),
        warmup: Duration.seconds(1),
        inner: { n: 1 },
      }
      input.inner.self = input
      const created = (yield* KitAggregate.create(input)) as Kit
      expect(created.inner.n).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Legacy domain-form numbers
// ---------------------------------------------------------------------------

class Tally extends Schema.Class<Tally>("Tally")({
  id: Schema.String,
  big: Schema.optional(Schema.BigIntFromString),
  bigs: Schema.Array(Schema.BigIntFromString),
  num: Schema.optional(Schema.NumberFromString),
}) {}

const TallyAggregate = Aggregate.make(Tally, {
  table: ReproTable,
  schema: ReproSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "tally" },
  root: { entityType: "TallyItem" },
  edges: {},
})

describe("#133 nested transforms — legacy domain-form numbers", () => {
  it.effect("reads bigint and NumberFromString values stored as N before #133", () =>
    Effect.gen(function* () {
      yield* TallyAggregate.create({ id: "t1", big: "5", bigs: ["7"], num: "3" } as any)
      const item = [...store.values()].find((i) => i.__edd_e__?.S === "TallyItem")!
      expect(item.big).toEqual(S("5"))
      // How <= 1.22.0 stored them: the domain value, marshalled as a number.
      item.big = { N: "5" }
      item.bigs = { L: [{ N: "7" }, { N: "12345678901234567890" }] }
      item.num = { N: "3" }

      const got = (yield* TallyAggregate.get({ id: "t1" } as any)) as Tally
      expect(got.big).toBe(5n)
      expect(got.bigs).toEqual([7n, 12345678901234567890n])
      expect(got.num).toBe(3)

      yield* TallyAggregate.update({ id: "t1" } as any, (c: any) => ({ ...c.state, big: 6n }))
      const after = [...store.values()].find((i) => i.__edd_e__?.S === "TallyItem")!
      expect(after.big).toEqual(S("6"))
      expect(after.bigs).toEqual({ L: [S("7"), S("12345678901234567890")] })
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// A sub-aggregate nested inside a sub-aggregate
// ---------------------------------------------------------------------------

class SquadSession extends Schema.Class<SquadSession>("SquadSession")({
  at: Schema.DateTimeUtcFromString,
}) {}
class SquadPlayer extends Schema.Class<SquadPlayer>("SquadPlayer")({
  player: Player,
  sessions: Schema.Array(SquadSession),
}) {}
class Squad extends Schema.Class<Squad>("Squad")({
  name: Schema.String,
  days: Schema.Array(Schema.DateTimeUtcFromString),
  players: Schema.Array(SquadPlayer),
}) {}
class Club extends Schema.Class<Club>("Club")({
  name: Schema.String,
  coach: Coach.pipe(DynamoModel.ref),
  squad: Squad,
}) {}
class League extends Schema.Class<League>("League")({
  id: Schema.String,
  club1: Club,
  club2: Club,
}) {}

const SquadAggregate = Aggregate.make(Squad, {
  root: { entityType: "LeagueSquad" },
  edges: {
    players: Aggregate.many("players", { entityType: "LeagueSquadPlayer", entity: Players }),
  },
})
const ClubAggregate = Aggregate.make(Club, {
  root: { entityType: "LeagueClub" },
  edges: {
    coach: Aggregate.one("coach", { entityType: "LeagueCoach", entity: Coaches }),
    squad: SquadAggregate.with({ discriminator: { squadNo: 1 } }),
  },
})
const LeagueAggregate = Aggregate.make(League, {
  table: ReproTable,
  schema: ReproSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "league" },
  root: { entityType: "LeagueItem" },
  edges: {
    club1: ClubAggregate.with({ discriminator: { clubNo: 1 } }),
    club2: ClubAggregate.with({ discriminator: { clubNo: 2 } }),
  },
})

const leagueInput = {
  id: "l1",
  club1: {
    name: "One",
    coachId: "coach-1",
    squad: {
      name: "A",
      days: [DOB],
      players: [{ playerId: "player-1", sessions: [{ at: DOB }] }],
    },
  },
  club2: {
    name: "Two",
    coachId: "coach-2",
    squad: {
      name: "B",
      days: [DAY2],
      players: [{ playerId: "player-2", sessions: [{ at: DAY2 }] }],
    },
  },
}

const leagueKeys = () =>
  [...store.values()]
    .filter((i) => i.pk?.S === "$issue133#v1#league#l1")
    .map((i) => `${i.__edd_e__?.S} ${i.sk?.S}`)
    .sort()

describe("#133 nested sub-aggregates", () => {
  it.effect("create writes each binding's inner sub-aggregate under its own keys", () =>
    Effect.gen(function* () {
      yield* seed
      yield* LeagueAggregate.create(leagueInput as any)
      expect(leagueKeys()).toEqual([
        "LeagueClub $issue133#v1#leagueclub#clubno#0000000000000001",
        "LeagueClub $issue133#v1#leagueclub#clubno#0000000000000002",
        "LeagueCoach $issue133#v1#leaguecoach#clubno#0000000000000001",
        "LeagueCoach $issue133#v1#leaguecoach#clubno#0000000000000002",
        "LeagueItem $issue133#v1#leagueitem",
        "LeagueSquad $issue133#v1#leaguesquad#clubno#0000000000000001#squadno#0000000000000001",
        "LeagueSquad $issue133#v1#leaguesquad#clubno#0000000000000002#squadno#0000000000000001",
        "LeagueSquadPlayer $issue133#v1#leaguesquadplayer#clubno#0000000000000001#squadno#0000000000000001#player-1",
        "LeagueSquadPlayer $issue133#v1#leaguesquadplayer#clubno#0000000000000002#squadno#0000000000000001#player-2",
      ])
      const squad = [...store.values()].find(
        (i) => i.__edd_e__?.S === "LeagueSquad" && i.clubNo?.N === "2",
      )!
      expect(squad.squadNo).toEqual({ N: "1" })
      expect(squad.days).toEqual({ L: [S(DAY2)] })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("get assembles both levels with real DateTimes", () =>
    Effect.gen(function* () {
      yield* seed
      yield* LeagueAggregate.create(leagueInput as any)
      const got = (yield* LeagueAggregate.get({ id: "l1" } as any)) as League
      expect(got.club1.name).toBe("One")
      expect(got.club2.squad.name).toBe("B")
      expect(got.club2.squad).toBeInstanceOf(Squad)
      expect(isRealUtc(got.club1.coach.dateOfBirth, DOB_MS)).toBe(true)
      expect(isRealUtc(got.club2.squad.days[0], DAY2_MS)).toBe(true)
      expect(got.club2.squad.players[0]!.player.id).toBe("player-2")
      expect(isRealUtc(got.club2.squad.players[0]!.sessions[0]!.at, DAY2_MS)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("update rewrites only the inner group that changed", () =>
    Effect.gen(function* () {
      yield* seed
      yield* LeagueAggregate.create(leagueInput as any)
      transactCalls.length = 0
      yield* LeagueAggregate.update({ id: "l1" } as any, (c: any) => c.state)
      expect(transactCalls).toHaveLength(0)

      yield* LeagueAggregate.update({ id: "l1" } as any, (c: any) => ({
        ...c.state,
        club2: { ...c.state.club2, squad: { ...c.state.club2.squad, name: "B2" } },
      }))
      expect(transactCalls).toHaveLength(1)
      const written = transactCalls[0]!.map((op) => op.Put?.Item?.__edd_e__?.S).sort()
      expect(written).toEqual(["LeagueSquad", "LeagueSquadPlayer"])
      const got = (yield* LeagueAggregate.get({ id: "l1" } as any)) as League
      expect(got.club2.squad.name).toBe("B2")
      expect(got.club1.squad.name).toBe("A")

      // Removing an inner element deletes its row.
      yield* LeagueAggregate.update({ id: "l1" } as any, (c: any) => ({
        ...c.state,
        club1: { ...c.state.club1, squad: { ...c.state.club1.squad, players: [] } },
      }))
      expect(leagueKeys()).toHaveLength(8)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("delete removes every level", () =>
    Effect.gen(function* () {
      yield* seed
      yield* LeagueAggregate.create(leagueInput as any)
      yield* LeagueAggregate.delete({ id: "l1" } as any)
      expect(leagueKeys()).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it("rejects a nested binding that reuses an inherited discriminator attribute", () => {
    const Inner = Aggregate.make(Squad, {
      root: { entityType: "ClashSquad" },
      edges: {
        players: Aggregate.many("players", { entityType: "ClashPlayer", entity: Players }),
      },
    })
    const Outer = Aggregate.make(Club, {
      root: { entityType: "ClashClub" },
      edges: {
        coach: Aggregate.one("coach", { entityType: "ClashCoach", entity: Coaches }),
        squad: Inner.with({ discriminator: { clubNo: 9 } }),
      },
    })
    expect(() =>
      Aggregate.make(League, {
        table: ReproTable,
        schema: ReproSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "clash" },
        root: { entityType: "ClashLeague" },
        edges: {
          club1: Outer.with({ discriminator: { clubNo: 1 } }),
          club2: Outer.with({ discriminator: { clubNo: 2 } }),
        },
      }),
    ).toThrow(/EDD-9056/)
  })
})

describe("#133 nested sub-aggregates — derived input schema", () => {
  it.effect("accepts the nested create payload, with ref ids at both levels", () =>
    Effect.gen(function* () {
      const decoded = (yield* Schema.decodeUnknownEffect(LeagueAggregate.inputSchema as any)(
        leagueInput,
      )) as any
      expect(decoded.club2.coachId).toBe("coach-2")
      expect(decoded.club2.squad.players[0].playerId).toBe("player-2")
    }),
  )
})

// ---------------------------------------------------------------------------
// Batch 3 — root unions mixing a date with a string / number member
// ---------------------------------------------------------------------------

const describeValue = (v: unknown): string =>
  DateTime.isDateTime(v)
    ? Object.getPrototypeOf(v) === Object.prototype
      ? "PLAIN"
      : `DT ${DateTime.formatIso(v)}`
    : typeof v === "bigint"
      ? `${v}n`
      : JSON.stringify(v)

interface AggUnionCase {
  readonly name: string
  readonly schema: Schema.Top
  /** Stored attributes, as an earlier version left them, and their read-back. */
  readonly stored: ReadonlyArray<readonly [AttributeValue, string]>
  readonly fresh: ReadonlyArray<readonly [unknown, AttributeValue, string]>
}

const aggUnionCases: ReadonlyArray<AggUnionCase> = [
  {
    name: "Union([DateTimeUtc, String])",
    schema: Schema.Union([Schema.DateTimeUtc, Schema.String]),
    stored: [
      [S("2020"), '"2020"'],
      [S("5"), '"5"'],
      // <= 1.22.0 aggregates stored this field's dates as canonical ISO.
      [S(DOB), `DT ${DOB}`],
      [rcMap(DOB_MS), `DT ${DOB}`],
    ],
    fresh: [
      ["2020", S("2020"), '"2020"'],
      [DateTime.makeUnsafe(DOB_MS), S(DOB), `DT ${DOB}`],
    ],
  },
  {
    name: "Union([String, DateTimeUtc])",
    schema: Schema.Union([Schema.String, Schema.DateTimeUtc]),
    stored: [
      [S("2020"), '"2020"'],
      [S(DOB), `DT ${DOB}`],
    ],
    fresh: [
      ["hello", S("hello"), '"hello"'],
      [DateTime.makeUnsafe(DOB_MS), S(DOB), `DT ${DOB}`],
    ],
  },
  {
    name: "Union([DateTimeUtc storedAs epochMs, Number])",
    schema: Schema.Union([
      Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
      Schema.Number,
    ]),
    stored: [
      [{ N: "5" }, "5"],
      [rcMap(DOB_MS), `DT ${DOB}`],
    ],
    fresh: [
      [5, { N: "5" }, "5"],
      [DateTime.makeUnsafe(DOB_MS), S(DOB), `DT ${DOB}`],
    ],
  },
  {
    name: "NullOr(DateTimeUtc)",
    schema: Schema.NullOr(Schema.DateTimeUtc),
    stored: [[rcMap(DOB_MS), `DT ${DOB}`]],
    fresh: [
      [DateTime.makeUnsafe(DOB_MS), S(DOB), `DT ${DOB}`],
      [null, { NULL: true }, "null"],
    ],
  },
  {
    name: "Schema.BigInt",
    schema: Schema.BigInt,
    stored: [
      [{ N: "5" }, "5n"],
      [{ N: "12345678901234567890" }, "12345678901234567890n"],
    ],
    fresh: [[5n, { N: "5" }, "5n"]],
  },
]

describe("#133 nested transforms — root unions with a colliding member", () => {
  for (const c of aggUnionCases) {
    it.effect(`${c.name}: stored rows and fresh writes read back as their own member`, () =>
      Effect.gen(function* () {
        const Holder = makeHolder(`collide-${c.name}`, c.schema)
        const reads: Array<string> = []
        for (const [stored] of c.stored) {
          store.clear()
          yield* Holder.create({ id: "h1", f: c.fresh[0]![0] } as any)
          holderItem().f = stored
          reads.push(describeValue(((yield* Holder.get({ id: "h1" } as any)) as any).f))
        }
        expect(reads).toEqual(c.stored.map(([, read]) => read))

        const fresh: Array<string> = []
        for (const [value, stored] of c.fresh) {
          store.clear()
          yield* Holder.create({ id: "h1", f: value } as any)
          expect(holderItem().f).toEqual(stored)
          fresh.push(describeValue(((yield* Holder.get({ id: "h1" } as any)) as any).f))
          transactCalls.length = 0
          yield* Holder.update({ id: "h1" } as any, (ctx: any) => ctx.state)
          expect(transactCalls).toHaveLength(0)
        }
        expect(fresh).toEqual(c.fresh.map(([, , read]) => read))
      }).pipe(Effect.provide(TestLayer)),
    )
  }
})
