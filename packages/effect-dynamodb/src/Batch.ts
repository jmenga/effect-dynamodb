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
import {
  DynamoError,
  isAwsTransactionCancelled,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import { DynamoClient, type DynamoClientError } from "./DynamoClient.js"
import type { Entity, EntityDelete, EntityPut, TransactableInfo } from "./Entity.js"
import { extractTransactable } from "./Entity.js"
import type { AnyGet, BoundWriteOp, GetSuccess } from "./internal/BoundCrud.js"
import {
  batchRejectReason,
  composePrimaryKey,
  getRejectReason,
  rejectUnsupportedOp,
  resolveTableNames,
  validateAndBuildPutItem,
} from "./internal/TransactableOps.js"
import { fromAttributeMap, toAttributeMap } from "./Marshaller.js"
import type { TableConfig } from "./Table.js"

const MAX_BATCH_GET = 100
const MAX_BATCH_WRITE = 25
const MAX_TRANSACT_WRITE = 100
/** DynamoDB caps a transaction's payload at 4 MB of item data; leave headroom. */
const MAX_TRANSACT_BYTES = 3_500_000
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
 * Map a tuple of get descriptors to a tuple of (A | undefined) results.
 */
type BatchGetResult<T extends ReadonlyArray<AnyGet>> = {
  -readonly [K in keyof T]: GetSuccess<T[K]> | undefined
}

/**
 * Batch-get up to any number of items across entities/tables.
 * Auto-chunks at 100 items per request. Retries unprocessed keys
 * with exponential backoff. Returns a typed tuple matching input positions.
 *
 * DynamoDB batchGetItem doesn't preserve order, so results are matched
 * back to input positions by comparing composed primary key fields.
 *
 * Accepts the unbound `EntityGet` intermediate or the `BoundGet` returned by
 * `db.entities.X.get(...)` — the latter is the only read descriptor available
 * for entities authored with the pure `@effect-dynamodb/schema` `Entity.make`
 * (#108).
 *
 * ```typescript
 * const [alice, bob, post] = yield* Batch.get([
 *   Users.get({ userId: "u-1" }),
 *   db.entities.Users.get({ userId: "u-2" }),
 *   Posts.get({ postId: "p-1" }),
 * ])
 * // alice: User | undefined, bob: User | undefined, post: Post | undefined
 * ```
 */
export const get = <const T extends ReadonlyArray<AnyGet>>(
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

    // Unwrap each position to its get descriptor. A rejection belongs on the
    // error channel, not as a defect — a thrown Error is neither catchable nor
    // discriminable by the caller (the same judgement `Batch.write` made in
    // #100).
    const infos: Array<TransactableInfo> = []
    for (const item of items) {
      const info = extractTransactable(item)
      if (!info || info.opType !== "get") {
        return yield* new ValidationError({
          entityType: "unknown",
          operation: "batchGet",
          cause: getRejectReason("Batch.get"),
        })
      }
      infos.push(info)
    }

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

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/**
 * An item's size as DynamoDB counts it toward a transaction's 4 MB payload:
 * attribute names plus values, binary as raw bytes. Numbers are counted by
 * their digits and list / map entries carry a few bytes of overhead, so this
 * errs high.
 */
const attributeBytes = (value: AttributeValue): number => {
  if (value.S !== undefined) return utf8Bytes(value.S)
  if (value.N !== undefined) return value.N.length + 1
  if (value.B !== undefined) return value.B.byteLength
  if (value.SS !== undefined) return value.SS.reduce((sum, v) => sum + utf8Bytes(v), 0)
  if (value.NS !== undefined) return value.NS.reduce((sum, v) => sum + v.length + 1, 0)
  if (value.BS !== undefined) return value.BS.reduce((sum, v) => sum + v.byteLength, 0)
  if (value.L !== undefined) return value.L.reduce((sum, v) => sum + attributeBytes(v) + 1, 3)
  if (value.M !== undefined) return itemBytes(value.M) + 3
  return 1
}

const itemBytes = (item: Record<string, AttributeValue>): number =>
  Object.entries(item).reduce(
    (sum, [name, value]) => sum + utf8Bytes(name) + attributeBytes(value),
    0,
  )

// ---------------------------------------------------------------------------
// Batch.write — auto-chunk at 25, retry unprocessed
// ---------------------------------------------------------------------------

/**
 * Union accepted by `Batch.write`. Bound-CRUD builders
 * (`db.entities.X.put(...)` / `.delete(...)`) are accepted alongside the unbound
 * intermediates — they are the only write descriptor available for entities
 * authored with the pure, AWS-free `@effect-dynamodb/schema` `Entity.make`
 * (#100).
 */
type BatchWriteOp = EntityPut<any, any, any, any> | EntityDelete<any, any> | BoundWriteOp

/**
 * Batch-write any number of items across entities/tables.
 * Auto-chunks at 25 items per request. Retries unprocessed items
 * with exponential backoff.
 *
 * Puts of a `versioned` entity are sent first, as create-only
 * `TransactWriteItems` of up to 100 items (`attribute_not_exists`): a batch
 * put cannot continue an existing item's version, so one that would replace an
 * item fails with a `ValidationError` and its chunk writes nothing (the entity's
 * `put` and `Transaction.transactWrite` replace it). Each chunk costs twice the
 * write capacity of a batch write.
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
    const versionedPuts: Array<{
      readonly tableName: string
      readonly entityType: string
      readonly item: Record<string, AttributeValue>
      readonly pkField: string
      readonly bytes: number
    }> = []
    // Every key the batch touches, to refuse one touched twice when a versioned
    // put is involved: its put runs in an earlier transaction than the batch's
    // other requests, so a repeated key would be reordered or misreported.
    const touched = new Map<string, number>()
    const versionedKeys = new Map<string, string>()
    const keyOf = (
      tableName: string,
      entity: {
        readonly indexes: {
          readonly primary?:
            | { readonly pk: { readonly field: string }; readonly sk: { readonly field: string } }
            | undefined
        }
      },
      item: Record<string, AttributeValue>,
    ) => {
      const primary = entity.indexes.primary!
      return JSON.stringify([tableName, item[primary.pk.field], item[primary.sk.field]])
    }
    const writeRequests: Array<{
      tableName: string
      request: Record<string, any>
    }> = []

    for (const op of operations) {
      const info = extractTransactable(op)
      // A rejection belongs on the error channel, not as a defect — the caller
      // can neither catch nor discriminate a thrown Error (#100).
      if (!info) {
        return yield* new ValidationError({
          entityType: "unknown",
          operation: "batchWrite",
          cause:
            "Batch.write: unrecognized operation type. Use Entity.put/Entity.delete, or the " +
            "bound builders db.entities.X.put(...) / .delete(...).",
        })
      }

      const entity = info.entity
      const { name: tableName } = yield* entity._tableTag

      // BatchWriteItem has no ConditionExpression. Silently dropping a
      // condition would turn `create()` into a blind overwrite, so reject
      // instead — the caller wants `Transaction.transactWrite`.
      if (info.condition !== undefined) {
        return yield* new ValidationError({
          entityType: entity.entityType,
          operation: "batchWrite",
          cause:
            "Batch.write cannot apply a condition — BatchWriteItem has no ConditionExpression. " +
            "Use Transaction.transactWrite for conditional writes (this includes create() and " +
            "deleteIfExists(), which carry an implicit condition).",
        })
      }

      // Multi-item lifecycle features are structurally impossible here — no
      // ConditionExpression, no UpdateRequest, no atomicity across the 25-item
      // chunk boundary. Checked per direction: `softDelete` changes only the
      // delete path, so a put of a soft-deletable entity stays allowed. The
      // transact path expands puts into these items instead (#113).
      const batchReason = batchRejectReason(entity, info.opType === "delete" ? "delete" : "put")
      if (batchReason !== undefined) {
        return yield* new ValidationError({
          entityType: entity.entityType,
          operation: "batchWrite",
          cause: batchReason,
        })
      }

      if (info.opType === "put") {
        yield* rejectUnsupportedOp(entity, "batchWrite", "put", info.putKind, info.input)
        const built = yield* validateAndBuildPutItem(entity, info.input!, "batchWrite.put")
        // A versioned entity's put over an existing item continues its version
        // (#133), which a blind BatchWriteItem cannot — it would reset the item
        // to version 1 under a new incarnation. Such puts go out as create-only
        // TransactWriteItems Puts (`attribute_not_exists`) instead: no read, no
        // window between a check and the write.
        const key = keyOf(tableName, entity, built.marshalled)
        touched.set(key, (touched.get(key) ?? 0) + 1)
        if (entity._incarnationToken) {
          versionedKeys.set(key, entity.entityType)
          versionedPuts.push({
            tableName,
            entityType: entity.entityType,
            item: built.marshalled,
            pkField: entity.indexes.primary!.pk.field,
            bytes: itemBytes(built.marshalled),
          })
        } else {
          writeRequests.push({
            tableName,
            request: { PutRequest: { Item: built.marshalled } },
          })
        }
      } else if (info.opType === "delete") {
        yield* rejectUnsupportedOp(entity, "batchWrite", "delete", undefined)
        const composed = toAttributeMap(composePrimaryKey(entity, info.key!))
        const key = keyOf(tableName, entity, composed)
        touched.set(key, (touched.get(key) ?? 0) + 1)
        writeRequests.push({
          tableName,
          request: { DeleteRequest: { Key: composed } },
        })
      } else {
        return yield* new ValidationError({
          entityType: entity.entityType,
          operation: "batchWrite",
          cause:
            `Batch.write: unsupported operation type "${info.opType}". BatchWriteItem has no ` +
            "UpdateRequest — use Entity.put or Entity.delete, or Transaction.transactWrite.",
        })
      }
    }

    for (const [key, entityType] of versionedKeys) {
      if ((touched.get(key) ?? 0) > 1) {
        return yield* new ValidationError({
          entityType,
          operation: "batchWrite",
          cause:
            "Batch.write touches the same item more than once alongside a versioned put. " +
            "Versioned puts are written as separate create-only transactions, so the batch's " +
            "operations on that item could not keep their order. Nothing was written.",
        })
      }
    }

    // Versioned puts first, as create-only transactions of up to 100 items and
    // under DynamoDB's 4 MB transaction payload. Each chunk is atomic; a chunk
    // that would replace an existing item writes nothing and stops the batch
    // before any later chunk or the plain requests below.
    const versionedChunks: Array<typeof versionedPuts> = []
    for (const put of versionedPuts) {
      const last = versionedChunks[versionedChunks.length - 1]
      const lastBytes = last?.reduce((sum, p) => sum + p.bytes, 0) ?? 0
      if (
        last === undefined ||
        last.length >= MAX_TRANSACT_WRITE ||
        lastBytes + put.bytes > MAX_TRANSACT_BYTES
      ) {
        versionedChunks.push([put])
      } else {
        last.push(put)
      }
    }
    for (const chunk of versionedChunks) {
      const transactItems = chunk.map((put) => ({
        Put: {
          TableName: put.tableName,
          Item: put.item,
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": put.pkField },
        },
      }))

      let retries = 0
      while (true) {
        const cancelled = yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
          Effect.as(undefined),
          Effect.catchTag("DynamoError", (error) =>
            isAwsTransactionCancelled(error.cause)
              ? Effect.succeed({
                  reasons: error.cause.CancellationReasons ?? [],
                  cause: error.cause,
                })
              : Effect.fail(error),
          ),
        )
        if (cancelled === undefined) break
        const outcome = cancelled.reasons

        const replacedAt = outcome.findIndex((reason) => reason?.Code === "ConditionalCheckFailed")
        if (replacedAt !== -1) {
          const replaced = chunk[replacedAt]!
          return yield* new ValidationError({
            entityType: replaced.entityType,
            operation: "batchWrite",
            cause:
              `Batch.write would replace an existing ${replaced.entityType} item. A versioned ` +
              "entity's replacing put continues the item's version (and snapshots / rotates it), " +
              "which needs the stored item — a batch write could only reset it to version 1. " +
              "Use the entity's put() or Transaction.transactWrite for it. Nothing in its chunk " +
              "of versioned puts, nor any " +
              "non-versioned request, was written; earlier chunks of versioned puts may have been.",
          })
        }

        // Only contention is retried; any other cancellation is a real failure.
        const retryable =
          outcome.length > 0 &&
          outcome.every(
            (reason) =>
              reason?.Code === undefined ||
              reason.Code === "None" ||
              reason.Code === "TransactionConflict" ||
              reason.Code === "ThrottlingError" ||
              reason.Code === "ProvisionedThroughputExceeded",
          )
        retries++
        if (!retryable || retries > maxRetries) {
          return yield* new DynamoError({
            operation: "TransactWriteItems",
            cause: new Error(
              `Batch.write versioned puts were cancelled: ${outcome
                .map((reason) =>
                  reason?.Message
                    ? `${reason.Code ?? "None"} (${reason.Message})`
                    : (reason?.Code ?? "None"),
                )
                .join(", ")}`,
              { cause: cancelled.cause },
            ),
          })
        }
        yield* Effect.sleep(`${baseDelayMs * 2 ** (retries - 1)} millis`)
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
