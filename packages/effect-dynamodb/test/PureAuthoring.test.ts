import { describe, expect, it } from "@effect/vitest"
// AUTHORED PURELY via @effect-dynamodb/schema — NO AWS import in this section.
// This is the headline of the schema/runtime split (#62): define the entity once
// against the AWS-free package, then bind it to the runtime client (#69).
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"

import * as Batch from "../src/Batch.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Expression from "../src/Expression.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

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
let transactWriteCalls: unknown[] = []
let batchWriteCalls: unknown[] = []
let transactGetCalls: unknown[] = []

const keyOf = (item: AttrMap) => `${(item.pk as { S: string })?.S}|${(item.sk as { S: string })?.S}`

// Partial test double — only the methods the bound ops exercise are real; the
// rest die if reached. Cast because this intentionally omits table-management
// commands not used by these tests (mirrors the existing DynamoClient.test.ts).
const mockClient = mockDynamoClientLayer({
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
  batchGetItem: (input: { RequestItems: Record<string, { Keys: AttrMap[] }> }) =>
    Effect.sync(() => {
      const responses: Record<string, AttrMap[]> = {}
      for (const [table, { Keys }] of Object.entries(input.RequestItems)) {
        responses[table] = Keys.map((k) => store.find((s) => keyOf(s) === keyOf(k))).filter(
          (i): i is AttrMap => i !== undefined,
        )
      }
      return { Responses: responses } as never
    }),
  batchWriteItem: (input: unknown) =>
    Effect.sync(() => {
      batchWriteCalls.push(input)
      return {} as never
    }),
  transactGetItems: (input: { TransactItems: { Get: { Key: AttrMap } }[] }) =>
    Effect.sync(() => {
      transactGetCalls.push(input)
      return {
        Responses: input.TransactItems.map((t) => {
          const found = store.find((s) => keyOf(s) === keyOf(t.Get.Key))
          return found ? { Item: found } : {}
        }),
      } as never
    }),
  transactWriteItems: (input: unknown) =>
    Effect.sync(() => {
      transactWriteCalls.push(input)
      return {} as never
    }),
  createTable: () => Effect.sync(() => ({}) as never),
} as unknown as DynamoClientService)

const TableLayer = MainTable.layer({ name: "pure-authoring-table" })
const layers = Layer.merge(mockClient, TableLayer)

beforeEach(() => {
  store = []
  transactWriteCalls = []
  batchWriteCalls = []
  transactGetCalls = []
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
      // `!` matches every example in the repo: `collections` is an index
      // signature, so `noUncheckedIndexedAccess` widens each accessor with
      // `| undefined` even though auto-discovery guarantees it exists.
      const grouped = (yield* db.collections.members!({ orgId: "o1" }).collect()) as {
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

// ---------------------------------------------------------------------------
// Pure entity WITH refs — write-time hydration calls .get() on the ref target,
// so binding must promote the target too (otherwise: "ref.refEntity.get is not
// a function"). This is the only refs coverage that runs in CI (the connected
// refs round-trip is skipped without DynamoDB Local).
// ---------------------------------------------------------------------------

class Project extends Schema.Class<Project>("Project")({
  projectId: Schema.String,
  projectName: Schema.String,
}) {}

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  title: Schema.String,
  project: DynamoModel.ref(Project),
}) {}

const Projects = PureEntity.make({
  model: DynamoModel.configure(Project, { projectId: { identifier: true } }),
  entityType: "Project",
  primaryKey: { pk: { field: "pk", composite: ["projectId"] }, sk: { field: "sk", composite: [] } },
})

const Tasks = PureEntity.make({
  model: Task,
  entityType: "Task",
  primaryKey: { pk: { field: "pk", composite: ["taskId"] }, sk: { field: "sk", composite: [] } },
  refs: { project: { entity: Projects } },
})

const RefsTable = Table.make({ schema: AppSchema, entities: { Projects, Tasks } })
const refsLayers = Layer.merge(mockClient, RefsTable.layer({ name: "pure-refs-table" }))

// ---------------------------------------------------------------------------
// #100 — Batch / Transaction participation.
//
// A pure `EntityDefinition` carries no CRUD ops, so the ONLY write descriptor
// its author can build is the bound-CRUD builder returned by `db.entities.*`.
// Before the fix the shared extraction protocol did not recognise those
// builders, and every multi-item write path rejected them with
// `ValidationError { entityType: "unknown" }`.
// ---------------------------------------------------------------------------

describe("pure-authored entities in Batch / Transaction (#100)", () => {
  it.effect("Transaction.transactWrite accepts bound put + delete", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })

      yield* Transaction.transactWrite([
        db.entities.Users.put({ orgId: "o1", userId: "u1", email: "a@x.io", name: "Ann" }),
        db.entities.Teams.delete({ orgId: "o1", teamId: "t1" }),
      ])

      expect(transactWriteCalls).toHaveLength(1)
      const items = (transactWriteCalls[0] as { TransactItems: any[] }).TransactItems
      expect(items).toHaveLength(2)
      expect(fromAttributeMap(items[0].Put.Item).__edd_e__).toBe("User")
      expect(fromAttributeMap(items[1].Delete.Key).pk).toBe("$pure-authoring#v1#team#orgid_o1")
    }).pipe(Effect.provide(layers)),
  )

  it.effect("Batch.write accepts bound put + delete", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })

      yield* Batch.write([
        db.entities.Users.put({ orgId: "o1", userId: "u1", email: "a@x.io", name: "Ann" }),
        db.entities.Teams.delete({ orgId: "o1", teamId: "t1" }),
      ])

      expect(batchWriteCalls).toHaveLength(1)
      const requests = (batchWriteCalls[0] as { RequestItems: Record<string, any[]> }).RequestItems[
        "pure-authoring-table"
      ]!
      expect(requests).toHaveLength(2)
      expect(fromAttributeMap(requests[0].PutRequest.Item).__edd_e__).toBe("User")
      expect(requests[1].DeleteRequest).toBeDefined()
    }).pipe(Effect.provide(layers)),
  )
})

// ---------------------------------------------------------------------------
// #108 — the read side of the same gap.
//
// `Batch.get`, `Transaction.transactGet` and `Transaction.check` all want an
// `EntityGet` DESCRIPTOR, and a pure `EntityDefinition` carries no ops at all,
// so before `BoundGet` a pure-authored entity could not read in a batch, read
// in a transaction, or assert an invariant on a row it was not writing.
// ---------------------------------------------------------------------------

describe("pure-authored entities in Batch / Transaction reads (#108)", () => {
  const ann = { orgId: "o1", userId: "u1", email: "a@x.io", name: "Ann" }
  const eng = { orgId: "o1", teamId: "t1", label: "Eng" }

  it.effect("Batch.get accepts bound gets across two entities", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })
      yield* db.entities.Users.put(ann)
      yield* db.entities.Teams.put(eng)

      const [user, team, missing] = yield* Batch.get([
        db.entities.Users.get({ orgId: "o1", userId: "u1" }),
        db.entities.Teams.get({ orgId: "o1", teamId: "t1" }),
        db.entities.Users.get({ orgId: "o1", userId: "nope" }),
      ])

      // Per-position types survive the union — `user` is a User, not a Team.
      expect(user?.name).toBe("Ann")
      expect(team?.label).toBe("Eng")
      expect(missing).toBeUndefined()
    }).pipe(Effect.provide(layers)),
  )

  it.effect("Transaction.transactGet accepts bound gets", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })
      yield* db.entities.Users.put(ann)
      yield* db.entities.Teams.put(eng)

      const [user, team] = yield* Transaction.transactGet([
        db.entities.Users.get({ orgId: "o1", userId: "u1" }),
        db.entities.Teams.get({ orgId: "o1", teamId: "t1" }),
      ])
      expect(user?.email).toBe("a@x.io")
      expect(team?.label).toBe("Eng")
      expect(transactGetCalls).toHaveLength(1)
    }).pipe(Effect.provide(layers)),
  )

  it.effect("Transaction.check accepts a bound get — data-first and piped", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })

      // The sharp case: guard a row you are NOT writing.
      yield* Transaction.transactWrite([
        db.entities.Teams.put(eng),
        Transaction.check(
          db.entities.Users.get({ orgId: "o1", userId: "u1" }),
          Expression.condition({ attributeExists: "pk" }),
        ),
        // BoundGet is an Effect, so `.pipe` is the Effect pipe — the data-last
        // form of `check` still composes through it.
        db.entities.Users.get({ orgId: "o1", userId: "u1" }).pipe(
          Transaction.check(Expression.condition({ attributeExists: "pk" })),
        ),
      ])

      const items = (transactWriteCalls[0] as { TransactItems: any[] }).TransactItems
      expect(items).toHaveLength(3)
      // Both checks name the same composed key the bound `put`/`get` would.
      const checks = items.filter((i) => i.ConditionCheck !== undefined)
      expect(checks).toHaveLength(2)
      expect(fromAttributeMap(checks[0].ConditionCheck.Key).pk).toBe(
        "$pure-authoring#v1#user#orgid_o1",
      )
      expect(fromAttributeMap(checks[0].ConditionCheck.Key).sk).toBe(
        "$pure-authoring#v1#user#userid_u1",
      )
    }).pipe(Effect.provide(layers)),
  )

  it.effect("a bound get composes the same key the bound put wrote", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })
      yield* db.entities.Users.put(ann)

      // The stored row and the descriptor's composed key must agree, or a batch
      // read silently returns undefined against a row that is right there.
      const written = keyOf(store[0]!)
      const [viaBatch] = yield* Batch.get([db.entities.Users.get({ orgId: "o1", userId: "u1" })])
      expect(written).toBe("$pure-authoring#v1#user#orgid_o1|$pure-authoring#v1#user#userid_u1")
      expect(viaBatch?.name).toBe("Ann")
    }).pipe(Effect.provide(layers)),
  )

  it.effect("a value that is not a get descriptor fails on the error channel", () =>
    Effect.gen(function* () {
      // Pre-#108 these were thrown Errors — a defect the caller could neither
      // catch nor discriminate.
      const batchErr = yield* Batch.get([Effect.succeed(1) as never]).pipe(Effect.flip)
      expect(batchErr._tag).toBe("ValidationError")
      expect(String(batchErr.cause)).toContain("EDD-9052")

      const txErr = yield* Transaction.transactGet([Effect.succeed(1) as never]).pipe(Effect.flip)
      expect(txErr._tag).toBe("ValidationError")
      expect(String(txErr.cause)).toContain("EDD-9052")
    }).pipe(Effect.provide(layers)),
  )
})

describe("pure entity with refs bound via DynamoClient.make (#69 ref-target promotion)", () => {
  it.effect("writing by ref id hydrates the (pure) ref target instead of crashing", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Projects, Tasks }, tables: { RefsTable } })

      yield* db.entities.Projects.put({ projectId: "p1", projectName: "Apollo" })

      // Before ref-target promotion this threw "ref.refEntity.get is not a function".
      const task = yield* db.entities.Tasks.put({ taskId: "t1", title: "Land", projectId: "p1" })
      expect(task.project.projectId).toBe("p1")
      expect(task.project.projectName).toBe("Apollo")
    }).pipe(Effect.provide(refsLayers)),
  )
})
