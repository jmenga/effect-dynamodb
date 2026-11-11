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

/**
 * `obj[key]` when `obj` holds `key` itself: never a name `Object.prototype`
 * supplies (`constructor`, `toString`, `__proto__`, …).
 */
const own = <V>(obj: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(obj, key) ? obj[key] : undefined

/** Set `obj[key]` as an own property, `__proto__` included. */
const setOwn = <V>(obj: Record<string, V>, key: string, value: V): void => {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true })
}

// DynamoDB's rejections of an update expression the item can't take, as
// DynamoDB Local words them. Each is a request-wide `ValidationException`, in a
// transaction too, checked once the update's condition has passed, and the
// update writes nothing.

/** An operand naming an attribute, map key or list element the item doesn't hold. */
export const DDB_UPDATE_MISSING_ATTRIBUTE =
  "The provided expression refers to an attribute that does not exist in the item"
/** A path below an attribute or map key the item doesn't hold, or below one that isn't a map or list. */
export const DDB_UPDATE_INVALID_PATH =
  "The document path provided in the update expression is invalid for update"
/** `+` / `-` on an operand that isn't a number, `list_append` on one that isn't a list, … */
export const DDB_UPDATE_OPERAND_TYPE =
  "An operand in the update expression has an incorrect data type"

/**
 * Apply an UpdateItem request to an in-memory item, for mocks that keep a
 * store. Understands `SET`, `REMOVE`, `ADD` and `DELETE` clauses on document
 * paths (`#a`, `#a.#b`, `#a[0]`), with `+` / `-`, `if_not_exists` and
 * `list_append` operands. An expression it can't read only bumps the `version`
 * attribute, so a retain update can still recognise its own write by version.
 *
 * An update DynamoDB rejects throws DynamoDB's `ValidationException`, as the
 * AWS SDK throws it, and the item is left as it was: an operand naming an
 * attribute the item doesn't hold ({@link DDB_UPDATE_MISSING_ATTRIBUTE}), a
 * path below one it doesn't hold ({@link DDB_UPDATE_INVALID_PATH}), an operand
 * of the wrong type ({@link DDB_UPDATE_OPERAND_TYPE}). A table answers it with
 * {@link updateOutcome}. Names are looked up as the item's own attributes only.
 */
export const applyUpdate = (
  item: Record<string, AttributeValue> | undefined,
  input: {
    readonly UpdateExpression?: string | undefined
    readonly ExpressionAttributeNames?: Record<string, string> | undefined
    readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
  },
): Record<string, AttributeValue> | undefined => {
  if (item === undefined) return undefined
  const names = input.ExpressionAttributeNames ?? {}
  const values = input.ExpressionAttributeValues ?? {}
  const clauses = updateClauses(input.UpdateExpression ?? "")
  const next = structuredClone(item) as Record<string, AttributeValue>
  const applied = clauses !== undefined && applyClauses(next, clauses, names, values)
  if (applied) return next
  // An expression this doesn't read: the write landed, and its fields are unknown.
  const fallback: Record<string, AttributeValue> = { ...item }
  const version = own(fallback, "version")?.N
  if (version !== undefined) setOwn(fallback, "version", { N: String(Number(version) + 1) })
  return fallback
}

/**
 * An UpdateItem as a table answers it, once its condition has passed: the
 * item to store, or the `ValidationException` DynamoDB rejects the update
 * with (see {@link applyUpdate}), which writes nothing.
 */
export const updateOutcome = (
  item: Record<string, AttributeValue>,
  input: Parameters<typeof applyUpdate>[1],
):
  | { readonly _tag: "Updated"; readonly item: Record<string, AttributeValue> }
  | { readonly _tag: "Refused"; readonly error: Error } => {
  try {
    return { _tag: "Updated", item: applyUpdate(item, input)! }
  } catch (error) {
    if (error instanceof Error && error.name === "ValidationException") {
      return { _tag: "Refused", error }
    }
    throw error
  }
}

const refuse = (message: string): never => {
  throw awsValidationException(message)
}

type UpdateClause = { readonly action: "SET" | "REMOVE" | "ADD" | "DELETE"; readonly text: string }

/** An update expression's clauses, or `undefined` if it has none. */
const updateClauses = (expression: string): ReadonlyArray<UpdateClause> | undefined => {
  const sections = expression.split(/(?:^|\s)(?=(?:SET|REMOVE|ADD|DELETE)\s)/).filter(Boolean)
  if (sections.length === 0) return undefined
  return sections.flatMap((section) => {
    const space = section.indexOf(" ")
    const action = section.slice(0, space) as UpdateClause["action"]
    return splitTopLevel(section.slice(space + 1)).map((text) => ({ action, text }))
  })
}

/** Split on the commas outside any parentheses. */
const splitTopLevel = (text: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let depth = 0
  let current = ""
  for (const char of text) {
    if (char === "(") depth++
    if (char === ")") depth--
    if (char === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
    } else {
      current += char
    }
  }
  parts.push(current.trim())
  return parts
}

/** A document path's segments, or `undefined` if the text isn't one. */
const pathSegments = (
  text: string,
  names: Record<string, string>,
): ReadonlyArray<string | number> | undefined => {
  const segments: Array<string | number> = []
  for (const part of text.split(".")) {
    const parsed = /^(#\w+)((?:\[\d+\])*)$/.exec(part)
    const name = parsed === null ? undefined : own(names, parsed[1]!)
    if (parsed === null || name === undefined) return undefined
    segments.push(name)
    for (const index of parsed[2]!.matchAll(/\[(\d+)\]/g)) segments.push(Number(index[1]))
  }
  return segments
}

type Container = { [key: string]: AttributeValue } | Array<AttributeValue>

/** The value a map holds under a name, or a list at an index: the container's own entries only. */
const childOf = (container: Container, segment: string | number): AttributeValue | undefined =>
  Array.isArray(container)
    ? typeof segment === "number"
      ? container[segment]
      : undefined
    : typeof segment === "string"
      ? own(container, segment)
      : undefined

/**
 * The map or list holding a path's last segment: `undefined` when a segment
 * above it is missing, or isn't a map (for a name) or a list (for an index).
 */
const parentOf = (
  root: Record<string, AttributeValue>,
  segments: ReadonlyArray<string | number>,
): Container | undefined => {
  let container: Container = root
  for (let at = 0; at < segments.length - 1; at++) {
    const value = childOf(container, segments[at]!)
    const inner: Container | undefined = typeof segments[at + 1] === "number" ? value?.L : value?.M
    if (inner === undefined) return undefined
    container = inner
  }
  return container
}

/** The container a path writes into: DynamoDB rejects a path below one the item doesn't hold. */
const parentToWrite = (
  root: Record<string, AttributeValue>,
  segments: ReadonlyArray<string | number>,
): Container => parentOf(root, segments) ?? refuse(DDB_UPDATE_INVALID_PATH)

const readPath = (
  root: Record<string, AttributeValue>,
  segments: ReadonlyArray<string | number>,
): AttributeValue | undefined => {
  const parent = parentOf(root, segments)
  return parent === undefined ? undefined : childOf(parent, segments[segments.length - 1]!)
}

const writePath = (
  root: Record<string, AttributeValue>,
  segments: ReadonlyArray<string | number>,
  value: AttributeValue,
): void => {
  const parent = parentToWrite(root, segments)
  const last = segments[segments.length - 1]!
  if (Array.isArray(parent)) parent[last as number] = value
  else setOwn(parent, last as string, value)
}

const removePath = (
  root: Record<string, AttributeValue>,
  segments: ReadonlyArray<string | number>,
): void => {
  const parent = parentToWrite(root, segments)
  const last = segments[segments.length - 1]!
  if (Array.isArray(parent)) parent.splice(last as number, 1)
  else if (Object.hasOwn(parent, last)) delete parent[last]
}

/**
 * A SET clause's right-hand side, or `undefined` if this doesn't read it. Its
 * `value` is `undefined` for a path the item doesn't hold, which only
 * `if_not_exists` takes.
 */
const operand = (
  text: string,
  root: Record<string, AttributeValue>,
  names: Record<string, string>,
  values: Record<string, AttributeValue>,
): { readonly value: AttributeValue | undefined } | undefined => {
  const trimmed = text.trim()
  const sum = splitOutside(trimmed, /\s([+-])\s/)
  if (sum !== undefined) {
    const left = operand(sum.left, root, names, values)
    const right = operand(sum.right, root, names, values)
    if (left === undefined || right === undefined) return undefined
    const [a, b] = [held(left.value).N, held(right.value).N]
    if (a === undefined || b === undefined) return refuse(DDB_UPDATE_OPERAND_TYPE)
    return {
      value: { N: String(sum.operator === "+" ? Number(a) + Number(b) : Number(a) - Number(b)) },
    }
  }
  if (trimmed.startsWith(":")) {
    const value = own(values, trimmed)
    return value === undefined ? undefined : { value }
  }
  const call = /^(if_not_exists|list_append)\((.*)\)$/.exec(trimmed)
  if (call !== null) {
    const [first, second] = splitTopLevel(call[2]!)
    const a = operand(first!, root, names, values)
    if (a === undefined) return undefined
    if (call[1] === "if_not_exists" && a.value !== undefined) return a
    const b = operand(second!, root, names, values)
    if (b === undefined) return undefined
    if (call[1] === "if_not_exists") return { value: held(b.value) }
    const [x, y] = [held(a.value).L, held(b.value).L]
    if (x === undefined || y === undefined) return refuse(DDB_UPDATE_OPERAND_TYPE)
    return { value: { L: [...x, ...y] } }
  }
  const path = pathSegments(trimmed, names)
  return path === undefined ? undefined : { value: readPath(root, path) }
}

/** An operand's value: DynamoDB rejects one naming something the item doesn't hold. */
const held = (value: AttributeValue | undefined): AttributeValue =>
  value ?? refuse(DDB_UPDATE_MISSING_ATTRIBUTE)

/** `text` split on its last top-level match of `separator`. */
const splitOutside = (text: string, separator: RegExp) => {
  let depth = 0
  for (let at = text.length - 1; at >= 0; at--) {
    if (text[at] === ")") depth++
    if (text[at] === "(") depth--
    if (depth !== 0) continue
    const match = separator.exec(text.slice(at, at + 3))
    if (match?.index === 0) {
      return { left: text.slice(0, at), operator: match[1]!, right: text.slice(at + 3) }
    }
  }
  return undefined
}

/** Apply every clause to `root`; `false` if one of them can't be read. */
const applyClauses = (
  root: Record<string, AttributeValue>,
  clauses: ReadonlyArray<UpdateClause>,
  names: Record<string, string>,
  values: Record<string, AttributeValue>,
): boolean => {
  // DynamoDB evaluates every right-hand side against the item as it was.
  const before = structuredClone(root)
  for (const { action, text } of clauses) {
    if (action === "REMOVE") {
      const path = pathSegments(text, names)
      if (path === undefined) return false
      removePath(root, path)
    } else if (action === "SET") {
      const at = text.indexOf(" = ")
      const path = at < 0 ? undefined : pathSegments(text.slice(0, at), names)
      const value = at < 0 ? undefined : operand(text.slice(at + 3), before, names, values)
      if (path === undefined || value === undefined) return false
      writePath(root, path, held(value.value))
    } else {
      const [target, source] = text.split(/\s+/)
      const path = target === undefined ? undefined : pathSegments(target, names)
      const value = source === undefined ? undefined : own(values, source)
      if (path === undefined || value === undefined) return false
      const current = readPath(root, path)
      if (value.N !== undefined && action === "ADD") {
        if (current !== undefined && current.N === undefined) refuse(DDB_UPDATE_OPERAND_TYPE)
        writePath(root, path, { N: String(Number(current?.N ?? 0) + Number(value.N)) })
      } else {
        const kind = value.SS !== undefined ? "SS" : value.NS !== undefined ? "NS" : undefined
        if (kind === undefined) return false
        if (current !== undefined && current[kind] === undefined) refuse(DDB_UPDATE_OPERAND_TYPE)
        const stored: ReadonlyArray<string> = current?.[kind] ?? []
        const given: ReadonlyArray<string> = value[kind]!
        const merged =
          action === "ADD"
            ? [...new Set([...stored, ...given])]
            : stored.filter((entry) => !given.includes(entry))
        if (merged.length === 0) removePath(root, path)
        else writePath(root, path, { [kind]: merged } as unknown as AttributeValue)
      }
    }
  }
  return true
}

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
export const awsValidationException = (message: string): Error =>
  Object.assign(new Error(message), { name: "ValidationException" })

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
/** Two operations on one item in a transaction (or `TransactGetItems`). */
export const DDB_REPEATED_ITEM =
  "Transaction request cannot include multiple operations on one item"
/** Two requests for one item in a `BatchWriteItem` / `BatchGetItem`. */
export const DDB_REPEATED_BATCH_ITEM = "Provided list of item keys contains duplicates"
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
