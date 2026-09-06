/**
 * @internal CompositeCodec — put a composite attribute value into the form key
 * composition must see.
 *
 * ONE function decides this for every path: the write path (`Entity.put` →
 * `composeAllKeys`), `composePrimaryKey`, the policy-aware GSI composer, the
 * query accessors, `.where()` operands, and the aggregate composer. An operand
 * and a stored key have to be produced by the same function — every bug in this
 * area so far has been two call sites disagreeing about which form to use.
 *
 * **The rule.** Compose from the **Encoded** form, EXCEPT when the domain type
 * is numeric (`number` / `bigint`) and the encoded form is a **string** — then
 * compose from the numeric **Type** form so `KeyComposer.serializeValue` pads
 * it.
 *
 * | composite | Type | Encoded | key uses |
 * |---|---|---|---|
 * | `Schema.Number` | number | number | encoded (already padded) |
 * | `Schema.BigInt` | bigint | bigint | encoded (already padded) |
 * | `Schema.BigIntFromString` | bigint | string | **Type** — a string would not pad |
 * | `Schema.NumberFromString` | number | string | **Type** — same shape |
 * | `DynamoModel.DateEpochMs` | DateTime | number | encoded — epoch, padded |
 * | `Schema.Date` / `DateTimeUtc` | Date | ISO string | encoded — ISO sorts correctly |
 * | untransformed string | string | string | encoded (identical) |
 *
 * The exception exists because `serializeValue` pads numbers to 16 digits and
 * bigints to 38 so they sort lexicographically in numeric order, and does
 * nothing to a string. Composing the encoded `"42"` of a `BigIntFromString`
 * stored `txn_42` alongside `txn_100` and `txn_5`, which DynamoDB orders
 * 100 < 42 < 5 — so `gte(42n)` returned 42 and 5 instead of 42 and 100.
 *
 * Not part of the public API.
 */

import { Option, Schema, SchemaAST } from "effect"
import {
  getSchemaFields,
  hasEncodingTransformation,
  numericTypeWithStringEncoding,
} from "./SchemaAccessors.js"

/**
 * Normalises one composite attribute value into its key form. Accepts a value
 * from either side — the write path holds encoded records, the read path holds
 * domain values — and lands both on the same result.
 */
export type CompositeKeyForm = (attr: string, value: unknown) => unknown

/**
 * Build a `CompositeKeyForm` for a model/derived schema.
 *
 * Per attribute, decided once and memoised:
 *
 * 1. **Not a model field** (a ref-derived `<ref>Id`, say) — pass through; it is
 *    already a wire-shaped string.
 * 2. **Numeric Type with string Encoded** — the rule's exception. Target is the
 *    numeric Type value: keep a `number` / `bigint` as-is, otherwise `decode`
 *    to reach it.
 * 3. **Anything else** — target is the Encoded value. A field with no encoding
 *    transformation is identity by construction (`SchemaAST` documents
 *    `encoding === undefined` as "type and encoded forms are identical"), and
 *    is passed through WITHOUT attempting an encode — an open sort key bound
 *    like `gte(t.status, "d")` on a `Schema.Literals` composite is deliberately
 *    not a valid value and must not be rejected by a codec. Otherwise `encode`,
 *    with `decode -> encode` as the fallback so an already-encoded value
 *    round-trips to itself (`Entity.put`'s strategy).
 *
 * `onError` fires when the value reaches neither target form — refuse loudly
 * rather than compose a key that silently matches nothing.
 */
export const makeCompositeKeyForm = (
  source: Schema.Top,
  onError: (attr: string, value: unknown) => never,
): CompositeKeyForm => {
  const fields = getSchemaFields(source)
  const cache = new Map<string, ((value: unknown) => unknown) | null>()

  const resolve = (attr: string): ((value: unknown) => unknown) | null => {
    const cached = cache.get(attr)
    if (cached !== undefined) return cached

    const field = fields?.[attr]
    // Case 1.
    if (field === undefined) {
      cache.set(attr, null)
      return null
    }

    const codec = field as unknown as Schema.Codec<any>

    // Case 2 — the numeric exception. Target is the Type side, and it must be
    // the DECLARED numeric kind, not merely "some number".
    //
    // `KeyComposer.serializeValue` pads by JS type — 16 digits for a number, 38
    // for a bigint — so a `bigint` composite handed a `number` composes a
    // 16-wide key where the write composed 38. That is not hypothetical: a
    // stored `bigint` attribute marshalls to `{ N: "420" }` and unmarshalls
    // back as a **number**, so any path that re-derives a key from a stored row
    // (`Aggregate.list`) lands here with the wrong kind and silently finds
    // nothing. Coercing to the declared kind is the same rule, applied
    // exactly; a value already of the right kind is unaffected.
    if (numericTypeWithStringEncoding(field)) {
      const wantsBigInt = SchemaAST.isBigInt(SchemaAST.toType(field.ast))
      const decode = Schema.decodeUnknownOption(codec)
      const fn = (value: unknown): unknown => {
        if (typeof value === "bigint") return wantsBigInt ? value : Number(value)
        if (typeof value === "number") {
          if (!wantsBigInt) return value
          return Number.isInteger(value) ? BigInt(value) : onError(attr, value)
        }
        const decoded = decode(value)
        if (Option.isSome(decoded)) return decoded.value
        return onError(attr, value)
      }
      cache.set(attr, fn)
      return fn
    }

    // Case 3a — identity by construction.
    if (!hasEncodingTransformation(field)) {
      cache.set(attr, null)
      return null
    }

    // Case 3b — target is the Encoded side.
    const encode = Schema.encodeUnknownOption(codec)
    const decode = Schema.decodeUnknownOption(codec)
    const fn = (value: unknown): unknown => {
      const direct = encode(value)
      if (Option.isSome(direct)) return direct.value
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
 * Apply a `CompositeKeyForm` across every entry of a record, so a whole key or
 * composite record can be normalised in one call.
 */
export const toCompositeKeyRecord = (
  keyForm: CompositeKeyForm,
  record: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [attr, value] of Object.entries(record)) {
    out[attr] = keyForm(attr, value)
  }
  return out
}

/**
 * How a composite's key form is derived — the branch `makeCompositeKeyForm`
 * takes for that attribute.
 *
 * Exposed so that a COLLECTION, which spans several entities over one physical
 * index, can check at bind time that its members agree. Two members whose
 * models spell the same composite differently (`Schema.Date` vs
 * `DynamoModel.DateEpochMs`, say) write keys into the same partition that can
 * never match each other; picking one member's form silently loses the others'
 * rows. That is a modelling conflict and should fail loudly at `make()` time.
 */
export type CompositeKeyFormKind = "absent" | "identity" | "type-numeric" | "encoded"

/** Classify one composite attribute of a model/derived schema. */
export const compositeKeyFormKind = (source: Schema.Top, attr: string): CompositeKeyFormKind => {
  const field = getSchemaFields(source)?.[attr]
  if (field === undefined) return "absent"
  if (numericTypeWithStringEncoding(field)) return "type-numeric"
  if (!hasEncodingTransformation(field)) return "identity"
  return "encoded"
}
