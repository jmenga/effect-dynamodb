/**
 * @internal Cursor — the opaque string a query's `fetch` or an aggregate's
 * `list` hands back (#171, design §10).
 *
 * Two formats:
 *
 * - **Legacy** — `btoa(JSON.stringify(key))`: a bare `LastEvaluatedKey`. Every
 *   query without a planner, and `Aggregate.list`, still emits it whenever it
 *   can carry the key exactly (every value `S` / `N`, and JSON text `btoa`
 *   accepts), so their cursors are the bytes they always were.
 * - **v2** — `"v2." + base64url(utf8(JSON))` of a {@link CursorV2}: a key with
 *   `B` values or text outside Latin-1 (on which `btoa` threw), and every
 *   cursor of a planned query, which carries its plan's fingerprint, mode and
 *   resume position.
 *
 * A cursor starting `v2.` is v2 (`.` is outside the base64 alphabet);
 * anything else is legacy, read as `{ k }`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { PlanMode } from "../Query.js"

/** A key value as a cursor carries it: `B` as base64. */
export type WireValue =
  | { readonly S: string }
  | { readonly N: string }
  | { readonly B: string /* base64 */ }

/**
 * A cursor v2 envelope. At most one of `k` / `a` / `d` is present; none of
 * them (planned queries only) is `Start`: the beginning of tuple `t`, or of
 * the plan when `t` is absent.
 */
export interface CursorV2 {
  readonly v: 2
  /** The plan's fingerprint; absent without a planner. */
  readonly f?: string
  /** The plan in force (one vocabulary with `explain`). */
  readonly s?: PlanMode
  /** The skip tuple in progress. */
  readonly t?: WireValue
  /** At: resume with `ExclusiveStartKey = k`, inside the range holding it. */
  readonly k?: Record<string, WireValue>
  /** Through: every in-plan row up to `a` (in scan direction) inside `t` is done. */
  readonly a?: WireValue
  /** TupleDone: tuple `t` is finished. */
  readonly d?: 1
  /**
   * A sharded index's query (#183): each partition's position, in the query's
   * partition order. `0` not started, `1` done, or the key to resume after,
   * without the index partition key: it is recomposed, so a cursor can't name
   * another partition.
   */
  readonly z?: ReadonlyArray<ShardPosition>
  /** A checksum over `z`: catches a corrupted or hand-edited cursor. */
  readonly c?: string
}

/** One partition's position in a {@link CursorV2}'s `z`. */
export type ShardPosition = 0 | 1 | Record<string, WireValue>

const V2 = "v2."

const PLAN_MODES: ReadonlySet<string> = new Set<PlanMode>([
  "key",
  "skip-scan",
  "filter",
  "naive",
  "jump",
  "precise",
  "empty",
])

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** Standard base64 of `bytes` (no `Buffer`: the library is runtime-agnostic). */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** The bytes of standard (or, `url`, base64url) text; throws on text that is neither. */
export const fromBase64 = (text: string, url = false): Uint8Array => {
  const standard = url ? text.replace(/-/g, "+").replace(/_/g, "/") : text
  const padded = url ? standard.padEnd(Math.ceil(standard.length / 4) * 4, "=") : standard
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** A key attribute as a cursor carries it; `undefined` for a type no key has. */
export const toWire = (value: AttributeValue): WireValue | undefined => {
  if (value.S !== undefined) return { S: value.S }
  if (value.N !== undefined) return { N: value.N }
  if (value.B !== undefined) return { B: toBase64(value.B) }
  return undefined
}

/** A wire value back as an attribute value. */
export const fromWire = (value: WireValue): AttributeValue =>
  "S" in value ? { S: value.S } : "N" in value ? { N: value.N } : { B: fromBase64(value.B) }

/** A key value (`S` text or `B` bytes) as a wire value. */
export const keyValueToWire = (value: string | Uint8Array): WireValue =>
  typeof value === "string" ? { S: value } : { B: toBase64(value) }

/** A wire value as a key value; `undefined` for an `N`, which no planned sort key holds. */
export const wireToKeyValue = (value: WireValue): string | Uint8Array | undefined =>
  "S" in value ? value.S : "B" in value ? fromBase64(value.B) : undefined

/** A key's attributes as a cursor carries them; `undefined` when one has no wire form. */
export const keyToWire = (
  key: Record<string, AttributeValue>,
): Record<string, WireValue> | undefined => {
  const out: Record<string, WireValue> = {}
  for (const [name, value] of Object.entries(key)) {
    const wire = toWire(value)
    if (wire === undefined) return undefined
    out[name] = wire
  }
  return out
}

/** A cursor's key back as an `ExclusiveStartKey`. */
export const keyFromWire = (key: Record<string, WireValue>): Record<string, AttributeValue> => {
  const out: Record<string, AttributeValue> = {}
  for (const [name, value] of Object.entries(key)) out[name] = fromWire(value)
  return out
}

/** Encode a v2 envelope. */
export const encodeV2 = (cursor: CursorV2): string =>
  V2 + toBase64Url(encoder.encode(JSON.stringify(cursor)))

const isLatin1 = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) return false
  return true
}

/**
 * The cursor of a query without a planner or an aggregate's list, resuming
 * after `key`: the legacy bytes whenever they carry it exactly (every value
 * `S` / `N`, Latin-1 JSON — what every such cursor always was), else
 * `{ v: 2, k }`. A `B` value serialises as `{"0":…}` in the legacy form and
 * never round-trips, and `btoa` throws on text above U+00FF (design §19 E2).
 */
export const encodeKeyCursor = (key: Record<string, AttributeValue>): string => {
  const json = JSON.stringify(key)
  const plain = Object.values(key).every(
    (value) => value.B === undefined && (value.S !== undefined || value.N !== undefined),
  )
  if (plain && isLatin1(json)) return btoa(json)
  const wire = keyToWire(key)
  // A key of a type no DynamoDB key has: as it always was.
  return wire === undefined ? btoa(json) : encodeV2({ v: 2, k: wire })
}

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u)

const isWireValue = (u: unknown): u is WireValue => {
  if (!isRecord(u)) return false
  const keys = Object.keys(u)
  if (keys.length !== 1) return false
  const [tag] = keys
  if (tag === "S" || tag === "N") return typeof u[tag] === "string"
  if (tag === "B") {
    if (typeof u.B !== "string") return false
    try {
      fromBase64(u.B)
      return true
    } catch {
      return false
    }
  }
  return false
}

/** A key as a cursor carries it: every value a valid {@link WireValue}. */
export const isWireKey = (u: unknown): u is Record<string, WireValue> =>
  isRecord(u) && Object.keys(u).length > 0 && Object.values(u).every(isWireValue)

/**
 * Read a cursor of either format, or `undefined` when it is malformed: not
 * base64 JSON, a v2 envelope of the wrong shape, or a legacy key whose values
 * are not `S` / `N` attribute values (the only ones it ever carried).
 */
export const decode = (text: string): CursorV2 | undefined => {
  let parsed: unknown
  try {
    parsed = text.startsWith(V2)
      ? JSON.parse(decoder.decode(fromBase64(text.slice(V2.length), true)))
      : JSON.parse(atob(text))
  } catch {
    return undefined
  }
  if (!text.startsWith(V2)) {
    if (!isRecord(parsed) || Object.keys(parsed).length === 0) return undefined
    const legacy = Object.values(parsed).every(
      (value) => isWireValue(value) && !("B" in (value as object)),
    )
    return legacy ? { v: 2, k: parsed as Record<string, WireValue> } : undefined
  }
  if (!isRecord(parsed) || parsed.v !== 2) return undefined
  const allowed = new Set(["v", "f", "s", "t", "k", "a", "d", "z", "c"])
  if (Object.keys(parsed).some((key) => !allowed.has(key))) return undefined
  if (parsed.f !== undefined && typeof parsed.f !== "string") return undefined
  if (parsed.s !== undefined && !(typeof parsed.s === "string" && PLAN_MODES.has(parsed.s))) {
    return undefined
  }
  if (parsed.t !== undefined && !isWireValue(parsed.t)) return undefined
  if (parsed.k !== undefined && !isWireKey(parsed.k)) return undefined
  if (parsed.a !== undefined && !isWireValue(parsed.a)) return undefined
  if (parsed.d !== undefined && parsed.d !== 1) return undefined
  if (parsed.c !== undefined && typeof parsed.c !== "string") return undefined
  if (parsed.z !== undefined) {
    if (!Array.isArray(parsed.z)) return undefined
    const valid = parsed.z.every((at) => at === 0 || at === 1 || isWireKey(at))
    if (!valid) return undefined
    const elsewhere = [parsed.k, parsed.a, parsed.d, parsed.t]
    if (elsewhere.some((field) => field !== undefined)) return undefined
  }
  const positions = [parsed.k, parsed.a, parsed.d].filter((field) => field !== undefined)
  if (positions.length > 1) return undefined
  return parsed as unknown as CursorV2
}

/**
 * The `ExclusiveStartKey` of a cursor {@link encodeKeyCursor} wrote, or
 * `undefined` when `text` isn't one: malformed by {@link decode}'s rules, or a
 * v2 envelope holding anything beside the key, as a planned or sharded query's
 * does. For a reader with no plan to place a cursor in. The key isn't checked
 * against the request: as on a query without a planner, that is DynamoDB's to
 * refuse, and a key of the right shape resumes from wherever it points.
 */
export const decodeKeyCursor = (text: string): Record<string, AttributeValue> | undefined => {
  const cursor = decode(text)
  if (cursor?.k === undefined) return undefined
  const keyOnly = Object.keys(cursor).every((field) => field === "v" || field === "k")
  return keyOnly ? keyFromWire(cursor.k) : undefined
}
