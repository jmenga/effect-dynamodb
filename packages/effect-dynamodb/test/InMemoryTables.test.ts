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
 * - **A transaction's items are taken in order**, each on what the ones before it left: a failed
 *   condition is that item's cancellation reason (a `ConditionCheck`'s message ends in a full
 *   stop, a write's doesn't), an update the item can't take refuses the request, and a repeat is
 *   reported only when the repeated item's condition passes.
 * - **An item is named by its table and its typed key**, never by `<pk>|<sk>` text: one key in two
 *   tables is two items, and keys whose text would join to the same text are two keys (which the
 *   tables, keeping items under that text, name as a defect). A binary key is refused as DynamoDB
 *   Local refuses it on a table of string keys.
 * - **A condition refuses an operand `<` can't order** (a map, list, set, boolean or null) and an
 *   attribute compared with itself, with DynamoDB Local's message, reads list-index paths, and
 *   finds two missing attributes unequal. Before, it answered false, threw a `TypeError`, and
 *   answered false.
 * - **Whitespace is optional**: `SET #a=:v` sets `a`, alone and in a transaction.
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
import { encodeKeyCursor } from "../src/internal/Cursor.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { keyIdentity, query, UnreadableRequest } from "./helpers/DynamoExpressions.js"
import {
  holds,
  InMemoryClient,
  keyOf,
  resetStore,
  sameValue,
  store,
  tableIndexes,
} from "./helpers/InMemoryTables.js"
import {
  DDB_REPEATED_BATCH_ITEM,
  DDB_REPEATED_ITEM,
  DDB_UPDATE_INVALID_PATH,
  DDB_UPDATE_MISSING_ATTRIBUTE,
  mockDynamoClient,
} from "./helpers/MockDynamoClient.js"
import { keyText, makeRecordingTable } from "./helpers/RecordingTable.js"

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

/**
 * The rows below are rows of `connected.helper-conformance.test.ts`, which sends each to DynamoDB
 * Local and to both tables: the answers here are DynamoDB Local's.
 */
describe("a condition reads list paths, and refuses what DynamoDB Local refuses", () => {
  const item: Item = {
    pk: { S: "p" },
    sk: { S: "s" },
    n: { N: "5" },
    m: { M: { k: { N: "1" }, l: { L: [{ N: "1" }, { N: "2" }] } } },
    l: { L: [{ N: "1" }, { N: "2" }, { M: { a: { N: "1" } } }] },
    ss: { SS: ["a", "b"] },
    nul: { NULL: true },
    bool: { BOOL: true },
  }
  const namesOf = (expression: string) =>
    Object.fromEntries(
      [...expression.matchAll(/#(\w+)/g)].map((match) => [`#${match[1]}`, match[1]!]),
    )
  const answer = (expression: string, values: Record<string, AttributeValue> = {}) => {
    try {
      return holds(expression, item, namesOf(expression), values)
    } catch (error) {
      return { name: (error as Error).name, message: (error as Error).message }
    }
  }

  for (const [expression, values] of [
    ["#l[0] = :v", { ":v": { N: "1" } }],
    ["#m.#l[1] = :v", { ":v": { N: "2" } }],
    ["attribute_not_exists(#l[5])", {}],
    ["attribute_exists(#l[0])", {}],
    ["#zz <> #qq", {}],
  ] as const) {
    it(`${expression}: holds`, () => {
      expect(answer(expression, values)).toBe(true)
    })
  }

  const operandType = (operator: string, type: string) => ({
    name: "ValidationException",
    message: `Invalid ConditionExpression: Incorrect operand type for operator or function; operator or function: ${operator}, operand type: ${type}`,
  })
  const distinct = (operator: string, name: string) => ({
    name: "ValidationException",
    message: `Invalid ConditionExpression: The first operand must be distinct from the remaining operands for this operator or function; operator: ${operator}, first operand: [${name}]`,
  })
  for (const [expression, values, refusal] of [
    // Only numbers, strings and bytes are ordered: any other operand is refused.
    ["#m < :v", { ":v": { M: {} } }, operandType("<", "M")],
    ["#l < :v", { ":v": { L: [] } }, operandType("<", "L")],
    ["#ss < :v", { ":v": { SS: ["z"] } }, operandType("<", "SS")],
    ["#bool < :v", { ":v": { BOOL: true } }, operandType("<", "BOOL")],
    ["#nul <= :v", { ":v": { NULL: true } }, operandType("<=", "NULL")],
    ["#n < :v", { ":v": { M: {} } }, operandType("<", "M")],
    ["#n < :v", { ":v": { BOOL: true } }, operandType("<", "BOOL")],
    // An attribute compared with itself.
    ["#m <= #m", {}, distinct("<=", "m")],
    ["#n < #n", {}, distinct("<", "n")],
    ["#n <> #n", {}, distinct("<>", "n")],
  ] satisfies ReadonlyArray<
    readonly [string, Record<string, AttributeValue>, { name: string; message: string }]
  >) {
    it(`${expression} ${JSON.stringify(values)}: refused`, () => {
      expect(answer(expression, values)).toEqual(refusal)
    })
  }

  it("between values of different types, `<` fails: numbers, strings and bytes", () => {
    expect(answer("#n < :v", { ":v": { S: "9" } })).toBe(false)
  })
})

/** The failure a request ends in, with its cancellation reasons. */
const outcomeOf = <A, E>(
  effect: Effect.Effect<A, E, DynamoClient>,
  layer: Layer.Layer<DynamoClient>,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(Effect.provide(effect, layer))
    if (Exit.isSuccess(exit)) return { ok: exit.value as unknown }
    const error = Cause.squash(exit.cause) as {
      readonly cause?: {
        readonly name?: string
        readonly message?: string
        readonly CancellationReasons?: ReadonlyArray<unknown>
      }
    }
    return {
      name: error.cause?.name,
      message: error.cause?.message,
      ...(error.cause?.CancellationReasons !== undefined && {
        reasons: error.cause.CancellationReasons,
      }),
    }
  })

const cancelledWith = (...reasons: ReadonlyArray<"None" | "Put" | "ConditionCheck">) => ({
  name: "TransactionCanceledException",
  message: `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons
    .map((reason) => (reason === "None" ? "None" : "ConditionalCheckFailed"))
    .join(", ")}]`,
  // A `ConditionCheck`'s reason ends in a full stop; a write's doesn't.
  reasons: reasons.map((reason) =>
    reason === "None"
      ? { Code: "None" }
      : {
          Code: "ConditionalCheckFailed",
          Message: `The conditional request failed${reason === "ConditionCheck" ? "." : ""}`,
        },
  ),
})

for (const [name, make] of Object.entries(TABLES)) {
  describe(`${name}: a transaction's items are taken in order, each on what the ones before left`, () => {
    const stored = (): Item => ({ ...key("a"), n: { N: "1" } })
    const put = (n: string, condition?: string): Record<string, unknown> => ({
      Put: {
        TableName: "t",
        Item: { ...key("a"), n: { N: n } },
        ...(condition !== undefined && {
          ConditionExpression: condition,
          ExpressionAttributeNames: { "#n": "n" },
          ExpressionAttributeValues: { ":v": { N: "2" } },
        }),
      },
    })
    const check = (expression: string, value?: string): Record<string, unknown> => ({
      ConditionCheck: {
        TableName: "t",
        Key: key("a"),
        ConditionExpression: expression,
        ExpressionAttributeNames: Object.fromEntries(
          [...expression.matchAll(/#(\w+)/g)].map((match) => [`#${match[1]}`, match[1]!]),
        ),
        ...(value !== undefined && { ExpressionAttributeValues: { ":v": { N: value } } }),
      },
    })
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<Record<string, unknown>>, object]> =
      [
        [
          "Put (its condition fails) + Put",
          [put("5", "#n = :v"), put("6")],
          cancelledWith("Put", "None"),
        ],
        [
          "Put + ConditionCheck failing on what the Put wrote",
          [put("5"), check("#n = :v", "1")],
          cancelledWith("None", "ConditionCheck"),
        ],
        [
          "ConditionCheck (fails) + Put",
          [check("#n = :v", "2"), put("5")],
          cancelledWith("ConditionCheck", "None"),
        ],
        [
          "ConditionCheck (fails) + ConditionCheck (fails)",
          [check("#n = :v", "2"), check("#n = :v", "3")],
          cancelledWith("ConditionCheck", "ConditionCheck"),
        ],
        [
          "Update (refused) + ConditionCheck (passes): the refusal",
          [
            {
              Update: {
                TableName: "t",
                Key: key("a"),
                UpdateExpression: "SET #x = #zz + :v",
                ExpressionAttributeNames: { "#x": "x", "#zz": "zz" },
                ExpressionAttributeValues: { ":v": { N: "1" } },
              },
            },
            check("attribute_exists(#pk)"),
          ],
          { name: "ValidationException", message: DDB_UPDATE_MISSING_ATTRIBUTE },
        ],
        [
          "Put + ConditionCheck passing only on what the Put wrote: the repeat",
          [put("5"), check("#n = :v", "5")],
          { name: "ValidationException", message: DDB_REPEATED_ITEM },
        ],
      ]
    for (const [label, items, expected] of cases) {
      it.effect(label, () =>
        Effect.gen(function* () {
          const table = make()
          table.seed(stored())
          const got = yield* outcomeOf(
            withClient((client) => client.transactWriteItems({ TransactItems: items as never })),
            table.layer,
          )
          expect(got).toEqual(expected)
          expect(table.read(key("a"))).toEqual(stored())
        }),
      )
    }
  })

  describe(`${name}: compact expressions`, () => {
    // Whitespace around `=` is optional, as on DynamoDB Local.
    it.effect("SET #a=:v, alone and in a transaction", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed({ ...key("u"), a: { S: "old" }, version: { N: "1" } })
        const update = {
          TableName: "t",
          Key: key("u"),
          UpdateExpression: "SET #a=:v",
          ExpressionAttributeNames: { "#a": "a" },
          ExpressionAttributeValues: { ":v": { S: "new" } },
        }
        expect(
          yield* failureOf(
            withClient((client) => client.updateItem(update)),
            table.layer,
          ),
        ).toBe("ok")
        expect(table.read(key("u"))).toEqual({ ...key("u"), a: { S: "new" }, version: { N: "1" } })
        expect(
          yield* failureOf(
            withClient((client) =>
              client.transactWriteItems({
                TransactItems: [
                  {
                    Update: { ...update, ExpressionAttributeValues: { ":v": { S: "newer" } } },
                  },
                ],
              }),
            ),
            table.layer,
          ),
        ).toBe("ok")
        expect(table.read(key("u"))).toEqual({
          ...key("u"),
          a: { S: "newer" },
          version: { N: "1" },
        })
      }),
    )
  })

  describe(`${name}: a list of 150,000 elements`, () => {
    // The nesting check reads a list of any length: spreading its elements into one call exhausted
    // the stack (a RangeError) on updates DynamoDB Local takes.
    const LENGTH = 150_000
    const long = (n: string): AttributeValue => ({
      L: Array.from({ length: LENGTH }, () => ({ N: n })),
    })
    it.effect("an update appending to one, and a transaction setting one", () =>
      Effect.gen(function* () {
        const table = make()
        table.seed({ ...key("big"), l: long("1") })
        expect(
          yield* failureOf(
            withClient((client) =>
              client.updateItem({
                TableName: "t",
                Key: key("big"),
                UpdateExpression: "SET #l = list_append(#l, :v)",
                ExpressionAttributeNames: { "#l": "l" },
                ExpressionAttributeValues: { ":v": { L: [{ N: "2" }] } },
              }),
            ),
            table.layer,
          ),
        ).toBe("ok")
        const appended = table.read(key("big"))!.l!.L!
        expect([appended.length, appended[LENGTH]]).toEqual([LENGTH + 1, { N: "2" }])
        expect(
          yield* failureOf(
            withClient((client) =>
              client.transactWriteItems({
                TransactItems: [
                  {
                    Update: {
                      TableName: "t",
                      Key: key("big"),
                      UpdateExpression: "SET #l = :l",
                      ExpressionAttributeNames: { "#l": "l" },
                      ExpressionAttributeValues: { ":l": long("3") },
                    },
                  },
                ],
              }),
            ),
            table.layer,
          ),
        ).toBe("ok")
        const set = table.read(key("big"))!.l!.L!
        expect([set.length, set[0], set[LENGTH - 1]]).toEqual([LENGTH, { N: "3" }, { N: "3" }])
      }),
    )
  })
}

describe("an item is named by its table and its typed key", () => {
  const identity = (table: string, key: Item) => keyIdentity(table, key, ["pk", "sk"])

  it("keys whose text would join to the same text are two keys", () => {
    expect(identity("t", { pk: { S: "a|b" }, sk: { S: "c" } })).not.toBe(
      identity("t", { pk: { S: "a" }, sk: { S: "b|c" } }),
    )
  })

  it("one key in two tables is two items; its attributes in another order, one", () => {
    expect(identity("t", key("u"))).not.toBe(identity("t2", key("u")))
    expect(identity("t", { sk: { S: "x" }, pk: { S: "u" } })).toBe(identity("t", key("u")))
  })

  it("a key that isn't a string is a defect: these tables take string keys only", () => {
    expect(() => identity("t", { pk: { S: "a" }, sk: { B: new Uint8Array([1]) } })).toThrow(
      UnreadableRequest,
    )
  })

  const binary = (byte: number): Item => ({ pk: { S: "a" }, sk: { B: new Uint8Array([byte]) } })
  const typeMismatch = "One or more parameter values were invalid: Type mismatch for key"

  it.effect("recording table: binary sort keys are refused as DynamoDB Local refuses them", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      expect(
        yield* outcomeOf(
          withClient((client) =>
            client.batchGetItem({ RequestItems: { t: { Keys: [binary(1), binary(2)] } } }),
          ),
          table.layer,
        ),
      ).toEqual({ name: "ValidationException", message: typeMismatch })
      expect(
        yield* outcomeOf(
          withClient((client) =>
            client.transactGetItems({
              TransactItems: [
                { Get: { TableName: "t", Key: binary(1) } },
                { Get: { TableName: "t", Key: binary(2) } },
              ],
            }),
          ),
          table.layer,
        ),
      ).toEqual({ name: "TransactionCanceledException", message: typeMismatch })
    }),
  )

  it.effect("recording table: one key read from two tables is two reads", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      expect(
        yield* outcomeOf(
          withClient((client) =>
            client.transactGetItems({
              TransactItems: [
                { Get: { TableName: "t", Key: key("u") } },
                { Get: { TableName: "t2", Key: key("u") } },
              ],
            }),
          ),
          table.layer,
        ),
      ).toEqual({ ok: { Responses: [{}, {}] } })
      expect(
        yield* outcomeOf(
          withClient((client) =>
            client.batchGetItem({
              RequestItems: { t: { Keys: [key("u")] }, t2: { Keys: [key("u")] } },
            }),
          ),
          table.layer,
        ),
      ).toEqual({ ok: { Responses: { t: [], t2: [] }, UnprocessedKeys: {} } })
    }),
  )

  it.effect("InMemoryClient: one key written in two tables is two items", () =>
    Effect.gen(function* () {
      resetStore()
      expect(
        yield* outcomeOf(
          withClient((client) =>
            client.transactWriteItems({
              TransactItems: [
                { Put: { TableName: "t", Item: { ...key("u"), n: { N: "5" } } } },
                { Put: { TableName: "t2", Item: { ...key("u"), n: { N: "6" } } } },
              ],
            }),
          ),
          InMemoryClient,
        ),
      ).toEqual({ ok: {} })
      expect(store.get(keyOf("t", key("u")))?.n).toEqual({ N: "5" })
      expect(store.get(keyOf("t2", key("u")))?.n).toEqual({ N: "6" })
    }),
  )

  const joined: ReadonlyArray<Item> = [
    { pk: { S: "a|b" }, sk: { S: "c" }, n: { N: "1" } },
    { pk: { S: "a" }, sk: { S: "b|c" }, n: { N: "2" } },
    { pk: { S: "a\\" }, sk: { S: "|b|c" }, n: { N: "3" } },
  ]
  const keysOnly = (item: Item) => ({ pk: item.pk!, sk: item.sk! })

  it.effect("keys whose text joins alike are items like any other, in both tables", () =>
    Effect.gen(function* () {
      const recording = makeRecordingTable()
      const write = withClient((client) =>
        client.transactWriteItems({
          TransactItems: joined.map((item) => ({ Put: { TableName: "t", Item: item } })),
        }),
      )
      const read = withClient((client) =>
        client.batchGetItem({ RequestItems: { t: { Keys: joined.map(keysOnly) } } }),
      )
      expect(yield* outcomeOf(write, recording.layer)).toEqual({ ok: {} })
      const got = (yield* outcomeOf(read, recording.layer)) as {
        readonly ok: { readonly Responses: { readonly t: ReadonlyArray<Item> } }
      }
      expect(got.ok.Responses.t).toEqual(joined)
      expect(recording.items.get(keyText("a|b", "c"))).toEqual(joined[0])
      expect(recording.items.get(keyText("a\\", "|b|c"))).toEqual(joined[2])
      expect([...recording.items.keys()]).toEqual(
        joined.map((item) => keyText(item.pk!.S!, item.sk!.S!)),
      )

      resetStore()
      expect(yield* outcomeOf(write, InMemoryClient)).toEqual({ ok: {} })
      expect(joined.map((item) => store.get(keyOf("t", item)))).toEqual(joined)
      expect(store.size).toBe(3)
    }),
  )

  it.effect(
    "recording table: one key in two tables is two items, and items names neither alone",
    () =>
      Effect.gen(function* () {
        const recording = makeRecordingTable()
        const write = withClient((client) =>
          client.transactWriteItems({
            TransactItems: [
              { Put: { TableName: "one", Item: { ...key("a"), n: { N: "1" } } } },
              { Put: { TableName: "two", Item: { ...key("a"), n: { N: "2" } } } },
            ],
          }),
        )
        expect(yield* outcomeOf(write, recording.layer)).toEqual({ ok: {} })
        for (const [table, n] of [
          ["one", "1"],
          ["two", "2"],
        ] as const) {
          const got = yield* outcomeOf(
            withClient((client) => client.getItem({ TableName: table, Key: key("a") })),
            recording.layer,
          )
          expect(got).toEqual({ ok: { Item: { ...key("a"), n: { N: n } } } })
        }
        expect(recording.items.size).toBe(2)
        expect(recording.items.has(keyText("a", "x"))).toBe(true)
        expect(() => recording.items.get(keyText("a", "x"))).toThrow(UnreadableRequest)
        expect(() => recording.items.delete(keyText("a", "x"))).toThrow(UnreadableRequest)
        recording.seed("three", { ...key("b"), n: { N: "3" } })
        expect(recording.items.get(keyText("b", "x"))).toEqual({ ...key("b"), n: { N: "3" } })
        const elsewhere = yield* outcomeOf(
          withClient((client) => client.getItem({ TableName: "one", Key: key("b") })),
          recording.layer,
        )
        expect(elsewhere).toEqual({ ok: {} })
      }),
  )

  it.effect("a transaction one of whose items this doesn't read writes nothing", () =>
    Effect.gen(function* () {
      const transaction = withClient((client) =>
        client.transactWriteItems({
          TransactItems: [
            { Put: { TableName: "t", Item: { ...key("a"), n: { N: "1" } } } },
            { Put: { TableName: "t", Item: key("b"), Unmodelled: true } as never },
          ],
        }),
      )
      const recording = makeRecordingTable()
      const exit = yield* Effect.exit(Effect.provide(transaction, recording.layer))
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(UnreadableRequest)
      expect(recording.items.size).toBe(0)
      resetStore()
      const inMemory = yield* Effect.exit(Effect.provide(transaction, InMemoryClient))
      expect(Exit.isFailure(inMemory) && Cause.squash(inMemory.cause)).toBeInstanceOf(
        UnreadableRequest,
      )
      expect(store.size).toBe(0)
    }),
  )
})

describe("rows of one index key: a read is refused only when its own page depends on their order", () => {
  const S = (value: string): AttributeValue => ({ S: value })
  const TABLE = { pk: "pk", sk: "sk" }
  const INDEXES = { lsi: { pk: "pk", sk: "lsk" }, gsi: { pk: "gpk", sk: "gsk" } }
  type Where = "table" | "lsi" | "gsi"
  /** Row `i` holds `values[i]` as its index sort keys, and a table sort key in the same order. */
  const rowsOf = (values: ReadonlyArray<string>): ReadonlyArray<Item> =>
    values.map((value, i) => ({
      pk: S("p"),
      sk: S(`${value}${i}`),
      lsk: S(value),
      gpk: S("g"),
      gsk: S(value),
    }))
  const keyOn = (where: Where, row: Item): Item => ({
    pk: row.pk!,
    sk: row.sk!,
    ...(where === "lsi" && { lsk: row.lsk! }),
    ...(where === "gsi" && { gpk: row.gpk!, gsk: row.gsk! }),
  })
  const requestOn = (where: Where, start: Item | undefined, extra: object) => ({
    TableName: "t",
    ...(where !== "table" && { IndexName: where }),
    KeyConditionExpression: "#p = :p",
    ExpressionAttributeNames: { "#p": where === "gsi" ? "gpk" : "pk" },
    ExpressionAttributeValues: { ":p": S(where === "gsi" ? "g" : "p") },
    ...(start !== undefined && { ExclusiveStartKey: keyOn(where, start) }),
    ...extra,
  })
  const Limit = (limit: number) => ({ Limit: limit })
  const reverse = (extra: object = {}) => ({ ScanIndexForward: false, ...extra })
  /** The rows returned (by position in `values`), or which refusal. */
  type Expected = ReadonlyArray<number> | "the Limit" | "the ExclusiveStartKey"
  const CASES: ReadonlyArray<
    readonly [
      label: string,
      values: ReadonlyArray<string>,
      start: number,
      extra: object,
      table: ReadonlyArray<number>,
      index: Expected,
    ]
  > = [
    ["ties before the start key", ["1", "1", "2", "3"], 2, Limit(1), [3], [3]],
    ["ties before the start key, no Limit", ["1", "1", "2", "3"], 2, {}, [3], [3]],
    ["a Limit before the ties", ["1", "2", "3", "3", "4"], 0, Limit(1), [1], [1]],
    [
      "a Limit between ties past the start key",
      ["1", "2", "3", "3", "4"],
      1,
      Limit(1),
      [2],
      "the Limit",
    ],
    ["a Limit on the last of ties", ["1", "2", "3", "3", "4"], 1, Limit(2), [2, 3], "the Limit"],
    [
      "a Limit on the last of ties, the last rows",
      ["1", "2", "3", "3"],
      1,
      Limit(2),
      [2, 3],
      "the Limit",
    ],
    ["a Limit past the ties", ["1", "2", "3", "3", "4"], 1, Limit(3), [2, 3, 4], [2, 3, 4]],
    ["ties past the start key, no Limit", ["1", "2", "3", "3"], 1, {}, [2, 3], [2, 3]],
    ["the start key among ties", ["1", "2", "2", "3"], 1, Limit(1), [2], "the ExclusiveStartKey"],
    [
      "reverse, ties before the start key",
      ["1", "2", "3", "3", "4"],
      1,
      reverse(Limit(1)),
      [0],
      [0],
    ],
    [
      "reverse, a Limit between ties past the start key",
      ["1", "1", "2", "3"],
      2,
      reverse(Limit(1)),
      [1],
      "the Limit",
    ],
    [
      "reverse, a Limit on the last of ties",
      ["1", "1", "2", "3"],
      2,
      reverse(Limit(2)),
      [1, 0],
      "the Limit",
    ],
    [
      "reverse, a Limit past the ties",
      ["1", "2", "3", "3", "4"],
      4,
      reverse(Limit(3)),
      [3, 2, 1],
      [3, 2, 1],
    ],
    [
      "reverse, the start key among ties",
      ["1", "2", "2", "3"],
      2,
      reverse(),
      [1, 0],
      "the ExclusiveStartKey",
    ],
  ]
  for (const where of ["table", "lsi", "gsi"] as const) {
    for (const [label, values, startAt, extra, onTable, onIndex] of CASES) {
      const expected = where === "table" ? onTable : onIndex
      it(`${where}: ${label}: ${typeof expected === "string" ? `refused, naming ${expected}` : `rows ${expected.join(", ")}`}`, () => {
        const rows = rowsOf(values)
        const read = () =>
          query(requestOn(where, rows[startAt], extra) as never, rows, TABLE, INDEXES)
        if (typeof expected === "string") {
          const attribute = where === "lsi" ? "lsk" : "gsk"
          expect(read).toThrow(UnreadableRequest)
          expect(read).toThrow(
            `The in-memory table doesn't read ${expected} ${
              expected === "the Limit"
                ? JSON.stringify(String((extra as { Limit: number }).Limit))
                : ""
            }`.trimEnd(),
          )
          expect(read).toThrow(
            `${expected === "the Limit" ? "stopping among" : "among"} rows of one ${attribute} (DynamoDB Local's order among them is not modelled)`,
          )
        } else {
          expect(read().Items).toEqual(expected.map((i) => rows[i]))
        }
      })
    }
  }

  // The same reads through the library's query and cursor, on both tables.
  const PUBLIC: ReadonlyArray<
    readonly [
      label: string,
      values: ReadonlyArray<string>,
      start: number,
      reversed: boolean,
      expected: Expected,
    ]
  > = [
    ["a Limit between ties past the start key", ["1", "2", "3", "3", "4"], 1, false, "the Limit"],
    ["ties before the start key", ["1", "1", "2", "3"], 2, false, [3]],
    ["reverse, ties before the start key", ["1", "2", "3", "3", "4"], 1, true, [0]],
    [
      "reverse, a Limit between ties past the start key",
      ["1", "1", "2", "3"],
      2,
      true,
      "the Limit",
    ],
  ]
  const onTables = {
    "recording table": () => makeRecordingTable({ indexes: { gsi: INDEXES.gsi } }).layer,
    InMemoryClient: () => {
      resetStore()
      tableIndexes.set("t", { gsi: INDEXES.gsi })
      return InMemoryClient
    },
  }
  for (const [name, layerOf] of Object.entries(onTables)) {
    for (const [label, values, startAt, reversed, expected] of PUBLIC) {
      it.effect(`${name}: Query.startFrom, gsi, Limit 1: ${label}`, () =>
        Effect.gen(function* () {
          const rows = rowsOf(values)
          const layer = layerOf()
          const read = Effect.gen(function* () {
            const client = yield* DynamoClient
            for (const item of rows) yield* client.putItem({ TableName: "t", Item: item })
            const base = Query.make({
              tableName: "t",
              indexName: "gsi",
              pkField: "gpk",
              pkValue: "g",
              skField: "gsk",
              entityTypes: [],
              decoder: (row) => Effect.succeed(row),
            })
            const ordered = reversed ? Query.reverse(base) : base
            return yield* Query.execute(
              Query.startFrom(
                Query.limit(ordered, 1),
                encodeKeyCursor(keyOn("gsi", rows[startAt]!)),
              ),
            )
          })
          const exit = yield* Effect.exit(Effect.provide(read, layer)).pipe(
            Effect.ensuring(Effect.sync(() => tableIndexes.delete("t"))),
          )
          if (typeof expected === "string") {
            expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(
              UnreadableRequest,
            )
            expect(String(Exit.isFailure(exit) && Cause.squash(exit.cause))).toContain(
              `doesn't read the Limit "1": stopping among rows of one gsk`,
            )
          } else {
            // As the library reads them: unmarshalled.
            expect(Exit.isSuccess(exit) && exit.value.items.map((row) => row.sk)).toEqual(
              expected.map((i) => rows[i]!.sk!.S),
            )
          }
        }),
      )
    }
  }
})

describe("what the tables don't model fails by name", () => {
  for (const [name, table] of Object.entries(TABLES)) {
    it.effect(
      `${name}: a transaction's ClientRequestToken is refused, and nothing is written`,
      () =>
        Effect.gen(function* () {
          const { layer, seed, read } = table()
          seed({ ...key("counter"), n: { N: "0" } })
          const exit = yield* Effect.exit(
            Effect.provide(
              withClient((client) =>
                client.transactWriteItems({
                  ClientRequestToken: "token",
                  TransactItems: [
                    {
                      Update: {
                        TableName: "t",
                        Key: key("counter"),
                        UpdateExpression: "ADD #n :one",
                        ExpressionAttributeNames: { "#n": "n" },
                        ExpressionAttributeValues: { ":one": { N: "1" } },
                      },
                    },
                  ],
                }),
              ),
              layer,
            ),
          )
          const defect = Exit.isFailure(exit) && Cause.squash(exit.cause)
          expect(defect).toBeInstanceOf(UnreadableRequest)
          expect(String(defect)).toContain(
            `doesn't read the ClientRequestToken "token": not modelled (DynamoDB Local answers a committed transaction resent with its token with success, writing nothing`,
          )
          expect(read(key("counter"))).toEqual({ ...key("counter"), n: { N: "0" } })
        }),
    )
  }

  /** The client operations each table answers; every other one dies naming it. */
  const MODELLED: Record<keyof typeof TABLES, readonly [string, ReadonlyArray<string>]> = {
    "recording table": [
      "modelled by the recording table",
      [
        "getItem",
        "putItem",
        "updateItem",
        "deleteItem",
        "query",
        "scan",
        "batchGetItem",
        "batchWriteItem",
        "transactGetItems",
        "transactWriteItems",
      ],
    ],
    InMemoryClient: [
      "modelled by the in-memory tables (InMemoryClient)",
      ["getItem", "putItem", "updateItem", "deleteItem", "query", "transactWriteItems"],
    ],
  }
  const OPERATIONS = Object.keys(mockDynamoClient())
  for (const [name, table] of Object.entries(TABLES)) {
    const [by, modelled] = MODELLED[name as keyof typeof TABLES]
    it.effect(
      `${name}: every operation of the client it doesn't answer dies naming the operation`,
      () =>
        Effect.gen(function* () {
          expect(modelled.filter((operation) => !OPERATIONS.includes(operation))).toEqual([])
          const client = yield* Effect.provide(
            withClient((client) => Effect.succeed(client)),
            table().layer,
          )
          const others = OPERATIONS.filter((operation) => !modelled.includes(operation))
          expect(others.length).toBeGreaterThan(0)
          for (const operation of others) {
            const call = client[operation as keyof DynamoClientService] as unknown as (
              input: unknown,
            ) => Effect.Effect<unknown, unknown>
            const exit = yield* Effect.exit(call({}))
            expect(
              Exit.isFailure(exit) && Cause.hasDies(exit.cause) && Cause.squash(exit.cause),
            ).toBe(`DynamoClient.${operation} is not ${by}`)
          }
        }),
    )
  }
})
