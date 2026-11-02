/**
 * @internal Garbage collection of offloaded values (#179, design §11): what
 * the collector (`BlobGc`) and `Entity.purge` share, and what each member
 * kind tells them about its rows.
 *
 * - **Ownership** (§11.2). A version is a member's **own** only when its key's
 *   `P/F` — the partition and item-family hashes of §4.5 — are the ones the
 *   member computes from its own physical table name and the row's partition
 *   and family, whatever leading prefix stands in front of them (an earlier
 *   `offload.prefix` or store prefix keeps a version own). Any other pointer a
 *   row holds is **foreign**: never a candidate, never listed, never deleted.
 * - **Holders.** Every pointer-shaped value on any top-level attribute of a
 *   row counts as a holder ({@link pointersOfRow}) — configured offloaded
 *   attribute or not — so a field whose `external` was switched off (§4.7)
 *   still keeps the versions its rows name. Rows are read whole: a query's
 *   read units are charged on the item size, not the projection.
 * - **The confirm-read** ({@link confirmRead}, §11.3): the family's ranges
 *   bracketed by strongly consistent `GetItem`s of its live key, retried up to
 *   three times while the live row changes in between (a restore, a retain
 *   update, an append) — `Option.none()` when it never settles ("family
 *   busy"): nothing is freed or deleted for it.
 * - **Sweep decisions** ({@link sweepVersions}, §11.4) and **purge's store
 *   step** ({@link purgeVersions}, §11.6).
 *
 * Members expose their support under {@link GcSupportId} (a symbol, not part
 * of any public type): `Entity.ts`, `Aggregate.ts` and `EventStore.ts` build
 * it inside their closures, where the key composers live.
 *
 * Not part of the public API.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import type { BlobPointer, BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { type Context, Duration, Effect, Option, Stream } from "effect"
import type { DynamoClientError, DynamoClientService } from "../DynamoClient.js"
import type { TableConfig } from "../Table.js"
import { attributeValueEquals } from "./AttributeValueEquals.js"
import { type BlobCallContext, call, callStream, refKey } from "./BlobCalls.js"
import { familyHash, type KeyAttributeValue, partitionHash } from "./BlobKeys.js"
import type { BlobListing, BlobStoreService } from "./BlobStoreContract.js"
import type { OffloadInfo } from "./OffloadWrite.js"
import { storedPointer } from "./StoredPointer.js"

// ---------------------------------------------------------------------------
// Member support
// ---------------------------------------------------------------------------

/** Where a member keeps its {@link GcSupport}. */
export const GcSupportId: unique symbol = Symbol.for("effect-dynamodb/GcSupport")

/**
 * The sort-key ranges of an entity item family (design §11.2's R1–R5):
 *
 * - `live` (R1): the live row and the time-series events nested under it;
 * - `snapshots` (R2) / `tombstones` (R3): the item's retain snapshots and
 *   soft-delete tombstones, under its item segment;
 * - `legacySnapshots` (R4) / `legacyTombstones` (R5): history an earlier
 *   release wrote without an item segment, kept when its composites compose
 *   the item's live key.
 *
 * An entity without sort-key composites has one item per partition: every
 * range is the partition's rows of the entity's type.
 */
export type FamilyRange =
  | "live"
  | "snapshots"
  | "tombstones"
  | "legacySnapshots"
  | "legacyTombstones"

/** Every range: what the sweeps, purge and `confirm: "always"` read. */
export const ALL_RANGES: ReadonlySet<FamilyRange> = new Set<FamilyRange>([
  "live",
  "snapshots",
  "tombstones",
  "legacySnapshots",
  "legacyTombstones",
])

/** The lifecycle features that copy pointers between an item family's rows. */
export interface Lifecycle {
  readonly retain: boolean
  readonly softDelete: boolean
  readonly timeSeries: boolean
}

/**
 * The ranges a member's current config can populate (§11.3, `confirm:
 * "auto"`): `retain` R1, R2, R4; `softDelete` R1, R3, R5; `timeSeries` R1.
 */
export const autoRanges = (lifecycle: Lifecycle): ReadonlySet<FamilyRange> => {
  const ranges = new Set<FamilyRange>(["live"])
  if (lifecycle.retain) {
    ranges.add("snapshots")
    ranges.add("legacySnapshots")
  }
  if (lifecycle.softDelete) {
    ranges.add("tombstones")
    ranges.add("legacyTombstones")
  }
  return ranges
}

/** An entity item family: the partition key and the live sort key (both `S`). */
export interface EntityFamily {
  readonly pk: string
  readonly liveSk: string
}

/** What GC reads of an entity member (built in `Entity.ts`). */
export interface EntityGcSupport {
  readonly kind: "entity"
  readonly entityType: string
  /** The table the entity is registered on (`Table.make`), `undefined` before. */
  readonly tableTag: () => Context.Service<TableConfig, TableConfig> | undefined
  readonly pkField: string
  readonly skField: string
  /** How the entity offloads, `undefined` when it offloads nothing. */
  readonly offload: OffloadInfo | undefined
  readonly lifecycle: Lifecycle
  /** The item family of a caller's key (the model's Type side, as every key-taking op). */
  readonly familyOfKey: (
    key: unknown,
    operation: string,
  ) => Effect.Effect<EntityFamily, ValidationError>
  /**
   * The live sort key of the item a stored row (unmarshalled, stored names)
   * belongs to — its live row, a time-series event, a snapshot or tombstone —
   * composed from the row's sort-key composites; `undefined` when they do not
   * compose.
   */
  readonly liveSkOfRow: (row: Readonly<Record<string, unknown>>) => string | undefined
  /**
   * The live sort keys a row with sort key `rowSk` may belong to, from the key
   * alone (the store-wide sweep has only the row key of an object's metadata):
   * `rowSk` itself (a live row), and its prefix before each time-series event
   * marker (an event row). The caller keeps the one whose family hash matches.
   */
  readonly liveSkCandidates: (rowSk: string) => ReadonlyArray<string>
  /** The family's rows in `ranges`: strongly consistent queries, every attribute. */
  readonly readFamily: (
    client: DynamoClientService,
    table: string,
    family: EntityFamily,
    ranges: ReadonlySet<FamilyRange>,
  ) => Effect.Effect<ReadonlyArray<Record<string, AttributeValue>>, DynamoClientError>
}

/** What GC reads of an aggregate member (built in `Aggregate.ts`). */
export interface AggregateGcSupport {
  readonly kind: "aggregate"
  /** The aggregate's name (its root entity type). */
  readonly name: string
  readonly tableTag: () => Context.Service<TableConfig, TableConfig>
  readonly pkField: string
  readonly skField: string
  /** How each edge entity type's items offload, by the type its items carry (`__edd_e__`). */
  readonly edges: ReadonlyMap<string, OffloadInfo>
  /**
   * Whether a partition key is one this aggregate composes (its head, continued after `#` when it
   * has composites). An edge entity's type alone does not make a row the aggregate's: the same
   * entity may also be used standalone on the table, whose rows hold its own history.
   */
  readonly ownsPartition: (pk: string) => boolean
  /** The partition key of an aggregate key. */
  readonly partitionOfKey: (
    key: unknown,
    operation: string,
  ) => Effect.Effect<string, ValidationError>
}

/** What GC reads of an EventStore stream (built in `EventStore.ts`). */
export interface StreamGcSupport {
  readonly kind: "stream"
  readonly name: string
  readonly tableTag: () => Context.Service<TableConfig, TableConfig>
  readonly pkField: string
  readonly skField: string
  /** `__edd_e__` of the stream's event items (`<stream>.event`). */
  readonly eventType: string
  /** `__edd_e__` of its snapshot item (`<stream>.snapshot`). */
  readonly snapshotType: string
  /** How event `data` offloads, `undefined` when it does not. */
  readonly event: OffloadInfo | undefined
  /** How snapshot `state` offloads, `undefined` when it does not. */
  readonly snapshot: OffloadInfo | undefined
  /** The stream's `offload.prefix`; the store's prefix when `undefined`. */
  readonly prefix: string | undefined
  /** The partition key of a stream id. */
  readonly partitionOfKey: (
    streamId: unknown,
    operation: string,
  ) => Effect.Effect<string, ValidationError>
}

export type GcSupport = EntityGcSupport | AggregateGcSupport | StreamGcSupport

/** The support a member carries, if it is a member GC can collect. */
export const supportOf = (member: unknown): GcSupport | undefined =>
  typeof member === "object" && member !== null
    ? ((member as { readonly [GcSupportId]?: GcSupport })[GcSupportId] ?? undefined)
    : undefined

// ---------------------------------------------------------------------------
// Pointers
// ---------------------------------------------------------------------------

/**
 * The pointer a stored attribute value holds, in any form a row or a stream
 * image carries it ({@link storedPointer}); `undefined` for anything else —
 * inline content, a native value, a malformed pointer.
 */
export const pointerOf = (value: unknown): BlobPointer | undefined =>
  Option.getOrUndefined(storedPointer(value))

/** Every pointer on any top-level attribute of `row` (DynamoDB JSON). */
export const pointersOfRow = (row: Readonly<Record<string, unknown>>): Array<BlobPointer> => {
  const out: Array<BlobPointer> = []
  for (const value of Object.values(row)) {
    const pointer = pointerOf(value)
    if (pointer !== undefined) out.push(pointer)
  }
  return out
}

/** The refs `rows` hold, by {@link refKey}. */
export const refsOfRows = (
  rows: Iterable<Readonly<Record<string, unknown>>>,
): Map<string, BlobRef> => {
  const refs = new Map<string, BlobRef>()
  for (const row of rows) {
    for (const pointer of pointersOfRow(row)) refs.set(refKey(pointer.ref), pointer.ref)
  }
  return refs
}

export const sameRef = (a: BlobRef, b: BlobRef): boolean =>
  a.key === b.key && a.version === b.version

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/** `P/F/` of an item family (§4.5). */
export const familySegment = (
  table: string,
  pk: KeyAttributeValue,
  familySk: KeyAttributeValue,
): string => {
  const partition = partitionHash(table, pk)
  return `${partition}/${familyHash(partition, familySk)}/`
}

/** `P/` of a partition (§4.5). */
export const partitionSegment = (table: string, pk: KeyAttributeValue): string =>
  `${partitionHash(table, pk)}/`

/** What follows a family segment in a library key: `O`. */
export const FAMILY_REST = /^[0-9a-f]{32}/
/** What follows a partition segment in a library key: `F/O`. */
export const PARTITION_REST = /^[0-9a-f]{32}\/[0-9a-f]{32}/

/**
 * The leading prefix of `key` when it lies under `segment` (a family's
 * `P/F/` or a partition's `P/`) — the part in front, an `offload.prefix` or
 * store prefix, current or earlier — or `undefined` when it does not: the
 * key is foreign to that family.
 */
export const leadingPrefix = (key: string, segment: string, rest: RegExp): string | undefined => {
  let at = key.indexOf(segment)
  while (at >= 0) {
    if (rest.test(key.slice(at + segment.length))) return key.slice(0, at)
    at = key.indexOf(segment, at + 1)
  }
  return undefined
}

/** `P/F/O` at the start of a string. */
const LIBRARY_KEY_AT = /^([0-9a-f]{32})\/([0-9a-f]{32})\/[0-9a-f]{32}/
/** The first `P/F/O` of a library key, from `lastIndex` on. */
const LIBRARY_KEY = /([0-9a-f]{32})\/([0-9a-f]{32})\/[0-9a-f]{32}/g

/** A listed key's family: its family prefix (`<leading>P/F/`) and the two hashes. */
export interface ListedFamily {
  readonly familyPrefix: string
  readonly partition: string
  readonly family: string
}

const familyAt = (key: string, at: number, partition: string, family: string): ListedFamily => ({
  familyPrefix: key.slice(0, at + partition.length + family.length + 2),
  partition,
  family,
})

/**
 * The family a listed key belongs to, or `undefined` for a key that is not a
 * library key. Its `P/F/O` is the one right after a `known` prefix (the
 * store's and the members' `offload.prefix`es, longest first) the key starts
 * with at or after `from` (the listed root's length) — so a known prefix with
 * a 32-hex-character segment of its own is never read as `P` — else, under an
 * earlier prefix, the first `P/F/O` at or after `from`. A key-per-write
 * store's suffix after `O` is ignored.
 */
export const listedFamily = (
  key: string,
  from: number,
  known: ReadonlyArray<string>,
): ListedFamily | undefined => {
  const under = known
    .filter((prefix) => prefix.length >= from && key.startsWith(prefix))
    .sort((a, b) => b.length - a.length)
  for (const prefix of under) {
    const match = LIBRARY_KEY_AT.exec(key.slice(prefix.length))
    if (match !== null) return familyAt(key, prefix.length, match[1]!, match[2]!)
  }
  LIBRARY_KEY.lastIndex = from
  const match = LIBRARY_KEY.exec(key)
  return match === null ? undefined : familyAt(key, match.index, match[1]!, match[2]!)
}

// ---------------------------------------------------------------------------
// The confirm-read (§11.3)
// ---------------------------------------------------------------------------

/** Attempts of the bracketed confirm-read before a family counts as busy. */
export const CONFIRM_ATTEMPTS = 3

const sameItem = (
  a: Record<string, AttributeValue> | undefined,
  b: Record<string, AttributeValue> | undefined,
): boolean =>
  a === undefined || b === undefined ? a === b : attributeValueEquals({ M: a }, { M: b })

/**
 * The refs every row of a family holds, read between two strongly consistent
 * `GetItem`s of its live key (`liveKey`): a transaction that creates a row
 * holding an existing pointer always writes the live row too (retain update
 * or delete, soft delete, restore, time-series append), so when the live row
 * is the same before and after, no holder appeared while `readRows` ran. A
 * live row that differs is read again, up to {@link CONFIRM_ATTEMPTS} times;
 * `Option.none()` when it never settles (the family is busy).
 */
export const confirmRead = (args: {
  readonly client: DynamoClientService
  readonly table: string
  readonly liveKey: Record<string, AttributeValue>
  readonly readRows: Effect.Effect<ReadonlyArray<Record<string, AttributeValue>>, DynamoClientError>
}): Effect.Effect<Option.Option<ReadonlyMap<string, BlobRef>>, DynamoClientError> => {
  const live = Effect.map(
    args.client.getItem({ TableName: args.table, Key: args.liveKey, ConsistentRead: true }),
    (result) => result.Item as Record<string, AttributeValue> | undefined,
  )
  const attempt = (
    n: number,
  ): Effect.Effect<Option.Option<ReadonlyMap<string, BlobRef>>, DynamoClientError> =>
    n === CONFIRM_ATTEMPTS
      ? Effect.succeed(Option.none())
      : Effect.gen(function* () {
          const before = yield* live
          const rows = yield* args.readRows
          const after = yield* live
          if (!sameItem(before, after)) return yield* attempt(n + 1)
          return Option.some(refsOfRows(after === undefined ? rows : [...rows, after]))
        })
  return attempt(0)
}

// ---------------------------------------------------------------------------
// Listing, marking and deleting
// ---------------------------------------------------------------------------

/**
 * How long after its last modification a version may still be an upload
 * whose DynamoDB write is in flight: the store's `maxUploadAge` plus 15
 * minutes of clock skew between writer and store (§11.4).
 */
export const inFlightAge = (store: BlobStoreService): Duration.Duration =>
  Duration.sum(store.maxUploadAge, Duration.minutes(15))

/** Every version under `prefix` (after `startAfter`), its failures wrapped, in a list span. */
export const listing = (
  store: BlobStoreService,
  ctx: BlobCallContext,
  prefix: string,
  startAfter?: string | undefined,
): Stream.Stream<BlobListing, BlobStoreError> =>
  callStream(store, "list", ctx, { key: prefix }, () =>
    store.list === undefined
      ? Stream.empty
      : store.list(prefix, startAfter === undefined ? undefined : { startAfter }),
  )

/** Every version under each of `prefixes` (deduplicated), in order. */
export const listAll = (
  store: BlobStoreService,
  ctx: BlobCallContext,
  prefixes: Iterable<string>,
): Effect.Effect<Array<BlobListing>, BlobStoreError> =>
  Effect.map(
    Effect.forEach([...new Set(prefixes)], (prefix) =>
      Stream.runCollect(listing(store, ctx, prefix)),
    ),
    (pages) => {
      const seen = new Set<string>()
      const out: Array<BlobListing> = []
      for (const version of pages.flat()) {
        const k = refKey(version.ref)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(version)
      }
      return out
    },
  )

/** Delete `refs` in one store call (nothing when empty). */
export const deleteRefs = (
  store: BlobStoreService,
  ctx: BlobCallContext,
  refs: ReadonlyArray<BlobRef>,
): Effect.Effect<void, BlobStoreError> =>
  refs.length === 0
    ? Effect.void
    : call(store, "delete", ctx, { ref: refs.length === 1 ? refs[0] : undefined }, () =>
        store.delete(refs),
      )

/** What a sweep did with the versions it listed. */
export interface SweepDecision {
  readonly marked: number
  readonly deleted: number
  readonly retainedYoung: number
}

/**
 * Decide each listed version (§11.4): referenced → keep; unreferenced and
 * modified within {@link inFlightAge} → keep unmarked (an upload whose write
 * may be in flight); older and unmarked → mark it unreferenced since `now`;
 * marked at least `grace` ago → delete (one store call); marked more
 * recently → keep. Only versions that can no longer be committed are marked,
 * and "no holder" is permanent, so a marked version never becomes referenced
 * again: the marks of referenced versions are never read.
 */
export const sweepVersions = (args: {
  readonly store: BlobStoreService
  readonly ctx: BlobCallContext
  readonly listed: ReadonlyArray<BlobListing>
  readonly referenced: ReadonlyMap<string, BlobRef>
  readonly grace: Duration.Duration
  readonly now: number
}): Effect.Effect<SweepDecision, BlobStoreError> =>
  Effect.gen(function* () {
    const { store, ctx } = args
    const marks = store.marks!
    const youngSince = args.now - Duration.toMillis(inFlightAge(store))
    const graceMillis = Duration.toMillis(args.grace)
    let marked = 0
    let retainedYoung = 0
    const doomed: Array<BlobRef> = []
    for (const version of args.listed) {
      if (args.referenced.has(refKey(version.ref))) continue
      if (version.lastModified.getTime() > youngSince) {
        retainedYoung++
        continue
      }
      const mark = yield* call(store, "mark", ctx, { ref: version.ref }, () =>
        marks.get(version.ref),
      )
      if (Option.isNone(mark)) {
        yield* call(store, "mark", ctx, { ref: version.ref }, () =>
          marks.set(version.ref, new Date(args.now)),
        )
        marked++
      } else if (args.now - mark.value.getTime() >= graceMillis) {
        doomed.push(version.ref)
      }
    }
    yield* deleteRefs(store, ctx, doomed)
    return { marked, deleted: doomed.length, retainedYoung }
  })

/**
 * Purge's store step (§11.6), after every DynamoDB delete succeeded and the
 * family was re-read: with `list`, delete each listed version under
 * `prefixes` that no row references (`referenced`) and that the purged rows
 * named (`named`) or that was last modified more than {@link inFlightAge}
 * ago — a younger unnamed one may be the upload of a write racing the purge,
 * left for the sweep. Without `list`, delete the named versions nothing
 * references.
 */
export const purgeVersions = (args: {
  readonly store: BlobStoreService
  readonly ctx: BlobCallContext
  readonly named: ReadonlyArray<BlobRef>
  readonly prefixes: Iterable<string>
  readonly referenced: ReadonlyMap<string, BlobRef>
  readonly now: number
}): Effect.Effect<number, BlobStoreError> =>
  Effect.gen(function* () {
    const { store, ctx, referenced } = args
    const named = new Map(args.named.map((ref) => [refKey(ref), ref]))
    let doomed: Array<BlobRef>
    if (store.list === undefined) {
      doomed = [...named.entries()].filter(([k]) => !referenced.has(k)).map(([, ref]) => ref)
    } else {
      const settledBefore = args.now - Duration.toMillis(inFlightAge(store))
      const listed = yield* listAll(store, ctx, args.prefixes)
      doomed = listed
        .filter((version) => {
          const k = refKey(version.ref)
          if (referenced.has(k)) return false
          return named.has(k) || version.lastModified.getTime() <= settledBefore
        })
        .map((version) => version.ref)
    }
    yield* deleteRefs(store, ctx, doomed)
    return doomed.length
  })
