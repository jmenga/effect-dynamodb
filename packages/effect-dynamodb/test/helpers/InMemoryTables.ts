/**
 * An in-memory DynamoDB for projection and time-series unit tests: GetItem, PutItem, UpdateItem,
 * DeleteItem, Query and TransactWriteItems, over any number of tables, answered as DynamoDB Local
 * answers them (`DynamoExpressions`): expressions read and evaluated, requests checked, a
 * transaction's items taken in order. A request DynamoDB refuses fails with DynamoDB Local's
 * `ValidationException`, as the library's client reports it (`DynamoValidationError`); a failed
 * condition with `ConditionalCheckFailedException`; a request this doesn't read is a defect naming
 * it, found before anything is written. A transaction is checked whole, then written whole.
 * `connected.helper-conformance.test.ts` compares the answers with DynamoDB Local's; what it
 * doesn't model is listed at the top of `DynamoExpressions.ts`.
 *
 * Each table's keys are `pk` / `sk` (`S`) unless `tableKeys` says otherwise; a Query of a
 * secondary index needs the index's keys in `tableIndexes`.
 */

import type {
  AttributeValue,
  GetItemCommandInput,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import { classifyError } from "../../src/DynamoClient.js"
import {
  answering,
  deleteItem,
  getItem,
  type IndexSchema,
  type KeySchema,
  putItem,
  query,
  type Tables,
  transactWrite,
  UnreadableRequest,
  updateItem,
  type WriteOutcome,
} from "./DynamoExpressions.js"
import { mockDynamoClientLayer } from "./MockDynamoClient.js"

export { holds, sameValue } from "./DynamoExpressions.js"

export type Item = Record<string, AttributeValue>

/** Every stored item, keyed `<table>|<pk>|<sk>` ({@link keyOf}). */
export const store = new Map<string, Item>()
export const calls = {
  query: 0,
  getItem: 0,
  putItem: 0,
  transactWriteItems: 0,
  updateItem: 0,
  deleteItem: 0,
}
/** Every query's expression values, for asserting the range read. */
export const queried: Array<Record<string, AttributeValue>> = []
/** Every `GetItem` and `TransactWriteItems` input, for asserting request shapes. */
export const sent = {
  getItem: [] as Array<GetItemCommandInput>,
  transactWriteItems: [] as Array<TransactWriteItemsCommandInput>,
}
/** Hooks run once after the next `getItem` — a concurrent writer between read and write. */
export const hooks = { afterGet: [] as Array<(table: string) => void> }
/** Fail every conditional write, as if another writer always won. */
export const rejection = { all: false, next: 0 }
/**
 * Cancel the next `next` transactions for a `TransactionConflict` — another
 * transaction in flight on the item, as real DynamoDB reports it and DynamoDB
 * Local never does — writing nothing.
 */
export const contention = { next: 0 }

export const resetStore = () => {
  store.clear()
  resetCalls()
  hooks.afterGet = []
  rejection.all = false
  rejection.next = 0
  contention.next = 0
}

export const resetCalls = () => {
  queried.length = 0
  sent.getItem.length = 0
  sent.transactWriteItems.length = 0
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0
}

/** Key attribute names per table (default `pk` / `sk`). */
export const tableKeys = new Map<string, KeySchema>()
/** Secondary indexes' key attribute names, per table, for queries of an index. */
export const tableIndexes = new Map<string, Readonly<Record<string, IndexSchema>>>()
const keysOf = (table: string): KeySchema => tableKeys.get(table) ?? { pk: "pk", sk: "sk" }

const escapePart = (text: string) => text.replace(/[\\|]/g, (c) => `\\${c}`)

/**
 * The store key of a table's item (or key): `<table>|<pk>|<sk>`, with a `\` or `|` inside any part
 * escaped (`\\`, `\|`), so one text names one table's key; parts of neither character read as
 * written. Every key a request names is a non-empty `S` of the table's key attributes
 * (`checkKey`); an item a test stores must hold them too.
 */
export const keyOf = (table: string, item: Item) => {
  const k = keysOf(table)
  const parts = [item[k.pk]?.S, item[k.sk]?.S]
  if (parts.some((part) => part === undefined)) {
    throw new UnreadableRequest(
      `InMemoryTables: ${JSON.stringify([item[k.pk], item[k.sk]])} is not a key of ${table}, whose keys are text`,
    )
  }
  return [table, ...parts].map((part) => escapePart(part!)).join("|")
}

/** The rows `table` holds: those whose store key starts with its name. */
const rowsOf = (table: string) => {
  const prefix = `${escapePart(table)}|`
  return [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([, item]) => item)
}

const tables: Tables = {
  schema: keysOf,
  read: (table, key) => store.get(keyOf(table, key)),
}

/** A refusal as the library's client reports it. */
const failure = (operation: string) => (error: Error) =>
  Effect.fail(classifyError(operation)(error))

/** Rejections asked for by `rejection`: the next conditional write fails, or all of them do. */
const failCondition = () => {
  if (rejection.all) return true
  if (rejection.next > 0) {
    rejection.next--
    return true
  }
  return false
}

const write = (
  operation: string,
  table: string,
  key: Item,
  outcome: WriteOutcome,
): Effect.Effect<{ readonly Attributes?: Item }, unknown> => {
  if (outcome._tag === "ConditionFailed") {
    return Effect.fail(classifyError(operation)(outcome.error))
  }
  if (outcome.item === undefined) store.delete(keyOf(table, key))
  else store.set(keyOf(table, key), outcome.item)
  return Effect.succeed(outcome.output)
}

export const InMemoryClient = mockDynamoClientLayer({
  query: (input) =>
    Effect.suspend(() => {
      calls.query++
      queried.push(input.ExpressionAttributeValues ?? {})
      const table = input.TableName!
      const index =
        input.IndexName === undefined
          ? undefined
          : (tableIndexes.get(table)?.[input.IndexName] ??
            (() => {
              throw new UnreadableRequest(
                `InMemoryTables: a query of index ${input.IndexName} of ${table} needs its keys in tableIndexes`,
              )
            })())
      const rows = rowsOf(table)
      return answering(
        () => Effect.succeed(query(input as never, rows, keysOf(table), index) as never),
        failure("Query"),
      )
    }),
  getItem: (input) =>
    Effect.suspend(() => {
      calls.getItem++
      sent.getItem.push(input)
      const table = input.TableName!
      return answering(() => {
        const output = getItem(input as never, (key) => store.get(keyOf(table, key)), keysOf(table))
        const run = hooks.afterGet
        hooks.afterGet = []
        for (const hook of run) hook(table)
        return Effect.succeed(output as never)
      }, failure("GetItem"))
    }),
  putItem: (input) =>
    Effect.suspend(() => {
      calls.putItem++
      const table = input.TableName!
      return answering(() => {
        const outcome = putItem(
          input as never,
          (key) => store.get(keyOf(table, key)),
          keysOf(table),
          {
            failCondition,
          },
        )
        return write("PutItem", table, input.Item!, outcome) as never
      }, failure("PutItem"))
    }),
  updateItem: (input) =>
    Effect.suspend(() => {
      calls.updateItem++
      const table = input.TableName!
      return answering(() => {
        const outcome = updateItem(
          input as never,
          (key) => store.get(keyOf(table, key)),
          keysOf(table),
          { failCondition },
        )
        return write("UpdateItem", table, input.Key!, outcome) as never
      }, failure("UpdateItem"))
    }),
  deleteItem: (input) =>
    Effect.suspend(() => {
      calls.deleteItem++
      const table = input.TableName!
      return answering(() => {
        const outcome = deleteItem(
          input as never,
          (key) => store.get(keyOf(table, key)),
          keysOf(table),
          { failCondition },
        )
        return write("DeleteItem", table, input.Key!, outcome) as never
      }, failure("DeleteItem"))
    }),
  transactWriteItems: (input) =>
    Effect.suspend(() => {
      calls.transactWriteItems++
      sent.transactWriteItems.push(input)
      const ops = input.TransactItems ?? []
      if (contention.next > 0) {
        contention.next--
        return Effect.fail(
          new DynamoError({
            operation: "TransactWriteItems",
            cause: Object.assign(new Error("Transaction cancelled"), {
              name: "TransactionCanceledException",
              CancellationReasons: ops.map((_, i) => ({
                Code: i === 0 ? "TransactionConflict" : "None",
              })),
            }),
          }),
        )
      }
      return answering(() => {
        const outcome = transactWrite(input as never, tables, { failCondition })
        if (outcome._tag === "Cancelled") {
          return Effect.fail(classifyError("TransactWriteItems")(outcome.error))
        }
        // Every write's store key found before any write is made.
        const placed = outcome.writes.map(
          (each) => [keyOf(each.table, each.key), each.item] as const,
        )
        for (const [key, item] of placed) {
          if (item === undefined) store.delete(key)
          else store.set(key, item)
        }
        return Effect.succeed({} as never)
      }, failure("TransactWriteItems"))
    }),
})
