/**
 * `rekey` of an item whose unique value is a zoned date outside its key, written by published 1.40.0
 * on Effect 4.1.3 (#242, `fixtures/zone-unique-1.40.0-effect-4.1.3.json`): its date's text and its
 * zone's map hold the zone's given name (`Asia/Kolkata`) and its sentinel is keyed by it, where 1.41.0
 * stores and keys the name it resolves to (`Asia/Calcutta`). Before `rekey`, another item can take
 * the value. Per item, the rewrite of its zones and the move of everything keyed by them are one
 * step: while another item holds the value, every run reports it `taken` and leaves the item exactly
 * as it was, as a dry run says; once the other lets go, one run moves the sentinel and rewrites the
 * zones, and the value is enforced again. The same on Effect 4.1.2 and 4.1.3.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Exit, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/zone-unique-1.40.0-effect-4.1.3.json", import.meta.url), "utf8"),
) as { readonly generatedFrom: string; readonly rows: ReadonlyArray<Row> }

const G = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    when: Schema.DateTimeZoned,
    tz: Schema.optional(Schema.TimeZoneNamed),
    note: Schema.optional(Schema.String),
  }),
  entityType: "G",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  unique: { byWhen: ["when"], byNote: ["note"] },
})
const Main = Table.make({ schema: DynamoSchema.make({ name: "zu", version: 1 }), entities: { G } })
const when = () => DateTime.makeZonedUnsafe(1700000000000, { timeZone: "Asia/Kolkata" })

const seeded = () => {
  const table = makeRecordingTable()
  for (const row of fixture.rows) {
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  }
  return table
}

describe("rekey of a unique zoned date another item took before it ran", () => {
  it("the rows are published 1.40.0's on Effect 4.1.3", () => {
    expect(fixture.generatedFrom).toBe("effect-dynamodb@1.40.0 + effect@4.1.3")
  })

  it.effect("taken: every run leaves the item as it was; once let go, one run moves it all", () => {
    const table = seeded()
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { G }, tables: { Main } })
      const rows = () => [...table.items.values()] as unknown as ReadonlyArray<Row>
      const g = () => rows().find((row) => row.__edd_e__?.S === "G" && row.id?.S === "g")
      const read = structuredClone(rows())
      const taken = (report: { readonly conflicts: ReadonlyArray<any> }) =>
        report.conflicts.map(({ kind, reason }) => [kind, reason])
      // Not enforced before rekey: the sentinel is under the given name.
      yield* db.entities.G.put({ id: "g2", when: when(), note: "m" }).asEffect()
      const other = rows().filter((row) => !read.some((was) => was.pk?.S === row.pk?.S))
      const dry = yield* db.tables.Main.rekey({ repairIndexKeys: true, dryRun: true })
      const first = yield* db.tables.Main.rekey({ repairIndexKeys: true })
      for (const report of [dry, first]) {
        expect(taken(report)).toEqual([["item", "taken"]])
        expect(report.zonesRewritten).toBe(0)
        expect(report.sentinelsMoved).toBe(0)
        expect(report.skipped.unrecognizedKey).toBe(0)
      }
      // Exactly as 1.40.0 left it, and the other item as it wrote it.
      expect(rows()).toEqual([...read, ...other])
      const again = yield* db.tables.Main.rekey({ repairIndexKeys: true })
      expect(taken(again)).toEqual([["item", "taken"]])
      expect(rows()).toEqual([...read, ...other])
      // The other item lets go: the next run moves the sentinel and rewrites the zones together.
      yield* db.entities.G.delete({ id: "g2" }).asEffect()
      const after = yield* db.tables.Main.rekey({ repairIndexKeys: true })
      expect(taken(after)).toEqual([])
      expect(after.sentinelsMoved).toBe(1)
      expect(after.zonesRewritten).toBe(1)
      expect(g()?.when).toEqual({ S: "2023-11-15T03:43:20.000+05:30[Asia/Calcutta]" })
      expect(JSON.stringify(rows()).toLowerCase()).not.toContain("kolkata")
      const settled = yield* db.tables.Main.rekey({ repairIndexKeys: true })
      expect(settled.skipped.unrecognizedKey).toBe(0)
      expect(settled.conflicts).toEqual([])
      expect(settled.zonesRewritten + settled.sentinelsMoved).toBe(0)
      // Enforced again.
      const third = yield* Effect.exit(
        db.entities.G.put({ id: "g3", when: when(), note: "o" }).asEffect(),
      )
      expect(Exit.isFailure(third) && JSON.stringify(third)).toContain("UniqueConstraintViolation")
    }).pipe(Effect.provide(Main.layer({ name: "zu" })), Effect.provide(table.layer))
  })
})
