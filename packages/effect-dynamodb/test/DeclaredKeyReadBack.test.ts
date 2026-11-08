/**
 * A key composite whose value is a declaration's (`Schema.Option`, an array of them,
 * `Schema.Duration`): DynamoDB hands it back as a plain map, which composes other key text than the
 * value written until the field decodes it again. The rows are published 1.39.0's own
 * (`fixtures/declared-keys-1.39.0.json`), whose `restore` composed the live key from the map read back
 * (`f_[object object]`) and whose `delete` released a sentinel the put never wrote, leaving the one it
 * did.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Duration, Effect, Exit, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/declared-keys-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly shapes: Record<
    string,
    {
      readonly put: ReadonlyArray<Row>
      readonly seeded: ReadonlyArray<Row>
      readonly afterRestoreAndDelete: ReadonlyArray<Row>
    }
  >
}

/** The fixture's definitions: they must stay what its generator declared. */
const definitionsOf = (field: Schema.Top) => {
  const model = Schema.Struct({ id: Schema.String, f: field })
  const Soft = Entity.make({
    model,
    entityType: "Soft",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["f"] } },
    softDelete: true,
  } as never) as any
  const Unique = Entity.make({
    model,
    entityType: "Unique",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { byF: ["f"] },
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "declared", version: 1 }),
    entities: { Soft, Unique },
  } as never) as any
  return { Soft, Unique, Main }
}

const on = <A>(
  field: Schema.Top,
  seed: ReadonlyArray<Row>,
  body: (db: any, rows: () => ReadonlyArray<Row>) => Effect.Effect<A, unknown, any>,
) => {
  const { Soft, Unique, Main } = definitionsOf(field)
  const table = makeRecordingTable()
  for (const row of seed)
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  const rows = () => [...table.items.values()] as unknown as ReadonlyArray<Row>
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Soft, Unique },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db, rows)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

const typed = (rows: ReadonlyArray<Row>, prefix: string) =>
  rows.filter((row) => row.__edd_e__?.S?.startsWith(prefix))
const keysOf = (rows: ReadonlyArray<Row>) => rows.map((row) => `${row.pk?.S}|${row.sk?.S}`).sort()

const revived = {
  "Option(Number)": [Schema.Option(Schema.Number), Option.some(5)],
  "Option(BigIntFromString)": [Schema.Option(Schema.BigIntFromString), Option.some(5n)],
  "Array(Option(Number))": [Schema.Array(Schema.Option(Schema.Number)), [Option.some(5)]],
} as const

describe("a key composite holding a declaration's value, read back as a plain map", () => {
  for (const [label, [field, value]] of Object.entries(revived)) {
    const stored = fixture.shapes[label]!

    it.effect(`${label}: put composes the key 1.39.0 wrote`, () =>
      on(field, [], (db, rows) =>
        Effect.gen(function* () {
          yield* db.entities.Soft.put({ id: "a", f: value }).asEffect()
          expect(keysOf(rows())).toEqual(keysOf(stored.put))
          expect((yield* db.entities.Soft.get({ id: "a", f: value })).f).toEqual(value)
        }),
      ),
    )

    for (const seed of ["here", "1.39.0"] as const) {
      it.effect(`${label}, stored ${seed}: restore puts the item back under its own key`, () =>
        on(field, seed === "1.39.0" ? stored.seeded : [], (db, rows) =>
          Effect.gen(function* () {
            if (seed === "here") {
              yield* db.entities.Soft.put({ id: "a", f: value }).asEffect()
              yield* db.entities.Soft.delete({ id: "a", f: value }).asEffect()
            }
            yield* db.entities.Soft.restore({ id: "a", f: value })
            expect(keysOf(typed(rows(), "Soft"))).toEqual(keysOf(stored.put))
            expect((yield* db.entities.Soft.get({ id: "a", f: value })).f).toEqual(value)
          }),
        ),
      )

      it.effect(`${label}, stored ${seed}: delete releases the sentinel put wrote`, () =>
        on(field, seed === "1.39.0" ? stored.seeded : [], (db, rows) =>
          Effect.gen(function* () {
            if (seed === "here") yield* db.entities.Unique.put({ id: "b", f: value }).asEffect()
            expect(typed(rows(), "Unique")).toHaveLength(2)
            yield* db.entities.Unique.delete({ id: "b" }).asEffect()
            expect(typed(rows(), "Unique")).toEqual([])
            // The value is free again.
            yield* db.entities.Unique.put({ id: "c", f: value }).asEffect()
          }),
        ),
      )
    }

    it(`${label}: 1.39.0 restored under the map's text and kept the sentinel`, () => {
      expect(keysOf(typed(stored.afterRestoreAndDelete, "Soft"))).toEqual([
        "$declared#v1#soft#id_a|$declared#v1#soft#f_[object object]",
      ])
      expect(typed(stored.afterRestoreAndDelete, "Unique")).toHaveLength(1)
    })
  }

  // `Schema.Duration` takes the map read back as it is, so a key composed again from the row
  // would hold its text, `[object Object]`, and not `1000 millis`.
  it.effect("Schema.Duration: refused, as the map it reads back as composes other key text", () =>
    on(Schema.Duration, [], (db, rows) =>
      Effect.gen(function* () {
        const f = Duration.millis(1000)
        for (const exit of [
          yield* Effect.exit(db.entities.Soft.put({ id: "a", f }).asEffect()),
          yield* Effect.exit(db.entities.Unique.put({ id: "b", f }).asEffect()),
        ]) {
          expect(Exit.isFailure(exit)).toBe(true)
          const text = JSON.stringify(exit)
          expect(text).toContain("ValidationError")
          expect(text).toContain("EDD-9128")
          expect(text).toContain(`Field \\"f\\"`)
        }
        expect(rows()).toEqual([])
      }),
    ),
  )
})
