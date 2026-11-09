/**
 * @internal A sparse map's entry key, as its writer takes it: each entry is stored in an attribute
 * of its own, named `<prefix>#<key>`.
 */

/**
 * Validate a sparse-map key at write time.
 *
 * Rules:
 *  - Must be a string (we don't silently coerce).
 *  - Must be non-empty.
 *  - Must not contain `#` — `#` is reserved as the prefix/key delimiter.
 *  - The composed `<prefix>#<key>` must satisfy DynamoDB's 1–255 byte
 *    attribute-name limit.
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
  // DynamoDB attribute names: 1–255 bytes. Length check is approximate (UTF-8
  // bytes vs JS code units), but `key.length + prefix.length + 1` is an upper
  // bound on byte length when both are ASCII, which is the common case.
  // For full UTF-8 correctness, encode via TextEncoder.
  const byteLen = new TextEncoder().encode(attrName).length
  if (byteLen < 1 || byteLen > 255) {
    throw new Error(
      `Sparse map "${field}": composed attribute name "${attrName}" is ${byteLen} bytes (must be 1–255)`,
    )
  }
}

/** Whether the sparse map's writer takes `key` as an entry key ({@link validateSparseKey}). */
export const isSparseKey = (field: string, prefix: string, key: string): boolean => {
  try {
    validateSparseKey(field, prefix, key)
    return true
  } catch {
    return false
  }
}
