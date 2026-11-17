/**
 * @internal An aggregate's write requests (#168, `docs/designs/aggregate-concurrency.md` §3):
 * the guard on each row a write sends, the units of a write packed into as few
 * `TransactWriteItems` requests as DynamoDB's limits on one allow, the fence each request without
 * the root carries, and the verdict on a cancelled request.
 *
 * Nothing here is a pre-check of a limit DynamoDB enforces (#144): packing picks request boundaries
 * and the lighter guard (D18) picks a condition, both by the exact size model in `ItemSize.ts`, and
 * neither refuses anything. A unit over a limit on its own is sent alone, for DynamoDB to reject and
 * the diagnosis to name.
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import {
  AggregateAssemblyError,
  AggregateTransactionOverflow,
  type BlobStoreError,
  ConcurrentModification,
  isAwsTransactionCancelled,
  OptimisticLockError,
  TransactionCancelled,
  type ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect, Option } from "effect"
import type { DynamoClientError, DynamoClientService } from "../DynamoClient.js"
import { expiredWithCommitted } from "./BlobCalls.js"
import * as Capacity from "./Capacity.js"
import { expressionFits, preferredGuard, sizeOperand, wholeRowGuard } from "./ExpressionLimits.js"
import {
  attributeBytes,
  jsonBytes,
  packRequests,
  type RequestShape,
  TRANSACT_WRITE_MAX_BYTES,
  transactItemBytes,
  transactionBytes,
  transactWriteShape,
  transactWriteUnit,
} from "./ItemSize.js"
import { INCARNATION_TOKEN } from "./TransactableOps.js"
import {
  type Diagnosis,
  diagnosedValidationError,
  diagnoseFailure,
  type KeyAttributes,
  transactItemTarget,
} from "./WriteDiagnosis.js"

/** A condition on one item of a transaction. */
export type Guard = {
  readonly ConditionExpression: string
  readonly ExpressionAttributeNames: Record<string, string>
  readonly ExpressionAttributeValues?: Record<string, AttributeValue>
}

/**
 * What an item of a write is, for the verdict on a cancelled request:
 *
 * - `root`: the root's `Put` (guarded as read on `update`, `attribute_not_exists` on `create`) or a
 *   versioned aggregate's version `Update` of the root;
 * - `fence`: a `ConditionCheck` of the root (`fence: true` or `versioned`);
 * - `row`: a `Put` or `Delete` of a row read, guarded as read;
 * - `new`: a `Put` of a row not read, `attribute_not_exists`;
 * - `cleanup`: an `ownsRows` cleanup `Delete`, gone or as read.
 */
export type ItemRole = "root" | "fence" | "row" | "new" | "cleanup"

/** One item of a write, with what the verdict needs to name it. */
export interface PlannedItem {
  readonly action: TransactWriteItem
  readonly role: ItemRole
  /** The row's member path (`"team1.lines[b]"`; `""` for the root). */
  readonly name: string
  /** The row as read, as stored: what its guard compares and a conflict is named against. */
  readonly read?: Record<string, AttributeValue> | undefined
  /** The item again, its attributes in `bySize` compared by size (D18). */
  readonly sized?: ((bySize: ReadonlySet<string>) => TransactWriteItem) | undefined
  /**
   * On the root's items, a versioned aggregate's version and token this item expects stored, and the
   * version a conflict on it reports as expected (`reported`, else `version`): the fence of a later
   * request expects this writer's own next version, and reports the version the writer read.
   */
  readonly expects?:
    | {
        readonly version: number
        readonly token: string | undefined
        readonly reported?: number | undefined
      }
    | undefined
}

/** Items that must share one transaction: a group's rows, or one cleanup `Delete`. */
export interface PlannedUnit {
  readonly group: string
  readonly items: ReadonlyArray<PlannedItem>
  /** How many of its items delete rows read under the sort key text 1.40.0 composed (#241). */
  readonly previous?: number | undefined
}

const NONE: ReadonlySet<string> = new Set()

/**
 * The guard on a row read (D1, D14): the row exactly as read, with each attribute its entity type can
 * hold that it didn't still absent (`wholeRowGuard`, as `rekey` guards a move), or, for a row too
 * wide for one expression, `prefer` first (an `updatedAt`, a version and token) and as many other
 * attributes as fit (`preferredGuard`).
 */
export const rowGuard = (
  read: Record<string, AttributeValue>,
  pkField: string,
  prefer: ReadonlyArray<string>,
  absent: ReadonlyArray<string>,
  bySize: ReadonlySet<string> = NONE,
): Guard =>
  wholeRowGuard(byName(read), pkField, prefer, [], absent, bySize) ??
  preferredGuard(byName(read), pkField, prefer, absent, bySize)

/**
 * A row's attributes in name order: DynamoDB hands a row's attributes back in an order of its own,
 * so a guard built in that order would name the same row by other placeholders from one read to
 * the next. In name order the guard on a row is one text.
 */
const byName = (read: Record<string, AttributeValue>): Record<string, AttributeValue> =>
  Object.fromEntries(Object.entries(read).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

/** The guard on a row the write didn't read: nothing is there. */
export const absentGuard = (pkField: string): Guard => ({
  ConditionExpression: "attribute_not_exists(#pk)",
  ExpressionAttributeNames: { "#pk": pkField },
})

/**
 * The guard on an `ownsRows` cleanup `Delete` (D10): the row is gone, or still as read. A row too
 * wide for that in one expression falls back to 1.40.0's: gone, or still of the type read.
 */
export const goneOrAsReadGuard = (
  read: Record<string, AttributeValue>,
  pkField: string,
  prefer: ReadonlyArray<string>,
  absent: ReadonlyArray<string>,
  entityType: string,
  bySize: ReadonlySet<string> = NONE,
): Guard => {
  const wrap = (guard: Guard | undefined): Guard | undefined => {
    if (guard === undefined) return undefined
    const expression = `attribute_not_exists(#cpk) OR (${guard.ConditionExpression})`
    if (!expressionFits(expression)) return undefined
    return {
      ...guard,
      ConditionExpression: expression,
      ExpressionAttributeNames: { ...guard.ExpressionAttributeNames, "#cpk": pkField },
    }
  }
  return (
    wrap(wholeRowGuard(byName(read), pkField, prefer, [], absent, bySize)) ??
    wrap(preferredGuard(byName(read), pkField, prefer, absent, bySize)) ?? {
      ConditionExpression: "attribute_not_exists(#cpk) OR #e = :e",
      ExpressionAttributeNames: { "#cpk": pkField, "#e": "__edd_e__" },
      ExpressionAttributeValues: { ":e": { S: entityType } },
    }
  )
}

/** A failed condition answers the item as stored, at no capacity (§3.2). */
export const withAllOld = <A extends object>(action: A): A => ({
  ...action,
  ReturnValuesOnConditionCheckFailure: "ALL_OLD",
})

/** An item with its condition left out: what it counts against 4 MB unguarded. */
const unguarded = (item: TransactWriteItem): TransactWriteItem => {
  if (item.Put !== undefined) return { Put: { TableName: item.Put.TableName, Item: item.Put.Item } }
  if (item.Delete !== undefined) {
    return { Delete: { TableName: item.Delete.TableName, Key: item.Delete.Key } }
  }
  return item
}

/** An attribute over this many bytes may be compared by size in a lighter guard (D18). */
const LARGE_ATTRIBUTE_BYTES = 1024

/**
 * A unit over `budget` bytes only because of its guards (D18): its rows' guards compare each
 * attribute over 1 KB by `size()` instead of by value, then as many of those whole again as still
 * fit. Choosing the condition by measure refuses nothing: a unit still over is sent as it is, for
 * DynamoDB to judge. A unit within `budget`, or over it unguarded too, is returned as it is.
 */
export const lighten = (unit: PlannedUnit, budget: number): PlannedUnit => {
  const actions = unit.items.map((item) => item.action)
  if (transactionBytes(actions) <= budget) return unit
  if (transactionBytes(actions.map(unguarded)) > budget) return unit
  const candidates = unit.items.map((item) =>
    item.sized === undefined || item.read === undefined
      ? []
      : Object.entries(item.read)
          .filter(
            ([, value]) =>
              attributeBytes(value) > LARGE_ATTRIBUTE_BYTES && sizeOperand(value) !== undefined,
          )
          .map(([name]) => name),
  )
  if (candidates.every((names) => names.length === 0)) return unit
  const build = (sets: ReadonlyArray<ReadonlySet<string>>): Array<TransactWriteItem> =>
    unit.items.map((item, k) =>
      sets[k]!.size > 0 && item.sized !== undefined ? item.sized(sets[k]!) : item.action,
    )
  const lightest = candidates.map((names) => new Set(names))
  const light = build(lightest)
  let bytes = transactionBytes(light)
  const withItems = (built: ReadonlyArray<TransactWriteItem>): PlannedUnit => ({
    ...unit,
    items: unit.items.map((item, k) => ({ ...item, action: built[k]! })),
  })
  if (bytes > budget) return withItems(light)
  // As many whole values back as still fit: `size(#gN) = :gN` and the size number out, the value in.
  const sets = lightest.map((set) => new Set(set))
  candidates.forEach((names, k) => {
    for (const name of names) {
      const value = unit.items[k]!.read![name]!
      const delta = attributeBytes(value) - attributeBytes(sizeOperand(value)!) - 6
      if (bytes + delta > budget) continue
      sets[k]!.delete(name)
      bytes += delta
    }
  })
  const fuller = build(sets)
  return withItems(transactionBytes(fuller) <= budget ? fuller : light)
}

/** The error a cancelled request's verdict gives, or `undefined` for `TransactionCancelled`. */
export type Verdict<E> = (
  reasons: ReadonlyArray<{
    readonly Code?: string
    readonly Item?: Readonly<Record<string, unknown>>
  }>,
  items: ReadonlyArray<PlannedItem>,
  committed: ReadonlyArray<string>,
) => E | undefined

/** What every aggregate write's requests share. */
export interface SendOptions<E> {
  readonly tableName: string
  readonly aggregateName: string
  readonly keys: { readonly pkField: string; readonly keys: KeyAttributes }
  readonly operation: "create" | "update"
  /** The item each request without a `root` item carries (`fence: true` or `versioned`). */
  readonly fence?: PlannedItem | undefined
  readonly verdict: Verdict<E>
}

export type SendError =
  | AggregateTransactionOverflow
  | DynamoClientError
  | TransactionCancelled
  | ValidationError
  | BlobStoreError

/**
 * Send `units`, in order, in as few `TransactWriteItems` requests as fit (D3, D16): whole units,
 * never one split, the first request holding the root. With a fence, each request without a `root`
 * item carries it, and every request but a first holding the root is packed against a shape one
 * item and one fence smaller, so no request is packed full and then given one item more. A failure
 * of a later request says what the earlier ones committed (D9).
 */
export const sendUnits = <E>(
  client: DynamoClientService,
  units: ReadonlyArray<PlannedUnit>,
  options: SendOptions<E>,
): Effect.Effect<void, SendError | E> =>
  Effect.gen(function* () {
    const sending = units.filter((unit) => unit.items.length > 0)
    if (sending.length === 0) return
    const shape = transactWriteShape(yield* Capacity.requestFields)
    const fence = options.fence?.action
    const reduced: RequestShape =
      fence === undefined
        ? shape
        : {
            count: shape.count - 1,
            bytes: (shape.bytes ?? TRANSACT_WRITE_MAX_BYTES) - transactItemBytes(fence),
            envelope: shape.envelope + jsonBytes(fence) + 1,
          }
    const holdsRoot = (unit: PlannedUnit) => unit.items.some((item) => item.role === "root")
    const firstHoldsRoot = holdsRoot(sending[0]!)
    const lightened = sending.map((unit, u) =>
      lighten(
        unit,
        (u === 0 && firstHoldsRoot ? shape.bytes : reduced.bytes) ?? TRANSACT_WRITE_MAX_BYTES,
      ),
    )
    const requests = packRequests(
      lightened,
      (unit) => transactWriteUnit(unit.items.map((item) => item.action)),
      reduced,
      firstHoldsRoot ? shape : reduced,
    )
    const committed: Array<string> = []
    for (const request of requests) {
      const planned: Array<PlannedItem> = request.flatMap((unit) => unit.items)
      if (options.fence !== undefined && !planned.some((item) => item.role === "root")) {
        planned.push(options.fence)
      }
      const transactItems = planned.map((item) => item.action)
      /** The group each item is of: the fence, pushed last, is the root's check, of none. */
      const groupOf = request.flatMap((unit) => unit.items.map(() => unit.group))
      const groups = [...new Set(request.map((unit) => unit.group))]
      const previous = request.reduce((sum, unit) => sum + (unit.previous ?? 0), 0)
      const sent = () => ({
        _tag: "Transaction" as const,
        items: transactItems,
        targets: () =>
          transactItems.map((item, i) => {
            const entityType =
              item.Put?.Item?.__edd_e__?.S ??
              planned[i]?.read?.__edd_e__?.S ??
              options.aggregateName
            return transactItemTarget(
              item,
              options.tableName,
              [options.keys.pkField, "sk"],
              entityType,
              planned[i]?.role === "fence"
                ? "the root's fence"
                : `the ${item.Put !== undefined ? entityType : "removed"} item of sub-aggregate ` +
                    `"${groupOf[i] ?? groups.join('", "')}"`,
            )
          }),
      })
      const already = [...committed]
      const diagnosed = (
        diagnosis: Diagnosis,
        original: unknown,
      ): AggregateTransactionOverflow | ValidationError =>
        diagnosis._tag === "TooManyItems"
          ? new AggregateTransactionOverflow({
              aggregate: options.aggregateName,
              subgraph: groups.join(", "),
              itemCount: diagnosis.count,
              limit: diagnosis.limit,
              committed: already,
              operation: options.operation,
              // Over only because of the rows it moves off 1.40.0's text: `rekey` moves them.
              ...(previous > 0 &&
                diagnosis.count - previous <= diagnosis.limit && { previousKeyText: previous }),
              cause: original,
            })
          : diagnosedValidationError(diagnosis, original, {
              operation: `Aggregate.write(${options.aggregateName})`,
              entityType: options.aggregateName,
              ...(already.length > 0 && {
                committed:
                  `earlier transactions of this write already committed sub-aggregates ` +
                  already.map((name) => `"${name}"`).join(", ") +
                  (options.operation === "create"
                    ? ", so a retried create fails on the existing root: update or delete " +
                      "the partial aggregate instead"
                    : ""),
              }),
            })

      yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
        // An upload over its store's `maxUploadAge` (#179, design §6.1) refuses the request before
        // it is sent: say what earlier requests committed.
        Effect.mapError((error) =>
          already.length === 0
            ? error
            : expiredWithCommitted(
                error,
                "earlier transactions of this write already committed sub-aggregates " +
                  already.map((name) => `"${name}"`).join(", "),
              ),
        ),
        // One operation per item (#144): diagnosed BEFORE the conditional mapping, which would
        // read a repeat's conditional failure as a conflict.
        diagnoseFailure({ sent, only: ["RepeatedItem"], rewrite: diagnosed }),
        Effect.mapError((error): SendError | E => {
          const cause = (error as { cause?: unknown }).cause
          if (!isAwsTransactionCancelled(cause)) return error
          const reasons = cause.CancellationReasons ?? []
          const judged = options.verdict(reasons, planned, already)
          if (judged !== undefined) return judged
          return new TransactionCancelled({
            operation: "TransactWriteItems",
            reasons: reasons.map((r) => ({ code: r?.Code, message: r?.Message })),
            cause,
          })
        }),
        // A limit DynamoDB enforced (#144), named, after the conditional mapping.
        diagnoseFailure({ sent, keys: () => options.keys.keys, rewrite: diagnosed }),
      )
      for (const group of groups) if (!committed.includes(group)) committed.push(group)
    }
  })

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** Two stored values alike, as DynamoDB compares them: binary by its bytes, the rest by its form. */
const sameStored = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false
    return a.every((byte, i) => byte === b[i])
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const bKeys = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) =>
    sameStored((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

/** `name.attribute`, or `attribute` alone on the root (whose name is `""`). */
const pathOf = (name: string, attribute: string) =>
  name === "" ? attribute : `${name}.${attribute}`

/**
 * The attributes of a failing row (D15): each attribute that differs between the row as read and
 * the row as stored (`ALL_OLD`), by member path; a row that appeared or vanished by its path alone.
 */
const changedAttributes = (
  item: PlannedItem,
  stored: Readonly<Record<string, unknown>> | undefined,
  pkField: string,
): ReadonlyArray<string> => {
  const vanished = item.name === "" ? "(root)" : item.name
  if (item.role === "new") return [vanished]
  if (stored === undefined || item.read === undefined) return [vanished]
  const names = new Set([...Object.keys(item.read), ...Object.keys(stored)])
  const changed = [...names]
    .filter((name) => name !== pkField && name !== "sk")
    .filter((name) => !sameStored(item.read![name], stored[name]))
    .sort()
    .map((name) => pathOf(item.name, name))
  return changed.length > 0 ? changed : [vanished]
}

const storedVersion = (
  stored: Readonly<Record<string, unknown>>,
  field: string,
): { readonly version: number; readonly token: string | undefined } => {
  const version = (stored[field] as { N?: string } | undefined)?.N
  return {
    version: version === undefined ? 0 : Number(version),
    token: (stored[INCARNATION_TOKEN] as { S?: string } | undefined)?.S,
  }
}

/**
 * `update`'s verdict on a cancelled request (§3.6): the root gone (an item on the root failed with
 * nothing stored) is `AggregateAssemblyError`, as a read finding nothing is; on a versioned aggregate
 * a root whose version or token moved is `OptimisticLockError`; a row that changed is
 * `ConcurrentModification` (versioned: `OptimisticLockError` with the version unmoved), each naming
 * the rows by member path; anything else (`TransactionConflict`) is `undefined`, a
 * `TransactionCancelled`.
 */
export const updateVerdict =
  (context: {
    readonly aggregateName: string
    readonly key: Record<string, unknown>
    readonly pkField: string
    /** A versioned aggregate's version attribute and the version read. */
    readonly versioned?: { readonly field: string; readonly read: number } | undefined
  }): Verdict<AggregateAssemblyError | ConcurrentModification | OptimisticLockError> =>
  (reasons, items, committed) => {
    const failing = reasons.flatMap((reason, i) =>
      reason?.Code === "ConditionalCheckFailed" && items[i] !== undefined
        ? [{ item: items[i]!, stored: reason.Item }]
        : [],
    )
    if (failing.length === 0) return undefined
    const onRoot = failing.filter(({ item }) => item.role === "root" || item.role === "fence")
    if (onRoot.some(({ stored }) => stored === undefined)) {
      return new AggregateAssemblyError({
        aggregate: context.aggregateName,
        reason: "No items found for aggregate key",
        key: context.key,
      })
    }
    const extra = committed.length > 0 ? { committed } : {}
    const versioned = context.versioned
    if (versioned !== undefined) {
      for (const { item, stored } of onRoot) {
        const expects = item.expects
        if (expects === undefined || stored === undefined) continue
        const now = storedVersion(stored, versioned.field)
        if (now.version !== expects.version || now.token !== expects.token) {
          return new OptimisticLockError({
            entityType: context.aggregateName,
            key: context.key,
            expectedVersion: expects.reported ?? expects.version,
            actualVersion: now.version,
            ...extra,
          })
        }
      }
    }
    const attributes = [
      ...new Set(
        failing
          .filter(({ item }) => item.role !== "fence")
          .flatMap(({ item, stored }) => changedAttributes(item, stored, context.pkField)),
      ),
    ]
    if (versioned !== undefined) {
      return new OptimisticLockError({
        entityType: context.aggregateName,
        key: context.key,
        expectedVersion: versioned.read,
        actualVersion: versioned.read,
        attributes,
        ...extra,
      })
    }
    return new ConcurrentModification({
      entityType: context.aggregateName,
      key: context.key,
      attributes,
      current: Option.none(),
      ...extra,
    })
  }
