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

import { Equal, Option, Schema, SchemaAST } from "effect"
import { substituteSchemaDeep } from "./EntitySchemas.js"
import { isStoredNaN, KeyValueError, STORED_NAN } from "./NumericKey.js"
import {
  getSchemaFields,
  hasEncodingTransformation,
  holdsPlainBigint,
  numericTypeWithStringEncoding,
} from "./SchemaAccessors.js"

/** The same encoded composite value: a scalar, or a `Date` of the same instant. */
const sameValue = (a: unknown, b: unknown): boolean =>
  Object.is(a, b) || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime())

/**
 * Normalises one composite attribute value into its key form. Accepts a value
 * from either side — the write path holds encoded records, the read path holds
 * domain values — and lands both on the same result.
 */
export type CompositeKeyForm = (attr: string, value: unknown) => unknown

/**
 * How {@link makeCompositeKeyForm} keys a codec whose `encode` takes its own output, and which
 * attributes it refuses a value of.
 */
export interface CompositeKeyFormOptions {
  /**
   * The key form 1.39.0 had: such a codec's value encoded whatever it is, its
   * stored text included (`x:x:mix` for `"MiX"` stored `"x:MiX"`). `rekey` asks
   * for it to find a row 1.39.0's `put` stored under that text, and an
   * aggregate, whose keys only its own paths compose, keys with it as it did
   * (one encode of a domain value).
   */
  readonly text139?: boolean
  /**
   * The attributes a key is composed from, when the records normalised hold
   * others too ({@link makeCompositeKeyForm}).
   */
  readonly reads?: ((attr: string) => boolean) | undefined
}

/**
 * The refusal of a composite's number its declared kind can't hold exactly (the
 * `reason` {@link makeCompositeKeyForm} gives `onError`), `[EDD-9050]`. Thrown as
 * a value key composition can't place (`KeyValueError`, as `NaN` is), so every
 * path that takes the value fails with a `ValidationError`, nothing sent, rather
 * than dying. `composite` names it: `Composite "n" on entity "E"`.
 */
export const refuseInexact = (composite: string, value: unknown, reason: string): never => {
  throw new KeyValueError({
    value,
    reason,
    message:
      `[EDD-9050] ${composite} has no key text: ${reason}, so a row storing it is one the ` +
      `field can't read.`,
  })
}

/**
 * Build a `CompositeKeyForm` for a model/derived schema.
 *
 * Per attribute, decided once and memoised:
 *
 * 1. **Not a model field** (a ref-derived `<ref>Id`, say) — pass through; it is
 *    already a wire-shaped string.
 * 2. **Numeric Type with string Encoded** — the rule's exception. Target is the
 *    numeric Type value: keep a `number` / `bigint` as-is, otherwise `decode`
 *    to reach it. A `NaN` is handed on as `NumericKey.STORED_NAN`: the field
 *    stores it (`"NaN"`), which no other numeric field can, so with
 *    `escapeKeys` off it keeps the key text 1.36 gave it.
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
 *    A codec whose `encode` takes its own output (`x:` prepended,
 *    `Schema.StringFromBase64`, a number scaled) takes its stored text too, so
 *    `encode` alone can't tell the two sides apart. A value that is its own
 *    stored text (`encode(decode(value))` is the value) is that text, keyed as
 *    it is: `put` holds `"x:MiX"` for `"MiX"` and keys `x:mix`. Up to 1.39.0
 *    it was encoded once more, so `put` keyed `x:x:mix` (`text139` composes
 *    that, for `rekey`, and keeps an aggregate's keys, which only its own
 *    paths compose, from domain values). A domain value can be such a text as
 *    well (`"x:MiX"` itself): a path holding domain values encodes them first
 *    ({@link makeCompositeDomainKeyForm}), so the key form only ever sees
 *    stored text from it. A codec whose `encode` refuses its own output never
 *    reaches this: its stored text takes the `decode -> encode` fallback.
 *
 * `onError` fires when the value of an attribute a key is composed from
 * reaches neither target form — refuse loudly rather than compose a key that
 * silently matches nothing. `reason` says why, when it's a number its numeric
 * kind can't hold exactly, which `onError` refuses with {@link refuseInexact}.
 * `reads` names those attributes, when the records normalised hold others too
 * (a whole row read back from DynamoDB): any other attribute's value is never
 * key text, so one that reaches neither form is left as it is. Without `reads`,
 * every attribute is one.
 */
export const makeCompositeKeyForm = (
  source: Schema.Top,
  onError: (attr: string, value: unknown, reason?: string) => never,
  options?: CompositeKeyFormOptions,
): CompositeKeyForm => {
  const keysStoredText = options?.text139 !== true
  const fields = getSchemaFields(source)
  const cache = new Map<string, ((value: unknown) => unknown) | null>()
  const reads = options?.reads
  const refuse = (attr: string, value: unknown, reason?: string): unknown =>
    reads === undefined || reads(attr) ? onError(attr, value, reason) : value
  /** `value` as `kind` holds it exactly, or refused (a row storing it is one `attr` can't read). */
  const exactly = (attr: string, kind: NumericKind, value: number | bigint): unknown =>
    exactIn(kind, value) ??
    refuse(attr, value, `${String(value)} is a value no ${kind} holds exactly`)

  const resolve = (attr: string): ((value: unknown) => unknown) | null => {
    const cached = cache.get(attr)
    if (cached !== undefined) return cached

    const field = declared(fields, attr)
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
      const stored = (value: unknown): unknown => storedNaNKeyForm(field, value)
      const fn = (value: unknown): unknown => {
        if (isStoredNaN(value)) return value
        if (typeof value === "bigint" || typeof value === "number") {
          return stored(exactly(attr, wantsBigInt ? "bigint" : "number", value))
        }
        const decoded = decode(value)
        if (Option.isSome(decoded)) return stored(decoded.value)
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
    // A number the kind can't hold exactly is refused, never rounded: a row holding one is one its
    // field can't read (`rekey` reports it, and its sentinels stay where they are).
    if (!hasEncodingTransformation(field)) {
      const declared = keyFormValueKind(field)
      const kind =
        declared === "bigint" || declared === "number"
          ? declared
          : declared === undefined
            ? onlyNumericKind(storedNumericKinds(field))
            : undefined
      const fn =
        kind === undefined
          ? null
          : (value: unknown): unknown =>
              typeof value === "number" || typeof value === "bigint"
                ? exactly(attr, kind, value)
                : value
      cache.set(attr, fn)
      return fn
    }

    // Case 3b — target is the Encoded side.
    const encode = Schema.encodeUnknownOption(codec)
    const decode = Schema.decodeUnknownOption(codec)
    /** Is `value` its own stored text: what `encode` gives for what it decodes to? */
    const isStoredText = (value: unknown): boolean => {
      const decoded = decode(value)
      if (Option.isNone(decoded)) return false
      const reencoded = encode(decoded.value)
      return Option.isSome(reencoded) && sameValue(reencoded.value, value)
    }
    const toEncoded = (value: unknown): Option.Option<unknown> => {
      const direct = encode(value)
      if (Option.isSome(direct)) {
        // `encode` takes the value and changes it: a domain value, or, for a codec whose
        // `encode` takes its own output, its stored text, which is its key text.
        if (keysStoredText && !sameValue(direct.value, value) && isStoredText(value)) {
          return Option.some(value)
        }
        return direct
      }
      return Option.flatMap(decode(value), (decoded) => encode(decoded))
    }
    // The stored form, as case 3a takes it (`OptionFromNullOr(BigInt)`, a
    // `BigInt` under a decoding default): asked only when the value as given
    // reaches neither form. It is the value `put` handed this rule (the write
    // path holds encoded records), so it takes the steps `put`'s value took.
    const stored = storedNumericForm(field)
    // A row read back holds a stored bigint beneath the field's step as a number
    // (`Schema.Array(Schema.BigInt)` under a decoding default stores `[5n]`, which
    // comes back `[5]`). A read lifts it back, so the value is taken as a read
    // decodes it, and encoded again: asked last, of a value nothing else takes.
    let readDecode: ((value: unknown) => Option.Option<unknown>) | null | undefined
    const asRead = (value: unknown): Option.Option<unknown> => {
      if (readDecode === undefined) {
        readDecode = holdsPlainBigint(SchemaAST.toEncoded(field.ast)) ? readDecodeOf(field) : null
      }
      return readDecode === null ? Option.none() : readDecode(value)
    }
    const fn = (value: unknown): unknown => {
      const given = toEncoded(value)
      if (Option.isSome(given)) return given.value
      const lifted = stored?.(value)
      if (lifted !== undefined) {
        const fromStored = toEncoded(lifted)
        if (Option.isSome(fromStored)) return fromStored.value
      }
      const fromRead = Option.flatMap(asRead(value), (decoded) => encode(decoded))
      if (Option.isSome(fromRead)) return fromRead.value
      return refuse(attr, value)
    }
    cache.set(attr, fn)
    return fn
  }

  // A value of a field storing a declaration may be one read back from a row, which the unmarshaller
  // hands back as a plain map, list or set: it's taken as the field reads it first. Only for an
  // attribute a key reads, when `reads` names them: no other is key text.
  const readBacks = new Map<string, ((value: unknown) => unknown) | undefined>()
  const readBack = (attr: string): ((value: unknown) => unknown) | undefined => {
    if (!readBacks.has(attr)) {
      const field = declared(fields, attr)
      readBacks.set(attr, field === undefined ? undefined : storedFormOfDeclaration(field))
    }
    const fn = readBacks.get(attr)
    return fn === undefined || reads === undefined || reads(attr) ? fn : undefined
  }

  return (attr, value) => {
    if (value === undefined || value === null) return value
    const read = readBack(attr)?.(value)
    const given = read === undefined ? value : read
    const fn = resolve(attr)
    return fn === null ? given : fn(given)
  }
}

/**
 * Whether a schema's Encoded side holds a declaration anywhere (`Schema.Option`, `Schema.Result`,
 * `Schema.ReadonlySet`, `Schema.Duration`, …): at its top, or in a member, property, element or
 * suspension.
 */
const holdsDeclaration = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST> = new Set()): boolean => {
  if (seen.has(ast)) return false
  seen.add(ast)
  if (SchemaAST.isDeclaration(ast)) return true
  if (SchemaAST.isSuspend(ast)) return holdsDeclaration(ast.thunk(), seen)
  if (SchemaAST.isUnion(ast)) return ast.types.some((member) => holdsDeclaration(member, seen))
  if (SchemaAST.isObjects(ast)) {
    return (
      ast.propertySignatures.some((property) => holdsDeclaration(property.type, seen)) ||
      ast.indexSignatures.some((index) => holdsDeclaration(index.type, seen))
    )
  }
  if (SchemaAST.isArrays(ast)) {
    return [...ast.elements, ...ast.rest].some((element) => holdsDeclaration(element, seen))
  }
  return false
}

/**
 * A field's decode as an entity's read decodes a row's value (`legacyReads`): what the marshaller
 * changed is taken back first, a stored bigint read back as a number lifted wherever it sits (in a
 * list, a struct, a declaration's value).
 */
const readDecodeOf = (field: Schema.Top): ((value: unknown) => Option.Option<unknown>) =>
  Schema.decodeUnknownOption(
    substituteSchemaDeep(field, { legacyReads: true }) as unknown as Schema.Codec<unknown, unknown>,
  )

/**
 * The value a field storing a declaration ({@link holdsDeclaration}) stored, from what a read of it
 * hands back: the value decoded through the field, as a read decodes it ({@link readDecodeOf}), and
 * encoded again, as a write encodes it. A declaration's value goes to DynamoDB as a map, a list or a
 * set, and comes back a plain one: `Option.some(5)` composes `some(5)`, and the map read back
 * `[object Object]`, until the field decodes it to `Option.some(5)` again; `Option.some(5n)` comes
 * back a map holding `5`, which a read lifts to `5n`. `undefined` for a field storing none, and from
 * the function returned for a value that isn't an object or that the field doesn't decode, which is
 * then taken as it is.
 */
export const storedFormOfDeclaration = (
  field: Schema.Top,
): ((value: unknown) => unknown) | undefined => {
  if (!holdsDeclaration(SchemaAST.toEncoded(field.ast))) return undefined
  const codec = field as unknown as Schema.Codec<unknown, unknown>
  const asRead = readDecodeOf(field)
  const decode = Schema.decodeUnknownOption(codec)
  const encode = Schema.encodeUnknownOption(codec)
  return (value) => {
    if (typeof value !== "object" || value === null) return undefined
    const read = asRead(value)
    const decoded = Option.isSome(read) ? read : decode(value)
    const stored = Option.flatMap(decoded, (domain) => encode(domain))
    return Option.isSome(stored) ? stored.value : undefined
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
  return (value) =>
    typeof value === "bigint" && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

/** The one numeric kind of `kinds`, when there's one. */
const onlyNumericKind = (kinds: ReadonlySet<NumericKind>): NumericKind | undefined =>
  kinds.size === 1 ? [...kinds][0] : undefined

/**
 * `value` as `kind` holds it, exactly: a bigint as a number only within the safe range (a number
 * can't be written past it, and DynamoDB hands one back as a bigint there), a number as a bigint
 * only when it's an integer. `undefined` when `kind` can't hold it: a row storing that value is one
 * a field of that kind can't read.
 */
const exactIn = (kind: NumericKind, value: number | bigint): number | bigint | undefined =>
  kind === "bigint"
    ? typeof value === "bigint"
      ? value
      : Number.isInteger(value)
        ? BigInt(value)
        : undefined
    : typeof value === "number"
      ? value
      : Number.isSafeInteger(Number(value))
        ? Number(value)
        : undefined

/** A JavaScript numeric kind a stored `N` may have been written from. */
export type NumericKind = "number" | "bigint"

/**
 * The numeric kinds a field's stored `N` can have been written from: those its Encoded side admits.
 * `Schema.BigInt` and `Schema.Union([Schema.String, Schema.BigInt])` store only a `bigint`;
 * `Schema.Union([Schema.Number, Schema.BigInt])` stores both, and so does an unknown value. Read back,
 * a field storing one kind is that kind ({@link storedNumericForm}); a field storing both can't say
 * which from the value alone, so no key is composed from one: declared, it's refused at load
 * ({@link bothKindsKeyRefusal}), and a key whose kinds can't be read (`Schema.Unknown`, a declaration)
 * refuses a value that reads back otherwise at write ({@link readsBackOtherwise}).
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
 * strings works, so they're judged by value at write instead ({@link readsBackOtherwise}), as is a
 * declaration and a transformation whose Encoded side is one of these.
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
 * Whether the numeric kinds a field stores can't be read off its schema: its Encoded side holds a
 * `Schema.Unknown`, a `Schema.Any` or a declaration (`Schema.declare`), alone, in a union or behind a
 * `Schema.suspend`. A transformation is judged by its Encoded side, so `Schema.Unknown` decoded to a
 * `Schema.BigInt` is one.
 */
const kindsUnreadable = (field: Schema.Top): boolean => {
  const seen = new Set<SchemaAST.AST>()
  const walk = (ast: SchemaAST.AST): boolean => {
    if (SchemaAST.isSuspend(ast)) {
      if (seen.has(ast)) return false
      seen.add(ast)
      return walk(ast.thunk())
    }
    if (SchemaAST.isUnknown(ast) || SchemaAST.isAny(ast) || SchemaAST.isDeclaration(ast))
      return true
    return SchemaAST.isUnion(ast) && ast.types.some(walk)
  }
  return walk(SchemaAST.toEncoded(field.ast))
}

/** Whether a schema transforms anywhere: at its top, or in a member, property, element or suspension. */
const transformsAnywhere = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST> = new Set()): boolean => {
  if (seen.has(ast)) return false
  seen.add(ast)
  if (ast.encoding !== undefined) return true
  if (SchemaAST.isSuspend(ast)) return transformsAnywhere(ast.thunk(), seen)
  if (SchemaAST.isUnion(ast)) return ast.types.some((member) => transformsAnywhere(member, seen))
  if (SchemaAST.isObjects(ast)) {
    return (
      ast.propertySignatures.some((property) => transformsAnywhere(property.type, seen)) ||
      ast.indexSignatures.some((index) => transformsAnywhere(index.type, seen))
    )
  }
  if (SchemaAST.isArrays(ast)) {
    return [...ast.elements, ...ast.rest].some((element) => transformsAnywhere(element, seen))
  }
  if (SchemaAST.isDeclaration(ast)) {
    return ast.typeParameters.some((parameter) => transformsAnywhere(parameter, seen))
  }
  return false
}

/**
 * Whether a key composite's read-back can't be guaranteed at load, so a write judges each value it
 * stores: a field whose numeric kinds can't be read off its schema (`Schema.Unknown`, `Schema.Any`, a
 * declaration, alone or in a union), or one with a transformation anywhere on it. Only a field of
 * known kinds with no transformation reads back as itself by construction: the marshaller's only
 * changes to such a value (a safe-integer `bigint` read back as a number, a number past 2^53 as a
 * `bigint`, `-0` as `0`) compose the same key text.
 */
export const readBackUnsure = (field: Schema.Top): boolean =>
  kindsUnreadable(field) || transformsAnywhere(field.ast)

/**
 * The value a field stored, from what a read of it hands back, for composing a key from a row read
 * back: `undefined` when it's that already. A field storing one numeric kind takes it
 * ({@link storedNumericForm}). A field whose kinds can't be read off its schema ({@link
 * kindsUnreadable}) is decoded through the field, as a read decodes it, and encoded again, as a write
 * encodes it: `Schema.Unknown` decoded to a `Schema.BigInt` with `BigInt(n)` stored `5n`, which reads
 * back as `5`, and decoding `5` gives `5n` again. A field storing a declaration takes an object the
 * same way ({@link storedFormOfDeclaration}): `Option.some(5)` comes back a plain map. Only these
 * are taken this way, the only values DynamoDB hands back otherwise, and for any other field nothing
 * is.
 */
export const storedFormOfRead = (field: Schema.Top): ((value: unknown) => unknown) | undefined => {
  const lift = storedNumericForm(field)
  const declared = storedFormOfDeclaration(field)
  const numeric = lift ?? (kindsUnreadable(field) ? numericFormOfRead(field) : undefined)
  if (declared === undefined) return numeric
  return (value) =>
    typeof value === "object" && value !== null ? declared(value) : numeric?.(value)
}

/** {@link storedFormOfRead} of a number or a bigint, for a field whose kinds can't be read off it. */
const numericFormOfRead = (field: Schema.Top): ((value: unknown) => unknown) => {
  const codec = field as unknown as Schema.Codec<unknown, unknown>
  const decode = Schema.decodeUnknownOption(codec)
  const encode = Schema.encodeUnknownOption(codec)
  return (value) => {
    if (typeof value !== "number" && typeof value !== "bigint") return undefined
    const stored = Option.flatMap(decode(value), (decoded) => encode(decoded))
    return Option.isSome(stored) && !Object.is(stored.value, value) ? stored.value : undefined
  }
}

/**
 * Whether two decoded values compose the same key text: the same value, or the same number (`-0` and
 * `0` compose the same text).
 */
const sameKeyValue = (a: unknown, b: unknown): boolean =>
  typeof a === typeof b &&
  (Object.is(a, b) || (typeof a === "number" && a === b) || Equal.equals(a, b))

/** The texts a key composite's value is composed into: as written, and from what's read back. */
export interface ReadBackText {
  /** The text a write composes from the value it stores, `undefined` when it composes none. */
  readonly written: (stored: unknown) => string | undefined
  /** The text composed again from the value read back, `undefined` when none can be. */
  readonly read: (returned: unknown) => string | undefined
}

/**
 * For a key composite whose read-back can't be guaranteed at load ({@link readBackUnsure}, of the
 * field that reads it back or of the one a write encodes it with): what a value a write stores reads
 * back as, when a key composed again from the row read back wouldn't be the key written. `"a
 * number"` or `"a bigint"` for a value read back as the other kind, `"a value the field refuses"`,
 * or the value it reads back as. `undefined` for a value that reads back as written.
 *
 * `asRead` is what DynamoDB hands back for a stored value, the marshaller and the unmarshaller run
 * for real: a safe-integer `bigint` comes back as a `number`, and `-0` as `0`. A `number` past
 * 2^53 the marshaller refuses, which the write's own marshalling reports (`EDD-9124`). A value that
 * comes back as it went is never judged. One that doesn't is judged twice: each of `texts` composed
 * from the value written and from the value read back must be the same text, and a value that isn't
 * an object, read back and decoded through `field`, must be the value written decoded (when that
 * decodes). An object is judged by its texts alone: `Option.some(5)` comes back a plain map, which
 * the key form decodes to `Option.some(5)` again ({@link storedFormOfDeclaration}), so it composes
 * the text written, while a struct holding a `bigint` reads back holding a number its field refuses,
 * and composes the text written all the same. `Schema.Unknown` reads `5n` back as `5`, and a
 * declaration of either kind does the same, so both are refused; `Schema.Unknown` decoded to a
 * `Schema.BigInt` with `BigInt(n)` reads it back as `5n`, and is stored. A codec decoding `-0` and
 * `0` to different values refuses `-0`. The judge itself is `undefined` for a field that reads back
 * as itself by construction, which never needs asking.
 */
export const readsBackOtherwise = (
  field: Schema.Top,
  options: {
    readonly asRead: (stored: unknown) => unknown
    /** The field a write encodes the value with, when it isn't `field` (`timeSeries.appendInput`). */
    readonly written?: Schema.Top | undefined
    readonly texts?: ReadonlyArray<ReadBackText> | undefined
  },
): ((stored: unknown) => string | undefined) | undefined => {
  if (
    !readBackUnsure(field) &&
    (options.written === undefined || !readBackUnsure(options.written))
  ) {
    return undefined
  }
  const decode = Schema.decodeUnknownOption(field as unknown as Schema.Codec<unknown, unknown>)
  // A read takes what DynamoDB hands back as the one numeric kind the field stores, when it stores
  // one ({@link storedNumericForm}): `OptionFromNullOr(Schema.BigInt)` reads `5` as `5n`.
  const lift = storedNumericForm(field)
  const texts = options.texts ?? []
  return (stored) => {
    // A string or a boolean comes back as it went.
    if (typeof stored === "string" || typeof stored === "boolean") return undefined
    let returned: unknown
    try {
      returned = options.asRead(stored)
    } catch {
      // A value the marshaller refuses is the write's own marshalling's to report.
      return undefined
    }
    if (Object.is(returned, stored)) return undefined
    const read = decode(lift?.(returned) ?? returned)
    const written = decode(stored)
    const textMoved = texts.some((text) => {
      const at = text.written(stored)
      return at !== undefined && text.read(returned) !== at
    })
    // An object's key text is its texts' to judge: what each composes from the value read back is
    // what a key composed again from the row holds.
    const valueMoved =
      Option.isSome(written) &&
      typeof written.value !== "object" &&
      typeof written.value !== "function" &&
      (Option.isNone(read) || !sameKeyValue(read.value, written.value))
    if (!textMoved && !valueMoved) return undefined
    return readBackAs(read, Option.isSome(written) ? written.value : stored)
  }
}

/**
 * What a value reads back as, in the words of {@link readsBackOtherwise}: `"a value the field
 * refuses"` when the read fails, `"a number"` or `"a bigint"` for one of another kind than `was`, the
 * value written, and otherwise the value read back.
 */
export const readBackAs = (read: Option.Option<unknown>, was: unknown): string => {
  if (Option.isNone(read)) return "a value the field refuses"
  if (typeof read.value !== typeof was) {
    return typeof read.value === "bigint"
      ? "a bigint"
      : typeof read.value === "number"
        ? "a number"
        : "something else"
  }
  return typeof read.value === "bigint"
    ? `${read.value}n`
    : typeof read.value === "number" || typeof read.value === "boolean"
      ? String(read.value)
      : typeof read.value === "string"
        ? JSON.stringify(read.value)
        : "something else"
}

/**
 * The field a composite names by its dotted path (`nested.n`): the first segment a field of
 * `fields`, each further one looked up through what holds it on the way — `Schema.optional`,
 * `Schema.optionalKey`, `Schema.NullOr` or another union with `null` or `undefined`,
 * `Schema.suspend`, and a `Schema.Class` — as the value holds it. A union of structs naming the
 * segment in several members gives the union of their fields. `undefined` where a segment names
 * nothing.
 */
export const fieldAtPath = (
  fields: Record<string, Schema.Top> | undefined,
  path: string,
): Schema.Top | undefined => followPath(fields, path, (ast) => ast)

/**
 * {@link fieldAtPath} on the stored side: each segment looked up in what its holder is stored as, so
 * a transformation of a value on the way (a struct decoded to another struct) is kept, and the field
 * found is the one a row holds. `Schema.Struct({ n: Schema.Number })` decoded to a struct whose `n`
 * is `Schema.Union([Schema.Number, Schema.BigInt])` stores a number at `nested.n`.
 */
export const storedFieldAtPath = (
  fields: Record<string, Schema.Top> | undefined,
  path: string,
): Schema.Top | undefined => followPath(fields, path, (ast) => SchemaAST.toEncoded(ast))

/**
 * The field a model declares under `name`. Never a member every object
 * inherits: an attribute named `toString` that the model doesn't declare (a
 * version or timestamp attribute) is not a field.
 */
const declared = (
  fields: Record<string, Schema.Top> | undefined,
  name: string,
): Schema.Top | undefined =>
  fields !== undefined && Object.hasOwn(fields, name) ? fields[name] : undefined

const followPath = (
  fields: Record<string, Schema.Top> | undefined,
  path: string,
  side: (ast: SchemaAST.AST) => SchemaAST.AST,
): Schema.Top | undefined => {
  const [first, ...rest] = path.split(".")
  const top = declared(fields, first!)
  if (top === undefined || rest.length === 0) return top
  let at: ReadonlyArray<SchemaAST.AST> = [side(top.ast)]
  for (const segment of rest) {
    at = at.flatMap((ast) => propertyAt(ast, segment, new Set()))
    if (at.length === 0) return undefined
  }
  return at.length === 1
    ? Schema.make<Schema.Top>(at[0]!)
    : Schema.Union(at.map((ast) => Schema.make<Schema.Top>(ast)))
}

const propertyAt = (
  ast: SchemaAST.AST,
  name: string,
  seen: Set<SchemaAST.AST>,
): ReadonlyArray<SchemaAST.AST> => {
  if (SchemaAST.isSuspend(ast)) {
    if (seen.has(ast)) return []
    seen.add(ast)
    return propertyAt(ast.thunk(), name, seen)
  }
  if (SchemaAST.isUnion(ast)) {
    return ast.types.flatMap((member) =>
      SchemaAST.isUndefined(member) || SchemaAST.isNull(member)
        ? []
        : propertyAt(member, name, seen),
    )
  }
  if (SchemaAST.isObjects(ast)) {
    const property = ast.propertySignatures.find((signature) => signature.name === name)
    return property === undefined ? [] : [property.type]
  }
  // A class: a declaration of its struct, which is what it's stored as.
  if (
    SchemaAST.isDeclaration(ast) &&
    ast.typeParameters.length === 1 &&
    SchemaAST.isObjects(SchemaAST.toEncoded(ast))
  ) {
    return propertyAt(ast.typeParameters[0]!, name, seen)
  }
  return []
}

/** A record with the fields in `asOther` given as the other numeric kind ({@link kindReadingOf}). */
export interface KindReading {
  readonly record: Record<string, unknown>
  readonly asOther: ReadonlySet<string>
}

/**
 * A number or bigint as the other kind, read from `stored`, the `N` its field stored, when there
 * is one: a bigint past 2^53 keeps its digits, and a number that isn't an integer has no bigint.
 * `undefined` for anything else.
 */
export const otherNumericKind = (
  value: unknown,
  stored: string | undefined,
): number | bigint | undefined => {
  if (typeof value === "bigint") return Number(stored ?? value)
  if (typeof value !== "number") return undefined
  const integer = stored !== undefined ? /^-?\d+$/.test(stored) : Number.isInteger(value)
  return integer ? BigInt(stored ?? value) : undefined
}

/** The texts a reading is looked for among ({@link kindReadingOf}). */
export interface KindTargets {
  readonly has: (text: string) => boolean
  /** Whether some text looked for begins with `prefix`. */
  readonly hasPrefix: (prefix: string) => boolean
}

/** {@link KindTargets} over `texts`: sorted once, then each question is a binary search. */
export const kindTargets = (texts: Iterable<string>): KindTargets => {
  // Compared by UTF-16 code unit, as `<` and `startsWith` compare: the texts beginning with a
  // prefix sort together, from the first one not below it.
  const sorted = [...new Set(texts)].sort()
  const from = (text: string) => {
    let low = 0
    let high = sorted.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (sorted[middle]! < text) low = middle + 1
      else high = middle
    }
    return sorted[low]
  }
  return {
    has: (text) => from(text) === text,
    hasPrefix: (prefix) => from(prefix)?.startsWith(prefix) ?? false,
  }
}

/** The stretch of a reading's text where one field as the other kind differs from `record`'s. */
interface KindEdit {
  readonly field: string
  readonly other: number | bigint
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * The reading of `record` whose `compose` is `stored`, or one of the texts in `stored`: each of
 * `fields` that holds a number or a bigint given as its own kind or as the other one ({@link
 * otherNumericKind}, the other read from `digits`, the `N` the field stored). A field that stored
 * both kinds (`Schema.Union([Schema.Number, Schema.BigInt])` before {@link bothKindsKeyRefusal},
 * or a `Schema.Unknown`) composed each value's own kind's text, so `rekey` looks for a row stored
 * under the other kind's. `compose` gives `undefined` for values with no text there.
 *
 * `compose` may give its text in segments, whose concatenation is the text (a key's partition and
 * sort key halves): a value is looked for once in each segment, so a composite in both halves of a
 * key is found in both. Each field is one decision, its kind, whichever segments it is in.
 *
 * `record` as it is comes first, and when its text is looked for nothing else is composed: that is
 * a row under its current key, every row of a clean run. Otherwise each field is composed once as
 * the other kind by itself, which shows where its value lies in each segment: the stretch where
 * that segment and `record`'s differ. The readings are then walked stretch by stretch from the
 * left, keeping those whose text so far begins a text looked for, a field's later stretches
 * following its first, and one left whole at the end is composed to confirm it. That is one
 * composition per field and one or two more, never one per combination, and no text is split on
 * its delimiters. When two fields' stretches overlap in a segment, a composer that doesn't keep
 * each value in a stretch of its own, each field is read as the other kind only alone.
 */
export const kindReadingOf = (
  record: Record<string, unknown>,
  fields: ReadonlyArray<string>,
  digits: (field: string) => string | undefined,
  compose: (reading: KindReading) => string | ReadonlyArray<string> | undefined,
  stored: string | KindTargets,
): KindReading | undefined => {
  const targets: KindTargets =
    typeof stored === "string"
      ? { has: (text) => text === stored, hasPrefix: (prefix) => stored.startsWith(prefix) }
      : stored
  const composed = (reading: KindReading): ReadonlyArray<string> | undefined => {
    try {
      const out = compose(reading)
      return out === undefined ? undefined : typeof out === "string" ? [out] : out
    } catch {
      return undefined
    }
  }
  const given: KindReading = { record, asOther: new Set() }
  const segments = composed(given)
  if (segments === undefined) return undefined
  const base = segments.join("")
  if (targets.has(base)) return given
  const offsets: Array<number> = []
  let offset = 0
  for (const segment of segments) {
    offsets.push(offset)
    offset += segment.length
  }
  const others = new Map<string, number | bigint>()
  const edits: Array<KindEdit> = []
  for (const field of new Set(fields)) {
    const other = otherNumericKind(record[field], digits(field))
    if (other === undefined) continue
    const alone: KindReading = { record: { ...record, [field]: other }, asOther: new Set([field]) }
    const parts = composed(alone)
    if (parts === undefined) continue
    const text = parts.join("")
    if (text === base) continue
    if (targets.has(text)) return alone
    // Segments that don't line up can't be compared stretch by stretch: read alone only.
    if (parts.length !== segments.length) continue
    others.set(field, other)
    for (let i = 0; i < segments.length; i++) {
      const was = segments[i]!
      const now = parts[i]!
      if (was === now) continue
      let start = 0
      while (start < was.length && start < now.length && was[start] === now[start]) start++
      let tail = 0
      while (
        tail < was.length - start &&
        tail < now.length - start &&
        was[was.length - 1 - tail] === now[now.length - 1 - tail]
      ) {
        tail++
      }
      edits.push({
        field,
        other,
        start: offsets[i]! + start,
        end: offsets[i]! + was.length - tail,
        text: now.slice(start, now.length - tail),
      })
    }
  }
  // Each field alone has been tried.
  if (others.size < 2) return undefined
  edits.sort((a, b) => a.start - b.start || a.end - b.end)
  if (edits.some((edit, i) => i > 0 && edit.start <= edits[i - 1]!.start)) return undefined
  if (edits.some((edit, i) => i > 0 && edit.start < edits[i - 1]!.end)) return undefined
  // Where each field's last stretch is: a decision is followed until then.
  const last = new Map<string, number>()
  for (let i = 0; i < edits.length; i++) last.set(edits[i]!.field, i)
  // The readings' texts so far, each with its decisions: a field as the other kind, or not.
  type Walked = { readonly text: string; readonly decided: ReadonlyMap<string, boolean> }
  let walked = new Map<string, Walked>([["", { text: "", decided: new Map() }]])
  let at = 0
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!
    const next = new Map<string, Walked>()
    const between = base.slice(at, edit.start)
    for (const { text, decided } of walked.values()) {
      const made = decided.get(edit.field)
      for (const asOther of made === undefined ? [false, true] : [made]) {
        const sofar = `${text}${between}${asOther ? edit.text : base.slice(edit.start, edit.end)}`
        if (!targets.hasPrefix(sofar)) continue
        const now = new Map(decided).set(edit.field, asOther)
        // Readings with one text so far differ only in decisions still to be followed.
        const pending = [...now]
          .filter(([field]) => last.get(field)! > i)
          .map(([field, flipped]) => `${field}:${flipped ? 1 : 0}`)
          .join(",")
        const key = `${sofar}\u0000${pending}`
        if (!next.has(key)) next.set(key, { text: sofar, decided: now })
      }
    }
    if (next.size === 0) return undefined
    walked = next
    at = edit.end
  }
  const rest = base.slice(at)
  for (const { text, decided } of walked.values()) {
    const flipped = [...decided].filter(([, asOther]) => asOther).map(([field]) => field)
    if (flipped.length < 2 || !targets.has(`${text}${rest}`)) continue
    const values = { ...record }
    for (const field of flipped) values[field] = others.get(field)
    const reading: KindReading = { record: values, asOther: new Set(flipped) }
    const confirmed = composed(reading)
    if (confirmed !== undefined && targets.has(confirmed.join(""))) return reading
  }
  return undefined
}

/**
 * Build the function that puts a composite's DOMAIN value into the form
 * `Entity.put` stores it in, before `makeCompositeKeyForm`'s normaliser composes
 * a key from it — so a key composed from a caller's value is the key `put`
 * wrote for it.
 *
 * `put` encodes its input (`encode`, else `decode -> encode`), then composes
 * keys through the key-form normaliser, which keys that stored text as it is.
 * For a codec that `encode` takes on its own output (`x:` prepended by
 * `encode`, stripped by `decode`; a number scaled by `encode`), a caller's
 * value is therefore encoded here first, once: the normaliser can't tell
 * `"x:MiX"` given as a domain value from `"MiX"`'s stored text.
 *
 * A codec inside a wrapper (`Schema.optional(Schema.NumberFromString)`, a union
 * of a codec and a literal) is encoded here too, as `put` encodes it. The
 * normaliser takes such a field as it comes, so `put` keys its stored text
 * (`id_5`), and a caller's `5` composed `id_0000000000000005`, a key `put` never
 * writes.
 *
 * Every other composite is untouched here — an untransformed one, a numeric one
 * stored as a string (the normaliser takes either side), and a codec whose
 * `encode` refuses its own output compose the same key whichever form they come
 * in.
 *
 * A value no step takes is passed through, for the normaliser to refuse.
 */
export const makeCompositeStoredForm = (
  source: Schema.Top,
): ((record: Record<string, unknown>) => Record<string, unknown>) => {
  const storedForm = compositeStoredForm(source)
  return (record) => toCompositeKeyRecord(storedForm, record)
}

/** {@link makeCompositeStoredForm}, one attribute at a time. */
const compositeStoredForm = (source: Schema.Top): CompositeKeyForm => {
  const fields = getSchemaFields(source)
  const cache = new Map<string, ((value: unknown) => unknown) | null>()

  const resolve = (attr: string): ((value: unknown) => unknown) | null => {
    const cached = cache.get(attr)
    if (cached !== undefined) return cached
    const field = declared(fields, attr)
    if (
      field === undefined ||
      numericTypeWithStringEncoding(field) ||
      // No transformation anywhere in it, a wrapper's included: stored as given.
      SchemaAST.toEncoded(field.ast) === field.ast
    ) {
      cache.set(attr, null)
      return null
    }
    const codec = field as unknown as Schema.Codec<any>
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
      return value
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
 * The key form of a caller's DOMAIN value: {@link makeCompositeStoredForm}'s
 * stored form, then `makeCompositeKeyForm`'s key form — what `Entity.put`
 * composes for the value: encode a domain value once, then key that text.
 * Every path that composes a key from values a caller gives (an accessor's
 * composites, a `.where()` or `.within()` bound, a collection's or a vector
 * index's partition, a geo search's filter, a multi-item op's key, a
 * projection's row) composes through it, so it finds what `put` wrote. Except
 * for a domain value that is also its codec's stored text (`"x:MiX"`), it is
 * exactly the key form.
 */
export const makeCompositeDomainKeyForm = (
  source: Schema.Top,
  onError: (attr: string, value: unknown, reason?: string) => never,
): CompositeKeyForm => {
  const keyForm = makeCompositeKeyForm(source, onError)
  const storedForm = compositeStoredForm(source)
  return (attr, value) => keyForm(attr, storedForm(attr, value))
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
 * `value` in key form where it's the `NaN` of a number `field` stores as a string
 * (`Schema.NumberFromString`): `NumericKey.STORED_NAN`. The field stores it as `"NaN"`, so a row
 * can hold it, and with `escapeKeys` off it composes the text 1.36 gave it, as up to 1.39.0. A
 * `number`'s own `NaN`, which no row holds, has no key text. Any other value as it is. The one
 * place the two are told apart: the composite key form, and an aggregate's `many` edge sort key,
 * which is composed from the element's values.
 */
export const storedNaNKeyForm = (field: Schema.Top | undefined, value: unknown): unknown =>
  typeof value === "number" &&
  Number.isNaN(value) &&
  field !== undefined &&
  numericTypeWithStringEncoding(field) &&
  !SchemaAST.isBigInt(SchemaAST.toType(field.ast))
    ? STORED_NAN
    : value

/**
 * The JavaScript type of a key-form value, to compare with {@link keyFormValueKind}: `"number"` for
 * `NumericKey.STORED_NAN`, the `NaN` a number stored as a string hands on, as for any other number.
 */
export const keyFormValueKindOf = (value: unknown): string =>
  isStoredNaN(value) ? "number" : typeof value

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
