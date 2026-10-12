/**
 * @internal Pure codec for packed storage (`DynamoModel.Packed`): the stored
 * form of one attribute value, independent of DynamoDB's attribute-value types.
 *
 * Packing turns an attribute's **wire form** (the value the write path would
 * otherwise marshal as a native map) into the JS value that marshals to its
 * stored form — `string` → `S`, `Uint8Array` → `B`, `null` → `NULL`,
 * `undefined` → no attribute. Unpacking dispatches on the stored value, never on
 * the current config:
 *
 * | Stored (unmarshalled) | Read as                                                     |
 * |-----------------------|-------------------------------------------------------------|
 * | `undefined` / `null`  | as is                                                       |
 * | `string` (`S`)        | `JSON.parse`                                                |
 * | `Uint8Array` (`B`)    | header byte → decompress per codec → UTF-8 (fatal) → `JSON.parse` |
 * | anything else         | a legacy native value (map, list, …), unchanged             |
 *
 * ## `B` header (byte 0): `vvv ff ccc`
 *
 * - bits 7–5, layout version: `001` = v1. `000` invalid; `010`–`111` reserved
 *   for future layouts, which may add bytes after byte 0.
 * - bits 4–3, format: `00` json; `01` binary — reserved for SchemaBinary;
 *   `10`, `11` reserved.
 * - bits 2–0, codec: `000` none, `001` gzip, `010` brotli, `011` zstd;
 *   `100`–`111` reserved.
 *
 * v1 writers emit `0x21` (gzip), `0x22` (brotli), `0x23` (zstd); v1 readers also
 * accept `0x20` (json, uncompressed). Every v1 header byte lies in `0x20`–`0x3F`,
 * so the base64 text of a v1 `B` value starts with one of `I`–`P` — a character
 * no `JSON.stringify` output starts with. A future layout version must keep that
 * property (see {@link isBase64PackedText}).
 *
 * No `node:zlib` and no AWS SDK here: compression goes through a
 * {@link CompressionRegistry}.
 */

import { Effect, Schema, SchemaAST } from "effect"
import type { CompressionRegistry } from "../Compression.js"
import type { CompressionCodec, PackedConfig } from "../DynamoModel.js"
import { CompressorNotRegistered, ValidationError } from "../Errors.js"

// ---------------------------------------------------------------------------
// Header layout
// ---------------------------------------------------------------------------

/** Layout version of every value this version writes (bits 7–5). */
export const LAYOUT_VERSION_V1 = 0b001

/** Format codes (bits 4–3). */
export const FORMAT_JSON = 0b00
/** Reserved for a future SchemaBinary encoding; not read or written by this version. */
export const FORMAT_BINARY = 0b01

/** Codec codes (bits 2–0). */
export const CODEC_NONE = 0b000
export const CODEC_GZIP = 0b001
export const CODEC_BROTLI = 0b010
export const CODEC_ZSTD = 0b011

const codecCodes: Readonly<Record<CompressionCodec, number>> = {
  gzip: CODEC_GZIP,
  brotli: CODEC_BROTLI,
  zstd: CODEC_ZSTD,
}

const codecByCode: ReadonlyArray<CompressionCodec | "none" | undefined> = [
  "none",
  "gzip",
  "brotli",
  "zstd",
]

/** The header byte of a v1 value of `format` compressed with `codec`. */
export const headerByte = (
  codec: CompressionCodec | "none",
  format: number = FORMAT_JSON,
): number =>
  (LAYOUT_VERSION_V1 << 5) | (format << 3) | (codec === "none" ? CODEC_NONE : codecCodes[codec])

/** A header this version can read. */
export interface PackedHeader {
  readonly version: 1
  readonly format: "json"
  readonly codec: CompressionCodec | "none"
}

const hex = (byte: number): string => `0x${byte.toString(16).padStart(2, "0")}`

/** Parse byte 0 of a `B` value. Returns a reason string when this version cannot read it. */
export const parseHeader = (byte: number): PackedHeader | string => {
  const version = byte >>> 5
  const format = (byte >>> 3) & 0b11
  const codec = byte & 0b111
  if (version === 0) return `header byte ${hex(byte)} has layout version 0, which is invalid`
  if (version !== LAYOUT_VERSION_V1) {
    return (
      `header byte ${hex(byte)} has layout version ${version}, which this version does not ` +
      `support (written by a newer effect-dynamodb?)`
    )
  }
  if (format === FORMAT_BINARY) {
    return (
      `header byte ${hex(byte)} declares format "binary", which is reserved and not supported ` +
      `by this version`
    )
  }
  if (format !== FORMAT_JSON) return `header byte ${hex(byte)} has unknown format code ${format}`
  const name = codecByCode[codec]
  if (name === undefined) return `header byte ${hex(byte)} has unknown codec code ${codec}`
  return { version: 1, format: "json", codec: name }
}

/**
 * True iff `text` is the base64 encoding of a v1 `B` value: its first
 * character encodes the top six bits of a header byte in `0x20`–`0x3F`
 * (`I`–`P`). JSON text never starts with one of those characters, so a string
 * on a packed attribute of an unmarshalled stream image is base64 exactly when
 * this holds.
 */
export const isBase64PackedText = (text: string): boolean => {
  const first = text.charCodeAt(0)
  // "I" (0x49) .. "P" (0x50)
  return first >= 0x49 && first <= 0x50
}

// ---------------------------------------------------------------------------
// Context for errors
// ---------------------------------------------------------------------------

/**
 * Who is packing or unpacking, for error attribution. `operation` is used
 * verbatim — by convention `<op>.packed` on writes and `<op>.decode` (or the
 * store's decode operation) on reads.
 */
export interface PackedContext {
  readonly entityType: string
  readonly attribute: string
  readonly operation: string
}

const invalid = (ctx: PackedContext, message: string, cause?: unknown): ValidationError =>
  new ValidationError({
    entityType: ctx.entityType,
    operation: ctx.operation,
    cause:
      cause === undefined
        ? new Error(`Packed attribute "${ctx.attribute}": ${message}`)
        : new Error(`Packed attribute "${ctx.attribute}": ${message}`, { cause }),
  })

// ---------------------------------------------------------------------------
// Strict JSON serialisation
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const describe = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (typeof value === "bigint") return "a bigint"
  if (typeof value === "symbol") return "a symbol"
  if (typeof value === "function") return "a function"
  if (typeof value === "number") return `the non-finite number ${String(value)}`
  if (value instanceof Date) return "a Date"
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `binary data (${(value as object).constructor?.name ?? "ArrayBuffer"})`
  }
  if (value instanceof Set) return "a Set"
  if (value instanceof Map) return "a Map"
  const name = (value as object).constructor?.name
  return name ? `an instance of ${name}` : "a non-plain object"
}

class NotJson extends Error {
  constructor(
    readonly path: string,
    readonly what: string,
  ) {
    super(
      `the value at ${path} is ${what}, which JSON cannot represent. Packed storage holds ` +
        `JSON only: store this field natively, or give it a JSON-shaped schema ` +
        `(e.g. DateTimeUtcFromString, BigIntFromString, Uint8ArrayFromBase64, an array instead ` +
        `of a set).`,
    )
  }
}

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const check = (value: unknown, path: string, stack: Set<object>): void => {
  switch (typeof value) {
    case "string":
    case "boolean":
      return
    case "number":
      if (!Number.isFinite(value)) throw new NotJson(path, describe(value))
      return
    case "object": {
      if (value === null) return
      if (stack.has(value)) throw new NotJson(path, "a circular reference")
      if (Array.isArray(value)) {
        stack.add(value)
        for (let i = 0; i < value.length; i++) {
          const element = value[i]
          if (element === undefined) throw new NotJson(`${path}[${i}]`, "undefined")
          check(element, `${path}[${i}]`, stack)
        }
        stack.delete(value)
        return
      }
      if (!isPlainObject(value) || typeof (value as { toJSON?: unknown }).toJSON === "function") {
        throw new NotJson(path, describe(value))
      }
      stack.add(value)
      for (const key of Object.keys(value)) {
        const v = (value as Record<string, unknown>)[key]
        // Omitted by JSON.stringify, as removeUndefinedValues omits it from a map.
        if (v === undefined) continue
        check(v, IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`, stack)
      }
      stack.delete(value)
      return
    }
    default:
      throw new NotJson(path, describe(value))
  }
}

/**
 * `JSON.stringify` that refuses anything JSON cannot represent faithfully:
 * bigint, binary (`Uint8Array`, `ArrayBuffer`, typed arrays), `Set`, `Map`,
 * `Date`, any other non-plain object (including one with `toJSON`), non-finite
 * numbers, `undefined` array elements, symbols, functions and cycles.
 * `undefined` object properties are omitted.
 *
 * @throws an `Error` naming the path (rooted at `root`) and the JS type.
 */
export const stringifyStrict = (value: unknown, root = "value"): string => {
  check(value, root, new Set())
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// Pack / unpack
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** The JS value a packed attribute marshals to: `S`, `B`, `NULL`, or absent. */
export type PackedStored = string | Uint8Array | null | undefined

/**
 * Pack an attribute's wire form per `config` (see the module header).
 *
 * - `undefined` → `undefined` (leave the attribute absent); `null` → `null`.
 * - Otherwise the strict JSON. Without compression, or when its UTF-8 length is
 *   under `threshold`, the JSON string (`S`).
 * - At or over the threshold the codec's compressor runs, and the header plus
 *   compressed bytes are kept only when strictly smaller than the JSON (`B`);
 *   otherwise the JSON string.
 *
 * Fails with `CompressorNotRegistered` (direction `"compress"`) when the value
 * crosses the threshold and `registry` has no compressor for the codec, and
 * with `ValidationError` on non-JSON input or a throwing compressor.
 */
export const packValue = (
  config: PackedConfig,
  wire: unknown,
  registry: CompressionRegistry,
  ctx: PackedContext,
): Effect.Effect<PackedStored, ValidationError | CompressorNotRegistered> => {
  if (wire === undefined) return Effect.succeed(undefined)
  if (wire === null) return Effect.succeed(null)
  let json: string
  try {
    json = stringifyStrict(wire, ctx.attribute)
  } catch (cause) {
    return Effect.fail(
      invalid(ctx, cause instanceof NotJson ? cause.message : "cannot be serialised", cause),
    )
  }
  const compression = config.compression
  if (compression === undefined) return Effect.succeed(json)
  // UTF-8 is at most 3 bytes per UTF-16 code unit: skip the encode when the
  // value is certainly under the threshold.
  if (json.length * 3 < compression.threshold) return Effect.succeed(json)
  const bytes = encoder.encode(json)
  if (bytes.length < compression.threshold) return Effect.succeed(json)
  const compressor = registry.get(compression.codec)
  if (compressor === undefined) {
    return Effect.fail(
      new CompressorNotRegistered({
        codec: compression.codec,
        direction: "compress",
        entityType: ctx.entityType,
        attribute: ctx.attribute,
        operation: ctx.operation,
      }),
    )
  }
  let compressed: Uint8Array
  try {
    compressed = compressor.compress(bytes)
  } catch (cause) {
    return Effect.fail(invalid(ctx, `the "${compression.codec}" compressor failed`, cause))
  }
  if (!(compressed instanceof Uint8Array)) {
    return Effect.fail(
      invalid(ctx, `the "${compression.codec}" compressor did not return a Uint8Array`),
    )
  }
  if (1 + compressed.length >= bytes.length) return Effect.succeed(json)
  const out = new Uint8Array(1 + compressed.length)
  out[0] = headerByte(compression.codec)
  out.set(compressed, 1)
  return Effect.succeed(out)
}

const parseJson = (text: string, ctx: PackedContext): Effect.Effect<unknown, ValidationError> => {
  try {
    return Effect.succeed(JSON.parse(text))
  } catch (cause) {
    return Effect.fail(invalid(ctx, "the stored value is not valid JSON", cause))
  }
}

/**
 * Decode a `B` value (header byte + payload) to its JSON wire form.
 */
export const unpackBytes = (
  stored: Uint8Array,
  registry: CompressionRegistry,
  ctx: PackedContext,
): Effect.Effect<unknown, ValidationError | CompressorNotRegistered> => {
  if (stored.length === 0) return Effect.fail(invalid(ctx, "the stored binary value is empty"))
  const header = parseHeader(stored[0]!)
  if (typeof header === "string") return Effect.fail(invalid(ctx, header))
  let payload = stored.subarray(1)
  if (header.codec !== "none") {
    const compressor = registry.get(header.codec)
    if (compressor === undefined) {
      return Effect.fail(
        new CompressorNotRegistered({
          codec: header.codec,
          direction: "decompress",
          entityType: ctx.entityType,
          attribute: ctx.attribute,
          operation: ctx.operation,
        }),
      )
    }
    try {
      payload = compressor.decompress(payload)
    } catch (cause) {
      return Effect.fail(invalid(ctx, `the "${header.codec}" decompressor failed`, cause))
    }
  }
  let text: string
  try {
    text = decoder.decode(payload)
  } catch (cause) {
    return Effect.fail(invalid(ctx, "the stored payload is not valid UTF-8", cause))
  }
  return parseJson(text, ctx)
}

/**
 * Unpack a stored (unmarshalled) value by its form — see the module header.
 * A `string` is JSON, a `Uint8Array` is a header + payload, and anything else
 * (absent, `null`, a legacy native map, list, number, …) is returned unchanged.
 */
export const unpackValue = (
  stored: unknown,
  registry: CompressionRegistry,
  ctx: PackedContext,
): Effect.Effect<unknown, ValidationError | CompressorNotRegistered> => {
  if (typeof stored === "string") return parseJson(stored, ctx)
  if (stored instanceof Uint8Array) return unpackBytes(stored, registry, ctx)
  return Effect.succeed(stored)
}

// ---------------------------------------------------------------------------
// Shape rule (EDD-9073) and dispatch eligibility
// ---------------------------------------------------------------------------

/**
 * The shape of a schema's **encoded** side, for packed storage:
 *
 * - `Structured` — object- or array-shaped (`Struct`, `Class`, `Record`,
 *   `Array`, `Tuple`, a union of those, optionally with `null` / `undefined`).
 *   A native value of it is never `S` or `B`, so a reader may dispatch on the
 *   stored form even when the field is not configured packed.
 * - `Opaque` — `Unknown`, `Any`, `Json`, `object`: may be packed (a native
 *   value of it could be a string or bytes, so switching an existing native
 *   field of this type to packed misreads such values), but is not
 *   dispatch-eligible unless configured packed.
 * - `Refused` — scalar, date, binary, set, map, or a union with such a member:
 *   cannot be packed (`reason` says why).
 */
export type PackedShape =
  | { readonly _tag: "Structured" }
  | { readonly _tag: "Opaque" }
  | { readonly _tag: "Refused"; readonly reason: string }

const STRUCTURED: PackedShape = { _tag: "Structured" }
const OPAQUE: PackedShape = { _tag: "Opaque" }
const refused = (reason: string): PackedShape => ({ _tag: "Refused", reason })

const OPAQUE_DECLARATIONS = new Set(["effect/schema/Json", "effect/schema/MutableJson"])

const representationId = (ast: SchemaAST.AST): string | undefined => {
  const representation = (ast.annotations as Record<string, unknown> | undefined)?.representation
  const id = (representation as { readonly id?: unknown } | undefined)?.id
  return typeof id === "string" ? id : undefined
}

const scalarReason: Partial<Record<SchemaAST.AST["_tag"], string>> = {
  String: "a string",
  Number: "a number",
  Boolean: "a boolean",
  BigInt: "a bigint",
  Symbol: "a symbol",
  UniqueSymbol: "a unique symbol",
  Literal: "a literal",
  Enum: "an enum",
  TemplateLiteral: "a template literal",
  Never: "never",
  Null: "null",
  Undefined: "undefined",
  Void: "void",
}

const classify = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST>): PackedShape => {
  const encoded = SchemaAST.toEncoded(ast)
  switch (encoded._tag) {
    case "Objects":
    case "Arrays":
      return STRUCTURED
    case "Unknown":
    case "Any":
    case "ObjectKeyword":
      return OPAQUE
    case "Declaration": {
      const id = representationId(encoded)
      if (id !== undefined && OPAQUE_DECLARATIONS.has(id)) return OPAQUE
      const name = id?.replace(/^effect\/schema\//, "")
      return refused(
        name
          ? `its encoded side is ${name}, which is not object- or array-shaped (dates, binary, ` +
              `sets and maps cannot be packed)`
          : "its encoded side is a declared type that is not object- or array-shaped",
      )
    }
    case "Suspend": {
      if (seen.has(encoded)) return refused("its encoded side is an unresolvable recursive type")
      seen.add(encoded)
      return classify(encoded.thunk(), seen)
    }
    case "Union": {
      let opaque = false
      let members = 0
      for (const member of encoded.types) {
        const tag = SchemaAST.toEncoded(member)._tag
        if (tag === "Null" || tag === "Undefined" || tag === "Void") continue
        members++
        const shape = classify(member, seen)
        if (shape._tag === "Refused") {
          return refused(`a member of its union is not packable: ${shape.reason}`)
        }
        if (shape._tag === "Opaque") opaque = true
      }
      if (members === 0) return refused("its encoded side is only null / undefined")
      return opaque ? OPAQUE : STRUCTURED
    }
    default:
      return refused(
        `its encoded side is ${scalarReason[encoded._tag] ?? encoded._tag}, which is not ` +
          `object- or array-shaped`,
      )
  }
}

/** Classify a schema's encoded side for packed storage (see {@link PackedShape}). */
export const packedShape = (schema: Schema.Top | SchemaAST.AST): PackedShape =>
  classify(Schema.isSchema(schema) ? schema.ast : schema, new Set())

/** True iff a schema may be stored packed (its encoded side is not refused). */
export const isPackedShape = (schema: Schema.Top | SchemaAST.AST): boolean =>
  packedShape(schema)._tag !== "Refused"

/**
 * True iff readers may dispatch on the stored form of an attribute of this
 * schema even when it is not configured packed: its encoded side is
 * `Structured`, so a native value is never `S` or `B`.
 */
export const isDispatchEligible = (schema: Schema.Top | SchemaAST.AST): boolean =>
  packedShape(schema)._tag === "Structured"
