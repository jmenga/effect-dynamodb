/**
 * @internal Object keys of offloaded values (#179, design §4.5).
 *
 * ```
 * key = <offload.prefix, else the store prefix> P "/" F "/" O
 *
 * P = hex128(SHA-256("edd-blob/1" 0x00 table 0x00 canon(pk)))      — the partition
 * F = hex128(SHA-256(P 0x00 canon(family sk)))                      — the item family
 * O = hex128(SHA-256(F 0x00 canon(row sk) 0x00 attribute))          — the row + attribute
 * ```
 *
 * - `hex128` is the first 16 bytes of the digest as 32 lowercase hex
 *   characters.
 * - `canon` writes a key attribute value with its type: `s:` + text, `n:` +
 *   the number's canonical text (below), `b:` + standard base64. `S "1"` and
 *   `N 1` differ.
 * - Strings enter the digests as UTF-8; `P` and `F` enter the next level as
 *   their hex text.
 * - `table` is the physical table name.
 *
 * Every key is the prefix plus {@link HASHED_KEY_BYTES} bytes, so it never
 * leaks an item key into S3 logs or inventories, and its length is known
 * before upload (the item budget counts a pointer at its upper bound, §6.3).
 *
 * The family prefix (`…P/F/`) holds every object any row of the item family
 * ever had; the partition prefix (`…P/`) holds a whole aggregate or stream.
 * GC trusts the trailing `P/F` to decide what is a table's own (§11.2), so the
 * digest is a fixed, vendored SHA-256 — never a service (`effect/crypto`'s
 * `Digest`), which tests may stub and unbound write paths do not have.
 *
 * Pure and synchronous. Not part of the public API.
 */

import { sha256 } from "@effect-dynamodb/schema/internal/Sha256.js"
import { Base64 } from "effect/encoding"

/**
 * A key attribute value in its DynamoDB wire shape. A table key is always a
 * string, number or binary; the library's own tables key on strings.
 */
export type KeyAttributeValue =
  | { readonly S: string }
  | { readonly N: string }
  | { readonly B: Uint8Array }

/** Hex characters in one key segment (`hex128`). */
export const HASH_HEX_CHARS = 32

/** Bytes a key adds to its prefix: `P/F/O`. */
export const HASHED_KEY_BYTES = HASH_HEX_CHARS * 3 + 2

/** The domain separator of the partition digest, versioning the key scheme. */
export const KEY_SCHEME = "edd-blob/1"

/** The family sort key of EventStore rows: the stream is the family (§4.5). */
export const STREAM_FAMILY_SK: KeyAttributeValue = Object.freeze({ S: "" })

const encoder = new TextEncoder()

const hex128 = (parts: ReadonlyArray<string>): string => {
  const chunks = parts.map((part) => encoder.encode(part))
  const separators = chunks.length - 1
  const input = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, separators))
  let offset = 0
  chunks.forEach((chunk, i) => {
    input.set(chunk, offset)
    offset += chunk.length
    // 0x00 between parts (a fresh array is zero-filled)
    if (i < separators) offset += 1
  })
  const digest = sha256(input)
  let out = ""
  for (let i = 0; i < 16; i++) out += digest[i]!.toString(16).padStart(2, "0")
  return out
}

const NUMBER_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

/**
 * The canonical text of a DynamoDB number: equal numbers get equal text,
 * whatever their spelling (`"1.50"`, `"015e-1"`, `"1.5E0"` → `"15e-1"`; zero
 * → `"0"`), so a key read back from DynamoDB (which trims zeros) hashes like
 * the one written.
 *
 * @throws when `text` is not a decimal number.
 */
export const canonicalNumber = (text: string): string => {
  const match = NUMBER_RE.exec(text)
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match ?? []
  if (match === null || whole.length + fraction.length === 0) {
    throw new Error(`BlobKeys: ${JSON.stringify(text)} is not a DynamoDB number`)
  }
  let digits = (whole + fraction).replace(/^0+/, "")
  let exp = Number(exponent) - fraction.length
  if (!Number.isSafeInteger(exp)) {
    throw new Error(`BlobKeys: the exponent of ${JSON.stringify(text)} is out of range`)
  }
  if (digits.length === 0) return "0"
  const trimmed = digits.replace(/0+$/, "")
  exp += digits.length - trimmed.length
  digits = trimmed
  return `${sign === "-" ? "-" : ""}${digits}e${exp}`
}

/** A key attribute value with its type: `s:` text, `n:` canonical number, `b:` base64. */
export const canon = (value: KeyAttributeValue): string => {
  const v = value as { readonly S?: unknown; readonly N?: unknown; readonly B?: unknown }
  if (typeof v.S === "string") return `s:${v.S}`
  if (typeof v.N === "string") return `n:${canonicalNumber(v.N)}`
  if (v.B instanceof Uint8Array) return `b:${Base64.encode(v.B)}`
  throw new Error("BlobKeys: a key attribute value must be { S }, { N } or { B }")
}

/** `P`: the partition of `pk` in `table`. */
export const partitionHash = (table: string, pk: KeyAttributeValue): string => {
  if (table.length === 0 || table.includes("\u0000")) {
    throw new Error(`BlobKeys: invalid table name ${JSON.stringify(table)}`)
  }
  return hex128([KEY_SCHEME, table, canon(pk)])
}

/** `F`: the item family of `familySk` in partition `partition`. */
export const familyHash = (partition: string, familySk: KeyAttributeValue): string =>
  hex128([partition, canon(familySk)])

/**
 * `O`: the row `rowSk`'s `attribute` in family `family`.
 *
 * @throws when `attribute` contains U+0000 — the separator. A row key may
 *   contain it, so the digest input stays unambiguous only while attribute
 *   names do not (DynamoDB attribute names in practice never do).
 */
export const objectHash = (family: string, rowSk: KeyAttributeValue, attribute: string): string => {
  if (attribute.length === 0 || attribute.includes("\u0000")) {
    throw new Error(`BlobKeys: invalid attribute name ${JSON.stringify(attribute)}`)
  }
  return hex128([family, canon(rowSk), attribute])
}

/** Where an offloaded value of one row attribute lives (§4.5's table of rows). */
export interface BlobKeyTarget {
  /** The physical table name. */
  readonly table: string
  readonly pk: KeyAttributeValue
  /**
   * The item family's sort key: the live SK for an entity's rows (its time-series
   * events and lifecycle copies included), {@link STREAM_FAMILY_SK} for an
   * EventStore stream, the edge item's SK for an aggregate edge.
   */
  readonly familySk: KeyAttributeValue
  /**
   * The row's own sort key: the live SK, a time-series event item's SK, an
   * EventStore event or snapshot SK, an edge item's SK.
   */
  readonly rowSk: KeyAttributeValue
  /** The stored attribute name. */
  readonly attribute: string
}

/** `<prefix>P/`: every object of a partition (an aggregate, a stream). */
export const partitionPrefix = (
  prefix: string,
  target: Pick<BlobKeyTarget, "table" | "pk">,
): string => `${prefix}${partitionHash(target.table, target.pk)}/`

/** `<prefix>P/F/`: every object any row of the item family ever had. */
export const familyPrefix = (
  prefix: string,
  target: Pick<BlobKeyTarget, "table" | "pk" | "familySk">,
): string => {
  const partition = partitionHash(target.table, target.pk)
  return `${prefix}${partition}/${familyHash(partition, target.familySk)}/`
}

/** `<prefix>P/F/O`: the stable key of one row attribute's object. */
export const objectKey = (prefix: string, target: BlobKeyTarget): string => {
  const partition = partitionHash(target.table, target.pk)
  const family = familyHash(partition, target.familySk)
  return `${prefix}${partition}/${family}/${objectHash(family, target.rowSk, target.attribute)}`
}
