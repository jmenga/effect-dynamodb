/**
 * @internal Type-level helpers for the trailing offload state every read
 * builder carries (#179, design §9.2): how `.offloaded(m)`, `select` and
 * `returnValues` re-type a builder's result, and the blob errors its
 * terminals carry.
 *
 * Every helper is the identity for a builder over a member that offloads
 * nothing (`NoOffloadState`): its result and error types are exactly what
 * they were before offloading existed. Type-erased fields (`any`) read as
 * none, as `ReadBlobErrors<any, M>` does.
 *
 * Not part of the public API.
 */

import type { OffloadFields } from "@effect-dynamodb/schema/DynamoModel.js"
import type { BlobStoreError } from "@effect-dynamodb/schema/Errors.js"
import type {
  DefaultOffloadModes,
  OffloadMode,
  ReadBlobErrors,
  ResolvedOffloadModes,
} from "@effect-dynamodb/schema/internal/EntityTypes.js"
import type {
  NoOffloadState,
  OffloadModes,
  OffloadState,
  ResolveModes,
  View,
  ViewOf,
} from "../Offload.js"

/** True iff the member a state describes offloads a field. */
export type Offloads<O extends OffloadState> = [
  O["fields"]["overflow"] | O["fields"]["binary"],
] extends [never]
  ? false
  : true

/**
 * The state of a builder over a member with offloaded fields `T`, reading
 * `Item` in modes `M` — `NoOffloadState` for a member that offloads nothing.
 */
export type StateOf<
  T extends OffloadFields,
  Item,
  M extends ResolvedOffloadModes = DefaultOffloadModes,
> = 0 extends 1 & T
  ? NoOffloadState
  : [T["overflow"] | T["binary"]] extends [never]
    ? NoOffloadState
    : { readonly fields: T; readonly modes: M; readonly item: Item }

/** `O` reading `Item` instead (a `select`, an update's `returnValues`). */
export type WithItem<O extends OffloadState, Item> =
  Offloads<O> extends true
    ? { readonly fields: O["fields"]; readonly modes: O["modes"]; readonly item: Item }
    : O

/** `O` after `.offloaded(m)`. */
export type WithModes<O extends OffloadState, M extends OffloadMode | OffloadModes> =
  Offloads<O> extends true
    ? O extends { readonly members: infer Ms }
      ? {
          readonly fields: O["fields"]
          readonly modes: ResolveModes<M, O["modes"]>
          readonly item: O["item"]
          readonly members: Ms
        }
      : {
          readonly fields: O["fields"]
          readonly modes: ResolveModes<M, O["modes"]>
          readonly item: O["item"]
        }
    : O

/** One member of a grouped collection query: its offloaded fields, record and entity type. */
export interface MemberState {
  readonly fields: OffloadFields
  readonly item: unknown
  readonly entityType: string
}

/**
 * The state of a grouped collection query (`Collection.make`'s `query`,
 * §9.2): one {@link MemberState} per member beside the union of the
 * members' offloaded fields, which its blob errors read. Its modes are the
 * query's, shared by every member.
 */
export interface MembersOffloadState extends OffloadState {
  readonly members: { readonly [K: string]: MemberState }
}

/**
 * One item of a grouped collection query in modes `M`: the member it belongs
 * to (`_entityKey`), its entity type and its record, viewed in `M`.
 */
export type MemberItem<
  Ms extends { readonly [K: string]: MemberState },
  M extends ResolvedOffloadModes,
> = {
  readonly [K in keyof Ms]: {
    readonly _entityKey: K
    readonly _entityType: Ms[K]["entityType"]
    readonly _decoded: View<Ms[K]["item"], Ms[K]["fields"], M>
  }
}[keyof Ms]

/**
 * The result a builder in state `O` returns: the view of its item — except a
 * raw projection (`Record<string, unknown>`), whose values are typed
 * `unknown` whatever the modes, and a grouped collection query, whose items
 * are each member's view.
 */
export type ReadView<O extends OffloadState> = O extends {
  readonly members: infer Ms extends { readonly [K: string]: MemberState }
}
  ? MemberItem<Ms, O["modes"]>
  : string extends keyof O["item"]
    ? O["item"]
    : ViewOf<O>

/**
 * A read's result after `.offloaded(m)`: `A` itself for a member that
 * offloads nothing, and for a builder that returns nothing (a delete without
 * `returnValues`, whose state's item is `undefined`).
 */
export type OffloadedView<A, O extends OffloadState, M extends OffloadMode | OffloadModes> =
  Offloads<O> extends true ? ([O["item"]] extends [undefined] ? A : ReadView<WithModes<O, M>>) : A

/** The blob errors a read in state `O` raises. */
export type ReadErrors<O extends OffloadState> = ReadBlobErrors<O["fields"], O["modes"]>

/**
 * A read's errors after `.offloaded(m)`: its own read errors swapped for the
 * new modes' — `E` itself for a member that offloads nothing.
 */
export type OffloadedErrors<E, O extends OffloadState, M extends OffloadMode | OffloadModes> =
  Offloads<O> extends true ? Exclude<E, BlobStoreError> | ReadErrors<WithModes<O, M>> : E

/**
 * The state of an unbound operation (`EntityGet`, `EntityPut`, …): its item
 * is the model (or a `returnValues` share of it), `record` what `asRecord` /
 * `asItem` view, `kind` whether it is a read (a get) or a write (whose errors
 * already carry `BlobStoreError`), and `base` the model and record it was
 * made over (a later `returnValues` derives from them).
 */
export interface OpOffloadState extends OffloadState {
  readonly record: unknown
  readonly kind: "read" | "write"
  readonly base: readonly [unknown, unknown]
}

/** An operation's state over a member with offloaded fields `T`. */
export type OpStateOf<
  T extends OffloadFields,
  Item,
  Rec,
  Kind extends "read" | "write",
  M extends ResolvedOffloadModes = DefaultOffloadModes,
> = 0 extends 1 & T
  ? NoOffloadState
  : [T["overflow"] | T["binary"]] extends [never]
    ? NoOffloadState
    : {
        readonly fields: T
        readonly modes: M
        readonly item: Item
        readonly record: Rec
        readonly kind: Kind
        readonly base: readonly [Item, Rec]
      }

/**
 * A delete's state over a member with offloaded fields `T`: it returns
 * nothing until `returnValues("allOld")` makes it return the `Model` it
 * deleted.
 */
export type DeleteOpStateOf<T extends OffloadFields, Model> = 0 extends 1 & T
  ? NoOffloadState
  : [T["overflow"] | T["binary"]] extends [never]
    ? NoOffloadState
    : {
        readonly fields: T
        readonly modes: DefaultOffloadModes
        readonly item: undefined
        readonly record: undefined
        readonly kind: "write"
        readonly base: readonly [Model, Model]
      }

/** An operation's state after `Entity.offloaded(m)`. */
export type OpWithModes<O extends OffloadState, M extends OffloadMode | OffloadModes> =
  Offloads<O> extends true
    ? { readonly [K in keyof O]: K extends "modes" ? ResolveModes<M, O["modes"]> : O[K] }
    : O

/** An operation's state reading `Item` / `Rec` instead (`returnValues`, a projection). */
export type OpWithItem<O extends OffloadState, Item, Rec> =
  Offloads<O> extends true
    ? {
        readonly [K in keyof O]: K extends "item" ? Item : K extends "record" ? Rec : O[K]
      }
    : O

/** The model and record an operation's state was made over. */
export type OpBase<O extends OffloadState> = O extends {
  readonly base: readonly [infer I, infer Rc]
}
  ? readonly [I, Rc]
  : readonly [O["item"], O["item"]]

/** The record view of an operation in state `O`. */
export type RecordViewOf<O extends OffloadState> = View<
  O extends { readonly record: infer R } ? R : O["item"],
  O["fields"],
  O["modes"]
>

/**
 * An operation's errors after `Entity.offloaded(m)`: a read's own read
 * errors swapped for the new modes'; a write's unchanged (they carry
 * `BlobStoreError` already). `E` itself for a member that offloads nothing.
 */
export type OpOffloadedErrors<E, O extends OffloadState, M extends OffloadMode | OffloadModes> =
  Offloads<O> extends true
    ? O extends { readonly kind: "write" }
      ? E
      : Exclude<E, BlobStoreError> | ReadErrors<OpWithModes<O, M>>
    : E

/**
 * A read builder's result type with its state `O` reading `Item`: the view
 * of `Item` — `Item` itself for a member that offloads nothing.
 */
export type ViewWith<O extends OffloadState, Item> =
  Offloads<O> extends true ? View<Item, O["fields"], O["modes"]> : Item
