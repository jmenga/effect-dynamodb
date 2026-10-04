/**
 * @internal Item sizes by DynamoDB's item-size rules, shared by `Batch.write`'s
 * versioned transactions (chunked by size) and the client-side size check of
 * `Transaction.transactWrite` and `EventStore.append` (#133).
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"

/**
 * DynamoDB's limit on the aggregate size of the items in one
 * `TransactWriteItems` request: 4 MB, in the binary megabytes DynamoDB uses
 * for every size limit (an item's 400 KB is 409,600 bytes).
 */
export const TRANSACT_WRITE_MAX_BYTES = 4 * 1024 * 1024

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/**
 * Which way a size errs. DynamoDB documents its sizes as approximate, so:
 *
 * - `"lower"` never counts more than DynamoDB does — a refusal on it never
 *   refuses what DynamoDB would accept (the transaction check). Numbers count
 *   as DynamoDB stores them: a byte per two significant digits (leading and
 *   trailing zeros trimmed), plus one; list and map overheads aren't counted.
 * - `"upper"` never counts less — a budget on it never overfills (`Batch.write`
 *   chunking). Numbers count by their characters plus one, and lists and maps
 *   carry three bytes plus one per element.
 */
export type SizeBound = "lower" | "upper"

/** A number's significant digits: sign, point and exponent dropped, zeros trimmed. */
const significantDigits = (n: string): number => {
  const mantissa = n.split(/[eE]/)[0] ?? ""
  const digits = mantissa.replace(/[-+.]/g, "").replace(/^0+/, "").replace(/0+$/, "")
  return digits.length
}

const numberBytes = (n: string, bound: SizeBound): number => {
  if (bound === "upper") return n.length + 1
  // Zero has no significant digits, and is stored in one byte.
  const digits = significantDigits(n)
  return digits === 0 ? 1 : Math.ceil(digits / 2) + 1
}

/** An attribute value's size toward its item's, erring the way `bound` says. */
export const attributeBytes = (value: AttributeValue, bound: SizeBound = "lower"): number => {
  if (value.S !== undefined) return utf8Bytes(value.S)
  if (value.N !== undefined) return numberBytes(value.N, bound)
  if (value.B !== undefined) return value.B.byteLength
  if (value.SS !== undefined) return value.SS.reduce((sum, v) => sum + utf8Bytes(v), 0)
  if (value.NS !== undefined) return value.NS.reduce((sum, v) => sum + numberBytes(v, bound), 0)
  if (value.BS !== undefined) return value.BS.reduce((sum, v) => sum + v.byteLength, 0)
  const overhead = bound === "upper"
  if (value.L !== undefined) {
    return value.L.reduce(
      (sum, v) => sum + attributeBytes(v, bound) + (overhead ? 1 : 0),
      overhead ? 3 : 0,
    )
  }
  if (value.M !== undefined) return itemBytes(value.M, bound) + (overhead ? 3 : 0)
  return 1
}

/** An item's size: its attribute names plus their values. */
export const itemBytes = (
  item: Record<string, AttributeValue>,
  bound: SizeBound = "lower",
): number =>
  Object.entries(item).reduce(
    (sum, [name, value]) => sum + utf8Bytes(name) + attributeBytes(value, bound),
    0,
  )

/**
 * A lower bound on what one transact entry contributes to its transaction's
 * size, as far as the request shows it: a Put's whole item; a Delete's,
 * ConditionCheck's or Update's key. (An Update's values aren't counted: some
 * may be its condition's, and the item it writes is the stored one updated,
 * which the request does not carry.)
 */
export const transactItemBytes = (item: TransactWriteItem): number => {
  if (item.Put !== undefined) return itemBytes(item.Put.Item ?? {})
  return itemBytes(item.Delete?.Key ?? item.Update?.Key ?? item.ConditionCheck?.Key ?? {})
}
