/**
 * TransactPlan — the items one entity write would issue, compiled but not sent.
 *
 * `update` and a multi-item `delete` (an entity with `unique`, `versioned: {
 * retain: true }` or `softDelete`) derive their extra items from the STORED
 * row, so compiling them for `Transaction.transactWrite` means reading first.
 * Rather than re-derive that logic, the op builders run in plan mode: the same
 * code path the standalone op takes, stopping where it would call DynamoDB and
 * returning the items instead (with a read guard on the main item wherever the
 * plan was derived from a read — see `readGuard` in `Entity.ts`).
 *
 * Lives in its own module so `Entity.ts` can produce it and
 * `TransactWriteOps.ts` can consume it without a runtime import cycle.
 */

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb"

/** Brand for {@link isTransactPlan}. */
export const TransactPlanTypeId: unique symbol = Symbol.for("effect-dynamodb/TransactPlan")
export type TransactPlanTypeId = typeof TransactPlanTypeId

/**
 * One planned item and what it is for.
 *
 * - `main` — the op's own row. At most one per plan, and always first.
 * - `sentinel` — a unique-constraint sentinel. `constraintName` and `fields`
 *   are set only on a guarded `Put` that RESERVES a value; the unconditional
 *   `Delete` that releases one carries neither, since it cannot be rejected.
 * - `snapshot` — a `versioned: { retain: true }` copy of the outgoing row.
 * - `tombstone` — a soft-delete row relocated to its deleted sort key.
 */
export interface PlannedTransactItem {
  readonly item: TransactWriteItem
  readonly kind: "main" | "sentinel" | "snapshot" | "tombstone"
  readonly constraintName?: string | undefined
  readonly fields?: Record<string, string> | undefined
}

export interface TransactPlan {
  readonly [TransactPlanTypeId]: TransactPlanTypeId
  /** Empty when the op resolves to no write (an update with nothing to set). */
  readonly items: ReadonlyArray<PlannedTransactItem>
}

export const makeTransactPlan = (items: ReadonlyArray<PlannedTransactItem>): TransactPlan => ({
  [TransactPlanTypeId]: TransactPlanTypeId,
  items,
})

export const isTransactPlan = (u: unknown): u is TransactPlan =>
  typeof u === "object" && u !== null && TransactPlanTypeId in u
