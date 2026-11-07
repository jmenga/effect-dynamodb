/**
 * `Aggregate.list`'s cursor (#197), against DynamoDB Local: paging through keys that hold text
 * above U+00FF, the bytes of a cursor over a key `btoa` can carry, old cursors resuming, and the
 * refusal of a cursor that can't be decoded.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Cursor from "../src/internal/Cursor.js"
import * as Table from "../src/Table.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const schema = DynamoSchema.make({ name: "listcursor", version: 1 })
const tableName = `list-cursor-test-${Date.now()}`

class Line extends Schema.Class<Line>("Line")({
  id: Schema.String,
  sku: Schema.String,
}) {}

class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  tournament: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["open", "done"]),
  lines: Schema.Array(Line),
}) {}

class Anchor extends Schema.Class<Anchor>("Anchor")({ anchorId: Schema.String }) {}

const Anchors = Entity.make({
  model: Anchor,
  entityType: "Anchor",
  primaryKey: { pk: { field: "pk", composite: ["anchorId"] }, sk: { field: "sk", composite: [] } },
})

const MainTable = Table.make({ schema, entities: { Anchors } })

const Matches = Aggregate.make(Match, {
  table: MainTable,
  schema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "match" },
  list: {
    index: "gsi1",
    name: "matchlist",
    pk: { field: "gsi1pk", composite: ["tournament"] },
    sk: { field: "gsi1sk", composite: ["name"] },
  },
  root: { entityType: "MatchItem" },
  edges: { lines: Aggregate.many({ entityType: "MatchLine" }) },
})

const ShardedMatches = Aggregate.make(Match, {
  table: MainTable,
  schema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "shardedmatch" },
  list: {
    index: "gsi1",
    name: "shardedmatchlist",
    pk: { field: "gsi1pk", composite: ["tournament"] },
    sk: { field: "gsi1sk", composite: ["name"] },
    cardinality: 3,
  },
  root: { entityType: "ShardedMatchItem" },
  edges: { lines: Aggregate.many({ entityType: "ShardedMatchLine" }) },
})

/** Every `query` since the last reset, and the `LastEvaluatedKey` of each read of the list index. */
const log = {
  requests: 0,
  lastKeys: [] as Array<Record<string, AttributeValue> | undefined>,
}

const loggingClient = (client: DynamoClientService): DynamoClientService => ({
  ...client,
  query: (input) => {
    log.requests++
    return client.query(input).pipe(
      Effect.tap((output) =>
        Effect.sync(() => {
          if (input.IndexName === "gsi1") {
            log.lastKeys.push(output.LastEvaluatedKey as Record<string, AttributeValue> | undefined)
          }
        }),
      ),
    )
  },
})

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const LoggedClient = Layer.effect(
  DynamoClient,
  Effect.map(DynamoClient, (client) => loggingClient(client)),
).pipe(Layer.provide(ClientLayer))

const provide = Effect.provide(Layer.mergeAll(LoggedClient, MainTable.layer({ name: tableName })))

const gateway = DynamoClient.make({
  aggregates: { Matches, ShardedMatches },
  entities: { Anchors },
  tables: { MainTable },
})

const match = (
  tournament: string,
  matchId: string,
  name: string,
  status: "open" | "done" = "open",
) => ({
  lines: [{ id: `${matchId}-l1`, sku: "sku" }],
  matchId,
  name,
  status,
  tournament,
})

/** The list index holds these in this order. */
const T1 = [
  match("t1", "m1", "Alpha Cup"),
  match("t1", "m2", "Caf\u00E9 Cup", "done"),
  match("t1", "m3", "Men\u2019s Final", "done"),
  match("t1", "m4", "Mixed Doubles"),
  match("t1", "m5", "Semi \u{1F3CF}"),
  match("t1", "m6", "Women\u2019s Final", "done"),
  match("t1", "m7", "Zulu Cup", "done"),
]
const T1_IDS = T1.map((row) => row.matchId)
const T1_DONE = T1.filter((row) => row.status === "done").map((row) => row.matchId)

/** Every key's list partition holds U+2019. */
const PROS = "Pro\u2019s Cup"
const T_PROS = [match(PROS, "p1", "One"), match(PROS, "p2", "Two"), match(PROS, "p3", "Three")]

/** Every key's table partition holds U+2019, and no list key does. */
const T_TABLE = [
  match("t3", "x\u20191", "One"),
  match("t3", "x\u20192", "Three"),
  match("t3", "x\u20193", "Two"),
]

/** The same rows on a sharded list. */
const T_SHARDED = T1.map((row) => ({ ...row, matchId: `s-${row.matchId}`, tournament: "s1" }))

const V2_CURSOR = /^v2\.[A-Za-z0-9_-]+$/

describeConnected("Aggregate.list cursor (#197)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* gateway
        yield* db.tables.MainTable.create()
        for (const row of [...T1, ...T_PROS, ...T_TABLE]) {
          yield* db.aggregates.Matches.create(row as never)
        }
        for (const row of T_SHARDED) {
          yield* db.aggregates.ShardedMatches.create(row as never)
        }
      }).pipe(provide, Effect.scoped),
    )
  }, 60000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  beforeEach(() => {
    log.requests = 0
    log.lastKeys.length = 0
  })

  /** Every page of a list: what it returned, and each cursor it handed back. */
  const walk = (options: Aggregate.ListOptions<Match>, tournament = "t1") =>
    Effect.gen(function* () {
      const db = yield* gateway
      const ids: Array<string> = []
      const cursors: Array<string> = []
      let cursor: string | undefined
      for (let page = 0; page < 40; page++) {
        const result: Aggregate.ListResult<Match> = yield* db.aggregates.Matches.list(
          { tournament },
          cursor === undefined ? options : { ...options, cursor },
        )
        ids.push(...result.data.map((row) => row.matchId))
        if (Option.isNone(result.cursor)) return { cursors, ids }
        cursor = result.cursor.value
        cursors.push(cursor)
      }
      return yield* Effect.die("the list never ended")
    })

  for (const limit of [1, 2, 3, 6, 7, 100]) {
    it.effect(`pages through keys holding U+2019 and U+1F3CF to the end, limit ${limit}`, () =>
      Effect.gen(function* () {
        const { ids } = yield* walk({ limit })
        expect(ids).toEqual(T1_IDS)
      }).pipe(provide),
    )
  }

  it.effect("a page size smaller than the page takes the same path", () =>
    Effect.gen(function* () {
      const { ids } = yield* walk({ limit: 2, pageSize: 1 })
      expect(ids).toEqual(T1_IDS)
    }).pipe(provide),
  )

  it.effect("a list partition holding U+2019 pages to the end", () =>
    Effect.gen(function* () {
      const { cursors, ids } = yield* walk({ limit: 1 }, PROS)

      expect(ids).toEqual(["p1", "p3", "p2"])
      for (const cursor of cursors) expect(cursor).toMatch(V2_CURSOR)
    }).pipe(provide),
  )

  it.effect("a table partition holding U+2019 pages to the end", () =>
    Effect.gen(function* () {
      const { cursors, ids } = yield* walk({ limit: 1 }, "t3")

      expect(ids).toEqual(T_TABLE.map((row) => row.matchId))
      for (const cursor of cursors) expect(cursor).toMatch(V2_CURSOR)
    }).pipe(provide),
  )

  it.effect("each cursor is the legacy bytes when btoa can carry the key, and v2 otherwise", () =>
    Effect.gen(function* () {
      const { cursors } = yield* walk({ limit: 1 })

      // m3 and m6 hold U+2019, m5 holds U+1F3CF, and m2's U+00E9 is one `btoa` takes.
      const notCarried = new Set(["m3", "m5", "m6"])
      for (const [page, row] of T1.entries()) {
        const key = log.lastKeys[page]!
        if (notCarried.has(row.matchId)) expect(cursors[page]).toMatch(V2_CURSOR)
        else expect(cursors[page]).toBe(btoa(JSON.stringify(key)))
        expect(cursors[page]).toBe(Cursor.encodeKeyCursor(key))
      }
    }).pipe(provide),
  )

  it.effect("a cursor from the old form resumes, in ASCII and in Latin-1", () =>
    Effect.gen(function* () {
      const db = yield* gateway

      yield* db.aggregates.Matches.list({ tournament: "t1" }, { limit: 2 })
      const latin1 = log.lastKeys[0]!
      expect(latin1.gsi1sk?.S).toContain("caf\u00E9")
      const fromLatin1 = yield* db.aggregates.Matches.list(
        { tournament: "t1" },
        { cursor: btoa(JSON.stringify(latin1)) },
      )
      expect(fromLatin1.data.map((row) => row.matchId)).toEqual(T1_IDS.slice(2))

      log.lastKeys.length = 0
      yield* db.aggregates.Matches.list({ tournament: "t1" }, { limit: 1 })
      const ascii = log.lastKeys[0]!
      const fromAscii = yield* db.aggregates.Matches.list(
        { tournament: "t1" },
        { cursor: btoa(JSON.stringify(ascii)) },
      )
      expect(fromAscii.data.map((row) => row.matchId)).toEqual(T1_IDS.slice(1))
    }).pipe(provide),
  )

  for (const [label, cursor] of [
    ["malformed base64", "%%% not base64 %%%"],
    ["base64 of something that isn't JSON", btoa("not json")],
    ["base64 of JSON of the wrong shape", btoa('{"pk":"x"}')],
    ["base64 of a JSON array", btoa("[1,2]")],
    ["a v2 cursor of something that isn't JSON", "v2.bm90IGpzb24"],
    ["an empty string", ""],
  ] as const) {
    it.effect(`${label} is a ValidationError carrying EDD-9094, with nothing sent`, () =>
      Effect.gen(function* () {
        const db = yield* gateway

        const error: any = yield* Effect.flip(
          db.aggregates.Matches.list({ tournament: "t1" }, { cursor }),
        )

        expect(error._tag).toBe("ValidationError")
        expect(error.operation).toBe("list")
        expect(String(error.cause)).toContain("[EDD-9094]")
        expect(log.requests).toBe(0)
      }).pipe(provide),
    )
  }

  it.effect("a well-formed key that isn't the list's is DynamoDB's to refuse", () =>
    Effect.gen(function* () {
      const db = yield* gateway

      const error: any = yield* Effect.flip(
        db.aggregates.Matches.list(
          { tournament: "t1" },
          { cursor: btoa(JSON.stringify({ nope: { S: "x" } })) },
        ),
      )

      expect(error._tag).toBe("DynamoValidationError")
    }).pipe(provide),
  )

  describe("a filtered list", () => {
    it.effect("an over-read page rebuilds a cursor holding U+2019, and nothing is skipped", () =>
      Effect.gen(function* () {
        // No page size: one request reads the whole range and returns every match, of which
        // one is kept, with no `LastEvaluatedKey` to fall back on.
        const { cursors, ids } = yield* walk({ filter: { status: "done" }, limit: 1 })

        expect(ids).toEqual(T1_DONE)
        expect(log.lastKeys.every((key) => key === undefined)).toBe(true)
        // After m2 (Latin-1) the legacy form; after m3 and m6 (U+2019) v2.
        expect(cursors[0]?.startsWith("v2.")).toBe(false)
        expect(cursors[1]).toMatch(V2_CURSOR)
        expect(cursors[2]).toMatch(V2_CURSOR)
      }).pipe(provide),
    )

    for (const pageSize of [1, 2, 3]) {
      it.effect(`a request of ${pageSize} row(s) at a time reaches every match`, () =>
        Effect.gen(function* () {
          const { ids } = yield* walk({ filter: { status: "done" }, limit: 1, pageSize })
          expect(ids).toEqual(T1_DONE)
        }).pipe(provide),
      )
    }

    it.effect("a page of two, its last row holding U+2019", () =>
      Effect.gen(function* () {
        const { cursors, ids } = yield* walk({ filter: { status: "done" }, limit: 2 })

        expect(ids).toEqual(T1_DONE)
        // m2 and m3 fill the first page: it ends on U+2019.
        expect(cursors[0]).toMatch(V2_CURSOR)
      }).pipe(provide),
    )

    it.effect("the callback form", () =>
      Effect.gen(function* () {
        const { ids } = yield* walk({ filter: (t, { eq }) => eq(t.status, "done"), limit: 1 })
        expect(ids).toEqual(T1_DONE)
      }).pipe(provide),
    )

    it.effect("a client-side predicate's cursor lands on the last row accepted", () =>
      Effect.gen(function* () {
        const { cursors, ids } = yield* walk({
          filterBy: (root) => root.status === "done",
          limit: 1,
        })

        expect(ids).toEqual(T1_DONE)
        expect(cursors[1]).toMatch(V2_CURSOR)
      }).pipe(provide),
    )
  })

  describe("reverse", () => {
    for (const limit of [1, 2, 3, 100]) {
      it.effect(`pages down through keys holding U+2019 and U+1F3CF, limit ${limit}`, () =>
        Effect.gen(function* () {
          const { ids } = yield* walk({ limit, reverse: true })
          expect(ids).toEqual([...T1_IDS].reverse())
        }).pipe(provide),
      )
    }

    it.effect("an over-read page rebuilds its cursor, going down", () =>
      Effect.gen(function* () {
        const { cursors, ids } = yield* walk({
          filter: { status: "done" },
          limit: 1,
          reverse: true,
        })

        expect(ids).toEqual([...T1_DONE].reverse())
        // m7, then m6: the second page ends on U+2019.
        expect(cursors[1]).toMatch(V2_CURSOR)
      }).pipe(provide),
    )

    it.effect("a request of one row at a time, under a filter, going down", () =>
      Effect.gen(function* () {
        const { ids } = yield* walk({
          filter: { status: "done" },
          limit: 1,
          pageSize: 1,
          reverse: true,
        })
        expect(ids).toEqual([...T1_DONE].reverse())
      }).pipe(provide),
    )
  })

  describe("a sharded list", () => {
    for (const [label, cursor] of [
      ["malformed base64", "%%% not base64 %%%"],
      ["a v2 cursor", "v2.bm90IGpzb24"],
      ["an empty string", ""],
    ] as const) {
      it.effect(`${label} is still refused with EDD-9051, with nothing sent`, () =>
        Effect.gen(function* () {
          const db = yield* gateway

          const error: any = yield* Effect.flip(
            db.aggregates.ShardedMatches.list({ tournament: "s1" }, { cursor }),
          )

          expect(error._tag).toBe("ValidationError")
          expect(String(error.cause)).toContain("[EDD-9051]")
          expect(String(error.cause)).not.toContain("EDD-9094")
          expect(log.requests).toBe(0)
        }).pipe(provide),
      )
    }

    it.effect("a list over keys holding U+2019 reads every row and hands back no cursor", () =>
      Effect.gen(function* () {
        const db = yield* gateway

        const page = yield* db.aggregates.ShardedMatches.list({ tournament: "s1" })

        expect(page.data).toHaveLength(T_SHARDED.length)
        expect(page.cursor).toEqual(Option.none())
      }).pipe(provide),
    )
  })
})
