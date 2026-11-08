/**
 * A key composite holding a list of bigints beneath a step (a decoding default, a transformation over
 * itself): DynamoDB hands `[5n]` back as `[5]`, which the field refuses until a read lifts it, as
 * every entity read does. The key composed again from the row is the one written, so a write is
 * stored and not refused (EDD-9128). The rows are published 1.39.0's own
 * (`fixtures/nested-bigint-keys-1.39.0.json`), whose `restore` couldn't compose the live key from the
 * row at all (EDD-9050).
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema, SchemaTransformation } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/nested-bigint-keys-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly shapes: Record<
    string,
    {
      readonly put: ReadonlyArray<Row>
      readonly seeded: ReadonlyArray<Row>
      readonly restore: string
      readonly delete: string
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
    schema: DynamoSchema.make({ name: "nested", version: 1 }),
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

const list = Schema.Array(Schema.BigInt)
const shapes = {
  "default(Array(BigInt))": list.pipe(Schema.withDecodingDefault(Effect.succeed([5n]))),
  "OverItself(Array(BigInt))": list.pipe(Schema.decodeTo(list, SchemaTransformation.passthrough())),
} as const
const value = [5n]

describe("a key composite holding bigints beneath a step, read back as numbers", () => {
  for (const [label, field] of Object.entries(shapes)) {
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
            yield* db.entities.Unique.put({ id: "c", f: value }).asEffect()
          }),
        ),
      )
    }

    it(`${label}: 1.39.0 couldn't compose the restored item's key from the row`, () => {
      expect(stored.restore).toMatch(/^died: \[EDD-9050\] Composite "f" on entity "Soft"/)
      expect(stored.delete).toBe("ok")
      expect(keysOf(typed(stored.afterRestoreAndDelete, "Soft"))).toEqual(
        keysOf(typed(stored.seeded, "Soft")),
      )
    })
  }
})
