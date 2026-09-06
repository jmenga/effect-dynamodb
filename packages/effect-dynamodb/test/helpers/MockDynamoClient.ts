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

import { Effect, Layer } from "effect"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"

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
