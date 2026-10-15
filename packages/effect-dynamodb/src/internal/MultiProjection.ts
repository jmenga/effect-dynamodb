/**
 * Multi-source projections (#153): read-model rows that several streams
 * contribute to, with a checkpoint per source instance, gap-filling per
 * instance, and one write per row guarded by the row's revision.
 *
 * Re-exported from `EventStore`; built on `ProjectionEngine`.
 *
 * @internal
 */

import type {
  ConcurrentModification,
  ProjectionSourceConflict,
  StreamRecordIdentifierMissing,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Duration, Effect, Option, Pipeable, Result, type Schedule } from "effect"
import type { DynamoClient, DynamoClientError } from "../DynamoClient.js"
import type { EventStream, StreamEvent, StreamIdInput, StreamMetadata } from "../EventStore.js"
import type { TableConfig } from "../Table.js"
import {
  type ApplyBatchOptions,
  type CheckpointField,
  type DecodableStream,
  type IdentifyBySource,
  type IdentifyWith,
  type ProcessBatchOptions,
  type ProjectionKey,
  type ProjectionOutboxConfig,
  type ProjectionReadModel,
  type ProjectionReadModelError,
  type ProjectionRevision,
  ProjectionRoutes,
  type ProjectionState,
  type Route,
  refuseReadModel,
  resolveOutbox,
  resolveRevision,
  runBatch,
  type StreamRecord,
} from "./EventProjection.js"
import type { StreamImage } from "./Packed.js"
import {
  addressed,
  type DrainResult,
  type EngineEntity,
  type EngineSource,
  type EvolveContext,
  type InstanceWork,
  instanceKey,
  keyId,
  makeEngine,
  type OutboxMeta,
  type RemoveRow,
  type RowResult,
  retrySchedule,
} from "./ProjectionEngine.js"

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

type AnyStream = EventStream<any, any, any, any, any, any, any>

type EventOfStream<St> =
  St extends EventStream<infer A, any, infer M, any, any, any, any>
    ? StreamEvent<A, StreamMetadata<M>>
    : never
type IdOfStream<St> =
  St extends EventStream<any, infer F, any, any, any, any, any> ? StreamIdInput<F> : never

const MultiSourceTypeId: unique symbol = Symbol.for("effect-dynamodb/MultiProjection/Source")

/** One source of a multi-source projection — built with the `source` helper. */
export interface MultiSource<St extends AnyStream, K, S, E, R> {
  readonly [MultiSourceTypeId]: {
    readonly _St: St
    readonly _E: E
    readonly _R: R
  }
  readonly stream: St
  // Methods, not function properties: bivariant parameters, so any source is
  // an `AnySource` (the same reason `EventStream.writeSnapshot` is a method).
  key(streamId: IdOfStream<St>, event: EventOfStream<St>): K | Option.Option<K>
  evolve(
    state: S,
    event: EventOfStream<St>,
    context: EvolveContext,
  ): Effect.Effect<S | RemoveRow, E, R>
  readonly mode: "fold" | "latest"
  terminal(error: E): boolean
}

/** A source's configuration. */
export interface MultiSourceConfig<St extends AnyStream, K, S, E, R> {
  /** The row an event contributes to — `Option.none()`: none. */
  readonly key: (streamId: IdOfStream<St>, event: EventOfStream<St>) => K | Option.Option<K>
  /**
   * Fold one event into the row's state (the whole row: every source's part).
   * Sources interleave in any order across writes, so a source's `evolve` must
   * not depend on another's having run first. Return `EventStore.removeRow` to
   * remove the row (with `removal`).
   */
  readonly evolve: (
    state: S,
    event: EventOfStream<St>,
    context: EvolveContext,
  ) => Effect.Effect<S | RemoveRow, E, R>
  /**
   * `"fold"` (default): every event, in version order, gaps filled from the
   * store — for contributions that change a few fields (deltas). `"latest"`:
   * only the newest event of each instance in a batch (the rest are
   * `superseded`), nothing read — for events that carry the source's whole
   * part. The mode is a declaration: the library can't tell one from the other.
   */
  readonly mode?: "fold" | "latest" | undefined
  /** The `evolve` failures that reject their event — see `projection`'s `terminal`. */
  readonly terminal?: ((error: E) => boolean) | undefined
}

/** The `source` helper `sources` receives. */
export type SourceBuilder<K, S> = <St extends AnyStream, E = never, R = never>(
  stream: St,
  config: MultiSourceConfig<St, K, S, E, R>,
) => MultiSource<St, K, S, E, R>

type AnySource = MultiSource<any, any, any, any, any>
type SourceStream<Src> = Src extends MultiSource<infer St, any, any, any, any> ? St : never
type SourceError<Src> = Src extends MultiSource<any, any, any, infer E, any> ? E : never
type SourceRequirements<Src> = Src extends MultiSource<any, any, any, any, infer R> ? R : never

/** A decoded event of one of the sources, tagged with the source's name. */
export type MultiSourceEvent<Sources extends Record<string, AnySource>> = {
  readonly [N in keyof Sources & string]: {
    readonly stream: N
    readonly event: EventOfStream<SourceStream<Sources[N]>>
  }
}[keyof Sources & string]

// ---------------------------------------------------------------------------
// Configuration and results
// ---------------------------------------------------------------------------

/** Where a multi-source row keeps its checkpoints — at least one of `field` / `sources`. */
export interface MultiCheckpoints<S, SourceName extends string> {
  /** A `Record<string, number>` model field, keyed `<source>#<streamId>`. */
  readonly field?: RecordField<S> | undefined
  /**
   * Compatibility with rows that keep one numeric field per source: the
   * field (`version + offset`) and `instanceField`, a string field recording
   * which stream instance owns it. An instance arriving while another owns
   * the field goes to `field`'s map, or — without one — fails with
   * `ProjectionSourceConflict`.
   */
  readonly sources?:
    | {
        readonly [N in SourceName]?: {
          readonly field: CheckpointField<S>
          readonly offset?: number | undefined
          readonly instanceField: StringField<S>
        }
      }
    | undefined
}

/** The model's `Record<string, number>` fields. */
export type RecordField<S> = {
  [F in keyof S]-?: S[F] extends Readonly<Record<string, number>>
    ? S[F] extends number
      ? never
      : F
    : never
}[keyof S] &
  string
/** The model's string fields. */
export type StringField<S> = { [F in keyof S]-?: S[F] extends string ? F : never }[keyof S] & string

/** Configuration of {@link multiProjection}. */
export interface MultiProjectionConfig<
  RM extends ProjectionReadModel,
  Sources extends Record<string, AnySource>,
  O,
> {
  readonly readModel: RM
  /** The state a row starts from, before the first event folded into it. */
  readonly initial: (key: ProjectionKey<RM>) => ProjectionState<RM>
  /** The sources, built with the `source` helper: `(source) => ({ name: source(stream, { … }) })`. */
  readonly sources: (source: SourceBuilder<ProjectionKey<RM>, ProjectionState<RM>>) => Sources
  readonly checkpoints: MultiCheckpoints<ProjectionState<RM>, keyof Sources & string>
  /** The revision field (required) — see `projection`'s `revision`. */
  readonly revision: ProjectionRevision<ProjectionState<RM>>
  /** The row as written, from the folded state — see `projection`'s `toItem`. */
  readonly toItem?:
    | ((
        state: ProjectionState<RM>,
        context: { readonly key: ProjectionKey<RM> },
      ) => ProjectionState<RM>)
    | undefined
  readonly retry?: number | Schedule.Schedule<unknown, ConcurrentModification> | undefined
  readonly removal?: { readonly ttl?: Duration.Input | undefined } | undefined
  readonly outbox?:
    | ProjectionOutboxConfig<O, MultiSourceEvent<Sources>["event"], ProjectionState<RM>>
    | undefined
  /**
   * The source instances that contribute to a row, for `rebuild` without
   * `instances` — over a stream index, say.
   */
  readonly sourcesOf?:
    | ((key: ProjectionKey<RM>) => Effect.Effect<RebuildInstances<Sources>, any, any>)
    | undefined
}

/** The instances to rebuild a row from, by source. */
export type RebuildInstances<Sources extends Record<string, AnySource>> = {
  readonly [N in keyof Sources]?: ReadonlyArray<IdOfStream<SourceStream<Sources[N]>>>
}

/** One source instance's share of a row's result. */
export type MultiInstanceResult<Sources extends Record<string, AnySource>> = {
  readonly [N in keyof Sources & string]: {
    readonly source: N
    readonly streamId: string
    readonly applied: ReadonlyArray<EventOfStream<SourceStream<Sources[N]>>>
    readonly alreadyApplied: ReadonlyArray<EventOfStream<SourceStream<Sources[N]>>>
    readonly rejected: ReadonlyArray<{
      readonly event: EventOfStream<SourceStream<Sources[N]>>
      readonly error: SourceError<Sources[N]>
    }>
    /** `"latest"` mode: the instance's older events in the batch, passed over. */
    readonly superseded: ReadonlyArray<EventOfStream<SourceStream<Sources[N]>>>
    /** The instance's checkpoint after the call. */
    readonly version: number
  }
}[keyof Sources & string]

/** A row applied by a multi-source projection. */
export interface MultiApplied<S, K, Sources extends Record<string, AnySource>> {
  readonly key: K
  readonly instances: ReadonlyArray<MultiInstanceResult<Sources>>
  /** The row as written (or read) — none when removed or never created. */
  readonly state: Option.Option<S>
  readonly removed: boolean
  /** The row's revision after the call. */
  readonly revision: number | undefined
  readonly enqueued: number
  readonly undelivered: Option.Option<{ readonly meta: OutboxMeta; readonly error: unknown }>
}

/** A row's outcome in a multi-source batch. */
export type MultiOutcome<S, K, Sources extends Record<string, AnySource>, Err> =
  | ({
      readonly _tag: "Applied"
      /** Positions of the row's events in the input, ascending. */
      readonly positions: ReadonlyArray<number>
    } & MultiApplied<S, K, Sources>)
  | {
      readonly _tag: "Failed"
      /** Undefined when the row could not be determined (a stream id or `key` failed). */
      readonly key: K | undefined
      readonly positions: ReadonlyArray<number>
      readonly error: Err
    }

/** Result of {@link MultiProjection.applyBatch}. */
export interface MultiBatchResult<S, K, Sources extends Record<string, AnySource>, Err> {
  readonly outcomes: ReadonlyArray<MultiOutcome<S, K, Sources, Err>>
  readonly failedPositions: ReadonlyArray<number>
  readonly ignored: ReadonlyArray<number>
}

/** What a multi-source projection's operations fail with. */
export type MultiProjectionError<RM, Sources extends Record<string, AnySource>> =
  | SourceError<Sources[keyof Sources]>
  | ProjectionReadModelError<RM>
  | DynamoClientError
  | ValidationError
  | ConcurrentModification
  | ProjectionSourceConflict

const MultiProjectionTypeId: unique symbol = Symbol.for("effect-dynamodb/MultiProjection")

/** A multi-source projection — see {@link multiProjection}. */
export interface MultiProjection<S, K, Sources extends Record<string, AnySource>, Err, R, O = never>
  extends Pipeable.Pipeable {
  readonly [MultiProjectionTypeId]: typeof MultiProjectionTypeId
  /** @internal */
  readonly [ProjectionRoutes]: (name: string) => ReadonlyArray<Route>
  readonly entityType: string
  readonly sources: Sources

  /**
   * Apply a batch of decoded events of the sources (tagged by source name, as
   * `EventStore.decoder` returns them). Per row, across sources: read the row,
   * and per instance drop what its checkpoint covers, gap-fill (`fold`) or
   * take the newest (`latest`); fold sources as declared, then by stream id;
   * write once, conditioned on the revision. Never fails: each row's failure
   * is its outcome.
   */
  applyBatch(
    events: ReadonlyArray<MultiSourceEvent<Sources>>,
    options?: ApplyBatchOptions | undefined,
  ): Effect.Effect<MultiBatchResult<S, K, Sources, Err>, never, R>

  /** Bring every instance the row's checkpoints know up to its stream's head. */
  catchUp(key: K): Effect.Effect<MultiApplied<S, K, Sources>, Err, R>

  /**
   * Re-derive a row from the named instances (or `sourcesOf`): fold each
   * one's events keyed to the row from `initial`, checkpoints from scratch,
   * written with the next revision. The repair path — a scalar checkpoint
   * owned by the wrong instance is reassigned to the first instance in fold
   * order.
   */
  rebuild(
    key: K,
    options?: { readonly instances?: RebuildInstances<Sources> | undefined } | undefined,
  ): Effect.Effect<MultiApplied<S, K, Sources>, Err, R>

  /** Decode a raw change-feed batch, apply it, and build the partial batch response. */
  processBatch<Rec extends StreamRecord>(
    records: ReadonlyArray<Rec>,
    options: ProcessBatchOptions<Rec> & (IdentifyBySource | IdentifyWith<Rec>),
  ): Effect.Effect<
    {
      readonly outcomes: ReadonlyArray<MultiOutcome<S, K, Sources, Err>>
      readonly decodeFailures: ReadonlyArray<{
        readonly record: Rec
        readonly error: ValidationError
      }>
      readonly failedRecords: ReadonlyArray<Rec>
      readonly response: { readonly batchItemFailures: Array<{ readonly itemIdentifier: string }> }
    },
    StreamRecordIdentifierMissing,
    R
  >

  /** See `projection`'s `drain`. */
  drain<DE, DR>(
    key: K,
    deliver: (effect: O, meta: OutboxMeta) => Effect.Effect<void, DE, DR>,
  ): Effect.Effect<DrainResult<DE>, DynamoClientError | ValidationError, R | DR>

  /** See `projection`'s `drainPending`. */
  drainPending<DE, DR>(
    deliver: (effect: O, meta: OutboxMeta) => Effect.Effect<void, DE, DR>,
  ): Effect.Effect<
    {
      readonly delivered: number
      readonly undelivered: ReadonlyArray<{ readonly meta: OutboxMeta; readonly error: DE }>
    },
    DynamoClientError | ValidationError,
    R | DR
  >
}

/** @internal */
export const isMultiProjection = (u: unknown): u is MultiProjection<any, any, any, any, any, any> =>
  typeof u === "object" && u !== null && MultiProjectionTypeId in u

// ---------------------------------------------------------------------------
// multiProjection
// ---------------------------------------------------------------------------

/**
 * A projection of several source streams into one read model: each row keeps
 * a checkpoint per contributing source instance (`checkpoints`), and every
 * write is guarded by the row's `revision`, so writers serving different
 * sources serialise. See {@link MultiProjection}.
 *
 * @example
 * ```ts
 * const Shipments = EventStore.multiProjection({
 *   readModel: ShipmentSummaries,
 *   initial: (key) => ShipmentSummary.empty(key),
 *   sources: (source) => ({
 *     order: source(OrderEvents, { key: (id, e) => …, evolve: … }),
 *     scan: source(ScanEvents, { key: …, evolve: …, mode: "latest" }),
 *   }),
 *   checkpoints: { field: "checkpoints" },
 *   revision: "revision",
 * })
 * ```
 */
export const multiProjection = <
  RM extends ProjectionReadModel,
  Sources extends Record<string, AnySource>,
  O = never,
>(
  config: MultiProjectionConfig<RM, Sources, O>,
): MultiProjection<
  ProjectionState<RM>,
  ProjectionKey<RM>,
  Sources,
  MultiProjectionError<RM, Sources>,
  SourceRequirements<Sources[keyof Sources]> | DynamoClient | TableConfig,
  O
> => {
  type S = ProjectionState<RM>
  type K = ProjectionKey<RM>
  type Err = MultiProjectionError<RM, Sources>
  type Req = SourceRequirements<Sources[keyof Sources]> | DynamoClient | TableConfig
  type Applied = MultiApplied<S, K, Sources>
  type Outcome = MultiOutcome<S, K, Sources, Err>
  type Tagged = { readonly stream: string; readonly event: StreamEvent<unknown, unknown> }

  const { readModel } = config
  const sources = config.sources((stream, source) => ({
    [MultiSourceTypeId]: undefined as never,
    stream,
    key: source.key,
    evolve: source.evolve,
    mode: source.mode ?? "fold",
    terminal: source.terminal ?? (() => false),
  })) as Sources
  const names = Object.keys(sources)
  const label = `EventStore.multiProjection("${readModel.entityType}")`
  const mapped = (config.checkpoints.sources ?? {}) as Record<
    string,
    { readonly field: string; readonly offset?: number; readonly instanceField: string }
  >
  if (config.checkpoints.field === undefined && Object.keys(mapped).length === 0) {
    throw new Error(
      `[EDD-9081] ${label}: \`checkpoints\` declares neither \`field\` nor \`sources\`.`,
    )
  }
  for (const name of Object.keys(mapped)) {
    if (!names.includes(name)) {
      throw new Error(`[EDD-9081] ${label}: \`checkpoints.sources.${name}\` names no source.`)
    }
  }
  if (config.checkpoints.field === undefined) {
    for (const name of names) {
      if (mapped[name] === undefined) {
        throw new Error(
          `[EDD-9081] ${label}: source "${name}" has no checkpoint — declare \`checkpoints.field\` ` +
            "(a map for every source) or a field for it in `checkpoints.sources`.",
        )
      }
    }
  }
  const revision = resolveRevision(config.revision)!
  refuseReadModel(label, readModel, {
    fields: [
      revision.field,
      ...(config.checkpoints.field === undefined ? [] : [config.checkpoints.field as string]),
      ...Object.values(mapped).flatMap((f) => [f.field, f.instanceField]),
    ],
    removal: config.removal !== undefined,
    outbox: config.outbox !== undefined,
    revision: revision.field,
  })

  const engineSources: Record<string, EngineSource> = {}
  for (const name of names) {
    const src = sources[name]!
    engineSources[name] = {
      name,
      stream: src.stream as unknown as EngineSource["stream"],
      key: src.key as EngineSource["key"],
      evolve: src.evolve as EngineSource["evolve"],
      mode: src.mode,
      terminal: src.terminal as EngineSource["terminal"],
    }
  }
  const engine = makeEngine({
    label,
    readModel: readModel as unknown as EngineEntity,
    sources: names.map((n) => engineSources[n]!),
    initial: (key) => config.initial(key as K),
    checkpoints: {
      kind: "sources",
      map: config.checkpoints.field as string | undefined,
      fields: Object.fromEntries(
        Object.entries(mapped).map(([n, f]) => [
          n,
          { field: f.field, offset: f.offset ?? 0, instanceField: f.instanceField },
        ]),
      ),
    },
    revision,
    toItem: config.toItem as never,
    toItemContext: (key) => ({ key }),
    retry: retrySchedule(config.retry),
    removal:
      config.removal === undefined
        ? undefined
        : {
            ttl:
              config.removal.ttl === undefined
                ? undefined
                : Duration.fromInputUnsafe(config.removal.ttl),
          },
    outbox: resolveOutbox(config.outbox as never),
  })

  const appliedOf = (result: RowResult): Applied => ({
    key: result.key as K,
    instances: result.instances as unknown as Applied["instances"],
    state: result.state as Option.Option<S>,
    removed: result.removed,
    revision: result.revision,
    enqueued: result.enqueued,
    undelivered: Option.none(),
  })

  const deliverAfter = (applied: Applied, deliver: ApplyBatchOptions["deliver"]) =>
    deliver === undefined || config.outbox === undefined || applied.enqueued === 0
      ? Effect.succeed(applied)
      : (
          engine.drain(applied.key, deliver as never) as Effect.Effect<
            DrainResult<unknown>,
            Err,
            Req
          >
        ).pipe(
          Effect.map((drained) => ({
            ...applied,
            undelivered: drained.undelivered as Applied["undelivered"],
          })),
        )

  const applyBatch = (
    events: ReadonlyArray<Tagged>,
    options?: ApplyBatchOptions | undefined,
  ): Effect.Effect<MultiBatchResult<S, K, Sources, Err>, never, Req> =>
    Effect.gen(function* () {
      // By source instance, in order of first delivery.
      const instances = new Map<
        string,
        {
          source: EngineSource
          streamIdStr: string
          positions: Array<number>
          events: Array<StreamEvent<unknown, unknown>>
        }
      >()
      events.forEach((tagged, position) => {
        const source = engineSources[tagged.stream]
        if (source === undefined) return
        const id = `${tagged.stream}\u0000${tagged.event.streamId}`
        const group = instances.get(id)
        if (group === undefined) {
          instances.set(id, {
            source,
            streamIdStr: tagged.event.streamId,
            positions: [position],
            events: [tagged.event],
          })
        } else {
          group.positions.push(position)
          group.events.push(tagged.event)
        }
      })
      const ignored: Array<number> = []
      const failed: Array<Outcome> = []
      // Rows across sources: each row's work, one entry per instance.
      const rows = new Map<
        string,
        {
          key: K
          positions: Array<number>
          work: Array<InstanceWork>
          /** Each instance's positions in this row, by `<source>\u0000<streamId>`. */
          byInstance: Map<string, Array<number>>
        }
      >()
      for (const group of instances.values()) {
        const placed = yield* Effect.result(
          Effect.gen(function* () {
            const streamId = yield* group.source.stream.parseStreamId(group.streamIdStr)
            const byRow = new Map<
              string,
              { key: K; positions: Array<number>; events: Array<StreamEvent<unknown, unknown>> }
            >()
            for (let i = 0; i < group.events.length; i++) {
              const event = group.events[i]!
              const key = addressed<K>(
                yield* engine.call("key", () => group.source.key(streamId, event)),
              )
              if (Option.isNone(key)) {
                ignored.push(group.positions[i]!)
                continue
              }
              const id = keyId(key.value)
              const row = byRow.get(id)
              if (row === undefined)
                byRow.set(id, { key: key.value, positions: [group.positions[i]!], events: [event] })
              else {
                row.positions.push(group.positions[i]!)
                row.events.push(event)
              }
            }
            return { streamId, byRow }
          }),
        )
        if (Result.isFailure(placed)) {
          failed.push({
            _tag: "Failed",
            key: undefined,
            positions: group.positions,
            error: placed.failure as Err,
          })
          continue
        }
        const delivered = new Set(group.events.map((e) => e.version))
        for (const [id, row] of placed.success.byRow) {
          const ordered = [...row.events]
            .sort((a, b) => a.version - b.version)
            .filter((e, i, sorted) => i === 0 || sorted[i - 1]!.version !== e.version)
          const entry = rows.get(id) ?? {
            key: row.key,
            positions: [] as Array<number>,
            work: [] as Array<InstanceWork>,
            byInstance: new Map<string, Array<number>>(),
          }
          entry.positions.push(...row.positions)
          entry.byInstance.set(`${group.source.name}\u0000${group.streamIdStr}`, row.positions)
          entry.work.push({
            source: group.source,
            streamIdStr: group.streamIdStr,
            streamId: placed.success.streamId,
            events: ordered,
            top: 0,
            delivered,
          })
          rows.set(id, entry)
        }
      }
      const tasks = [...rows.values()].map((row) => {
        const positions = row.positions.sort((a, b) => a - b)
        return {
          first: positions[0]!,
          run: Effect.result(
            Effect.gen(function* () {
              const result = (yield* engine.applyRow(row.key, row.work)) as RowResult
              return { result, applied: yield* deliverAfter(appliedOf(result), options?.deliver) }
            }) as Effect.Effect<{ result: RowResult; applied: Applied }, Err, Req>,
          ).pipe(
            Effect.map((outcome): ReadonlyArray<Outcome> => {
              if (Result.isFailure(outcome)) {
                return [{ _tag: "Failed", key: row.key, positions, error: outcome.failure }]
              }
              // The instances that failed are their own outcomes; the rest applied.
              const failedAt = new Set<number>()
              const instanceFailures: Array<Outcome> = outcome.success.result.failed.map((f) => {
                const at = row.byInstance.get(`${f.source}\u0000${f.streamId}`) ?? []
                for (const p of at) failedAt.add(p)
                return { _tag: "Failed", key: row.key, positions: at, error: f.error as Err }
              })
              return [
                {
                  _tag: "Applied",
                  positions: positions.filter((p) => !failedAt.has(p)),
                  ...outcome.success.applied,
                },
                ...instanceFailures,
              ]
            }),
          ),
        }
      })
      tasks.sort((a, b) => a.first - b.first)
      const outcomes = [
        ...failed,
        ...(yield* Effect.forEach(tasks, (task) => task.run, {
          concurrency: options?.concurrency ?? 10,
        })).flat(),
      ]
        .filter((o) => o._tag === "Failed" || o.positions.length > 0 || o.instances.length > 0)
        .sort((a, b) => (a.positions[0] ?? 0) - (b.positions[0] ?? 0))
      return {
        outcomes,
        failedPositions: outcomes
          .filter((o) => o._tag === "Failed")
          .map((o) => o.positions[0]!)
          .sort((a, b) => a - b),
        ignored: ignored.sort((a, b) => a - b),
      }
    }) as Effect.Effect<MultiBatchResult<S, K, Sources, Err>, never, Req>

  /** The instances a row's checkpoints know: map entries, and field owners. */
  const knownInstances = (values: Record<string, unknown>): Array<readonly [string, string]> => {
    const known: Array<readonly [string, string]> = []
    const map =
      config.checkpoints.field === undefined
        ? {}
        : ((values[config.checkpoints.field] ?? {}) as Record<string, number>)
    for (const entry of Object.keys(map)) {
      const at = entry.indexOf("#")
      if (at > 0) known.push([entry.slice(0, at), entry.slice(at + 1)])
    }
    for (const [name, f] of Object.entries(mapped)) {
      const owner = values[f.instanceField]
      if (typeof owner === "string" && owner !== "") known.push([name, owner])
    }
    return known.filter(([name]) => engineSources[name] !== undefined)
  }

  const catchUp = (key: K): Effect.Effect<Applied, Err, Req> =>
    Effect.gen(function* () {
      const row = yield* engine.readRow(key)
      if (Option.isNone(row)) {
        return appliedOf({
          key,
          instances: [],
          state: Option.none(),
          removed: false,
          revision: undefined,
          enqueued: 0,
          failed: [],
        })
      }
      const work: Array<InstanceWork> = []
      for (const [name, streamIdStr] of knownInstances(row.value.values)) {
        const source = engineSources[name]!
        const streamId = yield* source.stream.parseStreamId(streamIdStr)
        const head = yield* (source.stream as unknown as AnyStream).currentVersion(streamId, {
          consistentRead: true,
        })
        work.push({
          source,
          streamIdStr,
          streamId,
          events: undefined,
          top: head as number,
          delivered: new Set(),
        })
      }
      return appliedOf((yield* engine.applyRow(key, work)) as RowResult)
    }) as Effect.Effect<Applied, Err, Req>

  const rebuild = (
    key: K,
    options?: { readonly instances?: RebuildInstances<Sources> | undefined } | undefined,
  ): Effect.Effect<Applied, Err, Req> =>
    Effect.gen(function* () {
      const named =
        options?.instances ??
        (config.sourcesOf === undefined
          ? yield* Effect.die(
              new Error(
                `[EDD-9081] ${label}.rebuild: pass \`instances\`, or declare \`sourcesOf\`.`,
              ),
            )
          : ((yield* config.sourcesOf(key)) as RebuildInstances<Sources>))
      const rowId = keyId(key)
      const work: Array<InstanceWork> = []
      for (const name of names) {
        const ids = ((named as Record<string, ReadonlyArray<unknown>>)[name] ??
          []) as ReadonlyArray<Record<string, string>>
        const source = engineSources[name]!
        for (const streamId of ids) {
          const events = (yield* source.stream.read(streamId, { consistentRead: true })) as Array<
            StreamEvent<unknown, unknown>
          >
          const mine: Array<StreamEvent<unknown, unknown>> = []
          for (const event of events) {
            const k = addressed<K>(yield* engine.call("key", () => source.key(streamId, event)))
            if (Option.isSome(k) && keyId(k.value) === rowId) mine.push(event)
          }
          if (mine.length === 0) continue
          work.push({
            source,
            streamIdStr: source.stream.streamIdFields.map((f) => streamId[f]).join("#"),
            streamId,
            events: mine,
            top: mine[mine.length - 1]!.version,
            delivered: new Set(events.map((e) => e.version)),
          })
        }
      }
      return appliedOf((yield* engine.applyRow(key, work, { fromScratch: true })) as RowResult)
    }) as Effect.Effect<Applied, Err, Req>

  const routes = (name: string): ReadonlyArray<Route> =>
    names.map((tag) => ({
      name,
      tag,
      stream: engineSources[tag]!.stream as unknown as DecodableStream,
      decode: (image: StreamImage) => engineSources[tag]!.stream.decodeStreamImage(image),
      applyBatch: (events, applyOptions) =>
        applyBatch(events as ReadonlyArray<Tagged>, applyOptions) as never,
    }))

  const processBatch = <Rec>(
    records: ReadonlyArray<Rec>,
    options: ProcessBatchOptions<Rec> & (IdentifyBySource | IdentifyWith<Rec>),
  ) =>
    runBatch(`${label}.processBatch`, records, options, routes("projection")).pipe(
      Effect.map(({ outcomes, unrouted: _, ...rest }) => ({
        ...rest,
        outcomes: outcomes.projection as unknown as ReadonlyArray<Outcome>,
      })),
    )

  return {
    [MultiProjectionTypeId]: MultiProjectionTypeId,
    pipe() {
      // eslint-disable-next-line prefer-rest-params
      return Pipeable.pipeArguments(this, arguments)
    },
    [ProjectionRoutes]: routes,
    entityType: readModel.entityType,
    sources,
    applyBatch,
    catchUp,
    rebuild,
    processBatch,
    drain: (key: K, deliver: (effect: O, meta: OutboxMeta) => Effect.Effect<void, any, any>) =>
      config.outbox === undefined
        ? Effect.die(new Error(`[EDD-9081] ${label}.drain: the projection declares no \`outbox\`.`))
        : engine.drain(key, deliver),
    drainPending: (deliver: (effect: O, meta: OutboxMeta) => Effect.Effect<void, any, any>) =>
      config.outbox === undefined
        ? Effect.die(
            new Error(`[EDD-9081] ${label}.drainPending: the projection declares no \`outbox\`.`),
          )
        : engine.drainPending(deliver),
  } as unknown as MultiProjection<S, K, Sources, Err, Req, O>
}

export { instanceKey }
