/**
 * @internal How the library calls a `BlobStore` (#179, design §12.1): every
 * call runs in a span (`effect-dynamodb.BlobStore.<action>`), and the
 * `BlobStoreFailure` a store fails with becomes a `BlobStoreError` carrying the
 * operation's context — the entity type, the stored attribute, the operation
 * and whether the DynamoDB write already committed (§6.13).
 *
 * Shared by the upload ledger (`put`, `delete`) and the resolver (`get`,
 * `presign`). Not part of the public API.
 */

import {
  type BlobStoreAction,
  BlobStoreError,
  type BlobStoreReason,
} from "@effect-dynamodb/schema/Errors.js"
import type { BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Effect, Stream } from "effect"
import type { BlobStoreService } from "./BlobStoreContract.js"

/** Who is calling the store, for the error and the span. */
export interface BlobCallContext {
  /** The entity type, or `"<stream>.event"` / `"<stream>.snapshot"`. */
  readonly entityType: string
  /** The stored attribute name. */
  readonly attribute: string
  /** The operation, e.g. `"Entity.put"`, `"get.offload"`. */
  readonly operation: string
  /** The DynamoDB write committed; only reading its result back failed (design §6.13). */
  readonly committed?: boolean | undefined
}

/** Span attribute names of a store call. */
export const BlobSpanAttributes = {
  store: "effect_dynamodb.blob.store",
  action: "effect_dynamodb.blob.action",
  target: "effect_dynamodb.target",
  attribute: "effect_dynamodb.blob.attribute",
  key: "effect_dynamodb.blob.key",
  version: "effect_dynamodb.blob.version",
  refs: "effect_dynamodb.blob.refs",
} as const

/** The span name of a store call: `effect-dynamodb.BlobStore.<action>`. */
export const blobSpanName = (action: BlobStoreAction): string =>
  `effect-dynamodb.BlobStore.${action}`

const REASONS: ReadonlySet<BlobStoreReason> = new Set<BlobStoreReason>([
  "NotProvided",
  "Unversioned",
  "NotFound",
  "AccessDenied",
  "Throttled",
  "ChecksumMismatch",
  "TooLarge",
  "SourceFailed",
  "Expired",
  "Unsupported",
  "Unavailable",
  "Rejected",
])

/** A `BlobStoreError` of `ctx`. */
export const blobError = (
  ctx: BlobCallContext,
  action: BlobStoreAction,
  reason: BlobStoreReason,
  ref: BlobRef | undefined,
  cause: unknown,
): BlobStoreError =>
  new BlobStoreError({
    entityType: ctx.entityType,
    attribute: ctx.attribute,
    operation: ctx.operation,
    action,
    reason,
    ref,
    committed: ctx.committed === true,
    cause,
  })

/**
 * Wrap what a store failed with. A store that breaks the contract and fails
 * with something other than a `BlobStoreFailure` is reported as `Rejected`,
 * with what it failed with as the cause.
 */
export const fromFailure =
  (ctx: BlobCallContext, action: BlobStoreAction, ref: BlobRef | undefined) =>
  (failure: unknown): BlobStoreError => {
    const reason = (failure as { readonly reason?: unknown } | null)?.reason
    const failedRef = (failure as { readonly ref?: BlobRef | undefined } | null)?.ref
    return blobError(
      ctx,
      action,
      typeof reason === "string" && REASONS.has(reason as BlobStoreReason)
        ? (reason as BlobStoreReason)
        : "Rejected",
      ref ?? failedRef,
      failure,
    )
  }

const spanAttributes = (
  store: BlobStoreService,
  action: BlobStoreAction,
  ctx: BlobCallContext,
  key: string | undefined,
  ref: BlobRef | undefined,
): Record<string, unknown> => ({
  [BlobSpanAttributes.store]: store.name,
  [BlobSpanAttributes.action]: action,
  [BlobSpanAttributes.target]: ctx.entityType,
  [BlobSpanAttributes.attribute]: ctx.attribute,
  ...((key ?? ref?.key) !== undefined && { [BlobSpanAttributes.key]: key ?? ref?.key }),
  ...(ref !== undefined && ref.version !== "" && { [BlobSpanAttributes.version]: ref.version }),
})

/**
 * Run one store call as the span of `action`, its failure wrapped. `key` /
 * `ref` name the object for the span and the error.
 */
export const call = <A>(
  store: BlobStoreService,
  action: BlobStoreAction,
  ctx: BlobCallContext,
  target: { readonly key?: string | undefined; readonly ref?: BlobRef | undefined },
  effect: () => Effect.Effect<A, unknown>,
): Effect.Effect<A, BlobStoreError> =>
  Effect.suspend(effect).pipe(
    Effect.mapError(fromFailure(ctx, action, target.ref)),
    Effect.withSpan(blobSpanName(action), {
      kind: "client",
      attributes: spanAttributes(store, action, ctx, target.key, target.ref),
    }),
  )

/** {@link call} for a call that streams (a `get`). */
export const callStream = <A>(
  store: BlobStoreService,
  action: BlobStoreAction,
  ctx: BlobCallContext,
  ref: BlobRef,
  stream: () => Stream.Stream<A, unknown>,
): Stream.Stream<A, BlobStoreError> =>
  Stream.suspend(stream).pipe(
    Stream.mapError(fromFailure(ctx, action, ref)),
    Stream.withSpan(blobSpanName(action), {
      kind: "client",
      attributes: spanAttributes(store, action, ctx, undefined, ref),
    }),
  )

/** The key of a ref in maps: key and version, separated by U+0000 (in neither). */
export const refKey = (ref: BlobRef): string => `${ref.key}\u0000${ref.version}`

/**
 * A `BlobStoreError` that refused one of a multi-request write's requests (an
 * upload over the store's `maxUploadAge`, design §6.1), saying what the write
 * had already committed before it — a batch's earlier chunks, an aggregate's
 * earlier sub-aggregate groups — as every other mid-write failure does. Any
 * other error unchanged.
 */
export const expiredWithCommitted = <E>(error: E, committed: string): E =>
  error instanceof BlobStoreError && error.reason === "Expired"
    ? (new BlobStoreError({
        entityType: error.entityType,
        attribute: error.attribute,
        operation: error.operation,
        action: error.action,
        reason: error.reason,
        ref: error.ref,
        committed: error.committed,
        cause: `${String(error.cause)} by that request; ${committed}`,
      }) as E)
    : error
