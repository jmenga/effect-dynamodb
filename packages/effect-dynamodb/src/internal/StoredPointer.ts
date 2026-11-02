/**
 * @internal The blob pointer a stored attribute value holds (#179, design
 * §4.2), in any form a row or a stream image carries it — the one reader
 * behind `StorageEncoding.pointer` and blob GC's holder scan.
 *
 * Not part of the public API.
 */

import {
  type BlobPointer,
  decode as decodePointer,
  decodeText as decodePointerText,
  isPointerHeader,
  isPointerText,
} from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { isBase64PackedText } from "@effect-dynamodb/schema/internal/PackedCodec.js"
import { Option, Result } from "effect"
import { Base64 } from "effect/encoding"

/** A layout-`010` `B` value's json pointer. */
const bytesPointer = (bytes: Uint8Array): Option.Option<BlobPointer> => {
  if (bytes.length === 0 || !isPointerHeader(bytes[0]!)) return Option.none()
  const decoded = decodePointer(bytes)
  return typeof decoded !== "string" && decoded.kind === "json"
    ? Option.some(decoded)
    : Option.none()
}

/** A binary field's `~edbp:` bytes pointer. */
const textPointer = (text: string): Option.Option<BlobPointer> => {
  const decoded = decodePointerText(text)
  return decoded !== undefined && typeof decoded !== "string" && decoded.kind === "bytes"
    ? Option.some(decoded)
    : Option.none()
}

/** A `B` value given as base64 text: its json pointer. */
const base64Pointer = (text: string): Option.Option<BlobPointer> => {
  const decoded = Base64.decode(text)
  return Result.isSuccess(decoded) ? bytesPointer(decoded.success) : Option.none()
}

/**
 * The pointer `stored` holds: an `AttributeValue` (`B` as bytes or base64
 * text, `S` text), or an unmarshalled value (bytes; `~edbp:` text; base64 of
 * a `B` value, which starts `I`–`X` — neither JSON nor `~edbp:` text does).
 * `Option.none()` for anything else — inline content, a native value, a
 * malformed pointer, or one of the other kind than its form stores (a bytes
 * pointer as `B`, a json pointer as `S` text).
 */
export const storedPointer = (stored: unknown): Option.Option<BlobPointer> => {
  if (typeof stored === "string") {
    if (isPointerText(stored)) return textPointer(stored)
    return isBase64PackedText(stored) ? base64Pointer(stored) : Option.none()
  }
  if (stored instanceof Uint8Array) return bytesPointer(stored)
  if (typeof stored !== "object" || stored === null) return Option.none()
  const text = (stored as { readonly S?: unknown }).S
  if (typeof text === "string") return textPointer(text)
  const bytes = (stored as { readonly B?: unknown }).B
  if (bytes instanceof Uint8Array) return bytesPointer(bytes)
  return typeof bytes === "string" ? base64Pointer(bytes) : Option.none()
}
