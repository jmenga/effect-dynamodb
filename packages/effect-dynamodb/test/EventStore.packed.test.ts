/**
 * EventStore packed storage (#147): `makeStream({ storedAs: { data } })` and
 * `snapshot.storedAs` — event data and snapshot state as one JSON string (`S`),
 * compressed to binary (`B`) over a threshold when smaller.
 *
 * Runs against an in-memory `DynamoClient` that understands the requests the
 * stream sends (puts, key-condition queries on the table and its stream
 * indexes, `BatchGetItem`), so every read path is exercised end to end on a
 * stream holding a MIX of native-map, JSON and compressed events — what a
 * stream that switched encoding holds.
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Option, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { beforeEach } from "vitest"
import * as NodeCompression from "../src/compression/node.js"
import * as EventStore from "../src/EventStore.js"
import { createConditionOps } from "../src/internal/Expr.js"
import { itemBytes, transactItemBytes, transactionBytes } from "../src/internal/ItemSize.js"
import { createPathBuilder } from "../src/internal/PathBuilder.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import { missingCompressor, unregisteredCodecDefect } from "./helpers/MissingCompressor.js"
import {
  awsValidationException,
  DDB_ITEM_SIZE,
  ddbPayloadTooLarge,
  mockDynamoClientLayer,
} from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "ledger", version: 1 })
const LedgerTable = Table.make({ schema: AppSchema, entities: {} })

class Recorded extends Schema.TaggedClass<Recorded>()("Recorded", {
  kind: Schema.String,
  day: Schema.String,
  amount: Schema.Number,
  note: Schema.String,
}) {}

class Voided extends Schema.TaggedClass<Voided>()("Voided", {
  day: Schema.String,
  reason: Schema.String,
}) {}

const Metadata = Schema.Struct({ correlationId: Schema.String })

const LedgerState = Schema.Struct({
  total: Schema.Number,
  notes: Schema.Array(Schema.String),
})
type LedgerState = typeof LedgerState.Type

type LedgerEvent = Recorded | Voided

const indexes = {
  byKind: {
    index: "lsi1",
    sk: "lsi1sk",
    key: (event: LedgerEvent, version: number) =>
      event._tag === "Recorded" ? `${event.kind}#${String(version).padStart(4, "0")}` : undefined,
  },
  byKindKeys: {
    index: "lsi2",
    sk: "lsi2sk",
    projection: "keys",
    key: (_event: LedgerEvent, version: number) => String(version).padStart(4, "0"),
  },
  byDayLean: {
    type: "gsi",
    index: "gsi1",
    pk: "gsi1pk",
    sk: "gsi1sk",
    projection: "withoutMetadata",
    key: (event: LedgerEvent, version: number) =>
      `${event.day}#${String(version).padStart(4, "0")}`,
  },
  byDayKeys: {
    type: "gsi",
    index: "gsi2",
    pk: "gsi2pk",
    sk: "gsi2sk",
    projection: "keys",
    key: (event: LedgerEvent, version: number) =>
      `${event.day}#${String(version).padStart(4, "0")}`,
  },
} as const

const streamConfig = {
  table: LedgerTable,
  streamName: "Ledger",
  events: [Recorded, Voided],
  streamId: { composite: ["ledgerId"] },
  metadata: Metadata,
  indexes,
} as const

const json = DynamoModel.Packed({ format: "json" })
const gzip = DynamoModel.Packed({ format: "json", compression: { codec: "gzip" } })
const zstd = DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } })

/** Today's stream — the native map. */
const NativeLedger = EventStore.makeStream({
  ...streamConfig,
  snapshot: { schema: LedgerState, mode: "inline" },
})
/** The same stream after switching `data` to JSON. */
const JsonLedger = EventStore.makeStream({
  ...streamConfig,
  storedAs: { data: json },
  snapshot: { schema: LedgerState, mode: "inline", storedAs: json },
})
/** ...then to JSON + gzip. */
const GzipLedger = EventStore.makeStream({
  ...streamConfig,
  storedAs: { data: gzip },
  snapshot: { schema: LedgerState, mode: "inline", storedAs: gzip },
})
/** ...then to JSON + zstd (the recommended codec). */
const ZstdLedger = EventStore.makeStream({
  ...streamConfig,
  storedAs: { data: zstd },
  snapshot: { schema: LedgerState, mode: "inline", storedAs: zstd },
})

const ledgerDecider: EventStore.Decider<
  LedgerState,
  { readonly amount: number; readonly note: string },
  LedgerEvent
> = {
  initialState: { total: 0, notes: [] },
  decide: (command) =>
    Effect.succeed([
      new Recorded({ kind: "sale", day: "2026-10-11", amount: command.amount, note: command.note }),
    ]),
  evolve: (state, event) =>
    event._tag === "Recorded"
      ? { total: state.total + event.amount, notes: [...state.notes, event.note] }
      : state,
}

/** A note long and repetitive enough to cross the 1 KiB threshold and compress well. */
const LONG_NOTE = "the quick brown fox jumps over the lazy dog; ".repeat(60)

const recorded = (amount: number, note = `note ${amount}`) =>
  new Recorded({ kind: "sale", day: "2026-10-11", amount, note })

const id = { ledgerId: "L-1" }

// ---------------------------------------------------------------------------
// In-memory DynamoClient
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>

const INDEXES: Record<
  string,
  { readonly pk: string; readonly sk: string; readonly projection: string; readonly lsi: boolean }
> = {
  lsi1: { pk: "pk", sk: "lsi1sk", projection: "all", lsi: true },
  lsi2: { pk: "pk", sk: "lsi2sk", projection: "keys", lsi: true },
  gsi1: { pk: "gsi1pk", sk: "gsi1sk", projection: "withoutMetadata", lsi: false },
  gsi2: { pk: "gsi2pk", sk: "gsi2sk", projection: "keys", lsi: false },
}

const store = new Map<string, Item>()
const sentTransactions: Array<ReadonlyArray<TransactWriteItem>> = []
const sentPuts: Array<Item> = []
let rejectNextWrite: Error | undefined

const keyOf = (item: Item) => `${item.pk?.S}|${item.sk?.S}`

const project = (
  item: Item,
  expression: string | undefined,
  names: Record<string, string>,
): Item => {
  if (expression === undefined) return item
  const out: Item = {}
  for (const token of expression.split(",").map((t) => t.trim())) {
    const name = token.startsWith("#") ? names[token]! : token
    if (item[name] !== undefined) out[name] = item[name]!
  }
  return out
}

const runQuery = (input: {
  readonly IndexName?: string | undefined
  readonly KeyConditionExpression?: string | undefined
  readonly FilterExpression?: string | undefined
  readonly ProjectionExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
  readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
  readonly ScanIndexForward?: boolean | undefined
  readonly Limit?: number | undefined
  readonly ExclusiveStartKey?: Item | undefined
  readonly Select?: string | undefined
}) => {
  const names = input.ExpressionAttributeNames ?? {}
  const values = input.ExpressionAttributeValues ?? {}
  const spec =
    input.IndexName === undefined
      ? { pk: "pk", sk: "sk", projection: "all", lsi: true }
      : INDEXES[input.IndexName]!
  const kc = /^(#\w+) = (:\w+)(?: AND (.*))?$/.exec(input.KeyConditionExpression ?? "")!
  const pkValue = values[kc[2]!]!.S
  let rows = [...store.values()]
    .filter((item) => item[spec.pk]?.S === pkValue && item[spec.sk] !== undefined)
    .sort((a, b) =>
      a[spec.sk]!.S! < b[spec.sk]!.S! ? -1 : a[spec.sk]!.S! > b[spec.sk]!.S! ? 1 : 0,
    )
  const cond = kc[3]
  if (cond !== undefined) {
    const sk = (item: Item) => item[spec.sk]!.S!
    const begins = /^begins_with\((#\w+), (:\w+)\)$/.exec(cond)
    const between = /^(#\w+) BETWEEN (:\w+) AND (:\w+)$/.exec(cond)
    const compare = /^(#\w+) (=|<|<=|>|>=) (:\w+)$/.exec(cond)
    if (begins) rows = rows.filter((item) => sk(item).startsWith(values[begins[2]!]!.S!))
    else if (between) {
      const low = values[between[2]!]!.S!
      const high = values[between[3]!]!.S!
      rows = rows.filter((item) => sk(item) >= low && sk(item) <= high)
    } else if (compare) {
      const v = values[compare[3]!]!.S!
      const op = compare[2]!
      rows = rows.filter((item) => {
        const s = sk(item)
        return op === "="
          ? s === v
          : op === "<"
            ? s < v
            : op === "<="
              ? s <= v
              : op === ">"
                ? s > v
                : s >= v
      })
    } else throw new Error(`mock: unsupported key condition ${cond}`)
  }
  if (input.ScanIndexForward === false) rows.reverse()
  if (input.ExclusiveStartKey !== undefined) {
    const start = input.ExclusiveStartKey
    const at = rows.findIndex((item) => item.pk?.S === start.pk?.S && item.sk?.S === start.sk?.S)
    rows = rows.slice(at + 1)
  }
  let lastEvaluatedKey: Item | undefined
  if (input.Limit !== undefined && rows.length > input.Limit) {
    rows = rows.slice(0, input.Limit)
    const last = rows[rows.length - 1]!
    lastEvaluatedKey = {
      pk: last.pk!,
      sk: last.sk!,
      [spec.pk]: last[spec.pk]!,
      [spec.sk]: last[spec.sk]!,
    }
  }
  const owner = /(#\w+) IN \(([^)]*)\)/.exec(input.FilterExpression ?? "")
  if (owner) {
    const attribute = names[owner[1]!]!
    const allowed = owner[2]!.split(",").map((p) => values[p.trim()]!.S)
    rows = rows.filter((item) => allowed.includes(item[attribute]?.S))
  }
  const fetched =
    spec.lsi && (input.Select === "ALL_ATTRIBUTES" || input.ProjectionExpression !== undefined)
  const items = rows.map((item) => {
    let row: Item = item
    if (spec.projection === "withoutMetadata") {
      row = { ...item }
      delete row.metadata
    } else if (spec.projection === "keys" && !fetched) {
      row = {}
      for (const attr of ["pk", "sk", spec.pk, spec.sk, "__edd_e__"]) {
        if (item[attr] !== undefined) row[attr] = item[attr]!
      }
    }
    return project(row, input.ProjectionExpression, names)
  })
  return {
    Items: items,
    ...(lastEvaluatedKey === undefined ? {} : { LastEvaluatedKey: lastEvaluatedKey }),
  }
}

const InMemoryClient = mockDynamoClientLayer({
  query: (input) => Effect.sync(() => runQuery(input) as never),
  transactWriteItems: (input) =>
    Effect.suspend(() => {
      const items = input.TransactItems ?? []
      sentTransactions.push(items)
      if (rejectNextWrite !== undefined) {
        const cause = rejectNextWrite
        rejectNextWrite = undefined
        return Effect.fail(new DynamoError({ operation: "TransactWriteItems", cause }))
      }
      for (const item of items) {
        if (item.Put?.Item !== undefined) store.set(keyOf(item.Put.Item), item.Put.Item)
      }
      return Effect.succeed({} as never)
    }),
  putItem: (input) =>
    Effect.sync(() => {
      sentPuts.push(input.Item!)
      store.set(keyOf(input.Item!), input.Item!)
      return {} as never
    }),
  getItem: (input) =>
    Effect.sync(() => {
      const item = store.get(keyOf(input.Key!))
      return (item === undefined ? {} : { Item: item }) as never
    }),
  batchGetItem: (input) =>
    Effect.sync(() => {
      const Responses: Record<string, Array<Item>> = {}
      for (const [table, request] of Object.entries(input.RequestItems ?? {})) {
        Responses[table] = (request.Keys ?? []).flatMap((key) => {
          const item = store.get(keyOf(key))
          return item === undefined
            ? []
            : [project(item, request.ProjectionExpression, request.ExpressionAttributeNames ?? {})]
        })
      }
      return { Responses } as never
    }),
})

const TableLayer = LedgerTable.layer({ name: "ledger-table" })
const Codecs = Compression.layer([NodeCompression.gzip(), NodeCompression.zstd()])
/** Client + table + every codec. */
const TestLayer = Layer.mergeAll(InMemoryClient, TableLayer, Codecs)
/** Client + table, no `Compression` service at all. */
const NoCodecs = Layer.mergeAll(InMemoryClient, TableLayer)

beforeEach(() => {
  store.clear()
  sentTransactions.length = 0
  sentPuts.length = 0
  rejectNextWrite = undefined
})

/** The stored event items of the stream, by version. */
const storedEvents = () =>
  [...store.values()]
    .filter((item) => item.__edd_e__?.S === "ledger.event")
    .sort((a, b) => Number(a.version!.N) - Number(b.version!.N))

const storedSnapshot = () => [...store.values()].find((i) => i.__edd_e__?.S === "ledger.snapshot")

/**
 * Write the mixed stream: v1–2 native maps, v3 JSON (`S`), v4 gzip (`B`),
 * v5 JSON under the zstd threshold (`S`), v6 zstd (`B`).
 */
const writeMixedStream = Effect.gen(function* () {
  yield* NativeLedger.append(
    id,
    [recorded(1), new Voided({ day: "2026-10-10", reason: "dup" })],
    0,
    {
      metadata: { correlationId: "c-native" },
    },
  )
  yield* JsonLedger.append(id, [recorded(3)], 2, { metadata: { correlationId: "c-json" } })
  yield* GzipLedger.append(id, [recorded(4, LONG_NOTE)], 3, {
    metadata: { correlationId: "c-gzip" },
  })
  yield* ZstdLedger.append(id, [recorded(5)], 4, { metadata: { correlationId: "c-small" } })
  yield* ZstdLedger.append(id, [recorded(6, LONG_NOTE)], 5, {
    metadata: { correlationId: "c-zstd" },
  })
})

/** The wire form of each event of the mixed stream — what raw rows must return. */
const mixedWire = [
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 1, note: "note 1" },
  { _tag: "Voided", day: "2026-10-10", reason: "dup" },
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 3, note: "note 3" },
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 4, note: LONG_NOTE },
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 5, note: "note 5" },
  { _tag: "Recorded", kind: "sale", day: "2026-10-11", amount: 6, note: LONG_NOTE },
]

const expectMixedEvents = (
  events: ReadonlyArray<EventStore.StreamEvent<LedgerEvent, unknown>>,
  versions: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6],
) => {
  expect(events.map((e) => e.version)).toEqual(versions)
  for (const event of events) {
    const wire = mixedWire[event.version - 1]!
    expect(event.eventType).toBe(wire._tag)
    expect(event.data).toBeInstanceOf(wire._tag === "Recorded" ? Recorded : Voided)
    const { _tag, ...fields } = wire
    expect(event.data).toMatchObject(fields)
  }
}

const header = (item: Item) => item.data?.B?.[0]

// ---------------------------------------------------------------------------
// makeStream config
// ---------------------------------------------------------------------------

describe("EventStore packed storage — config (#147)", () => {
  it("exposes the resolved settings", () => {
    expect(NativeLedger.storedAs).toEqual({ data: undefined, state: undefined })
    expect(ZstdLedger.storedAs).toEqual({ data: zstd, state: zstd })
    const NoSnapshot = EventStore.makeStream({ ...streamConfig, storedAs: { data: json } })
    expect(NoSnapshot.storedAs).toEqual({ data: json, state: undefined })
  })

  it("[EDD-9079] refuses a storedAs key other than data, naming why", () => {
    expect(() =>
      EventStore.makeStream({ ...streamConfig, storedAs: { metadata: json } as never }),
    ).toThrow(/\[EDD-9079\].*"metadata".*metadata always stays a map/)
    expect(() =>
      EventStore.makeStream({ ...streamConfig, storedAs: { state: json } as never }),
    ).toThrow(/\[EDD-9079\].*snapshot\.storedAs/)
  })

  it("[EDD-9079] refuses a value that is not a Packed config", () => {
    expect(() =>
      EventStore.makeStream({ ...streamConfig, storedAs: { data: { format: "json" } as never } }),
    ).toThrow(/\[EDD-9079\] EventStream "Ledger": storedAs\.data must be a DynamoModel\.Packed/)
    expect(() => EventStore.makeStream({ ...streamConfig, storedAs: "json" as never })).toThrow(
      /\[EDD-9079\]/,
    )
    expect(() =>
      EventStore.makeStream({
        ...streamConfig,
        snapshot: { schema: LedgerState, storedAs: "json" as never },
      }),
    ).toThrow(/\[EDD-9079\].*snapshot\.storedAs must be/)
  })

  it("[EDD-9073] refuses a packed snapshot whose state is not object/array-shaped", () => {
    expect(() =>
      EventStore.makeStream({
        ...streamConfig,
        snapshot: { schema: Schema.Number, storedAs: json },
      }),
    ).toThrow(/\[EDD-9073\].*a number/)
    // Unpacked, any state schema is still accepted.
    expect(() =>
      EventStore.makeStream({ ...streamConfig, snapshot: { schema: Schema.Number } }),
    ).not.toThrow()
  })

  it("the types admit only `data` in storedAs", () => {
    // @ts-expect-error — metadata always stays a map
    const bad = () => EventStore.makeStream({ ...streamConfig, storedAs: { metadata: json } })
    expect(bad).toThrow(/EDD-9079/)
  })
})

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

describe("EventStore packed storage — append (#147)", () => {
  it.effect("stores data as JSON (S) with storedAs json; metadata stays a map", () =>
    Effect.gen(function* () {
      yield* JsonLedger.append(id, [recorded(3)], 0, { metadata: { correlationId: "c-1" } })
      const [item] = storedEvents()
      expect(item!.data!.S).toBe(JSON.stringify(mixedWire[2]))
      expect(item!.metadata!.M).toEqual({ correlationId: { S: "c-1" } })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("compresses over the threshold (B, header byte per codec), S under it", () =>
    Effect.gen(function* () {
      yield* GzipLedger.append(id, [recorded(1, LONG_NOTE), recorded(2)], 0)
      yield* ZstdLedger.append(id, [recorded(3, LONG_NOTE)], 2)
      const [big, small, zstdBig] = storedEvents()
      expect(header(big!)).toBe(0x21)
      expect(small!.data!.S).toBeDefined()
      expect(header(zstdBig!)).toBe(0x23)
      // Smaller than the JSON it replaces.
      expect(big!.data!.B!.length).toBeLessThan(JSON.stringify(mixedWire[3]).length / 4)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "an unbound stream whose codec is not registered dies with EDD-9078 on first use, before writing",
    () =>
      Effect.gen(function* () {
        // Even a value under the threshold: the stream meets zstd values on
        // every read, so every operation needs the codec.
        const message = unregisteredCodecDefect(
          yield* Effect.exit(ZstdLedger.append(id, [recorded(1)], 0)),
        )
        expect(message).toContain('EventStore (first use of stream "Ledger")')
        expect(message).toContain('stream "Ledger" stores "data" packed with codec "zstd"')
        expect(message).toContain('stream "Ledger" stores "state" packed with codec "zstd"')
        expect(message).toContain("no Compression registry is in scope")
        expect(store.size).toBe(0)
        // A registry without the codec is refused the same way, by name.
        const gzipOnly = unregisteredCodecDefect(
          yield* Effect.exit(
            ZstdLedger.read(id).pipe(Effect.provide(Compression.layer([NodeCompression.gzip()]))),
          ),
        )
        expect(gzipOnly).toContain('the Compression registry in scope has "gzip"')
        // With the codec in scope the same stream works.
        yield* ZstdLedger.append(id, [recorded(1, LONG_NOTE)], 0).pipe(Effect.provide(Codecs))
        expect(storedEvents()).toHaveLength(1)
      }).pipe(Effect.provide(NoCodecs)),
  )

  it.effect("refuses non-JSON wire values, naming the path", () =>
    Effect.gen(function* () {
      class Stamped extends Schema.TaggedClass<Stamped>()("Stamped", {
        at: Schema.Date,
      }) {}
      const Stamps = EventStore.makeStream({
        table: LedgerTable,
        streamName: "Stamps",
        events: [Stamped],
        streamId: { composite: ["ledgerId"] },
        storedAs: { data: json },
      })
      const error = yield* Stamps.append(id, [new Stamped({ at: new Date(0) })], 0).pipe(
        Effect.flip,
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).operation).toBe("EventStore.append.packed")
      expect(String((error as ValidationError).cause)).toContain("data.at is a Date")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("eventMetadata, eventTimestamps and idempotency apply as on a native stream", () =>
    Effect.gen(function* () {
      yield* ZstdLedger.append(id, [recorded(1, LONG_NOTE), recorded(2)], 0, {
        eventMetadata: [{ correlationId: "a" }, undefined],
        idempotency: { commandId: "cmd-1" },
      })
      const events = yield* ZstdLedger.read(id)
      expect(events.map((e) => e.metadata)).toEqual([{ correlationId: "a" }, undefined])
      expect(events[0]!.data).toEqual(recorded(1, LONG_NOTE))
      const sentinel = [...store.values()].find((i) => i.__edd_e__?.S === "ledger.command")
      expect(sentinel?.commandId?.S).toBe("cmd-1")
      expect(sentinel?.data).toBeUndefined()
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Read paths over a mixed stream
// ---------------------------------------------------------------------------

describe("EventStore packed storage — every read path on a mixed M/S/B stream (#147)", () => {
  it.effect("the stream really is mixed", () =>
    Effect.gen(function* () {
      yield* writeMixedStream
      const forms = storedEvents().map((item) =>
        item.data!.M !== undefined ? "M" : item.data!.S !== undefined ? "S" : `B${header(item)}`,
      )
      expect(forms).toEqual(["M", "M", "S", "B33", "S", "B35"])
    }).pipe(Effect.provide(TestLayer)),
  )

  for (const [label, stream] of [
    ["native", NativeLedger],
    ["json", JsonLedger],
    ["gzip", GzipLedger],
    ["zstd", ZstdLedger],
  ] as const) {
    it.effect(`read / readFrom / currentVersion through the ${label} definition`, () =>
      Effect.gen(function* () {
        yield* writeMixedStream
        expectMixedEvents(yield* stream.read(id))
        expectMixedEvents(yield* stream.readFrom(id, 3), [4, 5, 6])
        expect(yield* stream.currentVersion(id)).toBe(6)
        expect((yield* stream.read(id)).map((e) => e.metadata)).toEqual([
          { correlationId: "c-native" },
          { correlationId: "c-native" },
          { correlationId: "c-json" },
          { correlationId: "c-gzip" },
          { correlationId: "c-small" },
          { correlationId: "c-zstd" },
        ])
      }).pipe(Effect.provide(TestLayer)),
    )
  }

  it.effect("query.events, with combinators and fold", () =>
    Effect.gen(function* () {
      yield* writeMixedStream
      const all = yield* Query.collect(ZstdLedger.query.events(id))
      expectMixedEvents(all)
      const lastTwo = yield* ZstdLedger.query
        .events(id)
        .pipe(Query.reverse, Query.limit(2), Query.collect)
      expect(lastTwo.map((e) => e.version)).toEqual([6, 5])
      const filtered = yield* ZstdLedger.query.events(id).pipe(
        Query.filterBy((e) => e.data._tag === "Recorded" && e.data.amount > 3),
        Query.collect,
      )
      expect(filtered.map((e) => e.version)).toEqual([4, 5, 6])
      expect(EventStore.fold(ledgerDecider, all).total).toBe(1 + 3 + 4 + 5 + 6)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("readIndex on every projection: LSI all, LSI keys, GSI withoutMetadata, GSI keys", () =>
    Effect.gen(function* () {
      yield* writeMixedStream
      const recordedVersions = [1, 3, 4, 5, 6]
      expectMixedEvents(yield* ZstdLedger.readIndex("byKind", id), recordedVersions)
      expectMixedEvents(yield* ZstdLedger.readIndex("byKindKeys", id))
      const lean = yield* ZstdLedger.readIndex("byDayLean", id)
      expectMixedEvents(lean, [2, 1, 3, 4, 5, 6])
      expect(lean.every((e) => e.metadata === undefined)).toBe(true)
      const keys = yield* ZstdLedger.readIndex("byDayKeys", id, { beginsWith: "2026-10-11" })
      expectMixedEvents(keys, recordedVersions)
      expect(keys[0]!.metadata).toEqual({ correlationId: "c-native" })
      expectMixedEvents(
        yield* Query.collect(ZstdLedger.query.index("byDayKeys", id)),
        [2, 1, 3, 4, 5, 6],
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "reading a B value without its codec fails with a ValidationError caused by CompressorNotRegistered",
    () =>
      Effect.gen(function* () {
        yield* writeMixedStream.pipe(Effect.provide(Codecs))
        // A stream configured with plain JSON names no codec, so it runs
        // without a registry — and meets the gzip values written earlier.
        const error = yield* JsonLedger.read(id).pipe(Effect.flip)
        expect(missingCompressor(error)).toMatchObject({
          codec: "gzip",
          direction: "decompress",
          attribute: "data",
        })
        // Rows that need no codec still read.
        expectMixedEvents(yield* ZstdLedger.readFrom(id, 4).pipe(Effect.provide(Codecs)), [5, 6])
        // ZstdLedger names zstd itself: without it, it dies before reading.
        unregisteredCodecDefect(yield* Effect.exit(ZstdLedger.readFrom(id, 4)))
        const events = yield* NativeLedger.query.events(id).pipe(Query.limit(3), Query.collect)
        expect(events.map((e) => e.version)).toEqual([1, 2, 3])
      }).pipe(Effect.provide(NoCodecs)),
  )

  it.effect("a corrupt packed value is a ValidationError naming data", () =>
    Effect.gen(function* () {
      yield* JsonLedger.append(id, [recorded(1)], 0)
      const [item] = storedEvents()
      store.set(keyOf(item!), { ...item!, data: { B: new Uint8Array([0x40, 1, 2]) } })
      const error = yield* JsonLedger.read(id).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).operation).toBe("EventStore.decode")
      expect(String((error as ValidationError).cause)).toContain('Packed attribute "data"')
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Raw rows (R3)
// ---------------------------------------------------------------------------

describe("EventStore packed storage — raw rows return data as plain JSON (#147, R3)", () => {
  const rawData = (rows: ReadonlyArray<Record<string, unknown>>) =>
    rows.map((row) => [row.version, row.data] as const)

  it.effect("query.events + Query.select / selectPaths", () =>
    Effect.gen(function* () {
      yield* writeMixedStream
      const rows = yield* ZstdLedger.query
        .events(id)
        .pipe(Query.select(["version", "data"]), Query.collect)
      expect(rawData(rows)).toEqual(mixedWire.map((wire, i) => [i + 1, wire]))
      const paths = yield* ZstdLedger.query
        .events(id)
        .pipe(Query.selectPaths([["version"], ["data"]]), Query.collect)
      expect(rawData(paths)).toEqual(mixedWire.map((wire, i) => [i + 1, wire]))
      // A native stream definition reads the packed rows the same way.
      const native = yield* NativeLedger.query
        .events(id)
        .pipe(Query.select(["version", "data"]), Query.collect)
      expect(rawData(native)).toEqual(rawData(rows))
    }).pipe(Effect.provide(TestLayer)),
  )

  for (const name of ["byKind", "byKindKeys", "byDayLean", "byDayKeys"] as const) {
    it.effect(`query.index("${name}") + Query.select`, () =>
      Effect.gen(function* () {
        yield* writeMixedStream
        const rows = yield* ZstdLedger.query
          .index(name, id)
          .pipe(Query.select(["version", "data"]), Query.collect)
        expect(rows.length).toBeGreaterThan(0)
        for (const [version, data] of rawData(rows)) {
          expect(data).toEqual(mixedWire[(version as number) - 1])
        }
        // Every row carries only what was selected.
        expect(rows.every((row) => Object.keys(row).sort().join() === "data,version")).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )
  }

  it.effect("ignoreOwnership: another entity type's row keeps its plain string data", () =>
    Effect.gen(function* () {
      yield* writeMixedStream
      // A row of another type in the stream's partition and event SK range.
      const first = storedEvents()[0]!
      const foreign: Item = {
        ...first,
        sk: { S: `${first.sk!.S}#foreign` },
        __edd_e__: { S: "audit.note" },
        data: { S: "plain text, not JSON" },
      }
      store.set(keyOf(foreign), foreign)
      const rows = yield* ZstdLedger.query
        .events(id)
        .pipe(Query.ignoreOwnership, Query.select(["version", "data"]), Query.collect)
      expect(rows).toHaveLength(7)
      expect(rows).toContainEqual({ version: 1, data: "plain text, not JSON" })
      // The stream's own rows are still read by their stored form, and the
      // borrowed __edd_e__ is stripped from every row.
      expect(
        rows.filter((row) => row.data !== "plain text, not JSON").map((row) => row.data),
      ).toEqual(mixedWire)
      expect(rows.every((row) => Object.keys(row).sort().join() === "data,version")).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a raw row that does not select data is untouched", () =>
    Effect.gen(function* () {
      yield* writeMixedStream
      const rows = yield* ZstdLedger.query.events(id).pipe(Query.select(["version"]), Query.collect)
      expect(rows).toEqual([1, 2, 3, 4, 5, 6].map((version) => ({ version })))
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Filters and projections (EDD-9076)
// ---------------------------------------------------------------------------

describe("EventStore packed storage — filters and projections (#147)", () => {
  type Row = { data: { amount: number; tags: ReadonlyArray<string> }; version: number }
  const ops = createConditionOps<Row>()
  const t = createPathBuilder<Row>()

  it("Query.filterExpr on a path inside packed data is refused, pointing to Query.filterBy", () => {
    expect(() =>
      ZstdLedger.query.events(id).pipe(Query.filterExpr(ops.gt(t.data.amount, 100))),
    ).toThrow(
      /\[EDD-9076\] EventStream "Ledger": the filter addresses "data\.amount", but `data` is stored packed \(format "json"\).*Query\.filterBy/,
    )
    expect(() =>
      ZstdLedger.query.index("byDayLean", id).pipe(Query.filterExpr(ops.eq(t.data, {} as never))),
    ).toThrow(/\[EDD-9076\].*applies = to "data"/)
    expect(() =>
      ZstdLedger.query.events(id).pipe(Query.filterExpr(ops.gt(t.data.tags.size(), 1))),
    ).toThrow(/\[EDD-9076\].*size\(\)/)
    expect(() =>
      ZstdLedger.query
        .events(id)
        .pipe(Query.filterExpr(ops.and(ops.gt(t.version, 1), ops.not(ops.exists(t.data.amount))))),
    ).toThrow(/\[EDD-9076\].*"data\.amount"/)
  })

  it("attribute_exists / attribute_not_exists on the whole data, and other attributes, are allowed", () => {
    expect(() =>
      ZstdLedger.query
        .events(id)
        .pipe(
          Query.filterExpr(ops.and(ops.exists(t.data), ops.gt(t.version, 1))),
          Query.filterExpr(ops.notExists(t.data)),
        ),
    ).not.toThrow()
  })

  it("a stream without storedAs.data keeps accepting data.* filters", () => {
    expect(() =>
      NativeLedger.query.events(id).pipe(Query.filterExpr(ops.gt(t.data.amount, 100))),
    ).not.toThrow()
  })

  it("a projection inside packed data is refused; the whole data is allowed", () => {
    expect(() => ZstdLedger.query.events(id).pipe(Query.select(["data.amount"]))).toThrow(
      /\[EDD-9076\].*projection names "data\.amount"/,
    )
    expect(() => ZstdLedger.query.events(id).pipe(Query.selectPaths([["data", "amount"]]))).toThrow(
      /\[EDD-9076\].*"data\.amount"/,
    )
    expect(() => ZstdLedger.query.events(id).pipe(Query.select(["data", "version"]))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshots (R4)
// ---------------------------------------------------------------------------

describe("EventStore packed storage — snapshots (#147, R4)", () => {
  const bigState = (n: number): LedgerState => ({
    total: n,
    notes: Array.from({ length: 200 }, (_, i) => `entry ${i}: ${LONG_NOTE.slice(0, 200)}`),
  })

  it.effect("an inline snapshot is packed and compressed in the append transaction", () =>
    Effect.gen(function* () {
      yield* ZstdLedger.append(id, [recorded(1)], 0, { snapshot: bigState(1) })
      const snap = storedSnapshot()!
      expect(snap.state!.B![0]).toBe(0x23)
      const json = JSON.stringify(bigState(1))
      expect(snap.state!.B!.length).toBeLessThan(json.length / 5)
      const latest = yield* ZstdLedger.readLatest(id)
      expect(Option.getOrThrow(latest.snapshot).state).toEqual(bigState(1))
      expect(latest.version).toBe(1)
      const unverified = yield* ZstdLedger.readLatest(id, { verifySnapshot: false })
      expect(Option.getOrThrow(unverified.snapshot).state).toEqual(bigState(1))
      expect(Option.getOrThrow(yield* ZstdLedger.readSnapshot(id)).state).toEqual(bigState(1))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("writeSnapshot packs; snapshots written natively before still decode", () =>
    Effect.gen(function* () {
      yield* NativeLedger.append(id, [recorded(1)], 0, { snapshot: { total: 1, notes: ["a"] } })
      expect(storedSnapshot()!.state!.M).toBeDefined()
      // The packed definition reads the native snapshot…
      expect(Option.getOrThrow(yield* GzipLedger.readSnapshot(id)).state).toEqual({
        total: 1,
        notes: ["a"],
      })
      // …and overwrites it packed.
      yield* GzipLedger.writeSnapshot(id, bigState(9), 2)
      expect(sentPuts[0]!.state!.B![0]).toBe(0x21)
      // A native definition still reads the packed snapshot (state dispatch).
      expect(Option.getOrThrow(yield* NativeLedger.readSnapshot(id)).state).toEqual(bigState(9))
      // JSON under the threshold is S.
      yield* JsonLedger.writeSnapshot(id, { total: 3, notes: [] }, 3)
      expect(storedSnapshot()!.state!.S).toBe('{"total":3,"notes":[]}')
      expect(Option.getOrThrow(yield* ZstdLedger.readSnapshot(id)).state).toEqual({
        total: 3,
        notes: [],
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("readLatest replays packed events after a packed snapshot", () =>
    Effect.gen(function* () {
      yield* writeMixedStream
      yield* ZstdLedger.writeSnapshot(id, { total: 4, notes: [] }, 3)
      const latest = yield* ZstdLedger.readLatest(id)
      expect(Option.getOrThrow(latest.snapshot).asOfVersion).toBe(3)
      expectMixedEvents(latest.events, [4, 5, 6])
      expect(latest.version).toBe(6)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "a packed snapshot without its codec fails with a ValidationError caused by CompressorNotRegistered",
    () =>
      Effect.gen(function* () {
        yield* ZstdLedger.writeSnapshot(id, bigState(1), 1).pipe(Effect.provide(Codecs))
        // JsonLedger names no codec: it reads without a registry and meets zstd.
        const error = yield* JsonLedger.readSnapshot(id).pipe(Effect.flip)
        expect(missingCompressor(error)).toMatchObject({
          _tag: "CompressorNotRegistered",
          codec: "zstd",
          direction: "decompress",
          entityType: "ledger.snapshot",
          attribute: "state",
        })
      }).pipe(Effect.provide(NoCodecs)),
  )

  it.effect("commandHandler with a packed inline snapshot: append, load, append again", () =>
    Effect.gen(function* () {
      const handle = EventStore.commandHandler(ledgerDecider, ZstdLedger, {
        idempotency: {},
      })
      const first = yield* handle(
        id,
        { amount: 5, note: LONG_NOTE },
        {
          commandId: "c-1",
          eventMetadata: ({ events }) => events.map(() => ({ correlationId: "m-1" })),
          eventTimestamps: ({ events }) => events.map(() => undefined),
        },
      )
      expect(first.version).toBe(1)
      expect(storedSnapshot()!.state!.B).toBeDefined()
      const second = yield* handle(id, { amount: 7, note: "short" }, { commandId: "c-2" })
      expect(second.state).toEqual({ total: 12, notes: [LONG_NOTE, "short"] })
      const unverified = EventStore.commandHandler(ledgerDecider, ZstdLedger, {
        verifySnapshot: false,
      })
      const third = yield* unverified(id, { amount: 1, note: "x" })
      expect(third.state.total).toBe(13)
      const events = yield* ZstdLedger.read(id)
      expect(events.map((e) => e.metadata)).toEqual([
        { correlationId: "m-1" },
        undefined,
        undefined,
      ])
      expect(EventStore.fold(ledgerDecider, events)).toEqual(third.state)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Size accounting (R1, R4)
// ---------------------------------------------------------------------------

describe("EventStore packed storage — size accounting (#147, R1/R4)", () => {
  it.effect("measureAppend equals the item and transaction sizes append sends", () =>
    Effect.gen(function* () {
      yield* ZstdLedger.append(id, [recorded(1)], 0)
      sentTransactions.length = 0
      const events = [recorded(2, LONG_NOTE), recorded(3), new Voided({ day: "d", reason: "r" })]
      const options = {
        eventMetadata: [{ correlationId: "a" }, undefined, { correlationId: "c" }],
        idempotency: { commandId: "cmd-9", ttl: "1 day" },
        snapshot: { total: 5, notes: [LONG_NOTE] },
      } as const
      const measured = yield* ZstdLedger.measureAppend(id, events, 1, options)
      yield* ZstdLedger.append(id, events, 1, options)
      const [sent] = sentTransactions
      // [contiguity check, 3 events, sentinel, snapshot]
      expect(sent).toHaveLength(6)
      expect(measured.events).toEqual(sent!.slice(1, 4).map((item) => itemBytes(item.Put!.Item!)))
      expect(measured.sentinel).toBe(itemBytes(sent![4]!.Put!.Item!))
      expect(measured.snapshot).toBe(itemBytes(sent![5]!.Put!.Item!))
      expect(measured.transactionBytes).toBe(transactionBytes(sent!))
      // Packed bytes, not a map estimate: the compressed event is far smaller
      // than its JSON.
      expect(measured.events[0]!).toBeLessThan(JSON.stringify(mixedWire[3]).length / 4)
      // Nothing was written by measuring.
      expect(sentTransactions).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("measureAppend: no-op, invalid options, additionalItems, missing codec", () =>
    Effect.gen(function* () {
      expect(yield* ZstdLedger.measureAppend(id, [], 0)).toEqual({
        events: [],
        sentinel: undefined,
        snapshot: undefined,
        transactionBytes: 0,
      })
      const invalid = yield* ZstdLedger.measureAppend(id, [recorded(1)], 0, {
        eventMetadata: [],
      }).pipe(Effect.flip)
      expect(invalid).toBeInstanceOf(ValidationError)
      const additional = yield* ZstdLedger.measureAppend(id, [recorded(1)], 0, {
        additionalItems: [],
      } as never).pipe(Effect.flip)
      expect(String((additional as ValidationError).cause)).toContain("additionalItems")
    }).pipe(Effect.provide(Layer.merge(TableLayer, Codecs))),
  )

  it.effect("measureAppend needs only TableConfig, and the codecs the stream names", () =>
    Effect.gen(function* () {
      const json = yield* JsonLedger.measureAppend(id, [recorded(1, LONG_NOTE)], 0)
      expect(json.events).toHaveLength(1)
      unregisteredCodecDefect(yield* Effect.exit(ZstdLedger.measureAppend(id, [recorded(1)], 0)))
      const zstd = yield* ZstdLedger.measureAppend(id, [recorded(1, LONG_NOTE)], 0).pipe(
        Effect.provide(Codecs),
      )
      expect(zstd.events[0]!).toBeLessThan(json.events[0]!)
    }).pipe(Effect.provide(TableLayer)),
  )

  it.effect("measureSnapshot equals the snapshot item writeSnapshot sends", () =>
    Effect.gen(function* () {
      const state = { total: 1, notes: [LONG_NOTE, LONG_NOTE] }
      const bytes = yield* GzipLedger.measureSnapshot(id, state, 4)
      yield* GzipLedger.writeSnapshot(id, state, 4)
      expect(bytes).toBe(itemBytes(sentPuts[0]!))
      const native = yield* NativeLedger.measureSnapshot(id, state, 4)
      expect(bytes).toBeLessThan(native)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the item-size diagnosis reports the stored (packed) size of the event", () =>
    Effect.gen(function* () {
      const huge = recorded(1, "x".repeat(420_000))
      const measured = yield* JsonLedger.measureAppend(id, [huge], 0)
      rejectNextWrite = awsValidationException(DDB_ITEM_SIZE)
      const error = yield* JsonLedger.append(id, [huge], 0).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain(
        `the item of the event at version 1, at pk=$ledger#v1#ledger#l-1`,
      )
      expect(String((error as ValidationError).cause)).toContain(
        `${measured.events[0]} bytes by DynamoDB's item-size rules`,
      )
      // The stored item is the JSON string, not a map.
      expect(sentTransactions[0]![0]!.Put!.Item!.data!.S).toBeDefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the 4 MB diagnosis counts the JSON inline snapshot's stored bytes", () =>
    Effect.gen(function* () {
      const events = Array.from({ length: 11 }, (_, i) => recorded(i + 1, "y".repeat(390_000)))
      const snapshotState = {
        total: 1,
        notes: Array.from({ length: 400 }, () => LONG_NOTE),
      }
      const measured = yield* JsonLedger.measureAppend(id, events, 0, { snapshot: snapshotState })
      rejectNextWrite = awsValidationException(ddbPayloadTooLarge(4_300_000))
      const error = yield* JsonLedger.append(id, events, 0, { snapshot: snapshotState }).pipe(
        Effect.flip,
      )
      const text = String((error as ValidationError).cause)
      expect(text).toContain(
        `the library measures the request at ${measured.transactionBytes} bytes`,
      )
      const [sent] = sentTransactions
      const snapshotPut = sent![sent!.length - 1]!
      expect(snapshotPut.Put!.Item!.state!.S).toBeDefined() // JSON, under no compression
      expect(transactItemBytes(snapshotPut)).toBe(measured.snapshot)
      // With zstd the same snapshot is a fraction of its JSON.
      const zstdMeasured = yield* ZstdLedger.measureAppend(id, events.slice(0, 1), 0, {
        snapshot: snapshotState,
      })
      expect(zstdMeasured.snapshot!).toBeLessThan(measured.snapshot! / 20)
    }).pipe(Effect.provide(TestLayer)),
  )
  it.effect(
    "the 400 KB and 4 MB diagnoses attribute a compressed (B) inline snapshot by its stored bytes",
    () =>
      Effect.gen(function* () {
        // ~48 KB of folded state, compressed by zstd to a few KB.
        const snapshotState = {
          total: 1,
          notes: Array.from(
            { length: 18 },
            (_, i) =>
              `${LONG_NOTE}${Array.from({ length: 60 }, (_, k) => (k * 7919 + i * 104_729) % 9973).join(",")}`,
          ),
        }
        expect(JSON.stringify(snapshotState).length).toBeGreaterThan(45_000)
        const events = [recorded(1)]
        const measured = yield* ZstdLedger.measureAppend(id, events, 0, { snapshot: snapshotState })
        expect(measured.snapshot!).toBeLessThan(JSON.stringify(snapshotState).length / 5)
        // The largest item, so the 400 KB diagnosis names it.
        expect(measured.snapshot!).toBeGreaterThan(measured.events[0]!)
        const snapshotAt = `the inline snapshot, at pk=$ledger#v1#ledger#l-1, sk=$ledger#v1#ledger.snapshot`

        rejectNextWrite = awsValidationException(ddbPayloadTooLarge(4_300_000))
        const tooLarge = yield* ZstdLedger.append(id, events, 0, { snapshot: snapshotState }).pipe(
          Effect.flip,
        )
        const tooLargeText = String((tooLarge as ValidationError).cause)
        expect(tooLargeText).toContain(
          `the library measures the request at ${measured.transactionBytes} bytes`,
        )
        expect(tooLargeText).toContain(`${snapshotAt} (${measured.snapshot} bytes)`)
        const sent = sentTransactions[0]!
        const snapshotPut = sent[sent.length - 1]!
        expect(snapshotPut.Put!.Item!.state!.B).toBeInstanceOf(Uint8Array)
        expect(transactItemBytes(snapshotPut)).toBe(measured.snapshot)
        expect(transactionBytes(sent)).toBe(measured.transactionBytes)

        rejectNextWrite = awsValidationException(DDB_ITEM_SIZE)
        const itemTooLarge = yield* ZstdLedger.append(id, events, 0, {
          snapshot: snapshotState,
        }).pipe(Effect.flip)
        expect(String((itemTooLarge as ValidationError).cause)).toContain(
          `the item of ${snapshotAt}, ${measured.snapshot} bytes by DynamoDB's item-size rules`,
        )
        expect(sentTransactions[1]!.at(-1)!.Put!.Item!.state!.B).toBeInstanceOf(Uint8Array)
      }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// DynamoDB Streams images (R2)
// ---------------------------------------------------------------------------

/** An AttributeValue map as Lambda / EventBridge Pipes deliver it: B and BS as base64. */
const toLambdaJson = (value: AttributeValue): unknown => {
  if (value.B !== undefined) return { B: Base64.encode(value.B) }
  if (value.BS !== undefined) return { BS: value.BS.map((b) => Base64.encode(b)) }
  if (value.M !== undefined) {
    return { M: Object.fromEntries(Object.entries(value.M).map(([k, v]) => [k, toLambdaJson(v)])) }
  }
  if (value.L !== undefined) return { L: value.L.map(toLambdaJson) }
  return value
}
const lambdaImage = (item: Item) =>
  Object.fromEntries(Object.entries(item).map(([k, v]) => [k, toLambdaJson(v)]))

describe("EventStore packed storage — decodeStreamImage (#147, R2)", () => {
  /** A number DynamoDB stores but the SDK's `unmarshall` cannot represent. */
  const UNREPRESENTABLE_N = "12345678901234567890.5"

  it.effect("a foreign image is none before anything is unmarshalled", () =>
    Effect.gen(function* () {
      // Another entity's DynamoDB JSON image in the same table: one bad record
      // must not fail a whole Lambda batch.
      const foreign = {
        pk: { S: "$packed#v1#order#orderid_o-1" },
        sk: { S: "$packed#v1#order" },
        __edd_e__: { S: "Order" },
        total: { N: UNREPRESENTABLE_N },
        totals: { M: { day: { N: UNREPRESENTABLE_N } } },
        blob: { B: "!!! not base64 !!!" },
        data: { S: "plain text, not JSON" },
      }
      expect(Option.isNone(yield* ZstdLedger.decodeStreamImage(foreign as never))).toBe(true)
      expect(Option.isNone(yield* NativeLedger.decodeStreamImage(foreign as never))).toBe(true)
      // An unmarshalled foreign image, and one without __edd_e__ at all.
      expect(
        Option.isNone(
          yield* ZstdLedger.decodeStreamImage({ __edd_e__: "Order", data: "plain text" }),
        ),
      ).toBe(true)
      const { __edd_e__: _, ...untyped } = foreign
      expect(Option.isNone(yield* ZstdLedger.decodeStreamImage(untyped as never))).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("this stream's own image with an unrepresentable number is a ValidationError", () =>
    Effect.gen(function* () {
      yield* ZstdLedger.append(id, [recorded(1)], 0)
      const [item] = storedEvents()
      const error = yield* ZstdLedger.decodeStreamImage({
        ...item!,
        extra: { N: UNREPRESENTABLE_N },
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ValidationError)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("returns exactly the StreamEvent read returns, for every image form", () =>
    Effect.gen(function* () {
      yield* writeMixedStream
      const read = yield* ZstdLedger.read(id)
      for (const [i, item] of storedEvents().entries()) {
        const expected = read[i]!
        const unmarshalled = fromAttributeMap(item)
        const forms: ReadonlyArray<EventStore.StreamImage> = [
          item, // DynamoDB JSON, B as bytes
          lambdaImage(item) as EventStore.StreamImage, // DynamoDB JSON, B as base64
          unmarshalled, // unmarshalled, B as bytes
          unmarshalled.data instanceof Uint8Array
            ? { ...unmarshalled, data: Base64.encode(unmarshalled.data) }
            : unmarshalled, // unmarshalled, B as base64 text
        ]
        for (const image of forms) {
          const decoded = yield* ZstdLedger.decodeStreamImage(image)
          expect(Option.getOrThrow(decoded)).toStrictEqual(expected)
          // Any definition of the stream decodes it the same way.
          expect(Option.getOrThrow(yield* NativeLedger.decodeStreamImage(image))).toStrictEqual(
            expected,
          )
        }
      }
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("none for a snapshot, a sentinel, another stream or an entity image", () =>
    Effect.gen(function* () {
      yield* ZstdLedger.append(id, [recorded(1)], 0, {
        idempotency: { commandId: "c" },
        snapshot: { total: 1, notes: [] },
      })
      const others = [...store.values()].filter((i) => i.__edd_e__?.S !== "ledger.event")
      expect(others).toHaveLength(2)
      for (const image of others) {
        expect(yield* ZstdLedger.decodeStreamImage(lambdaImage(image) as never)).toEqual(
          Option.none(),
        )
      }
      expect(
        yield* ZstdLedger.decodeStreamImage({ pk: { S: "x" }, __edd_e__: { S: "order" } }),
      ).toEqual(Option.none())
      expect(yield* ZstdLedger.decodeStreamImage({ pk: "x", __edd_e__: "other.event" })).toEqual(
        Option.none(),
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an event image that does not decode fails with ValidationError", () =>
    Effect.gen(function* () {
      yield* ZstdLedger.append(id, [recorded(1)], 0)
      const [item] = storedEvents()
      const broken = { ...item!, data: { S: '{"_tag":"Recorded","amount":"nope"}' } }
      const error = yield* ZstdLedger.decodeStreamImage(broken).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ValidationError)
      const notBase64 = { ...lambdaImage(item!), data: { B: "!!!" } }
      expect(
        yield* ZstdLedger.decodeStreamImage(notBase64 as never).pipe(Effect.flip),
      ).toBeInstanceOf(ValidationError)
      expect(yield* ZstdLedger.decodeStreamImage("nope" as never).pipe(Effect.flip)).toBeInstanceOf(
        ValidationError,
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "a compressed image without its codec fails with a ValidationError caused by CompressorNotRegistered",
    () =>
      Effect.gen(function* () {
        yield* ZstdLedger.append(id, [recorded(1, LONG_NOTE)], 0).pipe(Effect.provide(TestLayer))
        const [item] = storedEvents()
        // A decoder of a stream that names no codec meets the zstd value.
        const error = yield* JsonLedger.decodeStreamImage(lambdaImage(item!) as never).pipe(
          Effect.flip,
        )
        missingCompressor(error)
        // One that names zstd dies before decoding anything.
        unregisteredCodecDefect(
          yield* Effect.exit(ZstdLedger.decodeStreamImage(lambdaImage(item!) as never)),
        )
      }),
  )
})

// ---------------------------------------------------------------------------
// Bound streams
// ---------------------------------------------------------------------------

describe("EventStore packed storage — bound streams (#147)", () => {
  it.effect("bind dies with EDD-9078 when the registry it captures lacks a configured codec", () =>
    Effect.gen(function* () {
      const none = unregisteredCodecDefect(yield* Effect.exit(EventStore.bind(ZstdLedger)))
      expect(none).toContain("[EDD-9078] EventStore.bind")
      expect(none).toContain('stream "Ledger" stores "data" packed with codec "zstd"')
      const gzipOnly = unregisteredCodecDefect(
        yield* Effect.exit(
          EventStore.bind(ZstdLedger).pipe(
            Effect.provide(Compression.layer([NodeCompression.gzip()])),
          ),
        ),
      )
      expect(gzipOnly).toContain('the Compression registry in scope has "gzip"')
      // A stream that names no codec binds without a registry.
      yield* EventStore.bind(JsonLedger)
      yield* EventStore.bind(NativeLedger)
    }).pipe(Effect.provide(NoCodecs)),
  )

  it.effect("bind captures the Compression registry in scope", () =>
    Effect.gen(function* () {
      const bound = yield* EventStore.bind(ZstdLedger).pipe(Effect.provide(TestLayer))
      expect(bound.storedAs).toEqual(ZstdLedger.storedAs)
      // Run with no layer at all: R = never, the codecs come from the bind.
      yield* bound.append(id, [recorded(1, LONG_NOTE)], 0, { snapshot: { total: 1, notes: [] } })
      expect(header(storedEvents()[0]!)).toBe(0x23)
      const events = yield* bound.read(id)
      expect(events[0]!.data).toEqual(recorded(1, LONG_NOTE))
      const measured = yield* bound.measureAppend(id, [recorded(2, LONG_NOTE)], 1)
      expect(measured.events).toHaveLength(1)
      expect(yield* bound.measureSnapshot(id, { total: 1, notes: [] }, 1)).toBeGreaterThan(0)
      const image = yield* bound.decodeStreamImage(lambdaImage(storedEvents()[0]!) as never)
      expect(Option.getOrThrow(image)).toStrictEqual(events[0])
    }),
  )
})
