/**
 * EventStore offloaded storage (#179, design §6.10, §8, §10.2, §10.5, §13):
 * event `data` and snapshot `state` declared `DynamoModel.Packed({ external })`
 * — the writes (append, `offload.itemBudget` / `prefix`, a failed upload, a
 * replayed idempotent append, the inline snapshot, `writeSnapshot`,
 * `commandHandler`'s retries, `measureAppend`), every read path eager by
 * default and lazy on request (a sealed stream's and a `"keys"` GSI's
 * included), raw rows, stream images and the change-feed surface lazy by
 * default — each projection decoded in its own mode, store failures reported
 * and never skipped — and the `[EDD-9115]` bind and first-operation checks.
 *
 * Requests go to the in-memory tables (`helpers/InMemoryTables.ts`), with
 * the stored item DynamoDB returns on a `ConditionalCheckFailedException`
 * that asked for `ALL_OLD`; objects land in the in-memory blob store, whose
 * call counts say what was uploaded, fetched and deleted.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Effect, Exit, Layer, Logger, Option, References, Schema, Stream } from "effect"
import { beforeEach } from "vitest"
import { BlobStore } from "../src/BlobStore.js"
import type { ChangeFeedBatch, ChangeFeedRecord } from "../src/change-feed/ChangeFeed.js"
import { runChangeFeed } from "../src/change-feed/ChangeFeed.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { objectKey, STREAM_FAMILY_SK } from "../src/internal/BlobKeys.js"
import { itemBytes } from "../src/internal/ItemSize.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import { isOffloadedValue, type OffloadedValue } from "../src/Offload.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import {
  InMemoryClient,
  type Item,
  keyOf,
  rejection,
  resetStore,
  store as rows,
  tableIndexes,
} from "./helpers/InMemoryTables.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Offloading requires escaped key text (`[EDD-9146]`, design §11.10). */
const AppSchema = DynamoSchema.make({ name: "evo", version: 1, escapeKeys: true })
const TABLE = "events"

class Filed extends Schema.TaggedClass<Filed>()("Filed", { note: Schema.String }) {}
class Tagged extends Schema.TaggedClass<Tagged>()("Tagged", { tag: Schema.String }) {}
type CaseEvent = Filed | Tagged

const CaseState = Schema.Struct({ notes: Schema.Array(Schema.String) })
type CaseState = typeof CaseState.Type

/** Offloaded at 256 bytes of JSON or more. */
const overflow = DynamoModel.Packed({ format: "json", external: { threshold: 256 } })

/** An offloading entity on the same table: an append's additional item. */
const Attachments = Entity.make({
  model: DynamoModel.configure(
    Schema.Struct({ caseId: Schema.String, body: Schema.Struct({ text: Schema.String }) }),
    { body: { storedAs: overflow } },
  ),
  entityType: "CaseAttachment",
  primaryKey: { pk: { field: "pk", composite: ["caseId"] }, sk: { field: "sk", composite: [] } },
})

const EventsTable = Table.make({ schema: AppSchema, entities: { Attachments } })

/** Event data and the inline snapshot's state offload. */
const Cases = EventStore.makeStream({
  table: EventsTable,
  streamName: "Case",
  events: [Filed, Tagged],
  streamId: { composite: ["caseId"] },
  storedAs: { data: overflow },
  snapshot: { schema: CaseState, mode: "inline", storedAs: overflow },
})

/** Only the snapshot's state offloads (written by `writeSnapshot`). */
const Dossiers = EventStore.makeStream({
  table: EventsTable,
  streamName: "Dossier",
  events: [Filed, Tagged],
  streamId: { composite: ["caseId"] },
  snapshot: { schema: CaseState, mode: "after-append", storedAs: overflow },
})

/** Event data offloads; an LSI over every event. */
const Indexed = EventStore.makeStream({
  table: EventsTable,
  streamName: "Indexed",
  events: [Filed, Tagged],
  streamId: { composite: ["caseId"] },
  storedAs: { data: overflow },
  indexes: {
    byVersion: {
      index: "lsi1",
      sk: "lsi1sk",
      key: (_event: CaseEvent, version: number) => String(version).padStart(4, "0"),
    },
  },
})

/**
 * Thresholds no test value reaches: `offload.itemBudget` alone offloads, per
 * event item and per snapshot item, under `offload.prefix`.
 */
const lenient = DynamoModel.Packed({ format: "json", external: {} })
const Budgeted = EventStore.makeStream({
  table: EventsTable,
  streamName: "Budgeted",
  events: [Filed, Tagged],
  streamId: { composite: ["caseId"] },
  storedAs: { data: lenient },
  snapshot: { schema: CaseState, mode: "inline", storedAs: lenient },
  offload: { itemBudget: 1_000, prefix: "cases/" },
})

/** Event data offloads; a `"keys"` GSI, whose events are fetched from the table. */
const KeyIndexed = EventStore.makeStream({
  table: EventsTable,
  streamName: "KeyIndexed",
  events: [Filed, Tagged],
  streamId: { composite: ["caseId"] },
  storedAs: { data: overflow },
  indexes: {
    byVersionKeys: {
      type: "gsi",
      index: "gsi2",
      pk: "gsi2pk",
      sk: "gsi2sk",
      projection: "keys",
      key: (_event: CaseEvent, version: number) => String(version).padStart(4, "0"),
    },
  },
})

const id = { caseId: "c-1" }
/** A note whose event JSON is well over the threshold. */
const LONG = "the quick brown fox jumps over the lazy dog; ".repeat(20)
const filed = (note: string) => new Filed({ note })
const bigState = (n: number): CaseState => ({ notes: Array.from({ length: n }, () => LONG) })

const decider: EventStore.Decider<CaseState, { readonly note: string }, CaseEvent> = {
  initialState: { notes: [] },
  decide: (command) => Effect.succeed([filed(command.note)]),
  evolve: (state, event) =>
    event._tag === "Filed" ? { notes: [...state.notes, event.note] } : state,
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * The in-memory tables, with what DynamoDB adds on a conditional write that
 * fails: the stored item when the request asked for `ALL_OLD`.
 */
const SpyClient = Layer.effect(
  DynamoClient,
  Effect.map(
    Effect.service(DynamoClient),
    (inner): DynamoClientService => ({
      ...inner,
      putItem: (input) => {
        const old = rows.get(keyOf(input.TableName!, input.Item!))
        return inner.putItem(input).pipe(
          Effect.mapError((error) => {
            const cause = (error as { readonly cause?: { readonly name?: string } }).cause
            if (
              cause?.name === "ConditionalCheckFailedException" &&
              input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" &&
              old !== undefined
            ) {
              Object.assign(cause, { Item: old })
            }
            return error
          }),
        )
      },
    }),
  ),
).pipe(Layer.provide(InMemoryClient))

/** The attributes `gsi2` (a `"keys"` index) projects. */
const GSI2_ATTRIBUTES = ["pk", "sk", "gsi2pk", "gsi2sk", "__edd_e__"]

/**
 * `SpyClient`, with `gsi2` returning only the attributes it projects and
 * `BatchGetItem` reading the table — the fetch a `"keys"` GSI's events take.
 */
const KeysIndexClient = Layer.effect(
  DynamoClient,
  Effect.map(
    Effect.service(DynamoClient),
    (inner): DynamoClientService => ({
      ...inner,
      query: (input) =>
        input.IndexName !== "gsi2"
          ? inner.query(input)
          : Effect.map(inner.query(input), (page) => ({
              ...page,
              Items: (page.Items ?? []).map((item) =>
                Object.fromEntries(
                  Object.entries(item).filter(([name]) => GSI2_ATTRIBUTES.includes(name)),
                ),
              ),
            })),
      batchGetItem: (input) =>
        Effect.sync(
          () =>
            ({
              Responses: Object.fromEntries(
                Object.entries(input.RequestItems ?? {}).map(([table, request]) => [
                  table,
                  (request.Keys ?? []).flatMap((key) => {
                    const item = rows.get(keyOf(table, key))
                    return item === undefined ? [] : [item]
                  }),
                ]),
              ),
              UnprocessedKeys: {},
            }) as never,
        ),
    }),
  ),
).pipe(Layer.provide(SpyClient))

const tableLayer = EventsTable.layer({ name: TABLE })
/** The streams' indexes, as `EventStore.indexDefinitions` emits them (`gsi2`'s projection is `KeysIndexClient`'s). */
tableIndexes.set(TABLE, {
  lsi1: { pk: "pk", sk: "lsi1sk" },
  gsi2: { pk: "gsi2pk", sk: "gsi2sk", kind: "global" },
})
let blobs: MemoryBlobStore = BlobStore.memory()

/** The client, the table and the in-memory store `blobs`. */
const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    effect.pipe(Effect.provide(Layer.mergeAll(SpyClient, tableLayer, BlobStore.layer(blobs)))),
  )
/** The client and the table, no store. */
const withoutStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(SpyClient, tableLayer)))

beforeEach(() => {
  resetStore()
  blobs = BlobStore.memory()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const calls = () => blobs.inspect().calls
const versions = () => blobs.inspect().versions

const eventRows = (entityType = "case.event"): Array<Item> =>
  [...rows.values()]
    .filter((item) => item.__edd_e__?.S === entityType)
    .sort((a, b) => (a.sk!.S! < b.sk!.S! ? -1 : 1))
const snapshotRow = (entityType = "case.snapshot"): Item | undefined =>
  [...rows.values()].find((item) => item.__edd_e__?.S === entityType)

/** An overflow attribute's stored pointer (`B`). */
const pointerOf = (value: AttributeValue | undefined): BlobPointer.BlobPointer => {
  expect(value?.B).toBeInstanceOf(Uint8Array)
  const pointer = BlobPointer.decode(value!.B!)
  if (typeof pointer === "string") throw new Error(pointer)
  expect(pointer.kind).toBe("json")
  return pointer
}
const isPointer = (value: AttributeValue | undefined): boolean =>
  value?.B !== undefined && BlobPointer.isPointerHeader(value.B[0]!)

/** The object key of a stream row's attribute (design §4.5: the stream is the family). */
const keyFor = (row: Item, attribute: string) =>
  objectKey("", {
    table: TABLE,
    pk: { S: row.pk!.S! },
    familySk: STREAM_FAMILY_SK,
    rowSk: { S: row.sk!.S! },
    attribute,
  })

const defectOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a defect")
  const reason = exit.cause.reasons.find((r) => r._tag === "Die")
  if (reason === undefined || reason._tag !== "Die") throw new Error("expected a Die reason")
  return String((reason.defect as Error).message ?? reason.defect)
}

/** Two events — a short one (inline) and a long one (offloaded) — and an inline snapshot. */
const seed = Effect.gen(function* () {
  yield* Cases.append(id, [filed("short"), filed(LONG)], 0, { snapshot: bigState(1) })
})

const recordsOf = (items: ReadonlyArray<Item>) =>
  items.map((item, i) => ({
    eventName: "INSERT",
    dynamodb: { SequenceNumber: String(i + 1).padStart(4, "0"), NewImage: item as never },
  }))

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe("EventStore offload — append", () => {
  it.effect("offloads event data at or over its threshold, keyed per event item", () =>
    withStore(
      Effect.gen(function* () {
        const result = yield* Cases.append(id, [filed("short"), filed(LONG)], 0)
        expect(result.version).toBe(2)
        const [first, second] = eventRows()
        // Under the threshold: the packed JSON, inline.
        expect(first!.data?.S).toBe(JSON.stringify({ _tag: "Filed", note: "short" }))
        // Over it: a pointer to one object version, under the event item's key.
        const pointer = pointerOf(second!.data)
        expect(pointer.ref.key).toBe(keyFor(second!, "data"))
        expect(pointer.contentSize).toBe(JSON.stringify({ _tag: "Filed", note: LONG }).length)
        expect(calls().put).toBe(1)
        expect(versions().map((v) => v.ref)).toEqual([pointer.ref])
        // Every read resolves it.
        expect((yield* Cases.read(id)).map((e) => e.data)).toEqual([filed("short"), filed(LONG)])
      }),
    ),
  )

  it.effect("offloads the inline snapshot's state beside the events", () =>
    withStore(
      Effect.gen(function* () {
        yield* seed
        const snapshot = snapshotRow()!
        const pointer = pointerOf(snapshot.state)
        expect(pointer.ref.key).toBe(keyFor(snapshot, "state"))
        // The long event and the snapshot: two objects.
        expect(calls().put).toBe(2)
        const read = yield* Cases.readSnapshot(id)
        expect(Option.map(read, (s) => s.state)).toEqual(Option.some(bigState(1)))
        // A small state stays inline.
        yield* Cases.append(id, [filed("x")], 2, { snapshot: { notes: ["x"] } })
        expect(isPointer(snapshotRow()!.state)).toBe(false)
      }),
    ),
  )

  it.effect("a lost race deletes the losing append's uploads (cancelled transaction)", () =>
    withStore(
      Effect.gen(function* () {
        yield* Cases.append(id, [filed(LONG)], 0)
        const winner = pointerOf(eventRows()[0]!.data)
        const lost = yield* Cases.append(id, [filed(`${LONG}!`)], 0).pipe(Effect.flip)
        expect(lost._tag).toBe("VersionConflict")
        // Uploaded, then deleted at exit: only the winner's version is left.
        expect(calls().put).toBe(2)
        expect(calls().delete).toBe(1)
        expect(versions().map((v) => v.ref)).toEqual([winner.ref])
      }),
    ),
  )

  it.effect("offload.itemBudget offloads an item over budget, under offload.prefix", () =>
    withStore(
      Effect.gen(function* () {
        expect(Budgeted.offload).toMatchObject({ itemBudget: 1_000, prefix: "cases/" })
        yield* Budgeted.append(id, [filed("short"), filed(LONG)], 0, { snapshot: bigState(1) })
        const [short, long] = eventRows("budgeted.event")
        // Far under its threshold, but its item is over the budget.
        expect(short!.data?.S).toBe(JSON.stringify({ _tag: "Filed", note: "short" }))
        const event = pointerOf(long!.data)
        const snapshot = snapshotRow("budgeted.snapshot")!
        const state = pointerOf(snapshot.state)
        // Keyed under the stream's prefix, not the store's.
        const prefixed = (row: Item, attribute: string) =>
          objectKey("cases/", {
            table: TABLE,
            pk: { S: row.pk!.S! },
            familySk: STREAM_FAMILY_SK,
            rowSk: { S: row.sk!.S! },
            attribute,
          })
        expect(event.ref.key).toBe(prefixed(long!, "data"))
        expect(state.ref.key).toBe(prefixed(snapshot, "state"))
        expect(event.ref.key.startsWith("cases/")).toBe(true)
        expect(calls().put).toBe(2)
        expect((yield* Budgeted.read(id)).map((e) => e.data)).toEqual([filed("short"), filed(LONG)])
        const read = yield* Budgeted.readSnapshot(id)
        expect(Option.map(read, (s) => s.state)).toEqual(Option.some(bigState(1)))
      }),
    ),
  )

  it.effect("a failed upload fails the append once the others settled, and rolls them back", () =>
    Effect.gen(function* () {
      // The second put fails; the first succeeds.
      blobs = BlobStore.memory({
        failures: (call) =>
          call.action === "put" && call.n === 2
            ? { _tag: "Fail", reason: "AccessDenied" }
            : undefined,
      })
      const error = yield* withStore(Cases.append(id, [filed(LONG), filed(`${LONG}!`)], 0)).pipe(
        Effect.flip,
      )
      expect(error).toBeInstanceOf(BlobStoreError)
      expect((error as BlobStoreError).reason).toBe("AccessDenied")
      expect((error as BlobStoreError).operation).toBe("EventStore.append")
      // Nothing written; the upload that succeeded is deleted at exit.
      expect(eventRows()).toEqual([])
      expect(calls().put).toBe(2)
      expect(calls().delete).toBe(1)
      expect(versions()).toEqual([])
    }),
  )

  it.effect("an idempotent append replayed (DuplicateCommand) deletes its upload", () =>
    withStore(
      Effect.gen(function* () {
        const idempotency = { commandId: "cmd-1" }
        yield* Cases.append(id, [filed(LONG)], 0, { idempotency })
        const kept = pointerOf(eventRows()[0]!.data)
        const replay = yield* Cases.append(id, [filed(`${LONG}?`)], 1, { idempotency }).pipe(
          Effect.flip,
        )
        expect(replay._tag).toBe("DuplicateCommand")
        // The replay's transaction was cancelled: its upload is rolled back.
        expect(eventRows()).toHaveLength(1)
        expect(calls().put).toBe(2)
        expect(calls().delete).toBe(1)
        expect(versions().map((v) => v.ref)).toEqual([kept.ref])
      }),
    ),
  )

  it.effect("appendOp in a transaction uploads through the transaction's ledger", () =>
    withStore(
      Effect.gen(function* () {
        const bound = yield* EventStore.bind(Cases)
        yield* bound.append(id, [filed(LONG)], 0, {
          additionalItems: [bound.appendOp({ caseId: "c-2" }, [filed(`${LONG}?`)], 0)],
        })
        expect(calls().put).toBe(2)
        expect(isPointer(eventRows()[0]!.data)).toBe(true)
        expect(isPointer(eventRows()[1]!.data)).toBe(true)
        expect((yield* bound.read({ caseId: "c-2" })).map((e) => e.data)).toEqual([
          filed(`${LONG}?`),
        ])
      }),
    ),
  )
})

describe("EventStore offload — writeSnapshot", () => {
  it.effect("offloads the state; a lost race (ALL_OLD without the pointer) deletes it", () =>
    withStore(
      Effect.gen(function* () {
        yield* Dossiers.append(id, [filed("a"), filed("b")], 0)
        yield* Dossiers.writeSnapshot(id, bigState(2), 2)
        const pointer = pointerOf(snapshotRow("dossier.snapshot")!.state)
        expect(calls().put).toBe(1)
        // An older snapshot loses the monotonic condition: no-op, upload deleted.
        yield* Dossiers.writeSnapshot(id, bigState(3), 1)
        expect(calls().put).toBe(2)
        expect(calls().delete).toBe(1)
        expect(versions().map((v) => v.ref)).toEqual([pointer.ref])
        expect(pointerOf(snapshotRow("dossier.snapshot")!.state).ref).toEqual(pointer.ref)
        const read = yield* Dossiers.readSnapshot(id)
        expect(Option.map(read, (s) => [s.asOfVersion, s.state])).toEqual(
          Option.some([2, bigState(2)]),
        )
      }),
    ),
  )
})

describe("EventStore offload — commandHandler", () => {
  it.effect("a retried attempt with the same content reuses the upload (memo)", () =>
    withStore(
      Effect.gen(function* () {
        const handle = EventStore.commandHandler(decider, Cases, { retry: 1 })
        // The first attempt's transaction is cancelled, as if another writer won.
        rejection.next = 1
        const result = yield* handle(id, { note: LONG })
        expect(result.version).toBe(1)
        // The event's and the inline snapshot's uploads, reused by the retry:
        // the cancelled attempt deleted nothing.
        expect(calls().put).toBe(2)
        expect(calls().delete).toBe(0)
        const kept = versions().map((v) => v.ref)
        expect(kept).toHaveLength(2)
        expect(kept).toContainEqual(pointerOf(eventRows()[0]!.data).ref)
        expect(kept).toContainEqual(pointerOf(snapshotRow()!.state).ref)
      }),
    ),
  )

  it.effect("a retry at another version re-uploads; the lost attempt's upload is deleted", () =>
    withStore(
      Effect.gen(function* () {
        let attempts = 0
        const other = yield* EventStore.bind(Cases)
        const racing: EventStore.Decider<CaseState, { readonly note: string }, CaseEvent> = {
          ...decider,
          // A concurrent writer appends between the first load and its append.
          decide: (command) =>
            Effect.gen(function* () {
              attempts++
              if (attempts === 1) yield* other.append(id, [filed("other")], 0).pipe(Effect.orDie)
              return [filed(command.note)]
            }),
        }
        const result = yield* EventStore.commandHandler(racing, Cases, { retry: 1 })(id, {
          note: LONG,
        })
        expect(attempts).toBe(2)
        expect(result.version).toBe(2)
        // The lost attempt's event (version 1's key) and snapshot uploads are
        // deleted, in one store call; the retry's — another key, another
        // state — are kept.
        expect(calls().put).toBe(4)
        expect(calls().delete).toBe(1)
        const kept = versions().map((v) => v.ref)
        expect(kept).toContainEqual(pointerOf(eventRows()[1]!.data).ref)
        expect(kept).toContainEqual(pointerOf(snapshotRow()!.state).ref)
        expect(kept).toHaveLength(2)
      }),
    ),
  )
})

describe("EventStore offload — measureAppend / measureSnapshot", () => {
  it.effect("upload nothing, and report what append would offload", () =>
    withStore(
      Effect.gen(function* () {
        const events = [filed("short"), filed(LONG)]
        const measured = yield* Cases.measureAppend(id, events, 0, { snapshot: bigState(1) })
        expect(calls().put).toBe(0)
        expect(measured.offloaded.map(({ item, attribute }) => [item, attribute])).toEqual([
          [1, "data"],
          ["snapshot", "state"],
        ])
        yield* Cases.append(id, events, 0, { snapshot: bigState(1) })
        const [, long] = eventRows()
        const [data, state] = measured.offloaded
        expect(data!.objectBytes).toBe(pointerOf(long!.data).objectSize)
        expect(state!.objectBytes).toBe(pointerOf(snapshotRow()!.state).objectSize)
        // A pointer at its upper bound: never under the item written.
        expect(measured.events[0]).toBe(itemBytes(eventRows()[0]!))
        expect(measured.events[1]!).toBeGreaterThanOrEqual(itemBytes(long!))
        expect(measured.snapshot!).toBeGreaterThanOrEqual(itemBytes(snapshotRow()!))
        const snapshotBytes = yield* Dossiers.measureSnapshot(id, bigState(2), 2)
        expect(calls().put).toBe(2)
        yield* Dossiers.writeSnapshot(id, bigState(2), 2)
        expect(snapshotBytes).toBeGreaterThanOrEqual(itemBytes(snapshotRow("dossier.snapshot")!))
      }),
    ),
  )

  it.effect("an offloading additional item is measured, never uploaded", () =>
    withStore(
      Effect.gen(function* () {
        const additionalItems = [Attachments.put({ caseId: "c-1", body: { text: LONG } })]
        const measured = yield* Cases.measureAppend(id, [filed("short")], 0, { additionalItems })
        // Nothing uploaded, nothing sent.
        expect(calls().put).toBe(0)
        expect(rows.size).toBe(0)
        // `offloaded` lists the stream's own values only.
        expect(measured.offloaded).toEqual([])
        // The append writes a pointer: the measured request never under-counts it.
        yield* Cases.append(id, [filed("short")], 0, { additionalItems })
        expect(calls().put).toBe(1)
        const attachment = [...rows.values()].find((row) => row.__edd_e__?.S === "CaseAttachment")!
        expect(isPointer(attachment.body)).toBe(true)
        expect(measured.transactionBytes).toBeGreaterThan(0)
        expect(measured.requestBytes).toBeGreaterThan(measured.transactionBytes)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("EventStore offload — reads", () => {
  it.effect("every read path resolves pointers eagerly by default", () =>
    withStore(
      Effect.gen(function* () {
        yield* seed
        const expected = [filed("short"), filed(LONG)]
        expect((yield* Cases.read(id)).map((e) => e.data)).toEqual(expected)
        expect((yield* Cases.readFrom(id, 1)).map((e) => e.data)).toEqual([filed(LONG)])
        const events = yield* Cases.query.events(id).pipe(Query.collect)
        expect(events.map((e) => e.data)).toEqual(expected)
        const latest = yield* Cases.readLatest(id)
        expect(latest.snapshot.pipe(Option.map((s) => s.state))).toEqual(Option.some(bigState(1)))
        expect(latest.version).toBe(2)
        const snapshot = yield* Cases.readSnapshot(id)
        expect(snapshot.pipe(Option.map((s) => s.state))).toEqual(Option.some(bigState(1)))
        // Each read fetched what it met.
        expect(calls().get).toBeGreaterThanOrEqual(5)
      }),
    ),
  )

  it.effect("offloaded: 'lazy' fetches nothing until read()", () =>
    withStore(
      Effect.gen(function* () {
        yield* seed
        const before = calls().get
        const lazy = yield* Cases.read(id, { offloaded: "lazy" })
        const fromQuery = yield* Cases.query.events(id).pipe(Query.offloaded("lazy"), Query.collect)
        const latest = yield* Cases.readLatest(id, { offloaded: "lazy" })
        const snapshot = yield* Cases.readSnapshot(id, { offloaded: "lazy" })
        expect(calls().get).toBe(before)
        let fetched = before
        for (const events of [lazy, fromQuery]) {
          expect(events.map((e) => e.eventType)).toEqual(["Filed", "Filed"])
          expect(events.every((e) => isOffloadedValue(e.data))).toBe(true)
          // An inline value reads without I/O; an offloaded one fetches.
          expect(events[0]!.data.location).toBe("inline")
          expect(yield* events[0]!.data.read()).toEqual(filed("short"))
          expect(calls().get).toBe(fetched)
          expect(events[1]!.data.location).toBe("external")
          expect(yield* events[1]!.data.read()).toEqual(filed(LONG))
          fetched++
          expect(calls().get).toBe(fetched)
        }
        const state = Option.getOrThrow(latest.snapshot).state
        expect(isOffloadedValue(state)).toBe(true)
        expect(yield* state.read()).toEqual(bigState(1))
        expect(yield* Option.getOrThrow(snapshot).state.read()).toEqual(bigState(1))
      }),
    ),
  )

  it.effect("readIndex and query.index: eager by default, lazy on request", () =>
    withStore(
      Effect.gen(function* () {
        yield* Indexed.append(id, [filed("short"), filed(LONG)], 0)
        const eager = yield* Indexed.readIndex("byVersion", id)
        expect(eager.map((e) => e.data)).toEqual([filed("short"), filed(LONG)])
        const fetched = calls().get
        expect(fetched).toBe(1)
        const lazy = yield* Indexed.readIndex("byVersion", id, { offloaded: "lazy" })
        const fromQuery = yield* Indexed.query
          .index("byVersion", id)
          .pipe(Query.offloaded("lazy"), Query.collect)
        expect(calls().get).toBe(fetched)
        for (const events of [lazy, fromQuery]) {
          expect(events.every((e) => isOffloadedValue(e.data))).toBe(true)
          expect(yield* events[1]!.data.read()).toEqual(filed(LONG))
        }
      }),
    ),
  )

  it.effect("readLatest lazily: the events past the snapshot fetch nothing either", () =>
    withStore(
      Effect.gen(function* () {
        // The snapshot is at version 2; version 3 follows it.
        yield* seed
        yield* Cases.append(id, [filed(`${LONG}3`)], 2)
        const before = calls().get
        const lazy = yield* Cases.readLatest(id, { offloaded: "lazy" })
        expect(calls().get).toBe(before)
        expect(lazy.version).toBe(3)
        expect(lazy.events.map((e) => e.version)).toEqual([3])
        expect(lazy.events[0]!.data.location).toBe("external")
        expect(yield* lazy.events[0]!.data.read()).toEqual(filed(`${LONG}3`))
        expect(yield* Option.getOrThrow(lazy.snapshot).state.read()).toEqual(bigState(1))
        const eager = yield* Cases.readLatest(id)
        expect(eager.events.map((e) => e.data)).toEqual([filed(`${LONG}3`)])
      }),
    ),
  )

  it.effect("readLatest on a sealed stream, verified or not: the seal and snapshot per mode", () =>
    withStore(
      Effect.gen(function* () {
        yield* Cases.append(id, [filed("short")], 0, { snapshot: { notes: ["short"] } })
        yield* Cases.append(id, [filed(LONG)], 1, { seal: true, snapshot: bigState(2) })
        expect(isPointer(eventRows()[1]!.data)).toBe(true)
        expect(isPointer(snapshotRow()!.state)).toBe(true)
        for (const verifySnapshot of [true, false]) {
          const eager = yield* Cases.readLatest(id, { verifySnapshot })
          expect(eager.version).toBe(2)
          expect(eager.seal?.data).toEqual(filed(LONG))
          expect(Option.map(eager.snapshot, (s) => s.state)).toEqual(Option.some(bigState(2)))
          const before = calls().get
          const lazy = yield* Cases.readLatest(id, { verifySnapshot, offloaded: "lazy" })
          expect(calls().get).toBe(before)
          expect(lazy.seal!.data.location).toBe("external")
          expect(yield* lazy.seal!.data.read()).toEqual(filed(LONG))
          expect(yield* Option.getOrThrow(lazy.snapshot).state.read()).toEqual(bigState(2))
        }
      }),
    ),
  )

  it.effect('a "keys" GSI fetches its events from the table, offloaded data per mode', () =>
    Effect.gen(function* () {
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() =>
          effect.pipe(
            Effect.provide(Layer.mergeAll(KeysIndexClient, tableLayer, BlobStore.layer(blobs))),
          ),
        )
      yield* run(KeyIndexed.append(id, [filed("short"), filed(LONG)], 0))
      const expected = [filed("short"), filed(LONG)]
      const eager = yield* run(KeyIndexed.readIndex("byVersionKeys", id))
      expect(eager.map((e) => e.data)).toEqual(expected)
      const fromQuery = yield* run(KeyIndexed.query.index("byVersionKeys", id).pipe(Query.collect))
      expect(fromQuery.map((e) => e.data)).toEqual(expected)
      const fetched = calls().get
      expect(fetched).toBe(2)
      const lazy = yield* run(KeyIndexed.readIndex("byVersionKeys", id, { offloaded: "lazy" }))
      const lazyQuery = yield* run(
        KeyIndexed.query.index("byVersionKeys", id).pipe(Query.offloaded("lazy"), Query.collect),
      )
      expect(calls().get).toBe(fetched)
      for (const events of [lazy, lazyQuery]) {
        expect(events.map((e) => e.version)).toEqual([1, 2])
        expect(events.every((e) => isOffloadedValue(e.data))).toBe(true)
        expect(yield* run(events[1]!.data.read())).toEqual(filed(LONG))
      }
    }),
  )

  it.effect("an unknown mode is [EDD-9117]", () =>
    withStore(
      Effect.gen(function* () {
        yield* seed
        const error = yield* Cases.read(id, { offloaded: "soon" as never }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ValidationError)
        expect(String((error as ValidationError).cause)).toContain("EDD-9117")
        // A projection's mode is checked at definition.
        expect(() =>
          EventStore.projection({
            stream: Cases,
            readModel: Summaries,
            offloaded: "soon" as never,
            key: (streamId: { readonly caseId: string }) => ({ caseId: streamId.caseId }),
            initial: initialSummary,
            evolve: (state) => Effect.succeed(state),
            checkpoint: "version",
          }),
        ).toThrow(
          '[EDD-9117] EventStore.projection("Case" → "CaseSummary"): unknown offloaded mode "soon"',
        )
      }),
    ),
  )

  it.effect("raw rows carry the wire JSON — eagerly, or lazily on request", () =>
    withStore(
      Effect.gen(function* () {
        yield* seed
        const wire = [
          { _tag: "Filed", note: "short" },
          { _tag: "Filed", note: LONG },
        ]
        const raw = yield* Cases.query
          .events(id)
          .pipe(Query.select(["version", "data"]), Query.collect)
        expect(raw.map((row) => row.data)).toEqual(wire)
        const before = calls().get
        const lazy = yield* Cases.query
          .events(id)
          .pipe(Query.select(["version", "data"]), Query.offloaded("lazy"), Query.collect)
        expect(calls().get).toBe(before)
        const values = lazy.map((row) => row.data as OffloadedValue<unknown>)
        expect(values.every((v) => isOffloadedValue(v))).toBe(true)
        expect(yield* Effect.forEach(values, (v) => v.read())).toEqual(wire)
      }),
    ),
  )

  it.effect("a store failure on an eager read is a BlobStoreError; lazy reads defer it", () =>
    Effect.gen(function* () {
      yield* withStore(seed)
      blobs = BlobStore.memory({
        failures: (call) =>
          call.action === "get" ? { _tag: "Fail", reason: "AccessDenied" } : undefined,
      })
      const error = yield* withStore(Cases.read(id)).pipe(Effect.flip)
      expect(error).toBeInstanceOf(BlobStoreError)
      expect((error as BlobStoreError).reason).toBe("AccessDenied")
      const lazy = yield* withStore(Cases.read(id, { offloaded: "lazy" }))
      expect(yield* withStore(lazy[1]!.data.read()).pipe(Effect.flip)).toBeInstanceOf(
        BlobStoreError,
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// Stream images and the change-feed surface
// ---------------------------------------------------------------------------

describe("EventStore offload — decodeStreamImage", () => {
  it.effect("is lazy by default, and eager on request", () =>
    withStore(
      Effect.gen(function* () {
        yield* seed
        const image = eventRows()[1]!
        const before = calls().get
        const lazy = Option.getOrThrow(yield* Cases.decodeStreamImage(image))
        expect(calls().get).toBe(before)
        expect(isOffloadedValue(lazy.data)).toBe(true)
        expect(yield* lazy.data.read()).toEqual(filed(LONG))
        const eager = Option.getOrThrow(
          yield* Cases.decodeStreamImage(image, { offloaded: "eager" }),
        )
        expect(eager.data).toEqual(filed(LONG))
        const raw = Option.getOrThrow(yield* Cases.decodeStreamImage(image, { raw: true }))
        expect(yield* raw.rawData.read()).toEqual({ _tag: "Filed", note: LONG })
        const rawEager = Option.getOrThrow(
          yield* Cases.decodeStreamImage(image, { raw: true, offloaded: "eager" }),
        )
        expect(rawEager.rawData).toEqual({ _tag: "Filed", note: LONG })
        // A store failure names the operation.
        const failed = yield* Cases.decodeStreamImage(image, { offloaded: "eager" }).pipe(
          Effect.provide(BlobStore.layer(failingGets())),
          Effect.flip,
        )
        expect(failed).toBeInstanceOf(BlobStoreError)
        expect((failed as BlobStoreError).operation).toBe("EventStore.decodeStreamImage")
      }),
    ),
  )
})

const Summary = Schema.Struct({
  caseId: Schema.String,
  count: Schema.Number,
  chars: Schema.Number,
  version: Schema.Number,
})
type Summary = typeof Summary.Type
const Summaries = Entity.make({
  model: Summary,
  entityType: "CaseSummary",
  primaryKey: { pk: { field: "pk", composite: ["caseId"] }, sk: { field: "sk", composite: [] } },
})
/** The read models of a lazy and an eager projection of the same stream. */
const LazySides = Entity.make({
  model: Summary,
  entityType: "CaseLazySide",
  primaryKey: { pk: { field: "pk", composite: ["caseId"] }, sk: { field: "sk", composite: [] } },
})
const EagerSides = Entity.make({
  model: Summary,
  entityType: "CaseEagerSide",
  primaryKey: { pk: { field: "pk", composite: ["caseId"] }, sk: { field: "sk", composite: [] } },
})
const ReadTable = Table.make({ schema: AppSchema, entities: { Summaries, LazySides, EagerSides } })
const readLayer = ReadTable.layer({ name: "read" })

const noteOf = (event: CaseEvent) => (event._tag === "Filed" ? event.note : event.tag)
const initialSummary = (key: { readonly caseId: string }): Summary => ({
  caseId: key.caseId,
  count: 0,
  chars: 0,
  version: 0,
})

/** What each handler received: whether `data` was lazy. */
const seen: Array<boolean> = []

const LazySummary = EventStore.projection({
  stream: Cases,
  readModel: Summaries,
  key: (streamId: { readonly caseId: string }) => ({ caseId: streamId.caseId }),
  initial: initialSummary,
  evolve: (state, event) =>
    Effect.map(event.data.read(), (data) => {
      seen.push(true)
      return { ...state, count: state.count + 1, chars: state.chars + noteOf(data).length }
    }),
  checkpoint: "version",
})

const EagerSummary = EventStore.projection({
  stream: Cases,
  readModel: Summaries,
  offloaded: "eager",
  key: (streamId: { readonly caseId: string }) => ({ caseId: streamId.caseId }),
  initial: initialSummary,
  evolve: (state, event) => {
    seen.push(isOffloadedValue(event.data))
    return Effect.succeed({
      ...state,
      count: state.count + 1,
      chars: state.chars + noteOf(event.data).length,
    })
  },
  checkpoint: "version",
})

/** What each side projection received, as `<side>:<lazy | resolved>`. */
const received: Array<string> = []
const shapeOf = (data: unknown) => (isOffloadedValue(data) ? "lazy" : "resolved")

const LazySide = EventStore.projection({
  stream: Cases,
  readModel: LazySides,
  key: (streamId: { readonly caseId: string }) => ({ caseId: streamId.caseId }),
  initial: initialSummary,
  evolve: (state, event) => {
    received.push(`lazy:${shapeOf(event.data)}`)
    return Effect.map(event.data.read(), (data) => ({
      ...state,
      count: state.count + 1,
      chars: state.chars + noteOf(data).length,
    }))
  },
  checkpoint: "version",
})

const EagerSide = EventStore.projection({
  stream: Cases,
  readModel: EagerSides,
  offloaded: "eager",
  key: (streamId: { readonly caseId: string }) => ({ caseId: streamId.caseId }),
  initial: initialSummary,
  evolve: (state, event) => {
    received.push(`eager:${shapeOf(event.data)}`)
    return Effect.succeed({
      ...state,
      count: state.count + 1,
      chars: state.chars + noteOf(event.data).length,
    })
  },
  checkpoint: "version",
})

/**
 * The stream `Case` with offload switched off (design §4.7): its items may
 * still hold pointers an earlier writer stored.
 */
const FormerCases = EventStore.makeStream({
  table: EventsTable,
  streamName: "Case",
  events: [Filed, Tagged],
  streamId: { composite: ["caseId"] },
  storedAs: { data: DynamoModel.Packed({ format: "json" }) },
})

const FormerSummary = EventStore.projection({
  stream: FormerCases,
  readModel: Summaries,
  key: (streamId: { readonly caseId: string }) => ({ caseId: streamId.caseId }),
  initial: initialSummary,
  evolve: (state, event) =>
    Effect.succeed({
      ...state,
      count: state.count + 1,
      chars: state.chars + noteOf(event.data).length,
    }),
  checkpoint: "version",
})

const MultiSummary = Schema.Struct({
  caseId: Schema.String,
  count: Schema.Number,
  chars: Schema.Number,
  checkpoints: Schema.Record(Schema.String, Schema.Number),
  revision: Schema.Number,
})
type MultiSummary = typeof MultiSummary.Type
const MultiSummaries = Entity.make({
  model: MultiSummary,
  entityType: "CaseMulti",
  primaryKey: { pk: { field: "pk", composite: ["caseId"] }, sk: { field: "sk", composite: [] } },
})
const MultiTable = Table.make({ schema: AppSchema, entities: { MultiSummaries } })
const multiLayer = MultiTable.layer({ name: "multi" })
const multiInitial = (key: { readonly caseId: string }): MultiSummary => ({
  caseId: key.caseId,
  count: 0,
  chars: 0,
  checkpoints: {},
  revision: 0,
})

const LazyMulti = EventStore.multiProjection({
  readModel: MultiSummaries,
  initial: multiInitial,
  sources: (source) => ({
    cases: source(Cases, {
      key: (streamId) => ({ caseId: streamId.caseId }),
      evolve: (state, event) =>
        Effect.map(event.data.read(), (data) => {
          seen.push(true)
          return { ...state, count: state.count + 1, chars: state.chars + noteOf(data).length }
        }),
    }),
  }),
  checkpoints: { field: "checkpoints" },
  revision: "revision",
})

const EagerMulti = EventStore.multiProjection({
  readModel: MultiSummaries,
  initial: multiInitial,
  offloaded: "eager",
  sources: (source) => ({
    cases: source(Cases, {
      key: (streamId) => ({ caseId: streamId.caseId }),
      evolve: (state, event) => {
        seen.push(isOffloadedValue(event.data))
        return Effect.succeed({
          ...state,
          count: state.count + 1,
          chars: state.chars + noteOf(event.data).length,
        })
      },
    }),
  }),
  checkpoints: { field: "checkpoints" },
  revision: "revision",
})

const withProjections = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(SpyClient, tableLayer, readLayer, multiLayer, BlobStore.layer(blobs)),
      ),
    ),
  )

const expectedChars = "short".length + LONG.length

/** One change-feed batch of `records`. */
const batchOf = (records: ReadonlyArray<unknown>): ChangeFeedBatch => ({
  streamArn: "arn",
  shardId: "shard-1",
  records: records as unknown as ReadonlyArray<ChangeFeedRecord>,
  firstSequenceNumber: "0001",
  lastSequenceNumber: String(records.length).padStart(4, "0"),
  commit: () => Effect.void,
  complete: () => Effect.void,
})

/** Collects every log line: level, first message part and annotations. */
const logs = () => {
  const lines: Array<{
    readonly level: string
    readonly message: unknown
    readonly annotations: Readonly<Record<string, unknown>>
  }> = []
  const logger = Logger.make((options) => {
    const message = Array.isArray(options.message) ? options.message[0] : options.message
    lines.push({
      level: options.logLevel,
      message,
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
    })
  })
  return { lines, layer: Logger.layer([logger]) }
}

/** Every get fails with `AccessDenied`. */
const failingGets = () =>
  BlobStore.memory({
    failures: (call) =>
      call.action === "get" ? { _tag: "Fail", reason: "AccessDenied" } : undefined,
  })

describe("EventStore offload — projections", () => {
  beforeEach(() => {
    seen.length = 0
    received.length = 0
  })

  it.effect("EventProjection.processBatch hands LazyStreamEvents by default", () =>
    withProjections(
      Effect.gen(function* () {
        yield* seed
        // Only the second record: the first is gap-filled from the store, lazily too.
        const result = yield* LazySummary.processBatch(recordsOf(eventRows()).slice(1), {
          source: "lambda",
        })
        expect(result.response.batchItemFailures).toEqual([])
        expect(seen).toEqual([true, true])
        const row = yield* Summaries.get({ caseId: "c-1" })
        expect([row.count, row.chars, row.version]).toEqual([2, expectedChars, 2])
      }),
    ),
  )

  it.effect("EventProjection with offloaded: 'eager' receives resolved events", () =>
    withProjections(
      Effect.gen(function* () {
        yield* seed
        const result = yield* EagerSummary.processBatch(recordsOf(eventRows()).slice(1), {
          source: "lambda",
        })
        expect(result.response.batchItemFailures).toEqual([])
        expect(seen).toEqual([false, false])
        const row = yield* Summaries.get({ caseId: "c-1" })
        expect([row.count, row.chars]).toEqual([2, expectedChars])
        // rebuild reads the stream in the projection's mode.
        seen.length = 0
        yield* EagerSummary.rebuild(id)
        expect(seen).toEqual([false, false])
      }),
    ),
  )

  it.effect("MultiProjection: lazy by default, eager on request", () =>
    withProjections(
      Effect.gen(function* () {
        yield* seed
        const records = recordsOf(eventRows()).slice(1)
        yield* LazyMulti.processBatch(records, { source: "lambda" })
        expect(seen).toEqual([true, true])
        const lazyRow = yield* MultiSummaries.get({ caseId: "c-1" })
        expect([lazyRow.count, lazyRow.chars]).toEqual([2, expectedChars])
        seen.length = 0
        yield* EagerMulti.rebuild({ caseId: "c-1" }, { instances: { cases: [id] } })
        expect(seen).toEqual([false, false])
      }),
    ),
  )

  it.effect("EventStore.processBatch and runChangeFeed hand lazy events, unrouted too", () =>
    withProjections(
      Effect.gen(function* () {
        yield* seed
        const records = recordsOf(eventRows())
        const result = yield* EventStore.processBatch(records, {
          projections: { summary: LazySummary },
          streams: { cases: Cases },
          source: "lambda",
        })
        expect(seen).toEqual([true, true])
        const unrouted = result.unrouted.map((u) => u.event.data)
        expect(unrouted.every((data) => isOffloadedValue(data))).toBe(true)
        expect(yield* Effect.forEach(unrouted, (data) => data.read())).toEqual([
          filed("short"),
          filed(LONG),
        ])

        const batches: Array<ReadonlyArray<unknown>> = []
        yield* runChangeFeed(Stream.make(batchOf(records)), {
          projections: {},
          streams: { cases: Cases },
          onBatch: (_batch, processed) =>
            Effect.sync(() => {
              batches.push(processed.unrouted.map((u) => u.event.data))
            }),
        })
        expect(batches).toHaveLength(1)
        expect(batches[0]!.every((data) => isOffloadedValue(data))).toBe(true)
      }),
    ),
  )

  it.effect(
    "EventStore.processBatch decodes for each projection in its own mode, streams lazily",
    () =>
      withProjections(
        Effect.gen(function* () {
          // Both orders: no projection's mode decides another's.
          for (const projections of [
            { lazy: LazySide, eager: EagerSide },
            { eager: EagerSide, lazy: LazySide },
          ]) {
            resetStore()
            received.length = 0
            yield* seed
            const result = yield* EventStore.processBatch(recordsOf(eventRows()), {
              projections,
              streams: { cases: Cases },
              source: "lambda",
            })
            expect(result.response.batchItemFailures).toEqual([])
            expect([...received].sort()).toEqual([
              "eager:resolved",
              "eager:resolved",
              "lazy:lazy",
              "lazy:lazy",
            ])
            // `streams` are decoded lazily, whichever projection reads the stream.
            expect(result.unrouted.map((u) => shapeOf(u.event.data))).toEqual(["lazy", "lazy"])
            for (const model of [LazySides, EagerSides]) {
              const row = yield* model.get({ caseId: "c-1" })
              expect([row.count, row.chars, row.version]).toEqual([2, expectedChars, 2])
            }
          }
        }),
      ),
  )

  it.effect("runChangeFeed: an eager projection receives resolved events; streams stay lazy", () =>
    withProjections(
      Effect.gen(function* () {
        yield* seed
        const unrouted: Array<string> = []
        yield* runChangeFeed(Stream.make(batchOf(recordsOf(eventRows()))), {
          projections: { eager: EagerSide },
          streams: { cases: Cases },
          onBatch: (_batch, processed) =>
            Effect.sync(() => {
              unrouted.push(...processed.unrouted.map((u) => shapeOf(u.event.data)))
            }),
        })
        expect(received).toEqual(["eager:resolved", "eager:resolved"])
        expect(unrouted).toEqual(["lazy", "lazy"])
        const row = yield* EagerSides.get({ caseId: "c-1" })
        expect([row.count, row.chars]).toEqual([2, expectedChars])
      }),
    ),
  )

  it.effect(
    "a BlobStoreError decoding a record is not poison: reported, logged, never skipped",
    () =>
      withProjections(
        Effect.gen(function* () {
          yield* seed
          const records = recordsOf(eventRows())
          const log = logs()
          // Every get fails from here on.
          const result = yield* EagerSummary.processBatch(records, {
            source: "lambda",
            onDecodeFailure: "skip",
          }).pipe(Effect.provide(Layer.merge(BlobStore.layer(failingGets()), log.layer)))
          expect(result.decodeFailures).toEqual([])
          expect(result.storeFailures.map(({ record, error }) => [record, error.reason])).toEqual([
            [records[1], "AccessDenied"],
          ])
          expect(result.storeFailures[0]!.error).toBeInstanceOf(BlobStoreError)
          expect(result.response.batchItemFailures).toEqual([{ itemIdentifier: "0002" }])
          const warnings = log.lines.filter((line) => line.level === "Warn")
          expect(warnings).toHaveLength(1)
          expect(String(warnings[0]!.message)).toContain(
            'record 1 (0002) of stream "Case" failed to read offloaded event data from the blob ' +
              "store (AccessDenied)",
          )
          expect(warnings[0]!.annotations).toMatchObject({
            stream: "Case",
            position: 1,
            record: "0002",
            reason: "AccessDenied",
          })
          // EventStore.processBatch reports it the same way, for `streams` too.
          const batch = yield* EventStore.processBatch(records, {
            projections: {},
            streams: { cases: Cases },
            source: "lambda",
            onDecodeFailure: "skip",
          }).pipe(Effect.provide(BlobStore.layer(failingGets())))
          // Lazily decoded, `streams` fetch nothing: nothing fails.
          expect(batch.storeFailures).toEqual([])
          const eager = yield* EventStore.processBatch(records, {
            projections: { eager: EagerSide },
            source: "lambda",
            onDecodeFailure: "skip",
          }).pipe(Effect.provide(BlobStore.layer(failingGets())))
          expect(eager.storeFailures.map(({ record }) => record)).toEqual([records[1]])
          expect(eager.response.batchItemFailures).toEqual([{ itemIdentifier: "0002" }])
        }),
      ),
  )

  it.effect(
    "a pointer met on a stream that no longer offloads: a store failure is transient too",
    () =>
      Effect.gen(function* () {
        // Written while `data` offloaded; read by the stream with offload off.
        yield* withStore(seed)
        const records = recordsOf(eventRows())
        // With a store, the pointer resolves (design §4.7).
        const read = yield* withProjections(
          Effect.gen(function* () {
            const result = yield* FormerSummary.processBatch(records, { source: "lambda" })
            return { result, row: yield* Summaries.get({ caseId: "c-1" }) }
          }),
        )
        expect(read.result.response.batchItemFailures).toEqual([])
        expect(read.row.chars).toBe(expectedChars)
        resetStore()
        yield* withStore(seed)
        // A failing store, or none: the ValidationError's cause is the
        // store's failure — redelivered, not dropped as poison.
        for (const [store, reason] of [
          [BlobStore.layer(failingGets()), "AccessDenied"],
          [Layer.empty, "NotProvided"],
        ] as const) {
          const result = yield* FormerSummary.processBatch(records, {
            source: "lambda",
            onDecodeFailure: "skip",
          }).pipe(Effect.provide(Layer.mergeAll(SpyClient, tableLayer, readLayer, store)))
          expect(result.decodeFailures).toEqual([])
          expect(result.storeFailures.map(({ record, error }) => [record, error.reason])).toEqual([
            [records[1], reason],
          ])
          expect(result.response.batchItemFailures).toEqual([{ itemIdentifier: "0002" }])
        }
      }),
  )
})

// ---------------------------------------------------------------------------
// [EDD-9115]
// ---------------------------------------------------------------------------

describe("EventStore offload — the store checks ([EDD-9115])", () => {
  it.effect("bind and bindProjection need a store", () =>
    withoutStore(
      Effect.gen(function* () {
        const bound = defectOf(yield* Effect.exit(EventStore.bind(Cases)))
        expect(bound).toContain("[EDD-9115] EventStore.bind")
        expect(bound).toContain('stream "Case" offloads "data", "state"')
        const projection = defectOf(
          yield* Effect.exit(
            EventStore.bindProjection(LazySummary).pipe(Effect.provide(readLayer)),
          ),
        )
        expect(projection).toContain("[EDD-9115]")
        const multi = defectOf(
          yield* Effect.exit(EventStore.bindProjection(LazyMulti).pipe(Effect.provide(multiLayer))),
        )
        expect(multi).toContain("[EDD-9115]")
        // A stream that offloads nothing needs none.
        const plain = EventStore.makeStream({
          table: EventsTable,
          streamName: "Plain",
          events: [Filed],
          streamId: { composite: ["caseId"] },
        })
        expect((yield* EventStore.bind(plain)).offload).toBeUndefined()
      }),
    ),
  )

  it.effect("an unbound stream checks on its first operation, per store", () =>
    Effect.gen(function* () {
      const read = defectOf(yield* Effect.exit(withoutStore(Cases.read(id))))
      expect(read).toContain('[EDD-9115] EventStore (first use of stream "Case")')
      const image = defectOf(
        yield* Effect.exit(withoutStore(Cases.decodeStreamImage({ __edd_e__: { S: "x" } }))),
      )
      expect(image).toContain("[EDD-9115]")
      // Query terminals check too; `asParams` sends nothing and checks nothing.
      const query = defectOf(
        yield* Effect.exit(withoutStore(Cases.query.events(id).pipe(Query.collect))),
      )
      expect(query).toContain('[EDD-9115] EventStore (first use of stream "Case")')
      const index = defectOf(
        yield* Effect.exit(
          withoutStore(
            Indexed.query.index("byVersion", id).pipe(Query.offloaded("lazy"), Query.count),
          ),
        ),
      )
      expect(index).toContain('[EDD-9115] EventStore (first use of stream "Indexed")')
      const params = yield* withoutStore(Query.asParams(Cases.query.events(id)))
      expect(params.TableName).toBe(TABLE)
      // processBatch decodes through the stream: its first record of the stream checks.
      yield* withStore(seed)
      const batch = defectOf(
        yield* Effect.exit(
          withoutStore(
            LazySummary.processBatch(recordsOf(eventRows()), { source: "lambda" }).pipe(
              Effect.provide(readLayer),
            ),
          ),
        ),
      )
      expect(batch).toContain("[EDD-9115]")
      // With a store, it runs; the bound stream captured its store.
      expect(yield* withStore(Cases.read(id))).toHaveLength(2)
      const bound = yield* withStore(EventStore.bind(Cases))
      expect(yield* withoutStore(bound.read(id))).toHaveLength(2)
    }),
  )
})

describe("EventStore offload — escaped key text ([EDD-9146])", () => {
  /** Key text not escaped (#183): offloading requires it escaped. */
  const PlainSchema = DynamoSchema.make({ name: "evo", version: 1, escapeKeys: false })
  const PlainTable = Table.make({ schema: PlainSchema, entities: {} })
  const UnescapedCases = EventStore.makeStream({
    table: PlainTable,
    streamName: "Case",
    events: [Filed, Tagged],
    streamId: { composite: ["caseId"] },
    storedAs: { data: overflow },
    snapshot: { schema: CaseState, mode: "inline", storedAs: overflow },
  })
  const UnescapedSummary = EventStore.projection({
    stream: UnescapedCases,
    readModel: Summaries,
    key: (streamId: { readonly caseId: string }) => ({ caseId: streamId.caseId }),
    initial: initialSummary,
    evolve: (state) => Effect.succeed(state),
    checkpoint: "version",
  })
  const plainLayer = PlainTable.layer({ name: TABLE })

  it.effect("EventStore.bind and bindProjection die naming the stream, before the store", () =>
    Effect.gen(function* () {
      for (const exit of [
        // No store: the key text is checked first.
        yield* Effect.exit(EventStore.bind(UnescapedCases)),
        // A store doesn't make the key text right.
        yield* Effect.exit(
          EventStore.bind(UnescapedCases).pipe(Effect.provide(BlobStore.layer(blobs))),
        ),
      ]) {
        const message = defectOf(exit)
        expect(message).toContain("[EDD-9146] EventStore.bind")
        expect(message).toContain('stream "Case" offloads "data", "state"')
        expect(message).toContain("escapeKeys: true")
      }
      const projection = defectOf(
        yield* Effect.exit(
          EventStore.bindProjection(UnescapedSummary).pipe(
            Effect.provide(Layer.mergeAll(readLayer, BlobStore.layer(blobs))),
          ),
        ),
      )
      expect(projection).toContain("[EDD-9146] EventStore.bind")
      expect(calls().put).toBe(0)
    }).pipe(Effect.provide(Layer.mergeAll(SpyClient, plainLayer))),
  )

  it.effect("an unbound append is refused where it routes: nothing uploaded or sent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        UnescapedCases.append(id, [filed(LONG)], 0, { snapshot: bigState(1) }),
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain(
        "[EDD-9146] EventStore.append: case.event offloads",
      )
      expect(calls().put).toBe(0)
      expect(rows.size).toBe(0)
      // A measurement routes as the write would: refused the same way.
      const measured = yield* Effect.flip(UnescapedCases.measureAppend(id, [filed(LONG)], 0))
      expect(String(measured.cause)).toContain("[EDD-9146]")
      // Reads are never refused.
      expect(yield* UnescapedCases.read(id)).toEqual([])
    }).pipe(Effect.provide(Layer.mergeAll(SpyClient, plainLayer, BlobStore.layer(blobs)))),
  )

  it.effect("rekey dies on an offloading stream it is given, before reading anything", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const exit = yield* Effect.exit(
        Effect.flatMap(DynamoClient.make({ entities: {}, tables: { PlainTable } }), (db) =>
          db.tables.PlainTable.rekey({ streams: [UnescapedCases] }),
        ).pipe(Effect.provide(Layer.mergeAll(table.layer, plainLayer, BlobStore.layer(blobs)))),
      )
      const message = defectOf(exit)
      expect(message).toContain("[EDD-9146] rekey")
      expect(message).toContain('stream "Case" offloads "data", "state"')
      expect(table.take()).toEqual([])
    }),
  )

  describe("rekey never moves a stream row holding a pointer", () => {
    /** A stream id whose partition key text differs between the two settings (a space). */
    const spaced = { caseId: "c 1" }
    /** `escapeKeys` turned off and the offloaded declarations removed: the only way it runs. */
    const PlainCases = EventStore.makeStream({
      table: PlainTable,
      streamName: "Case",
      events: [Filed, Tagged],
      streamId: { composite: ["caseId"] },
      storedAs: { data: DynamoModel.Packed({ format: "json" }) },
      snapshot: {
        schema: CaseState,
        mode: "inline",
        storedAs: DynamoModel.Packed({ format: "json" }),
      },
    })
    /** The stream, written with offloading under escaped key text. */
    const written = (table: ReturnType<typeof makeRecordingTable>) =>
      Cases.append(spaced, [filed("short"), filed(LONG)], 0, { snapshot: bigState(1) }).pipe(
        Effect.provide(Layer.mergeAll(table.layer, tableLayer, BlobStore.layer(blobs))),
      )

    it.effect("under escaped key text, rekey moves nothing", () =>
      Effect.gen(function* () {
        const table = makeRecordingTable()
        yield* written(table)
        const held = [...table.items.values()]
        expect(held.some((row) => isPointer(row.data))).toBe(true)
        expect(held.some((row) => isPointer(row.state))).toBe(true)
        expect(held.every((row) => row.pk?.S?.includes("c%201"))).toBe(true)
        const before = new Map(table.items)
        const report = yield* Effect.flatMap(
          DynamoClient.make({ entities: {}, tables: { EventsTable } }),
          (db) => db.tables.EventsTable.rekey({ streams: [Cases] }),
        ).pipe(Effect.provide(Layer.mergeAll(table.layer, tableLayer, BlobStore.layer(blobs))))
        expect(report.conflicts).toEqual([])
        expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
        expect(new Map(table.items)).toEqual(before)
      }),
    )

    for (const dryRun of [true, false]) {
      it.effect(
        `with escapeKeys turned off, a row holding a pointer is refused${dryRun ? " (dry run)" : ""}`,
        () =>
          Effect.gen(function* () {
            const table = makeRecordingTable()
            yield* written(table)
            const held = new Map(table.items)
            const first = [...held.values()].find((row) => isPointer(row.data))!
            table.take()
            const error = yield* Effect.flip(
              Effect.flatMap(DynamoClient.make({ entities: {}, tables: { PlainTable } }), (db) =>
                db.tables.PlainTable.rekey({ streams: [PlainCases], dryRun }),
              ).pipe(Effect.provide(Layer.mergeAll(table.layer, plainLayer))),
            )
            expect(error).toBeInstanceOf(ValidationError)
            const cause = String((error as ValidationError).cause)
            expect(cause).toContain('[EDD-9146] stream "Case"')
            expect(cause).toContain("holds a blob pointer")
            // The row's key, as stored (escaped).
            expect(cause).toContain(first.pk!.S!)
            // Nothing written: every row is where it was, as it was.
            expect(new Map(table.items)).toEqual(held)
            const writes = table
              .take()
              .filter((r) => !["GetItem", "Query", "Scan", "BatchGetItem"].includes(r.command))
            expect(writes).toEqual([])
          }),
      )
    }
  })
})
