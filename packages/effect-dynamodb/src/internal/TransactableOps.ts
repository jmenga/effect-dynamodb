/**
 * @internal Shared helpers for Batch and Transaction operations.
 *
 * Extracts common patterns: table name resolution, primary key composition,
 * and put-item construction (validation + key composition + system fields).
 */

import { DateTime, Effect, Schema } from "effect"
import type { DynamoEncoding } from "../DynamoModel.js"
import type { Entity } from "../Entity.js"
import { ValidationError } from "../Errors.js"
import * as KeyComposer from "../KeyComposer.js"
import { serializeDateForDynamo, toAttributeMap } from "../Marshaller.js"

const generateTimestampPrimitive = (encoding: DynamoEncoding | null): string | number =>
  encoding ? serializeDateForDynamo(new Date(), encoding) : new Date().toISOString()

const generateDomainTimestamp = (
  encoding: DynamoEncoding,
): DateTime.Utc | DateTime.Zoned | Date => {
  switch (encoding.domain) {
    case "DateTime.Utc":
      return DateTime.makeUnsafe(new Date())
    case "DateTime.Zoned":
      return DateTime.makeZonedUnsafe(new Date(), { timeZone: "UTC" })
    case "Date":
      return new Date()
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
    const inputDecodeSchema = entity.schemas.inputDecodeSchema as Schema.Codec<any>
    const validated = yield* Schema.decodeUnknownEffect(inputDecodeSchema)(input).pipe(
      Effect.mapError(
        (cause) =>
          new ValidationError({
            entityType: entity.entityType,
            operation,
            cause,
          }),
      ),
    )

    const item: Record<string, unknown> = { ...validated }
    item.__edd_e__ = entity.entityType

    const keys = KeyComposer.composeAllKeys(
      entity._schema,
      entity.entityType,
      1,
      entity.indexes,
      validated,
    )
    Object.assign(item, keys)

    // System fields (collision-aware). See Entity.put for the canonical logic.
    const sf = entity.systemFields
    if (sf.createdAt) {
      if (item[sf.createdAt] === undefined) {
        item[sf.createdAt] =
          sf.createdAtCollision && sf.createdAtEncoding
            ? generateDomainTimestamp(sf.createdAtEncoding)
            : generateTimestampPrimitive(sf.createdAtEncoding)
      }
    }
    if (sf.updatedAt) {
      if (item[sf.updatedAt] === undefined) {
        item[sf.updatedAt] =
          sf.updatedAtCollision && sf.updatedAtEncoding
            ? generateDomainTimestamp(sf.updatedAtEncoding)
            : generateTimestampPrimitive(sf.updatedAtEncoding)
      }
    }
    if (sf.version) item[sf.version] = 1

    // Convert any domain-value date fields to storage primitives (both user-
    // supplied model fields and domain-generated system fields).
    entity._serializeDateFields(item)

    return toAttributeMap(item)
  })
