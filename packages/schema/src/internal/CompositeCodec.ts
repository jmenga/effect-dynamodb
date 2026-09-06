/**
 * @internal CompositeCodec — encode a single composite attribute value to the
 * form key composition sees.
 *
 * The write path composes every key from the **encoded** record
 * (`Entity.put` → `encodeOrDecodeEncode(inputSchema)` → `composeAllKeys`), so
 * a stored key holds the wire value: a `Schema.BigIntFromString` composite
 * `420n` is stored as `txn_420`, not as the 38-digit padding
 * `serializeValue(420n)` would produce.
 *
 * Read-side composition (query accessors, `.where()` operands) receives
 * **decoded** values, because that is what the model's Type side declares.
 * Composing those directly produced a different string from the one the write
 * path stored — the query silently matched nothing, or everything. This module
 * puts both sides on one pipeline: encode first, exactly as `put` does, then
 * hand the result to `KeyComposer`.
 *
 * Not part of the public API.
 */

import { Option, Schema } from "effect"
import { getSchemaFields, hasEncodingTransformation } from "./SchemaAccessors.js"

/**
 * Encodes one composite attribute value into the form key composition expects.
 *
 * Returns the value unchanged when no encoding is involved — see
 * `makeCompositeEncoder` for the three cases.
 */
export type CompositeEncoder = (attr: string, value: unknown) => unknown

/**
 * Build a `CompositeEncoder` for a model schema.
 *
 * Three cases, decided per attribute:
 *
 * 1. **No field schema** — the attribute is not a model field (a ref-derived
 *    `<ref>Id`, say). Nothing to encode; pass the value through. Ref ids are
 *    already wire-shaped strings.
 * 2. **Field has no encoding transformation** — `SchemaAST` documents
 *    `encoding === undefined` as "type and encoded forms are identical", so
 *    encoding is a no-op by construction. Pass the value through WITHOUT
 *    attempting an encode: a sort key bound such as
 *    `gte(t.status, "d")` on a `Schema.Literals` composite is deliberately not
 *    a valid value, and running it through the codec would reject a legitimate
 *    query.
 * 3. **Field has an encoding transformation** — the stored key holds the
 *    encoded form, so the operand MUST be encoded too. Mirrors the write
 *    path's `encode`, then `decode → encode` fallback (`Entity.ts`
 *    `encodeOrDecodeEncode`), which tolerates callers passing either the Type
 *    or the already-Encoded shape. If neither succeeds the value cannot be
 *    placed in a key at all — `onError` is invoked to refuse loudly rather
 *    than compose a string that silently compares against nothing.
 */
export const makeCompositeEncoder = (
  model: Schema.Top,
  onError: (attr: string, value: unknown) => never,
): CompositeEncoder => {
  const fields = getSchemaFields(model)
  // Per-attribute encoder, built lazily and memoised — `.where()` and the query
  // accessors run on every call, and `encodeUnknownOption` allocates a parser.
  const cache = new Map<string, ((value: unknown) => unknown) | null>()

  const resolve = (attr: string): ((value: unknown) => unknown) | null => {
    const cached = cache.get(attr)
    if (cached !== undefined) return cached

    const field = fields?.[attr]
    // Case 1 + case 2 — identity.
    if (field === undefined || !hasEncodingTransformation(field)) {
      cache.set(attr, null)
      return null
    }

    // Case 3 — real codec.
    const codec = field as unknown as Schema.Codec<any>
    const encode = Schema.encodeUnknownOption(codec)
    const decode = Schema.decodeUnknownOption(codec)
    const fn = (value: unknown): unknown => {
      const direct = encode(value)
      if (Option.isSome(direct)) return direct.value
      // Caller may have handed us the already-encoded shape; round-trip it.
      const decoded = decode(value)
      if (Option.isSome(decoded)) {
        const reencoded = encode(decoded.value)
        if (Option.isSome(reencoded)) return reencoded.value
      }
      return onError(attr, value)
    }
    cache.set(attr, fn)
    return fn
  }

  return (attr, value) => {
    if (value === undefined || value === null) return value
    const fn = resolve(attr)
    return fn === null ? value : fn(value)
  }
}

/**
 * Apply a `CompositeEncoder` across every entry of a composite record.
 * Used by the query accessors, whose caller-supplied composites are decoded
 * model values.
 */
export const encodeCompositeRecord = (
  encoder: CompositeEncoder,
  record: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [attr, value] of Object.entries(record)) {
    out[attr] = encoder(attr, value)
  }
  return out
}
