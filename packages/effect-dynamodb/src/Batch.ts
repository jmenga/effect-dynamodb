/**
 * Batch — BatchGetItem and BatchWriteItem with auto-chunking and retry.
 *
 * DynamoDB limits: BatchGetItem max 100 keys, BatchWriteItem max 25 items and
 * 16 MB of request body.
 * Both can return unprocessed items that must be retried.
 *
 * Accepts Entity operation intermediates directly (EntityGet, EntityPut, EntityDelete).
 * Batch.get returns a typed tuple inferred per-position.
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import {
  type BlobStoreError,
  DynamoError,
  isAwsTransactionCancelled,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import type { DynamoClient, DynamoClientError } from "./DynamoClient.js"
import type { EntityDelete, EntityPut, TransactableInfo } from "./Entity.js"
import { extractTransactable } from "./Entity.js"
import { expiredWithCommitted } from "./internal/BlobCalls.js"
import * as BlobLedger from "./internal/BlobLedger.js"
import type {
  AnyGet,
  BoundWriteOp,
  GetBlobErrors,
  GetSuccess,
  WriteOpBlobErrors,
} from "./internal/BoundCrud.js"
import * as Capacity from "./internal/Capacity.js"
import { BASE_DELAY_MS, batchGetRaw, MAX_RETRIES } from "./internal/Hydrate.js"
import {
  batchWriteShape,
  batchWriteUnit,
  packRequests,
  transactWriteShape,
  transactWriteUnit,
} from "./internal/ItemSize.js"
import { forEachSettled } from "./internal/OffloadWrite.js"
import {
  batchRejectReason,
  composePrimaryKeyOrFail,
  getRejectReason,
  isProjectionTombstone,
  loadGetRows,
  marshalPutItem,
  rejectUnsupportedOp,
  resolveTableNames,
  underCaptured,
  validateAndBuildPutItem,
} from "./internal/TransactableOps.js"
import {
  batchEntries,
  diagnosedValidationError,
  diagnoseFailure,
  type KeyAttributes,
  keyAttributesOf,
  mergeKeyAttributes,
  transactItemTarget,
} from "./internal/WriteDiagnosis.js"
import { fromAttributeMap, toAttributeMap } from "./Marshaller.js"
import type { TableConfig } from "./Table.js"

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
  DynamoClientError | ValidationError | GetBlobErrors<T[number]>,
  DynamoClient | TableConfig
> =>
  Capacity.operation("Batch.get", undefined, getCore(items, config)) as Effect.Effect<
    BatchGetResult<T>,
    DynamoClientError | ValidationError | GetBlobErrors<T[number]>,
    DynamoClient | TableConfig
  >

const getCore = <const T extends ReadonlyArray<AnyGet>>(
  items: T,
  config?: BatchRetryConfig,
): Effect.Effect<
  BatchGetResult<T>,
  DynamoClientError | ValidationError | BlobStoreError,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    const maxRetries = config?.maxRetries ?? MAX_RETRIES
    const baseDelayMs = config?.baseDelayMs ?? BASE_DELAY_MS
    // Cast rationale: empty array [] is a valid tuple for any BatchGetResult<T>.
    // TypeScript cannot infer that [] satisfies a mapped tuple type, so we cast.
    if (items.length === 0) return [] as unknown as BatchGetResult<T>

    const client = yield* Capacity.client

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
    const requests = yield* Effect.forEach(infos, (info) =>
      Effect.map(composePrimaryKeyOrFail(info.entity, info.key!, "batchGet"), (key) => ({
        tableName: tableNames.get(info.entity)!,
        key: toAttributeMap(key),
      })),
    )
    const fetched = yield* batchGetRaw(client, requests, {
      maxRetries,
      baseDelayMs,
      // A key repeated in one request is DynamoDB's to reject (#144): named by position.
      describe: (position) => {
        const entityType = infos[position]!.entity.entityType
        return { entityType, source: `get ${position} (${entityType})` }
      },
    })

    const rows: Array<Record<string, unknown> | undefined> = fetched.map((item, i) =>
      // A projection tombstone (#154) is no row.
      item === undefined || isProjectionTombstone(item, infos[i]!.entity.entityType)
        ? undefined
        : (fromAttributeMap(item) as Record<string, unknown>),
    )
    // Offloaded fields (#179): every get's rows resolve together, per entity
    // and per the get's own modes, before any decode.
    yield* loadGetRows(infos, rows, "Batch.get")
    const results: Array<unknown> = new Array(items.length).fill(undefined)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row === undefined) continue
      const info = infos[i]!
      // Under a bound get's captured services (§3.6), as its row was loaded.
      results[i] = yield* underCaptured(
        info.captured,
        info.entity._decodeRecord(row, info.offloadModes, "Batch.get.decode"),
      )
    }

    // Cast rationale: results is built as Array<A | undefined> by matching DynamoDB
    // responses back to input positions via primary key comparison. The mapped tuple
    // type BatchGetResult<T> captures per-position entity types, but the runtime
    // array construction can't express this statically.
    return results as unknown as BatchGetResult<T>
  })

// ---------------------------------------------------------------------------
// Batch.write — split at 25 items and 16 MB, retry unprocessed
// ---------------------------------------------------------------------------

/**
 * Union accepted by `Batch.write`. Bound-CRUD builders
 * (`db.entities.X.put(...)` / `.delete(...)`) are accepted alongside the unbound
 * intermediates — they are the only write descriptor available for entities
 * authored with the pure, AWS-free `@effect-dynamodb/schema` `Entity.make`
 * (#100).
 */
type BatchWriteOp =
  // The trailing `any`: an op's offload state (#179) — an offloading member's ops too.
  EntityPut<any, any, any, any, any> | EntityDelete<any, any, void, unknown, any> | BoundWriteOp

/** A versioned put, sent as a create-only `TransactWriteItems` Put (#133). */
type VersionedPut = {
  readonly tableName: string
  readonly entityType: string
  readonly transactItem: TransactWriteItem
  /** Primary key and every sort-key attribute, to name a rejected item (#144). */
  readonly keyFields: ReadonlyArray<string>
  readonly keys: () => KeyAttributes
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
 * Splits the writes into `BatchWriteItem` requests of at most 25 items and
 * 16,777,216 bytes of request body (the JSON sent, where a control character in
 * a string takes 6 bytes and a quote 2, though each counts 1 toward an item's
 * size). Retries unprocessed items with exponential backoff.
 *
 * Puts of a `versioned` entity are sent first, as create-only
 * `TransactWriteItems` (`attribute_not_exists`), split at exactly DynamoDB's
 * limits: 100 actions, 4,194,304 bytes by DynamoDB's size accounting, and
 * 16,777,216 bytes of request body. A
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
 * **Offloaded fields** (#179). Every put routes and uploads its entity's
 * offloaded values before any request is sent — a bound builder's to the
 * blob store (and packed with the compressors) its `DynamoClient.make`
 * bundled. Each upload settles by the requests that carry its pointer: kept
 * once one of them is processed; deleted when the batch exits if DynamoDB
 * provably applied none of them (refused, or left unprocessed by a response
 * the SDK sent once, or a cancelled transaction of versioned puts); otherwise
 * kept and reported to the `Offload.layerObserver` observer. An upload older
 * than the store's `maxUploadAge` when its request is due fails the batch with
 * `BlobStoreError { reason: "Expired" }`, saying what the batch had already
 * written. An op over a member that offloads a field adds `BlobStoreError` to
 * the error type; a plain op, or one typed `any`, adds nothing.
 *
 * ```typescript
 * yield* Batch.write([
 *   Users.put({ userId: "u-3", ... }),
 *   Posts.delete({ postId: "p-1" }),
 * ])
 * ```
 */
export const write = <const T extends ReadonlyArray<BatchWriteOp>>(
  operations: T,
  config?: BatchRetryConfig,
): Effect.Effect<
  void,
  DynamoClientError | ValidationError | WriteOpBlobErrors<T[number]>,
  DynamoClient | TableConfig
> =>
  Capacity.operation(
    "Batch.write",
    undefined,
    BlobLedger.root(writeCore(operations, config)),
  ) as Effect.Effect<
    void,
    DynamoClientError | ValidationError | WriteOpBlobErrors<T[number]>,
    DynamoClient | TableConfig
  >

/** One op of a batch, built: its item (a put) or key (a delete), and what names it. */
type BuiltWrite = {
  readonly tableName: string
  readonly entity: TransactableInfo["entity"]
  readonly keyFields: ReadonlyArray<string>
  readonly keys: () => KeyAttributes
  /** The table and composed primary key, as one string: the same item, the same id. */
  readonly id: string
} & (
  | {
      readonly kind: "put"
      readonly item: Record<string, unknown>
      /** The item as built: what an entity that offloads nothing stores. */
      readonly marshalled: Record<string, AttributeValue>
      readonly captured: TransactableInfo["captured"]
    }
  | {
      readonly kind: "delete"
      readonly key: Record<string, AttributeValue>
    }
)

const writeCore = (
  operations: ReadonlyArray<BatchWriteOp>,
  config?: BatchRetryConfig,
): Effect.Effect<
  void,
  DynamoClientError | ValidationError | BlobStoreError,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    if (operations.length === 0) return
    const maxRetries = config?.maxRetries ?? MAX_RETRIES
    const baseDelayMs = config?.baseDelayMs ?? BASE_DELAY_MS

    const client = yield* Capacity.client

    const idOf = (
      tableName: string,
      entity: TransactableInfo["entity"],
      item: Readonly<Record<string, unknown>>,
    ) => {
      const primary = entity.indexes.primary!
      return JSON.stringify([tableName, item[primary.pk.field], item[primary.sk.field]])
    }

    // 1. Build every op — local work only, so a refused op (the checks below,
    //    an invalid input) leaves nothing uploaded.
    const built: Array<BuiltWrite> = []
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
      // A provided shard table (#287) comes from the context the op runs in (its binding's, for a
      // bound builder): one missing is `EDD-9181` before anything is sent, a delete's included.
      yield* underCaptured(
        info.captured,
        Effect.sync(() => info.entity._requireShardTables?.("batchWrite")),
      )

      const entity = info.entity
      const { name: tableName } = yield* entity._tableTag
      const primary = entity.indexes.primary!
      const keyFields = [primary.pk.field, primary.sk.field]
      const keys = () => keyAttributesOf(entity.indexes as never)

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
        // Packed under the op's captured compressor registry, when it is a
        // bound builder (§3.6): a compressor given only to `DynamoClient.make`
        // reaches it.
        const { item, marshalled } = yield* underCaptured(
          info.captured,
          validateAndBuildPutItem(entity, info.input!, "batchWrite.put"),
        )
        built.push({
          kind: "put",
          tableName,
          entity,
          keyFields,
          keys,
          id: idOf(tableName, entity, item),
          item,
          marshalled,
          captured: info.captured,
        })
      } else if (info.opType === "delete") {
        yield* rejectUnsupportedOp(entity, "batchWrite", "delete", undefined)
        const composed = yield* composePrimaryKeyOrFail(entity, info.key!, "batchWrite.delete")
        built.push({
          kind: "delete",
          tableName,
          entity,
          keyFields,
          keys,
          id: idOf(tableName, entity, composed),
          key: toAttributeMap(composed),
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

    // Every key the batch touches, to refuse one touched twice when a versioned
    // put is involved: its put runs in an earlier transaction than the batch's
    // other requests, so a repeated key would be reordered or misreported.
    const touched = new Map<string, number>()
    for (const write of built) touched.set(write.id, (touched.get(write.id) ?? 0) + 1)
    for (const write of built) {
      if (write.kind !== "put" || !write.entity._incarnationToken) continue
      if ((touched.get(write.id) ?? 0) > 1) {
        return yield* new ValidationError({
          entityType: write.entity.entityType,
          operation: "batchWrite",
          cause:
            "Batch.write touches the same item more than once alongside a versioned put. " +
            "Versioned puts are written as separate create-only transactions, so the batch's " +
            "operations on that item could not keep their order. Nothing was written.",
        })
      }
    }

    // 2. Offloaded fields (#179, design §6.6): every put routes and uploads —
    //    under its captured blob store when it is a bound builder (§3.6) —
    //    before any request is sent. The uploads are the batch's ledger's: each
    //    settles by the request that carries its pointer. A failed upload
    //    fails the batch once the others have settled; nothing was sent.
    yield* forEachSettled(
      built.filter((write) => write.kind === "put" && write.entity._offloads),
      (write) =>
        write.kind === "put"
          ? Effect.asVoid(
              underCaptured(
                write.captured,
                write.entity._offloadItem(write.item, write.tableName, "batchWrite.put"),
              ),
            )
          : Effect.void,
    )

    // 3. The requests.
    const versionedPuts: Array<VersionedPut> = []
    type WriteRequest = {
      tableName: string
      request: Record<string, any>
      entityType: string
      keyFields: ReadonlyArray<string>
      keys: () => KeyAttributes
    }
    const writeRequests: Array<WriteRequest> = []
    for (const write of built) {
      const { tableName, entity, keyFields, keys } = write
      if (write.kind === "delete") {
        writeRequests.push({
          tableName,
          request: { DeleteRequest: { Key: write.key } },
          entityType: entity.entityType,
          keyFields,
          keys,
        })
        continue
      }
      // Routed above when the entity offloads a field: marshalled again.
      const marshalled = entity._offloads
        ? yield* marshalPutItem(entity, write.item, "batchWrite.put")
        : write.marshalled
      // A versioned entity's put over an existing item continues its version
      // (#133), which a blind BatchWriteItem cannot — it would reset the item
      // to version 1 under a new incarnation. Such puts go out as create-only
      // TransactWriteItems Puts (`attribute_not_exists`) instead: no read, no
      // window between a check and the write.
      if (entity._incarnationToken) {
        const transactItem: TransactWriteItem = {
          Put: {
            TableName: tableName,
            Item: marshalled,
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": entity.indexes.primary!.pk.field },
          },
        }
        versionedPuts.push({
          tableName,
          entityType: entity.entityType,
          transactItem,
          keyFields,
          keys,
        })
      } else {
        writeRequests.push({
          tableName,
          request: { PutRequest: { Item: marshalled } },
          entityType: entity.entityType,
          keyFields,
          keys,
        })
      }
    }

    // What the client sends beside each request's items, counted toward the
    // request's 16 MB body.
    const fields = yield* Capacity.requestFields

    // Versioned puts first, as create-only transactions, split at DynamoDB's
    // limits on one transaction — 100 actions, 4 MB of item size (the
    // condition and its name included, #144), 16 MB of body. One put always
    // fits alone: its item is at most 409,600 bytes, or DynamoDB rejects it as
    // too large. Each chunk is atomic; a chunk that would replace an existing
    // item writes nothing and stops the batch before any later chunk or the
    // plain requests below.
    const versionedChunks = packRequests(
      versionedPuts,
      (put) => transactWriteUnit([put.transactItem]),
      transactWriteShape(fields),
    )
    for (const [chunkIndex, chunk] of versionedChunks.entries()) {
      const transactItems: Array<TransactWriteItem> = chunk.map((put) => put.transactItem)
      const committed = committedBefore(versionedChunks, chunkIndex)

      let retries = 0
      while (true) {
        const cancelled = yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
          Effect.mapError((error) => expiredWithCommitted(error, committed)),
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
            keys: () => mergeKeyAttributes(...chunk.map((put) => put.keys())),
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

    // Split at DynamoDB's limits on one BatchWriteItem request: 25 requests and
    // 16 MB of body. A batch within both is split by its count alone.
    const chunks = packRequests(
      writeRequests,
      (request) => batchWriteUnit(request.tableName, request.request),
      batchWriteShape(fields),
    )
    let chunkStart = 0
    for (const chunk of chunks) {
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
          Effect.mapError((error) => expiredWithCommitted(error, committed)),
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
            keys: () => mergeKeyAttributes(...chunk.map((item) => item.keys())),
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
      chunkStart += chunk.length
    }
  })
