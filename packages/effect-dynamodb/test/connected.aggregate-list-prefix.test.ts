/**
 * `Aggregate.list`'s `prefix` option (#264), against DynamoDB Local: the issue's fixtures listed
 * through `sk: [league, name]`. Without the option every call returns what 1.41.0 returned; with
 * it, the last composite given is matched as a prefix, as 1.36 matched every list key, and the
 * list pages with its own cursor.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
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

const schema = DynamoSchema.make({ name: "listprefix", version: 1 })
const tableName = `list-prefix-test-${Date.now()}`

class Fixture extends Schema.Class<Fixture>("Fixture")({
  id: Schema.String,
  league: Schema.String,
  name: Schema.String,
}) {}

class Tag extends Schema.Class<Tag>("Tag")({ id: Schema.String }) {}

const Tags = Entity.make({
  model: Tag,
  entityType: "Tag",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})

const MainTable = Table.make({ schema, entities: { Tags } })

const Fixtures = Aggregate.make(Fixture, {
  table: MainTable,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "fixture" },
  list: {
    index: "gsi1",
    name: "fixtureList",
    pk: { field: "gsi1pk", composite: [] },
    sk: { field: "gsi1sk", composite: ["league", "name"] },
  },
  root: { entityType: "FixtureItem" },
  edges: {},
})

const provide = Effect.provide(
  Layer.mergeAll(
    DynamoClient.layer({
      region: "us-east-1",
      endpoint: ENDPOINT,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
    MainTable.layer({ name: tableName }),
  ),
)

const gateway = DynamoClient.make({
  entities: { Tags },
  aggregates: { Fixtures },
  tables: { MainTable },
})

const LEAGUES = [
  ["f1", "Big", "Final"],
  ["f2", "Big Bash", "Final"],
  ["f3", "Big Bash", "Finals Day"],
  ["f4", "Big Bash League", "Final"],
] as const

const listed = (key: Record<string, string>, options?: Aggregate.ListOptions<Fixture>) =>
  Effect.gen(function* () {
    const db = yield* gateway
    const page = yield* db.aggregates.Fixtures.list(key, { limit: 50, ...options })
    return page.data.map((fixture) => fixture.id).sort()
  })

describeConnected("Aggregate.list prefix (#264)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* gateway
        yield* db.tables.MainTable.create()
        for (const [id, league, name] of LEAGUES) {
          yield* db.aggregates.Fixtures.create({ id, league, name })
        }
      }).pipe(provide),
    )
  }, 60000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect("without `prefix`, each value is matched whole, as in 1.41.0", () =>
    Effect.gen(function* () {
      expect(yield* listed({ league: "big" })).toEqual(["f1"])
      expect(yield* listed({ league: "Big Bash" })).toEqual(["f2", "f3"])
      expect(yield* listed({ league: "Big Bash", name: "fin" })).toEqual([])
      expect(yield* listed({ league: "Big Bash", name: "Final" })).toEqual(["f2"])
    }).pipe(provide),
  )

  it.effect("with `prefix`, the last value given is a prefix, as in 1.36", () =>
    Effect.gen(function* () {
      const prefix = { prefix: true }
      expect(yield* listed({ league: "big" }, prefix)).toEqual(["f1", "f2", "f3", "f4"])
      expect(yield* listed({ league: "Big Bash" }, prefix)).toEqual(["f2", "f3", "f4"])
      expect(yield* listed({ league: "Big Bash", name: "fin" }, prefix)).toEqual(["f2", "f3"])
      expect(yield* listed({ league: "Big Bash", name: "Final" }, prefix)).toEqual(["f2", "f3"])
      expect(yield* listed({ league: "BIG BASH L" }, prefix)).toEqual(["f4"])
    }).pipe(provide),
  )

  it.effect("a prefix list pages with its own cursor", () =>
    Effect.gen(function* () {
      const db = yield* gateway
      const walked: Array<string> = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        const result: Aggregate.ListResult<Fixture> = yield* db.aggregates.Fixtures.list(
          { league: "big" },
          { prefix: true, limit: 1, ...(cursor === undefined ? {} : { cursor }) },
        )
        walked.push(...result.data.map((fixture) => fixture.id))
        if (Option.isNone(result.cursor)) break
        cursor = result.cursor.value
      }
      const all = yield* db.aggregates.Fixtures.list({ league: "big" }, { prefix: true })
      expect(walked).toEqual(all.data.map((fixture) => fixture.id))
      expect([...walked].sort()).toEqual(["f1", "f2", "f3", "f4"])
    }).pipe(provide),
  )
})
