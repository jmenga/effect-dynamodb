/**
 * #190: what an interrupt does to the library's own operations now that it ends the
 * request, against DynamoDB Local through a local server that can hold a request back.
 *
 * Reads: where the library doesn't interrupt anything, results are unchanged and nothing
 * is aborted; where a sibling's failure does, only that failure surfaces.
 *
 * Writes: aborting ends the wait, not the request. A write already applied stays applied,
 * the caller sees an interrupt either way, and retrying the same conditional write tells
 * them which it was.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Config, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import type { TableConfig } from "../src/Table.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  applyAndHang,
  awsFailure,
  hang,
  type LocalServer,
  localServer,
  passThrough,
  type Reply,
  type SeenRequest,
} from "./helpers/LocalServer.js"
import * as ZListings from "./helpers/ZOrderListings.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local isn't reachable
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "abort-it", version: 1 })
const tableName = `abort-it-${Date.now()}`
const zTableName = `abort-it-z-${Date.now()}`

const Users = Entity.make({
  model: Schema.Struct({ id: Schema.String, name: Schema.String }),
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const Notes = Entity.make({
  model: Schema.Struct({ owner: Schema.String, title: Schema.String, body: Schema.String }),
  entityType: "Note",
  primaryKey: {
    pk: { field: "pk", composite: ["owner"] },
    sk: { field: "sk", composite: ["title"] },
  },
})

const Employees = Entity.make({
  model: Schema.Struct({ employee: Schema.String, name: Schema.String }),
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employee"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    assignments: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["employee"] },
      sk: { field: "gsi1sk", composite: [] },
      collection: "assignments",
    },
  },
})

const Tasks = Entity.make({
  model: Schema.Struct({ employee: Schema.String, task: Schema.String }),
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["task"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    assignments: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["employee"] },
      sk: { field: "gsi1sk", composite: ["task"] },
      collection: "assignments",
    },
  },
})

const Documents = Entity.make({
  model: Schema.Struct({ id: Schema.String, name: Schema.String }),
  entityType: "Document",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: true,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Users, Notes, Employees, Tasks, Documents },
})

class Opened extends Schema.TaggedClass<Opened>()("Opened", { owner: Schema.String }) {}

const EventsTable = Table.make({ schema: AppSchema, entities: {} })

const Accounts = EventStore.makeStream({
  table: EventsTable,
  streamName: "Account",
  events: [Opened],
  streamId: { composite: ["accountId"] },
})

const openAccount: EventStore.Decider<{ readonly opened: boolean }, string, Opened, never> = {
  initialState: { opened: false },
  decide: (owner) => Effect.succeed([new Opened({ owner })]),
  evolve: () => ({ opened: true }),
}

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const TestLayer = Layer.mergeAll(
  DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials }),
  MainTable.layer({ name: tableName }),
  EventsTable.layer({ name: tableName }),
  ZListings.MainTable.layer({ name: zTableName }),
)
const provide = Effect.provide(TestLayer)

/** The same program with every request going through `server`. */
const through = (server: LocalServer, options?: { readonly maxAttempts?: number }) =>
  Effect.provide(
    DynamoClient.layer({
      region: "us-east-1",
      endpoint: server.endpoint,
      credentials,
      ...options,
    }),
  )

const server = (reply: (seen: SeenRequest) => Reply) => localServer(reply, { upstream: ENDPOINT })

/** `reply` for the first request of `operation`; everything else reaches DynamoDB Local. */
const firstOf = (operation: string, reply: Reply) => {
  let seen = 0
  return (request: SeenRequest) =>
    request.operation === operation && ++seen === 1 ? reply : passThrough
}

const interruptedOnly = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)

const usersDb = DynamoClient.make({ entities: { Users } })

const unique = (() => {
  let n = 0
  return (prefix: string) => `${prefix}-${++n}`
})()

const listings = ZListings.randomZListings(190, 300)

const box = {
  price: { between: [100, 900] as const },
  bedrooms: { between: [2, 12] as const },
}

const zDb = DynamoClient.make({ entities: { Listings: ZListings.Listings } })

describeConnected("interrupting requests (#190) — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
        yield* client.createTable({
          TableName: zTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(ZListings.MainTable),
        })
        yield* Batch.write(listings.map((listing) => ZListings.Listings.put(listing)))
      }).pipe(provide),
    )
  }, 120_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const TableName of [tableName, zTableName]) {
          yield* client.deleteTable({ TableName }).pipe(Effect.ignore)
        }
      }).pipe(provide),
    )
  }, 30_000)

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  describe("reads", () => {
    const ids = (items: ReadonlyArray<{ readonly listingId: string }>) =>
      items.map((item) => item.listingId)

    const facets = (db: Effect.Success<typeof zDb>) =>
      db.entities.Listings.byFacets({ region: ZListings.REGION }).within(box)

    it.live(".zorder() reaching its limit aborts nothing, and returns the same items", () =>
      Effect.gen(function* () {
        const proxy = yield* server(() => passThrough)
        const direct = yield* zDb
        const query = (db: typeof direct) =>
          facets(db).zorder({ strategy: "precise", concurrency: 4 }).limit(10).collect()
        const expected = yield* query(direct)
        yield* Effect.gen(function* () {
          const got = yield* query(yield* zDb)
          expect(ids(got)).toEqual(ids(expected))
          expect(got).toHaveLength(10)
          // Not vacuous: more than one range was read, and every read got its answer.
          expect(proxy.of("Query").length).toBeGreaterThan(1)
          expect(proxy.requests.every((seen) => seen.answered)).toBe(true)
          expect(proxy.requests.some((seen) => seen.connectionClosed)).toBe(false)
        }).pipe(through(proxy))
      }).pipe(provide),
    )

    for (const [terminal, run] of [
      ["collect", (query: ReturnType<typeof facets>) => query.zorder(zOptions).collect()],
      ["count", (query: ReturnType<typeof facets>) => query.zorder(zOptions).count()],
      [
        "paginate",
        (query: ReturnType<typeof facets>) => Stream.runDrain(query.zorder(zOptions).paginate()),
      ],
    ] as const) {
      it.live(`a range failing aborts the others on ${terminal}: only the failure surfaces`, () =>
        Effect.gen(function* () {
          let reads = 0
          const proxy = yield* server((seen) =>
            seen.operation !== "Query"
              ? passThrough
              : ++reads === 2
                ? awsFailure(400, "ValidationException", "refused")
                : hang,
          )
          yield* Effect.gen(function* () {
            const exit = yield* Effect.exit(
              run(facets(yield* zDb)) as Effect.Effect<unknown, unknown>,
            )
            expect(Exit.isFailure(exit)).toBe(true)
            const failure = Exit.isFailure(exit)
              ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as
                  | { readonly error: { readonly _tag: string; readonly cause: Error } }
                  | undefined)
              : undefined
            expect(failure?.error._tag).toBe("DynamoValidationError")
            expect(failure?.error.cause.message).toBe("refused")
            const hung = proxy.of("Query").filter((seen) => !seen.answered)
            expect(hung.length).toBeGreaterThanOrEqual(1)
            yield* proxy.until(() => hung.every((seen) => seen.connectionClosed))
          }).pipe(through(proxy))
        }).pipe(provide),
      )
    }

    it.live("a consumer stopping paginate early leaves nothing in flight", () =>
      Effect.gen(function* () {
        const proxy = yield* server(() => passThrough)
        const direct = yield* zDb
        const firstThree = (db: typeof direct) =>
          facets(db)
            .zorder({ strategy: "naive" })
            .pageSize(2)
            .paginate()
            .pipe(Stream.take(3), Stream.runCollect)
        const expected = yield* firstThree(direct)
        yield* Effect.gen(function* () {
          const got = yield* firstThree(yield* zDb)
          expect(ids(got)).toEqual(ids(expected))
          expect(proxy.requests.length).toBeGreaterThanOrEqual(1)
          expect(proxy.requests.every((seen) => seen.answered)).toBe(true)
          expect(proxy.requests.some((seen) => seen.connectionClosed)).toBe(false)
        }).pipe(through(proxy))
      }).pipe(provide),
    )

    it.live("a collection query is one request: nothing in it to interrupt", () =>
      Effect.gen(function* () {
        const employee = unique("employee")
        const direct = yield* DynamoClient.make({ entities: { Employees, Tasks } })
        yield* direct.entities.Employees.put({ employee, name: "Dee" }).asEffect()
        yield* direct.entities.Tasks.put({ employee, task: unique("task") }).asEffect()
        const proxy = yield* server(() => passThrough)
        yield* Effect.gen(function* () {
          const db = yield* DynamoClient.make({ entities: { Employees, Tasks } })
          const got = yield* db.collections.assignments!({ employee }).collect()
          expect(got.Employees).toHaveLength(1)
          expect(got.Tasks).toHaveLength(1)
          expect(proxy.of("Query")).toHaveLength(1)
          expect(proxy.requests.every((seen) => seen.answered)).toBe(true)
        }).pipe(through(proxy))
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // rekey
  // -------------------------------------------------------------------------

  describe("rekey", () => {
    const rekeyDb = DynamoClient.make({ entities: { Notes }, tables: { MainTable } })

    /** Notes whose sort keys hold a space, moved back to the raw text 1.36 wrote. */
    const seedLegacyNotes = (owner: string, count: number) =>
      Effect.gen(function* () {
        const db = yield* rekeyDb
        const client = yield* DynamoClient
        for (let n = 0; n < count; n++) {
          yield* db.entities.Notes.put({ owner, title: `new york ${n}`, body: "b" }).asEffect()
        }
        const { Items } = yield* client.scan({ TableName: tableName, ConsistentRead: true })
        const rows = (Items ?? []).filter((row) => row.owner?.S === owner)
        expect(rows).toHaveLength(count)
        for (const row of rows) {
          const sk = row.sk!.S!
          yield* client.deleteItem({ TableName: tableName, Key: { pk: row.pk!, sk: row.sk! } })
          yield* client.putItem({
            TableName: tableName,
            Item: { ...row, sk: { S: sk.replaceAll("%20", " ") } },
          })
        }
      })

    /** Sort keys of the rows of `owner`. */
    const sortKeys = (owner: string) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const { Items } = yield* client.scan({ TableName: tableName, ConsistentRead: true })
        return (Items ?? [])
          .filter((row) => row.owner?.S === owner)
          .map((row) => row.sk!.S!)
          .sort()
      })

    it.live("a segment's failure aborts the others, and a rerun finishes the move", () =>
      Effect.gen(function* () {
        const owner = unique("rekey-owner")
        yield* seedLegacyNotes(owner, 3)
        const proxy = yield* server((seen) =>
          seen.operation !== "Scan"
            ? passThrough
            : JSON.parse(seen.body).Segment === 1
              ? awsFailure(400, "ValidationException", "refused")
              : hang,
        )
        const exit = yield* Effect.gen(function* () {
          const db = yield* rekeyDb
          const exit = yield* Effect.exit(db.tables.MainTable.rekey({ segments: 2 }))
          // The failure, not an interrupt, and the other segment's connection closed.
          expect(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          const hung = proxy.of("Scan").filter((seen) => !seen.answered)
          yield* proxy.until(() => hung.every((seen) => seen.connectionClosed))
          return exit
        }).pipe(through(proxy))
        expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("refused")
        const db = yield* rekeyDb
        const report = yield* db.tables.MainTable.rekey({ segments: 2 })
        expect(report.moved.item).toBeGreaterThanOrEqual(3)
        const moved = yield* sortKeys(owner)
        expect(moved).toHaveLength(3)
        for (const sk of moved) expect(sk).toContain("%20")
      }).pipe(provide),
    )

    it.live("a move interrupted after it applied is found moved by the rerun", () =>
      Effect.gen(function* () {
        const owner = unique("rekey-owner")
        yield* seedLegacyNotes(owner, 2)
        const proxy = yield* server(firstOf("TransactWriteItems", applyAndHang))
        yield* Effect.gen(function* () {
          const db = yield* rekeyDb
          const fiber = yield* Effect.forkChild(db.tables.MainTable.rekey())
          yield* proxy.until(() => proxy.of("TransactWriteItems")[0]?.reachedUpstream === true)
          const exit = yield* Effect.as(Fiber.interrupt(fiber), fiber).pipe(
            Effect.flatMap(Fiber.await),
          )
          expect(interruptedOnly(exit)).toBe(true)
          yield* proxy.until(() => proxy.of("TransactWriteItems")[0]!.connectionClosed)
        }).pipe(through(proxy))
        const db = yield* rekeyDb
        yield* db.tables.MainTable.rekey()
        const moved = yield* sortKeys(owner)
        expect(moved).toHaveLength(2)
        for (const sk of moved) expect(sk).toContain("%20")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  describe("a write interrupted mid-flight", () => {
    const interruptWhen = <A, E, R>(
      proxy: LocalServer,
      operation: string,
      reached: (request: SeenRequest) => boolean,
      write: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(write)
        yield* proxy.until(() => {
          const request = proxy.of(operation)[0]
          return request !== undefined && reached(request)
        })
        const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
        expect(interruptedOnly(exit)).toBe(true)
        yield* proxy.until(() => proxy.of(operation)[0]!.connectionClosed)
        // The SDK doesn't send it again: an abort isn't retried.
        expect(proxy.of(operation)).toHaveLength(1)
      })

    const applied = (request: SeenRequest) => request.reachedUpstream
    const arrived = () => true

    type Needs = DynamoClient | TableConfig
    const scenarios: Readonly<
      Record<
        string,
        {
          readonly operation: string
          readonly onRetry: string
          readonly make: () => {
            readonly seed?: Effect.Effect<unknown, unknown, Needs>
            readonly write: Effect.Effect<unknown, { readonly _tag: string }, Needs>
            readonly state: Effect.Effect<number, unknown, Needs>
          }
        }
      >
    > = {
      "Entity.create": {
        operation: "PutItem",
        make: () => {
          const id = unique("user")
          return {
            write: Effect.flatMap(usersDb, (db) =>
              db.entities.Users.create({ id, name: "Ann" }).asEffect(),
            ),
            state: Effect.flatMap(usersDb, (db) =>
              db.entities.Users.get({ id }).pipe(
                Effect.as(1),
                Effect.catchTag("ItemNotFound", () => Effect.succeed(0)),
              ),
            ),
          }
        },
        onRetry: "ConditionalCheckFailed",
      },
      "an update with expectedVersion": {
        operation: "UpdateItem",
        make: () => {
          const id = unique("document")
          const db = DynamoClient.make({ entities: { Documents } })
          return {
            seed: Effect.flatMap(db, (bound) =>
              bound.entities.Documents.put({ id, name: "before" }).asEffect(),
            ),
            write: Effect.flatMap(db, (bound) =>
              bound.entities.Documents.update({ id })
                .set({ name: "after" })
                .expectedVersion(1)
                .asEffect(),
            ),
            state: Effect.flatMap(db, (bound) =>
              Effect.map(bound.entities.Documents.get({ id }), (row) =>
                row.name === "after" ? 1 : 0,
              ),
            ),
          }
        },
        onRetry: "OptimisticLockError",
      },
      "Transaction.transactWrite": {
        operation: "TransactWriteItems",
        make: () => {
          const id = unique("user")
          return {
            write: Effect.flatMap(usersDb, (db) =>
              Transaction.transactWrite([db.entities.Users.create({ id, name: "Ann" })]),
            ),
            state: Effect.flatMap(usersDb, (db) =>
              db.entities.Users.get({ id }).pipe(
                Effect.as(1),
                Effect.catchTag("ItemNotFound", () => Effect.succeed(0)),
              ),
            ),
          }
        },
        onRetry: "TransactionCancelled",
      },
      // One event, at version 0: one conditional Put.
      "EventStore.append": {
        operation: "PutItem",
        make: () => {
          const accountId = unique("account")
          return {
            write: Accounts.append({ accountId }, [new Opened({ owner: "o" })], 0),
            state: Effect.map(Accounts.read({ accountId }), (events) => events.length),
          }
        },
        onRetry: "VersionConflict",
      },
      "EventStore.commandHandler with a commandId": {
        operation: "TransactWriteItems",
        make: () => {
          const accountId = unique("account")
          const handle = EventStore.commandHandler(openAccount, Accounts, {
            idempotency: { ttl: Duration.days(1) },
          })
          return {
            write: handle({ accountId }, "o", { commandId: "command-1" }),
            state: Effect.map(Accounts.read({ accountId }), (events) => events.length),
          }
        },
        onRetry: "DuplicateCommand",
      },
    }

    for (const [name, { operation, make, onRetry }] of Object.entries(scenarios)) {
      it.live(`${name}, already applied: stays applied, and the retry says so`, () =>
        Effect.gen(function* () {
          const { seed, write, state } = make()
          if (seed !== undefined) yield* seed
          const proxy = yield* server(firstOf(operation, applyAndHang))
          yield* Effect.gen(function* () {
            yield* interruptWhen(proxy, operation, applied, write)
            // The conditional write settles it for a caller who needs to know.
            const retried = yield* Effect.flip(write)
            expect(retried._tag).toBe(onRetry)
          }).pipe(through(proxy))
          expect(yield* state).toBe(1)
        }).pipe(provide),
      )

      it.live(`${name}, not yet applied: isn't, and the retry succeeds`, () =>
        Effect.gen(function* () {
          const { seed, write, state } = make()
          if (seed !== undefined) yield* seed
          const proxy = yield* server(firstOf(operation, hang))
          yield* Effect.gen(function* () {
            yield* interruptWhen(proxy, operation, arrived, write)
            expect(yield* state).toBe(0)
            yield* write
          }).pipe(through(proxy))
          expect(yield* state).toBe(1)
        }).pipe(provide),
      )
    }

    it.live("a transactWrite update interrupted on its read writes nothing", () =>
      Effect.gen(function* () {
        const id = unique("user")
        const direct = yield* usersDb
        yield* direct.entities.Users.put({ id, name: "before" }).asEffect()
        const proxy = yield* server(firstOf("GetItem", hang))
        yield* Effect.gen(function* () {
          const db = yield* usersDb
          yield* interruptWhen(
            proxy,
            "GetItem",
            arrived,
            Transaction.transactWrite([db.entities.Users.update({ id }).set({ name: "after" })]),
          )
          expect(proxy.of("TransactWriteItems")).toHaveLength(0)
        }).pipe(through(proxy))
        expect(yield* direct.entities.Users.get({ id })).toMatchObject({ name: "before" })
      }).pipe(provide),
    )

    it.live("a transactWrite update, already applied, finds it did on its retry", () =>
      Effect.gen(function* () {
        const id = unique("user")
        const direct = yield* usersDb
        yield* direct.entities.Users.put({ id, name: "before" }).asEffect()
        const proxy = yield* server(firstOf("TransactWriteItems", applyAndHang))
        yield* Effect.gen(function* () {
          const db = yield* usersDb
          yield* interruptWhen(
            proxy,
            "TransactWriteItems",
            applied,
            Transaction.transactWrite([db.entities.Users.update({ id }).set({ name: "after" })]),
          )
        }).pipe(through(proxy))
        expect(yield* direct.entities.Users.get({ id })).toMatchObject({ name: "after" })
      }).pipe(provide),
    )
  })
})

const zOptions = { strategy: "precise", concurrency: 4 } as const
