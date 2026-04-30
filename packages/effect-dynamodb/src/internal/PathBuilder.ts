/**
 * @internal PathBuilder — Type-safe path proxy for DynamoDB expressions.
 *
 * Creates a recursive Proxy that tracks attribute path segments for use in
 * condition, filter, update, and projection expressions.
 */

// ---------------------------------------------------------------------------
// Path interface — a resolved attribute path with phantom types
// ---------------------------------------------------------------------------

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
  readonly [K in keyof Model]-?: NonNullable<Model[K]> extends ReadonlyArray<infer E>
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

/** Check if a value is a Path */
export const isPath = (value: unknown): value is Path =>
  typeof value === "object" && value !== null && PathTag in value

/**
 * Create a PathBuilder proxy that tracks attribute path segments.
 *
 * @param segments - Initial segments (default: [])
 * @param resolveDbName - Optional function to resolve domain names to DynamoDB
 *   attribute names. Segments containing `#` are treated as raw literal
 *   attribute names and bypass `resolveDbName` (this is how sparse-map entry
 *   segments survive through compilation as a single placeholder).
 * @param sparseFields - Optional map of sparse-map field names to their
 *   prefix configuration. When the proxy walks into a sparse field at the
 *   first level, the next access is expected to be `.entry(key)`, which
 *   produces a literal `<prefix>#<key>` segment.
 */
export const createPathBuilder = <Model>(
  segments: ReadonlyArray<string | number> = [],
  resolveDbName?: (name: string) => string,
  sparseFields?: globalThis.Record<string, { readonly prefix: string }>,
): PathBuilder<Model, Model> => {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === PathTag) return PathTag
      if (prop === "_tag") return "Path"
      if (prop === "segments") return segments
      if (prop === "_Root" || prop === "_Value") return undefined
      if (prop === "size") {
        return () => ({
          _tag: "size" as const,
          _Root: undefined,
          segments,
        })
      }
      if (prop === "at") {
        return (index: number) =>
          createPathBuilder([...segments, index], resolveDbName, sparseFields)
      }
      if (prop === "entry") {
        // The previous segment must be a top-level field name marked sparse.
        // We look up its prefix and bake the segment as `<prefix>#<key>`.
        const last = segments[segments.length - 1]
        if (
          typeof last !== "string" ||
          !sparseFields ||
          !(last in sparseFields)
        ) {
          // No-op for non-sparse fields — return a function that throws so
          // misuse is loud and clear.
          return (_key: string) => {
            throw new Error(
              `PathBuilder.entry: field "${String(last)}" is not configured as a sparse map`,
            )
          }
        }
        const prefix = sparseFields[last]!.prefix
        return (key: string) => {
          if (typeof key !== "string" || key.length === 0) {
            throw new Error(`PathBuilder.entry: key must be a non-empty string`)
          }
          if (key.includes("#")) {
            throw new Error(
              `PathBuilder.entry: key "${key}" must not contain '#'`,
            )
          }
          // Drop the parent field segment and replace with the flattened
          // `<prefix>#<key>` literal segment. Subsequent property accesses
          // (e.g. `.views` on a struct bucket) chain normally and compile to
          // dotted nested-Map paths.
          const newSegments = [...segments.slice(0, -1), `${prefix}#${key}`]
          return createPathBuilder(newSegments, resolveDbName, sparseFields)
        }
      }
      // Pipe/iterator/Symbol access — return undefined to avoid interference
      if (typeof prop === "symbol") return undefined
      if (prop === "pipe" || prop === "toJSON" || prop === "then") return undefined
      if (typeof prop === "string") {
        return createPathBuilder([...segments, prop], resolveDbName, sparseFields)
      }
      return undefined
    },
    has(_target, prop) {
      return prop === PathTag || prop === "_tag" || prop === "segments"
    },
  }
  return new Proxy({} as any, handler) as PathBuilder<Model, Model>
}

// ---------------------------------------------------------------------------
// compilePath — shared path→DynamoDB expression name compilation
// ---------------------------------------------------------------------------

/**
 * Compile path segments into DynamoDB ExpressionAttributeNames placeholders.
 *
 * @param segments - The path segments (e.g., ["address", "city"])
 * @param names - Mutable names map to populate
 * @param prefix - Placeholder prefix (e.g., "p" for paths, "e" for expressions)
 * @param counter - Mutable counter object for unique placeholder generation
 * @param resolveDbName - Optional function to resolve domain names to DynamoDB
 *   attribute names. **Segments containing `#` bypass `resolveDbName`** —
 *   they are already literal DynamoDB attribute names (used by sparse-map
 *   entry segments shaped `<prefix>#<key>`).
 * @returns The expression path string (e.g., "#p0.#p1" or "#p0[2].#p1")
 */
export const compilePath = (
  segments: ReadonlyArray<string | number>,
  names: globalThis.Record<string, string>,
  prefix: string,
  counter: { value: number },
  resolveDbName?: (name: string) => string,
): string => {
  const parts: Array<string> = []
  for (const seg of segments) {
    if (typeof seg === "number") {
      // Array index — append directly to previous part
      parts.push(`[${seg}]`)
    } else {
      const key = `#${prefix}${counter.value++}`
      // Segments containing `#` are literal attribute names (sparse-map
      // entry: `<prefix>#<key>`). They are emitted as-is — `resolveDbName`
      // is never invoked because the segment was generated by the library,
      // not by user-provided field references.
      names[key] = seg.includes("#") ? seg : resolveDbName ? resolveDbName(seg) : seg
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
export type PathKeys<P> = P extends Path<any, any, infer K> ? K : never
