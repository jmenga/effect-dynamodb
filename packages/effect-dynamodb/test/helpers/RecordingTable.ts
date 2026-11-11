/**
 * A recording in-memory DynamoDB table for request-capture tests (#171): every data-plane request
 * is kept, in order, and answered from `pk` / `sk` tables as DynamoDB Local answers it
 * (`DynamoExpressions`): GetItem, PutItem, UpdateItem, DeleteItem, Query (on the table's keys or a
 * declared secondary index, `Limit` counting rows examined before the filter, paged by
 * `ExclusiveStartKey` / `LastEvaluatedKey`), Scan (in key order, split into `TotalSegments` by a
 * hash of the key, paged the same way), BatchGetItem, BatchWriteItem, TransactGetItems and
 * TransactWriteItems (items taken in order, each against the item as the ones before it left it).
 * A failed condition answers `ALL_OLD` when the request asked for it, as DynamoDB does. With
 * `refuseBodiesOver`, a request whose body ({@link sdkBodyBytes}) is over that many bytes is
 * refused as DynamoDB Local refuses one over 16 MiB: HTTP 413, before it is read.
 *
 * A request DynamoDB refuses fails with DynamoDB Local's `ValidationException`, as the library's
 * client reports it (`DynamoValidationError`); a request this doesn't read is a defect naming it.
 * Items are stored and returned as copies, so neither a caller nor the library can change a stored
 * item in place. `connected.helper-conformance.test.ts` compares the answers with DynamoDB Local's.
 *
 * `items` holds every table's items under `<pk>|<sk>`. An item a request wrote belongs to that
 * request's table: another table doesn't hold it (a read finds nothing, a query or scan passes it
 * by), and a write of another table's item under the same key is a defect, as `items` can't hold
 * both. An item a test put in `items` itself belongs to no table in particular, so every table
 * finds it until a request writes it.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer } from "effect"
import { classifyError, DynamoClient } from "../../src/DynamoClient.js"
import {
  answering,
  batchGet,
  batchWrite,
  deleteItem,
  getItem,
  type KeySchema,
  putItem,
  query,
  scan,
  type Tables,
  type TableWrite,
  transactGet,
  transactWrite,
  UnreadableRequest,
  updateItem,
  type WriteOutcome,
} from "./DynamoExpressions.js"
import { mockDynamoClient } from "./MockDynamoClient.js"

export type Item = Record<string, AttributeValue>

export interface Request {
  readonly command: string
  readonly input: Record<string, any>
}

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

/** A secondary index's key attributes. */
export interface IndexKeys {
  readonly pk: string
  readonly sk: string
}

/** A refusal as the library's client reports it. */
const failure = (operation: string) => (error: Error) =>
  Effect.fail(classifyError(operation)(error))

/**
 * A fresh table: its items, the requests sent to it, and a `DynamoClient`
 * layer over both. `indexes` names the secondary indexes a Query may read.
 */
export const makeRecordingTable = (options?: {
  readonly indexes?: Readonly<Record<string, IndexKeys>> | undefined
  /** Refuse a request whose body is over this many bytes, as DynamoDB Local refuses one over 16 MiB. */
  readonly refuseBodiesOver?: number | undefined
  /** The tables' key attributes (default `pk` / `sk`); `items` is keyed `<pk value>|<sk value>`. */
  readonly keys?: IndexKeys | undefined
}) => {
  const tableKeys: KeySchema = options?.keys ?? { pk: "pk", sk: "sk" }
  /**
   * The key `items` holds an item (or key) under: `<pk>|<sk>`. A key that isn't text, or text
   * holding `|`, would not name one item alone, so it is a defect here.
   */
  const keyOf = (key: Item) => {
    const parts = [key[tableKeys.pk]?.S, key[tableKeys.sk]?.S]
    if (parts.some((part) => part === undefined || part.includes("|"))) {
      throw new UnreadableRequest(
        `RecordingTable keys items by their text keys, which ${JSON.stringify(parts)} can't be`,
      )
    }
    return `${parts[0]}|${parts[1]}`
  }
  const items = new Map<string, Item>()
  const requests: Array<Request> = []
  /** Run before each request is answered — another writer landing just before it. */
  const hooks: { onRequest?: ((request: Request) => void) | undefined } = {}
  /** The table each item a request wrote belongs to, by its key in `items`. */
  const owners = new Map<string, string>()
  const schemaOf = (table: string | undefined): KeySchema => {
    if (table === undefined) throw new UnreadableRequest("RecordingTable: a request names no table")
    return tableKeys
  }
  /** Whether `table` holds the item `items` keeps under `stored`. */
  const holdsItem = (table: string, stored: string) =>
    items.has(stored) && (owners.get(stored) ?? table) === table
  const read = (table: string, key: Item) => {
    const stored = keyOf(key)
    return holdsItem(table, stored) ? items.get(stored) : undefined
  }
  const store = (table: string, key: Item, item: Item | undefined) => {
    const stored = keyOf(key)
    const owner = owners.get(stored)
    if (items.has(stored) && owner !== undefined && owner !== table) {
      if (item === undefined) return
      throw new UnreadableRequest(
        `RecordingTable keeps every table's items under <pk>|<sk>, and ${stored} is ${owner}'s; ${table} writes it too`,
      )
    }
    if (item === undefined) {
      items.delete(stored)
      owners.delete(stored)
    } else {
      items.set(stored, item)
      owners.set(stored, table)
    }
  }
  /** The items `table` holds, by their keys in `items`. */
  const rowsOf = (table: string) =>
    [...items.entries()].filter(([stored]) => holdsItem(table, stored))
  const tables: Tables = { schema: schemaOf, read }
  const record = (command: string, input: Record<string, any>) => {
    const request = { command, input: structuredClone(input) }
    requests.push(request)
    hooks.onRequest?.(request)
  }
  /** Whether DynamoDB Local would refuse `input` for its body. */
  const refused = (command: string, input: Record<string, any>) =>
    options?.refuseBodiesOver !== undefined &&
    sdkBodyBytes(command, input) > options.refuseBodiesOver

  const write = (operation: string, table: string, key: Item, outcome: WriteOutcome) => {
    if (outcome._tag === "ConditionFailed") {
      return Effect.fail(classifyError(operation)(outcome.error))
    }
    store(table, key, outcome.item)
    return Effect.succeed(outcome.output as never)
  }
  const apply = (writes: ReadonlyArray<TableWrite>) => {
    for (const each of writes) store(each.table, each.key, each.item)
  }

  const client = mockDynamoClient({
    getItem: (input) =>
      Effect.suspend(() => {
        record("GetItem", input)
        return answering(() => {
          const table = input.TableName!
          const output = getItem(input as never, (key) => read(table, key), schemaOf(table))
          return Effect.succeed(output as never)
        }, failure("GetItem"))
      }),
    putItem: (input) =>
      Effect.suspend(() => {
        record("PutItem", input)
        if (refused("PutItem", input)) return Effect.fail(tooLargeFailure("PutItem"))
        return answering(() => {
          const table = input.TableName!
          const outcome = putItem(input as never, (key) => read(table, key), schemaOf(table))
          return write("PutItem", table, input.Item!, outcome)
        }, failure("PutItem"))
      }),
    updateItem: (input) =>
      Effect.suspend(() => {
        record("UpdateItem", input)
        return answering(() => {
          const table = input.TableName!
          const outcome = updateItem(input as never, (key) => read(table, key), schemaOf(table))
          return write("UpdateItem", table, input.Key!, outcome)
        }, failure("UpdateItem"))
      }),
    deleteItem: (input) =>
      Effect.suspend(() => {
        record("DeleteItem", input)
        return answering(() => {
          const table = input.TableName!
          const outcome = deleteItem(input as never, (key) => read(table, key), schemaOf(table))
          return write("DeleteItem", table, input.Key!, outcome)
        }, failure("DeleteItem"))
      }),
    query: (input) =>
      Effect.suspend(() => {
        record("Query", input)
        return answering(() => {
          const schema = schemaOf(input.TableName)
          const index =
            input.IndexName === undefined
              ? undefined
              : (options?.indexes?.[input.IndexName] ??
                (() => {
                  throw new UnreadableRequest(`RecordingTable: no index ${input.IndexName}`)
                })())
          const rows = rowsOf(input.TableName!).map(([, item]) => item)
          return Effect.succeed(query(input as never, rows, schema, index) as never)
        }, failure("Query"))
      }),
    scan: (input) =>
      Effect.suspend(() => {
        record("Scan", input)
        return answering(() => {
          const schema = schemaOf(input.TableName)
          const total = input.TotalSegments ?? 1
          const segmentOf = (key: string) => {
            let hash = 0
            for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
            return hash % total
          }
          const rows = rowsOf(input.TableName!)
            .filter(([key]) => segmentOf(key) === (input.Segment ?? 0))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          const after = (start: Item) =>
            rows.filter(([key]) => key > keyOf(start)).map(([, item]) => item)
          return Effect.succeed(
            scan(
              input as never,
              rows.map(([, item]) => item),
              schema,
              after,
            ) as never,
          )
        }, failure("Scan"))
      }),
    batchGetItem: (input) =>
      Effect.suspend(() => {
        record("BatchGetItem", input)
        return answering(
          () => Effect.succeed(batchGet(input as never, tables) as never),
          failure("BatchGetItem"),
        )
      }),
    batchWriteItem: (input) =>
      Effect.suspend(() => {
        record("BatchWriteItem", input)
        if (refused("BatchWriteItem", input)) return Effect.fail(tooLargeFailure("BatchWriteItem"))
        return answering(() => {
          apply(batchWrite(input as never, tables))
          return Effect.succeed({ UnprocessedItems: {} } as never)
        }, failure("BatchWriteItem"))
      }),
    transactGetItems: (input) =>
      Effect.suspend(() => {
        record("TransactGetItems", input)
        return answering(
          () => Effect.succeed(transactGet(input as never, tables) as never),
          failure("TransactGetItems"),
        )
      }),
    transactWriteItems: (input) =>
      Effect.suspend(() => {
        record("TransactWriteItems", input)
        if (refused("TransactWriteItems", input)) {
          return Effect.fail(tooLargeFailure("TransactWriteItems"))
        }
        return answering(() => {
          const outcome = transactWrite(input as never, tables)
          if (outcome._tag === "Cancelled") {
            return Effect.fail(classifyError("TransactWriteItems")(outcome.error))
          }
          apply(outcome.writes)
          return Effect.succeed({} as never)
        }, failure("TransactWriteItems"))
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
