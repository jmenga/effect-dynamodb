/**
 * Every write keys the indexes an entity-level ref's id is a composite of, as `put` keys them
 * (#241), whatever the referenced entity's key type, and a ref the model declares optional can be
 * left out:
 *
 * - `upsert` and `update` / `patch` / a `transactWrite` update compose those keys from the id given,
 *   as `put` does (`withRefIds`), through the same policy-aware composer. Up to 1.40.0 they composed
 *   from the stored ref alone, so an upsert wrote no cascade index key and an update reassigning the
 *   ref kept the old one: a cascade from the new team missed the row, and one from the old team
 *   rewrote it with the wrong team.
 * - An id is taken as a value of the referenced entity's key (`keyValueOf`), so a key stored in
 *   another form (`NumberFromString`, `BigIntFromString`, `DateEpochSeconds`) is fetched. Up to
 *   1.40.0 every write naming such a ref failed (`get.decode`).
 * - A `.within()` row check and `rekey` read a stored ref's id as a value of the key
 *   (`storedRefIdOf`). Up to 1.40.0 a date key stored as epoch milliseconds was read as stored: a
 *   bound on the id matched no row, and `rekey({ repairIndexKeys: true })` rewrote a correct row's
 *   cascade key as epoch text, which a cascade then missed.
 * - A ref declared `Schema.optionalKey` / `Schema.optional` can be left out of `put`, `create` and
 *   `upsert`: nothing is fetched, and the row stores no ref and no key of an index keyed by its id.
 *   `.remove(["team"])` removes it, and the row leaves the index keyed by its id; `.remove(["teamId"])`
 *   is refused as before. Up to 1.40.0 its id was required, and removing it was refused.
 *
 * `fixtures/entity-ref-writes-1.40.0.json` holds what published 1.40.0 sent, stored and returned for
 * each step on DynamoDB Local. One suite, run on a recording table (`EntityRefKeys.test.ts`) and
 * against DynamoDB Local (`connected.entity-ref-keys.test.ts`), with their harnesses.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import type { Harness } from "./EntityRefKeys.js"

type Row = Record<string, AttributeValue>
type Sent = { readonly command: string; readonly input: any }
type Outcome = {
  readonly ok?: any
  readonly failed?: string
  readonly operation?: string
  readonly cause?: string
  readonly died?: string
}
type Step = { readonly outcome: Outcome; readonly requests: ReadonlyArray<Sent> }
type Recorded = {
  readonly steps: Record<string, Step>
  readonly rows: ReadonlyArray<Row>
  readonly cascadeRows: ReadonlyArray<Row>
}

const published = JSON.parse(
  readFileSync(new URL("../fixtures/entity-ref-writes-1.40.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly keys: Record<string, Recorded>
  readonly optional: Record<string, Recorded>
}

const schema = DynamoSchema.make({ name: "refw", version: 1 })
const one = (composite: ReadonlyArray<string>) => ({
  pk: { field: "pk", composite: [...composite] },
  sk: { field: "sk", composite: [] as Array<string> },
})
const cascade = { index: "gsi1", pk: { field: "gsi1pk" }, sk: { field: "gsi1sk" } }
const d1 = DateTime.makeUnsafe(1700000000000)
const d2 = DateTime.makeUnsafe(1800000000000)

/** Each key type a Team is keyed by, with the ids of teams a and b: the fixture generator's. */
const keyTypes = {
  String: [() => Schema.String, "t1", "t2"],
  Number: [() => Schema.Number, 5, 6],
  NumberFromString: [() => Schema.NumberFromString, 5, 6],
  BigInt: [() => Schema.BigInt, 5n, 6n],
  BigIntFromString: [() => Schema.BigIntFromString, 5n, 6n],
  DateTimeUtc: [() => Schema.DateTimeUtc, d1, d2],
  "DateTimeUtc stored as DateEpochMs": [
    () => Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
    d1,
    d2,
  ],
  DateEpochSeconds: [() => DynamoModel.DateEpochSeconds, d1, d2],
} as const satisfies Record<string, readonly [() => Schema.Top, unknown, unknown]>
type KeyType = keyof typeof keyTypes
/** The key types 1.40.0 fetched a ref by: every write naming one of the others failed. */
const fetched140: ReadonlyArray<KeyType> = [
  "String",
  "Number",
  "BigInt",
  "DateTimeUtc",
  "DateTimeUtc stored as DateEpochMs",
]

const variants = ["required", "Schema.optionalKey", "Schema.optional"] as const
type Variant = (typeof variants)[number]

/** A value as the fixture holds it: a date as its epoch milliseconds, a bigint as `"<n>n"`. */
const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, function (this: any, key, encoded) {
      const held = this[key]
      if (held !== null && typeof held === "object" && DateTime.isDateTime(held)) {
        return { date: DateTime.toEpochMillis(held) }
      }
      if (typeof held === "bigint") return `${held}n`
      return encoded
    }),
  )

const outcome = <A, E>(exit: Exit.Exit<A, E>): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: exit.value === undefined ? null : plain(exit.value) }
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (failure === undefined) return { died: Cause.pretty(exit.cause).split("\n")[0]! }
  const error = (failure as unknown as { readonly error: any }).error
  return {
    failed: error._tag,
    operation: error.operation,
    cause: String(error.cause?.message ?? error.cause ?? error.message).slice(0, 400),
  }
}

const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`
const sorted = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
const player = (rows: ReadonlyArray<Row>, id: string) =>
  rows.find((row) => row.__edd_e__?.S === "Player" && row.id?.S === id)
const writeOf = (step: Step) => {
  const sent = step.requests.find((request) => request.command !== "GetItem")!
  return sent.command === "TransactWriteItems" ? sent.input.TransactItems[0].Update : sent.input
}
/** The value an update SETs `attribute` to, by its placeholder; `undefined` when it sets none. */
const setTo = (write: any, attribute: string): AttributeValue | undefined => {
  const name = Object.keys(write.ExpressionAttributeNames).find(
    (placeholder) => write.ExpressionAttributeNames[placeholder] === attribute,
  )
  return name === undefined ? undefined : write.ExpressionAttributeValues[`:${name.slice(1)}`]
}

/** Run `steps` against a fresh table, recording each step's outcome and requests. */
const record = (
  harness: Harness,
  Main: any,
  entities: Record<string, any>,
  steps: (
    db: any,
    step: (name: string, op: any) => Effect.Effect<void, never, any>,
    snapshot: (into: "rows") => Effect.Effect<void>,
  ) => Effect.Effect<void, unknown, any>,
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
        harness.provide(tableName, Main, effect)
      const db: any = yield* run(DynamoClient.make({ entities, tables: { Main } } as never))
      const recorded: Record<string, Step> = {}
      let rows: ReadonlyArray<Row> = []
      const step = (name: string, op: any) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            run(typeof op.asEffect === "function" ? op.asEffect() : op),
          )
          recorded[name] = { outcome: outcome(exit), requests: yield* harness.requests(tableName) }
        })
      const snapshot = () =>
        Effect.gen(function* () {
          rows = sorted(yield* harness.rows(tableName))
        })
      yield* steps(db, step, snapshot)
      return {
        steps: recorded,
        rows,
        cascadeRows: sorted(yield* harness.rows(tableName)),
      } as Recorded
    }),
  )

/** The fixture generator's panel for one key type. */
const keyPanel = (harness: Harness, label: KeyType) => {
  const [keySchema, a, b] = keyTypes[label]
  class Team extends Schema.Class<Team>("Team")({
    id: (keySchema() as Schema.Top).pipe(DynamoModel.identifier),
    name: Schema.String,
  }) {}
  const Teams = Entity.make({ model: Team, entityType: "Team", primaryKey: one(["id"]) } as never)
  class Player extends Schema.Class<Player>("Player")({
    id: Schema.String,
    league: Schema.String,
    nick: Schema.String,
    team: Team.pipe(DynamoModel.ref),
  }) {}
  const Players = Entity.make({
    model: Player,
    entityType: "Player",
    primaryKey: one(["id"]),
    indexes: {
      byLeague: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["league"] },
        sk: { field: "gsi2sk", composite: ["nick", "teamId"] },
      },
    },
    refs: { team: { entity: Teams, cascade } },
  } as never) as any
  const Main = Table.make({ schema, entities: { Teams, Players } } as never) as any
  return record(harness, Main, { Teams, Players }, (db, step, snapshot) =>
    Effect.gen(function* () {
      yield* step("seed a", db.entities.Teams.put({ id: a, name: "Tigers" }))
      yield* step("seed b", db.entities.Teams.put({ id: b, name: "Bears" }))
      yield* step(
        "put p1",
        db.entities.Players.put({ id: "p1", league: "L", nick: "x", teamId: a }),
      )
      yield* step(
        "put p2",
        db.entities.Players.put({ id: "p2", league: "L", nick: "y", teamId: a }),
      )
      yield* step(
        "upsert p3",
        db.entities.Players.upsert({ id: "p3", league: "L", nick: "z", teamId: b }),
      )
      yield* step("update p1", db.entities.Players.update({ id: "p1" }).set({ teamId: b }))
      yield* step("patch p2", db.entities.Players.patch({ id: "p2" }).set({ teamId: b }))
      yield* step(
        "transactWrite update p2",
        Transaction.transactWrite([db.entities.Players.update({ id: "p2" }).set({ teamId: a })]),
      )
      yield* snapshot("rows")
      const byLeague = () => db.entities.Players.byLeague({ league: "L" })
      yield* step(
        "within eq",
        byLeague()
          .within({ teamId: { eq: a } }, { maxSkips: 0 })
          .collect(),
      )
      yield* step(
        "within gte",
        byLeague()
          .within({ teamId: { gte: b } }, { maxSkips: 0 })
          .collect(),
      )
      yield* step(
        "cascade",
        db.entities.Teams.update({ id: b })
          .set({ name: "Bulls" })
          .cascade({ targets: [Players] }),
      )
      for (const id of ["p1", "p2", "p3"]) {
        yield* step(`get ${id}`, db.entities.Players.get({ id }))
      }
      // Not in the fixture: the row a `put` stores for what `upsert p3` was given, the cascade
      // already run.
      yield* step(
        "put p4",
        db.entities.Players.put({ id: "p4", league: "L", nick: "z", teamId: b }),
      )
      // Not in the fixture: `rekey` judges every row's index keys by its stored ref.
      yield* step("rekey", db.tables.Main.rekey({ dryRun: true, repairIndexKeys: true }))
    }),
  )
}

/** The fixture generator's panel for a ref declared required, `Schema.optionalKey` or `Schema.optional`. */
const optionalPanel = (harness: Harness, variant: Variant) => {
  class Team extends Schema.Class<Team>("Team")({
    id: Schema.String.pipe(DynamoModel.identifier),
    name: Schema.String,
  }) {}
  const Teams = Entity.make({ model: Team, entityType: "Team", primaryKey: one(["id"]) } as never)
  const team =
    variant === "required"
      ? Team.pipe(DynamoModel.ref)
      : variant === "Schema.optionalKey"
        ? Schema.optionalKey(Team.pipe(DynamoModel.ref))
        : Schema.optional(Team).pipe(DynamoModel.ref)
  class Player extends Schema.Class<Player>("Player")({
    id: Schema.String,
    nick: Schema.String,
    team: team as Schema.Top,
  }) {}
  const Players = Entity.make({
    model: Player,
    entityType: "Player",
    primaryKey: one(["id"]),
    refs: { team: { entity: Teams, cascade } },
  } as never) as any
  const Main = Table.make({ schema, entities: { Teams, Players } } as never) as any
  return record(harness, Main, { Teams, Players }, (db, step, snapshot) =>
    Effect.gen(function* () {
      yield* step("seed", db.entities.Teams.put({ id: "t1", name: "Tigers" }))
      const P = db.entities.Players
      yield* step("put p1", P.put({ id: "p1", nick: "n", teamId: "t1" }))
      yield* step("put p2, no teamId", P.put({ id: "p2", nick: "n" }))
      yield* step("create p3, no teamId", P.create({ id: "p3", nick: "n" }))
      yield* step("upsert p4, no teamId", P.upsert({ id: "p4", nick: "n" }))
      yield* step("put p5", P.put({ id: "p5", nick: "n", teamId: "t1" }))
      yield* step("update p1, set nick", P.update({ id: "p1" }).set({ nick: "m" }))
      yield* step("update p5, remove team", P.update({ id: "p5" }).remove(["team"]))
      yield* step("update p5, remove teamId", P.update({ id: "p5" }).remove(["teamId"]))
      yield* step("update p2, set teamId", P.update({ id: "p2" }).set({ teamId: "t1" }))
      yield* snapshot("rows")
      yield* step(
        "cascade",
        db.entities.Teams.update({ id: "t1" })
          .set({ name: "Lions" })
          .cascade({ targets: [Players] }),
      )
      for (const id of ["p1", "p2", "p3", "p4", "p5"]) {
        yield* step(`get ${id}`, P.get({ id }))
      }
    }),
  )
}

/** The steps both the fixture and a run hold (a run also seeds through steps). */
const shared = (run: Recorded, before: Recorded) =>
  Object.keys(before.steps).filter((name) => Object.hasOwn(run.steps, name))

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("every write keys the indexes a ref's id is a composite of, as put does", () => {
    it("the fixture is published 1.40.0's, and holds every shape", () => {
      expect(published.generatedFrom).toBe("effect-dynamodb@1.40.0")
      expect(Object.keys(published.keys)).toEqual(Object.keys(keyTypes))
      expect(Object.keys(published.optional)).toEqual([...variants])
    })

    it("on 1.40.0 an upsert wrote no cascade index key, an update kept the old one, and a transformed key failed", () => {
      const own = published.keys.String!
      expect(setTo(writeOf(own.steps["upsert p3"]!), "gsi1pk")).toBeUndefined()
      expect(player(own.rows, "p3")).not.toHaveProperty("gsi1pk")
      for (const name of ["update p1", "patch p2", "transactWrite update p2"]) {
        expect(Object.values(writeOf(own.steps[name]!).ExpressionAttributeNames)).toEqual([
          "team",
          "gsi1sk",
          "pk",
        ])
      }
      // p1 names team b, and is keyed under team a: the cascade from b found nothing.
      expect(player(own.rows, "p1")!.team!.M!.id).toEqual({ S: "t2" })
      expect(player(own.rows, "p1")!.gsi1pk).toEqual({ S: "$refw#v1#player#teamid_t1" })
      expect(own.steps.cascade!.requests.map((sent) => sent.command)).toEqual([
        "UpdateItem",
        "Query",
      ])
      expect(own.steps["get p1"]!.outcome.ok.team.name).toBe("Bears")
      for (const label of ["NumberFromString", "BigIntFromString", "DateEpochSeconds"] as const) {
        expect(published.keys[label]!.steps["put p1"]!.outcome).toMatchObject({
          failed: "ValidationError",
          operation: "get.decode",
        })
      }
      // A date key stored as epoch milliseconds: a bound on its id matched no row.
      const epoch = published.keys["DateTimeUtc stored as DateEpochMs"]!
      expect(epoch.steps["within eq"]!.outcome).toEqual({ ok: [] })
      expect(published.keys.DateTimeUtc!.steps["within eq"]!.outcome.ok).toHaveLength(1)
    })

    for (const label of Object.keys(keyTypes) as ReadonlyArray<KeyType>) {
      it(`keyed by ${label}: every write keys the cascade index by the ref, as put does`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const before = published.keys[label]!
            const ran = yield* keyPanel(harness, label)
            for (const [name, step] of Object.entries(ran.steps)) {
              expect({ name, outcome: Object.keys(step.outcome) }).toEqual({
                name,
                outcome: ["ok"],
              })
            }

            // A put 1.40.0 made is 1.40.0's, byte for byte; every team is fetched under the key
            // its own put wrote.
            if (fetched140.includes(label)) {
              for (const name of ["put p1", "put p2"])
                expect(ran.steps[name]).toEqual(before.steps[name])
            }
            const teamKeys = ran.rows
              .filter((row) => row.__edd_e__?.S === "Team")
              .map((row) => ({ pk: row.pk, sk: row.sk }))
            for (const name of [
              "put p1",
              "put p2",
              "upsert p3",
              "update p1",
              "patch p2",
              "transactWrite update p2",
            ]) {
              const fetched = ran.steps[name]!.requests.filter((sent) => sent.command === "GetItem")
              expect(fetched.length).toBeGreaterThan(0)
              expect(teamKeys).toContainEqual(fetched[0]!.input.Key)
            }

            // The key a put writes for each team; every row is keyed by the team it names.
            const keyedA = ran.steps["put p1"]!.requests.find((sent) => sent.command === "PutItem")!
              .input.Item.gsi1pk
            const keyedB = setTo(writeOf(ran.steps["upsert p3"]!), "gsi1pk")
            expect(keyedB).toBeDefined()
            expect(keyedB).not.toEqual(keyedA)
            expect(player(ran.rows, "p1")!.gsi1pk).toEqual(keyedB)
            expect(player(ran.rows, "p2")!.gsi1pk).toEqual(keyedA)
            expect(player(ran.rows, "p3")!.gsi1pk).toEqual(keyedB)
            for (const id of ["p1", "p2", "p3"]) {
              expect(player(ran.rows, id)!.gsi1sk).toEqual({ S: `$refw#v1#player#id_${id}` })
            }

            // An update names the cascade index key where 1.40.0 left it out; the rest is 1.40.0's.
            for (const [name, keyed] of [
              ["update p1", keyedB],
              ["patch p2", keyedB],
              ["transactWrite update p2", keyedA],
            ] as const) {
              const write = writeOf(ran.steps[name]!)
              expect(write.UpdateExpression).toBe("SET #u0 = :u0, #u1 = :u1, #u2 = :u2")
              expect(write.ExpressionAttributeNames).toEqual({
                "#u0": "team",
                "#u1": "gsi1pk",
                "#u2": "gsi1sk",
                "#exists": "pk",
              })
              expect(write.ExpressionAttributeValues[":u1"]).toEqual(keyed)
              if (fetched140.includes(label)) {
                const was = writeOf(before.steps[name]!)
                expect(write.ExpressionAttributeValues).toEqual({
                  ":u0": was.ExpressionAttributeValues[":u0"],
                  ":u1": keyed,
                  ":u2": was.ExpressionAttributeValues[":u1"],
                })
                expect(write.ConditionExpression).toBe(was.ConditionExpression)
              }
            }

            // An upsert stores what a put given the same values stores (`put p4`, after the cascade).
            const { pk: _pk3, id: _id3, gsi1sk: _sk3, ...upserted } = player(ran.cascadeRows, "p3")!
            const { pk: _pk4, id: _id4, gsi1sk: _sk4, ...put } = player(ran.cascadeRows, "p4")!
            expect(upserted).toEqual(put)

            // A bound on the id finds the rows naming the team; the requests are 1.40.0's.
            const ids = (step: Step) => (step.outcome.ok as Array<{ id: string }>).map((p) => p.id)
            expect(ids(ran.steps["within eq"]!).sort()).toEqual(["p2"])
            expect(ids(ran.steps["within gte"]!).sort()).toEqual(["p1", "p3"])
            for (const name of ["within eq", "within gte"]) {
              expect(ran.steps[name]!.requests).toEqual(before.steps[name]!.requests)
            }

            // The cascade from b reads the partition put keys b's rows in, and rewrites them all.
            const cascaded = ran.steps.cascade!.requests
            expect(cascaded.map((sent) => sent.command)).toEqual([
              "UpdateItem",
              "Query",
              "UpdateItem",
              "UpdateItem",
            ])
            expect(cascaded[0]).toEqual(before.steps.cascade!.requests[0])
            expect(cascaded[1]!.input.ExpressionAttributeValues[":pk"]).toEqual(keyedB)
            expect(ran.steps["get p1"]!.outcome.ok.team.name).toBe("Bulls")
            expect(ran.steps["get p2"]!.outcome.ok.team.name).toBe("Tigers")
            expect(ran.steps["get p3"]!.outcome.ok.team.name).toBe("Bulls")

            // The update naming only `teamId` leaves p1's `byLeague` key, whose other composite
            // (`nick`) it lacks, under `'preserve'`, as for any composite; 1.40.0 left it too.
            const putP1 = ran.steps["put p1"]!.requests.find((sent) => sent.command === "PutItem")!
            expect(player(ran.rows, "p1")!.gsi2sk).toEqual(putP1.input.Item.gsi2sk)
            // `rekey` reads each stored ref's id as a value of the key: that key is the one it finds
            // lagging, and every cascade key is what a put writes. 1.40.0 read a date key stored as
            // epoch milliseconds as stored, so `repairIndexKeys` judged a correct row's cascade key
            // lagging too, and rewrote it as epoch text, which a cascade then missed. A dry run
            // counts what it finds and repairs nothing.
            expect(ran.steps.rekey!.outcome.ok.indexKeys).toEqual({
              missing: 0,
              truncated: 0,
              lagging: 1,
              ambiguous: 0,
              repaired: 0,
              skipped: 0,
            })
          }),
        ))
    }

    it("a required ref is 1.40.0's, but an update naming the team keys the index by it", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const before = published.optional.required!
          const ran = yield* optionalPanel(harness, "required")
          for (const name of shared(ran, before)) {
            if (name === "update p2, set teamId") continue
            expect({ name, step: ran.steps[name] }).toEqual({ name, step: before.steps[name] })
          }
          // p2 was never put (its put without teamId is refused): the update finds no row.
          const update = ran.steps["update p2, set teamId"]!
          expect(update.outcome).toEqual(before.steps["update p2, set teamId"]!.outcome)
          expect(writeOf(update).ExpressionAttributeNames).toEqual({
            "#u0": "team",
            "#u1": "gsi1pk",
            "#u2": "gsi1sk",
            "#exists": "pk",
          })
          expect(ran.rows).toEqual(before.rows)
          expect(ran.cascadeRows).toEqual(before.cascadeRows)
        }),
      ))

    for (const variant of ["Schema.optionalKey", "Schema.optional"] as const) {
      it(`a ref declared ${variant} can be left out, and removed`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const before = published.optional[variant]!
            const ran = yield* optionalPanel(harness, variant)
            for (const name of ["put p1", "put p5", "update p1, set nick", "get p1"]) {
              expect({ name, step: ran.steps[name] }).toEqual({ name, step: before.steps[name] })
            }

            // Left out of put, create and upsert: nothing fetched, no ref and no index key stored.
            // 1.40.0 required the id.
            for (const name of [
              "put p2, no teamId",
              "create p3, no teamId",
              "upsert p4, no teamId",
            ]) {
              expect(before.steps[name]!.outcome).toMatchObject({
                failed: "ValidationError",
                cause: 'Missing key\n  at ["teamId"]',
              })
              expect(ran.steps[name]!.outcome.ok).not.toHaveProperty("team")
              expect(ran.steps[name]!.requests.map((sent) => sent.command)).toEqual([
                name.startsWith("upsert") ? "UpdateItem" : "PutItem",
              ])
            }
            for (const id of ["p3", "p4"]) {
              expect(player(ran.rows, id)).toEqual({
                pk: { S: `$refw#v1#player#id_${id}` },
                sk: { S: "$refw#v1#player" },
                id: { S: id },
                nick: { S: "n" },
                __edd_e__: { S: "Player" },
              })
            }

            // Removed by its field: the ref and the index key composed from its id go; the
            // primary-key half is SET as on every write. 1.40.0 refused it.
            expect(before.steps["update p5, remove team"]!.outcome.failed).toBe("ValidationError")
            const removed = ran.steps["update p5, remove team"]!
            expect(removed.outcome.ok).not.toHaveProperty("team")
            expect(removed.requests).toHaveLength(1)
            expect(writeOf(removed)).toMatchObject({
              UpdateExpression: "SET #u0 = :u0 REMOVE #r0, #r1",
              ExpressionAttributeNames: {
                "#u0": "gsi1sk",
                "#r0": "team",
                "#r1": "gsi1pk",
                "#exists": "pk",
              },
            })
            const p5 = player(ran.rows, "p5")!
            expect(p5).not.toHaveProperty("team")
            expect(p5).not.toHaveProperty("gsi1pk")
            expect(p5.gsi1sk).toEqual({ S: "$refw#v1#player#id_p5" })

            // Its id can't be removed: the row stores the ref, not the id. As 1.40.0, but the hint.
            const byId = ran.steps["update p5, remove teamId"]!
            expect(byId.requests).toEqual([])
            expect(byId.outcome).toMatchObject({ failed: "ValidationError", operation: "update" })
            expect(byId.outcome.cause).toContain('or remove the ref with .remove(["team"])')

            // Set on a row without one: the ref and the index key are stored, as a put stores them.
            const set = ran.steps["update p2, set teamId"]!
            expect(set.requests.map((sent) => sent.command)).toEqual(["GetItem", "UpdateItem"])
            expect(player(ran.rows, "p2")!.gsi1pk).toEqual(player(ran.rows, "p1")!.gsi1pk)
            expect(player(ran.rows, "p2")!.team).toEqual(player(ran.rows, "p1")!.team)

            // The cascade rewrites the rows naming the team, and skips the rows without one.
            const cascaded = ran.steps.cascade!.requests
            expect(cascaded.map((sent) => sent.command)).toEqual([
              "UpdateItem",
              "Query",
              "UpdateItem",
              "UpdateItem",
            ])
            expect(
              cascaded
                .slice(2)
                .map((sent) => sent.input.Key.pk.S as string)
                .sort(),
            ).toEqual(["$refw#v1#player#id_p1", "$refw#v1#player#id_p2"])
            for (const id of ["p1", "p2"]) {
              expect(ran.steps[`get ${id}`]!.outcome.ok.team.name).toBe("Lions")
            }
            for (const id of ["p3", "p4", "p5"]) {
              expect(ran.steps[`get ${id}`]!.outcome.ok).toEqual({ id, nick: "n" })
            }
          }),
        ))
    }
  })
