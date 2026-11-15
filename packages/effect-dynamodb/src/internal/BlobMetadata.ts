/**
 * @internal Object metadata of offloaded values (#179, design §4.6): what the
 * library writes with every version, and how it reads it back.
 *
 * | Key | Value |
 * |---|---|
 * | `edd-v` | `1` |
 * | `edd-table` | the physical table name |
 * | `edd-entity` | the entity type, or `<stream>.event` / `<stream>.snapshot` |
 * | `edd-attr` | the stored attribute name |
 * | `edd-item` | base64url of the row's canonical `[pk, sk]`, while the whole set fits 2 KB |
 * | `edd-item-sha256` | instead of `edd-item` when it does not fit: hex SHA-256 of the same bytes |
 * | `edd-kind` | `json` / `bytes` |
 * | `edd-codec` | json only: `none` / `gzip` / `brotli` / `zstd` |
 * | `edd-checksum` | json with a codec: base64 of the content CRC-64/NVME |
 *
 * - **Canonical `[pk, sk]`.** The UTF-8 JSON text of the two key values in
 *   {@link canon} form (`["s:…","s:…"]`): `edd-item` is its unpadded base64url.
 * - **US-ASCII.** S3 user metadata is US-ASCII. Table names, base64 and hex
 *   always are; an entity type or attribute name is written as is when it is
 *   printable ASCII without `%`, and otherwise with every other character as
 *   `%XX` UTF-8 escapes (so `%` itself is `%25`), which {@link parse} undoes.
 * - **The 2 KB limit** is counted conservatively ({@link metadataBytes}): the
 *   UTF-8 bytes of every value and of every key with its `x-amz-meta-` header
 *   prefix. The entity type and attribute name count against it too; a set
 *   that cannot fit even with `edd-item-sha256` is left to the store to
 *   refuse (diagnosed on failure, not pre-checked).
 *
 * Metadata is for traceability (inventory, logs, incident tooling) and for one
 * library reader: the store-wide sweep recovers an orphaned family's item key
 * from `edd-item` (§11.5).
 *
 * Pure and synchronous. Not part of the public API.
 */

import type { CompressionCodec } from "@effect-dynamodb/schema/DynamoModel.js"
import type { BlobChecksum, BlobPointerKind } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { CRC64NVME_BYTES } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { sha256 } from "@effect-dynamodb/schema/internal/Sha256.js"
import { Result } from "effect"
import { Base64, Base64Url } from "effect/encoding"
import { canon, canonicalNumber, type KeyAttributeValue } from "./BlobKeys.js"

/** The metadata scheme version (`edd-v`). */
export const METADATA_VERSION = "1"

/** S3's limit on a version's user metadata, in bytes (F10). */
export const MAX_METADATA_BYTES = 2_048

/** The header prefix S3 sends user metadata keys under. */
const HEADER_PREFIX = "x-amz-meta-"

/** Metadata keys. */
export const Keys = {
  version: "edd-v",
  table: "edd-table",
  entity: "edd-entity",
  attribute: "edd-attr",
  item: "edd-item",
  itemSha256: "edd-item-sha256",
  kind: "edd-kind",
  codec: "edd-codec",
  checksum: "edd-checksum",
} as const

const encoder = new TextEncoder()
const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * The bytes a metadata set counts against {@link MAX_METADATA_BYTES}: the UTF-8
 * bytes of each value and of each key with its `x-amz-meta-` prefix — at or
 * above S3's own count, so a set within it is within S3's.
 */
export const metadataBytes = (metadata: Readonly<Record<string, string>>): number => {
  let total = 0
  for (const [key, value] of Object.entries(metadata)) {
    total += HEADER_PREFIX.length + encoder.encode(key).length + encoder.encode(value).length
  }
  return total
}

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const isVerbatim = (code: number): boolean => code >= 0x21 && code <= 0x7e && code !== 0x25

/** `text` as printable US-ASCII: other characters (and `%`) as `%XX` UTF-8 escapes. */
export const asciiValue = (text: string): string => {
  let out = ""
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (isVerbatim(code)) {
      out += char
      continue
    }
    for (const byte of encoder.encode(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}

/** The text {@link asciiValue} wrote, or `undefined` for a value it cannot have written. */
export const fromAsciiValue = (value: string): string | undefined => {
  const bytes: Array<number> = []
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0x25) {
      const pair = value.slice(i + 1, i + 3)
      if (!/^[0-9A-F]{2}$/.test(pair)) return undefined
      const byte = Number.parseInt(pair, 16)
      // An escape of a verbatim character is not what asciiValue writes.
      if (isVerbatim(byte)) return undefined
      bytes.push(byte)
      i += 2
    } else if (isVerbatim(code)) {
      bytes.push(code)
    } else {
      return undefined
    }
  }
  try {
    return fatalDecoder.decode(new Uint8Array(bytes))
  } catch {
    return undefined
  }
}

/** The canonical `[pk, sk]` of a row: the UTF-8 JSON of their {@link canon} forms. */
export const itemKeyBytes = (pk: KeyAttributeValue, sk: KeyAttributeValue): Uint8Array =>
  encoder.encode(JSON.stringify([canon(pk), canon(sk)]))

/** What a version's metadata describes. */
export interface BlobMetadataInput {
  /** The physical table name. */
  readonly table: string
  /** The entity type, or `<stream>.event` / `<stream>.snapshot`. */
  readonly entity: string
  /** The stored attribute name. */
  readonly attribute: string
  /** The row's partition key. */
  readonly pk: KeyAttributeValue
  /** The row's own sort key (a time-series event item's, an EventStore row's). */
  readonly sk: KeyAttributeValue
  readonly kind: BlobPointerKind
  /** Codec of the object bytes; `"none"` for a bytes value. */
  readonly codec: CompressionCodec | "none"
  /** The content checksum (§5), written as `edd-checksum` for compressed json. */
  readonly checksum: BlobChecksum
}

/** The metadata set to write with a version (design §4.6). */
export const build = (input: BlobMetadataInput): Readonly<Record<string, string>> => {
  if (input.kind === "bytes" && input.codec !== "none") {
    throw new Error(`BlobMetadata: a bytes value is never compressed (codec ${input.codec})`)
  }
  const item = itemKeyBytes(input.pk, input.sk)
  const head: Record<string, string> = {
    [Keys.version]: METADATA_VERSION,
    [Keys.table]: asciiValue(input.table),
    [Keys.entity]: asciiValue(input.entity),
    [Keys.attribute]: asciiValue(input.attribute),
  }
  const tail: Record<string, string> = { [Keys.kind]: input.kind }
  if (input.kind === "json") {
    tail[Keys.codec] = input.codec
    if (input.codec !== "none") tail[Keys.checksum] = Base64.encode(input.checksum.value)
  }
  const withItem = Object.freeze({ ...head, [Keys.item]: Base64Url.encode(item), ...tail })
  if (metadataBytes(withItem) <= MAX_METADATA_BYTES) return withItem
  return Object.freeze({ ...head, [Keys.itemSha256]: hexOf(sha256(item)), ...tail })
}

/** A version's metadata, read back. */
export interface ParsedBlobMetadata {
  readonly table: string
  readonly entity: string
  readonly attribute: string
  /** The row key, when `edd-item` is present. */
  readonly item: { readonly pk: KeyAttributeValue; readonly sk: KeyAttributeValue } | undefined
  /** Hex SHA-256 of the canonical row key, when the key was too long for `edd-item`. */
  readonly itemSha256: string | undefined
  readonly kind: BlobPointerKind
  readonly codec: CompressionCodec | "none"
  /** The content checksum, for compressed json. */
  readonly checksum: BlobChecksum | undefined
}

const fromCanon = (text: unknown): KeyAttributeValue | undefined => {
  if (typeof text !== "string") return undefined
  const body = text.slice(2)
  if (text.startsWith("s:")) return { S: body }
  if (text.startsWith("n:")) {
    try {
      return canonicalNumber(body) === body ? { N: body } : undefined
    } catch {
      return undefined
    }
  }
  if (text.startsWith("b:")) {
    const bytes = Base64.decode(body)
    return Result.isSuccess(bytes) && Base64.encode(bytes.success) === body
      ? { B: bytes.success }
      : undefined
  }
  return undefined
}

const codecs: ReadonlyArray<CompressionCodec | "none"> = ["none", "gzip", "brotli", "zstd"]

/**
 * Read a metadata set this version of the library wrote. Returns the reason
 * when it is not one: another scheme version, a missing or malformed field.
 * Keys are matched case-insensitively (S3 lowercases them).
 */
export const parse = (metadata: Readonly<Record<string, string>>): ParsedBlobMetadata | string => {
  const lower = new Map<string, string>()
  for (const [key, value] of Object.entries(metadata)) lower.set(key.toLowerCase(), value)
  const get = (key: string): string | undefined => lower.get(key)
  const version = get(Keys.version)
  if (version !== METADATA_VERSION) {
    return `${Keys.version} is ${JSON.stringify(version)}, expected "${METADATA_VERSION}"`
  }
  const text = (key: string): string | undefined => {
    const value = get(key)
    return value === undefined ? undefined : fromAsciiValue(value)
  }
  const table = text(Keys.table)
  const entity = text(Keys.entity)
  const attribute = text(Keys.attribute)
  if (table === undefined || table.length === 0) return `${Keys.table} is missing or malformed`
  if (entity === undefined || entity.length === 0) return `${Keys.entity} is missing or malformed`
  if (attribute === undefined || attribute.length === 0) {
    return `${Keys.attribute} is missing or malformed`
  }
  const kind = get(Keys.kind)
  if (kind !== "json" && kind !== "bytes") return `${Keys.kind} is ${JSON.stringify(kind)}`
  const codecValue = get(Keys.codec)
  let codec: CompressionCodec | "none" = "none"
  if (kind === "json") {
    if (!codecs.includes(codecValue as CompressionCodec | "none")) {
      return `${Keys.codec} is ${JSON.stringify(codecValue)}`
    }
    codec = codecValue as CompressionCodec | "none"
  } else if (codecValue !== undefined) {
    return `${Keys.codec} is set on a bytes value`
  }
  const checksumValue = get(Keys.checksum)
  let checksum: BlobChecksum | undefined
  if (codec !== "none") {
    const decoded = checksumValue === undefined ? undefined : Base64.decode(checksumValue)
    if (
      decoded === undefined ||
      Result.isFailure(decoded) ||
      decoded.success.length !== CRC64NVME_BYTES
    ) {
      return `${Keys.checksum} is missing or malformed`
    }
    checksum = { algorithm: "crc64nvme", value: decoded.success }
  } else if (checksumValue !== undefined) {
    return `${Keys.checksum} is set on an uncompressed value`
  }
  const itemValue = get(Keys.item)
  const itemSha256 = get(Keys.itemSha256)
  let item: ParsedBlobMetadata["item"]
  if (itemValue !== undefined) {
    const bytes = Base64Url.decode(itemValue)
    let parsed: unknown
    try {
      parsed = Result.isSuccess(bytes) ? JSON.parse(fatalDecoder.decode(bytes.success)) : undefined
    } catch {
      parsed = undefined
    }
    const pk = Array.isArray(parsed) && parsed.length === 2 ? fromCanon(parsed[0]) : undefined
    const sk = Array.isArray(parsed) && parsed.length === 2 ? fromCanon(parsed[1]) : undefined
    if (pk === undefined || sk === undefined) return `${Keys.item} is malformed`
    item = { pk, sk }
  }
  if (itemSha256 !== undefined && !/^[0-9a-f]{64}$/.test(itemSha256)) {
    return `${Keys.itemSha256} is malformed`
  }
  if ((item === undefined) === (itemSha256 === undefined)) {
    return `exactly one of ${Keys.item} and ${Keys.itemSha256} must be present`
  }
  return { table, entity, attribute, item, itemSha256, kind, codec, checksum }
}
