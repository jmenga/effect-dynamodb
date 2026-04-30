/**
 * @internal Shared helpers for Batch and Transaction operations.
 *
 * Extracts common patterns: table name resolution, primary key composition,
 * and put-item construction (validation + key composition + system fields).
 */

import { Effect, Schema } from "effect"
import type { DynamoEncoding } from "../DynamoModel.js"
import type { Entity } from "../Entity.js"
import { ValidationError } from "../Errors.js"
import * as KeyComposer from "../KeyComposer.js"
import { toAttributeMap } from "../Marshaller.js"

/**
 * Generate a wire-form timestamp value for the configured encoding.
 * No-encoding default: ISO string. Custom encoding: serialized primitive.
 */
const generateTimestampPrimitive = (encoding: DynamoEncoding | null): string | number => {
  if (!encoding) return new Date().toISOString()
  const now = Date.now()
  switch (encoding.storage) {
    case "string":
      return new Date(now).toISOString()
    case "epochMs":
      return now
    case "epochSeconds":
      return Math.floor(now / 1000)
  }
}

/**
 * Resolve table names for a set of entity infos, deduplicating by entity reference.
 */
export const resolveTableNames = (infos: ReadonlyArray<{ readonly entity: Entity }>) =>
  Effect.gen(function* () {
    const tableNames = new Map<Entity, string>()
    for (const info of infos) {
      if (!tableNames.has(info.entity)) {
        const { name } = yield* info.entity._tableTag
        tableNames.set(info.entity, name)
      }
    }
    return tableNames
  })

/**
 * Compose the primary key for an entity item.
 */
export const composePrimaryKey = (
  entity: Entity,
  key: Record<string, unknown>,
): Record<string, unknown> => {
  const primary = entity.indexes.primary!
  const schema = entity._schema
  return {
    [primary.pk.field]: KeyComposer.composePk(schema, entity.entityType, primary, key),
    [primary.sk.field]: KeyComposer.composeSk(schema, entity.entityType, 1, primary, key),
  }
}

/**
 * Validate input, compose all keys, and build a marshalled put item.
 *
 * Encodes the user-supplied domain payload to wire format via
 * `Schema.encode(inputSchema)`, then assembles the DynamoDB item with system
 * fields and composite keys. Substituted self-date schemas + RedactedFromValue
 * are handled in the encode pass — no per-field serialization needed.
 */
export const validateAndBuildPutItem = (
  entity: Entity,
  input: Record<string, unknown>,
  operation: string,
): Effect.Effect<
  Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>,
  ValidationError
> =>
  Effect.gen(function* () {
    const inputSchema = entity.schemas.inputSchema as Schema.Codec<any>
    // Encode → fall back to decode-then-encode (mirrors Entity.put).
    const encoded = yield* Schema.encodeUnknownEffect(inputSchema)(input).pipe(
      Effect.catch(() =>
        Schema.decodeUnknownEffect(inputSchema)(input).pipe(
          Effect.flatMap((decoded) => Schema.encodeUnknownEffect(inputSchema)(decoded)),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new ValidationError({
            entityType: entity.entityType,
            operation,
            cause,
          }),
      ),
    )

    const item: Record<string, unknown> = { ...(encoded as Record<string, unknown>) }
    item.__edd_e__ = entity.entityType

    const keys = KeyComposer.composeAllKeys(
      entity._schema,
      entity.entityType,
      1,
      entity.indexes,
      encoded as Record<string, unknown>,
    )
    Object.assign(item, keys)

    // System fields (collision-aware). When a timestamp field collides with a
    // model-declared field, the user may have supplied their own value
    // (already encoded to wire by `Schema.encode`); else generate a wire
    // primitive directly.
    const sf = entity.systemFields
    if (sf.createdAt) {
      if (item[sf.createdAt] === undefined) {
        item[sf.createdAt] = generateTimestampPrimitive(sf.createdAtEncoding)
      }
    }
    if (sf.updatedAt) {
      if (item[sf.updatedAt] === undefined) {
        item[sf.updatedAt] = generateTimestampPrimitive(sf.updatedAtEncoding)
      }
    }
    if (sf.version) item[sf.version] = 1

    // Flatten sparse-map fields into per-entry top-level attributes. Throws
    // on invalid keys; surface as ValidationError at the entity boundary.
    try {
      entity._serializeSparseFields(item)
    } catch (e) {
      return yield* new ValidationError({
        entityType: entity.entityType,
        operation,
        cause: e instanceof Error ? e.message : String(e),
      })
    }


    return toAttributeMap(item)
  })
