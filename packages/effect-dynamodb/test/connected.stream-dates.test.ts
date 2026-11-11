/**
 * A stream's dates against DynamoDB Local: the rows the published 1.39.0 stored read back real through
 * every path that reads a stream, a real date is stored as 1.39.0 stored a date and round-trips on
 * every packed form, and what stays as it was.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Config, type DateTime, Effect, Equal, Exit, Layer, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import * as ZlibCompression from "../src/compression/zlib.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import {
  DATES,
  expectReal,
  Gzip,
  iso,
  Json,
  PACKED,
  packedText,
  type Row,
  STORES,
  storedOutbox,
  storedRows,
  withOlderMarker,
} from "./helpers/StreamDateRows.js"

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

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials,
  compressors: [ZlibCompression.gzip()],
})

const AppSchema = DynamoSchema.make({ name: "dates", version: 1 })

const Keys = {
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" as const },
    { AttributeName: "sk", KeyType: "RANGE" as const },
  ],
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" as const },
    { AttributeName: "sk", AttributeType: "S" as const },
  ],
}

const StreamIndexes = {
  AttributeDefinitions: [
    ...Keys.AttributeDefinitions,
    { AttributeName: "lsi1sk", AttributeType: "S" as const },
    { AttributeName: "lsi2sk", AttributeType: "S" as const },
  ],
  LocalSecondaryIndexes: [
    {
      IndexName: "lsi1",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" as const },
        { AttributeName: "lsi1sk", KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: "ALL" as const },
    },
    {
      IndexName: "lsi2",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" as const },
        { AttributeName: "lsi2sk", KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: "INCLUDE" as const, NonKeyAttributes: ["__edd_e__"] },
    },
  ],
}

let tables = 0
const onTable = <A, E>(
  Base: any,
  body: (tableName: string) => Effect.Effect<A, E, any>,
  extra: Record<string, unknown> = {},
) => {
  const tableName = `dates-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...Keys,
        ...extra,
      })
    }),
    () => body(tableName),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Base.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<A, unknown>
}

const put = (tableName: string, ...rows: ReadonlyArray<Row>) =>
  Effect.promise(async () => {
    for (const Item of rows) await raw.send(new PutItemCommand({ TableName: tableName, Item }))
  })

const rowsOf = (tableName: string) =>
  Effect.promise(async () => {
    const { Items = [] } = await raw.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true }),
    )
    return Items as ReadonlyArray<Row>
  })

const isEvent = (row: Row) => row.data !== undefined && row.eventType !== undefined
const isSnapshot = (row: Row) => row.state !== undefined

const pad = (n: number) => String(n).padStart(8, "0")

const streamOf = (Base: any, D: Schema.Top, storedAs?: any) =>
  EventStore.makeStream({
    table: Base,
    streamName: "Tally",
    events: [Schema.Struct({ _tag: Schema.tag("Noted"), f: D as never })],
    streamId: { composite: ["id"] },
    metadata: Schema.Struct({ m: D as never }),
    snapshot: {
      schema: Schema.Struct({ m: D as never, n: Schema.Number }),
      mode: "inline",
      ...(storedAs !== undefined ? { storedAs } : {}),
    },
    indexes: {
      byVersion: { index: "lsi1", sk: "lsi1sk", key: (_e: unknown, v: number) => pad(v) },
      byKeys: {
        index: "lsi2",
        sk: "lsi2sk",
        projection: "keys",
        key: (_e: unknown, v: number) => pad(v),
      },
    },
    ...(storedAs !== undefined ? { storedAs: { data: storedAs } } : {}),
  } as never) as any

const Base = Table.make({ schema: AppSchema, entities: {} })

const expectEventsReal = (events: ReadonlyArray<any>, value: DateTime.DateTime) => {
  expect(events).toHaveLength(1)
  expectReal(events[0].data.f, value)
  expectReal(events[0].metadata.m, value)
}

describeConnected("a stream's dates on DynamoDB", () => {
  describe.each(DATES)("a %s date", (zone, D, value) => {
    describe.each(STORES)("in a %s row 1.39.0 stored", (store) => {
      const id = { id: `${zone}${store}` }
      const { event, snapshot } = storedRows(zone, store)
      const Stream = streamOf(Base, D)

      it.effect("every read path", () =>
        onTable(
          Base,
          (tableName) =>
            Effect.gen(function* () {
              // The stored row, with only the index keys a row carries on a stream with indexes
              const indexed = { ...event, lsi1sk: { S: pad(1) }, lsi2sk: { S: pad(1) } }
              yield* put(tableName, indexed, snapshot)

              expectEventsReal(yield* Stream.read(id), value)
              expectEventsReal(yield* Stream.read(id, { consistentRead: true }), value)
              expectEventsReal(yield* Stream.readFrom(id, 0), value)
              expectEventsReal(yield* Stream.readIndex("byVersion", id), value)
              expectEventsReal(yield* Stream.readIndex("byKeys", id), value)
              expectEventsReal((yield* Query.collect(Stream.query.events(id))) as never, value)
              expectEventsReal(
                (yield* Query.collect(Stream.query.index("byVersion", id))) as never,
                value,
              )

              const latest = yield* Stream.readLatest(id)
              expectReal(Option.getOrThrow<any>(latest.snapshot).state.m, value)
              expect(latest.version).toBe(1)

              const read = Option.getOrThrow<any>(yield* Stream.readSnapshot(id))
              expectReal(read.state.m, value)
              expect(read.state.n).toBe(1)

              const image = Option.getOrThrow<any>(yield* Stream.decodeStreamImage(event))
              expectReal(image.data.f, value)
              expectReal(image.metadata.m, value)
              const decoded = yield* EventStore.decoder({ Tally: Stream })(event as never)
              expectReal(Option.getOrThrow<any>(decoded).event.data.f, value)
            }),
          StreamIndexes,
        ),
      )

      it.effect("a command's load, from the events and from the snapshot", () =>
        onTable(Base, (tableName) =>
          Effect.gen(function* () {
            yield* put(tableName, event)
            let folded: unknown
            let decided: unknown
            const decider = {
              initialState: { m: value, n: 0 },
              decide: (_command: unknown, state: any) => {
                decided = state.m
                return Effect.succeed([])
              },
              evolve: (state: any, noted: any) => {
                folded = noted.f
                return { m: noted.f, n: state.n + 1 }
              },
            }
            yield* (EventStore.commandHandler(decider as never, Stream) as any)(id, {})
            expectReal(folded, value)
            expectReal(decided, value)

            decided = undefined
            folded = undefined
            yield* put(tableName, snapshot)
            yield* (EventStore.commandHandler(decider as never, Stream) as any)(id, {})
            expectReal(decided, value)
            expect(folded).toBeUndefined()

            decided = undefined
            yield* (
              EventStore.commandHandler(decider as never, Stream, {
                verifySnapshot: false,
              } as never) as any
            )(id, {})
            expectReal(decided, value)
          }),
        ),
      )

      it.effect("marked as Effect's betas marked one", () =>
        onTable(Base, (tableName) =>
          Effect.gen(function* () {
            yield* put(tableName, withOlderMarker(event), withOlderMarker(snapshot))
            expectEventsReal(yield* Stream.read(id), value)
            const latest = yield* Stream.readLatest(id)
            expectReal(Option.getOrThrow<any>(latest.snapshot).state.m, value)
          }),
        ),
      )
    })

    describe.each(PACKED)("written packed as %s", (store, storedAs) => {
      const Native = streamOf(Base, D)
      const Packed = streamOf(Base, D, storedAs)
      const stored = storedRows(zone, store)
      const expectSameForm = (attribute: any, as: any) => {
        expect(attribute.S === undefined).toBe(as.S === undefined)
        expect(packedText(attribute)).toBe(packedText(as))
      }

      it.effect("a real date round-trips and stores the text 1.39.0 stored", () =>
        onTable(
          Base,
          (tableName) =>
            Effect.gen(function* () {
              const id = { id: "fresh" }
              yield* Packed.append(id, [{ _tag: "Noted", f: value }], 0, {
                metadata: { m: value },
              })
              yield* Packed.writeSnapshot(id, { m: value, n: 1 }, 1)

              const rows = yield* rowsOf(tableName)
              const event = rows.find(isEvent) as Row
              expectSameForm(event.data, stored.event.data)
              expect(event.metadata).toEqual(stored.event.metadata)
              expectSameForm((rows.find(isSnapshot) as Row).state, stored.snapshot.state)

              expectEventsReal(yield* Packed.read(id), value)
              const read = Option.getOrThrow<any>(yield* Packed.readSnapshot(id))
              expectReal(read.state.m, value)
            }),
          StreamIndexes,
        ),
      )

      it.effect("a command's new date, into its event and an inline snapshot", () =>
        onTable(
          Base,
          (tableName) =>
            Effect.gen(function* () {
              const id = { id: "command" }
              const handle = EventStore.commandHandler(
                {
                  initialState: { m: null, n: 0 },
                  decide: () => Effect.succeed([{ _tag: "Noted", f: value }]),
                  evolve: (state: any, noted: any) => ({ m: noted.f, n: state.n + 1 }),
                } as never,
                Packed,
              ) as any
              yield* handle(id, {}, { metadata: { m: value } })

              const rows = yield* rowsOf(tableName)
              expectSameForm((rows.find(isEvent) as Row).data, stored.event.data)
              expectSameForm((rows.find(isSnapshot) as Row).state, stored.snapshot.state)

              const latest = yield* Packed.readLatest(id)
              expectReal(Option.getOrThrow<any>(latest.snapshot).state.m, value)
            }),
          StreamIndexes,
        ),
      )

      it.effect("load, fold, write: a date a native row read back, into packed rows", () =>
        onTable(
          Base,
          (tableName) =>
            Effect.gen(function* () {
              const id = { id: "carried" }
              yield* Native.append(id, [{ _tag: "Noted", f: value }], 0, {
                metadata: { m: value },
              })
              // Only the state read back holds a date: this command is handed none of its own.
              const handle = EventStore.commandHandler(
                {
                  initialState: { m: null, n: 0 },
                  decide: (_command: unknown, state: any) =>
                    Effect.succeed([{ _tag: "Noted", f: state.m }]),
                  evolve: (state: any, noted: any) => ({ m: noted.f, n: state.n + 1 }),
                } as never,
                Packed,
              ) as any
              const result = yield* handle(id, {}, { metadata: { m: value } })
              expectReal(result.state.m, value)

              const rows = yield* rowsOf(tableName)
              const events = rows.filter(isEvent)
              expect(events).toHaveLength(2)
              const packed = events.find((row) => row.data?.M === undefined) as Row
              expectSameForm(packed.data, stored.event.data)
              // The snapshot's fold counted two events; everything else is 1.39.0's text.
              expect(packedText((rows.find(isSnapshot) as Row).state)).toBe(
                packedText(stored.snapshot.state).replace(/"n":1/, '"n":2'),
              )

              const again = yield* Packed.readLatest(id)
              expectReal(Option.getOrThrow<any>(again.snapshot).state.m, value)
              const all = yield* Packed.read(id)
              expectReal(all[0].data.f, value)
              expectReal(all[1].data.f, value)
            }),
          StreamIndexes,
        ),
      )
    })

    describe("projected", () => {
      const Summaries = Entity.make({
        model: Schema.Struct({
          id: Schema.String,
          version: Schema.Number,
          rev: Schema.Number,
          at: Schema.optional(D as never),
        }),
        entityType: "Summary",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      } as never) as any
      const WithModel = Table.make({ schema: AppSchema, entities: { Summaries } })
      const Events = EventStore.makeStream({
        table: WithModel,
        streamName: "Tally",
        events: [Schema.Struct({ _tag: Schema.tag("Noted"), f: D as never })],
        streamId: { composite: ["id"] },
      } as never) as any
      const projectionSeeing = (seen: Array<unknown>) =>
        EventStore.projection({
          stream: Events,
          readModel: Summaries,
          key: (input: any) => ({ id: input.id }),
          initial: (input: any) => ({ id: input.id, version: 0, rev: 0 }),
          evolve: (state: any, event: any) => {
            seen.push(event.data.f)
            return Effect.succeed({ ...state, at: event.data.f })
          },
          checkpoint: "version",
          revision: "rev",
          outbox: {
            schema: Schema.Struct({ at: D as never }),
            effects: (event: any) => [{ at: event.data.f }],
          },
        } as never) as any
      const stored = storedOutbox(zone)
      const id = { id: `${zone}outbox` }

      const record = (image: Row, sequence: string) => ({
        eventID: sequence,
        eventName: "INSERT",
        dynamodb: {
          SequenceNumber: sequence,
          NewImage: image,
          Keys: { pk: image.pk, sk: image.sk },
        },
      })

      it.effect("an outbox item 1.39.0 stored drains real", () =>
        onTable(WithModel, (tableName) =>
          Effect.gen(function* () {
            yield* put(tableName, ...stored.rows)
            const delivered: Array<any> = []
            yield* projectionSeeing([]).drain(id, (effect: any) =>
              Effect.sync(() => {
                delivered.push(effect)
              }),
            )
            expect(delivered).toHaveLength(1)
            expectReal(delivered[0].at, value)
          }),
        ),
      )

      it.effect("a change-feed image of a row 1.39.0 stored reaches evolve real", () =>
        onTable(WithModel, (tableName) =>
          Effect.gen(function* () {
            yield* put(tableName, stored.event)
            const seen: Array<unknown> = []
            yield* projectionSeeing(seen).processBatch([record(stored.event, "1")], {
              source: "lambda",
            })
            expect(seen).toHaveLength(1)
            expectReal(seen[0], value)

            const rows = yield* rowsOf(tableName)
            const outbox = rows.find((row) => row.effect !== undefined) as Row
            expect(outbox.effect).toEqual(stored.outbox.effect)
          }),
        ),
      )

      it.effect("EventStore.processBatch reaches evolve real", () =>
        onTable(WithModel, (tableName) =>
          Effect.gen(function* () {
            yield* put(tableName, stored.event)
            const seen: Array<unknown> = []
            yield* EventStore.processBatch(
              [record(stored.event, "1")] as never,
              {
                projections: [projectionSeeing(seen)],
                source: "lambda",
              } as never,
            )
            expectReal(seen[0], value)
          }),
        ),
      )

      it.effect("apply reaches evolve real, and the outbox stores what 1.39.0 stored", () =>
        onTable(WithModel, (tableName) =>
          Effect.gen(function* () {
            yield* put(tableName, stored.event)
            const seen: Array<unknown> = []
            const projected = projectionSeeing(seen)
            const [event] = yield* Events.read(id)
            yield* projected.apply(event)
            expectReal(seen[0], value)
            const rows = yield* rowsOf(tableName)
            const outbox = rows.find((row) => row.effect !== undefined) as Row
            expect(outbox.effect).toEqual(stored.outbox.effect)
          }),
        ),
      )
    })
  })

  describe("what a date a stream reads back does elsewhere", () => {
    const utc = DATES[0][2]
    const Keyed = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
    const asStored = {
      epochMilliseconds: 1735689600000,
      "~effect/DateTime": "~effect/DateTime",
      _tag: "Utc",
    }

    describe.each([
      ["json", Json],
      ["gzip", Gzip],
    ] as const)("a packed %s entity field", (_store, storedAs) => {
      const Rows = Entity.make({
        model: DynamoModel.configure(
          Schema.Struct({
            id: Schema.String,
            u: Schema.Unknown,
            declared: Schema.optional(Schema.Struct({ at: Schema.DateTimeUtc })),
          }),
          { u: { storedAs }, declared: { storedAs } },
        ),
        entityType: "Row",
        primaryKey: Keyed,
      } as never) as any
      const MainTable = Table.make({ schema: AppSchema, entities: { Rows } })

      it.effect("Schema.Unknown takes a real date and reads back the map it stored", () =>
        onTable(MainTable, (tableName) =>
          Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: { Rows },
              tables: { MainTable },
            })
            yield* db.entities.Rows.put({ id: "a", u: utc })
            const [row] = yield* rowsOf(tableName)
            expect(JSON.parse(packedText(row?.u))).toEqual(asStored)
            // Nothing declares this field a date, so it reads as what it is: a map.
            const read = yield* db.entities.Rows.get({ id: "a" })
            expect(read.u).toEqual(asStored)
            expect(Object.getPrototypeOf(read.u)).toBe(Object.prototype)
            expect(Equal.equals(read.u, utc)).toBe(false)
          }),
        ),
      )

      it.effect("a declared date stores its encoded form and reads back real", () =>
        onTable(MainTable, (tableName) =>
          Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: { Rows },
              tables: { MainTable },
            })
            yield* db.entities.Rows.put({ id: "a", u: 1, declared: { at: utc } })
            const [row] = yield* rowsOf(tableName)
            expect(JSON.parse(packedText(row?.declared))).toEqual({ at: iso })
            const read = yield* db.entities.Rows.get({ id: "a" })
            expectReal(read.declared.at, utc)
          }),
        ),
      )
    })

    it.effect("a native Schema.Unknown entity field reads back the map too", () => {
      const Rows = Entity.make({
        model: Schema.Struct({ id: Schema.String, u: Schema.Unknown }),
        entityType: "Row",
        primaryKey: Keyed,
      } as never) as any
      const MainTable = Table.make({ schema: AppSchema, entities: { Rows } })
      return onTable(MainTable, () =>
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { MainTable } })
          yield* db.entities.Rows.put({ id: "a", u: utc })
          const read = yield* db.entities.Rows.get({ id: "a" })
          expect(read.u).toEqual(asStored)
          expect(Object.getPrototypeOf(read.u)).toBe(Object.prototype)
        }),
      )
    })

    it.effect("Schema.Json refuses a date, read or new", () => {
      const Source = streamOf(Base, Schema.DateTimeUtc)
      const Target = EventStore.makeStream({
        table: Base,
        streamName: "Target",
        events: [Schema.Struct({ _tag: Schema.tag("J"), j: Schema.Json })],
        streamId: { composite: ["id"] },
      } as never) as any
      return onTable(
        Base,
        (tableName) =>
          Effect.gen(function* () {
            yield* Source.append({ id: "a" }, [{ _tag: "Noted", f: utc }], 0, {
              metadata: { m: utc },
            })
            const [read] = yield* Source.read({ id: "a" })
            for (const date of [read.data.f, utc]) {
              const exit = yield* Effect.exit(
                Target.append({ id: "t" }, [{ _tag: "J", j: date }], 0) as Effect.Effect<unknown>,
              )
              expect(Exit.isFailure(exit)).toBe(true)
              expect((Cause.squash((exit as any).cause) as any)._tag).toBe("ValidationError")
            }
            expect((yield* rowsOf(tableName)).filter(isEvent)).toHaveLength(1)
          }),
        StreamIndexes,
      )
    })

    it.effect(
      "a read date in JSON.stringify is ISO text, and a spread keeps only the epoch",
      () => {
        const Source = streamOf(Base, Schema.DateTimeUtc)
        return onTable(
          Base,
          () =>
            Effect.gen(function* () {
              yield* Source.append({ id: "a" }, [{ _tag: "Noted", f: utc }], 0, {
                metadata: { m: utc },
              })
              const [read] = yield* Source.read({ id: "a" })
              expect(JSON.stringify(read.data.f)).toBe(`"${iso}"`)
              expect({ ...read.data.f }).toEqual({ epochMilliseconds: 1735689600000 })
            }),
          StreamIndexes,
        )
      },
    )
  })
})
