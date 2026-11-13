/**
 * Effect's look-alikes in packed storage (#242). A packed write refused a real `Duration`, `BigDecimal`,
 * zone, cookie, version, address, DNS record, `Option` or `Result` ("an instance of Object"), though a
 * native attribute stores each as a map and reads it back. Packed, each is now that map, in the order
 * DynamoDB Local hands it back, as a real date always was: exactly the bytes published 1.40.0 stored
 * for the map a native read hands back for it. It reads back as the instance, and writing what was
 * read stores the same bytes. Every value 1.40.0 packed is packed to the bytes it stored
 * (`fixtures/packed-lookalikes-1.40.0.json`). What JSON can't hold (bytes, a bigint past 2^53) is
 * refused where it is.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Duration, Effect, Exit, Option, Result, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as StorageEncoding from "../src/StorageEncoding.js"
import * as Table from "../src/Table.js"
import { isInstanceOf } from "./helpers/Lookalikes.js"
import {
  definitionsOf,
  fixture,
  inputOf,
  Json,
  kindOf,
  kinds,
  packable,
  packedBy140,
  packedMapText,
  type Row,
  unpackable,
} from "./helpers/PackedLookalikes.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

interface Harness {
  readonly db: any
  readonly stream: any
  /** The entity row with this id. */
  readonly row: (id: string) => Row | undefined
  /** The stream's event and snapshot. */
  readonly streamRows: (sid: string) => {
    readonly event: Row | undefined
    readonly snapshot: Row | undefined
  }
  readonly seed: (row: Row) => void
  readonly requests: () => number
}

const on = <A>(field: Schema.Top, body: (h: Harness) => Effect.Effect<A, unknown, any>) => {
  const { P, Main, Stream } = definitionsOf(field)
  const table = makeRecordingTable()
  const rows = () => [...table.items.values()] as unknown as ReadonlyArray<Row>
  const harness = (db: any, stream: any): Harness => ({
    db,
    stream,
    row: (id) => rows().find((row) => row.pk?.S === `$pk#v1#p#id_${id}`),
    streamRows: (sid) => {
      const mine = rows().filter((row) => row.pk?.S === `$pk#v1#s#${sid}`)
      return {
        event: mine.find((row) => row.data !== undefined),
        snapshot: mine.find((row) => row.state !== undefined),
      }
    },
    seed: (row) => table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never),
    requests: () => table.requests.length,
  })
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { P }, tables: { Main } } as never) as any
    const stream = yield* EventStore.bind(Stream) as any
    return yield* body(harness(db, stream))
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

const put = (h: Harness, id: string, attribute: "p" | "u", value: unknown) =>
  Effect.exit(h.db.entities.P.put({ id, [attribute]: { v: value } }).asEffect())

const append = (h: Harness, sid: string, value: unknown) =>
  Effect.exit(
    Effect.suspend(() =>
      h.stream.append({ sid }, [{ _tag: "Ev", v: value }], 0, { snapshot: { v: value } }),
    ) as Effect.Effect<unknown, unknown>,
  )

const refusalOf = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as any
}

/** What a packed write's refusal says. */
const says = (refused: any): string => String(refused.cause?.message ?? "")

describe("what 1.40.0 packed is packed to the same bytes", () => {
  it("every kind it refused all of is one JSON can't hold", () => {
    expect([...kinds.keys()].filter((name) => !packedBy140.includes(name))).toEqual(
      unpackable.map(([name]) => name),
    )
  })

  describe.each(packedBy140)("%s", (name) => {
    const { field } = kindOf(name)
    const cases = Object.entries(fixture[name]!.cases).filter(([, c]) => c.outcome === "ok")

    it.effect.each(cases.map(([label]) => label))("%s", (label) =>
      on(field, (h) =>
        Effect.gen(function* () {
          const captured = fixture[name]!.cases[label]!
          const value = inputOf(name, label)
          if (label.startsWith("stream/")) {
            expect(Exit.isSuccess(yield* append(h, "s", value))).toBe(true)
            const { event, snapshot } = h.streamRows("s")
            expect(event?.data).toEqual(captured.data)
            expect(snapshot?.state).toEqual(captured.state)
            return
          }
          const attribute = label.startsWith("typed/") ? "p" : "u"
          expect(Exit.isSuccess(yield* put(h, "a", attribute, value))).toBe(true)
          expect(h.row("a")?.[attribute]).toEqual(captured.stored)
        }),
      ),
    )
  })
})

describe("a real instance is packed as 1.40.0 packed the map a native read hands back for it", () => {
  describe.each(packable)("%s", (name) => {
    const { field, make } = kindOf(name)
    const text = packedMapText(name)!

    it.effect("in a typed field and an Unknown one", () =>
      on(field, (h) =>
        Effect.gen(function* () {
          expect(Exit.isSuccess(yield* put(h, "t", "p", make()))).toBe(true)
          expect(Exit.isSuccess(yield* put(h, "u", "u", make()))).toBe(true)
          expect(h.row("t")?.p).toEqual({ S: `{"v":${text}}` })
          expect(h.row("u")?.u).toEqual({ S: `{"v":${text}}` })
        }),
      ),
    )

    it.effect("in a stream's event data and snapshot", () =>
      on(field, (h) =>
        Effect.gen(function* () {
          expect(Exit.isSuccess(yield* append(h, "s", make()))).toBe(true)
          const { event, snapshot } = h.streamRows("s")
          expect(event?.data).toEqual({ S: `{"_tag":"Ev","v":${text}}` })
          expect(snapshot?.state).toEqual({ S: `{"v":${text}}` })
        }),
      ),
    )

    it.effect("by StorageEncoding, as an attribute is", () =>
      Effect.gen(function* () {
        const encoded = yield* StorageEncoding.encode(Json, { v: make() })
        expect(encoded).toEqual({ S: `{"v":${text}}` })
      }),
    )
  })
})

describe("a packed look-alike reads back as the instance", () => {
  const read = packable.filter((name) => name !== "Json")

  describe.each(read)("%s", (name) => {
    const { field, make } = kindOf(name)
    const text = packedMapText(name)!

    it.effect("written, read, and written again as the same bytes, in no more requests", () =>
      on(field, (h) =>
        Effect.gen(function* () {
          yield* put(h, "a", "p", make())
          const before = h.requests()
          const got = yield* h.db.entities.P.get({ id: "a" })
          expect(h.requests() - before).toBe(1)
          expect(isInstanceOf(got.p.v, make(), field)).toBe(true)
          expect(Exit.isSuccess(yield* put(h, "b", "p", got.p.v))).toBe(true)
          expect(h.row("b")?.p).toEqual({ S: `{"v":${text}}` })
        }),
      ),
    )

    it.effect("a row 1.40.0 packed from the map a native read handed it", () =>
      on(field, (h) =>
        Effect.gen(function* () {
          h.seed({
            pk: { S: "$pk#v1#p#id_old" },
            sk: { S: "$pk#v1#p" },
            __edd_e__: { S: "P" },
            id: { S: "old" },
            p: { S: `{"v":${text}}` },
          })
          const got = yield* h.db.entities.P.get({ id: "old" })
          expect(isInstanceOf(got.p.v, make(), field)).toBe(true)
          expect(Exit.isSuccess(yield* put(h, "again", "p", got.p.v))).toBe(true)
          expect(h.row("again")?.p).toEqual({ S: `{"v":${text}}` })
        }),
      ),
    )

    it.effect("in an Unknown field, the map, as a native read hands it back", () =>
      on(field, (h) =>
        Effect.gen(function* () {
          yield* put(h, "a", "u", make())
          const got = yield* h.db.entities.P.get({ id: "a" })
          expect(Object.getPrototypeOf(got.u.v)).toBe(Object.prototype)
          expect(got.u).toEqual(JSON.parse(`{"v":${text}}`))
        }),
      ),
    )

    it.effect("from a stream's event data and snapshot", () =>
      on(field, (h) =>
        Effect.gen(function* () {
          yield* append(h, "s", make())
          const [event] = yield* h.stream.read({ sid: "s" })
          expect(isInstanceOf(event.data.v, make(), field)).toBe(true)
          const snapshot = yield* h.stream.readSnapshot({ sid: "s" })
          expect(
            isInstanceOf((Option.getOrThrow(snapshot as any) as any).state.v, make(), field),
          ).toBe(true)
        }),
      ),
    )
  })
})

describe("what JSON can't hold is still refused, where it is", () => {
  it.effect.each(unpackable)("%s at %s", ([name, path]) => {
    const { field, make } = kindOf(name)
    return on(field, (h) =>
      Effect.gen(function* () {
        const typed = refusalOf(yield* put(h, "t", "p", make()))
        expect(typed._tag).toBe("ValidationError")
        expect(typed.operation).toBe("put.packed")
        expect(says(typed)).toContain(`the value at ${path} is`)
        const unknown = refusalOf(yield* put(h, "u", "u", make()))
        expect(unknown._tag).toBe("ValidationError")
        const streamed = refusalOf(yield* append(h, "s", make()))
        expect(streamed._tag).toBe("ValidationError")
        expect(streamed.operation).toBe("EventStore.append.packed")
        expect(h.requests()).toBe(0)
      }),
    )
  })
})

describe("an Option or a Result holds the caller's value, packed as any packed value is", () => {
  it.effect("its value keeps its keys' order, and an instance in it is its stored map", () =>
    on(Schema.Unknown, (h) =>
      Effect.gen(function* () {
        expect(
          Exit.isSuccess(yield* put(h, "a", "u", Option.some({ b: 1, a: Duration.seconds(2) }))),
        ).toBe(true)
        expect(h.row("a")?.u).toEqual({
          S:
            '{"v":{"_op":"Some","~effect/Option":{},"value":{"b":1,"a":' +
            '{"~effect/Duration":"~effect/Duration","value":{"millis":2000,"_tag":"Millis"}}},' +
            '"_tag":"Some"}}',
        })
      }),
    ),
  )

  it.effect.each([
    ["a bigint", Option.some(5n), "u.v.value"],
    ["a Date", Result.succeed(new Date(0)), "u.v.success"],
  ] as const)("refused: %s in it, at %s", ([what, value, path]) =>
    on(Schema.Unknown, (h) =>
      Effect.gen(function* () {
        const refused = refusalOf(yield* put(h, "a", "u", value))
        expect(refused._tag).toBe("ValidationError")
        expect(says(refused)).toContain(`the value at ${path} is ${what}`)
        expect(h.requests()).toBe(0)
      }),
    ),
  )
})

describe("an aggregate's packed edge", () => {
  class Plan extends Schema.Class<Plan>("Plan")({
    planId: Schema.String.pipe(DynamoModel.identifier),
    timing: Schema.Struct({ wait: Schema.Duration, zone: Schema.TimeZoneNamed }),
  }) {}
  class Trip extends Schema.Class<Trip>("Trip")({ tripId: Schema.String, plan: Plan }) {}
  const AppSchema = DynamoSchema.make({ name: "agg", version: 1 })
  const Plans = Entity.make({
    model: DynamoModel.configure(Plan, { timing: { storedAs: Json } }),
    entityType: "Plan",
    primaryKey: { pk: { field: "pk", composite: ["planId"] }, sk: { field: "sk", composite: [] } },
  })
  const Main = Table.make({ schema: AppSchema, entities: { Plans } })
  const Trips = Aggregate.make(Trip, {
    table: Main,
    schema: AppSchema,
    pk: { field: "pk", composite: ["tripId"] },
    collection: { name: "trip" },
    root: { entityType: "TripItem" },
    edges: { plan: Aggregate.one({ entityType: "TripPlan", entity: Plans }) },
  })

  it.effect("stores a look-alike as its map and reads it back as the instance", () => {
    const table = makeRecordingTable()
    const timing = {
      wait: Duration.millis(1500),
      zone: DateTime.zoneMakeNamedUnsafe("Europe/London"),
    }
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Plans },
        aggregates: { Trips },
        tables: { Main },
      })
      yield* db.aggregates.Trips.create({
        tripId: "t",
        plan: new Plan({ planId: "p", timing }),
      } as never)
      const edge = [...table.items.values()].find((row: any) => row.__edd_e__?.S === "TripPlan")
      expect((edge as any)?.timing).toEqual({
        S:
          '{"wait":{"~effect/Duration":"~effect/Duration","value":{"millis":1500,"_tag":"Millis"}},' +
          '"zone":{"format":{},"id":"Europe/London","~effect/DateTime/TimeZone":' +
          '"~effect/DateTime/TimeZone","_tag":"Named"}}',
      })
      const trip = yield* db.aggregates.Trips.get({ tripId: "t" })
      expect(isInstanceOf(trip.plan.timing.wait, Duration.millis(1500), Schema.Duration)).toBe(true)
      expect(
        isInstanceOf(
          trip.plan.timing.zone,
          DateTime.zoneMakeNamedUnsafe("Europe/London"),
          Schema.TimeZoneNamed,
        ),
      ).toBe(true)
    }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer))
  })
})
