/**
 * A date the model declares optional (`Schema.optionalKey`, `Schema.optional`) whose storage its
 * `DynamoModel.configure` sets (`storedAs: DynamoModel.DateEpochSeconds`) stays optional, and is
 * stored in that form. Up to 1.41.0 an `optionalKey` one became required (a `put` leaving it out
 * failed with `Missing key`), and an `optional` one was stored, compared and written as ISO text.
 * A row stored as ISO text then reads as the date it holds; a condition on it sends the configured
 * form, so it doesn't match until the field is set again.
 *
 * One suite, run on a recording table (`OptionalStoredAs.test.ts`) and against DynamoDB Local
 * (`connected.optional-stored-as.test.ts`).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Equal, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import type { Harness } from "./EntityRefKeys.js"

type Row = Record<string, AttributeValue>
type Sent = { readonly command: string; readonly input: any }

const schema = DynamoSchema.make({ name: "optstored", version: 1 })

class Booking extends Schema.Class<Booking>("OptionalStoredAsBooking")({
  id: Schema.String,
  note: Schema.String,
  confirmed: Schema.optionalKey(Schema.DateTimeUtc),
  cancelled: Schema.optional(Schema.DateTimeUtc),
}) {}

const entities = () => ({
  Bookings: Entity.make({
    model: DynamoModel.configure(Booking, {
      id: { identifier: true },
      confirmed: { storedAs: DynamoModel.DateEpochSeconds },
      cancelled: { storedAs: DynamoModel.DateEpochSeconds },
    }),
    entityType: "Booking",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  }),
})

const at = (iso: string) => DateTime.makeUnsafe(iso)
const ON = at("2001-02-03T04:05:06.000Z")
const LATER = at("2002-03-04T05:06:07.000Z")
/** `DateEpochSeconds`'s stored form of a date. */
const seconds = (date: DateTime.Utc): AttributeValue => ({
  N: String(Math.floor(DateTime.toEpochMillis(date) / 1000)),
})

const onTable = (
  harness: Harness,
  body: (t: {
    readonly db: any
    /** Run `op`, with the requests it sent. */
    readonly step: (op: any) => Effect.Effect<{ exit: Exit.Exit<any, any>; sent: Array<Sent> }>
    /** The booking's stored row. */
    readonly row: (id: string) => Effect.Effect<Row>
    /** Store `item` as it is, outside the library. */
    readonly seed: (item: Row) => Effect.Effect<void, unknown>
  }) => Effect.Effect<void, unknown>,
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      const { Bookings } = entities()
      const Main = Table.make({ schema, entities: { Bookings } }) as any
      const exec = <A, E>(op: any): Effect.Effect<A, E> =>
        harness.provide(tableName, Main, typeof op.asEffect === "function" ? op.asEffect() : op)
      const db: any = yield* exec(DynamoClient.make({ entities: { Bookings }, tables: { Main } }))
      const step = (op: any) =>
        Effect.gen(function* () {
          yield* harness.requests(tableName)
          const exit = yield* Effect.exit(exec(op))
          return { exit, sent: [...(yield* harness.requests(tableName))] as Array<Sent> }
        })
      const row = (id: string) =>
        Effect.map(
          harness.rows(tableName),
          (rows) => rows.find((r) => r.id?.S === id && r.__edd_e__?.S === "Booking")!,
        )
      const seed = (item: Row) =>
        exec(
          Effect.gen(function* () {
            const client = yield* DynamoClient
            yield* client.putItem({ TableName: tableName, Item: item })
          }),
        )
      yield* body({ db, step, row, seed })
    }),
  )

const succeeded = (exit: Exit.Exit<any, any>) => {
  if (Exit.isFailure(exit)) throw exit
  return exit.value
}
const failure = (exit: Exit.Exit<any, any>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as any)?.error
    : undefined
const same = (a: unknown, b: unknown) => expect(Equal.equals(a, b)).toBe(true)

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("an optional date stored in the form configure gives it", () => {
    for (const [field, wrapper] of [
      ["confirmed", "Schema.optionalKey"],
      ["cancelled", "Schema.optional"],
    ] as const) {
      it(`a ${wrapper} date is left out, set, compared and removed in that form`, () =>
        Effect.runPromise(
          onTable(harness, ({ db, step, row }) =>
            Effect.gen(function* () {
              const B = db.entities.Bookings
              // Left out: up to 1.41.0 an `optionalKey` date was required here.
              const put = yield* step(B.put({ id: "a", note: "n" }))
              expect(field in succeeded(put.exit)).toBe(false)
              expect(field in (yield* row("a"))).toBe(false)
              expect(field in succeeded((yield* step(B.get({ id: "a" }))).exit)).toBe(false)

              // Set: stored, and sent, as epoch seconds.
              const set = yield* step(B.update({ id: "a" }).set({ [field]: ON }))
              same(succeeded(set.exit)[field], ON)
              expect(Object.values(set.sent.at(-1)!.input.ExpressionAttributeValues)).toEqual([
                seconds(ON),
              ])
              expect((yield* row("a"))[field]).toEqual(seconds(ON))
              same(succeeded((yield* step(B.get({ id: "a" }))).exit)[field], ON)

              // A condition on it holds on the date it holds, and on no other.
              const on = (date: DateTime.Utc) =>
                B.update({ id: "a" })
                  .set({ note: "m" })
                  .condition((t: any, { eq }: any) => eq(t[field], date))
              const held = yield* step(on(ON))
              expect(succeeded(held.exit).note).toBe("m")
              expect(
                Object.values(held.sent.at(-1)!.input.ExpressionAttributeValues),
              ).toContainEqual(seconds(ON))
              expect(failure((yield* step(on(LATER))).exit)?._tag).toBe("ConditionalCheckFailed")

              // Removed: left out again.
              succeeded((yield* step(B.update({ id: "a" }).remove([field]))).exit)
              expect(field in (yield* row("a"))).toBe(false)
              expect(field in succeeded((yield* step(B.get({ id: "a" }))).exit)).toBe(false)
            }),
          ),
        ))
    }

    it("a row holding the dates as ISO text reads them; a set stores them as configured", () =>
      Effect.runPromise(
        onTable(harness, ({ db, step, row, seed }) =>
          Effect.gen(function* () {
            const B = db.entities.Bookings
            succeeded((yield* step(B.put({ id: "a", note: "n" }))).exit)
            // What 1.41.0 stored for the `optional` date (and `put` with the `optionalKey` one
            // refused).
            const iso = { S: "2001-02-03T04:05:06.000Z" }
            yield* seed({ ...(yield* row("a")), confirmed: iso, cancelled: iso })
            const read = succeeded((yield* step(B.get({ id: "a" }))).exit)
            same(read.confirmed, ON)
            same(read.cancelled, ON)

            // A condition sends the configured form, which ISO text doesn't match.
            const on = B.update({ id: "a" })
              .set({ note: "m" })
              .condition((t: any, { eq }: any) => eq(t.cancelled, ON))
            expect(failure((yield* step(on)).exit)?._tag).toBe("ConditionalCheckFailed")

            // Set again, it's stored as configured, and the condition holds.
            succeeded(
              (yield* step(B.update({ id: "a" }).set({ confirmed: ON, cancelled: ON }))).exit,
            )
            const stored = yield* row("a")
            expect(stored.confirmed).toEqual(seconds(ON))
            expect(stored.cancelled).toEqual(seconds(ON))
            expect(succeeded((yield* step(on)).exit).note).toBe("m")
          }),
        ),
      ))
  })
