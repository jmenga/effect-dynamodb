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

/** Render the configured multi-item features for an error message. */
const describeFeatures = (features: ReadonlyArray<"unique" | "retain" | "softDelete">): string => {
  const labels = features.map((f) =>
    f === "unique" ? "`unique`" : f === "retain" ? "`versioned: { retain: true }`" : "`softDelete`",
  )
  return labels.length === 1
    ? labels[0]!
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
}

/**
 * `Batch.write` cannot host the multi-item lifecycle features that apply to the
 * direction being written (EDD-9049). This is a different judgement from the
 * transact path's: there, a `put`'s side items are derivable and get emitted;
 * here `BatchWriteItem` structurally cannot express them at all.
 *
 *   - **No `ConditionExpression`.** A uniqueness sentinel is only a constraint
 *     because of `attribute_not_exists(pk)`. Writing one without the guard would
 *     overwrite another row's reservation and enforce nothing — strictly worse
 *     than writing none, because the table would then *look* guarded.
 *   - **No atomicity.** A sentinel or snapshot that lands without its item (or
 *     an item without them) is a corrupt partition, and `Batch.write` chunks at
 *     25, so related items can even land in different requests.
 *   - **No `UpdateRequest`.** A soft-delete tombstone is a relocation
 *     (delete + put at a new sort key); a batch cannot make that one unit.
 *
 * **Direction matters.** `softDelete` changes only the delete path — a `put` of
 * a soft-deletable entity is an ordinary single-item put and is allowed. Gating
 * it on the put side would reject writes that have always been correct.
 *
 * Returns `undefined` when the entity is safe for `Batch.write` in `opType`.
 */
export const batchRejectReason = (entity: Entity, opType: "put" | "delete"): string | undefined => {
  const features = entity._multiItemWriteFeatures.filter((f) =>
    // `unique` and `retain` add items to BOTH directions (sentinel write /
    // release, snapshot on create / on overwrite-and-delete). `softDelete` only
    // ever changes a delete.
    f === "softDelete" ? opType === "delete" : true,
  )
  if (features.length === 0) return undefined
  return (
    `[EDD-9049] Batch.write cannot ${opType} an entity configured with ${describeFeatures(features)} — ` +
    "BatchWriteItem has no ConditionExpression (which is the whole of a uniqueness " +
    "sentinel's correctness), no UpdateRequest, and no atomicity across its 25-item " +
    "chunks. Use Transaction.transactWrite, or the entity's own operation."
  )
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
 * **What this gate covers.** Cases that are silently wrong (`upsert` — see
 * `PutKind`) or that cannot be working for anyone today: a `refs` entity writes
 * an item whose ref attribute is absent, so every later read fails to decode; a
 * `generatedId` entity dies outright (no `Crypto` in scope); a vector-indexed
 * entity writes an item with no embedding, so it silently drops out of the index.
 *
 * **The multi-item lifecycle features split by direction (#113).** `unique`,
 * `versioned: { retain }` and `softDelete` all need MORE than one item per write.
 * The line between "expand" and "reject" is whether the extra items are
 * derivable from the caller's payload or only from stored state:
 *
 * - **put** — the sentinel and the v1 snapshot come from the payload being
 *   written. `transactWrite` expands into them (`Entity._buildPutSideItems`).
 * - **delete** — the sentinel to release is keyed by the *stored* item's unique
 *   values, a retain snapshot copies the *stored* row, and a soft-delete
 *   tombstone IS the stored row relocated to a new sort key. All three need a
 *   read this path does not do (and a read would introduce a TOCTOU window that
 *   only another ConditionCheck could close). Rejected with **EDD-9048**.
 *
 * `Batch.write` rejects BOTH directions (**EDD-9049**) — see `batchRejectReason`.
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

  // --- multi-item lifecycle, delete direction (EDD-9048) -------------------
  // The put direction is EXPANDED instead — see the doc comment.
  if (opType === "delete" && entity._multiItemWriteFeatures.length > 0) {
    return Effect.fail(
      fail(
        `[EDD-9048] deleting an entity configured with ${describeFeatures(entity._multiItemWriteFeatures)}`,
        "the extra items a delete must write are derived from the STORED item — the sentinel " +
          "to release is keyed by its unique values, a retain snapshot copies it, and a " +
          "soft-delete tombstone is that row relocated to a new sort key. This path never " +
          "reads, so it cannot build them. Run the delete as its own operation " +
          "(db.entities.X.delete(...)), which reads the item first.",
      ),
    )
  }

  // --- entity-configuration level -----------------------------------------
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
 *
 * Returns the unmarshalled `item` alongside the marshalled one, plus the `now`
 * the timestamps were generated from. `Entity._buildPutSideItems` needs both to
 * derive uniqueness sentinels and the v1 version snapshot from the same values
 * that were written (#113), and re-deriving `now` there would risk a skew
 * between an item's `createdAt` and its snapshot's TTL.
 */
export const validateAndBuildPutItem = (
  entity: Entity,
  input: Record<string, unknown>,
  operation: string,
): Effect.Effect<
  {
    readonly item: Record<string, unknown>
    readonly marshalled: Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>
    readonly now: DateTime.Utc
  },
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

    return { item, marshalled: toAttributeMap(item), now }
  })
