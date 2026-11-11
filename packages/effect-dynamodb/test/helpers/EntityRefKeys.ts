/**
 * Entity-level refs (`Entity.make({ refs })`) name the referenced entity's key composite (#241): a
 * `${field}Id` is fetched under it, read back from the stored ref under it (`putValuesOf`, a
 * `.within()` row check), and a cascade from the referenced entity is keyed by it. Up to 1.40.0 an
 * id was fetched under the entity's identifier, so one whose identifier is another field than its
 * key failed `put` (`get.decode`, `Missing key`), and a cascade from it updated nothing.
 *
 * `fixtures/entity-ref-keys-1.39.0.json` holds what published 1.39.0 sent, stored and returned for
 * each shape on DynamoDB Local (1.40.0 is the same): Teams seeded, a Player put with `teamId`, the
 * team updated with a cascade to Players. One suite, run on a recording table
 * (`EntityRefKeys.test.ts`) and against DynamoDB Local (`connected.entity-ref-keys.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"

type Row = Record<string, AttributeValue>
type Sent = { readonly command: string; readonly input: unknown }
type Outcome = {
  readonly ok?: unknown
  readonly failed?: string
  readonly operation?: string
  readonly cause?: string
}
type Recorded = {
  readonly put: Outcome
  readonly putRequests: ReadonlyArray<Sent>
  readonly rows: ReadonlyArray<Row>
  readonly cascade: Outcome
  readonly cascadeRequests: ReadonlyArray<Sent>
  readonly cascadeRows: ReadonlyArray<Row>
}

const published = JSON.parse(
  readFileSync(new URL("../fixtures/entity-ref-keys-1.39.0.json", import.meta.url), "utf8"),
) as { readonly generatedFrom: string; readonly shapes: Record<string, Recorded> }

/** The secondary indexes every table here has. */
export const INDEXES = {
  gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
  gsi2: { pk: "gsi2pk", sk: "gsi2sk" },
} as const

const schema = DynamoSchema.make({ name: "refs", version: 1 })
const one = (composite: ReadonlyArray<string>) => ({
  pk: { field: "pk", composite: [...composite] },
  sk: { field: "sk", composite: [] as Array<string> },
})

/** Each referenced entity, as the fixture's generator declared it. */
const shapes = {
  "identifier is the key": () => {
    class Team extends Schema.Class<Team>("Team")({
      id: Schema.String.pipe(DynamoModel.identifier),
      name: Schema.String,
    }) {}
    return {
      Team,
      primaryKey: one(["id"]),
      seed: { id: "t1", name: "Tigers" },
      teamId: "t1" as unknown,
      key: { id: "t1" } as Record<string, unknown>,
    }
  },
  "identifier is the key, a number": () => {
    class Team extends Schema.Class<Team>("Team")({
      num: Schema.Number.pipe(DynamoModel.identifier),
      name: Schema.String,
    }) {}
    return {
      Team,
      primaryKey: one(["num"]),
      seed: { num: 5, name: "Tigers" },
      teamId: 5 as unknown,
      key: { num: 5 } as Record<string, unknown>,
    }
  },
  "identifier is another field": () => {
    class Team extends Schema.Class<Team>("Team")({
      code: Schema.String.pipe(DynamoModel.identifier),
      id: Schema.String,
      name: Schema.String,
    }) {}
    return {
      Team,
      primaryKey: one(["id"]),
      seed: { code: "TIG", id: "t1", name: "Tigers" },
      teamId: "t1" as unknown,
      key: { id: "t1" } as Record<string, unknown>,
    }
  },
  "identifier is another field, keyed by a number": () => {
    class Team extends Schema.Class<Team>("Team")({
      code: Schema.String.pipe(DynamoModel.identifier),
      num: Schema.Number,
      name: Schema.String,
    }) {}
    return {
      Team,
      primaryKey: one(["num"]),
      seed: { code: "TIG", num: 5, name: "Tigers" },
      teamId: 5 as unknown,
      key: { num: 5 } as Record<string, unknown>,
    }
  },
  "keyed by two composites": () => {
    class Team extends Schema.Class<Team>("Team")({
      org: Schema.String,
      code: Schema.String.pipe(DynamoModel.identifier),
      name: Schema.String,
    }) {}
    return {
      Team,
      primaryKey: {
        pk: { field: "pk", composite: ["org"] },
        sk: { field: "sk", composite: ["code"] },
      },
      seed: { org: "o", code: "TIG", name: "Tigers" },
      teamId: "TIG" as unknown,
      key: { org: "o", code: "TIG" } as Record<string, unknown>,
    }
  },
} as const

type Label = keyof typeof shapes

const define = (label: Label) => {
  const shape = shapes[label]()
  const Teams = Entity.make({
    model: shape.Team as Schema.Top,
    entityType: "Team",
    primaryKey: shape.primaryKey,
  } as never) as any
  class Player extends Schema.Class<Player>("Player")({
    id: Schema.String,
    league: Schema.String,
    team: (shape.Team as Schema.Top).pipe(DynamoModel.ref),
  }) {}
  const Players = Entity.make({
    model: Player,
    entityType: "Player",
    primaryKey: one(["id"]),
    indexes: {
      byLeague: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["league"] },
        sk: { field: "gsi2sk", composite: ["id", "teamId"] },
      },
    },
    refs: {
      team: {
        entity: Teams,
        cascade: { index: "gsi1", pk: { field: "gsi1pk" }, sk: { field: "gsi1sk" } },
      },
    },
  } as never) as any
  const Main = Table.make({ schema, entities: { Teams, Players } } as never) as any
  return { ...shape, Teams, Players, Main }
}

export interface Harness {
  /** Run `body` on a fresh, empty table (with {@link INDEXES}) named `tableName`. */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
  /** Every row of the table. */
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The requests sent since the last call: commands and inputs, the table name as `<table>`. */
  readonly requests: (tableName: string) => Effect.Effect<ReadonlyArray<Sent>>
  /** Provide the table's layer to `effect`. */
  readonly provide: <A, E>(
    tableName: string,
    main: any,
    effect: Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, E>
}

const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`
const sorted = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

const outcome = <A, E>(exit: Exit.Exit<A, E>): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (failure === undefined) throw new Error(`died: ${String(exit.cause)}`)
  const error = (failure as unknown as { readonly error: any }).error
  return {
    failed: error._tag,
    operation: error.operation,
    cause: String(error.cause?.message ?? error.cause ?? error.message),
  }
}

type Ran = {
  readonly recorded: Recorded
  readonly db: any
  readonly run: <A, E>(effect: Effect.Effect<A, E, any>) => Effect.Effect<A, E>
  readonly tableName: string
}

/**
 * Seed the team, put the player, update the team with a cascade: each step recorded. `then` runs
 * on the same table after them.
 */
const runShape = <B = Ran>(
  harness: Harness,
  label: Label,
  then: (ran: Ran) => Effect.Effect<B, unknown> = (ran) => Effect.succeed(ran as B),
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      const shape = define(label)
      const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
        harness.provide(tableName, shape.Main, effect)
      const db: any = yield* run(
        DynamoClient.make({
          entities: { Teams: shape.Teams, Players: shape.Players },
          tables: { Main: shape.Main },
        } as never),
      )
      yield* run(db.entities.Teams.put(shape.seed).asEffect())
      yield* harness.requests(tableName)
      const put = outcome(
        yield* Effect.exit(
          run(db.entities.Players.put({ id: "p1", league: "l", teamId: shape.teamId }).asEffect()),
        ),
      )
      const putRequests = yield* harness.requests(tableName)
      const rows = sorted(yield* harness.rows(tableName))
      const cascade = outcome(
        yield* Effect.exit(
          run(
            db.entities.Teams.update(shape.key)
              .set({ name: "Lions" })
              .cascade({ targets: [shape.Players] })
              .asEffect(),
          ),
        ),
      )
      const cascadeRequests = yield* harness.requests(tableName)
      const cascadeRows = sorted(yield* harness.rows(tableName))
      return yield* then({
        recorded: { put, putRequests, rows, cascade, cascadeRequests, cascadeRows } as Recorded,
        db,
        run,
        tableName,
      })
    }),
  )

/**
 * `value` (requests, rows or a result of "identifier is the key") with the team's `code: TIG` too:
 * on the Team row, in each stored or sent `team` (and a cascade's `:refData`), and in a returned
 * `team`. Nothing else differs between the two shapes.
 */
const withCode = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withCode)
  if (typeof value !== "object" || value === null) return value
  const out: Record<string, unknown> = {}
  const record = value as Record<string, any>
  if (record.__edd_e__?.S === "Team") out.code = { S: "TIG" }
  for (const [key, inner] of Object.entries(record)) {
    out[key] =
      (key === "team" || key === ":refData") && inner?.M !== undefined
        ? { M: { code: { S: "TIG" }, ...(withCode(inner.M) as object) } }
        : key === "team" && typeof inner === "object" && inner !== null
          ? { code: "TIG", ...(withCode(inner) as object) }
          : withCode(inner)
  }
  return out
}

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("an entity-level ref names its entity's key composite", () => {
    it("the fixture is published 1.39.0's, and holds every shape", () => {
      expect(published.generatedFrom).toBe("effect-dynamodb@1.39.0")
      expect(Object.keys(published.shapes).sort()).toEqual(Object.keys(shapes).sort())
    })

    it("an entity whose identifier is its key: put and cascade are 1.39.0's, byte for byte", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { recorded } = yield* runShape(harness, "identifier is the key")
          expect(recorded).toEqual(published.shapes["identifier is the key"])
        }),
      ))

    it("a number key: put as on 1.39.0, and the cascade reads the partition put wrote", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const before = published.shapes["identifier is the key, a number"]!
          const { recorded } = yield* runShape(harness, "identifier is the key, a number")
          expect(recorded.put).toEqual(before.put)
          expect(recorded.putRequests).toEqual(before.putRequests)
          expect(recorded.rows).toEqual(before.rows)
          const player = recorded.rows.find((row) => row.__edd_e__?.S === "Player")!
          expect(player.gsi1pk).toEqual({ S: "$refs#v1#player#teamid_0000000000000005" })
          // 1.39.0 queried `teamid_5`, the text of `"5"`, which no put of 5 writes, and left the
          // player's team as it was. The cascade now queries the partition put wrote.
          expect(before.cascadeRequests.map((request) => request.command)).toEqual([
            "UpdateItem",
            "Query",
          ])
          expect(
            (before.cascadeRequests[1]!.input as any).ExpressionAttributeValues[":pk"],
          ).toEqual({ S: "$refs#v1#player#teamid_5" })
          expect(recorded.cascadeRequests[0]).toEqual(before.cascadeRequests[0])
          expect(recorded.cascadeRequests[1]).toEqual({
            ...before.cascadeRequests[1],
            input: {
              ...(before.cascadeRequests[1]!.input as object),
              ExpressionAttributeValues: {
                ...(before.cascadeRequests[1]!.input as any).ExpressionAttributeValues,
                ":pk": player.gsi1pk,
              },
            },
          })
          expect(recorded.cascadeRequests.map((request) => request.command)).toEqual([
            "UpdateItem",
            "Query",
            "UpdateItem",
          ])
          const after = recorded.cascadeRows.find((row) => row.__edd_e__?.S === "Player")!
          expect(after.team).toEqual({ M: { num: { N: "5" }, name: { S: "Lions" } } })
        }),
      ))

    it("an identifier other than the key: fetched and cascaded under the key", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const before = published.shapes["identifier is another field"]!
          expect(before.put.failed).toBe("ValidationError")
          expect(before.put.operation).toBe("get.decode")
          expect(before.cascadeRequests.map((request) => request.command)).toEqual(["UpdateItem"])
          const { recorded } = yield* runShape(harness, "identifier is another field")
          // What an entity whose identifier is its key sends and stores, the referenced
          // entity's own `code` beside its key: the GetItem under `id`, the PutItem keyed
          // `teamid_t1`, then the cascade's Query of that partition and its UpdateItem.
          const keyed = published.shapes["identifier is the key"]!
          expect(recorded.put).toEqual(withCode(keyed.put))
          expect(recorded.putRequests).toEqual(withCode(keyed.putRequests))
          expect(recorded.rows).toEqual(sorted(withCode(keyed.rows) as ReadonlyArray<Row>))
          expect(recorded.cascade).toEqual({ ok: { code: "TIG", id: "t1", name: "Lions" } })
          expect(recorded.cascadeRequests).toEqual(withCode(keyed.cascadeRequests))
          expect(recorded.cascadeRows).toEqual(
            sorted(withCode(keyed.cascadeRows) as ReadonlyArray<Row>),
          )
        }),
      ))

    it("an identifier other than a number key: the id is a number, fetched under the key", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const before = published.shapes["identifier is another field, keyed by a number"]!
          expect(before.put).toMatchObject({ failed: "ValidationError", operation: "put.decode" })
          const { recorded } = yield* runShape(
            harness,
            "identifier is another field, keyed by a number",
          )
          const team = { code: "TIG", num: 5, name: "Tigers" }
          expect(recorded.put).toEqual({ ok: { id: "p1", league: "l", team } })
          expect(recorded.putRequests.map((request) => request.command)).toEqual([
            "GetItem",
            "PutItem",
          ])
          const seeded = before.rows.find((row) => row.__edd_e__?.S === "Team")!
          expect((recorded.putRequests[0]!.input as any).Key).toEqual({
            pk: seeded.pk,
            sk: seeded.sk,
          })
          const player = recorded.rows.find((row) => row.__edd_e__?.S === "Player")!
          expect(player.team).toEqual({
            M: { code: { S: "TIG" }, num: { N: "5" }, name: { S: "Tigers" } },
          })
          expect(player.gsi1pk).toEqual({ S: "$refs#v1#player#teamid_0000000000000005" })
          expect(recorded.cascadeRequests.map((request) => request.command)).toEqual([
            "UpdateItem",
            "Query",
            "UpdateItem",
          ])
          const after = recorded.cascadeRows.find((row) => row.__edd_e__?.S === "Player")!
          expect(after.team).toEqual({
            M: { code: { S: "TIG" }, num: { N: "5" }, name: { S: "Lions" } },
          })
        }),
      ))

    it("an entity keyed by two composites: refused before anything is fetched, cascade as on 1.39.0", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const before = published.shapes["keyed by two composites"]!
          expect(before.put).toMatchObject({ failed: "ValidationError", operation: "get.decode" })
          const { recorded } = yield* runShape(harness, "keyed by two composites")
          expect(recorded.put.failed).toBe("ValidationError")
          expect(recorded.put.operation).toBe("hydrateRefs")
          expect(recorded.put.cause).toContain("[EDD-9158]")
          expect(recorded.putRequests).toEqual(before.putRequests)
          expect(recorded.rows).toEqual(before.rows)
          expect(recorded.cascade).toEqual(before.cascade)
          expect(recorded.cascadeRequests).toEqual(before.cascadeRequests)
          expect(recorded.cascadeRows).toEqual(before.cascadeRows)
        }),
      ))

    it("a .within() row check reads the stored ref's key composite", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const found = yield* runShape(harness, "identifier is another field", ({ db, run }) => {
            const within = (teamId: string) =>
              run(
                db.entities.Players.byLeague({ league: "l" })
                  .within({ teamId: { eq: teamId } }, { maxSkips: 0 })
                  .collect(),
              ) as Effect.Effect<ReadonlyArray<{ readonly id: string }>>
            return Effect.all([within("t1"), within("TIG")])
          })
          expect(found[0].map((player) => player.id)).toEqual(["p1"])
          expect(found[1]).toEqual([])
        }),
      ))

    it("rekey reads a ref's id back from its key composite, and leaves the row", () =>
      Effect.runPromise(
        harness.onTable((tableName) =>
          Effect.gen(function* () {
            // The rows a put writes (the team, and the player keyed `teamid_t1` holding the team
            // whole), written directly: read back under the identifier, the player's id is `TIG`.
            const stored = sorted(
              withCode(published.shapes["identifier is the key"]!.rows) as ReadonlyArray<Row>,
            )
            const shape = define("identifier is another field")
            const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
              harness.provide(tableName, shape.Main, effect)
            yield* run(
              Effect.gen(function* () {
                const client = yield* DynamoClient
                for (const Item of stored) yield* client.putItem({ TableName: tableName, Item })
              }),
            )
            const db: any = yield* run(
              DynamoClient.make({
                entities: { Teams: shape.Teams, Players: shape.Players },
                tables: { Main: shape.Main },
              } as never),
            )
            const report = (yield* run(db.tables.Main.rekey({ repairIndexKeys: true }))) as any
            expect(report.conflicts).toEqual([])
            expect(report.indexKeysRewritten).toBe(0)
            expect(Object.values(report.indexKeys).every((count) => count === 0)).toBe(true)
            expect(sorted(yield* harness.rows(tableName))).toEqual(stored)
          }),
        ),
      ))
  })
