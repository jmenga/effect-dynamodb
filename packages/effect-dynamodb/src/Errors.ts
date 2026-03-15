import { Data } from "effect"

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

/** PutItem/DeleteItem conditional check failed */
export class ConditionalCheckFailed extends Data.TaggedError("ConditionalCheckFailed")<{
  readonly entityType: string
  readonly key: Record<string, unknown>
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

/** Optimistic concurrency conflict — stream version did not match */
export class VersionConflict extends Data.TaggedError("VersionConflict")<{
  readonly streamName: string
  readonly streamId: string
  readonly expectedVersion: number
}> {}
