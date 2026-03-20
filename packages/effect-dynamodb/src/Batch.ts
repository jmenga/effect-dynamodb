/**
 * Batch — BatchGetItem and BatchWriteItem with auto-chunking and retry.
 *
 * DynamoDB limits: BatchGetItem max 100 keys, BatchWriteItem max 25 items.
 * Both can return unprocessed items that must be retried.
 *
 * Accepts Entity operation intermediates directly (EntityGet, EntityPut, EntityDelete).
 * Batch.get returns a typed tuple inferred per-position.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Effect } from "effect"
import { DynamoClient, type DynamoClientError } from "./DynamoClient.js"
import type { Entity, EntityDelete, EntityGet, EntityPut } from "./Entity.js"
import { extractTransactable } from "./Entity.js"
import { DynamoError, type ValidationError } from "./Errors.js"
import {
  composePrimaryKey,
  resolveTableNames,
  validateAndBuildPutItem,
} from "./internal/TransactableOps.js"
import { fromAttributeMap, toAttributeMap } from "./Marshaller.js"
import type { TableConfig } from "./Table.js"

const MAX_BATCH_GET = 100
const MAX_BATCH_WRITE = 25
const MAX_RETRIES = 5
const BASE_DELAY_MS = 100

/**
 * Optional retry configuration for batch operations.
 * When omitted, defaults to 5 retries with 100ms base delay.
 */
export interface BatchRetryConfig {
  readonly maxRetries?: number | undefined
  readonly baseDelayMs?: number | undefined
}

// ---------------------------------------------------------------------------
// Batch.get — typed tuple return, auto-chunk at 100, retry unprocessed
// ---------------------------------------------------------------------------

/**
 * Map a tuple of EntityGet operations to a tuple of (A | undefined) results.
 */
type BatchGetResult<T extends ReadonlyArray<EntityGet<any, any, any, any>>> = {
  -readonly [K in keyof T]: T[K] extends EntityGet<infer A, any, any, any> ? A | undefined : never
}

/**
 * Batch-get up to any number of items across entities/tables.
 * Auto-chunks at 100 items per request. Retries unprocessed keys
 * with exponential backoff. Returns a typed tuple matching input positions.
 *
 * DynamoDB batchGetItem doesn't preserve order, so results are matched
 * back to input positions by comparing composed primary key fields.
 *
 * ```typescript
 * const [alice, bob, post] = yield* Batch.get([
 *   Users.get({ userId: "u-1" }),
 *   Users.get({ userId: "u-2" }),
 *   Posts.get({ postId: "p-1" }),
 * ])
 * // alice: User | undefined, bob: User | undefined, post: Post | undefined
 * ```
 */
export const get = <const T extends ReadonlyArray<EntityGet<any, any, any, any>>>(
  items: T,
  config?: BatchRetryConfig,
): Effect.Effect<
  BatchGetResult<T>,
  DynamoClientError | ValidationError,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    const maxRetries = config?.maxRetries ?? MAX_RETRIES
    const baseDelayMs = config?.baseDelayMs ?? BASE_DELAY_MS
    // Cast rationale: empty array [] is a valid tuple for any BatchGetResult<T>.
    // TypeScript cannot infer that [] satisfies a mapped tuple type, so we cast.
    if (items.length === 0) return [] as unknown as BatchGetResult<T>

    const client = yield* DynamoClient

    // Extract entity info from each EntityGet intermediate
    const infos = items.map((item) => {
      const info = extractTransactable(item)
      if (!info || info.opType !== "get") {
        throw new Error("Batch.get requires EntityGet intermediates")
      }
      return info
    })

    const tableNames = yield* resolveTableNames(infos)

    // Build composed keys for each item and track the mapping
    const itemKeys: Array<{
      tableName: string
      composedKey: Record<string, unknown>
      marshalledKey: Record<string, AttributeValue>
      entity: Entity
      index: number
    }> = []

    for (let i = 0; i < infos.length; i++) {
      const info = infos[i]!
      const tableName = tableNames.get(info.entity)!
      const composed = composePrimaryKey(info.entity, info.key!)

      itemKeys.push({
        tableName,
        composedKey: composed,
        marshalledKey: toAttributeMap(composed),
        entity: info.entity,
        index: i,
      })
    }

    // Collect all responses by original index
    const results: Array<unknown> = new Array(items.length).fill(undefined)

    // Process in chunks of MAX_BATCH_GET
    for (let chunkStart = 0; chunkStart < itemKeys.length; chunkStart += MAX_BATCH_GET) {
      const chunk = itemKeys.slice(chunkStart, chunkStart + MAX_BATCH_GET)

      // Build request grouped by table
      let requestItems: Record<string, { Keys: Array<Record<string, AttributeValue>> }> = {}
      for (const item of chunk) {
        if (!requestItems[item.tableName]) {
          requestItems[item.tableName] = { Keys: [] }
        }
        requestItems[item.tableName]!.Keys.push(item.marshalledKey)
      }

      // Retry loop for unprocessed keys
      let retries = 0
      while (Object.keys(requestItems).length > 0) {
        const response = yield* client.batchGetItem({ RequestItems: requestItems })

        // Process responses
        if (response.Responses) {
          for (const [tableName, tableItems] of Object.entries(response.Responses)) {
            for (const responseItem of tableItems) {
              const raw = fromAttributeMap(responseItem)

              // Match to original position by primary key
              const matched = chunk.find((item) => {
                if (item.tableName !== tableName) return false
                const primary = item.entity.indexes.primary!
                return (
                  raw[primary.pk.field] === item.composedKey[primary.pk.field] &&
                  raw[primary.sk.field] === item.composedKey[primary.sk.field]
                )
              })

              if (matched) {
                const decoded = yield* matched.entity._decodeRecord(raw)
                results[matched.index] = decoded
              }
            }
          }
        }

        // Check for unprocessed keys
        const unprocessed: Record<string, { Keys: Array<Record<string, AttributeValue>> }> = {}
        if (response.UnprocessedKeys) {
          for (const [tableName, tableKeys] of Object.entries(response.UnprocessedKeys)) {
            if (tableKeys.Keys && tableKeys.Keys.length > 0) {
              unprocessed[tableName] = { Keys: tableKeys.Keys }
            }
          }
        }

        if (Object.keys(unprocessed).length === 0) break

        retries++
        if (retries > maxRetries) {
          return yield* new DynamoError({
            operation: "BatchGetItem",
            cause: new Error(`Unprocessed keys remain after ${maxRetries} retries`),
          })
        }

        // Exponential backoff
        yield* Effect.sleep(`${baseDelayMs * 2 ** (retries - 1)} millis`)
        requestItems = unprocessed
      }
    }

    // Cast rationale: results is built as Array<A | undefined> by matching DynamoDB
    // responses back to input positions via primary key comparison. The mapped tuple
    // type BatchGetResult<T> captures per-position entity types, but the runtime
    // array construction can't express this statically.
    return results as unknown as BatchGetResult<T>
  })

// ---------------------------------------------------------------------------
// Batch.write — auto-chunk at 25, retry unprocessed
// ---------------------------------------------------------------------------

type BatchWriteOp = EntityPut<any, any, any, any> | EntityDelete<any, any>

/**
 * Batch-write any number of items across entities/tables.
 * Auto-chunks at 25 items per request. Retries unprocessed items
 * with exponential backoff.
 *
 * ```typescript
 * yield* Batch.write([
 *   Users.put({ userId: "u-3", ... }),
 *   Posts.delete({ postId: "p-1" }),
 * ])
 * ```
 */
export const write = (
  operations: ReadonlyArray<BatchWriteOp>,
  config?: BatchRetryConfig,
): Effect.Effect<void, DynamoClientError | ValidationError, DynamoClient | TableConfig> =>
  Effect.gen(function* () {
    if (operations.length === 0) return
    const maxRetries = config?.maxRetries ?? MAX_RETRIES
    const baseDelayMs = config?.baseDelayMs ?? BASE_DELAY_MS

    const client = yield* DynamoClient

    // Build write requests
    const writeRequests: Array<{
      tableName: string
      request: Record<string, any>
    }> = []

    for (const op of operations) {
      const info = extractTransactable(op)
      if (!info) {
        throw new Error("Batch.write: unrecognized operation type")
      }

      const entity = info.entity
      const { name: tableName } = yield* entity._tableTag

      if (info.opType === "put") {
        const marshalledItem = yield* validateAndBuildPutItem(entity, info.input!, "batchWrite.put")
        writeRequests.push({
          tableName,
          request: { PutRequest: { Item: marshalledItem } },
        })
      } else if (info.opType === "delete") {
        const composed = composePrimaryKey(entity, info.key!)
        writeRequests.push({
          tableName,
          request: { DeleteRequest: { Key: toAttributeMap(composed) } },
        })
      } else {
        throw new Error(
          `Batch.write: unsupported operation type "${info.opType}". Use EntityPut or EntityDelete.`,
        )
      }
    }

    // Process in chunks of MAX_BATCH_WRITE
    for (let chunkStart = 0; chunkStart < writeRequests.length; chunkStart += MAX_BATCH_WRITE) {
      const chunk = writeRequests.slice(chunkStart, chunkStart + MAX_BATCH_WRITE)

      // Group by table name
      let requestItems: Record<string, Array<Record<string, any>>> = {}
      for (const item of chunk) {
        if (!requestItems[item.tableName]) {
          requestItems[item.tableName] = []
        }
        requestItems[item.tableName]!.push(item.request)
      }

      // Retry loop for unprocessed items
      let retries = 0
      while (Object.keys(requestItems).length > 0) {
        const response = yield* client.batchWriteItem({ RequestItems: requestItems })

        // Check for unprocessed items
        const unprocessed: Record<string, Array<Record<string, any>>> = {}
        if (response.UnprocessedItems) {
          for (const [tableName, tableItems] of Object.entries(response.UnprocessedItems)) {
            if (tableItems.length > 0) {
              unprocessed[tableName] = tableItems as Array<Record<string, any>>
            }
          }
        }

        if (Object.keys(unprocessed).length === 0) break

        retries++
        if (retries > maxRetries) {
          return yield* new DynamoError({
            operation: "BatchWriteItem",
            cause: new Error(`Unprocessed items remain after ${maxRetries} retries`),
          })
        }

        // Exponential backoff
        yield* Effect.sleep(`${baseDelayMs * 2 ** (retries - 1)} millis`)
        requestItems = unprocessed
      }
    }
  })
