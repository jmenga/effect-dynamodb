/**
 * @internal Shared `TransactWriteItems` item-building for `Transaction.transactWrite`
 * and `EventStore.append`'s `additionalItems`.
 *
 * Both call sites assemble items before deciding what to do with them
 * (execute directly, or merge into a larger transaction). A put of a versioned
 * or unique-constrained entity reads the item it replaces (#133), so the
 * builder needs `DynamoClient` as well as `TableConfig`.
 *
 * Keeping one builder is what lets `EventStore.append({ additionalItems })` and
 * `Transaction.transactWrite` accept exactly the same op union: they cannot
 * drift, and support added here (e.g. `EntityUpdate`) lands for both at once.
 */

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb"
import type {
  ConcurrentModification,
  OptimisticLockError,
  UniqueConstraintViolation,
} from "@effect-dynamodb/schema/Errors.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Option } from "effect"
import type { DynamoClient, DynamoClientError } from "../DynamoClient.js"
import type {
  Entity,
  EntityDelete,
  EntityPut,
  EntityUpdate,
  PlanDeleteError,
  PlanUpdateError,
  PutVerdict,
  WriteCancellationReason,
} from "../Entity.js"
import { extractTransactable } from "../Entity.js"
import type { ConditionInput, ExpressionResult } from "../Expression.js"
import { toAttributeMap } from "../Marshaller.js"
import { resolveTtlAttributeName, type TableConfig } from "../Table.js"
import type { BoundUpdateOp, BoundWriteOp } from "./BoundCrud.js"
import { withGuard } from "./EntityOps.js"
import { compileExpr, type Expr, emptyPartProblem, isExpr, parseShorthand } from "./Expr.js"
import {
  composePrimaryKey,
  rejectUnsupportedOp,
  resolveTableNames,
  validateAndBuildPutItem,
} from "./TransactableOps.js"
import type { TransactPlan } from "./TransactPlan.js"
import {
  type KeyAttributes,
  keyAttributesOf,
  mergeKeyAttributes,
  type TransactItemTarget,
  transactItemTarget,
} from "./WriteDiagnosis.js"

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

export { type TransactItemTarget, transactItemTarget }

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
 * Kept out of {@link TransactWriteOp} because compiling an update reads, in
 * {@link planTransactWriteOps}. `transactWrite` runs that pre-pass;
 * `EventStore.append({ additionalItems })` does not, and `Batch.write` cannot
 * express an update at all, so neither accepts one at the type level.
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

/**
 * An op's condition with an empty part where none may be (#133) is refused
 * before anything is sent — see `emptyPartProblem`.
 */
const refuseEmptyParts = (
  entity: Entity,
  operation: string,
  opType: string,
  cond: Expr | ConditionInput | undefined,
): Effect.Effect<void, ValidationError> => {
  const problem =
    cond === undefined
      ? undefined
      : emptyPartProblem(isExpr(cond) ? cond : parseShorthand(cond as Record<string, unknown>))
  return problem === undefined
    ? Effect.void
    : Effect.fail(
        new ValidationError({
          entityType: entity.entityType,
          operation: `${operation}.condition`,
          cause: `${operation} (${opType}): ${problem} Nothing was sent.`,
        }),
      )
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
 * What an emitted transact item was produced by, so a positional cancellation
 * reason can be attributed back to the caller op that caused it.
 *
 * Before #113 this was implicit: one caller op produced exactly one item, so
 * `itemIndex === opIndex`. A guarded put (#133) expands into several items,
 * and the mapping has to be carried rather than assumed — that is what this
 * array is for.
 */
export interface ItemProvenance {
  /** Index into the caller's `operations` array. */
  readonly opIndex: number
  /**
   * `"main"`: the op's own item. `"guarded"`: one of the items of a guarded put
   * or of a planned update or delete — see {@link GuardedWrite}, which reads
   * their cancellation reasons.
   */
  readonly kind: "main" | "guarded"
  /** The entity the op targeted, so consumers can name it in an error. */
  readonly entityType: string
}

/**
 * A write planned from a fresh read, exactly as the entity's own op plans it:
 *
 * - a put of a versioned or unique-constrained entity (#133): the item
 *   continued (or created past any retained history), its sentinels rotated —
 *   releasing only those it owns — and its retain snapshot;
 * - an update, or a delete of a `unique` / `retain` / `softDelete` entity
 *   (`Transaction.transactWrite` only): the op itself, run with its write
 *   recorded instead of sent (`internal/TransactPlan.planWrite`).
 */
export interface GuardedWrite {
  /** Index into the caller's `operations` array. */
  readonly opIndex: number
  /** Where the plan's items start in `items`. */
  readonly start: number
  /**
   * A guarded put's plan (`Entity._planPut`), or a planned update or delete
   * (`Entity._planUpdate` / `_planDelete`): its items and their verdict.
   */
  readonly plan: TransactPlan
}

/** Compiled items plus the caller-op attribution for each one. */
export interface BuiltTransactWriteItems {
  readonly items: Array<TransactWriteItem>
  /** Parallel to `items`: `provenance[i]` describes `items[i]`. */
  readonly provenance: Array<ItemProvenance>
  /**
   * Parallel to `items`: the item each one writes, to name it in a diagnosed
   * rejection (`internal/WriteDiagnosis.ts`) — two entries naming one item, an
   * oversized item, an over-long sort key. A thunk: needed only on failure.
   */
  readonly targets: () => ReadonlyArray<TransactItemTarget>
  readonly guarded: ReadonlyArray<GuardedWrite>
  /**
   * The key attributes the ops' entities write (primary and index, partition
   * and sort), for diagnosing a rejected key size. A thunk: needed only on
   * failure.
   */
  readonly keys: () => KeyAttributes
}

/**
 * The read pre-pass that lets `Transaction.transactWrite` carry the ops the
 * build step below cannot: every `update`, and every `delete` of an entity
 * whose delete writes more than its own row (`unique`, `versioned: { retain:
 * true }`, `softDelete` — EDD-9048). Each is planned by the entity's own op
 * (`Entity._planUpdate` / `_planDelete`): the standalone op itself, run with
 * its write recorded instead of sent, so the transaction writes exactly what
 * the standalone op would have — every read, item and guard included.
 *
 * Ops a planned write cannot carry are refused before anything is read
 * (EDD-9059 – EDD-9061, `rejectUnsupportedOp`). Returns the plans keyed by
 * index into `operations`; ops that need no plan are absent. Run on every
 * attempt, so a transaction cancelled by a lost race is planned again from
 * fresh reads.
 */
export const planTransactWriteOps = (
  operations: ReadonlyArray<TransactWriteOp | TransactWriteUpdateOp>,
): Effect.Effect<
  ReadonlyMap<number, TransactPlan>,
  ValidationError | PlanUpdateError | PlanDeleteError,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    const plans = new Map<number, TransactPlan>()
    for (let opIndex = 0; opIndex < operations.length; opIndex++) {
      const op = operations[opIndex]
      if (op != null && typeof op === "object" && ConditionCheckTypeId in op) continue
      const info = extractTransactable(op)
      if (info === undefined) continue
      if (info.opType === "update" && info.updateState !== undefined) {
        yield* rejectUnsupportedOp(info.entity, "transactWrite", "update", undefined, undefined, {
          updateState: info.updateState,
        })
        plans.set(opIndex, yield* info.entity._planUpdate(info.key, info.updateState))
      } else if (
        info.opType === "delete" &&
        info.deleteRequest !== undefined &&
        info.entity._multiItemWriteFeatures.length > 0
      ) {
        yield* rejectUnsupportedOp(info.entity, "transactWrite", "delete", undefined, undefined, {
          returnValues: info.deleteRequest.returnValues,
          readsStoredRow: true,
        })
        plans.set(
          opIndex,
          yield* info.entity._planDelete(info.key, {
            condition: info.deleteRequest.condition,
            mustExist: info.deleteRequest.mustExist,
          }),
        )
      }
    }
    return plans
  })

/**
 * Compile a list of Entity write ops into marshalled `TransactWriteItems` entries,
 * preserving caller order.
 *
 * **One caller op may emit several items.** A put of a versioned or
 * unique-constrained entity is a guarded put (#133): it reads the item, and
 * emits the item guarded on what was read, plus its sentinel reservations and
 * releases and its retain snapshot (see {@link GuardedWrite}). `provenance`
 * records which caller op each emitted item belongs to; consumers that map
 * cancellation reasons positionally MUST use it instead of assuming 1:1, and
 * read a guarded put's reasons through {@link judgeCancellation}.
 *
 * DynamoDB's rules (one operation per item, 100 items, 4 MB, 400 KB per
 * item, 2048-byte partition and 1024-byte sort keys, the limits on one expression) are not
 * pre-checked: the caller sends the transaction and diagnoses DynamoDB's
 * rejection through `internal/WriteDiagnosis.ts`, which counts the EXPANDED
 * items and names the culprit through `targets` (and `keys`) — two ops
 * touching one item included, among them two puts that swap unique values
 * and so release and claim the same sentinels. A caller adding items of its
 * own appends their targets to these.
 */
export const buildTransactWriteItems = (
  operations: ReadonlyArray<TransactWriteOp | TransactWriteUpdateOp>,
  operation: string,
  /**
   * Updates and multi-item deletes, planned by {@link planTransactWriteOps}
   * and keyed by index into `operations`. A caller that runs no pre-pass
   * (`EventStore.append`) passes none, and such ops are refused.
   */
  plans: ReadonlyMap<number, TransactPlan> = new Map(),
): Effect.Effect<
  BuiltTransactWriteItems,
  ValidationError | DynamoClientError,
  TableConfig | DynamoClient
> =>
  Effect.gen(function* () {
    if (operations.length === 0) {
      return {
        items: [],
        provenance: [],
        targets: () => [],
        guarded: [],
        keys: () => mergeKeyAttributes(),
      }
    }

    const opInfos: Array<{
      type: "put" | "delete" | "conditionCheck" | "planned"
      putKind?: "put" | "create" | "upsert" | undefined
      entity: Entity
      /** Index into the caller's `operations` array — preserved for provenance. */
      opIndex: number
      key?: Record<string, unknown> | undefined
      input?: Record<string, unknown> | undefined
      condition?: ExpressionResult | undefined
      /** The caller's own condition — what a `create` over a tombstone keeps. */
      callerCondition?: Expr | ConditionInput | undefined
      plan?: TransactPlan | undefined
    }> = []

    for (let opIndex = 0; opIndex < operations.length; opIndex++) {
      const op = operations[opIndex]!
      // Check for ConditionCheckOp first (has its own TypeId)
      if (op != null && typeof op === "object" && ConditionCheckTypeId in op) {
        const checkOp = op as ConditionCheckOp
        // A check that asserts nothing (`Expression.condition({})`) would be
        // sent as an empty ConditionExpression, which DynamoDB rejects (#134).
        if (checkOp._condition.expression.trim() === "") {
          return yield* new ValidationError({
            entityType: checkOp._entity.entityType,
            operation: `${operation}.check`,
            cause: `${operation}: Transaction.check() was given an empty condition. Nothing was sent.`,
          })
        }
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
        yield* refuseEmptyParts(info.entity, operation, "put", info.condition)
        opInfos.push({
          type: "put",
          putKind: info.putKind,
          entity: info.entity,
          opIndex,
          input: info.input!,
          condition: compileOpCondition(info.entity, info.condition),
          callerCondition: info.callerCondition,
        })
      } else if (info.opType === "delete") {
        yield* rejectUnsupportedOp(info.entity, operation, "delete", undefined, undefined, {
          returnValues: info.deleteRequest?.returnValues,
        })
        yield* refuseEmptyParts(info.entity, operation, "delete", info.condition)
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
    // What names each item, kept so its target is built only on failure.
    const naming: Array<() => TransactItemTarget> = []
    const guarded: Array<GuardedWrite> = []
    let tableName = ""
    let keyFields: ReadonlyArray<string> = []
    const push = (item: TransactWriteItem, from: ItemProvenance, derived = false) => {
      items.push(item)
      provenance.push(from)
      const [table, fields] = [tableName, keyFields]
      naming.push(() =>
        transactItemTarget(
          item,
          table,
          fields,
          from.entityType,
          `operation ${from.opIndex} (${from.entityType}${
            derived ? ", through a uniqueness sentinel or version snapshot it writes" : ""
          })`,
        ),
      )
    }

    for (const op of opInfos) {
      tableName = tableNames.get(op.entity)!
      const primary = op.entity.indexes.primary!
      keyFields = [primary.pk.field, primary.sk.field]

      if (op.type === "planned") {
        // Already marshalled and table-resolved; read like a guarded put's.
        guarded.push({ opIndex: op.opIndex, start: items.length, plan: op.plan! })
        for (const [i, item] of op.plan!.items.entries()) {
          push(
            item,
            { opIndex: op.opIndex, kind: "guarded", entityType: op.entity.entityType },
            i > 0,
          )
        }
        continue
      }

      if (op.type === "put") {
        const built = yield* validateAndBuildPutItem(op.entity, op.input!, `${operation}.put`)
        if (op.entity._incarnationToken || op.entity._multiItemWriteFeatures.includes("unique")) {
          const plan = yield* op.entity._planPut({
            tableName,
            ttlAttrName: resolveTtlAttributeName(yield* op.entity._tableTag),
            now: built.now,
            item: built.item,
            createdAtSupplied: built.createdAtSupplied,
            userCondition: op.condition,
            create: op.putKind === "create",
            operation,
            key: op.input!,
          })
          guarded.push({ opIndex: op.opIndex, start: items.length, plan })
          for (const [i, item] of plan.items.entries()) {
            push(
              item,
              { opIndex: op.opIndex, kind: "guarded", entityType: op.entity.entityType },
              i > 0,
            )
          }
          continue
        }
        // `create` over a projection tombstone (#154): take its place,
        // carrying its checkpoints over, guarded on that tombstone.
        const over =
          op.putKind === "create"
            ? yield* op.entity._overTombstone(tableName, built.item)
            : Option.none<ConditionInput>()
        push(
          {
            Put: {
              TableName: tableName,
              Item: Option.isSome(over) ? toAttributeMap(built.item) : built.marshalled,
              ...conditionFields(
                Option.isSome(over)
                  ? compileOpCondition(op.entity, withGuard(over.value, op.callerCondition))
                  : op.condition,
              ),
            },
          },
          { opIndex: op.opIndex, kind: "main", entityType: op.entity.entityType },
        )
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

    const keys = () =>
      mergeKeyAttributes(...opInfos.map((op) => keyAttributesOf(op.entity.indexes as never)))
    const targets = () => naming.map((name) => name())
    return { items, provenance, targets, guarded, keys }
  })

// ---------------------------------------------------------------------------
// judgeCancellation
// ---------------------------------------------------------------------------

/** Attempts a transaction with guarded puts makes before it reports a lost race. */
export const GUARDED_TRANSACTION_ATTEMPTS = 3

/**
 * What a cancelled transaction of {@link buildTransactWriteItems} items means,
 * from its positional reasons (`offset`: where those items start in the
 * request). In order of precedence:
 *
 * - `fail` — a guarded put's final verdict: a unique value is taken
 *   (`UniqueConstraintViolation`) or its history conflicts (`ValidationError`).
 *   Never a caller-condition error: the caller set none.
 * - `conditions` — the caller ops whose OWN condition (`.condition()`,
 *   `create()`'s, `Transaction.check`'s) rejected the write.
 * - `retry` — a guarded put lost a race to a concurrent write (or met retained
 *   history its read did not see): build and write the transaction again. Its
 *   `error` is what to report when every attempt loses.
 *
 * `undefined`: no conditional failure among these items explains it.
 */
export const judgeCancellation = (
  built: BuiltTransactWriteItems,
  reasons: ReadonlyArray<WriteCancellationReason | undefined>,
  offset = 0,
):
  | {
      readonly _tag: "fail"
      readonly opIndex: number
      readonly error: UniqueConstraintViolation | ValidationError
    }
  | { readonly _tag: "conditions"; readonly opIndices: ReadonlyArray<number> }
  | {
      readonly _tag: "retry"
      readonly error: OptimisticLockError | ConcurrentModification
      readonly stored: Extract<PutVerdict, { readonly _tag: "Retry" }>["stored"]
    }
  | undefined => {
  const conditions = new Set<number>()
  let retry: Extract<PutVerdict, { readonly _tag: "Retry" }> | undefined
  const inGuarded = new Set<number>()
  for (const { opIndex, start, plan } of built.guarded) {
    for (let i = 0; i < plan.items.length; i++) inGuarded.add(start + i)
    const verdict = plan.verdict(reasons.slice(offset + start, offset + start + plan.items.length))
    if (verdict === undefined) continue
    if (verdict._tag === "Fail") return { _tag: "fail", opIndex, error: verdict.error }
    if (verdict._tag === "Condition") conditions.add(opIndex)
    else retry ??= verdict
  }
  for (let i = 0; i < built.items.length; i++) {
    if (inGuarded.has(i)) continue
    if (reasons[offset + i]?.Code !== "ConditionalCheckFailed") continue
    const from = built.provenance[i]
    if (from !== undefined) conditions.add(from.opIndex)
  }
  if (conditions.size > 0) {
    return { _tag: "conditions", opIndices: [...conditions].sort((a, b) => a - b) }
  }
  if (retry !== undefined) return { _tag: "retry", error: retry.error, stored: retry.stored }
  return undefined
}
