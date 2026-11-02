/**
 * ZOrder — the dimensions of a Z-order sort key (#171).
 *
 * A Z-order index interleaves the bits of several model fields into one binary
 * sort key, so a query can bound any of them (`.within()`) and read a few key
 * ranges instead of a whole partition. Declare it on a secondary index's sort
 * key, one entry per dimension:
 *
 * ```ts
 * search: {
 *   name: "gsi2",
 *   pk: { field: "gsi2pk", composite: ["region"] },
 *   sk: {
 *     field: "gsi2sk",
 *     prefix: ["agencyId"],
 *     zorder: [
 *       { field: "price", min: 0, max: 5_000_000, step: 1_000 },
 *       { field: "bedrooms", min: 0, max: 15 },
 *       { field: "listedAt", from: "2024-01-01", unit: "hours", bits: 16 },
 *       "status",
 *     ],
 *   },
 * }
 * ```
 *
 * An entry names a model field, and the field's type decides which options it
 * takes ({@link DimensionFor}): a number or bigint field a range, a date field
 * a time window, a literal union its members (a bare name takes them in the
 * schema's order), a string field a byte width. `Entity.make` types each entry
 * from the model, so a misspelled field, a misspelled option or an option of
 * another kind is a compile error; at runtime it checks the options
 * (`[EDD-9087]`) and the field
 * (`[EDD-9088]`). Declaration order is interleave priority.
 *
 * This module holds the types only. The curve algebra (interleaving, range
 * planning) is internal.
 */

import type { DateTime } from "effect"

/** The ways a field's values map onto levels. */
export type DimensionKind = "int" | "float" | "dateTime" | "literals" | "string"

/** The level width of a date-time dimension. */
export type DateTimeUnit = "milliseconds" | "seconds" | "minutes" | "hours" | "days" | "weeks"

/** A literal member of a literals dimension. */
export type LiteralValue = string | number | boolean

/**
 * A dimension over a `number` or `bigint` field: `min`..`max` in steps of
 * `step` (default 1). Values below `min` or above `max` share the edge levels,
 * and the exact bound check on each read keeps results exact. A `bigint` field
 * takes integer options and is quantized in `bigint` arithmetic.
 */
export interface NumericDimension<F extends string = string> {
  readonly field: F
  readonly min: number
  readonly max: number
  readonly step?: number | undefined
}

/**
 * A dimension over a date field: `2^bits` levels of one `unit` each, starting
 * at `from`. Instants before `from` or past the last level share the edge
 * levels. The field must have a known storage format (a `DynamoModel` date
 * schema or an Effect date schema), so its order is known.
 */
export interface DateTimeDimension<F extends string = string> {
  readonly field: F
  readonly from: string | Date | DateTime.DateTime
  readonly unit: DateTimeUnit
  readonly bits: number
}

/**
 * A dimension over a literal union (or `boolean`) field, one level per member.
 * Without `values` the levels follow the schema's member order (`false`, `true`
 * for a boolean); `values` reorders them, and must list every member. Ranges
 * (`{ gte: "b" }`) mean "at or after `b` in this order". `bits` reserves room
 * for members added later: adding one keeps stored addresses valid only while
 * it fits the declared width.
 *
 * A plain `string` field takes one too, with `values` listed
 * ({@link ListedLiteralsDimension}); writing a value outside them fails. A
 * plain `number` field doesn't: it takes a range ({@link NumericDimension}),
 * whose order is the numbers' own.
 */
export interface LiteralsDimension<F extends string = string, L = LiteralValue> {
  readonly field: F
  readonly values?: ReadonlyArray<L> | undefined
  readonly bits?: number | undefined
}

/** A {@link LiteralsDimension} whose `values` are required: over a plain `string` field. */
export interface ListedLiteralsDimension<F extends string = string, L = LiteralValue>
  extends LiteralsDimension<F, L> {
  readonly values: ReadonlyArray<L>
}

/**
 * A dimension over a string field: the first `bytes` (1..16) UTF-8 bytes of
 * the value, in byte order — the order DynamoDB sorts strings in. Values
 * sharing those bytes share a level.
 */
export interface StringDimension<F extends string = string> {
  readonly field: F
  readonly bytes: number
}

/** Any dimension entry, as `Entity.make` reads it at runtime. */
export type AnyDimension =
  | string
  | NumericDimension
  | DateTimeDimension
  | LiteralsDimension
  | StringDimension

// ---------------------------------------------------------------------------
// Typing an entry from its field
// ---------------------------------------------------------------------------

type HasExtraKeys<M, P> = [Exclude<keyof M, keyof P>] extends [never] ? false : true

/** A member that is a whole primitive type (`string`, a branded `number`, …), not a literal. */
type IsWide<M> = M extends string
  ? string extends M
    ? true
    : HasExtraKeys<M, string>
  : M extends number
    ? number extends M
      ? true
      : HasExtraKeys<M, number>
    : M extends bigint
      ? bigint extends M
        ? true
        : HasExtraKeys<M, bigint>
      : M extends boolean
        ? false
        : true

/** Is `V` a union of literal members (`boolean` included)? */
type IsLiterals<V> = true extends (V extends unknown ? IsWide<V> : never) ? false : true

/**
 * The entries a dimension over field `F`, of model type `V`, takes:
 *
 * | Field type | Entry |
 * |---|---|
 * | `number` | {@link NumericDimension} |
 * | `bigint` | {@link NumericDimension} |
 * | a date (`DateTime`, `Date`) | {@link DateTimeDimension} |
 * | a string literal union | `F`, {@link LiteralsDimension} or {@link StringDimension} |
 * | a number literal union | `F`, {@link LiteralsDimension} or {@link NumericDimension} |
 * | `boolean`, or a mixed literal union | `F` or {@link LiteralsDimension} |
 * | `string` | {@link StringDimension} or {@link ListedLiteralsDimension} |
 *
 * Any other field (an object, an array) takes none. A field whose type is
 * unknown takes any entry, and `Entity.make` checks it at runtime.
 */
export type DimensionFor<F extends string, V> = unknown extends V
  ? AnyDimensionOf<F>
  : DimensionOf<F, Exclude<V, undefined | null>>

type AnyDimensionOf<F extends string> =
  | F
  | NumericDimension<F>
  | DateTimeDimension<F>
  | LiteralsDimension<F>
  | StringDimension<F>

type DimensionOf<F extends string, V> = [V] extends [never]
  ? never
  : [V] extends [DateTime.DateTime | Date]
    ? DateTimeDimension<F>
    : [V] extends [number | bigint]
      ? IsLiterals<V> extends true
        ? F | LiteralsDimension<F, V> | NumericDimension<F>
        : NumericDimension<F>
      : [V] extends [string]
        ? IsLiterals<V> extends true
          ? F | LiteralsDimension<F, V> | StringDimension<F>
          : StringDimension<F> | ListedLiteralsDimension<F, string>
        : [V] extends [LiteralValue]
          ? IsLiterals<V> extends true
            ? F | LiteralsDimension<F, V>
            : never
          : never

/**
 * The dimension entries of a model with fields `TFields` (field name → model
 * type): for each field, the entries its type takes ({@link DimensionFor}).
 */
export type Dimension<TFields = Record<string, unknown>> = {
  readonly [F in keyof TFields & string]-?: DimensionFor<F, TFields[F]>
}[keyof TFields & string]

/**
 * A sort-key prefix composite: matched exactly, in front of the address. A
 * bare name is stored length-prefixed; `{ field, hash: n }` stores the first
 * `n` bytes (1..8) of its FNV-1a-64 hash, which keeps long values short.
 */
export type PrefixPart<F extends string = string> = F | { readonly field: F; readonly hash: number }

/**
 * @internal A dimension's declaration as plain data, resolved against its
 * field — what the stored layout depends on, for fingerprints and `explain`.
 */
export type DimensionSpec =
  | {
      readonly kind: "int" | "float"
      readonly field: string
      readonly min: number
      readonly max: number
      readonly step: number
      readonly bits: number
    }
  | {
      readonly kind: "dateTime"
      readonly field: string
      /** `from` as an ISO instant. */
      readonly from: string
      readonly fromMs: number
      readonly unit: DateTimeUnit
      readonly bits: number
    }
  | {
      readonly kind: "literals"
      readonly field: string
      readonly values: ReadonlyArray<LiteralValue>
      readonly bits: number
    }
  | {
      readonly kind: "string"
      readonly field: string
      readonly bytes: number
      readonly bits: number
    }
