/**
 * @internal Shared helpers for Batch and Transaction operations.
 *
 * Extracts common patterns: table name resolution, primary key composition,
 * and put-item construction (validation + key composition + system fields).
 */

import type { DynamoEncoding } from "@effect-dynamodb/schema/DynamoModel.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DateTime, Effect, Schema } from "effect"
import type { Entity } from "../Entity.js"
import { toAttributeMap } from "../Marshaller.js"

/**
 * Generate a wire-form timestamp value for the configured encoding from a
 * Clock-backed `now: DateTime.Utc` (resolved by the caller via `yield*
 * DateTime.now`). No-encoding default: ISO string. Custom encoding: serialized
 * primitive. Contains no `Date` constructor, so it is deterministic under
 * `TestClock`.
 *
 * Shared by the Entity write path (`Entity.generateTimestamp`) and the
 * Batch/Transaction path so both produce identical timestamps.
 */
export const generateTimestampPrimitive = (
  now: DateTime.Utc,
  encoding: DynamoEncoding | null,
): string | number => {
  if (!encoding) return DateTime.formatIso(now)
  const ms = DateTime.toEpochMillis(now)
  switch (encoding.storage) {
    case "string":
      // System timestamps generated here are UTC; DateTime.Zoned-typed
      // collision fields are rare and were not previously special-cased.
      return DateTime.formatIso(now)
    case "epochMs":
      return ms
    case "epochSeconds":
      return Math.floor(ms / 1000)
  }
}

/**
 * Reject an op whose semantics the `TransactWriteItems` / `BatchWriteItem`
 * compile path cannot faithfully reproduce.
 *
 * Both paths turn an entity op into a single self-contained `Put` / `Delete`
 * built from the encoded input. That is exactly right for a plain `put` /
 * `delete`, and wrong — silently — for anything whose contract needs a
 * different DynamoDB verb, extra items, or a service the compile step does not
 * have. Loud beats silent (#100).
 *
 * **What this gate covers, and why not more.** It rejects the cases that are
 * either newly reachable and silently wrong (`upsert` — see `PutKind`) or that
 * cannot be working for anyone today: a `refs` entity writes an item whose ref
 * attribute is absent, so every later read fails to decode; a `generatedId`
 * entity dies outright (no `Crypto` in scope); a vector-indexed entity writes an
 * item with no embedding, so it silently drops out of the index.
 *
 * It deliberately does NOT reject the multi-item lifecycle features — `unique`,
 * `versioned: { retain }`, `softDelete`. Those share one root cause with each
 * other (this path emits exactly one item, so it cannot write a sentinel, a
 * version snapshot, or a tombstone), they are long-shipped, and this repo's own
 * connected suite exercises them through `transactWrite`. Fixing them means
 * emitting EXTRA transact items, which collides with EventStore's position-based
 * cancellation mapping — the caller-visible `additionalItems` indices must not
 * shift. That is a deliberate design change with its own semver decision, not a
 * drive-by.
 *
 * `capability` names what the caller would have to give up, so the message can
 * say why rather than just "unsupported".
 */
export const rejectUnsupportedOp = (
  entity: Entity,
  operation: string,
  opType: "put" | "delete",
  putKind: "put" | "create" | "upsert" | undefined,
): Effect.Effect<void, ValidationError> => {
  const fail = (capability: string, reason: string) =>
    new ValidationError({
      entityType: entity.entityType,
      operation,
      cause: `${operation}: ${capability} is not supported here — ${reason}`,
    })

  // --- op-kind level -------------------------------------------------------
  if (opType === "put" && putKind === "upsert") {
    return Effect.fail(
      fail(
        "upsert",
        "upsert is an UpdateItem whose SET clause uses if_not_exists for createdAt, " +
          "immutable fields and the version counter. Compiling it as a Put would reset " +
          "them. Use put() or create() here, or run the upsert as its own operation.",
      ),
    )
  }

  // --- entity-configuration level -----------------------------------------
  // Only the cases that cannot be working for anyone today — see the doc comment
  // for why `unique` / `versioned.retain` / `softDelete` are deliberately absent.
  if (opType === "put" && entity._resolvedRefs.length > 0) {
    return Effect.fail(
      fail(
        "a ref",
        "write-time ref hydration reads the referenced entity, which this compile step " +
          "cannot do; the ref attribute would be written empty.",
      ),
    )
  }
  if (opType === "put" && entity.generatedId != null) {
    return Effect.fail(
      fail("a generated id", "id generation needs the Crypto service, which is not in scope here."),
    )
  }
  if (opType === "put" && Object.keys(entity._vectorIndexes ?? {}).length > 0) {
    return Effect.fail(
      fail(
        "a vector index",
        "computing the embedding needs the Embedder service, which is not in scope here; " +
          "the item would be written without its vector and drop out of the index.",
      ),
    )
  }
  return Effect.void
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
    // Clock-backed time source resolved once per op; threaded into the sync
    // timestamp builder so the value is deterministic under `TestClock`.
    const now = yield* DateTime.now
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
        item[sf.createdAt] = generateTimestampPrimitive(now, sf.createdAtEncoding)
      }
    }
    if (sf.updatedAt) {
      if (item[sf.updatedAt] === undefined) {
        item[sf.updatedAt] = generateTimestampPrimitive(now, sf.updatedAtEncoding)
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
