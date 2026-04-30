/**
 * Marshaller — Thin wrapper around @aws-sdk/util-dynamodb for converting
 * between JS objects and DynamoDB attribute maps.
 *
 * Date-aware (de)serialization is no longer handled here — both Entity and
 * Aggregate now route date conversion through substituted bidirectional
 * Schema transforms (`buildDateTransform` in `internal/EntitySchemas.ts`)
 * and the standard `Schema.encode` / `Schema.decode` pipelines.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import type { SparseConfig } from "./DynamoModel.js"

/** Marshall a JS object to a DynamoDB attribute map */
export const toAttributeMap = (item: Record<string, unknown>): Record<string, AttributeValue> =>
  marshall(item, { removeUndefinedValues: true, convertClassInstanceToMap: true })

/** Unmarshall a DynamoDB attribute map to a JS object */
export const fromAttributeMap = (item: Record<string, AttributeValue>): Record<string, unknown> =>
  unmarshall(item)

/** Marshall a single value to a DynamoDB attribute value */
export const toAttributeValue = (value: unknown): AttributeValue =>
  marshall({ v: value }, { removeUndefinedValues: true, convertClassInstanceToMap: true }).v!

/** Unmarshall a single DynamoDB attribute value */
export const fromAttributeValue = (value: AttributeValue): unknown => unmarshall({ v: value }).v

// ---------------------------------------------------------------------------
// Sparse Map flatten / rebuild
// ---------------------------------------------------------------------------

/**
 * Validate a sparse-map key at write time.
 *
 * Rules:
 *  - Must be a string (we don't silently coerce).
 *  - Must not contain `#` — `#` is reserved as the prefix/key delimiter.
 *  - The composed `<prefix>#<key>` must satisfy DynamoDB's 1–255 byte
 *    attribute-name limit.
 *
 * Throws on violation. Caller is expected to translate into a tagged
 * `ValidationError` at the entity boundary.
 */
const validateSparseKey = (field: string, prefix: string, key: string): void => {
  if (typeof key !== "string") {
    throw new Error(
      `Sparse map "${field}": key must be a string, got ${typeof key}`,
    )
  }
  if (key.length === 0) {
    throw new Error(`Sparse map "${field}": key must be non-empty`)
  }
  if (key.includes("#")) {
    throw new Error(
      `Sparse map "${field}": key "${key}" must not contain '#' — the library does not silently escape`,
    )
  }
  const attrName = `${prefix}#${key}`
  // DynamoDB attribute names: 1–255 bytes. Length check is approximate (UTF-8
  // bytes vs JS code units), but `key.length + prefix.length + 1` is an upper
  // bound on byte length when both are ASCII, which is the common case.
  // For full UTF-8 correctness, encode via TextEncoder.
  const byteLen = new TextEncoder().encode(attrName).length
  if (byteLen < 1 || byteLen > 255) {
    throw new Error(
      `Sparse map "${field}": composed attribute name "${attrName}" is ${byteLen} bytes (must be 1–255)`,
    )
  }
}

/**
 * Flatten sparse-map fields on an item before marshalling.
 *
 * For each `(fieldName, { prefix })` in `sparseFields`:
 *  - If `item[fieldName]` is undefined/null, drop the field (no-op).
 *  - Otherwise, expect `Record<string, V>`. For each `(k, v)`:
 *      validate `k`, write `item["<prefix>#<k>"] = v`.
 *  - Delete the original `item[fieldName]` so it doesn't marshal as a Map.
 *
 * Mutates `item` in place. Idempotent on items already flattened (the field is
 * absent — the for/in skips it).
 */
export const encodeSparseFields = (
  item: Record<string, unknown>,
  sparseFields: Record<string, SparseConfig>,
): void => {
  for (const [fieldName, sparse] of Object.entries(sparseFields)) {
    if (!(fieldName in item)) continue
    const value = item[fieldName]
    if (value === undefined || value === null) {
      delete item[fieldName]
      continue
    }
    if (typeof value !== "object") {
      throw new Error(
        `Sparse map "${fieldName}": expected an object/record, got ${typeof value}`,
      )
    }
    const record = value as Record<string, unknown>
    for (const [k, v] of Object.entries(record)) {
      validateSparseKey(fieldName, sparse.prefix, k)
      item[`${sparse.prefix}#${k}`] = v
    }
    delete item[fieldName]
  }
}

/**
 * Rebuild sparse-map fields on a raw item after unmarshalling.
 *
 * For each `(fieldName, { prefix })` in `sparseFields`:
 *  - Walk top-level keys, collect any matching `<prefix>#<key>`,
 *    extract the key portion, and accumulate into `out[fieldName][key]`.
 *  - Delete the flattened attributes from the raw item.
 *  - If no matching attributes are found, the result is `{}` — sparse fields
 *    on the domain side are required (a `Schema.Record` always decodes to an
 *    object, never `undefined`).
 *
 * Mutates `raw` in place.
 */
export const decodeSparseFields = (
  raw: Record<string, unknown>,
  sparseFields: Record<string, SparseConfig>,
): void => {
  if (Object.keys(sparseFields).length === 0) return
  // Build a list of (fieldName, prefix, prefixWithDelim) once so we don't
  // re-concatenate per attribute.
  const entries: Array<[string, string, string]> = []
  for (const [fieldName, sparse] of Object.entries(sparseFields)) {
    entries.push([fieldName, sparse.prefix, `${sparse.prefix}#`])
  }
  // Sort by prefix length descending so a longer prefix wins over a shorter
  // prefix that happens to be its own substring (e.g. `metric` vs `metrics`).
  entries.sort((a, b) => b[2].length - a[2].length)

  // Initialize empty buckets for each sparse field.
  const buckets: Record<string, Record<string, unknown>> = {}
  for (const [fieldName] of entries) buckets[fieldName] = {}

  // One pass over keys.
  const keys = Object.keys(raw)
  for (const k of keys) {
    for (const [fieldName, , prefixWithDelim] of entries) {
      if (k.startsWith(prefixWithDelim)) {
        const subKey = k.substring(prefixWithDelim.length)
        // Skip empty sub-keys (defensive — would mean the stored attr was
        // literally `<prefix>#`, which validation rejects on write).
        if (subKey.length === 0) break
        buckets[fieldName]![subKey] = raw[k]
        delete raw[k]
        break
      }
    }
  }

  for (const [fieldName] of entries) {
    raw[fieldName] = buckets[fieldName]!
  }
}
