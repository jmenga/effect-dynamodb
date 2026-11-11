/**
 * A recording in-memory DynamoDB table for request-capture tests (#171): every
 * data-plane request is kept, in order, and answered from one `pk` / `sk`
 * table with conditions evaluated (`InMemoryTables.holds`) — GetItem, PutItem,
 * UpdateItem (`MockDynamoClient.applyUpdate`'s expression shapes), DeleteItem,
 * Query (on the table's keys or a declared secondary index, `Limit` counting
 * rows examined before the filter, paged by `ExclusiveStartKey` /
 * `LastEvaluatedKey`), Scan (in key order, split into `TotalSegments` by a
 * hash of the key, paged the same way), BatchGetItem, BatchWriteItem,
 * TransactGetItems and TransactWriteItems (`Put` / `Update` / `Delete` /
 * `ConditionCheck`). A failed condition answers `ALL_OLD` when the request
 * asked for it, as DynamoDB does. With `refuseBodiesOver`, a request whose
 * body ({@link sdkBodyBytes}) is over that many bytes is refused as DynamoDB
 * Local refuses one over 16 MiB: HTTP 413, before it is read.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer } from "effect"
import { DynamoClient } from "../../src/DynamoClient.js"
import { holds } from "./InMemoryTables.js"
import { applyUpdate, mockDynamoClient } from "./MockDynamoClient.js"

export type Item = Record<string, AttributeValue>

export interface Request {
  readonly command: string
  readonly input: Record<string, any>
}

const keyOf = (key: Item) => `${key.pk?.S}|${key.sk?.S}`

/**
 * The body the AWS SDK sends for `input`, by native `JSON.stringify` (binary
 * as base64) — independent of the library's own measure — plus the
 * `ClientRequestToken` (60 bytes) the SDK fills on a `TransactWriteItems`
 * without one. Checked against the SDK in `RequestSize.test.ts`.
 */
export const sdkBodyBytes = (command: string, input: Record<string, unknown>): number =>
  Buffer.byteLength(
    JSON.stringify(input, (_key, value) =>
      value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
    ),
    "utf8",
  ) + (command === "TransactWriteItems" && input.ClientRequestToken === undefined ? 60 : 0)

/** DynamoDB Local's refusal of a request body over 16 MiB, as the AWS SDK reports it. */
export const tooLargeFailure = (operation: string) =>
  new DynamoError({
    operation,
    cause: Object.assign(new Error("UnknownError"), {
      name: "Unknown",
      $fault: "client",
      $metadata: { httpStatusCode: 413, attempts: 1, totalRetryDelay: 0 },
    }),
  })

const conditionFailed = (operation: string, item: Item | undefined, input: Record<string, any>) =>
  new DynamoError({
    operation,
    cause: Object.assign(new Error("The conditional request failed"), {
      name: "ConditionalCheckFailedException",
      ...(input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" &&
        item !== undefined && { Item: item }),
    }),
  })

const passes = (input: Record<string, any>, item: Item | undefined) =>
  holds(
    input.ConditionExpression,
    item,
    input.ExpressionAttributeNames ?? {},
    input.ExpressionAttributeValues ?? {},
  )

/**
 * A key attribute's value as text that sorts as DynamoDB sorts it: a string as it is, bytes (a
 * Z-order `B` sort key) one character per byte, which compares byte by byte.
 */
const keyText = (value: AttributeValue | undefined): string =>
  value?.S ?? (value?.B === undefined ? "" : Buffer.from(value.B).toString("latin1"))

const sortKeyHolds = (
  condition: string | undefined,
  item: Item,
  names: Record<string, string>,
  values: Record<string, AttributeValue>,
): boolean => {
  if (condition === undefined) return true
  const between = /^(#\w+) BETWEEN (:\w+) AND (:\w+)$/.exec(condition)
  if (between) {
    const value = keyText(item[names[between[1]!]!])
    return value >= keyText(values[between[2]!]) && value <= keyText(values[between[3]!])
  }
  const begins = /^begins_with\((#\w+), (:\w+)\)$/.exec(condition)
  if (begins) return keyText(item[names[begins[1]!]!]).startsWith(keyText(values[begins[2]!]))
  const comparison = /^(#\w+) (<=|>=|=|<|>) (:\w+)$/.exec(condition)
  if (comparison) {
    const value = keyText(item[names[comparison[1]!]!])
    const operand = keyText(values[comparison[3]!])
    switch (comparison[2]) {
      case "=":
        return value === operand
      case "<":
        return value < operand
      case "<=":
        return value <= operand
      case ">":
        return value > operand
      default:
        return value >= operand
    }
  }
  throw new Error(`RecordingTable: unsupported key condition ${condition}`)
}

/** A secondary index's key attributes. */
export interface IndexKeys {
  readonly pk: string
  readonly sk: string
}

/**
 * A fresh table: its items, the requests sent to it, and a `DynamoClient`
 * layer over both. `indexes` names the secondary indexes a Query may read.
 */
export const makeRecordingTable = (options?: {
  readonly indexes?: Readonly<Record<string, IndexKeys>> | undefined
  /** Refuse a request whose body is over this many bytes, as DynamoDB Local refuses one over 16 MiB. */
  readonly refuseBodiesOver?: number | undefined
}) => {
  const items = new Map<string, Item>()
  const requests: Array<Request> = []
  /** Run before each request is answered — another writer landing just before it. */
  const hooks: { onRequest?: ((request: Request) => void) | undefined } = {}
  const record = (command: string, input: Record<string, any>) => {
    const request = { command, input: structuredClone(input) }
    requests.push(request)
    hooks.onRequest?.(request)
  }
  /** Whether DynamoDB Local would refuse `input` for its body. */
  const refused = (command: string, input: Record<string, any>) =>
    options?.refuseBodiesOver !== undefined &&
    sdkBodyBytes(command, input) > options.refuseBodiesOver

  const update = (input: Record<string, any>, current: Item | undefined): Item =>
    applyUpdate(current ?? { ...input.Key }, input)!

  const client = mockDynamoClient({
    getItem: (input) =>
      Effect.sync(() => {
        record("GetItem", input)
        const item = items.get(keyOf(input.Key!))
        return (item === undefined ? {} : { Item: item }) as never
      }),
    putItem: (input) =>
      Effect.suspend(() => {
        record("PutItem", input)
        if (refused("PutItem", input)) return Effect.fail(tooLargeFailure("PutItem"))
        const key = keyOf(input.Item!)
        const current = items.get(key)
        if (!passes(input, current)) return Effect.fail(conditionFailed("PutItem", current, input))
        items.set(key, input.Item!)
        return Effect.succeed({
          ...(input.ReturnValues === "ALL_OLD" && current !== undefined && { Attributes: current }),
        } as never)
      }),
    updateItem: (input) =>
      Effect.suspend(() => {
        record("UpdateItem", input)
        const key = keyOf(input.Key!)
        const current = items.get(key)
        if (!passes(input, current)) {
          return Effect.fail(conditionFailed("UpdateItem", current, input))
        }
        const next = update(input, current)
        items.set(key, next)
        const returned =
          input.ReturnValues === "ALL_OLD" || input.ReturnValues === "UPDATED_OLD"
            ? current
            : input.ReturnValues === "NONE" || input.ReturnValues === undefined
              ? undefined
              : next
        return Effect.succeed((returned === undefined ? {} : { Attributes: returned }) as never)
      }),
    deleteItem: (input) =>
      Effect.suspend(() => {
        record("DeleteItem", input)
        const key = keyOf(input.Key!)
        const current = items.get(key)
        if (!passes(input, current)) {
          return Effect.fail(conditionFailed("DeleteItem", current, input))
        }
        items.delete(key)
        return Effect.succeed({
          ...(input.ReturnValues === "ALL_OLD" && current !== undefined && { Attributes: current }),
        } as never)
      }),
    query: (input) =>
      Effect.sync(() => {
        record("Query", input)
        const index: IndexKeys =
          input.IndexName === undefined
            ? { pk: "pk", sk: "sk" }
            : (options?.indexes?.[input.IndexName] ??
              (() => {
                throw new Error(`RecordingTable: no index ${input.IndexName}`)
              })())
        const names = input.ExpressionAttributeNames ?? {}
        const values = input.ExpressionAttributeValues ?? {}
        const kc = /^(#\w+) = (:\w+)(?: AND (.*))?$/.exec(input.KeyConditionExpression ?? "")!
        const pk = values[kc[2]!]!.S
        const sortOf = (item: Item) => keyText(item[index.sk])
        const tableKey = (item: Item) => keyOf(item)
        let rows = [...items.values()]
          .filter(
            (item) =>
              item[index.pk]?.S === pk &&
              item[index.sk] !== undefined &&
              sortKeyHolds(kc[3], item, names, values),
          )
          .sort((a, b) =>
            sortOf(a) === sortOf(b)
              ? tableKey(a) < tableKey(b)
                ? -1
                : 1
              : sortOf(a) < sortOf(b)
                ? -1
                : 1,
          )
        if (input.ScanIndexForward === false) rows.reverse()
        const start = input.ExclusiveStartKey as Item | undefined
        if (start !== undefined) {
          const after = rows.findIndex(
            (item) => tableKey(item) === tableKey(start) && sortOf(item) === sortOf(start),
          )
          if (after < 0) {
            // A key no longer stored: resume at the first row past it.
            const forward = input.ScanIndexForward !== false
            rows = rows.filter((item) =>
              forward ? sortOf(item) > sortOf(start) : sortOf(item) < sortOf(start),
            )
          } else {
            rows = rows.slice(after + 1)
          }
        }
        const examined = input.Limit === undefined ? rows : rows.slice(0, input.Limit)
        const last = examined[examined.length - 1]
        const more = examined.length < rows.length && last !== undefined
        const returned =
          input.FilterExpression === undefined
            ? examined
            : examined.filter((item) => holds(input.FilterExpression, item, names, values))
        return {
          Items: returned,
          Count: returned.length,
          ScannedCount: examined.length,
          ...(more && {
            LastEvaluatedKey: {
              pk: last.pk!,
              sk: last.sk!,
              [index.pk]: last[index.pk]!,
              [index.sk]: last[index.sk]!,
            },
          }),
        } as never
      }),
    scan: (input) =>
      Effect.sync(() => {
        record("Scan", input)
        const total = input.TotalSegments ?? 1
        const segmentOf = (key: string) => {
          let hash = 0
          for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
          return hash % total
        }
        let rows = [...items.entries()]
          .filter(([key]) => segmentOf(key) === (input.Segment ?? 0))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        const start = input.ExclusiveStartKey as Item | undefined
        if (start !== undefined) rows = rows.filter(([key]) => key > keyOf(start))
        const examined = input.Limit === undefined ? rows : rows.slice(0, input.Limit)
        const last = examined[examined.length - 1]
        const more = examined.length < rows.length && last !== undefined
        const names = input.ExpressionAttributeNames ?? {}
        const values = input.ExpressionAttributeValues ?? {}
        const returned = examined
          .map(([, item]) => item)
          .filter(
            (item) =>
              input.FilterExpression === undefined ||
              holds(input.FilterExpression, item, names, values),
          )
        return {
          Items: returned,
          Count: returned.length,
          ScannedCount: examined.length,
          ...(more && { LastEvaluatedKey: { pk: last[1].pk!, sk: last[1].sk! } }),
        } as never
      }),
    batchGetItem: (input) =>
      Effect.sync(() => {
        record("BatchGetItem", input)
        const Responses: Record<string, Array<Item>> = {}
        for (const [table, request] of Object.entries(input.RequestItems ?? {})) {
          Responses[table] = (request.Keys ?? []).flatMap((key) => {
            const item = items.get(keyOf(key))
            return item === undefined ? [] : [item]
          })
        }
        return { Responses, UnprocessedKeys: {} } as never
      }),
    batchWriteItem: (input) =>
      Effect.suspend(() => {
        record("BatchWriteItem", input)
        if (refused("BatchWriteItem", input)) return Effect.fail(tooLargeFailure("BatchWriteItem"))
        for (const requests of Object.values(input.RequestItems ?? {})) {
          for (const request of requests) {
            if (request.PutRequest?.Item !== undefined) {
              items.set(keyOf(request.PutRequest.Item), request.PutRequest.Item)
            }
            if (request.DeleteRequest?.Key !== undefined) {
              items.delete(keyOf(request.DeleteRequest.Key))
            }
          }
        }
        return Effect.succeed({ UnprocessedItems: {} } as never)
      }),
    transactGetItems: (input) =>
      Effect.sync(() => {
        record("TransactGetItems", input)
        return {
          Responses: (input.TransactItems ?? []).map((get) => {
            const item = items.get(keyOf(get.Get!.Key!))
            return item === undefined ? {} : { Item: item }
          }),
        } as never
      }),
    transactWriteItems: (input) =>
      Effect.suspend(() => {
        record("TransactWriteItems", input)
        if (refused("TransactWriteItems", input)) {
          return Effect.fail(tooLargeFailure("TransactWriteItems"))
        }
        const ops = input.TransactItems ?? []
        const keys = ops.map((op) =>
          keyOf(op.Put?.Item ?? op.Update?.Key ?? op.Delete?.Key ?? op.ConditionCheck?.Key ?? {}),
        )
        if (new Set(keys).size !== keys.length) {
          return Effect.fail(
            new DynamoError({
              operation: "TransactWriteItems",
              cause: Object.assign(
                new Error("Transaction request cannot include multiple operations on one item"),
                { name: "ValidationException" },
              ),
            }),
          )
        }
        const reasons = ops.map((op, i) => {
          const write = (op.Put ?? op.Update ?? op.Delete ?? op.ConditionCheck)!
          const current = items.get(keys[i]!)
          return passes(write, current)
            ? { Code: "None" }
            : {
                Code: "ConditionalCheckFailed",
                ...(write.ReturnValuesOnConditionCheckFailure === "ALL_OLD" &&
                  current !== undefined && { Item: current }),
              }
        })
        if (reasons.some((reason) => reason.Code !== "None")) {
          return Effect.fail(
            new DynamoError({
              operation: "TransactWriteItems",
              cause: Object.assign(new Error("Transaction cancelled"), {
                name: "TransactionCanceledException",
                CancellationReasons: reasons,
              }),
            }),
          )
        }
        for (const [i, op] of ops.entries()) {
          if (op.Put !== undefined) items.set(keys[i]!, op.Put.Item!)
          if (op.Update !== undefined) items.set(keys[i]!, update(op.Update, items.get(keys[i]!)))
          if (op.Delete !== undefined) items.delete(keys[i]!)
        }
        return Effect.succeed({} as never)
      }),
  })

  return {
    items,
    requests,
    hooks,
    client,
    layer: Layer.succeed(DynamoClient, client),
    /** The requests sent since the last call, and forget them. */
    take: (): Array<Request> => requests.splice(0, requests.length),
  }
}
