import { Data, type Option } from "effect"

/** Wraps AWS SDK errors from DynamoDB operations */
export class DynamoError extends Data.TaggedError("DynamoError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** DynamoDB throttling — request rate too high */
export class ThrottlingError extends Data.TaggedError("ThrottlingError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** DynamoDB validation error — malformed request */
export class DynamoValidationError extends Data.TaggedError("DynamoValidationError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** DynamoDB internal server error — transient failure */
export class InternalServerError extends Data.TaggedError("InternalServerError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** DynamoDB resource not found — table doesn't exist */
export class ResourceNotFoundError extends Data.TaggedError("ResourceNotFoundError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** GetItem returned no item for the given key */
export class ItemNotFound extends Data.TaggedError("ItemNotFound")<{
  readonly entityType: string
  readonly key: Record<string, unknown>
}> {}

/**
 * PutItem/DeleteItem/UpdateItem conditional check failed.
 *
 * On `Entity.append()` (time-series), this is surfaced when a user-supplied
 * `condition` rejected the write while the CAS predicate held. In that case
 * `current` is `Option.some(<decoded post-state>)` carrying the live current
 * item snapshot read via the follow-up GetItem. For non-append paths and for
 * append calls that opted out via `.skipFollowUp()`, `current` is omitted /
 * `Option.none()` (no follow-up GetItem was issued).
 *
 * On the `.skipFollowUp()` path of `.append()`, user-condition failures cannot
 * be distinguished from CAS failures, so they are reported as
 * {@link StaleAppend} instead — see that error's docs.
 */
export class ConditionalCheckFailed extends Data.TaggedError("ConditionalCheckFailed")<{
  readonly entityType: string
  readonly key: Record<string, unknown>
  readonly current?: Option.Option<unknown>
}> {}

/**
 * `Entity.append()` was rejected because the CAS predicate
 * (`attribute_not_exists(pk) OR <orderBy> < :newOrderBy`) did not hold —
 * i.e. another writer has already advanced the current item past
 * `attemptedOrderBy`. This is an EXPECTED outcome under newer-wins
 * concurrency; callers typically `Effect.catchTag("StaleAppend", ...)` and
 * treat it as a no-op.
 *
 * `current` carries the winning state when the follow-up GetItem ran:
 * - `Option.some(<raw decoded item>)` on the default path.
 * - `Option.none()` when the caller opted out via `.skipFollowUp()`.
 *
 * The value is typed as `unknown` because `StaleAppend` has no model
 * generic; callers that need a typed value can decode it with the entity's
 * record schema themselves.
 *
 * NOTE on the `skipFollowUp` path: a user-supplied `.condition()` failure
 * also raises `StaleAppend` (not {@link ConditionalCheckFailed}) because no
 * follow-up GetItem ran, so the two cancellation modes are
 * indistinguishable. If you need the disambiguation, do not call
 * `.skipFollowUp()`.
 */
export class StaleAppend extends Data.TaggedError("StaleAppend")<{
  readonly entityType: string
  readonly orderByField: string
  readonly attemptedOrderBy: unknown
  readonly current: Option.Option<unknown>
}> {}

/** Schema decode/encode validation failed */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly entityType: string
  readonly operation: string
  readonly cause: unknown
}> {}

/** TransactWriteItems or TransactGetItems cancelled by DynamoDB */
export class TransactionCancelled extends Data.TaggedError("TransactionCancelled")<{
  readonly operation: string
  readonly reasons: ReadonlyArray<{
    readonly code?: string | undefined
    readonly message?: string | undefined
  }>
  readonly cause: unknown
}> {}

/** Unique constraint violation — field value already exists */
export class UniqueConstraintViolation extends Data.TaggedError("UniqueConstraintViolation")<{
  readonly entityType: string
  readonly constraint: string
  readonly fields: Record<string, string>
}> {}

/** Optimistic concurrency conflict — item was modified since last read */
export class OptimisticLockError extends Data.TaggedError("OptimisticLockError")<{
  readonly entityType: string
  readonly key: Record<string, unknown>
  readonly expectedVersion: number
  readonly actualVersion: number
}> {}

// ---------------------------------------------------------------------------
// AWS error shape interfaces and type guards (internal)
// ---------------------------------------------------------------------------

/** @internal Shape of AWS SDK TransactionCanceledException */
export interface AwsTransactionCancelled {
  readonly name: "TransactionCanceledException"
  readonly CancellationReasons?: ReadonlyArray<{
    readonly Code?: string
    readonly Message?: string
  }>
}

/** @internal Shape of AWS SDK ConditionalCheckFailedException */
export interface AwsConditionalCheckFailed {
  readonly name: "ConditionalCheckFailedException"
}

/** @internal */
export const isAwsTransactionCancelled = (cause: unknown): cause is AwsTransactionCancelled =>
  cause != null &&
  typeof cause === "object" &&
  "name" in cause &&
  (cause as { name: unknown }).name === "TransactionCanceledException"

/** @internal */
export const isAwsConditionalCheckFailed = (cause: unknown): cause is AwsConditionalCheckFailed =>
  cause != null &&
  typeof cause === "object" &&
  "name" in cause &&
  (cause as { name: unknown }).name === "ConditionalCheckFailedException"

/** @internal */
export const isAwsThrottling = (cause: unknown): boolean =>
  cause != null &&
  typeof cause === "object" &&
  "name" in cause &&
  ((cause as { name: string }).name === "ThrottlingException" ||
    (cause as { name: string }).name === "ProvisionedThroughputExceededException")

/** @internal */
export const isAwsValidationError = (cause: unknown): boolean =>
  cause != null &&
  typeof cause === "object" &&
  "name" in cause &&
  (cause as { name: string }).name === "ValidationException"

/** @internal */
export const isAwsInternalServerError = (cause: unknown): boolean =>
  cause != null &&
  typeof cause === "object" &&
  "name" in cause &&
  (cause as { name: string }).name === "InternalServerError"

/** @internal */
export const isAwsResourceNotFound = (cause: unknown): boolean =>
  cause != null &&
  typeof cause === "object" &&
  "name" in cause &&
  (cause as { name: string }).name === "ResourceNotFoundException"

/** Entity-level transactWriteItems would exceed DynamoDB's 100-item limit */
export class TransactionOverflow extends Data.TaggedError("TransactionOverflow")<{
  readonly entityType: string
  readonly operation: string
  readonly itemCount: number
  readonly limit: number
}> {}

/** Referenced entity not found during ref hydration */
export class RefNotFound extends Data.TaggedError("RefNotFound")<{
  readonly entity: string
  readonly field: string
  readonly refEntity: string
  readonly refId: string
}> {}

/** Item is soft-deleted and cannot be modified without restore */
export class ItemDeleted extends Data.TaggedError("ItemDeleted")<{
  readonly entityType: string
  readonly key: Record<string, unknown>
  readonly deletedAt: string
}> {}

/** Item is not soft-deleted — restore requires a deleted item */
export class ItemNotDeleted extends Data.TaggedError("ItemNotDeleted")<{
  readonly entityType: string
  readonly key: Record<string, unknown>
}> {}

/** Aggregate assembly failed — missing items, structural violations, or decode errors */
export class AggregateAssemblyError extends Data.TaggedError("AggregateAssemblyError")<{
  readonly aggregate: string
  readonly reason: string
  readonly key: Record<string, unknown>
}> {}

/** Aggregate decomposition failed — schema validation or structural error during write path */
export class AggregateDecompositionError extends Data.TaggedError("AggregateDecompositionError")<{
  readonly aggregate: string
  readonly member: string
  readonly reason: string
}> {}

/** Sub-aggregate exceeds DynamoDB's 100-item transaction limit */
export class AggregateTransactionOverflow extends Data.TaggedError("AggregateTransactionOverflow")<{
  readonly aggregate: string
  readonly subgraph: string
  readonly itemCount: number
  readonly limit: number
}> {}

/** Cascade update partially failed (eventual mode) */
export class CascadePartialFailure extends Data.TaggedError("CascadePartialFailure")<{
  readonly sourceEntity: string
  readonly sourceId: string
  readonly succeeded: number
  readonly failed: number
  readonly errors: ReadonlyArray<unknown>
}> {}

/**
 * Embedding generation failed on the vector-search write path.
 *
 * Raised either by the user's `Embedder.embed` implementation (`cause` carries
 * the underlying failure) or by the library when an entity declares
 * `vectorIndexes` but no `Embedder` was resolvable at `DynamoClient.make` time
 * and the write did not supply `.withVector(...)`. The `index` field names the
 * logical vector index the embedding was being produced for.
 */
export class EmbeddingError extends Data.TaggedError("EmbeddingError")<{
  readonly entityType: string
  readonly index: string
  readonly reason: string
  readonly cause?: unknown
}> {}

/**
 * `SearchVectors` was called against a vector index that is still backfilling.
 *
 * DynamoDB rejects searches until a newly created index reports `ACTIVE` with
 * `Backfilling: false`. Wait for it with
 * `db.tables.<Table>.waitForVectorIndex(indexName)` before searching.
 */
export class VectorIndexBackfilling extends Data.TaggedError("VectorIndexBackfilling")<{
  readonly tableName: string
  readonly indexName: string
  readonly cause: unknown
}> {}

/** Optimistic concurrency conflict — stream version did not match */
export class VersionConflict extends Data.TaggedError("VersionConflict")<{
  readonly streamName: string
  readonly streamId: string
  readonly expectedVersion: number
}> {}

/**
 * EDD-9024 — DEPRECATED in v1.7.1.
 *
 * @deprecated Since v1.7.1, this error is no longer thrown at runtime. It is
 *   kept as an exported class for back-compat with consumers who type-imported
 *   it (e.g. inside `Effect.catchTag("CompositeKeyHoleError", ...)` blocks).
 *   No code path constructs or throws this error anymore.
 *
 * **Why deprecated.** v1.7.0's "throw under preserve on hole pattern" was a
 * defensive runtime safety net for a case the type system already catches:
 * required composites can't be omitted under `exactOptionalPropertyTypes`
 * since v1.7.0 reverted the v1.6 NullishOr widening. The only remaining
 * runtime "hole" shape is "optional leading composite absent + present
 * trailing composite," which is a normal write the consumer expressly chose.
 *
 * **What replaces it.** Hole patterns now collapse into the unified per-half
 * can't-compose rule:
 * - `'sparse'` half → REMOVE that half's key (drops the half).
 * - `'preserve'` half + composite of the half is in `Entity.remove([...])`
 *   → REMOVE that half's key (cascade override fires).
 * - `'preserve'` half + no composite in `Entity.remove([...])` → noop (the
 *   stored key is left untouched; may be stale until the next write that
 *   touches the half supplies enough composites to recompose, or an
 *   `Entity.remove` cascade fires).
 *
 * See `DESIGN.md §7 Policy-Aware GSI Composition` (v1.7.1 unified rule).
 *
 * **Migration.** Remove any `Effect.catchTag("CompositeKeyHoleError", ...)`
 * handlers — the throw site is gone and the catch is dead code. If you were
 * relying on the throw to detect bad payloads, switch to declaring the
 * relevant GSI half as `'sparse'` (the consumer-side semantic that always
 * matches the throw's intent — drop the index entry on can't-compose) or
 * supply the surviving composites via `set` in the same update.
 */
export class CompositeKeyHoleError extends Data.TaggedError("CompositeKeyHoleError")<{
  readonly entityType: string
  readonly indexName: string
  readonly clearedComposite: string
  readonly trailingComposite: string
  readonly clearedPosition: number
  readonly trailingPosition: number
  /** Which GSI key attribute the hole is in — `"pk"` (gsiNpk) or `"sk"` (gsiNsk). */
  readonly key: "pk" | "sk"
  /** Human-readable description, prefixed with `EDD-9024`. */
  readonly message: string
}> {}

/**
 * Build a {@link CompositeKeyHoleError} with a formatted message.
 *
 * @deprecated Since v1.7.1 this builder is unused — no code path raises EDD-9024
 *   at runtime. Kept exported only for back-compat with consumers who imported
 *   the helper. See {@link CompositeKeyHoleError} for the migration path.
 */
export const makeCompositeKeyHoleError = (params: {
  readonly entityType: string
  readonly indexName: string
  readonly clearedComposite: string
  readonly trailingComposite: string
  readonly clearedPosition: number
  readonly trailingPosition: number
  readonly key: "pk" | "sk"
}): CompositeKeyHoleError =>
  new CompositeKeyHoleError({
    ...params,
    message:
      `[EDD-9024 — DEPRECATED] Composite key hole on GSI "${params.indexName}" of entity "${params.entityType}": ` +
      `composite "${params.clearedComposite}" at ${params.key} position ${params.clearedPosition} is absent, ` +
      `but composite "${params.trailingComposite}" at ${params.key} position ${params.trailingPosition} is still present. ` +
      `Since v1.7.1 this error is no longer thrown — hole patterns collapse into the unified per-half can't-compose rule ` +
      `(REMOVE the half under 'sparse' or removedSet cascade; noop under 'preserve' without removedSet).`,
  })

/**
 * EDD-9025 — A composite attribute on `primaryKey`, `indexes`, or a `unique`
 * constraint has a Schema whose type union includes `null`. Composites
 * participate in string composition (`acc#X#alert#Y`); `null` is not a
 * meaningful slot value — only present-with-value or absent. Allowing
 * `Schema.NullOr` / `Schema.NullishOr` / `Schema.Union([..., Schema.Null])`
 * on a composite would let `set({ composite: null })` typecheck, then either
 * blow up at runtime or silently produce a key with the literal string
 * `"null"` as a slot.
 *
 * Raised at `Entity.make()` time. The error names the entity, the
 * surface where the composite is declared (primary key / a GSI / a unique
 * constraint), the offending composite attribute, and the resolved Schema
 * path that contains `null`.
 *
 * Resolution: declare the attribute as `Schema.optional(...)` (which
 * produces `T | undefined` without `null`). Sparse-pattern usage is fully
 * supported under v3's two-way payload classification — `undefined` is
 * "absent" for GSI composition purposes.
 *
 * See `DESIGN.md §7 Policy-Aware GSI Composition` (EDD-9025 footgun gate).
 */
export class CompositeNullableError extends Data.TaggedError("CompositeNullableError")<{
  readonly entityType: string
  /** "primaryKey" | "index:<name>" | "unique:<name>" */
  readonly surface: string
  readonly compositeAttribute: string
  /** Resolved schema path that revealed the `null` branch. */
  readonly schemaPath: string
  /** Human-readable description, prefixed with `EDD-9025`. */
  readonly message: string
}> {}

/**
 * Build a {@link CompositeNullableError} with a formatted message. Centralises
 * the message format so call sites (Entity.make validation paths) stay
 * consistent.
 */
export const makeCompositeNullableError = (params: {
  readonly entityType: string
  readonly surface: string
  readonly compositeAttribute: string
  readonly schemaPath: string
}): CompositeNullableError =>
  new CompositeNullableError({
    ...params,
    message:
      `[EDD-9025] Entity "${params.entityType}": composite attribute "${params.compositeAttribute}" ` +
      `on ${params.surface} resolves to a Schema that includes \`null\` (${params.schemaPath}). ` +
      `Composites participate in string composition and cannot be null — only present-with-value or absent. ` +
      `Replace the nullable wrapper with \`Schema.optional(...)\` (T | undefined) to express the sparse ` +
      `pattern, or supply a non-nullable schema for "${params.compositeAttribute}".`,
  })
