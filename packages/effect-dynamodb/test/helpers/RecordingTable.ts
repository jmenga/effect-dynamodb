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
 * client reports it (`DynamoValidationError`); a request this doesn't read is a defect naming it,
 * found before anything is written. A transaction or batch is checked whole, then written whole.
 * Items are stored and returned as copies, so neither a caller nor the library can change a stored
 * item in place. `connected.helper-conformance.test.ts` compares the answers with DynamoDB Local's;
 * what it doesn't model is listed at the top of `DynamoExpressions.ts`.
 *
 * Items are held by table and key: one key in two tables is two items. `items` shows them all
 * under their key text, `<pk>|<sk>` ({@link keyText}: a `\` or `|` inside either part escaped, so
 * one text names one key). An item a request wrote belongs to that request's table; `seed` puts an
 * item in a table as a write would. An item a test put in `items` belongs to no table in
 * particular, so every table finds it until a request writes it. A text two tables hold an item
 * under names neither alone, so `items.get` / `set` / `delete` of it is a defect.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer } from "effect"
import { classifyError, DynamoClient } from "../../src/DynamoClient.js"
import {
  answering,
  batchGet,
  batchWrite,
  checkItem,
  deleteItem,
  getItem,
  type IndexSchema,
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

/** A secondary index: its key attributes, its kind and what it projects (`DynamoExpressions`). */
export type IndexKeys = IndexSchema

/** A refusal as the library's client reports it. */
const failure = (operation: string) => (error: Error) =>
  Effect.fail(classifyError(operation)(error))

const escapePart = (text: string) => text.replace(/[\\|]/g, (c) => `\\${c}`)

/**
 * The text `items` shows a key under: `<pk>|<sk>`, with a `\` or `|` inside either part escaped
 * (`\\`, `\|`), so one text names one key. A key of neither kind of character reads as written.
 */
export const keyText = (pk: string, sk: string): string => `${escapePart(pk)}|${escapePart(sk)}`

/** The key a {@link keyText} names, or `undefined` for text that isn't one. */
const parseKeyText = (text: string): readonly [string, string] | undefined => {
  const parts: Array<string> = []
  let part = ""
  for (let at = 0; at < text.length; at++) {
    const c = text[at]!
    if (c === "\\") {
      const next = text[at + 1]
      if (next !== "\\" && next !== "|") return undefined
      part += next
      at++
    } else if (c === "|") {
      parts.push(part)
      part = ""
    } else {
      part += c
    }
  }
  parts.push(part)
  return parts.length === 2 ? [parts[0]!, parts[1]!] : undefined
}

/**
 * A fresh table: its items, the requests sent to it, and a `DynamoClient`
 * layer over both. `indexes` names the secondary indexes a Query may read.
 */
export const makeRecordingTable = (options?: {
  readonly indexes?: Readonly<Record<string, IndexKeys>> | undefined
  /** Refuse a request whose body is over this many bytes, as DynamoDB Local refuses one over 16 MiB. */
  readonly refuseBodiesOver?: number | undefined
  /** The tables' key attributes (default `pk` / `sk`); `items` shows them as `<pk value>|<sk value>`. */
  readonly keys?: KeySchema | undefined
}) => {
  const tableKeys: KeySchema = options?.keys ?? { pk: "pk", sk: "sk" }
  /**
   * Every item, by its key's text, then by the table it belongs to (`undefined`: a test put it in
   * `items`, and every table finds it until a request writes it). Every key a request names is a
   * non-empty `S` of the table's key attributes (`checkKey`), so the text names one key.
   */
  const slots = new Map<string, Map<string | undefined, Item>>()
  const textOf = (key: Item) => keyText(key[tableKeys.pk]!.S!, key[tableKeys.sk]!.S!)
  const requests: Array<Request> = []
  /** Run before each request is answered — another writer landing just before it. */
  const hooks: { onRequest?: ((request: Request) => void) | undefined } = {}
  const schemaOf = (table: string | undefined): KeySchema => {
    if (table === undefined) throw new UnreadableRequest("RecordingTable: a request names no table")
    return tableKeys
  }
  const heldBy = (slot: Map<string | undefined, Item> | undefined, table: string) =>
    slot?.get(table) ?? slot?.get(undefined)
  const read = (table: string, key: Item) => heldBy(slots.get(textOf(key)), table)
  /** One write, its key's text found: it can't fail, so a request's writes are found first, then made. */
  const place = (table: string, text: string, item: Item | undefined) => {
    const slot = slots.get(text) ?? new Map<string | undefined, Item>()
    slot.delete(undefined)
    if (item === undefined) slot.delete(table)
    else slot.set(table, item)
    if (slot.size === 0) slots.delete(text)
    else slots.set(text, slot)
  }
  /** Make every write, each one's key found before any is made. */
  const apply = (writes: ReadonlyArray<TableWrite>) => {
    const placed = writes.map((each) => [each.table, textOf(each.key), each.item] as const)
    for (const [table, text, item] of placed) place(table, text, item)
  }
  /** The items `table` holds, with their keys' text. */
  const rowsOf = (table: string) =>
    [...slots.entries()].flatMap(([text, slot]) => {
      const item = heldBy(slot, table)
      return item === undefined ? [] : [[text, item] as const]
    })
  const tables: Tables = { schema: schemaOf, read }

  /** The one item `items` shows under `text`; two tables' items there are a defect. */
  const only = (text: string, what: string) => {
    const slot = slots.get(text)
    if (slot !== undefined && slot.size > 1) {
      throw new UnreadableRequest(
        `RecordingTable: items.${what}(${JSON.stringify(text)}) names an item of each of ${JSON.stringify([...slot.keys()])}`,
      )
    }
    return slot
  }
  /**
   * Every item, keyed by its key's text; one key in two tables shows twice. A `Map` (so it
   * compares equal to one holding the same entries) whose methods read and write `slots`.
   */
  const items = new Map<string, Item>()
  const entries = function* (): Generator<[string, Item]> {
    for (const [text, slot] of slots) for (const item of slot.values()) yield [text, item]
  }
  Object.defineProperties(items, {
    get: {
      value: (text: string): Item | undefined => {
        const slot = only(text, "get")
        return slot === undefined ? undefined : [...slot.values()][0]
      },
    },
    set: {
      value: (text: string, item: Item) => {
        const slot = only(text, "set")
        if (slot !== undefined) {
          slot.set([...slot.keys()][0], item)
          return items
        }
        if (parseKeyText(text) === undefined) {
          throw new UnreadableRequest(
            `RecordingTable: items.set(${JSON.stringify(text)}) names no key: keys are <pk>|<sk>, a \\ or | inside a part escaped (keyText)`,
          )
        }
        slots.set(text, new Map([[undefined, item]]))
        return items
      },
    },
    delete: {
      value: (text: string): boolean => only(text, "delete") !== undefined && slots.delete(text),
    },
    has: { value: (text: string): boolean => slots.has(text) },
    clear: { value: (): void => slots.clear() },
    size: {
      get: (): number => {
        let size = 0
        for (const slot of slots.values()) size += slot.size
        return size
      },
    },
    entries: { value: entries },
    keys: {
      value: function* () {
        for (const [text] of entries()) yield text
      },
    },
    values: {
      value: function* () {
        for (const [, item] of entries()) yield item
      },
    },
    [Symbol.iterator]: { value: entries },
    forEach: {
      value: (each: (item: Item, text: string, map: Map<string, Item>) => void): void => {
        for (const [text, item] of entries()) each(item, text, items)
      },
    },
  })
  /** Put `item` in `table`, as a write of it would. */
  const seed = (table: string, item: Item) => place(table, textOf(checkItem(item, tableKeys)), item)
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
    place(table, textOf(key), outcome.item)
    return Effect.succeed(outcome.output as never)
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
          // In the order of their keys' text, which names one key each.
          const rows = rowsOf(input.TableName!)
            .filter(([text]) => segmentOf(text) === (input.Segment ?? 0))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          const after = (start: Item) =>
            rows.filter(([text]) => text > textOf(start)).map(([, item]) => item)
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
    seed,
    requests,
    hooks,
    client,
    layer: Layer.succeed(DynamoClient, client),
    /** The requests sent since the last call, and forget them. */
    take: (): Array<Request> => requests.splice(0, requests.length),
  }
}
