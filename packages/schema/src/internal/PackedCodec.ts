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
 * | `Uint8Array` (`B`), layout `001` | header byte → decompress per codec → UTF-8 (fatal) → `JSON.parse` |
 * | `Uint8Array` (`B`), layout `010` | a {@link BlobPointer} (an offloaded value, #179) — returned, never fetched |
 * | anything else         | a legacy native value (map, list, …), unchanged             |
 *
 * ## `B` header (byte 0): `vvv ff ccc`
 *
 * - bits 7–5, layout version: `001` = v1 (an inline value). `010` = a blob
 *   pointer (see `BlobPointer.ts`). `000` invalid; `011`–`111` reserved for
 *   future layouts, which may add bytes after byte 0.
 * - bits 4–3, format: `00` json; `01` binary — reserved for SchemaBinary;
 *   `10`, `11` reserved. (In a pointer, these bits are its kind.)
 * - bits 2–0, codec: `000` none, `001` gzip, `010` brotli, `011` zstd;
 *   `100`–`111` reserved.
 *
 * v1 writers emit `0x21` (gzip), `0x22` (brotli), `0x23` (zstd); v1 readers also
 * accept `0x20` (json, uncompressed). Every v1 header byte lies in `0x20`–`0x3F`
 * and every pointer header byte in `0x40`–`0x5F`, so the base64 text of either
 * starts with one of `I`–`X` — a character no `JSON.stringify` output starts
 * with. A future layout version must keep that property (see
 * {@link isBase64PackedText}).
 *
 * The codec stays synchronous and never fetches: a pointer is handed back to
 * the caller, which resolves it (or refuses it).
 *
 * No `node:zlib` and no AWS SDK here: compression goes through a
 * {@link CompressionRegistry}.
 */

import { Effect, Schema, SchemaAST } from "effect"
import type { CompressionRegistry } from "../Compression.js"
import type { CompressionCodec, ExternalPackedConfig, PackedConfig } from "../DynamoModel.js"
import { CompressorNotRegistered, ValidationError } from "../Errors.js"
import { type Lost, lostAs, lostRefusal } from "./LostValues.js"
import { classOf } from "./OwnNames.js"
import { storedFormOf, ZONE_MARKER, zoneEntriesWritten } from "./StoredForm.js"

export { BETA_DATE_MARKER, DATE_MARKER, ZONE_MARKER } from "./StoredForm.js"

import {
  type BlobPointer,
  decode as decodePointer,
  decodeText as decodePointerText,
  isPointerHeader,
  type PointerHeader,
  parsePointerHeader,
} from "./BlobPointer.js"

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

/** A v1 (inline value) header this version can read. */
export interface PackedHeader {
  readonly version: 1
  readonly format: "json"
  readonly codec: CompressionCodec | "none"
}

export type { PointerHeader } from "./BlobPointer.js"

const hex = (byte: number): string => `0x${byte.toString(16).padStart(2, "0")}`

/**
 * Parse byte 0 of a `B` value: a v1 header (an inline value), a pointer
 * header (layout `010`, `0x40`–`0x43` json and `0x48` bytes), or the reason
 * this version cannot read it (a reserved pointer kind or codec included).
 */
export const parseHeader = (byte: number): PackedHeader | PointerHeader | string => {
  const version = byte >>> 5
  const format = (byte >>> 3) & 0b11
  const codec = byte & 0b111
  if (version === 0) return `header byte ${hex(byte)} has layout version 0, which is invalid`
  if (isPointerHeader(byte)) return parsePointerHeader(byte)
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
 * True iff `text` is the base64 encoding of a `B` value of a layout this
 * version reads: its first character encodes the top six bits of a header
 * byte in `0x20`–`0x3F` (v1, `I`–`P`) or `0x40`–`0x5F` (a blob pointer,
 * `Q`–`X`). JSON text never starts with one of those characters, so a string
 * on a packed attribute of an unmarshalled stream image is base64 exactly when
 * this holds.
 */
export const isBase64PackedText = (text: string): boolean => {
  const first = text.charCodeAt(0)
  // "I" (0x49) .. "X" (0x58)
  return first >= 0x49 && first <= 0x58
}

// ---------------------------------------------------------------------------
// Context for errors
// ---------------------------------------------------------------------------

/**
 * Who is packing or unpacking, for error attribution. `operation` is used
 * verbatim — by convention `<op>.packed` on writes and `<op>.decode` (or the
 * store's decode operation) on reads.
 */
export interface PackedContext extends OperationContext {
  readonly attribute: string
}

/**
 * Who is reading or writing, without the attribute: the synchronous codec
 * takes the attribute separately so a hot read loop builds no context object
 * per value — one is built only when a value fails.
 */
export interface OperationContext {
  readonly entityType: string
  readonly operation: string
}

const invalid = (
  ctx: OperationContext,
  attribute: string,
  message: string,
  cause?: unknown,
): ValidationError =>
  new ValidationError({
    entityType: ctx.entityType,
    operation: ctx.operation,
    cause:
      cause === undefined
        ? new Error(`Packed attribute "${attribute}": ${message}`)
        : new Error(`Packed attribute "${attribute}": ${message}`, { cause }),
  })

/**
 * A missing compressor, surfaced as a `ValidationError` whose `cause` is a
 * {@link CompressorNotRegistered} naming the codec, the direction and the
 * attribute. Packed storage is opt-in, so it never widens an operation's error
 * channel: a caller inspects `cause` (`error.cause instanceof
 * CompressorNotRegistered`) to tell a misconfigured deployment from an
 * undecodable value.
 */
export const notRegistered = (
  ctx: OperationContext,
  attribute: string,
  codec: CompressionCodec,
  direction: "compress" | "decompress",
): ValidationError =>
  new ValidationError({
    entityType: ctx.entityType,
    operation: ctx.operation,
    cause: new CompressorNotRegistered({
      codec,
      direction,
      entityType: ctx.entityType,
      attribute,
      operation: ctx.operation,
    }),
  })

/**
 * The `ValidationError` of a read path that met a blob pointer (an offloaded
 * value, #179) it cannot resolve: it names the attribute and the object
 * version the pointer pins. Stored data never reads as the pointer itself.
 */
export const unresolvedPointer = (
  ctx: OperationContext,
  attribute: string,
  pointer: BlobPointer,
): ValidationError =>
  invalid(
    ctx,
    attribute,
    `the stored value is a blob pointer to an offloaded ${pointer.kind} value (object ` +
      `"${pointer.ref.key}", version "${pointer.ref.version}"), which this version of ` +
      "effect-dynamodb cannot resolve (written by a newer effect-dynamodb?)",
  )

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
    return `binary data (${classOf(value)?.name ?? "ArrayBuffer"})`
  }
  if (value instanceof Set) return "a Set"
  if (value instanceof Map) return "a Map"
  const name = classOf(value as object)?.name
  return name ? `an instance of ${name}` : "a non-plain object"
}

class NotJson extends Error {
  constructor(
    readonly path: string,
    readonly what: string,
    message?: string,
  ) {
    super(
      message ??
        `the value at ${path} is ${what}, which JSON cannot represent. Packed storage holds ` +
          `JSON only: store this field natively, or give it a JSON-shaped schema ` +
          `(e.g. DateTimeUtcFromString, BigIntFromString, Uint8ArrayFromBase64, an array instead ` +
          `of a set).`,
    )
  }
}

/** A value DynamoDB doesn't store however it's written, refused as a native write refuses it. */
const notStored = (path: string, lost: Lost): NotJson =>
  new NotJson(path, lost.what, lostRefusal(path, lost))

/**
 * What JSON can't hold whatever it holds: a map, or binary data. Refused as not JSON, ahead of what a
 * native write would lose of one ({@link lostAs}), which a packed field never stores either way.
 */
const isNeverJson = (value: object): boolean =>
  value instanceof Map ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value) ||
  (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer)

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Each of Effect's instances met in a value, with what it's written as. */
type Forms = Map<object, unknown>

/** A named zone's map, holding `resolvedId`, as it's written ({@link zoneEntriesWritten}). */
const zoneWritten = (value: object, entries: ReadonlyArray<readonly [string, unknown]>) => {
  const written = zoneEntriesWritten(
    entries,
    Object.hasOwn(value, ZONE_MARKER),
    (entry) => entry,
    (name) => name,
  )
  return written === entries ? undefined : written
}

/**
 * What a value is written as: the value itself where it holds nothing to write otherwise, and a copy
 * where it does, so `JSON.stringify` reads each property this read, once. Refuses what JSON can't
 * hold. One of Effect's instances is written as the map a native write stores
 * ({@link storedFormOf}), which is then written as any other value is, so what it still holds that
 * JSON can't is refused where it is; a named zone's map holding `resolvedId` as 4.1.2 held it
 * ({@link zoneEntriesWritten}). `forms` holds each instance met, with what it's written as.
 */
const written = (value: unknown, path: string, stack: Set<object>, forms: Forms): unknown => {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      if (!Number.isFinite(value)) throw new NotJson(path, describe(value))
      return value
    case "object": {
      if (value === null) return value
      if (stack.has(value)) throw new NotJson(path, "a circular reference")
      // What no storage holds is refused with the words a native write refuses it in (`LostValues`).
      const lost = isNeverJson(value) ? undefined : lostAs(value)
      if (lost !== undefined) throw notStored(path, lost)
      if (Array.isArray(value)) {
        stack.add(value)
        let copy: Array<unknown> | undefined
        for (let i = 0; i < value.length; i++) {
          const element: unknown = value[i]
          if (element === undefined) throw new NotJson(`${path}[${i}]`, "undefined")
          const write = written(element, `${path}[${i}]`, stack, forms)
          if (copy === undefined && write !== element) copy = value.slice(0, i)
          copy?.push(write)
        }
        stack.delete(value)
        return copy ?? value
      }
      if (!isPlainObject(value)) {
        if (forms.has(value)) return forms.get(value)
        const form = storedFormOf(value)
        if (form === undefined) throw new NotJson(path, describe(value))
        stack.add(value)
        const write = written(form, path, stack, forms)
        stack.delete(value)
        forms.set(value, write)
        return write
      }
      if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
        throw new NotJson(path, describe(value))
      }
      stack.add(value)
      const entries: Array<readonly [string, unknown]> = []
      let changed = false
      for (const key of Object.keys(value)) {
        const v: unknown = (value as Record<string, unknown>)[key]
        // Omitted by JSON.stringify, as removeUndefinedValues omits it from a map.
        if (v === undefined) continue
        const at = IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
        const write = written(v, at, stack, forms)
        if (write !== v) changed = true
        entries.push([key, write])
      }
      stack.delete(value)
      const zone = zoneWritten(value, entries)
      if (zone === undefined && !changed) return value
      const copy: Record<string, unknown> = Object.create(null)
      for (const [key, write] of zone ?? entries) copy[key] = write
      return copy
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
 * `undefined` object properties are omitted. One of Effect's own instances that
 * a native attribute stores as a map is the exception: a `DateTime`, one of the
 * look-alikes a read rebuilds (a `Duration`, a `BigDecimal`, a zone, a cookie,
 * an address, ...), an `Option` or a `Result` is written as that map
 * ({@link storedFormOf}), as the map read back from a native row has always
 * been. A named zone's map holding `resolvedId` is written as 4.1.2 held it.
 *
 * @throws an `Error` naming the path (rooted at `root`) and the JS type.
 */
export const stringifyStrict = (value: unknown, root = "value"): string =>
  JSON.stringify(written(value, root, new Set(), new Map()))

// ---------------------------------------------------------------------------
// Pack / unpack
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
// Non-fatal decoding takes the runtime's fast UTF-8 path; a payload that
// decodes with a replacement character is re-decoded fatally, so invalid
// UTF-8 still fails (and a payload that legitimately holds U+FFFD reads).
const looseDecoder = new TextDecoder("utf-8")
const fatalDecoder = new TextDecoder("utf-8", { fatal: true })

/** The JS value a packed attribute marshals to: `S`, `B`, `NULL`, or absent. */
export type PackedStored = string | Uint8Array | null | undefined

/**
 * {@link packValue} without an Effect: the stored value, or the
 * `ValidationError` it fails with (a returned value, never thrown). The
 * synchronous core every pack site runs, wrapped in an Effect once per item or
 * operation by the caller.
 */
export const packValueSync = (
  config: PackedConfig | ExternalPackedConfig,
  wire: unknown,
  registry: CompressionRegistry,
  ctx: OperationContext,
  attribute: string,
): PackedStored | ValidationError => {
  if (wire === undefined) return undefined
  if (wire === null) return null
  let json: string
  try {
    json = stringifyStrict(wire, attribute)
  } catch (cause) {
    return invalid(
      ctx,
      attribute,
      cause instanceof NotJson ? cause.message : "cannot be serialised",
      cause,
    )
  }
  const compression = config.compression
  if (compression === undefined) return json
  // UTF-8 is at most 3 bytes per UTF-16 code unit: skip the encode when the
  // value is certainly under the threshold.
  if (json.length * 3 < compression.threshold) return json
  const bytes = encoder.encode(json)
  if (bytes.length < compression.threshold) return json
  const compressor = registry.get(compression.codec)
  if (compressor === undefined) {
    return notRegistered(ctx, attribute, compression.codec, "compress")
  }
  let compressed: Uint8Array
  try {
    compressed = compressor.compress(bytes)
  } catch (cause) {
    return invalid(ctx, attribute, `the "${compression.codec}" compressor failed`, cause)
  }
  if (!(compressed instanceof Uint8Array)) {
    return invalid(
      ctx,
      attribute,
      `the "${compression.codec}" compressor did not return a Uint8Array`,
    )
  }
  if (1 + compressed.length >= bytes.length) return json
  const out = new Uint8Array(1 + compressed.length)
  out[0] = headerByte(compression.codec)
  out.set(compressed, 1)
  return out
}

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
 * Fails with `ValidationError` on non-JSON input or a throwing compressor, and
 * when the value crosses the threshold and `registry` has no compressor for the
 * codec — then its `cause` is a `CompressorNotRegistered` (direction
 * `"compress"`).
 */
export const packValue = (
  config: PackedConfig | ExternalPackedConfig,
  wire: unknown,
  registry: CompressionRegistry,
  ctx: PackedContext,
): Effect.Effect<PackedStored, ValidationError> => {
  const stored = packValueSync(config, wire, registry, ctx, ctx.attribute)
  return stored instanceof ValidationError ? Effect.fail(stored) : Effect.succeed(stored)
}

const parseJsonSync = (text: string, ctx: OperationContext, attribute: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (cause) {
    return invalid(ctx, attribute, "the stored value is not valid JSON", cause)
  }
}

/**
 * {@link unpackBytes} without an Effect: the JSON wire form, the
 * {@link BlobPointer} a layout-`010` value holds, or the `ValidationError` it
 * fails with (returned, never thrown). A parsed JSON value is never a
 * `ValidationError` nor a `BlobPointer`, so `instanceof ValidationError` and
 * `isBlobPointer` tell the three apart.
 *
 * A pointer is decoded, never fetched: the caller resolves it. A malformed
 * pointer, or one of kind bytes (a binary field's, which a packed attribute
 * never stores), is a `ValidationError`.
 */
export const unpackBytesSync = (
  stored: Uint8Array,
  registry: CompressionRegistry,
  ctx: OperationContext,
  attribute: string,
): unknown => {
  if (stored.length === 0) return invalid(ctx, attribute, "the stored binary value is empty")
  const header = parseHeader(stored[0]!)
  if (typeof header === "string") return invalid(ctx, attribute, header)
  if (header.version === 2) {
    const pointer = decodePointer(stored)
    if (typeof pointer === "string") return invalid(ctx, attribute, pointer)
    if (pointer.kind !== "json") {
      return invalid(
        ctx,
        attribute,
        "the stored value is a binary field's blob pointer (kind bytes), which a packed " +
          "attribute never holds",
      )
    }
    return pointer
  }
  let payload = stored.subarray(1)
  if (header.codec !== "none") {
    const compressor = registry.get(header.codec)
    if (compressor === undefined) return notRegistered(ctx, attribute, header.codec, "decompress")
    try {
      payload = compressor.decompress(payload)
    } catch (cause) {
      return invalid(ctx, attribute, `the "${header.codec}" decompressor failed`, cause)
    }
    if (!(payload instanceof Uint8Array)) {
      return invalid(
        ctx,
        attribute,
        `the "${header.codec}" decompressor did not return a Uint8Array`,
      )
    }
  }
  let text = looseDecoder.decode(payload)
  if (text.includes("\uFFFD")) {
    try {
      text = fatalDecoder.decode(payload)
    } catch (cause) {
      return invalid(ctx, attribute, "the stored payload is not valid UTF-8", cause)
    }
  }
  return parseJsonSync(text, ctx, attribute)
}

/**
 * {@link unpackValue} of a stored `S` (JSON text) or `B` (header + payload)
 * without an Effect: the JSON wire form, the {@link BlobPointer} a `B` pointer
 * holds, or the `ValidationError` it fails with (returned, never thrown — tell
 * them apart with `instanceof ValidationError` and `isBlobPointer`). Callers
 * pass only strings and bytes; every other stored value is native and read as
 * is, without a call.
 */
export const unpackStoredSync = (
  stored: string | Uint8Array,
  registry: CompressionRegistry,
  ctx: OperationContext,
  attribute: string,
): unknown =>
  typeof stored === "string"
    ? parseJsonSync(stored, ctx, attribute)
    : unpackBytesSync(stored, registry, ctx, attribute)

const lift = (value: unknown): Effect.Effect<unknown, ValidationError> =>
  value instanceof ValidationError ? Effect.fail(value) : Effect.succeed(value)

/**
 * Decode a `B` value (header byte + payload) to its JSON wire form, or to the
 * {@link BlobPointer} it holds (see {@link unpackBytesSync}).
 */
export const unpackBytes = (
  stored: Uint8Array,
  registry: CompressionRegistry,
  ctx: PackedContext,
): Effect.Effect<unknown, ValidationError> =>
  lift(unpackBytesSync(stored, registry, ctx, ctx.attribute))

/**
 * Unpack a stored (unmarshalled) value by its form — see the module header.
 * A `string` is JSON, a `Uint8Array` is a header + payload (or a blob pointer,
 * returned as a {@link BlobPointer}), and anything else (absent, `null`, a
 * legacy native map, list, number, …) is returned unchanged.
 */
export const unpackValue = (
  stored: unknown,
  registry: CompressionRegistry,
  ctx: PackedContext,
): Effect.Effect<unknown, ValidationError> =>
  typeof stored === "string" || stored instanceof Uint8Array
    ? lift(unpackStoredSync(stored, registry, ctx, ctx.attribute))
    : Effect.succeed(stored)

// ---------------------------------------------------------------------------
// Binary fields: the `S` pointer form
// ---------------------------------------------------------------------------

/**
 * Read a binary field's `S` value as a blob pointer: `undefined` when it does
 * not start with `~edbp:` (it is not a pointer), the {@link BlobPointer} when
 * it is a valid one of kind bytes, or the `ValidationError` naming the
 * attribute when it starts with the sentinel but is not canonical unpadded
 * base64url of a valid bytes pointer (returned, never thrown).
 *
 * A pointer is decoded, never fetched: the caller resolves it.
 */
export const parseBinaryPointerText = (
  text: string,
  ctx: OperationContext,
  attribute: string,
): BlobPointer | ValidationError | undefined => {
  const pointer = decodePointerText(text)
  if (pointer === undefined) return undefined
  if (typeof pointer === "string") return invalidBinary(ctx, attribute, pointer)
  if (pointer.kind !== "bytes") {
    return invalidBinary(
      ctx,
      attribute,
      "the stored text is an overflow field's blob pointer (kind json), which a binary " +
        "attribute never holds",
    )
  }
  return pointer
}

const invalidBinary = (
  ctx: OperationContext,
  attribute: string,
  message: string,
): ValidationError =>
  new ValidationError({
    entityType: ctx.entityType,
    operation: ctx.operation,
    cause: new Error(`Binary attribute "${attribute}": ${message}`),
  })

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

// ---------------------------------------------------------------------------
// Binary shape — the encoded side an `External` field must have (#179)
// ---------------------------------------------------------------------------

const UINT8ARRAY_REPRESENTATION = "effect/schema/Uint8Array"

const binaryRefusalOf = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST>): string | undefined => {
  const encoded = SchemaAST.toEncoded(ast)
  switch (encoded._tag) {
    case "Declaration": {
      const id = representationId(encoded)
      if (id === UINT8ARRAY_REPRESENTATION) return undefined
      const name = id?.replace(/^effect\/schema\//, "")
      return name ? `its encoded side is ${name}` : "its encoded side is a declared type"
    }
    case "Suspend": {
      if (seen.has(encoded)) return "its encoded side is an unresolvable recursive type"
      seen.add(encoded)
      return binaryRefusalOf(encoded.thunk(), seen)
    }
    case "Union": {
      let members = 0
      for (const member of encoded.types) {
        const tag = SchemaAST.toEncoded(member)._tag
        if (tag === "Null" || tag === "Undefined" || tag === "Void") continue
        members++
        const reason = binaryRefusalOf(member, seen)
        if (reason !== undefined) return `a member of its union is not binary: ${reason}`
      }
      return members === 0 ? "its encoded side is only null / undefined" : undefined
    }
    default:
      return `its encoded side is ${scalarReason[encoded._tag] ?? encoded._tag}`
  }
}

/**
 * Why a schema cannot hold an `External` binary field, or `undefined` when its
 * encoded side is a `Uint8Array` — `Schema.Uint8Array`, optionally under
 * `optional` / `optionalKey` / `NullOr` (a union whose other members are only
 * `null` / `undefined`). `Uint8ArrayFromBase64` encodes to a string, so it is
 * refused: it stores text, not bytes.
 */
export const binaryShapeRefusal = (schema: Schema.Top | SchemaAST.AST): string | undefined =>
  binaryRefusalOf(Schema.isSchema(schema) ? schema.ast : schema, new Set())
