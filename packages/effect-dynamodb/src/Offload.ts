/**
 * Offload — the vocabulary of offloaded storage (#179): read modes, the lazy
 * forms of offloaded values, the type-level view a read returns, and what a
 * binary field takes on a write.
 *
 * - **Read modes.** An overflow field (`DynamoModel.Packed({ external })`) is
 *   read `"eager"` by default — its domain value, resolved from the store; a
 *   binary field (`DynamoModel.External()`) `"lazy"` — a {@link BlobHandle}.
 *   `.offloaded(mode)` on a read chooses per kind ({@link OffloadModes}).
 * - **Lazy values.** {@link OffloadedValue} (overflow) and {@link BlobHandle}
 *   (binary) carry the ref, size and content checksum, and read on demand
 *   with `R = never`.
 * - **{@link View}** is the type of a read's result: the model with each
 *   offloaded field typed by its mode. For a member that offloads nothing it
 *   is the model itself.
 * - **Binary inputs.** A binary field takes a {@link BinaryInput} on a write:
 *   its bytes, a `Stream` of them (single-use: one target object, run once),
 *   a {@link BlobHandle} (content to copy into a new version) or
 *   {@link source}`(bytes | stream, { contentType, contentLength })`.
 * - **{@link layerObserver}** reports every upload the library could not
 *   settle (an unknown DynamoDB outcome, a failed rollback delete, a lost
 *   multipart completion), so the application can queue the item for
 *   `gc.sweep`.
 *
 * See `DESIGN.md §7 "Offloaded Storage"`.
 */

import type { NoOffload, OffloadFields } from "@effect-dynamodb/schema/DynamoModel.js"
import type {
  DefaultOffloadModes,
  OffloadMode,
  ResolvedOffloadModes,
} from "@effect-dynamodb/schema/internal/EntityTypes.js"
import type { Layer } from "effect"
import { layerObserver as makeObserverLayer, type ObserverOptions } from "./internal/BlobLedger.js"
import type { BlobHandle, OffloadedValue } from "./internal/OffloadValues.js"

export type {
  ExternalConfig,
  ExternalPackedConfig,
  ExtractOffloadFields,
  NoOffload,
  OffloadFields,
} from "@effect-dynamodb/schema/DynamoModel.js"
export type { BlobChecksum, BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
export type {
  DefaultOffloadModes,
  OffloadMode,
  OpBlobErrors,
  ReadBlobErrors,
  ResolvedOffloadModes,
  WriteBlobErrors,
} from "@effect-dynamodb/schema/internal/EntityTypes.js"
export type {
  ObserverOptions,
  UnsettledReason,
  UnsettledUpload,
} from "./internal/BlobLedger.js"
export type { ByteRange } from "./internal/BlobStoreContract.js"
export type { BinaryInput, BlobSource, BlobSourceOptions } from "./internal/OffloadInput.js"
export { BlobSourceTypeId, isBlobSource, source } from "./internal/OffloadInput.js"
export type { BlobHandle, OffloadedValue, OffloadLocation } from "./internal/OffloadValues.js"
export {
  BlobHandleTypeId,
  isBlobHandle,
  isOffloadedValue,
  OffloadedValueTypeId,
} from "./internal/OffloadValues.js"

/**
 * The read modes `.offloaded(...)` takes per kind: a string sets both kinds,
 * an object the kinds it names.
 */
export interface OffloadModes {
  readonly overflow?: OffloadMode | undefined
  readonly binary?: OffloadMode | undefined
}

/**
 * One kind's mode: `V` (the argument's property) when it is surely a mode,
 * `Base` when it is surely absent, and the union of the two when it may be
 * either (an optional property, a widened `OffloadModes`) — so a view or an
 * error union over the result never under-reports.
 */
type ResolveKind<V, Base extends OffloadMode> = [V] extends [OffloadMode]
  ? V
  : Extract<V, OffloadMode> | Base

/**
 * The {@link ResolvedOffloadModes} of `M` over `Base` (the modes in effect
 * before it; default {@link DefaultOffloadModes}): a string sets both kinds,
 * an object overrides the kinds it names. A kind the object may or may not
 * set (an optional property, `OffloadModes` itself) resolves to its mode or
 * `Base`'s, which `View` types as either form and `ReadBlobErrors` counts as
 * eager.
 */
export type ResolveModes<
  M extends OffloadMode | OffloadModes,
  Base extends ResolvedOffloadModes = DefaultOffloadModes,
> = M extends OffloadMode
  ? { readonly overflow: M; readonly binary: M }
  : M extends OffloadModes
    ? {
        readonly overflow: ResolveKind<M["overflow"], Base["overflow"]>
        readonly binary: ResolveKind<M["binary"], Base["binary"]>
      }
    : never

/** A lazily read value's type: `null` / `undefined` members stay as they are. */
export type Lazy<V, H> = V extends null | undefined ? V : H

/**
 * One field's type under mode `Mode`: the value when eager, the handle when
 * lazy, either when the mode is not a single literal.
 */
type ByMode<V, H, Mode> = [Mode] extends ["eager"]
  ? V
  : [Mode] extends ["lazy"]
    ? Lazy<V, H>
    : V | Lazy<V, H>

/**
 * A read's result type: `A` with each offloaded field of `T` typed by the
 * modes `M` — an eager field its value, a lazy overflow field
 * `OffloadedValue<value>`, a lazy binary field `BlobHandle`. Optional and
 * nullable fields keep their `undefined` / `null`. For a member that
 * offloads nothing — and for `T = any` (type-erased code, as `ReadBlobErrors`
 * reads it) — exactly `A`.
 */
export type View<
  A,
  T extends OffloadFields,
  M extends ResolvedOffloadModes = DefaultOffloadModes,
> = 0 extends 1 & T
  ? A
  : [T["overflow"] | T["binary"]] extends [never]
    ? A
    : {
        readonly [K in keyof A]: K extends T["overflow"]
          ? ByMode<A[K], OffloadedValue<NonNullable<A[K]>>, M["overflow"]>
          : K extends T["binary"]
            ? ByMode<A[K], BlobHandle, M["binary"]>
            : A[K]
      }

/**
 * What a builder needs to re-type its result under other modes: the
 * member's offloaded fields, the builder's effective modes, and the pre-view
 * item (the model, a record, a selected partial, an update's return).
 */
export interface OffloadState {
  readonly fields: OffloadFields
  readonly modes: ResolvedOffloadModes
  readonly item: unknown
}

/** The state of a builder over a member that offloads nothing. */
export type NoOffloadState = {
  readonly fields: NoOffload
  readonly modes: DefaultOffloadModes
  readonly item: never
}

/** The result type a builder in state `O` returns. */
export type ViewOf<O extends OffloadState> = View<O["item"], O["fields"], O["modes"]>

/**
 * Report every upload the library could not settle — for everything run
 * under this layer, and for every client bound (`DynamoClient.make`,
 * `EventStore.bind`, …) while it was in context.
 *
 * A write uploads its offloaded values before it reaches DynamoDB, and keeps
 * a version only when DynamoDB committed the write, or may have. The
 * library deletes a version only when DynamoDB provably did not commit the
 * write; the rest it cannot settle, and reports here once the operation
 * exits:
 *
 * - `inDoubt` — the write's outcome is unknown (a timeout, an
 *   `InternalServerError`, an interruption while it was in flight, a refusal
 *   after an SDK retry): the version is kept;
 * - `rollbackFailed` — DynamoDB rejected the write but the delete of its
 *   version failed: the version is left behind;
 * - `completeLost` — a multipart upload completed but its response was lost:
 *   the version it made has no pointer;
 * - `answerRefused` — the store's answer to an upload broke the `BlobStore`
 *   contract (no ref, a ref outside the requested key, a ref it had already
 *   returned) and was refused: the version it wrote, if any, has no pointer.
 *
 * Each is also logged at `Warning`. Queue the item (`rowKey`) for `gc.sweep`;
 * `gc.sweepStore` finds what no process could report. A failing observer is
 * logged and never changes the operation's result. Off by default.
 *
 * @example
 * ```ts
 * // `enqueueSweep` is the application's own: e.g. a queue a sweeper drains.
 * const AppLayer = Layer.mergeAll(
 *   DynamoClient.layer({ region: "eu-west-1" }),
 *   BlobStore.layer(store),
 *   Offload.layerObserver({
 *     onUnsettled: (upload) => enqueueSweep({ table: upload.table, key: upload.rowKey }),
 *   }),
 * )
 * ```
 */
export const layerObserver: (options: ObserverOptions) => Layer.Layer<never> = makeObserverLayer
