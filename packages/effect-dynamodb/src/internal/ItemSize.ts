/**
 * @internal Item sizes as DynamoDB counts them, shared by `Batch.write`'s
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
 * An attribute value's size as DynamoDB counts it toward an item's size:
 * strings as UTF-8, binary as raw bytes. Numbers are counted by their digits
 * and list / map entries carry a few bytes of overhead, so this errs high.
 */
export const attributeBytes = (value: AttributeValue): number => {
  if (value.S !== undefined) return utf8Bytes(value.S)
  if (value.N !== undefined) return value.N.length + 1
  if (value.B !== undefined) return value.B.byteLength
  if (value.SS !== undefined) return value.SS.reduce((sum, v) => sum + utf8Bytes(v), 0)
  if (value.NS !== undefined) return value.NS.reduce((sum, v) => sum + v.length + 1, 0)
  if (value.BS !== undefined) return value.BS.reduce((sum, v) => sum + v.byteLength, 0)
  if (value.L !== undefined) return value.L.reduce((sum, v) => sum + attributeBytes(v) + 1, 3)
  if (value.M !== undefined) return itemBytes(value.M) + 3
  return 1
}

/** An item's size: its attribute names plus their values. */
export const itemBytes = (item: Record<string, AttributeValue>): number =>
  Object.entries(item).reduce(
    (sum, [name, value]) => sum + utf8Bytes(name) + attributeBytes(value),
    0,
  )

/**
 * What one transact entry contributes to its transaction's size, as far as the
 * request shows it: a Put's whole item; a Delete's or ConditionCheck's key; an
 * Update's key and the values it writes. DynamoDB also counts an updated
 * item's stored attributes, which the request does not carry — so this is a
 * lower bound for an Update, and exact (up to the overheads above) otherwise.
 */
export const transactItemBytes = (item: TransactWriteItem): number => {
  if (item.Put !== undefined) return itemBytes(item.Put.Item ?? {})
  if (item.Update !== undefined) {
    return itemBytes(item.Update.Key ?? {}) + itemBytes(item.Update.ExpressionAttributeValues ?? {})
  }
  return itemBytes(item.Delete?.Key ?? item.ConditionCheck?.Key ?? {})
}
