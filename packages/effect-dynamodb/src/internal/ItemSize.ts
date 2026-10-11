/**
 * @internal Exact sizes by DynamoDB's own accounting (#144), the one measure
 * the library uses: `Batch.write` chunks its versioned-put transactions by
 * it, and the failure-time diagnosis of DynamoDB's write limits
 * (`internal/WriteDiagnosis.ts`) names the item at fault by it. Nothing here
 * refuses a write: DynamoDB's own limits are never pre-checked.
 *
 * The rules were measured on DynamoDB Local from the `Payload Size` its 4 MB
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

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"

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
