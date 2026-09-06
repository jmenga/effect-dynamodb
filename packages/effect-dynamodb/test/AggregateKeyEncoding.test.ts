import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"

/**
 * The entity and aggregate key paths are MIRROR IMAGES of each other, and this
 * test pins that so a change to either is visible in review.
 *
 * | path      | input it accepts    | key composed from |
 * |-----------|---------------------|-------------------|
 * | entity    | Type (`420n`)       | Encoded (`"420"`) |
 * | aggregate | Encoded (`"420"`)   | Type (`420n`)     |
 *
 * For a composite carrying an encoding transformation the two therefore produce
 * DIFFERENT key strings for the same logical value: a `BigIntFromString` of
 * `420n` composes `…#00000000000000000000000000000000000420` through an
 * aggregate (serializeValue pads a bigint to 38 digits) and `…#420` through an
 * entity. Untransformed composites, where Type and Encoded are the same value,
 * are identical on both paths.
 *
 * This is NOT to be "fixed" for consistency without a migration. Aggregates are
 * internally consistent — they decode the input, then compose from the decoded
 * value on both read (`Aggregate.ts` `fetchPartition`) and write — so they work
 * today and callers have stored data in this format. Routing them through the
 * entity codec would silently orphan every existing row with a transformed
 * composite: no error, just a partition that no longer resolves.
 *
 * The entity path could be changed safely because neither input spelling worked
 * there beforehand — the domain value failed validation and the wire value
 * returned `ItemNotFound` for a row that exists — so no data existed in either
 * format. That argument does not transfer here.
 *
 * Unifying the two belongs in a major, with a migration note. The dangerous
 * case meanwhile is an aggregate and an entity sharing a partition and expecting
 * byte-identical keys for a transformed composite; nothing detects that yet.
 */
describe("Aggregate key encoding (Type side, deliberately divergent)", () => {
  const AppSchema = DynamoSchema.make({ name: "aggkeys", version: 1 })

  class Entry extends Schema.Class<Entry>("Entry")({
    txn: Schema.BigIntFromString,
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

  const mockTransactWrite = vi.fn()
  const TestLayer = Layer.merge(
    Layer.succeed(DynamoClient, {
      transactWriteItems: (input) =>
        Effect.tryPromise({
          try: () => mockTransactWrite(input),
          catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
        }),
      query: () => Effect.die("not used"),
      putItem: () => Effect.die("not used"),
      getItem: () => Effect.die("not used"),
      deleteItem: () => Effect.die("not used"),
      updateItem: () => Effect.die("not used"),
      batchGetItem: () => Effect.die("not used"),
      batchWriteItem: () => Effect.die("not used"),
      transactGetItems: () => Effect.die("not used"),
      createTable: () => Effect.die("not used"),
      deleteTable: () => Effect.die("not used"),
      describeTable: () => Effect.die("not used"),
      scan: () => Effect.die("not used"),
    } as never),
    MainTable.layer({ name: "aggkeys-table" }),
  )

  beforeEach(() => {
    mockTransactWrite.mockReset()
  })

  it.effect("composes a transformed pk composite from the Type side", () =>
    Effect.gen(function* () {
      mockTransactWrite.mockResolvedValue({})

      yield* LedgerAggregate.create({ txn: "420", note: "n" } as never)

      const call = mockTransactWrite.mock.calls[0]![0] as {
        TransactItems: Array<{ Put?: { Item: Record<string, { S?: string }> } }>
      }
      const pk = call.TransactItems[0]!.Put!.Item.pk!.S

      // Type side: serializeValue pads a bigint to 38 digits.
      // The entity path would compose "…#420" from the encoded string instead.
      expect(pk).toBe("$aggkeys#v1#ledger#00000000000000000000000000000000000420")
    }).pipe(Effect.provide(TestLayer)),
  )
})
