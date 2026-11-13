/**
 * Connected tests for a ref's id as a primary key composite, against DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * A `put` is given the ref's id and stores the ref whole, so a key composed from a row read
 * back reads the id from the ref, and every other key takes it as the caller gives it. Up to
 * 1.40.0 the key schema dropped the id and these operations died. `RefIdPrimaryKey.test.ts`
 * covers the same ground against the in-memory table, except what it doesn't model:
 * `upsert`, a soft delete, `restore` and `purge`.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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

const tableName = `ref-key-conn-${Date.now()}`

class Project extends Schema.Class<Project>("RefKeyConnProject")({
  projectId: Schema.String,
  name: Schema.String,
}) {}

const Projects = Entity.make({
  model: DynamoModel.configure(Project, { projectId: { identifier: true } }),
  entityType: "Project",
  primaryKey: {
    pk: { field: "pk", composite: ["projectId"] },
    sk: { field: "sk", composite: [] },
  },
})

class Task extends Schema.Class<Task>("RefKeyConnTask")({
  taskId: Schema.String,
  title: Schema.String,
  project: DynamoModel.ref(Project),
}) {}

const refs = { project: { entity: Projects } }

const InPartition = Entity.make({
  model: Task,
  entityType: "InPartition",
  primaryKey: {
    pk: { field: "pk", composite: ["projectId"] },
    sk: { field: "sk", composite: ["taskId"] },
  },
  refs,
})

const InSort = Entity.make({
  model: Task,
  entityType: "InSort",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: ["projectId"] },
  },
  refs,
})

const Kept = Entity.make({
  model: Task,
  entityType: "Kept",
  primaryKey: {
    pk: { field: "pk", composite: ["projectId"] },
    sk: { field: "sk", composite: ["taskId"] },
  },
  refs,
  versioned: { retain: true },
  softDelete: true,
  unique: { title: ["title"] },
})

const Indexed = Entity.make({
  model: Task,
  entityType: "Indexed",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byProject: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["projectId"] },
      sk: { field: "gsi1sk", composite: ["taskId"] },
    },
  },
  refs,
  versioned: { retain: true },
  softDelete: true,
})

/** The id is the sort key, so each history row's key holds it too. */
const KeptInSort = Entity.make({
  model: Task,
  entityType: "KeptInSort",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: ["projectId"] },
  },
  refs,
  versioned: { retain: true },
  softDelete: true,
})

const entities = { Projects, InPartition, InSort, Kept, KeptInSort, Indexed }
const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "refkeyconn", version: 1 }),
  entities,
})

const TestLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: tableName }),
)

const database = DynamoClient.make({ entities, tables: { MainTable } })

const one = { projectId: "p-1", name: "One" }
const two = { projectId: "p-2", name: "Two" }

/** An error's key, whatever the error: the test checks its tag first. */
const keyOf = (error: unknown): unknown => (error as { readonly key?: unknown }).key

/** The task rows of one entity type, raw: none holds the id, as a `put` stores the ref instead. */
const rowsOf = (entityType: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const all = yield* client.scan({ TableName: tableName, ConsistentRead: true })
    return (all.Items ?? []).filter((row) => row.__edd_e__?.S === entityType)
  })

describeConnected("a ref's id as a primary key composite — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
        const db = yield* database
        yield* db.entities.Projects.put(one)
        yield* db.entities.Projects.put(two)
      }).pipe(Effect.provide(TestLayer)),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        Effect.provide(TestLayer),
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  for (const [name, entity] of [
    ["the partition key", "InPartition"],
    ["the sort key", "InSort"],
  ] as const) {
    it.effect(`in ${name}: every key-taking operation names it`, () =>
      Effect.gen(function* () {
        const db = yield* database
        const tasks = db.entities[entity]
        const key = { projectId: "p-1", taskId: "t-1" }
        yield* tasks.put({ taskId: "t-1", title: "a", projectId: "p-1" })
        expect(yield* tasks.get(key)).toMatchObject({ title: "a", project: one })
        expect(yield* tasks.update(key).set({ title: "b" })).toMatchObject({ title: "b" })
        expect(yield* tasks.patch(key).set({ title: "c" })).toMatchObject({ title: "c" })
        yield* Transaction.transactWrite([tasks.update(key).set({ title: "d" })])
        expect(yield* tasks.get(key)).toMatchObject({ title: "d", project: one })

        expect(yield* tasks.upsert({ taskId: "t-2", title: "e", projectId: "p-1" })).toMatchObject({
          title: "e",
          project: one,
        })
        expect(yield* tasks.upsert({ taskId: "t-2", title: "f", projectId: "p-1" })).toMatchObject({
          title: "f",
        })
        const elsewhere = yield* tasks.get({ projectId: "p-2", taskId: "t-1" }).pipe(Effect.flip)
        expect(elsewhere._tag).toBe("ItemNotFound")

        yield* tasks.delete(key)
        yield* tasks.deleteIfExists({ projectId: "p-1", taskId: "t-2" })
        expect(yield* rowsOf(entity === "InPartition" ? "InPartition" : "InSort")).toEqual([])
      }).pipe(Effect.provide(TestLayer)),
    )
  }

  it.effect(
    "through retain, soft delete, restore and purge, which compose keys from rows read",
    () =>
      Effect.gen(function* () {
        const db = yield* database
        const kept = db.entities.Kept
        const key = { projectId: "p-1", taskId: "t-1" }
        yield* kept.put({ taskId: "t-1", title: "a", projectId: "p-1" })
        yield* kept.update(key).set({ title: "b" })
        yield* Transaction.transactWrite([kept.update(key).set({ title: "c" })])
        expect(yield* kept.get(key)).toMatchObject({ title: "c", version: 3, project: one })
        // Each update snapshots the version it replaces.
        expect((yield* kept.versions(key).collect()).map((v) => v.title)).toEqual(["a", "b"])
        // The updates released the titles they replaced.
        yield* kept.put({ taskId: "t-2", title: "a", projectId: "p-1" })

        yield* kept.delete(key)
        expect(yield* kept.deleted.get(key)).toMatchObject({ title: "c", project: one })
        expect((yield* kept.deleted.list(key).collect()).map((t) => t.taskId)).toEqual(["t-1"])
        expect((yield* kept.get(key).pipe(Effect.flip))._tag).toBe("ItemNotFound")
        yield* kept.restore(key)
        expect(yield* kept.get(key)).toMatchObject({ title: "c", version: 4, project: one })
        const taken = yield* kept
          .put({ taskId: "t-3", title: "c", projectId: "p-1" })
          .asEffect()
          .pipe(Effect.flip)
        expect(taken._tag).toBe("UniqueConstraintViolation")

        yield* kept.purge(key)
        expect((yield* kept.get(key).pipe(Effect.flip))._tag).toBe("ItemNotFound")
        const left = yield* rowsOf("Kept")
        expect(left.map((row) => row.taskId?.S)).toEqual(["t-2", "t-2"])
        for (const row of left) expect(row.projectId).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("in the sort key, through the history rows keyed by it", () =>
    Effect.gen(function* () {
      const db = yield* database
      const kept = db.entities.KeptInSort
      const key = { projectId: "p-1", taskId: "t-1" }
      yield* kept.put({ taskId: "t-1", title: "a", projectId: "p-1" })
      yield* kept.update(key).set({ title: "b" })
      expect(yield* kept.getVersion(key, 1)).toMatchObject({ title: "a", project: one })
      expect((yield* kept.versions(key).collect()).map((v) => v.title)).toEqual(["a"])
      // Under the other project, the same task is another item, with no history.
      expect(yield* kept.versions({ projectId: "p-2", taskId: "t-1" }).collect()).toEqual([])

      yield* Transaction.transactWrite([kept.delete(key)])
      expect(yield* kept.deleted.get(key)).toMatchObject({ title: "b", project: one })
      yield* kept.restore(key)
      expect(yield* kept.get(key)).toMatchObject({ title: "b", project: one })
      yield* kept.purge(key)
      expect(yield* rowsOf("KeptInSort")).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("as an index composite, an update re-points the ref and moves the entry", () =>
    Effect.gen(function* () {
      const db = yield* database
      const indexed = db.entities.Indexed
      yield* indexed.put({ taskId: "t-1", title: "a", projectId: "p-1" })
      expect(yield* indexed.update({ taskId: "t-1" }).set({ projectId: "p-2" })).toMatchObject({
        project: two,
        version: 2,
      })
      expect(yield* indexed.byProject({ projectId: "p-1" }).collect()).toEqual([])
      expect(
        (yield* indexed.byProject({ projectId: "p-2" }).collect()).map((t) => t.taskId),
      ).toEqual(["t-1"])
      yield* indexed.upsert({ taskId: "t-2", title: "b", projectId: "p-1" })
      expect(
        (yield* indexed.byProject({ projectId: "p-1" }).collect()).map((t) => t.taskId),
      ).toEqual(["t-2"])

      // A restore keys the entry from the stored ref, as the put did.
      yield* indexed.delete({ taskId: "t-1" })
      expect(yield* indexed.byProject({ projectId: "p-2" }).collect()).toEqual([])
      yield* indexed.restore({ taskId: "t-1" })
      expect(
        (yield* indexed.byProject({ projectId: "p-2" }).collect()).map((t) => t.taskId),
      ).toEqual(["t-1"])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("is on an error's key, as get names it", () =>
    Effect.gen(function* () {
      const db = yield* database
      const key = { projectId: "p-1", taskId: "t-9" }
      const missing = yield* db.entities.InPartition.get(key).pipe(Effect.flip)
      expect(missing).toMatchObject({ _tag: "ItemNotFound", key })
      const input = { taskId: "t-9", title: "z", projectId: "p-1" }
      yield* db.entities.InPartition.create(input)
      const created = yield* db.entities.InPartition.create(input).asEffect().pipe(Effect.flip)
      expect(created).toMatchObject({ _tag: "ConditionalCheckFailed" })
      expect(keyOf(created)).toStrictEqual(key)
      const conditioned = yield* db.entities.InPartition.put(input)
        .condition({ title: "y" })
        .asEffect()
        .pipe(Effect.flip)
      expect(conditioned).toMatchObject({ _tag: "ConditionalCheckFailed" })
      expect(keyOf(conditioned)).toStrictEqual(key)
      const inserted = yield* db.entities.InPartition.insert(input).asEffect().pipe(Effect.flip)
      expect(inserted).toMatchObject({ _tag: "ItemAlreadyExists" })
      expect(keyOf(inserted)).toStrictEqual(key)
      yield* db.entities.Kept.create(input)
      const guarded = yield* db.entities.Kept.create(input).asEffect().pipe(Effect.flip)
      expect(guarded).toMatchObject({ _tag: "ConditionalCheckFailed" })
      expect(keyOf(guarded)).toStrictEqual(key)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("insert writes the item put writes, which get reads", () =>
    Effect.gen(function* () {
      const db = yield* database
      const tasks = db.entities.InSort
      const input = { taskId: "t-8", title: "x", projectId: "p-2" }
      const key = { projectId: "p-2", taskId: "t-8" }
      expect(yield* tasks.insert(input)).toMatchObject({ title: "x", project: two })
      const inserted = yield* rowsOf("InSort")
      expect(yield* tasks.get(key)).toMatchObject({ title: "x", project: two })
      yield* tasks.delete(key)
      yield* tasks.put(input)
      expect(yield* rowsOf("InSort")).toEqual(inserted)
      for (const row of inserted) expect(row.projectId).toBeUndefined()
      yield* tasks.delete(key)
    }).pipe(Effect.provide(TestLayer)),
  )
})
