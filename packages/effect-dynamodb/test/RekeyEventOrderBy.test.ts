/**
 * `rekey` places a time-series event where `append` puts it. `append` composes the event's sort
 * key from the `orderBy` value it stores (the Encoded value). A `Schema.BigInt` stores a `bigint`,
 * which reads back as a number while it's a safe integer. Under 1.39.0's `escapeKeys: false`,
 * `rekey` composed the key from the number it read and moved a `5n` event to `5`'s key text.
 * `.history().where()` on `5n` then found nothing.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

describe.each([
  ["escapeKeys: false", false],
  ["escapeKeys: true", true],
])("a Schema.BigInt orderBy, %s", (_, escapeKeys) => {
  it.effect("rekey leaves events where append put them", () => {
    const schema = DynamoSchema.make({ name: "ts", version: 1, escapeKeys })
    const Input = Schema.Struct({ id: Schema.String, at: Schema.BigInt, v: Schema.String })
    const Readings = Entity.make({
      model: Input,
      entityType: "Readings",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      timeSeries: { orderBy: "at", appendInput: Input },
    })
    const Main = Table.make({ schema, entities: { Readings } })
    const table = makeRecordingTable({})
    const sortKeys = () =>
      ([...table.items.values()] as unknown as ReadonlyArray<Row>).map((row) => row.sk!.S).sort()
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings }, tables: { Main } })
      // A safe integer, which reads back as a number, and one past 2^53, which reads back as a
      // bigint.
      yield* db.entities.Readings.append({ id: "r", at: 5n, v: "a" }).asEffect()
      yield* db.entities.Readings.append({ id: "r", at: 2n ** 60n, v: "b" }).asEffect()
      const appended = sortKeys()
      const report = yield* db.tables.Main.rekey()
      expect(report.moved.event).toBe(0)
      expect(sortKeys()).toEqual(appended)
      const found = yield* db.entities.Readings.history({ id: "r" })
        .where((t, { eq }) => eq(t.at, 5n))
        .collect()
      expect(found.map((event) => event.v)).toEqual(["a"])
    }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer))
  })
})
