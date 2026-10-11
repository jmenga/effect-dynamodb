/**
 * Batch — BatchGetItem and BatchWriteItem with auto-chunking and retry.
 *
 * DynamoDB limits: BatchGetItem max 100 keys, BatchWriteItem max 25 items.
 * Both can return unprocessed items that must be retried.
 *
 * Accepts Entity operation intermediates directly (EntityGet, EntityPut, EntityDelete).
 * Batch.get returns a typed tuple inferred per-position.
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import {
  DynamoError,
  isAwsTransactionCancelled,
  TRANSACT_WRITE_ITEMS_LIMIT,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import { DynamoClient, type DynamoClientError } from "./DynamoClient.js"
import type { EntityDelete, EntityPut, TransactableInfo } from "./Entity.js"
import { extractTransactable } from "./Entity.js"
import type { AnyGet, BoundWriteOp, GetSuccess } from "./internal/BoundCrud.js"
import { BASE_DELAY_MS, batchGetRaw, MAX_RETRIES } from "./internal/Hydrate.js"
import { TRANSACT_WRITE_MAX_BYTES, transactItemBytes } from "./internal/ItemSize.js"
import {
  batchRejectReason,
  composePrimaryKey,
  getRejectReason,
  rejectUnsupportedOp,
  resolveTableNames,
  validateAndBuildPutItem,
} from "./internal/TransactableOps.js"
import {
  batchEntries,
  diagnosedValidationError,
  diagnoseFailure,
  rangeKeysOf,
  transactItemTarget,
} from "./internal/WriteDiagnosis.js"
import { fromAttributeMap, toAttributeMap } from "./Marshaller.js"
import type { TableConfig } from "./Table.js"

const MAX_BATCH_WRITE = 25

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

    // Compose each position's primary key. `BatchGetItem` does not preserve
    // order, so `batchGetRaw` matches responses back to positions by key.
    const requests = infos.map((info) => ({
      tableName: tableNames.get(info.entity)!,
      key: toAttributeMap(composePrimaryKey(info.entity, info.key!)),
    }))
    const fetched = yield* batchGetRaw(client, requests, { maxRetries, baseDelayMs })

    const results: Array<unknown> = new Array(items.length).fill(undefined)
    for (let i = 0; i < fetched.length; i++) {
      const item = fetched[i]
      if (item === undefined) continue
      results[i] = yield* infos[i]!.entity._decodeRecord(fromAttributeMap(item))
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

/**
 * Union accepted by `Batch.write`. Bound-CRUD builders
 * (`db.entities.X.put(...)` / `.delete(...)`) are accepted alongside the unbound
 * intermediates — they are the only write descriptor available for entities
 * authored with the pure, AWS-free `@effect-dynamodb/schema` `Entity.make`
 * (#100).
 */
type BatchWriteOp = EntityPut<any, any, any, any> | EntityDelete<any, any> | BoundWriteOp

/** A versioned put, sent as a create-only `TransactWriteItems` Put (#133). */
type VersionedPut = {
  readonly tableName: string
  readonly entityType: string
  readonly transactItem: TransactWriteItem
  /** Primary key and every sort-key attribute, to name a rejected item (#144). */
  readonly keyFields: ReadonlyArray<string>
  readonly rangeKeys: () => ReadonlyArray<string>
  /** Its exact contribution to a transaction's size (`transactItemBytes`). */
  readonly bytes: number
}

/**
 * Versioned puts in caller order, chunked greedily into transactions of at
 * most {@link TRANSACT_WRITE_ITEMS_LIMIT} actions and
 * {@link TRANSACT_WRITE_MAX_BYTES} bytes — DynamoDB's own limits, exactly, by
 * the exact size model. Chunking picks request boundaries; it refuses nothing.
 * One put always fits alone: its item is at most 409,600 bytes, or DynamoDB
 * rejects it as too large.
 */
const chunkVersionedPuts = (
  puts: ReadonlyArray<VersionedPut>,
): ReadonlyArray<ReadonlyArray<VersionedPut>> => {
  const chunks: Array<Array<VersionedPut>> = []
  let bytes = 0
  for (const put of puts) {
    const last = chunks[chunks.length - 1]
    if (
      last === undefined ||
      last.length >= TRANSACT_WRITE_ITEMS_LIMIT ||
      bytes + put.bytes > TRANSACT_WRITE_MAX_BYTES
    ) {
      chunks.push([put])
      bytes = put.bytes
    } else {
      last.push(put)
      bytes += put.bytes
    }
  }
  return chunks
}

/** What a batch had written when its versioned-put chunk `index` failed, as a clause. */
const committedBefore = (
  chunks: ReadonlyArray<ReadonlyArray<VersionedPut>>,
  index: number,
): string => {
  const unsent = "none of the batch's non-versioned requests was sent"
  if (index === 0) return `no earlier transaction of the batch was written, and ${unsent}`
  const items = chunks.slice(0, index).reduce((sum, chunk) => sum + chunk.length, 0)
  return (
    `the batch's ${index} earlier transaction${index === 1 ? "" : "s"} of versioned puts ` +
    `(${items} item${items === 1 ? "" : "s"}) ${index === 1 ? "was" : "were"} already ` +
    `written, and ${unsent}`
  )
}

/**
 * What a batch had written when one of its `BatchWriteItem` requests (the
 * non-versioned requests, after every versioned-put chunk) was rejected, as a
 * clause: its versioned-put transactions, the `written` non-versioned requests
 * of earlier calls (earlier chunks, and this chunk's requests written before
 * an unprocessed-items retry), and the `unsent` requests after this chunk.
 */
const committedBeforeRequest = (
  versionedChunks: ReadonlyArray<ReadonlyArray<VersionedPut>>,
  written: number,
  unsent: number,
): string => {
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
  const parts: Array<string> = []
  if (versionedChunks.length > 0) {
    const items = versionedChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    parts.push(
      `its ${plural(versionedChunks.length, "transaction")} of versioned puts ` +
        `(${plural(items, "item")})`,
    )
  }
  if (written > 0) parts.push(plural(written, "non-versioned request"))
  const wrote =
    parts.length === 0
      ? "the batch had written nothing before it"
      : `the batch had already written ${parts.join(" and ")}`
  return unsent === 0
    ? wrote
    : `${wrote}, and its ${plural(unsent, "later request")} ${unsent === 1 ? "was" : "were"} not sent`
}

/**
 * Batch-write any number of items across entities/tables.
 * Auto-chunks at 25 items per request. Retries unprocessed items
 * with exponential backoff.
 *
 * Puts of a `versioned` entity are sent first, as create-only
 * `TransactWriteItems` (`attribute_not_exists`), chunked at exactly DynamoDB's
 * limits: 100 actions and 4,194,304 bytes by DynamoDB's size accounting. A
 * batch put cannot continue an existing item's version, so one that would
 * replace an item fails with a `ValidationError` and its chunk writes nothing
 * (the entity's `put` and `Transaction.transactWrite` replace it). Each chunk
 * costs twice the write capacity of a batch write. Should DynamoDB reject a
 * chunk's size all the same, the batch fails with a `ValidationError` giving
 * both the library's measure and DynamoDB's, and what was already written; the
 * chunk is not re-split.
 *
 * An item over DynamoDB's 400 KB, or a sort key over 1024 bytes, is not
 * pre-checked (#144): DynamoDB rejects its request, and the batch fails with a
 * `ValidationError` naming the item, with DynamoDB's error as the cause. The
 * batch is not atomic: the message says exactly what it had already written.
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
    const versionedPuts: Array<VersionedPut> = []
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
      entityType: string
      keyFields: ReadonlyArray<string>
      rangeKeys: () => ReadonlyArray<string>
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
      const primary = entity.indexes.primary!
      const keyFields = [primary.pk.field, primary.sk.field]
      const rangeKeys = () => rangeKeysOf(entity.indexes as never)

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
          const transactItem: TransactWriteItem = {
            Put: {
              TableName: tableName,
              Item: built.marshalled,
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": entity.indexes.primary!.pk.field },
            },
          }
          versionedPuts.push({
            tableName,
            entityType: entity.entityType,
            transactItem,
            keyFields,
            rangeKeys,
            // Exact, condition and its name included: what DynamoDB counts
            // toward the transaction's 4 MB (#144).
            bytes: transactItemBytes(transactItem),
          })
        } else {
          writeRequests.push({
            tableName,
            request: { PutRequest: { Item: built.marshalled } },
            entityType: entity.entityType,
            keyFields,
            rangeKeys,
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
          entityType: entity.entityType,
          keyFields,
          rangeKeys,
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

    // Versioned puts first, as create-only transactions. Each chunk is atomic;
    // a chunk that would replace an existing item writes nothing and stops the
    // batch before any later chunk or the plain requests below.
    const versionedChunks = chunkVersionedPuts(versionedPuts)
    for (const [chunkIndex, chunk] of versionedChunks.entries()) {
      const transactItems: Array<TransactWriteItem> = chunk.map((put) => put.transactItem)
      const committed = committedBefore(versionedChunks, chunkIndex)

      let retries = 0
      while (true) {
        const cancelled = yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
          Effect.as(undefined),
          // A limit DynamoDB enforced (#144) — an oversized item, the 4 MB
          // payload, an over-long sort key — named. Such a rejection carries no
          // conditional failure, so it is never read as a replacing put.
          diagnoseFailure({
            sent: () => ({
              _tag: "Transaction",
              items: transactItems,
              targets: () =>
                chunk.map((put, index) =>
                  transactItemTarget(
                    transactItems[index]!,
                    put.tableName,
                    put.keyFields,
                    put.entityType,
                    `the versioned put of ${put.entityType}`,
                  ),
                ),
            }),
            rangeKeys: () => [...new Set(chunk.flatMap((put) => put.rangeKeys()))],
            // Chunked to fit by the exact size model: should DynamoDB still
            // reject the payload, the error gives both sizes — never re-split
            // nor retried — and says exactly what the batch already wrote.
            rewrite: (diagnosis, original) =>
              diagnosedValidationError(diagnosis, original, {
                operation: "batchWrite",
                entityType: chunk[0]!.entityType,
                committed,
              }),
          }),
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
              "Use the entity's put() or Transaction.transactWrite for it. Nothing in its " +
              `transaction of versioned puts was written; ${committed}.`,
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
        const sentItems = requestItems
        // What the batch had written before this request: every versioned
        // chunk, the earlier chunks, and this chunk's requests processed on
        // earlier attempts (all but the unprocessed ones being retried).
        const sentCount = Object.values(sentItems).reduce(
          (sum, requests) => sum + requests.length,
          0,
        )
        const committed = committedBeforeRequest(
          versionedChunks,
          chunkStart + chunk.length - sentCount,
          writeRequests.length - chunkStart - chunk.length,
        )
        const response = yield* client.batchWriteItem({ RequestItems: sentItems }).pipe(
          // An oversized item or over-long sort key (#144), named, with what
          // the batch had already written: Batch.write was never atomic.
          diagnoseFailure({
            sent: () => {
              // The request's entries, in request order, matched back to the
              // batch's own records (by request object) to name them.
              const sources = new Map(chunk.map((item) => [item.request, item]))
              const ordered = Object.values(sentItems).flatMap((requests) =>
                requests.map((request) => sources.get(request)),
              )
              const items = batchEntries(sentItems)
              return {
                _tag: "Batch",
                items,
                targets: () =>
                  items.map((item, index) => {
                    const source = ordered[index]
                    return transactItemTarget(
                      item,
                      source?.tableName ?? "",
                      source?.keyFields ?? [],
                      source?.entityType ?? "unknown",
                      source === undefined
                        ? `request ${index} of the batch`
                        : `the ${item.Put !== undefined ? "put" : "delete"} of ${source.entityType}`,
                    )
                  }),
              }
            },
            rangeKeys: () => [...new Set(chunk.flatMap((item) => item.rangeKeys()))],
            rewrite: (diagnosis, original) =>
              diagnosedValidationError(diagnosis, original, {
                operation: "batchWrite",
                entityType: chunk[0]?.entityType ?? "unknown",
                committed,
              }),
          }),
        )

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
