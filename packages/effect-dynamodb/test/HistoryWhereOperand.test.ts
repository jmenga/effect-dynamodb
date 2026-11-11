/**
 * A time-series entity's `.history(key).where()` bounds on the `orderBy` attribute, request
 * capture. `append` keys an event by the `orderBy` value encoded (`NumberFromString`'s `10` as
 * `"10"`, a value stored divided by ten as `10` for `100`), then through the key form when keys are
 * escaped. The bound was composed from the value as the caller gave it, so it named a key no event
 * has: `eq` found nothing on `NumberFromString` and `BigIntFromString` with unescaped keys, and on a
 * value stored divided by ten with escaped keys, and every bound on the latter missed. A bound is
 * composed exactly as `append` composes the event key.
 *
 * Unescaped, a string-encoded number keys its text unpadded, so its events are in text order: a
 * `between` from 9 to 10 is a reversed range there, which DynamoDB rejects (the connected twin,
 * `connected.read-back-keys.test.ts`, checks the `ValidationError` it's diagnosed into).
 *
 * The rows are what published 1.39.0 stored (`helpers/ReadBackKeys.ts`); `append` stores the same
 * rows here, except an `x10` orderBy's with escaped keys: 1.39.0 keyed each event by the value it
 * stores divided by ten once more (`0.9` for `90`, stored as `9`), and `append` keys the value it
 * stores (`9`), where `rekey` moves 1.39.0's events (`historyMoved`).
 */

import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { KEY_TOP, keyJustBelow } from "../src/internal/RangePlanner.js"
import {
  byKey,
  historyDefinitions,
  historyMoved,
  historyRows,
  historyRowsNow,
  historyShapes,
  type Row,
} from "./helpers/ReadBackKeys.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** The sort keys a query's key condition names, in order. */
const operands = (request: { readonly input: Record<string, any> }) =>
  Object.entries(request.input.ExpressionAttributeValues ?? {})
    .filter(([name]) => name.startsWith(":sk"))
    .map(([, value]: [string, any]) => value.S as string)

const seeded = (rows: ReadonlyArray<Row>) => {
  const table = makeRecordingTable()
  for (const row of rows) table.items.set(`${row.pk.S}|${row.sk.S}`, structuredClone(row) as never)
  return table
}

describe("history .where() bounds compose as append composes the event key", () => {
  for (const { name, Kind, values } of historyShapes) {
    for (const escapeKeys of [false, true]) {
      const { rows, prefix, events } = historyRowsNow(name, escapeKeys)
      const event = (value: unknown) => events[values.indexOf(value as never)]!
      const on = <A, E>(
        table: ReturnType<typeof makeRecordingTable>,
        body: (e: any, db: any) => Effect.Effect<A, E, any>,
      ) => {
        const { E, Main } = historyDefinitions(name, Kind, escapeKeys)
        return Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { E },
            tables: { Main },
          } as never) as Effect.Effect<any, never, any>
          return yield* body(db.entities.E, db)
        }).pipe(
          Effect.provide(Main.layer({ name: "t" })),
          Effect.provide(table.layer),
        ) as Effect.Effect<A, unknown>
      }

      const moved = historyMoved(name, escapeKeys)
      it.effect(
        `${name}, escapeKeys ${escapeKeys}: append stores the rows 1.39.0 stored${moved ? ", keyed by the value it stores" : ""}`,
        () => {
          const table = makeRecordingTable()
          return on(table, (e) =>
            Effect.gen(function* () {
              for (const n of values) yield* e.append({ id: "x", n }).asEffect()
              expect(byKey([...table.items.values()] as never)).toEqual(byKey(rows))
            }),
          )
        },
      )

      if (moved) {
        it.effect(`${name}, escapeKeys ${escapeKeys}: rekey moves 1.39.0's events there`, () => {
          const table = seeded(historyRows(name, escapeKeys).rows)
          return on(table, (_e, db) =>
            Effect.gen(function* () {
              const report = yield* db.tables.Main.rekey()
              expect(report.moved.event).toBe(values.length)
              expect(report.conflicts).toEqual([])
              expect(report.skipped.unrecognizedKey).toBe(0)
              expect(byKey([...table.items.values()] as never)).toEqual(byKey(rows))
            }),
          )
        })
      }

      it.effect(`${name}, escapeKeys ${escapeKeys}: eq names each event's key`, () => {
        const table = seeded(rows)
        return on(table, (e) =>
          Effect.gen(function* () {
            for (const n of values) {
              table.take()
              const found = yield* e
                .history({ id: "x" })
                .where((t: any, { eq }: any) => eq(t.n, n))
                .collect()
              expect(found.map((item: any) => item.n)).toEqual([n])
              const [query] = table.take().filter((request) => request.command === "Query")
              expect(operands(query!)).toEqual([event(n).sk.S])
            }
          }),
        )
      })

      if (values.length === 2) {
        const [lo, hi] = values
        it.effect(`${name}, escapeKeys ${escapeKeys}: range bounds name the events' keys`, () => {
          const table = seeded(rows)
          return on(table, (e) =>
            Effect.gen(function* () {
              const where = (f: (t: any, ops: any) => unknown) =>
                Effect.gen(function* () {
                  table.take()
                  const found = yield* e.history({ id: "x" }).where(f).collect()
                  const [query] = table.take().filter((request) => request.command === "Query")
                  return { found: found.map((item: any) => item.n), operands: operands(query!) }
                })
              const gte = yield* where((t, { gte }) => gte(t.n, hi))
              const lt = yield* where((t, { lt }) => lt(t.n, hi))
              const between = yield* where((t, { between }) => between(t.n, lo, hi))
              // `gte` runs to the top of the events, `lt` from their bottom to the key just below.
              expect(gte.operands).toEqual([event(hi).sk.S, `${prefix}${KEY_TOP}`])
              expect(lt.operands).toEqual([prefix, keyJustBelow(event(hi).sk.S)])
              expect(between.operands).toEqual([event(lo).sk.S, event(hi).sk.S])
              // Escaped, a number keys order-preserving text: the bounds find what they say. Not
              // escaped, a string-encoded number keys its text unpadded, in text order ("10" < "9").
              if (escapeKeys || name === "x10") {
                expect(gte.found).toEqual([hi])
                expect(lt.found).toEqual([lo])
                expect(between.found).toEqual([lo, hi])
              } else {
                expect(event(hi).sk.S < event(lo).sk.S).toBe(true)
              }
            }),
          )
        })
      }
    }
  }
})
