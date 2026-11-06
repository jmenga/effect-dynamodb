/**
 * The things built over a sharded index (#183, design §11): collections, unbound
 * accessors, cascades, aggregates, projection rows, and what refuses it.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Option, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Collection from "../src/Collection.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import { InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { pkOfInput, serveRows } from "./helpers/ShardedDevices.js"

const schema = DynamoSchema.make({ name: "hr", version: 1 })

class EmployeeModel extends Schema.Class<EmployeeModel>("EmployeeModel")({
  employee: Schema.String,
  team: Schema.String,
  title: Schema.String,
}) {}

class TaskModel extends Schema.Class<TaskModel>("TaskModel")({
  employee: Schema.String,
  taskId: Schema.String,
  status: Schema.String,
}) {}

const employeeIndex = (shards: unknown) => ({
  name: "gsi1",
  collection: "assignments",
  pk: { field: "gsi1pk", composite: ["employee"] },
  sk: { field: "gsi1sk", composite: [] },
  ...(shards === undefined ? {} : { shards }),
})
const taskIndex = (shards: unknown) => ({
  name: "gsi1",
  collection: "assignments",
  pk: { field: "gsi1pk", composite: ["employee"] },
  sk: { field: "gsi1sk", composite: ["taskId"] },
  ...(shards === undefined ? {} : { shards }),
})

const makeMembers = (employeeShards: unknown, taskShards: unknown) => {
  const Employees: any = Entity.make({
    model: EmployeeModel,
    entityType: "Employee",
    primaryKey: {
      pk: { field: "pk", composite: ["employee"] },
      sk: { field: "sk", composite: ["team"] },
    },
    indexes: { assignments: employeeIndex(employeeShards) },
  } as any)
  const Tasks: any = Entity.make({
    model: TaskModel,
    entityType: "Task",
    primaryKey: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: { assignments: taskIndex(taskShards) },
  } as any)
  const MainTable = Table.make({ schema, entities: { Employees, Tasks } })
  return { Employees, Tasks, MainTable }
}

const SHARDS = 4
const members = makeMembers(SHARDS, SHARDS)
const fields = {
  pkField: "gsi1pk",
  skField: "gsi1sk",
  keyFields: ["gsi1pk", "gsi1sk", "pk", "sk"],
}

const rowOf = (entity: any, entityType: string, item: Record<string, unknown>) =>
  toAttributeMap({
    ...item,
    ...KeyComposer.composeAllKeys(schema, entityType, 1, entity.indexes, item),
    __edd_e__: entityType,
  })

const employee = { employee: "dana", team: "core", title: "lead" }
const tasks = Array.from({ length: 12 }, (_, i) => ({
  employee: "dana",
  taskId: `task-${String(i).padStart(2, "0")}`,
  status: i % 2 === 0 ? "open" : "done",
}))

const serve = (options: Parameters<typeof serveRows>[2] = {}) => {
  const server = serveRows(
    [
      rowOf(members.Employees, "Employee", employee),
      ...tasks.map((task) => rowOf(members.Tasks, "Task", task)),
    ],
    fields,
    options,
  )
  return {
    ...server,
    layer: Layer.merge(
      mockDynamoClientLayer({ query: server.query }),
      members.MainTable.layer({ name: "t" }),
    ),
  }
}

const ids = (rows: ReadonlyArray<{ readonly taskId: string }>) => rows.map((row) => row.taskId)

describe("auto-discovered collections", () => {
  const client = DynamoClient.make({
    entities: { Employees: members.Employees, Tasks: members.Tasks },
    tables: { MainTable: members.MainTable },
  }) as Effect.Effect<any, never, DynamoClient>

  it.effect("fan out, never prune, and group the merged rows", () => {
    const server = serve()
    return Effect.gen(function* () {
      const db = yield* client
      const grouped = yield* db.collections.assignments({ employee: "dana" }).collect()
      expect(grouped.Employees).toHaveLength(1)
      expect(ids(grouped.Tasks)).toEqual(tasks.map((task) => task.taskId))
      expect(new Set(server.partitionsRead()).size).toBe(SHARDS)
      for (const pk of server.partitionsRead()) {
        expect(pk).toMatch(/^\$hr#v1#assignments#!4\.\d#employee_dana$/)
      }
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
  })

  it.effect("fetch chains and `.concurrency()` work through the same builder", () => {
    const server = serve({ pageRows: 2 })
    return Effect.gen(function* () {
      const db = yield* client
      const out: Array<string> = []
      let employees = 0
      let cursor: Option.Option<string> = Option.none()
      do {
        const query = db.collections.assignments({ employee: "dana" }).limit(3).concurrency(2)
        const page: any = yield* Option.isSome(cursor)
          ? query.startFrom(cursor.value).fetch()
          : query.fetch()
        out.push(...ids(page.items.Tasks))
        employees += page.items.Employees.length
        cursor = page.cursor
      } while (Option.isSome(cursor))
      expect(out).toEqual(tasks.map((task) => task.taskId))
      expect(employees).toBe(1)
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
  })

  it("members must agree on `count` [EDD-9103]", () => {
    const { Employees, Tasks, MainTable } = makeMembers(SHARDS, 8)
    const server = serveRows([], fields)
    const made = DynamoClient.make({
      entities: { Employees, Tasks },
      tables: { MainTable },
    }) as Effect.Effect<any, never, DynamoClient>
    expect(() =>
      Effect.runSync(made.pipe(Effect.provide(mockDynamoClientLayer({ query: server.query })))),
    ).toThrow("[EDD-9103]")
  })

  it("members must agree on `previous` [EDD-9103]", () => {
    const { Employees, Tasks, MainTable } = makeMembers(
      { count: SHARDS, previous: 1 },
      { count: SHARDS },
    )
    const server = serveRows([], fields)
    const made = DynamoClient.make({
      entities: { Employees, Tasks },
      tables: { MainTable },
    }) as Effect.Effect<any, never, DynamoClient>
    expect(() =>
      Effect.runSync(made.pipe(Effect.provide(mockDynamoClientLayer({ query: server.query })))),
    ).toThrow("[EDD-9103]")
  })

  it("a sharded member and an unsharded one disagree [EDD-9103]", () => {
    const { Employees, Tasks, MainTable } = makeMembers(SHARDS, undefined)
    const server = serveRows([], fields)
    const made = DynamoClient.make({
      entities: { Employees, Tasks },
      tables: { MainTable },
    }) as Effect.Effect<any, never, DynamoClient>
    expect(() =>
      Effect.runSync(made.pipe(Effect.provide(mockDynamoClientLayer({ query: server.query })))),
    ).toThrow("[EDD-9103]")
  })

  it.effect("members may differ on `by`: each hashes its own source", () => {
    class TaggedTask extends Schema.Class<TaggedTask>("TaggedTask")({
      employee: Schema.String,
      taskId: Schema.String,
      status: Schema.String,
    }) {}
    const ByStatus: any = Entity.make({
      model: TaggedTask,
      entityType: "Task",
      primaryKey: {
        pk: { field: "pk", composite: ["taskId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        assignments: {
          name: "gsi1",
          collection: "assignments",
          pk: { field: "gsi1pk", composite: ["employee"] },
          sk: { field: "gsi1sk", composite: ["status", "taskId"] },
          shards: { count: SHARDS, by: ["status"] },
        },
      },
    } as any)
    const { Employees } = makeMembers(SHARDS, SHARDS)
    const MainTable = Table.make({ schema, entities: { Employees, ByStatus } })
    const server = serveRows(
      [
        rowOf(Employees, "Employee", employee),
        ...tasks.map((task) => rowOf(ByStatus, "Task", task)),
      ],
      fields,
    )
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Employees, ByStatus },
        tables: { MainTable },
      })
      const grouped = yield* db.collections.assignments({ employee: "dana" }).collect()
      expect(grouped.Employees).toHaveLength(1)
      expect(grouped.ByStatus).toHaveLength(tasks.length)
      // Even with the member's whole `by` pinned, a collection reads every shard.
      expect(new Set(server.partitionsRead()).size).toBe(SHARDS)
    }).pipe(
      Effect.provide(
        Layer.merge(mockDynamoClientLayer({ query: server.query }), MainTable.layer({ name: "t" })),
      ),
    ) as Effect.Effect<void, unknown>
  })
})

describe("Collection.make", () => {
  const Assignments = Collection.make("assignments", {
    Employees: members.Employees,
    Tasks: members.Tasks,
  })

  it.effect("`query` fans out, each row tagged with its member", () => {
    const server = serve()
    return Effect.gen(function* () {
      const rows: ReadonlyArray<any> = yield* Assignments.query({ employee: "dana" }).pipe(
        Query.collect,
      )
      const of = (member: string) =>
        rows.filter((row) => row._entityKey === member).map((row) => row._decoded)
      expect(of("Employees")).toHaveLength(1)
      expect(ids(of("Tasks"))).toEqual(tasks.map((task) => task.taskId))
      expect(new Set(server.partitionsRead()).size).toBe(SHARDS)
    }).pipe(Effect.provide(server.layer))
  })

  it.effect("a member's selector fans out, and pins don't prune it", () => {
    const server = serve()
    return Effect.gen(function* () {
      const found: any = yield* (Assignments as any).Tasks({ employee: "dana" }).pipe(Query.collect)
      expect(ids(found)).toEqual(tasks.map((task) => task.taskId))
      expect(new Set(server.partitionsRead()).size).toBe(SHARDS)
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
  })

  it("members must agree [EDD-9103]", () => {
    const { Employees, Tasks } = makeMembers(SHARDS, 8)
    expect(() => Collection.make("assignments", { Employees, Tasks })).toThrow("[EDD-9103]")
  })
})

describe("unbound accessors", () => {
  it.effect("`Entity.query.<index>` fans out", () => {
    const server = serve()
    return Effect.gen(function* () {
      const found: any = yield* members.Tasks.query
        .assignments({ employee: "dana" })
        .pipe(Query.collect)
      expect(ids(found)).toEqual(tasks.map((task) => task.taskId))
      expect(server.inputs).toHaveLength(SHARDS)
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
  })

  it.effect("`Query.concurrency` is dual, and refuses what isn't a positive integer", () => {
    const server = serve()
    return Effect.gen(function* () {
      const query = members.Tasks.query.assignments({ employee: "dana" })
      const piped = query.pipe(Query.concurrency(2))
      const direct = Query.concurrency(query, 2)
      expect(yield* Query.explain(piped)).toMatchObject({ fanOut: { concurrency: 2 } })
      expect(yield* Query.explain(direct)).toMatchObject({ fanOut: { concurrency: 2 } })
      expect(() => query.pipe(Query.concurrency(0))).toThrow("[EDD-9105]")
      expect(() => Query.concurrency(query, 1.5)).toThrow("[EDD-9105]")
    }).pipe(Effect.provide(server.layer))
  })

  it.effect("`Query.plan` on a fan-out is refused [EDD-9104]", () =>
    Effect.sync(() => {
      const query = members.Tasks.query.assignments({ employee: "dana" })
      expect(() => Query.plan(query, (() => undefined) as never)).toThrow("[EDD-9104]")
    }),
  )

  it.effect("`asParams` shows the first partition's request", () => {
    const server = serve()
    return Effect.gen(function* () {
      const params: any = yield* Query.asParams(
        members.Tasks.query.assignments({ employee: "dana" }),
      )
      expect(params.ExpressionAttributeValues[":pk"].S).toBe(
        "$hr#v1#assignments#!4.0#employee_dana",
      )
      expect(server.inputs).toHaveLength(0)
    }).pipe(Effect.provide(server.layer))
  })

  it.effect("a provably empty `.where()` sends nothing", () => {
    const server = serve()
    return Effect.gen(function* () {
      const query = Query.planEmpty(members.Tasks.query.assignments({ employee: "dana" }))
      expect(yield* Query.collect(query as any)).toEqual([])
      expect(server.inputs).toHaveLength(0)
    }).pipe(Effect.provide(server.layer))
  })
})

describe("a cascade over a sharded index", () => {
  class Player extends Schema.Class<Player>("Player")({
    playerId: Schema.String.pipe(DynamoModel.identifier),
    displayName: Schema.String,
  }) {}
  class Selection extends Schema.Class<Selection>("Selection")({
    selectionId: Schema.String,
    player: Player.pipe(DynamoModel.ref),
    role: Schema.String,
  }) {}
  const Players: any = Entity.make({
    model: Player,
    entityType: "Player",
    primaryKey: {
      pk: { field: "pk", composite: ["playerId"] },
      sk: { field: "sk", composite: [] },
    },
  } as any)
  const Selections: any = Entity.make({
    model: Selection,
    entityType: "Selection",
    primaryKey: {
      pk: { field: "pk", composite: ["selectionId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byPlayer: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["playerId"] },
        sk: { field: "gsi2sk", composite: ["selectionId"] },
        shards: 4,
      },
    },
    refs: { player: { entity: Players } },
  } as any)
  const MainTable = Table.make({ schema, entities: { Players, Selections } })

  it.effect("reads every partition, so every target is reached", () => {
    const table = makeRecordingTable({ indexes: { gsi2: { pk: "gsi2pk", sk: "gsi2sk" } } })
    const queried: Array<string> = []
    table.hooks.onRequest = (request) => {
      if (request.command === "Query") {
        queried.push(pkOfInput(request.input as never))
      }
    }
    const layer = Layer.merge(table.layer, MainTable.layer({ name: "t" }))
    return Effect.gen(function* () {
      const player = { playerId: "p-1", displayName: "Old" }
      table.items.set(
        "$hr#v1#player#playerid_p-1|$hr#v1#player",
        toAttributeMap({
          ...player,
          pk: "$hr#v1#player#playerid_p-1",
          sk: "$hr#v1#player",
          __edd_e__: "Player",
        }),
      )
      // Selections spread over the shards.
      const selectionIds = ["s-1", "s-2", "s-3", "s-4", "s-5", "s-6", "s-7", "s-8"]
      for (const selectionId of selectionIds) {
        const record = { selectionId, role: "bat", player, playerId: "p-1" }
        const keys = KeyComposer.composeAllKeys(
          schema,
          "Selection",
          1,
          Selections.indexes,
          record,
        ) as Record<string, string>
        table.items.set(
          `${keys.pk}|${keys.sk}`,
          toAttributeMap({ ...record, ...keys, __edd_e__: "Selection" }),
        )
      }
      const shards = new Set([...table.items.values()].flatMap((row) => row.gsi2pk?.S ?? []))
      expect(shards.size).toBeGreaterThan(1)

      yield* Players.update({ playerId: "p-1" }).pipe(
        Entity.set({ displayName: "New" }),
        Entity.cascade({ targets: [Selections] }),
        Entity.asModel,
      )
      expect(new Set(queried).size).toBe(4)
      const names = [...table.items.values()]
        .filter((row) => row.__edd_e__?.S === "Selection")
        .map((row) => (fromAttributeMap(row) as any).player.displayName)
      expect(names).toEqual(selectionIds.map(() => "New"))
    }).pipe(Effect.provide(layer)) as Effect.Effect<void, unknown>
  })
})

describe("aggregates (design §11)", () => {
  class Owner extends Schema.Class<Owner>("Owner")({
    ownerId: Schema.String,
    tenantId: Schema.String,
  }) {}
  class Note extends Schema.Class<Note>("Note")({
    noteId: Schema.String,
    title: Schema.String,
    owner: Owner,
  }) {}
  const Owners: any = Entity.make({
    model: Owner,
    entityType: "Owner",
    primaryKey: {
      pk: { field: "pk", composite: ["ownerId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byTenant: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["ownerId"] },
        shards: 8,
      },
    },
  } as any)
  const MainTable = Table.make({ schema, entities: { Owners } })
  const Notes: any = Aggregate.make(Note, {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["noteId"] },
    collection: { index: "lsi1", name: "note", sk: { field: "lsi1sk", composite: [] } },
    root: { entityType: "NoteItem" },
    edges: { owner: Aggregate.one({ entityType: "NoteOwner", entity: Owners }) },
  } as any)

  it.effect("an edge over a sharded entity writes no key of that index", () => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      yield* Notes.create({
        noteId: "n-1",
        title: "t",
        owner: { ownerId: "o-1", tenantId: "t-1" },
      })
      expect(table.items.size).toBeGreaterThan(0)
      for (const row of table.items.values()) {
        expect(row.gsi1pk).toBeUndefined()
        expect(row.gsi1sk).toBeUndefined()
      }
    }).pipe(
      Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "t" }))),
    ) as Effect.Effect<void, unknown>
  })

  it.effect("the same entity on its own shards normally", () => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Owners },
        tables: { MainTable },
      })
      yield* db.entities.Owners.put({ ownerId: "o-1", tenantId: "t-1" })
      const [row] = [...table.items.values()]
      expect(row!.gsi1pk?.S).toMatch(/#!8\.\d#tenantid_t-1$/)
    }).pipe(
      Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "t" }))),
    ) as Effect.Effect<void, unknown>
  })
})

describe("projection rows", () => {
  class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}

  const EventsTable = Table.make({ schema, entities: {} })
  const Orders = EventStore.makeStream({
    table: EventsTable,
    streamName: "Order",
    events: [Placed],
    streamId: { composite: ["orderId"] },
  })
  const Summary = Schema.Struct({
    orderId: Schema.String,
    region: Schema.String,
    total: Schema.Number,
    version: Schema.Number,
  })
  const Summaries = Entity.make({
    model: Summary,
    entityType: "Summary",
    primaryKey: {
      pk: { field: "pk", composite: ["orderId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byRegion: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["region"] },
        sk: { field: "gsi1sk", composite: ["orderId"] },
        shards: 8,
      },
    },
  })
  const ReadTable = Table.make({ schema, entities: { Summaries } })
  const Totals = EventStore.projection({
    stream: Orders,
    readModel: Summaries,
    key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
    initial: (id: { readonly orderId: string }) => ({
      orderId: id.orderId,
      region: "emea",
      total: 0,
      version: 0,
    }),
    evolve: (state: typeof Summary.Type, event: EventStore.StreamEvent<Placed>) =>
      Effect.succeed({ ...state, total: state.total + event.data.amount }),
    checkpoint: "version" as const,
  })
  const layer = Layer.mergeAll(
    InMemoryClient,
    EventsTable.layer({ name: "events" }),
    ReadTable.layer({ name: "read" }),
  )

  beforeEach(() => resetStore())

  it.effect("carry the sharded key, through the read model's operations", () =>
    Effect.gen(function* () {
      yield* Orders.append({ orderId: "o-1" }, [new Placed({ amount: 5 })], 0)
      const events = yield* Orders.read({ orderId: "o-1" })
      yield* Totals.apply(events[0]!)
      const rows = [...store.entries()]
        .filter(([key]) => key.startsWith("read|"))
        .map(([, item]) => item)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.gsi1pk?.S).toMatch(/^\$hr#v1#summary#!8\.\d#region_emea$/)
    }).pipe(Effect.provide(layer)),
  )
})
