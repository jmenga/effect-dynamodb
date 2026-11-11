/**
 * @internal A sparse map's entries, as its writer and its reader take them: each entry is stored
 * in an attribute of its own, named `<prefix>#<key>`.
 *
 * Every write of an entry runs {@link validateSparseKey}. Everything that decides which stored
 * attributes belong to a sparse map (the row's reader, `clearMap`, `removeEntries`, a key attribute
 * the map could name) asks {@link sparseReader}.
 */

/**
 * Validate a sparse-map key at write time.
 *
 * Rules:
 *  - Must be a string (we don't silently coerce).
 *  - Must be non-empty.
 *  - Must not contain `#` — `#` is reserved as the prefix/key delimiter.
 *  - The composed `<prefix>#<key>` must be 1–255 bytes. DynamoDB takes an attribute name of up to
 *    64 KB, and 255 bytes only for an index key or an attribute an index projects by name; this
 *    is the library's own limit on an entry's name.
 *
 * Throws on violation. Caller is expected to translate into a tagged
 * `ValidationError` at the entity boundary.
 */
export const validateSparseKey = (field: string, prefix: string, key: string): void => {
  if (typeof key !== "string") {
    throw new Error(`Sparse map "${field}": key must be a string, got ${typeof key}`)
  }
  if (key.length === 0) {
    throw new Error(`Sparse map "${field}": key must be non-empty`)
  }
  if (key.includes("#")) {
    throw new Error(
      `Sparse map "${field}": key "${key}" must not contain '#' — the library does not silently escape`,
    )
  }
  const attrName = `${prefix}#${key}`
  const byteLen = new TextEncoder().encode(attrName).length
  if (byteLen < 1 || byteLen > 255) {
    throw new Error(
      `Sparse map "${field}": composed attribute name "${attrName}" is ${byteLen} bytes (must be 1–255)`,
    )
  }
}

/** Why the sparse map's writer refuses `key` as an entry key ({@link validateSparseKey}), if it does. */
export const sparseKeyRefusal = (
  field: string,
  prefix: string,
  key: string,
): string | undefined => {
  try {
    validateSparseKey(field, prefix, key)
    return undefined
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** A stored attribute read as a sparse map's entry ({@link sparseReader}). */
export type SparseEntry = {
  /** The sparse map's field. */
  readonly field: string
  readonly prefix: string
  /** The attribute after `<prefix>#`: never empty. It may be a key the writer refuses. */
  readonly key: string
}

/**
 * Which stored attributes are sparse map entries, as the reader reads a row: an attribute is an
 * entry of the field whose `<prefix>#` begins it, the longest such prefix winning, when something
 * follows that `#`; the rest is the entry's key. `<prefix>#` itself is no entry (the writer never
 * writes an empty key). `fields` lists the sparse fields in reading order.
 */
export const sparseReader = (
  sparseFields: Readonly<Record<string, { readonly prefix: string }>>,
): {
  readonly fields: ReadonlyArray<string>
  readonly entryOf: (attribute: string) => SparseEntry | undefined
} => {
  const order = Object.entries(sparseFields)
    .map(([field, { prefix }]) => ({ field, prefix, start: `${prefix}#` }))
    .sort((a, b) => b.start.length - a.start.length)
  return {
    fields: order.map(({ field }) => field),
    entryOf: (attribute) => {
      const match = order.find(({ start }) => attribute.startsWith(start))
      if (match === undefined || attribute.length === match.start.length) return undefined
      return { field: match.field, prefix: match.prefix, key: attribute.slice(match.start.length) }
    },
  }
}
