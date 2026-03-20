/**
 * @internal Shared helpers for Batch and Transaction operations.
 *
 * Extracts common patterns: table name resolution, primary key composition,
 * and put-item construction (validation + key composition + system fields).
 */

import { Effect, Schema } from "effect"
import type { Entity } from "../Entity.js"
import { ValidationError } from "../Errors.js"
import * as KeyComposer from "../KeyComposer.js"
import { toAttributeMap } from "../Marshaller.js"

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
    const inputSchema = entity.schemas.inputSchema as Schema.Codec<any>
    const validated = yield* Schema.decodeUnknownEffect(inputSchema)(input).pipe(
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

    const now = new Date().toISOString()
    if (entity.systemFields.createdAt) item[entity.systemFields.createdAt] = now
    if (entity.systemFields.updatedAt) item[entity.systemFields.updatedAt] = now
    if (entity.systemFields.version) item[entity.systemFields.version] = 1

    return toAttributeMap(item)
  })
