/**
 * A ref's id as a primary key composite (`primaryKey: { pk: ["projectId"] }` with
 * `refs: { project: ... }`), which `Entity.make` types and accepts.
 *
 * A `put` is given the ref's id and stores the ref whole (`project: { projectId, name }`,
 * no `projectId`). Every key-taking operation names the id, as the input does, and a key
 * composed from a row read back reads the id from the stored ref. Up to 1.40.0 the key
 * schema dropped the id, so `get`, `update`, `delete` and the rest died with
 * `Missing composite attribute "projectId"`. Connected twin, with `upsert`, the soft
 * delete, `restore` and `purge`: `connected.ref-id-primary-key.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { InMemoryClient, resetStore, store, tableIndexes } from "./helpers/InMemoryTables.js"

class Project extends Schema.Class<Project>("RefKeyProject")({
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

class Task extends Schema.Class<Task>("RefKeyTask")({
  taskId: Schema.String,
  title: Schema.String,
  project: DynamoModel.ref(Project),
}) {}

const refs = { project: { entity: Projects } }

/** The id leads the partition key. */
const InPartition = Entity.make({
  model: Task,
  entityType: "InPartition",
  primaryKey: {
    pk: { field: "pk", composite: ["projectId"] },
    sk: { field: "sk", composite: ["taskId"] },
  },
  refs,
})

/** The id is the sort key. */
const InSort = Entity.make({
  model: Task,
  entityType: "InSort",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: ["projectId"] },
  },
  refs,
})

/** Every update reads the row and writes it whole, and a delete leaves a tombstone. */
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

/** The id is an index composite: an update that names it re-points the ref and moves the entry. */
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
})

const entities = { Projects, InPartition, InSort, Kept, Indexed }
const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "refkey", version: 1 }),
  entities,
})
const layer = Layer.mergeAll(InMemoryClient, MainTable.layer({ name: "refkey" }))
const gsi1 = { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } }
tableIndexes.set("refkey", gsi1)
const database = DynamoClient.make({ entities, tables: { MainTable } })

const key = { projectId: "p-1", taskId: "t-1" }
const one = { projectId: "p-1", name: "One" }
const two = { projectId: "p-2", name: "Two" }

const seed = Effect.gen(function* () {
  const db = yield* database
  yield* db.entities.Projects.put(one)
  yield* db.entities.Projects.put(two)
  return db
})

const taskRows = (entityType: string) =>
  [...store.values()].filter((row) => row.__edd_e__?.S === entityType)

/** An error's key, whatever the error: the test checks its tag first. */
const keyOf = (error: unknown): unknown => (error as { readonly key?: unknown }).key

/** No task's row holds the id: a `put` stores the ref in its place. */
const expectNoStoredId = () => {
  for (const row of store.values())
    if (row.__edd_e__?.S !== "Project") expect(row.projectId).toBeUndefined()
}

beforeEach(() => {
  resetStore()
})

describe("a ref's id as a primary key composite", () => {
  for (const [name, entity] of [
    ["the partition key", "InPartition"],
    ["the sort key", "InSort"],
  ] as const) {
    it.effect(`in ${name}: every key-taking operation names it`, () =>
      Effect.gen(function* () {
        const db = yield* seed
        const tasks = db.entities[entity]
        yield* tasks.put({ taskId: "t-1", title: "a", projectId: "p-1" })
        expect(yield* tasks.get(key)).toMatchObject({ title: "a", project: one })

        // The in-memory table returns no item from `UpdateItem`, so nothing is asked of it.
        yield* tasks.update(key).set({ title: "b" }).returnValues("none")
        yield* tasks.patch(key).set({ title: "c" }).returnValues("none")
        yield* Transaction.transactWrite([tasks.update(key).set({ title: "d" })])
        expect(yield* tasks.get(key)).toMatchObject({ title: "d", project: one })

        // Under the other project, the same task is another item.
        const elsewhere = yield* tasks.get({ projectId: "p-2", taskId: "t-1" }).pipe(Effect.flip)
        expect(elsewhere._tag).toBe("ItemNotFound")

        yield* tasks.deleteIfExists(key)
        const gone = yield* tasks.get(key).pipe(Effect.flip)
        expect(gone._tag).toBe("ItemNotFound")
        expectNoStoredId()
      }).pipe(Effect.provide(layer)),
    )
  }

  // `upsert`, the soft delete, `restore` and `purge` are in `connected.ref-key.test.ts`: the
  // in-memory table returns no item from `UpdateItem` and applies no `Delete` in a transaction.
  it.effect("on the retain and unique paths, which compose keys from rows read", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const kept = db.entities.Kept
      yield* kept.put({ taskId: "t-1", title: "a", projectId: "p-1" })
      yield* kept.update(key).set({ title: "b" })
      yield* Transaction.transactWrite([kept.update(key).set({ title: "c" })])
      expect(yield* kept.get(key)).toMatchObject({ title: "c", version: 3, project: one })
      const taken = yield* kept
        .put({ taskId: "t-2", title: "c", projectId: "p-1" })
        .asEffect()
        .pipe(Effect.flip)
      expect(taken._tag).toBe("UniqueConstraintViolation")
      expectNoStoredId()
    }).pipe(Effect.provide(layer)),
  )

  it.effect("as an index composite, an update re-points the ref and moves the entry", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const indexed = db.entities.Indexed
      yield* indexed.put({ taskId: "t-1", title: "a", projectId: "p-1" })
      yield* indexed.update({ taskId: "t-1" }).set({ projectId: "p-2" }).returnValues("none")
      expect(yield* indexed.get({ taskId: "t-1" })).toMatchObject({ project: two, version: 2 })
      expect(yield* indexed.byProject({ projectId: "p-1" }).collect()).toEqual([])
      expect(
        (yield* indexed.byProject({ projectId: "p-2" }).collect()).map((t) => t.taskId),
      ).toEqual(["t-1"])
      yield* indexed.upsert({ taskId: "t-2", title: "b", projectId: "p-1" })
      expect(
        (yield* indexed.byProject({ projectId: "p-1" }).collect()).map((t) => t.taskId),
      ).toEqual(["t-2"])
    }).pipe(Effect.provide(layer)),
  )

  it("is not in the update schema, as no update changes the key", () => {
    const decode = (entity: { readonly updateSchema: Schema.Top }) =>
      Object.keys(
        Schema.decodeUnknownSync(entity.updateSchema as Schema.Codec<unknown>)({
          projectId: "p-2",
          title: "x",
        }) as object,
      )
    expect(decode(InPartition)).toEqual(["title"])
    expect(decode(InSort)).toEqual(["title"])
    // As an index composite it is: the update re-points the ref.
    expect(decode(Indexed).sort()).toEqual(["projectId", "title"])
  })

  it.effect("is on an error's key, as get names it, on every write path", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const missing = yield* db.entities.InPartition.get(key).pipe(Effect.flip)
      expect(missing).toMatchObject({ _tag: "ItemNotFound", key })
      const input = { taskId: "t-1", title: "a", projectId: "p-1" }
      yield* db.entities.InPartition.create(input)
      const created = yield* db.entities.InPartition.create(input).asEffect().pipe(Effect.flip)
      expect(created).toMatchObject({ _tag: "ConditionalCheckFailed" })
      expect(keyOf(created)).toStrictEqual(key)
      const conditioned = yield* db.entities.InPartition.put(input)
        .condition({ title: "z" })
        .asEffect()
        .pipe(Effect.flip)
      expect(conditioned).toMatchObject({ _tag: "ConditionalCheckFailed" })
      expect(keyOf(conditioned)).toStrictEqual(key)
      const inserted = yield* db.entities.InPartition.insert(input).asEffect().pipe(Effect.flip)
      expect(inserted).toMatchObject({ _tag: "ItemAlreadyExists" })
      expect(keyOf(inserted)).toStrictEqual(key)
      // A guarded put composes its error's key from the item, whose ref is hydrated.
      yield* db.entities.Kept.create(input)
      const guarded = yield* db.entities.Kept.create(input).asEffect().pipe(Effect.flip)
      expect(guarded).toMatchObject({ _tag: "ConditionalCheckFailed" })
      expect(keyOf(guarded)).toStrictEqual(key)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("insert writes the item put writes, which get reads", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const tasks = db.entities.InPartition
      expect(yield* tasks.insert({ taskId: "t-1", title: "a", projectId: "p-1" })).toMatchObject({
        title: "a",
        project: one,
      })
      const inserted = taskRows("InPartition")
      resetStore()
      yield* seed
      yield* tasks.put({ taskId: "t-1", title: "a", projectId: "p-1" })
      expect(taskRows("InPartition")).toEqual(inserted)
      expect(yield* tasks.get(key)).toMatchObject({ title: "a", project: one })
      expectNoStoredId()
    }).pipe(Effect.provide(layer)),
  )
})

// The projects' table folds key case, as by default; the tasks' table preserves it. A task given
// `P-1` reads the project stored as `p-1`. The task is keyed by `P-1`, as `put` keys it, and every
// key the caller names takes the id as given; a key the operation has no id for reads the stored
// one.
const FoldedProjects = Entity.make({
  model: DynamoModel.configure(Project, { projectId: { identifier: true } }),
  entityType: "FoldedProject",
  primaryKey: {
    pk: { field: "pk", composite: ["projectId"] },
    sk: { field: "sk", composite: [] },
  },
})
const foldedRefs = { project: { entity: FoldedProjects } }
const Preserved = Entity.make({
  model: Task,
  entityType: "Preserved",
  primaryKey: {
    pk: { field: "pk", composite: ["projectId"] },
    sk: { field: "sk", composite: ["taskId"] },
  },
  refs: foldedRefs,
  softDelete: true,
})
const byProject = {
  byProject: {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["projectId"] },
    sk: { field: "gsi1sk", composite: ["taskId"] },
  },
} as const
const byTask = {
  pk: { field: "pk", composite: ["taskId"] },
  sk: { field: "sk", composite: [] },
} as const
const PreservedIndexed = Entity.make({
  model: Task,
  entityType: "PreservedIndexed",
  primaryKey: byTask,
  indexes: byProject,
  refs: foldedRefs,
})
const PreservedIndexedKept = Entity.make({
  model: Task,
  entityType: "PreservedIndexedKept",
  primaryKey: byTask,
  indexes: byProject,
  refs: foldedRefs,
  versioned: { retain: true },
})
const preservedEntities = {
  Preserved,
  PreservedIndexed,
  PreservedIndexedKept,
}
const FoldedTable = Table.make({
  schema: DynamoSchema.make({ name: "refkeyfold", version: 1 }),
  entities: { FoldedProjects },
})
const PreservedTable = Table.make({
  schema: DynamoSchema.make({ name: "refkeykeep", version: 1, casing: "preserve" }),
  entities: preservedEntities,
})
tableIndexes.set("refkeykeep", gsi1)
const casingLayer = Layer.mergeAll(
  InMemoryClient,
  FoldedTable.layer({ name: "refkeyfold" }),
  PreservedTable.layer({ name: "refkeykeep" }),
)
const casingDatabase = DynamoClient.make({
  entities: { FoldedProjects, ...preservedEntities },
  tables: { FoldedTable, PreservedTable },
})
const seedFolded = Effect.gen(function* () {
  const db = yield* casingDatabase
  yield* db.entities.FoldedProjects.put({ projectId: "p-1", name: "One" })
  yield* db.entities.FoldedProjects.put({ projectId: "p-2", name: "Two" })
  return db
})

const indexKeyOf = (entityType: string, taskId: string) =>
  taskRows(entityType).find((row) => row.taskId?.S === taskId)?.gsi1pk?.S
const taskIds = (tasks: ReadonlyArray<{ readonly taskId: string }>) =>
  tasks.map((task) => task.taskId).sort()

describe("a ref's id given in other key text than the referenced item stores it", () => {
  it.effect("keys the item by the id as given, on every write that reads the ref", () =>
    Effect.gen(function* () {
      const db = yield* seedFolded
      const preserved = db.entities.Preserved
      yield* preserved.put({ taskId: "t-1", title: "a", projectId: "P-1" })
      yield* preserved.create({ taskId: "t-2", title: "a", projectId: "P-1" })
      yield* preserved.insert({ taskId: "t-3", title: "a", projectId: "P-1" })
      for (const taskId of ["t-1", "t-2", "t-3"]) {
        expect(yield* preserved.get({ projectId: "P-1", taskId })).toMatchObject({
          project: { projectId: "p-1", name: "One" },
        })
      }
      // One partition, under the id as given; under the stored id there is no item.
      expect(new Set(taskRows("Preserved").map((row) => row.pk?.S)).size).toBe(1)
      expect(taskRows("Preserved")[0]?.pk?.S).toContain("P-1")
      const stored = yield* preserved.get({ projectId: "p-1", taskId: "t-1" }).pipe(Effect.flip)
      expect(stored._tag).toBe("ItemNotFound")

      // An error names the key as the caller gave it.
      const created = yield* preserved
        .create({ taskId: "t-2", title: "a", projectId: "P-1" })
        .asEffect()
        .pipe(Effect.flip)
      expect(created).toMatchObject({
        _tag: "ConditionalCheckFailed",
        key: { projectId: "P-1", taskId: "t-2" },
      })
      const inserted = yield* preserved
        .insert({ taskId: "t-3", title: "a", projectId: "P-1" })
        .asEffect()
        .pipe(Effect.flip)
      expect(inserted).toMatchObject({
        _tag: "ItemAlreadyExists",
        key: { projectId: "P-1", taskId: "t-3" },
      })

      const key = { projectId: "P-1", taskId: "t-1" }
      yield* preserved.update(key).set({ title: "b" }).returnValues("none")
      yield* Transaction.transactWrite([preserved.update(key).set({ title: "c" })])
      expect(yield* preserved.get(key)).toMatchObject({ title: "c" })
    }).pipe(Effect.provide(casingLayer)),
  )

  it.effect("moves an index entry to the id as given when an update re-points the ref", () =>
    Effect.gen(function* () {
      const db = yield* seedFolded
      for (const indexed of [db.entities.PreservedIndexed, db.entities.PreservedIndexedKept]) {
        yield* indexed.put({ taskId: "t-1", title: "a", projectId: "P-1" })
        expect(taskIds(yield* indexed.byProject({ projectId: "P-1" }).collect())).toEqual(["t-1"])
        yield* indexed.update({ taskId: "t-1" }).set({ projectId: "P-2" }).returnValues("none")
        expect(yield* indexed.get({ taskId: "t-1" })).toMatchObject({
          project: { projectId: "p-2", name: "Two" },
        })
        expect(taskIds(yield* indexed.byProject({ projectId: "P-2" }).collect())).toEqual(["t-1"])
        expect(yield* indexed.byProject({ projectId: "p-2" }).collect()).toEqual([])
        expect(yield* indexed.byProject({ projectId: "P-1" }).collect()).toEqual([])
      }
    }).pipe(Effect.provide(casingLayer)),
  )

  it.effect(
    "leaves an index half holding the ref's id alone on an update that doesn't touch it",
    () =>
      Effect.gen(function* () {
        const db = yield* seedFolded
        for (const [entityType, indexed] of [
          ["PreservedIndexed", db.entities.PreservedIndexed],
          ["PreservedIndexedKept", db.entities.PreservedIndexedKept],
        ] as const) {
          yield* indexed.put({ taskId: "t-1", title: "a", projectId: "P-1" })
          const before = indexKeyOf(entityType, "t-1")
          expect(before).toContain("P-1")
          yield* indexed.update({ taskId: "t-1" }).set({ title: "b" }).returnValues("none")
          expect(indexKeyOf(entityType, "t-1")).toBe(before)
          expect(taskIds(yield* indexed.byProject({ projectId: "P-1" }).collect())).toEqual(["t-1"])
        }
      }).pipe(Effect.provide(casingLayer)),
  )

  it.effect("where both tables fold case, the two ids compose one key", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db.entities.InPartition.put({ taskId: "t-1", title: "a", projectId: "P-1" })
      expect(yield* db.entities.InPartition.get({ projectId: "P-1", taskId: "t-1" })).toMatchObject(
        { project: one },
      )
      expect(yield* db.entities.InPartition.get(key)).toMatchObject({ project: one })
    }).pipe(Effect.provide(layer)),
  )
})

// A referenced entity keyed by a transformed identifier: stored as text, a number in the model.
class Code extends Schema.Class<Code>("RefKeyCode")({
  code: Schema.NumberFromString,
  label: Schema.String,
}) {}
const Codes = Entity.make({
  model: DynamoModel.configure(Code, { code: { identifier: true } }),
  entityType: "Code",
  primaryKey: {
    pk: { field: "pk", composite: ["code"] },
    sk: { field: "sk", composite: [] },
  },
})
class Coded extends Schema.Class<Coded>("RefKeyCoded")({
  id: Schema.String,
  code: DynamoModel.ref(Code),
}) {}
const CodedById = Entity.make({
  model: Coded,
  entityType: "CodedById",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
  refs: { code: { entity: Codes } },
})
const CodedByCode = Entity.make({
  model: Coded,
  entityType: "CodedByCode",
  primaryKey: {
    pk: { field: "pk", composite: ["codeId"] },
    sk: { field: "sk", composite: ["id"] },
  },
  refs: { code: { entity: Codes } },
})
const CodesTable = Table.make({
  schema: DynamoSchema.make({ name: "refkeycode", version: 1 }),
  entities: { Codes, CodedById, CodedByCode },
})
const codesLayer = Layer.mergeAll(InMemoryClient, CodesTable.layer({ name: "refkeycode" }))
const codesDatabase = DynamoClient.make({
  entities: { Codes, CodedById, CodedByCode },
  tables: { CodesTable },
})

describe("a ref to an entity whose identifier is transformed", () => {
  it.effect("reads the referenced item by its id, as a composite or not", () =>
    Effect.gen(function* () {
      const db = yield* codesDatabase
      yield* db.entities.Codes.put({ code: 5, label: "five" })
      const five = { code: 5, label: "five" }
      expect(yield* db.entities.CodedById.put({ id: "i-1", codeId: 5 })).toMatchObject({
        code: five,
      })
      expect(yield* db.entities.CodedById.get({ id: "i-1" })).toMatchObject({ code: five })

      yield* db.entities.CodedByCode.put({ id: "i-1", codeId: 5 })
      expect(yield* db.entities.CodedByCode.get({ codeId: 5, id: "i-1" })).toMatchObject({
        code: five,
      })
      yield* db.entities.CodedByCode.deleteIfExists({ codeId: 5, id: "i-1" })
      expect(
        (yield* db.entities.CodedByCode.get({ codeId: 5, id: "i-1" }).pipe(Effect.flip))._tag,
      ).toBe("ItemNotFound")

      const missing = yield* db.entities.CodedById.put({ id: "i-2", codeId: 6 })
        .asEffect()
        .pipe(Effect.flip)
      expect(missing).toMatchObject({ _tag: "RefNotFound", refId: "6" })
    }).pipe(Effect.provide(codesLayer)),
  )
})
