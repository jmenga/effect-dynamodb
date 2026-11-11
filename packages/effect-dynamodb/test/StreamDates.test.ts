/**
 * A stream's dates, without a table: the rows the published 1.39.0 stored read back real through the
 * paths that decode a row, and a real date is stored exactly as 1.39.0 stored a date. Every path
 * against a table is in `connected.stream-dates.test.ts`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import * as ZlibCompression from "../src/compression/zlib.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"
import {
  DATES,
  expectReal,
  PACKED,
  packedText,
  type Row,
  STORES,
  storedRows,
  withOlderMarker,
} from "./helpers/StreamDateRows.js"

const AppSchema = DynamoSchema.make({ name: "dates", version: 1 })
const Base = Table.make({ schema: AppSchema, entities: {} })
const TableLayer = Base.layer({ name: "dates-table" })
const Compressors = Compression.layer([ZlibCompression.gzip()])

const streamOf = (D: Schema.Top, storedAs?: any) =>
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
    ...(storedAs !== undefined ? { storedAs: { data: storedAs } } : {}),
  } as never) as any

const providing =
  (layer: Layer.Layer<any, any, any>) =>
  (effect: Effect.Effect<any, any, any>): Effect.Effect<void, unknown> =>
    Effect.provide(effect, layer) as never

/** A client that answers a stream's reads with these rows, and records what it's asked to write. */
const answering = (rows: { readonly event?: Row; readonly snapshot?: Row }) => {
  const written: Array<Row> = []
  const layer = mockDynamoClientLayer({
    query: () => Effect.succeed({ Items: rows.event !== undefined ? [rows.event] : [] }),
    getItem: () => Effect.succeed({ Item: rows.snapshot }),
    putItem: (input: any) =>
      Effect.sync(() => {
        written.push(input.Item)
        return {}
      }),
    transactWriteItems: (input: any) =>
      Effect.sync(() => {
        for (const item of input.TransactItems) {
          if (item.Put !== undefined) written.push(item.Put.Item)
        }
        return {}
      }),
  } as never)
  return { written, layer: Layer.mergeAll(layer, TableLayer, Compressors) }
}

describe.each(DATES)("a %s date", (zone, D, value) => {
  const Stream = streamOf(D)

  describe.each(STORES)("in a %s row 1.39.0 stored", (store) => {
    const { event, snapshot } = storedRows(zone, store)

    it.effect("decodeStreamImage", () =>
      Effect.gen(function* () {
        const decoded = yield* Stream.decodeStreamImage(event)
        const read = Option.getOrThrow(decoded) as any
        expectReal(read.data.f, value)
        expectReal(read.metadata.m, value)
      }).pipe(providing(Compressors)),
    )

    it.effect("EventStore.decoder", () =>
      Effect.gen(function* () {
        const decoded = yield* EventStore.decoder({ Tally: Stream })(event as never)
        const read = Option.getOrThrow(decoded) as any
        expectReal(read.event.data.f, value)
        expectReal(read.event.metadata.m, value)
      }).pipe(providing(Compressors)),
    )

    it.effect("read", () =>
      Effect.gen(function* () {
        const [read] = yield* Stream.read({ id: `${zone}${store}` })
        expectReal(read.data.f, value)
        expectReal(read.metadata.m, value)
      }).pipe(providing(answering({ event }).layer)),
    )

    it.effect("readSnapshot", () =>
      Effect.gen(function* () {
        const read = Option.getOrThrow(yield* Stream.readSnapshot({ id: `${zone}${store}` })) as any
        expectReal(read.state.m, value)
        expect(read.state.n).toBe(1)
      }).pipe(providing(answering({ snapshot }).layer)),
    )

    it.effect("what a command folds and decides on", () =>
      Effect.gen(function* () {
        let folded: unknown
        let decided: unknown
        const handle = EventStore.commandHandler(
          {
            initialState: { m: value, n: 0 },
            decide: (_command: unknown, state: any) => {
              decided = state.m
              return Effect.succeed([])
            },
            evolve: (state: any, noted: any) => {
              folded = noted.f
              return { m: noted.f, n: state.n + 1 }
            },
          } as never,
          Stream,
        )
        yield* (handle as any)({ id: `${zone}${store}` }, {})
        expectReal(folded, value)
        expectReal(decided, value)
      }).pipe(providing(answering({ event }).layer)),
    )

    it.effect("marked as Effect's betas marked one", () =>
      Effect.gen(function* () {
        const decoded = yield* Stream.decodeStreamImage(withOlderMarker(event))
        const read = Option.getOrThrow(decoded) as any
        expectReal(read.data.f, value)
        expectReal(read.metadata.m, value)
        const state = yield* Stream.readSnapshot({ id: `${zone}${store}` })
        expectReal((Option.getOrThrow(state) as any).state.m, value)
      }).pipe(providing(answering({ snapshot: withOlderMarker(snapshot) }).layer)),
    )
  })

  describe("stored", () => {
    const id = { id: `${zone}native` }

    it.effect("natively as 1.39.0 stored it, event data and metadata", () => {
      const client = answering({})
      return Effect.gen(function* () {
        yield* Stream.append(id, [{ _tag: "Noted", f: value }], 0, { metadata: { m: value } })
        const stored = storedRows(zone, "native").event
        expect(client.written[0]?.data).toEqual(stored.data)
        expect(client.written[0]?.metadata).toEqual(stored.metadata)
      }).pipe(providing(client.layer))
    })

    it.effect("natively as 1.39.0 stored it, a snapshot", () => {
      const client = answering({})
      return Effect.gen(function* () {
        yield* Stream.writeSnapshot(id, { m: value, n: 1 }, 1)
        expect(client.written[0]?.state).toEqual(storedRows(zone, "native").snapshot.state)
      }).pipe(providing(client.layer))
    })

    describe.each(PACKED)("packed as %s", (store, storedAs) => {
      const Packed = streamOf(D, storedAs)
      const packedId = { id: `${zone}${store}` }
      const stored = storedRows(zone, store)
      const expectPacked = (
        attribute: AttributeValue | undefined,
        as: AttributeValue | undefined,
      ) => {
        expect(attribute?.S === undefined).toBe(as?.S === undefined)
        expect(packedText(attribute)).toBe(packedText(as))
      }

      it.effect("a real date, as the text 1.39.0 stored for one it read", () => {
        const client = answering({})
        return Effect.gen(function* () {
          yield* Packed.append(packedId, [{ _tag: "Noted", f: value }], 0, {
            metadata: { m: value },
          })
          yield* Packed.writeSnapshot(packedId, { m: value, n: 1 }, 1)
          expectPacked(client.written[0]?.data, stored.event.data)
          expect(client.written[0]?.metadata).toEqual(stored.event.metadata)
          expectPacked(client.written[1]?.state, stored.snapshot.state)
        }).pipe(providing(client.layer))
      })

      it.effect("a date a read returned, the same", () => {
        const client = answering({ event: stored.event })
        return Effect.gen(function* () {
          const [read] = yield* Packed.read(packedId)
          expectReal(read.data.f, value)
          yield* Packed.append(packedId, [{ _tag: "Noted", f: read.data.f }], 1, {
            metadata: { m: read.metadata.m },
          })
          yield* Packed.writeSnapshot(packedId, { m: read.data.f, n: 1 }, 1)
          expectPacked(client.written[0]?.data, stored.event.data)
          expect(client.written[0]?.metadata).toEqual(stored.event.metadata)
          expectPacked(client.written[1]?.state, stored.snapshot.state)
        }).pipe(providing(client.layer))
      })
    })
  })
})

describe("what a stream's dates don't change", () => {
  it.effect("a packed write still refuses any other instance beside the date", () => {
    const Packed = EventStore.makeStream({
      table: Base,
      streamName: "Tally",
      events: [
        Schema.Struct({
          _tag: Schema.tag("Noted"),
          f: Schema.DateTimeUtc,
          other: Schema.Unknown,
        }),
      ],
      streamId: { composite: ["id"] },
      storedAs: { data: PACKED[0][1] },
    } as never) as any
    const client = answering({})
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Packed.append(
          { id: "a" },
          [{ _tag: "Noted", f: DATES[0][2], other: new Date(0) }],
          0,
        ) as Effect.Effect<unknown>,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect((Cause.squash((exit as any).cause) as any)._tag).toBe("ValidationError")
      expect(client.written).toEqual([])
    }).pipe(providing(client.layer))
  })
})
