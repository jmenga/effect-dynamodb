/**
 * A key whose composites earlier releases each composed their own way (#242). Published 1.39.0 on
 * Effect 4.1.3 keyed an item by a `Duration` and a date zoned in `Etc/UTC` under
 * `…#d_1500 millis#at_…[etc/utc]` (the zone under the name it was given), and its `restore` put the
 * item back under `…#d_[object object]#at_…[etc/utc]`: the `Duration` as the map its tombstone held,
 * the zone still as given. Neither reading by itself composes that key; `rekey` reads each composite
 * its own way, in every combination (`keyReadings`), and moves both items to the key composed now,
 * under either `escapeKeys` setting. The rows are 1.39.0's own
 * (`fixtures/mixed-restore-keys-1.39.0-effect-4.1.3.json`).
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Duration, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>
const written = JSON.parse(
  readFileSync(
    new URL("./fixtures/mixed-restore-keys-1.39.0-effect-4.1.3.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly generatedFrom: string
  readonly results: Record<string, unknown>
  readonly rows: ReadonlyArray<Row>
}

const Mixed = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    d: Schema.Duration,
    at: Schema.DateTimeZoned,
    note: Schema.optional(Schema.String),
  }),
  entityType: "Mixed",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: ["d", "at"] },
  },
  softDelete: true,
})
const key = (id: string) => ({
  id,
  d: Duration.millis(1500),
  at: DateTime.makeZonedUnsafe(0, { timeZone: "Etc/UTC" }),
})

const run = <A>(
  escapeKeys: boolean,
  table: ReturnType<typeof makeRecordingTable>,
  body: (db: any) => Effect.Effect<A, unknown, unknown>,
) => {
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "mx", version: 1, escapeKeys }),
    entities: { Mixed },
  })
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { Mixed }, tables: { Main } })
    return yield* body(db)
  }).pipe(Effect.provide(Main.layer({ name: "mx" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

const found = (db: any, id: string) =>
  Effect.map(Effect.exit(db.entities.Mixed.get(key(id))), (exit) => Exit.isSuccess(exit))

describe("a key 1.39.0 composed two ways at once, on Effect 4.1.3", () => {
  it("the fixture is 1.39.0's: restore keyed the Duration as a map and the zone as given", () => {
    expect(written.generatedFrom).toBe("effect-dynamodb@1.39.0 + effect@4.1.3")
    expect(written.results.restoreA).toBe("ok")
    expect(written.rows.map((row) => row.sk?.S)).toEqual([
      "$mx#v1#mixed#d_[object object]#at_1970-01-01t00:00:00.000+00:00[etc/utc]",
      "$mx#v1#mixed#d_1500 millis#at_1970-01-01t00:00:00.000+00:00[etc/utc]",
    ])
  })

  for (const escapeKeys of [false, true]) {
    it.effect(`rekey moves both to the key composed now (escapeKeys: ${escapeKeys})`, () =>
      Effect.gen(function* () {
        const table = makeRecordingTable()
        for (const row of written.rows) {
          table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
        }
        yield* run(escapeKeys, table, (db) =>
          Effect.gen(function* () {
            expect([yield* found(db, "a"), yield* found(db, "b")]).toEqual([false, false])
            const dry = yield* db.tables.Main.rekey({ dryRun: true })
            const report = yield* db.tables.Main.rekey()
            expect(report.conflicts).toEqual([])
            expect(report.skipped.unrecognizedKey).toBe(0)
            expect(report.moved.item).toBe(2)
            expect(dry.moved).toEqual(report.moved)
            expect([yield* found(db, "a"), yield* found(db, "b")]).toEqual([true, true])
            const item = yield* db.entities.Mixed.get(key("a"))
            expect(item.note).toBe("a")
            const again = yield* db.tables.Main.rekey()
            expect(again.moved.item).toBe(0)
            expect(again.unchanged).toBe(2)
          }),
        )
      }),
    )
  }
})
