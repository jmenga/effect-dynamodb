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
// PathBuilder — recursive mapped type that creates typed path accessors
// ---------------------------------------------------------------------------

/**
 * A recursive mapped type that provides type-safe path access to model attributes.
 * Each property access returns either:
 * - `Path<Root, V>` for leaf values (string, number, boolean, etc.)
 * - `PathBuilder<Root, V> & Path<Root, V>` for nested objects
 * - `ArrayPath<Root, E>` for arrays
 */
export type PathBuilder<Root, Model, Keys extends ReadonlyArray<string | number> = []> = {
  readonly [K in keyof Model]-?: NonNullable<Model[K]> extends ReadonlyArray<infer E>
    ? ArrayPath<Root, E, [...Keys, K & string]>
    : NonNullable<Model[K]> extends globalThis.Record<string, any>
      ? PathBuilder<Root, NonNullable<Model[K]>, [...Keys, K & string]> &
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
 * @param resolveDbName - Optional function to resolve domain names to DynamoDB attribute names
 */
export const createPathBuilder = <Model>(
  segments: ReadonlyArray<string | number> = [],
  resolveDbName?: (name: string) => string,
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
        return (index: number) => createPathBuilder([...segments, index], resolveDbName)
      }
      // Pipe/iterator/Symbol access — return undefined to avoid interference
      if (typeof prop === "symbol") return undefined
      if (prop === "pipe" || prop === "toJSON" || prop === "then") return undefined
      if (typeof prop === "string") {
        return createPathBuilder([...segments, prop], resolveDbName)
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
 * @param resolveDbName - Optional function to resolve domain names to DynamoDB attribute names
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
      names[key] = resolveDbName ? resolveDbName(seg) : seg
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
