/**
 * @internal Shared helpers for Batch and Transaction operations.
 *
 * Extracts common patterns: table name resolution, primary key composition,
 * and put-item construction (validation + key composition + system fields).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { DynamoEncoding } from "@effect-dynamodb/schema/DynamoModel.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { makeDefaultCrypto } from "@effect-dynamodb/schema/internal/DefaultCrypto.js"
import type { UniqueConstraintDef } from "@effect-dynamodb/schema/internal/EntityConfig.js"
import { resolveUniqueFields } from "@effect-dynamodb/schema/internal/EntitySchemas.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DateTime, Effect, Option, type Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import type { DynamoClientError, DynamoClientService } from "../DynamoClient.js"
import type { Entity } from "../Entity.js"
import type { ConditionInput } from "../Expression.js"
import { fromAttributeMap, isUnstorableValue, toAttributeMap } from "../Marshaller.js"
import { resolveTtlAttributeName, type TableConfig, tableKeyAttributes } from "../Table.js"
import { isRefusedValue } from "./Capacity.js"
import type { ReturnValuesMode, UpdateState } from "./EntityOps.js"
import { encodeInput } from "./InputForm.js"

/**
 * @internal Hidden per-incarnation token of a versioned entity (#133): set
 * when an item is created, it tells an item apart from a deleted-and-recreated
 * one at the same version. Named like
 * `__edd_e__` so it cannot collide with a model field; never decoded.
 */
export const INCARNATION_TOKEN = "__edd_i__"

/**
 * @internal The row token (#237) on the rows of a read model that `rowTokened` says carry one:
 * 128 random bits (base64url), then the tags of the projection layouts that have written the row
 * (`layoutTag`), each `.`-prefixed. Every projection write, tombstone and rebuild write, and
 * `create` over a tombstone, writes a fresh one, conditioned on the one it read (`rowTokenTerm`):
 * a write that read the row before another fails, whichever projection made the other and
 * whatever counters it reset. Named like `__edd_e__`; never decoded.
 */
export const ROW_TOKEN = "__edd_rt__"

/**
 * @internal The tags of the layouts that have written a row, from its row token as read: none
 * for a row without one.
 */
export const rowWriters = (token: AttributeValue | undefined): ReadonlyArray<string> =>
  token?.S === undefined ? [] : token.S.split(".").slice(1)

/**
 * @internal Whether a read model's rows carry the row token (`ROW_TOKEN`): more than one
 * projection layout is recorded on it. Asked when a write is made, so a projection defined later
 * counts. With one layout, the projection's own revision or checkpoint serialises its writes, and
 * it sends and stores what 1.40.0 did.
 */
export const rowTokened = (entity: object): boolean =>
  (projectionLayoutsOf(entity)?.length ?? 0) > 1

const tokenRandom = makeDefaultCrypto()

/**
 * @internal A fresh row token recording `writers` (deduplicated, sorted) after its random part,
 * from the `SecureRandom` in context, else Web Crypto: no requirement is added.
 */
export const freshRowToken = (writers: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.serviceOption(SecureRandom.SecureRandom).pipe(
    Effect.flatMap((random) =>
      (Option.isSome(random) ? random.value : tokenRandom).randomBytes(16),
    ),
    Effect.map((bytes) => {
      let binary = ""
      for (const byte of bytes) binary += String.fromCharCode(byte)
      const random = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
      return [random, ...[...new Set(writers)].sort()].join(".")
    }),
  )

/** @internal A condition already in DynamoDB's form. */
export interface RawCondition {
  readonly expression: string
  readonly names: Record<string, string>
  readonly values: Record<string, AttributeValue>
}

/**
 * @internal The term proving a row still holds the token a write read: the stored value as the
 * read returned it, or its absence.
 */
export const rowTokenTerm = (read: AttributeValue | undefined): RawCondition =>
  read === undefined
    ? { expression: "attribute_not_exists(#eddRt)", names: { "#eddRt": ROW_TOKEN }, values: {} }
    : { expression: "#eddRt = :eddRt", names: { "#eddRt": ROW_TOKEN }, values: { ":eddRt": read } }

/** @internal Both conditions, either of which may be absent. Their placeholders must differ. */
export const andRaw = (
  a: RawCondition | undefined,
  b: RawCondition | undefined,
): RawCondition | undefined =>
  a === undefined
    ? b
    : b === undefined
      ? a
      : {
          expression: `(${a.expression}) AND (${b.expression})`,
          names: { ...a.names, ...b.names },
          values: { ...a.values, ...b.values },
        }

/** @internal What an attribute a projection keeps on its read model's rows is for. */
export type ProjectionRole = "checkpoint" | "checkpoint map" | "checkpoint owner" | "revision"

/**
 * @internal What a projection records on its read model (#154): each attribute its rows hold for
 * it (domain field names), with its role, in the order its tombstone stores them (its revision
 * last), whether it has `removal` (its rows may become tombstones), and whether its tombstones set
 * the table's TTL attribute (`removal.ttl`). `label` names the projection in a refusal. A field
 * the projection gives two roles is listed once per role.
 */
export interface ProjectionLayout {
  readonly label: string
  readonly roles: ReadonlyArray<readonly [field: string, role: ProjectionRole]>
  readonly removal: boolean
  readonly ttl: boolean
}

/**
 * @internal A projection layout's tag, in outbox items' marks and row tokens: FNV-1a (32-bit, base
 * 36) of its roles, `removal` and `ttl`, so every program defining the projection gives it the
 * same tag.
 */
export const layoutTag = (layout: ProjectionLayout): string => {
  let hash = 0x811c9dc5
  for (const char of JSON.stringify([layout.roles, layout.removal, layout.ttl])) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * @internal The layout of every projection defined on the read model, one entry per distinct
 * layout; `undefined` when none is.
 */
export const projectionLayoutsOf = (entity: object): ReadonlyArray<ProjectionLayout> | undefined =>
  (entity as { readonly _projectionLayouts?: ReadonlyArray<ProjectionLayout> })._projectionLayouts

/**
 * @internal Whether a projection defined on the read model has `removal`: its rows may be
 * tombstones, which `create` takes the place of (`overTombstone`), so `create` reads first.
 */
export const hasProjectionTombstones = (entity: object): boolean =>
  (entity as { readonly _projectionTombstones?: true })._projectionTombstones === true

/** A domain field's stored attribute name on `entity`. */
const storedName = (
  entity: { readonly _renameToDynamo: (item: Record<string, unknown>) => void },
  field: string,
): string => {
  const probe: Record<string, unknown> = { [field]: 1 }
  entity._renameToDynamo(probe)
  return Object.keys(probe)[0] ?? field
}

/**
 * `[EDD-9133]` among `layouts`: a stored attribute one projection names in two roles. The problem,
 * or `undefined`. `current` is the layout being defined, named "this projection". Two projections
 * may name one attribute in different roles: each writes its own, so two that never write one
 * row (rows of disjoint keys) work as on 1.39.0. Two that share rows and swap names can't be told
 * apart from them, and are as broken as on 1.39.0.
 */
const roleConflict = (
  entity: {
    readonly entityType: string
    readonly _renameToDynamo: (item: Record<string, unknown>) => void
  },
  layouts: ReadonlyArray<ProjectionLayout>,
  current: ProjectionLayout,
): string | undefined => {
  type Named = {
    readonly layout: ProjectionLayout
    readonly field: string
    readonly role: ProjectionRole
  }
  const whose = (layout: ProjectionLayout) =>
    layout === current ? "this projection's" : `${layout.label}'s`
  const as = (field: string, stored: string) =>
    field === stored ? `"${field}"` : `"${field}" (stored as "${stored}")`
  for (const layout of layouts) {
    const first = new Map<string, Named>()
    for (const [field, role] of layout.roles) {
      const stored = storedName(entity, field)
      const held = first.get(stored)
      if (held === undefined) {
        first.set(stored, { layout, field, role })
        continue
      }
      if (held.role === role) continue
      const second = held.field === field ? `its ${role}` : `${as(field, stored)} its ${role}`
      return (
        `[EDD-9133] ${current.label}: on read model "${entity.entityType}", ` +
        `${as(held.field, stored)} is ${whose(held.layout)} ${held.role}, and ${second}. A ` +
        "projection of the read model has `removal`, and a tombstone carries a checkpoint as it " +
        "is and raises a revision: an attribute holds one role in a projection. Give each its " +
        "own field."
      )
    }
  }
  return undefined
}

/**
 * @internal Record a projection's layout on its read model, beside those of the other projections
 * defined on it, and whether it has `removal`. On a read model one of whose projections has
 * `removal`, a stored attribute one projection names in two roles is refused (`[EDD-9133]`), before
 * anything is recorded: its tombstone carries a checkpoint as it is and raises a revision, so the
 * two would overwrite each other's values. The refusal comes at whichever definition completes the
 * conflict (the projection's own, or the first `removal`), so the order projections are defined in
 * doesn't decide it. Without `removal` nothing is refused: rows are never tombstones. Two
 * projections naming one attribute in different roles are not refused (`roleConflict`). A layout
 * already there moves to the end rather than being added again, so a projection defined over and
 * over (in a function, say) doesn't grow the list.
 */
export const addProjectionLayout = (
  entity: {
    readonly entityType: string
    readonly _renameToDynamo: (item: Record<string, unknown>) => void
  },
  layout: ProjectionLayout,
): void => {
  const holder = entity as {
    _projectionLayouts?: ReadonlyArray<ProjectionLayout>
    _projectionTombstones?: true
  }
  const same = (other: ProjectionLayout) =>
    other.removal === layout.removal &&
    other.ttl === layout.ttl &&
    other.roles.length === layout.roles.length &&
    other.roles.every(([field, role], i) => {
      const [f, r] = layout.roles[i]!
      return field === f && role === r
    })
  const layouts = [...(holder._projectionLayouts ?? []).filter((other) => !same(other)), layout]
  if (layout.removal || hasProjectionTombstones(entity)) {
    const problem = roleConflict(entity, layouts, layout)
    if (problem !== undefined) throw new Error(problem)
  }
  holder._projectionLayouts = layouts
  if (layout.removal) holder._projectionTombstones = true
}

/**
 * @internal Whether the read model's TTL attribute must be checked against the attributes its
 * projections keep (`projectionTtlConflict`): a projection's tombstones set it (`removal.ttl`).
 * Only then is the table resolved for it.
 */
export const projectionTtlChecked = (entity: object): boolean =>
  hasProjectionTombstones(entity) &&
  (projectionLayoutsOf(entity) ?? []).some((layout) => layout.ttl)

/**
 * @internal `[EDD-9133]` at run time, once the table's TTL attribute is known: an attribute a
 * projection keeps on the read model's rows that is stored as the TTL attribute, which another's
 * tombstones set (`removal.ttl`). The problem, or `undefined` when there is none. Like the
 * definition's refusal, only on a read model one of whose projections has `removal`.
 */
export const projectionTtlConflict = (
  entity: {
    readonly entityType: string
    readonly _renameToDynamo: (item: Record<string, unknown>) => void
  },
  ttlAttribute: string,
): string | undefined => {
  if (!projectionTtlChecked(entity)) return undefined
  for (const layout of projectionLayoutsOf(entity) ?? []) {
    for (const [field, role] of layout.roles) {
      if (storedName(entity, field) === ttlAttribute) {
        return (
          `[EDD-9133] "${field}" is a projection's ${role} on read model "${entity.entityType}", ` +
          `stored as "${ttlAttribute}", the table's TTL attribute, which a projection's ` +
          "tombstones set (`removal.ttl`). An attribute holds one role: give the " +
          `${role} its own field.`
        )
      }
    }
  }
  return undefined
}

/**
 * @internal `create` over a projection tombstone (#154): read the key, and when it holds the
 * entity's tombstone, carry what the projections with `removal` keep on one over into `item`
 * (stored names, wire values), and return the guard naming that very tombstone. `None` when there
 * is no tombstone: `create`'s own guard applies. A tombstone holds the attributes of the projection
 * that wrote it, which may be any of those with `removal`: each one's checkpoints (and map, and
 * owners) the tombstone holds are carried as they are, so a late redelivery is still recognised,
 * and its revision one higher. An attribute two of them name is taken in the role the one defined
 * last gives it, as 1.39.0 took every attribute from that one. A projection without `removal`
 * writes no tombstone, and isn't consulted. When a projection's tombstones set the table's TTL
 * attribute, it is never carried, so the row doesn't expire with the tombstone: a projection
 * naming it is refused when it writes (`projectionTtlConflict`), and one defined after a tombstone
 * was written would otherwise carry its expiry onto the row.
 *
 * Each value is stored as the row stores any value of the field: a sparse map as its entries (a
 * tombstone holds it whole, as 1.39.0's did), an entry whose key sparse storage can't hold left
 * off, never the whole map (#237).
 *
 * On a read model whose rows carry the row token (`rowTokened`), or when the tombstone holds one,
 * it also holds the bookkeeping of the other projections that had written the row (#237): those of
 * projections without `removal` are carried after, each attribute the others haven't named, in
 * the same way. The row gets a fresh token recording the projections whose bookkeeping it holds,
 * and `term` names the tombstone's own (`rowTokenTerm`), so a tombstone written since fails it.
 * Without a token, `term` names every value carried as the tombstone holds it (or its absence):
 * the removal stamp alone has a millisecond's resolution, so a row written over the tombstone and
 * removed again within one would pass it, and its newer checkpoints be lost to the older ones.
 */
export const overTombstone = (
  entity: {
    readonly entityType: string
    readonly indexes: {
      readonly primary?: {
        readonly pk: { readonly field: string }
        readonly sk: { readonly field: string }
      }
    }
    readonly _renameToDynamo: (item: Record<string, unknown>) => void
    readonly _serializeSparseFields: (item: Record<string, unknown>) => void
  },
  client: Pick<DynamoClientService, "getItem">,
  table: TableConfig,
  item: Record<string, unknown>,
): Effect.Effect<
  Option.Option<{ readonly guard: ConditionInput; readonly term: RawCondition | undefined }>,
  DynamoClientError
> =>
  Effect.gen(function* () {
    if (!hasProjectionTombstones(entity)) return Option.none()
    const layouts = projectionLayoutsOf(entity) ?? []
    const primary = entity.indexes.primary!
    const { Item } = yield* client.getItem({
      TableName: table.name,
      Key: toAttributeMap({
        [primary.pk.field]: item[primary.pk.field],
        [primary.sk.field]: item[primary.sk.field],
      }),
      ConsistentRead: true,
    })
    if (Item === undefined || !isProjectionTombstone(Item, entity.entityType)) return Option.none()
    const tomb = fromAttributeMap(Item) as Record<string, unknown>
    const ttl = layouts.some((layout) => layout.ttl) ? resolveTtlAttributeName(table) : undefined
    // An attribute is the tombstone's own, never a member it inherits.
    const held = (name: string): unknown => (Object.hasOwn(tomb, name) ? tomb[name] : undefined)
    // A value as the row stores it: a sparse map as its entries, each one sparse storage can hold.
    const carry = (name: string, value: unknown) => {
      const holds = (part: Record<string, unknown>) => {
        try {
          entity._serializeSparseFields(part)
          return true
        } catch {
          return false
        }
      }
      const whole: Record<string, unknown> = { [name]: value }
      if (holds(whole)) {
        Object.assign(item, whole)
        return
      }
      if (typeof value !== "object" || value === null) return
      for (const [entry, v] of Object.entries(value)) {
        const part: Record<string, unknown> = { [name]: { [entry]: v } }
        if (holds(part)) Object.assign(item, part)
      }
    }
    // The projections with `removal`, the one defined last first. Each attribute once, in the role
    // of the first that names it: its checkpoints, then its revision, as with one layout.
    const taken = new Set<string>()
    const carried = new Set<string>()
    const ordered = [...layouts].reverse()
    for (const layout of [
      ...ordered.filter((layout) => layout.removal),
      ...ordered.filter((layout) => !layout.removal),
    ]) {
      const mine = layout.roles
        .map(([field, role]) => [storedName(entity, field), role] as const)
        .filter(([name]) => name !== ttl && !taken.has(name))
      for (const [name, role] of mine) {
        taken.add(name)
        if (role !== "revision" && held(name) !== undefined) {
          carry(name, held(name))
          carried.add(name)
        }
      }
      for (const [name, role] of mine) {
        if (role === "revision" && held(name) !== undefined) {
          item[name] = Number(held(name)) + 1
          carried.add(name)
        }
      }
    }
    const read = Item[ROW_TOKEN]
    if (rowTokened(entity) || read !== undefined) {
      // The projections whose bookkeeping the row holds: those this program doesn't define kept.
      const known = new Map(layouts.map((layout) => [layoutTag(layout), layout]))
      const writers = rowWriters(read).filter((tag) => {
        const layout = known.get(tag)
        return (
          layout === undefined ||
          layout.roles.some(([field]) => {
            const name = storedName(entity, field)
            return carried.has(name) || Object.hasOwn(item, name)
          })
        )
      })
      item[ROW_TOKEN] = yield* freshRowToken(writers)
      return Option.some({
        guard: tombstoneGuard(entity.entityType, tomb),
        term: rowTokenTerm(read),
      })
    }
    // Without a token, the tombstone's every value this write carries, as read.
    const terms: Array<string> = []
    const names: Record<string, string> = {}
    const values: Record<string, AttributeValue> = {}
    for (const [i, name] of [...taken].entries()) {
      names[`#eddTb${i}`] = name
      const value = Object.hasOwn(Item, name) ? Item[name] : undefined
      if (value === undefined) terms.push(`attribute_not_exists(#eddTb${i})`)
      else {
        terms.push(`#eddTb${i} = :eddTb${i}`)
        values[`:eddTb${i}`] = value
      }
    }
    return Option.some({
      guard: tombstoneGuard(entity.entityType, tomb),
      term: terms.length === 0 ? undefined : { expression: terms.join(" AND "), names, values },
    })
  })

/** The guard naming a tombstone by its marker and removal stamp. */
const tombstoneGuard = (entityType: string, tomb: Record<string, unknown>): ConditionInput =>
  ({
    eq: { __edd_e__: `${entityType}#tombstone`, __edd_removed__: tomb.__edd_removed__ },
  }) as ConditionInput

/**
 * @internal Flatten `entity`'s sparse-map fields on `item` (stored names) into per-entry
 * attributes, refusing a key it can't store with a `ValidationError` for `operation`. The
 * transactional put and a projection's tombstone (on a copy) go through it, and `Entity.put`
 * refuses through the same `_serializeSparseFields`, so each refuses the same key the same way,
 * before sending anything.
 */
export const serializeSparseOrFail = (
  entity: {
    readonly entityType: string
    readonly _serializeSparseFields: (item: Record<string, unknown>) => void
  },
  item: Record<string, unknown>,
  operation: string,
): Effect.Effect<void, ValidationError> =>
  Effect.try({
    try: () => entity._serializeSparseFields(item),
    catch: (e) =>
      new ValidationError({
        entityType: entity.entityType,
        operation,
        cause: e instanceof Error ? e.message : String(e),
      }),
  })

/**
 * A projection tombstone (#154) of `entityType` — written at a removed row's
 * own key to keep its checkpoints. Every read by key reports it as absent.
 */
export const isProjectionTombstone = (
  item: { readonly __edd_e__?: { readonly S?: string | undefined } | undefined } | undefined,
  entityType: string,
): boolean => item?.__edd_e__?.S === `${entityType}#tombstone`

/**
 * Marks a projection's row tombstone or outbox item with the key text it's
 * under (#171, #183). They hold no values to tell whose key they are at, and
 * `foo bar`'s escaped key is `foo%20bar`'s unescaped one, so `rekey` reads the
 * key back by the mark (`KeyText136.formOfMark`): none is the text 1.36
 * composed, which `escapeKeys` off composes too.
 */
export const KEY_TEXT = "__edd_kt__"

/** The read-model row an outbox item was written for: its key attributes' text. */
export const OUTBOX_ROW_PK = "__edd_row_pk__"
export const OUTBOX_ROW_SK = "__edd_row_sk__"

/**
 * The effect an outbox item holds, and the read model it was written for (#237):
 * `<read model tag>.<effect tag>` (`ProjectionEngine.outboxMark`), the tag of the read model's key
 * template (`ProjectionEngine.readModelTag`) then a hash of the projection and the event. Written
 * from 1.41.0 where its name is free (`outboxMarkInUse`); part of no key. Read models of one entity
 * type share the outbox index's partition, and a key alone can't always say whose an item is
 * (`[shop]` with `north#branch_b1` beside `[shop, branch]`): `outboxOwnership` reads it first. An
 * item's `Put` replaces only the item of the same effect (`ProjectionEngine.writeRow`).
 */
export const OUTBOX_READ_MODEL = "__edd_rm__"

/**
 * @internal The attributes a read model's projections' outbox items hold under names something
 * else decides (#237): each outbox's key attributes and its index's, and every key attribute of
 * the table it is on (`tableKeyAttributes`: any item holding one is in that index).
 */
const outboxItemNames = (entity: object): ReadonlySet<string> => {
  const member = entity as {
    readonly _tableTag?: unknown
    readonly indexes?: { readonly primary?: { readonly pk: KeyPartLike; readonly sk: KeyPartLike } }
    readonly _projectionOutboxes?: ReadonlyArray<{
      readonly table: { readonly Tag: unknown } | undefined
      readonly pk: string
      readonly sk: string
      readonly index: { readonly pk: string; readonly sk: string } | undefined
    }>
  }
  const names = new Set<string>()
  for (const outbox of member._projectionOutboxes ?? []) {
    if (outbox.table === undefined) {
      const primary = member.indexes?.primary
      if (primary !== undefined) names.add(primary.pk.field).add(primary.sk.field)
    } else names.add(outbox.pk).add(outbox.sk)
    if (outbox.index !== undefined) names.add(outbox.index.pk).add(outbox.index.sk)
    for (const name of tableKeyAttributes(outbox.table?.Tag ?? member._tableTag) ?? []) {
      names.add(name)
    }
  }
  return names
}

interface KeyPartLike {
  readonly field: string
}

/**
 * @internal Whether a read model's outbox items carry their mark (`OUTBOX_READ_MODEL`, #237): its
 * name is free on them (`outboxItemNames`). The one decision, from the definitions: where an
 * outbox's key or index attribute, or a key attribute of its table, is named `__edd_rm__`, the
 * read model's items carry none, their `Put` no condition, and its drainers read no mark, as on
 * 1.40.0.
 */
export const outboxMarkInUse = (entity: object): boolean =>
  !outboxItemNames(entity).has(OUTBOX_READ_MODEL)

/** A drainer's claim on an outbox item: its token, and the epoch millis it holds until. */
export const OUTBOX_CLAIM = "__edd_claim__"
export const OUTBOX_CLAIMED_UNTIL = "__edd_claimed_until__"

/**
 * @internal Hidden string set naming the unique-constraint fields an item
 * holds a DEFAULT for (#133): a decoding-default field that is also an index
 * composite is stored when omitted, but a default never creates a unique
 * sentinel — so no sentinel is composed, rotated or deleted for a field
 * listed here until a write supplies a value for it.
 */
export const UNSENTINELED_DEFAULTS = "__edd_d__"

const incarnationCrypto = makeDefaultCrypto()

/** @internal A fresh incarnation token. */
export const freshIncarnationToken: Effect.Effect<string> = incarnationCrypto.uuidV4()

/**
 * Generate a wire-form timestamp value for the configured encoding from a
 * Clock-backed `now: DateTime.Utc` (resolved by the caller via `yield*
 * DateTime.now`). No-encoding default: ISO string. Custom encoding: serialized
 * primitive. Contains no `Date` constructor, so it is deterministic under
 * `TestClock`.
 *
 * Shared by the Entity write path (`Entity.generateTimestamp`) and the
 * Batch/Transaction path so both produce identical timestamps.
 */
export const generateTimestampPrimitive = (
  now: DateTime.Utc,
  encoding: DynamoEncoding | null,
): string | number => {
  if (!encoding) return DateTime.formatIso(now)
  const ms = DateTime.toEpochMillis(now)
  switch (encoding.storage) {
    case "string":
      // System timestamps generated here are UTC; DateTime.Zoned-typed
      // collision fields are rare and were not previously special-cased.
      return DateTime.formatIso(now)
    case "epochMs":
      return ms
    case "epochSeconds":
      return Math.floor(ms / 1000)
  }
}

/**
 * Message for a read path (`Batch.get`, `Transaction.transactGet`,
 * `Transaction.check`) handed something that is not a get descriptor.
 *
 * Both accepted spellings are named, because the bound one is the ONLY
 * descriptor an entity authored with the pure `@effect-dynamodb/schema`
 * `Entity.make` can produce (#108) — a caller who reached here with a pure
 * definition needs to be pointed at the client, not at `Entity.get`.
 */
export const getRejectReason = (operation: string): string =>
  `[EDD-9052] ${operation} requires a get descriptor — pass \`Entity.get(key)\` or the ` +
  "bound `db.entities.X.get(key)`. An already-executed Effect, a query, or a write op " +
  "carries no key to read."

/** Render the configured multi-item features for an error message. */
const describeFeatures = (features: ReadonlyArray<"unique" | "retain" | "softDelete">): string => {
  const labels = features.map((f) =>
    f === "unique" ? "`unique`" : f === "retain" ? "`versioned: { retain: true }`" : "`softDelete`",
  )
  return labels.length === 1
    ? labels[0]!
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
}

/**
 * `Batch.write` cannot host the multi-item lifecycle features that apply to the
 * direction being written (EDD-9049). This is a different judgement from the
 * transact path's: there, a `put`'s side items are derivable and get emitted;
 * here `BatchWriteItem` structurally cannot express them at all.
 *
 *   - **No `ConditionExpression`.** A uniqueness sentinel is only a constraint
 *     because of `attribute_not_exists(pk)`. Writing one without the guard would
 *     overwrite another row's reservation and enforce nothing — strictly worse
 *     than writing none, because the table would then *look* guarded.
 *   - **No atomicity.** A sentinel or snapshot that lands without its item (or
 *     an item without them) is a corrupt partition, and `Batch.write` chunks at
 *     25, so related items can even land in different requests.
 *   - **No `UpdateRequest`.** A soft-delete tombstone is a relocation
 *     (delete + put at a new sort key); a batch cannot make that one unit.
 *
 * **Direction matters.** `softDelete` changes only the delete path — a `put` of
 * a soft-deletable entity is an ordinary single-item put and is allowed. Gating
 * it on the put side would reject writes that have always been correct.
 *
 * Returns `undefined` when the entity is safe for `Batch.write` in `opType`.
 */
export const batchRejectReason = (entity: Entity, opType: "put" | "delete"): string | undefined => {
  const features = entity._multiItemWriteFeatures.filter((f) =>
    // `unique` and `retain` add items to BOTH directions (sentinel write /
    // release, snapshot on create / on overwrite-and-delete). `softDelete` only
    // ever changes a delete.
    f === "softDelete" ? opType === "delete" : true,
  )
  if (features.length === 0) return undefined
  return (
    `[EDD-9049] Batch.write cannot ${opType} an entity configured with ${describeFeatures(features)} — ` +
    "BatchWriteItem has no ConditionExpression (which is the whole of a uniqueness " +
    "sentinel's correctness), no UpdateRequest, and no atomicity across its 25-item " +
    "chunks. Use Transaction.transactWrite, or the entity's own operation."
  )
}

/**
 * Reject an op whose semantics the `TransactWriteItems` / `BatchWriteItem`
 * compile path cannot faithfully reproduce.
 *
 * Both paths turn an entity op into a single self-contained `Put` / `Delete`
 * built from the encoded input. That is exactly right for a plain `put` /
 * `delete`, and wrong — silently — for anything whose contract needs a
 * different DynamoDB verb, extra items, or a service the compile step does not
 * have. Loud beats silent (#100).
 *
 * **What this gate covers.** Cases that are silently wrong (`upsert` — see
 * `PutKind`) or that cannot be working for anyone today: a `refs` entity writes
 * an item whose ref attribute is absent, so every later read fails to decode; a
 * `generatedId` entity whose id was NOT supplied dies outright (no `SecureRandom` in
 * scope) — one supplied on the input is written as given, since that is the case
 * `Entity.put` also handles without `SecureRandom` (#120); a vector-indexed entity
 * writes an item with no embedding, so it silently drops out of the index.
 *
 * **The multi-item lifecycle features split by direction (#113).** `unique`,
 * `versioned: { retain }` and `softDelete` all need MORE than one item per write:
 *
 * - **put** — expanded. A put of a versioned or unique-constrained entity is
 *   planned exactly as `Entity.put` plans it (#133): the item is read, and the
 *   Put is guarded on what was read, beside its sentinel reservations and
 *   (owned) releases and its retain snapshot (`Entity._planPut`).
 * - **delete** — the sentinel to release is keyed by the *stored* item's unique
 *   values, a retain snapshot copies the *stored* row, and a soft-delete
 *   tombstone IS the stored row relocated to a new sort key. `Transaction.
 *   transactWrite` plans such a delete from a read (`Entity._planDelete`);
 *   a path that builds a delete from its key alone (`EventStore.append`)
 *   rejects it with **EDD-9048**.
 *
 * `Batch.write` rejects BOTH directions (**EDD-9049**) — see `batchRejectReason`.
 *
 * **What a planned update or delete cannot carry** (`Transaction.transactWrite`
 * runs the op with its write recorded, so nothing after the write runs): a
 * cascade (**EDD-9059** — a follow-up write after the update commits), a
 * `returnValues` mode that returns an item (**EDD-9060** — a transaction
 * returns no item attributes), and an update of a vector-indexed entity
 * (**EDD-9061** — the embedding needs the `Embedder` service).
 *
 * `capability` names what the caller would have to give up, so the message can
 * say why rather than just "unsupported".
 */
export const rejectUnsupportedOp = (
  entity: Entity,
  operation: string,
  opType: "put" | "update" | "delete",
  putKind: "put" | "create" | "upsert" | undefined,
  /**
   * The op's own input, for the one gate whose dependency the caller can
   * remove. `undefined` for a delete (which carries a key, not an input) and
   * for any caller with none to offer — both read as "the field is absent".
   */
  input?: unknown,
  details?: {
    /** An update's accumulated state (`.cascade()`, `.returnValues()`, …). */
    readonly updateState?: UpdateState | undefined
    /** A delete's `.returnValues()`. */
    readonly returnValues?: ReturnValuesMode | undefined
    /**
     * The caller reads the stored row before compiling (`transactWrite`'s
     * pre-pass), so a multi-item delete is buildable and EDD-9048 does not apply.
     */
    readonly readsStoredRow?: boolean | undefined
  },
): Effect.Effect<void, ValidationError> => {
  const fail = (capability: string, reason: string) =>
    new ValidationError({
      entityType: entity.entityType,
      operation,
      cause: `${operation}: ${capability} is not supported here — ${reason}`,
    })

  // --- op-kind level -------------------------------------------------------
  if (opType === "put" && putKind === "upsert") {
    return Effect.fail(
      fail(
        "upsert",
        "upsert is an UpdateItem whose SET clause uses if_not_exists for createdAt, " +
          "immutable fields and the version counter. Compiling it as a Put would reset " +
          "them. Use put() or create() here, or run the upsert as its own operation.",
      ),
    )
  }

  // --- what a planned write cannot carry (EDD-9059 – EDD-9061) -------------
  if (opType === "update" && details?.updateState?.cascade !== undefined) {
    return Effect.fail(
      fail(
        "[EDD-9059] cascade",
        "a cascade is a follow-up write to other entities after the update commits, so it " +
          "cannot share the transaction. Run the update as its own operation.",
      ),
    )
  }
  const returnValues =
    opType === "update" ? details?.updateState?.returnValues : details?.returnValues
  if (opType !== "put" && returnValues !== undefined && returnValues !== "none") {
    return Effect.fail(
      fail(
        "[EDD-9060] returnValues",
        `a transaction returns no item attributes. Run the ${opType} as its own operation ` +
          "to read them.",
      ),
    )
  }
  if (opType === "update" && Object.keys(entity._vectorIndexes ?? {}).length > 0) {
    return Effect.fail(
      fail(
        "[EDD-9061] updating an entity with vector indexes",
        "recomputing the embedding calls the Embedder service, which this path does not " +
          "provide. Run the update as its own operation.",
      ),
    )
  }

  // --- multi-item lifecycle, delete direction (EDD-9048) -------------------
  // The put direction is EXPANDED instead — see the doc comment.
  if (
    opType === "delete" &&
    details?.readsStoredRow !== true &&
    entity._multiItemWriteFeatures.length > 0
  ) {
    return Effect.fail(
      fail(
        `[EDD-9048] deleting an entity configured with ${describeFeatures(entity._multiItemWriteFeatures)}`,
        "the extra items a delete must write are derived from the STORED item — the sentinel " +
          "to release is keyed by its unique values, a retain snapshot copies it, and a " +
          "soft-delete tombstone is that row relocated to a new sort key. This path builds a " +
          "delete from its key alone, so it cannot build them. Run the delete as its own operation " +
          "(db.entities.X.delete(...)) or through Transaction.transactWrite, both of which " +
          "read the item first.",
      ),
    )
  }

  // --- entity-configuration level -----------------------------------------
  if (opType === "put" && entity._resolvedRefs.length > 0) {
    return Effect.fail(
      fail(
        "a ref",
        "write-time ref hydration reads the referenced entity, which this compile step " +
          "cannot do; the ref attribute would be written empty.",
      ),
    )
  }
  // Unlike the two gates around it, this one depends on the INPUT rather than
  // the configuration. `Entity.put` only reaches `SecureRandom` when the caller
  // omitted the field — `fillGeneratedId` returns the input untouched when it
  // is present — so a caller who supplies the id needs nothing this path lacks.
  // Rejecting them named a dependency that did not apply, and pointed at a
  // workaround that was already in effect (#120).
  //
  // The absent case still has to be refused: this path builds the item straight
  // from the encoded input and never calls `fillGeneratedId`, so the id would
  // stay missing and the primary key would compose around an `undefined`.
  if (opType === "put" && entity.generatedId != null) {
    const idField = (entity.generatedId as { readonly field: string }).field
    const supplied =
      typeof input === "object" &&
      input !== null &&
      (input as globalThis.Record<string, unknown>)[idField] != null
    if (!supplied) {
      return Effect.fail(
        fail(
          `an omitted generated id ("${idField}")`,
          "generating one needs the SecureRandom service, which is not in scope here. Supply " +
            `"${idField}" on the input and this path writes it as given — only the ` +
            "generating case is unsupported.",
        ),
      )
    }
  }
  if (opType === "put" && Object.keys(entity._vectorIndexes ?? {}).length > 0) {
    return Effect.fail(
      fail(
        "a vector index",
        "computing the embedding needs the Embedder service, which is not in scope here; " +
          "the item would be written without its vector and drop out of the index.",
      ),
    )
  }
  return Effect.void
}

/**
 * Resolve table names for a set of entity infos, deduplicating by entity reference.
 */
export const resolveTableNames = (infos: ReadonlyArray<{ readonly entity: Entity }>) =>
  Effect.gen(function* () {
    const tableNames = new Map<Entity, string>()
    for (const info of infos) {
      if (!tableNames.has(info.entity)) {
        const { name } = yield* info.entity._tableTag
        tableNames.set(info.entity, name)
      }
    }
    return tableNames
  })

/**
 * @internal Run a key composer, turning a value it can't place into a
 * `ValidationError` for `operation`: a Z-order value (`[EDD-9092]`,
 * `ZOrderValueError`: `NaN`, an unparseable date, a value outside a `literals`
 * list — #171), or a composite with no key text (`[EDD-9096]`,
 * `KeyValueError`: `NaN`, a bigint past 1,000 digits), or a sharded index's
 * missing shard source (`[EDD-9100]`, `ShardSourceError`, #183). Every write path
 * that composes an item's keys goes through this, so the failure is typed instead
 * of a defect. Any other throw stays a defect.
 */
export const composeKeysOrFail = <A>(
  entityType: string,
  operation: string,
  compose: () => A,
): Effect.Effect<A, ValidationError> =>
  Effect.try({ try: compose, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      isRefusedValue(error)
        ? Effect.fail(new ValidationError({ entityType, operation, cause: error }))
        : Effect.die(error),
    ),
  )

/**
 * Marshal an item holding a caller's values. A value DynamoDB can't store (an
 * empty set in a list, `NaN`, a number past `Number.MAX_SAFE_INTEGER`, …) fails with
 * a `ValidationError` naming the field; `fieldOf` names a stored attribute by its
 * model field. So does a value it composes into a key and can't place, as
 * {@link composeKeysOrFail} says. Any other throw stays a defect.
 */
export const marshalOrFail = <A>(
  entityType: string,
  operation: string,
  marshal: () => A,
  options: {
    readonly fieldOf?: (attribute: string) => string
    readonly outcome?: string
  } = {},
): Effect.Effect<A, ValidationError> =>
  Effect.try({ try: marshal, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      isUnstorableValue(error)
        ? Effect.fail(
            new ValidationError({
              entityType,
              operation,
              cause: error.refusal(options.outcome ?? "Nothing was written.", options.fieldOf),
            }),
          )
        : isRefusedValue(error)
          ? Effect.fail(new ValidationError({ entityType, operation, cause: error }))
          : Effect.die(error),
    ),
  )

/** An entity item's primary key, from a record already in the composite key form. */
const primaryKeyOf = (
  entity: Entity,
  recordKeyForm: Record<string, unknown>,
): Record<string, unknown> => {
  const primary = entity.indexes.primary!
  const schema = entity._schema
  return {
    [primary.pk.field]: KeyComposer.composePk(schema, entity.entityType, primary, recordKeyForm),
    [primary.sk.field]: KeyComposer.composeSk(schema, entity.entityType, 1, primary, recordKeyForm),
  }
}

/**
 * The primary key of the row a caller's DOMAIN key record names: the key
 * `Entity.put` wrote for it (`_domainKeyForm`). The projection engine reads a
 * read-model row, writes its tombstone and keys its outbox items through this,
 * as the row itself is written by the read model's own `put`.
 */
export const composePrimaryKey = (
  entity: Entity,
  key: Record<string, unknown>,
): Record<string, unknown> =>
  // Every `KeyComposer` input must first go through the composite key-form rule
  // or it composes a different string than `Entity.put` wrote — a `DateEpochMs`
  // PK composite made `Batch.get` return null and `Batch.write(delete)` report
  // success against a row it never touched (#111).
  primaryKeyOf(entity, entity._domainKeyForm(key))

/**
 * The primary key of the item a caller's key names, failing with a
 * `ValidationError` for `operation` where a composite has no key text (`NaN`,
 * `[EDD-9096]`) — the key-taking multi-item ops (`Batch.get`, `Batch.write`
 * deletes, `transactGet`, `transactWrite` deletes and condition checks), as an
 * entity's own `get` and `delete` do.
 *
 * The caller's key is a DOMAIN record (`{ takenAt: DateTime }`), as an entity's
 * own `get` takes it, so it goes through `_domainKeyForm`: the key `Entity.put`
 * wrote for it, the key that `get` composes. For a codec `encode` takes on its
 * own output (`x:` prepended), that is the key of the stored text: a domain
 * value that is also such a text (`"x:MiX"`) is encoded first, as `put` does.
 * It sends the key it sent on 1.39.0, whose `put` keyed the stored text encoded
 * once more, so it found nothing there.
 */
export const composePrimaryKeyOrFail = (
  entity: Entity,
  key: Record<string, unknown>,
  operation: string,
): Effect.Effect<Record<string, unknown>, ValidationError> =>
  composeKeysOrFail(entity.entityType, operation, () =>
    primaryKeyOf(entity, entity._domainKeyForm(key)),
  )

/**
 * Validate input, compose all keys, and build a marshalled put item.
 *
 * Encodes the user-supplied domain payload to wire format via
 * `Schema.encode(inputSchema)`, then assembles the DynamoDB item with system
 * fields and composite keys. Substituted self-date schemas + RedactedFromValue
 * are handled in the encode pass — no per-field serialization needed.
 *
 * Returns the unmarshalled `item` alongside the marshalled one, plus the `now`
 * the timestamps were generated from, and whether the input supplied
 * `createdAt`. `Entity._planPut` needs them to derive uniqueness sentinels and
 * the retain snapshot from the same values that were written (#113), and to
 * keep a replaced item's `createdAt` (#133); re-deriving `now` there would risk
 * a skew between an item's `createdAt` and its snapshot's TTL. `options.createdAt`
 * is the `createdAt` of a row being rewritten, which no input supplies.
 */
export const validateAndBuildPutItem = (
  entity: Entity,
  input: Record<string, unknown>,
  operation: string,
  options?: { readonly createdAt?: DateTime.Utc | undefined },
): Effect.Effect<
  {
    readonly item: Record<string, unknown>
    readonly marshalled: Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>
    readonly now: DateTime.Utc
    /** Whether the input supplied `createdAt` (a replacing put keeps the stored one otherwise). */
    readonly createdAtSupplied: boolean
    /** The item's keys, were these system fields what a guarded put carries over from the stored item. */
    readonly composeKeys: (
      carried: Record<string, unknown>,
    ) => Effect.Effect<Record<string, unknown>, ValidationError>
  },
  ValidationError
> =>
  Effect.gen(function* () {
    // Clock-backed time source resolved once per op; threaded into the sync
    // timestamp builder so the value is deterministic under `TestClock`.
    const now = yield* DateTime.now
    const inputSchema = entity.schemas.inputSchema as Schema.Codec<any>
    // The input's stored form, decided as `Entity.put` decides it (`InputForm`).
    // Omitted decoding defaults are stored, exactly as `Entity.put` does.
    const filled = yield* entity._fillDecodingDefaults(input)
    const unsentineled = entity._unsentineledDefaults(input)
    const encoded = yield* encodeInput(inputSchema, filled).pipe(
      Effect.mapError(
        ({ stored }) =>
          new ValidationError({
            entityType: entity.entityType,
            operation,
            cause: stored,
          }),
      ),
    )
    yield* entity._refuseNotReadBack(encoded, operation)

    const item: Record<string, unknown> = { ...(encoded as Record<string, unknown>) }
    item.__edd_e__ = entity.entityType
    if (unsentineled.length > 0) item[UNSENTINELED_DEFAULTS] = new Set(unsentineled)

    // System fields (collision-aware), stamped before the keys are composed,
    // as `Entity.put` does: an index may be composed from one. When a
    // timestamp field collides with a model-declared field, the user may have
    // supplied their own value (already encoded to wire by `Schema.encode`);
    // else generate a wire primitive directly. They are placed in the item
    // after the keys, where 1.39.0 placed them, so the request is the same.
    const sf = entity.systemFields
    const createdAtSupplied = sf.createdAt !== null && item[sf.createdAt] !== undefined
    const stamps: Record<string, unknown> = {}
    if (sf.createdAt) {
      if (options?.createdAt !== undefined) {
        stamps[sf.createdAt] = generateTimestampPrimitive(options.createdAt, sf.createdAtEncoding)
      } else if (item[sf.createdAt] === undefined) {
        stamps[sf.createdAt] = generateTimestampPrimitive(now, sf.createdAtEncoding)
      }
    }
    if (sf.updatedAt) {
      if (item[sf.updatedAt] === undefined) {
        stamps[sf.updatedAt] = generateTimestampPrimitive(now, sf.updatedAtEncoding)
      }
    }
    if (sf.version) stamps[sf.version] = 1

    // Same normalisation `Entity.put` applies. Without it a `BigIntFromString`
    // composite composed `txn_420` here and `txn_000…0420` there, so the two
    // APIs wrote two different rows for the same logical item and neither
    // accessor could read the transact-written one (#111).
    const composed = { ...(encoded as Record<string, unknown>) }
    for (const field of [sf.createdAt, sf.updatedAt, sf.version]) {
      if (field) composed[field] = Object.hasOwn(stamps, field) ? stamps[field] : item[field]
    }
    // The item is written whole: every key composed from it is its own, and an object composing
    // `[object Object]` into one is refused where it's composed (`EDD-9162`).
    const own = entity._ownSchema()
    const composeKeys = (carried: Record<string, unknown>) =>
      composeKeysOrFail(entity.entityType, operation, () =>
        KeyComposer.composeAllKeys(
          own,
          entity.entityType,
          1,
          entity.indexes,
          entity._keyForm({ ...composed, ...carried }),
        ),
      )
    Object.assign(item, yield* composeKeys({}))
    // A unique field's sentinel key is composed from its value later, on the
    // guarded path, after this item is marshalled. One with no key text
    // (`NaN`, `[EDD-9096]`) is refused here, as `Entity.put` refuses it, not
    // by the marshaller as a defect; so is an object composing `[object Object]`
    // into a sentinel composed.
    yield* composeKeysOrFail(entity.entityType, operation, () => {
      for (const def of Object.values(entity.unique ?? {})) {
        for (const field of resolveUniqueFields(def as UniqueConstraintDef)) {
          const value = (encoded as Record<string, unknown>)[field]
          if (value !== undefined && value !== null) {
            KeyComposer.compositeText(entity._schema, value)
          }
        }
      }
      if (own !== entity._schema) entity._composeUniqueSentinels(own, composed)
    })

    Object.assign(item, stamps)
    if (entity._incarnationToken) item[INCARNATION_TOKEN] = yield* freshIncarnationToken

    // Rename domain fields to their stored attribute names, in the same
    // position `Entity.put` does (after keys + system fields, before sparse
    // flattening). Omitting it gave a `field:`-renamed entity a differently
    // shaped item depending on whether `put` or `transactWrite` wrote it — and
    // `_planPut` derives the retain snapshot from this same item,
    // so the snapshot inherited the wrong shape too (#111).
    entity._renameToDynamo(item)

    // Flatten sparse-map fields into per-entry top-level attributes.
    yield* serializeSparseOrFail(entity, item, operation)

    // Pack `storedAs: DynamoModel.Packed` fields, as `Entity.put` does (#147).
    yield* entity._packFields(item, operation)

    const marshalled = yield* marshalOrFail(
      entity.entityType,
      operation,
      () => toAttributeMap(item),
      { fieldOf: entity._fieldOfAttribute },
    )
    return { item, marshalled, now, createdAtSupplied, composeKeys }
  })
