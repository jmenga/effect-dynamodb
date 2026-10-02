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
import type { DynamoClient } from "../DynamoClient.js"
import type {
  Entity,
  EntityDelete,
  EntityPut,
  EntityUpdate,
  PlanDeleteError,
  PlanUpdateError,
} from "../Entity.js"
import { extractTransactable } from "../Entity.js"
import type { ConditionInput, ExpressionResult } from "../Expression.js"
import { toAttributeMap } from "../Marshaller.js"
import { resolveTtlAttributeName, type TableConfig } from "../Table.js"
import type { BoundUpdateOp, BoundWriteOp } from "./BoundCrud.js"
import { compileExpr, type Expr, isExpr, parseShorthand } from "./Expr.js"
import {
  composePrimaryKey,
  rejectUnsupportedOp,
  resolveTableNames,
  validateAndBuildPutItem,
} from "./TransactableOps.js"
import { conditionFields, type TransactPlan } from "./TransactPlan.js"

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
 * An `update` — accepted by `Transaction.transactWrite` alone.
 *
 * Kept out of {@link TransactWriteOp} because compiling an update needs
 * {@link planTransactWriteOps}, which reads. `transactWrite` runs that pre-pass;
 * `EventStore.append({ additionalItems })` does not, and `Batch.write` cannot
 * express an update at all, so neither should accept one at the type level.
 */
export type TransactWriteUpdateOp = EntityUpdate<any, any, any, any, any> | BoundUpdateOp

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

// ---------------------------------------------------------------------------
// buildTransactWriteItems
// ---------------------------------------------------------------------------

/**
 * What an emitted transact item was produced by, so a positional cancellation
 * reason can be attributed back to the caller op that caused it.
 *
 * Before #113 this was implicit: one caller op produced exactly one item, so
 * `itemIndex === opIndex`. A `put` of an entity with `unique` / `retain` now
 * expands into several items, and the mapping has to be carried rather than
 * assumed — that is what this array is for.
 */
export interface ItemProvenance {
  /** Index into the caller's `operations` array. */
  readonly opIndex: number
  readonly kind: "main" | "sentinel" | "snapshot" | "tombstone"
  /**
   * Set for `kind: "sentinel"` when the item RESERVES a value — which `unique`
   * constraint it belongs to. Unset on a sentinel release (an unconditional
   * `Delete`), which cannot be what rejected the transaction.
   */
  readonly constraintName?: string | undefined
  /** Set for `kind: "sentinel"` — the values reserved, for `UniqueConstraintViolation`. */
  readonly fields?: Record<string, string> | undefined
  /** The entity the op targeted, so consumers can name it in an error. */
  readonly entityType: string
}

/** Compiled items plus the caller-op attribution for each one. */
export interface BuiltTransactWriteItems {
  readonly items: Array<TransactWriteItem>
  /** Parallel to `items`: `provenance[i]` describes `items[i]`. */
  readonly provenance: Array<ItemProvenance>
}

/**
 * The read pre-pass that lets `transactWrite` carry the ops the pure compile
 * step below cannot: every `update`, and every `delete` of an entity whose
 * delete writes more than its own row (`unique`, `versioned: { retain: true }`,
 * `softDelete` — EDD-9048). Each is compiled by the entity's own op in plan
 * mode (`Entity._planUpdate` / `_planDelete`), which reads the stored row
 * exactly as the standalone op does, so the transaction writes what the
 * standalone op would have.
 *
 * Returns the plans keyed by index into `operations`, for
 * {@link buildTransactWriteItems}. Ops that need no plan are absent.
 *
 * The reads are not isolated from the write, so each plan's main item carries a
 * read guard (`readGuard` in `Entity.ts` — the version read on a versioned
 * entity, otherwise every `unique` field's read value): a row changed in
 * between cancels the transaction rather than leaving side items that describe
 * a row that no longer exists.
 */
export const planTransactWriteOps = (
  operations: ReadonlyArray<TransactWriteOp | TransactWriteUpdateOp>,
): Effect.Effect<
  ReadonlyMap<number, TransactPlan>,
  PlanUpdateError | PlanDeleteError,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    const plans = new Map<number, TransactPlan>()
    for (let opIndex = 0; opIndex < operations.length; opIndex++) {
      const op = operations[opIndex]
      if (op != null && typeof op === "object" && ConditionCheckTypeId in op) continue
      const info = extractTransactable(op)
      if (!info) continue
      // Refused before the read, so an op no transaction can carry costs nothing.
      if (info.opType === "update" && info.updateState !== undefined) {
        yield* rejectUnsupportedOp(info.entity, "transactWrite", "update", undefined, undefined, {
          updateState: info.updateState,
        })
        plans.set(opIndex, yield* info.entity._planUpdate(info.key, info.updateState))
      } else if (info.opType === "delete" && info.entity._multiItemWriteFeatures.length > 0) {
        yield* rejectUnsupportedOp(info.entity, "transactWrite", "delete", undefined, undefined, {
          returnValues: info.returnValues,
          readsStoredRow: true,
        })
        plans.set(opIndex, yield* info.entity._planDelete(info.key, info.condition))
      }
    }
    return plans
  })

/**
 * Compile a list of Entity write ops into marshalled `TransactWriteItems` entries,
 * preserving caller order.
 *
 * **One caller op may emit several items.** A `put` of an entity with `unique`
 * constraints or `versioned: { retain: true }` expands into the main item plus
 * one guarded sentinel per satisfiable constraint plus the v1 snapshot — all
 * derived from the payload, so no read is needed (#113). `provenance` records
 * which caller op each emitted item belongs to; consumers that map cancellation
 * reasons positionally MUST use it instead of assuming 1:1.
 *
 * **Ops that must read are emitted from `plans`** ({@link planTransactWriteOps}).
 * An `update`, or a `delete` needing side items, with no plan is rejected — the
 * behaviour callers that run no pre-pass (`EventStore.append`) keep.
 *
 * Does NOT enforce `TRANSACT_WRITE_ITEMS_LIMIT` — the caller counts, because the
 * total may include items this builder never sees (event puts, dedup sentinels).
 * Callers must count the EXPANDED `items.length`, not `operations.length`.
 */
export const buildTransactWriteItems = (
  operations: ReadonlyArray<TransactWriteOp | TransactWriteUpdateOp>,
  operation: string,
  plans: ReadonlyMap<number, TransactPlan> = new Map(),
): Effect.Effect<BuiltTransactWriteItems, ValidationError, TableConfig> =>
  Effect.gen(function* () {
    if (operations.length === 0) return { items: [], provenance: [] }

    const opInfos: Array<{
      type: "put" | "delete" | "conditionCheck" | "planned"
      entity: Entity
      /** Index into the caller's `operations` array — preserved for provenance. */
      opIndex: number
      key?: Record<string, unknown> | undefined
      input?: Record<string, unknown> | undefined
      condition?: ExpressionResult | undefined
      plan?: TransactPlan | undefined
    }> = []

    for (let opIndex = 0; opIndex < operations.length; opIndex++) {
      const op = operations[opIndex]!
      // Check for ConditionCheckOp first (has its own TypeId)
      if (op != null && typeof op === "object" && ConditionCheckTypeId in op) {
        const checkOp = op as ConditionCheckOp
        opInfos.push({
          type: "conditionCheck",
          entity: checkOp._entity,
          opIndex,
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

      const plan = plans.get(opIndex)
      if (plan !== undefined) {
        opInfos.push({ type: "planned", entity: info.entity, opIndex, plan })
        continue
      }

      if (info.opType === "put") {
        yield* rejectUnsupportedOp(info.entity, operation, "put", info.putKind, info.input)
        opInfos.push({
          type: "put",
          entity: info.entity,
          opIndex,
          input: info.input!,
          condition: compileOpCondition(info.entity, info.condition),
        })
      } else if (info.opType === "delete") {
        yield* rejectUnsupportedOp(info.entity, operation, "delete", undefined, undefined, {
          returnValues: info.returnValues,
        })
        opInfos.push({
          type: "delete",
          entity: info.entity,
          opIndex,
          key: info.key!,
          condition: compileOpCondition(info.entity, info.condition),
        })
      } else {
        return yield* new ValidationError({
          entityType: info.entity.entityType,
          operation,
          cause:
            info.opType === "update"
              ? `${operation}: update is not supported here — compiling an update reads the ` +
                "stored row, which this path does not do. Transaction.transactWrite accepts " +
                "updates; otherwise run the update as its own operation."
              : `${operation}: unsupported operation type "${info.opType}". Use EntityPut, EntityDelete, or Transaction.check().`,
        })
      }
    }

    const tableNames = yield* resolveTableNames(opInfos)

    const items: Array<TransactWriteItem> = []
    const provenance: Array<ItemProvenance> = []
    const push = (item: TransactWriteItem, from: ItemProvenance) => {
      items.push(item)
      provenance.push(from)
    }

    for (const op of opInfos) {
      const tableName = tableNames.get(op.entity)!

      if (op.type === "planned") {
        // Already marshalled, table-resolved and in the standalone op's order.
        for (const planned of op.plan!.items) {
          push(planned.item, {
            opIndex: op.opIndex,
            kind: planned.kind,
            constraintName: planned.constraintName,
            fields: planned.fields,
            entityType: op.entity.entityType,
          })
        }
      } else if (op.type === "put") {
        const built = yield* validateAndBuildPutItem(op.entity, op.input!, `${operation}.put`)
        push(
          {
            Put: {
              TableName: tableName,
              Item: built.marshalled,
              ...conditionFields(op.condition),
            },
          },
          { opIndex: op.opIndex, kind: "main", entityType: op.entity.entityType },
        )

        // Uniqueness sentinels + the v1 retain snapshot. Emitted immediately
        // after their item so a reader of the request sees them as one group;
        // `provenance` is what actually carries the association.
        const ttlAttrName = resolveTtlAttributeName(yield* op.entity._tableTag)
        for (const side of op.entity._buildPutSideItems(built.item, built.now, ttlAttrName)) {
          push(
            {
              Put: {
                TableName: tableName,
                Item: toAttributeMap(side.item),
                ...(side.guard ?? {}),
              },
            },
            {
              opIndex: op.opIndex,
              kind: side.kind,
              constraintName: side.constraintName,
              fields: side.fields,
              entityType: op.entity.entityType,
            },
          )
        }
      } else if (op.type === "delete") {
        push(
          {
            Delete: {
              TableName: tableName,
              Key: toAttributeMap(composePrimaryKey(op.entity, op.key!)),
              ...conditionFields(op.condition),
            },
          },
          { opIndex: op.opIndex, kind: "main", entityType: op.entity.entityType },
        )
      } else {
        push(
          {
            ConditionCheck: {
              TableName: tableName,
              Key: toAttributeMap(composePrimaryKey(op.entity, op.key!)),
              ConditionExpression: op.condition!.expression,
              ...conditionFields(op.condition),
            },
          },
          { opIndex: op.opIndex, kind: "main", entityType: op.entity.entityType },
        )
      }
    }

    return { items, provenance }
  })
