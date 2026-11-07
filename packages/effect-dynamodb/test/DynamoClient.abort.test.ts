/**
 * #190: the real SDK clients against a local HTTP server. An interrupt aborts the
 * request (the server sees the connection end, and no further attempt arrives), and
 * the layers pass the HTTP handler's options and `maxAttempts` to the SDK client, so
 * a call on a connection that never answers can end. No Docker.
 */

import { Readable } from "node:stream"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  Cause,
  Config,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Schema,
  Scope,
} from "effect"
import { vi } from "vitest"
import * as Batch from "../src/Batch.js"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import {
  classifyStreamsError,
  DynamoStreamsClient,
} from "../src/change-feed/DynamoStreamsClient.js"
import { classifyError, DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Capacity from "../src/internal/Capacity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { collectReports } from "./helpers/CapacityMock.js"
import {
  answer,
  awsFailure,
  hang,
  type LocalServer,
  localServer,
  passThrough,
  type SeenRequest,
} from "./helpers/LocalServer.js"

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const getItem = { TableName: "t", Key: { pk: { S: "a" }, sk: { S: "b" } } }

type ClientOptions = Omit<Parameters<typeof DynamoClient.layer>[0], "region" | "endpoint">

const clientOn = (server: LocalServer, options?: ClientOptions) =>
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: server.endpoint,
    credentials,
    ...options,
  } as Parameters<typeof DynamoClient.layer>[0])

const streamsOn = (
  server: LocalServer,
  options?: Omit<Parameters<typeof DynamoStreamsClient.layer>[0], "region" | "endpoint">,
) =>
  DynamoStreamsClient.layer({
    region: "us-east-1",
    endpoint: server.endpoint,
    credentials,
    ...options,
  })

/** Every SDK `send`'s promise: once one settles, its retry loop is over. */
const recordSends = Effect.acquireRelease(
  Effect.sync(() => {
    const sends: Array<Promise<unknown>> = []
    const original = DynamoDBClient.prototype.send as (...args: Array<unknown>) => Promise<unknown>
    const spy = vi.spyOn(DynamoDBClient.prototype, "send").mockImplementation(function (
      this: unknown,
      ...args: Array<unknown>
    ) {
      const sent = original.apply(this, args)
      sends.push(sent)
      return sent as never
    })
    return { sends, spy }
  }),
  ({ spy }) => Effect.sync(() => spy.mockRestore()),
)

/** What a settled `send` rejected with. */
const rejection = (sent: Promise<unknown>) =>
  Effect.promise(() =>
    sent.then(
      () => {
        throw new Error("the send succeeded")
      },
      (error: { readonly name?: string; readonly $metadata?: { readonly attempts?: number } }) =>
        error,
    ),
  )

const interruptedOnly = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)

const failureOf = (exit: Exit.Exit<unknown, unknown>): any =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: unknown } | undefined)?.error
    : undefined

// ---------------------------------------------------------------------------
// Interruption
// ---------------------------------------------------------------------------

describe("interrupting a call", () => {
  it.live("closes the connection, and no further attempt arrives", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      const { sends } = yield* recordSends
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const fiber = yield* Effect.forkChild(client.getItem(getItem))
        yield* server.until(() => server.requests.length === 1)
        const exit = yield* Fiber.await(yield* Effect.as(Fiber.interrupt(fiber), fiber))
        expect(interruptedOnly(exit)).toBe(true)
        yield* server.until(() => server.requests[0]!.connectionClosed)
        // The SDK's retry loop has ended on the abort, so nothing more can come of it.
        const error = yield* rejection(sends[0]!)
        expect(error.name).toBe("AbortError")
        expect(error.$metadata?.attempts).toBe(1)
        expect(server.requests).toHaveLength(1)
        expect(server.connections()).toBe(1)
      }).pipe(Effect.provide(clientOn(server)))
    }),
  )

  it.live("between attempts sends no further attempt", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      const { sends } = yield* recordSends
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const fiber = yield* Effect.forkChild(client.getItem(getItem))
        // The first attempt timed out; the SDK is backing off, or the next has just gone out.
        yield* server.until(() => server.requests[0]?.connectionClosed === true)
        const seenAtInterrupt = server.connections()
        yield* Fiber.interrupt(fiber)
        const error = yield* rejection(sends[0]!)
        expect(error.name).toBe("AbortError")
        expect(server.connections()).toBeLessThanOrEqual(seenAtInterrupt + 1)
      }).pipe(Effect.provide(clientOn(server, { requestHandler: { socketTimeout: 50 } })))
    }),
  )

  it.live("aborts the request of every DynamoClient operation", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const operations = Object.entries(client) as ReadonlyArray<
          [string, (input: unknown) => Effect.Effect<unknown, unknown>]
        >
        expect(operations.length).toBeGreaterThanOrEqual(30)
        for (const [index, [name, operation]] of operations.entries()) {
          const fiber = yield* Effect.forkChild(operation({ TableName: "t" }))
          yield* server.until(() => server.requests.length === index + 1)
          yield* Fiber.interrupt(fiber)
          yield* server.until(() => server.requests[index]!.connectionClosed)
          expect([name, server.requests[index]!.connectionClosed]).toEqual([name, true])
        }
      }).pipe(Effect.provide(clientOn(server)))
    }),
  )

  it.live("aborts the request of every DynamoStreamsClient operation", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoStreamsClient
        const operations = Object.entries(client) as ReadonlyArray<
          [string, (input: unknown) => Effect.Effect<unknown, unknown>]
        >
        expect(operations.map(([name]) => name).sort()).toEqual([
          "describeStream",
          "getRecords",
          "getShardIterator",
          "listStreams",
        ])
        for (const [index, [name, operation]] of operations.entries()) {
          const fiber = yield* Effect.forkChild(
            operation({
              StreamArn: "arn",
              ShardId: "s",
              ShardIterator: "i",
              ShardIteratorType: "LATEST",
            }),
          )
          yield* server.until(() => server.requests.length === index + 1)
          yield* Fiber.interrupt(fiber)
          yield* server.until(() => server.requests[index]!.connectionClosed)
          expect([name, server.requests[index]!.connectionClosed]).toEqual([name, true])
        }
      }).pipe(Effect.provide(streamsOn(server)))
    }),
  )

  it.live("through Effect.timeout, ends the request and fails with the timeout alone", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const exit = yield* client.getItem(getItem).pipe(Effect.timeout("30 millis"), Effect.exit)
        expect(failureOf(exit)?._tag).toBe("TimeoutError")
        yield* server.until(() => server.connections() === 1)
        yield* server.until(() => server.requests[0]?.connectionClosed === true)
      }).pipe(Effect.provide(clientOn(server)))
    }),
  )

  it.live("a sibling's failure aborts the other request, and only the failure surfaces", () =>
    Effect.gen(function* () {
      const server = yield* localServer((request) =>
        request.operation === "PutItem"
          ? awsFailure(400, "ValidationException", "refused")
          : request.operation === "GetItem"
            ? hang
            : passThrough,
      )
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const exit = yield* Effect.all(
          [
            client.getItem(getItem),
            Effect.andThen(
              server.until(() => server.of("GetItem").length === 1),
              client.putItem({ TableName: "t", Item: { pk: { S: "a" } } }),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.exit)
        expect(failureOf(exit)?._tag).toBe("DynamoValidationError")
        expect(failureOf(exit)?.operation).toBe("PutItem")
        yield* server.until(() => server.of("GetItem")[0]!.connectionClosed)
      }).pipe(Effect.provide(clientOn(server)))
    }),
  )
})

// ---------------------------------------------------------------------------
// Batch retries
// ---------------------------------------------------------------------------

describe("interrupting a batch while it retries what DynamoDB left unprocessed", () => {
  const Plain = Entity.make({
    model: Schema.Struct({ id: Schema.String }),
    entityType: "Plain",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const MainTable = Table.make({
    schema: DynamoSchema.make({ name: "abort", version: 1 }),
    entities: { Plain },
  })
  const bound = DynamoClient.make({ entities: { Plain } })

  const operations = {
    "Batch.write": {
      operation: "BatchWriteItem",
      left: (request: SeenRequest) => ({
        UnprocessedItems: JSON.parse(request.body).RequestItems,
      }),
      run: Effect.flatMap(bound, (db) => Batch.write([db.entities.Plain.put({ id: "1" })])),
    },
    "Batch.get": {
      operation: "BatchGetItem",
      left: (request: SeenRequest) => ({
        Responses: { t: [] },
        UnprocessedKeys: JSON.parse(request.body).RequestItems,
      }),
      run: Effect.flatMap(bound, (db) => Batch.get([db.entities.Plain.get({ id: "1" })])),
    },
  } as const

  for (const [name, { operation, left, run }] of Object.entries(operations)) {
    const on = (server: LocalServer) =>
      Effect.provide(Layer.merge(clientOn(server), MainTable.layer({ name: "t" })))

    it.live(`${name}: on its retry closes the connection, and stops there`, () =>
      Effect.gen(function* () {
        const server = yield* localServer((request) =>
          request.operation === operation && request.number === 1
            ? answer(200, JSON.stringify(left(request)))
            : hang,
        )
        yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(run as Effect.Effect<unknown, unknown, never>)
          yield* server.until(() => server.requests.length === 2)
          yield* Fiber.interrupt(fiber)
          expect(interruptedOnly(yield* Fiber.await(fiber))).toBe(true)
          yield* server.until(() => server.requests[1]!.connectionClosed)
          expect(server.requests).toHaveLength(2)
        }).pipe(on(server))
      }),
    )

    it.live(`${name}: during its backoff sends nothing more`, () =>
      Effect.gen(function* () {
        const server = yield* localServer((request) => answer(200, JSON.stringify(left(request))))
        yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(run as Effect.Effect<unknown, unknown, never>)
          yield* server.until(() => server.requests[0]?.answered === true)
          yield* Fiber.interrupt(fiber)
          expect(interruptedOnly(yield* Fiber.await(fiber))).toBe(true)
          // At most what was already on its way when the interrupt landed.
          const seen = server.requests.length
          yield* server.until(() => server.requests.every((request) => request.answered))
          expect(server.requests.length).toBe(seen)
        }).pipe(on(server))
      }),
    )
  }
})

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

describe("the handler's timeouts", () => {
  it.live("socketTimeout fails with a TimeoutError-caused error after its attempts", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const exit = yield* Effect.exit(client.getItem(getItem))
        const error = failureOf(exit)
        expect(error?._tag).toBe("DynamoError")
        expect(error?.operation).toBe("GetItem")
        expect(error?.cause?.name).toBe("TimeoutError")
        // The SDK's default: the call has ended, so these are all the attempts there are.
        expect(error?.cause?.$metadata?.attempts).toBe(3)
        yield* server.until(() => server.connections() === 3)
      }).pipe(Effect.provide(clientOn(server, { requestHandler: { socketTimeout: 100 } })))
    }),
  )

  it.live("maxAttempts bounds them", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const error = failureOf(yield* Effect.exit(client.getItem(getItem)))
        expect(error?.cause?.name).toBe("TimeoutError")
        expect(error?.cause?.$metadata?.attempts).toBe(2)
        yield* server.until(() => server.connections() === 2)
      }).pipe(
        Effect.provide(clientOn(server, { requestHandler: { socketTimeout: 50 }, maxAttempts: 2 })),
      )
    }),
  )

  it.live("requestTimeout with throwOnRequestTimeout fails the same way", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const error = failureOf(yield* Effect.exit(client.getItem(getItem)))
        expect(error?._tag).toBe("DynamoError")
        expect(error?.cause?.name).toBe("TimeoutError")
        expect(error?.cause?.code).toBe("ETIMEDOUT")
        expect(error?.cause?.$metadata?.attempts).toBe(1)
      }).pipe(
        Effect.provide(
          clientOn(server, {
            requestHandler: { requestTimeout: 50, throwOnRequestTimeout: true },
            maxAttempts: 1,
          }),
        ),
      )
    }),
  )

  it.live("requestTimeout alone only logs a warning on Node's handler", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      const warned = yield* Deferred.make<string>()
      const logger = {
        debug: () => {},
        info: () => {},
        warn: (message: unknown) => Deferred.doneUnsafe(warned, Exit.succeed(String(message))),
        error: () => {},
      }
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const fiber = yield* Effect.forkChild(client.getItem(getItem))
        expect(yield* Deferred.await(warned)).toContain("requestTimeout")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(fiber)
        yield* server.until(() => server.requests[0]?.connectionClosed === true)
      }).pipe(Effect.provide(clientOn(server, { requestHandler: { requestTimeout: 30, logger } })))
    }),
  )

  it.live("the streams client takes them too", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoStreamsClient
        const error = failureOf(yield* Effect.exit(client.listStreams({})))
        expect(error?._tag).toBe("DynamoError")
        expect(error?.operation).toBe("ListStreams")
        expect(error?.cause?.name).toBe("TimeoutError")
        expect(error?.cause?.$metadata?.attempts).toBe(2)
      }).pipe(
        Effect.provide(
          streamsOn(server, { requestHandler: { socketTimeout: 50 }, maxAttempts: 2 }),
        ),
      )
    }),
  )

  describe("reach every write path as the failure they are", () => {
    const AppSchema = DynamoSchema.make({ name: "abort", version: 1 })
    class Opened extends Schema.TaggedClass<Opened>()("Opened", { owner: Schema.String }) {}
    const Users = Entity.make({
      model: Schema.Struct({ id: Schema.String, email: Schema.String }),
      entityType: "User",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
      unique: { email: ["email"] },
    })
    const EventsTable = Table.make({ schema: AppSchema, entities: {} })
    const Accounts = EventStore.makeStream({
      table: EventsTable,
      streamName: "Account",
      events: [Opened],
      streamId: { composite: ["accountId"] },
    })
    const Plain = Entity.make({
      model: Schema.Struct({ id: Schema.String }),
      entityType: "Plain",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const MainTable = Table.make({ schema: AppSchema, entities: { Users, Plain } })

    const writes = {
      "Entity.create": Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Users } })
        return yield* db.entities.Users.create({ id: "1", email: "a@b" }).asEffect()
      }),
      "Entity.delete": Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Users } })
        return yield* db.entities.Users.delete({ id: "1" }).asEffect()
      }),
      "Transaction.transactWrite": Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Users } })
        return yield* Transaction.transactWrite([db.entities.Users.put({ id: "1", email: "a@b" })])
      }),
      // Planned: its read is what times out, recorded writes never reach the wire.
      "Transaction.transactWrite of an update": Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Users } })
        return yield* Transaction.transactWrite([
          db.entities.Users.update({ id: "1" }).set({ email: "c@d" }),
        ])
      }),
      "Batch.write": Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Plain } })
        return yield* Batch.write([db.entities.Plain.put({ id: "1" })])
      }),
      "EventStore.append": Accounts.append({ accountId: "a" }, [new Opened({ owner: "o" })], 0),
    }

    for (const [name, write] of Object.entries(writes)) {
      it.live(name, () =>
        Effect.gen(function* () {
          const server = yield* localServer(() => hang)
          const exit = yield* Effect.exit(write as Effect.Effect<unknown, unknown, never>).pipe(
            Effect.provide(
              Layer.mergeAll(
                clientOn(server, { requestHandler: { socketTimeout: 30 }, maxAttempts: 1 }),
                MainTable.layer({ name: "t" }),
                EventsTable.layer({ name: "t" }),
              ),
            ),
          )
          const error = failureOf(exit)
          expect(error?._tag).toBe("DynamoError")
          expect(error?.cause?.name).toBe("TimeoutError")
          expect(server.requests.length).toBeLessThanOrEqual(1)
        }),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classifying a timeout or an abort", () => {
  const errors = {
    socket: Object.assign(new Error("the request socket timed out"), { name: "TimeoutError" }),
    request: Object.assign(new Error("exceeded requestTimeout"), {
      name: "TimeoutError",
      code: "ETIMEDOUT",
    }),
    abort: Object.assign(new Error("Request aborted"), { name: "AbortError" }),
    closed: Object.assign(new Error("closed"), { name: "ClientClosedError" }),
  }
  for (const [name, error] of Object.entries(errors)) {
    it(`${name} is a DynamoError keeping the SDK's error, from both clients`, () => {
      for (const classified of [classifyError("Op")(error), classifyStreamsError("Op")(error)]) {
        expect(classified._tag).toBe("DynamoError")
        expect(classified.cause).toBe(error)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// The layers' options
// ---------------------------------------------------------------------------

describe("the layers' options", () => {
  /** An HTTP handler answering everything with `{}`, whatever the runtime. */
  const fakeHandler = () => {
    const signals: Array<AbortSignal | undefined> = []
    let destroyed = 0
    return {
      signals,
      destroyed: () => destroyed,
      handler: {
        metadata: { handlerProtocol: "http/1.1" },
        handle: (_request: unknown, options?: { readonly abortSignal?: AbortSignal }) => {
          signals.push(options?.abortSignal)
          return Promise.resolve({
            response: { statusCode: 200, headers: {}, body: Readable.from([Buffer.from("{}")]) },
          })
        },
        destroy: () => {
          destroyed++
        },
        updateHttpClientConfig: () => {},
        httpHandlerConfigs: () => ({}),
      },
    }
  }

  it.live("a handler instance is used as given, and destroyed with the layer", () =>
    Effect.gen(function* () {
      const fake = fakeHandler()
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        expect(yield* client.getItem(getItem)).toMatchObject({})
      }).pipe(
        Effect.provide(
          DynamoClient.layer({
            region: "us-east-1",
            endpoint: "http://127.0.0.1:1",
            credentials,
            requestHandler: fake.handler as never,
          }),
        ),
      )
      expect(fake.signals).toHaveLength(1)
      expect(fake.signals[0]).toBeInstanceOf(AbortSignal)
      expect(fake.destroyed()).toBe(1)
    }),
  )

  it.live("the streams layer uses one too", () =>
    Effect.gen(function* () {
      const fake = fakeHandler()
      yield* Effect.gen(function* () {
        const client = yield* DynamoStreamsClient
        yield* client.listStreams({})
      }).pipe(
        Effect.provide(
          DynamoStreamsClient.layer({
            region: "us-east-1",
            endpoint: "http://127.0.0.1:1",
            credentials,
            requestHandler: fake.handler as never,
          }),
        ),
      )
      expect(fake.signals[0]).toBeInstanceOf(AbortSignal)
      expect(fake.destroyed()).toBe(1)
    }),
  )

  const withEntries = (entries: Record<string, unknown>) =>
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(entries)))

  it.live("layerConfig reads the timeouts and maxAttempts through Config", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const error = failureOf(yield* Effect.exit(client.getItem(getItem)))
        expect(error?.cause?.name).toBe("TimeoutError")
        expect(error?.cause?.message).toContain("50 ms")
        expect(error?.cause?.$metadata?.attempts).toBe(2)
      }).pipe(
        Effect.provide(
          DynamoClient.layerConfig({
            region: Config.String("REGION"),
            endpoint: Config.String("ENDPOINT"),
            credentials: Config.succeed(credentials),
            requestHandler: {
              socketTimeout: Config.Int("SOCKET_TIMEOUT"),
              requestTimeout: Config.Int("REQUEST_TIMEOUT"),
            },
            maxAttempts: Config.Int("MAX_ATTEMPTS"),
          }),
        ),
        withEntries({
          REGION: "us-east-1",
          ENDPOINT: server.endpoint,
          SOCKET_TIMEOUT: "50",
          MAX_ATTEMPTS: "2",
        }),
      )
    }),
  )

  it.live("layerConfig reads throwOnRequestTimeout as a boolean", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        const error = failureOf(yield* Effect.exit(client.getItem(getItem)))
        expect(error?.cause?.code).toBe("ETIMEDOUT")
      }).pipe(
        Effect.provide(
          DynamoClient.layerConfig({
            region: Config.succeed("us-east-1"),
            endpoint: Config.succeed(server.endpoint),
            credentials: Config.succeed(credentials),
            requestHandler: {
              requestTimeout: Config.Int("REQUEST_TIMEOUT"),
              throwOnRequestTimeout: Config.Boolean("THROW"),
            },
            maxAttempts: Config.succeed(1),
          }),
        ),
        withEntries({ REQUEST_TIMEOUT: "50", THROW: "true" }),
      )
    }),
  )

  it.live("layerConfig leaves what the provider doesn't hold unset", () =>
    Effect.gen(function* () {
      const server = yield* localServer()
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.getItem(getItem)
      }).pipe(
        Effect.provide(
          DynamoClient.layerConfig({
            region: Config.succeed("us-east-1"),
            endpoint: Config.succeed(server.endpoint),
            credentials: Config.succeed(credentials),
            requestHandler: { socketTimeout: Config.Int("MISSING_TIMEOUT") },
            maxAttempts: Config.Int("MISSING_ATTEMPTS"),
          }),
        ),
        withEntries({}),
      )
      expect(server.requests).toHaveLength(1)
    }),
  )

  it.effect("layerConfig fails on a value that doesn't parse", () =>
    Effect.gen(function* () {
      const build = (config: Partial<Parameters<typeof DynamoClient.layerConfig>[0]>) =>
        Effect.void.pipe(
          Effect.provide(
            DynamoClient.layerConfig({ region: Config.succeed("us-east-1"), ...config }),
          ),
          Effect.flip,
          withEntries({ BAD: "soon" }),
        )
      const handler = yield* build({ requestHandler: { socketTimeout: Config.Int("BAD") } })
      expect(handler._tag).toBe("ConfigError")
      const attempts = yield* build({ maxAttempts: Config.Int("BAD") })
      expect(attempts._tag).toBe("ConfigError")
    }),
  )

  it.live("layerConfig takes a handler instance as itself", () =>
    Effect.gen(function* () {
      const fake = fakeHandler()
      yield* Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.getItem(getItem)
      }).pipe(
        Effect.provide(
          DynamoClient.layerConfig({
            region: Config.succeed("us-east-1"),
            endpoint: Config.succeed("http://127.0.0.1:1"),
            credentials: Config.succeed(credentials),
            requestHandler: fake.handler as never,
          }),
        ),
      )
      expect(fake.signals).toHaveLength(1)
    }),
  )

  it.live("the streams layerConfig reads them too", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      yield* Effect.gen(function* () {
        const client = yield* DynamoStreamsClient
        const error = failureOf(yield* Effect.exit(client.listStreams({})))
        expect(error?.cause?.name).toBe("TimeoutError")
        expect(error?.cause?.$metadata?.attempts).toBe(1)
      }).pipe(
        Effect.provide(
          DynamoStreamsClient.layerConfig({
            region: Config.succeed("us-east-1"),
            endpoint: Config.succeed(server.endpoint),
            credentials: Config.succeed(credentials),
            requestHandler: { socketTimeout: Config.Int("SOCKET_TIMEOUT") },
            maxAttempts: Config.Int("MAX_ATTEMPTS"),
          }),
        ),
        withEntries({ SOCKET_TIMEOUT: "50", MAX_ATTEMPTS: "1" }),
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// The layer's scope closing
// ---------------------------------------------------------------------------

describe("a request in flight when the layer closes", () => {
  /** The client of a layer built in its own scope, and a way to close that scope. */
  const scopedClient = <S>(layer: Layer.Layer<S>, tag: { readonly key: string }) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(layer, scope)
      return {
        client: context.mapUnsafe.get(tag.key) as S extends DynamoClient
          ? DynamoClientService
          : never,
        close: Scope.close(scope, Exit.void),
      }
    })

  it.live("makes no further attempt once the client is destroyed, and fails", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      const { client, close } = yield* scopedClient(clientOn(server), DynamoClient)
      // A fiber that outlives the layer: nothing interrupts its request.
      const fiber = yield* Effect.forkDetach(client.getItem(getItem))
      yield* server.until(() => server.requests.length === 1)
      yield* close
      yield* server.until(() => server.requests[0]!.connectionClosed)
      const error = failureOf(yield* Fiber.await(fiber))
      expect(error?._tag).toBe("DynamoError")
      expect(error?.cause?.name).toBe("ClientClosedError")
      expect(server.connections()).toBe(1)
    }),
  )

  it.live("a fiber interrupted first has aborted already, and nothing else surfaces", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      const { client, close } = yield* scopedClient(clientOn(server), DynamoClient)
      const fiber = yield* Effect.forkDetach(client.getItem(getItem))
      yield* server.until(() => server.requests.length === 1)
      yield* Fiber.interrupt(fiber)
      yield* close
      yield* server.until(() => server.requests[0]!.connectionClosed)
      expect(interruptedOnly(yield* Fiber.await(fiber))).toBe(true)
      expect(server.connections()).toBe(1)
    }),
  )

  it.live("a request sent after the close still goes out", () =>
    Effect.gen(function* () {
      const server = yield* localServer()
      const { client, close } = yield* scopedClient(clientOn(server), DynamoClient)
      yield* close
      yield* client.getItem(getItem)
      expect(server.requests).toHaveLength(1)
    }),
  )
})

// ---------------------------------------------------------------------------
// Consumed capacity
// ---------------------------------------------------------------------------

describe("consumed capacity of an interrupted request", () => {
  const reporting = () => {
    const { reports, onOperation } = collectReports()
    return { reports, layer: ConsumedCapacity.layer({ onOperation, spans: false }) }
  }

  it.live("counts it once, as a request with nothing reported, under one report", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      const { reports, layer } = reporting()
      yield* Effect.gen(function* () {
        const client = yield* Capacity.client
        const fiber = yield* Effect.forkChild(client.getItem(getItem))
        yield* server.until(() => server.requests.length === 1)
        yield* Fiber.interrupt(fiber)
        yield* server.until(() => server.requests[0]!.connectionClosed)
      }).pipe(Effect.provide(Layer.merge(clientOn(server), layer)))
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "DynamoClient.GetItem",
        outcome: "interrupted",
        requests: 1,
        unreportedRequests: 1,
        capacityUnits: 0,
        requestsByCommand: { GetItem: 1 },
      })
    }),
  )

  it.live("an operation's interrupted request adds to what it already counted", () =>
    Effect.gen(function* () {
      const server = yield* localServer((request) =>
        request.operation === "GetItem" ? hang : passThrough,
      )
      const { reports, layer } = reporting()
      const Items = Entity.make({
        model: Schema.Struct({ id: Schema.String }),
        entityType: "Item",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      })
      const MainTable = Table.make({
        schema: DynamoSchema.make({ name: "abort", version: 1 }),
        entities: { Items },
      })
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Items } })
        const fiber = yield* Effect.forkChild(db.entities.Items.get({ id: "1" }))
        yield* server.until(() => server.requests.length === 1)
        yield* Fiber.interrupt(fiber)
      }).pipe(
        Effect.provide(Layer.mergeAll(clientOn(server), layer, MainTable.layer({ name: "t" }))),
      )
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Entity.get",
        outcome: "interrupted",
        requests: 1,
        unreportedRequests: 1,
      })
    }),
  )

  it.live("a request aborted by a sibling's failure is counted beside it", () =>
    Effect.gen(function* () {
      const server = yield* localServer((request) =>
        request.operation === "PutItem" ? awsFailure(400, "ValidationException", "refused") : hang,
      )
      const { reports, layer } = reporting()
      yield* Effect.gen(function* () {
        const client = yield* Capacity.client
        yield* Effect.all(
          [
            client.getItem(getItem),
            Effect.andThen(
              server.until(() => server.of("GetItem").length === 1),
              client.putItem({ TableName: "t", Item: { pk: { S: "a" } } }),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.exit)
      }).pipe(Effect.provide(Layer.merge(clientOn(server), layer)))
      expect(
        reports.map((r) => [r.operation, r.outcome, r.requests, r.unreportedRequests]),
      ).toEqual(
        expect.arrayContaining([
          ["DynamoClient.GetItem", "interrupted", 1, 1],
          ["DynamoClient.PutItem", "failure", 1, 1],
        ]),
      )
      expect(reports).toHaveLength(2)
    }),
  )

  it.live("a timeout counts as one request whatever the SDK's attempts", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      const { reports, layer } = reporting()
      yield* Effect.gen(function* () {
        const client = yield* Capacity.client
        yield* Effect.exit(client.getItem(getItem))
      }).pipe(
        Effect.provide(
          Layer.merge(
            clientOn(server, { requestHandler: { socketTimeout: 30 }, maxAttempts: 2 }),
            layer,
          ),
        ),
      )
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({ outcome: "failure", requests: 1, unreportedRequests: 1 })
    }),
  )

  it.live("a retried operation counts each try and is not charged after it stops", () =>
    Effect.gen(function* () {
      const server = yield* localServer(() => hang)
      const { reports, layer } = reporting()
      yield* Effect.gen(function* () {
        const client = yield* Capacity.client
        const tries = yield* Effect.exit(
          Effect.retry(client.getItem(getItem).pipe(Effect.timeout("20 millis")), {
            schedule: Schedule.recurs(2),
          }),
        )
        expect(failureOf(tries)?._tag).toBe("TimeoutError")
      }).pipe(Effect.provide(Layer.merge(clientOn(server), layer)))
      expect(reports.map((r) => [r.outcome, r.requests])).toEqual([
        ["interrupted", 1],
        ["interrupted", 1],
        ["interrupted", 1],
      ])
      yield* server.until(() => server.connections() === 3)
    }),
  )
})
