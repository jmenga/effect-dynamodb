/**
 * Transaction — TransactGetItems and TransactWriteItems for atomic multi-item operations.
 *
 * DynamoDB transactions support up to 100 items. TransactWriteItems costs 2x WCU.
 * Each item can appear only once per transaction.
 *
 * v2 API: accepts Entity operation intermediates directly (EntityGet, EntityPut,
 * EntityDelete) instead of manual { entity, key/item } objects.
 * transactGet returns a typed tuple inferred per-position.
 */

import {
  type ConcurrentModification,
  type ConditionalCheckFailed,
  DynamoError,
  type ItemNotFound,
  isAwsTransactionCancelled,
  type OptimisticLockError,
  type RefNotFound,
  TransactionCancelled,
  type TransactionOverflow,
  type UniqueConstraintViolation,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect, Function as Fn } from "effect"
import type { DynamoClient, DynamoClientError } from "./DynamoClient.js"
import type { TransactableInfo } from "./Entity.js"
import { extractTransactable } from "./Entity.js"
import type { ExpressionResult } from "./Expression.js"
import type { AnyGet, GetSuccess } from "./internal/BoundCrud.js"
import * as Capacity from "./internal/Capacity.js"
import { packedCompiledRefusal } from "./internal/Packed.js"
import {
  composePrimaryKey,
  getRejectReason,
  isProjectionTombstone,
  resolveTableNames,
} from "./internal/TransactableOps.js"
import {
  buildTransactWriteItems,
  type ConditionCheckOp,
  ConditionCheckTypeId,
  GUARDED_TRANSACTION_ATTEMPTS,
  judgeCancellation,
  planTransactWriteOps,
  type TransactWriteOp,
  type TransactWriteUpdateOp,
} from "./internal/TransactWriteOps.js"
import {
  type Diagnosis,
  diagnosedValidationError,
  diagnoseFailure,
  transactItemTarget,
  withCause,
} from "./internal/WriteDiagnosis.js"
import { fromAttributeMap, toAttributeMap } from "./Marshaller.js"
import type { TableConfig } from "./Table.js"

// ---------------------------------------------------------------------------
// ConditionCheck — composable from EntityGet + condition expression
//
// Defined in `internal/TransactWriteOps.ts` (shared with EventStore's
// `additionalItems`) and re-exported here so the public surface is unchanged.
// ---------------------------------------------------------------------------

export {
  ConditionCheckTypeId,
  type ConditionCheckOp,
  type TransactWriteOp,
  type TransactWriteUpdateOp,
}

/**
 * Create a conditionCheck operation from a get descriptor and a condition.
 * The descriptor is never executed — it is used purely as a typed key resolver.
 *
 * Accepts the unbound `EntityGet` intermediate or the `BoundGet` returned by
 * `db.entities.X.get(...)`. The bound form is the only read descriptor an
 * entity authored with the pure `@effect-dynamodb/schema` `Entity.make` can
 * produce, and a condition check on a row you are not writing is the standard
 * way to assert a cross-entity invariant inside one transaction (#108).
 *
 * Works in pipe: `Users.get(key).pipe(Transaction.check(expr))`
 * Or data-first: `Transaction.check(db.entities.Users.get(key), expr)`
 */
export const check: {
  (condition: ExpressionResult): (self: AnyGet) => ConditionCheckOp
  (self: AnyGet, condition: ExpressionResult): ConditionCheckOp
} = Fn.dual(2, (self: AnyGet, condition: ExpressionResult): ConditionCheckOp => {
  const info = extractTransactable(self)
  if (!info || info.opType !== "get") {
    // Sync API — there is no error channel to fail into, so this stays a throw.
    throw new Error(getRejectReason("Transaction.check"))
  }
  // A packed field may be tested only as a whole (`[EDD-9076]`, #147).
  const refused = packedCompiledRefusal(
    condition.expression,
    condition.names,
    info.entity._packedGuards ?? [],
    "condition check",
  )
  if (refused !== undefined) throw new Error(refused)
  return {
    [ConditionCheckTypeId]: ConditionCheckTypeId,
    _entity: info.entity,
    _key: info.key!,
    _condition: condition,
  }
})

// ---------------------------------------------------------------------------
// TransactGet — typed tuple return
// ---------------------------------------------------------------------------

/**
 * Map a tuple of get descriptors to a tuple of (A | undefined) results.
 * Each position extracts the model type A from whichever descriptor it holds.
 */
type TransactGetResult<T extends ReadonlyArray<AnyGet>> = {
  -readonly [K in keyof T]: GetSuccess<T[K]> | undefined
}

/**
 * Atomically get up to 100 items across entities/tables.
 * Returns a typed tuple where each position is `ModelType | undefined`.
 *
 * Accepts the unbound `EntityGet` intermediate or the `BoundGet` returned by
 * `db.entities.X.get(...)` — the latter is the only read descriptor available
 * for entities authored with the pure `@effect-dynamodb/schema` `Entity.make`
 * (#108).
 *
 * ```typescript
 * const [user, post] = yield* Transaction.transactGet([
 *   Users.get({ userId: "u-1" }),
 *   db.entities.Posts.get({ postId: "p-1" }),
 * ])
 * // user: User | undefined, post: Post | undefined
 * ```
 */
export const transactGet = <const T extends ReadonlyArray<AnyGet>>(
  items: T,
): Effect.Effect<
  TransactGetResult<T>,
  DynamoClientError | ValidationError | TransactionCancelled,
  DynamoClient | TableConfig
> => Capacity.operation("Transaction.transactGet", undefined, transactGetCore(items))

const transactGetCore = <const T extends ReadonlyArray<AnyGet>>(
  items: T,
): Effect.Effect<
  TransactGetResult<T>,
  DynamoClientError | ValidationError | TransactionCancelled,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    // Cast rationale: same as Batch.get — empty array satisfies any mapped tuple type
    if (items.length === 0) return [] as unknown as TransactGetResult<T>
    const client = yield* Capacity.client

    // Unwrap each position to its get descriptor. A rejection belongs on the
    // error channel, not as a defect — the caller can neither catch nor
    // discriminate a thrown Error.
    const infos: Array<TransactableInfo> = []
    for (const item of items) {
      const info = extractTransactable(item)
      if (!info || info.opType !== "get") {
        return yield* new ValidationError({
          entityType: "unknown",
          operation: "transactGet",
          cause: getRejectReason("Transaction.transactGet"),
        })
      }
      infos.push(info)
    }

    const tableNames = yield* resolveTableNames(infos)

    const transactItems = infos.map((info) => ({
      Get: {
        TableName: tableNames.get(info.entity)!,
        Key: toAttributeMap(composePrimaryKey(info.entity, info.key!)),
      },
    }))

    const result = yield* client.transactGetItems({ TransactItems: transactItems }).pipe(
      Effect.mapError((error) => {
        if (isAwsTransactionCancelled(error.cause)) {
          return new TransactionCancelled({
            operation: "TransactGetItems",
            reasons: (error.cause.CancellationReasons ?? []).map((r) => ({
              code: r?.Code,
              message: r?.Message,
            })),
            cause: error.cause,
          }) as DynamoClientError | TransactionCancelled
        }
        return error as DynamoClientError | TransactionCancelled
      }),
      // Over DynamoDB's 100 items, or one item read twice: rejected by
      // DynamoDB, confirmed against the request (#144).
      diagnoseFailure({
        sent: () => ({
          _tag: "TransactGet",
          count: transactItems.length,
          targets: () =>
            transactItems.map((item, index) => {
              const entity = infos[index]!.entity
              const primary = entity.indexes.primary!
              return transactItemTarget(
                item,
                item.Get.TableName,
                [primary.pk.field, primary.sk.field],
                entity.entityType,
                `get ${index} (${entity.entityType})`,
              )
            }),
        }),
        rewrite: (diagnosis, original) =>
          diagnosis._tag === "TooManyItems"
            ? new DynamoError({
                operation: "TransactGetItems",
                cause: withCause(
                  `TransactGetItems supports a maximum of ${diagnosis.limit} items; ` +
                    `the request holds ${diagnosis.count}`,
                  original,
                ),
              })
            : diagnosis._tag === "RepeatedItem"
              ? new DynamoError({
                  operation: "TransactGetItems",
                  cause: withCause(
                    `TransactGetItems reads one item more than once — ${diagnosis.first.source} ` +
                      `and ${diagnosis.second.source} both read the item at ` +
                      `${diagnosis.second.key}. DynamoDB allows one operation per item in a ` +
                      "transaction, and rejected it. Read the item once.",
                    original,
                  ),
                })
              : (original as DynamoClientError),
      }),
    )

    const responses = result.Responses ?? []
    const decoded: Array<unknown> = []

    for (let i = 0; i < infos.length; i++) {
      const response = responses[i]
      const entity = infos[i]!.entity
      // A projection tombstone (#154) is no row.
      const raw =
        response?.Item && !isProjectionTombstone(response.Item, entity.entityType)
          ? fromAttributeMap(response.Item)
          : undefined

      if (raw === undefined) {
        decoded.push(undefined)
        continue
      }

      const item = yield* entity._decodeRecord(raw)
      decoded.push(item)
    }

    // Cast rationale: decoded is built as Array<A | undefined> by iterating
    // Responses in order. The mapped tuple type captures per-position entity types
    // which the runtime array construction preserves but TypeScript cannot verify.
    return decoded as unknown as TransactGetResult<T>
  })

// ---------------------------------------------------------------------------
// TransactWrite — accepts Entity operation intermediates
// ---------------------------------------------------------------------------

/**
 * Atomically write up to 100 items across entities/tables.
 * Accepts EntityPut, EntityDelete, and ConditionCheckOp (via Transaction.check).
 *
 * A put of a versioned or unique-constrained entity is guarded, exactly as the
 * entity's own `put` (#133): the item is read first, a replaced item continues
 * its version, incarnation and `createdAt` (and is snapshotted under `retain`),
 * a created one continues after any retained history, and changed unique
 * values rotate their sentinels — releasing only those the item owns. A race
 * between that read and the transaction (or retained history the read did not
 * see) cancels the transaction, which is then built and written again; a race
 * lost on every attempt fails with `OptimisticLockError` /
 * `ConcurrentModification`. A caller's own condition failing is
 * `TransactionCancelled`; a taken unique value is `UniqueConstraintViolation`.
 *
 * DynamoDB's rules are not pre-checked (#144): a transaction breaking one is
 * sent, rejected whole, and reported naming the culprit — over 100 items
 * (counted after expansion) as `DynamoError`; two ops touching one item, an
 * oversized item, a payload over 4 MB, a sort key over 1024 bytes or a
 * condition over DynamoDB's expression limits as `ValidationError` — with
 * DynamoDB's error as the cause. Nothing is written, and a repeated item is
 * never retried as a lost race.
 *
 * **Updates and multi-item deletes.** An `update` (or `patch`), and a delete of
 * an entity with `unique`, `versioned: { retain: true }` or `softDelete`, write
 * exactly what the same op writes on its own: the op is run with its write
 * recorded instead of sent, and the recorded items join the transaction —
 * guarded, sentinel rotations and releases, snapshot and tombstone included.
 * Each reads first wherever the standalone op does, so the read's outcomes
 * surface before anything is sent: `ItemNotFound`, `ConditionalCheckFailed`
 * (`patch` of a missing item), `OptimisticLockError` (a stale
 * `expectedVersion`), `RefNotFound`. A race with that read is retried as for a
 * guarded put. Refused: an update `.cascade()` (EDD-9059), `.returnValues()`
 * that returns an item (EDD-9060), and an update of a vector-indexed entity
 * (EDD-9061).
 *
 * ```typescript
 * yield* Transaction.transactWrite([
 *   Users.put({ userId: "u-1", ... }),
 *   Users.update({ userId: "u-2" }).pipe(Entity.set({ email: "b@example.com" })),
 *   Posts.delete({ postId: "p-3" }),
 *   Users.get({ userId: "u-1" }).pipe(Transaction.check(expr)),
 * ])
 * ```
 */
export const transactWrite = (
  operations: ReadonlyArray<TransactWriteOp | TransactWriteUpdateOp>,
): Effect.Effect<
  void,
  | DynamoClientError
  | ValidationError
  | TransactionCancelled
  | UniqueConstraintViolation
  | OptimisticLockError
  | ConcurrentModification
  | ConditionalCheckFailed
  | ItemNotFound
  | TransactionOverflow
  | RefNotFound,
  DynamoClient | TableConfig
> => Capacity.operation("Transaction.transactWrite", undefined, transactWriteCore(operations))

const transactWriteCore = (
  operations: ReadonlyArray<TransactWriteOp | TransactWriteUpdateOp>,
): Effect.Effect<
  void,
  | DynamoClientError
  | ValidationError
  | TransactionCancelled
  | UniqueConstraintViolation
  | OptimisticLockError
  | ConcurrentModification
  | ConditionalCheckFailed
  | ItemNotFound
  | TransactionOverflow
  | RefNotFound,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    if (operations.length === 0) return

    const client = yield* Capacity.client
    let lost: OptimisticLockError | ConcurrentModification | undefined
    for (let attempt = 0; attempt < GUARDED_TRANSACTION_ATTEMPTS; attempt++) {
      // Planned every attempt: a lost race is planned again from fresh reads.
      const plans = yield* planTransactWriteOps(operations)
      const built = yield* buildTransactWriteItems(operations, "transactWrite", { plans })
      const transactItems = built.items
      // Every op resolved to no write — as a standalone no-op update does.
      // DynamoDB rejects an empty TransactItems list.
      if (transactItems.length === 0) return

      // Named once, for both diagnoses below.
      const sent = () => ({
        _tag: "Transaction" as const,
        items: transactItems,
        targets: built.targets,
      })
      const diagnosed = (diagnosis: Diagnosis, original: unknown) =>
        diagnosis._tag === "TooManyItems"
          ? new DynamoError({
              operation: "TransactWriteItems",
              cause: withCause(
                `TransactWriteItems supports a maximum of ${diagnosis.limit} items; ` +
                  `${operations.length} operation(s) expanded to ${diagnosis.count} items ` +
                  "(uniqueness sentinels and version snapshots each occupy one)",
                original,
              ),
            })
          : diagnosedValidationError(diagnosis, original, {
              operation: "transactWrite",
              entityType: "unknown",
            })

      const outcome = yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
        Effect.as(undefined),
        // One operation per item (#133, #144): a transaction that touches one
        // item twice is DynamoDB's to reject, and is diagnosed BEFORE the
        // conditional mapping — DynamoDB can report a repeat as a conditional
        // failure, which would read as a lost race and be retried.
        diagnoseFailure({ sent, only: ["RepeatedItem"], rewrite: diagnosed }),
        Effect.catch(
          (
            error: DynamoClientError | ValidationError,
          ): Effect.Effect<
            OptimisticLockError | ConcurrentModification,
            DynamoClientError | ValidationError | UniqueConstraintViolation | TransactionCancelled
          > => {
            if (!isAwsTransactionCancelled(error.cause)) return Effect.fail(error)
            const rawReasons = error.cause.CancellationReasons ?? []
            const judged = judgeCancellation(built, rawReasons)
            // A taken unique value or a history conflict is precisely what the
            // entity's own `put` reports for the same item.
            if (judged?._tag === "fail") return Effect.fail(judged.error)
            if (judged?._tag === "retry") return Effect.succeed(judged.error)
            return Effect.fail(
              new TransactionCancelled({
                operation: "TransactWriteItems",
                reasons: rawReasons.map((r) => ({ code: r?.Code, message: r?.Message })),
                cause: error.cause,
              }),
            )
          },
        ),
        // DynamoDB's limits are not pre-checked: a rejection is diagnosed
        // here, after the conditional mapping, naming the item at fault. The
        // 100-item limit counts the EXPANDED items — one op can emit several
        // (uniqueness sentinels, version snapshots) — and keeps its #113 tag.
        diagnoseFailure({ sent, keys: built.keys, rewrite: diagnosed }),
      )
      if (outcome === undefined) return
      lost = outcome
    }
    return yield* Effect.fail(lost!)
  })
