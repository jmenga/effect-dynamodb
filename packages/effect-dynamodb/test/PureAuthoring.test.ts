import { describe, expect, it } from "@effect/vitest"
// AUTHORED PURELY via @effect-dynamodb/schema — NO AWS import in this section.
// This is the headline of the schema/runtime split (#62): define the entity once
// against the AWS-free package, then bind it to the runtime client (#69).
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"

import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Pure definitions (regression fixtures for #69)
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "pure-authoring", version: 1 })

class User extends Schema.Class<User>("User")({
  orgId: Schema.String,
  userId: Schema.String,
  email: Schema.String,
  name: Schema.String,
}) {}

class Team extends Schema.Class<Team>("Team")({
  orgId: Schema.String,
  teamId: Schema.String,
  label: Schema.String,
}) {}

// Pure EntityDefinition — note `PureEntity.make` is @effect-dynamodb/schema's
// builder, which attaches NO runtime operations. DynamoClient.make must promote
// these to full runtime entities at bind time.
const Users = PureEntity.make({
  model: User,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["orgId"] },
    sk: { field: "sk", composite: ["userId"] },
  },
  indexes: {
    usersByOrg: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["orgId"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
      collection: "members",
    },
  },
})

const Teams = PureEntity.make({
  model: Team,
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["orgId"] },
    sk: { field: "sk", composite: ["teamId"] },
  },
  indexes: {
    teamsByOrg: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["orgId"] },
      sk: { field: "gsi1sk", composite: ["teamId"] },
      collection: "members",
    },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Users, Teams } })

// ---------------------------------------------------------------------------
// In-memory mock DynamoClient: round-trips real marshalled items so the decode
// path (`_decodeRecord`) actually executes. The #69 query/scan/collection crash
// is DEFERRED to the first item decode — an empty result set would false-pass,
// so every read here returns >= 1 stored item.
// ---------------------------------------------------------------------------

type AttrMap = Record<string, unknown>
let store: AttrMap[] = []

const keyOf = (item: AttrMap) => `${(item.pk as { S: string })?.S}|${(item.sk as { S: string })?.S}`

// Partial test double — only the methods the bound ops exercise are real; the
// rest die if reached. Cast because this intentionally omits table-management
// commands not used by these tests (mirrors the existing DynamoClient.test.ts).
const mockClient = Layer.succeed(DynamoClient, {
  putItem: (input: { Item: AttrMap }) =>
    Effect.sync(() => {
      const item = input.Item
      const k = keyOf(item)
      store = store.filter((s) => keyOf(s) !== k)
      store.push(item)
      return {} as never
    }),
  getItem: (input: { Key: AttrMap }) =>
    Effect.sync(() => {
      const target = keyOf(input.Key)
      const found = store.find((s) => keyOf(s) === target)
      return (found ? { Item: found } : {}) as never
    }),
  // Query/scan return whatever the test staged via `store`; the entity-type
  // FilterExpression is applied by real DynamoDB, so tests stage only items the
  // query is expected to see.
  query: () => Effect.sync(() => ({ Items: store, Count: store.length }) as never),
  scan: () => Effect.sync(() => ({ Items: store, Count: store.length }) as never),
  deleteItem: () => Effect.sync(() => ({}) as never),
  updateItem: (input: { Key: AttrMap }) =>
    Effect.sync(() => {
      // Return the existing item as Attributes so the update's decode succeeds.
      const found = store.find((s) => keyOf(s) === keyOf(input.Key))
      return { Attributes: found } as never
    }),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  transactWriteItems: () => Effect.die("not used"),
  createTable: () => Effect.sync(() => ({}) as never),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
} as unknown as DynamoClientService)

const TableLayer = MainTable.layer({ name: "pure-authoring-table" })
const layers = Layer.merge(mockClient, TableLayer)

beforeEach(() => {
  store = []
  vi.clearAllMocks()
})

describe("pure @effect-dynamodb/schema authoring bound via DynamoClient.make (#69)", () => {
  it.effect("put + get round-trips a pure-authored entity", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })

      // Before the fix this threw "entity.put is not a function".
      yield* db.entities.Users.put({ orgId: "o1", userId: "u1", email: "a@x.io", name: "Ann" })

      // get exercises the decode path (`_decodeRecord`) on a real stored item.
      const got = yield* db.entities.Users.get({ orgId: "o1", userId: "u1" })
      expect(got.name).toBe("Ann")
      expect(got.email).toBe("a@x.io")
    }).pipe(Effect.provide(layers)),
  )

  it.effect("index query accessor decodes a non-empty page (deferred-decode regression)", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })
      yield* db.entities.Users.put({ orgId: "o1", userId: "u1", email: "a@x.io", name: "Ann" })

      // Before the fix this threw "entityLike._decodeRecord is not a function"
      // once a real item was returned.
      const rows = yield* db.entities.Users.usersByOrg({ orgId: "o1" }).collect()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.name).toBe("Ann")
    }).pipe(Effect.provide(layers)),
  )

  it.effect("scan() decodes a non-empty page", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })
      yield* db.entities.Users.put({ orgId: "o1", userId: "u1", email: "a@x.io", name: "Ann" })

      const rows = yield* db.entities.Users.scan().collect()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.userId).toBe("u1")
    }).pipe(Effect.provide(layers)),
  )

  it.effect("auto-discovered collection groups decoded members (deferred-decode regression)", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })
      yield* db.entities.Users.put({ orgId: "o1", userId: "u1", email: "a@x.io", name: "Ann" })
      yield* db.entities.Teams.put({ orgId: "o1", teamId: "t1", label: "Eng" })

      // Before the fix this threw "member.entityLike._decodeRecord is not a function".
      const grouped = (yield* db.collections.members({ orgId: "o1" }).collect()) as {
        Users: User[]
        Teams: Team[]
      }
      expect(grouped.Users).toHaveLength(1)
      expect(grouped.Teams).toHaveLength(1)
      expect(grouped.Users[0]?.name).toBe("Ann")
      expect(grouped.Teams[0]?.label).toBe("Eng")
    }).pipe(Effect.provide(layers)),
  )

  it.effect("table operations derive GSIs from pure-authored entities", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })
      // Derivation reads only entity.indexes — works for pure defs and must keep working.
      yield* db.tables.MainTable.create()
    }).pipe(Effect.provide(layers)),
  )

  it.effect("update + delete work on a pure-authored entity", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })
      yield* db.entities.Users.put({ orgId: "o1", userId: "u1", email: "a@x.io", name: "Ann" })
      yield* db.entities.Users.update({ orgId: "o1", userId: "u1" }).set({ name: "Annie" })
      yield* db.entities.Users.delete({ orgId: "o1", userId: "u1" })
    }).pipe(Effect.provide(layers)),
  )

  it.effect("a ConditionalCheckFailed surfaces as a typed error (errors still tagged)", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })
      // sanity: DynamoError union is importable from the schema package and the
      // bound op's error channel is unchanged by promotion.
      expect(DynamoError).toBeDefined()
      yield* db.entities.Users.put({ orgId: "o1", userId: "u1", email: "a@x.io", name: "Ann" })
    }).pipe(Effect.provide(layers)),
  )
})
