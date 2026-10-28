/**
 * The row engine behind EventStore projections (#151, #153, #154, #155).
 *
 * One engine serves single-source projections (`EventStore.projection`, one
 * source and a scalar checkpoint) and multi-source projections
 * (`EventStore.multiProjection`, a checkpoint per source instance): a row is
 * read strongly consistent, each contributing instance's events are ordered,
 * deduplicated and gap-filled from the store, folded, and written once —
 * conditioned on the row's revision (or, without one, its checkpoint) — as
 * the row, a tombstone (#154), or either together with outbox items in one
 * transaction (#155).
 *
 * Internal: the public shapes live in `EventProjection.ts` / `MultiProjection.ts`.
 *
 * @internal
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { isConfiguredModel } from "@effect-dynamodb/schema/DynamoModel.js"
import {
  ConcurrentModification,
  type ConditionalCheckFailed,
  isAwsConditionalCheckFailed,
  isAwsTransactionCancelled,
  ProjectionSourceConflict,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { getSchemaFields } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import {
  DateTime,
  Duration as Dur,
  type Duration,
  Effect,
  Option,
  Random,
  Result,
  Schema as S,
  Schedule,
  type Schema,
} from "effect"
import { decodeMarshalledItem } from "../Entity.js"
import type { StreamEvent } from "../EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../Marshaller.js"
import type * as Query from "../Query.js"
import { resolveTtlAttributeName, type TableConfig } from "../Table.js"
import * as Capacity from "./Capacity.js"
import { condition as entityCondition } from "./EntityCombinators.js"
import type { EntityPutImpl } from "./EntityOps.js"
import { asReadGuard } from "./ExpressionLimits.js"
import {
  OUTBOX_CLAIM as CLAIM_TOKEN,
  OUTBOX_CLAIMED_UNTIL as CLAIMED_UNTIL,
  composePrimaryKey,
  generateTimestampPrimitive,
  KEY_TEXT,
  OUTBOX_ROW_PK as ROW_PK,
  OUTBOX_ROW_SK as ROW_SK,
  validateAndBuildPutItem,
} from "./TransactableOps.js"

// ---------------------------------------------------------------------------
// Removal (#154)
// ---------------------------------------------------------------------------

const RemoveRowTypeId: unique symbol = Symbol.for("effect-dynamodb/EventStore/RemoveRow")

/** What `evolve` returns to remove the row — see {@link removeRow}. */
export interface RemoveRow {
  readonly [RemoveRowTypeId]: typeof RemoveRowTypeId
}

/**
 * Returned from a projection's `evolve`, removes the row: the library writes a
 * tombstone at the row's key that keeps its checkpoints (and revision), so a
 * redelivery can't recreate it. A later event starts the row again from
 * `initial`. Requires `removal` on the projection.
 */
export const removeRow: RemoveRow = { [RemoveRowTypeId]: RemoveRowTypeId }

/** @internal */
export const isRemoveRow = (u: unknown): u is RemoveRow =>
  typeof u === "object" && u !== null && RemoveRowTypeId in u

// ---------------------------------------------------------------------------
// Skipping (#162)
// ---------------------------------------------------------------------------

const SkipEventTypeId: unique symbol = Symbol.for("effect-dynamodb/EventStore/SkipEvent")

/** What `evolve` returns to skip an event — see {@link skipEvent}. */
export interface SkipEvent {
  readonly [SkipEventTypeId]: typeof SkipEventTypeId
}

/**
 * Returned from a projection's `evolve`, skips the event: the fold carries on
 * with the state before it, no outbox effects are produced, and the event is
 * reported in `skipped`, never `applied`. A row whose events are all skipped
 * (or already applied) is not written, and its revision doesn't move. A
 * skipped event doesn't move its instance's checkpoint: the checkpoint rises
 * only to the instance's last applied or rejected event, so a skipped event
 * above it is read and decided again later.
 */
export const skipEvent: SkipEvent = { [SkipEventTypeId]: SkipEventTypeId }

/** @internal */
export const isSkipEvent = (u: unknown): u is SkipEvent =>
  typeof u === "object" && u !== null && SkipEventTypeId in u

/** The `__edd_e__` of a read model's tombstones. */
export const tombstoneMarker = (entityType: string): string => `${entityType}#tombstone`
/** The `__edd_e__` of a read model's outbox items. */
export const outboxMarker = (entityType: string): string => `${entityType}#outbox`

/** Attribute names the engine owns on tombstones and outbox items. */
export const REMOVED_AT = "__edd_removed__"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type AnyEvent = StreamEvent<unknown, unknown>

/** @internal The read-model entity, as far as the engine uses it. */
export interface EngineEntity {
  readonly entityType: string
  readonly model: Schema.Top
  readonly indexes: {
    readonly primary?: {
      readonly pk: { readonly field: string }
      readonly sk: { readonly field: string }
    }
  }
  readonly systemFields: {
    readonly createdAt: string | null
    readonly createdAtEncoding: unknown
  }
  readonly put: (input: any) => any
  readonly create: (input: any) => any
  readonly _tableTag: any
  readonly _renameToDynamo: (item: Record<string, unknown>) => void
  readonly _attachPrototype?: ((decoded: any) => any) | undefined
  readonly _multiItemWriteFeatures?: ReadonlyArray<string> | undefined
  readonly schemas: any
  // Rows still under their 1.36 keys (#171) — see `Entity`.
  readonly _primaryKey136: (
    key: Record<string, unknown>,
    force?: boolean,
  ) => Record<string, string> | undefined
  readonly _ownsRow136: (
    key: Record<string, unknown>,
    at: Record<string, unknown>,
    row: Record<string, AttributeValue>,
  ) => boolean
  readonly _spells136: (key: Record<string, unknown>) => boolean
  readonly _currentKeyOf136: (
    stored: Record<string, unknown>,
    force?: boolean,
  ) => { readonly current: Record<string, string> } | "same" | undefined
  readonly _clearAlias136: (
    key: Record<string, unknown>,
    operation: string,
  ) => Effect.Effect<any, any, any>
  readonly _displaceValueless136: (
    tableName: string,
    keys: { readonly pk: string; readonly sk: string },
    row: Record<string, AttributeValue>,
    operation: string,
  ) => Effect.Effect<boolean, any, any>
}

/** @internal One source a row engine reads. */
export interface EngineSource {
  readonly name: string
  readonly stream: {
    readonly streamName: string
    readonly eventMarker: string
    readonly streamIdFields: ReadonlyArray<string>
    parseStreamId(id: string): Effect.Effect<any, ValidationError>
    readFrom(id: any, after: number, options?: any): Effect.Effect<ReadonlyArray<any>, any, any>
    read(id: any, options?: any): Effect.Effect<ReadonlyArray<any>, any, any>
    readonly query: { events(id: any): Query.Query<any> }
    decodeStreamImage(image: any): Effect.Effect<Option.Option<any>, ValidationError, any>
  }
  /** `K`, or `Option<K>` (none: the event addresses no row). */
  readonly key: (streamId: any, event: any) => unknown
  readonly evolve: (state: any, event: any, context: EvolveContext) => Effect.Effect<any, any, any>
  readonly mode: "fold" | "latest"
  readonly terminal: ((error: any) => boolean) | undefined
}

/** What `evolve` is told about the event it folds. */
export interface EvolveContext {
  /** The source (a multi-source projection's name for it; `"projection"` otherwise). */
  readonly source: string
  /** The stream instance (`StreamEvent.streamId`). */
  readonly streamId: string
}

/** @internal Where a row keeps its checkpoints. */
export type CheckpointLayout =
  | { readonly kind: "scalar"; readonly field: string; readonly offset: number }
  | {
      readonly kind: "sources"
      /** A `Record<string, number>` model field, keyed `<source>#<streamId>`. */
      readonly map: string | undefined
      readonly fields: Readonly<
        Record<
          string,
          { readonly field: string; readonly offset: number; readonly instanceField: string }
        >
      >
    }

/** @internal */
export interface EngineOutbox {
  readonly schema: Schema.Codec<any, any>
  readonly effects: (event: any, next: any, context: EvolveContext) => ReadonlyArray<any>
  readonly table: { readonly Tag: any } | undefined
  readonly pk: string
  readonly sk: string
  readonly index: { readonly name: string; readonly pk: string; readonly sk: string } | undefined
  readonly claimFor: Duration.Duration
}

/** @internal */
export interface EngineConfig {
  readonly label: string
  readonly readModel: EngineEntity
  readonly sources: ReadonlyArray<EngineSource>
  readonly initial: (
    key: any,
    context: { readonly source: string; readonly streamId: any; readonly event: any },
  ) => any
  readonly checkpoints: CheckpointLayout
  /**
   * The library-owned revision field, incremented and conditioned on by every
   * write; `initial` is the value a row without one is written with.
   */
  readonly revision: { readonly field: string; readonly initial: number } | undefined
  readonly toItem: ((state: any, context: any) => any) | undefined
  readonly retry: Schedule.Schedule<unknown, unknown>
  readonly removal: { readonly ttl: Duration.Duration | undefined } | undefined
  readonly outbox: EngineOutbox | undefined
  /** Builds the context `toItem` receives for a row. */
  readonly toItemContext: (key: any, instances: ReadonlyArray<InstanceWork>) => any
}

// ---------------------------------------------------------------------------
// Work and results
// ---------------------------------------------------------------------------

/** @internal One source instance's share of a row's work. */
export interface InstanceWork {
  readonly source: EngineSource
  readonly streamIdStr: string
  readonly streamId: any
  /** The batch's events of this instance for this row, sorted and deduplicated; none: catch up to `top`. */
  readonly events: ReadonlyArray<AnyEvent> | undefined
  /** The highest version wanted when catching up (or rebuilding). */
  readonly top: number
  /** Versions of every batch event of this instance (any row, or none). */
  readonly delivered: ReadonlySet<number>
}

/** @internal One instance's result. */
export interface InstanceResult {
  readonly source: string
  readonly streamId: string
  readonly applied: ReadonlyArray<AnyEvent>
  readonly alreadyApplied: ReadonlyArray<AnyEvent>
  readonly rejected: ReadonlyArray<{ readonly event: AnyEvent; readonly error: unknown }>
  readonly superseded: ReadonlyArray<AnyEvent>
  /** The events `evolve` skipped (`skipEvent`), in version order. */
  readonly skipped: ReadonlyArray<AnyEvent>
  /** The instance's checkpoint after this call, in store numbering. */
  readonly version: number
}

/** @internal A row's result. */
export interface RowResult {
  readonly key: unknown
  readonly instances: ReadonlyArray<InstanceResult>
  readonly state: Option.Option<unknown>
  readonly removed: boolean
  readonly revision: number | undefined
  /** Outbox effects committed with this write. */
  readonly enqueued: number
  /** Instances that failed and were left out of the write (the others applied). */
  readonly failed: ReadonlyArray<{
    readonly source: string
    readonly streamId: string
    readonly error: unknown
  }>
}

/** The engine's own lost-race signal. */
class LostRace {
  constructor(readonly key: unknown) {}
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** A key's identity: its fields, sorted, as JSON. */
export const keyId = (key: unknown): string =>
  JSON.stringify(
    Object.entries(key as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )

/** `K | Option<K>` → `Option<K>`. */
export const addressed = <K>(key: unknown): Option.Option<K> =>
  Option.isOption(key) ? (key as Option.Option<K>) : Option.some(key as K)

/** A map checkpoint's key. */
export const instanceKey = (source: string, streamId: string): string => `${source}#${streamId}`

/**
 * @internal The read model's field names, `Hidden` ones included — through a
 * `DynamoModel.configure`d model to its schema (#160).
 */
export const modelFields = (model: unknown): ReadonlyArray<string> | undefined => {
  const schema = isConfiguredModel(model) ? (model.model as Schema.Top) : (model as Schema.Top)
  const fields = getSchemaFields(schema)
  return fields === undefined ? undefined : Object.keys(fields)
}

/** A row as read. */
interface Row {
  /** The model fields (with `Hidden` ones), or — for a tombstone — the kept checkpoint fields. */
  readonly values: Record<string, unknown>
  readonly tombstone: boolean
  readonly createdAt: unknown
  /** The row's 1.36 key, when it was read there (#171): the write moves it. */
  readonly at136?: Record<string, string> | undefined
  /** The row as stored, when it was read at its 1.36 key: the move deletes it only while it is so. */
  readonly stored?: Record<string, AttributeValue> | undefined
}

/** @internal */
export const makeEngine = (config: EngineConfig) => {
  const { readModel } = config
  const entityType = readModel.entityType
  const fields = modelFields(readModel.model)
  const createdAtField = readModel.systemFields.createdAt
  /** A domain field's stored attribute name. */
  const dbName = (field: string): string => {
    const probe: Record<string, unknown> = { [field]: 1 }
    readModel._renameToDynamo(probe)
    return Object.keys(probe)[0] ?? field
  }
  const primary = readModel.indexes.primary!
  const call = <X>(name: string, f: () => X): Effect.Effect<X, ValidationError> =>
    Effect.try({
      try: f,
      catch: (cause) =>
        new ValidationError({ entityType, operation: `${config.label}.${name}`, cause }),
    })

  /** The checkpoint and revision fields a tombstone keeps. */
  const keptFields: ReadonlyArray<string> = (() => {
    const kept = new Set<string>()
    if (config.revision !== undefined) kept.add(config.revision.field)
    const layout = config.checkpoints
    if (layout.kind === "scalar") kept.add(layout.field)
    else {
      if (layout.map !== undefined) kept.add(layout.map)
      for (const f of Object.values(layout.fields)) {
        kept.add(f.field)
        kept.add(f.instanceField)
      }
    }
    return [...kept]
  })()

  // Resolved when it runs: an entity's table is set when it is registered on
  // one, which may come after the projection is defined.
  // Rows may be tombstones (#154): the entity's `create` takes one's place,
  // keeping these fields — the checkpoints — and the revision one higher.
  if (config.removal !== undefined) {
    ;(readModel as { _projectionTombstones?: unknown })._projectionTombstones = {
      kept: keptFields.filter((f) => f !== config.revision?.field),
      revision: config.revision?.field,
    }
  }

  const tableName = Effect.suspend(() =>
    Effect.map(readModel._tableTag as Effect.Effect<TableConfig>, (tc) => tc.name),
  )

  /**
   * The row, read strongly consistent — raw, so a tombstone reads as one. A
   * row 1.36 wrote under a key whose text changed (#171) is read there when
   * its current key holds none, as the read model's own reads do: judged by
   * its values (`_ownsRow136`; a tombstone, which holds none, by its key and
   * `KEY_TEXT`), another value's 1.36 row at the current key is no row, nor
   * is that value's current row at the 1.36 key. A row found at its 1.36 key
   * carries it (`at136`), so the write moves it.
   */
  const readRow = (key: unknown): Effect.Effect<Option.Option<Row>, any, any> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const TableName = yield* tableName
      const rowKey = key as Record<string, unknown>
      const read = (at: Record<string, unknown>) =>
        client
          .getItem({ TableName, Key: toAttributeMap(at), ConsistentRead: true })
          .pipe(Effect.map((result) => result.Item))
      const current = composePrimaryKey(readModel as any, rowKey)
      let item = yield* read(current)
      if (item !== undefined && !readModel._ownsRow136(rowKey, current, item)) item = undefined
      let at136: Record<string, string> | undefined
      if (item === undefined) {
        const old = readModel._primaryKey136(rowKey)
        if (old !== undefined) {
          const held = yield* read(old)
          if (held !== undefined && readModel._ownsRow136(rowKey, old, held)) {
            item = held
            at136 = old
          }
        }
      }
      if (item === undefined) return Option.none<Row>()
      const moving = at136 === undefined ? {} : { at136, stored: item }
      if (item.__edd_e__?.S === tombstoneMarker(entityType)) {
        const raw = fromAttributeMap(item) as Record<string, unknown>
        const values: Record<string, unknown> = {}
        for (const f of keptFields) {
          const v = raw[dbName(f)]
          if (v !== undefined) values[f] = v
        }
        return Option.some<Row>({ values, tombstone: true, createdAt: undefined, ...moving })
      }
      const decoded = (yield* decodeMarshalledItem(readModel as any, item)) as Record<
        string,
        unknown
      >
      let values: Record<string, unknown> = decoded
      if (fields !== undefined) {
        values = {}
        for (const f of fields) if (decoded[f] !== undefined) values[f] = decoded[f]
      }
      return Option.some<Row>({
        values: readModel._attachPrototype?.(values) ?? values,
        tombstone: false,
        createdAt: createdAtField === null ? undefined : decoded[createdAtField],
        ...moving,
      })
    })

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  /** Where an instance's checkpoint lives on a row, and its value. */
  interface Slot {
    readonly kind: "scalar" | "field" | "map"
    readonly at: number
    /** The instance claimed a field with no recorded owner, in this attempt. */
    readonly adopted?: true
  }

  /**
   * `claimed` records, per field-mapped source, the instance that owns its
   * field in this attempt — so two instances of one source never both take it.
   * `adopt: false` reads an unowned field without claiming it (#162): the
   * instance won't write it, so the next instance of its source may.
   */
  const slotOf = (
    row: Option.Option<Row>,
    source: string,
    streamIdStr: string,
    claimed: Map<string, string>,
    adopt: boolean,
  ): Slot | ProjectionSourceConflict => {
    const values = Option.isSome(row) ? row.value.values : undefined
    const layout = config.checkpoints
    if (layout.kind === "scalar") {
      const v = values?.[layout.field]
      return { kind: "scalar", at: v === undefined ? 0 : Number(v) - layout.offset }
    }
    const mapped = layout.fields[source]
    const fromMap = (): Slot => {
      const map = (values?.[layout.map!] ?? {}) as Record<string, number>
      const v = map[instanceKey(source, streamIdStr)]
      return { kind: "map", at: v === undefined ? 0 : Number(v) }
    }
    if (mapped === undefined) return fromMap()
    const stored = values?.[mapped.instanceField]
    const owner = claimed.get(source) ?? (stored === null || stored === "" ? undefined : stored)
    const scalar = values?.[mapped.field]
    const at = scalar === undefined ? 0 : Number(scalar) - mapped.offset
    // No owner recorded: a new row, or a legacy one — adopted by this instance.
    if (owner === undefined && !adopt) return { kind: "field", at }
    if (owner === undefined || owner === streamIdStr) {
      claimed.set(source, streamIdStr)
      return owner === undefined ? { kind: "field", at, adopted: true } : { kind: "field", at }
    }
    if (layout.map !== undefined) return fromMap()
    return new ProjectionSourceConflict({
      entityType,
      source,
      recorded: String(owner),
      arriving: streamIdStr,
    })
  }

  /** The row's revision, when the projection keeps one. */
  const revisionOf = (row: Option.Option<Row>): number | undefined => {
    if (config.revision === undefined || Option.isNone(row)) return undefined
    const v = row.value.values[config.revision.field]
    return v === undefined ? undefined : Number(v)
  }

  /** The revision the next write stores: one higher, or `initial` for a row without one. */
  const nextRevisionOf = (row: Option.Option<Row>): number => {
    const current = revisionOf(row)
    return current === undefined ? config.revision!.initial : current + 1
  }

  /** Write the instances' new checkpoints (and the next revision) onto `target`. */
  const stamp = (
    target: Record<string, unknown>,
    row: Option.Option<Row>,
    advanced: ReadonlyArray<{
      readonly source: string
      readonly streamIdStr: string
      readonly slot: Slot
      readonly version: number
    }>,
  ): void => {
    const layout = config.checkpoints
    const previous = Option.isSome(row) ? row.value.values : undefined
    if (layout.kind === "scalar") {
      for (const a of advanced) target[layout.field] = a.version + layout.offset
    } else {
      // Carry every field the layout owns over from the row, then advance.
      for (const f of Object.values(layout.fields)) {
        if (target[f.field] === undefined && previous?.[f.field] !== undefined)
          target[f.field] = previous[f.field]
        if (target[f.instanceField] === undefined && previous?.[f.instanceField] !== undefined) {
          target[f.instanceField] = previous[f.instanceField]
        }
      }
      const map: Record<string, number> =
        layout.map === undefined
          ? {}
          : { ...((previous?.[layout.map] ?? {}) as Record<string, number>) }
      for (const a of advanced) {
        if (a.slot.kind === "field") {
          const mapped = layout.fields[a.source]!
          target[mapped.field] = a.version + mapped.offset
          target[mapped.instanceField] = a.streamIdStr
        } else map[instanceKey(a.source, a.streamIdStr)] = a.version
      }
      // An empty map stays absent on a row that had none.
      if (
        layout.map !== undefined &&
        (Object.keys(map).length > 0 || previous?.[layout.map] !== undefined)
      )
        target[layout.map] = map
    }
    if (config.revision !== undefined) target[config.revision.field] = nextRevisionOf(row)
  }

  /** The write's condition — the revision read, else the scalar checkpoint read. */
  const guard = (
    row: Option.Option<Row>,
  ): { readonly input: Record<string, unknown> | undefined; readonly raw: RawCondition } => {
    if (config.revision !== undefined) {
      const rev = revisionOf(row)
      const name = dbName(config.revision.field)
      return rev === undefined
        ? {
            input: Option.isSome(row) ? { attributeNotExists: config.revision.field } : undefined,
            raw: { expression: "attribute_not_exists(#g)", names: { "#g": name }, values: {} },
          }
        : {
            input: { eq: { [config.revision.field]: rev } },
            raw: {
              expression: "#g = :g",
              names: { "#g": name },
              values: toAttributeMap({ ":g": rev }),
            },
          }
    }
    const layout = config.checkpoints as { readonly field: string; readonly offset: number }
    if (Option.isNone(row)) {
      return {
        input: undefined,
        raw: {
          expression: "attribute_not_exists(#g)",
          names: { "#g": primary.pk.field },
          values: {},
        },
      }
    }
    const stored = row.value.values[layout.field]
    // A row written before the projection: no checkpoint yet.
    if (stored === undefined) {
      return {
        input: { attributeNotExists: layout.field },
        raw: {
          expression: "attribute_not_exists(#g)",
          names: { "#g": dbName(layout.field) },
          values: {},
        },
      }
    }
    return {
      input: { eq: { [layout.field]: stored } },
      raw: {
        expression: "#g = :g",
        names: { "#g": dbName(layout.field) },
        values: toAttributeMap({ ":g": stored }),
      },
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** An outbox item to write with the row. */
  interface Enqueued {
    readonly effect: unknown
    readonly event: AnyEvent
    readonly source: string
  }

  const outboxTable = Effect.gen(function* () {
    if (config.outbox?.table === undefined) return yield* tableName
    const tc = (yield* config.outbox.table.Tag) as TableConfig
    return tc.name
  })

  /** The outbox items' key attribute names (the row table's, or the outbox table's). */
  const outboxKeys = () =>
    config.outbox?.table === undefined
      ? { pk: primary.pk.field, sk: primary.sk.field }
      : { pk: config.outbox.pk, sk: config.outbox.sk }

  const pad = (n: number, width: number) => String(n).padStart(width, "0")

  const outboxItems = (
    rowKey: Record<string, unknown>,
    revision: number,
    enqueued: ReadonlyArray<Enqueued>,
    marked: boolean,
  ): Effect.Effect<ReadonlyArray<Record<string, AttributeValue>>, ValidationError> =>
    Effect.forEach(enqueued, (e, i) =>
      Effect.gen(function* () {
        const outbox = config.outbox!
        const encoded = yield* S.encodeUnknownEffect(outbox.schema)(e.effect).pipe(
          Effect.mapError(
            (cause) =>
              new ValidationError({ entityType, operation: `${config.label}.outbox`, cause }),
          ),
        )
        const keys = outboxKeys()
        const rowPk = String(rowKey[primary.pk.field])
        const rowSk = String(rowKey[primary.sk.field])
        const sk = `${rowSk}#outbox#${pad(revision, 12)}#${pad(i, 4)}`
        const item: Record<string, unknown> = {
          [keys.pk]: rowPk,
          [keys.sk]: sk,
          __edd_e__: outboxMarker(entityType),
          [ROW_PK]: rowPk,
          [ROW_SK]: rowSk,
          effect: encoded,
          source: e.source,
          streamId: e.event.streamId,
          version: e.event.version,
          eventType: e.event.eventType,
          ...(marked && { [KEY_TEXT]: 1 }),
        }
        if (outbox.index !== undefined) {
          item[outbox.index.pk] = outboxMarker(entityType)
          item[outbox.index.sk] = `${rowPk}#${sk}`
        }
        return toAttributeMap(item)
      }),
    )

  /**
   * A lost race, from a single write's or a transaction's failure: the row's
   * Put, or — moving it from its 1.36 key — that row's Delete, cancelled.
   */
  const lostRaceOf = (error: unknown, transaction: boolean): boolean => {
    const cause = (error as { readonly cause?: unknown })?.cause
    if (!transaction) return isAwsConditionalCheckFailed(cause)
    return (
      isAwsTransactionCancelled(cause) &&
      (cause.CancellationReasons ?? []).some((reason) => reason?.Code === "ConditionalCheckFailed")
    )
  }

  /** The row (or tombstone) and any outbox items, written as one conditional unit. */
  const writeRow = (
    key: unknown,
    target: Option.Option<Record<string, unknown>>,
    kept: Record<string, unknown>,
    row: Option.Option<Row>,
    enqueued: ReadonlyArray<Enqueued>,
    revision: number | undefined,
  ): Effect.Effect<Option.Option<unknown>, any, any> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const TableName = yield* tableName
      const rowKey = composePrimaryKey(readModel as any, key as Record<string, unknown>)
      const condition = guard(row)
      const createdAt = Option.isSome(row) ? row.value.createdAt : undefined
      // A tombstone or outbox item holds no values: one under a key whose
      // text differs from 1.36's is marked as written under its current key
      // (#171, `KEY_TEXT`) — whatever the fallback is set to, since `rekey`
      // reads every key — and one under unchanged text is as 1.36 wrote it.
      const marked = readModel._primaryKey136(key as Record<string, unknown>, true) !== undefined

      // The row's item: the entity's own `put` (no outbox), or built for a
      // transaction. A row over a tombstone under a key whose text changed is
      // built too: the entity's `put` would judge the tombstone by values it
      // doesn't hold, and moves it unmarked from its 1.36 key (#171).
      let rowItem: Record<string, AttributeValue> | undefined
      if (Option.isNone(target)) {
        // A tombstone: the key, the kept checkpoint fields, the revision.
        const tc = (yield* readModel._tableTag) as TableConfig
        const now = yield* DateTime.now
        const tomb: Record<string, unknown> = {
          ...rowKey,
          __edd_e__: tombstoneMarker(entityType),
          [REMOVED_AT]: DateTime.formatIso(now),
          ...(marked && { [KEY_TEXT]: 1 }),
        }
        for (const [f, v] of Object.entries(kept)) tomb[dbName(f)] = v
        if (config.removal?.ttl !== undefined) {
          tomb[resolveTtlAttributeName(tc)] = Math.floor(
            (DateTime.toEpochMillis(now) + Dur.toMillis(config.removal.ttl)) / 1000,
          )
        }
        rowItem = toAttributeMap(tomb)
      } else if (
        enqueued.length > 0 ||
        (Option.isSome(row) &&
          row.value.tombstone &&
          readModel._primaryKey136(key as Record<string, unknown>) !== undefined)
      ) {
        const built = yield* validateAndBuildPutItem(
          readModel as any,
          target.value,
          `${config.label}.write`,
        )
        const item = { ...built.item }
        if (createdAtField !== null && DateTime.isDateTime(createdAt)) {
          item[dbName(createdAtField)] = generateTimestampPrimitive(
            DateTime.toUtc(createdAt),
            readModel.systemFields.createdAtEncoding as any,
          )
        }
        rowItem = toAttributeMap(item)
      }

      if (rowItem === undefined) {
        // The row alone, through the entity: `put` conditioned on the guard
        // (keeping the row's `createdAt`), or `create` for a new row.
        const value = target.pipe(Option.getOrThrow)
        const op =
          condition.input === undefined
            ? readModel.create(value)
            : (entityCondition(
                readModel.put(value),
                condition.input as never,
              ) as unknown as EntityPutImpl<any, any, any, any>)
        const run =
          condition.input === undefined
            ? (op.asEffect() as Effect.Effect<unknown, any, any>)
            : (op as EntityPutImpl<any, any, any, any>)._builder("model", {
                condition: (op as EntityPutImpl<any, any, any, any>)._condition,
                withVectors: (op as EntityPutImpl<any, any, any, any>)._withVectors,
                putKind: (op as EntityPutImpl<any, any, any, any>)._putKind,
                createdAt: DateTime.isDateTime(createdAt) ? DateTime.toUtc(createdAt) : undefined,
              })
        const written = yield* (run as Effect.Effect<unknown, any, any>).pipe(
          Effect.catchTag("ConditionalCheckFailed", () => Effect.fail(new LostRace(key))),
        )
        return Option.some(written)
      }

      // A row read at its 1.36 key (#171) moves in the same write: put at its
      // current key, where nothing may be, and deleted at its 1.36 key only
      // while it is as read. Another value's 1.36 row at the current key fails
      // a write that expects nothing there: it is moved out of the way, as the
      // entity's own writes move it, and the write is read again. So is
      // another value's outbox item 1.36 left where one of this write's goes:
      // a key that reads back as another value's 1.36 key can hold them, so
      // there each Put requires its key empty.
      const at136 = Option.isSome(row) ? row.value.at136 : undefined
      const OutboxTable = yield* outboxTable
      const keys = outboxKeys()
      const sharedKey = typeof readModel._currentKeyOf136(rowKey) === "object"
      const moved: ReadonlyArray<TransactWriteItem> =
        at136 === undefined
          ? []
          : [
              {
                Delete: {
                  TableName,
                  Key: toAttributeMap(at136),
                  ...asReadGuard(
                    (row as Option.Some<Row>).value.stored!,
                    primary.pk.field,
                    config.revision === undefined ? [] : [dbName(config.revision.field)],
                  ),
                },
              },
            ]
      const outboxAt = 1 + moved.length
      const lostRace = (error: unknown, transaction: boolean) =>
        lostRaceOf(error, transaction)
          ? Effect.gen(function* () {
              if (Option.isNone(row) || at136 !== undefined) {
                yield* readModel._clearAlias136(key as Record<string, unknown>, config.label)
              }
              const reasons = transaction
                ? ((error as { readonly cause?: { readonly CancellationReasons?: any } }).cause
                    ?.CancellationReasons ?? [])
                : []
              for (const reason of reasons.slice(outboxAt)) {
                if (reason?.Code === "ConditionalCheckFailed" && reason.Item !== undefined) {
                  yield* readModel._displaceValueless136(
                    OutboxTable,
                    keys,
                    reason.Item,
                    config.label,
                  )
                }
              }
              return yield* Effect.fail(new LostRace(key))
            })
          : Effect.fail(error)
      const rowPut = {
        Put: {
          TableName,
          Item: rowItem,
          ...(at136 === undefined
            ? {
                ConditionExpression: condition.raw.expression,
                ExpressionAttributeNames: condition.raw.names,
                ...(Object.keys(condition.raw.values).length > 0
                  ? { ExpressionAttributeValues: condition.raw.values }
                  : {}),
              }
            : {
                ConditionExpression: "attribute_not_exists(#g)",
                ExpressionAttributeNames: { "#g": primary.pk.field },
              }),
        },
      } satisfies TransactWriteItem
      if (enqueued.length === 0 && at136 === undefined) {
        yield* client.putItem(rowPut.Put).pipe(Effect.catch((error) => lostRace(error, false)))
      } else {
        const items = yield* outboxItems(rowKey, revision ?? 0, enqueued, marked)
        yield* client
          .transactWriteItems({
            TransactItems: [
              rowPut,
              ...moved,
              ...items.map(
                (Item) =>
                  ({
                    Put: {
                      TableName: OutboxTable,
                      Item,
                      ...(sharedKey && {
                        ConditionExpression: "attribute_not_exists(#opk)",
                        ExpressionAttributeNames: { "#opk": keys.pk },
                        ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
                      }),
                    },
                  }) satisfies TransactWriteItem,
              ),
            ],
          })
          .pipe(Effect.catch((error) => lostRace(error, true)))
      }
      return target
    })

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------

  /** Every version from `from` to the last of `events` was delivered. */
  const coveredFrom = (
    events: ReadonlyArray<AnyEvent>,
    from: number,
    delivered: ReadonlySet<number>,
  ): boolean => {
    const own = new Set(events.map((e) => e.version))
    const last = events[events.length - 1]!.version
    for (let v = from; v <= last; v++) if (!own.has(v) && !delivered.has(v)) return false
    return true
  }

  const gapError = (streamId: string, from: number, to: number) =>
    Effect.fail(
      new ValidationError({
        entityType,
        operation: config.label,
        cause:
          `Stream ${JSON.stringify(streamId)} is missing events between versions ${from} and ` +
          `${to}: a strongly consistent read did not return them. Was the stream written ` +
          "outside `append`?",
      }),
    )

  const withRetry = <X>(attempt: Effect.Effect<X, any, any>): Effect.Effect<X, any, any> =>
    Effect.retry(attempt, {
      schedule: config.retry,
      while: (error: unknown) => error instanceof LostRace,
    }).pipe(
      Effect.mapError((error) =>
        error instanceof LostRace
          ? new ConcurrentModification({
              entityType,
              key: error.key as Record<string, unknown>,
              attributes: [
                config.revision?.field ?? (config.checkpoints as { field: string }).field,
              ],
              current: Option.none(),
            })
          : error,
      ),
    )

  /** The row's events of one instance: its checkpoint, what to fold, what was already in. */
  const runOf = (
    rowId: string,
    slotAt: number,
    work: InstanceWork,
  ): Effect.Effect<
    { readonly run: ReadonlyArray<AnyEvent>; readonly alreadyApplied: ReadonlyArray<AnyEvent> },
    any,
    any
  > =>
    Effect.gen(function* () {
      const alreadyApplied = work.events?.filter((e) => e.version <= slotAt) ?? []
      const pending = work.events?.filter((e) => e.version > slotAt)
      if (pending !== undefined ? pending.length === 0 : slotAt >= work.top) {
        return { run: [], alreadyApplied }
      }
      // `latest` reads nothing: its candidates are the batch's events.
      if (work.source.mode === "latest" && pending !== undefined)
        return { run: pending, alreadyApplied }
      if (pending !== undefined && coveredFrom(pending, slotAt + 1, work.delivered)) {
        return { run: pending, alreadyApplied }
      }
      const upTo = pending === undefined ? work.top : pending[pending.length - 1]!.version
      const read = (yield* work.source.stream.readFrom(work.streamId, slotAt, {
        consistentRead: true,
        toVersion: upTo,
      })) as ReadonlyArray<AnyEvent>
      let last = slotAt
      for (const e of read) {
        if (e.version !== last + 1) return yield* gapError(work.streamIdStr, last + 1, upTo)
        last = e.version
      }
      if (last < upTo) return yield* gapError(work.streamIdStr, last + 1, upTo)
      const mine: Array<AnyEvent> = []
      for (const e of read) {
        const key = addressed(yield* call("key", () => work.source.key(work.streamId, e)))
        if (Option.isSome(key) && keyId(key.value) === rowId) mine.push(e)
      }
      return { run: mine, alreadyApplied }
    })

  /**
   * Apply a row's work: read, gap-fill per instance, fold in a deterministic
   * order (sources as declared, then stream id, then version), write once.
   * `fromScratch` folds from `initial` ignoring the row's state (rebuild).
   */
  const applyRow = (
    key: unknown,
    work: ReadonlyArray<InstanceWork>,
    options?: { readonly fromScratch?: boolean | undefined },
  ): Effect.Effect<RowResult, any, any> => {
    const rowId = keyId(key)
    const ordered = [...work].sort((a, b) => {
      const sa = config.sources.indexOf(a.source)
      const sb = config.sources.indexOf(b.source)
      return sa !== sb
        ? sa - sb
        : a.streamIdStr < b.streamIdStr
          ? -1
          : a.streamIdStr > b.streamIdStr
            ? 1
            : 0
    })
    const fromScratch = options?.fromScratch === true
    const attempt = Effect.gen(function* () {
      const row = yield* readRow(key)
      type Plan = {
        readonly work: InstanceWork
        readonly slot: Slot
        /** The events to fold — in `latest` mode, the candidates, newest tried first. */
        readonly run: ReadonlyArray<AnyEvent>
        readonly alreadyApplied: ReadonlyArray<AnyEvent>
      }
      /**
       * Instances that failed (not by `terminal`): left out of this write —
       * their checkpoints don't move — and reported, so the row's other
       * sources still apply.
       */
      type Failure = {
        readonly source: string
        readonly streamId: string
        readonly error: unknown
      }
      const slotRow = fromScratch ? Option.none<Row>() : row
      /**
       * Each instance's slot and run, in fold order. `barred` instances read an
       * unowned field without adopting it; `adopters` are those that adopted one.
       */
      const planAll = (barred: ReadonlySet<InstanceWork>) =>
        Effect.gen(function* () {
          const failed: Array<Failure> = []
          const plans: Array<Plan> = []
          const adopters: Array<InstanceWork> = []
          const claimed = new Map<string, string>()
          for (const w of ordered) {
            const slot = slotOf(slotRow, w.source.name, w.streamIdStr, claimed, !barred.has(w))
            if (slot instanceof ProjectionSourceConflict) {
              failed.push({ source: w.source.name, streamId: w.streamIdStr, error: slot })
              continue
            }
            if (slot.adopted === true) adopters.push(w)
            const at = fromScratch ? 0 : slot.at
            const r = yield* Effect.result(runOf(rowId, at, w))
            if (Result.isFailure(r)) {
              failed.push({ source: w.source.name, streamId: w.streamIdStr, error: r.failure })
              continue
            }
            plans.push({ work: w, slot, ...r.success })
          }
          return { plans, failed, adopters }
        })
      const initialState: Option.Option<any> =
        fromScratch || Option.isNone(row) || row.value.tombstone
          ? Option.none()
          : Option.some(row.value.values)
      const initiallyRemoved = Option.isSome(row) && row.value.tombstone && !fromScratch

      type InstanceFold = {
        readonly applied: ReadonlyArray<AnyEvent>
        readonly rejected: ReadonlyArray<{ readonly event: AnyEvent; readonly error: unknown }>
        readonly superseded: ReadonlyArray<AnyEvent>
        readonly skipped: ReadonlyArray<AnyEvent>
      }
      type Folded = {
        readonly state: Option.Option<any>
        readonly removed: boolean
        readonly enqueued: ReadonlyArray<Enqueued>
        readonly results: ReadonlyArray<InstanceFold>
      }
      /** Fold `active`; the index of the first instance that fails, if one does. */
      const foldAll = (
        active: ReadonlyArray<Plan>,
      ): Effect.Effect<
        { readonly folded: Folded } | { readonly failedAt: number; readonly error: unknown },
        never,
        any
      > =>
        Effect.gen(function* () {
          let state = initialState
          let removed = initiallyRemoved
          const enqueued: Array<Enqueued> = []
          const results: Array<InstanceFold> = []
          for (const [index, plan] of active.entries()) {
            const applied: Array<AnyEvent> = []
            const rejected: Array<{ event: AnyEvent; error: unknown }> = []
            const superseded: Array<AnyEvent> = []
            const skipped: Array<AnyEvent> = []
            const context: EvolveContext = {
              source: plan.work.source.name,
              streamId: plan.work.streamIdStr,
            }
            /** Evolve one event onto the current state: its next state, or its failure. */
            const evolveOne = (event: AnyEvent) =>
              Effect.result(
                Effect.gen(function* () {
                  const base = Option.isSome(state)
                    ? state.value
                    : yield* call("initial", () =>
                        config.initial(key, {
                          source: context.source,
                          streamId: plan.work.streamId,
                          event,
                        }),
                      )
                  const next = yield* plan.work.source.evolve(base, event, context)
                  // A skip: the state stays, and the event produces no effects.
                  if (isSkipEvent(next)) return { next, effects: [] }
                  if (isRemoveRow(next) && config.removal === undefined) {
                    return yield* new ValidationError({
                      entityType,
                      operation: config.label,
                      cause:
                        "`evolve` returned `removeRow`, but the projection declares no `removal`.",
                    })
                  }
                  const effects =
                    config.outbox === undefined
                      ? []
                      : yield* call("outbox", () =>
                          config.outbox!.effects(
                            event,
                            isRemoveRow(next) ? undefined : next,
                            context,
                          ),
                        )
                  return { next, effects }
                }),
              )
            const accept = (
              event: AnyEvent,
              outcome: { next: unknown; effects: ReadonlyArray<unknown> },
            ) => {
              if (isRemoveRow(outcome.next)) {
                state = Option.none()
                removed = true
              } else {
                state = Option.some(outcome.next)
                removed = false
              }
              applied.push(event)
              for (const effect of outcome.effects)
                enqueued.push({ effect, event, source: context.source })
            }
            if (plan.work.source.mode === "latest") {
              // Newest first, until one is accepted: rejections and skips fall back
              // to an older event, and only those older than the accepted one are passed over.
              for (let i = plan.run.length - 1; i >= 0; i--) {
                const event = plan.run[i]!
                const result = yield* evolveOne(event)
                if (Result.isSuccess(result) && isSkipEvent(result.success.next)) {
                  skipped.unshift(event)
                } else if (Result.isSuccess(result)) {
                  accept(event, result.success)
                  superseded.push(...plan.run.slice(0, i))
                  break
                } else if (plan.work.source.terminal?.(result.failure) === true) {
                  rejected.unshift({ event, error: result.failure })
                } else return { failedAt: index, error: result.failure }
              }
            } else {
              for (const event of plan.run) {
                const result = yield* evolveOne(event)
                if (Result.isSuccess(result)) {
                  if (isSkipEvent(result.success.next)) skipped.push(event)
                  else accept(event, result.success)
                } else if (plan.work.source.terminal?.(result.failure) === true) {
                  rejected.push({ event, error: result.failure })
                } else return { failedAt: index, error: result.failure }
              }
            }
            results.push({ applied, rejected, superseded, skipped })
          }
          return { folded: { state, removed, enqueued, results } }
        })

      /**
       * The checkpoint an instance's fold moves it to: its last applied or
       * rejected event (#162 — skipped ones don't count). None: it stays as read.
       */
      const checkpointOf = (plan: Plan, result: InstanceFold): number | undefined => {
        let last: number | undefined
        for (const e of result.applied) if (last === undefined || e.version > last) last = e.version
        for (const r of result.rejected) {
          if (last === undefined || r.event.version > last) last = r.event.version
        }
        // A rebuild records an instance with nothing to fold at its read checkpoint.
        if (last === undefined && fromScratch && plan.run.length === 0) return plan.slot.at
        return last
      }

      // Plan, and fold; an instance that fails is set aside and the rest folded
      // again. An instance that adopted an unowned field but won't write it
      // (all skipped, or failed) releases it, and — when another instance of
      // its source could take it — the row is planned again without its claim.
      const barred = new Set<InstanceWork>()
      let failed: Array<Failure>
      let active: ReadonlyArray<Plan>
      let folded: Folded
      while (true) {
        const planned = yield* planAll(barred)
        failed = planned.failed
        active = planned.plans
        while (true) {
          const attempt = yield* foldAll(active)
          if ("folded" in attempt) {
            folded = attempt.folded
            break
          }
          const bad = active[attempt.failedAt]!
          failed.push({
            source: bad.work.source.name,
            streamId: bad.work.streamIdStr,
            error: attempt.error,
          })
          active = active.filter((p) => p !== bad)
        }
        const writes = new Set(
          active
            .filter((p, i) => checkpointOf(p, folded.results[i]!) !== undefined)
            .map((p) => p.work),
        )
        const released = planned.adopters.filter(
          (w) =>
            !writes.has(w) &&
            ordered.some((o) => o !== w && o.source === w.source && !barred.has(o)),
        )
        if (released.length === 0) break
        for (const w of released) barred.add(w)
      }
      // Every instance failed: the row fails, with the first failure.
      if (active.length === 0 && failed.length > 0) return yield* Effect.fail(failed[0]!.error)
      const { state, removed, enqueued, results } = folded

      const instances = (version: (i: number) => number): Array<InstanceResult> =>
        active.map((plan, i) => ({
          source: plan.work.source.name,
          streamId: plan.work.streamIdStr,
          applied: results[i]!.applied,
          alreadyApplied: plan.alreadyApplied,
          rejected: results[i]!.rejected,
          superseded: results[i]!.superseded,
          skipped: results[i]!.skipped,
          version: version(i),
        }))
      const unchanged = (): RowResult => ({
        key,
        instances: instances((i) => active[i]!.slot.at),
        state:
          Option.isSome(row) && !row.value.tombstone
            ? Option.some(row.value.values)
            : Option.none(),
        removed: Option.isSome(row) && row.value.tombstone,
        revision: revisionOf(row),
        enqueued: 0,
        failed,
      })
      // Written only when an event was applied or rejected (or rebuilding):
      // skipped and already-applied events alone leave the row as read.
      const changed = results.some((r) => r.applied.length > 0 || r.rejected.length > 0)
      if (!changed && !fromScratch) return unchanged()
      // No row came of it (only rejections, and none existed): write nothing.
      if (Option.isNone(state) && !removed) return unchanged()
      // The new checkpoints: every event up to the last applied or rejected one.
      const advanced = active.flatMap((p, i) => {
        const version = checkpointOf(p, results[i]!)
        return version === undefined
          ? []
          : [{ source: p.work.source.name, streamIdStr: p.work.streamIdStr, slot: p.slot, version }]
      })
      const target: Record<string, unknown> = Option.isSome(state)
        ? { ...(state.value as object) }
        : {}
      stamp(target, fromScratch ? Option.none() : row, advanced)
      if (fromScratch && config.revision !== undefined) {
        target[config.revision.field] = nextRevisionOf(row)
      }
      const nextRevision =
        config.revision === undefined ? undefined : (target[config.revision.field] as number)
      let written: Option.Option<unknown>
      if (Option.isNone(state)) {
        // A tombstone keeps exactly the layout's fields.
        written = yield* writeRow(key, Option.none(), pick(target), row, enqueued, nextRevision)
      } else {
        const mapped =
          config.toItem === undefined
            ? target
            : {
                ...(yield* call("toItem", () =>
                  config.toItem!(target, config.toItemContext(key, work)),
                )),
                ...pick(target),
              }
        written = yield* writeRow(key, Option.some(mapped), {}, row, enqueued, nextRevision)
      }
      const versions = new Map(
        advanced.map((a) => [`${a.source}\u0000${a.streamIdStr}`, a.version]),
      )
      return {
        key,
        instances: instances(
          (i) =>
            versions.get(`${active[i]!.work.source.name}\u0000${active[i]!.work.streamIdStr}`) ??
            active[i]!.slot.at,
        ),
        state: written,
        removed: Option.isNone(state),
        revision: nextRevision,
        enqueued: enqueued.length,
        failed,
      }
    })
    return withRetry(attempt)
  }

  /** The fields the library owns, re-applied after `toItem`. */
  const pick = (target: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const f of keptFields) if (target[f] !== undefined) out[f] = target[f]
    return out
  }

  // -------------------------------------------------------------------------
  // Outbox drain (#155)
  // -------------------------------------------------------------------------

  /**
   * A key a row's outbox items are under (#171): its current key, or its 1.36
   * key. `only` when that key can also hold another row's items: the row's
   * there are the `marked` ones (written under its current key), or the
   * `unmarked` ones (1.36's).
   */
  interface OutboxAt {
    readonly pk: string
    readonly sk: string
    readonly only?: "marked" | "unmarked" | undefined
  }

  /**
   * Deliver a row's pending effects in order: claim the head item, deliver it,
   * delete it, repeat. A claim another drainer holds stops the drain; a crash
   * leaves a claim that expires, so the effect is delivered again.
   *
   * `rows` are the keys the row's items are under: its current key, and its
   * 1.36 key when its items can still be there (#171). The head is the first
   * pending item of them all, by revision and position, so a row's effects
   * are delivered in one order wherever they are.
   */
  const drainRaw = <E, R>(
    rows: ReadonlyArray<OutboxAt>,
    deliver: (effect: any, meta: OutboxMeta) => Effect.Effect<void, E, R>,
  ): Effect.Effect<DrainResult<E>, any, any> =>
    Effect.gen(function* () {
      const outbox = config.outbox!
      const client = yield* Capacity.client
      const TableName = yield* outboxTable
      const keys = outboxKeys()
      /** The row's first item under `at`. */
      const firstAt = (at: OutboxAt) =>
        Effect.gen(function* () {
          const request = {
            TableName,
            KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
            ExpressionAttributeNames: {
              "#pk": keys.pk,
              "#sk": keys.sk,
              ...(at.only !== undefined && { "#kt": KEY_TEXT }),
            },
            ExpressionAttributeValues: toAttributeMap({ ":pk": at.pk, ":sk": `${at.sk}#outbox#` }),
            ConsistentRead: true,
          }
          if (at.only === undefined) {
            return (yield* client.query({ ...request, Limit: 1 })).Items?.[0]
          }
          // Read past another row's items under the same key.
          let start: Record<string, AttributeValue> | undefined
          do {
            const page = yield* client.query({
              ...request,
              FilterExpression:
                at.only === "marked" ? "attribute_exists(#kt)" : "attribute_not_exists(#kt)",
              ...(start !== undefined && { ExclusiveStartKey: start }),
            })
            const first = page.Items?.[0]
            if (first !== undefined) return first
            start = page.LastEvaluatedKey
          } while (start !== undefined)
          return undefined
        })
      let delivered = 0
      while (true) {
        let head: Record<string, AttributeValue> | undefined
        let headAt = ""
        for (const at of rows) {
          const first = yield* firstAt(at)
          // `#outbox#<revision>#<n>`: fixed widths, so text order is delivery order.
          const suffix = first?.[keys.sk]?.S?.slice(at.sk.length) ?? ""
          if (first !== undefined && (head === undefined || suffix < headAt)) {
            head = first
            headAt = suffix
          }
        }
        if (head === undefined) return { delivered, undelivered: Option.none() }
        const raw = fromAttributeMap(head) as Record<string, unknown>
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        const token = `${now}-${Math.floor((yield* Random.next) * 1e9)}`
        const claimed = yield* client
          .updateItem({
            TableName,
            Key: toAttributeMap({ [keys.pk]: raw[keys.pk], [keys.sk]: raw[keys.sk] }),
            UpdateExpression: "SET #c = :c, #u = :u",
            ConditionExpression:
              "attribute_exists(#pk) AND (attribute_not_exists(#u) OR #u < :now)",
            ExpressionAttributeNames: { "#c": CLAIM_TOKEN, "#u": CLAIMED_UNTIL, "#pk": keys.pk },
            ExpressionAttributeValues: toAttributeMap({
              ":c": token,
              ":u": now + Dur.toMillis(outbox.claimFor),
              ":now": now,
            }),
          })
          .pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) => isAwsConditionalCheckFailed((error as { cause?: unknown }).cause),
              () => Effect.succeed(false),
            ),
          )
        // Another drainer holds the head: it delivers in order; stop here.
        if (!claimed) return { delivered, undelivered: Option.none() }
        const effect = yield* S.decodeUnknownEffect(outbox.schema)(raw.effect).pipe(
          Effect.mapError(
            (cause) =>
              new ValidationError({ entityType, operation: `${config.label}.drain`, cause }),
          ),
        )
        const meta: OutboxMeta = {
          source: String(raw.source),
          streamId: String(raw.streamId),
          version: Number(raw.version),
          eventType: String(raw.eventType),
        }
        const outcome = yield* Effect.result(deliver(effect, meta))
        if (Result.isFailure(outcome)) {
          // Release the claim so the next drain retries promptly.
          yield* client
            .updateItem({
              TableName,
              Key: toAttributeMap({ [keys.pk]: raw[keys.pk], [keys.sk]: raw[keys.sk] }),
              UpdateExpression: "REMOVE #c, #u",
              ConditionExpression: "#c = :c",
              ExpressionAttributeNames: { "#c": CLAIM_TOKEN, "#u": CLAIMED_UNTIL },
              ExpressionAttributeValues: toAttributeMap({ ":c": token }),
            })
            .pipe(Effect.ignore)
          return { delivered, undelivered: Option.some({ meta, error: outcome.failure }) }
        }
        // Delivered: remove it, whoever holds the claim now. A drainer whose
        // claim expired mid-delivery must still retire the effect, or two
        // slow drainers re-claim it in turn forever.
        yield* client
          .deleteItem({
            TableName,
            Key: toAttributeMap({ [keys.pk]: raw[keys.pk], [keys.sk]: raw[keys.sk] }),
            ConditionExpression: "attribute_exists(#pk)",
            ExpressionAttributeNames: { "#pk": keys.pk },
          })
          .pipe(
            Effect.catchIf(
              (error) => isAwsConditionalCheckFailed((error as { cause?: unknown }).cause),
              () => Effect.void,
            ),
          )
        delivered++
      }
    })

  /**
   * Drain the row at `key`: under its current key, and — while the fallback is
   * on (#171) — its 1.36 key, where 1.36 left the items it wrote. A key that
   * can also hold another value's items is read for the row's own: its
   * current key when it reads back as another value's 1.36 key (`foo bar`'s
   * is `foo%20bar`'s) for the marked ones, its 1.36 key when that can be
   * another value's current key (`_spells136`) for the unmarked ones.
   */
  const drain = <E, R>(
    key: unknown,
    deliver: (effect: any, meta: OutboxMeta) => Effect.Effect<void, E, R>,
  ) => {
    const record = key as Record<string, unknown>
    const rowKey = composePrimaryKey(readModel as any, record)
    const rows: Array<OutboxAt> = [
      {
        pk: String(rowKey[primary.pk.field]),
        sk: String(rowKey[primary.sk.field]),
        only: typeof readModel._currentKeyOf136(rowKey) === "object" ? "marked" : undefined,
      },
    ]
    const old = readModel._primaryKey136(record)
    if (old !== undefined) {
      rows.unshift({
        pk: old[primary.pk.field]!,
        sk: old[primary.sk.field]!,
        only: readModel._spells136(record) ? "unmarked" : undefined,
      })
    }
    return drainRaw(rows, deliver)
  }

  /** Every row with pending effects, through the outbox's sparse index, drained. */
  const drainPending = <E, R>(
    deliver: (effect: any, meta: OutboxMeta) => Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      const outbox = config.outbox!
      if (outbox.index === undefined) {
        return yield* new ValidationError({
          entityType,
          operation: `${config.label}.drainPending`,
          cause: "`drainPending` needs `outbox.index` (a sparse index over the outbox items).",
        })
      }
      const client = yield* Capacity.client
      const TableName = yield* outboxTable
      /** The row keys items name, and whether marked and unmarked items name each. */
      const rows = new Map<string, { pk: string; sk: string; marked: boolean; unmarked: boolean }>()
      let start: Record<string, AttributeValue> | undefined
      do {
        const page = yield* client.query({
          TableName,
          IndexName: outbox.index.name,
          KeyConditionExpression: "#p = :p",
          ExpressionAttributeNames: { "#p": outbox.index.pk },
          ExpressionAttributeValues: toAttributeMap({ ":p": outboxMarker(entityType) }),
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        })
        for (const item of page.Items ?? []) {
          const raw = fromAttributeMap(item) as Record<string, unknown>
          const pk = String(raw[ROW_PK])
          const sk = String(raw[ROW_SK])
          const id = `${pk}\u0000${sk}`
          const named = rows.get(id) ?? { pk, sk, marked: false, unmarked: false }
          if (raw[KEY_TEXT] === undefined) named.unmarked = true
          else named.marked = true
          rows.set(id, named)
        }
        start = page.LastEvaluatedKey
      } while (start !== undefined)
      // A row's items under its 1.36 key (#171) are drained with those under
      // its current key, in one order: the key an item 1.36 wrote names is
      // read back as 1.36 text (`_currentKeyOf136`) to find where the row is
      // now. When that is another row (`foo%20bar`'s 1.36 key is `foo bar`'s
      // current key), the key's unmarked items are that row's, and its
      // marked ones the row of the key.
      const byRow = new Map<string, Array<OutboxAt>>()
      const add = (rowPk: string, rowSk: string, at: OutboxAt) => {
        const id = `${rowPk}\u0000${rowSk}`
        byRow.set(id, [...(byRow.get(id) ?? []), at])
      }
      for (const { pk, sk, marked, unmarked } of rows.values()) {
        const placed = readModel._currentKeyOf136({
          [primary.pk.field]: pk,
          [primary.sk.field]: sk,
        })
        if (typeof placed !== "object") {
          add(pk, sk, { pk, sk })
          continue
        }
        if (unmarked) {
          const current = placed.current
          add(current[primary.pk.field]!, current[primary.sk.field]!, { pk, sk, only: "unmarked" })
        }
        if (marked) add(pk, sk, { pk, sk, only: "marked" })
      }
      let delivered = 0
      const undelivered: Array<{ readonly meta: OutboxMeta; readonly error: E }> = []
      for (const keys of byRow.values()) {
        const result = yield* drainRaw(keys, deliver)
        delivered += result.delivered
        if (Option.isSome(result.undelivered)) undelivered.push(result.undelivered.value)
      }
      return { delivered, undelivered }
    })

  return { readRow, applyRow, drain, drainPending, call }
}

/** What `deliver` is told about an effect. */
export interface OutboxMeta {
  readonly source: string
  readonly streamId: string
  readonly version: number
  readonly eventType: string
}

/** Result of draining a row's outbox. */
export interface DrainResult<E> {
  /** Effects delivered (and removed). */
  readonly delivered: number
  /** The effect `deliver` failed on — it stays pending, at the head. */
  readonly undelivered: Option.Option<{ readonly meta: OutboxMeta; readonly error: E }>
}

/** A raw condition for a `Put` the engine writes itself. */
interface RawCondition {
  readonly expression: string
  readonly names: Record<string, string>
  readonly values: Record<string, AttributeValue>
}

/**
 * The default lost-race policy: up to 12 retries after a jittered delay
 * growing from 5 ms by 1.5× (about 1.3 s in all).
 */
export const defaultRetry: Schedule.Schedule<unknown, unknown> = Schedule.max([
  Schedule.jittered(Schedule.exponential("5 millis", 1.5)),
  Schedule.recurs(12),
]) as Schedule.Schedule<unknown, unknown>

/** The `retry` option as a schedule. */
export const retrySchedule = (
  retry: number | Schedule.Schedule<unknown, ConcurrentModification> | undefined,
): Schedule.Schedule<unknown, unknown> =>
  (retry === undefined
    ? defaultRetry
    : typeof retry === "number"
      ? Schedule.recurs(retry)
      : retry) as Schedule.Schedule<unknown, unknown>

export type { ConditionalCheckFailed }
