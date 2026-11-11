/**
 * @internal Exact sizes by DynamoDB's own accounting (#144), the one measure
 * the library uses: `Batch.write` splits its requests by it and an
 * aggregate's `rekey` its transactions ({@link packRequests}), and the
 * failure-time diagnosis of DynamoDB's write limits
 * (`internal/WriteDiagnosis.ts`) names the item at fault by it. Nothing here
 * refuses a write: DynamoDB's own limits are never pre-checked.
 *
 * Two measures, for two kinds of limit:
 *
 * - **Item size** ({@link itemBytes}, {@link transactItemBytes}): what the
 *   400 KB item and 4 MB transaction limits count. Rules below.
 * - **Request body** ({@link jsonBytes}): what the 16 MB limit on one
 *   request counts — the JSON text the AWS SDK sends, where a control
 *   character in a string is 6 bytes (`\u0000`), a quote or backslash 2, and
 *   binary is base64. Item size counts 1 byte for each, so 25 items within
 *   400 KB can still be over 16 MB on the wire. See {@link REQUEST_MAX_BYTES}.
 *
 * The item-size rules were measured on DynamoDB Local from the `Payload Size` its 4 MB
 * rejection reports, and confirmed at the exact boundaries: an item of
 * 409,600 bytes is accepted and 409,601 rejected; a transaction of 4,194,304
 * bytes is accepted and 4,194,305 rejected.
 *
 * - An item is the sum over its attributes of `utf8(name) + size(value)`, with
 *   no per-item or per-attribute overhead.
 * - `S`: UTF-8 bytes. `B`: byte length. `BOOL`, `NULL`: 1.
 * - `N`: see {@link numberBytes} (at most 21 bytes, a negative one included).
 * - `SS` / `NS` / `BS`: the sum of the elements' sizes, no overhead.
 * - `L`: `3 + Σ (size(element) + 1)`. `M`: `3 + Σ (utf8(name) + size(value) + 1)`.
 * - A transaction action: its item (a Put) or its key (any other action), plus
 *   each of its expressions — see {@link transactItemBytes}.
 */

import type { AttributeValue, TransactWriteItem, WriteRequest } from "@aws-sdk/client-dynamodb"
import { TRANSACT_WRITE_ITEMS_LIMIT } from "@effect-dynamodb/schema/Errors.js"

/**
 * DynamoDB's limit on the size of one `TransactWriteItems` request: 4 MB, in
 * the binary megabytes DynamoDB uses for every size limit — 4,194,304 bytes,
 * measured by {@link transactItemBytes}.
 */
export const TRANSACT_WRITE_MAX_BYTES = 4 * 1024 * 1024

/** DynamoDB's limit on the size of one item: 400 KB, which is 409,600 bytes. */
export const ITEM_MAX_BYTES = 400 * 1024

const encoder = new TextEncoder()

export const utf8Bytes = (text: string): number => encoder.encode(text).length

/**
 * A number's size as DynamoDB stores it. Zero is 1 byte. Otherwise: 1, plus
 * one byte per base-100 digit pair of the magnitude — pairs aligned to the
 * decimal point, all-zero pairs trimmed at both ends — plus 1 if negative,
 * except when the magnitude takes the maximum 20 pairs: a number is never
 * more than 21 bytes.
 *
 * Measured: `1`, `10`, `99`, `100`, `1200`, `1e10`, `0.5`, `0.05`, `0.0012`,
 * `9.9E+125` → 2; `101`, `120`, `1234`, `1.5`, `12.34`, `10.01` → 3;
 * `12345`, `1.234`, `-123` → 4; `-1` → 3; a 38-digit integer → 20;
 * `-123456789012345678901234567890123456.78` (19 pairs) → 21;
 * `-9.9999999999999999999999999999999999999` and
 * `-1.2345678901234567890123456789012345678` (20 pairs) → 21.
 */
export const numberBytes = (n: string): number => {
  let text = n.trim()
  const negative = text.startsWith("-")
  if (negative || text.startsWith("+")) text = text.slice(1)
  const [mantissa = "", exponent] = text.split(/[eE]/)
  const [whole = "", fraction = ""] = mantissa.split(".")
  const all = whole + fraction
  const leading = /^0*/.exec(all)![0].length
  const digits = all.slice(leading).replace(/0+$/, "")
  if (digits.length === 0) return 1
  // How many significant digits sit before the decimal point (negative: the
  // first one sits that many places after it). Pairs are aligned to the point,
  // so an odd count leaves the first digit alone in its pair.
  const beforePoint = whole.length + Number(exponent ?? 0) - leading
  const aligned = (Math.abs(beforePoint) % 2 === 1 ? 1 : 0) + digits.length
  const pairs = Math.ceil(aligned / 2)
  // The sign byte is left off at the maximum 20 pairs (measured).
  return 1 + pairs + (negative && pairs < 20 ? 1 : 0)
}

/** An attribute value's size, by the rules in this module's header. */
export const attributeBytes = (value: AttributeValue): number => {
  if (value.S !== undefined) return utf8Bytes(value.S)
  if (value.N !== undefined) return numberBytes(value.N)
  if (value.B !== undefined) return value.B.byteLength
  if (value.BOOL !== undefined || value.NULL !== undefined) return 1
  if (value.SS !== undefined) return value.SS.reduce((sum, v) => sum + utf8Bytes(v), 0)
  if (value.NS !== undefined) return value.NS.reduce((sum, v) => sum + numberBytes(v), 0)
  if (value.BS !== undefined) return value.BS.reduce((sum, v) => sum + v.byteLength, 0)
  if (value.L !== undefined) return value.L.reduce((sum, v) => sum + attributeBytes(v) + 1, 3)
  if (value.M !== undefined) {
    return Object.entries(value.M).reduce(
      (sum, [name, v]) => sum + utf8Bytes(name) + attributeBytes(v) + 1,
      3,
    )
  }
  return 0
}

/** An item's size: its attribute names plus their values. What the 400 KB limit measures. */
export const itemBytes = (item: Record<string, AttributeValue>): number =>
  Object.entries(item).reduce(
    (sum, [name, value]) => sum + utf8Bytes(name) + attributeBytes(value),
    0,
  )

const PLACEHOLDER = /[#:][A-Za-z0-9_]+/g

/**
 * An expression's contribution to a transaction's size: its UTF-8 length as
 * written, plus, for every placeholder **occurrence**, the substituted name's
 * UTF-8 bytes (`#name`) or value's size (`:value`). A placeholder the maps do
 * not define adds nothing (DynamoDB rejects such a request anyway).
 *
 * Expressions count toward the 4 MB transaction limit, never toward an item's
 * 400 KB.
 */
export const expressionBytes = (
  expression: string | undefined,
  names: Record<string, string> | undefined,
  values: Record<string, AttributeValue> | undefined,
): number => {
  if (expression === undefined) return 0
  let bytes = utf8Bytes(expression)
  for (const [placeholder] of expression.matchAll(PLACEHOLDER)) {
    if (placeholder.startsWith("#")) {
      const name = names?.[placeholder]
      if (name !== undefined) bytes += utf8Bytes(name)
    } else {
      const value = values?.[placeholder]
      if (value !== undefined) bytes += attributeBytes(value)
    }
  }
  return bytes
}

/**
 * One action's contribution to its `TransactWriteItems` request's size:
 *
 * - a Put's item, or an Update's, Delete's or ConditionCheck's key — never the
 *   stored item, nor the item an Update produces;
 * - plus each of its expressions (`ConditionExpression`, an Update's
 *   `UpdateExpression`) by {@link expressionBytes}.
 *
 * `TableName` and `ReturnValuesOnConditionCheckFailure` add nothing.
 */
export const transactItemBytes = (item: TransactWriteItem): number => {
  const action = item.Put ?? item.Update ?? item.Delete ?? item.ConditionCheck
  if (action === undefined) return 0
  const names = action.ExpressionAttributeNames
  const values = action.ExpressionAttributeValues
  const base =
    item.Put !== undefined
      ? itemBytes(item.Put.Item ?? {})
      : itemBytes((item.Update ?? item.Delete ?? item.ConditionCheck)?.Key ?? {})
  return (
    base +
    expressionBytes(action.ConditionExpression, names, values) +
    expressionBytes(item.Update?.UpdateExpression, names, values)
  )
}

/** A `TransactWriteItems` request's size: the sum of its actions' contributions. */
export const transactionBytes = (items: ReadonlyArray<TransactWriteItem>): number =>
  items.reduce((sum, item) => sum + transactItemBytes(item), 0)

// ---------------------------------------------------------------------------
// Request body: the 16 MB limit
// ---------------------------------------------------------------------------

/**
 * The 16 MB limit on one request's body: 16,777,216 bytes of the JSON the AWS
 * SDK sends, measured by {@link jsonBytes}.
 *
 * AWS documents 16 MB for `BatchWriteItem` ("up to 16 MB of data over the
 * network"). DynamoDB Local rejects any request whose body is over 16 MiB:
 * measured, 16,777,216 bytes accepted and 16,777,217 rejected, by every
 * operation (`BatchWriteItem`, `TransactWriteItems`, `PutItem`, reads alike),
 * with HTTP 413, before the request is read. The bytes are the raw body's —
 * UTF-8 bytes, not characters. How AWS measures it, and whether it applies the
 * limit to other operations, is unverified.
 */
export const REQUEST_MAX_BYTES = 16 * 1024 * 1024

/** DynamoDB's limit on the write requests of one `BatchWriteItem` request. */
export const BATCH_WRITE_REQUESTS_LIMIT = 25

/**
 * The UTF-8 bytes of `JSON.stringify(text)`, quotes included, without building
 * either: `"` and `\` escape to 2 bytes; a control character to 2 (`\b`, `\t`,
 * `\n`, `\f`, `\r`) or 6 (`\u0000`); a lone surrogate to 6 (`\ud800`); any
 * other character is its UTF-8 bytes (U+2028 and U+2029 are not escaped).
 */
export const jsonStringBytes = (text: string): number => {
  let bytes = 2
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20) {
      bytes += c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6
    } else if (c === 0x22 || c === 0x5c) {
      bytes += 2
    } else if (c < 0x80) {
      bytes += 1
    } else if (c < 0x800) {
      bytes += 2
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 6
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
  }
  return bytes
}

/**
 * The UTF-8 bytes of the JSON the AWS SDK sends for `value`: `JSON.stringify`'s
 * output — a property whose value is `undefined` left out — with binary
 * (`Uint8Array`) as a base64 string. A request's body is `jsonBytes` of its
 * input, plus, for `TransactWriteItems`, the `ClientRequestToken` the SDK fills
 * in ({@link transactWriteBodyBytes}). Checked against the body the SDK builds
 * (`test/RequestSize.test.ts`).
 */
export const jsonBytes = (value: unknown): number => {
  if (typeof value === "string") return jsonStringBytes(value)
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4
  if (typeof value === "boolean") return value ? 4 : 5
  if (value === null || typeof value !== "object") return 4
  if (value instanceof Uint8Array) return 2 + 4 * Math.ceil(value.byteLength / 3)
  if (Array.isArray(value)) {
    let bytes = value.length === 0 ? 2 : 1 + value.length
    for (const element of value) bytes += jsonBytes(element)
    return bytes
  }
  let bytes = 1
  let entries = 0
  for (const key of Object.keys(value)) {
    const element = (value as Record<string, unknown>)[key]
    if (element === undefined || typeof element === "function" || typeof element === "symbol") {
      continue
    }
    bytes += jsonStringBytes(key) + 1 + jsonBytes(element)
    entries++
  }
  return bytes + Math.max(entries, 1)
}

/**
 * Stands in for the `ClientRequestToken` the AWS SDK fills on a
 * `TransactWriteItems` whose input has none: a UUID, 36 characters.
 */
const SDK_TRANSACTION_TOKEN = "00000000-0000-0000-0000-000000000000"

/** Request-level fields sent beside a request's items: `ReturnConsumedCapacity`. */
export type RequestFields = { readonly ReturnConsumedCapacity?: "TOTAL" | "INDEXES" | undefined }

/** A `BatchWriteItem` request's body as sent: its input, measured by {@link jsonBytes}. */
export const batchWriteBodyBytes = (input: {
  readonly RequestItems?: Record<string, ReadonlyArray<WriteRequest>> | undefined
}): number => jsonBytes(input)

/**
 * A `TransactWriteItems` request's body as sent: its input, and the
 * `ClientRequestToken` the AWS SDK fills when the input has none (60 bytes).
 */
export const transactWriteBodyBytes = (input: {
  readonly TransactItems?: ReadonlyArray<TransactWriteItem> | undefined
  readonly ClientRequestToken?: string | undefined
}): number =>
  jsonBytes(
    input.ClientRequestToken === undefined
      ? { ...input, ClientRequestToken: SDK_TRANSACTION_TOKEN }
      : input,
  )

// ---------------------------------------------------------------------------
// Splitting the library's own requests
// ---------------------------------------------------------------------------

/**
 * What one unit adds to a request: a `BatchWriteItem` write request, or the
 * actions that must share one transaction (a `rekey` move's Put and Delete).
 */
export type RequestUnit = {
  /** Its write requests or actions, against the request's count limit. */
  readonly count: number
  /** Its item size ({@link transactionBytes}), against a transaction's 4 MB; 0 for a batch. */
  readonly bytes: number
  /** Its body bytes ({@link jsonBytes}), each entry's separating comma included. */
  readonly wire: number
  /**
   * Body shared by every unit with the same `key`, sent once per request: a
   * `BatchWriteItem` table's `"<name>":[]` and its comma.
   */
  readonly shared?: { readonly key: string; readonly wire: number } | undefined
}

/** One kind of request: its limits, and its body before any unit. */
export type RequestShape = {
  readonly count: number
  /** A transaction's 4 MB of item size; none for a batch. */
  readonly bytes?: number | undefined
  /** The body with no unit in it, less one comma (the first entry has none). */
  readonly envelope: number
}

/** A `BatchWriteItem` request, sent with `fields` beside its items. */
export const batchWriteShape = (fields: RequestFields): RequestShape => ({
  count: BATCH_WRITE_REQUESTS_LIMIT,
  envelope: batchWriteBodyBytes({ RequestItems: {}, ...fields }) - 1,
})

/** A `TransactWriteItems` request, sent with `fields` beside its items. */
export const transactWriteShape = (fields: RequestFields): RequestShape => ({
  count: TRANSACT_WRITE_ITEMS_LIMIT,
  bytes: TRANSACT_WRITE_MAX_BYTES,
  envelope: transactWriteBodyBytes({ TransactItems: [], ...fields }) - 1,
})

/** A write request to `tableName`, as a unit of a `BatchWriteItem` request. */
export const batchWriteUnit = (tableName: string, request: WriteRequest): RequestUnit => ({
  count: 1,
  bytes: 0,
  wire: jsonBytes(request) + 1,
  shared: { key: tableName, wire: jsonStringBytes(tableName) + 3 },
})

/** Actions that must share one transaction, as a unit of a `TransactWriteItems` request. */
export const transactWriteUnit = (items: ReadonlyArray<TransactWriteItem>): RequestUnit => ({
  count: items.length,
  bytes: transactionBytes(items),
  wire: items.reduce((sum, item) => sum + jsonBytes(item) + 1, 0),
})

/**
 * Split `units`, in order, into requests within every limit DynamoDB applies to
 * one: `shape.count` entries, `shape.bytes` of item size, and
 * {@link REQUEST_MAX_BYTES} of body. Greedy: a request takes the next unit
 * while it fits, and always at least one — a unit over a limit on its own goes
 * alone, for DynamoDB to reject and the diagnosis to name. It picks request
 * boundaries and refuses nothing. Units within every limit are split exactly
 * as by their count alone.
 */
export const packRequests = <U>(
  units: ReadonlyArray<U>,
  unitOf: (unit: U) => RequestUnit,
  shape: RequestShape,
): Array<Array<U>> => {
  const requests: Array<Array<U>> = []
  let request: Array<U> = []
  let count = 0
  let bytes = 0
  let wire = shape.envelope
  let shared = new Set<string>()
  for (const unit of units) {
    const sized = unitOf(unit)
    const sharedWire = (open: ReadonlySet<string>) =>
      sized.shared === undefined || open.has(sized.shared.key) ? 0 : sized.shared.wire
    const fits =
      count + sized.count <= shape.count &&
      (shape.bytes === undefined || bytes + sized.bytes <= shape.bytes) &&
      wire + sharedWire(shared) + sized.wire <= REQUEST_MAX_BYTES
    if (request.length > 0 && !fits) {
      requests.push(request)
      request = []
      count = 0
      bytes = 0
      wire = shape.envelope
      shared = new Set()
    }
    wire += sharedWire(shared) + sized.wire
    if (sized.shared !== undefined) shared.add(sized.shared.key)
    count += sized.count
    bytes += sized.bytes
    request.push(unit)
  }
  if (request.length > 0) requests.push(request)
  return requests
}
