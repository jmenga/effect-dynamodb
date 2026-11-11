/**
 * Effect's look-alike types as key composites against DynamoDB Local (#242 §2): the connected twin
 * of `LookalikeKeys.test.ts`, over the rows published 1.39.0 stored
 * (`fixtures/lookalike-keys-1.39.0.json`, definitions and steps in `helpers/LookalikeKeys.ts`). The
 * head writes 1.39.0's rows, restores and updates them as its own, `rekey` moves none of them, and
 * moves the item 1.39.0's `restore` left under `[object object]` to the key `put` wrote;
 * a cookie stays refused.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect, Exit, type Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  asHeadLeavesIt,
  comparable,
  definitionsOf,
  fixture,
  kindOf,
  putAll,
  type Row,
  typed,
} from "./helpers/LookalikeKeys.js"

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
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const send = <A>(make: () => Promise<A>) =>
  Effect.tryPromise(make).pipe(Effect.orDie) as Effect.Effect<A>

let tables = 0

/**
 * A fresh table of the fixture's definitions (its `gsi1` included) seeded with `seed`, a client on
 * it, and its rows read consistently; dropped after `body`.
 */
const on = <A>(
  field: Schema.Top,
  seed: ReadonlyArray<Row>,
  body: (db: any, rows: Effect.Effect<ReadonlyArray<Row>>) => Effect.Effect<A, unknown, any>,
) => {
  const { Soft, Unique, Indexed, Retained, Roots, Base, Main } = definitionsOf(field)
  const TableName = `lookalike-keys-${Date.now()}-${tables++}`
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Soft, Unique, Indexed, Retained },
      aggregates: { Roots },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    yield* db.tables.Main.create()
    for (const Item of seed) yield* send(() => raw.send(new PutItemCommand({ TableName, Item })))
    const rows = Effect.map(
      send(() => raw.send(new ScanCommand({ TableName, ConsistentRead: true }))),
      (out) => (out.Items ?? []) as unknown as ReadonlyArray<Row>,
    )
    return yield* Effect.ensuring(body(db, rows), Effect.ignore(db.tables.Main.delete()))
  }).pipe(
    Effect.provide(Base.layer({ name: TableName })),
    Effect.provide(ClientLayer),
  ) as Effect.Effect<A, unknown>
}

const kindsChecked = [
  "Duration",
  "Duration nanos past 2^53",
  "TimeZoneNamed",
  "UrlParams",
  "SemVerRange",
  "MacAddress",
  "InetAddressV6",
  "DnsTlsaRecord",
  "Option(DateTimeZoned)",
  "Result(String, DateTimeUtc)",
]

describeConnected("look-alike key composites against DynamoDB Local", () => {
  for (const name of kindsChecked) {
    const { field, make } = kindOf(name)
    const captured = fixture[name]!

    it.effect(`${name}: put stores 1.39.0's rows, and 1.39.0's rows restore and update`, () =>
      Effect.gen(function* () {
        yield* on(field, [], (db, rows) =>
          Effect.gen(function* () {
            yield* putAll(db, make)
            expect(comparable(yield* rows)).toEqual(comparable(captured.stages.put))
          }),
        )
        yield* on(field, captured.stages.put, (db, rows) =>
          Effect.gen(function* () {
            yield* db.entities.Soft.delete({ id: "a", f: make() }).asEffect()
            expect(comparable(yield* rows)).toEqual(comparable(captured.stages.softDeleted))
            yield* db.entities.Soft.restore({ id: "a", f: make() })
            expect(comparable(yield* rows)).toEqual(
              comparable(asHeadLeavesIt(captured, "restored")),
            )
            yield* db.entities.Unique.delete({ id: "b" }).asEffect()
            yield* db.entities.Retained.update({ id: "d", f: make() }).set({ note: "x" }).asEffect()
            yield* db.entities.Indexed.update({ id: "c" }).set({ note: "x" }).asEffect()
            yield* db.aggregates.Roots.update({ id: "e", f: make() }, ({ state }: any) => ({
              ...state,
              note: "two",
            }))
            expect(comparable(yield* rows)).toEqual(comparable(asHeadLeavesIt(captured, "updated")))
            expect(yield* db.entities.Indexed.byF({ f: make() }).collect()).toHaveLength(1)
          }),
        )
      }),
    )

    it.effect(`${name}: rekey finds 1.39.0's rows where they belong`, () =>
      on(field, captured.stages.put, (db, rows) =>
        Effect.gen(function* () {
          const report = yield* db.tables.Main.rekey()
          expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
          expect(Object.values(report.skipped).every((n) => n === 0)).toBe(true)
          expect(report.indexKeys.lagging).toBe(0)
          expect(report.conflicts).toEqual([])
          expect(comparable(yield* rows)).toEqual(comparable(captured.stages.put))
        }),
      ),
    )

    it.effect(`${name}: rekey moves the row 1.39.0's restore keyed by the map to put's key`, () =>
      on(field, captured.stages.restored, (db, rows) =>
        Effect.gen(function* () {
          const key = { id: "a", f: make() }
          expect(Exit.isFailure(yield* Effect.exit(db.entities.Soft.get(key)))).toBe(true)
          const report = yield* db.tables.Main.rekey()
          expect(report.moved.item).toBe(1)
          expect(
            Object.values(report.moved as Record<string, number>).reduce((a, n) => a + n, 0),
          ).toBe(1)
          expect(Object.values(report.skipped).every((n) => n === 0)).toBe(true)
          expect(report.conflicts).toEqual([])
          const moved = comparable(asHeadLeavesIt(captured, "restored"))
          expect(comparable(yield* rows)).toEqual(moved)
          yield* db.entities.Soft.get(key)
          const again = yield* db.tables.Main.rekey()
          expect(Object.values(again.moved).every((n) => n === 0)).toBe(true)
          expect(comparable(yield* rows)).toEqual(moved)
        }),
      ),
    )
  }

  it.effect("BigDecimal: keyed by the value's text, restored and released under it", () => {
    const { field, make } = kindOf("BigDecimal")
    return on(field, [], (db, rows) =>
      Effect.gen(function* () {
        yield* putAll(db, make)
        yield* db.entities.Soft.delete({ id: "a", f: make() }).asEffect()
        yield* db.entities.Soft.restore({ id: "a", f: make() })
        yield* db.entities.Unique.delete({ id: "b" }).asEffect()
        const now = yield* rows
        expect(typed(now, "Soft").map((row) => row.sk?.S)).toEqual([
          "$keys#v1#soft#f_bigdecimal(1.5)",
        ])
        expect(typed(now, "Unique")).toEqual([])
      }),
    )
  })

  it.effect("Cookie: put is refused with EDD-9128, and 1.39.0's row is found", () => {
    const { field, make } = kindOf("Cookie")
    return Effect.gen(function* () {
      yield* on(field, [], (db, rows) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(db.entities.Soft.put({ id: "a", f: make() }).asEffect())
          expect(Exit.isFailure(exit)).toBe(true)
          expect(JSON.stringify(exit)).toContain("EDD-9128")
          expect(yield* rows).toEqual([])
        }),
      )
      yield* on(field, fixture.Cookie!.stages.put, (db) =>
        Effect.asVoid(db.entities.Soft.get({ id: "a", f: make() })),
      )
    })
  })
})
