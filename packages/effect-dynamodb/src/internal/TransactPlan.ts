/**
 * TransactPlan — the items one entity write would issue, compiled but not sent.
 *
 * `update` and `delete` compile in two steps: a prepare step that makes every
 * read the op needs and returns a plan, and a run step that sends it. The
 * standalone op runs both; `Transaction.transactWrite` takes the prepared
 * items instead (`Entity._planUpdate` / `_planDelete`), with a read guard on
 * the main item wherever the plan was derived from a read — see `readGuard`
 * in `Entity.ts`. One compile step, so the two cannot drift.
 *
 * Lives in its own module so `Entity.ts` can produce it and
 * `TransactWriteOps.ts` can consume it without a runtime import cycle.
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"

/**
 * One planned item and what it is for. The role is set where the item is
 * created, so nothing downstream infers it from the item's position.
 *
 * - `main` — the op's own row. Exactly one per non-empty plan.
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
  /** Empty when the op resolves to no write (an update with nothing to set). */
  readonly items: ReadonlyArray<PlannedTransactItem>
}

/**
 * Spread a compiled condition onto a `Put` / `Delete` / `ConditionCheck` entry.
 * `ExpressionAttributeValues` is omitted when empty — DynamoDB rejects an empty
 * map, and value-free conditions (`attribute_not_exists`, `attribute_exists`)
 * produce one. Shared by `Entity.ts` and `TransactWriteOps.ts`.
 */
export const conditionFields = (
  condition:
    | {
        readonly expression: string
        readonly names: Record<string, string>
        readonly values: Record<string, AttributeValue>
      }
    | undefined,
) =>
  condition === undefined
    ? {}
    : {
        ConditionExpression: condition.expression,
        ExpressionAttributeNames: condition.names,
        ...(Object.keys(condition.values).length > 0
          ? { ExpressionAttributeValues: condition.values }
          : {}),
      }
