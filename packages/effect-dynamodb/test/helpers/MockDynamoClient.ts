/**
 * Shared mock `DynamoClientService` for unit tests.
 *
 * Every test that stubs the raw client only ever implements the two or three
 * operations it exercises, but `Layer.succeed(DynamoClient, ...)` demands the
 * whole interface. Hand-rolling the remaining ~25 `Effect.die("not used")`
 * stubs per call site meant every new operation added to `DynamoClientService`
 * broke (or silently rotted, while `test/` went untype-checked) every mock in
 * the suite.
 *
 * `mockDynamoClient` supplies a dying default for every operation and lets a
 * test override just the ones it needs. Adding an operation to the service now
 * only requires adding a default here.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Effect, Layer } from "effect"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"
import {
  answering,
  DDB_REPEATED_BATCH_ITEM,
  DDB_REPEATED_ITEM,
  type ExpressionInput,
  updatedItem,
  validationException,
} from "./DynamoExpressions.js"

/**
 * The default stub for an operation a test does not exercise. Dying (rather
 * than failing) means an unexpected call surfaces as a defect with the
 * operation name, not as a recoverable error the code under test might swallow.
 */
const notUsed = (operation: string) => () =>
  Effect.die(`DynamoClient.${operation} is not stubbed by this test`)

/** A complete `DynamoClientService` whose every operation dies when invoked. */
const unusedDynamoClient: DynamoClientService = {
  createTable: notUsed("createTable"),
  deleteTable: notUsed("deleteTable"),
  describeTable: notUsed("describeTable"),
  putItem: notUsed("putItem"),
  getItem: notUsed("getItem"),
  deleteItem: notUsed("deleteItem"),
  updateItem: notUsed("updateItem"),
  query: notUsed("query"),
  scan: notUsed("scan"),
  searchVectors: notUsed("searchVectors"),
  batchGetItem: notUsed("batchGetItem"),
  batchWriteItem: notUsed("batchWriteItem"),
  transactGetItems: notUsed("transactGetItems"),
  transactWriteItems: notUsed("transactWriteItems"),
  updateTable: notUsed("updateTable"),
  listTables: notUsed("listTables"),
  createBackup: notUsed("createBackup"),
  deleteBackup: notUsed("deleteBackup"),
  listBackups: notUsed("listBackups"),
  restoreTableFromBackup: notUsed("restoreTableFromBackup"),
  describeContinuousBackups: notUsed("describeContinuousBackups"),
  updateContinuousBackups: notUsed("updateContinuousBackups"),
  restoreTableToPointInTime: notUsed("restoreTableToPointInTime"),
  exportTableToPointInTime: notUsed("exportTableToPointInTime"),
  describeExport: notUsed("describeExport"),
  updateTimeToLive: notUsed("updateTimeToLive"),
  describeTimeToLive: notUsed("describeTimeToLive"),
  tagResource: notUsed("tagResource"),
  untagResource: notUsed("untagResource"),
  listTagsOfResource: notUsed("listTagsOfResource"),
}

/**
 * Build a `DynamoClientService` from a partial set of operations. Anything not
 * supplied dies when invoked.
 */
export const mockDynamoClient = (
  overrides: Partial<DynamoClientService> = {},
): DynamoClientService => ({ ...unusedDynamoClient, ...overrides })

/**
 * Build a `Layer` providing `DynamoClient` from a partial set of operations.
 * The common form — `Layer.succeed(DynamoClient, mockDynamoClient(...))`.
 */
export const mockDynamoClientLayer = (
  overrides: Partial<DynamoClientService> = {},
): Layer.Layer<DynamoClient> => Layer.succeed(DynamoClient, mockDynamoClient(overrides))

/**
 * Build a command output from just the fields a test cares about.
 *
 * Every AWS SDK command output extends `MetadataBearer`, whose `$metadata`
 * carries the HTTP response envelope. Nothing in this library reads it, so
 * requiring each mock to fabricate one buys no safety — the cast is confined
 * here instead of spreading `as never` across every stub. The returned object
 * is exactly what was passed in; no `$metadata` is invented.
 */
export const mockOutput = <T extends { readonly $metadata: unknown }>(
  fields: Omit<T, "$metadata">,
): T => fields as T

export {
  DDB_UPDATE_INVALID_PATH,
  DDB_UPDATE_MISSING_ATTRIBUTE,
  DDB_UPDATE_OPERAND_TYPE,
} from "./DynamoExpressions.js"

/**
 * Apply an UpdateItem request to an in-memory item, for mocks that keep a store: the expression
 * read and applied as DynamoDB Local reads and applies it (`DynamoExpressions.updatedItem`), on
 * document paths (`#a`, `#a.#b`, `#a[0]`) with `+` / `-`, `if_not_exists` and `list_append`
 * operands, numbers exact. `undefined` for no item.
 *
 * An update DynamoDB refuses throws DynamoDB Local's `ValidationException`, as the AWS SDK throws
 * it, and the item is left as it was: an operand naming an attribute the item doesn't hold
 * ({@link DDB_UPDATE_MISSING_ATTRIBUTE}), a path below one it doesn't hold
 * ({@link DDB_UPDATE_INVALID_PATH}), an operand of the wrong type
 * ({@link DDB_UPDATE_OPERAND_TYPE}), an expression DynamoDB refuses to read. A table answers it
 * with {@link updateOutcome}. An expression this doesn't read throws
 * `DynamoExpressions.UnreadableRequest`: a defect, never a guess.
 */
export const applyUpdate = (
  item: Record<string, AttributeValue> | undefined,
  input: ExpressionInput,
): Record<string, AttributeValue> | undefined =>
  item === undefined ? undefined : updatedItem(item, input)

/**
 * An UpdateItem as a table answers it, once its condition has passed: the
 * item to store, or the `ValidationException` DynamoDB rejects the update
 * with (see {@link applyUpdate}), which writes nothing.
 */
export const updateOutcome = (
  item: Record<string, AttributeValue>,
  input: ExpressionInput,
):
  | { readonly _tag: "Updated"; readonly item: Record<string, AttributeValue> }
  | { readonly _tag: "Refused"; readonly error: Error } =>
  answering(
    () => ({ _tag: "Updated" as const, item: updatedItem(item, input) }),
    (error) => ({ _tag: "Refused" as const, error }),
  )

/**
 * DynamoDB's request-wide `ValidationException`, as the AWS SDK throws it —
 * for mocks reproducing a rejection the library diagnoses (#144). Wordings
 * observed on DynamoDB Local:
 *
 * - `"Item size has exceeded the maximum allowed size"` (PutItem, a transaction
 *   or batch holding an oversized Put)
 * - `"Item size to update has exceeded the maximum allowed size"` (UpdateItem)
 * - `"… Member must have length less than or equal to 100"` (101+ transact items)
 * - `"Transaction payload size cannot exceed 4MB. Payload Size: N"`
 * - `"One or more parameter values were invalid: Size limit exceeded"` (sort key)
 */
export const awsValidationException = (message: string): Error => validationException(message)

/** DynamoDB's `TransactionCanceledException`, with positional reasons. */
export const awsTransactionCanceled = (
  reasons: ReadonlyArray<{ readonly Code?: string; readonly Message?: string } | undefined>,
): Error =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: reasons,
  })

/** Messages of DynamoDB's limit rejections, as DynamoDB Local words them. */
export const DDB_ITEM_SIZE = "Item size has exceeded the maximum allowed size"
export const DDB_ITEM_SIZE_UPDATE = "Item size to update has exceeded the maximum allowed size"
export const DDB_TOO_MANY_ITEMS =
  "1 validation error detected: Value '[...]' at 'transactItems' failed to satisfy constraint: " +
  "Member must have length less than or equal to 100"
export const ddbPayloadTooLarge = (bytes: number): string =>
  `Transaction payload size cannot exceed 4MB. Payload Size: ${bytes}`
export const DDB_SORT_KEY_LOCAL = "One or more parameter values were invalid: Size limit exceeded"
/** A table key over its size limit, on DynamoDB Local (single write, or a cancellation reason). */
export const DDB_TABLE_KEY_SIZE_LOCAL =
  "Hash primary key values must be under 2048 bytes, and range primary key values must be " +
  "under 1024 bytes"
/** Two operations on one item in a transaction (or `TransactGetItems`); two requests for one item in a batch. */
export { DDB_REPEATED_BATCH_ITEM, DDB_REPEATED_ITEM }
/** An expression over 4,096 characters (`kind`: Condition, Update, KeyCondition, …). */
export const ddbExpressionTooLong = (kind: string, size?: number): string =>
  `Invalid ${kind}Expression: Expression size has exceeded the maximum allowed size` +
  (size === undefined ? "" : `; expression size: ${size}`)
/** An expression over 300 operators. DynamoDB stops counting at 301. */
export const ddbTooManyOperators = (kind: string): string =>
  `Invalid ${kind}Expression: The expression contains too many operators; operator count: 301`
/** An `IN` over 100 operands. */
export const ddbTooManyInOperands = (kind: string, count: number): string =>
  `Invalid ${kind}Expression: The IN operator is provided with too many operands; number of operands: ${count}`
/** An empty key value: a table key's wording, then a secondary index key's. */
export const ddbEmptyTableKey = (key: string): string =>
  "One or more parameter values are not valid. The AttributeValue for a key attribute cannot " +
  `contain an empty string value. Key: ${key}`
export const ddbEmptyIndexKey = (index: string, key: string): string =>
  "One or more parameter values are not valid. A value specified for a secondary index key is " +
  "not supported. The AttributeValue for a key attribute cannot contain an empty string value. " +
  `IndexName: ${index}, IndexKey: ${key}`
/** A `BETWEEN` whose lower bound sorts after its upper bound. */
export const ddbBetweenReversed = (low: string, high: string): string =>
  "Invalid KeyConditionExpression: The BETWEEN operator requires upper bound to be greater than " +
  `or equal to lower bound; lower bound operand: AttributeValue: {S:${low}}, upper bound ` +
  `operand: AttributeValue: {S:${high}}`
/** A consistent read of a GSI. */
export const DDB_CONSISTENT_READ_GSI = "Consistent read cannot be true when querying a GSI"
export const DDB_CONSISTENT_SCAN_GSI = "Consistent read cannot be true when scanning a GSI"
/** The same rejection in AWS's (and later DynamoDB Local releases') wording. */
export const DDB_CONSISTENT_GSI_AWS =
  "Consistent reads are not supported on global secondary indexes"
export const DDB_SORT_KEY_AWS =
  "One or more parameter values were invalid: Aggregated size of all range keys has exceeded " +
  "the size limit of 1024 bytes"
/**
 * A partition key over 2048 bytes, as AWS reports it (unverified here:
 * DynamoDB Local words it as {@link DDB_TABLE_KEY_SIZE_LOCAL}, or
 * {@link DDB_SORT_KEY_LOCAL} for an index key).
 */
export const DDB_PARTITION_KEY_AWS =
  "One or more parameter values were invalid: Size of hashkey has exceeded the maximum size " +
  "limit of2048 bytes"
/**
 * An `IN ()` — an `isIn()` with no values (`kind`: Condition, Filter). `near`
 * runs on to the token after it, when one follows: `"())"`, `"() AND"`.
 */
export const ddbEmptyIn = (kind: string, near = "()"): string =>
  `Invalid ${kind}Expression: Syntax error; token: ")", near: "${near}"`
/**
 * AWS's standard member-constraint wording, for a member out of its range
 * (vector `dimensions`, `topK`). Unverified: DynamoDB Local has no vector
 * indexes or `SearchVectors`.
 */
export const ddbMemberOutOfRange = (value: number, member: string, bound: string): string =>
  `1 validation error detected: Value '${value}' at '${member}' failed to satisfy constraint: ` +
  `Member must have value ${bound}`
