/**
 * @internal The blob pointer codec — Packed header layout `010` (#179, design
 * §4.2): the stored form of an offloaded value, naming the object version that
 * holds it.
 *
 * ## Header (byte 0): `010 kk ccc`
 *
 * - bits 7–5, layout version: `010` (a blob pointer).
 * - bits 4–3, kind: `00` json (an overflow field's value), `01` bytes (a
 *   binary field's value); `10`, `11` reserved.
 * - bits 2–0, codec of the **object bytes**: `000` none, `001` gzip, `010`
 *   brotli, `011` zstd — json only, a bytes pointer is always `000`;
 *   `100`–`111` reserved.
 *
 * Writers emit `0x40`–`0x43` (json) and `0x48` (bytes); every other layout-`010`
 * byte is refused.
 *
 * ## Body
 *
 * Integers are unsigned LEB128 (minimal encoding) unless sized; fixed
 * multi-byte fields are big-endian.
 *
 * | Size  | Field |
 * |-------|-------|
 * | 1     | header |
 * | 4     | magic `EDBP` (`0x45 0x44 0x42 0x50`) |
 * | 1     | flags — bit 0: a content type follows; bits 1–7 reserved, 0 |
 * | 1     | checksum algorithm — `0x01` CRC-64/NVME (8 bytes); `0x02` SHA-256 is reserved and not written |
 * | n     | checksum (the content's, §5) |
 * | var   | object size — bytes of the stored object |
 * | var   | content size — bytes the checksum covers: the uncompressed JSON (json), the object (bytes) |
 * | var+k | key length (1 … 1,024) + key (UTF-8) |
 * | var+v | version length (0 … 1,024) + version (UTF-8; empty = an immutable key from a key-per-write store) |
 * | var+c | when flags bit 0: content-type length (1 … 255) + content type (US-ASCII) |
 * | 4     | trailer — low 32 bits of the CRC-64/NVME of every byte before it |
 *
 * ## Two stored forms of the same bytes
 *
 * - **Overflow fields** store the bytes as a `B` value.
 * - **Binary fields** store them as `S` text: `~edbp:` followed by the
 *   unpadded base64url of the bytes. `~` and `:` are outside every base64
 *   alphabet, so no base64 text starts with the sentinel, and a reader that
 *   predates pointers fails the field's `Uint8Array` schema on the text instead
 *   of returning the pointer bytes as content.
 *
 * ## Strictness
 *
 * One pointer has exactly one encoding in each form: the decoder refuses
 * reserved header, flag and algorithm values, a bad magic or trailer,
 * truncation, trailing bytes, non-minimal or unsafe LEB128 integers, lengths
 * out of range, invalid UTF-8, a non-ASCII content type, an object size that
 * differs from the content size when nothing is compressed, and text that is
 * padded or not canonical base64url. Every {@link BlobPointer} value — made by
 * {@link make} or {@link decode} — is encodable, and decodes back to itself.
 *
 * Pure, synchronous and AWS-free: no fetching here. Callers resolve pointers.
 *
 * Not part of the public API.
 */

import { Inspectable, Option, Pipeable, Result } from "effect"
import { Base64Url } from "effect/encoding"
import type { CompressionCodec } from "../DynamoModel.js"
import { CRC64NVME_BYTES, crc64nvme } from "./Crc64Nvme.js"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** A stored object version: `version` `""` is an immutable key (a key-per-write store). */
export interface BlobRef {
  readonly key: string
  readonly version: string
}

/** A content checksum (design §5). Only CRC-64/NVME is written. */
export interface BlobChecksum {
  readonly algorithm: "crc64nvme"
  /** 8 bytes, most significant first. */
  readonly value: Uint8Array
}

/** What a pointer's value is: an overflow field's JSON, or a binary field's bytes. */
export type BlobPointerKind = "json" | "bytes"

/** The fields of a {@link BlobPointer}. */
export interface BlobPointerFields {
  readonly kind: BlobPointerKind
  /** Codec of the object bytes; always `"none"` for a bytes pointer. */
  readonly codec: CompressionCodec | "none"
  readonly ref: BlobRef
  /** Bytes of the stored object. */
  readonly objectSize: number
  /** Bytes the checksum covers: the uncompressed JSON (json), the object (bytes). */
  readonly contentSize: number
  readonly checksum: BlobChecksum
  readonly contentType: Option.Option<string>
}

export const BlobPointerTypeId: unique symbol = Symbol.for("effect-dynamodb/BlobPointer")
export type BlobPointerTypeId = typeof BlobPointerTypeId

/** A decoded blob pointer (Packed layout `010`). */
export interface BlobPointer extends BlobPointerFields, Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [BlobPointerTypeId]: BlobPointerTypeId
}

/** True iff `u` is a {@link BlobPointer} — never true of a parsed JSON value. */
export const isBlobPointer = (u: unknown): u is BlobPointer =>
  typeof u === "object" && u !== null && BlobPointerTypeId in u

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Layout version of a pointer (bits 7–5). */
export const LAYOUT_VERSION_POINTER = 0b010

/** Kind codes (bits 4–3). */
export const KIND_JSON = 0b00
export const KIND_BYTES = 0b01

/** The magic after the header: ASCII `EDBP`. */
export const MAGIC: ReadonlyArray<number> = [0x45, 0x44, 0x42, 0x50]

/** Flags bit 0: a content type follows the version. */
export const FLAG_CONTENT_TYPE = 0x01

/** Checksum algorithm codes. */
export const CHECKSUM_CRC64NVME = 0x01
/** Reserved for adversarial integrity (design §5); not read or written by this version. */
export const CHECKSUM_SHA256 = 0x02

/** Bounds of the length-prefixed fields, in bytes. */
export const MAX_KEY_BYTES = 1_024
export const MAX_VERSION_BYTES = 1_024
export const MAX_CONTENT_TYPE_BYTES = 255

/** Bytes of the trailer. */
export const TRAILER_BYTES = 4

/** The sentinel a binary field's `S` pointer text starts with. */
export const TEXT_PREFIX = "~edbp:"

/** The smallest valid pointer: a 1-byte key, empty version, no content type. */
const MIN_BYTES = 1 + MAGIC.length + 1 + 1 + CRC64NVME_BYTES + 1 + 1 + 1 + 1 + 1 + TRAILER_BYTES

const codecCodes: Readonly<Record<CompressionCodec | "none", number>> = {
  none: 0b000,
  gzip: 0b001,
  brotli: 0b010,
  zstd: 0b011,
}

const codecByCode: ReadonlyArray<CompressionCodec | "none" | undefined> = [
  "none",
  "gzip",
  "brotli",
  "zstd",
]

const hex = (byte: number): string => `0x${byte.toString(16).padStart(2, "0")}`

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** A pointer header this version can read. */
export interface PointerHeader {
  readonly version: 2
  readonly kind: BlobPointerKind
  readonly codec: CompressionCodec | "none"
}

/** The header byte of a pointer of `kind` whose object is compressed with `codec`. */
export const pointerHeaderByte = (
  kind: BlobPointerKind,
  codec: CompressionCodec | "none",
): number =>
  (LAYOUT_VERSION_POINTER << 5) |
  ((kind === "json" ? KIND_JSON : KIND_BYTES) << 3) |
  codecCodes[codec]

/** True iff byte 0 of a `B` value has the pointer layout (`0x40`–`0x5F`). */
export const isPointerHeader = (byte: number): boolean => byte >>> 5 === LAYOUT_VERSION_POINTER

/**
 * Parse a layout-`010` header byte. Returns a reason string for a reserved
 * kind or codec. The caller has checked the layout version.
 */
export const parsePointerHeader = (byte: number): PointerHeader | string => {
  const kind = (byte >>> 3) & 0b11
  const codec = byte & 0b111
  const what = `header byte ${hex(byte)} is a blob pointer (layout version 2)`
  if (kind !== KIND_JSON && kind !== KIND_BYTES) return `${what} with reserved pointer kind ${kind}`
  const name = codecByCode[codec]
  if (name === undefined) return `${what} with unknown codec code ${codec}`
  if (kind === KIND_BYTES && name !== "none") {
    return `${what} of kind bytes with codec ${name}: a compressed bytes pointer is reserved`
  }
  return { version: 2, kind: kind === KIND_JSON ? "json" : "bytes", codec: name }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
// `ignoreBOM`: a leading U+FEFF is part of a key, not a byte-order mark.
const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const PointerProto: Omit<BlobPointer, keyof BlobPointerFields> = Object.assign(
  Object.create(Inspectable.BaseProto) as Inspectable.Inspectable,
  {
    [BlobPointerTypeId]: BlobPointerTypeId as BlobPointerTypeId,
    pipe(this: BlobPointer) {
      return Pipeable.pipeArguments(this, arguments)
    },
    toJSON(this: BlobPointer) {
      return {
        _id: "BlobPointer",
        kind: this.kind,
        codec: this.codec,
        ref: { key: this.ref.key, version: this.ref.version },
        objectSize: this.objectSize,
        contentSize: this.contentSize,
        checksum: { algorithm: this.checksum.algorithm, value: hexOf(this.checksum.value) },
        contentType: Option.getOrUndefined(this.contentType),
      }
    },
  },
)

/** The UTF-8 bytes of `text`, or `undefined` when it holds a lone surrogate. */
const utf8 = (text: string): Uint8Array | undefined => {
  const bytes = encoder.encode(text)
  // A lone surrogate encodes as U+FFFD: the text would not survive a round trip.
  return fatalDecoder.decode(bytes) === text ? bytes : undefined
}

const isSize = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0

const isAscii = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false
  return true
}

/** Every field of a valid pointer, or the reason it is not one. */
const validate = (fields: BlobPointerFields): string | undefined => {
  if (fields.kind !== "json" && fields.kind !== "bytes") {
    return `kind ${String(fields.kind)} is not "json" or "bytes"`
  }
  if (!Object.hasOwn(codecCodes, fields.codec)) return `codec ${String(fields.codec)} is unknown`
  if (fields.kind === "bytes" && fields.codec !== "none") {
    return `a bytes pointer is never compressed (codec ${fields.codec})`
  }
  if (typeof fields.ref?.key !== "string" || typeof fields.ref.version !== "string") {
    return "ref must be { key: string, version: string }"
  }
  const key = utf8(fields.ref.key)
  if (key === undefined) return "the key is not well-formed Unicode"
  if (key.length < 1 || key.length > MAX_KEY_BYTES) {
    return `the key is ${key.length} UTF-8 bytes, outside 1 … ${MAX_KEY_BYTES}`
  }
  const version = utf8(fields.ref.version)
  if (version === undefined) return "the version is not well-formed Unicode"
  if (version.length > MAX_VERSION_BYTES) {
    return `the version is ${version.length} UTF-8 bytes, over ${MAX_VERSION_BYTES}`
  }
  if (!isSize(fields.objectSize)) return `object size ${fields.objectSize} is not a safe size`
  if (!isSize(fields.contentSize)) return `content size ${fields.contentSize} is not a safe size`
  if (fields.codec === "none" && fields.objectSize !== fields.contentSize) {
    return (
      `object size ${fields.objectSize} differs from content size ${fields.contentSize}, ` +
      "but nothing is compressed"
    )
  }
  if (fields.checksum?.algorithm !== "crc64nvme") {
    return `checksum algorithm ${String(fields.checksum?.algorithm)} is not "crc64nvme"`
  }
  const value = fields.checksum.value
  if (!(value instanceof Uint8Array) || value.length !== CRC64NVME_BYTES) {
    return `a crc64nvme checksum is ${CRC64NVME_BYTES} bytes`
  }
  if (!Option.isOption(fields.contentType)) return "contentType must be an Option"
  if (Option.isSome(fields.contentType)) {
    const contentType = fields.contentType.value
    if (typeof contentType !== "string" || !isAscii(contentType)) {
      return "the content type is not US-ASCII"
    }
    if (contentType.length < 1 || contentType.length > MAX_CONTENT_TYPE_BYTES) {
      return `the content type is ${contentType.length} bytes, outside 1 … ${MAX_CONTENT_TYPE_BYTES}`
    }
  }
  return undefined
}

const build = (fields: BlobPointerFields): BlobPointer =>
  Object.freeze(
    Object.assign(Object.create(PointerProto) as BlobPointer, {
      kind: fields.kind,
      codec: fields.codec,
      ref: Object.freeze({ key: fields.ref.key, version: fields.ref.version }),
      objectSize: fields.objectSize,
      contentSize: fields.contentSize,
      checksum: Object.freeze({
        algorithm: "crc64nvme" as const,
        // A copy: the pointer never aliases its caller's (or the stored item's)
        // bytes. Not `.slice()`: a Node `Buffer`'s `slice` is a view of the same
        // memory. The bytes stay writable — a typed array cannot be frozen.
        value: new Uint8Array(fields.checksum.value),
      }),
      contentType: fields.contentType,
    }),
  )

/**
 * A pointer from its fields, or the reason they do not make one (an
 * out-of-range length or size, a malformed string, a compressed bytes
 * pointer, …). Every pointer made here is encodable.
 */
export const make = (fields: BlobPointerFields): BlobPointer | string => {
  const reason = validate(fields)
  return reason === undefined ? build(fields) : `invalid blob pointer: ${reason}`
}

// ---------------------------------------------------------------------------
// LEB128
// ---------------------------------------------------------------------------

const pushLeb = (out: Array<number>, value: number): void => {
  let v = value
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
}

/** At most 8 groups: 56 bits, enough for every safe integer. */
const MAX_LEB_BYTES = 8

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/** The `B` form of `pointer`: header, body and trailer. */
export const encode = (pointer: BlobPointer): Uint8Array => {
  const out: Array<number> = [pointerHeaderByte(pointer.kind, pointer.codec), ...MAGIC]
  const contentType = Option.getOrUndefined(pointer.contentType)
  out.push(contentType === undefined ? 0 : FLAG_CONTENT_TYPE, CHECKSUM_CRC64NVME)
  for (const byte of pointer.checksum.value) out.push(byte)
  pushLeb(out, pointer.objectSize)
  pushLeb(out, pointer.contentSize)
  const key = encoder.encode(pointer.ref.key)
  pushLeb(out, key.length)
  for (const byte of key) out.push(byte)
  const version = encoder.encode(pointer.ref.version)
  pushLeb(out, version.length)
  for (const byte of version) out.push(byte)
  if (contentType !== undefined) {
    pushLeb(out, contentType.length)
    for (let i = 0; i < contentType.length; i++) out.push(contentType.charCodeAt(i))
  }
  const bytes = new Uint8Array(out.length + TRAILER_BYTES)
  bytes.set(out)
  bytes.set(crc64nvme(bytes.subarray(0, out.length)).subarray(4), out.length)
  return bytes
}

/** The `S` form of `pointer`: `~edbp:` + the unpadded base64url of {@link encode}. */
export const encodeText = (pointer: BlobPointer): string =>
  TEXT_PREFIX + Base64Url.encode(encode(pointer))

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

class Reader {
  offset: number
  constructor(
    readonly bytes: Uint8Array,
    offset: number,
    readonly end: number,
  ) {
    this.offset = offset
  }

  /** An unsigned LEB128 safe integer, or the reason it is not one. */
  leb(field: string): number | string {
    let value = 0
    let scale = 1
    for (let n = 0; n < MAX_LEB_BYTES; n++) {
      if (this.offset >= this.end) return `truncated in the ${field}`
      const byte = this.bytes[this.offset++]!
      value += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) {
        if (byte === 0 && n > 0) return `the ${field} is not minimally encoded`
        if (!Number.isSafeInteger(value)) return `the ${field} is not a safe integer`
        return value
      }
      scale *= 0x80
    }
    return `the ${field} is longer than ${MAX_LEB_BYTES} bytes`
  }

  /** `length` bytes, or the reason they are not there. */
  take(length: number, field: string): Uint8Array | string {
    if (this.end - this.offset < length) return `truncated in the ${field}`
    const out = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  /** A length-prefixed field of `min … max` bytes, or the reason it is not one. */
  prefixed(field: string, min: number, max: number): Uint8Array | string {
    const length = this.leb(`${field} length`)
    if (typeof length === "string") return length
    if (length < min || length > max) {
      return `the ${field} length ${length} is outside ${min} … ${max}`
    }
    return this.take(length, field)
  }
}

const utf8Text = (bytes: Uint8Array): string | undefined => {
  try {
    return fatalDecoder.decode(bytes)
  } catch {
    return undefined
  }
}

const asciiText = (bytes: Uint8Array): string | undefined => {
  let text = ""
  for (const byte of bytes) {
    if (byte > 0x7f) return undefined
    text += String.fromCharCode(byte)
  }
  return text
}

/**
 * Decode the `B` form of a pointer, or return the reason it is not a valid
 * one (see the module header's strictness rules). Accepts either kind; the
 * caller checks the kind its attribute stores.
 */
export const decode = (bytes: Uint8Array): BlobPointer | string => {
  if (bytes.length === 0) return "the blob pointer is empty"
  if (!isPointerHeader(bytes[0]!)) {
    return `header byte ${hex(bytes[0]!)} is not a blob pointer (layout version 2)`
  }
  const header = parsePointerHeader(bytes[0]!)
  if (typeof header === "string") return header
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes.length <= 1 + i) return "the blob pointer is truncated in its magic"
    if (bytes[1 + i] !== MAGIC[i]) return "the blob pointer has a bad magic (expected EDBP)"
  }
  if (bytes.length < MIN_BYTES) {
    return `the blob pointer is truncated: ${bytes.length} bytes, under the minimum ${MIN_BYTES}`
  }
  const end = bytes.length - TRAILER_BYTES
  const trailer = crc64nvme(bytes.subarray(0, end))
  for (let i = 0; i < TRAILER_BYTES; i++) {
    if (bytes[end + i] !== trailer[4 + i]) {
      return "the blob pointer's trailer does not match its bytes (truncated or corrupt)"
    }
  }
  const reader = new Reader(bytes, 1 + MAGIC.length, end)
  const flags = bytes[reader.offset++]!
  if ((flags & ~FLAG_CONTENT_TYPE) !== 0) {
    return `the blob pointer sets reserved flag bits (flags ${hex(flags)})`
  }
  const algorithm = bytes[reader.offset++]!
  if (algorithm === CHECKSUM_SHA256) {
    return "the blob pointer's checksum algorithm 0x02 (SHA-256) is reserved and not supported by this version"
  }
  if (algorithm !== CHECKSUM_CRC64NVME) {
    return `the blob pointer has unknown checksum algorithm ${hex(algorithm)}`
  }
  const checksum = reader.take(CRC64NVME_BYTES, "checksum")
  if (typeof checksum === "string") return checksum
  const objectSize = reader.leb("object size")
  if (typeof objectSize === "string") return objectSize
  const contentSize = reader.leb("content size")
  if (typeof contentSize === "string") return contentSize
  const keyBytes = reader.prefixed("key", 1, MAX_KEY_BYTES)
  if (typeof keyBytes === "string") return keyBytes
  const key = utf8Text(keyBytes)
  if (key === undefined) return "the blob pointer's key is not valid UTF-8"
  const versionBytes = reader.prefixed("version", 0, MAX_VERSION_BYTES)
  if (typeof versionBytes === "string") return versionBytes
  const version = utf8Text(versionBytes)
  if (version === undefined) return "the blob pointer's version is not valid UTF-8"
  let contentType = Option.none<string>()
  if ((flags & FLAG_CONTENT_TYPE) !== 0) {
    const typeBytes = reader.prefixed("content type", 1, MAX_CONTENT_TYPE_BYTES)
    if (typeof typeBytes === "string") return typeBytes
    const text = asciiText(typeBytes)
    if (text === undefined) return "the blob pointer's content type is not US-ASCII"
    contentType = Option.some(text)
  }
  if (reader.offset !== end) {
    return `the blob pointer has ${end - reader.offset} unexpected bytes before its trailer`
  }
  const fields: BlobPointerFields = {
    kind: header.kind,
    codec: header.codec,
    ref: { key, version },
    objectSize,
    contentSize,
    checksum: { algorithm: "crc64nvme", value: checksum },
    contentType,
  }
  const reason = validate(fields)
  return reason === undefined ? build(fields) : `the blob pointer is invalid: ${reason}`
}

/** True iff `text` starts with the binary pointer sentinel `~edbp:`. */
export const isPointerText = (text: string): boolean => text.startsWith(TEXT_PREFIX)

const BASE64URL = /^[A-Za-z0-9_-]*$/

/**
 * Decode the `S` form of a pointer: `undefined` when `text` does not start
 * with `~edbp:` (it is not a pointer), the reason when it does but is not
 * canonical unpadded base64url of a valid pointer, or the pointer. Accepts
 * either kind; the caller checks the kind its attribute stores.
 */
export const decodeText = (text: string): BlobPointer | string | undefined => {
  if (!isPointerText(text)) return undefined
  const body = text.slice(TEXT_PREFIX.length)
  if (!BASE64URL.test(body) || body.length % 4 === 1) {
    return `the text after "${TEXT_PREFIX}" is not unpadded base64url`
  }
  const decoded = Base64Url.decode(body)
  if (Result.isFailure(decoded)) {
    return `the text after "${TEXT_PREFIX}" is not unpadded base64url`
  }
  const bytes = decoded.success
  if (Base64Url.encode(bytes) !== body) {
    return `the text after "${TEXT_PREFIX}" is not canonical base64url`
  }
  return decode(bytes)
}
