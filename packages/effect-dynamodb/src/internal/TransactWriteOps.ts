/**
 * @internal Shared `TransactWriteItems` item-building for `Transaction.transactWrite`
 * and `EventStore.append`'s `additionalItems`.
 *
 * The builder is a pure compile step — its `R` is `TableConfig` only (no
 * `DynamoClient`) — so both call sites can assemble items before deciding what
 * to do with them (execute directly, or merge into a larger transaction).
 *
 * Keeping one builder is what lets `EventStore.append({ additionalItems })` and
 * `Transaction.transactWrite` accept exactly the same op union: they cannot
 * drift, and support added here (e.g. `EntityUpdate`) lands for both at once.
 */

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import type { Entity, EntityDelete, EntityPut } from "../Entity.js"
import { extractTransactable } from "../Entity.js"
import type { ConditionInput, ExpressionResult } from "../Expression.js"
import { toAttributeMap } from "../Marshaller.js"
import type { TableConfig } from "../Table.js"
import type { BoundWriteOp } from "./BoundCrud.js"
import { compileExpr, type Expr, isExpr, parseShorthand } from "./Expr.js"
import {
  composePrimaryKey,
  rejectUnsupportedOp,
  resolveTableNames,
  validateAndBuildPutItem,
} from "./TransactableOps.js"

// ---------------------------------------------------------------------------
// ConditionCheck — composable from EntityGet + condition expression
// ---------------------------------------------------------------------------

/** @internal */
export const ConditionCheckTypeId: unique symbol = Symbol.for("effect-dynamodb/ConditionCheck")
export type ConditionCheckTypeId = typeof ConditionCheckTypeId

/**
 * A condition-check operation for use inside a `TransactWriteItems` call.
 * Created via `Transaction.check` from an EntityGet intermediate + a condition
 * expression. The EntityGet is never executed — used purely as a typed key resolver.
 */
export interface ConditionCheckOp {
  readonly [ConditionCheckTypeId]: ConditionCheckTypeId
  readonly _entity: Entity
  readonly _key: Record<string, unknown>
  readonly _condition: ExpressionResult
}

/** A single marshalled entry of a `TransactWriteItems` call. */
export type { TransactWriteItem }

/**
 * Union of operations accepted by `transactWrite` and by `append`'s
 * `additionalItems`. The `any` positions are deliberate: op intermediates are
 * heterogeneous by design, and each element is narrowed at the call site.
 *
 * Bound-CRUD builders (`db.entities.X.put(...)` / `.create(...)` /
 * `.delete(...)`) are accepted alongside the unbound intermediates. They are the
 * only write descriptor available for entities authored with the pure,
 * AWS-free `@effect-dynamodb/schema` `Entity.make` (#100).
 */
export type TransactWriteOp =
  | EntityPut<any, any, any, any>
  | EntityDelete<any, any>
  | BoundWriteOp
  | ConditionCheckOp

/**
 * Compile an op-attached condition (`Entity.create()`'s `attribute_not_exists`,
 * `.condition(...)`, `Entity.condition(...)`) into a DynamoDB expression.
 * `resolveDbName` maps domain field names to their stored attribute names.
 */
const compileOpCondition = (
  entity: Entity,
  cond: Expr | ConditionInput | undefined,
): ExpressionResult | undefined => {
  if (cond === undefined) return undefined
  const expr = isExpr(cond) ? cond : parseShorthand(cond as Record<string, unknown>)
  return compileExpr(expr, entity._resolveDbName) as ExpressionResult
}

/**
 * Spread a compiled condition onto a `Put` / `Delete` / `ConditionCheck` entry.
 * `ExpressionAttributeValues` is omitted when empty — DynamoDB rejects an empty
 * map, and value-free conditions (`attribute_not_exists`, `attribute_exists`)
 * produce one.
 */
const conditionFields = (condition: ExpressionResult | undefined) =>
  condition === undefined
    ? {}
    : {
        ConditionExpression: condition.expression,
        ExpressionAttributeNames: condition.names,
        ...(Object.keys(condition.values).length > 0
          ? { ExpressionAttributeValues: condition.values }
          : {}),
      }

// ---------------------------------------------------------------------------
// buildTransactWriteItems
// ---------------------------------------------------------------------------

/**
 * Compile a list of Entity write ops into marshalled `TransactWriteItems` entries,
 * preserving caller order (positions are load-bearing: `EventStore.append` maps
 * `CancellationReasons` back to `additionalItems` indices by position).
 *
 * Does NOT enforce `TRANSACT_WRITE_ITEMS_LIMIT` — the caller counts, because the
 * total may include items this builder never sees (event puts, dedup sentinels).
 */
export const buildTransactWriteItems = (
  operations: ReadonlyArray<TransactWriteOp>,
  operation: string,
): Effect.Effect<Array<TransactWriteItem>, ValidationError, TableConfig> =>
  Effect.gen(function* () {
    if (operations.length === 0) return []

    const opInfos: Array<{
      type: "put" | "delete" | "conditionCheck"
      entity: Entity
      key?: Record<string, unknown> | undefined
      input?: Record<string, unknown> | undefined
      condition?: ExpressionResult | undefined
    }> = []

    for (const op of operations) {
      // Check for ConditionCheckOp first (has its own TypeId)
      if (op != null && typeof op === "object" && ConditionCheckTypeId in op) {
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
        return yield* new ValidationError({
          entityType: "unknown",
          operation,
          cause: `${operation}: unrecognized operation type. Use EntityPut, EntityDelete, or Transaction.check().`,
        })
      }

      if (info.opType === "put") {
        yield* rejectUnsupportedOp(info.entity, operation, "put", info.putKind)
        opInfos.push({
          type: "put",
          entity: info.entity,
          input: info.input!,
          condition: compileOpCondition(info.entity, info.condition),
        })
      } else if (info.opType === "delete") {
        yield* rejectUnsupportedOp(info.entity, operation, "delete", undefined)
        opInfos.push({
          type: "delete",
          entity: info.entity,
          key: info.key!,
          condition: compileOpCondition(info.entity, info.condition),
        })
      } else {
        return yield* new ValidationError({
          entityType: info.entity.entityType,
          operation,
          cause: `${operation}: unsupported operation type "${info.opType}". Use EntityPut, EntityDelete, or Transaction.check().`,
        })
      }
    }

    const tableNames = yield* resolveTableNames(opInfos)

    const transactItems: Array<TransactWriteItem> = []

    for (const op of opInfos) {
      const tableName = tableNames.get(op.entity)!

      if (op.type === "put") {
        const marshalledItem = yield* validateAndBuildPutItem(
          op.entity,
          op.input!,
          `${operation}.put`,
        )
        transactItems.push({
          Put: {
            TableName: tableName,
            Item: marshalledItem,
            ...conditionFields(op.condition),
          },
        })
      } else if (op.type === "delete") {
        transactItems.push({
          Delete: {
            TableName: tableName,
            Key: toAttributeMap(composePrimaryKey(op.entity, op.key!)),
            ...conditionFields(op.condition),
          },
        })
      } else {
        transactItems.push({
          ConditionCheck: {
            TableName: tableName,
            Key: toAttributeMap(composePrimaryKey(op.entity, op.key!)),
            ConditionExpression: op.condition!.expression,
            ...conditionFields(op.condition),
          },
        })
      }
    }

    return transactItems
  })
