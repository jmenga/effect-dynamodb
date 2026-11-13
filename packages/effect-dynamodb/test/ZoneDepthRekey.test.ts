/**
 * Rows keyed by zones inside a container, by the names they were given (#242). Published 1.40.0 on
 * Effect 4.1.3 keyed a list of zones `timezone.named(etc/utc)`, a list through
 * `Schema.TimeZoneNamedFromString` `etc/utc`, a tuple and a list of zoned dates' text likewise,
 * where every key is now composed from the resolved name at any depth (`walkLeaves`), the text
 * 1.40.0 composed on Effect 4.1.2. `rekey` reads each zone where it sits under the name the row
 * stores there (`givenZoneReading`), so a list holding `Etc/UTC` and `GMT`, both `UTC` now, reads as
 * `timezone.named(etc/utc),timezone.named(gmt)`, and moves each row, its unique sentinel and its index
 * key. The rows are 1.40.0's own (`fixtures/zone-depth-keys-1.40.0-effect-4.1.3.json`);
 * `europe/london` is a zone given in another case, whose key text is the same under the lowercase
 * casing, so its rows don't move.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

const written = JSON.parse(
  readFileSync(
    new URL("./fixtures/zone-depth-keys-1.40.0-effect-4.1.3.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly generatedFrom: string
  readonly results: Record<string, Record<string, unknown>>
  readonly rows: ReadonlyArray<Row>
}

const pk = { field: "pk", composite: ["id"] } as const
const ListKeyed = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    zl: Schema.Array(Schema.TimeZoneNamed),
    note: Schema.optional(Schema.String),
  }),
  entityType: "ListKeyed",
  primaryKey: { pk, sk: { field: "sk", composite: ["zl"] } },
  unique: { byZl: ["zl"] },
})
const CodecKeyed = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    zc: Schema.Array(Schema.TimeZoneNamedFromString),
    note: Schema.optional(Schema.String),
  }),
  entityType: "CodecKeyed",
  primaryKey: { pk, sk: { field: "sk", composite: ["zc"] } },
  unique: { byZc: ["zc"] },
  indexes: {
    byZc: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["zc"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
})
const OptionKeyed = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    zo: Schema.Option(Schema.Array(Schema.TimeZoneNamed)),
    note: Schema.optional(Schema.String),
  }),
  entityType: "OptionKeyed",
  primaryKey: { pk, sk: { field: "sk", composite: ["zo"] } },
})
const TupleKeyed = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    zt: Schema.Tuple([Schema.String, Schema.TimeZoneNamed]),
    note: Schema.optional(Schema.String),
  }),
  entityType: "TupleKeyed",
  primaryKey: { pk, sk: { field: "sk", composite: ["zt"] } },
})
const DatesKeyed = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    zd: Schema.Array(Schema.DateTimeZonedFromString),
    note: Schema.optional(Schema.String),
  }),
  entityType: "DatesKeyed",
  primaryKey: { pk, sk: { field: "sk", composite: ["zd"] } },
})
const entities = { ListKeyed, CodecKeyed, OptionKeyed, TupleKeyed, DatesKeyed }
const Main = Table.make({ schema: DynamoSchema.make({ name: "depth", version: 1 }), entities })

const CASES = [["Etc/UTC"], ["Asia/Kolkata"], ["europe/london"], ["Etc/UTC", "GMT"]] as const
/** Cases naming a zone by a name other than the resolved one: their rows are under old keys. */
const MOVED = new Set(["Etc/UTC", "Asia/Kolkata", "Etc/UTC+GMT"])
const zone = (name: string) => DateTime.zoneMakeNamedUnsafe(name)
const at = (name: string) => DateTime.makeZonedUnsafe(0, { timeZone: zone(name) })

const rowsOf = (table: ReturnType<typeof makeRecordingTable>) =>
  [...table.items.values()] as unknown as ReadonlyArray<Row>
const keysOf = (rows: ReadonlyArray<Row>) =>
  rows.map((row) => [row.pk?.S, row.sk?.S, row.gsi1pk?.S].join("|")).sort()

const seeded = () => {
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  for (const row of written.rows)
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  return table
}

const run = <A>(
  table: ReturnType<typeof makeRecordingTable>,
  body: (db: any) => Effect.Effect<A, unknown, unknown>,
) =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities, tables: { Main } })
    return yield* body(db)
  }).pipe(
    Effect.provide(Main.layer({ name: "depth" })),
    Effect.provide(table.layer),
  ) as Effect.Effect<A, unknown>

const found = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => Exit.isSuccess(exit))

/** Whether each row of case `n` is found by its key, and the index by its zones. */
const reach = (db: any, n: number, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return {
      list: yield* found(db.entities.ListKeyed.get({ id: `l${n}`, zl: names.map(zone) })),
      codec: yield* found(db.entities.CodecKeyed.get({ id: `c${n}`, zc: names.map(zone) })),
      tuple: yield* found(db.entities.TupleKeyed.get({ id: `t${n}`, zt: ["x", zone(names[0]!)] })),
      dates: yield* found(db.entities.DatesKeyed.get({ id: `d${n}`, zd: names.map(at) })),
      indexed: (yield* db.entities.CodecKeyed.byZc({ zc: names.map(zone) }).collect()).length,
    }
  })

describe("rows published 1.40.0 keyed by zones inside a container, on Effect 4.1.3", () => {
  it("the fixture is 1.40.0's, on 4.1.3, keyed by each zone's given name", () => {
    expect(written.generatedFrom).toBe("effect-dynamodb@1.40.0 + effect@4.1.3")
    expect(written.rows).toHaveLength(24)
    const keys = keysOf(written.rows).join("\n")
    expect(keys).toContain("$depth#v1#listkeyed#zl_timezone.named(etc/utc),timezone.named(gmt)")
    expect(keys).toContain("$depth#v1#codeckeyed.byzc#etc/utc,gmt|")
    expect(keys).toContain("$depth#v1#dateskeyed#zd_1970-01-01t05:30:00.000+05:30[asia/kolkata]")
    expect(keys).not.toContain("calcutta")
    for (const result of Object.values(written.results)) {
      expect(result.listGet).toBe("ok")
      expect(result.codecQuery).toBe(1)
    }
  })

  it.effect("rekey moves each, reading every zone where it sits; all are found after", () =>
    Effect.gen(function* () {
      const table = seeded()
      yield* run(table, (db) =>
        Effect.gen(function* () {
          for (const [n, names] of CASES.entries()) {
            const reached = yield* reach(db, n, names)
            const moved = MOVED.has(names.join("+"))
            expect([names, reached]).toEqual([
              names,
              {
                list: !moved,
                codec: !moved,
                tuple: !moved,
                dates: !moved,
                indexed: moved ? 0 : 1,
              },
            ])
          }
          const report = yield* db.tables.Main.rekey({ repairIndexKeys: true })
          expect(report.conflicts).toEqual([])
          expect(Object.values(report.skipped).every((count) => count === 0)).toBe(true)
          // Three cases of four kinds of row.
          expect(report.moved.item).toBe(12)
          expect(report.sentinelsMoved).toBe(6)
          // A row moves with its index keys composed again: none is left to rewrite in place.
          expect(report.indexKeysRewritten).toBe(0)
          const keys = keysOf(rowsOf(table)).join("\n")
          expect(keys).not.toContain("etc/utc")
          expect(keys).not.toContain("gmt")
          expect(keys).not.toContain("asia/kolkata")
          expect(keys).toContain("$depth#v1#listkeyed#zl_timezone.named(utc),timezone.named(utc)")
          for (const [n, names] of CASES.entries()) {
            expect([names, yield* reach(db, n, names)]).toEqual([
              names,
              { list: true, codec: true, tuple: true, dates: true, indexed: 1 },
            ])
            const taken = yield* Effect.exit(
              db.entities.ListKeyed.put({ id: `other${n}`, zl: names.map(zone) }).asEffect(),
            )
            expect(JSON.stringify(taken)).toContain("UniqueConstraintViolation")
          }
          const again = yield* db.tables.Main.rekey({ repairIndexKeys: true })
          expect(Object.values(again.moved).every((count) => count === 0)).toBe(true)
          expect(again.sentinelsMoved).toBe(0)
          expect(again.indexKeysRewritten).toBe(0)
        }),
      )
    }),
  )
})
