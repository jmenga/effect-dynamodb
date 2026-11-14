/**
 * @internal PathBuilder — Type-safe path proxy for DynamoDB expressions.
 *
 * Creates a recursive Proxy that tracks attribute path segments for use in
 * condition, filter, update, and projection expressions.
 */

// ---------------------------------------------------------------------------
// Path interface — a resolved attribute path with phantom types
// ---------------------------------------------------------------------------

import { getSparseFields } from "@effect-dynamodb/schema/DynamoModel.js"

export const PathTag: unique symbol = Symbol.for("effect-dynamodb/Path")
export type PathTag = typeof PathTag

/**
 * A resolved attribute path tracking segments from root to leaf.
 * Phantom types ensure type safety in expression builders.
 *
 * @typeParam Root - The root model type
 * @typeParam Value - The value type at this path
 * @typeParam Keys - Tuple of path segments
 */
export interface Path<
  Root = unknown,
  Value = unknown,
  Keys extends ReadonlyArray<string | number> = ReadonlyArray<string | number>,
> {
  readonly [PathTag]: PathTag
  readonly segments: ReadonlyArray<string | number>
  /** Phantom */ readonly _Root: (_: never) => Root
  /** Phantom */ readonly _Value: (_: never) => Value
  /** Phantom */ readonly _Keys: (_: never) => Keys
  /** Return a size operand for this path */
  readonly size: () => SizeOperand<Root>
}

/**
 * A size() operand — represents the size of the attribute at the given path.
 */
export interface SizeOperand<Root = unknown> {
  readonly _tag: "size"
  readonly segments: ReadonlyArray<string | number>
  /** Phantom */ readonly _Root: (_: never) => Root
}

// ---------------------------------------------------------------------------
// ArrayPath — Path for array/list attributes with .at(n) accessor
// ---------------------------------------------------------------------------

export interface ArrayPath<
  Root,
  Element,
  Keys extends ReadonlyArray<string | number> = ReadonlyArray<string | number>,
> extends Path<Root, ReadonlyArray<Element>, Keys> {
  readonly at: (
    index: number,
  ) => NonNullable<Element> extends globalThis.Record<string, any>
    ? PathBuilder<Root, NonNullable<Element>> & Path<Root, NonNullable<Element>>
    : Path<Root, NonNullable<Element>>
}

// ---------------------------------------------------------------------------
// SparsePath — Path for sparse-map (Record) attributes with .entry(key) accessor
// ---------------------------------------------------------------------------

/**
 * Path produced by a sparse-map field. Carries `.entry(key)` to address an
 * individual bucket. Each entry is stored as a top-level DynamoDB attribute
 * named `<prefix>#<key>`, so the resulting path is a single literal segment
 * (the bucket attribute itself), with optional further property access for
 * struct-valued buckets.
 */
export interface SparsePath<
  Root,
  Value,
  Keys extends ReadonlyArray<string | number> = ReadonlyArray<string | number>,
> extends Path<Root, globalThis.Record<string, Value>, Keys> {
  readonly entry: (
    key: string,
  ) => NonNullable<Value> extends globalThis.Record<string, any>
    ? PathBuilder<Root, NonNullable<Value>> & Path<Root, NonNullable<Value>>
    : Path<Root, NonNullable<Value>>
}

// ---------------------------------------------------------------------------
// PackedPath — Path for a packed attribute (`storedAs: DynamoModel.Packed`)
// ---------------------------------------------------------------------------

export const PackedPathTag: unique symbol = Symbol.for("effect-dynamodb/PackedPath")
export type PackedPathTag = typeof PackedPathTag

/**
 * Path to a field stored packed (`storedAs: DynamoModel.Packed(...)`). DynamoDB
 * holds the field as one opaque JSON string or compressed binary value, so the
 * path has no property, `.at`, `.entry` or `.size` accessors and is **not** a
 * {@link Path}: comparisons, `size`, `contains`, `beginsWith` and path update
 * operations reject it at compile time. It is accepted by `exists` /
 * `notExists` and by projections, which address the field as a whole.
 */
export interface PackedPath<
  Root = unknown,
  Value = unknown,
  Keys extends ReadonlyArray<string | number> = ReadonlyArray<string | number>,
> {
  readonly [PathTag]: PathTag
  readonly [PackedPathTag]: PackedPathTag
  readonly segments: ReadonlyArray<string | number>
  /** Phantom */ readonly _Root: (_: never) => Root
  /** Phantom */ readonly _Value: (_: never) => Value
  /** Phantom */ readonly _Keys: (_: never) => Keys
}

declare const PackedValueTag: unique symbol

/**
 * @internal Marker a path model ({@link PathModel}) puts on a packed field so
 * the {@link PathBuilder} produces a {@link PackedPath} for it.
 */
export interface PackedValue<V> {
  readonly [PackedValueTag]: (_: never) => V
}

/**
 * The model a path builder walks for an entity with packed fields `P`: each
 * packed top-level field is marked {@link PackedValue}. `Model` unchanged when
 * there are none.
 */
export type PathModel<Model, P extends PropertyKey> = [P] extends [never]
  ? Model
  : unknown extends Model
    ? Model
    : {
        [K in keyof Model]: K extends P
          ? // An `any` field would swallow the marker (`PackedValue<any> | any`
            // is `any`): mark it whole.
            0 extends 1 & Model[K]
            ? PackedValue<any>
            : PackedValue<NonNullable<Model[K]>> | Extract<Model[K], null | undefined>
          : Model[K]
      }

/**
 * `[V]` for a packed field's {@link PackedValue}`<V>` marker, `false` for any
 * other field type. Guarded so it never matches by accident: `any` would
 * distribute over the check (yielding `PackedPath | …` for every `any` field,
 * which then fails every comparison) and `never` extends everything — both
 * fall through to the ordinary, pre-#147 mapping. (`false`, not `never`, for
 * "not packed": `never` would itself satisfy `extends [infer V]`.)
 */
type PackedValueOf<T> = 0 extends 1 & T
  ? false
  : [NonNullable<T>] extends [never]
    ? false
    : [NonNullable<T>] extends [PackedValue<infer V>]
      ? [V]
      : false

// ---------------------------------------------------------------------------
// PathBuilder — recursive mapped type that creates typed path accessors
// ---------------------------------------------------------------------------

/**
 * A recursive mapped type that provides type-safe path access to model attributes.
 * Each property access returns either:
 * - `Path<Root, V>` for leaf values (string, number, boolean, etc.)
 * - `PathBuilder<Root, V> & Path<Root, V>` for nested objects
 * - `ArrayPath<Root, E>` for arrays
 *
 * Sparse-map fields (`storedAs: 'sparse'`) produce a `SparsePath<Root, V>`
 * with `.entry(key)` accessor.
 */
export type PathBuilder<Root, Model, Keys extends ReadonlyArray<string | number> = []> = {
  readonly [K in keyof Model]-?: PackedValueOf<Model[K]> extends [infer PV]
    ? PackedPath<Root, PV, [...Keys, K & string]>
    : NonNullable<Model[K]> extends ReadonlyArray<infer E>
      ? ArrayPath<Root, E, [...Keys, K & string]>
      : NonNullable<Model[K]> extends globalThis.Record<infer KK, infer V>
        ? string extends KK
          ? // String-indexed Record — treat as a sparse-map candidate. The
            // runtime decides whether `.entry()` is actually wired (driven by
            // the sparseFields map). For non-sparse Records, callers won't
            // typically reach for `.entry`; for sparse ones, `.entry` is the
            // expected entry point.
            SparsePath<Root, V, [...Keys, K & string]>
          : PathBuilder<Root, NonNullable<Model[K]>, [...Keys, K & string]> &
              Path<Root, NonNullable<Model[K]>, [...Keys, K & string]>
        : Path<Root, NonNullable<Model[K]>, [...Keys, K & string]>
}

// ---------------------------------------------------------------------------
// Runtime: createPathBuilder — single recursive Proxy handler
// ---------------------------------------------------------------------------

/**
 * Check if a value is a Path. A path ending in `size`, `at` or `entry` is a function (it is also
 * that accessor, called), so a function is checked too.
 */
export const isPath = (value: unknown): value is Path =>
  ((typeof value === "object" && value !== null) || typeof value === "function") && PathTag in value

/** @internal A sparse map's entry, as `.entry(key)` named it: the map's field and the entry's key. */
export interface PathEntry {
  readonly field: string
  readonly key: string
}

/**
 * The paths whose first segment `.entry(key)` built (#238), by identity. The segment is the entry's
 * attribute (`<prefix>#<key>`), and a model field may carry the same name (stored elsewhere by a
 * `field:` rename): a segment the caller wrote names that field, one `.entry()` built names the
 * entry. The builder knows which it made, so the path carries it, and nothing re-derives it from
 * the spelling.
 */
const entries = new WeakMap<ReadonlyArray<string | number>, PathEntry>()

/** @internal The sparse map entry a path's first segment is, when `.entry()` built it. */
export const entryOfPath = (segments: ReadonlyArray<string | number>): PathEntry | undefined =>
  entries.get(segments)

/** @internal `segments`, marked as a path below `entry` when there is one. */
export const withEntry = (
  segments: ReadonlyArray<string | number>,
  entry: PathEntry | undefined,
): ReadonlyArray<string | number> => {
  if (entry !== undefined) entries.set(segments, entry)
  return segments
}

/**
 * Create a PathBuilder proxy that tracks attribute path segments.
 *
 * @param segments - Initial segments (default: [])
 * @param resolveDbName - Optional function to resolve domain names to DynamoDB
 *   attribute names. It names a path's first segment only (`storedPath`): a
 *   segment below it is stored under its own name. A first segment `.entry()`
 *   built is the entry's attribute (`<prefix>#<key>`), never a field's name
 *   ({@link entryOfPath}), and compiles as one placeholder.
 * @param sparseFields - Optional map of sparse-map field names to their
 *   prefix configuration. When the proxy walks into a sparse field at the
 *   first level, the next access is expected to be `.entry(key)`, which
 *   produces a literal `<prefix>#<key>` segment.
 *
 * `Keys` is the phantom "path so far" marker carried by every produced `Path`.
 * It defaults to `[]` (a builder rooted at the model). Consumers that store a
 * builder for callbacks — `BoundQueryConfig` / `BoundCrudConfig` — declare it
 * as `never` so any concrete path is assignable at the call site, so they
 * instantiate this as `createPathBuilder<Model, never>()`.
 *
 * `size`, `at` and `entry` are each two things, as the types say: the model's
 * field of that name, below this path (`t.size`, `t.box.size`), and, called,
 * the accessor on this path (`t.tags.size()`, `t.roster.at(0)`,
 * `t.zones.entry("k")`). The path below is a function, and calling it performs
 * the accessor. Through 1.41.0 each was only the accessor, so a field of that
 * name compiled to an operand with no value behind it.
 *
 * `_tag` is the model's field too (`t.box._tag`, a tagged struct's tag): a path
 * is recognised by {@link PathTag}, never by a tag. Through 1.41.0 it was the
 * text `"Path"`, so a condition on it never held.
 */
export const createPathBuilder = <Model, Keys extends ReadonlyArray<string | number> = []>(
  segments: ReadonlyArray<string | number> = [],
  resolveDbName?: (name: string) => string,
  sparseFields?: globalThis.Record<string, { readonly prefix: string }>,
): PathBuilder<Model, Model, Keys> =>
  pathProxy(segments, resolveDbName, sparseFields) as PathBuilder<Model, Model, Keys>

/** The path at `segments`; with `call`, also a function performing an accessor on its parent. */
const pathProxy = (
  segments: ReadonlyArray<string | number>,
  resolveDbName: ((name: string) => string) | undefined,
  sparseFields: globalThis.Record<string, { readonly prefix: string }> | undefined,
  call?: (arg: never) => unknown,
): object => {
  // Every path below an entry carries it (`.entry("k").x`, `.entry("k").at(0)`).
  const entry = entryOfPath(segments)
  const below = (segment: string | number, accessor?: (arg: never) => unknown) =>
    pathProxy(withEntry([...segments, segment], entry), resolveDbName, sparseFields, accessor)
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === PathTag) return PathTag
      if (prop === "segments") return segments
      if (prop === "_Root" || prop === "_Value") return undefined
      if (prop === "size") {
        return below("size", () => ({
          _tag: "size" as const,
          _Root: undefined,
          segments,
        }))
      }
      if (prop === "at") {
        return below("at", (index: number) => below(index))
      }
      if (prop === "entry") {
        return below("entry", (key: string) => {
          // The path must be a top-level field marked sparse: a sparse map is a top-level field, so
          // a nested field of the same name (`t.inner.zones`) is not it. We look up its prefix and
          // bake the segment as `<prefix>#<key>`.
          const last = segments[segments.length - 1]
          if (
            segments.length !== 1 ||
            typeof last !== "string" ||
            !sparseFields ||
            !Object.hasOwn(sparseFields, last)
          ) {
            throw new Error(
              `PathBuilder.entry: field "${segments.join(".")}" is not configured as a sparse map`,
            )
          }
          if (typeof key !== "string" || key.length === 0) {
            throw new Error(`PathBuilder.entry: key must be a non-empty string`)
          }
          if (key.includes("#")) {
            throw new Error(`PathBuilder.entry: key "${key}" must not contain '#'`)
          }
          // Drop the parent field segment and replace with the flattened
          // `<prefix>#<key>` literal segment. Subsequent property accesses
          // (e.g. `.views` on a struct bucket) chain normally and compile to
          // dotted nested-Map paths.
          const newSegments = [...segments.slice(0, -1), `${sparseFields[last]!.prefix}#${key}`]
          // A map is a top-level field, so its entry is the path's first segment: marked as one.
          return pathProxy(
            withEntry(newSegments, newSegments.length === 1 ? { field: last, key } : undefined),
            resolveDbName,
            sparseFields,
          )
        })
      }
      // Pipe/iterator/Symbol access — return undefined to avoid interference
      if (typeof prop === "symbol") return undefined
      if (prop === "pipe" || prop === "toJSON" || prop === "then") return undefined
      return below(prop)
    },
    has(_target, prop) {
      return prop === PathTag || prop === "segments"
    },
    apply(_target, _this, args) {
      return call?.(args[0] as never)
    },
  }
  // A function target only where the path is also an accessor: every other path stays an object.
  return new Proxy(call === undefined ? {} : () => undefined, handler)
}

/**
 * The sparse maps whose `.entry(key)` a path builder over `models` resolves (#238): each field a
 * model's configuration stores as a sparse map, with its prefix, by the first model declaring it
 * (a collection names each member's entry by its own prefix: `collectionNaming`). `undefined`
 * when none does. A model that isn't configured declares none.
 */
export const sparseFieldsOf = (
  models: ReadonlyArray<unknown>,
): globalThis.Record<string, { readonly prefix: string }> | undefined => {
  const sparse: globalThis.Record<string, { readonly prefix: string }> = Object.create(null)
  let any = false
  for (const model of models) {
    for (const [field, config] of Object.entries(getSparseFields(model as never))) {
      if (Object.hasOwn(sparse, field)) continue
      sparse[field] = config
      any = true
    }
  }
  return any ? sparse : undefined
}

/**
 * The path builder a callback over `models` gets (#238), on every terminal that takes one: an
 * entity's conditions, filters, selects and path operations, its query accessors, `scan()`,
 * `.history()`, `versions()` and `deleted.list()`, a collection's accessors, an aggregate's `list`
 * filter, `Transaction.check`. The one place `.entry(key)` is resolved: a sparse map of any of
 * the models ({@link sparseFieldsOf}).
 */
export const pathBuilderOf = <Model>(
  models: ReadonlyArray<unknown>,
  resolveDbName?: (name: string) => string,
): PathBuilder<Model, Model, never> =>
  createPathBuilder<Model, never>(undefined, resolveDbName, sparseFieldsOf(models))

// ---------------------------------------------------------------------------
// compilePath — shared path→DynamoDB expression name compilation
// ---------------------------------------------------------------------------

/**
 * @internal How the segments below a path's first are stored, given the whole path as written
 * (#238): an entity's own (`Entity._storedBelow`), from its model's schema, by `storedSegments`.
 */
export type StoredBelow = (
  segments: ReadonlyArray<string | number>,
) => ReadonlyArray<string | number>

/**
 * A path as it is stored: its first segment under the attribute `head` gives it, and every segment
 * below as `below` names it (as given, without one).
 *
 * A `field:` rename is a top-level attribute's name. Below it a value is stored whole, under the
 * names its own schema has: `put` stores `meta.count` as `count` whatever a top-level `count` is
 * renamed to, and a struct that renames its keys as it's stored (`Schema.encodeKeys`) stores each
 * under its stored name, which `below` gives (#238). This is the one place that says so, for an
 * update's path operations, a condition, a filter and a projection alike, so each names the
 * attribute `put` stored.
 *
 * A first segment `.entry()` built ({@link entryOfPath}) is the entry's attribute, never a field's
 * name: it stays as it is, whatever field a rename stores under another name it spells (#238).
 */
export const storedPath = (
  segments: ReadonlyArray<string | number>,
  head: (name: string) => string,
  below?: StoredBelow,
): ReadonlyArray<string | number> => {
  const entry = entryOfPath(segments)
  const [first] = segments
  if (first === undefined) return segments
  return withEntry(
    [
      typeof first === "string" && entry === undefined ? head(first) : first,
      ...(below === undefined ? segments.slice(1) : below(segments)),
    ],
    entry,
  )
}

/**
 * Compile path segments into DynamoDB ExpressionAttributeNames placeholders.
 *
 * @param segments - The path segments (e.g., ["address", "city"])
 * @param names - Mutable names map to populate
 * @param prefix - Placeholder prefix (e.g., "p" for paths, "e" for expressions)
 * @param counter - Mutable counter object for unique placeholder generation
 * @param resolveDbName - Optional function to resolve the path's top-level field to its
 *   DynamoDB attribute name ({@link storedPath}). Every first segment the caller wrote goes
 *   through it, as a filter's and a projection's do: a model field whose own name holds `#` is
 *   named by its rename. A sparse-map entry's attribute (`<prefix>#<key>`) that `.entry()` built
 *   doesn't, whatever field its name spells.
 * @param below - Optional names of the segments below the first ({@link StoredBelow}).
 * @returns The expression path string (e.g., "#p0.#p1" or "#p0[2].#p1")
 */
export const compilePath = (
  segments: ReadonlyArray<string | number>,
  names: globalThis.Record<string, string>,
  prefix: string,
  counter: { value: number },
  resolveDbName?: (name: string) => string,
  below?: StoredBelow,
): string => {
  const parts: Array<string> = []
  const stored =
    resolveDbName === undefined && below === undefined
      ? segments
      : storedPath(
          segments,
          (head) => (resolveDbName === undefined ? head : resolveDbName(head)),
          below,
        )
  for (const seg of stored) {
    if (typeof seg === "number") {
      // Array index — append directly to previous part
      parts.push(`[${seg}]`)
    } else {
      const key = `#${prefix}${counter.value++}`
      names[key] = seg
      parts.push(key)
    }
  }
  // Join parts: string placeholders with ".", array indices attach directly
  let result = ""
  for (const part of parts) {
    if (part.startsWith("[")) {
      result += part
    } else if (result === "") {
      result = part
    } else {
      result += `.${part}`
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Type utilities for projections
// ---------------------------------------------------------------------------

/** Deep pick a single path from a type */
type DeepPickOne<T, Keys extends ReadonlyArray<string | number>> = Keys extends readonly [
  infer Head extends keyof T,
  ...infer Rest extends ReadonlyArray<string | number>,
]
  ? Rest extends readonly []
    ? Pick<T, Head>
    : { readonly [K in Head]: DeepPickOne<T[Head], Rest> }
  : T

/** Convert a union to an intersection */
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never

/**
 * Deep pick from a type given an array of path tuples.
 * Used by projections to narrow return types.
 */
export type DeepPick<
  T,
  Paths extends ReadonlyArray<ReadonlyArray<string | number>>,
> = UnionToIntersection<{ [K in keyof Paths]: DeepPickOne<T, Paths[K]> }[number]>

/** Extract the Keys tuple from a Path type */
export type PathKeys<P> =
  P extends Path<any, any, infer K> ? K : P extends PackedPath<any, any, infer K> ? K : never
