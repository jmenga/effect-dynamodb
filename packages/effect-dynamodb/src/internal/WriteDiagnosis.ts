/**
 * @internal Failure-time diagnosis of DynamoDB's write limits (#144).
 *
 * The library does not pre-check limits DynamoDB enforces itself — the 400 KB
 * item, the 4 MB and 100-item transaction, the 1024-byte sort key. It sends the
 * write; when DynamoDB rejects it, this module:
 *
 * 1. **recognises** the rejection by a stable fragment of its message (a
 *    request-wide `ValidationException`, or a `TransactionCanceledException`
 *    whose positional reason carries `Code: "ValidationError"`);
 * 2. **confirms** it by measuring the request the site sent — exactly (an item
 *    count, a key's UTF-8 bytes: confirmed only when over the limit) or, for
 *    DynamoDB's approximate item sizes, by checking the request holds
 *    something the message can apply to;
 * 3. **attributes** it to the culprit item, using the targets the site built.
 *
 * A site turns the {@link Diagnosis} into its own tagged error with
 * DynamoDB's error kept as the cause ({@link withCause}); anything
 * unrecognised or unconfirmed passes through unchanged. Nothing is measured,
 * and no target is built, unless DynamoDB has rejected the request.
 */

import type { AttributeValue, TransactWriteItem, WriteRequest } from "@aws-sdk/client-dynamodb"
import {
  isAwsTransactionCancelled,
  isAwsValidationError,
  TRANSACT_WRITE_ITEMS_LIMIT,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import {
  attributeBytes,
  ITEM_MAX_BYTES,
  TRANSACT_WRITE_MAX_BYTES,
  transactItemBytes,
} from "./ItemSize.js"

/** DynamoDB's limit on a sort (range) key value, in UTF-8 bytes. */
export const SORT_KEY_MAX_BYTES = 1024

// ---------------------------------------------------------------------------
// Targets: the item an entry writes, and how to name it
// ---------------------------------------------------------------------------

/** The item a transact entry writes or checks, and how to name it in an error. */
export type TransactItemTarget = {
  /** Its table and primary key, as one comparable string. */
  readonly identity: string
  /** The entity (or stream) it belongs to. */
  readonly entityType: string
  /** What put it in the transaction: `operation 2 (User)`, `the event at version 4`. */
  readonly source: string
  /** The key, readable: `pk=…, sk=…`. */
  readonly key: string
}

/**
 * The target of a transact entry in `tableName`, keyed by `keyFields` (the
 * table's primary key attributes): read from a Put's item, or any other
 * entry's `Key`.
 */
export const transactItemTarget = (
  item: TransactWriteItem,
  tableName: string,
  keyFields: ReadonlyArray<string>,
  entityType: string,
  source: string,
): TransactItemTarget => {
  const attributes: Record<string, AttributeValue> | undefined =
    item.Put?.Item ?? item.Delete?.Key ?? item.Update?.Key ?? item.ConditionCheck?.Key
  const parts = keyFields.map((field) => {
    const value = attributes?.[field]
    return { field, value, text: value?.S ?? value?.N ?? JSON.stringify(value ?? null) }
  })
  return {
    identity: [
      tableName,
      ...parts.map((p) => `${p.field}=${JSON.stringify(p.value ?? null)}`),
    ].join("\u0000"),
    entityType,
    source,
    key: parts.map((p) => `${p.field}=${p.text}`).join(", "),
  }
}

// ---------------------------------------------------------------------------
// What was sent, and what went wrong
// ---------------------------------------------------------------------------

/**
 * What a site sent, as the diagnosis needs it. A single-item write is given
 * in its transact-entry form (`{ Put }`, `{ Update }`, `{ Delete }`); a batch
 * as its requests flattened to the same form ({@link batchEntries}). Targets
 * are thunks: built only once DynamoDB has rejected the request.
 */
export type SentWrite =
  | {
      readonly _tag: "Item"
      readonly item: TransactWriteItem
      readonly target: () => TransactItemTarget
    }
  | {
      readonly _tag: "Transaction"
      readonly items: ReadonlyArray<TransactWriteItem>
      readonly targets: () => ReadonlyArray<TransactItemTarget>
    }
  | {
      readonly _tag: "Batch"
      readonly items: ReadonlyArray<TransactWriteItem>
      readonly targets: () => ReadonlyArray<TransactItemTarget>
    }
  | { readonly _tag: "TransactGet"; readonly count: number }

/** A confirmed reading of DynamoDB's rejection, naming the culprit. */
export type Diagnosis =
  | {
      readonly _tag: "ItemTooLarge"
      readonly target: TransactItemTarget
      /** The item's size by the library's lower-bound count, when the request carries it. */
      readonly bytes: number | undefined
      /** No item measures over the limit: this is the largest, named as the likely culprit. */
      readonly likely: boolean
    }
  | { readonly _tag: "TooManyItems"; readonly count: number; readonly limit: number }
  | {
      readonly _tag: "TransactionTooLarge"
      /** DynamoDB's `Payload Size`, when its message carries one. */
      readonly reported: number | undefined
      /** The library's lower-bound total of the items sent. */
      readonly measured: number
      /** The largest contributors, largest first (at most three). */
      readonly largest: ReadonlyArray<{
        readonly target: TransactItemTarget
        readonly bytes: number
      }>
    }
  | {
      readonly _tag: "SortKeyTooLong"
      readonly target: TransactItemTarget
      readonly attribute: string
      readonly bytes: number
    }

// ---------------------------------------------------------------------------
// Recognise
// ---------------------------------------------------------------------------

const ITEM_SIZE = /Item size has exceeded the maximum allowed size/i
const ITEM_SIZE_UPDATE = /Item size to update has exceeded/i
const ITEM_COUNT = /length less than or equal to 100\b/i
const PAYLOAD = /payload size cannot exceed 4\s?MB/i
const PAYLOAD_SIZE = /Payload Size:\s*(\d+)/i
// DynamoDB Local's wording, then AWS's documented one.
const SORT_KEY = /Size limit exceeded|Aggregated size of all range keys/i

type CancellationReason = {
  readonly code?: string | undefined
  readonly message?: string | undefined
}

type Failure =
  | { readonly _tag: "Request"; readonly message: string }
  | { readonly _tag: "Cancelled"; readonly reasons: ReadonlyArray<CancellationReason | undefined> }

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (cause !== null && typeof cause === "object" && "message" in cause) {
    return String((cause as { message: unknown }).message)
  }
  return ""
}

/**
 * The failure a write's error carries, if it is one this module can read: a
 * DynamoDB `ValidationException` (however the client classified it), a
 * `TransactionCanceledException`, or a site's `TransactionCancelled`.
 */
const readFailure = (error: unknown): Failure | undefined => {
  if (error === null || typeof error !== "object" || !("_tag" in error)) return undefined
  const tagged = error as { readonly _tag: unknown; readonly cause?: unknown }
  if (tagged._tag === "TransactionCancelled") {
    return {
      _tag: "Cancelled",
      reasons:
        (error as { readonly reasons?: ReadonlyArray<CancellationReason | undefined> }).reasons ??
        [],
    }
  }
  if (tagged._tag !== "DynamoError" && tagged._tag !== "DynamoValidationError") return undefined
  const cause = tagged.cause
  if (isAwsValidationError(cause)) return { _tag: "Request", message: messageOf(cause) }
  if (isAwsTransactionCancelled(cause)) {
    return {
      _tag: "Cancelled",
      reasons: (cause.CancellationReasons ?? []).map((r) =>
        r === undefined ? undefined : { code: r.Code, message: r.Message },
      ),
    }
  }
  return undefined
}

/** Whether `error` is a write failure this module could diagnose at all. */
export const isDiagnosable = (error: unknown): boolean => readFailure(error) !== undefined

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------

/**
 * The attributes an entry writes, as far as its request shows them: a Put's
 * item, any entry's key, and an Update's `SET #name = :value` pairs.
 */
const writtenAttributes = (item: TransactWriteItem): Record<string, AttributeValue> => {
  if (item.Put !== undefined) return item.Put.Item ?? {}
  const keyed = item.Delete ?? item.ConditionCheck
  if (keyed !== undefined) return keyed.Key ?? {}
  const update = item.Update
  if (update === undefined) return {}
  const written: Record<string, AttributeValue> = { ...update.Key }
  const names = update.ExpressionAttributeNames ?? {}
  const values = update.ExpressionAttributeValues ?? {}
  const setClause = /\bSET\b([\s\S]*?)(?=\b(?:REMOVE|ADD|DELETE)\b|$)/i.exec(
    update.UpdateExpression ?? "",
  )?.[1]
  if (setClause !== undefined) {
    for (const match of setClause.matchAll(/(#[\w]+)\s*=\s*(:[\w]+)\s*(?=,|$)/g)) {
      const name = names[match[1]!]
      const value = values[match[2]!]
      if (name !== undefined && value !== undefined) written[name] = value
    }
  }
  return written
}

/** A key attribute's size, by DynamoDB's rules: a string's UTF-8 bytes, a binary's bytes. */
const keyBytes = (value: AttributeValue): number => attributeBytes(value, "lower")

/** The first range-key attribute of `item` over {@link SORT_KEY_MAX_BYTES}. */
const oversizedRangeKey = (
  item: TransactWriteItem,
  rangeKeys: ReadonlyArray<string>,
): { readonly attribute: string; readonly bytes: number } | undefined => {
  const written = writtenAttributes(item)
  for (const attribute of rangeKeys) {
    const value = written[attribute]
    if (value === undefined) continue
    const bytes = keyBytes(value)
    if (bytes > SORT_KEY_MAX_BYTES) return { attribute, bytes }
  }
  return undefined
}

const putBytes = (item: TransactWriteItem): number | undefined =>
  item.Put === undefined ? undefined : transactItemBytes(item)

// ---------------------------------------------------------------------------
// Confirm and attribute
// ---------------------------------------------------------------------------

const entriesOf = (sent: SentWrite): ReadonlyArray<TransactWriteItem> =>
  sent._tag === "Item" ? [sent.item] : sent._tag === "TransactGet" ? [] : sent.items

const targetAt = (sent: SentWrite, index: number): TransactItemTarget | undefined => {
  if (sent._tag === "Item") return index === 0 ? sent.target() : undefined
  if (sent._tag === "TransactGet") return undefined
  return sent.targets()[index]
}

/** The `Put` over the item limit, else the largest `Put` (likely), else `undefined`. */
const oversizedPut = (sent: SentWrite): Diagnosis | undefined => {
  const entries = entriesOf(sent)
  let largest: { index: number; bytes: number } | undefined
  for (const [index, item] of entries.entries()) {
    const bytes = putBytes(item)
    if (bytes === undefined) continue
    if (bytes > ITEM_MAX_BYTES) {
      const target = targetAt(sent, index)
      return target === undefined
        ? undefined
        : { _tag: "ItemTooLarge", target, bytes, likely: false }
    }
    if (largest === undefined || bytes > largest.bytes) largest = { index, bytes }
  }
  if (largest === undefined) return undefined
  const target = targetAt(sent, largest.index)
  if (target === undefined) return undefined
  return {
    _tag: "ItemTooLarge",
    target,
    bytes: largest.bytes,
    likely: sent._tag !== "Item",
  }
}

/** The one `Update` an item-size-to-update message can mean, if the request holds one. */
const growingUpdate = (sent: SentWrite): Diagnosis | undefined => {
  const entries = entriesOf(sent)
  const updates = [...entries.entries()].filter(([, item]) => item.Update !== undefined)
  if (updates.length !== 1) return undefined
  const target = targetAt(sent, updates[0]![0])
  return target === undefined
    ? undefined
    : { _tag: "ItemTooLarge", target, bytes: undefined, likely: sent._tag !== "Item" }
}

const sortKeyAt = (
  sent: SentWrite,
  index: number,
  rangeKeys: ReadonlyArray<string>,
): Diagnosis | undefined => {
  const item = entriesOf(sent)[index]
  if (item === undefined) return undefined
  const over = oversizedRangeKey(item, rangeKeys)
  if (over === undefined) return undefined
  const target = targetAt(sent, index)
  return target === undefined ? undefined : { _tag: "SortKeyTooLong", target, ...over }
}

const anySortKey = (sent: SentWrite, rangeKeys: ReadonlyArray<string>): Diagnosis | undefined => {
  const entries = entriesOf(sent)
  for (let index = 0; index < entries.length; index++) {
    const found = sortKeyAt(sent, index, rangeKeys)
    if (found !== undefined) return found
  }
  return undefined
}

const diagnoseRequest = (
  message: string,
  sent: SentWrite,
  rangeKeys: ReadonlyArray<string>,
): Diagnosis | undefined => {
  if (ITEM_COUNT.test(message)) {
    const count =
      sent._tag === "TransactGet"
        ? sent.count
        : sent._tag === "Transaction"
          ? sent.items.length
          : undefined
    return count !== undefined && count > TRANSACT_WRITE_ITEMS_LIMIT
      ? { _tag: "TooManyItems", count, limit: TRANSACT_WRITE_ITEMS_LIMIT }
      : undefined
  }
  if (PAYLOAD.test(message)) {
    if (sent._tag !== "Transaction" || sent.items.length === 0) return undefined
    const sized = sent.items.map((item, index) => ({ index, bytes: transactItemBytes(item) }))
    const measured = sized.reduce((sum, { bytes }) => sum + bytes, 0)
    const targets = sent.targets()
    const largest = [...sized]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3)
      .flatMap(({ index, bytes }) => {
        const target = targets[index]
        return target === undefined ? [] : [{ target, bytes }]
      })
    const reported = PAYLOAD_SIZE.exec(message)?.[1]
    return {
      _tag: "TransactionTooLarge",
      reported: reported === undefined ? undefined : Number(reported),
      measured,
      largest,
    }
  }
  if (SORT_KEY.test(message)) return anySortKey(sent, rangeKeys)
  if (ITEM_SIZE_UPDATE.test(message)) {
    if (sent._tag === "Item") {
      return sent.item.Update === undefined && sent.item.Put === undefined
        ? undefined
        : { _tag: "ItemTooLarge", target: sent.target(), bytes: putBytes(sent.item), likely: false }
    }
    return growingUpdate(sent)
  }
  if (ITEM_SIZE.test(message)) {
    if (sent._tag === "Item" && sent.item.Update !== undefined) {
      return { _tag: "ItemTooLarge", target: sent.target(), bytes: undefined, likely: false }
    }
    return oversizedPut(sent)
  }
  return undefined
}

const diagnoseCancellation = (
  reasons: ReadonlyArray<CancellationReason | undefined>,
  sent: SentWrite,
  rangeKeys: ReadonlyArray<string>,
): Diagnosis | undefined => {
  // A conditional failure is the site's to explain, never this module's.
  if (reasons.some((reason) => reason?.code === "ConditionalCheckFailed")) return undefined
  const entries = entriesOf(sent)
  for (const [index, reason] of reasons.entries()) {
    if (reason?.code !== "ValidationError") continue
    const message = reason.message ?? ""
    const item = entries[index]
    if (item === undefined) continue
    if (SORT_KEY.test(message)) {
      const found = sortKeyAt(sent, index, rangeKeys)
      if (found !== undefined) return found
      continue
    }
    if (
      (ITEM_SIZE_UPDATE.test(message) || ITEM_SIZE.test(message)) &&
      (item.Update !== undefined || item.Put !== undefined)
    ) {
      const target = targetAt(sent, index)
      if (target !== undefined) {
        return { _tag: "ItemTooLarge", target, bytes: putBytes(item), likely: false }
      }
    }
  }
  return undefined
}

/**
 * Read DynamoDB's rejection of `sent`. `rangeKeys` names the sort-key
 * attributes the request writes (the table's and its indexes'), for the
 * sort-key shape. `undefined`: unrecognised or unconfirmed — the site fails
 * with `error` unchanged.
 */
export const diagnoseWriteFailure = (
  error: unknown,
  sent: SentWrite,
  rangeKeys: ReadonlyArray<string>,
): Diagnosis | undefined => {
  const failure = readFailure(error)
  if (failure === undefined) return undefined
  return failure._tag === "Request"
    ? diagnoseRequest(failure.message, sent, rangeKeys)
    : diagnoseCancellation(failure.reasons, sent, rangeKeys)
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

const named = (target: TransactItemTarget): string => `${target.source}, at ${target.key}`

/**
 * The explanation every site puts in its error, so the wording is identical
 * library-wide. `partial`: earlier requests of the operation may already have
 * been written (`Batch.write`, which was never atomic).
 */
export const explainDiagnosis = (
  diagnosis: Diagnosis,
  operation: string,
  options?: { readonly partial?: boolean | undefined },
): string => {
  const outcome =
    options?.partial === true
      ? "This request wrote nothing; earlier requests of the operation may already have been written."
      : "Nothing was written."
  switch (diagnosis._tag) {
    case "ItemTooLarge":
      return (
        `${operation}: DynamoDB rejected the write because an item exceeds its limit of ` +
        `${ITEM_MAX_BYTES} bytes (400 KB) for one item — ` +
        (diagnosis.likely ? "most likely the item of " : "the item of ") +
        named(diagnosis.target) +
        (diagnosis.bytes === undefined
          ? " (the item it would produce is not in the request, so it cannot be measured)"
          : `, at least ${diagnosis.bytes} bytes by DynamoDB's item-size rules`) +
        "." +
        (diagnosis.likely
          ? " No item measures over the limit by the library's lower-bound count, and " +
            "DynamoDB's sizes are approximate, so the largest is named."
          : "") +
        ` ${outcome}`
      )
    case "TooManyItems":
      return (
        `${operation}: the transaction holds ${diagnosis.count} items, over DynamoDB's limit ` +
        `of ${diagnosis.limit} items for one transaction. ${outcome}`
      )
    case "TransactionTooLarge":
      return (
        `${operation}: DynamoDB rejected the transaction for exceeding its limit of ` +
        `${TRANSACT_WRITE_MAX_BYTES} bytes (4 MB) for one transaction` +
        (diagnosis.reported === undefined ? "" : ` (it reported ${diagnosis.reported} bytes)`) +
        `; its items total at least ${diagnosis.measured} bytes by DynamoDB's item-size rules. ` +
        "The largest: " +
        diagnosis.largest
          .map(({ target, bytes }) => `${named(target)} (${bytes} bytes)`)
          .join("; ") +
        ". A put of a retain entity counts twice: its item and its version snapshot. " +
        `Split the operations into smaller transactions. ${outcome}`
      )
    case "SortKeyTooLong":
      return (
        `${operation}: the sort key "${diagnosis.attribute}" of ${named(diagnosis.target)} is ` +
        `${diagnosis.bytes} bytes, longer than DynamoDB's ${SORT_KEY_MAX_BYTES}-byte limit for ` +
        `a sort key. ${outcome}`
      )
  }
}

/**
 * An `Error` carrying `message`, with DynamoDB's error one step down as its
 * own `cause` — what a diagnosed error stores in its `cause`, so the readable
 * text stays where callers look and the original is kept.
 */
export const withCause = (message: string, original: unknown): Error =>
  new Error(message, { cause: original })

/** The entity (or stream) a diagnosis names, for an error's `entityType`. */
export const diagnosedEntityType = (diagnosis: Diagnosis, fallback: string): string =>
  diagnosis._tag === "ItemTooLarge" || diagnosis._tag === "SortKeyTooLong"
    ? diagnosis.target.entityType
    : diagnosis._tag === "TransactionTooLarge"
      ? (diagnosis.largest[0]?.target.entityType ?? fallback)
      : fallback

/** The `ValidationError` a diagnosis becomes at most sites. */
export const diagnosedValidationError = (
  diagnosis: Diagnosis,
  original: unknown,
  options: {
    readonly operation: string
    readonly entityType: string
    readonly partial?: boolean | undefined
  },
): ValidationError =>
  new ValidationError({
    entityType: diagnosedEntityType(diagnosis, options.entityType),
    operation: options.operation,
    cause: withCause(explainDiagnosis(diagnosis, options.operation, options), original),
  })

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Wrap a site's write so that, on failure only, a diagnosable error is read
 * against what was sent and — when confirmed — rewritten by `rewrite`.
 * Everything else, and every success, passes through untouched. Placed after
 * the site's own conditional-failure mapping, so it only ever sees what that
 * mapping could not explain.
 */
export const diagnoseFailure =
  <E2>(options: {
    readonly sent: () => SentWrite
    readonly rangeKeys: () => ReadonlyArray<string>
    readonly rewrite: (diagnosis: Diagnosis, original: unknown) => E2
  }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.catch(self, (error: E) => {
      if (!isDiagnosable(error)) return Effect.fail(error)
      const diagnosis = diagnoseWriteFailure(error, options.sent(), options.rangeKeys())
      return Effect.fail(diagnosis === undefined ? error : options.rewrite(diagnosis, error))
    }) as Effect.Effect<A, E | E2, R>

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * Targets for entries that all share one primary key schema (`keyFields`),
 * named by `source(index, item)`. Each entry's own `TableName` is used.
 */
export const targetsFor = (
  items: ReadonlyArray<TransactWriteItem>,
  keyFields: ReadonlyArray<string>,
  entityType: string | ((index: number) => string),
  source: (index: number, item: TransactWriteItem) => string,
): ReadonlyArray<TransactItemTarget> =>
  items.map((item, index) =>
    transactItemTarget(
      item,
      item.Put?.TableName ??
        item.Update?.TableName ??
        item.Delete?.TableName ??
        item.ConditionCheck?.TableName ??
        "",
      keyFields,
      typeof entityType === "string" ? entityType : entityType(index),
      source(index, item),
    ),
  )

/** A `BatchWriteItem` request map, flattened to transact-entry form in request order. */
export const batchEntries = (
  requestItems: Record<string, ReadonlyArray<WriteRequest>>,
): ReadonlyArray<TransactWriteItem> =>
  Object.entries(requestItems).flatMap(([tableName, requests]) =>
    requests.flatMap((request): ReadonlyArray<TransactWriteItem> => {
      if (request.PutRequest !== undefined) {
        return [{ Put: { TableName: tableName, Item: request.PutRequest.Item ?? {} } }]
      }
      if (request.DeleteRequest !== undefined) {
        return [{ Delete: { TableName: tableName, Key: request.DeleteRequest.Key ?? {} } }]
      }
      return []
    }),
  )

/**
 * The sort-key attributes an entity writes: its primary sort key and each
 * index's. `indexes` is an entity's `indexes` record.
 */
export const rangeKeysOf = (
  indexes: Readonly<Record<string, { readonly sk?: { readonly field: string } | undefined }>>,
): ReadonlyArray<string> => [
  ...new Set(
    Object.values(indexes).flatMap((index) =>
      index?.sk?.field === undefined ? [] : [index.sk.field],
    ),
  ),
]
