/**
 * A version snapshot and a soft-delete tombstone are told from a live row by the layout of their
 * sort key: the history prefix, an item segment holding the sort key composites' key text, and a
 * version or a timestamp. A composite's key text can hold a line break (a string holding one, or a
 * `UrlParams` composite, whose key text is multi-line, #242), and the layout test's `.*` stopped
 * at it: published 1.40.0 returned such a snapshot or tombstone from a scan and a partition query
 * as a live item, and `rekey` skipped both as keys it didn't recognise. Measured on DynamoDB Local
 * with published 1.40.0: a scan returned the snapshot beside its item and the tombstone of a
 * deleted one, and `rekey` reported `unrecognizedKey: 2`.
 */
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "nl", version: 1, escapeKeys: false })

const Docs = Entity.make({
  model: Schema.Struct({
    ownerId: Schema.String,
    name: Schema.String,
    note: Schema.optional(Schema.String),
  }),
  entityType: "Doc",
  primaryKey: {
    pk: { field: "pk", composite: ["ownerId"] },
    sk: { field: "sk", composite: ["name"] },
  },
  versioned: { retain: true },
  softDelete: true,
})

const Main = Table.make({ schema, entities: { Docs } })

/** An item updated once (its version 1 snapshot beside it) and another one deleted (its tombstone). */
const withHistory = (kept: string, deleted: string) => {
  const table = makeRecordingTable()
  const run = <A>(body: (db: any) => Effect.Effect<A, unknown, any>) =>
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { Main } })
      yield* db.entities.Docs.put({ ownerId: "o", name: kept })
      yield* db.entities.Docs.update({ ownerId: "o", name: kept }).set({ note: "n" })
      yield* db.entities.Docs.put({ ownerId: "o", name: deleted })
      yield* db.entities.Docs.delete({ ownerId: "o", name: deleted })
      return yield* body(db)
    }).pipe(
      Effect.provide(Main.layer({ name: "t" })),
      Effect.provide(table.layer),
    ) as Effect.Effect<A, unknown>
  return { table, run }
}

describe("history rows whose item segment holds a line break", () => {
  for (const [label, kept, deleted] of [
    ["a line break", "x\ny", "p\nq"],
    ["no line break (unchanged)", "xy", "pq"],
  ] as const) {
    it.effect(`${label}: the history rows are stored, and only the live item is read back`, () => {
      const { table, run } = withHistory(kept, deleted)
      return run((db) =>
        Effect.gen(function* () {
          const sks = [...table.items.values()].map((row) => row.sk?.S).sort()
          // The live item, a snapshot of each item's version 1, and the deleted one's tombstone.
          expect(sks).toHaveLength(4)
          expect(sks.filter((sk) => sk?.includes("#v#"))).toHaveLength(2)
          expect(sks.filter((sk) => sk?.includes("#deleted#"))).toHaveLength(1)
          const partition = yield* db.entities.Docs.primary({ ownerId: "o" }).collect()
          expect(partition.map((doc: { name: string }) => doc.name)).toEqual([kept])
          const scanned = yield* db.entities.Docs.scan().collect()
          expect(scanned.map((doc: { name: string }) => doc.name)).toEqual([kept])
          const deletedItems = yield* db.entities.Docs.deleted
            .list({ ownerId: "o", name: deleted })
            .collect()
          expect(deletedItems.map((doc: { name: string }) => doc.name)).toEqual([deleted])
          const versions = yield* db.entities.Docs.versions({ ownerId: "o", name: kept }).collect()
          expect(versions.map((doc: { version: number }) => doc.version)).toEqual([1])
        }),
      )
    })

    it.effect(`${label}: rekey finds every row where it belongs and moves nothing`, () => {
      const { run } = withHistory(kept, deleted)
      return run((db) =>
        Effect.gen(function* () {
          const report = yield* db.tables.Main.rekey()
          expect(report.scanned).toBe(4)
          expect(report.unchanged).toBe(4)
          expect(report.skipped.unrecognizedKey).toBe(0)
          expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
          expect(report.conflicts).toEqual([])
        }),
      )
    })
  }
})
