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

import { Effect, Function as Fn, Schema } from "effect"
import { DynamoClient, type DynamoClientError } from "./DynamoClient.js"
import type { Entity, EntityDelete, EntityGet, EntityPut } from "./Entity.js"
import { extractTransactable } from "./Entity.js"
import {
  DynamoError,
  isAwsTransactionCancelled,
  TransactionCancelled,
  ValidationError,
} from "./Errors.js"
import type { ExpressionResult } from "./Expression.js"
import {
  composePrimaryKey,
  resolveTableNames,
  validateAndBuildPutItem,
} from "./internal/TransactableOps.js"
import { fromAttributeMap, toAttributeMap } from "./Marshaller.js"
import type { TableConfig } from "./Table.js"

// ---------------------------------------------------------------------------
// ConditionCheck — composable from EntityGet + condition expression
// ---------------------------------------------------------------------------

/** @internal */
export const ConditionCheckTypeId: unique symbol = Symbol.for("effect-dynamodb/ConditionCheck")
export type ConditionCheckTypeId = typeof ConditionCheckTypeId

/**
 * A condition-check operation for use inside {@link transactWrite}.
 * Created via {@link check} from an EntityGet intermediate + a condition expression.
 * The EntityGet is never executed — used purely as a typed key resolver.
 */
export interface ConditionCheckOp {
  readonly [ConditionCheckTypeId]: ConditionCheckTypeId
  readonly _entity: Entity
  readonly _key: Record<string, unknown>
  readonly _condition: ExpressionResult
}

/**
 * Create a conditionCheck operation from an EntityGet intermediate and a condition.
 * The EntityGet is never executed — used purely as a typed key resolver.
 *
 * Works in pipe: `Users.get(key).pipe(Transaction.check(expr))`
 * Or data-first: `Transaction.check(Users.get(key), expr)`
 */
export const check: {
  (condition: ExpressionResult): <A, Rec, E, R>(self: EntityGet<A, Rec, E, R>) => ConditionCheckOp
  <A, Rec, E, R>(self: EntityGet<A, Rec, E, R>, condition: ExpressionResult): ConditionCheckOp
} = Fn.dual(
  2,
  <A, Rec, E, R>(self: EntityGet<A, Rec, E, R>, condition: ExpressionResult): ConditionCheckOp => {
    const info = extractTransactable(self)
    if (!info || info.opType !== "get") {
      throw new Error("Transaction.check requires an EntityGet intermediate")
    }
    return {
      [ConditionCheckTypeId]: ConditionCheckTypeId,
      _entity: info.entity,
      _key: info.key!,
      _condition: condition,
    }
  },
)

// ---------------------------------------------------------------------------
// TransactGet — typed tuple return
// ---------------------------------------------------------------------------

/**
 * Map a tuple of EntityGet operations to a tuple of (A | undefined) results.
 * Each position extracts the model type A from EntityGet<A, ...>.
 */
type TransactGetResult<T extends ReadonlyArray<EntityGet<any, any, any, any>>> = {
  -readonly [K in keyof T]: T[K] extends EntityGet<infer A, any, any, any> ? A | undefined : never
}

/**
 * Atomically get up to 100 items across entities/tables.
 * Accepts EntityGet intermediates directly. Returns a typed tuple
 * where each position is `ModelType | undefined`.
 *
 * ```typescript
 * const [user, post] = yield* Transaction.transactGet([
 *   Users.get({ userId: "u-1" }),
 *   Posts.get({ postId: "p-1" }),
 * ])
 * // user: User | undefined, post: Post | undefined
 * ```
 */
export const transactGet = <const T extends ReadonlyArray<EntityGet<any, any, any, any>>>(
  items: T,
): Effect.Effect<
  TransactGetResult<T>,
  DynamoClientError | ValidationError | TransactionCancelled,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    // Cast rationale: same as Batch.get — empty array satisfies any mapped tuple type
    if (items.length === 0) return [] as unknown as TransactGetResult<T>
    if (items.length > 100) {
      return yield* Effect.fail(
        new DynamoError({
          operation: "TransactGetItems",
          cause: new Error("TransactGetItems supports a maximum of 100 items"),
        }),
      )
    }

    const client = yield* DynamoClient

    // Extract entity info from each EntityGet intermediate
    const infos = items.map((item) => {
      const info = extractTransactable(item)
      if (!info || info.opType !== "get") {
        throw new Error("transactGet requires EntityGet intermediates")
      }
      return info
    })

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
    )

    const responses = result.Responses ?? []
    const decoded: Array<unknown> = []

    for (let i = 0; i < infos.length; i++) {
      const response = responses[i]
      const entity = infos[i]!.entity
      const raw = response?.Item ? fromAttributeMap(response.Item) : undefined

      if (raw === undefined) {
        decoded.push(undefined)
        continue
      }

      const recordSchema = entity.schemas.recordSchema as Schema.Codec<any>
      const item = yield* Schema.decodeUnknownEffect(recordSchema)(raw).pipe(
        Effect.mapError(
          (cause) =>
            new ValidationError({
              entityType: entity.entityType,
              operation: "transactGet",
              cause,
            }),
        ),
      )
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

/** Union of operations accepted by transactWrite */
type TransactWriteOp = EntityPut<any, any, any, any> | EntityDelete<any, any> | ConditionCheckOp

/**
 * Atomically write up to 100 items across entities/tables.
 * Accepts EntityPut, EntityDelete, and ConditionCheckOp (via Transaction.check).
 *
 * ```typescript
 * yield* Transaction.transactWrite([
 *   Users.put({ userId: "u-1", ... }),
 *   Posts.delete({ postId: "p-3" }),
 *   Users.get({ userId: "u-1" }).pipe(Transaction.check(expr)),
 * ])
 * ```
 */
export const transactWrite = (
  operations: ReadonlyArray<TransactWriteOp>,
): Effect.Effect<
  void,
  DynamoClientError | ValidationError | TransactionCancelled,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    if (operations.length === 0) return
    if (operations.length > 100) {
      return yield* Effect.fail(
        new DynamoError({
          operation: "TransactWriteItems",
          cause: new Error("TransactWriteItems supports a maximum of 100 items"),
        }),
      )
    }

    const client = yield* DynamoClient

    // Build info for each operation
    const opInfos: Array<{
      type: "put" | "delete" | "conditionCheck"
      entity: Entity
      key?: Record<string, unknown> | undefined
      input?: Record<string, unknown> | undefined
      condition?: ExpressionResult | undefined
    }> = []

    for (const op of operations) {
      // Check for ConditionCheckOp first (has its own TypeId)
      if (ConditionCheckTypeId in op) {
        const checkOp = op as ConditionCheckOp
        opInfos.push({
          type: "conditionCheck",
          entity: checkOp._entity,
          key: checkOp._key,
          condition: checkOp._condition,
        })
        continue
      }

      const info = extractTransactable(op)
      if (!info) {
        throw new Error("transactWrite: unrecognized operation type")
      }

      if (info.opType === "put") {
        opInfos.push({
          type: "put",
          entity: info.entity,
          input: info.input!,
        })
      } else if (info.opType === "delete") {
        opInfos.push({
          type: "delete",
          entity: info.entity,
          key: info.key!,
        })
      } else {
        throw new Error(
          `transactWrite: unsupported operation type "${info.opType}". Use EntityPut, EntityDelete, or Transaction.check().`,
        )
      }
    }

    const tableNames = yield* resolveTableNames(opInfos)

    const transactItems: Array<Record<string, any>> = []

    for (const op of opInfos) {
      const tableName = tableNames.get(op.entity)!

      if (op.type === "put") {
        const marshalledItem = yield* validateAndBuildPutItem(
          op.entity,
          op.input!,
          "transactWrite.put",
        )
        transactItems.push({
          Put: { TableName: tableName, Item: marshalledItem },
        })
      } else if (op.type === "delete") {
        transactItems.push({
          Delete: {
            TableName: tableName,
            Key: toAttributeMap(composePrimaryKey(op.entity, op.key!)),
          },
        })
      } else {
        // conditionCheck
        const marshalledKey = toAttributeMap(composePrimaryKey(op.entity, op.key!))
        transactItems.push({
          ConditionCheck: {
            TableName: tableName,
            Key: marshalledKey,
            ConditionExpression: op.condition!.expression,
            ExpressionAttributeNames: op.condition!.names,
            ExpressionAttributeValues: op.condition!.values,
          },
        })
      }
    }

    yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
      Effect.mapError((error) => {
        if (isAwsTransactionCancelled(error.cause)) {
          return new TransactionCancelled({
            operation: "TransactWriteItems",
            reasons: (error.cause.CancellationReasons ?? []).map((r) => ({
              code: r?.Code,
              message: r?.Message,
            })),
            cause: error.cause,
          }) as DynamoClientError | TransactionCancelled
        }
        return error as DynamoClientError | TransactionCancelled
      }),
    )
  })
