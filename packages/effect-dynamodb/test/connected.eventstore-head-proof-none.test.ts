/**
 * Connected integration tests for `headProof: "none"` and the single-item
 * append fast path (#173) against a real DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Asserts on the requests sent and on the stored items: a `"none"` append
 * writes no contiguity check, and one event is a `PutItem`; a stale
 * `expectedVersion` is still a `VersionConflict` with nothing written, on
 * either path; after a seal written by a separate administrative transaction
 * (another stream's append carrying `appendOp` with `seal: true`), a writer
 * that read the stream before the seal gets `StreamSealed` from DynamoDB's own
 * `ALL_OLD` item, and a writer that read the seal finds it on the last event
 * it read — refusing then is its duty.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { StreamSealed, VersionConflict } from "@effect-dynamodb/schema/Errors.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as EventStore from "../src/EventStore.js"
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

const AppSchema = DynamoSchema.make({ name: "none-it", version: 1 })
const tableName = `head-proof-none-${Date.now()}`

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {
  reason: Schema.String,
}) {}
class Opened extends Schema.TaggedClass<Opened>()("Opened", {
  accountId: Schema.String,
}) {}

const NoneTable = Table.make({ schema: AppSchema, entities: {} })

/** An account's ledger. */
const Ledger = EventStore.makeStream({
  table: NoneTable,
  streamName: "Ledger",
  events: [Deposited, Closed],
  streamId: { composite: ["accountId"] },
})

/** The administrative stream whose append seals a ledger (`appendOp`). */
const Admin = EventStore.makeStream({
  table: NoneTable,
  streamName: "Admin",
  events: [Opened],
  streamId: { composite: ["adminId"] },
})

/** Every write request sent: `put` (with its item type) or `tx` (its item kinds). */
const requests: Array<string> = []
const kindOf = (item: Record<string, any>): string =>
  item.ConditionCheck !== undefined
    ? "check"
    : String(item.Put?.Item?.__edd_e__?.S ?? Object.keys(item)[0])

const LoggingClient = Layer.effect(
  DynamoClient,
  Effect.map(
    DynamoClient,
    (client): DynamoClientService => ({
      ...client,
      putItem: (input) => {
        requests.push(`put ${String(input.Item?.__edd_e__?.S)}`)
        return client.putItem(input)
      },
      transactWriteItems: (input) => {
        const items = (input.TransactItems ?? []) as ReadonlyArray<Record<string, any>>
        requests.push(`tx ${items.map(kindOf).join(",")}`)
        return client.transactWriteItems(input)
      },
    }),
  ),
).pipe(
  Layer.provide(
    DynamoClient.layer({
      region: "us-east-1",
      endpoint: ENDPOINT,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
  ),
)

const TestLayer = Layer.mergeAll(LoggingClient, NoneTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)

const deposit = (amount: number) => new Deposited({ amount })

/** The stream's versions, read strongly consistent. */
const versions = (accountId: string) =>
  Effect.map(Ledger.read({ accountId }, { consistentRead: true }), (events) =>
    events.map((event) => event.version),
  )

/**
 * The caller's side of the contract: the head from a consistent read of the
 * stream, refusing when the last event it read is sealed.
 */
const appendAtHead = (accountId: string, amount: number) =>
  Effect.gen(function* () {
    const read = yield* Ledger.read({ accountId }, { consistentRead: true })
    const last = read.at(-1)
    if (last?.sealed === true) {
      return yield* new StreamSealed({
        streamName: "Ledger",
        streamId: accountId,
        sealedVersion: last.version,
      })
    }
    return yield* Ledger.append({ accountId }, [deposit(amount)], last?.version ?? 0, {
      headProof: "none",
    })
  })

describeConnected('EventStore headProof: "none" and the single-item fast path (#173)', () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          // Streams only: no entity for `Table.definition` to read.
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
        })
      }).pipe(provide),
    )
  }, 15000)

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
  })

  it.effect("one event at version 0 is a PutItem; the stream reads back as written", () =>
    Effect.gen(function* () {
      const accountId = "fast-0"
      const mark = requests.length
      const result = yield* Ledger.append({ accountId }, [deposit(5)], 0)

      expect(result).toEqual({ version: 1, events: [deposit(5)] })
      expect(requests.slice(mark)).toEqual(["put ledger.event"])
      const [event] = yield* Ledger.read({ accountId }, { consistentRead: true })
      expect(event).toMatchObject({ version: 1, eventType: "Deposited", data: deposit(5) })
    }).pipe(provide),
  )

  it.effect(
    '"none" appends after version 0 with no check: one event a PutItem, more a transaction',
    () =>
      Effect.gen(function* () {
        const accountId = "none-1"
        const mark = requests.length
        yield* Ledger.append({ accountId }, [deposit(1)], 0)
        yield* Ledger.append({ accountId }, [deposit(2)], 1, { headProof: "none" })
        yield* Ledger.append({ accountId }, [deposit(3), deposit(4)], 2, { headProof: "none" })
        // Without the proof option, the check is written as before.
        yield* Ledger.append({ accountId }, [deposit(5)], 4)

        expect(requests.slice(mark)).toEqual([
          "put ledger.event",
          "put ledger.event",
          "tx ledger.event,ledger.event",
          "tx check,ledger.event",
        ])
        expect(yield* versions(accountId)).toEqual([1, 2, 3, 4, 5])
      }).pipe(provide),
  )

  it.effect(
    'a stale expectedVersion is a VersionConflict with "none", and nothing is written',
    () =>
      Effect.gen(function* () {
        const accountId = "none-stale"
        yield* Ledger.append({ accountId }, [deposit(1), deposit(2)], 0)

        // One event (a PutItem): its condition fails on the taken slot.
        const lone = yield* Ledger.append({ accountId }, [deposit(9)], 1, {
          headProof: "none",
        }).pipe(Effect.flip)
        expect(lone).toBeInstanceOf(VersionConflict)
        expect(lone).toMatchObject({
          streamName: "Ledger",
          streamId: accountId,
          expectedVersion: 1,
        })

        // Two events (a transaction): the same verdict.
        const pair = yield* Ledger.append({ accountId }, [deposit(9), deposit(9)], 0, {
          headProof: "none",
        }).pipe(Effect.flip)
        expect(pair).toBeInstanceOf(VersionConflict)
        expect(pair).toMatchObject({
          streamName: "Ledger",
          streamId: accountId,
          expectedVersion: 0,
        })

        expect(yield* versions(accountId)).toEqual([1, 2])
      }).pipe(provide),
  )

  it.effect("the caller's consistent read keeps every append contiguous", () =>
    Effect.gen(function* () {
      const accountId = "none-loop"
      for (let i = 1; i <= 4; i++) yield* appendAtHead(accountId, i)
      expect(yield* versions(accountId)).toEqual([1, 2, 3, 4])
    }).pipe(provide),
  )

  describe("a stream sealed by a separate administrative transaction", () => {
    /** Seal the ledger at `head + 1` through the admin stream's append. */
    const sealThrough = (accountId: string, head: number) =>
      Admin.append({ adminId: `admin-${accountId}` }, [new Opened({ accountId })], 0, {
        additionalItems: [
          Ledger.appendOp({ accountId }, [new Closed({ reason: "closed" })], head, { seal: true }),
        ],
      })

    it.effect("a writer that read the stream before the seal gets StreamSealed (PutItem)", () =>
      Effect.gen(function* () {
        const accountId = "seal-pre"
        yield* Ledger.append({ accountId }, [deposit(1), deposit(2)], 0)
        // The writer reads the head (2)…
        const head = (yield* Ledger.read({ accountId }, { consistentRead: true })).length
        // …then the stream is sealed at 3…
        yield* sealThrough(accountId, 2)

        // …and its one-event append lands on the sealing event: DynamoDB's
        // ALL_OLD returns the marked item from the PutItem's failed condition.
        const mark = requests.length
        const error = yield* Ledger.append({ accountId }, [deposit(3)], head, {
          headProof: "none",
        }).pipe(Effect.flip)
        expect(requests.slice(mark)).toEqual(["put ledger.event"])
        expect(error).toBeInstanceOf(StreamSealed)
        expect(error).toMatchObject({ streamName: "Ledger", streamId: accountId, sealedVersion: 3 })

        // Through a transaction (two events) the verdict is the same.
        const pair = yield* Ledger.append({ accountId }, [deposit(3), deposit(4)], head, {
          headProof: "none",
        }).pipe(Effect.flip)
        expect(pair).toBeInstanceOf(StreamSealed)
        expect(pair).toMatchObject({ sealedVersion: 3 })

        expect(yield* versions(accountId)).toEqual([1, 2, 3])
      }).pipe(provide),
    )

    it.effect("a writer that reads the seal refuses: the caller's duty", () =>
      Effect.gen(function* () {
        const accountId = "seal-post"
        yield* Ledger.append({ accountId }, [deposit(1)], 0)
        yield* sealThrough(accountId, 1)

        const mark = requests.length
        const error = yield* appendAtHead(accountId, 2).pipe(Effect.flip)
        expect(error).toBeInstanceOf(StreamSealed)
        expect(error).toMatchObject({ sealedVersion: 2 })
        // Refused before anything was sent.
        expect(requests.slice(mark)).toEqual([])

        // Without the caller's refusal nothing stops it: "none" writes no
        // check, so an append at the seal's version lands past it.
        yield* Ledger.append({ accountId }, [deposit(2)], 2, { headProof: "none" })
        expect(yield* versions(accountId)).toEqual([1, 2, 3])
        // The check, kept, refuses the same append.
        const checked = yield* Ledger.append(
          { accountId: "seal-post-checked" },
          [deposit(1)],
          0,
        ).pipe(
          Effect.andThen(() => sealThrough("seal-post-checked", 1)),
          Effect.andThen(() => Ledger.append({ accountId: "seal-post-checked" }, [deposit(2)], 2)),
          Effect.flip,
        )
        expect(checked).toBeInstanceOf(StreamSealed)
      }).pipe(provide),
    )
  })
})
