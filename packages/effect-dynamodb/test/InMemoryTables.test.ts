/**
 * The in-memory tables answer as DynamoDB does (#243): `helpers/InMemoryTables.ts`'s
 * `InMemoryClient` and `holds`, and `helpers/RecordingTable.ts`. Each behaviour here was measured on
 * DynamoDB Local first.
 *
 * - **Values compare by content.** A map equals a map holding the same keys and values in any
 *   order (nested ones too), a list its elements in order, a set its members in any order, a number
 *   its value however it's spelled; values of different types are never equal, and `<` between
 *   them never holds. Before, anything but a number or a string compared by its JSON text, so a
 *   condition naming a stored map with its keys in another order failed in memory only.
 * - **An update whose expression the item can't take is rejected** with DynamoDB's
 *   `ValidationException` and message, as the library's client reports it
 *   (`DynamoValidationError`), and writes nothing: once its condition has passed (a failed
 *   condition answers first), and, in a transaction, for the whole request, ahead of another item's
 *   failed condition. Before, it was taken and stored nothing.
 * - **A request naming one item twice is rejected**: a `BatchGetItem` or `BatchWriteItem` ("Provided
 *   list of item keys contains duplicates"), a transaction ("Transaction request cannot include
 *   multiple operations on one item"). Before, the batches and `TransactGetItems` took it.
 * - **Names are the item's own attributes**: an item without `constructor` doesn't hold it.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { beforeEach, describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  holds,
  InMemoryClient,
  keyOf,
  resetStore,
  sameValue,
  store,
} from "./helpers/InMemoryTables.js"
import {
  DDB_REPEATED_BATCH_ITEM,
  DDB_REPEATED_ITEM,
  DDB_UPDATE_INVALID_PATH,
  DDB_UPDATE_MISSING_ATTRIBUTE,
} from "./helpers/MockDynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Item = Record<string, AttributeValue>

const stored: Item = {
  m: { M: { a: { S: "1" }, b: { N: "2" }, n: { M: { x: { S: "x" }, y: { S: "y" } } } } },
  l: { L: [{ M: { p: { S: "p" }, q: { S: "q" } } }] },
  ss: { SS: ["a", "b"] },
  ns: { NS: ["1", "2.0"] },
  bs: { BS: [new Uint8Array([1]), new Uint8Array([2])] },
  n: { N: "1.50" },
  big: { N: "12345678901234567890123456789012345678" },
  b: { B: new Uint8Array([1, 2]) },
  s: { S: "2" },
}

/** Whether `#f <op> :v` holds on `stored`. */
const compares = (field: string, op: string, value: AttributeValue) =>
  holds(`#f ${op} :v`, stored, { "#f": field }, { ":v": value })

describe("a condition compares values by content, as DynamoDB Local does", () => {
  const cases: ReadonlyArray<readonly [string, string, string, AttributeValue, boolean]> = [
    [
      "a map, its keys in another order",
      "m",
      "=",
      { M: { n: { M: { y: { S: "y" }, x: { S: "x" } } }, b: { N: "2" }, a: { S: "1" } } },
      true,
    ],
    [
      "<> a map, its keys in another order",
      "m",
      "<>",
      { M: { n: { M: { y: { S: "y" }, x: { S: "x" } } }, b: { N: "2" }, a: { S: "1" } } },
      false,
    ],
    [
      "a map with one value different",
      "m",
      "=",
      { M: { n: { M: { y: { S: "y" }, x: { S: "x" } } }, b: { N: "3" }, a: { S: "1" } } },
      false,
    ],
    [
      "a map with a number spelled 2.0",
      "m",
      "=",
      { M: { n: { M: { y: { S: "y" }, x: { S: "x" } } }, b: { N: "2.0" }, a: { S: "1" } } },
      true,
    ],
    ["a map with a key fewer", "m", "=", { M: { b: { N: "2" }, a: { S: "1" } } }, false],
    [
      "a list, a map in it with its keys in another order",
      "l",
      "=",
      { L: [{ M: { q: { S: "q" }, p: { S: "p" } } }] },
      true,
    ],
    ["a string set in another order", "ss", "=", { SS: ["b", "a"] }, true],
    ["a number set in another order and spelling", "ns", "=", { NS: ["2", "1.0"] }, true],
    [
      "a binary set in another order",
      "bs",
      "=",
      { BS: [new Uint8Array([2]), new Uint8Array([1])] },
      true,
    ],
    ["a number spelled 1.5", "n", "=", { N: "1.5" }, true],
    ["a number spelled 15E-1", "n", "=", { N: "15E-1" }, true],
    [
      "38 digits, the last one different",
      "big",
      "=",
      { N: "12345678901234567890123456789012345679" },
      false,
    ],
    ["38 digits, below by one", "big", "<", { N: "12345678901234567890123456789012345679" }, true],
    ["bytes", "b", "=", { B: new Uint8Array([1, 2]) }, true],
    ["a number = the same digits as a string", "n", "=", { S: "1.50" }, false],
    ["a number <> a string", "n", "<>", { S: "1.50" }, true],
    ["a number < a string", "n", "<", { S: "2" }, false],
    ["a string > a number", "s", ">", { N: "1" }, false],
    ["a missing attribute <> a value", "zz", "<>", { S: "1" }, true],
  ]
  for (const [label, field, op, value, expected] of cases) {
    it(`${label}: ${expected ? "holds" : "fails"}`, () => {
      expect(compares(field, op, value)).toBe(expected)
    })
  }

  it("sameValue is symmetric", () => {
    for (const [, field, op, value] of cases) {
      if (op !== "=" || stored[field] === undefined) continue
      expect(sameValue(value, stored[field]!)).toBe(sameValue(stored[field]!, value))
    }
  })

  it("an item without `constructor` or `toString` holds neither", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(holds("attribute_exists(#f)", { pk: { S: "p" } }, { "#f": name }, {})).toBe(false)
      expect(holds("attribute_not_exists(#f)", { pk: { S: "p" } }, { "#f": name }, {})).toBe(true)
      expect(
        holds("attribute_exists(#m.#f)", { m: { M: {} } }, { "#m": "m", "#f": name }, {}),
      ).toBe(false)
    }
  })
})

/** A table answering the requests below: the recording table, or `InMemoryClient`. */
const TABLES = {
  "recording table": () => {
    const table = makeRecordingTable()
    return {
      layer: table.layer,
      seed: (item: Item) => table.items.set(`${item.pk!.S}|${item.sk!.S}`, item),
      read: (key: Item) => table.items.get(`${key.pk!.S}|${key.sk!.S}`),
    }
  },
  InMemoryClient: () => {
    resetStore()
    return {
      layer: InMemoryClient,
      seed: (item: Item) => store.set(keyOf("t", item), item),
      read: (key: Item) => store.get(keyOf("t", key)),
    }
  },
} as const

beforeEach(() => resetStore())

const key = (id: string): Item => ({ pk: { S: id }, sk: { S: "x" } })

/** `f` given the client in context. */
const withClient = <A, E>(f: (client: DynamoClientService) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    return yield* f(client)
  })

/** A request's failure, as the library's client reports it: tag, the cause's name and message. */
const failureOf = <A, E>(
  effect: Effect.Effect<A, E, DynamoClient>,
  layer: Layer.Layer<DynamoClient>,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(Effect.provide(effect, layer))
    if (Exit.isSuccess(exit)) return "ok"
    const error = Cause.squash(exit.cause) as {
      readonly _tag: string
      readonly cause?: { readonly name?: string; readonly message?: string }
    }
    return `${error._tag}: ${error.cause?.name}: ${error.cause?.message}`
  })

const refused = (message: string) => `DynamoValidationError: ValidationException: ${message}`

for (const [name, make] of Object.entries(TABLES)) {
  describe(`${name}: an update DynamoDB rejects is rejected, and writes nothing`, () => {
    const held = (): Item => ({ ...key("u"), version: { N: "1" }, m: { M: {} } })

    it.effect("SET #a = #a - :n, #a missing", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed(held())
        const got = yield* failureOf(
          withClient((client) =>
            client.updateItem({
              TableName: "t",
              Key: key("u"),
              UpdateExpression: "SET #x = :x, #a = #a - :n",
              ExpressionAttributeNames: { "#a": "a", "#x": "x" },
              ExpressionAttributeValues: { ":n": { N: "1" }, ":x": { S: "x" } },
            }),
          ),
          table.layer,
        )
        expect(got).toBe(refused(DDB_UPDATE_MISSING_ATTRIBUTE))
        expect(table.read(key("u"))).toEqual(held())
      }),
    )

    it.effect("SET #a = list_append(#a, :l), #a missing", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed(held())
        const got = yield* failureOf(
          withClient((client) =>
            client.updateItem({
              TableName: "t",
              Key: key("u"),
              UpdateExpression: "SET #a = list_append(#a, :l)",
              ExpressionAttributeNames: { "#a": "a" },
              ExpressionAttributeValues: { ":l": { L: [{ S: "x" }] } },
            }),
          ),
          table.layer,
        )
        expect(got).toBe(refused(DDB_UPDATE_MISSING_ATTRIBUTE))
        expect(table.read(key("u"))).toEqual(held())
      }),
    )

    it.effect("SET #v = #v + :one on an item that isn't there: refused, and still not there", () =>
      Effect.gen(function* () {
        const table = make()
        const got = yield* failureOf(
          withClient((client) =>
            client.updateItem({
              TableName: "t",
              Key: key("none"),
              UpdateExpression: "SET #v = #v + :one",
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#v": "version", "#pk": "pk" },
              ExpressionAttributeValues: { ":one": { N: "1" } },
            }),
          ),
          table.layer,
        )
        expect(got).toBe(refused(DDB_UPDATE_MISSING_ATTRIBUTE))
        expect(table.read(key("none"))).toBeUndefined()
      }),
    )

    it.effect("SET below a missing map", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed(held())
        const got = yield* failureOf(
          withClient((client) =>
            client.updateItem({
              TableName: "t",
              Key: key("u"),
              UpdateExpression: "SET #z.#y = :v",
              ExpressionAttributeNames: { "#z": "z", "#y": "y" },
              ExpressionAttributeValues: { ":v": { S: "v" } },
            }),
          ),
          table.layer,
        )
        expect(got).toBe(refused(DDB_UPDATE_INVALID_PATH))
        expect(table.read(key("u"))).toEqual(held())
      }),
    )

    it.effect("a failed condition answers first", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed(held())
        const got = yield* failureOf(
          withClient((client) =>
            client.updateItem({
              TableName: "t",
              Key: key("u"),
              UpdateExpression: "SET #a = #a - :n",
              ConditionExpression: "attribute_exists(#zz)",
              ExpressionAttributeNames: { "#a": "a", "#zz": "zz" },
              ExpressionAttributeValues: { ":n": { N: "1" } },
            }),
          ),
          table.layer,
        )
        expect(got).toBe(
          "DynamoError: ConditionalCheckFailedException: The conditional request failed",
        )
      }),
    )

    it.effect("in a transaction: the whole request, ahead of another item's failed condition", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed(held())
        for (const order of [0, 1]) {
          const items = [
            {
              Put: {
                TableName: "t",
                Item: key("tp"),
                ConditionExpression: "attribute_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk" },
              },
            },
            {
              Update: {
                TableName: "t",
                Key: key("u"),
                UpdateExpression: "SET #a = #a - :n",
                ExpressionAttributeNames: { "#a": "a" },
                ExpressionAttributeValues: { ":n": { N: "1" } },
              },
            },
          ]
          const got = yield* failureOf(
            withClient((client) =>
              client.transactWriteItems({
                TransactItems: order === 0 ? items : [...items].reverse(),
              }),
            ),
            table.layer,
          )
          expect(got).toBe(refused(DDB_UPDATE_MISSING_ATTRIBUTE))
        }
        expect(table.read(key("tp"))).toBeUndefined()
        expect(table.read(key("u"))).toEqual(held())
      }),
    )

    it.effect("in a transaction: the update's own failed condition is a cancellation", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed(held())
        const got = yield* failureOf(
          withClient((client) =>
            client.transactWriteItems({
              TransactItems: [
                {
                  Update: {
                    TableName: "t",
                    Key: key("u"),
                    UpdateExpression: "SET #a = #a - :n",
                    ConditionExpression: "attribute_exists(#zz)",
                    ExpressionAttributeNames: { "#a": "a", "#zz": "zz" },
                    ExpressionAttributeValues: { ":n": { N: "1" } },
                  },
                },
              ],
            }),
          ),
          table.layer,
        )
        expect(got).toBe(
          "DynamoError: TransactionCanceledException: Transaction cancelled, please refer cancellation reasons for specific reasons [ConditionalCheckFailed]",
        )
      }),
    )

    it.effect("a transaction naming one item twice", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed(held())
        const got = yield* failureOf(
          withClient((client) =>
            client.transactWriteItems({
              TransactItems: [
                { Put: { TableName: "t", Item: { ...key("u"), n: { N: "1" } } } },
                {
                  ConditionCheck: {
                    TableName: "t",
                    Key: key("u"),
                    ConditionExpression: "attribute_exists(#pk)",
                    ExpressionAttributeNames: { "#pk": "pk" },
                  },
                },
              ],
            }),
          ),
          table.layer,
        )
        expect(got).toBe(refused(DDB_REPEATED_ITEM))
        expect(table.read(key("u"))).toEqual(held())
      }),
    )

    it.effect("a map condition with its keys in another order passes", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed({ ...key("u"), f: { M: { a: { S: "1" }, b: { S: "2" } } } })
        const got = yield* failureOf(
          withClient((client) =>
            client.updateItem({
              TableName: "t",
              Key: key("u"),
              UpdateExpression: "SET #n = :n",
              ConditionExpression: "#f = :f",
              ExpressionAttributeNames: { "#f": "f", "#n": "n" },
              ExpressionAttributeValues: {
                ":f": { M: { b: { S: "2" }, a: { S: "1" } } },
                ":n": { N: "1" },
              },
            }),
          ),
          table.layer,
        )
        expect(got).toBe("ok")
        expect(table.read(key("u"))?.n).toEqual({ N: "1" })
      }),
    )
  })
}

describe("recording table: a request naming one item twice is rejected", () => {
  const run = <A, E>(effect: (client: DynamoClientService) => Effect.Effect<A, E>) => {
    const table = makeRecordingTable()
    table.items.set("u|x", { ...key("u"), n: { N: "1" } })
    return failureOf(withClient(effect), table.layer).pipe(
      Effect.map((got) => ({ got, items: [...table.items.keys()] })),
    )
  }

  it.effect("BatchGetItem", () =>
    Effect.gen(function* () {
      expect(
        yield* run((client) =>
          client.batchGetItem({ RequestItems: { t: { Keys: [key("u"), key("u")] } } }),
        ),
      ).toEqual({ got: refused(DDB_REPEATED_BATCH_ITEM), items: ["u|x"] })
      // A key missing from the table too, and one named with its attributes in another order.
      expect(
        yield* run((client) =>
          client.batchGetItem({
            RequestItems: {
              t: { Keys: [key("zz"), { sk: { S: "x" }, pk: { S: "zz" } }] },
            },
          }),
        ),
      ).toEqual({ got: refused(DDB_REPEATED_BATCH_ITEM), items: ["u|x"] })
      expect(
        yield* run((client) =>
          client.batchGetItem({ RequestItems: { t: { Keys: [key("u"), key("v")] } } }),
        ),
      ).toEqual({ got: "ok", items: ["u|x"] })
    }),
  )

  it.effect("BatchWriteItem", () =>
    Effect.gen(function* () {
      expect(
        yield* run((client) =>
          client.batchWriteItem({
            RequestItems: {
              t: [{ PutRequest: { Item: key("w") } }, { DeleteRequest: { Key: key("w") } }],
            },
          }),
        ),
      ).toEqual({ got: refused(DDB_REPEATED_BATCH_ITEM), items: ["u|x"] })
    }),
  )

  it.effect("TransactGetItems", () =>
    Effect.gen(function* () {
      expect(
        yield* run((client) =>
          client.transactGetItems({
            TransactItems: [
              { Get: { TableName: "t", Key: key("u") } },
              { Get: { TableName: "t", Key: key("u") } },
            ],
          }),
        ),
      ).toEqual({ got: refused(DDB_REPEATED_ITEM), items: ["u|x"] })
    }),
  )

  it.effect("the library diagnoses it as it does DynamoDB Local's: both gets named", () =>
    Effect.gen(function* () {
      // As `connected.test.ts` (#26) on DynamoDB Local.
      const Docs = Entity.make({
        model: Schema.Struct({ docId: Schema.String }),
        entityType: "LimDoc",
        primaryKey: {
          pk: { field: "pk", composite: ["docId"] },
          sk: { field: "sk", composite: [] },
        },
      })
      const Main = Table.make({
        schema: DynamoSchema.make({ name: "lim", version: 1 }),
        entities: { Docs },
      })
      const table = makeRecordingTable()
      const error = yield* Batch.get([
        Docs.get({ docId: "bg-1" }),
        Docs.get({ docId: "bg-2" }),
        Docs.get({ docId: "bg-1" }),
      ]).pipe(Effect.flip, Effect.provide(Layer.merge(table.layer, Main.layer({ name: "t" }))))
      expect(error._tag).toBe("DynamoError")
      expect(String((error as { cause: unknown }).cause)).toContain(
        "BatchGetItem reads one item more than once — get 0 (LimDoc) and get 2 (LimDoc)",
      )
      const transactError = yield* Transaction.transactGet([
        Docs.get({ docId: "rep-3" }),
        Docs.get({ docId: "rep-3" }),
      ]).pipe(Effect.flip, Effect.provide(Layer.merge(table.layer, Main.layer({ name: "t" }))))
      expect(transactError._tag).toBe("DynamoError")
      expect(String((transactError as { cause: unknown }).cause)).toContain(
        "TransactGetItems reads one item more than once",
      )
    }),
  )
})
