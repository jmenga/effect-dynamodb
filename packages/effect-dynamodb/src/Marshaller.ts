/**
 * Marshaller — Thin wrapper around @aws-sdk/util-dynamodb for converting
 * between JS objects and DynamoDB attribute maps, plus date-aware serialization
 * for DynamoEncoding-annotated fields.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import { DateTime } from "effect"
import type { DynamoEncoding } from "./DynamoModel.js"

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
// Date-aware serialization for DynamoEncoding-annotated fields
// ---------------------------------------------------------------------------

/**
 * @internal
 *
 * Convert a domain date value to the storage primitive based on DynamoEncoding.
 *
 * No longer used by Entity (which now uses substituted bidirectional schemas
 * and Schema.encode end-to-end). Retained for Aggregate's per-field root
 * attribute serialization, which is decomposed at write time and re-assembled
 * at read time without going through Schema.encode/decode of a single schema.
 *
 * Domain types supported:
 * - `DateTime.Utc` → ISO string, epoch ms, or epoch seconds
 * - `DateTime.Zoned` → extended ISO string (only "string" storage)
 * - `Date` → ISO string, epoch ms, or epoch seconds
 */
export const serializeDateForDynamo = (
  value: unknown,
  encoding: DynamoEncoding,
): string | number => {
  let epochMs: number
  if (DateTime.isDateTime(value)) {
    epochMs = DateTime.toEpochMillis(value)
  } else if (value instanceof Date) {
    epochMs = value.getTime()
  } else {
    throw new Error(`serializeDateForDynamo: unsupported value type: ${typeof value}`)
  }

  switch (encoding.storage) {
    case "string":
      if (
        encoding.domain === "DateTime.Zoned" &&
        DateTime.isDateTime(value) &&
        DateTime.isZoned(value)
      ) {
        return DateTime.formatIsoZoned(value)
      }
      return new Date(epochMs).toISOString()
    case "epochMs":
      return epochMs
    case "epochSeconds":
      return Math.floor(epochMs / 1000)
  }
}

/**
 * @internal
 *
 * Convert a DynamoDB storage primitive back to the domain value based on DynamoEncoding.
 *
 * No longer used by Entity (which now uses substituted bidirectional schemas
 * and Schema.decode end-to-end). Retained for Aggregate's per-field root
 * attribute deserialization.
 */
export const deserializeDateFromDynamo = (
  stored: unknown,
  encoding: DynamoEncoding,
): DateTime.Utc | DateTime.Zoned | Date => {
  const label = `${encoding.domain}/${encoding.storage}`

  switch (encoding.domain) {
    case "DateTime.Zoned": {
      if (typeof stored !== "string") {
        throw new Error(
          `deserializeDateFromDynamo: expected string for ${label}, got ${typeof stored}`,
        )
      }
      try {
        const match = stored.match(/^(.+)\[(.+)\]$/)
        if (match) {
          const utc = DateTime.makeUnsafe(match[1]!)
          return DateTime.makeZonedUnsafe(utc, { timeZone: match[2]! })
        }
        // Offset-only or plain ISO → treat as UTC-zoned
        const utc = DateTime.makeUnsafe(stored)
        return DateTime.makeZonedUnsafe(utc, { timeZone: "UTC" })
      } catch (e) {
        throw new Error(
          `deserializeDateFromDynamo: invalid DateTime.Zoned value "${stored}": ${e instanceof Error ? e.message : e}`,
        )
      }
    }
    case "DateTime.Utc": {
      if (encoding.storage === "string") {
        if (typeof stored !== "string") {
          throw new Error(
            `deserializeDateFromDynamo: expected string for ${label}, got ${typeof stored}`,
          )
        }
        try {
          return DateTime.makeUnsafe(stored)
        } catch (e) {
          throw new Error(
            `deserializeDateFromDynamo: invalid DateTime.Utc value "${stored}": ${e instanceof Error ? e.message : e}`,
          )
        }
      }
      if (typeof stored !== "number" || !Number.isFinite(stored)) {
        throw new Error(
          `deserializeDateFromDynamo: expected finite number for ${label}, got ${typeof stored === "number" ? stored : typeof stored}`,
        )
      }
      if (encoding.storage === "epochMs") return DateTime.makeUnsafe(stored)
      return DateTime.makeUnsafe(stored * 1000)
    }
    case "Date": {
      if (encoding.storage === "string") {
        if (typeof stored !== "string") {
          throw new Error(
            `deserializeDateFromDynamo: expected string for ${label}, got ${typeof stored}`,
          )
        }
        const d = new Date(stored)
        if (Number.isNaN(d.getTime())) {
          throw new Error(`deserializeDateFromDynamo: invalid Date value "${stored}"`)
        }
        return d
      }
      if (typeof stored !== "number" || !Number.isFinite(stored)) {
        throw new Error(
          `deserializeDateFromDynamo: expected finite number for ${label}, got ${typeof stored === "number" ? stored : typeof stored}`,
        )
      }
      if (encoding.storage === "epochMs") return new Date(stored)
      return new Date(stored * 1000)
    }
  }
}
