import { describe, expect, it } from "@effect/vitest"
import { DateEpochMs } from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { DateTime, Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

/**
 * Aggregate and entity key composition now run the SAME rule, from the same
 * function (`internal/CompositeCodec.ts`):
 *
 * > Compose from the Encoded form, EXCEPT when the domain type is numeric
 * > (`number` / `bigint`) and the encoded form is a string — then compose from
 * > the numeric Type form so `serializeValue` pads it.
 *
 * This file previously argued the two paths should stay divergent, on the
 * grounds that aggregates were internally consistent and unifying them would
 * orphan stored rows. That argument is withdrawn: the divergence was a symptom
 * of a real bug, not a design. The entity path composed a `BigIntFromString`
 * composite from its ENCODED string, so `serializeValue` never padded it and
 * `txn_5`, `txn_42`, `txn_100` sorted 100 < 42 < 5 — a range query returned the
 * wrong rows. Under the rule both paths pad it, and both agree.
 *
 * What actually changes per path:
 *
 * | composite shape             | entity path      | aggregate path   |
 * |-----------------------------|------------------|------------------|
 * | numeric Type, string Encoded| unpadded → PADDED | unchanged (padded) |
 * | `DateEpochMs` (Date → number)| unchanged (epoch) | ISO → EPOCH      |
 * | everything else             | unchanged        | unchanged        |
 *
 * Both are storage-format changes and are called out in the changeset.
 */
describe("Aggregate key encoding (shared composite key-form rule)", () => {
  const AppSchema = DynamoSchema.make({ name: "aggkeys", version: 1 })

  class Entry extends Schema.Class<Entry>("Entry")({
    txn: Schema.BigIntFromString,
    note: Schema.String,
  }) {}

  // Type DateTime, Encoded number — the shape whose aggregate key CHANGES.
  class Reading extends Schema.Class<Reading>("Reading")({
    at: DateEpochMs,
    note: Schema.String,
  }) {}

  const MainTable = Table.make({ schema: AppSchema, entities: {} })

  const LedgerAggregate = Aggregate.make(Entry, {
    table: MainTable,
    schema: AppSchema,
    pk: { field: "pk", composite: ["txn"] },
    collection: { index: "lsi1", name: "ledger", sk: { field: "lsi1sk", composite: [] } },
    root: { entityType: "LedgerEntry" },
    edges: {},
  })

  const ReadingAggregate = Aggregate.make(Reading, {
    table: MainTable,
    schema: AppSchema,
    pk: { field: "pk", composite: ["at"] },
    collection: { index: "lsi1", name: "readings", sk: { field: "lsi1sk", composite: [] } },
    root: { entityType: "ReadingEntry" },
    edges: {},
  })

  const mockTransactWrite = vi.fn()
  const TestLayer = Layer.merge(
    mockDynamoClientLayer({
      transactWriteItems: (input) =>
        Effect.tryPromise({
          try: () => mockTransactWrite(input),
          catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
        }),
    }),
    MainTable.layer({ name: "aggkeys-table" }),
  )

  beforeEach(() => {
    mockTransactWrite.mockReset()
  })

  const pkOf = () => {
    const call = mockTransactWrite.mock.calls[0]![0] as {
      TransactItems: Array<{ Put?: { Item: Record<string, { S?: string }> } }>
    }
    return call.TransactItems[0]!.Put!.Item.pk!.S
  }

  it.effect("numeric Type + string Encoded composes PADDED — same as the entity path", () =>
    Effect.gen(function* () {
      mockTransactWrite.mockResolvedValue({})
      yield* LedgerAggregate.create({ txn: "420", note: "n" } as never)
      expect(pkOf()).toBe("$aggkeys#v1#ledger#00000000000000000000000000000000000420")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("mixed-width values order numerically", () =>
    Effect.gen(function* () {
      const keys: Array<string> = []
      for (const v of ["5", "42", "100"]) {
        mockTransactWrite.mockReset()
        mockTransactWrite.mockResolvedValue({})
        yield* LedgerAggregate.create({ txn: v, note: "n" } as never)
        keys.push(pkOf()!)
      }
      expect([...keys].sort()).toEqual(keys)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("DateEpochMs composes the EPOCH — changed from the previous ISO form", () =>
    Effect.gen(function* () {
      mockTransactWrite.mockResolvedValue({})
      const at = DateTime.makeUnsafe("2026-02-11T00:00:00.000Z")
      yield* ReadingAggregate.create({ at, note: "n" } as never)
      const epoch = String(DateTime.toEpochMillis(at)).padStart(16, "0")
      expect(pkOf()).toBe(`$aggkeys#v1#readings#${epoch}`)
      // Previously `…#2026-02-11t00:00:00.000z` — a storage-format change.
      expect(pkOf()).not.toContain("2026-02-11t")
    }).pipe(Effect.provide(TestLayer)),
  )
})
