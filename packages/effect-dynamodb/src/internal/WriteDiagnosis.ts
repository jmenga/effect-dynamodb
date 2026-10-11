/**
 * @internal Failure-time diagnosis of DynamoDB's rejections (#144).
 *
 * The library does not pre-check limits or request rules DynamoDB enforces
 * itself — the 400 KB item, the 4 MB and 100-item transaction, the 2048-byte
 * partition key and 1024-byte sort key, one operation per item, the limits on
 * one expression, an `IN ()` with no operands, an empty key value, a reversed
 * `BETWEEN`, a consistent read of a GSI, a table's vector index limits, a
 * vector search's `TopK`. It sends the request; when DynamoDB rejects it, this
 * module:
 *
 * 1. **recognises** the rejection by a stable fragment of its message (a
 *    request-wide `ValidationException` or `LimitExceededException`, or a
 *    `TransactionCanceledException` whose positional reason carries
 *    `Code: "ValidationError"`);
 * 2. **confirms** it against the request the site sent — an item count, a
 *    key's UTF-8 bytes, an expression's length or operators, two entries
 *    naming one item, an empty key value, the order of two bounds (each
 *    confirmed only when the request breaks the rule), or, for item and
 *    transaction sizes, by checking the request holds something the message
 *    can apply to and measuring it exactly (`ItemSize.ts`);
 * 3. **attributes** it to the culprit, using the targets the site built.
 *
 * A site turns the {@link Diagnosis} into its own tagged error with
 * DynamoDB's error kept as the cause ({@link withCause}); anything
 * unrecognised or unconfirmed passes through unchanged. Nothing is measured,
 * and no target is built, unless DynamoDB has rejected the request.
 *
 * Every site goes through {@link diagnoseFailure}: writes ({@link SentWrite}),
 * reads ({@link SentRead}), table management ({@link SentTable}) and vector
 * searches ({@link SentSearch}) share the one recognise / confirm / rewrite
 * path.
 */

import type {
  AttributeValue,
  TransactGetItem,
  TransactWriteItem,
  WriteRequest,
} from "@aws-sdk/client-dynamodb"
import {
  isAwsTransactionCancelled,
  isAwsValidationError,
  TRANSACT_WRITE_ITEMS_LIMIT,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import {
  MAX_DIMENSIONS,
  MAX_INLINE_FILTERS,
  MAX_TOP_K,
  MAX_VECTOR_INDEXES_PER_TABLE,
  MIN_DIMENSIONS,
  MIN_TOP_K,
} from "@effect-dynamodb/schema/VectorIndex.js"
import { Effect } from "effect"
import {
  countOperators,
  EXPRESSION_MAX_LENGTH,
  EXPRESSION_MAX_OPERATORS,
  expressionCost,
  IN_MAX_OPERANDS,
  largestInOperands,
} from "./ExpressionLimits.js"
import {
  attributeBytes,
  ITEM_MAX_BYTES,
  itemBytes,
  TRANSACT_WRITE_MAX_BYTES,
  transactItemBytes,
} from "./ItemSize.js"

/** DynamoDB's limit on a partition (hash) key value, in UTF-8 bytes. */
export const PARTITION_KEY_MAX_BYTES = 2048

/** DynamoDB's limit on a sort (range) key value, in UTF-8 bytes. */
export const SORT_KEY_MAX_BYTES = 1024

/**
 * The key attributes a write can carry — its table's and its indexes' — by
 * kind, so an over-long key value can be measured against its limit.
 */
export type KeyAttributes = {
  readonly partition: ReadonlyArray<string>
  readonly sort: ReadonlyArray<string>
}

const NO_KEYS: KeyAttributes = { partition: [], sort: [] }

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
 * entry's `Key` (a `TransactGetItems` entry's included).
 */
export const transactItemTarget = (
  item: TransactWriteItem | TransactGetItem,
  tableName: string,
  keyFields: ReadonlyArray<string>,
  entityType: string,
  source: string,
): TransactItemTarget => {
  const attributes: Record<string, AttributeValue> | undefined =
    "Get" in item && item.Get !== undefined
      ? item.Get.Key
      : (() => {
          const write = item as TransactWriteItem
          return (
            write.Put?.Item ?? write.Delete?.Key ?? write.Update?.Key ?? write.ConditionCheck?.Key
          )
        })()
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
 * What a writing site sent, as the diagnosis needs it. A single-item write is
 * given in its transact-entry form (`{ Put }`, `{ Update }`, `{ Delete }`); a
 * batch as its requests flattened to the same form ({@link batchEntries}).
 * Targets are thunks: built only once DynamoDB has rejected the request.
 *
 * `callerCondition` is the caller's own `.condition()` on the entry at an
 * index (the rest of its `ConditionExpression` is the library's guard), to
 * say how much of an expression rejected for its size is the caller's.
 */
export type SentWrite =
  | {
      readonly _tag: "Item"
      readonly item: TransactWriteItem
      readonly target: () => TransactItemTarget
      readonly callerCondition?: (() => string | undefined) | undefined
    }
  | {
      readonly _tag: "Transaction"
      readonly items: ReadonlyArray<TransactWriteItem>
      readonly targets: () => ReadonlyArray<TransactItemTarget>
      readonly callerCondition?: ((index: number) => string | undefined) | undefined
    }
  | {
      readonly _tag: "Batch"
      readonly items: ReadonlyArray<TransactWriteItem>
      readonly targets: () => ReadonlyArray<TransactItemTarget>
    }
  | {
      readonly _tag: "TransactGet"
      readonly count: number
      /** The item each `Get` reads, to name a repeated one. */
      readonly targets?: (() => ReadonlyArray<TransactItemTarget>) | undefined
    }
  | {
      /** A `BatchGetItem` request: the item each of its keys reads, in request order. */
      readonly _tag: "BatchGet"
      readonly targets: () => ReadonlyArray<TransactItemTarget>
    }

/** What a reading site sent: the `Query` / `Scan` request, as sent. */
export type SentRead = {
  readonly _tag: "Read"
  readonly scan: boolean
  readonly input: {
    readonly IndexName?: string | undefined
    readonly KeyConditionExpression?: string | undefined
    readonly FilterExpression?: string | undefined
    readonly ExpressionAttributeNames?: Record<string, string> | undefined
    readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
    readonly ConsistentRead?: boolean | undefined
  }
}

/** What a vector search sent: its `SearchVectors` request's `TopK`. */
export type SentSearch = {
  readonly _tag: "Search"
  readonly index: string
  readonly topK: number
}

/** A vector index as a `CreateTable` / `UpdateTable` request declares it. */
export type SentVectorIndex = {
  readonly IndexName?: string | undefined
  readonly Dimensions?: number | undefined
  readonly SearchSchema?:
    | ReadonlyArray<{
        readonly AttributeName?: string | undefined
        readonly SearchSchemaElementType?: string | undefined
      }>
    | undefined
}

/** What a table-management site sent: the vector indexes of its request. */
export type SentTable = {
  readonly _tag: "Table"
  readonly operation: "CreateTable" | "UpdateTable"
  /** The vector indexes the request creates. */
  readonly vectorIndexes: ReadonlyArray<SentVectorIndex>
  /** The entities sharing a physical vector index, to name them. */
  readonly sharers: (indexName: string) => ReadonlyArray<string>
  /** How many vector indexes the table's entities declare in all. */
  readonly declared: number
  /**
   * `UpdateTable` only: how many vector indexes the table had when DynamoDB
   * rejected the request, read back (`DescribeTable`) after the rejection.
   * The request shows only the index it adds, so a count rejection is
   * confirmed only when these plus the request's exceed the limit; unknown
   * (the read failed) means unconfirmed.
   */
  readonly existing?: number | undefined
}

/** Any request a site sent. */
export type Sent = SentWrite | SentRead | SentTable | SentSearch

/** A confirmed reading of DynamoDB's rejection, naming the culprit. */
export type Diagnosis =
  | {
      readonly _tag: "ItemTooLarge"
      readonly target: TransactItemTarget
      /** The item's exact size (`itemBytes`), when the request carries the item. */
      readonly bytes: number | undefined
      /** No item measures over the limit: this is the largest, named as the likely culprit. */
      readonly likely: boolean
    }
  | { readonly _tag: "TooManyItems"; readonly count: number; readonly limit: number }
  | {
      readonly _tag: "TransactionTooLarge"
      /** DynamoDB's `Payload Size`, when its message carries one. */
      readonly reported: number | undefined
      /**
       * The request's exact size by the library's model (`transactItemBytes`
       * summed). At or under the limit, the model disagrees with DynamoDB for
       * this request — the error says so and gives both numbers.
       */
      readonly measured: number
      /** The largest contributors, largest first (at most three). */
      readonly largest: ReadonlyArray<{
        readonly target: TransactItemTarget
        readonly bytes: number
      }>
    }
  | {
      /** A key value over its limit: 2048 bytes for a partition key, 1024 for a sort key. */
      readonly _tag: "KeyTooLong"
      readonly target: TransactItemTarget
      readonly kind: "partition" | "sort"
      readonly attribute: string
      readonly bytes: number
    }
  | {
      /** Two entries of one request target one item (DynamoDB allows one each). */
      readonly _tag: "RepeatedItem"
      readonly first: TransactItemTarget
      readonly second: TransactItemTarget
      /** The request was a `BatchWriteItem`, not a transaction. */
      readonly batch: boolean
    }
  | {
      readonly _tag: "ExpressionTooLarge"
      readonly target: TransactItemTarget
      readonly expression: "ConditionExpression" | "UpdateExpression"
      readonly limit: "length" | "operators" | "inOperands"
      /** The expression's length, operators, or largest `IN`, as DynamoDB counts them. */
      readonly measured: number
      /** The caller's own `.condition()` within it, when the site knows it. */
      readonly caller:
        | { readonly length: number; readonly operators: number; readonly inOperands: number }
        | undefined
    }
  | {
      /** A write puts an empty string (or binary) in a key attribute. */
      readonly _tag: "EmptyKey"
      readonly target: TransactItemTarget
      readonly attribute: string
      /** The secondary index whose key it is, as DynamoDB named it. */
      readonly index: string | undefined
    }
  | {
      /**
       * An `isIn()` with no values: its `IN ()`, which DynamoDB rejects as a
       * syntax error, in a write's condition or a read's filter.
       */
      readonly _tag: "EmptyIn"
      readonly expression: "ConditionExpression" | "FilterExpression"
      /** The attribute (path) the `isIn()` tests. */
      readonly attribute: string
      /** The write whose condition holds it; `undefined` for a read's filter. */
      readonly target: TransactItemTarget | undefined
    }
  | {
      /** A query's key condition compares a key attribute with an empty value. */
      readonly _tag: "EmptyKeyBound"
      readonly attribute: string
      readonly index: string | undefined
    }
  | {
      /** A query's `BETWEEN` whose lower bound sorts after its upper bound. */
      readonly _tag: "BetweenReversed"
      readonly attribute: string
      readonly index: string | undefined
      readonly low: string
      readonly high: string
    }
  | {
      /** A consistent read of a GSI, which DynamoDB reads only eventually consistently. */
      readonly _tag: "ConsistentReadOnGsi"
      readonly index: string
      readonly scan: boolean
    }
  | {
      /** A vector index with more `INLINE_FILTER` attributes than DynamoDB allows. */
      readonly _tag: "VectorIndexFilters"
      readonly operation: "CreateTable" | "UpdateTable"
      readonly index: string
      readonly filters: ReadonlyArray<string>
      readonly sharers: ReadonlyArray<string>
      readonly limit: number
    }
  | {
      /** A vector index whose dimensions are outside the range DynamoDB accepts. */
      readonly _tag: "VectorIndexDimensions"
      readonly operation: "CreateTable" | "UpdateTable"
      readonly index: string
      readonly dimensions: number
      readonly sharers: ReadonlyArray<string>
    }
  | {
      /** A vector search's `TopK` outside the range DynamoDB accepts. */
      readonly _tag: "TopKOutOfRange"
      readonly index: string
      readonly topK: number
    }
  | {
      /** More vector indexes on one table than DynamoDB allows the account. */
      readonly _tag: "VectorIndexCount"
      readonly operation: "CreateTable" | "UpdateTable"
      /** The vector indexes the request creates, with the entities sharing each. */
      readonly indexes: ReadonlyArray<{
        readonly index: string
        readonly sharers: ReadonlyArray<string>
      }>
      /** How many vector indexes the table's entities declare in all. */
      readonly declared: number
      /** `UpdateTable`: how many vector indexes the table already had. */
      readonly existing: number | undefined
      /** The limit DynamoDB stated, if its message carries one. */
      readonly stated: number | undefined
    }

// ---------------------------------------------------------------------------
// Recognise
// ---------------------------------------------------------------------------

const ITEM_SIZE = /Item size has exceeded the maximum allowed size/i
const ITEM_SIZE_UPDATE = /Item size to update has exceeded/i
const ITEM_COUNT = /length less than or equal to 100\b/i
const PAYLOAD = /payload size cannot exceed 4\s?MB/i
const PAYLOAD_SIZE = /Payload Size:\s*(\d+)/i
// A key value over its limit. DynamoDB Local words a table key's (partition
// and sort key in one message: "Hash primary key values must be under 2048
// bytes, and range primary key values must be under 1024 bytes") and an index
// key's ("One or more parameter values were invalid: Size limit exceeded")
// alike for both kinds, so either is confirmed against both. AWS words each
// kind its own way: "Aggregated size of all range keys has exceeded the size
// limit of 1024 bytes" (documented) and "Size of hashkey has exceeded the
// maximum size limit of 2048 bytes" (as AWS reports it; unverified here — Local
// cannot produce it).
const KEY_SIZE_EITHER =
  /Size limit exceeded|Hash primary key values must be under 2048 bytes|range primary key values must be under 1024 bytes/i
const KEY_SIZE_SORT = /Aggregated size of all range keys/i
const KEY_SIZE_PARTITION = /Size of hash\s?key has exceeded/i
const KEY_SIZE = new RegExp(
  [KEY_SIZE_EITHER, KEY_SIZE_SORT, KEY_SIZE_PARTITION].map((r) => r.source).join("|"),
  "i",
)
// A transaction (or `TransactGetItems`) naming one item twice; a batch
// request doing so.
const REPEATED = /cannot include multiple operations on one item/i
const REPEATED_BATCH = /Provided list of item keys contains duplicates/i
const EXPRESSION_KIND = /Invalid (\w+)Expression:/i
const EXPRESSION_LENGTH = /Expression size has exceeded the maximum allowed size/i
const EXPRESSION_OPERATORS = /too many operators/i
const EXPRESSION_IN = /IN operator is provided with too many operands/i
const EMPTY_KEY = /cannot contain an empty string value/i
const EMPTY_KEY_INDEX = /IndexName:\s*([^,\s]+),\s*IndexKey:\s*([^,\s]+)/i
const EMPTY_KEY_TABLE = /(?<!Index)Key:\s*([^,\s]+)/
const BETWEEN_REVERSED = /BETWEEN operator requires upper bound to be greater than or equal to/i
const CONSISTENT_GSI = /Consistent read cannot be true when (querying|scanning) a GSI/i
// `IN ()` — an `isIn()` with no values — is a syntax error to DynamoDB
// (Local: 'Invalid ConditionExpression: Syntax error; token: ")", near: "()"',
// the `near` running on to the next token — `"())"`, `"() AND"` — when one
// follows; `FilterExpression` likewise), request-wide even in a transaction.
// The message names no attribute: confirmed by finding the `IN ()` in the
// request.
const EMPTY_IN = /Syntax error; token: "\)", near: "\(\)/i
const EMPTY_IN_OPERAND = /((?:size\(\s*)?[#\w.[\]]+\)?)\s+IN\s*\(\s*\)/i
// A vector index's dimensions or a vector search's TopK outside DynamoDB's
// range. DynamoDB Local has neither vector indexes nor `SearchVectors`, so
// these follow AWS's documented ranges (Dimensions 1..4096, TopK 1..100) and
// its standard member-constraint wording ("Value '5000' at
// 'vectorIndexes.1.member.dimensions' failed to satisfy constraint: Member
// must have value less than or equal to 4096"); unverified on AWS. Matched on
// the member's name only, and confirmed against the request.
const VECTOR_DIMENSIONS = /dimension/i
const TOP_K = /top\s?k/i
// AWS documents the vector-index quotas (18 inline filters per index, 5
// vector indexes per table, adjustable) but not the wording of their
// rejection, and DynamoDB Local has no vector indexes: matched loosely, and
// confirmed against the request.
const VECTOR = /vector/i
const VECTOR_FILTERS = /inline.?filter/i
const VECTOR_COUNT = /limit|exceed|maximum|at most|too many/i
const STATED_LIMIT = /(?:limit|maximum|at most|exceeds?)\D{0,40}?(\d+)/i
// Limits on vector indexes that are not their count per table: how many may
// be created at once ("Only 1 … index can be created or deleted
// simultaneously per table"), or a name's length.
const VECTOR_NOT_COUNT = /simultaneous|at a time|concurrent|in progress|length/i

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

const isAwsLimitExceeded = (cause: unknown): boolean =>
  cause != null &&
  typeof cause === "object" &&
  "name" in cause &&
  (cause as { name: unknown }).name === "LimitExceededException"

/**
 * The failure a site's error carries, if it is one this module can read: a
 * DynamoDB `ValidationException` or `LimitExceededException` (however the
 * client classified it), a `TransactionCanceledException`, or a site's
 * `TransactionCancelled`.
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
  if (isAwsValidationError(cause) || isAwsLimitExceeded(cause)) {
    return { _tag: "Request", message: messageOf(cause) }
  }
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

/** Whether `error` is a rejection this module could diagnose at all. */
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
const keyBytes = (value: AttributeValue): number => attributeBytes(value)

/** An empty string or binary: what DynamoDB refuses as a key value. */
const isEmptyKeyValue = (value: AttributeValue | undefined): boolean =>
  value !== undefined &&
  ((value.S !== undefined && value.S === "") || (value.B !== undefined && value.B.length === 0))

/**
 * The first key attribute of `item` over its limit — a partition key over
 * {@link PARTITION_KEY_MAX_BYTES}, a sort key over {@link SORT_KEY_MAX_BYTES} —
 * among the `kinds` a rejection can mean.
 */
const oversizedKey = (
  item: TransactWriteItem,
  keys: KeyAttributes,
  kinds: ReadonlyArray<"partition" | "sort">,
):
  | { readonly kind: "partition" | "sort"; readonly attribute: string; readonly bytes: number }
  | undefined => {
  const written = writtenAttributes(item)
  for (const kind of kinds) {
    const limit = kind === "partition" ? PARTITION_KEY_MAX_BYTES : SORT_KEY_MAX_BYTES
    for (const attribute of kind === "partition" ? keys.partition : keys.sort) {
      const value = written[attribute]
      if (value === undefined) continue
      const bytes = keyBytes(value)
      if (bytes > limit) return { kind, attribute, bytes }
    }
  }
  return undefined
}

/** The key kinds a key-size message can mean. */
const keySizeKinds = (message: string): ReadonlyArray<"partition" | "sort"> =>
  KEY_SIZE_EITHER.test(message)
    ? ["partition", "sort"]
    : KEY_SIZE_PARTITION.test(message)
      ? ["partition"]
      : ["sort"]

/** The attribute (path) an `IN ()` in `expression` tests, its placeholders resolved. */
const emptyInOperand = (
  expression: string | undefined,
  names: Record<string, string> | undefined,
): string | undefined => {
  const operand = EMPTY_IN_OPERAND.exec(expression ?? "")?.[1]
  return operand === undefined
    ? undefined
    : operand.replace(/#\w+/g, (token) => names?.[token] ?? token)
}

/** A Put's item size — the 400 KB measure, which its expressions do not count toward. */
const putBytes = (item: TransactWriteItem): number | undefined =>
  item.Put === undefined ? undefined : itemBytes(item.Put.Item ?? {})

/** An entry's expression of `kind`, if it carries one. */
const expressionOf = (
  item: TransactWriteItem,
  kind: "ConditionExpression" | "UpdateExpression",
): string | undefined => {
  if (kind === "UpdateExpression") return item.Update?.UpdateExpression
  return (
    item.Put?.ConditionExpression ??
    item.Update?.ConditionExpression ??
    item.Delete?.ConditionExpression ??
    item.ConditionCheck?.ConditionExpression
  )
}

/**
 * UTF-8 byte order — the order DynamoDB sorts (and evaluates `BETWEEN` on)
 * string keys. JavaScript's `<` compares UTF-16 code units, which disagrees
 * for characters outside the BMP.
 */
const utf8 = new TextEncoder()
export const compareUtf8 = (a: string, b: string): number =>
  compareBytes(utf8.encode(a), utf8.encode(b))

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const diff = left[i]! - right[i]!
    if (diff !== 0) return diff
  }
  return left.length - right.length
}

/** `a` sorts after `b` as DynamoDB orders key values of their (shared) type. */
const sortsAfter = (a: AttributeValue, b: AttributeValue): boolean => {
  if (a.S !== undefined && b.S !== undefined) return compareUtf8(a.S, b.S) > 0
  if (a.N !== undefined && b.N !== undefined) return Number(a.N) > Number(b.N)
  if (a.B !== undefined && b.B !== undefined) return compareBytes(a.B, b.B) > 0
  return false
}

/** A key value, readable. */
const keyValueText = (value: AttributeValue): string =>
  value.S ??
  value.N ??
  (value.B !== undefined ? `<${value.B.length} bytes>` : JSON.stringify(value))

/**
 * The comparisons of a key condition — `#a = :v`, `#a BETWEEN :l AND :h`,
 * `begins_with(#a, :v)` — with their attributes resolved through `names`.
 */
const keyComparisons = (
  input: SentRead["input"],
): ReadonlyArray<{
  readonly attribute: string
  readonly operator: "between" | "other"
  readonly values: ReadonlyArray<AttributeValue>
}> => {
  const expression = input.KeyConditionExpression ?? ""
  const names = input.ExpressionAttributeNames ?? {}
  const values = input.ExpressionAttributeValues ?? {}
  const attribute = (token: string) => names[token] ?? token
  const value = (token: string) => values[token]
  const found: Array<{
    attribute: string
    operator: "between" | "other"
    values: ReadonlyArray<AttributeValue>
  }> = []
  const defined = (vs: ReadonlyArray<AttributeValue | undefined>) =>
    vs.filter((v): v is AttributeValue => v !== undefined)
  for (const m of expression.matchAll(/([#\w.]+)\s+BETWEEN\s+(:\w+)\s+AND\s+(:\w+)/gi)) {
    found.push({
      attribute: attribute(m[1]!),
      operator: "between",
      values: defined([value(m[2]!), value(m[3]!)]),
    })
  }
  for (const m of expression.matchAll(/begins_with\s*\(\s*([#\w.]+)\s*,\s*(:\w+)\s*\)/gi)) {
    found.push({ attribute: attribute(m[1]!), operator: "other", values: defined([value(m[2]!)]) })
  }
  for (const m of expression.matchAll(/([#\w.]+)\s*(?:=|<>|<=|>=|<|>)\s*(:\w+)/g)) {
    found.push({ attribute: attribute(m[1]!), operator: "other", values: defined([value(m[2]!)]) })
  }
  return found
}

// ---------------------------------------------------------------------------
// Confirm and attribute: writes
// ---------------------------------------------------------------------------

const entriesOf = (sent: SentWrite): ReadonlyArray<TransactWriteItem> =>
  sent._tag === "Item"
    ? [sent.item]
    : sent._tag === "TransactGet" || sent._tag === "BatchGet"
      ? []
      : sent.items

const targetsOf = (sent: SentWrite): ReadonlyArray<TransactItemTarget> => {
  if (sent._tag === "Item") return [sent.target()]
  if (sent._tag === "TransactGet") return sent.targets?.() ?? []
  return sent.targets()
}

const targetAt = (sent: SentWrite, index: number): TransactItemTarget | undefined => {
  if (sent._tag === "Item") return index === 0 ? sent.target() : undefined
  if (sent._tag === "TransactGet") return sent.targets?.()[index]
  return sent.targets()[index]
}

/** The first two entries of `sent` that target one item, if any do. */
const repeatedItem = (sent: SentWrite): Diagnosis | undefined => {
  if (sent._tag === "Item") return undefined
  const seen = new Map<string, TransactItemTarget>()
  for (const target of targetsOf(sent)) {
    const first = seen.get(target.identity)
    if (first !== undefined) {
      return {
        _tag: "RepeatedItem",
        first,
        second: target,
        batch: sent._tag === "Batch" || sent._tag === "BatchGet",
      }
    }
    seen.set(target.identity, target)
  }
  return undefined
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

const keyAt = (
  sent: SentWrite,
  index: number,
  keys: KeyAttributes,
  kinds: ReadonlyArray<"partition" | "sort">,
): Diagnosis | undefined => {
  const item = entriesOf(sent)[index]
  if (item === undefined) return undefined
  const over = oversizedKey(item, keys, kinds)
  if (over === undefined) return undefined
  const target = targetAt(sent, index)
  return target === undefined ? undefined : { _tag: "KeyTooLong", target, ...over }
}

const anyKey = (
  sent: SentWrite,
  keys: KeyAttributes,
  kinds: ReadonlyArray<"partition" | "sort">,
): Diagnosis | undefined => {
  const entries = entriesOf(sent)
  for (let index = 0; index < entries.length; index++) {
    const found = keyAt(sent, index, keys, kinds)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * An `IN ()` rejection, confirmed: the first entry whose condition holds an
 * `IN` with no operands.
 */
const emptyInCondition = (sent: SentWrite): Diagnosis | undefined => {
  for (const [index, item] of entriesOf(sent).entries()) {
    const entry = item.Put ?? item.Update ?? item.Delete ?? item.ConditionCheck
    const attribute = emptyInOperand(entry?.ConditionExpression, entry?.ExpressionAttributeNames)
    if (attribute === undefined) continue
    const target = targetAt(sent, index)
    return target === undefined
      ? undefined
      : { _tag: "EmptyIn", expression: "ConditionExpression", attribute, target }
  }
  return undefined
}

/**
 * An expression-limit rejection, confirmed: the first entry whose expression
 * of the kind DynamoDB named (either, if it named none) breaks that limit.
 */
const oversizedExpression = (message: string, sent: SentWrite): Diagnosis | undefined => {
  const limit = EXPRESSION_LENGTH.test(message)
    ? ("length" as const)
    : EXPRESSION_OPERATORS.test(message)
      ? ("operators" as const)
      : EXPRESSION_IN.test(message)
        ? ("inOperands" as const)
        : undefined
  if (limit === undefined) return undefined
  const named = EXPRESSION_KIND.exec(message)?.[1]?.toLowerCase()
  const kinds: ReadonlyArray<"ConditionExpression" | "UpdateExpression"> =
    named === "condition"
      ? ["ConditionExpression"]
      : named === "update"
        ? ["UpdateExpression"]
        : named === undefined
          ? ["ConditionExpression", "UpdateExpression"]
          : []
  const entries = entriesOf(sent)
  for (const kind of kinds) {
    for (const [index, item] of entries.entries()) {
      const expression = expressionOf(item, kind)
      if (expression === undefined) continue
      const counting = kind === "UpdateExpression" ? "update" : "condition"
      const measured =
        limit === "length"
          ? expression.length
          : limit === "operators"
            ? countOperators(expression, counting)
            : largestInOperands(expression)
      const max =
        limit === "length"
          ? EXPRESSION_MAX_LENGTH
          : limit === "operators"
            ? EXPRESSION_MAX_OPERATORS
            : IN_MAX_OPERANDS
      if (measured <= max) continue
      const target = targetAt(sent, index)
      if (target === undefined) return undefined
      const callerText =
        kind !== "ConditionExpression"
          ? undefined
          : sent._tag === "Item"
            ? sent.callerCondition?.()
            : sent._tag === "Transaction"
              ? sent.callerCondition?.(index)
              : undefined
      const cost = callerText === undefined ? undefined : expressionCost(callerText)
      return {
        _tag: "ExpressionTooLarge",
        target,
        expression: kind,
        limit,
        measured,
        caller:
          cost === undefined || callerText === undefined
            ? undefined
            : { ...cost, inOperands: largestInOperands(callerText) },
      }
    }
  }
  return undefined
}

/**
 * An empty-key rejection, confirmed: an entry writes an empty value to the
 * key attribute DynamoDB named.
 */
const emptyKey = (message: string, sent: SentWrite): Diagnosis | undefined => {
  const onIndex = EMPTY_KEY_INDEX.exec(message)
  const attribute = onIndex?.[2] ?? EMPTY_KEY_TABLE.exec(message)?.[1]
  if (attribute === undefined) return undefined
  const entries = entriesOf(sent)
  for (const [index, item] of entries.entries()) {
    if (!isEmptyKeyValue(writtenAttributes(item)[attribute])) continue
    const target = targetAt(sent, index)
    return target === undefined
      ? undefined
      : { _tag: "EmptyKey", target, attribute, index: onIndex?.[1] }
  }
  return undefined
}

const diagnoseRequest = (
  message: string,
  sent: SentWrite,
  keys: KeyAttributes,
): Diagnosis | undefined => {
  if (REPEATED.test(message) || REPEATED_BATCH.test(message)) return repeatedItem(sent)
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
  if (KEY_SIZE.test(message)) return anyKey(sent, keys, keySizeKinds(message))
  if (EMPTY_KEY.test(message)) return emptyKey(message, sent)
  if (EMPTY_IN.test(message)) {
    return EXPRESSION_KIND.exec(message)?.[1]?.toLowerCase() === "condition"
      ? emptyInCondition(sent)
      : undefined
  }
  if (
    EXPRESSION_LENGTH.test(message) ||
    EXPRESSION_OPERATORS.test(message) ||
    EXPRESSION_IN.test(message)
  ) {
    return oversizedExpression(message, sent)
  }
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
  keys: KeyAttributes,
): Diagnosis | undefined => {
  // A request that repeats an item can never commit, whatever DynamoDB
  // reported for it: DynamoDB Local applies the operations in order, and a
  // repeat whose condition then fails comes back as a conditional failure
  // indistinguishable from a lost race.
  const repeated = repeatedItem(sent)
  if (repeated !== undefined) return repeated
  // Any other conditional failure is the site's to explain, never this module's.
  if (reasons.some((reason) => reason?.code === "ConditionalCheckFailed")) return undefined
  const entries = entriesOf(sent)
  for (const [index, reason] of reasons.entries()) {
    if (reason?.code !== "ValidationError") continue
    const message = reason.message ?? ""
    const item = entries[index]
    if (item === undefined) continue
    if (KEY_SIZE.test(message)) {
      const found = keyAt(sent, index, keys, keySizeKinds(message))
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

// ---------------------------------------------------------------------------
// Confirm and attribute: reads
// ---------------------------------------------------------------------------

const diagnoseRead = (message: string, sent: SentRead): Diagnosis | undefined => {
  const index = sent.input.IndexName
  if (CONSISTENT_GSI.test(message)) {
    return sent.input.ConsistentRead === true && index !== undefined
      ? { _tag: "ConsistentReadOnGsi", index, scan: sent.scan }
      : undefined
  }
  if (EMPTY_IN.test(message)) {
    if (EXPRESSION_KIND.exec(message)?.[1]?.toLowerCase() !== "filter") return undefined
    const attribute = emptyInOperand(
      sent.input.FilterExpression,
      sent.input.ExpressionAttributeNames,
    )
    return attribute === undefined
      ? undefined
      : { _tag: "EmptyIn", expression: "FilterExpression", attribute, target: undefined }
  }
  if (sent.scan) return undefined
  if (BETWEEN_REVERSED.test(message)) {
    for (const comparison of keyComparisons(sent.input)) {
      const [low, high] = comparison.values
      if (comparison.operator !== "between" || low === undefined || high === undefined) continue
      if (!sortsAfter(low, high)) continue
      return {
        _tag: "BetweenReversed",
        attribute: comparison.attribute,
        index,
        low: keyValueText(low),
        high: keyValueText(high),
      }
    }
    return undefined
  }
  if (EMPTY_KEY.test(message)) {
    const attribute =
      EMPTY_KEY_INDEX.exec(message)?.[2] ?? EMPTY_KEY_TABLE.exec(message)?.[1] ?? undefined
    if (attribute === undefined) return undefined
    const empty = keyComparisons(sent.input).some(
      (comparison) =>
        comparison.attribute === attribute && comparison.values.some((v) => isEmptyKeyValue(v)),
    )
    return empty ? { _tag: "EmptyKeyBound", attribute, index } : undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Confirm and attribute: table management
// ---------------------------------------------------------------------------

const inlineFilters = (index: SentVectorIndex): ReadonlyArray<string> =>
  (index.SearchSchema ?? [])
    .filter((element) => element.SearchSchemaElementType === "INLINE_FILTER")
    .map((element) => element.AttributeName ?? "")

const outOfDimensionRange = (index: SentVectorIndex): boolean =>
  index.Dimensions !== undefined &&
  (index.Dimensions < MIN_DIMENSIONS || index.Dimensions > MAX_DIMENSIONS)

const diagnoseTable = (message: string, sent: SentTable): Diagnosis | undefined => {
  if (sent.vectorIndexes.length === 0) return undefined
  if (VECTOR_DIMENSIONS.test(message)) {
    // The index DynamoDB named, if it named one of the request's; else the
    // first outside the range.
    const over = sent.vectorIndexes.filter(outOfDimensionRange)
    const culprit =
      over.find((index) => index.IndexName !== undefined && message.includes(index.IndexName)) ??
      over[0]
    if (culprit === undefined) return undefined
    const name = culprit.IndexName ?? ""
    return {
      _tag: "VectorIndexDimensions",
      operation: sent.operation,
      index: name,
      dimensions: culprit.Dimensions!,
      sharers: sent.sharers(name),
    }
  }
  if (!VECTOR.test(message)) return undefined
  if (VECTOR_FILTERS.test(message)) {
    // The index DynamoDB named, if it named one of the request's; else the
    // first over the limit.
    const over = sent.vectorIndexes.filter(
      (index) => inlineFilters(index).length > MAX_INLINE_FILTERS,
    )
    const culprit =
      over.find((index) => index.IndexName !== undefined && message.includes(index.IndexName)) ??
      over[0]
    if (culprit === undefined) return undefined
    const name = culprit.IndexName ?? ""
    return {
      _tag: "VectorIndexFilters",
      operation: sent.operation,
      index: name,
      filters: inlineFilters(culprit),
      sharers: sent.sharers(name),
      limit: MAX_INLINE_FILTERS,
    }
  }
  if (!VECTOR_COUNT.test(message) || VECTOR_NOT_COUNT.test(message)) return undefined
  const statedText = STATED_LIMIT.exec(message)?.[1]
  const stated = statedText === undefined ? undefined : Number(statedText)
  const limit = stated ?? MAX_VECTOR_INDEXES_PER_TABLE
  const indexes = sent.vectorIndexes.map((index) => ({
    index: index.IndexName ?? "",
    sharers: sent.sharers(index.IndexName ?? ""),
  }))
  // Confirmed by counting against the limit DynamoDB stated, or its default
  // quota. `CreateTable` carries every vector index; `UpdateTable` adds to
  // the ones the table already has, read back after the rejection.
  const existing = sent.operation === "UpdateTable" ? sent.existing : 0
  if (existing === undefined || existing + indexes.length <= limit) return undefined
  return {
    _tag: "VectorIndexCount",
    operation: sent.operation,
    indexes,
    declared: sent.declared,
    existing: sent.operation === "UpdateTable" ? existing : undefined,
    stated,
  }
}

/**
 * A search rejected for its `TopK`, confirmed: the `TopK` sent is not an
 * integer in DynamoDB's range.
 */
const diagnoseSearch = (message: string, sent: SentSearch): Diagnosis | undefined =>
  TOP_K.test(message) &&
  (!Number.isInteger(sent.topK) || sent.topK < MIN_TOP_K || sent.topK > MAX_TOP_K)
    ? { _tag: "TopKOutOfRange", index: sent.index, topK: sent.topK }
    : undefined

/**
 * Read DynamoDB's rejection of `sent`. `keys` names the key attributes a write
 * writes (the table's and its indexes', by kind), for the key-size shape.
 * `undefined`: unrecognised or unconfirmed — the site fails with `error`
 * unchanged.
 */
export const diagnoseRejection = (
  error: unknown,
  sent: Sent,
  keys: KeyAttributes = NO_KEYS,
): Diagnosis | undefined => {
  const failure = readFailure(error)
  if (failure === undefined) return undefined
  switch (sent._tag) {
    case "Read":
      return failure._tag === "Request" ? diagnoseRead(failure.message, sent) : undefined
    case "Table":
      return failure._tag === "Request" ? diagnoseTable(failure.message, sent) : undefined
    case "Search":
      return failure._tag === "Request" ? diagnoseSearch(failure.message, sent) : undefined
    default:
      return failure._tag === "Request"
        ? diagnoseRequest(failure.message, sent, keys)
        : diagnoseCancellation(failure.reasons, sent, keys)
  }
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

const named = (target: TransactItemTarget): string => `${target.source}, at ${target.key}`

const list = (items: ReadonlyArray<string>): string => items.join(", ")

/** How a site describes what its operation had written before the rejected request. */
export type ExplainOptions = {
  /**
   * What earlier requests of the operation are known to have written, as a
   * clause: `"2 earlier transactions of versioned puts (200 items) were
   * already written"`. A multi-request operation always says exactly what it
   * wrote; never a vague "may have been written".
   */
  readonly committed?: string | undefined
}

/**
 * The explanation every site puts in its error, so the wording is identical
 * library-wide. See {@link ExplainOptions} for a multi-request operation.
 */
export const explainDiagnosis = (
  diagnosis: Diagnosis,
  operation: string,
  options?: ExplainOptions,
): string => {
  const outcome =
    options?.committed !== undefined
      ? `This request wrote nothing; ${options.committed}.`
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
          : `, ${diagnosis.bytes} bytes by DynamoDB's item-size rules`) +
        "." +
        (diagnosis.likely
          ? " No item measures over the limit by the library's size model (measured against " +
            "DynamoDB Local; AWS documents its sizes as approximate), so the largest is named."
          : "") +
        ` ${outcome}`
      )
    case "TooManyItems":
      return (
        `${operation}: the transaction holds ${diagnosis.count} items, over DynamoDB's limit ` +
        `of ${diagnosis.limit} items for one transaction. ${outcome}`
      )
    case "TransactionTooLarge": {
      const disagrees = diagnosis.measured <= TRANSACT_WRITE_MAX_BYTES
      return (
        `${operation}: DynamoDB rejected the transaction for exceeding its limit of ` +
        `${TRANSACT_WRITE_MAX_BYTES} bytes (4 MB) for one transaction` +
        (diagnosis.reported === undefined ? "" : ` (it reported ${diagnosis.reported} bytes)`) +
        `; the library measures the request at ${diagnosis.measured} bytes ` +
        "(its items, or an update's or delete's key, plus every expression with its names and values)." +
        (diagnosis.reported === undefined
          ? ""
          : " DynamoDB's figure is its running total in request order, up to the action that " +
            "crossed the limit.") +
        (disagrees
          ? " That is within the limit: the library's size model disagrees with DynamoDB's for " +
            "this request, so it was not split to fit."
          : "") +
        " The largest: " +
        diagnosis.largest
          .map(({ target, bytes }) => `${named(target)} (${bytes} bytes)`)
          .join("; ") +
        ". A put of a retain entity counts twice: its item and its version snapshot. " +
        `Split the operations into smaller transactions. ${outcome}`
      )
    }
    case "KeyTooLong": {
      const [kind, limit] =
        diagnosis.kind === "partition"
          ? ["partition key", PARTITION_KEY_MAX_BYTES]
          : ["sort key", SORT_KEY_MAX_BYTES]
      return (
        `${operation}: the ${kind} "${diagnosis.attribute}" of ${named(diagnosis.target)} is ` +
        `${diagnosis.bytes} bytes, longer than DynamoDB's ${limit}-byte limit for ` +
        `a ${kind}. ${outcome}`
      )
    }
    case "RepeatedItem":
      return diagnosis.batch
        ? `${operation}: the batch request touches one item more than once — ` +
            `${diagnosis.first.source} and ${diagnosis.second.source} both target the item at ` +
            `${diagnosis.second.key}. DynamoDB allows one request per item in a batch request, ` +
            `and rejected it. Write the item once. ${outcome}`
        : `${operation}: the transaction touches one item more than once — ` +
            `${diagnosis.first.source} and ${diagnosis.second.source} both target the item at ` +
            `${diagnosis.second.key}. DynamoDB allows one operation per item in a transaction, ` +
            "counting the uniqueness sentinels and version snapshots a put writes, and rejected " +
            `it. Split the operations into separate writes. ${outcome}`
    case "ExpressionTooLarge": {
      const subject = `the ${diagnosis.expression} of ${named(diagnosis.target)}`
      const over =
        diagnosis.limit === "length"
          ? `it is ${diagnosis.measured} characters, over DynamoDB's limit of ` +
            `${EXPRESSION_MAX_LENGTH} characters for one expression`
          : diagnosis.limit === "operators"
            ? `it holds ${diagnosis.measured} operators and functions, over DynamoDB's limit of ` +
              `${EXPRESSION_MAX_OPERATORS} for one expression`
            : `an IN in it holds ${diagnosis.measured} operands, over DynamoDB's limit of ` +
              `${IN_MAX_OPERANDS}`
      const caller = diagnosis.caller
      // The library added a guard beside the caller's condition: say so.
      const shared =
        caller !== undefined &&
        (diagnosis.limit === "length"
          ? caller.length
          : diagnosis.limit === "operators"
            ? caller.operators
            : caller.inOperands) < diagnosis.measured
      const advice =
        caller !== undefined && shared
          ? ` The .condition() alone is ${caller.length} characters / ${caller.operators} ` +
            "operators, and the library's own guard needs room beside it: simplify the condition."
          : diagnosis.expression === "UpdateExpression"
            ? " Split the update into smaller ones."
            : " Simplify the condition."
      return `${operation}: DynamoDB rejected ${subject}: ${over}.${advice} ${outcome}`
    }
    case "EmptyKey":
      return (
        `${operation}: DynamoDB rejected ${named(diagnosis.target)}: it writes an empty value ` +
        `to the key attribute "${diagnosis.attribute}"` +
        (diagnosis.index === undefined ? "" : ` of index "${diagnosis.index}"`) +
        `, and DynamoDB does not accept an empty string as a key value. ${outcome}`
      )
    case "EmptyIn":
      return diagnosis.target === undefined
        ? `${operation}: DynamoDB rejected the filter: isIn() on "${diagnosis.attribute}" has no ` +
            "values, and DynamoDB rejects the `IN ()` it compiles to as a syntax error. Give " +
            "isIn() at least one value, or leave the filter out."
        : `${operation}: DynamoDB rejected ${named(diagnosis.target)}: isIn() on ` +
            `"${diagnosis.attribute}" in its condition has no values, and DynamoDB rejects the ` +
            "`IN ()` it compiles to as a syntax error. Give isIn() at least one value, or " +
            `leave the condition out. ${outcome}`
    case "EmptyKeyBound":
      return (
        `${operation}: DynamoDB rejected the query: its key condition compares the key ` +
        `attribute "${diagnosis.attribute}"` +
        (diagnosis.index === undefined ? "" : ` of index "${diagnosis.index}"`) +
        " with an empty string, which DynamoDB does not accept as a key value."
      )
    case "BetweenReversed":
      return (
        `${operation}: DynamoDB rejected the query: between's lower bound ` +
        `${JSON.stringify(diagnosis.low)} sorts after its upper bound ` +
        `${JSON.stringify(diagnosis.high)} on "${diagnosis.attribute}"` +
        (diagnosis.index === undefined ? "" : ` of index "${diagnosis.index}"`) +
        " (DynamoDB orders strings by their UTF-8 bytes)."
      )
    case "ConsistentReadOnGsi":
      return (
        `consistentRead: index "${diagnosis.index}" is a global secondary index, which ` +
        "DynamoDB reads only eventually consistently, so DynamoDB rejected the consistent " +
        `${diagnosis.scan ? "scan" : "query"}.`
      )
    case "VectorIndexFilters":
      return (
        `${operation}: DynamoDB rejected vector index "${diagnosis.index}": it declares ` +
        `${diagnosis.filters.length} INLINE_FILTER attributes (${list(diagnosis.filters)}), over ` +
        `DynamoDB's limit of ${diagnosis.limit} per vector index. They are the union of the ` +
        `filters of the entities sharing it (${list(diagnosis.sharers)}). ` +
        (diagnosis.operation === "CreateTable"
          ? "The table was not created."
          : "Nothing was changed.")
      )
    case "VectorIndexDimensions":
      return (
        `${operation}: DynamoDB rejected vector index "${diagnosis.index}": its dimensions ` +
        `(${diagnosis.dimensions}) are outside the range DynamoDB accepts, ` +
        `${MIN_DIMENSIONS}..${MAX_DIMENSIONS}. The entities sharing it ` +
        `(${list(diagnosis.sharers)}) declare it. ` +
        (diagnosis.operation === "CreateTable"
          ? "The table was not created."
          : "Nothing was changed.")
      )
    case "TopKOutOfRange":
      return (
        `${operation}: DynamoDB rejected the search of vector index "${diagnosis.index}": ` +
        `topK(${diagnosis.topK}) is outside the range DynamoDB accepts, an integer in ` +
        `${MIN_TOP_K}..${MAX_TOP_K}. ` +
        `A vector search returns at most ${MAX_TOP_K} results, with no further pages.`
      )
    case "VectorIndexCount": {
      const indexes = diagnosis.indexes
        .map(({ index, sharers }) => `"${index}" (${list(sharers)})`)
        .join(", ")
      const quota = `its limit on vector indexes per table (${
        diagnosis.stated === undefined
          ? `${MAX_VECTOR_INDEXES_PER_TABLE} by default`
          : diagnosis.stated
      }; the quota is adjustable through AWS Service Quotas)`
      return diagnosis.operation === "CreateTable"
        ? `${operation}: DynamoDB rejected the table's ${diagnosis.indexes.length} vector ` +
            `indexes, ${indexes}, for exceeding ${quota}. The table was not created.`
        : `${operation}: DynamoDB rejected adding vector index ${indexes} for exceeding ` +
            `${quota}: the table already has ${diagnosis.existing ?? 0} vector ` +
            `${diagnosis.existing === 1 ? "index" : "indexes"}, and its entities declare ` +
            `${diagnosis.declared} in all. Nothing was changed.`
    }
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
export const diagnosedEntityType = (diagnosis: Diagnosis, fallback: string): string => {
  switch (diagnosis._tag) {
    case "ItemTooLarge":
    case "KeyTooLong":
    case "ExpressionTooLarge":
    case "EmptyKey":
      return diagnosis.target.entityType
    case "EmptyIn":
      return diagnosis.target?.entityType ?? fallback
    case "RepeatedItem":
      return diagnosis.first.entityType
    case "TransactionTooLarge":
      return diagnosis.largest[0]?.target.entityType ?? fallback
    default:
      return fallback
  }
}

/** The `ValidationError` a diagnosis becomes at most sites. */
export const diagnosedValidationError = (
  diagnosis: Diagnosis,
  original: unknown,
  options: ExplainOptions & {
    readonly operation: string
    readonly entityType: string
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
 * Wrap a site's request so that, on failure only, a diagnosable error is read
 * against what was sent and — when confirmed — rewritten by `rewrite`.
 * Everything else, and every success, passes through untouched.
 *
 * Placed after the site's own conditional-failure mapping, so it only ever
 * sees what that mapping could not explain — except for a repeated item: a
 * site whose mapping reads conditional failures (and may retry them) wraps its
 * request a second time, BEFORE that mapping, with `only: ["RepeatedItem"]`,
 * because DynamoDB can report a repeat as a conditional failure that reads as
 * a lost race. A diagnosis is terminal: no retry loop sees it.
 *
 * `only` limits the rewrite to those diagnoses; any other passes through.
 */
export const diagnoseFailure =
  <E2>(options: {
    readonly sent: () => Sent
    readonly keys?: (() => KeyAttributes) | undefined
    readonly only?: ReadonlyArray<Diagnosis["_tag"]> | undefined
    readonly rewrite: (diagnosis: Diagnosis, original: unknown) => E2
  }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.catch(self, (error: E): Effect.Effect<never, E | E2> => {
      if (!isDiagnosable(error)) return Effect.fail(error)
      const diagnosis = diagnoseRejection(error, options.sent(), options.keys?.() ?? NO_KEYS)
      if (diagnosis === undefined) return Effect.fail(error)
      if (options.only !== undefined && !options.only.includes(diagnosis._tag)) {
        return Effect.fail(error)
      }
      return Effect.fail(options.rewrite(diagnosis, error))
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
 * The key attributes an entity writes, by kind: its primary key's and each
 * index's partition and sort keys. `indexes` is an entity's `indexes` record.
 */
export const keyAttributesOf = (
  indexes: Readonly<
    Record<
      string,
      {
        readonly pk?: { readonly field: string } | undefined
        readonly sk?: { readonly field: string } | undefined
      }
    >
  >,
): KeyAttributes => {
  const fields = (half: "pk" | "sk") => [
    ...new Set(
      Object.values(indexes).flatMap((index) =>
        index?.[half]?.field === undefined ? [] : [index[half]!.field],
      ),
    ),
  ]
  return { partition: fields("pk"), sort: fields("sk") }
}

/** Key attributes from several sources, each attribute once per kind. */
export const mergeKeyAttributes = (...all: ReadonlyArray<KeyAttributes>): KeyAttributes => ({
  partition: [...new Set(all.flatMap((keys) => keys.partition))],
  sort: [...new Set(all.flatMap((keys) => keys.sort))],
})
