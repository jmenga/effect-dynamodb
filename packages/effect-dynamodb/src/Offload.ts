/**
 * Offload — the read-side vocabulary of offloaded storage (#179): read modes,
 * the lazy forms of offloaded values, and the type-level view a read returns.
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
 *
 * See `DESIGN.md §7 "Offloaded Storage"`.
 */

import type { NoOffload, OffloadFields } from "@effect-dynamodb/schema/DynamoModel.js"
import type {
  DefaultOffloadModes,
  OffloadMode,
  ResolvedOffloadModes,
} from "@effect-dynamodb/schema/internal/EntityTypes.js"
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
export type { ByteRange } from "./internal/BlobStoreContract.js"
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
 * offloads nothing, exactly `A`.
 */
export type View<
  A,
  T extends OffloadFields,
  M extends ResolvedOffloadModes = DefaultOffloadModes,
> = [T["overflow"] | T["binary"]] extends [never]
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
