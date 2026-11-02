/**
 * @internal The write side of offloaded fields (#179, design §6.1–§6.5,
 * §6.8, §6.13): which values of a row go to the blob store (per-field
 * thresholds, then the item budget), their uploads through the operation's
 * ledger, and the pointers that replace them in the request. (A write's
 * result reads what it stored through `OffloadRead`, its own uploads from the
 * ledger's read cache.)
 *
 * Everything here works on **stored** attribute names, after renames, sparse
 * flattening and packing: an overflow value arrives as its inline stored form
 * (a JSON string, or a v1 header byte + compressed bytes) and leaves as a `B`
 * pointer; a binary value arrives as its bytes and leaves as `~edbp:` text.
 *
 * Not part of the public API.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { CompressionRegistry } from "@effect-dynamodb/schema/Compression.js"
import type {
  CompressionCodec,
  ExternalConfig,
  ExternalPackedConfig,
} from "@effect-dynamodb/schema/DynamoModel.js"
import { type BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  type BlobPointer,
  type BlobPointerKind,
  decode as decodePointer,
  decodeText as decodePointerText,
  encode as encodePointer,
  encodeText as encodePointerText,
  isPointerHeader,
  isPointerText,
  make as makePointer,
} from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { ownValue, setOwn } from "@effect-dynamodb/schema/internal/OwnNames.js"
import { parseHeader } from "@effect-dynamodb/schema/internal/PackedCodec.js"
import { Cause, Effect, Exit, Option } from "effect"
import { BlobStore } from "../BlobStore.js"
import { toAttributeMap, toAttributeValue } from "../Marshaller.js"
import { blobError } from "./BlobCalls.js"
import { type KeyAttributeValue, objectKey } from "./BlobKeys.js"
import * as BlobLedger from "./BlobLedger.js"
import * as BlobMetadata from "./BlobMetadata.js"
import type { BlobStoreService } from "./BlobStoreContract.js"
import { attributeBytes, itemBytes, utf8Bytes } from "./ItemSize.js"
import { currentRegistry } from "./Packed.js"

// ---------------------------------------------------------------------------
// Member info
// ---------------------------------------------------------------------------

/** How one member offloads, keyed by stored attribute name. */
export interface OffloadInfo {
  readonly entityType: string
  /** Stored attribute → overflow config (`Packed({ external })`). */
  readonly overflow: Readonly<Record<string, ExternalPackedConfig>>
  /** Stored attribute → binary config (`External`). */
  readonly binary: Readonly<Record<string, ExternalConfig>>
  /** Stored attribute → domain field name. */
  readonly fieldOf: Readonly<Record<string, string>>
  /** `offload.itemBudget`: the whole-item size the router keeps an item under. */
  readonly itemBudget: number | undefined
  /** `offload.prefix`; the store's prefix when `undefined`. */
  readonly prefix: string | undefined
  /** The member's rows copy pointers (`retain`, `softDelete`, `timeSeries`). */
  readonly copiesPointers: boolean
}

/** The stored attributes of a member that may hold a pointer. */
export const offloadedAttributes = (info: OffloadInfo): ReadonlyArray<string> => [
  ...Object.keys(info.overflow),
  ...Object.keys(info.binary),
]

/** True iff `attribute` is one of the member's offloaded attributes. */
export const isOffloaded = (info: OffloadInfo, attribute: string): boolean =>
  Object.hasOwn(info.overflow, attribute) || Object.hasOwn(info.binary, attribute)

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** The row a write's uploads are for. */
export interface OffloadRow {
  /** The physical table name. */
  readonly table: string
  readonly pkAttribute: string
  readonly pk: KeyAttributeValue
  readonly skAttribute: string
  /** The item family's sort key: the live SK. */
  readonly sk: KeyAttributeValue
  /** The row's own sort key, when not the live SK (a time-series event item's). */
  readonly rowSk?: KeyAttributeValue | undefined
  /** The library operation, e.g. `"Entity.put"`. */
  readonly operation: string
  /**
   * The member's schema sets `escapeKeys: true`, which offloading requires
   * (design §11.10): object keys are named from the row's key text, so a
   * pointer row must be written only at its final text. {@link route} refuses
   * a row without it (`[EDD-9146]`), before anything is uploaded.
   */
  readonly escapeKeys: boolean
}

/** A key attribute value of a stored-name item (its composed `S` value, as a rule). */
export const keyValueOf = (value: unknown): KeyAttributeValue =>
  toAttributeValue(value) as KeyAttributeValue

const plainKeyValue = (value: KeyAttributeValue): unknown => {
  const v = value as { readonly S?: string; readonly N?: string; readonly B?: Uint8Array }
  return v.S ?? (v.N !== undefined ? Number(v.N) : v.B)
}

/** The row of a stored-name item whose key attributes are `pkAttribute` / `skAttribute`. */
export const rowOf = (
  item: Readonly<Record<string, unknown>>,
  keys: {
    readonly table: string
    readonly pkAttribute: string
    readonly skAttribute: string
    readonly operation: string
    /** The member's schema's `escapeKeys` (see {@link OffloadRow.escapeKeys}). */
    readonly escapeKeys: boolean
  },
): OffloadRow => ({
  table: keys.table,
  pkAttribute: keys.pkAttribute,
  pk: keyValueOf(item[keys.pkAttribute]),
  skAttribute: keys.skAttribute,
  sk: keyValueOf(item[keys.skAttribute]),
  operation: keys.operation,
  escapeKeys: keys.escapeKeys,
})

/**
 * The `[EDD-9146]` text: a member offloads on a schema without `escapeKeys:
 * true`. `what` names the member and its fields; `where` the bind site or the
 * write.
 */
export const unescapedKeysText = (where: string, what: string): string =>
  `[EDD-9146] ${where}: ${what}, but its table's schema doesn't set escapeKeys: true, which ` +
  "offloading requires. An offloaded value's object key is named from its row's key text and " +
  "S3 has no rename, so a row holding a pointer must be written only at its final key text and " +
  "never moved by rekey. Set DynamoSchema.make({ ..., escapeKeys: true }) — over existing rows, " +
  "run db.tables.<Table>.rekey() before serving traffic (see the offloaded storage guide)."

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const notProvided = (info: OffloadInfo, attribute: string, operation: string): BlobStoreError =>
  blobError(
    { entityType: info.entityType, attribute, operation },
    "put",
    "NotProvided",
    undefined,
    "no BlobStore is in context: provide one (DynamoClient.make({ blobStore }), BlobStore.layer, " +
      "or the S3 store's layer) where the operation runs or the client is bound",
  )

/** The store in context, if any (`Effect.serviceOption`: no requirement). */
const currentStore: Effect.Effect<BlobStoreService | undefined> = Effect.map(
  Effect.serviceOption(BlobStore),
  (store) => Option.getOrUndefined(store),
)

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const JSON_CONTENT_TYPE = "application/json"
const OCTET_STREAM = "application/octet-stream"

const decoder = new TextDecoder("utf-8", { fatal: true })

/** What one upload sends, derived from an attribute's inline stored value. */
interface Upload {
  readonly kind: BlobPointerKind
  readonly content: BlobLedger.LedgerContent
  readonly codec: CompressionCodec | "none"
  readonly body: Uint8Array | undefined
  readonly contentType: string
  readonly pointerContentType: string | undefined
  /** Bytes of the stored object. */
  readonly objectSize: number
  /** Bytes the checksum covers. */
  readonly contentSize: number | undefined
}

const invalid = (info: OffloadInfo, attribute: string, operation: string, message: string) =>
  new ValidationError({
    entityType: info.entityType,
    operation,
    cause: new Error(`Offloaded attribute "${attribute}": ${message}`),
  })

/**
 * The upload of an overflow attribute's inline stored value: its JSON text
 * (codec none, `application/json`), or the compressed payload after the
 * header byte (`application/octet-stream`, the content its decompression).
 * `contentSize` is left `undefined` for a compressed value when `measure`
 * only (routing): the pointer bound then counts the largest content size.
 */
const overflowUpload = (
  info: OffloadInfo,
  attribute: string,
  stored: string | Uint8Array,
  registry: CompressionRegistry | undefined,
  operation: string,
): Upload | ValidationError => {
  if (typeof stored === "string") {
    const bytes = utf8Bytes(stored)
    return {
      kind: "json",
      content: { kind: "json", text: stored },
      codec: "none",
      body: undefined,
      contentType: JSON_CONTENT_TYPE,
      pointerContentType: undefined,
      objectSize: bytes,
      contentSize: bytes,
    }
  }
  const header = stored.length === 0 ? "the stored value is empty" : parseHeader(stored[0]!)
  if (typeof header === "string") return invalid(info, attribute, operation, header)
  if (header.version !== 1) {
    return invalid(info, attribute, operation, "the value to upload is already a blob pointer")
  }
  const body = stored.slice(1)
  if (registry === undefined) {
    return {
      kind: "json",
      content: { kind: "json", text: "" },
      codec: header.codec,
      body,
      contentType: header.codec === "none" ? JSON_CONTENT_TYPE : OCTET_STREAM,
      pointerContentType: undefined,
      objectSize: body.length,
      contentSize: undefined,
    }
  }
  let payload: Uint8Array = body
  if (header.codec !== "none") {
    const compressor = registry.get(header.codec)
    if (compressor === undefined) {
      return invalid(info, attribute, operation, `no "${header.codec}" compressor is registered`)
    }
    try {
      payload = compressor.decompress(body)
    } catch (cause) {
      return new ValidationError({
        entityType: info.entityType,
        operation,
        cause: new Error(
          `Offloaded attribute "${attribute}": the "${header.codec}" decompressor failed`,
          { cause },
        ),
      })
    }
  }
  let text: string
  try {
    text = decoder.decode(payload)
  } catch (cause) {
    return new ValidationError({
      entityType: info.entityType,
      operation,
      cause: new Error(`Offloaded attribute "${attribute}": the payload is not UTF-8`, { cause }),
    })
  }
  return {
    kind: "json",
    content: { kind: "json", text },
    codec: header.codec,
    body: header.codec === "none" ? undefined : body,
    contentType: header.codec === "none" ? JSON_CONTENT_TYPE : OCTET_STREAM,
    pointerContentType: undefined,
    objectSize: body.length,
    contentSize: payload.length,
  }
}

/** The upload of a binary attribute's bytes. */
const binaryUpload = (config: ExternalConfig, bytes: Uint8Array): Upload => ({
  kind: "bytes",
  content: { kind: "bytes", bytes },
  codec: "none",
  body: undefined,
  contentType: config.contentType,
  pointerContentType: config.contentType,
  objectSize: bytes.length,
  contentSize: bytes.length,
})

/** Largest LEB128 content size a pointer can record (8 groups, every safe integer). */
const MAX_CONTENT_SIZE = Number.MAX_SAFE_INTEGER

/**
 * The bytes the attribute's pointer can take at most (design §6.3): the real
 * key extended by the store's `maxKeySuffixBytes`, a version of
 * `maxVersionBytes`, the real sizes (the largest content size when not yet
 * known) and the content type — in the attribute's stored form (`B` bytes for
 * an overflow value, the `~edbp:` text's UTF-8 bytes for a binary one).
 */
const pointerBound = (store: BlobStoreService, key: string, upload: Upload): number => {
  const pointer = makePointer({
    kind: upload.kind,
    codec: upload.codec,
    ref: {
      key: key + "k".repeat(store.limits.maxKeySuffixBytes),
      version: "v".repeat(store.limits.maxVersionBytes),
    },
    objectSize: upload.objectSize,
    contentSize: upload.contentSize ?? MAX_CONTENT_SIZE,
    checksum: { algorithm: "crc64nvme", value: new Uint8Array(8) },
    contentType: Option.fromNullishOr(upload.pointerContentType),
  })
  if (typeof pointer === "string") {
    throw new Error(`OffloadWrite: no pointer bound for "${key}": ${pointer}`)
  }
  return upload.kind === "json"
    ? encodePointer(pointer).length
    : utf8Bytes(encodePointerText(pointer))
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

const keyOf = (info: OffloadInfo, store: BlobStoreService, row: OffloadRow, attribute: string) =>
  objectKey(info.prefix ?? store.prefix, {
    table: row.table,
    pk: row.pk,
    familySk: row.sk,
    rowSk: row.rowSk ?? row.sk,
    attribute,
  })

/** The stored form of `pointer` on the attribute: `B` (overflow) or `~edbp:` text (binary). */
export const storedPointer = (pointer: BlobPointer): string | Uint8Array =>
  pointer.kind === "json" ? encodePointer(pointer) : encodePointerText(pointer)

const uploadOne = (
  info: OffloadInfo,
  store: BlobStoreService,
  row: OffloadRow,
  attribute: string,
  upload: Upload,
): Effect.Effect<BlobPointer, BlobStoreError> => {
  const rowSk = row.rowSk ?? row.sk
  return BlobLedger.upload({
    store,
    key: keyOf(info, store, row, attribute),
    content: upload.content,
    codec: upload.codec,
    body: upload.body,
    contentType: upload.contentType,
    pointerContentType: upload.pointerContentType,
    // Built from the ledger's own checksum of the content: computed once.
    metadata: (checksum) =>
      BlobMetadata.build({
        table: row.table,
        entity: info.entityType,
        attribute,
        pk: row.pk,
        sk: rowSk,
        kind: upload.kind,
        codec: upload.codec,
        checksum,
      }),
    target: {
      table: row.table,
      entityType: info.entityType,
      attribute,
      rowKey: {
        [row.pkAttribute]: plainKeyValue(row.pk),
        [row.skAttribute]: plainKeyValue(row.sk),
      },
      operation: row.operation,
      copiesPointers: info.copiesPointers,
    },
  })
}

/** The inline stored value of an offloaded attribute that can be uploaded, if any. */
const uploadable = (
  info: OffloadInfo,
  attribute: string,
  value: unknown,
): value is string | Uint8Array => {
  if (Object.hasOwn(info.binary, attribute)) return value instanceof Uint8Array
  if (!Object.hasOwn(info.overflow, attribute)) return false
  if (typeof value === "string") return true
  return value instanceof Uint8Array && value.length > 0 && !isPointerHeader(value[0]!)
}

const storedBytes = (value: string | Uint8Array): number =>
  typeof value === "string" ? utf8Bytes(value) : value.length

/** An overflow value at or above its threshold, or any binary value: offloaded whatever the item. */
const overThreshold = (info: OffloadInfo, attribute: string, value: string | Uint8Array): boolean =>
  Object.hasOwn(info.binary, attribute) ||
  storedBytes(value) >= info.overflow[attribute]!.external.threshold

/**
 * Run `f` over `items` concurrently and fail only once every one has settled
 * (design §6.2): an upload already sent is let finish rather than interrupted
 * by a sibling's failure, so the version it writes is registered with the
 * ledger and rolled back at exit — an interrupted one would leave a version no
 * entry names. Fails with the first failure in `items` order, preferring a
 * failure over an interruption.
 */
export const forEachSettled = <A, E>(
  items: Iterable<A>,
  f: (item: A) => Effect.Effect<void, E>,
): Effect.Effect<void, E> =>
  Effect.flatMap(
    Effect.forEach(items, (item) => Effect.exit(f(item)), { concurrency: "unbounded" }),
    (exits) => {
      let interrupted: Cause.Cause<E> | undefined
      for (const exit of exits) {
        if (Exit.isSuccess(exit)) continue
        if (!Cause.hasInterruptsOnly(exit.cause)) return Effect.failCause(exit.cause)
        interrupted ??= exit.cause
      }
      return interrupted === undefined ? Effect.void : Effect.failCause(interrupted)
    },
  )

/** What {@link route} decided. */
export interface Routed {
  /** The attributes it uploaded, now holding their pointers. */
  readonly uploaded: ReadonlySet<string>
}

/**
 * Route and upload a whole item (design §6.3), in place: every offloaded
 * attribute of `only` (default: all of them) at or above its threshold, every
 * binary one, then — when the member has an `itemBudget` and the item, with
 * those as pointers at their upper bound, is still over it — the remaining
 * overflow attributes by stored size, largest first (ties by name), until it
 * fits. The item may still exceed the budget (DynamoDB's own limit is then
 * diagnosed on failure). Each upload goes through the operation's ledger and
 * its pointer replaces the value. Attributes outside `only` keep what they
 * hold (a read-merge update's untouched pointers). Every upload is built
 * before any starts (a value that cannot be uploaded sends nothing to the
 * store), and a failed one fails the write only once the others have settled
 * ({@link forEachSettled}).
 *
 * Fails with `BlobStoreError { reason: "NotProvided" }` when a value must go
 * to the store and none is in context.
 */
export const route = (
  info: OffloadInfo,
  item: Record<string, unknown>,
  row: OffloadRow,
  only?: ReadonlySet<string>,
): Effect.Effect<Routed, BlobStoreError | ValidationError> =>
  Effect.gen(function* () {
    // Offloading requires escaped key text (design §11.10, `[EDD-9146]`). A
    // bound member was refused at bind; an unbound write is refused here,
    // before anything is uploaded or sent.
    if (!row.escapeKeys) {
      return yield* new ValidationError({
        entityType: info.entityType,
        operation: row.operation,
        cause: unescapedKeysText(
          row.operation,
          `${info.entityType} offloads ${offloadedAttributes(info)
            .map((attribute) => `"${info.fieldOf[attribute] ?? attribute}"`)
            .join(", ")}`,
        ),
      })
    }
    const candidates = offloadedAttributes(info).filter(
      (attribute) =>
        (only === undefined || only.has(attribute)) &&
        uploadable(info, attribute, ownValue(item, attribute)),
    )
    if (candidates.length === 0) return { uploaded: new Set<string>() }
    const out = new Set(
      candidates.filter((attribute) =>
        overThreshold(info, attribute, ownValue(item, attribute) as string | Uint8Array),
      ),
    )
    const store = yield* currentStore
    const budget = info.itemBudget
    if (budget !== undefined) {
      const marshalled = toAttributeMap(item)
      const measured = new Map<string, Upload>()
      const measure = (attribute: string): Upload | ValidationError => {
        const known = measured.get(attribute)
        if (known !== undefined) return known
        const value = ownValue(item, attribute) as string | Uint8Array
        const upload = Object.hasOwn(info.binary, attribute)
          ? binaryUpload(info.binary[attribute]!, value as Uint8Array)
          : overflowUpload(info, attribute, value, undefined, row.operation)
        if (!(upload instanceof ValidationError)) measured.set(attribute, upload)
        return upload
      }
      const bound = (
        attribute: string,
      ): Effect.Effect<number, BlobStoreError | ValidationError> => {
        if (store === undefined) return Effect.fail(notProvided(info, attribute, row.operation))
        const upload = measure(attribute)
        if (upload instanceof ValidationError) return Effect.fail(upload)
        return Effect.succeed(pointerBound(store, keyOf(info, store, row, attribute), upload))
      }
      const inline = (attribute: string): number => {
        const value = marshalled[attribute]
        return value === undefined ? 0 : attributeBytes(value)
      }
      let size = itemBytes(marshalled)
      for (const attribute of out) size += (yield* bound(attribute)) - inline(attribute)
      const rest = candidates
        .filter((attribute) => !out.has(attribute))
        .sort((a, b) => inline(b) - inline(a) || (a < b ? -1 : a > b ? 1 : 0))
      for (const attribute of rest) {
        if (size <= budget) break
        out.add(attribute)
        size += (yield* bound(attribute)) - inline(attribute)
      }
    }
    if (out.size === 0) return { uploaded: out }
    if (store === undefined) {
      return yield* notProvided(info, [...out][0]!, row.operation)
    }
    const registry = yield* currentRegistry
    const uploads: Array<readonly [attribute: string, upload: Upload]> = []
    for (const attribute of out) {
      const value = item[attribute] as string | Uint8Array
      const upload = Object.hasOwn(info.binary, attribute)
        ? binaryUpload(info.binary[attribute]!, value as Uint8Array)
        : overflowUpload(info, attribute, value, registry, row.operation)
      if (upload instanceof ValidationError) return yield* upload
      uploads.push([attribute, upload])
    }
    yield* forEachSettled(uploads, ([attribute, upload]) =>
      Effect.map(uploadOne(info, store, row, attribute, upload), (pointer) => {
        item[attribute] = storedPointer(pointer)
      }),
    )
    return { uploaded: out }
  })

/** One offloaded attribute an `UpdateItem` `SET`s: its `:value` token and stored name. */
export interface OffloadSet {
  readonly valKey: string
  readonly attr: string
}

/**
 * Upload, in place, the offloaded values an `UpdateItem` `SET`s (thresholds
 * only — the whole item is not in hand, §6.3): each binary value and each
 * overflow value at or above its threshold becomes, in `values`, the pointer
 * of a fresh upload; anything else stays as given. One {@link route} of all of
 * them, so every upload is built before any starts and a failed one fails the
 * write only once the others have settled.
 */
export const setValues = (
  info: OffloadInfo,
  sets: ReadonlyArray<OffloadSet>,
  values: Record<string, AttributeValue>,
  row: OffloadRow,
): Effect.Effect<void, BlobStoreError | ValidationError> => {
  const item: Record<string, unknown> = {}
  const valKeys = new Map<string, string>()
  for (const { valKey, attr } of sets) {
    const stored = values[valKey]
    if (stored === undefined || !isOffloaded(info, attr)) continue
    setOwn(item, attr, stored.S ?? stored.B)
    valKeys.set(attr, valKey)
  }
  if (valKeys.size === 0) return Effect.void
  return Effect.map(
    route({ ...info, itemBudget: undefined }, item, row, new Set(valKeys.keys())),
    ({ uploaded }) => {
      for (const attr of uploaded)
        values[valKeys.get(attr)!] = toAttributeValue(ownValue(item, attr))
    },
  )
}

// ---------------------------------------------------------------------------
// Stored pointers
// ---------------------------------------------------------------------------

/** The pointer an offloaded attribute's stored value is, if it is a well-formed one. */
export const pointerOf = (
  info: OffloadInfo,
  attribute: string,
  value: unknown,
): BlobPointer | undefined => {
  if (Object.hasOwn(info.overflow, attribute)) {
    if (!(value instanceof Uint8Array) || value.length === 0 || !isPointerHeader(value[0]!)) {
      return undefined
    }
    const pointer = decodePointer(value)
    return typeof pointer === "string" || pointer.kind !== "json" ? undefined : pointer
  }
  if (Object.hasOwn(info.binary, attribute)) {
    if (typeof value !== "string" || !isPointerText(value)) return undefined
    const pointer = decodePointerText(value)
    return pointer === undefined || typeof pointer === "string" || pointer.kind !== "bytes"
      ? undefined
      : pointer
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Immutables
// ---------------------------------------------------------------------------

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/**
 * Whether `content` (a restated value's JSON text, or its bytes) has the
 * pointer's content checksum and size — the fast path of an immutable
 * assertion (design §6.5): a match passes; a mismatch is confirmed by
 * fetching the stored value.
 */
export const matchesPointer = (pointer: BlobPointer, content: string | Uint8Array): boolean => {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
  return (
    bytes.length === pointer.contentSize &&
    pointer.checksum.algorithm === "crc64nvme" &&
    sameBytes(crc64nvme(bytes), pointer.checksum.value)
  )
}

// ---------------------------------------------------------------------------
// Bind-time check ([EDD-9115])
// ---------------------------------------------------------------------------

/** A bound member's offloaded fields, which need a store where it is bound. */
export interface StoreRequirement {
  /** The member, for the message: `entity "Documents"`, `aggregate "Order" (edge "Line")`. */
  readonly owner: string
  /** Its offloaded fields (domain names). */
  readonly fields: ReadonlyArray<string>
  /**
   * Its table's schema sets `escapeKeys: true`, which offloading requires
   * (`[EDD-9146]`); `undefined` when no schema is known yet (a definition on
   * no table), which the binding refuses on its own.
   */
  readonly escapeKeys: boolean | undefined
}

/** Whether a member's schema (`_schema`, configured by `Table.make`) sets `escapeKeys: true`. */
const escapeKeysOf = (schema: unknown): boolean | undefined =>
  typeof schema === "object" && schema !== null
    ? (schema as { readonly escapeKeys?: boolean }).escapeKeys === true
    : undefined

/** The store requirement of an entity (`entity.offload`), if it offloads anything. */
export const entityStoreRequirements = (
  owner: string,
  entity: unknown,
): ReadonlyArray<StoreRequirement> => {
  const member = entity as {
    readonly offload?:
      | { readonly overflow: ReadonlyArray<string>; readonly binary: ReadonlyArray<string> }
      | undefined
    readonly _schema?: unknown
  } | null
  const offload = member?.offload
  if (offload === undefined) return []
  return [
    {
      owner,
      fields: [...offload.overflow, ...offload.binary],
      escapeKeys: escapeKeysOf(member?._schema),
    },
  ]
}

/** The store requirements of an aggregate's edge entities (`_offloadByType`). */
export const aggregateStoreRequirements = (
  owner: string,
  aggregate: unknown,
): ReadonlyArray<StoreRequirement> => {
  const member = aggregate as {
    readonly _offloadByType?: ReadonlyMap<string, ReadonlyArray<string>> | undefined
    readonly _keySchema?: unknown
  } | null
  const byType = member?._offloadByType
  if (byType === undefined) return []
  return [...byType].map(([edgeType, fields]) => ({
    owner: `${owner} (edge "${edgeType}")`,
    fields,
    escapeKeys: escapeKeysOf(member?._keySchema),
  }))
}

/**
 * The `[EDD-9146]` configuration error for members that offload on a schema
 * without `escapeKeys: true` (design §11.10), or `undefined` when none does.
 * Checked before the store ({@link missingStoreError}): a store doesn't make
 * the key text right. `where` names the binding.
 */
export const unescapedKeysError = (
  where: string,
  requirements: ReadonlyArray<StoreRequirement>,
): Error | undefined => {
  const unescaped = requirements.filter((r) => r.escapeKeys === false)
  if (unescaped.length === 0) return undefined
  return new Error(
    unescapedKeysText(
      where,
      unescaped
        .map((r) => `${r.owner} offloads ${r.fields.map((field) => `"${field}"`).join(", ")}`)
        .join("; "),
    ),
  )
}

/**
 * The `[EDD-9115]` configuration error for members bound with no store
 * resolvable (`store` undefined), or `undefined` when there is one or nothing
 * offloads. `where` names the binding — `DynamoClient.make`, `Entity.bind`, ….
 */
export const missingStoreError = (
  where: string,
  requirements: ReadonlyArray<StoreRequirement>,
  store: BlobStoreService | undefined,
): Error | undefined => {
  if (store !== undefined || requirements.length === 0) return undefined
  const what = requirements
    .map((r) => `${r.owner} offloads ${r.fields.map((field) => `"${field}"`).join(", ")}`)
    .join("; ")
  return new Error(
    `[EDD-9115] ${where}: ${what}, but no BlobStore is resolvable. Every write of an ` +
      "offloaded field uploads it to the blob store and every read resolves its pointer there, " +
      "so provide one where the client is bound: DynamoClient.make({ blobStore }), or " +
      "BlobStore.layer(...) / the S3 store's layer merged into the application layer (see the " +
      "offloaded storage guide).",
  )
}
