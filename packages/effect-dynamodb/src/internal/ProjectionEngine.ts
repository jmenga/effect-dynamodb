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
import {
  type DynamoEncoding,
  getEncoding,
  isConfiguredModel,
} from "@effect-dynamodb/schema/DynamoModel.js"
import type * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  ConcurrentModification,
  type ConditionalCheckFailed,
  isAwsConditionalCheckFailed,
  isAwsTransactionCancelled,
  ProjectionSourceConflict,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import {
  keyFormLiterals,
  keyFormValueKind,
} from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import {
  isSelfDateSchema,
  optionalField,
  readingStreamValues,
  resolveFieldEncoding,
  writingTuplePositions,
} from "@effect-dynamodb/schema/internal/EntitySchemas.js"
import { decodingAsBefore } from "@effect-dynamodb/schema/internal/FailingAsBefore.js"
import { getSchemaFields } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import { fnv1a64 } from "@effect-dynamodb/schema/internal/ZOrderCurve.js"
import type { IndexDefinition } from "@effect-dynamodb/schema/KeyComposer.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import {
  type Context,
  DateTime,
  Duration as Dur,
  type Duration,
  Effect,
  Equal,
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
import { type RekeyAmbiguity, resolveTtlAttributeName, type TableConfig } from "../Table.js"
import * as Capacity from "./Capacity.js"
import { condition as entityCondition } from "./EntityCombinators.js"
import type { EntityPutImpl } from "./EntityOps.js"
import { handlerOf, type RekeyMember, type RekeyTally } from "./Rekey.js"
import { notReadBack, readBackOf } from "./RoundTrip.js"
import {
  addProjectionLayout,
  andRaw,
  OUTBOX_CLAIM as CLAIM_TOKEN,
  OUTBOX_CLAIMED_UNTIL as CLAIMED_UNTIL,
  composePrimaryKey,
  freshRowToken,
  KEY_TEXT,
  layoutTag,
  marshalOrFail,
  OUTBOX_READ_MODEL,
  outboxMarkInUse,
  type ProjectionLayout,
  type ProjectionRole,
  projectionLayoutsOf,
  projectionTtlChecked,
  projectionTtlConflict,
  type RawCondition,
  OUTBOX_ROW_PK as ROW_PK,
  OUTBOX_ROW_SK as ROW_SK,
  ROW_TOKEN,
  rowTokened,
  rowTokenTerm,
  rowWriters,
  serializeSparseOrFail,
  validateAndBuildPutItem,
} from "./TransactableOps.js"
import { withCause } from "./WriteDiagnosis.js"

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

/**
 * The term a projection keeping no revision adds to a write over a tombstone it read: the row is
 * still a tombstone (#237).
 */
const tombstoneTerm: RawCondition = {
  expression: "attribute_exists(#eddRm)",
  names: { "#eddRm": REMOVED_AT },
  values: {},
}

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
  readonly _serializeSparseFields: (item: Record<string, unknown>) => void
  readonly _attachPrototype?: ((decoded: any) => any) | undefined
  readonly _multiItemWriteFeatures?: ReadonlyArray<string> | undefined
  readonly schemas: any
  /** The mark a row tombstone or outbox item takes for the key `key` composes — see `Entity`. */
  readonly _keyTextMark: (key: Record<string, unknown>) => 2 | undefined
}

/**
 * Another projection's bookkeeping a row write carries (#237), by stored name: `attributes` set
 * whatever the write holds, `fill` only where it holds none.
 */
interface Carry {
  readonly attributes: Record<string, unknown>
  readonly fill: Record<string, unknown>
}

const noCarry: Carry = { attributes: {}, fill: {} }

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

/**
 * @internal Where a projection's outbox items are, as its read model keeps it (`_projectionOutboxes`,
 * one per projection): on the row table when `table` is undefined (under the row's own key
 * attributes), else on `table` under `pk` / `sk`, with the sparse `index` keys they carry.
 */
export interface ProjectionOutboxLayout {
  readonly table: { readonly Tag: any } | undefined
  readonly pk: string
  readonly sk: string
  readonly index: { readonly name: string; readonly pk: string; readonly sk: string } | undefined
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

/**
 * A key's identity: its fields, sorted, as JSON. JSON has no bigint, so one is written as an
 * object holding its digits, which no number or string is; any other key's text is unchanged.
 */
export const keyId = (key: unknown): string =>
  JSON.stringify(
    Object.entries(key as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    (_name, value) => (typeof value === "bigint" ? { bigint: value.toString() } : value),
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
  /** The item as read: its row token, and another projection's bookkeeping as stored (#237). */
  readonly item?: Record<string, AttributeValue> | undefined
}

/**
 * Two decoded values alike: primitives by `Object.is`, arrays and plain records entry by entry,
 * anything else by `Equal.equals`.
 */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameValue(v, b[i]))
    )
  }
  const plain = (v: object) => {
    const proto = Object.getPrototypeOf(v)
    return proto === Object.prototype || proto === null
  }
  if (plain(a) && plain(b)) {
    const x = a as Record<string, unknown>
    const y = b as Record<string, unknown>
    const keys = Object.keys(x)
    return (
      keys.length === Object.keys(y).length &&
      keys.every((k) => Object.hasOwn(y, k) && sameValue(x[k], y[k]))
    )
  }
  return Equal.equals(a, b)
}

/** A table's service, as an entity or an outbox names it. */
type TableTag = Context.Service<TableConfig, TableConfig>

/** A projection's outbox on another table, as its read model records it (#171). */
type RemoteOutbox = ProjectionOutboxLayout & { readonly table: { readonly Tag: TableTag } }

/**
 * @internal The outboxes on other tables of the read model's projections (`_projectionOutboxes`,
 * the entries with a `table`): several projections of one read model may each have one. A local
 * outbox is on the read model's own table, where its rows are.
 */
export const remoteOutboxesOf = (entity: unknown): ReadonlyArray<RemoteOutbox> =>
  (
    (entity as { readonly _projectionOutboxes?: ReadonlyArray<ProjectionOutboxLayout> })
      ._projectionOutboxes ?? []
  ).filter((outbox): outbox is RemoteOutbox => outbox.table !== undefined)

/**
 * @internal The physical name of the table `tag` names, the one requests are sent to:
 * `undefined` when the context doesn't provide it.
 */
export const physicalTableName = (tag: TableTag): Effect.Effect<string | undefined> =>
  Effect.map(Effect.serviceOption(tag), (config) =>
    Option.isSome(config) ? config.value.name : undefined,
  )

/**
 * The date encoding a composite field is stored under, when the library writes its text: a
 * `DynamoModel` date schema's own, or, for an Effect date schema the entity stores by its own
 * encoding (`Schema.DateTimeUtc`, `Schema.Date`, `Schema.DateTimeZoned`), the default or its
 * `storedAs` override; for an optional field, its value's. `undefined` for a field that is no date,
 * and for a date with a codec of its own (a transform to a date, `Schema.DateTimeUtcFromString`
 * included), whose text the library doesn't know: it may hold any text, as 1.40.0 took it.
 */
const dateEncodingOf = (
  field: Schema.Top,
  override: DynamoEncoding | undefined,
): DynamoEncoding | undefined => {
  const known = (schema: Schema.Top) =>
    getEncoding(schema) !== undefined || isSelfDateSchema(schema)
  if (known(field)) return resolveFieldEncoding(field, override) ?? undefined
  const inner = optionalField(field)?.inner
  if (inner === undefined || !known(inner)) return undefined
  return resolveFieldEncoding(inner, override) ?? undefined
}

/**
 * What a composite of `model` can be in the keys its rows are written under
 * (`KeyComposer.CompositeValues`), by its schema: the key text of its literals (a literal union), of
 * `true` and `false` (a boolean), a number's or bigint's key text, or, with `dates`, a date's the
 * library encodes (`dateEncodingOf`: an epoch's number, or ISO text); any other field (a string, a
 * date with a codec of its own, a field the model doesn't declare) may hold any text, `#` included.
 */
const compositeValues =
  (model: unknown, dates = true) =>
  (composite: string): KeyComposer.CompositeValues => {
    if (model === undefined || model === null) return "open"
    const schema = isConfiguredModel(model) ? (model.model as Schema.Top) : (model as Schema.Top)
    const fields = getSchemaFields(schema)
    if (fields === undefined || !Object.hasOwn(fields, composite)) return "open"
    const field = fields[composite]!
    if (dates) {
      const configured = isConfiguredModel(model) ? model.attributes : undefined
      const date = dateEncodingOf(
        field,
        configured !== undefined && Object.hasOwn(configured, composite)
          ? configured[composite]!.encoding
          : undefined,
      )
      if (date !== undefined) {
        return date.storage !== "string"
          ? "number"
          : date.domain === "DateTime.Zoned"
            ? "zonedDate"
            : "date"
      }
    }
    const literals = keyFormLiterals(field)
    if (literals !== undefined) return { values: literals }
    const kind = keyFormValueKind(field)
    if (kind === "number" || kind === "bigint") return "number"
    if (kind === "boolean") return { values: [true, false] }
    return "open"
  }

/** The key spaces of an entity's rows, each half's (`KeyComposer.composeKeySpace`). */
type KeySpace = { readonly pk: KeyComposer.KeySpace; readonly sk: KeyComposer.KeySpace }

/**
 * The key space an entity's rows are under: the text its primary key's partition and sort keys
 * start with, the composites' labels, and what each composite's value can be, composed by the call
 * its writes make (`KeyComposer.composeKeySpace`): the schema's name and version, the primary
 * collection (or the entity type), under a collection the entity type and its version, and each
 * composite's name. Each value is what its type can compose (`compositeValues`), by `view`:
 *
 * - `"plain"`, the keys its rows are written under with values that hold no `#`: every composite is
 *   walked, to the end of the key, under the schema's setting. `"plain140"` is the same, a date
 *   taken as any text without `#`, as 1.40.0 took it.
 * - `"owned"`, exactly the keys its rows can be written under, under any setting: every composite
 *   is walked, to the end of the key, a value that may hold `#` as any text.
 *
 * `undefined` for an entity on no table.
 */
const keySpaceOf = (
  entity: unknown,
  view: "plain" | "plain140" | "owned",
): KeySpace | undefined => {
  const member = entity as {
    readonly entityType?: string
    readonly _entityVersion?: number
    readonly indexes?: { readonly primary?: IndexDefinition }
    readonly _schema?: DynamoSchema.DynamoSchema
    readonly model?: unknown
  }
  const primary = member.indexes?.primary
  if (member._schema === undefined || member.entityType === undefined || primary === undefined) {
    return undefined
  }
  const values = compositeValues(member.model, view !== "plain140")
  const plain = view === "plain" || view === "plain140"
  try {
    return KeyComposer.composeKeySpace(
      member._schema,
      member.entityType,
      member._entityVersion ?? 1,
      primary,
      plain
        ? (composite) => {
            const of = values(composite)
            return of === "open" ? "text" : of
          }
        : values,
      { everyForm: !plain, walkOpen: !plain },
    )
  } catch {
    return undefined
  }
}

/**
 * The key space of a read model's outbox items: its rows' partition keys, and its rows' sort keys
 * followed by `#outbox#` (`<rowSk>#outbox#<revision>#<n>`), so any text after a whole sort key.
 */
const outboxSpaceOf = (space: KeySpace): KeySpace => {
  const { sk } = space
  if (sk.open) return space
  const last = sk.after.length - 1
  return {
    pk: space.pk,
    sk:
      last < 0
        ? { text: `${sk.text}#outbox#`, after: [], values: [], open: true }
        : { ...sk, after: [...sk.after.slice(0, last), `${sk.after[last]}#outbox#`], open: true },
  }
}

/** Whether a key of one key space can be a key of the other, in both halves. */
const spacesMeet = (a: KeySpace, b: KeySpace): boolean =>
  KeyComposer.keySpacesMeet(a.pk, b.pk) && KeyComposer.keySpacesMeet(a.sk, b.sk)

/**
 * Whether two read models' outbox items can overwrite each other, as `DynamoClient.make` and
 * `processBatch` ask (`"plain"`): a key of one can be a key of the other with values that hold no
 * `#`. A date's key text is its own (`"plain"`), so a date beside a label it can't spell is apart,
 * where 1.40.0 took a date as any text (`"plain140"`) and refused them. Such a pair is apart only
 * when no key one writes can be a key the other writes at all (`"owned"`), `#` included: a drainer
 * tells its own items from the other's by that (`drainPending`), so each delivers exactly its own.
 * Otherwise they're refused, as on 1.40.0.
 */
const overwriteEachOther = (a: unknown, b: unknown): boolean => {
  const meet = (view: "plain" | "plain140" | "owned") => {
    const x = keySpaceOf(a, view)
    const y = keySpaceOf(b, view)
    return x !== undefined && y !== undefined && spacesMeet(outboxSpaceOf(x), outboxSpaceOf(y))
  }
  if (meet("plain")) return true
  return meet("plain140") && meet("owned")
}

/**
 * Whether two entities compose every key the same way: one schema (name, version, casing,
 * `escapeKeys`), entity type and version, primary key composites, casing and collection, and each
 * composite of one kind of key text (a string, a number, a bigint or a boolean), whether or not one
 * of them is limited to literals: a reader reads a literal composite as any value of its kind, and
 * its key form composes that value as one of its kind (a literal union beside a string moves an
 * item where the string's would, as on 1.39.0). A composite of no one kind takes the same type on
 * both. Then either one's reader moves a row as the other's would.
 */
const sameKeys = (a: unknown, b: unknown): boolean => {
  type Member = {
    readonly entityType?: string
    readonly _entityVersion?: number
    readonly indexes?: { readonly primary?: IndexDefinition }
    readonly _schema?: DynamoSchema.DynamoSchema
    readonly model?: unknown
  }
  const x = a as Member
  const y = b as Member
  const px = x.indexes?.primary
  const py = y.indexes?.primary
  const sx = x._schema
  const sy = y._schema
  if (px === undefined || py === undefined || sx === undefined || sy === undefined) return false
  const fieldsOf = (model: unknown) =>
    model === undefined || model === null
      ? undefined
      : getSchemaFields(
          isConfiguredModel(model) ? (model.model as Schema.Top) : (model as Schema.Top),
        )
  const fx = fieldsOf(x.model)
  const fy = fieldsOf(y.model)
  const typeOf = (fields: ReturnType<typeof getSchemaFields>, composite: string) => {
    if (fields === undefined || !Object.hasOwn(fields, composite)) return undefined
    const field = fields[composite]!
    const kind = keyFormValueKind(field)
    return kind !== undefined ? kind : JSON.stringify([kind, keyFormLiterals(field)])
  }
  const same = (u: ReadonlyArray<string>, v: ReadonlyArray<string>) =>
    u.length === v.length && u.every((name, i) => name === v[i])
  return (
    x.entityType === y.entityType &&
    (x._entityVersion ?? 1) === (y._entityVersion ?? 1) &&
    sx.name === sy.name &&
    sx.version === sy.version &&
    sx.casing === sy.casing &&
    (sx.escapeKeys === true) === (sy.escapeKeys === true) &&
    same(px.pk.composite, py.pk.composite) &&
    same(px.sk.composite, py.sk.composite) &&
    px.casing === py.casing &&
    JSON.stringify(px.collection) === JSON.stringify(py.collection) &&
    px.type === py.type &&
    [...px.pk.composite, ...px.sk.composite].every((composite) => {
      const t = typeOf(fx, composite)
      return t !== undefined && t === typeOf(fy, composite)
    })
  )
}

/**
 * @internal `[EDD-9134]`: among `members` (each named as `site`'s message shows it), a read model
 * whose projection's outbox is on another table, where another read model in the same key space
 * has its outbox too. Tables are compared by the physical name the context resolves (two handles
 * on one table are one table), and by service when one isn't provided. The problem, or `undefined`.
 *
 * One question ({@link overwriteEachOther}): can a key of one be a key of the other with values
 * that hold no `#`, each value what its type can compose? Then their items overwrite each other
 * whenever their values match, in normal operation, and no one can tell whose an item is. Read
 * models whose keys meet only through a value holding `#` bind and run, as on 1.39.0, as do two
 * whose keys part where a value of one can't hold the other's text (a number beside a label):
 * `drainPending` and `rekey` tell their items apart item by item ({@link outboxOwnership},
 * {@link rekeyOutboxMember}). It is asked where, by `scope`:
 *
 * - `"plain"`: where read models are bound (`DynamoClient.make`, `EventStore.processBatch`).
 * - a table (`rekey` of it), for projections defined since the client was made, whose outboxes
 *   are recorded only when they are: only outboxes on that table are looked at. The table's own
 *   members (`scope.members`) are looked at too: an entity claims the outbox items of its entity
 *   type on its table (its own projections' outbox there). One whose keys are composed exactly as
 *   the read model's (`sameKeys`) moves them where the read model would, and isn't refused.
 *
 * 1.40.0 asked `rekey` more: whether its reader could read an item of one as the other's at all, a
 * value holding `#` included. Those pairs aren't refused from 1.41.0: `rekey` decides each item.
 *
 * Read models that never meet at a site that sees several at once can't be checked: their key
 * spaces must be kept apart by whoever defines them. Neither can a member that is no read model (a
 * projection object built by hand, carrying its routes but no read model): it runs as on 1.39.0.
 */
export const sharedOutboxKeySpace = (
  site: string,
  given: ReadonlyArray<readonly [name: string, entity: unknown]>,
  scope:
    | "plain"
    | {
        readonly key: string
        readonly name: string
        /** The table's members, each named as the message shows it. */
        readonly members: ReadonlyArray<readonly [name: string, member: unknown]>
      },
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const plain = scope === "plain"
    const members = given.filter(([, entity]) => typeof entity === "object" && entity !== null)
    // Every table a member's outbox is on, by its physical name.
    const names = new Map<string, string | undefined>()
    for (const [, entity] of members) {
      for (const { table } of remoteOutboxesOf(entity)) {
        if (!names.has(table.Tag.key)) {
          names.set(table.Tag.key, yield* physicalTableName(table.Tag))
        }
      }
    }
    const oneTable = (a: TableTag, b: TableTag): boolean => {
      if (a.key === b.key) return true
      const name = names.get(a.key)
      return name !== undefined && name === names.get(b.key)
    }
    const startOf = (space: KeySpace) =>
      `(partition keys starting "${space.pk.text}", sort keys starting "${space.sk.text}": the ` +
      "same schema name and version, primary collection, entity type and first composite)"
    for (const [name, entity] of members) {
      const space = keySpaceOf(entity, "plain")
      if (space === undefined) continue
      for (const outbox of remoteOutboxesOf(entity)) {
        const into = outbox.table.Tag
        if (!plain && into.key !== scope.key && names.get(into.key) !== scope.name) continue
        const physical = names.get(into.key)
        for (const [otherName, other] of members) {
          if (other === entity) continue
          if (!remoteOutboxesOf(other).some((o) => oneTable(o.table.Tag, into))) continue
          if (!overwriteEachOther(entity, other)) continue
          return (
            `[EDD-9134] ${site}: ${name} writes its projection's outbox items into another ` +
            `table${physical === undefined ? "" : ` ("${physical}")`}, where ${otherName} ` +
            `writes its own under the same key space ${startOf(space)}. ` +
            "Their items would overwrite each other whenever their keys match, and rekey " +
            "couldn't tell whose an item is. " +
            "Give one of them its own entity type, collection, schema or key composites."
          )
        }
        if (plain) continue
        // The members of the table being rekeyed that claim this read model's outbox items.
        for (const [memberName, member] of scope.members) {
          if (member === entity) continue
          const claims = handlerOf(member)?.types.includes(`${readModelType(entity)}#outbox`)
          if (claims !== true || sameKeys(member, entity) || !overwriteEachOther(entity, member)) {
            continue
          }
          return (
            `[EDD-9134] ${site}: ${name} writes its projection's outbox items into another ` +
            `table${physical === undefined ? "" : ` ("${physical}")`}, whose member ` +
            `${memberName} writes the outbox items of its entity type there under the same key ` +
            `space ${startOf(space)}, and composes its keys differently. Their items would ` +
            "overwrite each other whenever their keys match, and rekey couldn't tell whose an " +
            "item is. Give one of them its own entity type, collection, schema or key composites."
          )
        }
      }
    }
    return undefined
  })

/** An entity's type, as its rows' `__edd_e__` names it. */
const readModelType = (entity: unknown): string | undefined =>
  (entity as { readonly entityType?: string }).entityType

/**
 * @internal The tag a read model's outbox items carry (`OUTBOX_READ_MODEL`, #237): a hash of what
 * its rows' keys are composed from: the schema's name and version, the entity type and its
 * version, the primary collection and the primary key's composites. Not the key text's setting
 * (`escapeKeys`, casing), which `rekey` moves items across, nor a composite's type, which can
 * change with the key text staying. `undefined` for an entity on no table.
 */
export const readModelTag = (entity: unknown): string | undefined => {
  const member = entity as {
    readonly entityType?: string
    readonly _entityVersion?: number
    readonly indexes?: { readonly primary?: IndexDefinition }
    readonly _schema?: DynamoSchema.DynamoSchema
  }
  const primary = member.indexes?.primary
  if (member._schema === undefined || member.entityType === undefined || primary === undefined) {
    return undefined
  }
  let hash = 0x811c9dc5
  const text = JSON.stringify([
    member._schema.name,
    member._schema.version,
    member.entityType,
    member._entityVersion ?? 1,
    primary.collection ?? null,
    primary.pk.composite,
    primary.sk.composite,
  ])
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * @internal The mark an outbox item carries (`OUTBOX_READ_MODEL`, #237): the read model's tag
 * (`readModelTag`), then the effect's, a 64-bit FNV-1a hash of the projection (`layoutTag`) and
 * the event (its source, stream id and version). An item's `Put` replaces only an item carrying
 * the same mark (`writeRow`): a redelivery or retry of the same effect. Any other item at its key,
 * another projection's of the read model, another event's of the projection (its revision started
 * again after its row was lost), or another read model's, is kept, and the item written beside it.
 */
export const outboxMark = (
  readModel: string,
  projection: string,
  event: { readonly source: string; readonly streamId: unknown; readonly version: number },
): string =>
  `${readModel}.${fnv1a64(
    new TextEncoder().encode(
      JSON.stringify([projection, event.source, String(event.streamId), event.version]),
    ),
  ).toString(36)}`

/** The read model an outbox item's mark names: its text before the first `.` (`outboxMark`). */
const markedReadModel = (mark: string): string => {
  const dot = mark.indexOf(".")
  return dot < 0 ? mark : mark.slice(0, dot)
}

/**
 * Read models whose projections write outbox items, by the service key of the table they write
 * them to, and each read model's projections with an outbox (`layoutTag`), as they are defined.
 */
const outboxWriters = new Map<string, Set<object>>()
const outboxProjections = new WeakMap<object, Set<string>>()

/** The service keys of the tables a read model's projections write outbox items to. */
const outboxTablesOf = (readModel: object): ReadonlyArray<string | undefined> => {
  const member = readModel as {
    readonly _tableTag?: { readonly key?: string }
    readonly _projectionOutboxes?: ReadonlyArray<{
      readonly table: { readonly Tag: { readonly key?: string } } | undefined
    }>
  }
  return (member._projectionOutboxes ?? []).map(
    (outbox) => (outbox.table?.Tag ?? member._tableTag)?.key,
  )
}

/**
 * @internal Whether no other read model defined writes outbox items whose keys can be this read
 * model's (#237), decided from the definitions: on each table its outboxes are on, every other
 * read model with an outbox there (another key template, `readModelTag`) composes keys that can
 * never be this one's (`keySpaceOf`, `"owned"`: any value, `#` included). Then an item without a
 * mark at a key this read model writes was written by this read model before 1.41.0, and a `Put`
 * of the same event replaces it, as 1.40.0's did (`writeRow`). `false` where a key space can't be
 * composed or a table isn't known.
 */
export const outboxKeysApart = (readModel: object): boolean => {
  const own = keySpaceOf(readModel, "owned")
  const tag = readModelTag(readModel)
  if (own === undefined || tag === undefined) return false
  const mine = outboxSpaceOf(own)
  for (const table of outboxTablesOf(readModel)) {
    if (table === undefined) return false
    for (const other of outboxWriters.get(table) ?? []) {
      if (other === readModel || readModelTag(other) === tag) continue
      const space = keySpaceOf(other, "owned")
      if (space === undefined || spacesMeet(mine, outboxSpaceOf(space))) return false
    }
  }
  return true
}

/** Whose an outbox item is, as one read model sees it ({@link outboxOwnership}). */
export type OutboxOwnership = "mine" | "foreign" | "unmarked"

const ownershipOf = new WeakMap<object, (item: Record<string, AttributeValue>) => OutboxOwnership>()

/**
 * @internal Whose an outbox item is, as `readModel` sees it (#237): the one decision `drainPending`
 * and the outbox table's `rekey` make. The row it names (`__edd_row_pk__`, `__edd_row_sk__`) must
 * have a key the read model's composer writes, under any setting, for values of its composites'
 * kinds (`keySpaceOf`, `"owned"`: a date the library encodes as its text, a number's key text, a
 * literal's, a string as any text, `#` included): what its reader would take (a date or a literal
 * as any text) isn't enough. Then:
 *
 * - `"mine"`: the item names this read model (`OUTBOX_READ_MODEL`, from 1.41.0).
 * - `"foreign"`: it names another, or its row's key is no key this read model writes.
 * - `"unmarked"`: written before 1.41.0, at a key this read model writes, which another read model
 *   may write too (`[shop]` with `north#branch_b1` beside `[shop, branch]`). `drainPending` drains
 *   it, as 1.40.0 did; `rekey` asks the other read models on the table.
 *
 * Every key is taken as the read model's when its key space can't be composed.
 */
export const outboxOwnership = (
  readModel: object,
): ((item: Record<string, AttributeValue>) => OutboxOwnership) => {
  const known = ownershipOf.get(readModel)
  if (known !== undefined) return known
  const tag = readModelTag(readModel)
  const space = keySpaceOf(readModel, "owned")
  const whole = (text: string): KeyComposer.KeySpace => ({ text, after: [], open: false })
  const decide = (item: Record<string, AttributeValue>): OutboxOwnership => {
    const pk = item[ROW_PK]?.S
    const sk = item[ROW_SK]?.S
    if (space !== undefined) {
      if (pk === undefined || sk === undefined) return "foreign"
      if (!spacesMeet(space, { pk: whole(pk), sk: whole(sk) })) return "foreign"
    }
    // A read model whose items carry no mark reads none (`outboxMarkInUse`): `__edd_rm__` is
    // something else's there.
    const marked = outboxMarkInUse(readModel) ? item[OUTBOX_READ_MODEL]?.S : undefined
    if (marked === undefined) return "unmarked"
    return markedReadModel(marked) === tag ? "mine" : "foreign"
  }
  ownershipOf.set(readModel, decide)
  return decide
}

/**
 * @internal A read model `rekey` asks about the outbox items of its entity type on the table it
 * runs on: one whose projection's outbox is there, or a member of the table (its own projections'
 * outbox items, on its own table).
 */
export interface OutboxCandidate {
  readonly readModel: {
    readonly entityType: string
    readonly _tableTag: TableTag
    readonly indexes: { readonly primary?: IndexDefinition | undefined }
    readonly _rekeyProjectionRow: (
      row: Record<string, AttributeValue>,
      ctx: Parameters<RekeyMember["row"]>[1],
      keys?: { readonly pk: string; readonly sk: string } | undefined,
    ) => ReturnType<RekeyMember["row"]>
    readonly _valuelessMove: (
      row: Record<string, AttributeValue>,
      keys: { readonly pk: string; readonly sk: string },
    ) =>
      | "current"
      | {
          readonly to: Record<string, string>
          readonly rowTo: { readonly pk: string; readonly sk: string }
        }
      | undefined
    readonly _ownsRow: (row: Record<string, AttributeValue>) => boolean
  }
  /** The item's table key attributes: those of the layout whose attributes it holds. */
  readonly keys: (row: Record<string, AttributeValue>) => {
    readonly pk: string
    readonly sk: string
  }
}

/**
 * @internal `rekey`'s one member for the outbox items of `entityType` on a table (#237): it decides
 * whose an item is among `candidates` (registration order), and that read model moves it.
 *
 * - The item names its read model (`OUTBOX_READ_MODEL`), or its row's key is a key only some of
 *   them write: {@link outboxOwnership}, the one decision `drainPending` makes too. Those that can
 *   have written it and read its key back are its possible owners. None: `unregistered` when it
 *   names a read model none of them is, else `unrecognizedKey`.
 * - One, or several moving it to one key (or each finding it current): the first moves it, with
 *   no extra read.
 * - Otherwise, an item written before 1.41.0 at a key more than one writes, which they'd move
 *   apart: the row it names is read from each one's table (strongly consistent), at that key and
 *   at the key that read model would move it to. It is the read model's whose own row is there
 *   (`_ownsRow`: its values compose that key) when exactly one finds one and none finds a row
 *   tombstone. Otherwise it's left where it is, `ambiguousOwner` with the reason
 *   ({@link RekeyAmbiguity}), and a rerun reads and leaves it again.
 */
export const rekeyOutboxMember = (
  entityType: string,
  candidates: ReadonlyArray<OutboxCandidate>,
): RekeyMember => ({
  name: entityType,
  types: [`${entityType}#outbox`],
  exclusive: true,
  row: (row, ctx) =>
    Effect.gen(function* () {
      const marked = row[OUTBOX_READ_MODEL]?.S
      const owners = candidates.flatMap((candidate) => {
        if (outboxOwnership(candidate.readModel)(row) === "foreign") return []
        const keys = candidate.keys(row)
        const plan = candidate.readModel._valuelessMove(row, keys)
        return plan === undefined ? [] : [{ candidate, keys, plan }]
      })
      if (owners.length === 0) {
        const named =
          marked !== undefined &&
          !candidates.some((c) => readModelTag(c.readModel) === markedReadModel(marked))
        return { skipped: { [named ? "unregistered" : "unrecognizedKey"]: 1 } } as RekeyTally
      }
      const first = owners[0]!
      const where = (plan: (typeof owners)[number]["plan"]) =>
        plan === "current" ? "current" : JSON.stringify(plan.to)
      if (owners.every((owner) => where(owner.plan) === where(first.plan))) {
        return yield* first.candidate.readModel._rekeyProjectionRow(row, ctx, first.keys)
      }
      // Written before 1.41.0 at a key more than one of them writes, and they'd move it apart.
      const stored = {
        [first.keys.pk]: row[first.keys.pk]?.S,
        [first.keys.sk]: row[first.keys.sk]?.S,
      }
      const rowAt = { pk: row[ROW_PK]?.S ?? "", sk: row[ROW_SK]?.S ?? "" }
      const client = yield* Capacity.client
      const reads = new Map<string, Record<string, AttributeValue> | undefined>()
      const found: Array<"own" | "tombstone" | "none" | "unprovided"> = []
      for (const { candidate, plan } of owners) {
        const { readModel } = candidate
        const primary = readModel.indexes.primary
        const tableName = yield* physicalTableName(readModel._tableTag)
        if (tableName === undefined || primary === undefined) {
          found.push("unprovided")
          continue
        }
        // Where the row is, then where it would be: a move of it in between is seen at the second.
        const at =
          plan !== "current" && (plan.rowTo.pk !== rowAt.pk || plan.rowTo.sk !== rowAt.sk)
            ? [rowAt, plan.rowTo]
            : [rowAt]
        let result: "own" | "tombstone" | "none" = "none"
        for (const key of at) {
          const id = JSON.stringify([tableName, primary.pk.field, key.pk, primary.sk.field, key.sk])
          if (!reads.has(id)) {
            const { Item } = yield* client.getItem({
              TableName: tableName,
              Key: toAttributeMap({ [primary.pk.field]: key.pk, [primary.sk.field]: key.sk }),
              ConsistentRead: true,
            })
            reads.set(id, Item)
          }
          const there = reads.get(id)
          const type = there?.__edd_e__?.S
          if (there === undefined) continue
          if (type === `${entityType}#tombstone`) result = "tombstone"
          else if (type === entityType && readModel._ownsRow(there) && result === "none") {
            result = "own"
          }
        }
        found.push(result)
      }
      const own = found.flatMap((result, i) => (result === "own" ? [owners[i]!] : []))
      if (found.every((result) => result !== "tombstone" && result !== "unprovided")) {
        if (own.length === 1) {
          const { candidate, keys } = own[0]!
          return yield* candidate.readModel._rekeyProjectionRow(row, ctx, keys)
        }
      }
      const targets = [
        ...new Map(
          owners.map(({ plan }) => {
            const target = plan === "current" ? stored : plan.to
            return [JSON.stringify(target), target] as const
          }),
        ).values(),
      ]
      const rowText = `the row it names (${JSON.stringify(rowAt.pk)}, ${JSON.stringify(rowAt.sk)})`
      const gone = own.length === 0 && found.every((result) => result === "none")
      const ambiguity: RekeyAmbiguity = {
        member: entityType,
        key: stored,
        targets,
        reason: gone ? "rowGone" : "unsettled",
        message:
          `${owners.length} read models of entity type "${entityType}" whose outboxes share this ` +
          "table can each have written it, and would move it to different keys; it was written " +
          "before 1.41.0, so it doesn't name its read model. " +
          (gone
            ? `None of them has ${rowText}, at that key or where it would move it.`
            : found.includes("unprovided")
              ? `The table of one of them isn't provided where rekey runs, so ${rowText} can't be read there.`
              : found.includes("tombstone")
                ? `A row tombstone is at ${rowText}: it holds no values to say whose it is.`
                : `More than one of them has a row of its own at ${rowText}.`) +
          " It's left where it is.",
      }
      return { skipped: { ambiguousOwner: 1 }, ambiguous: [ambiguity] } as RekeyTally
    }),
})

/**
 * @internal `[EDD-9134]` ({@link sharedOutboxKeySpace}) as a defect, from the sites that define
 * what runs (`DynamoClient.make`, `EventStore.processBatch`), before anything runs.
 */
export const refuseSharedOutboxKeySpace = (
  site: string,
  members: ReadonlyArray<readonly [name: string, entity: unknown]>,
): Effect.Effect<void> =>
  Effect.flatMap(sharedOutboxKeySpace(site, members, "plain"), (problem) =>
    problem === undefined ? Effect.void : Effect.die(new Error(problem)),
  )

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

  // Each attribute the projection keeps on a row, with its role: the checkpoints, then the
  // revision, as a tombstone stores them. An attribute in two roles is listed in each, and refused
  // (`[EDD-9133]`, `addProjectionLayout`) when the read model's rows may be tombstones.
  const roles: Array<readonly [string, ProjectionRole]> = []
  const giveRole = (field: string, role: ProjectionRole) => {
    if (!roles.some(([named, held]) => named === field && held === role)) roles.push([field, role])
  }
  if (config.checkpoints.kind === "scalar") giveRole(config.checkpoints.field, "checkpoint")
  else {
    if (config.checkpoints.map !== undefined) giveRole(config.checkpoints.map, "checkpoint map")
    for (const f of Object.values(config.checkpoints.fields)) {
      giveRole(f.field, "checkpoint")
      giveRole(f.instanceField, "checkpoint owner")
    }
  }
  if (config.revision !== undefined) giveRole(config.revision.field, "revision")

  // Recorded beside the layouts of the read model's other projections, whether or not it has
  // `removal`, for the checks of `[EDD-9133]`. Rows may be tombstones (#154) when one has
  // `removal`: the entity's `create` takes one's place, keeping the checkpoints of the projection
  // with `removal` that wrote it, with its revision one higher (`overTombstone`).
  const ownLayout: ProjectionLayout = {
    label: config.label,
    roles,
    removal: config.removal !== undefined,
    ttl: config.removal?.ttl !== undefined,
  }
  addProjectionLayout(readModel, ownLayout)
  /**
   * This projection's tag (`layoutTag`), in its outbox items' marks (`outboxMark`) and in a row
   * token.
   */
  const ownTag = layoutTag(ownLayout)
  /** This projection's roles, by stored name. */
  const ownRoles = new Map<string, Set<ProjectionRole>>()
  for (const [field, role] of roles) {
    const name = dbName(field)
    ownRoles.set(name, (ownRoles.get(name) ?? new Set()).add(role))
  }

  // Every projection's outbox, kept on the read model, one entry per distinct layout, the one defined
  // last at the end: a second projection doesn't hide the first's, which stays callable, and one
  // defined again adds nothing. One on another table (`table`) is moved by that table's `rekey`
  // (#171). Wherever it is, an aggregate declaring `ownsRows` is checked against its items at bind
  // (DESIGN.md §7 "Which rows in its partition are an aggregate's"), with the index keys it writes
  // on them.
  if (config.outbox !== undefined) {
    const holder = readModel as { _projectionOutboxes?: ReadonlyArray<ProjectionOutboxLayout> }
    const layout: ProjectionOutboxLayout = {
      table: config.outbox.table,
      pk: config.outbox.pk,
      sk: config.outbox.sk,
      index: config.outbox.index,
    }
    const same = (other: ProjectionOutboxLayout) =>
      other.table?.Tag === layout.table?.Tag &&
      other.pk === layout.pk &&
      other.sk === layout.sk &&
      other.index?.name === layout.index?.name &&
      other.index?.pk === layout.index?.pk &&
      other.index?.sk === layout.index?.sk
    holder._projectionOutboxes = [
      ...(holder._projectionOutboxes ?? []).filter((other) => !same(other)),
      layout,
    ]
    // Where its items are, beside the other read models', for `outboxKeysApart`; and that the
    // read model has this projection with an outbox.
    const into = ((config.outbox.table?.Tag ?? readModel._tableTag) as { key?: string } | undefined)
      ?.key
    if (into !== undefined) {
      const writers = outboxWriters.get(into) ?? new Set<object>()
      writers.add(readModel)
      outboxWriters.set(into, writers)
    }
    const projections = outboxProjections.get(readModel) ?? new Set<string>()
    projections.add(ownTag)
    outboxProjections.set(readModel, projections)
  }

  const tableName = Effect.suspend(() =>
    Effect.map(readModel._tableTag as Effect.Effect<TableConfig>, (tc) => tc.name),
  )

  /** The row, read strongly consistent — raw, so a tombstone reads as one. */
  const readRow = (key: unknown): Effect.Effect<Option.Option<Row>, any, any> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const TableName = yield* tableName
      const { Item: item } = yield* client.getItem({
        TableName,
        Key: toAttributeMap(composePrimaryKey(readModel as any, key as Record<string, unknown>)),
        ConsistentRead: true,
      })
      if (item === undefined) return Option.none<Row>()
      if (item.__edd_e__?.S === tombstoneMarker(entityType)) {
        const raw = fromAttributeMap(item) as Record<string, unknown>
        const values: Record<string, unknown> = {}
        for (const f of keptFields) {
          const v = raw[dbName(f)]
          if (v !== undefined) values[f] = v
        }
        return Option.some<Row>({ values, tombstone: true, createdAt: undefined, item })
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
        item,
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

  const outboxReadBack =
    config.outbox === undefined
      ? undefined
      : readBackOf(config.outbox.schema, () => readingStreamValues(config.outbox!.schema))

  /** The tag of this read model's key template (`readModelTag`), its items' marks begin with. */
  const outboxTag = readModelTag(readModel)

  /**
   * How an outbox item's `Put` stands toward what is at its key, tried in turn as the write is
   * cancelled there (`outboxStages`):
   *
   * - `"none"`: no mark, no condition: the item replaces what's there, as on 1.40.0.
   * - `"plain"`: the key holds nothing, or this effect's item (`outboxMark`).
   * - `"sameEvent"`: that, or an item without a mark (written before 1.41.0) of the same event.
   * - `"beside"`: at the key followed by `#<mark>`, which only this effect writes.
   */
  type OutboxStage = "none" | "plain" | "sameEvent" | "beside"

  /**
   * The stages of this read model's outbox items, decided from the definitions (#237). Its items
   * carry no mark where the name is something else's (`outboxMarkInUse`). An item without a mark
   * at its key (written before 1.41.0) is its own only where no other read model's keys can be its
   * own (`outboxKeysApart`) and no other projection of it writes outbox items (an item records
   * its event, not its projection): then the same event's is replaced, as on 1.40.0, after the
   * plain `Put` is cancelled. Anywhere else it is kept, and the item written beside it.
   */
  const outboxStages = (): ReadonlyArray<OutboxStage> => {
    if (outboxTag === undefined || !outboxMarkInUse(readModel)) return ["none"]
    return outboxKeysApart(readModel) && (outboxProjections.get(readModel)?.size ?? 0) <= 1
      ? ["plain", "sameEvent", "beside"]
      : ["plain", "beside"]
  }

  /**
   * The outbox items to write with the row, each at `<row sk>#outbox#<revision>#<n>`, or, at the
   * stage `"beside"`, at that key followed by `#<mark>` ({@link writeRow}).
   */
  const outboxItems = (
    rowKey: Record<string, unknown>,
    revision: number,
    enqueued: ReadonlyArray<Enqueued>,
    mark: 2 | undefined,
    stageOf: (i: number) => OutboxStage,
  ): Effect.Effect<ReadonlyArray<Record<string, AttributeValue>>, ValidationError> =>
    Effect.forEach(enqueued, (e, i) =>
      Effect.gen(function* () {
        const outbox = config.outbox!
        const encoded = yield* S.encodeUnknownEffect(
          writingTuplePositions(outbox.schema) as S.Codec<unknown>,
        )(e.effect).pipe(
          Effect.tap((wire) =>
            outboxReadBack === undefined
              ? Effect.void
              : outboxReadBack(wire).pipe(
                  Effect.mapError((issue) => notReadBack("The outbox effect", issue)),
                ),
          ),
          Effect.mapError(
            (cause) =>
              new ValidationError({ entityType, operation: `${config.label}.outbox`, cause }),
          ),
        )
        const keys = outboxKeys()
        const rowPk = String(rowKey[primary.pk.field])
        const rowSk = String(rowKey[primary.sk.field])
        const stage = stageOf(i)
        const marked =
          stage === "none"
            ? undefined
            : outboxMark(outboxTag!, ownTag, {
                source: e.source,
                streamId: e.event.streamId,
                version: e.event.version,
              })
        const at = `${rowSk}#outbox#${pad(revision, 12)}#${pad(i, 4)}`
        const sk = stage === "beside" ? `${at}#${marked}` : at
        const item: Record<string, unknown> = {
          [keys.pk]: rowPk,
          [keys.sk]: sk,
          __edd_e__: outboxMarker(entityType),
          [ROW_PK]: rowPk,
          [ROW_SK]: rowSk,
          ...(marked !== undefined && { [OUTBOX_READ_MODEL]: marked }),
          effect: encoded,
          source: e.source,
          streamId: e.event.streamId,
          version: e.event.version,
          eventType: e.event.eventType,
          ...(mark !== undefined && { [KEY_TEXT]: mark }),
        }
        if (outbox.index !== undefined) {
          item[outbox.index.pk] = outboxMarker(entityType)
          item[outbox.index.sk] = `${rowPk}#${sk}`
        }
        return yield* marshalOrFail(entityType, `${config.label}.outbox`, () =>
          toAttributeMap(item),
        )
      }),
    )

  /** A lost race, from a single write's failure: the row's Put cancelled. */
  const lostRaceOf = (error: unknown): boolean =>
    isAwsConditionalCheckFailed((error as { readonly cause?: unknown })?.cause)

  /**
   * The condition an outbox item's `Put` carries at `stage` (#237, `outboxStages`): nothing at its
   * key, or the item of the same effect (`outboxMark`); at `"sameEvent"`, also an item without a
   * mark of the same event (its `source`, `streamId` and `version`, as 1.40.0 stored them). None
   * at `"none"`. Another item cancels the write instead of being replaced ({@link writeRow}).
   */
  const outboxGuard = (pk: string, Item: Record<string, AttributeValue>, stage: OutboxStage) => {
    if (stage === "none") return {}
    const rm = Item[OUTBOX_READ_MODEL]!
    if (stage !== "sameEvent") {
      return {
        ConditionExpression: "attribute_not_exists(#pk) OR #rm = :rm",
        ExpressionAttributeNames: { "#pk": pk, "#rm": OUTBOX_READ_MODEL },
        ExpressionAttributeValues: { ":rm": rm },
      }
    }
    return {
      ConditionExpression:
        "attribute_not_exists(#pk) OR #rm = :rm OR " +
        "(attribute_not_exists(#rm) AND #es = :es AND #ei = :ei AND #ev = :ev)",
      ExpressionAttributeNames: {
        "#pk": pk,
        "#rm": OUTBOX_READ_MODEL,
        "#es": "source",
        "#ei": "streamId",
        "#ev": "version",
      },
      ExpressionAttributeValues: {
        ":rm": rm,
        ":es": Item.source!,
        ":ei": Item.streamId!,
        ":ev": Item.version!,
      },
    }
  }

  /** The row (or tombstone) and any outbox items, written as one conditional unit. */
  const writeRow = (
    key: unknown,
    target: Option.Option<Record<string, unknown>>,
    kept: Record<string, unknown>,
    row: Option.Option<Row>,
    enqueued: ReadonlyArray<Enqueued>,
    revision: number | undefined,
    carry: Carry = noCarry,
  ): Effect.Effect<Option.Option<unknown>, any, any> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const TableName = yield* tableName
      const rowKey = composePrimaryKey(readModel as any, key as Record<string, unknown>)
      const condition = guard(row)
      // On a read model whose rows carry the row token (#237), a fresh one recording this layout
      // beside those that wrote the row before, and the term naming the one read.
      const read = Option.isSome(row) ? row.value.item?.[ROW_TOKEN] : undefined
      const tokened = rowTokened(readModel)
      const token = tokened ? yield* freshRowToken([...rowWriters(read), ownTag]) : undefined
      const tokenTerm = tokened ? rowTokenTerm(read) : undefined
      // Without a row token, a projection keeping no revision, writing over a tombstone it read,
      // names the tombstone: `create` over it keeps the checkpoint, which alone would let this
      // write replace the row the `create` wrote (#237).
      const overRead =
        !tokened && config.revision === undefined && Option.isSome(row) && row.value.tombstone
          ? tombstoneTerm
          : undefined
      const term = andRaw(tokenTerm, overRead)
      const createdAt = Option.isSome(row) ? row.value.createdAt : undefined
      // A tombstone or outbox item holds no values, so its key alone says which text it is for
      // `rekey` (`KEY_TEXT`): one under the text of `escapeKeys: true`, where that isn't off's, is
      // marked.
      const mark = readModel._keyTextMark(key as Record<string, unknown>)

      // The row's item: the entity's own `put` (no outbox), or built for a transaction.
      let rowItem: Record<string, AttributeValue> | undefined
      if (Option.isNone(target)) {
        // A tombstone: the key, the kept checkpoint fields, the revision.
        const tc = (yield* readModel._tableTag) as TableConfig
        const now = yield* DateTime.now
        const tomb: Record<string, unknown> = {
          ...rowKey,
          __edd_e__: tombstoneMarker(entityType),
          [REMOVED_AT]: DateTime.formatIso(now),
          ...(mark !== undefined && { [KEY_TEXT]: mark }),
        }
        for (const [f, v] of Object.entries(kept)) tomb[dbName(f)] = v
        Object.assign(tomb, carry.attributes)
        if (token !== undefined) tomb[ROW_TOKEN] = token
        if (config.removal?.ttl !== undefined) {
          tomb[resolveTtlAttributeName(tc)] = Math.floor(
            (DateTime.toEpochMillis(now) + Dur.toMillis(config.removal.ttl)) / 1000,
          )
        }
        // A sparse-map key is refused as the row's own write refuses it. The check flattens a
        // copy: what's stored is the tombstone as 1.39.0 stored it, an empty map whole.
        yield* serializeSparseOrFail(readModel, { ...tomb }, `${config.label}.write`)
        rowItem = yield* marshalOrFail(entityType, `${config.label}.write`, () =>
          toAttributeMap(tomb),
        )
      } else if (enqueued.length > 0) {
        const built = yield* validateAndBuildPutItem(
          readModel as any,
          target.value,
          `${config.label}.write`,
          { createdAt: DateTime.isDateTime(createdAt) ? DateTime.toUtc(createdAt) : undefined },
        )
        for (const [name, value] of Object.entries(carry.fill)) {
          if (!Object.hasOwn(built.item, name)) built.item[name] = value
        }
        Object.assign(built.item, carry.attributes)
        if (token !== undefined) built.item[ROW_TOKEN] = token
        rowItem = toAttributeMap(built.item)
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
        // With a row token the entity writes it, and the carried bookkeeping, as stored, and adds
        // the token's term (without one, the tombstone's); a `create` for a row read absent never
        // takes a tombstone's place.
        const run =
          condition.input === undefined && token === undefined && overRead === undefined
            ? (op.asEffect() as Effect.Effect<unknown, any, any>)
            : (op as EntityPutImpl<any, any, any, any>)._builder("model", {
                condition: (op as EntityPutImpl<any, any, any, any>)._condition,
                withVectors: (op as EntityPutImpl<any, any, any, any>)._withVectors,
                putKind: (op as EntityPutImpl<any, any, any, any>)._putKind,
                createdAt: DateTime.isDateTime(createdAt) ? DateTime.toUtc(createdAt) : undefined,
                ...((token !== undefined || overRead !== undefined) && {
                  projectionWrite: {
                    attributes:
                      token === undefined
                        ? carry.attributes
                        : { ...carry.attributes, [ROW_TOKEN]: token },
                    fill: carry.fill,
                    condition: Option.isSome(row) ? term : undefined,
                    expectAbsent: token !== undefined && Option.isNone(row),
                  },
                }),
              })
        const written = yield* (run as Effect.Effect<unknown, any, any>).pipe(
          Effect.catchTag("ConditionalCheckFailed", () => Effect.fail(new LostRace(key))),
        )
        return Option.some(written)
      }

      const lostRace = (error: unknown) =>
        Effect.fail(lostRaceOf(error) ? new LostRace(key) : error)
      const raw = andRaw(condition.raw, term)!
      const rowPut = {
        Put: {
          TableName,
          Item: rowItem,
          ConditionExpression: raw.expression,
          ExpressionAttributeNames: raw.names,
          ...(Object.keys(raw.values).length > 0 ? { ExpressionAttributeValues: raw.values } : {}),
        },
      } satisfies TransactWriteItem
      if (enqueued.length === 0) {
        yield* client.putItem(rowPut.Put).pipe(Effect.catch((error) => lostRace(error)))
        return target
      }
      // The row and its outbox items in one transaction, read by position (#237): the row's Put
      // cancelled is a lost race, whatever else was; an item's alone is a key holding another
      // effect's item (`outboxGuard`). The whole transaction is sent again, those items at their
      // next stage (`outboxStages`): an item without a mark of the same event replaced, then the
      // item beside it, at its key followed by `#<mark>` (`outboxItems`), so both effects are
      // delivered, in order: the key sorts right after the other's and before the next
      // position's. Nothing is read first, and an item at a free key is written where 1.40.0
      // wrote it. One held beside too is reported, naming what holds it.
      const OutboxTable = yield* outboxTable
      const keys = outboxKeys()
      const stages = outboxStages()
      const reached = new Map<number, number>()
      const stageOf = (i: number) => stages[reached.get(i) ?? 0]!
      while (true) {
        const items = yield* outboxItems(rowKey, revision ?? 0, enqueued, mark, stageOf)
        const sent = yield* client
          .transactWriteItems({
            TransactItems: [
              rowPut,
              ...items.map(
                (Item, i) =>
                  ({
                    Put: {
                      TableName: OutboxTable,
                      Item,
                      ...outboxGuard(keys.pk, Item, stageOf(i)),
                      ...(stageOf(i) === "beside" && {
                        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                      }),
                    },
                  }) satisfies TransactWriteItem,
              ),
            ],
          })
          .pipe(Effect.result)
        if (Result.isSuccess(sent)) return target
        const cause = (sent.failure as { readonly cause?: unknown })?.cause
        if (!isAwsTransactionCancelled(cause)) return yield* Effect.fail(sent.failure)
        const reasons = cause.CancellationReasons ?? []
        const failed = (i: number) => reasons[i]?.Code === "ConditionalCheckFailed"
        if (failed(0)) return yield* Effect.fail(new LostRace(key))
        const held = items.flatMap((_, i) => (failed(i + 1) && stageOf(i) !== "none" ? [i] : []))
        if (held.length === 0) return yield* Effect.fail(sent.failure)
        const again = held.find((i) => stageOf(i) === "beside")
        if (again !== undefined) {
          const holder = reasons[again + 1]?.Item as Record<string, AttributeValue> | undefined
          const other = holder?.[OUTBOX_READ_MODEL]?.S
          return yield* new ValidationError({
            entityType,
            operation: `${config.label}.outbox`,
            cause: withCause(
              `[EDD-9145] ${config.label}: read model ${JSON.stringify(entityType)} ` +
                `(${JSON.stringify(outboxTag)}) found another effect's item at the key of its ` +
                `outbox item ${again} for revision ${revision ?? 0} of row ` +
                `(${JSON.stringify(String(rowKey[primary.pk.field]))}, ` +
                `${JSON.stringify(String(rowKey[primary.sk.field]))}), and the key it writes ` +
                `beside it, ${JSON.stringify(items[again]![keys.sk]?.S)}, which only this ` +
                `effect writes (${JSON.stringify(items[again]![OUTBOX_READ_MODEL]?.S)}), is held ` +
                "too, by " +
                (holder === undefined
                  ? "an item"
                  : `an item of ${JSON.stringify(holder.__edd_e__?.S ?? "no entity type")}` +
                    (other === undefined
                      ? " carrying no mark"
                      : ` marked ${JSON.stringify(other)}`)) +
                ". Nothing was written. The library writes nothing else at that key: was the " +
                "item written outside the projection?",
              sent.failure,
            ),
          })
        }
        for (const i of held) reached.set(i, (reached.get(i) ?? 0) + 1)
      }
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

  /**
   * `[EDD-9133]` once the table's TTL attribute is known: an attribute a projection keeps on the
   * read model's rows that is stored as the TTL attribute, which a projection's tombstones set. The
   * two would overwrite each other, and a row could expire. Every entry point that writes a row
   * runs it before it sends anything, whatever the data: `applyRow` for each row, and `catchUp` and
   * `rebuild` first (`operation` names the entry point). The drains write no row and don't run it:
   * a worker providing only its outbox's table delivers as on 1.39.0.
   */
  const preflight = (operation: string): Effect.Effect<void, ValidationError, any> =>
    Effect.suspend(() =>
      // The table is resolved only when there is something to check.
      !projectionTtlChecked(readModel)
        ? Effect.void
        : Effect.flatMap(readModel._tableTag as Effect.Effect<TableConfig>, (tc) => {
            const problem = projectionTtlConflict(readModel, resolveTtlAttributeName(tc))
            return problem === undefined
              ? Effect.void
              : Effect.fail(
                  new ValidationError({
                    entityType,
                    operation: `${config.label}.${operation}`,
                    cause: problem,
                  }),
                )
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
      // An attribute this projection keeps that another, which has written the row, keeps in
      // another role would be read in the wrong one (`[EDD-9144]`).
      const misread = sharedMeaning(row)
      if (misread !== undefined) {
        return yield* new ValidationError({ entityType, operation: config.label, cause: misread })
      }
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
        // A tombstone keeps the layout's fields, and the bookkeeping of the other projections that
        // have written the row (`carriedOf`), so they still recognise what they applied.
        written = yield* writeRow(key, Option.none(), pick(target), row, enqueued, nextRevision, {
          attributes: carriedOf(row, "tombstone"),
          fill: {},
        })
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
        // The bookkeeping of the other projections that have written the row (`carriedOf`): over
        // a tombstone it replaces what `initial` gave it; over a live row it fills what the state
        // left out (a `toItem` that drops it, say), and a change to it is refused (`[EDD-9144]`).
        // A rebuild over a live row carries none: it drops the other projections' contributions to
        // the state, so they lose their checkpoints too and apply again.
        let carry = noCarry
        if (Option.isSome(row) && row.value.tombstone) {
          carry = { attributes: carriedOf(row, "row"), fill: {} }
        } else if (Option.isSome(row) && !fromScratch) {
          const changed = sharedMeaning(row, mapped)
          if (changed !== undefined) {
            return yield* new ValidationError({
              entityType,
              operation: config.label,
              cause: changed,
            })
          }
          carry = { attributes: {}, fill: carriedOf(row, "row") }
        }
        written = yield* writeRow(key, Option.some(mapped), {}, row, enqueued, nextRevision, carry)
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
    return Effect.andThen(preflight("apply"), withRetry(attempt))
  }

  /**
   * The bookkeeping attributes of the read model's other projections that have written `row`, as
   * its row token records them (`rowWriters`, #237). None for a row without one (written before,
   * or by a program that defines only this projection) or of a projection this program doesn't
   * define: its names can't be told from another's data.
   */
  const writtenBy = (
    row: Option.Option<Row>,
  ): ReadonlyArray<{
    readonly layout: ProjectionLayout
    readonly field: string
    readonly role: ProjectionRole
    readonly stored: string
  }> => {
    if (Option.isNone(row)) return []
    const writers = new Set(rowWriters(row.value.item?.[ROW_TOKEN]))
    writers.delete(ownTag)
    if (writers.size === 0) return []
    const out: Array<{
      readonly layout: ProjectionLayout
      readonly field: string
      readonly role: ProjectionRole
      readonly stored: string
    }> = []
    for (const layout of projectionLayoutsOf(readModel) ?? []) {
      if (!writers.has(layoutTag(layout))) continue
      for (const [field, role] of layout.roles) {
        out.push({ layout, field, role, stored: dbName(field) })
      }
    }
    return out
  }

  /**
   * `[EDD-9144]` (#237): an attribute holding two meanings on `row`. Another projection that has
   * written the row (`writtenBy`) keeps it as bookkeeping and this projection keeps it in another
   * role, so each would read the other's value as its own; or, given `item` (what a write over the
   * live row stores), this write gives it another value than the row holds without keeping it in
   * that role. The problem, or `undefined`. On rows only one of them writes nothing is refused:
   * projections writing disjoint rows may give one name different meanings.
   */
  const sharedMeaning = (
    row: Option.Option<Row>,
    item?: Record<string, unknown>,
  ): string | undefined => {
    for (const { layout, field, role, stored } of writtenBy(row)) {
      const mine = ownRoles.get(stored)
      if (mine?.has(role)) continue
      if (mine !== undefined) {
        return (
          `[EDD-9144] ${config.label}: on read model "${entityType}", "${field}" is ` +
          `${layout.label}'s ${role} on a row ${layout.label} has written, and this ` +
          `projection's ${[...mine].join(" and ")}. An attribute holds one meaning on a row two ` +
          "projections write: give each meaning its own field."
        )
      }
      if (item === undefined || Option.isNone(row) || row.value.tombstone) continue
      const value = item[field]
      const held = Object.hasOwn(row.value.values, field) ? row.value.values[field] : undefined
      if (value === undefined || sameValue(value, held)) continue
      return (
        `[EDD-9144] ${config.label}: on read model "${entityType}", this write changes ` +
        `"${field}", which is ${layout.label}'s ${role}, on a row ${layout.label} has written. ` +
        "An attribute holds one meaning on a row two projections write: give each meaning its " +
        "own field."
      )
    }
    return undefined
  }

  /**
   * The bookkeeping of the other projections that have written `row` (`writtenBy`), as the row
   * stores it, by stored name: each attribute once, none this projection keeps. `onto` is what
   * the write stores: a tombstone keeps a map whole, a row as its sparse entries. A value the
   * write couldn't store (a 1.39.0 tombstone's sparse map holding a key with `#`) isn't carried.
   */
  const carriedOf = (
    row: Option.Option<Row>,
    onto: "row" | "tombstone",
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const others = writtenBy(row)
    if (others.length === 0 || Option.isNone(row) || row.value.item === undefined) return out
    const stored = fromAttributeMap(row.value.item) as Record<string, unknown>
    const seen = new Set<string>()
    for (const { stored: name } of others) {
      if (ownRoles.has(name) || seen.has(name) || !Object.hasOwn(stored, name)) continue
      seen.add(name)
      const part: Record<string, unknown> = { [name]: stored[name] }
      try {
        readModel._serializeSparseFields(part)
      } catch {
        continue
      }
      Object.assign(out, onto === "row" ? part : { [name]: stored[name] })
    }
    return out
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

  // A decode that dies on an absent attribute fails as 1.39.0's did (`decodingAsBefore`).
  const decodeEffect = decodingAsBefore(
    readingStreamValues(config.outbox?.schema ?? S.Unknown),
    config.outbox?.schema ?? S.Unknown,
  )

  /**
   * Deliver a row's pending effects in order: claim the head item, deliver it,
   * delete it, repeat. A claim another drainer holds stops the drain; a crash
   * leaves a claim that expires, so the effect is delivered again.
   *
   * Each item is judged as it comes to the head (`outboxOwnership`, #237): another read model's
   * item at this row key (one keyed by `[shop]` with `north#branch_b1` beside one keyed by
   * `[shop, branch]`) is passed over, unclaimed, for its own drainer, and the query goes on after
   * it. A row holding only this read model's items sends the requests 1.40.0 sent.
   */
  const drainRaw = <E, R>(
    rowPk: string,
    rowSk: string,
    deliver: (effect: any, meta: OutboxMeta) => Effect.Effect<void, E, R>,
  ): Effect.Effect<DrainResult<E>, any, any> =>
    Effect.gen(function* () {
      const outbox = config.outbox!
      const client = yield* Capacity.client
      const TableName = yield* outboxTable
      const keys = outboxKeys()
      const whose = outboxOwnership(readModel)
      let delivered = 0
      // The last item passed over as another read model's: the query goes on after it.
      let after: Record<string, AttributeValue> | undefined
      while (true) {
        const page = yield* client.query({
          TableName,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
          ExpressionAttributeNames: { "#pk": keys.pk, "#sk": keys.sk },
          ExpressionAttributeValues: toAttributeMap({ ":pk": rowPk, ":sk": `${rowSk}#outbox#` }),
          ConsistentRead: true,
          Limit: 1,
          ...(after === undefined ? {} : { ExclusiveStartKey: after }),
        })
        const head = page.Items?.[0]
        if (head === undefined) return { delivered, undelivered: Option.none() }
        if (whose(head) === "foreign") {
          after = { [keys.pk]: head[keys.pk]!, [keys.sk]: head[keys.sk]! }
          continue
        }
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
        const effect = yield* decodeEffect(raw.effect).pipe(
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

  const drain = <E, R>(
    key: unknown,
    deliver: (effect: any, meta: OutboxMeta) => Effect.Effect<void, E, R>,
  ) => {
    const rowKey = composePrimaryKey(readModel as any, key as Record<string, unknown>)
    return drainRaw(String(rowKey[primary.pk.field]), String(rowKey[primary.sk.field]), deliver)
  }

  /**
   * Every row of this read model with pending effects, through the outbox's sparse index, drained.
   * The items another read model's are (`outboxOwnership`) are left to its drainer, here and at a
   * row key both write (`drainRaw`); an item written before 1.41.0 at a key both write is drained,
   * as 1.40.0 did.
   */
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
      const whose = outboxOwnership(readModel)
      const rows = new Map<string, readonly [string, string]>()
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
          if (whose(item) === "foreign") continue
          const raw = fromAttributeMap(item) as Record<string, unknown>
          const pk = String(raw[ROW_PK])
          const sk = String(raw[ROW_SK])
          rows.set(`${pk}\u0000${sk}`, [pk, sk])
        }
        start = page.LastEvaluatedKey
      } while (start !== undefined)
      let delivered = 0
      const undelivered: Array<{ readonly meta: OutboxMeta; readonly error: E }> = []
      for (const [pk, sk] of rows.values()) {
        const result = yield* drainRaw(pk, sk, deliver)
        delivered += result.delivered
        if (Option.isSome(result.undelivered)) undelivered.push(result.undelivered.value)
      }
      return { delivered, undelivered }
    })

  return {
    readRow,
    // A key the row can't compose is that row's failure, not the batch's.
    applyRow: (
      key: unknown,
      work: ReadonlyArray<InstanceWork>,
      options?: { readonly fromScratch?: boolean | undefined },
    ): Effect.Effect<RowResult, any, any> =>
      Capacity.refusalsFail(
        `${config.label}.apply`,
        { target: entityType },
        applyRow(key, work, options),
      ),
    drain,
    drainPending,
    preflight,
    call,
  }
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
