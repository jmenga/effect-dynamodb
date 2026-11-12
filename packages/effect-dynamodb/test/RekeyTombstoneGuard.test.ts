/**
 * A tombstone's move is guarded on the tombstone as read, as every move is, and one whose guard
 * can't prove it unchanged is counted in `guardGaps` (#240). A soft delete of the item put again
 * within the stamp's resolution replaces the tombstone at its key with the same `updatedAt`.
 * Guarded whole, the move sees it: it's cancelled, reads again and moves the new tombstone. Too
 * wide to guard whole, guarded on its `updatedAt` and what else fits, it can't, and is counted
 * (`guardGaps.stamp`) and named in `guardGaps.rows`. With `writesStopped`, nothing is counted.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { gatedLayer } from "./helpers/GatedClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const world = (escapeKeys: boolean, width: number) => {
  const fields = Array.from({ length: width }, (_, i) => `f${i}`)
  const schema = DynamoSchema.make({ name: "stampgap", version: 1, escapeKeys })
  const Items = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      ...Object.fromEntries(fields.map((field) => [field, Schema.String])),
    }),
    entityType: "Item",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    timestamps: true,
    softDelete: true,
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Items } })
  return {
    fields,
    MainTable,
    client: DynamoClient.make({
      entities: { Items },
      tables: { MainTable },
    } as never) as Effect.Effect<any>,
  }
}

/** What a race left: the run's report, the rows, whether the write landed, the field it changed. */
type Race = {
  readonly report: Table.RekeyReport
  readonly rows: ReadonlyArray<Record<string, any>>
  readonly raced: boolean
  readonly last: string
}

/**
 * An item `a b` of `width` fields, written with `escapeKeys` off and soft-deleted, then rekeyed
 * with it on. With `race`, just before the move's transaction the item is put again with its last
 * field `NEW` and soft-deleted again, in the same millisecond: the tombstone at its key is
 * replaced by one with the same `updatedAt`.
 */
const tombstoneRace = (
  width: number,
  race: boolean,
  options: Record<string, unknown> = {},
): Effect.Effect<Race> =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    const was = world(false, width)
    const now = world(true, width)
    const writer = yield* was.client.pipe(
      Effect.provide(Layer.merge(table.layer, was.MainTable.layer({ name: "t" }))),
    )
    const value = { id: "a b", ...Object.fromEntries(was.fields.map((field) => [field, "old"])) }
    yield* writer.entities.Items.put(value).asEffect()
    yield* writer.entities.Items.delete({ id: "a b" }).asEffect()
    const last = `f${width - 1}`
    let raced = false
    const around = (command: string, input: any, send: Effect.Effect<unknown, unknown>) => {
      const movesTombstone = (input.TransactItems ?? []).some((item: any) =>
        String(item.Delete?.Key?.sk?.S).includes("#deleted#"),
      )
      if (!race || raced || command !== "transactWriteItems" || !movesTombstone) return send
      raced = true
      return Effect.gen(function* () {
        yield* writer.entities.Items.put({ ...value, [last]: "NEW" }).asEffect()
        yield* writer.entities.Items.delete({ id: "a b" }).asEffect()
        return yield* send
      })
    }
    const report = yield* Effect.gen(function* () {
      const db = yield* now.client
      return yield* db.tables.MainTable.rekey({ concurrency: 1, ...options })
    }).pipe(
      Effect.provide(
        Layer.merge(
          gatedLayer(table.client as DynamoClientService, around as never),
          now.MainTable.layer({ name: "t" }),
        ),
      ),
    )
    const rows = [...table.items.values()]
    return { report, rows, raced, last }
  }) as unknown as Effect.Effect<Race>

describe("a tombstone replaced at its key in the stamp's resolution while rekey moves it", () => {
  it.effect("guarded whole: the move is cancelled, and moves the new tombstone", () =>
    Effect.gen(function* () {
      const { report, rows, raced, last } = yield* tombstoneRace(3, true)
      expect(raced).toBe(true)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.sk?.S).toContain("#deleted#")
      expect(rows[0]!.pk?.S).toBe("$stampgap#v1#item#id_a%20b")
      expect(rows[0]![last]).toEqual({ S: "NEW" })
      expect(report.moved.tombstone).toBe(1)
      expect(report.guardGaps).toEqual({ stamp: 0, sparse: 0, strongest: 0, rows: [] })
    }),
  )

  it.effect("too wide to guard whole: guarded on its updatedAt, counted and named", () =>
    Effect.gen(function* () {
      const { report, rows, raced, last } = yield* tombstoneRace(350, true)
      expect(raced).toBe(true)
      expect(rows).toHaveLength(1)
      // What the count says: the write landed unseen, and the tombstone read was moved over it.
      expect(rows[0]![last]).toEqual({ S: "old" })
      expect(report.moved.tombstone).toBe(1)
      expect(report.guardGaps).toEqual({
        stamp: 1,
        sparse: 0,
        strongest: 0,
        rows: [
          {
            member: "Item",
            kind: "tombstone",
            gap: "stamp",
            key: { pk: "$stampgap#v1#item#id_a b", sk: expect.stringContaining("#deleted#") },
            target: {
              pk: "$stampgap#v1#item#id_a%20b",
              sk: expect.stringContaining("#deleted#"),
            },
          },
        ],
      })
    }),
  )

  it.effect("too wide to guard whole, writes stopped: not counted", () =>
    Effect.gen(function* () {
      const { report } = yield* tombstoneRace(350, false, { writesStopped: true })
      expect(report.moved.tombstone).toBe(1)
      expect(report.guardGaps).toEqual({ stamp: 0, sparse: 0, strongest: 0, rows: [] })
    }),
  )
})
