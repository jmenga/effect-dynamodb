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
 * compose from the numeric **Type** form so `KeyComposer.serializeValue`
 * encodes it in numeric order.
 *
 * | composite | Type | Encoded | key uses |
 * |---|---|---|---|
 * | `Schema.Number` | number | number | encoded (already numeric) |
 * | `Schema.BigInt` | bigint | bigint | encoded (already numeric) |
 * | `Schema.BigIntFromString` | bigint | string | **Type** — a string would sort as text |
 * | `Schema.NumberFromString` | number | string | **Type** — same shape |
 * | `DynamoModel.DateEpochMs` | DateTime | number | encoded — epoch, numeric |
 * | `Schema.Date` / `DateTimeUtc` | Date | ISO string | encoded — ISO sorts correctly |
 * | untransformed string | string | string | encoded (identical) |
 *
 * The exception exists because `serializeValue` encodes numbers and bigints so
 * their key text sorts in numeric order (a non-negative integer zero-padded to
 * 16 digits, 38 for a bigint), and does nothing to a string. Composing the
 * encoded `"42"` of a `BigIntFromString` stored `txn_42` alongside `txn_100`
 * and `txn_5`, which DynamoDB orders 100 < 42 < 5 — so `gte(42n)` returned 42
 * and 5 instead of 42 and 100.
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
 *    transformation is identity by construction (a numeric one still coerced
 *    to its declared kind, as in case 2) (`SchemaAST` documents
 *    `encoding === undefined` as "type and encoded forms are identical"), and
 *    is passed through WITHOUT attempting an encode — an open sort key bound
 *    like `gte(t.status, "d")` on a `Schema.Literals` composite is deliberately
 *    not a valid value and must not be rejected by a codec. Otherwise `encode`,
 *    with `decode -> encode` as the fallback so an already-encoded value
 *    round-trips to itself (`Entity.put`'s strategy), and then, for a value
 *    neither takes, the same two from the numeric kind the Encoded side is
 *    stored as: a row read back holds a stored `bigint` as a number.
 *
 * `onError` fires when the value of an attribute a key is composed from
 * reaches neither target form — refuse loudly rather than compose a key that
 * silently matches nothing. `reads` names those attributes, when the records
 * normalised hold others too (a whole row read back from DynamoDB): any other
 * attribute's value is never key text, so one that reaches neither form is
 * left as it is. Without `reads`, every attribute is one.
 */
export const makeCompositeKeyForm = (
  source: Schema.Top,
  onError: (attr: string, value: unknown) => never,
  options?: { readonly reads?: ((attr: string) => boolean) | undefined },
): CompositeKeyForm => {
  const fields = getSchemaFields(source)
  const cache = new Map<string, ((value: unknown) => unknown) | null>()
  const reads = options?.reads
  const refuse = (attr: string, value: unknown): unknown =>
    reads === undefined || reads(attr) ? onError(attr, value) : value

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
    // `KeyComposer.serializeValue` encodes by JS type — a number zero-padded to
    // 16 digits, a bigint to 38 — so a `bigint` composite handed a `number`
    // composes a 16-wide key where the write composed 38. That is not
    // hypothetical: a stored `bigint` attribute marshalls to `{ N: "420" }` and
    // unmarshalls back as a **number**, so any path that re-derives a key from
    // a stored row (`Aggregate.list`) lands here with the wrong kind and
    // silently finds nothing. Coercing to the declared kind is the same rule,
    // applied exactly; a value already of the right kind is unaffected.
    if (numericTypeWithStringEncoding(field)) {
      const wantsBigInt = SchemaAST.isBigInt(SchemaAST.toType(field.ast))
      const decode = Schema.decodeUnknownOption(codec)
      const fn = (value: unknown): unknown => {
        if (typeof value === "bigint") return wantsBigInt ? value : Number(value)
        if (typeof value === "number") {
          if (!wantsBigInt) return value
          return Number.isInteger(value) ? BigInt(value) : refuse(attr, value)
        }
        const decoded = decode(value)
        if (Option.isSome(decoded)) return decoded.value
        return refuse(attr, value)
      }
      cache.set(attr, fn)
      return fn
    }

    // Case 3a — identity by construction. A numeric field still takes its
    // declared kind, for the reason case 2 does: a stored `Schema.BigInt`
    // value unmarshalls as a number (and a `Schema.Number` past 2^53 as a
    // bigint), so a key re-derived from a stored row would compose at the
    // other kind's width.
    // A union of kinds storing one numeric kind (`Union([String, BigInt])`) takes it the same way: a
    // stored `N` can only have been that kind. One storing both is left: its value alone can't say.
    if (!hasEncodingTransformation(field)) {
      const kind = keyFormValueKind(field)
      const lift = kind === undefined ? liftToKind(storedNumericKinds(field)) : undefined
      const fn =
        kind === "bigint"
          ? (value: unknown): unknown =>
              typeof value === "number" && Number.isInteger(value) ? BigInt(value) : value
          : kind === "number"
            ? (value: unknown): unknown => (typeof value === "bigint" ? Number(value) : value)
            : lift !== undefined
              ? (value: unknown): unknown => lift(value) ?? value
              : null
      cache.set(attr, fn)
      return fn
    }

    // Case 3b — target is the Encoded side.
    const encode = Schema.encodeUnknownOption(codec)
    const decode = Schema.decodeUnknownOption(codec)
    const toEncoded = (value: unknown): Option.Option<unknown> => {
      const direct = encode(value)
      if (Option.isSome(direct)) return direct
      return Option.flatMap(decode(value), (decoded) => encode(decoded))
    }
    // The stored form, as case 3a takes it (`OptionFromNullOr(BigInt)`, a
    // `BigInt` under a decoding default): asked only when the value as given
    // reaches neither form. It is the value `put` handed this rule (the write
    // path holds encoded records), so it takes the steps `put`'s value took.
    const stored = storedNumericForm(field)
    const fn = (value: unknown): unknown => {
      const given = toEncoded(value)
      if (Option.isSome(given)) return given.value
      const lifted = stored?.(value)
      if (lifted !== undefined) {
        const fromStored = toEncoded(lifted)
        if (Option.isSome(fromStored)) return fromStored.value
      }
      return refuse(attr, value)
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
 * The value a field held when it was stored, from what the unmarshaller hands
 * back for it. A field whose Encoded side is a `bigint` is stored as `N` and
 * comes back as a number while it is a safe integer; one whose Encoded side is
 * a number comes back as a `bigint` past 2^53. `undefined` when the field's
 * Encoded side isn't one numeric kind, and from the function returned for a
 * value already of that kind (or not a number at all).
 */
export const storedNumericForm = (field: Schema.Top): ((value: unknown) => unknown) | undefined =>
  liftToKind(storedNumericKinds(field))

/** {@link storedNumericForm}, from the kinds a field stores. */
const liftToKind = (kinds: ReadonlySet<NumericKind>): ((value: unknown) => unknown) | undefined => {
  if (kinds.size !== 1) return undefined
  if (kinds.has("bigint")) {
    return (value) =>
      typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : undefined
  }
  return (value) => (typeof value === "bigint" ? Number(value) : undefined)
}

/** A JavaScript numeric kind a stored `N` may have been written from. */
export type NumericKind = "number" | "bigint"

/**
 * The numeric kinds a field's stored `N` can have been written from: those its Encoded side admits.
 * `Schema.BigInt` and `Schema.Union([Schema.String, Schema.BigInt])` store only a `bigint`;
 * `Schema.Union([Schema.Number, Schema.BigInt])` stores both, and so does an unknown value. Read back,
 * a field storing one kind is that kind ({@link storedNumericForm}); a field storing both can't say
 * which from the value alone, so no key is composed from one: declared, it's refused at load
 * ({@link bothKindsKeyRefusal}), and a `Schema.Unknown` or `Schema.Any` key refuses a value that
 * reads back as the other kind at write ({@link readsBackAsOtherKind}).
 */
export const storedNumericKinds = (field: Schema.Top): ReadonlySet<NumericKind> =>
  numericKinds(field, true)

/**
 * The numeric kinds a field's Encoded side declares: {@link storedNumericKinds} but for what
 * `Schema.Unknown` and `Schema.Any` take, which declare no kind.
 */
const numericKinds = (field: Schema.Top, open: boolean): ReadonlySet<NumericKind> => {
  const kinds = new Set<NumericKind>()
  const seen = new Set<SchemaAST.AST>()
  const walk = (ast: SchemaAST.AST): void => {
    if (SchemaAST.isSuspend(ast)) {
      if (seen.has(ast)) return
      seen.add(ast)
      walk(ast.thunk())
    } else if (SchemaAST.isNumber(ast)) kinds.add("number")
    else if (SchemaAST.isBigInt(ast)) kinds.add("bigint")
    else if (SchemaAST.isUnknown(ast) || SchemaAST.isAny(ast)) {
      if (open) {
        kinds.add("number")
        kinds.add("bigint")
      }
    } else if (SchemaAST.isLiteral(ast)) {
      if (typeof ast.literal === "number") kinds.add("number")
      if (typeof ast.literal === "bigint") kinds.add("bigint")
    } else if (SchemaAST.isEnum(ast)) {
      for (const [, value] of ast.enums) if (typeof value === "number") kinds.add("number")
    } else if (SchemaAST.isUnion(ast)) {
      for (const member of ast.types) walk(member)
    }
  }
  walk(SchemaAST.toEncoded(field.ast))
  return kinds
}

/**
 * `[EDD-9128]`: a key composite declaring both numeric kinds, or `undefined` for one that doesn't.
 * DynamoDB stores `5` and `5n` alike, as `{N:"5"}`, and a safe integer reads back as a `number`
 * whichever was written, while the two compose different key text (16 digits, 38). So a key composed
 * again from a row read back (`restore`, an update reading the item first, a delete releasing a
 * unique constraint, `rekey`, an aggregate's `update` and `list`) wouldn't be the key `put` wrote,
 * and the value can't say which kind it was. Refused at load wherever a value is composed into key
 * text: a key, a unique constraint, a vector partition, a time-series `orderBy`. A field no key reads
 * may store both. `Schema.Unknown` and `Schema.Any` declare no kind, and a key over one that holds
 * strings works, so they're judged by value at write instead ({@link readsBackAsOtherKind}).
 */
export const bothKindsKeyRefusal = (
  owner: string,
  where: string,
  attr: string,
  field: Schema.Top,
): Error | undefined => {
  if (numericKinds(field, false).size < 2) return undefined
  return new Error(
    `[EDD-9128] ${owner}: ${where} can't be composed from "${attr}", which stores both a number ` +
      `and a bigint. DynamoDB stores 5 and 5n alike and reads a safe integer back as a number, ` +
      `and the two compose different key text, so a key composed again from a stored row ` +
      `wouldn't be the key the write composed. Declare the one kind it holds, such as ` +
      `Schema.Number or Schema.BigInt.`,
  )
}

/**
 * For a key composite whose field takes both numeric kinds without declaring them
 * (`Schema.Unknown`, `Schema.Any`): whether a value a write stores reads back as the other kind,
 * and so composes other key text from a stored row. A `bigint` that's a safe integer reads back as
 * a `number`, and an integer `number` past 2^53 as a `bigint`. `undefined` for a field that can't
 * hold both, which never needs asking.
 */
export const readsBackAsOtherKind = (
  field: Schema.Top,
): ((value: unknown) => boolean) | undefined => {
  if (storedNumericKinds(field).size < 2) return undefined
  return (value) =>
    typeof value === "bigint"
      ? Number.isSafeInteger(Number(value)) && BigInt(Number(value)) === value
      : typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
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

/** The JavaScript type a composite's key form takes, when its schema says. */
export type KeyFormValueKind = "string" | "number" | "bigint" | "boolean"

const astKeyFormValueKind = (
  ast: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
): KeyFormValueKind | undefined => {
  // A suspended schema is the schema it suspends (`Schema.suspend(() => Schema.BigInt)`).
  if (SchemaAST.isSuspend(ast)) {
    return seen.has(ast) ? undefined : astKeyFormValueKind(ast.thunk(), new Set([...seen, ast]))
  }
  if (SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)) return "string"
  if (SchemaAST.isNumber(ast)) return "number"
  if (SchemaAST.isBigInt(ast)) return "bigint"
  if (SchemaAST.isBoolean(ast)) return "boolean"
  if (SchemaAST.isLiteral(ast)) return typeof ast.literal as KeyFormValueKind
  const kinds = SchemaAST.isEnum(ast)
    ? ast.enums.map(([, value]) => typeof value as KeyFormValueKind)
    : SchemaAST.isUnion(ast)
      ? ast.types
          .filter((member) => !SchemaAST.isUndefined(member) && !SchemaAST.isNull(member))
          .map((member) => astKeyFormValueKind(member, seen))
      : [undefined]
  const [first] = kinds
  return first !== undefined && kinds.every((kind) => kind === first) ? first : undefined
}

/**
 * The kind of value a field's key form is — the numeric Type for a numeric
 * field encoded as a string (case 2), else its Encoded side — or `undefined`
 * when the schema doesn't pin one (a union of kinds, an object, …).
 */
export const keyFormValueKind = (field: Schema.Top): KeyFormValueKind | undefined => {
  if (numericTypeWithStringEncoding(field)) {
    return SchemaAST.isBigInt(SchemaAST.toType(field.ast)) ? "bigint" : "number"
  }
  return astKeyFormValueKind(SchemaAST.toEncoded(field.ast))
}

/**
 * The literal members a field's key form is limited to (a literal, a union of
 * literals or an enum), or `undefined` when it isn't limited to literals.
 */
export const keyFormLiterals = (
  field: Schema.Top,
): ReadonlyArray<string | number | boolean> | undefined => {
  const members = (ast: SchemaAST.AST): ReadonlyArray<unknown> | undefined => {
    if (SchemaAST.isLiteral(ast)) return [ast.literal]
    if (SchemaAST.isEnum(ast)) return ast.enums.map(([, value]) => value)
    if (SchemaAST.isUnion(ast)) {
      const found: Array<unknown> = []
      for (const member of ast.types) {
        if (SchemaAST.isUndefined(member) || SchemaAST.isNull(member)) continue
        const inner = members(member)
        if (inner === undefined) return undefined
        found.push(...inner)
      }
      return found
    }
    return undefined
  }
  return members(SchemaAST.toEncoded(field.ast)) as
    | ReadonlyArray<string | number | boolean>
    | undefined
}
