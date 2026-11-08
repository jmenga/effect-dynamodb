/**
 * Entity — Binds a domain model to a Table with ElectroDB-style index definitions,
 * system field configuration, unique constraints, and CRUD operations.
 *
 * Entity.make() returns a definition + operations namespace. The Entity object
 * carries derived schemas for 7 type extractors (Model, Record, Input, Update,
 * Key, Item, Marshalled).
 */

import type {
  AttributeValue,
  DeleteItemCommandInput,
  TransactWriteItem,
  UpdateItemCommandInput,
  WriteRequest,
} from "@aws-sdk/client-dynamodb"
import {
  type ConfiguredModel,
  type DynamoEncoding,
  type ExtractIdentifier,
  type ExtractPackedFields,
  type ExtractUnremovableFields,
  getIdentifierField,
  getSparseFields,
  isConfiguredModel,
  isRefField,
} from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { EmbedderService } from "@effect-dynamodb/schema/Embedder.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import {
  CascadePartialFailure,
  ConcurrentModification,
  ConditionalCheckFailed,
  DeleteAppliedButUnreadable,
  DynamoError,
  EmbeddingError,
  ItemNotDeleted,
  ItemNotFound,
  isAwsConditionalCheckFailed,
  isAwsTransactionCancelled,
  OptimisticLockError,
  RefNotFound,
  StaleAppend,
  TransactionOverflow,
  UniqueConstraintViolation,
  UpdateAppliedButUnreadable,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import {
  compositeKeyFormKind,
  keyFormValueKind,
  kindReadingOf,
  makeCompositeKeyForm,
  makeCompositeStoredForm,
  otherNumericKind,
  type ReadBackText,
  readsBackOtherwise,
  refuseInexact,
  storedFormOfRead,
  storedNumericForm,
  toCompositeKeyRecord,
} from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import { makeDefaultCrypto } from "@effect-dynamodb/schema/internal/DefaultCrypto.js"
import { packedIndexRefusal } from "@effect-dynamodb/schema/internal/EntityPacked.js"
import { failingAsBefore, issueDecoding } from "@effect-dynamodb/schema/internal/FailingAsBefore.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import {
  type AbsentReading,
  absentReading,
  absentStored,
  pathIsRequired,
  rowOmits,
} from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import { refuseReadAsSparseEntry } from "@effect-dynamodb/schema/internal/SharedKeyAttribute.js"
import { sparseKeyRefusal, sparseReader } from "@effect-dynamodb/schema/internal/SparseKey.js"
import type { GsiConfig, IndexDefinition, KeyPart } from "@effect-dynamodb/schema/KeyComposer.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { normalizeGsiConfig } from "@effect-dynamodb/schema/KeyComposer.js"
import type {
  VectorIndexConfig,
  VectorIndexDefinition,
} from "@effect-dynamodb/schema/VectorIndex.js"
import { deriveSourceText } from "@effect-dynamodb/schema/VectorIndex.js"
import {
  Cause,
  Context,
  Data,
  DateTime,
  type Duration,
  Effect,
  Equal,
  Exit,
  Option,
  Schema,
  SchemaIssue,
  Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import type { DynamoClient, DynamoClientError } from "./DynamoClient.js"
import type { ConditionInput } from "./Expression.js"
import { attributeValueEquals } from "./internal/AttributeValueEquals.js"
import {
  isBoundOp,
  makeBoundAppend,
  makeBoundDelete,
  makeBoundGet,
  makeBoundPut,
  makeBoundUpdate,
} from "./internal/BoundCrud.js"
import {
  type BoundQueryConfig,
  BoundQueryImpl,
  entityNaming,
  type RawSortKeyCondition,
} from "./internal/BoundQuery.js"
import * as Capacity from "./internal/Capacity.js"
import {
  compileExpr,
  createConditionOps,
  type Expr,
  emptyPartProblem,
  isExpr,
  nonEmptyCondition,
  parseShorthand,
  parseSimpleShorthand,
  toExpr,
} from "./internal/Expr.js"
import {
  asReadGuard,
  countOperators,
  expressionFits,
  unprovableRow,
  wholeRowGuard,
} from "./internal/ExpressionLimits.js"
import { BASE_DELAY_MS, MAX_RETRIES } from "./internal/Hydrate.js"
import {
  decodeImage,
  imageEntityType,
  ownRowsRawRow,
  type PackedAttributeGuard,
  packAttributeValueSync,
  packedExprRefusal,
  packedProjectionRefusal,
  packItemSync,
  type StreamImage,
  unpackRow,
  withRegistry,
} from "./internal/Packed.js"
import { compilePath, createPathBuilder, type PathModel } from "./internal/PathBuilder.js"
import { KEY_MAX, KEY_TOP, keyJustBelow } from "./internal/RangePlanner.js"
import * as Rekey from "./internal/Rekey.js"
import {
  asRead,
  notReadBack,
  type ReadBack,
  readBackOf,
  readBackRefusal,
} from "./internal/RoundTrip.js"
import {
  composeKeysOrFail,
  freshIncarnationToken,
  generateTimestampPrimitive,
  hasProjectionTombstones,
  INCARNATION_TOKEN,
  isProjectionTombstone,
  KEY_TEXT,
  marshalOrFail,
  OUTBOX_CLAIM,
  OUTBOX_CLAIMED_UNTIL,
  OUTBOX_ROW_PK,
  OUTBOX_ROW_SK,
  overTombstone,
  UNSENTINELED_DEFAULTS,
} from "./internal/TransactableOps.js"
import { planWrite, type TransactPlan } from "./internal/TransactPlan.js"
import {
  batchEntries,
  diagnosedValidationError,
  diagnoseFailure,
  keyAttributesOf,
  targetsFor,
  transactItemTarget,
} from "./internal/WriteDiagnosis.js"
import {
  decodeSparseFields,
  encodeSparseFields,
  fromAttributeMap,
  hasNoStoredForm,
  isEmptySet,
  toAttributeMap,
  toAttributeValue,
  UnstorableValue,
  unstorableIn,
} from "./Marshaller.js"
import * as Query from "./Query.js"
import { filterExpr, selectPaths } from "./Query.js"
import { resolveTtlAttributeName, type TableConfig } from "./Table.js"

// Internal modules (decomposed from Entity.ts)
export type {
  CascadeIndexConfig,
  GeneratedIdConfig,
  RefValue,
  SoftDeleteConfig,
  TimeSeriesConfig,
  TimestampFieldConfig,
  TimestampsConfig,
  UniqueConfig,
  UniqueConstraintDef,
  UniqueFieldsDef,
  VersionedConfig,
} from "@effect-dynamodb/schema/internal/EntityConfig.js"
export {
  type CascadeConfig,
  type CascadeTarget,
  type DecodeMode,
  type EntityBase,
  type EntityDelete,
  EntityDeleteImpl,
  EntityDeleteTypeId,
  type EntityGet,
  EntityGetImpl,
  type EntityGetOpts,
  type EntityOp,
  EntityOpTypeId,
  type EntityPut,
  EntityPutImpl,
  type EntityPutOpts,
  type EntityUpdate,
  EntityUpdateImpl,
  EntityUpdateTypeId,
  emptyUpdateState,
  type PutKind,
  type ReturnValuesMode,
  returnValuesMap,
  type UpdateReturn,
  type UpdateState,
  type WithVectors,
} from "./internal/EntityOps.js"

import * as Projection from "@effect-dynamodb/schema/Projection.js"
import {
  type AddOperand,
  type CascadeConfig,
  type CascadeTarget,
  type DecodeMode,
  type EntityDelete,
  EntityDeleteImpl,
  EntityDeleteTypeId,
  type EntityGet,
  EntityGetImpl,
  type EntityGetOpts,
  EntityOpTypeId,
  type EntityPut,
  EntityPutImpl,
  type EntityPutOpts,
  type EntityUpdate,
  EntityUpdateImpl,
  emptyUpdateState,
  type PutKind,
  type ReturnValuesMode,
  type UpdateState,
  withGuard,
} from "./internal/EntityOps.js"

export {
  add,
  append,
  asItem,
  asModel,
  asNative,
  asRecord,
  type ConditionPipeable,
  cascade,
  clearMap,
  consistentRead,
  deleteFromSet,
  expectedVersion,
  pathAdd,
  pathAppend,
  pathDelete,
  pathIfNotExists,
  pathPrepend,
  pathRemove,
  pathSet,
  pathSubtract,
  project,
  remove,
  removeEntries,
  returnValues,
  set,
  subtract,
} from "./internal/EntityCombinators.js"

import type {
  GeneratedIdConfig,
  SoftDeleteConfig,
  TimeSeriesConfig,
  TimestampsConfig,
  UniqueConfig,
  UniqueConstraintDef,
  VersionedConfig,
} from "@effect-dynamodb/schema/internal/EntityConfig.js"
import {
  allCompositeAttributes,
  allKeyFieldNames,
  type DerivedSchemas,
  getSchemaFields,
  makePathValueEncoder,
  primaryKeyComposites,
  type ResolvedSystemFields,
  resolveUniqueFields,
} from "@effect-dynamodb/schema/internal/EntitySchemas.js"
import type {
  AppendInputType,
  AppendRemovableFields,
  AppendSuccess as AppendSuccessType,
  EntityInputType,
  EntityKeyType,
  EntityRecordType,
  EntityRefCreateType,
  EntityRefInputType,
  EntityRefUpdateType,
  EntityUpdateType,
  IndexPkInput,
  ModelType,
  PrimaryKeyComposites,
  RefErrors,
  RemovableFields,
  VectorErrors,
  WithGeneratedId,
} from "@effect-dynamodb/schema/internal/EntityTypes.js"
import {
  asModel,
  type ConditionPipeable,
  condition as conditionCombinator,
  expectedVersion,
  type Removable,
  set,
} from "./internal/EntityCombinators.js"

// ---------------------------------------------------------------------------
// Re-export KeyComposer types for convenience
// ---------------------------------------------------------------------------

export type { IndexDefinition, KeyPart }

// ---------------------------------------------------------------------------
// Sparse-aware unique sentinel composition
// ---------------------------------------------------------------------------

/**
 * Compose a unique-constraint sentinel key, returning `undefined` when any
 * composing field is missing (`undefined` or `null`) on the source record.
 *
 * Mirrors GSI sparse semantics (`tryComposeIndexKeys`): a sentinel is only
 * written/deleted/checked when every composing field is present, so multiple
 * records can coexist with the field unset and an entity write doesn't synthesize
 * a literal `"undefined"` collision key.
 *
 * `source` is read by **domain** field name — a constraint declares domain
 * fields, so a row that came off the wire (keyed by stored attribute name) MUST
 * be passed through `toDomainView` first. Reading a renamed field off a raw row
 * yields `undefined`, which the sparse rule then reads as "constraint unset" and
 * silently skips the sentinel — the delete/purge/restore leak behind #127.
 */
/**
 * TTL helpers — pure implementations live in `@effect-dynamodb/schema/Entity`,
 * imported here for local use on the write path. `normalizeTtlSeconds` is
 * re-exported below so the public `Entity` namespace surface is unchanged.
 */
import {
  type AnyRefValue,
  type AppendInputFields,
  type AppendShardGuard,
  buildEntityDefinition,
  type EntityDefinition,
  type EntityDefinitionConfig,
  type EntityDefinitionData,
  type EntityGeneratedIdConfig,
  type EntityIndexesConfig,
  type EntityIndexesGuard,
  type EntityPrimaryKeyConfig,
  type EntityRefsConfig,
  type EntityTimeSeriesConfig,
  type EntityUniqueConfig,
  type EntityVectorIndexesConfig,
  type NormalizedIndexes,
  normalizeTtlSeconds,
  type RefsKeyGuard,
  type RefsOrNone,
  resolveUniqueTtl,
  zorderInCollection,
} from "@effect-dynamodb/schema/Entity.js"

export { normalizeTtlSeconds }

const composeUniqueSentinel = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  constraintName: string,
  constraintDef: UniqueConstraintDef,
  source: globalThis.Record<string, unknown>,
  /**
   * The value a field held when it was stored (`storedNumericForm`), or `undefined` when it is
   * that already. A sentinel is composed from the Encoded value `put` stores, and a row read back
   * holds a stored `bigint` as a number.
   */
  stored: (field: string, value: unknown) => unknown,
):
  | {
      readonly key: { readonly pk: string; readonly sk: string }
      readonly fieldsRecord: globalThis.Record<string, string>
    }
  | undefined => {
  const fields = resolveUniqueFields(constraintDef)
  // A field holding only a default has no sentinel (#133).
  const defaulted = source[UNSENTINELED_DEFAULTS]
  const defaultedFields =
    defaulted instanceof Set
      ? (defaulted as ReadonlySet<unknown>)
      : new Set(Array.isArray(defaulted) ? defaulted : [])
  if (fields.some((f) => defaultedFields.has(f))) return undefined
  const serialized: Array<string> = []
  const fieldsRecord: globalThis.Record<string, string> = {}
  for (const f of fields) {
    const given = source[f]
    if (given === undefined || given === null) return undefined
    const raw = stored(f, given) ?? given
    const s = KeyComposer.compositeText(schema, raw)
    serialized.push(s)
    fieldsRecord[f] = s
  }
  return {
    key: DynamoSchema.composeUniqueKey(
      schema,
      entityType,
      constraintName,
      serialized.map((text) => KeyComposer.keyText(schema, text, schema.casing)),
    ),
    fieldsRecord,
  }
}

// ---------------------------------------------------------------------------
// Encode-or-decode-encode helper
// ---------------------------------------------------------------------------

/**
 * Validate user input and produce wire-form output, accepting both Type and
 * Encoded shapes. Strategy:
 *
 *   1. Try `Schema.encode(input)`. This is the canonical Type → Encoded
 *      conversion and works when the user passes Type values for transforms
 *      (e.g. a `DateTime.Utc` for `Schema.DateTimeUtcFromString`, a `number`
 *      for `Schema.NumberFromString`, a `Redacted<string>` for our
 *      RedactedFromValue substitute).
 *
 *   2. On encode failure, fall back to `Schema.decode → Schema.encode`. This
 *      lifts plain inputs to the Type shape first (`Schema.Class` decode is
 *      forgiving — it constructs a class instance from a plain object), then
 *      re-encodes back to wire form. Required for nested `Schema.Class`
 *      fields whose Type is a class instance but whose Encoded is a plain
 *      object — users typically construct the plain object directly.
 *
 * Returns the Encoded shape (a plain object whose values are wire
 * primitives), ready for `toAttributeMap`.
 *
 * @internal
 */
/**
 * One `append` attempt's staleness guard: its condition, and the names and
 * values only it uses.
 */
type AppendCas = {
  readonly expression: string
  readonly names: globalThis.Record<string, string>
  readonly values: globalThis.Record<string, AttributeValue>
}

/**
 * An update's operands in the form they're written (`encodeOperands`): `.append()`'s by field,
 * each path operation's at its index (a `pathSet` copy's is `undefined`).
 */
type EncodedOperands = {
  readonly append: globalThis.Record<string, unknown>
  readonly pathSets: ReadonlyArray<unknown>
  readonly pathAppends: ReadonlyArray<unknown>
  readonly pathPrepends: ReadonlyArray<unknown>
  readonly pathIfNotExists: ReadonlyArray<unknown>
}

/** An update's operand its write schema refuses at its path: the operation, and the schema's issue. */
type RefusedOperand = { readonly operation: string; readonly issue: unknown }

/**
 * How many attempts an `append` on a string-encoded numeric `orderBy` makes in
 * all, reading and writing again after a concurrent write moved the item under
 * it (#171 E9) — and how many times any `append` sends its transaction while
 * DynamoDB cancels it for a `TransactionConflict` ({@link isTransactionConflict}).
 */
const APPEND_GUARD_ATTEMPTS = 8

/**
 * A transaction DynamoDB cancelled for contention alone: another transaction
 * was in flight on one of its items (`TransactionConflict`), and no condition
 * evaluated false. Nothing was written, and sent again it can apply, so it is
 * never a condition's verdict (#171). DynamoDB Local never raises it.
 */
const isTransactionConflict = (cause: unknown): boolean => {
  if (!isAwsTransactionCancelled(cause)) return false
  const reasons = cause.CancellationReasons ?? []
  return (
    reasons.some((reason) => reason?.Code === "TransactionConflict") &&
    !reasons.some((reason) => reason?.Code === "ConditionalCheckFailed")
  )
}

/**
 * @internal Build a key-form normaliser for an arbitrary entity-like value.
 *
 * `makeImpl` closes over its own `keyForm`; this is the escape hatch for the
 * two places that compose against a DIFFERENT entity's index (`cascade`) or run
 * outside `makeImpl` entirely (`bind`'s `reembed` / `history`). Same rule, same
 * `CompositeCodec` — just resolved per target.
 */
const keyFormFor = (
  target: unknown,
  record: globalThis.Record<string, unknown>,
): globalThis.Record<string, unknown> => {
  const t = target as {
    readonly model?: Schema.Top | undefined
    readonly schemas?: { readonly inputSchema?: Schema.Top | undefined } | undefined
  }
  const source = t.schemas?.inputSchema ?? t.model
  if (source === undefined) return record
  const form = makeCompositeKeyForm(source, (attr, value, reason) => {
    if (reason !== undefined) return refuseInexact(`Composite "${attr}"`, value, reason)
    throw new Error(
      `[EDD-9050] Composite "${attr}" could not be put into its key form: ` +
        `${JSON.stringify(String(value))} resolves under neither encode nor decode->encode.`,
    )
  })
  return toCompositeKeyRecord(form, record)
}

/**
 * @internal A plain update of a complete item found no item: the caller
 * creates it instead (`updateOrCreate`). Never escapes the update operation.
 */
/**
 * What a failed decode says, naming the field when the schema does: `"stock":
 * Expected a value greater than or equal to 0, got -2.`
 */
const decodeProblem = (cause: unknown): string => {
  if (!Schema.isSchemaError(cause)) return `${String(cause)}.`
  const first = SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue).issues[0]
  if (first === undefined) return `${cause.message}.`
  const path = (first.path ?? []).map((segment) => String(segment)).join(".")
  return path === "" ? `${first.message}.` : `"${path}": ${first.message}.`
}

class MissingForCreate extends Data.TaggedError("MissingForCreate")<{
  readonly input: unknown
}> {}

/** @internal Re-exported for tests: what DynamoDB counts against an expression's 300 operators. */
export { countOperators }

/**
 * The top-level attributes an UpdateExpression writes (SET / REMOVE / ADD /
 * DELETE targets), resolved through its attribute names.
 */
const expressionTargets = (
  expression: string,
  names: globalThis.Record<string, string>,
): ReadonlySet<string> => {
  const targets = new Set<string>()
  const sections = expression.split(/\b(SET|REMOVE|ADD|DELETE)\b/).slice(1)
  for (let i = 0; i + 1 < sections.length; i += 2) {
    const action = sections[i]!
    const body = sections[i + 1]!
    // Split on commas outside parentheses (`list_append(#a, :b)`).
    const items: Array<string> = []
    let depth = 0
    let current = ""
    for (const ch of body) {
      if (ch === "(") depth++
      if (ch === ")") depth--
      if (ch === "," && depth === 0) {
        items.push(current)
        current = ""
      } else current += ch
    }
    items.push(current)
    for (const item of items) {
      const trimmed = item.trim()
      if (trimmed === "") continue
      const path = action === "SET" ? trimmed.split("=")[0]!.trim() : trimmed.split(/\s+/)[0]!
      const head = path.split(/[.[]/)[0]!
      targets.add(head.startsWith("#") ? (names[head] ?? head) : head)
    }
  }
  return targets
}

const encodeOrDecodeEncode = (
  schema: Schema.Codec<any>,
  input: unknown,
  entityType: string,
  operation: string,
): Effect.Effect<unknown, ValidationError> =>
  Schema.encodeUnknownEffect(schema)(input).pipe(
    Effect.catch((primaryCause) =>
      Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.flatMap((decoded) => Schema.encodeUnknownEffect(schema)(decoded)),
        // On fallback failure, surface the original encode error — its
        // message is keyed on the caller's input shape, which is what the
        // user expects to see.
        Effect.catch(() =>
          Effect.fail(
            new ValidationError({
              entityType,
              operation: `${operation}.decode`,
              cause: primaryCause,
            }),
          ),
        ),
      ),
    ),
  )

// ---------------------------------------------------------------------------
// Entity interface — the return type of Entity.make()
// ---------------------------------------------------------------------------

/**
 * An Entity binds a domain model to a DynamoDB Table with index definitions,
 * system field configuration, unique constraints, and CRUD operations.
 *
 * Created via {@link make}. Returns a definition with descriptor builders.
 * Table association and binding happen via `DynamoClient.make()`.
 *
 * @typeParam TModel - Effect Schema defining the domain model
 * @typeParam TEntityType - Literal string discriminator stored as `__edd_e__`
 * @typeParam TIndexes - Index definitions (primary + GSIs)
 * @typeParam TTimestamps - Timestamp configuration
 * @typeParam TVersioned - Optimistic locking configuration
 * @typeParam TSoftDelete - Soft-delete configuration
 * @typeParam TUnique - Unique constraint definitions
 * @typeParam TIdentifier - Identifier field name (auto-generated, omitted from Create type)
 */
export interface Entity<
  TModel extends Schema.Top = Schema.Top,
  TEntityType extends string = string,
  TIndexes extends globalThis.Record<string, IndexDefinition> = globalThis.Record<
    string,
    IndexDefinition
  >,
  TTimestamps extends TimestampsConfig | undefined = TimestampsConfig | undefined,
  TVersioned extends VersionedConfig | undefined = VersionedConfig | undefined,
  TSoftDelete extends SoftDeleteConfig | undefined = SoftDeleteConfig | undefined,
  TUnique extends UniqueConfig | undefined = UniqueConfig | undefined,
  TRefs extends globalThis.Record<string, AnyRefValue> | undefined = undefined,
  TIdentifier extends string | undefined = undefined,
  TTimeSeries extends TimeSeriesConfig<any> | undefined = undefined,
  TGeneratedId extends GeneratedIdConfig | undefined = undefined,
  TVectorIndexes extends globalThis.Record<string, VectorIndexConfig> | undefined = undefined,
  TPackedFields extends string = never,
  TUnremovable extends string = never,
> {
  readonly _tag: "Entity"
  readonly model: TModel
  readonly entityType: TEntityType
  readonly indexes: TIndexes
  readonly timestamps: TTimestamps
  readonly versioned: TVersioned
  readonly softDelete: TSoftDelete
  readonly unique: TUnique
  readonly identifier: TIdentifier
  readonly timeSeries: TTimeSeries
  readonly generatedId: TGeneratedId
  /** Vector index declarations as authored (see `DESIGN.md §14`). */
  readonly vectorIndexes: TVectorIndexes

  /** @internal Normalized vector index definitions keyed by logical name. */
  readonly _vectorIndexes: globalThis.Record<string, VectorIndexDefinition>

  /**
   * @internal `[EDD-9140]` for the attributes a table's configuration names (its TTL attribute):
   * throws when a row's reader would take one this entity writes as a sparse map's entry.
   */
  readonly _refuseTableAttributes: (tableConfig: TableConfig) => void

  /**
   * The domain fields stored packed (`storedAs: DynamoModel.Packed(...)`).
   * Carries the `TPackedFields` type, which narrows expression path builders:
   * a packed field can be tested only with `exists` / `notExists` as a whole.
   */
  readonly _packedFields: ReadonlyArray<TPackedFields>

  /**
   * @internal Phantom — never read at runtime. Carries the fields
   * `.remove()` refuses by configuration (immutable, sparse map).
   */
  _unremovableFields?(field: TUnremovable): void

  /**
   * @internal Pack, in place, the packed attributes of an item keyed by stored
   * names (after renames and sparse flattening), before `toAttributeMap`.
   * `only` restricts packing to those stored attribute names.
   */
  readonly _packFields: (
    item: globalThis.Record<string, unknown>,
    operation: string,
    only?: ReadonlySet<string>,
  ) => Effect.Effect<void, ValidationError>

  /**
   * @internal Read, in place, every dispatch-eligible attribute of an
   * unmarshalled item (stored names) by its stored form — native unchanged,
   * `S` JSON, `B` header + payload — before sparse rebuild and renames.
   */
  readonly _unpackFields: (
    raw: globalThis.Record<string, unknown>,
    operation?: string,
  ) => Effect.Effect<void, ValidationError>

  /**
   * @internal The stored attributes {@link _unpackFields} reads by stored form
   * (packed ∪ dispatch-eligible): a projection naming none of them runs no
   * raw-row hook.
   */
  readonly _dispatchAttributes: ReadonlyArray<string>

  /**
   * @internal The packed attributes an expression or projection may not look
   * inside (`[EDD-9076]`), by domain AND stored name.
   */
  readonly _packedGuards: ReadonlyArray<PackedAttributeGuard>

  /**
   * @internal Decode a DynamoDB Streams image (DynamoDB JSON with `B` as bytes
   * or base64, or an unmarshalled item) into an item record — the
   * implementation of {@link decodeMarshalledItem}.
   */
  readonly _decodeImage: (image: StreamImage) => Effect.Effect<unknown, ValidationError>

  /** @internal Resolved ref metadata — used by cascade to inspect target entities */
  readonly _resolvedRefs: ReadonlyArray<{
    readonly fieldName: string
    readonly idFieldName: string
    readonly identifierField: string
    readonly refEntityType: string
  }>

  /** @internal Full decode pipeline: unpack + sparse + rename + schema decode. Used by Batch/Aggregate. */
  readonly _decodeRecord: (
    raw: globalThis.Record<string, unknown>,
  ) => Effect.Effect<any, ValidationError>

  /** @internal Domain field name → stored DynamoDB attribute name (`storedAs` renames). */
  readonly _resolveDbName: (domainName: string) => string

  /** @internal Entity schema version baked into composed keys. */
  readonly _entityVersion: number

  /**
   * @internal Flatten sparse-map fields into per-entry top-level attributes.
   * Mutates the item in place. Used by Transaction/Batch put builders.
   * Throws on invalid keys.
   */
  readonly _serializeSparseFields: (item: globalThis.Record<string, unknown>) => void

  /**
   * @internal Put a record into the composite key form (`internal/CompositeCodec.ts`)
   * before it reaches `KeyComposer`.
   *
   * Exposed because the multi-item write paths (`internal/TransactableOps.ts`,
   * `internal/TransactWriteOps.ts`, `Batch.ts`) and the aggregate/geo composers
   * compose keys OUTSIDE `makeImpl`, and a second implementation of the rule is
   * a second chance to disagree with `Entity.put`. Every such site must call
   * this rather than hand `KeyComposer` a raw record — `test/KeyFormInvariant.test.ts`
   * enforces it across all of them.
   */
  readonly _keyForm: (
    record: globalThis.Record<string, unknown>,
  ) => globalThis.Record<string, unknown>

  /**
   * @internal {@link _keyForm} of a caller's key record, a DOMAIN record: each
   * composite first put into the form `Entity.put` stores it in
   * (`makeCompositeStoredForm`), so the key is the one `put` wrote for that value,
   * the key this entity's own `get` composes. For the key-taking multi-item ops
   * (`Batch.get`, `Batch.write` deletes, `transactGet`, `transactWrite` deletes and
   * condition checks), which hold the caller's key.
   */
  readonly _domainKeyForm: (
    record: globalThis.Record<string, unknown>,
  ) => globalThis.Record<string, unknown>

  /**
   * @internal What in a caller's DOMAIN key record DynamoDB can't store, as `put` decides it for
   * an item holding those values: each encoded through `inputSchema`'s own field as `put` encodes
   * its input (`encodeOrDecodeEncode`), then judged by the check `put` runs on what it encoded
   * (`unstorableOf`), a `NaN` left to key composition (`EDD-9096`). `undefined` when it all stores;
   * a value that doesn't encode fails with the `ValidationError` `put` fails with. For a path
   * holding an id it fetches by (aggregate ref hydration): no item can be keyed by a value `put`
   * refuses, and its key text may name an item of another value.
   */
  readonly _unstorableKey: (
    record: globalThis.Record<string, unknown>,
  ) => Effect.Effect<UnstorableValue | undefined, ValidationError>

  /**
   * @internal Rename domain field names to their stored DynamoDB attribute
   * names (`storedAs`), in place. `Entity.put` applies this; the transact/batch
   * put builder must apply the SAME one or a `storedAs` entity gets a
   * differently-shaped item depending on which API wrote it.
   */
  readonly _renameToDynamo: (item: globalThis.Record<string, unknown>) => void
  /** @internal The model field a stored attribute holds, for a message naming it. */
  readonly _fieldOfAttribute: (attribute: string) => string

  /**
   * @internal Whether a created item carries the hidden incarnation token
   * (`__edd_i__`) — every versioned entity.
   */
  readonly _incarnationToken: boolean

  /** @internal An item with an incarnation token but no version (see `versionCorruption`). */
  readonly _versionCorruption: (
    item: Readonly<globalThis.Record<string, unknown>> | undefined,
    operation: string,
  ) => ValidationError | undefined

  /** @internal Fill omitted decoding-default fields of a put's input (see `put`). */
  readonly _fillDecodingDefaults: (input: unknown) => Effect.Effect<unknown, ValidationError>
  /**
   * Refuses an encoded payload holding a value of a custom declaration that wouldn't read back
   * (`EDD-9126`), or a key value of a field taking both numeric kinds that reads back as the other
   * (`EDD-9128`). For a write path outside this entity's own operations.
   * @internal
   */
  readonly _refuseNotReadBack: (
    encoded: unknown,
    operation: string,
  ) => Effect.Effect<void, ValidationError>

  /** @internal Unique fields a put's input leaves to an index-stored default. */
  readonly _unsentineledDefaults: (input: unknown) => ReadonlyArray<string>

  /**
   * @internal Plan a guarded put — of a versioned or unique-constrained entity —
   * from a fresh read of the item (#133): the same items `put` writes (the
   * item continued or created, its sentinels rotated, its snapshot), for the
   * transaction paths (`Transaction.transactWrite`, `EventStore.append`'s
   * `additionalItems`) to write in their own transaction. `item` is the output
   * of `validateAndBuildPutItem`. A `Retry` verdict means plan it again.
   */
  readonly _planPut: (args: {
    readonly tableName: string
    readonly ttlAttrName: string
    readonly now: DateTime.Utc
    readonly item: globalThis.Record<string, unknown>
    readonly createdAtSupplied: boolean
    readonly userCondition:
      | {
          readonly expression: string
          readonly names: globalThis.Record<string, string>
          readonly values: globalThis.Record<string, AttributeValue>
        }
      | undefined
    readonly create: boolean
    readonly operation: string
    readonly key: globalThis.Record<string, unknown>
    /** The item's keys, were these system fields what the plan carries over. */
    readonly composeKeys: (
      carried: globalThis.Record<string, unknown>,
    ) => Effect.Effect<globalThis.Record<string, unknown>, ValidationError>
  }) => Effect.Effect<PutPlan, ValidationError | DynamoClientError, DynamoClient>

  /**
   * @internal Whether this entity's write contract needs items beyond the one
   * the transact/batch compile path emits, and which config asks for it. Used to
   * decide between expanding (put) and rejecting (delete, and all of Batch).
   */
  readonly _multiItemWriteFeatures: ReadonlyArray<"unique" | "retain" | "softDelete">

  /**
   * @internal Compile an `update` into the transact items it would issue,
   * without issuing them — for `Transaction.transactWrite`.
   *
   * Runs the standalone update itself (`updateOrCreate`, so `patch` and an
   * update of a missing row behave exactly as standalone) with its write
   * recorded instead of sent (`internal/TransactPlan.planWrite`). The plan is
   * therefore the standalone write, guards included. It reads first wherever
   * the standalone update does, which is why the read's outcomes
   * (`ItemNotFound`, `OptimisticLockError`, …) can surface here.
   */
  readonly _planUpdate: (
    key: unknown,
    state: UpdateState,
    /** What {@link _prepareUpdate} decided of `state`. */
    prepared: PreparedUpdate,
  ) => Effect.Effect<TransactPlan, PlanUpdateError, DynamoClient | TableConfig>

  /**
   * @internal What an `update` decides from its own operands, reading nothing: every refusal of
   * its names, operands, payload and the keys the payload composes, and its encoded payload. Run by
   * `Transaction.transactWrite` for every op before any op reads; {@link _planUpdate} plans the
   * update from it. `encoded` is `key` through {@link _encodeKey}.
   */
  readonly _prepareUpdate: (
    key: unknown,
    state: UpdateState,
    encoded: globalThis.Record<string, unknown>,
  ) => Effect.Effect<PreparedUpdate, ValidationError, TableConfig>

  /**
   * @internal Compile a `delete` into the transact items it would issue — the
   * `delete` counterpart of `_planUpdate`. For an entity with `unique`,
   * `versioned: { retain: true }` or `softDelete` this includes the read of the
   * stored row the sentinel releases, snapshot and tombstone are built from:
   * the read whose absence is why the plain compile path refuses these
   * deletes (EDD-9048).
   */
  readonly _planDelete: (
    key: unknown,
    opts: {
      readonly condition: Expr | ConditionInput | undefined
      readonly mustExist: boolean
    },
    /** `key` through {@link _encodeKey}: refused before any op of the transaction reads. */
    encoded: globalThis.Record<string, unknown>,
  ) => Effect.Effect<TransactPlan, PlanDeleteError, DynamoClient | TableConfig>

  /**
   * @internal A key as the entity's own ops take it: encoded through its key schema, and its
   * primary key composed, a composite with no key text a `ValidationError`. What
   * `Transaction.transactWrite` checks of a planned op before any op reads.
   */
  readonly _encodeKey: (
    key: unknown,
    operation: string,
  ) => Effect.Effect<globalThis.Record<string, unknown>, ValidationError>

  /**
   * @internal Which of this entity's rows are items: a row is live iff the
   * sort key composed from its own stored composites is its stored sort key.
   * Version snapshots, soft-delete tombstones and time-series events keep the
   * entity's `__edd_e__` but never satisfy it, so a query of the primary key
   * or a scan leaves them out (#133). `undefined` without `retain`,
   * `softDelete` or `timeSeries` — every row is then an item.
   */
  readonly _liveRows: () => Query.LiveRows | undefined

  /**
   * @internal `rekey`'s handler for a projection's row tombstone or outbox
   * item of this read model (#171) — `keys`: the table key attributes of an
   * outbox on another table.
   */
  readonly _rekeyProjectionRow: (
    row: globalThis.Record<string, AttributeValue>,
    ctx: Rekey.RekeyRowContext,
    keys?: { readonly pk: string; readonly sk: string } | undefined,
  ) => Effect.Effect<Rekey.RekeyTally | undefined, DynamoClientError, DynamoClient | TableConfig>
  /**
   * @internal The mark (`__edd_kt__`) a projection's row tombstone or outbox item takes for the
   * read-model row at `key` (a domain key record, `_domainKeyForm`): `KeyText136.markOf`.
   */
  readonly _keyTextMark: (key: globalThis.Record<string, unknown>) => 2 | undefined

  /** @internal Attach model class prototype to a decoded plain object (no-op for Schema.Struct models). */
  readonly _attachPrototype: (decoded: any) => any
  /**
   * @internal `create` over a projection tombstone (#154), for the transaction
   * path — see `overTombstone`.
   */
  readonly _overTombstone: (
    item: globalThis.Record<string, unknown>,
  ) => Effect.Effect<Option.Option<ConditionInput>, DynamoClientError, DynamoClient | TableConfig>

  /**
   * @internal Configure the entity with table schema and tag.
   * Called by DynamoClient.make() when binding entities to a table.
   */
  readonly _configure: (
    schema: DynamoSchema.DynamoSchema,
    tableTag: import("effect").Context.Service<TableConfig, TableConfig>,
  ) => void

  /**
   * @internal Inject a GSI index definition into this entity.
   * Called by Collections binding or DynamoClient.make() to add collection-owned indexes.
   * The injected index becomes available to all entity operations (put, update, etc.)
   * for key composition.
   */
  readonly _injectIndex: (name: string, def: IndexDefinition) => void

  /** @internal Injected DynamoSchema — available after _configure(). Used by cascade. */
  readonly _schema: DynamoSchema.DynamoSchema
  /** @internal Injected TableConfig tag — available after _configure(). Used by cascade. */
  readonly _tableTag: import("effect").Context.Service<TableConfig, TableConfig>

  /** Resolved system field names */
  readonly systemFields: ResolvedSystemFields

  /** Derived schemas for type extraction */
  readonly schemas: DerivedSchemas

  /**
   * Typed input schema. Ref-aware: ref fields are replaced with branded ID fields.
   * Use in HttpApiEndpoint payloads or for validation.
   *
   * @example
   * ```ts
   * HttpApiEndpoint.post("create", "/squads", {
   *   payload: SquadSelections.inputSchema,
   * })
   * ```
   */
  readonly inputSchema: Schema.Codec<
    EntityRefInputType<TModel, TRefs, TTimestamps, TVersioned, TTimeSeries>
  >

  /**
   * Typed create schema. Input fields minus primary key composites — the common
   * "create" payload where IDs are auto-generated.
   *
   * @example
   * ```ts
   * HttpApiEndpoint.post("create", "/teams", {
   *   payload: Teams.createSchema,
   *   success: Team,
   * })
   * ```
   */
  readonly createSchema: Schema.Codec<
    EntityRefCreateType<TModel, TIndexes, TRefs, TIdentifier, TTimestamps, TVersioned, TTimeSeries>
  >

  /**
   * Typed update schema. Partial fields minus primary key composites and immutable fields.
   * Ref fields are replaced with optional branded ID fields.
   */
  readonly updateSchema: Schema.Codec<
    EntityRefUpdateType<TModel, TIndexes, TRefs, TTimestamps, TVersioned>
  >

  // --- CRUD Operations ---

  /** Fetch an item by primary key. Returns a lazy {@link EntityGet} intermediate. */
  readonly get: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityGet<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    ItemNotFound | DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /**
   * Create or replace an item. Returns a lazy {@link EntityPut} intermediate.
   *
   * On a versioned or unique-constrained entity the put reads the item first:
   * a replacing put continues its version, incarnation and `createdAt`,
   * snapshots it (`retain`) and rotates its unique sentinels — releasing only
   * those the item owns; a created one continues after any history retained
   * for its key. A concurrent write between the read and the put is retried,
   * so the last writer wins; a race lost on every attempt is an
   * `OptimisticLockError` (versioned) or `ConcurrentModification`.
   */
  readonly put: (
    input: WithGeneratedId<
      EntityRefInputType<TModel, TRefs, TTimestamps, TVersioned, TTimeSeries>,
      TGeneratedId
    >,
  ) => EntityPut<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    | DynamoClientError
    | TransactionOverflow
    | ValidationError
    | UniqueConstraintViolation
    | OptimisticLockError
    | ConcurrentModification
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    DynamoClient | TableConfig
  >

  /**
   * Begin an update operation on an existing item. Returns a lazy {@link EntityUpdate} intermediate.
   * Pipe to {@link set} to provide update fields and {@link expectedVersion} for optimistic locking.
   */
  readonly update: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityUpdate<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    EntityRefUpdateType<TModel, TIndexes, TRefs, TTimestamps, TVersioned> &
      Removable<RemovableFields<TModel, TIndexes, TRefs, TTimestamps, TVersioned, TUnremovable>>,
    | DynamoClientError
    | TransactionOverflow
    | ItemNotFound
    | OptimisticLockError
    | ConcurrentModification
    | UpdateAppliedButUnreadable
    | UniqueConstraintViolation
    | ValidationError
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    DynamoClient | TableConfig
  >

  /**
   * Delete an item by primary key. Returns a lazy {@link EntityDelete} intermediate.
   * A unique-constrained entity releases only the sentinels the item owns.
   */
  readonly delete: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityDelete<
    | DynamoClientError
    | TransactionOverflow
    | ItemNotFound
    | OptimisticLockError
    | ConcurrentModification
    | ValidationError
    | DeleteAppliedButUnreadable,
    DynamoClient | TableConfig,
    void,
    ModelType<TModel>
  >

  /**
   * Create a new item. Fails with `ConditionalCheckFailed` if an item with the same
   * primary key already exists. Equivalent to `put(input)` with an `attribute_not_exists`
   * condition — it never reads the item (a `retain` entity reads only the highest
   * version retained for the key, to continue after it).
   */
  readonly create: (
    input: WithGeneratedId<
      EntityRefInputType<TModel, TRefs, TTimestamps, TVersioned, TTimeSeries>,
      TGeneratedId
    >,
  ) => EntityPut<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    | DynamoClientError
    | TransactionOverflow
    | ValidationError
    | UniqueConstraintViolation
    | OptimisticLockError
    | ConcurrentModification
    | ConditionalCheckFailed
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    DynamoClient | TableConfig
  >

  /**
   * Update an existing item. Fails with `ConditionalCheckFailed` if the item doesn't exist.
   * Equivalent to `update(key)` with an automatic `attribute_exists` condition on the PK field.
   */
  readonly patch: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityUpdate<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    EntityRefUpdateType<TModel, TIndexes, TRefs, TTimestamps, TVersioned> &
      Removable<RemovableFields<TModel, TIndexes, TRefs, TTimestamps, TVersioned, TUnremovable>>,
    | DynamoClientError
    | TransactionOverflow
    | ItemNotFound
    | OptimisticLockError
    | ConcurrentModification
    | UpdateAppliedButUnreadable
    | UniqueConstraintViolation
    | ValidationError
    | ConditionalCheckFailed
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    DynamoClient | TableConfig
  >

  /**
   * Delete an existing item. Fails with `ConditionalCheckFailed` if the item doesn't exist.
   * Equivalent to `delete(key)` with an automatic `attribute_exists` condition on the PK field.
   */
  readonly deleteIfExists: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityDelete<
    | DynamoClientError
    | TransactionOverflow
    | ItemNotFound
    | OptimisticLockError
    | ConcurrentModification
    | ValidationError
    | DeleteAppliedButUnreadable
    | ConditionalCheckFailed,
    DynamoClient | TableConfig,
    void,
    ModelType<TModel>
  >

  /**
   * Create an item, or update the fields the input supplies on an existing one —
   * immutable fields, `createdAt` and fields the input omits keep their stored
   * values; the version is incremented. The whole input is validated either way.
   * Returns the full record.
   *
   * Plain entities: one UpdateItem, `if_not_exists()` for immutable fields,
   * `createdAt` and the version (`if_not_exists(version, 0) + 1`). An entity with
   * `unique` constraints or `versioned: { retain: true }` — or an input omitting a
   * defaulted index composite — reads the item once first: missing, it is
   * `create`d (sentinels reserved, snapshot written, defaults stored); present, it
   * is updated (sentinels rotated, the replaced item snapshotted). A concurrent
   * create or delete in between is retried the other way; a race lost on every
   * attempt is an `OptimisticLockError` (versioned) or `ConcurrentModification`.
   */
  readonly upsert: (
    input: WithGeneratedId<
      EntityRefInputType<TModel, TRefs, TTimestamps, TVersioned, TTimeSeries>,
      TGeneratedId
    >,
  ) => EntityPut<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    | DynamoClientError
    | TransactionOverflow
    | ValidationError
    | ItemNotFound
    | UniqueConstraintViolation
    | OptimisticLockError
    | ConcurrentModification
    | ConditionalCheckFailed
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    DynamoClient | TableConfig
  >

  // --- Lifecycle Operations ---

  /** Fetch a specific version snapshot by version number. */
  readonly getVersion: (
    key: EntityKeyType<TModel, TIndexes>,
    version: number,
  ) => EntityGet<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    ItemNotFound | DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /** Query version history for an item. Returns a Query for piping with limit, reverse, collect. */
  readonly versions: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => Query.Query<EntityRecordType<TModel, TTimestamps, TVersioned>>

  /** Restore a soft-deleted item. Recomposes index keys and re-establishes unique sentinels. */
  readonly restore: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityGet<
    ModelType<TModel>,
    EntityRecordType<TModel, TTimestamps, TVersioned>,
    | ItemNotFound
    | ItemNotDeleted
    | DynamoClientError
    | TransactionOverflow
    | ValidationError
    | UniqueConstraintViolation
    | ConcurrentModification,
    DynamoClient | TableConfig
  >

  /**
   * Permanently remove an item plus all version history and sentinels. Deletes
   * in `BatchWriteItem` chunks of 25, retrying `UnprocessedItems` with
   * backoff; not atomic, so a failure says exactly how many items it had
   * already deleted.
   */
  readonly purge: (
    key: EntityKeyType<TModel, TIndexes>,
  ) => EntityDelete<DynamoClientError | ValidationError, DynamoClient | TableConfig>

  /** Soft-deleted item accessors. */
  readonly deleted: {
    /** Get a specific soft-deleted item. */
    readonly get: (
      key: EntityKeyType<TModel, TIndexes>,
    ) => EntityGet<
      ModelType<TModel>,
      EntityRecordType<TModel, TTimestamps, TVersioned>,
      ItemNotFound | DynamoClientError | ValidationError,
      DynamoClient | TableConfig
    >
    /** List soft-deleted items within a partition. */
    readonly list: (
      key: EntityKeyType<TModel, TIndexes>,
    ) => Query.Query<EntityRecordType<TModel, TTimestamps, TVersioned>>
  }

  // --- Time-series Operations (only when `timeSeries` is configured) ---

  /**
   * Append an event to a time-series entity. Atomically updates the "current"
   * item (scoped SET on `appendInput` fields only + CAS on `orderBy`) and
   * writes an immutable event item under the same partition.
   *
   * **Stale-as-error contract:** on CAS rejection the Effect fails with
   * {@link StaleAppend} (carrying `current: Option.some(...)` from the
   * follow-up GetItem). When a user-supplied `condition` rejected the write
   * but the CAS held, the Effect fails with {@link ConditionalCheckFailed}
   * (also carrying `current`). This supersedes the v1 stale-as-value design.
   *
   * The optional `condition` argument is ANDed onto the CAS ConditionExpression.
   * The optional `skipFollowUp` flag suppresses the post-transaction GetItem;
   * success becomes `void` and CAS / user-condition failures collapse into
   * `StaleAppend(current: Option.none())` (cannot disambiguate without the
   * GetItem). See `guides/timeseries.mdx`.
   *
   * Only available when the entity was built with `timeSeries: { ... }`.
   */
  readonly append: [TTimeSeries] extends [TimeSeriesConfig<infer TAI extends Schema.Top>]
    ? {
        (
          input: AppendInputType<TAI>,
          condition?: Expr | ConditionInput,
          skipFollowUp?: false,
          removeAttrs?: ReadonlyArray<
            AppendRemovableFields<
              TModel,
              TIndexes,
              TRefs,
              TTimeSeries,
              TTimestamps,
              TVersioned,
              TUnremovable
            >
          >,
        ): Effect.Effect<
          { readonly current: ModelType<TModel> },
          | DynamoClientError
          | ValidationError
          | StaleAppend
          | ConditionalCheckFailed
          | ConcurrentModification,
          DynamoClient | TableConfig
        >
        (
          input: AppendInputType<TAI>,
          condition: Expr | ConditionInput | undefined,
          skipFollowUp: true,
          removeAttrs?: ReadonlyArray<
            AppendRemovableFields<
              TModel,
              TIndexes,
              TRefs,
              TTimeSeries,
              TTimestamps,
              TVersioned,
              TUnremovable
            >
          >,
        ): Effect.Effect<
          void,
          DynamoClientError | ValidationError | StaleAppend | ConcurrentModification,
          DynamoClient | TableConfig
        >
      }
    : never

  /**
   * Query the event history of a time-series entity partition. Returns a
   * `Query.Query` auto-scoped via `begins_with(<currentSk>#e#)`.
   *
   * Only available when the entity was built with `timeSeries: { ... }`.
   */
  readonly history: [TTimeSeries] extends [TimeSeriesConfig<any>]
    ? (key: EntityKeyType<TModel, TIndexes>) => Query.Query<ModelType<TModel>>
    : never

  // --- Update Combinators (entity-scoped, type-safe in both paths) ---

  /**
   * Set combinator pre-bound to this entity's update type.
   *
   * Any subset of a GSI's composites may be set: GSI keys are recomposed per
   * half — a half whose composites are given is recomposed, an untouched half
   * is left as stored, and a touched half that cannot be composed follows the
   * index's policy (`'sparse'` removes it, `'preserve'` keeps it).
   *
   * @example
   * ```typescript
   * // data-last
   * yield* Users.update({ userId: "u-1" }).pipe(
   *   Users.set({ tenantId: "t-3", region: "us-east-1" }),
   * )
   *
   * // data-first
   * Entity.set(Users.update({ userId: "u-1" }), { tenantId: "t-3", region: "us-east-1" })
   * ```
   */
  readonly set: {
    (
      updates: EntityRefUpdateType<TModel, TIndexes, TRefs, TTimestamps, TVersioned>,
    ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
    <A, Rec, U, E, R>(
      self: EntityUpdate<A, Rec, U, E, R>,
      updates: EntityRefUpdateType<TModel, TIndexes, TRefs, TTimestamps, TVersioned>,
    ): EntityUpdate<A, Rec, U, E, R>
  }

  /**
   * Set expected version for optimistic locking.
   * Entity-scoped for consistent pipe chains with {@link Entity.set}.
   */
  readonly expectedVersion: {
    (
      version: number,
    ): <A, Rec, U, E, R>(self: EntityUpdate<A, Rec, U, E, R>) => EntityUpdate<A, Rec, U, E, R>
    <A, Rec, U, E, R>(
      self: EntityUpdate<A, Rec, U, E, R>,
      version: number,
    ): EntityUpdate<A, Rec, U, E, R>
  }

  /** Index query accessors. Each non-primary index becomes a method that accepts PK composites and returns a {@link Query.Query}. */
  readonly query: {
    readonly [K in Exclude<keyof TIndexes, "primary">]: (
      pk: IndexPkInput<TModel, TIndexes, K, TRefs>,
    ) => Query.Query<ModelType<TModel>>
  }

  /** Scan all items of this entity type. Returns a {@link Query.Query} that uses DynamoDB Scan. */
  readonly scan: () => Query.Query<ModelType<TModel>>

  // --- Expression Combinators (callback + shorthand) ---

  /**
   * Build a condition expression combinator.
   * Callback receives `(t, ops)` where `t` is a PathBuilder and `ops` provides comparison functions.
   * Shorthand accepts a simple object for AND-equality conditions.
   *
   * @example
   * ```typescript
   * // Callback
   * Teams.condition((t, { eq }) => eq(t.status, "active"))
   * // Shorthand
   * Teams.condition({ status: "active" })
   * ```
   *
   * Applying the returned pipeable widens the operation's error channel with
   * {@link ConditionalCheckFailed}, so `Effect.catchTag("ConditionalCheckFailed", ...)`
   * type-checks on the resulting Effect.
   */
  readonly condition: {
    (
      cb: (
        t: import("./internal/PathBuilder.js").PathBuilder<
          PathModel<ModelType<TModel>, TPackedFields>,
          PathModel<ModelType<TModel>, TPackedFields>
        >,
        ops: import("./internal/Expr.js").ConditionOps<PathModel<ModelType<TModel>, TPackedFields>>,
      ) => import("./internal/Expr.js").Expr,
    ): ConditionPipeable
    (shorthand: globalThis.Record<string, unknown>): ConditionPipeable
  }

  /**
   * Build a filter expression for query/scan operations.
   * Same API as `condition()` — callback or shorthand.
   *
   * @example
   * ```typescript
   * teams.collect(Teams.query.byAll(pk), Teams.filter((t, { gt }) => gt(t.wins, 10)))
   * ```
   */
  readonly filter: {
    (
      cb: (
        t: import("./internal/PathBuilder.js").PathBuilder<
          PathModel<ModelType<TModel>, TPackedFields>,
          PathModel<ModelType<TModel>, TPackedFields>
        >,
        ops: import("./internal/Expr.js").ConditionOps<PathModel<ModelType<TModel>, TPackedFields>>,
      ) => import("./internal/Expr.js").Expr,
    ): <A>(self: Query.Query<A>) => Query.Query<A>
    (shorthand: globalThis.Record<string, unknown>): <A>(self: Query.Query<A>) => Query.Query<A>
  }

  /**
   * Build a select (projection) combinator for get/query/scan operations.
   * Callback receives `t` — a PathBuilder. Returns an array of paths to project.
   * String array shorthand for top-level only projections.
   *
   * @example
   * ```typescript
   * Teams.select((t) => [t.name, t.address.city])
   * Teams.select(["name", "status"])
   * ```
   */
  readonly select: {
    (
      cb: (
        t: import("./internal/PathBuilder.js").PathBuilder<
          PathModel<ModelType<TModel>, TPackedFields>,
          PathModel<ModelType<TModel>, TPackedFields>
        >,
      ) => ReadonlyArray<
        | import("./internal/PathBuilder.js").Path<PathModel<ModelType<TModel>, TPackedFields>, any>
        | import("./internal/PathBuilder.js").PackedPath<
            PathModel<ModelType<TModel>, TPackedFields>,
            any
          >
      >,
    ): (self: Query.Query<any>) => Query.Query<any>
    (attributes: ReadonlyArray<string>): (self: Query.Query<any>) => Query.Query<any>
  }
}

// ---------------------------------------------------------------------------
// BoundEntity — Entity operations with services pre-resolved (R = never)
// ---------------------------------------------------------------------------

/**
 * An Entity whose CRUD operations have `DynamoClient` and `TableConfig` already
 * resolved, so all methods return `Effect<A, E, never>`.
 *
 * Created via {@link bind}. Use in service layers to avoid leaking infrastructure
 * requirements through service method signatures.
 *
 * @example
 * ```typescript
 * export class TeamService extends Context.Service<TeamService>()("TeamService", {
 *   make: Effect.gen(function* () {
 *     const db = yield* DynamoClient.make({ entities: { Teams }, tables: { MainTable } })
 *     const teams = db.entities.Teams
 *     return {
 *       get: (id: TeamId) => teams.get({ id }),           // R = never
 *       create: (input) => teams.create({ ...input }),     // R = never
 *       list: (filter) => teams.byAll(filter).collect(),  // R = never
 *     }
 *   }),
 * }) {}
 * ```
 */
/**
 * What `.history(key).where()` accepts for the `orderBy` attribute: its model
 * type, as `.where()` on an accessor takes, plus the stored text form for a
 * non-numeric one (an ISO string for a `DateTime`, as the history guide
 * shows). A `number` or `bigint` `orderBy` takes a number: it was typed
 * `string` only, so a numeric history bound did not compile.
 */
type HistoryOrderByOperand<M, K extends string> = K extends keyof M
  ? [M[K]] extends [number | bigint]
    ? M[K]
    : M[K] | string
  : string

/**
 * The logical vector index names an entity declares, as a string union.
 *
 * Resolves to `never` for entities without `vectorIndexes`, which makes
 * `.withVector()` uncallable on them — an unusable method beats a method that
 * silently does nothing.
 */
export type VectorIndexNames<TVectorIndexes> =
  TVectorIndexes extends globalThis.Record<string, VectorIndexConfig>
    ? keyof TVectorIndexes & string
    : never

export interface BoundEntity<
  TModel extends Schema.Top,
  TIndexes extends globalThis.Record<string, IndexDefinition>,
  TRefs extends globalThis.Record<string, AnyRefValue> | undefined,
  TKey = EntityKeyType<TModel, TIndexes>,
  TTimeSeries extends TimeSeriesConfig<any> | undefined = undefined,
  TTimestamps extends TimestampsConfig | undefined = undefined,
  TVersioned extends VersionedConfig | undefined = undefined,
  TGeneratedId extends GeneratedIdConfig | undefined = undefined,
  TVectorIndexes extends globalThis.Record<string, VectorIndexConfig> | undefined = undefined,
  TPackedFields extends string = never,
  TUnremovable extends string = never,
> {
  // --- CRUD Operations ---

  /**
   * Fetch an item by primary key.
   *
   * Returns a {@link BoundGet}, which **is** an `Effect<Model, …, never>` —
   * `yield*` it, `.pipe(Effect.catchTag("ItemNotFound", …))` it, hand it to any
   * Effect combinator, exactly as before. It additionally carries the read
   * descriptor, so it can be passed straight to `Batch.get`,
   * `Transaction.transactGet` and `Transaction.check` (#108).
   *
   * ```ts
   * const user = yield* db.entities.Users.get({ userId })
   * const [a, b] = yield* Batch.get([
   *   db.entities.Users.get({ userId: "u-1" }),
   *   db.entities.Users.get({ userId: "u-2" }),
   * ])
   * ```
   */
  readonly get: (
    key: TKey,
  ) => import("./internal/BoundCrud.js").BoundGet<
    ModelType<TModel>,
    ItemNotFound | DynamoClientError | ValidationError
  >

  /**
   * Create or replace an item. Returns a fluent {@link BoundPut} — yield to execute,
   * chain `.condition(...)` to add a condition expression.
   *
   * ```ts
   * yield* db.entities.Users.put(input)
   * yield* db.entities.Users.put(input).condition({ status: "active" })
   * ```
   */
  readonly put: (
    input: WithGeneratedId<
      EntityRefInputType<TModel, TRefs, TTimestamps, TVersioned, TTimeSeries>,
      TGeneratedId
    >,
  ) => import("./internal/BoundCrud.js").BoundPut<
    ModelType<TModel>,
    ModelType<TModel>,
    | DynamoClientError
    | TransactionOverflow
    | ValidationError
    | UniqueConstraintViolation
    | OptimisticLockError
    | ConcurrentModification
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    VectorIndexNames<TVectorIndexes>,
    TPackedFields
  >

  /**
   * Create a new item. Fails with {@link ConditionalCheckFailed} if an item with the same
   * primary key already exists. Returns a fluent {@link BoundPut}.
   */
  readonly create: (
    input: WithGeneratedId<
      EntityRefInputType<TModel, TRefs, TTimestamps, TVersioned, TTimeSeries>,
      TGeneratedId
    >,
  ) => import("./internal/BoundCrud.js").BoundPut<
    ModelType<TModel>,
    ModelType<TModel>,
    | DynamoClientError
    | TransactionOverflow
    | ValidationError
    | UniqueConstraintViolation
    | OptimisticLockError
    | ConcurrentModification
    | ConditionalCheckFailed
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    VectorIndexNames<TVectorIndexes>,
    TPackedFields
  >

  /**
   * Begin an update on an existing item. Returns a fluent {@link BoundUpdate} — chain
   * `.set(...)`, `.remove(...)`, `.add(...)`, `.condition(...)`, `.expectedVersion(...)`,
   * then `yield*`.
   *
   * ```ts
   * yield* db.entities.Tasks.update({ id }).set(updates).expectedVersion(3)
   * ```
   */
  readonly update: (
    key: TKey,
  ) => import("./internal/BoundCrud.js").BoundUpdate<
    ModelType<TModel>,
    ModelType<TModel>,
    EntityRefUpdateType<TModel, TIndexes, TRefs, TTimestamps, TVersioned>,
    | DynamoClientError
    | TransactionOverflow
    | ItemNotFound
    | OptimisticLockError
    | ConcurrentModification
    | UpdateAppliedButUnreadable
    | UniqueConstraintViolation
    | ValidationError
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    VectorIndexNames<TVectorIndexes>,
    TPackedFields,
    RemovableFields<TModel, TIndexes, TRefs, TTimestamps, TVersioned, TUnremovable>
  >

  /**
   * Delete an item by primary key. Returns a fluent {@link BoundDelete} — yield to execute,
   * chain `.condition(...)` and/or `.returnValues(...)`.
   *
   * ```ts
   * yield* db.entities.Tasks.delete(key)
   * yield* db.entities.Tasks.delete(key).condition({ status: "archived" })
   * ```
   */
  readonly delete: (
    key: TKey,
  ) => import("./internal/BoundCrud.js").BoundDelete<
    ModelType<TModel>,
    | DynamoClientError
    | TransactionOverflow
    | ItemNotFound
    | OptimisticLockError
    | ConcurrentModification
    | ValidationError
    | DeleteAppliedButUnreadable,
    void,
    TPackedFields
  >

  /**
   * Create an item, or update the fields the input supplies on an existing one.
   * Returns a fluent {@link BoundPut}. See `Entity.upsert`: a plain entity is one
   * UpdateItem with `if_not_exists()` for immutable fields, `createdAt` and the
   * version; a `unique` or `retain` entity (or an input omitting a defaulted index
   * composite) reads the item once and creates or updates it.
   */
  readonly upsert: (
    input: WithGeneratedId<
      EntityRefInputType<TModel, TRefs, TTimestamps, TVersioned, TTimeSeries>,
      TGeneratedId
    >,
  ) => import("./internal/BoundCrud.js").BoundPut<
    ModelType<TModel>,
    ModelType<TModel>,
    | DynamoClientError
    | TransactionOverflow
    | ValidationError
    | ItemNotFound
    | UniqueConstraintViolation
    | OptimisticLockError
    | ConcurrentModification
    | ConditionalCheckFailed
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    VectorIndexNames<TVectorIndexes>,
    TPackedFields
  >

  /**
   * Update an existing item. Fails with {@link ConditionalCheckFailed} if the item doesn't exist.
   * Returns a fluent {@link BoundUpdate}.
   *
   * ```ts
   * yield* db.entities.Tasks.patch({ id }).set(updates)
   * ```
   */
  readonly patch: (
    key: TKey,
  ) => import("./internal/BoundCrud.js").BoundUpdate<
    ModelType<TModel>,
    ModelType<TModel>,
    EntityRefUpdateType<TModel, TIndexes, TRefs, TTimestamps, TVersioned>,
    | DynamoClientError
    | TransactionOverflow
    | ItemNotFound
    | OptimisticLockError
    | ConcurrentModification
    | UpdateAppliedButUnreadable
    | UniqueConstraintViolation
    | ValidationError
    | ConditionalCheckFailed
    | RefErrors<TRefs>
    | VectorErrors<TVectorIndexes>,
    VectorIndexNames<TVectorIndexes>,
    TPackedFields,
    RemovableFields<TModel, TIndexes, TRefs, TTimestamps, TVersioned, TUnremovable>
  >

  /** Delete an existing item, fails if not found. Returns a fluent {@link BoundDelete}. */
  readonly deleteIfExists: (
    key: TKey,
  ) => import("./internal/BoundCrud.js").BoundDelete<
    ModelType<TModel>,
    | DynamoClientError
    | TransactionOverflow
    | ItemNotFound
    | OptimisticLockError
    | ConcurrentModification
    | ValidationError
    | DeleteAppliedButUnreadable
    | ConditionalCheckFailed,
    void,
    TPackedFields
  >

  // --- Lifecycle Operations ---

  /** Fetch a specific version snapshot by version number. */
  readonly getVersion: (
    key: TKey,
    version: number,
  ) => Effect.Effect<ModelType<TModel>, ItemNotFound | DynamoClientError | ValidationError, never>

  /**
   * List all version snapshots for an item as a fluent BoundQuery.
   * Requires `versioned: { retain: true }` on the entity definition.
   *
   * ```ts
   * const all = yield* db.entities.Users.versions({ userId: "u-1" }).collect()
   * const last5 = yield* db.entities.Users
   *   .versions({ userId: "u-1" })
   *   .reverse()
   *   .limit(5)
   *   .collect()
   * ```
   */
  readonly versions: (
    key: TKey,
  ) => import("./internal/BoundQuery.js").BoundQuery<
    PathModel<ModelType<TModel>, TPackedFields>,
    never,
    ModelType<TModel>
  >

  /** Restore a soft-deleted item. */
  readonly restore: (
    key: TKey,
  ) => Effect.Effect<
    ModelType<TModel>,
    | ItemNotFound
    | ItemNotDeleted
    | DynamoClientError
    | TransactionOverflow
    | ValidationError
    | UniqueConstraintViolation
    | ConcurrentModification,
    never
  >

  /**
   * Permanently remove an item plus all version history and sentinels. Deletes
   * in `BatchWriteItem` chunks of 25, retrying `UnprocessedItems` with
   * backoff; not atomic, so a failure says exactly how many items it had
   * already deleted.
   */
  readonly purge: (key: TKey) => Effect.Effect<void, DynamoClientError | ValidationError, never>

  /** Soft-deleted item accessors. */
  readonly deleted: {
    /** Get a specific soft-deleted item. */
    readonly get: (
      key: TKey,
    ) => Effect.Effect<ModelType<TModel>, ItemNotFound | DynamoClientError | ValidationError, never>
    /**
     * List all soft-deleted items in this partition as a fluent BoundQuery.
     * Requires `softDelete` on the entity definition.
     *
     * ```ts
     * const tombstones = yield* db.entities.Employees.deleted
     *   .list({ employeeId: "e-1" })
     *   .collect()
     * ```
     */
    readonly list: (
      key: TKey,
    ) => import("./internal/BoundQuery.js").BoundQuery<
      PathModel<ModelType<TModel>, TPackedFields>,
      never,
      ModelType<TModel>
    >
  }

  // --- Time-series Operations (only when `timeSeries` is configured) ---

  /**
   * Append an event to a time-series entity. Atomically updates the "current"
   * item (scoped SET on `appendInput` fields only + CAS on `orderBy`) and
   * writes an immutable event item under the same partition.
   *
   * Returns a fluent {@link BoundAppend} — yield to execute, or chain
   * `.condition(...)` and/or `.skipFollowUp()`.
   *
   * **Stale-as-error contract:** on CAS rejection the Effect fails with
   * {@link StaleAppend}; user-condition rejection (when CAS held) fails with
   * {@link ConditionalCheckFailed}. `.skipFollowUp()` collapses both into
   * `StaleAppend(current: Option.none())` because no follow-up GetItem
   * runs.
   *
   * ```ts
   * const { current } = yield* db.entities.Telemetry.append(input)
   * yield* db.entities.Telemetry.append(input).condition({ status: "active" })
   * yield* db.entities.Telemetry.append(input).skipFollowUp() // → void
   * ```
   *
   * Only available when the entity was built with `timeSeries: { ... }`.
   */
  readonly append: [TTimeSeries] extends [TimeSeriesConfig<infer TAI extends Schema.Top>]
    ? (
        input: AppendInputType<TAI>,
      ) => import("./internal/BoundCrud.js").BoundAppend<
        ModelType<TModel>,
        { readonly current: ModelType<TModel> },
        | DynamoClientError
        | ValidationError
        | StaleAppend
        | ConditionalCheckFailed
        | ConcurrentModification,
        DynamoClientError | ValidationError | StaleAppend | ConcurrentModification,
        TPackedFields,
        AppendRemovableFields<
          TModel,
          TIndexes,
          TRefs,
          TTimeSeries,
          TTimestamps,
          TVersioned,
          TUnremovable
        >
      >
    : never

  /**
   * Query the event history of a time-series entity partition. Returns a
   * {@link import("./internal/BoundQuery.js").BoundQuery} auto-scoped to event
   * items via `begins_with(<currentSk>#e#)`. `.where()` is typed to the
   * configured `orderBy` attribute only; `.filter()` works on any model
   * attribute.
   *
   * Only available when the entity was built with `timeSeries: { ... }`.
   */
  readonly history: [TTimeSeries] extends [TimeSeriesConfig<any>]
    ? (key: TKey) => import("./internal/BoundQuery.js").BoundQuery<
        PathModel<ModelType<TModel>, TPackedFields>,
        {
          readonly [K in NonNullable<TTimeSeries>["orderBy"] & string]: HistoryOrderByOperand<
            ModelType<TModel>,
            K
          >
        },
        ModelType<TModel>
      >
    : never

  // --- Query Execution ---

  /**
   * Execute a query and return a lazy Stream of items. Automatically paginates through all pages.
   * Accepts optional query combinators (e.g. `Query.limit(...)`, `Query.reverse`).
   *
   * ```ts
   * const stream = teams.paginate(Teams.query.byRole({ role: "admin" }), Query.limit(10))
   * ```
   */
  readonly paginate: <A>(
    query: Query.Query<A>,
    ...combinators: ReadonlyArray<(q: Query.Query<A>) => Query.Query<A>>
  ) => Stream.Stream<A, DynamoClientError | ValidationError, never>

  /**
   * Execute a query and collect all pages into a single array.
   * Accepts optional query combinators (e.g. `Query.limit(...)`, `Query.reverse`).
   *
   * ```ts
   * const items = yield* teams.collect(Teams.query.byRole({ role: "admin" }), Query.limit(10))
   * ```
   */
  readonly collect: <A>(
    query: Query.Query<A>,
    ...combinators: ReadonlyArray<(q: Query.Query<A>) => Query.Query<A>>
  ) => Effect.Effect<Array<A>, DynamoClientError | ValidationError, never>

  /**
   * Execute a single DynamoDB page and return a {@link Query.Page} with an opaque cursor.
   * Use `Query.startFrom(cursor)` to iterate through subsequent pages.
   * Accepts optional query combinators (e.g. `Query.limit(...)`, `Query.reverse`).
   *
   * ```ts
   * const page = yield* teams.fetch(Teams.query.byRole({ role: "admin" }), Query.limit(25))
   * // page.cursor: Option<string> — None on the last page
   * const next = yield* Effect.transposeOption(
   *   Option.map(page.cursor, (cursor) =>
   *     teams.fetch(Teams.query.byRole({ role: "admin" }), Query.limit(25), Query.startFrom(cursor)),
   *   ),
   * )
   * ```
   */
  readonly fetch: <A>(
    query: Query.Query<A>,
    ...combinators: ReadonlyArray<(q: Query.Query<A>) => Query.Query<A>>
  ) => Effect.Effect<Query.Page<A>, DynamoClientError | ValidationError, never>

  /**
   * Execute a single DynamoDB scan page and return a {@link Query.Page} with an opaque cursor.
   * Convenience for `fetch(Entity.scan(), ...)`. Use `Query.startFrom(cursor)` for subsequent pages.
   * Accepts optional query combinators (e.g. `Query.limit(...)`, `Query.filter(...)`).
   *
   * ```ts
   * const page = yield* teams.scanFetch(Query.limit(25))
   * const next = yield* Effect.transposeOption(
   *   Option.map(page.cursor, (cursor) => teams.scanFetch(Query.limit(25), Query.startFrom(cursor))),
   * )
   * ```
   */
  readonly scanFetch: (
    ...combinators: ReadonlyArray<
      (q: Query.Query<ModelType<TModel>>) => Query.Query<ModelType<TModel>>
    >
  ) => Effect.Effect<Query.Page<ModelType<TModel>>, DynamoClientError | ValidationError, never>
}

/**
 * Compile a condition that may be either an Expr ADT node or a ConditionInput object.
 * Routes both paths through the Expr ADT compiler for a single compilation backend.
 * Returns undefined if the condition is undefined.
 */
const compileCondition = (
  cond: Expr | ConditionInput | undefined,
  resolveDbNameFn?: (name: string) => string,
):
  | {
      expression: string
      names: globalThis.Record<string, string>
      values: globalThis.Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>
    }
  | undefined => {
  if (cond === undefined) return undefined
  const expr = isExpr(cond) ? cond : parseShorthand(cond)
  return compileExpr(expr, resolveDbNameFn)
}

/** Name a get- or delete-shaped op for consumed-capacity reports (its builder carries it). */
const namedOp = <Op extends { readonly _builder: object }>(op: Op, name: string): Op => {
  Capacity.nameBuilder(op._builder, name)
  return op
}

/** Attempts a guarded put makes before it reports a lost race (#133). */
const GUARDED_PUT_ATTEMPTS = 3

/**
 * @internal A delete's item was deleted between its read and its write, with
 * nothing asserted about it: read again, never reported (#133).
 */
class DeletedConcurrently extends Data.TaggedError("DeletedConcurrently")<{}> {}

/**
 * The `ConcurrentModification`s that report a sentinel release whose
 * reservation changed hands between the ownership read and the write (#133),
 * as opposed to a change of the item itself. Nothing was written, and the
 * write is still valid against a fresh read — so an `upsert` plans it again,
 * as a put does. Carried across the copies that fill in `current`.
 */
const releaseRaces = new WeakSet<ConcurrentModification>()
/** `next`, a copy of `previous`, marked as a release race if `previous` was. */
const keepReleaseRace = (
  previous: ConcurrentModification,
  next: ConcurrentModification,
): ConcurrentModification => {
  if (releaseRaces.has(previous)) releaseRaces.add(next)
  return next
}

/** @internal One positional reason of a cancelled (or conditional) write. */
export interface WriteCancellationReason {
  readonly Code?: string | undefined
  readonly Item?: Readonly<globalThis.Record<string, unknown>> | undefined
}

/** @internal What a cancelled guarded put means (#133) — see `planPut`. */
export type PutVerdict =
  | {
      /** A lost race: plan the put again from a fresh read. */
      readonly _tag: "Retry"
      readonly stored: globalThis.Record<string, AttributeValue> | undefined
      /** Reported when every attempt loses. */
      readonly error: OptimisticLockError | ConcurrentModification
    }
  /** The caller's own condition rejected it (or `create` found the item). */
  | { readonly _tag: "Condition" }
  | {
      readonly _tag: "Fail"
      readonly error: UniqueConstraintViolation | ValidationError
    }

/**
 * @internal A guarded put — of a versioned or unique-constrained entity —
 * compiled against the item as read (#133): the items to write (the main Put
 * first), the item written, and how to read a cancellation of them.
 */
export interface PutPlan {
  readonly items: ReadonlyArray<TransactWriteItem>
  readonly item: globalThis.Record<string, unknown>
  readonly marshalled: globalThis.Record<string, AttributeValue>
  /** `reasons` positional with `items`; `undefined` when none of them failed. */
  readonly verdict: (
    reasons: ReadonlyArray<WriteCancellationReason | undefined>,
  ) => PutVerdict | undefined
}

// ---------------------------------------------------------------------------
// Entity.make()
// ---------------------------------------------------------------------------

/**
 * Create a new Entity — binding a domain model to a Table with index definitions
 * and optional system field configuration.
 *
 * @param config - Entity configuration
 * @param config.model - Effect Schema class or struct defining the domain model
 * @param config.entityType - Literal string discriminator stored as `__edd_e__`
 * @param config.indexes - ElectroDB-style composite key definitions (must include `primary`)
 * @param config.timestamps - Automatic `createdAt` / `updatedAt` fields
 * @param config.versioned - Optimistic locking via auto-incrementing version field
 * @param config.softDelete - Soft-delete behavior
 * @param config.unique - Named unique constraints enforced via transaction sentinels
 * @returns An {@link Entity} with typed CRUD operations and index query accessors
 *
 * @example
 * ```typescript
 * const Users = Entity.make({
 *   model: User,
 *   table: MainTable,
 *   entityType: "User",
 *   indexes: {
 *     primary: { pk: { field: "pk", composite: ["userId"] }, sk: { field: "sk", composite: [] } },
 *     byEmail: { index: "gsi1", pk: { field: "gsi1pk", composite: ["email"] }, sk: { field: "gsi1sk", composite: [] } },
 *   },
 *   timestamps: true,
 *   versioned: true,
 * })
 * ```
 */
/**
 * Create an Entity definition.
 *
 * `primaryKey` defines the table's primary key. `indexes` optionally defines GSI
 * access patterns. GSIs with a `collection` property are auto-discovered as
 * cross-entity collections by `DynamoClient.make()`.
 *
 * @example
 * ```typescript
 * const Tasks = Entity.make({
 *   model: Task,
 *   entityType: "Task",
 *   primaryKey: {
 *     pk: { field: "pk", composite: ["taskId"] },
 *     sk: { field: "sk", composite: [] },
 *   },
 *   indexes: {
 *     byProject: {
 *       name: "gsi1",
 *       pk: { field: "gsi1pk", composite: ["projectId"] },
 *       sk: { field: "gsi1sk", composite: ["status"] },
 *     },
 *     assigned: {
 *       collection: "assignments",
 *       name: "gsi2",
 *       pk: { field: "gsi2pk", composite: ["employee"] },
 *       sk: { field: "gsi2sk", composite: ["project"] },
 *     },
 *   },
 * })
 * ```
 */
export const make = <
  TModel extends Schema.Top,
  const TEntityType extends string,
  const TRefs extends EntityRefsConfig<TModel> | undefined,
  const TPrimaryKey extends EntityPrimaryKeyConfig<TModel, RefsOrNone<TRefs>>,
  const TGsiIndexes extends EntityIndexesConfig<TModel, RefsOrNone<TRefs>> = {},
  const TTimestamps extends TimestampsConfig | undefined = undefined,
  const TVersioned extends VersionedConfig | undefined = undefined,
  const TSoftDelete extends SoftDeleteConfig | undefined = undefined,
  const TUnique extends EntityUniqueConfig<TModel> | undefined = undefined,
  const TTimeSeries extends EntityTimeSeriesConfig<TModel> | undefined = undefined,
  const TGeneratedId extends EntityGeneratedIdConfig<TModel> | undefined = undefined,
  const TVectorIndexes extends EntityVectorIndexesConfig<TModel> | undefined = undefined,
  const TAttrs extends {} = {},
>(config: {
  readonly model: TModel | ConfiguredModel<TModel, TAttrs>
  readonly entityType: TEntityType
  readonly primaryKey: TPrimaryKey
  readonly indexes?: TGsiIndexes &
    EntityIndexesGuard<TModel, TRefs, TGsiIndexes, TPrimaryKey, TVersioned>
  readonly timestamps?: TTimestamps
  readonly versioned?: TVersioned
  readonly softDelete?: TSoftDelete
  readonly unique?: TUnique
  readonly refs?: TRefs & RefsKeyGuard<TModel, TRefs>
  readonly timeSeries?: TTimeSeries &
    AppendInputFields<TModel, TTimeSeries> &
    AppendShardGuard<TGsiIndexes, TTimeSeries>
  readonly generatedId?: TGeneratedId
  readonly vectorIndexes?: TVectorIndexes
}): Entity<
  TModel,
  TEntityType,
  NormalizedIndexes<TPrimaryKey, TGsiIndexes>,
  TTimestamps,
  TVersioned,
  TSoftDelete,
  TUnique,
  RefsOrNone<TRefs>,
  ExtractIdentifier<ConfiguredModel<TModel, TAttrs>>,
  TTimeSeries,
  TGeneratedId,
  TVectorIndexes,
  ExtractPackedFields<ConfiguredModel<TModel, TAttrs>>,
  ExtractUnremovableFields<ConfiguredModel<TModel, TAttrs>>
> => {
  // Normalize GSI configs to internal IndexDefinition format
  const gsiIndexes: globalThis.Record<string, IndexDefinition> = {}
  if (config.indexes) {
    for (const [name, gsi] of Object.entries(config.indexes)) {
      gsiIndexes[name] = normalizeGsiConfig(gsi as unknown as GsiConfig)
    }
  }

  const indexes = { primary: config.primaryKey, ...gsiIndexes } as any
  // Delegate to the internal implementation with normalized indexes
  return makeImpl({ ...config, indexes }) as any
}

/**
 * @internal Resolved ref metadata + the operational target entity. Mirrors the
 * pure-side `ResolvedRef` but types `refEntity` as the runtime {@link Entity}, so
 * write-time hydration can call its CRUD operations.
 */
interface ResolvedRef {
  readonly fieldName: string
  readonly idFieldName: string
  readonly identifierField: string
  readonly identifierSchema: Schema.Top
  readonly refEntity: Entity
  readonly refEntityType: string
}

/** @internal A definition that has had its operations attached (has `.get`). */
const isOperational = (e: { readonly get?: unknown }): boolean => typeof e.get === "function"

/** @internal Copy the schema + table tag a definition received via `_configure`
 * (Table.make injects them at table-definition time) onto a promoted entity. */
const carryConfigure = (from: EntityDefinition, to: Entity): void => {
  if (from._schema !== undefined && from._tableTag !== undefined) {
    to._configure(
      from._schema,
      from._tableTag as import("effect").Context.Service<TableConfig, TableConfig>,
    )
  }
}

/**
 * Promote a pure `@effect-dynamodb/schema` {@link EntityDefinition} into a full
 * operational runtime {@link Entity}, attaching CRUD/query operations. The
 * already-derived data bundle (`def._data`) is reused, so this is a thin
 * op-attach — no re-validation or re-derivation. The table binding the pure
 * definition already received (via `Table.make`) is preserved.
 *
 * **Ref targets are promoted too.** Write-time ref hydration calls `.get()` on
 * each ref target (to denormalise it), so a pure ref target must be operational
 * or the write crashes with `ref.refEntity.get is not a function`. Each ref
 * target is promoted one level: `.get` (a read) does not itself hydrate refs, so
 * the target's *own* ref targets need not be promoted — which also sidesteps
 * cyclic refs (A→B→A) without recursion. An entity that is itself bound and
 * written goes through `fromDefinition` independently and gets its own refs
 * promoted.
 *
 * Used by `DynamoClient.make()` to bind pure definitions; idempotent on an
 * entity that is already operational.
 *
 * @internal
 */
export const fromDefinition = (def: EntityDefinition): Entity => {
  const resolvedRefs = def._data.resolvedRefs
  // Replace any pure ref target with an operational one so hydration's `.get`
  // works. Already-operational targets (runtime-authored, or mixed refs once the
  // shared AnyRefValue lands) pass through unchanged.
  // Cast: a promoted ref target is a runtime `Entity`, not the pure
  // `EntityDefinition` that `EntityDefinitionData.resolvedRefs` is typed against.
  // Hydration only reads `.model`/`.entityType`/`.get` off it (the latter via the
  // runtime `ResolvedRef` cast inside makeImpl), so this is sound.
  const data =
    resolvedRefs.length > 0
      ? ({
          ...def._data,
          resolvedRefs: resolvedRefs.map((r) =>
            isOperational(r.refEntity as { readonly get?: unknown })
              ? r
              : { ...r, refEntity: promoteRefTarget(r.refEntity as unknown as EntityDefinition) },
          ),
        } as unknown as EntityDefinitionData)
      : def._data

  const runtime = makeImpl(
    def._config as unknown as Parameters<typeof makeImpl>[0],
    data,
  ) as unknown as Entity
  carryConfigure(def, runtime)
  return runtime
}

/** @internal Promote a ref target to an operational entity WITHOUT promoting its
 * own ref targets (one level — see {@link fromDefinition}). The target's table
 * binding is carried over so `.get` can compose keys. */
const promoteRefTarget = (def: EntityDefinition): Entity => {
  const runtime = makeImpl(
    def._config as unknown as Parameters<typeof makeImpl>[0],
    def._data,
  ) as unknown as Entity
  carryConfigure(def, runtime)
  return runtime
}

const makeImpl = <
  TModel extends Schema.Top,
  const TEntityType extends string,
  const TIndexes extends globalThis.Record<string, IndexDefinition> & {
    readonly primary: IndexDefinition &
      (
        | { readonly pk: { readonly composite: readonly [string, ...string[]] } }
        | { readonly sk: { readonly composite: readonly [string, ...string[]] } }
      )
  },
  const TTimestamps extends TimestampsConfig | undefined = undefined,
  const TVersioned extends VersionedConfig | undefined = undefined,
  const TSoftDelete extends SoftDeleteConfig | undefined = undefined,
  const TUnique extends UniqueConfig | undefined = undefined,
  const TRefs extends globalThis.Record<string, AnyRefValue> | undefined = undefined,
  const TTimeSeries extends TimeSeriesConfig<any> | undefined = undefined,
  const TGeneratedId extends GeneratedIdConfig | undefined = undefined,
  const TVectorIndexes extends
    | globalThis.Record<string, VectorIndexConfig<any>>
    | undefined = undefined,
  const TAttrs extends {} = {},
>(
  config: {
    readonly model: TModel | ConfiguredModel<TModel, TAttrs>
    readonly entityType: TEntityType
    readonly indexes: typeof undefined extends never ? never : TIndexes
    readonly timestamps?: TTimestamps
    readonly versioned?: TVersioned
    readonly softDelete?: TSoftDelete
    readonly unique?: TUnique
    readonly refs?: TRefs
    readonly timeSeries?: TTimeSeries
    readonly generatedId?: TGeneratedId
    readonly vectorIndexes?: TVectorIndexes
  },
  precomputedData?: EntityDefinitionData,
): Entity<
  TModel,
  TEntityType,
  TIndexes,
  TTimestamps,
  TVersioned,
  TSoftDelete,
  TUnique,
  TRefs,
  ExtractIdentifier<ConfiguredModel<TModel, TAttrs>>,
  TTimeSeries,
  TGeneratedId,
  TVectorIndexes,
  ExtractPackedFields<ConfiguredModel<TModel, TAttrs>>,
  ExtractUnremovableFields<ConfiguredModel<TModel, TAttrs>>
> => {
  // Derivation (validation + schema/ref/sparse/rename resolution) is shared with
  // the pure `@effect-dynamodb/schema` Entity.make via `buildEntityDefinition`,
  // giving a single source of truth for the EDD-90xx rules. Promotion of a pure
  // definition (see `fromDefinition`) passes the already-computed bundle as
  // `precomputedData`, so derivation runs exactly once per entity.
  // Cast: the runtime config's `refs` uses the runtime `AnyRefValue` (whose
  // `entity` is the operational `Entity`), which is nominally distinct from the
  // schema package's `AnyRefValue` (`entity: EntityDefinition`). buildEntityDefinition
  // only reads `.model`/`.entityType`/identifier off ref targets, both of which
  // the runtime Entity carries, so the cast is sound.
  const data = precomputedData ?? buildEntityDefinition(config as unknown as EntityDefinitionConfig)
  const {
    systemFields,
    schemas,
    hasRefs,
    immutableFields,
    resolvedIdentifier,
    generatedIdField,
    generatedIdVersion,
    entityType,
    entityVersion,
    sparseFields,
    hasSparseFields,
    renameToDynamo,
    renameFromDynamo,
    resolveDbName,
    rawModel,
    isSchemaClass,
    hasHiddenFields,
  } = data
  /** Which stored attributes are this entity's sparse map entries, as a row's reader takes them. */
  const sparseEntries = sparseReader(sparseFields)
  // Encoders for path-addressed update values (`pathSet`, `pathAppend`, …) and
  // record-based `append`, which bypass the update schema (#133).
  const pathValues = makePathValueEncoder(
    data.modelFields,
    (
      schemas.writeModelSchema as unknown as {
        readonly fields: globalThis.Record<string, Schema.Top>
      }
    ).fields,
    // A `DynamoModel.ref` field's own schema is opaque; paths under it follow
    // the model it is denormalised from.
    Object.fromEntries(
      (
        data.resolvedRefs as ReadonlyArray<{
          readonly fieldName: string
          readonly refEntity?: { readonly model?: unknown }
        }>
      )
        .filter((ref) => ref.refEntity?.model !== undefined)
        .map((ref) => {
          const model = ref.refEntity!.model as Schema.Top
          return [
            ref.fieldName,
            isConfiguredModel(model) ? (model.model as Schema.Top) : model,
          ] as const
        }),
    ),
  )
  /**
   * Encode a path-addressed update value and check it against the write schema
   * at its path — container checks included (#133). `undefined` issue = valid.
   */
  const encodePathValue = (
    segments: ReadonlyArray<string | number>,
    value: unknown,
    kind: "value" | "elements",
  ): { readonly encoded: unknown; readonly issue: unknown } => {
    if (kind === "value") {
      const encoded = pathValues.value(segments, value)
      return { encoded, issue: pathValues.validate(segments, encoded) }
    }
    const encoded = pathValues.elements(segments, value)
    return { encoded, issue: pathValues.validateElements(segments, encoded) }
  }
  /**
   * A `pathSet` or `pathSubtract` that names another attribute in place of a value: it has no
   * operand of its own. The other path operations always write their `value`, whatever else the
   * operation object holds.
   */
  const isCopy = (op: {
    readonly isPath?: boolean
    readonly valueSegments?: ReadonlyArray<string | number> | undefined
  }): boolean => Boolean(op.isPath && op.valueSegments)
  const hasPathOps = (uState: UpdateState): boolean =>
    [
      uState.pathSets,
      uState.pathRemoves,
      uState.pathAdds,
      uState.pathSubtracts,
      uState.pathAppends,
      uState.pathPrepends,
      uState.pathIfNotExists,
      uState.pathDeletes,
    ].some((ops) => ops !== undefined && ops.length > 0)

  // resolvedRefs carries the actual ref-target entity objects; at runtime they
  // are operational Entities (for runtime-authored refs) so write-time hydration
  // can call their CRUD ops. The pure bundle widens refEntity to EntityDefinition.
  const resolvedRefs = data.resolvedRefs as unknown as ReadonlyArray<ResolvedRef>
  // allIndexes is mutable: _injectIndex adds collection-owned GSIs after make().
  let allIndexes: globalThis.Record<string, IndexDefinition> = { ...data.initialIndexes }

  /** Composites of the secondary indexes (`allIndexes` grows after make()). */
  const indexCompositeFields = (): ReadonlySet<string> =>
    new Set(
      Object.entries(allIndexes)
        .filter(([name]) => name !== "primary")
        .flatMap(([, def]) => [...def.pk.composite, ...def.sk.composite]),
    )

  /**
   * Does `field` name a primary-key composite, by its model name or by the attribute
   * it's stored in? `.remove()` and `pathRemove()` take any string and write to either.
   */
  const isPrimaryComposite = (field: string): boolean => {
    const primary = allIndexes.primary
    return (
      primary !== undefined &&
      [...primary.pk.composite, ...primary.sk.composite].some(
        (attr) => attr === field || resolveDbName(attr) === field,
      )
    )
  }

  /**
   * Does `field` name an attribute of the table's primary key? The library never sets one
   * (`EDD-9109` refuses a model attribute stored there), and `.remove()` and `pathRemove()`
   * take any string. DynamoDB refuses such an update, so it is refused first, by name.
   */
  const isTableKeyAttribute = (field: string): boolean => {
    const primary = allIndexes.primary
    return primary !== undefined && (field === primary.pk.field || field === primary.sk.field)
  }
  const TABLE_KEY_ATTRIBUTE = "an attribute of the table's primary key"

  /**
   * Why `field` feeds a key or a unique sentinel — values the library derives
   * from the field at write time — or `undefined` when it feeds neither.
   */
  const derivedFrom = (field: string): string | undefined => {
    if (isTableKeyAttribute(field)) return TABLE_KEY_ATTRIBUTE
    if (isPrimaryComposite(field)) return "a primary-key composite"
    for (const [name, def] of Object.entries(allIndexes)) {
      if (name === "primary") continue
      if (def.pk.composite.includes(field) || def.sk.composite.includes(field)) {
        return `a composite of index "${name}"`
      }
    }
    for (const [name, def] of Object.entries(
      (config.unique ?? {}) as globalThis.Record<string, UniqueConstraintDef>,
    )) {
      if (resolveUniqueFields(def).includes(field)) return `a field of unique constraint "${name}"`
    }
    return undefined
  }

  /**
   * Path operations on a field that feeds a key or a unique sentinel (#133).
   *
   * DynamoDB evaluates a path operation, so compiling one on such a field would
   * change the attribute while its index keys and sentinel stay as they were.
   * A top-level `pathSet` of a value / `pathRemove` IS `.set()` / `.remove()`
   * of that field, and `pathAdd` / `pathSubtract` of a number IS `.add()` /
   * `.subtract()`: they are rewritten into those record operations, which go
   * through the key composer and the sentinel rotation. Anything whose result
   * only DynamoDB knows (a copy from another attribute, `if_not_exists`, list
   * and set operations) is refused, as is a path below such a field, a
   * primary-key composite (it identifies the item), an immutable field, and a
   * field targeted twice. Returns the rewritten state or the refusal.
   */
  const normalizeDerivedPathOps = (uState: UpdateState): UpdateState | string => {
    if (!hasPathOps(uState)) return uState
    const updates: globalThis.Record<string, unknown> = {
      ...((uState.updates as globalThis.Record<string, unknown> | undefined) ?? {}),
    }
    const remove = [...(uState.remove ?? [])]
    const add: globalThis.Record<string, AddOperand> = { ...uState.add }
    const subtract: globalThis.Record<string, number> = { ...uState.subtract }
    const targeted = new Set<string>([
      ...Object.keys(updates),
      ...remove,
      ...Object.keys(add),
      ...Object.keys(subtract),
      ...Object.keys(uState.append ?? {}),
      ...Object.keys(uState.deleteFromSet ?? {}),
    ])
    let refusal: string | undefined
    let rewritten = false
    const shown = (segments: ReadonlyArray<string | number>) =>
      JSON.stringify(
        segments.map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? s : `.${s}`)).join(""),
      )
    // The field a path operation addresses when it feeds a key or sentinel,
    // "free" when it feeds neither, or "refused" (recorded) for the shapes
    // that can never be rewritten.
    const claim = (
      op: string,
      segments: ReadonlyArray<string | number>,
    ): { readonly field: string; readonly reason: string } | "free" | "refused" => {
      const first = segments[0]
      if (typeof first !== "string") return "free"
      const head: string = first
      const reason = derivedFrom(head)
      if (reason === undefined) return "free"
      if (segments.length > 1) {
        refusal ??=
          `${op} on ${shown(segments)}: "${head}" is ${reason}, so a path below it cannot be ` +
          `updated. Write the whole value with .set({ ${head} }).`
      } else if (reason === "a primary-key composite" || reason === TABLE_KEY_ATTRIBUTE) {
        refusal ??=
          `${op} on "${head}": "${head}" is ${reason} — it identifies the item ` +
          "and cannot be changed by an update."
      } else if (immutableFields.has(head)) {
        refusal ??= `${op} on "${head}": "${head}" is immutable and cannot be changed by an update.`
      } else if (targeted.has(head)) {
        refusal ??=
          `${op} on "${head}": "${head}" is ${reason} and is already targeted by another ` +
          "operation in this update. Give it one operation."
      } else {
        targeted.add(head)
        return { field: head, reason }
      }
      return "refused"
    }
    const serverSide = (op: string, field: string, reason: string) => {
      refusal ??=
        `${op} on "${field}": "${field}" is ${reason}. DynamoDB computes this operation's ` +
        `result at write time, so the key or sentinel derived from "${field}" could not be ` +
        `recomposed to match. Read the item and write the new value with .set({ ${field} }).`
    }
    const keep = <Op>(
      ops: ReadonlyArray<Op> | undefined,
      segmentsOf: (op: Op) => ReadonlyArray<string | number>,
      name: string,
      rewrite: (op: Op, field: string, reason: string) => void,
    ): ReadonlyArray<Op> | undefined => {
      if (ops === undefined) return undefined
      const kept: Array<Op> = []
      for (const op of ops) {
        const claimed = claim(name, segmentsOf(op))
        if (claimed === "free") kept.push(op)
        if (typeof claimed === "string") continue
        rewritten = true
        rewrite(op, claimed.field, claimed.reason)
      }
      return kept
    }
    const pathSets = keep(
      uState.pathSets,
      (op) => op.segments,
      "pathSet",
      (op, field, reason) => {
        if (op.isPath) serverSide("pathSet (a copy of another attribute)", field, reason)
        else updates[field] = op.value
      },
    )
    const pathRemoves = keep(
      uState.pathRemoves,
      (segments) => segments,
      "pathRemove",
      (_, field) => {
        remove.push(field)
      },
    )
    const pathAdds = keep(
      uState.pathAdds,
      (op) => op.segments,
      "pathAdd",
      (op, field, reason) => {
        if (typeof op.value === "number") add[field] = op.value
        else serverSide("pathAdd (to a set)", field, reason)
      },
    )
    const pathSubtracts = keep(
      uState.pathSubtracts,
      (op) => op.segments,
      "pathSubtract",
      (op, field, reason) => {
        if (!op.isPath && typeof op.value === "number") subtract[field] = op.value
        else serverSide("pathSubtract (of another attribute)", field, reason)
      },
    )
    const refuseAll =
      (name: string) =>
      (_: unknown, field: string, reason: string): void =>
        serverSide(name, field, reason)
    const pathAppends = keep(
      uState.pathAppends,
      (op) => op.segments,
      "pathAppend",
      refuseAll("pathAppend"),
    )
    const pathPrepends = keep(
      uState.pathPrepends,
      (op) => op.segments,
      "pathPrepend",
      refuseAll("pathPrepend"),
    )
    const pathIfNotExists = keep(
      uState.pathIfNotExists,
      (op) => op.segments,
      "pathIfNotExists",
      refuseAll("pathIfNotExists"),
    )
    const pathDeletes = keep(
      uState.pathDeletes,
      (op) => op.segments,
      "pathDelete",
      refuseAll("pathDelete"),
    )
    if (refusal !== undefined) return refusal
    if (!rewritten) return uState
    return {
      ...uState,
      updates: Object.keys(updates).length > 0 ? updates : uState.updates,
      remove: remove.length > 0 ? remove : uState.remove,
      add: Object.keys(add).length > 0 ? add : uState.add,
      subtract: Object.keys(subtract).length > 0 ? subtract : uState.subtract,
      pathSets,
      pathRemoves,
      pathAdds,
      pathSubtracts,
      pathAppends,
      pathPrepends,
      pathIfNotExists,
      pathDeletes,
    }
  }

  const primaryCompositeRefusal = (op: string, field: string): string =>
    `${op} of "${field}": "${field}" is ${
      isTableKeyAttribute(field) ? TABLE_KEY_ATTRIBUTE : "a primary-key composite"
    } — it identifies the item and cannot be changed by an update.`

  /**
   * A `.set()` of a primary-key composite with a value other than the key's
   * (#133): it identifies the item and cannot change. It was silently dropped;
   * the update types already exclude it. The key's own value is a no-op, so a
   * spread record keeps working.
   */
  const refusedRecordSet = (updates: unknown, key: unknown): string | undefined => {
    if (typeof updates !== "object" || updates === null) return undefined
    const record = updates as globalThis.Record<string, unknown>
    const keyRecord = (key ?? {}) as globalThis.Record<string, unknown>
    const primary = allIndexes.primary
    for (const field of primary ? [...primary.pk.composite, ...primary.sk.composite] : []) {
      if (record[field] === undefined || Equal.equals(record[field], keyRecord[field])) continue
      return primaryCompositeRefusal(".set()", field)
    }
    const named = Object.keys(record).find((field) => isTableKeyAttribute(field))
    return named === undefined ? undefined : primaryCompositeRefusal(".set()", named)
  }

  /** A record operation writing a primary-key composite or an attribute of the table's key. */
  const refusedRecordOperands = (uState: UpdateState): string | undefined => {
    const operands: ReadonlyArray<readonly [string, object | undefined]> = [
      [".add()", uState.add],
      [".subtract()", uState.subtract],
      [".append()", uState.append],
      [".deleteFromSet()", uState.deleteFromSet],
    ]
    for (const [op, record] of operands) {
      const named = Object.keys(record ?? {}).find(
        (field) => isTableKeyAttribute(field) || isPrimaryComposite(field),
      )
      if (named !== undefined) return primaryCompositeRefusal(op, named)
    }
    return undefined
  }

  const modelFieldSchemas = data.modelFields as globalThis.Record<string, Schema.Top>
  const isModelField = (name: string): boolean => Object.hasOwn(modelFieldSchemas, name)
  const modelFieldStoredIn = (attribute: string): string | undefined =>
    Object.keys(modelFieldSchemas).find((field) => resolveDbName(field) === attribute)
  const fieldOfAttribute = (attribute: string): string => modelFieldStoredIn(attribute) ?? attribute

  /**
   * The fields of an encoded payload to judge against what DynamoDB can store. A
   * packed field has its own form, and a `NaN` feeding a key is key composition's to
   * refuse first, with its own code (`refuseUncomposed` has the rest).
   */
  const fieldsToStore = (
    encoded: globalThis.Record<string, unknown>,
  ): globalThis.Record<string, unknown> => {
    const composites = indexCompositeFields()
    return Object.fromEntries(
      Object.entries(encoded).filter(
        ([field, value]) =>
          !(field in packedFields) &&
          !(Number.isNaN(value) && (composites.has(field) || isPrimaryComposite(field))),
      ),
    )
  }

  /** What in an encoded payload DynamoDB can't store, as `put` finds it when it marshals. */
  const unstorableOf = (encoded: globalThis.Record<string, unknown>): UnstorableValue | undefined =>
    unstorableIn(fieldsToStore(encoded))

  /** `inputSchema`'s fields of a key record, once per set of names (`unstorableKey`). */
  const keyRecordSchemas = new Map<string, Schema.Codec<any>>()

  /**
   * What DynamoDB can't store in a caller's DOMAIN key record, as `put` decides it: the record
   * encoded through `inputSchema`'s own fields as `put` encodes its input, then `unstorableOf`,
   * the check `put` runs on what it encoded. `undefined` when it stores; a value that doesn't
   * encode fails as `put` fails on it, with a `ValidationError`.
   */
  const unstorableKey = (
    record: globalThis.Record<string, unknown>,
  ): Effect.Effect<UnstorableValue | undefined, ValidationError> => {
    const names = Object.keys(record)
    const id = names.join("\u0000")
    let schema = keyRecordSchemas.get(id)
    if (schema === undefined) {
      const fields = getSchemaFields(schemas.inputSchema as unknown as Schema.Top) ?? {}
      schema = Schema.Struct(
        Object.fromEntries(
          names.map((name) => [name, Object.hasOwn(fields, name) ? fields[name]! : Schema.Unknown]),
        ) as never,
      ) as unknown as Schema.Codec<any>
      keyRecordSchemas.set(id, schema)
    }
    return encodeOrDecodeEncode(schema, record, entityType, "aggregate.create").pipe(
      Effect.map((encoded) => unstorableOf(encoded as globalThis.Record<string, unknown>)),
    )
  }

  /** Refuses a value DynamoDB can't store, for a path about to read or send something. */
  const refuseUnstorable = (
    encoded: unknown,
    operation: string,
  ): Effect.Effect<void, ValidationError> => {
    const unstorable = unstorableOf(encoded as globalThis.Record<string, unknown>)
    return unstorable === undefined
      ? Effect.void
      : Effect.fail(
          new ValidationError({
            entityType,
            operation,
            cause: `${unstorable.describe()} Nothing was sent.`,
          }),
        )
  }

  /**
   * For a path that has composed its keys: a `NaN` `fieldsToStore` left to key composition,
   * which didn't refuse it, because it fed a half that wasn't composed.
   */
  const refuseUncomposed = (
    encoded: unknown,
    operation: string,
  ): Effect.Effect<void, ValidationError> => {
    const fields = encoded as globalThis.Record<string, unknown>
    const left = Object.keys(fields).filter((field) => Number.isNaN(fields[field]))
    const unstorable = unstorableIn(Object.fromEntries(left.map((field) => [field, fields[field]])))
    return unstorable === undefined
      ? Effect.void
      : Effect.fail(
          new ValidationError({
            entityType,
            operation,
            cause: `${unstorable.describe()} Nothing was sent.`,
          }),
        )
  }

  /**
   * One write's answers on the model fields it leaves out of a row.
   *
   * Where nothing the model runs takes part, the field's schema answers. Where the model's
   * code does (a decoding default, a step that reads an absent key, a check or a
   * transformation on the value an absent attribute stands for), the absence is read as the
   * next read would read it, at most once per field for the write, and never before a write:
   * defining an entity runs none of it.
   */
  type Lacks = {
    /**
     * Whether a field's key is one a row may leave out. A `null` clears such a field. On a
     * field a row lacks only because absent is one of its values, a `NullOr` of a set, `null`
     * is a stored value of its own. A name the model doesn't know is not the model's to judge.
     */
    readonly omits: (field: string) => boolean
    /** What an absent attribute reads back as on this field, if that's one of its values. */
    readonly absentReading: (field: string) => AbsentReading | undefined
    /**
     * Whether a stored row can be without a model field and still be read. A ref is refused
     * before this is asked: its read schema needs the target, however the field is declared.
     */
    readonly canLack: (field: string) => boolean
  }

  const writeLacks = (): Lacks => {
    const omitted = new Map<string, boolean>()
    const absent = new Map<string, AbsentReading | undefined>()
    const omits = (field: string): boolean => {
      if (!isModelField(field)) return true
      const known = omitted.get(field)
      if (known !== undefined) return known
      const judged = rowOmits(modelFieldSchemas[field]!)
      omitted.set(field, judged)
      return judged
    }
    const reading = (field: string): AbsentReading | undefined => {
      if (!isModelField(field)) return undefined
      if (absent.has(field)) return absent.get(field)
      const judged = absentReading(modelFieldSchemas[field]!)
      absent.set(field, judged)
      return judged
    }
    return {
      omits,
      absentReading: reading,
      canLack: (field) => omits(field) || reading(field) !== undefined,
    }
  }

  /**
   * Why an update can't address `name` as a top-level attribute, or `undefined` when it
   * can: it's a model field an update may write, a primary-key composite (refused
   * separately, whichever way it's named), or an attribute the model doesn't know,
   * which stays allowed so an attribute a model no longer declares can be cleaned up.
   */
  const unaddressable = (name: string, ttlAttribute: string): string | undefined => {
    if (isTableKeyAttribute(name) || isPrimaryComposite(name)) return undefined
    if (
      name === systemFields.version ||
      name === systemFields.createdAt ||
      name === systemFields.updatedAt
    ) {
      return `"${name}" is managed by the library`
    }
    if (isModelField(name)) {
      if (immutableFields.has(name)) {
        return `"${name}" is immutable and cannot be changed by an update`
      }
      if (Object.hasOwn(sparseFields, name)) {
        return (
          `"${name}" is a sparse map, stored as one attribute per entry. ` +
          `Use .removeEntries("${name}", [...]) or .clearMap("${name}")`
        )
      }
      return undefined
    }
    if (name.startsWith("__edd_")) return `"${name}" is an attribute the library manages`
    const storedBy = modelFieldStoredIn(name)
    if (storedBy !== undefined) {
      return `"${name}" is the attribute "${storedBy}" is stored in. Name the model field: "${storedBy}"`
    }
    const refId = resolvedRefs.find((ref) => ref.idFieldName === name)
    if (refId !== undefined) {
      return (
        `"${name}" is the id of the ref "${refId.fieldName}", which a row stores whole as ` +
        `"${refId.fieldName}". Reassign it with .set({ ${name} })`
      )
    }
    for (const [index, def] of Object.entries(allIndexes)) {
      if (index !== "primary" && (name === def.pk.field || name === def.sk.field)) {
        return (
          `"${name}" is a key attribute of index "${index}", which the library composes. ` +
          `Remove the composite it's built from instead`
        )
      }
    }
    if (name === "deletedAt" && config.softDelete) return `"${name}" is managed by the library`
    if (writesTtl() && name === ttlAttribute) return `"${name}" is managed by the library`
    return undefined
  }

  /** An update naming, in any operation, a top-level attribute it can't address. */
  const refusedAttributeNames = (uState: UpdateState, ttlAttribute: string): string | undefined => {
    const heads = (
      ops: ReadonlyArray<{ readonly segments: ReadonlyArray<string | number> }> = [],
    ) => ops.flatMap(({ segments }) => (typeof segments[0] === "string" ? [segments[0]] : []))
    const named: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      [".remove()", uState.remove ?? []],
      [".add()", Object.keys(uState.add ?? {})],
      [".subtract()", Object.keys(uState.subtract ?? {})],
      [".append()", Object.keys(uState.append ?? {})],
      [".deleteFromSet()", Object.keys(uState.deleteFromSet ?? {})],
      ["pathSet", heads(uState.pathSets)],
      ["pathRemove", heads((uState.pathRemoves ?? []).map((segments) => ({ segments })))],
      ["pathAdd", heads(uState.pathAdds)],
      ["pathSubtract", heads(uState.pathSubtracts)],
      ["pathAppend", heads(uState.pathAppends)],
      ["pathPrepend", heads(uState.pathPrepends)],
      ["pathIfNotExists", heads(uState.pathIfNotExists)],
      ["pathDelete", heads(uState.pathDeletes)],
    ]
    for (const [op, names] of named) {
      for (const name of names) {
        const reason = unaddressable(name, ttlAttribute)
        if (reason !== undefined) return `${op} of "${name}": ${reason}. Nothing was sent.`
      }
    }
    // A sparse map's entries have an operation of their own to clear them. The other
    // path operations address an entry by its stored name, which is how a counter
    // entry is added to, so that name stays open to them.
    const clearedEntries: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      [".remove()", uState.remove ?? []],
      [
        "pathRemove",
        (uState.pathRemoves ?? []).flatMap((segments) =>
          segments.length === 1 && typeof segments[0] === "string" ? [segments[0]] : [],
        ),
      ],
    ]
    for (const [op, names] of clearedEntries) {
      for (const name of names) {
        // The attribute the operation removes decides: `.remove()` names a field, removed where
        // it's stored, and a path's segment holding `#` is the attribute's own name.
        const entry = sparseEntries.entryOf(op === ".remove()" ? resolveDbName(name) : name)
        if (entry === undefined) continue
        return (
          `${op} of "${name}": "${name}" is an entry of the sparse map "${entry.field}". ` +
          `Use .removeEntries("${entry.field}", ["${entry.key}"]). Nothing was sent.`
        )
      }
    }
    return undefined
  }

  /** Clearing a field no row can be without: the row would write, then not be readable. */
  const clearRefusal = (op: string, field: string, lacks: Lacks): string | undefined => {
    if (isPrimaryComposite(field) || isTableKeyAttribute(field)) {
      return primaryCompositeRefusal(op, field)
    }
    if (immutableFields.has(field) || field === systemFields.version) {
      return `${op} of "${field}": "${field}" cannot be changed by an update. Nothing was sent.`
    }
    if (field === systemFields.createdAt) {
      return `${op} of "${field}": "${field}" is managed by the library. Nothing was sent.`
    }
    const ref = resolvedRefs.find((r) => r.fieldName === field || r.idFieldName === field)
    if (ref !== undefined) {
      return (
        `${op} of "${field}": "${ref.fieldName}" is a ref, so a row without it could not be ` +
        `read. Reassign it with .set({ ${ref.idFieldName} }). Nothing was sent.`
      )
    }
    if (lacks.canLack(field)) return undefined
    return (
      `${op} of "${field}": the model requires "${field}", so a row without it could not be ` +
      `read. Make it optional in the model, or write a new value with .set({ ${field} }). ` +
      "Nothing was sent."
    )
  }

  /**
   * A `.set()` value that writes nothing at all, so it clears the field: `undefined`, or
   * what encodes to it or to an empty set. A schema refusing the value (a `.check()` for a
   * non-empty set) isn't a clear, and that schema goes on to refuse it.
   */
  const encodesToNothing = (field: string, value: unknown): boolean => {
    if (value === undefined) return !storesUndefined(field)
    if (modelFieldSchemas[field]?.ast.encoding === undefined && !isEmptySet(value)) return false
    const updateField = getSchemaFields(schemas.updateSchema as unknown as Schema.Top)?.[field]
    if (updateField === undefined) return false
    try {
      const encoded = Schema.encodeUnknownExit(
        Schema.Struct({ [field]: updateField }) as unknown as Schema.Codec<
          unknown,
          globalThis.Record<string, unknown>
        >,
      )({ [field]: value })
      return Exit.isSuccess(encoded) && hasNoStoredForm(encoded.value[field])
    } catch {
      return false
    }
  }

  /**
   * `.set({ field: undefined })` IS `.remove([field])`: one form, from here on, for
   * everything downstream (sentinel release, the composer's per-half gate and policy,
   * the vector gate, the retain snapshot, the transactional planner). Clearing a field
   * no row can be without is refused. Three names are not clears: a library-generated
   * `updatedAt` (`undefined` means generate it), a sparse map (`.set()` merges entries,
   * and no entries merge nothing), and a name the model doesn't know, which the
   * payload's schema drops as it drops any other unknown name.
   */
  const normalizeClears = (uState: UpdateState, lacks: Lacks): UpdateState | string => {
    if (typeof uState.updates !== "object" || uState.updates === null) return uState
    const record = uState.updates as globalThis.Record<string, unknown>
    const payload = { ...record }
    const remove = [...(uState.remove ?? [])]
    let cleared = false
    for (const field of Object.keys(record)) {
      const named = isModelField(field) || resolvedRefs.some((ref) => ref.idFieldName === field)
      if (!named || !encodesToNothing(field, record[field])) continue
      cleared = true
      delete payload[field]
      if (field === systemFields.updatedAt || Object.hasOwn(sparseFields, field)) continue
      const refused = clearRefusal(".set()", field, lacks)
      if (refused !== undefined) return refused
      if (!remove.includes(field)) remove.push(field)
    }
    return cleared ? { ...uState, updates: payload, remove } : uState
  }

  /**
   * Whether `undefined` is a value of this field that has a stored form, one a transform
   * writes as `"none"`. Setting it writes that, like any other value.
   */
  const storesUndefined = (field: string): boolean => {
    const schema = modelFieldSchemas[field]
    if (schema === undefined) return false
    try {
      const encoded = Schema.encodeUnknownExit(schema as unknown as Schema.Codec<unknown, unknown>)(
        undefined,
      )
      return Exit.isSuccess(encoded) && !hasNoStoredForm(encoded.value)
    } catch {
      return false
    }
  }

  /**
   * The other operations holding a value with no stored form, which DynamoDB refuses as
   * an operand. Adding or deleting nothing, or defaulting to nothing, is nothing to do. A
   * `pathSet` of one clears the path, as `.set()` clears a field. A list element is
   * refused: it can't be absent without moving the elements after it.
   */
  const normalizeNoStoredForm = (uState: UpdateState): UpdateState | string => {
    const keptValues = (record: object | undefined) =>
      record === undefined
        ? undefined
        : Object.fromEntries(Object.entries(record).filter(([, value]) => !hasNoStoredForm(value)))
    const keptOps = <O extends { readonly value: unknown }>(ops: ReadonlyArray<O> | undefined) =>
      ops?.filter((op) => !hasNoStoredForm(op.value))
    const pathRemoves = [...(uState.pathRemoves ?? [])]
    const pathSets: Array<NonNullable<UpdateState["pathSets"]>[number]> = []
    for (const op of uState.pathSets ?? []) {
      if (op.isPath || !hasNoStoredForm(op.value)) {
        pathSets.push(op)
        continue
      }
      if (typeof op.segments[op.segments.length - 1] === "number") {
        const path = op.segments.map((segment) => String(segment)).join(".")
        return (
          `pathSet on "${path}": DynamoDB can't store this value, and a list element can't be ` +
          "left out without moving the elements after it. Use pathRemove to remove the " +
          "element. [EDD-9124] Nothing was sent."
        )
      }
      pathRemoves.push(op.segments)
    }
    return {
      ...uState,
      add: keptValues(uState.add),
      deleteFromSet: keptValues(uState.deleteFromSet),
      pathAdds: keptOps(uState.pathAdds),
      pathDeletes: keptOps(uState.pathDeletes),
      pathIfNotExists: keptOps(uState.pathIfNotExists),
      pathSets: uState.pathSets === undefined ? undefined : pathSets,
      pathRemoves: pathRemoves.length === 0 ? uState.pathRemoves : pathRemoves,
    } as UpdateState
  }

  /**
   * The fields that can hold a value of a custom declaration, each with what checks one reads back.
   * Empty for a model with none, which pays nothing more on a write.
   */
  const readBacks: ReadonlyMap<string, ReadBack> = new Map(
    Object.entries(data.modelFields as globalThis.Record<string, Schema.Top>).flatMap(
      ([field, schema]) => {
        // What's packed doesn't go through the marshaller's map, and packing refuses an instance itself.
        const read =
          field in data.packedFields
            ? undefined
            : getSchemaFields(schemas.recordSchema as unknown as Schema.Top)?.[field]
        const readBack = read === undefined ? undefined : readBackOf(schema, () => read)
        return readBack === undefined ? [] : [[field, readBack] as const]
      },
    ),
  )

  /** Refuses a payload holding a value that wouldn't read back, before anything is read or sent. */
  const refuseNotReadBack = (
    encoded: unknown,
    operation: string,
  ): Effect.Effect<void, ValidationError> =>
    readBacks.size === 0
      ? Effect.void
      : Effect.forEach(
          [...readBacks].filter(
            ([field]) => (encoded as globalThis.Record<string, unknown>)[field] != null,
          ),
          ([field, readBack]) =>
            readBack((encoded as globalThis.Record<string, unknown>)[field]).pipe(
              Effect.mapError(
                (issue) =>
                  new ValidationError({
                    entityType,
                    operation,
                    cause: notReadBack(`Field "${field}"`, issue),
                  }),
              ),
            ),
          { discard: true },
        )

  /** What composes `field` into key text, in words, or `undefined` when nothing does. */
  const composedInto = (field: string): string | undefined => {
    for (const [name, def] of Object.entries(allIndexes)) {
      if (def.pk.composite.includes(field) || def.sk.composite.includes(field)) {
        return name === "primary" ? "the primary key" : `index "${name}"`
      }
    }
    for (const [name, def] of Object.entries(
      (config.unique ?? {}) as globalThis.Record<string, UniqueConstraintDef>,
    )) {
      if (resolveUniqueFields(def).includes(field)) return `unique constraint "${name}"`
    }
    for (const [name, def] of Object.entries(data.vectorIndexes)) {
      if (def.partition.includes(field)) return `vector index "${name}"'s partition`
    }
    const timeSeries = config.timeSeries as TimeSeriesConfig<any> | undefined
    return timeSeries?.orderBy === field ? "an event's sort key (timeSeries.orderBy)" : undefined
  }

  /** A composite value's text, as `KeyComposer` composes it; `undefined` when it composes none. */
  const compositeTextOf = (value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined
    try {
      return KeyComposer.compositeText(schema, value)
    } catch {
      return undefined
    }
  }

  /**
   * The texts a key composite's value is composed into, written and composed again from a row read
   * back, by what composes it: a key or a vector partition through the key form; a unique sentinel
   * from the value as stored (`storedSentinelValue`, `readSentinelValue`); and `append`'s event sort
   * key, with `escapeKeys` and `numericKeyText` off, from the value as given.
   */
  const readBackTexts = (field: string, append: boolean): ReadonlyArray<ReadBackText> => {
    const timeSeries = config.timeSeries as TimeSeriesConfig<any> | undefined
    const numericOrderBy = schema.escapeKeys === true || schema.numericKeyText === true
    const inKey =
      Object.values(allIndexes).some(
        (def) => def.pk.composite.includes(field) || def.sk.composite.includes(field),
      ) ||
      Object.values(data.vectorIndexes).some((def) => def.partition.includes(field)) ||
      (append && timeSeries?.orderBy === field && numericOrderBy)
    const inSentinel =
      !append &&
      Object.values((config.unique ?? {}) as globalThis.Record<string, UniqueConstraintDef>).some(
        (def) => resolveUniqueFields(def).includes(field),
      )
    const inEvent = append && timeSeries?.orderBy === field && !numericOrderBy
    const keyText = (value: unknown) => {
      try {
        return compositeTextOf(compositeKeyForm(field, value))
      } catch {
        return undefined
      }
    }
    const readText = (value: unknown) => compositeTextOf(readSentinelValue(field, value) ?? value)
    return [
      ...(inKey ? [{ written: keyText, read: keyText }] : []),
      ...(inSentinel
        ? [
            {
              written: (value: unknown) =>
                compositeTextOf(storedSentinelValue(field, value) ?? value),
              read: readText,
            },
          ]
        : []),
      ...(inEvent ? [{ written: compositeTextOf, read: readText }] : []),
    ]
  }

  /**
   * The key composites of `fields` (the model's, or `appendInput`'s for `append`) whose read-back
   * can't be guaranteed at load (`readBackUnsure`: a transformation, or numeric kinds that can't be
   * read off the schema), each with what composes it and the test of a stored value that reads back
   * otherwise (`readsBackOtherwise`): read back by the model's field, as every read and every key
   * composed again from a row reads it. A write giving one such a value is refused (`EDD-9128`). A
   * field no key composes isn't asked. Empty for a model with none, which pays nothing more on a
   * write.
   */
  const otherKindReadsOf = (
    fields: globalThis.Record<string, Schema.Top>,
    append: boolean,
  ): ReadonlyMap<
    string,
    { readonly into: string; readonly readsOther: (value: unknown) => string | undefined }
  > =>
    new Map(
      Object.entries(fields).flatMap(([field, schema]) => {
        const into = composedInto(field)
        if (into === undefined) return []
        const reading = modelFieldSchemas[field] ?? schema
        const readsOther = readsBackOtherwise(reading, {
          asRead,
          written: schema === reading ? undefined : schema,
          texts: readBackTexts(field, append),
        })
        return readsOther === undefined ? [] : [[field, { into, readsOther }] as const]
      }),
    )
  type KindReads = ReturnType<typeof otherKindReadsOf>
  /**
   * The model's and, for `append`, which takes its input through `appendInput`, `appendInput`'s own.
   * Worked out again when `_injectIndex` adds an index, whose composites it composes.
   */
  let kindReadsFor:
    | { readonly indexes: typeof allIndexes; readonly model: KindReads; readonly append: KindReads }
    | undefined
  const kindReads = (): { readonly model: KindReads; readonly append: KindReads } => {
    if (kindReadsFor?.indexes === allIndexes) return kindReadsFor
    const appendInput = (config.timeSeries as TimeSeriesConfig<any> | undefined)?.appendInput
    const appendFields =
      appendInput === undefined ? undefined : getSchemaFields(appendInput as Schema.Top)
    kindReadsFor = {
      indexes: allIndexes,
      model: otherKindReadsOf(data.modelFields as globalThis.Record<string, Schema.Top>, false),
      append: appendFields === undefined ? new Map() : otherKindReadsOf(appendFields, true),
    }
    return kindReadsFor
  }

  /**
   * Refuses a payload storing, for a key composite whose read-back can't be guaranteed at load, a
   * value that reads back otherwise: a stored row would compose other key text (`EDD-9128`).
   */
  const refuseOtherKindRead = (
    encoded: unknown,
    operation: string,
    reads: KindReads = kindReads().model,
  ): Effect.Effect<void, ValidationError> => {
    for (const [field, { into, readsOther }] of reads) {
      const value = (encoded as globalThis.Record<string, unknown>)[field]
      const readsAs = value == null ? undefined : readsOther(value)
      if (readsAs === undefined) continue
      return Effect.fail(
        new ValidationError({
          entityType,
          operation,
          cause: readBackRefusal(`Field "${field}" is composed into ${into}`, value, readsAs),
        }),
      )
    }
    return Effect.void
  }

  /**
   * A write's payload, encoded (see `encodeOrDecodeEncode`) and refused if it wouldn't read back.
   * Every write of the entity's own encodes through this.
   */
  const encodeForWrite = (
    schema: Schema.Codec<any>,
    input: unknown,
    operation: string,
  ): Effect.Effect<unknown, ValidationError> => {
    const encoded = encodeOrDecodeEncode(schema, input, entityType, operation)
    const readBack =
      readBacks.size === 0
        ? encoded
        : encoded.pipe(Effect.tap((value) => refuseNotReadBack(value, operation)))
    const reads = operation === "append" ? kindReads().append : kindReads().model
    return reads.size === 0
      ? readBack
      : readBack.pipe(Effect.tap((value) => refuseOtherKindRead(value, operation, reads)))
  }

  /**
   * An update's operand that wouldn't read back. An operand of `.add`, `.subtract` or `.deleteFromSet`
   * is a number or a set to apply, not a value of the field, so only what's stored as given counts.
   * `unstorableOperand` goes first, so each of these has already been through the marshaller.
   */
  const notReadBackOperand = (uState: UpdateState): string | undefined => {
    if (readBacks.size === 0) return undefined
    type Operand = {
      readonly segments: ReadonlyArray<string | number>
      readonly value: unknown
      readonly isPath?: boolean
      readonly valueSegments?: ReadonlyArray<string | number> | undefined
    }
    const operands: ReadonlyArray<
      readonly [string, ReadonlyArray<Operand> | undefined, "value" | "elements"]
    > = [
      [
        ".append() of",
        Object.entries(uState.append ?? {}).map(([field, value]) => ({
          segments: [field],
          value,
        })),
        "elements",
      ],
      ["pathSet of", uState.pathSets, "value"],
      ["pathAppend of", uState.pathAppends, "elements"],
      ["pathPrepend of", uState.pathPrepends, "elements"],
      ["pathIfNotExists of", uState.pathIfNotExists, "value"],
    ]
    for (const [op, ops, kind] of operands) {
      for (const operand of ops ?? []) {
        // A copy writes another attribute's value: it holds no value of its own to read back.
        if (op === "pathSet of" && isCopy(operand)) continue
        const { segments, value } = operand
        if (!readBacks.has(String(segments[0]))) continue
        const { encoded } = encodePathValue(segments, value, kind)
        const read = asRead(encoded)
        const issue =
          kind === "value"
            ? pathValues.validate(segments, read)
            : pathValues.validateElements(segments, read)
        if (issue !== undefined) return notReadBack(`${op} "${segments.join(".")}"`, issue)
      }
    }
    return undefined
  }

  /**
   * A value in an update that DynamoDB can't store, in words, before the update reads or
   * sends anything: an operand of any operation, in the form it would be written.
   */
  const unstorableOperand = (
    uState: UpdateState,
    encodedUpdates: globalThis.Record<string, unknown>,
  ): string | undefined => {
    const refused = (op: string, unstorable: UnstorableValue) =>
      `${op} ${unstorable.describe()} Nothing was sent.`
    const appended = Object.fromEntries(
      Object.entries(uState.append ?? {}).map(([field, value]) => [
        field,
        encodePathValue([field], value, "elements").encoded,
      ]),
    )
    const records: ReadonlyArray<readonly [string, globalThis.Record<string, unknown>]> = [
      [".set() of", fieldsToStore(encodedUpdates)],
      [".add() of", uState.add ?? {}],
      [".subtract() of", uState.subtract ?? {}],
      [".append() of", appended],
      [".deleteFromSet() of", uState.deleteFromSet ?? {}],
      [".withVector() of", uState.withVectors ?? {}],
    ]
    for (const [op, record] of records) {
      const unstorable = unstorableIn(record)
      if (unstorable !== undefined) return refused(op, unstorable)
    }
    type Operand = {
      readonly segments: ReadonlyArray<string | number>
      readonly value: unknown
      readonly isPath?: boolean
      readonly valueSegments?: ReadonlyArray<string | number> | undefined
    }
    const pathOps: ReadonlyArray<
      readonly [string, ReadonlyArray<Operand> | undefined, "value" | "elements" | undefined]
    > = [
      ["pathSet of", uState.pathSets, "value"],
      ["pathAdd of", uState.pathAdds, undefined],
      ["pathSubtract of", uState.pathSubtracts, undefined],
      ["pathAppend of", uState.pathAppends, "elements"],
      ["pathPrepend of", uState.pathPrepends, "elements"],
      ["pathIfNotExists of", uState.pathIfNotExists, "value"],
      ["pathDelete of", uState.pathDeletes, undefined],
    ]
    for (const [op, ops, kind] of pathOps) {
      for (const operand of ops ?? []) {
        // A copy, or a subtraction of another attribute's value, writes no value of its own.
        if ((op === "pathSet of" || op === "pathSubtract of") && isCopy(operand)) continue
        const value =
          kind === undefined
            ? operand.value
            : encodePathValue(operand.segments, operand.value, kind).encoded
        const unstorable = unstorableIn({ value })
        if (unstorable !== undefined) {
          return refused(
            op,
            new UnstorableValue({
              path: [...operand.segments, ...unstorable.path.slice(1)],
              reason: unstorable.reason,
            }),
          )
        }
      }
    }
    for (const [attribute, value] of Object.entries(uState.cascade?.filter ?? {})) {
      const unstorable = isEmptySet(value)
        ? new UnstorableValue({ path: [attribute], reason: "DynamoDB has no empty set." })
        : unstorableIn({ [attribute]: value })
      if (unstorable !== undefined) return refused(".cascade() filter on", unstorable)
    }
    return undefined
  }

  /**
   * An update's operands written as values of its fields — `.append()`'s entries and the values of
   * `pathSet` (a copy excepted), `pathAppend`, `pathPrepend` and `pathIfNotExists` — in the form
   * they're written, each checked against the write schema at its path. Decided once, before the
   * update reads or sends anything: the first one the schema refuses refuses the update, and the
   * write sends the rest as encoded here. Each path operation's value is at its operation's index.
   */
  const encodeOperands = (uState: UpdateState): EncodedOperands | RefusedOperand => {
    // Keyed by a name the caller supplies: no prototype, so `__proto__` is a key like any other.
    const append: globalThis.Record<string, unknown> = Object.create(null)
    for (const [field, value] of Object.entries(uState.append ?? {})) {
      const { encoded, issue } = encodePathValue([field], value, "elements")
      if (issue !== undefined) return { operation: "update.append", issue }
      append[field] = encoded
    }
    const each = (
      operation: string,
      ops:
        | ReadonlyArray<{
            readonly segments: ReadonlyArray<string | number>
            readonly value: unknown
            readonly isPath?: boolean
            readonly valueSegments?: ReadonlyArray<string | number> | undefined
          }>
        | undefined,
      kind: "value" | "elements",
      /** Whether the operation can copy another attribute's value: only `pathSet`. */
      copies = false,
    ): ReadonlyArray<unknown> | RefusedOperand => {
      const values: Array<unknown> = []
      for (const op of ops ?? []) {
        // A copy writes another attribute's value: there's nothing to encode.
        if (copies && isCopy(op)) {
          values.push(undefined)
          continue
        }
        const { encoded, issue } = encodePathValue(op.segments, op.value, kind)
        if (issue !== undefined) return { operation, issue }
        values.push(encoded)
      }
      return values
    }
    const pathSets = each("update.pathSet", uState.pathSets, "value", true)
    if ("issue" in pathSets) return pathSets
    const pathAppends = each("update.pathAppend", uState.pathAppends, "elements")
    if ("issue" in pathAppends) return pathAppends
    const pathPrepends = each("update.pathPrepend", uState.pathPrepends, "elements")
    if ("issue" in pathPrepends) return pathPrepends
    const pathIfNotExists = each("update.pathIfNotExists", uState.pathIfNotExists, "value")
    if ("issue" in pathIfNotExists) return pathIfNotExists
    return { append, pathSets, pathAppends, pathPrepends, pathIfNotExists }
  }

  /**
   * A `pathRemove` of a field no row can be without, or of a property below a field
   * whose schema requires it. Primary-key composites, and paths below a field that
   * feeds a key or a sentinel, get their refusal from `normalizeDerivedPathOps`.
   */
  const refusedPathRemove = (uState: UpdateState, lacks: Lacks): string | undefined => {
    for (const segments of uState.pathRemoves ?? []) {
      const head = segments[0]
      if (typeof head !== "string" || !isModelField(head)) continue
      if (segments.length === 1) {
        if (isPrimaryComposite(head)) continue
        const refused = clearRefusal("pathRemove", head, lacks)
        if (refused !== undefined) return refused
        continue
      }
      if (derivedFrom(head) !== undefined) continue
      if (pathIsRequired(modelFieldSchemas[head]!, segments.slice(1))) {
        const path = segments.map((s) => String(s)).join(".")
        return (
          `pathRemove on "${path}": the model requires it, so a row without it could not be ` +
          "read. Make it optional in the model, or write a new value with .pathSet(). " +
          "Nothing was sent."
        )
      }
    }
    return undefined
  }

  /**
   * A `.remove()` no row could survive. A primary-key composite: the row would keep its
   * key and lose the attribute, so it would stop decoding for every reader. Refused as a
   * `.set()` of one is, before a defaulted composite could turn it into one. A required
   * field, for the same reason.
   */
  const refusedRecordRemove = (
    fields: ReadonlyArray<string> | undefined,
    lacks: Lacks,
  ): string | undefined => {
    for (const field of fields ?? []) {
      const refused = clearRefusal(".remove()", field, lacks)
      if (refused !== undefined) return refused
    }
    return undefined
  }

  type AssertedImmutable = {
    readonly field: string
    readonly attr: string
    readonly value: AttributeValue
    /** The encoded (wire) value — what a packed field's stored JSON is compared with. */
    readonly wire: unknown
    /**
     * A packed field (#147): its stored bytes depend on the codec and threshold
     * in force when written, so it is compared by its unpacked JSON, after a
     * read — never by a condition on the stored value.
     */
    readonly packed: boolean
  }

  /**
   * The immutable fields a `.set()` names, in stored form (#133). An update may
   * restate an immutable field's value — a spread record does — but never
   * change it: each one is checked against the item (read, or a condition on
   * the write) and a different value is refused.
   */
  const assertedImmutables = (updates: unknown): ReadonlyArray<AssertedImmutable> | string => {
    if (typeof updates !== "object" || updates === null) return []
    const record = updates as globalThis.Record<string, unknown>
    const out: Array<AssertedImmutable> = []
    for (const field of immutableFields) {
      if (record[field] === undefined) continue
      const encoded = encodePathValue([field], record[field], "value")
      if (encoded.issue !== undefined) {
        return `.set() of immutable "${field}": ${String(encoded.issue)}`
      }
      const unstorable = unstorableIn({ [field]: encoded.encoded })
      if (unstorable !== undefined) return `.set(): ${unstorable.describe()} Nothing was sent.`
      out.push({
        field,
        attr: resolveDbName(field),
        value: toAttributeValue(encoded.encoded),
        wire: encoded.encoded,
        packed: field in packedFields,
      })
    }
    return out
  }
  const immutableChangedMessage = (field: string) =>
    `.set() of "${field}": "${field}" is immutable and the update's value ` +
    "differs from the stored one."
  /** A restated immutable value that differs from the stored item's (packed fields excepted). */
  const immutableMismatch = (
    asserted: ReadonlyArray<AssertedImmutable>,
    stored: Readonly<globalThis.Record<string, unknown>>,
  ): string | undefined => {
    const changed = asserted.find(
      ({ attr, value, packed }) =>
        !packed && !attributeValueEquals(stored[attr] as AttributeValue | undefined, value),
    )
    return changed === undefined ? undefined : immutableChangedMessage(changed.field)
  }
  /**
   * A restated immutable PACKED value that differs from the stored item's,
   * compared by the stored value's unpacked JSON (#147) — whatever codec or
   * threshold it was written under.
   */
  const packedImmutableMismatch = (
    asserted: ReadonlyArray<AssertedImmutable>,
    stored: Readonly<globalThis.Record<string, AttributeValue>>,
  ): Effect.Effect<string | undefined, ValidationError> =>
    Effect.gen(function* () {
      for (const { field, attr, wire, packed } of asserted) {
        if (!packed) continue
        const storedValue = stored[attr]
        if (storedValue === undefined) {
          if (wire === undefined || wire === null) continue
          return immutableChangedMessage(field)
        }
        const raw = fromAttributeMap({ [attr]: storedValue }) as globalThis.Record<string, unknown>
        yield* unpackFields(raw, "update.decode")
        if (!attributeValueEquals(toAttributeValue(raw[attr]), toAttributeValue(wire))) {
          return immutableChangedMessage(field)
        }
      }
      return undefined
    })

  /**
   * Whether an update can safely create the item it names (#133): its payload
   * supplies every required model field and every primary-key composite, so
   * the item it writes decodes. Anything less on a missing item would leave a
   * partial row behind — those updates require the item to exist.
   */
  const completeUpsertPayload = (
    updates: unknown,
    removed: ReadonlyArray<string>,
    lacks: Lacks,
  ): boolean => {
    if (typeof updates !== "object" || updates === null) return false
    const record = updates as globalThis.Record<string, unknown>
    const present = (field: string) =>
      (record[field] !== undefined && record[field] !== null) ||
      (removed.includes(field) && lacks.absentReading(field) !== undefined)
    const primary = allIndexes.primary
    if (primary && ![...primary.pk.composite, ...primary.sk.composite].every(present)) return false
    for (const [field, fieldSchema] of Object.entries(
      data.modelFields as globalThis.Record<string, Schema.Top>,
    )) {
      const ast = fieldSchema.ast as {
        readonly context?: { readonly isOptional?: boolean }
        readonly encoding?: ReadonlyArray<{
          readonly to: { readonly context?: { readonly isOptional?: boolean } }
        }>
      }
      if (ast.context?.isOptional === true) continue
      // A decoding default (optional on the stored side): `put` may omit it too.
      if (ast.encoding?.[ast.encoding.length - 1]?.to.context?.isOptional === true) continue
      const ref = resolvedRefs.find((r) => r.fieldName === field)
      if (present(field) || (ref !== undefined && present(ref.idFieldName))) continue
      return false
    }
    return true
  }

  // schema + tableTag are injected via _configure() when the entity is registered
  // on a Table and bound through DynamoClient.make(); captured by operation closures.
  let schema!: DynamoSchema.DynamoSchema
  let tableTag!: import("effect").Context.Service<TableConfig, TableConfig>

  /**
   * Flatten sparse Map fields into per-entry top-level attributes.
   * Called on the write path after rename + date serialization, before
   * `toAttributeMap`. No-op when the entity has no sparse fields.
   *
   * Throws on key validation errors (caught by callers and translated into
   * tagged `ValidationError` at the entity boundary).
   */
  const serializeSparseFields = (item: globalThis.Record<string, unknown>): void => {
    if (!hasSparseFields) return
    encodeSparseFields(item, sparseFields)
  }

  /**
   * Rebuild sparse Map fields from flattened top-level attributes.
   * Called on the read path after `fromAttributeMap`, before rename + date
   * deserialization. No-op when the entity has no sparse fields.
   */
  const deserializeSparseFields = (raw: globalThis.Record<string, unknown>): void => {
    if (!hasSparseFields) return
    decodeSparseFields(raw, sparseFields)
  }

  // ---------------------------------------------------------------------------
  // Packed fields (`storedAs: DynamoModel.Packed`) — see
  // `docs/designs/storage-encoding.md` §6. Packing runs after renames and
  // sparse flattening, before `toAttributeMap`; unpacking after
  // `fromAttributeMap`, before sparse rebuild and renames — the same points as
  // the sparse layout, keyed by stored attribute names.
  // ---------------------------------------------------------------------------

  const { packedFields, packedAttributes, dispatchAttributes, hasPackedFields } = data

  /**
   * Pack, in place, the packed attributes of a stored-name item. `only`
   * restricts it to those stored attributes (the read-merge update path packs
   * only the fields it names: the others still hold their stored value).
   */
  const packFields = (
    item: globalThis.Record<string, unknown>,
    operation: string,
    only?: ReadonlySet<string>,
  ): Effect.Effect<void, ValidationError> => {
    if (!hasPackedFields) return Effect.void
    const targets =
      only === undefined
        ? packedAttributes
        : Object.fromEntries(Object.entries(packedAttributes).filter(([attr]) => only.has(attr)))
    if (Object.keys(targets).length === 0) return Effect.void
    return withRegistry((registry) =>
      packItemSync(item, targets, registry, { entityType, operation: `${operation}.packed` }),
    )
  }

  /** Pack one attribute's wire value straight to its `AttributeValue` (an `UpdateItem` SET). */
  const packAttribute = (
    attribute: string,
    wire: unknown,
    operation: string,
  ): Effect.Effect<AttributeValue | undefined, ValidationError> =>
    withRegistry((registry) =>
      packAttributeValueSync(
        packedAttributes[attribute]!,
        wire,
        registry,
        { entityType, operation: `${operation}.packed` },
        attribute,
      ),
    )

  /**
   * Read, in place, the dispatch-eligible attributes of a stored-name row by
   * their stored form. A row with no string or binary value on any of them
   * (every native row) costs one `typeof` per attribute.
   */
  const unpackFields = (
    raw: globalThis.Record<string, unknown>,
    operation = "decode",
  ): Effect.Effect<void, ValidationError> =>
    dispatchAttributes.length === 0
      ? Effect.void
      : unpackRow(raw, dispatchAttributes, { entityType, operation })

  /**
   * A domain-named copy of `record` with its packed (or once-packed) attributes
   * read by their stored form. The update paths derive vector source text from
   * it: an untouched packed field still holds its stored value there (a JSON
   * string or compressed bytes), not the value the source `compose` expects.
   * `record` itself is left as is, so the write still carries the stored bytes.
   */
  const unpackedDomainCopy = (
    record: globalThis.Record<string, unknown>,
    operation: string,
  ): Effect.Effect<globalThis.Record<string, unknown>, ValidationError> => {
    if (dispatchAttributes.length === 0) return Effect.succeed(record)
    const stored = { ...record }
    renameToDynamo(stored)
    return Effect.map(unpackFields(stored, operation), () => {
      renameFromDynamo(stored)
      return stored
    })
  }

  /** The packed attributes an expression or projection may not look inside (EDD-9076). */
  const packedGuards: ReadonlyArray<PackedAttributeGuard> = Object.entries(packedFields).flatMap(
    ([field, storedAs]) => {
      const guard = (attribute: string): PackedAttributeGuard => ({
        attribute,
        owner: `Entity "${entityType}"`,
        storedAs,
        alternative: () =>
          `To filter on it, use .filterBy((item) => ...), which runs on the decoded item; to ` +
          `condition a write on it, read the item and compare in code, then write the whole ` +
          `value with .set({ ${field} }).`,
      })
      const stored = resolveDbName(field)
      return stored === field ? [guard(field)] : [guard(field), guard(stored)]
    },
  )

  /** Throw `[EDD-9076]` when an expression looks inside a packed field. */
  const refusePackedExpr = (expr: Expr, usage: string): void => {
    const refused = packedExprRefusal(expr, packedGuards, usage)
    if (refused !== undefined) throw new Error(refused)
  }

  /**
   * The `Query.make` options of this entity's queries: the packed guards, and
   * the raw-row hook that reads packed attributes of a projected row of THIS
   * entity type by their stored form (parsed JSON, not schema-decoded) — rows
   * of other types (`ignoreOwnership()`) are left untouched.
   */
  const packedQueryOptions: {
    readonly packed: ReadonlyArray<PackedAttributeGuard>
    readonly rawRow: Query.QueryRawRow | undefined
  } = {
    packed: packedGuards,
    rawRow: ownRowsRawRow(entityType, dispatchAttributes, (raw) => unpackFields(raw)),
  }

  /**
   * `[EDD-9077]`: an update applies anything but a whole-value `.set()` /
   * `.remove()` to a packed field — DynamoDB cannot compute inside one opaque
   * value. `undefined` when the update is fine.
   */
  const refusedPackedUpdate = (uState: UpdateState): string | undefined => {
    if (!hasPackedFields) return undefined
    const refuse = (op: string, field: string) =>
      `[EDD-9077] Entity "${entityType}": ${op} on "${field}", but "${field}" is stored packed ` +
      `(format "${packedFields[field]!.format}"): DynamoDB holds it as one opaque string or ` +
      `binary value and cannot apply ${op} inside it. Write the whole value with ` +
      `.set({ ${field} }) (or .remove(["${field}"])).`
    const records: ReadonlyArray<readonly [string, object | undefined]> = [
      [".add()", uState.add],
      [".subtract()", uState.subtract],
      [".append()", uState.append],
      [".deleteFromSet()", uState.deleteFromSet],
    ]
    for (const [op, values] of records) {
      for (const field of Object.keys(values ?? {})) {
        if (field in packedFields) return refuse(op, field)
      }
    }
    const pathOps: ReadonlyArray<
      readonly [string, ReadonlyArray<{ readonly segments: ReadonlyArray<string | number> }>]
    > = [
      ["pathSet", uState.pathSets ?? []],
      ["pathRemove", (uState.pathRemoves ?? []).map((segments) => ({ segments }))],
      ["pathAdd", uState.pathAdds ?? []],
      ["pathSubtract", uState.pathSubtracts ?? []],
      ["pathAppend", uState.pathAppends ?? []],
      ["pathPrepend", uState.pathPrepends ?? []],
      ["pathIfNotExists", uState.pathIfNotExists ?? []],
      ["pathDelete", uState.pathDeletes ?? []],
    ]
    for (const [op, ops] of pathOps) {
      for (const { segments } of ops) {
        const head = segments[0]
        if (typeof head === "string" && head in packedFields) return refuse(op, head)
      }
    }
    for (const { field } of uState.sparseRemoveEntries ?? []) {
      if (field in packedFields) return refuse(".removeEntries()", field)
    }
    for (const field of uState.sparseClearFields ?? []) {
      if (field in packedFields) return refuse(".clearMap()", field)
    }
    return undefined
  }

  /**
   * A DOMAIN-keyed VIEW of a row that came off the wire.
   *
   * Stored rows are keyed by ATTRIBUTE name, but everything that reads a row by
   * field name — key composition (`composeAllKeys`, `keyForm`), vector-partition
   * recomposition, unique-sentinel composition — is written against DOMAIN
   * names. Under a `DynamoModel.configure(model, { id: { field: "widgetId" } })`
   * rename the two differ, and reading the wrong one yields `undefined`: key
   * composition throws (`Missing composite attribute "id" in record`) and
   * sentinel composition silently treats the constraint as unset (#127).
   *
   * Returns a shallow COPY — the caller's row stays attribute-keyed, so the item
   * actually written back (tombstone, restored item, snapshot) is unaffected and
   * `decodeAs` can still do its own in-place rename on it. Callers that decode
   * the row and discard it rename in place instead (see `decodeRecord`).
   */
  const toDomainView = (
    raw: globalThis.Record<string, unknown>,
  ): globalThis.Record<string, unknown> => {
    const view = { ...raw }
    // The order every read of a row uses: sparse entries leave the attribute-keyed row first, so
    // an entry never stands in for a field of its name whose own attribute the row lacks.
    deserializeSparseFields(view)
    renameFromDynamo(view)
    return view
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Read-path composite encoder — see `internal/CompositeCodec.ts`. The write
  // path composes keys from the encoded record (`put` encodes, THEN composes);
  // key and query inputs arrive as decoded model values, so they are encoded
  // through the model's own field codecs before composition. Encoding is
  // idempotent via the `decode -> encode` fallback, so callers that already
  // hold an encoded record are unaffected.
  // Source: `inputSchema`, the EXACT schema `put` encodes through before
  // `composeAllKeys`. The raw model is not equivalent — entity derivation
  // substitutes date/Redacted fields with their wire transforms, so reading
  // fields off the model would miss encodings the write path applies.
  /**
   * Every attribute a key, sentinel or partition of this entity is composed from: the composites
   * of the primary key and of every index (a Z-order half's prefix and dimensions among them, and
   * the history segments, which are the primary sort key's), shard sources, unique constraint
   * fields, vector partitions and a time series' `orderBy`. `allIndexes` grows after `make()`.
   */
  let keyReaders:
    | readonly [globalThis.Record<string, IndexDefinition>, ReadonlySet<string>]
    | undefined
  const readsKey = (attr: string): boolean => {
    if (keyReaders === undefined || keyReaders[0] !== allIndexes) {
      const readers = new Set<string>()
      for (const def of Object.values(allIndexes)) {
        // A shard's `by` and source are composites of the index and the primary key.
        for (const field of [...def.pk.composite, ...def.sk.composite]) readers.add(field)
      }
      for (const def of Object.values(
        (config.unique ?? {}) as globalThis.Record<string, UniqueConstraintDef>,
      )) {
        for (const field of resolveUniqueFields(def)) readers.add(field)
      }
      for (const definition of Object.values(data.vectorIndexes)) {
        for (const field of definition.partition) readers.add(field)
      }
      const orderBy = (config.timeSeries as TimeSeriesConfig<any> | undefined)?.orderBy
      if (orderBy !== undefined) readers.add(orderBy)
      keyReaders = [allIndexes, readers]
    }
    return keyReaders[1].has(attr)
  }

  const unencodable = (attr: string, value: unknown, reason?: string): never => {
    if (reason !== undefined) {
      return refuseInexact(`Composite "${attr}" on entity "${entityType}"`, value, reason)
    }
    throw new Error(
      `[EDD-9050] Composite "${attr}" on entity "${entityType}" could not be encoded to its ` +
        `stored form. The attribute's schema carries an encoding transformation, so the ` +
        `stored key holds the ENCODED value, but ${JSON.stringify(String(value))} encodes ` +
        `under neither encode nor decode->encode. Supply a value of the attribute's own type.`,
    )
  }
  const compositeKeyForm = makeCompositeKeyForm(
    schemas.inputSchema as unknown as Schema.Top,
    unencodable,
    // A record handed here can be a whole row read back (restore, a retain update, rekey): what
    // no key reads is never key text, so a field stored in a form its schema can't take again
    // is left as it is.
    { reads: readsKey },
  )
  const compositeStoredForm = makeCompositeStoredForm(schemas.inputSchema as unknown as Schema.Top)

  /**
   * PUBLIC key boundary. Converts a caller-supplied key record from the model's
   * **Type** side — the one convention the whole API takes — into the ENCODED
   * form key composition expects.
   *
   * `put` composes keys from the encoded record, so the stored key holds the
   * wire value. Key-taking operations used to run a plain `decode`, which reads
   * the Encoded side and then handed the *decoded* result to the composer. On a
   * transformed composite neither spelling worked: `get({ txn: 420n })` failed
   * validation and `get({ txn: "420" })` silently returned `ItemNotFound` for a
   * row that exists. Encoding the Type side fixes the one spelling that should
   * have worked all along, and matches what the query path takes.
   *
   * Encode-ONLY, deliberately: no `decode -> encode` fallback. The Encoded side
   * is not a public input, so `{ txn: "420" }` fails here — loudly, with the
   * attribute named by the schema error — rather than composing a key by a
   * second convention. Internal callers that legitimately hold encoded records
   * do not come through here; see `composePrimaryKey`.
   */
  const encodeKey = (
    key: unknown,
    operation: string,
  ): Effect.Effect<globalThis.Record<string, unknown>, ValidationError> =>
    Schema.encodeUnknownEffect(schemas.keySchema as Schema.Codec<any>)(key).pipe(
      Effect.map((encoded) => encoded as globalThis.Record<string, unknown>),
      Effect.mapError((cause) => new ValidationError({ entityType, operation, cause })),
      // A composite with no key text (`NaN`, `[EDD-9096]`) fails here, as a
      // `ValidationError`, not as a defect where the caller composes the key.
      Effect.tap((encoded) =>
        composeKeysOrFail(entityType, operation, () => composePrimaryKey(encoded)),
      ),
    )

  /**
   * Synchronous `encodeKey`, for the query builders (`history`, `versions`,
   * `deleted.list`) that compose a partition key outside an Effect. Same
   * Type-side-only rule; throws the schema's own error, which names the
   * offending attribute — these builders have always thrown on a bad key.
   */
  const encodeKeySync = (key: unknown): globalThis.Record<string, unknown> =>
    Schema.encodeUnknownSync(schemas.keySchema as Schema.Codec<any>)(key) as globalThis.Record<
      string,
      unknown
    >

  /**
   * INTERNAL key composition. Takes an **already-encoded** record — either the
   * output of `encodeKey` on the public path, or an item read back from
   * DynamoDB on the retain / restore / soft-delete paths, which are wire-shaped
   * by construction.
   *
   * The `encodeCompositeRecord` pass is a normalisation, not a second input
   * convention: composite encoding is idempotent, so an already-encoded value
   * round-trips to itself. It exists so that `keySchema` (built from raw model
   * fields) and `inputSchema` (built from derivation-substituted fields) cannot
   * disagree for a composite whose wire transform is added by derivation —
   * `Schema.Date` being the case that matters.
   */
  /**
   * THE key-form normaliser. Every record handed to `KeyComposer` in this
   * module goes through it, so the write path, the update path, the lifecycle
   * paths and the read path cannot disagree about how a composite is spelled
   * in a key.
   *
   * Skipping it on ONE site is enough to corrupt data: `composeAllKeys` (put)
   * normalised while `composeGsiKeysForUpdatePolicyAware` (update) did not, so
   * an `update()` rewrote a padded `gsi1pk` to its unpadded form and evicted
   * the row from its own GSI. `test/KeyFormInvariant.test.ts` scans this file
   * and fails if a `KeyComposer.compose*` call takes a record that did not come
   * through `keyForm(...)`.
   */
  const keyForm = (record: globalThis.Record<string, unknown>) =>
    toCompositeKeyRecord(compositeKeyForm, record)

  /**
   * A unique field's value as `put` stored it, from a row read back: sentinels are composed from
   * the Encoded value, which for a field stored as `N` the unmarshaller may hand back as the other
   * numeric kind (`storedNumericForm`). `undefined` when the value is already as stored.
   */
  const storedSentinelValue = (() => {
    const fields = getSchemaFields(schemas.inputSchema as unknown as Schema.Top)
    const forms = new Map<string, ((value: unknown) => unknown) | undefined>()
    return (field: string, value: unknown): unknown => {
      if (!forms.has(field)) {
        const fieldSchema = fields?.[field]
        forms.set(field, fieldSchema === undefined ? undefined : storedNumericForm(fieldSchema))
      }
      return forms.get(field)?.(value)
    }
  })()

  /**
   * A unique field's value, or a time-series `orderBy`, as `put` or `append` stored it, from a row
   * read back: {@link storedSentinelValue}, and for a field whose numeric kinds can't be read off its
   * schema, the value decoded through the field, as a read decodes it, and encoded again
   * (`storedFormOfRead`). `Schema.Unknown` decoded to a `Schema.BigInt` stored `5n`, which reads back
   * as `5`. Only a value read from a row is taken this way: a write's own value is the one it stores.
   */
  const readSentinelValue = (() => {
    const fields = getSchemaFields(schemas.inputSchema as unknown as Schema.Top)
    const forms = new Map<string, ((value: unknown) => unknown) | undefined>()
    return (field: string, value: unknown): unknown => {
      if (!forms.has(field)) {
        const fieldSchema = fields?.[field]
        forms.set(field, fieldSchema === undefined ? undefined : storedFormOfRead(fieldSchema))
      }
      return forms.get(field)?.(value)
    }
  })()

  /**
   * `keyForm` of a caller's DOMAIN key record: each composite first put into
   * the form `put` stores it in, as `put`'s encode and `get`'s `encodeKey` do,
   * so a domain value that also reads as its codec's stored text (`"x:MiX"`
   * for a codec prepending `x:`) composes the key `put` wrote for it. Every
   * other composite composes exactly what `keyForm` alone does.
   */
  const domainKeyForm = (record: globalThis.Record<string, unknown>) =>
    keyForm(compositeStoredForm(record))

  /**
   * The key form 1.39.0 composed from a stored record: a codec whose `encode`
   * takes its own output keyed its stored text encoded once more (`x:x:mix`
   * for `"MiX"` stored `"x:MiX"`). Only `rekey` composes it, to find a row
   * 1.39.0 stored under that text and move it to `keyForm`'s.
   */
  const compositeKeyForm139 = makeCompositeKeyForm(
    schemas.inputSchema as unknown as Schema.Top,
    unencodable,
    { text139: true, reads: readsKey },
  )
  const keyForm139 = (record: globalThis.Record<string, unknown>) =>
    toCompositeKeyRecord(compositeKeyForm139, record)

  // -------------------------------------------------------------------------
  // Write-limit diagnosis (#144)
  //
  // DynamoDB's limits — 400 KB per item, 100 items and 4 MB per transaction,
  // 1024-byte sort keys — are not pre-checked. Every write is sent; when
  // DynamoDB rejects it, `internal/WriteDiagnosis.ts` recognises the
  // rejection, confirms it against the request and names the item. Applied
  // after each site's conditional-failure mapping; nothing runs on success.
  // -------------------------------------------------------------------------

  const entityKeyFields = (): ReadonlyArray<string> => [
    config.indexes.primary.pk.field,
    config.indexes.primary.sk.field,
  ]
  const entityKeys = () => keyAttributesOf(config.indexes)

  /**
   * Diagnose a rejected single-item write (`PutItem` / `UpdateItem` /
   * `DeleteItem`). `callerCondition`: the caller's own `.condition()` within
   * the write's condition, to say how much of an over-long one is theirs.
   */
  const diagnoseItemWrite = (
    operation: string,
    item: TransactWriteItem,
    callerCondition?: () => string | undefined,
  ) =>
    diagnoseFailure({
      sent: () => ({
        _tag: "Item",
        item,
        target: () =>
          targetsFor(
            [item],
            entityKeyFields(),
            entityType,
            () => `the ${entityType} ${operation}`,
          )[0]!,
        callerCondition,
      }),
      keys: entityKeys,
      rewrite: (diagnosis, original) =>
        diagnosedValidationError(diagnosis, original, { operation, entityType }),
    })

  /**
   * Diagnose a rejected `TransactWriteItems` of this entity's write: over 100
   * items is `TransactionOverflow`, every other limit `ValidationError`.
   */
  const diagnoseTransactionWrite = (
    operation: string,
    items: ReadonlyArray<TransactWriteItem>,
    /** The caller's own `.condition()` within the first item's (its main write's) condition. */
    callerCondition?: () => string | undefined,
  ) =>
    diagnoseFailure({
      sent: () => ({
        _tag: "Transaction",
        items,
        targets: () =>
          targetsFor(items, entityKeyFields(), entityType, (index) =>
            index === 0 ? "the item" : `item ${index} of the ${operation} transaction`,
          ),
        callerCondition: (index: number) => (index === 0 ? callerCondition?.() : undefined),
      }),
      keys: entityKeys,
      rewrite: (diagnosis, original): TransactionOverflow | ValidationError =>
        diagnosis._tag === "TooManyItems"
          ? new TransactionOverflow({
              entityType,
              operation,
              itemCount: diagnosis.count,
              limit: diagnosis.limit,
              cause: original,
            })
          : diagnosedValidationError(diagnosis, original, { operation, entityType }),
    })

  const composePrimaryKey = (record: globalThis.Record<string, unknown>) => {
    const primary = config.indexes.primary
    const recordKeyForm = keyForm(record)
    return {
      [primary.pk.field]: KeyComposer.composePk(schema, entityType, primary, recordKeyForm),
      [primary.sk.field]: KeyComposer.composeSk(
        schema,
        entityType,
        entityVersion,
        primary,
        recordKeyForm,
      ),
    }
  }

  /**
   * What a write stamps on an item it builds whole, in wire form: a timestamp the caller didn't
   * supply, and the first version. Keys are composed after this, so an index can be composed from
   * any of them (`DESIGN.md` §7, "Composites the library stamps").
   */
  const stampsOf = (
    encoded: globalThis.Record<string, unknown>,
    times: { readonly createdAt: DateTime.Utc; readonly updatedAt: DateTime.Utc },
  ): globalThis.Record<string, unknown> => ({
    ...(systemFields.createdAt && encoded[systemFields.createdAt] === undefined
      ? {
          [systemFields.createdAt]: generateTimestamp(
            systemFields.createdAtEncoding,
            times.createdAt,
          ),
        }
      : {}),
    ...(systemFields.updatedAt && encoded[systemFields.updatedAt] === undefined
      ? {
          [systemFields.updatedAt]: generateTimestamp(
            systemFields.updatedAtEncoding,
            times.updatedAt,
          ),
        }
      : {}),
    ...(systemFields.version ? { [systemFields.version]: 1 } : {}),
  })

  /**
   * What an update stamps, by model name: the `updatedAt` it writes, and the next version where the
   * write read the item to know it. See `KeyComposer.composeGsiKeysForUpdatePolicyAware`.
   */
  const writeStamps = (
    updatedAt: unknown,
    version: number | undefined,
  ): globalThis.Record<string, unknown> => ({
    ...(systemFields.updatedAt && updatedAt !== undefined
      ? { [systemFields.updatedAt]: updatedAt }
      : {}),
    ...(systemFields.version && version !== undefined ? { [systemFields.version]: version } : {}),
  })

  /** The system fields of `item`, by model name: what a guarded put may have carried over from the stored item. */
  const carriedSystemFields = (
    item: globalThis.Record<string, unknown>,
  ): globalThis.Record<string, unknown> => ({
    ...(systemFields.createdAt
      ? { [systemFields.createdAt]: item[resolveDbName(systemFields.createdAt)] }
      : {}),
    ...(systemFields.version ? { [systemFields.version]: item[systemFields.version] } : {}),
  })

  /**
   * Every index's keys for `record`. A Z-order sort key can fail to place a
   * value (`[EDD-9092]`, #171), and a composite can have no key text (`NaN`,
   * `[EDD-9096]`), which surface as a `ValidationError` for `operation`. So
   * does a unique field with no key text: its sentinel key is composed later,
   * on the guarded path after the item is marshalled, and the marshaller
   * would refuse a `NaN` as a defect.
   */
  const composeAllKeys = (record: globalThis.Record<string, unknown>, operation: string) =>
    composeKeysOrFail(entityType, operation, () => {
      const keys = KeyComposer.composeAllKeys(
        schema,
        entityType,
        entityVersion,
        allIndexes,
        keyForm(record),
      )
      for (const constraintDef of Object.values(
        (config.unique ?? {}) as globalThis.Record<string, UniqueConstraintDef>,
      )) {
        for (const field of resolveUniqueFields(constraintDef)) {
          const value = record[field]
          if (value !== undefined && value !== null) KeyComposer.compositeText(schema, value)
        }
      }
      return keys
    })

  /**
   * Fill the auto-generated id field on the raw `put` input when configured and
   * absent. Sources a UUID from the bundled `SecureRandom` service. Caller-supplied
   * values are respected (never overwritten). Returns the input unchanged when
   * `generatedId` is not configured — entities without it never touch SecureRandom.
   *
   * `SecureRandom` is provided from the context `DynamoClient.make` bundles,
   * so the bound `put` stays `R = never` despite this yield.
   */
  const fillGeneratedId = (
    input: unknown,
  ): Effect.Effect<unknown, never, SecureRandom.SecureRandom> => {
    if (!generatedIdField) return Effect.succeed(input)
    if (typeof input !== "object" || input === null) return Effect.succeed(input)
    const rec = input as globalThis.Record<string, unknown>
    if (rec[generatedIdField] !== undefined && rec[generatedIdField] !== null) {
      return Effect.succeed(input)
    }
    return Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom
      const id = generatedIdVersion === "v7" ? yield* random.uuidV7() : yield* random.uuidV4()
      return { ...rec, [generatedIdField]: id }
    })
  }

  /**
   * The model fields with a decoding default (`Schema.withDecodingDefault` and
   * kin: optional on the stored side, required on the domain side).
   */
  const defaultedFields: ReadonlyArray<readonly [string, Schema.Top]> = Object.entries(
    data.modelFields as globalThis.Record<string, Schema.Top>,
  ).filter(([, field]) => {
    const ast = field.ast as {
      readonly context?: { readonly isOptional?: boolean }
      readonly encoding?: ReadonlyArray<{
        readonly to: { readonly context?: { readonly isOptional?: boolean } }
      }>
    }
    return (
      ast.context?.isOptional !== true &&
      ast.encoding?.[ast.encoding.length - 1]?.to.context?.isOptional === true
    )
  })

  /**
   * Fill each omitted decoding-default field that an INDEX key derives from —
   * a primary-key, GSI or LSI composite — with its default (#133), so the item
   * stores it, its keys compose from it, and the item, its keys and its decoded
   * read all agree. Left out, the item had no index keys while its decoded
   * record named a value the index is keyed by. A default never creates a
   * unique sentinel (`unsentineledDefaults`); other defaulted fields keep
   * their contract: not stored, defaulted on read.
   */
  /** The defaulted fields an index key derives from — materialised when omitted. */
  const indexedDefaultFields = (): ReadonlySet<string> => {
    const composites = new Set(
      Object.values(allIndexes).flatMap((def) => [...def.pk.composite, ...def.sk.composite]),
    )
    return new Set(defaultedFields.map(([name]) => name).filter((name) => composites.has(name)))
  }
  /**
   * The unique-constraint fields a write's input omits but stores a default
   * for (an index composite): the item lists them in `__edd_d__`, and no
   * sentinel is composed from them — a default never creates a sentinel.
   */
  const unsentineledDefaults = (input: unknown): ReadonlyArray<string> => {
    if (config.unique == null || typeof input !== "object" || input === null) return []
    const record = input as globalThis.Record<string, unknown>
    const unique = new Set(
      Object.values(config.unique as globalThis.Record<string, UniqueConstraintDef>).flatMap(
        (def) => [...resolveUniqueFields(def)],
      ),
    )
    return [...indexedDefaultFields()].filter(
      (name) => unique.has(name) && record[name] === undefined,
    )
  }

  /**
   * An update's `.remove()` of a defaulted index composite: the field would
   * read back as its default while its index keys were dropped. It becomes a
   * `.set()` of the default instead (#133) — stored, keys recomposed from it —
   * and the fields so defaulted are returned (a unique one then holds only a
   * default: `__edd_d__`).
   */
  const rematerializeRemovedDefaults = (
    uState: UpdateState,
  ): Effect.Effect<
    { readonly state: UpdateState; readonly defaulted: ReadonlyArray<string> },
    ValidationError
  > => {
    const indexed = indexedDefaultFields()
    const removed = (uState.remove ?? []).filter((field) => indexed.has(field))
    if (removed.length === 0) return Effect.succeed({ state: uState, defaulted: [] })
    const fields = defaultedFields.filter(([name]) => removed.includes(name))
    return Schema.decodeUnknownEffect(
      Schema.Struct(Object.fromEntries(fields)) as unknown as Schema.Codec<any>,
    )({}).pipe(
      Effect.map((defaults) => ({
        state: {
          ...uState,
          remove: (uState.remove ?? []).filter((field) => !removed.includes(field)),
          updates: {
            ...((uState.updates as globalThis.Record<string, unknown> | undefined) ?? {}),
            ...(defaults as object),
          },
        },
        defaulted: removed,
      })),
      Effect.mapError(
        (cause) => new ValidationError({ entityType, operation: "update.default", cause }),
      ),
    ) as Effect.Effect<
      { readonly state: UpdateState; readonly defaulted: ReadonlyArray<string> },
      ValidationError
    >
  }

  const fillDecodingDefaults = (
    input: unknown,
    fills: (field: string, given: globalThis.Record<string, unknown>) => boolean = (field) =>
      indexedDefaultFields().has(field),
  ): Effect.Effect<unknown, ValidationError> => {
    if (defaultedFields.length === 0 || typeof input !== "object" || input === null) {
      return Effect.succeed(input)
    }
    const record = input as globalThis.Record<string, unknown>
    const missing = defaultedFields.filter(
      ([name]) => fills(name, record) && record[name] === undefined,
    )
    if (missing.length === 0) return Effect.succeed(input)
    return Schema.decodeUnknownEffect(
      Schema.Struct(Object.fromEntries(missing)) as unknown as Schema.Codec<any>,
    )({}).pipe(
      Effect.map((defaults) => ({ ...record, ...(defaults as object) })),
      Effect.mapError(
        (cause) => new ValidationError({ entityType, operation: "put.default", cause }),
      ),
    ) as Effect.Effect<unknown, ValidationError>
  }

  /** Whether `input` omits a defaulted field an index key derives from (see `fillDecodingDefaults`). */
  const omitsIndexedDefault = (input: unknown): boolean => {
    if (defaultedFields.length === 0 || typeof input !== "object" || input === null) return false
    const record = input as globalThis.Record<string, unknown>
    return [...indexedDefaultFields()].some((name) => record[name] === undefined)
  }

  /** A field an upsert keeps from the stored row (`if_not_exists`), where it isn't in the key anyway. */
  const keptByUpsert = (field: string) =>
    !isPrimaryComposite(field) && (field === systemFields.createdAt || immutableFields.has(field))

  /** A secondary index's halves: the key attribute, and what's composed into it. */
  const halvesOf = (index: {
    readonly pk: { readonly field: string; readonly composite: ReadonlyArray<string> }
    readonly sk: { readonly field: string; readonly composite: ReadonlyArray<string> }
    readonly shards?: { readonly by?: ReadonlyArray<string> | undefined } | undefined
  }): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => [
    [index.pk.field, [...index.pk.composite, ...(index.shards?.by ?? [])]],
    [index.sk.field, index.sk.composite],
  ]

  /**
   * A value with no stored form is an absent attribute, so an upsert's replaces what the row
   * holds. A field left unset (an optional `undefined`) doesn't, nor does an immutable one.
   */
  const upsertClears = (field: string, value: unknown, lacks: Lacks): boolean =>
    (isEmptySet(value) || (value === undefined && lacks.absentReading(field) !== undefined)) &&
    !immutableFields.has(field)

  /**
   * The keys an upsert writes: `composed`, plus a half of an index it can't compose whole, where the
   * input has all that half holds and some of it can change. A half of nothing but primary composites
   * and kept values says what it always said, so it isn't written: an upsert writes no more attributes
   * than it must.
   */
  const upsertKeys = (
    record: globalThis.Record<string, unknown>,
    composed: globalThis.Record<string, KeyComposer.KeyValue>,
  ) =>
    composeKeysOrFail(entityType, "upsert", () => {
      const keys = { ...composed }
      const recordKeyForm = keyForm(record)
      for (const [indexName, index] of Object.entries(allIndexes)) {
        if (indexName === "primary" || index.pk.field in composed) continue
        const known = KeyComposer.composeKnownHalves(
          schema,
          entityType,
          entityVersion,
          index,
          recordKeyForm,
        )
        for (const [field, composites] of halvesOf(index)) {
          const value = known[field]
          if (
            value !== undefined &&
            composites.some((attr) => !keptByUpsert(attr) && !isPrimaryComposite(attr))
          ) {
            keys[field] = value
          }
        }
      }
      return keys
    })

  /**
   * What an upsert does about the secondary keys it can't simply write, because one `UpdateItem`
   * can't splice what's stored into a key (`DESIGN.md` §7, "An upsert over a value it keeps" and "An
   * upsert leaving out a composite"). By half:
   *
   * - **`keep`**: the key holds a value the upsert keeps (`createdAt`, immutable fields), and stays too
   *   (`if_not_exists`), where nothing else in the half can change or its `createdAt` isn't in the
   *   input, so the key can't be written. The write holds on an existing row only where it has the key
   *   and everything in `same`, what else the half holds, is what the input says: the key is then
   *   already right.
   * - **`matches`**: the input has every value, so the key is written, and the write holds only where
   *   each kept value is stored as the input has it.
   * - **`same`** also holds what the input names of a half it can't compose, as that half can only
   *   stay if none of it changes. A value it doesn't name changes nothing: an upsert leaves it, and the
   *   key that says it, as stored. So a stamped `updatedAt` isn't held to this, and the half lags until
   *   a write composes it, as on an update. One the input supplies is, and moves the key.
   *
   * A rejected write returns the row at no read, and the upsert composes from that
   * (`guardedUpsert`, by the per-half policy for what the row can't supply): an input that contradicts
   * it, a row without the key, or a changed `same`.
   */
  const upsertKeyPlan = (
    composed: globalThis.Record<string, unknown>,
    input: globalThis.Record<string, unknown>,
    suppliedCreatedAt: boolean,
  ): {
    readonly keep: ReadonlySet<string>
    readonly same: ReadonlySet<string>
    readonly matches: ReadonlySet<string>
  } => {
    const keep = new Set<string>()
    const same = new Set<string>()
    const matches = new Set<string>()
    for (const [indexName, index] of Object.entries(allIndexes)) {
      if (indexName === "primary") continue
      for (const [field, composites] of halvesOf(index)) {
        const others = composites.filter((attr) => !keptByUpsert(attr) && !isPrimaryComposite(attr))
        if (!(field in composed)) {
          for (const attr of others) {
            if (input[attr] !== undefined) same.add(attr)
          }
          continue
        }
        const held = composites.filter(keptByUpsert)
        if (held.length === 0) continue
        if (
          others.length === 0 ||
          (!suppliedCreatedAt && held.includes(systemFields.createdAt ?? ""))
        ) {
          keep.add(field)
          for (const attr of others) same.add(attr)
        } else {
          for (const attr of held) matches.add(attr)
        }
      }
    }
    return { keep, same, matches }
  }

  /** Attach the model class prototype to a decoded plain object (when model is Schema.Class). */
  const attachPrototype = (decoded: any) =>
    isSchemaClass ? Object.assign(Object.create((rawModel as any).prototype), decoded) : decoded

  /**
   * An item of a versioned entity with an incarnation token but no version
   * (#133). A versioned entity stamps the token when it creates an item, so
   * only an item written before the entity was `versioned` may lack a version
   * — and it lacks the token too. Token without version: the version was
   * removed outside the library. Reading it as version 0 would let the next
   * update rewrite the item's history, so every read and write refuses it.
   */
  const versionCorruption = (
    item: Readonly<globalThis.Record<string, unknown>> | undefined,
    operation: string,
  ): ValidationError | undefined =>
    systemFields.version &&
    item !== undefined &&
    item[systemFields.version] === undefined &&
    item[INCARNATION_TOKEN] !== undefined
      ? new ValidationError({
          entityType,
          operation,
          cause:
            `The ${entityType} item has an incarnation token (${INCARNATION_TOKEN}) but no ` +
            `"${systemFields.version}" attribute: its version was removed outside the library. ` +
            "It is refused rather than read as version 0, which would let an update overwrite " +
            "its version history. Restore the version attribute.",
        })
      : undefined
  const checkVersion = (
    item: Readonly<globalThis.Record<string, unknown>> | undefined,
    operation: string,
  ): Effect.Effect<void, ValidationError> => {
    const corruption = versionCorruption(item, operation)
    return corruption === undefined ? Effect.void : Effect.fail(corruption)
  }

  /**
   * The model field a row is without whose reading of the absence throws, if there is one.
   *
   * A field whose absent attribute stands for a value is read as that value, through the
   * field's own steps (`absentStored`). A step that throws on it kills the read, where 1.39.0,
   * which read no such value, failed on the missing key. Looked for only once a row's decode
   * has died, so a read that doesn't die runs nothing more.
   */
  const fieldDyingOnAbsence = (raw: globalThis.Record<string, unknown>): string | undefined => {
    for (const [field, fieldSchema] of Object.entries(modelFieldSchemas)) {
      if (Object.hasOwn(raw, field)) continue
      const absent = absentStored(fieldSchema)
      if (absent === undefined) continue
      try {
        const read = Schema.decodeUnknownExit(fieldSchema as unknown as Schema.Codec<unknown>)(
          absent.stored,
        )
        if (Exit.isFailure(read) && !Exit.hasFails(read)) return field
      } catch {
        return field
      }
    }
    return undefined
  }

  /**
   * A row's decode that died reading a field the row is without fails as 1.39.0's did, on the
   * missing key ({@link fieldDyingOnAbsence}, `failingAsBefore`). Any other defect is the defect
   * it was.
   */
  const missingKeyOnDefect = (raw: globalThis.Record<string, unknown>, operation: string) =>
    failingAsBefore(
      () => {
        const field = fieldDyingOnAbsence(raw)
        return field === undefined
          ? undefined
          : issueDecoding(Schema.Struct({ [field]: Schema.Never }), {})
      },
      (cause) => new ValidationError({ entityType, operation, cause }),
    )

  const decodeRecord = (
    raw: globalThis.Record<string, unknown>,
  ): Effect.Effect<any, ValidationError> => {
    const corruption = versionCorruption(raw, "decode")
    if (corruption !== undefined) return Effect.fail(corruption)
    return Effect.flatMap(unpackFields(raw), () => {
      deserializeSparseFields(raw)
      renameFromDynamo(raw)
      return Schema.decodeUnknownEffect(schemas.recordSchema as Schema.Codec<any>)(raw).pipe(
        Effect.map(attachPrototype),
        Effect.mapError(
          (cause) =>
            new ValidationError({
              entityType,
              operation: "decode",
              cause,
            }),
        ),
        missingKeyOnDefect(raw, "decode"),
      )
    })
  }

  /** Decode a raw item using the schema selected by mode */
  const decodeAs = (
    raw: globalThis.Record<string, unknown>,
    marshalled: globalThis.Record<string, AttributeValue>,
    mode: DecodeMode,
  ) => {
    const corruption = versionCorruption(raw, "decode")
    if (corruption !== undefined) return Effect.fail(corruption)
    // Native: the item as stored — packed values stay their `S` / `B`.
    if (mode === "native") return Effect.succeed(marshalled)
    return Effect.flatMap(unpackFields(raw), () => {
      // Collect flattened sparse-map attributes back into the domain Record.
      // Must happen before rename so the rebuilt Record sits at the domain field
      // name (sparse field renaming is not supported).
      deserializeSparseFields(raw)
      // Rename DynamoDB attributes back to domain field names. Substituted
      // schemas handle wire→domain conversion (date primitives, Redacted, etc.).
      renameFromDynamo(raw)
      const targetSchema =
        mode === "model"
          ? schemas.modelSchema
          : mode === "record"
            ? schemas.recordSchema
            : schemas.itemSchema
      return Schema.decodeUnknownEffect(targetSchema as Schema.Codec<any>)(raw).pipe(
        Effect.map((decoded) =>
          mode === "model" && isSchemaClass && !hasHiddenFields
            ? new (rawModel as any)(decoded)
            : mode !== "item"
              ? attachPrototype(decoded)
              : decoded,
        ),
        Effect.mapError(
          (cause) =>
            new ValidationError({
              entityType,
              operation: "decode",
              cause,
            }),
        ),
        missingKeyOnDefect(raw, "decode"),
      )
    })
  }

  /**
   * Decode a DynamoDB Streams image into an item record (`Entity.Item`): the
   * image normalised (DynamoDB JSON or unmarshalled; `B` as bytes or base64),
   * its dispatch-eligible attributes read by stored form, then sparse rebuild,
   * renames and the item-schema decode — exactly what a table read applies.
   */
  const decodeImageItem = (image: StreamImage): Effect.Effect<unknown, ValidationError> =>
    Effect.gen(function* () {
      // An image of another entity type is decoded as 1.25.0 decoded it: its
      // attributes are never read as packed values (a plain string of that
      // type is not this entity's JSON). The type is read off the raw image.
      const owner = imageEntityType(image)
      const raw = yield* decodeImage(
        image,
        owner === undefined || owner === entityType ? dispatchAttributes : [],
        { entityType, operation: "decodeMarshalledItem" },
        { probe: config.indexes.primary.pk.field },
      )
      const corruption = versionCorruption(raw, "decodeMarshalledItem")
      if (corruption !== undefined) return yield* corruption
      deserializeSparseFields(raw)
      renameFromDynamo(raw)
      const decoded = yield* Schema.decodeUnknownEffect(schemas.itemSchema as Schema.Codec<any>)(
        raw,
      ).pipe(
        Effect.mapError(
          (cause) => new ValidationError({ entityType, operation: "decodeMarshalledItem", cause }),
        ),
        missingKeyOnDefect(raw, "decodeMarshalledItem"),
      )
      return attachPrototype(decoded)
    })

  const nowIso = (now: DateTime.Utc) => DateTime.formatIso(now)

  /**
   * Generate a timestamp value as a wire primitive ready for marshalling.
   * Default (no encoding): ISO string. Custom encoding: serialized primitive.
   *
   * Used for system fields whether colliding or not — the value is always a
   * wire primitive (string or number) ready for `toAttributeMap`.
   *
   * Time source is the Clock-backed `now: DateTime.Utc` resolved at the write
   * op's entry (`yield* DateTime.now`) and threaded in — no `Date` constructor,
   * so timestamps are deterministic under `TestClock`. Delegates to the shared
   * {@link generateTimestampPrimitive} so the Batch/Transaction path produces
   * identical output.
   */
  const generateTimestamp = (encoding: DynamoEncoding | null, now: DateTime.Utc): string | number =>
    generateTimestampPrimitive(now, encoding)

  // ---------------------------------------------------------------------------
  // Lifecycle config helpers
  // ---------------------------------------------------------------------------

  const isRetainEnabled = (): boolean =>
    typeof config.versioned === "object" &&
    config.versioned !== null &&
    (config.versioned as { retain?: boolean }).retain === true

  const isSoftDeleteEnabled = (): boolean =>
    config.softDelete === true ||
    (typeof config.softDelete === "object" && config.softDelete !== null)

  const retainTtl = (): Duration.Duration | string | undefined => {
    if (typeof config.versioned !== "object" || config.versioned === null) return undefined
    return (config.versioned as { ttl?: Duration.Duration | string }).ttl
  }

  const softDeleteTtl = (): Duration.Duration | string | undefined => {
    if (typeof config.softDelete !== "object" || config.softDelete === null) return undefined
    return (config.softDelete as { ttl?: Duration.Duration | string }).ttl
  }

  // The TTL each kind of row is written with, or `undefined` when the entity writes none there.
  // The write of each row asks the same function, so what refuses the table's TTL attribute
  // (`refuseTableAttributes`) is what writes it.
  /** A retained snapshot's: `versioned: { ttl }` without `retain` writes no snapshot. */
  const snapshotTtl = (): Duration.Duration | string | undefined =>
    isRetainEnabled() ? retainTtl() || undefined : undefined
  /** A soft-deleted row's. */
  const tombstoneTtl = (): Duration.Duration | string | undefined =>
    isSoftDeleteEnabled() ? softDeleteTtl() || undefined : undefined
  /** A time series' event's. */
  const eventTtl = (): Duration.Duration | string | undefined => timeSeriesConfig?.ttl || undefined

  /**
   * The rows this entity writes the table's TTL attribute on, in words: the one place that says
   * whether it writes that attribute at all. An update naming the attribute is refused, and a
   * table whose TTL attribute a sparse map would read as an entry is refused at bind, only then.
   */
  const ttlRows = (): ReadonlyArray<string> => [
    ...(snapshotTtl() !== undefined ? ["retained versions"] : []),
    ...(tombstoneTtl() !== undefined ? ["soft-deleted rows"] : []),
    ...(eventTtl() !== undefined ? ["time series events"] : []),
  ]
  const writesTtl = (): boolean => ttlRows().length > 0

  /**
   * `[EDD-9140]` for what the table's configuration names: the TTL attribute this entity sets on
   * its rows may not be one a row's reader takes as a sparse map's entry. `Entity.make` checks
   * every name the definition supplies; this one is known when the table is bound.
   */
  const refuseTableAttributes = (tc: TableConfig): void => {
    const rows = ttlRows()
    if (rows.length === 0) return
    refuseReadAsSparseEntry(
      entityType,
      [
        {
          attribute: resolveTtlAttributeName(tc),
          what: `the table's TTL attribute, which the entity sets on its ${rows.join(" and ")}`,
        },
      ],
      sparseFields,
    )
  }

  const preserveUnique = (): boolean => {
    if (typeof config.softDelete !== "object" || config.softDelete === null) return false
    return (config.softDelete as { preserveUnique?: boolean }).preserveUnique === true
  }

  /**
   * The uniqueness sentinel's guard. `attribute_not_exists` must name the
   * entity's CONFIGURED partition-key attribute — a literal `pk` is simply
   * absent from an entity declaring `pk: { field: "PK" }`, so the condition is
   * vacuously true and the constraint is silently unenforced (#111). Routed
   * through `ExpressionAttributeNames` because the field name is user-supplied
   * and may be a reserved word.
   */
  const sentinelGuard = (): {
    readonly ConditionExpression: string
    readonly ExpressionAttributeNames: globalThis.Record<string, string>
  } => ({
    ConditionExpression: "attribute_not_exists(#sentinel_pk)",
    ExpressionAttributeNames: { "#sentinel_pk": config.indexes.primary.pk.field },
  })

  /**
   * The RESTORE-time sentinel guard.
   *
   * `restore` re-establishes one sentinel per satisfiable constraint. With
   * `preserveUnique` off the delete released them, so `attribute_not_exists` is
   * exactly right: the row is gone and anyone may have taken the value since.
   *
   * With `softDelete: { preserveUnique: true }` the delete deliberately KEPT the
   * reservation, so `attribute_not_exists` can never hold and every restore of a
   * constrained entity was cancelled and reported as a `UniqueConstraintViolation`
   * against its own reservation — `preserveUnique` made `restore` impossible.
   * The guard must instead let the row re-claim the sentinel it still owns while
   * still refusing one somebody else holds, which is what the stored
   * `_entity_pk`/`_entity_sk` back-pointer is for: they name the item the
   * reservation belongs to, and they are the same values this Put writes.
   */
  const restoreSentinelGuard = (
    entityPk: unknown,
    entitySk: unknown,
  ): {
    readonly ConditionExpression: string
    readonly ExpressionAttributeNames: globalThis.Record<string, string>
    readonly ExpressionAttributeValues?: globalThis.Record<string, AttributeValue>
  } => {
    const pkField = config.indexes.primary.pk.field
    if (!preserveUnique()) {
      return {
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": pkField },
      }
    }
    return {
      ConditionExpression: "attribute_not_exists(#pk) OR (#epk = :epk AND #esk = :esk)",
      ExpressionAttributeNames: {
        "#pk": pkField,
        "#epk": "_entity_pk",
        "#esk": "_entity_sk",
      },
      ExpressionAttributeValues: {
        ":epk": toAttributeValue(entityPk),
        ":esk": toAttributeValue(entitySk),
      },
    }
  }

  /** Collect all key field names (pk, sk, gsi*pk, gsi*sk) */
  const gsiKeyFields = (): ReadonlyArray<string> => {
    const fields: Array<string> = []
    for (const [indexName, indexDef] of Object.entries(allIndexes)) {
      if (indexName === "primary") continue
      fields.push(indexDef.pk.field, indexDef.sk.field)
    }
    // A half stored in a key attribute of the table isn't this index's to take away.
    return fields.filter((field) => !isTableKeyField(field))
  }

  /** Is `field` a key attribute of the table? It is the table's to hold. */
  const isTableKeyField = (field: string): boolean =>
    field === allIndexes.primary?.pk.field || field === allIndexes.primary?.sk.field

  // ---------------------------------------------------------------------------
  // Vector search — write-path helpers (see `DESIGN.md §14`)
  // ---------------------------------------------------------------------------

  const vectorIndexes = data.vectorIndexes
  const hasVectorIndexes = data.hasVectorIndexes
  const vectorIndexEntries: ReadonlyArray<readonly [string, VectorIndexDefinition]> =
    Object.entries(vectorIndexes)

  /**
   * Vector attributes a write should SET, and those it should REMOVE.
   *
   * REMOVE is how an item leaves a vector index — DynamoDB's sparse semantics
   * mean an item without the embedding (or without the composed HASH value) is
   * simply not indexed. There is no "delete from index" call.
   */
  interface VectorWriteResult {
    readonly sets: globalThis.Record<string, unknown>
    readonly removes: ReadonlyArray<string>
  }

  /**
   * Library-managed vector attribute names (embedding + composed partition).
   *
   * These join `gsiKeyFields()` in every strip set — version snapshots,
   * soft-delete tombstones, and time-series event items. DynamoDB's sparse
   * vector index semantics do the rest: an item without the vector attribute
   * (or without the HASH attribute) is simply not in the index, so stripping IS
   * the delete. See `DESIGN.md §14 Lifecycle integration`.
   */
  const vectorKeyFields = (): ReadonlyArray<string> => {
    const fields: Array<string> = []
    for (const [, definition] of vectorIndexEntries) {
      fields.push(definition.vectorField, definition.partitionField)
    }
    return fields
  }

  /**
   * Resolve the `Embedder` service from context.
   *
   * Deliberately resolved with `Effect.serviceOption` rather than a plain
   * `yield* Embedder`: only entities that declare `vectorIndexes` need one, and
   * widening every entity operation's `R` to include `Embedder` would force the
   * service on consumers who will never call it. A missing embedder surfaces as
   * a tagged {@link EmbeddingError} naming the index, not a type error at the
   * far end of the program.
   */
  const resolveEmbedder = (
    indexName: string,
  ): Effect.Effect<EmbedderService, EmbeddingError, never> =>
    Effect.flatMap(Effect.serviceOption(Embedder), (maybe) =>
      Option.isSome(maybe)
        ? Effect.succeed(maybe.value)
        : Effect.fail(
            new EmbeddingError({
              entityType,
              index: indexName,
              reason:
                `No Embedder service is available. Provide one via ` +
                `DynamoClient.make({ embedder }) or Effect.provide(Embedder.layerTest(...)), ` +
                `or supply a pre-computed vector with .withVector("${indexName}", [...]).`,
            }),
          ),
    )

  /**
   * Reject `.withVector("typo", ...)` before it silently does nothing.
   *
   * The combinator takes a plain string at runtime, and an unknown logical name
   * would otherwise be dropped by the declared-name lookup — the Embedder would
   * run anyway and the caller's supplied vector would vanish without a trace.
   * Fails fast with the list of declared names instead.
   */
  const checkWithVectorNames = (
    withVectors: globalThis.Record<string, ReadonlyArray<number>> | undefined,
    operation: string,
  ): Effect.Effect<void, ValidationError, never> => {
    if (withVectors === undefined) return Effect.void
    for (const name of Object.keys(withVectors)) {
      if (name in vectorIndexes) continue
      const declared = Object.keys(vectorIndexes).sort().join(", ")
      return Effect.fail(
        new ValidationError({
          entityType,
          operation: `${operation}.withVector`,
          cause:
            `Unknown vector index "${name}". Declared vector indexes: ` +
            `${declared.length > 0 ? declared : "(none)"}. ` +
            `\`.withVector()\` takes the LOGICAL name from Entity.make({ vectorIndexes }).`,
        }),
      )
    }
    return Effect.void
  }

  /** @internal Validate an embedding against the index's declared dimensionality. */
  const checkDimensions = (
    indexName: string,
    definition: VectorIndexDefinition,
    vector: ReadonlyArray<number>,
  ): Effect.Effect<ReadonlyArray<number>, EmbeddingError, never> =>
    vector.length === definition.dimensions
      ? Effect.succeed(vector)
      : Effect.fail(
          new EmbeddingError({
            entityType,
            index: indexName,
            reason:
              `Embedding has ${vector.length} dimensions but vector index "${definition.index}" ` +
              `declares ${definition.dimensions}. Dimensions are immutable on a DynamoDB vector index.`,
          }),
        )

  /**
   * Compute the vector + partition attributes for a full (put-style) record.
   *
   * Each index is independent and sparse: an index whose partition composites
   * or source fields are absent from the record contributes nothing, and the
   * item is simply not in that index.
   *
   * `embedFor` restricts which indexes are (re-)embedded — `"all"` on the put
   * path, a gated subset on the update path. The partition value is always
   * recomposed when it can be: it is idempotent, and writing it is what keeps
   * an item in the index.
   */
  const computeVectorAttributes = (
    record: globalThis.Record<string, unknown>,
    withVectors: globalThis.Record<string, ReadonlyArray<number>> | undefined,
    embedFor: ReadonlySet<string> | "all",
  ): Effect.Effect<VectorWriteResult, EmbeddingError, never> =>
    Effect.gen(function* () {
      const sets: globalThis.Record<string, unknown> = {}
      const removes: Array<string> = []
      for (const [logicalName, definition] of vectorIndexEntries) {
        const shouldEmbed = embedFor === "all" || embedFor.has(logicalName)
        const partition = KeyComposer.tryComposeVectorPartition(
          schema,
          entityType,
          definition,
          keyForm(record),
        )
        if (partition === undefined) {
          // No partition value ⇒ the item cannot be in the index at all. Drop
          // both attributes so a previously-indexed item leaves the index
          // rather than lingering under a stale partition.
          removes.push(definition.partitionField, definition.vectorField)
          continue
        }
        sets[definition.partitionField] = partition

        if (!shouldEmbed) continue

        const explicit = withVectors?.[logicalName]
        if (explicit !== undefined) {
          sets[definition.vectorField] = yield* checkDimensions(logicalName, definition, explicit)
          continue
        }
        const text = deriveSourceText(definition, record)
        if (text === undefined) {
          // Every source field is gone. Sparse semantics say the item should
          // leave the index — keeping the previous embedding would make it
          // findable by a description it no longer has.
          removes.push(definition.vectorField, definition.partitionField)
          delete sets[definition.partitionField]
          continue
        }
        const embedder = yield* resolveEmbedder(logicalName)
        const embedded = yield* embedder.embed(text)
        sets[definition.vectorField] = yield* checkDimensions(logicalName, definition, embedded)
      }
      return { sets, removes }
    })

  /**
   * Which vector indexes does this update require work for?
   *
   * Re-embedding fires when the write touches a `source.fields` member by ANY
   * channel — a `set()` payload entry, an `Entity.remove([...])` clearing it, or
   * a path-based operation whose root segment names it — or when the caller
   * supplied an explicit vector.
   *
   * Enumerating every channel (rather than only the SET payload) is the same
   * discipline the policy-aware GSI composer applies to `removedSet` (§7): a
   * clear is a change, and a writer that clears the source must not leave the
   * old embedding behind. Writers that touch none of it neither pay for an
   * embedding call nor clobber a vector another writer owns.
   */
  const vectorIndexesNeedingUpdate = (
    touchedFields: ReadonlySet<string>,
    withVectors: globalThis.Record<string, ReadonlyArray<number>> | undefined,
  ): ReadonlyArray<readonly [string, VectorIndexDefinition]> =>
    vectorIndexEntries.filter(
      ([logicalName, definition]) =>
        withVectors?.[logicalName] !== undefined ||
        definition.sourceFields.some((field) => touchedFields.has(field)),
    )

  /**
   * Every top-level attribute this update touches, by any channel.
   *
   * `touchesSource` alone only sees the SET payload; `remove([...])`, null
   * clears and path-based operations are just as capable of invalidating an
   * embedding, so they all feed the same set.
   */
  const collectTouchedFields = (
    updatePayload: globalThis.Record<string, unknown>,
    uState: UpdateState,
  ): ReadonlySet<string> => {
    const touched = new Set<string>(Object.keys(updatePayload))
    for (const attr of uState.remove ?? []) touched.add(attr)
    const pathOps: ReadonlyArray<ReadonlyArray<{ segments: ReadonlyArray<string | number> }>> = [
      uState.pathSets ?? [],
      uState.pathAdds ?? [],
      uState.pathSubtracts ?? [],
      uState.pathAppends ?? [],
      uState.pathPrepends ?? [],
      uState.pathIfNotExists ?? [],
      uState.pathDeletes ?? [],
    ]
    for (const ops of pathOps) {
      for (const op of ops) {
        const root = op.segments[0]
        if (typeof root === "string") touched.add(root)
      }
    }
    for (const segments of uState.pathRemoves ?? []) {
      const root = segments[0]
      if (typeof root === "string") touched.add(root)
    }
    return touched
  }

  /**
   * Compute vector-related SET / REMOVE attributes for the standard
   * (UpdateItem) path.
   *
   * When re-embedding is required and the payload does not carry every source
   * field, the current item is read once so the embedding is derived from the
   * complete post-update source text rather than the fragment that happened to
   * be in this payload. Attributes the update clears (via `remove([...])` or a
   * null payload entry) are subtracted from that merged record, so "clear the
   * description" produces the embedding of what actually remains — or drops the
   * item out of the index when nothing does.
   */
  const computeVectorUpdateAttributes = (
    encodedKey: globalThis.Record<string, unknown>,
    marshalledKey: globalThis.Record<string, AttributeValue>,
    tableName: string,
    updatePayload: globalThis.Record<string, unknown>,
    uState: UpdateState,
  ): Effect.Effect<
    VectorWriteResult,
    EmbeddingError | DynamoClientError | ValidationError,
    DynamoClient
  > =>
    Effect.gen(function* () {
      if (!hasVectorIndexes) return { sets: {}, removes: [] }
      const withVectors = uState.withVectors
      const touchedFields = collectTouchedFields(updatePayload, uState)
      const needing = vectorIndexesNeedingUpdate(touchedFields, withVectors)
      const clearedFields = new Set<string>(uState.remove ?? [])
      for (const [attr, value] of Object.entries(updatePayload)) {
        if (value === null || value === undefined) clearedFields.add(attr)
      }

      // Base record: key composites plus whatever the payload supplies. Enough
      // to compose partition values (their composites are normally primary-key
      // members) without any extra read.
      let merged: globalThis.Record<string, unknown> = { ...encodedKey, ...updatePayload }

      const needsFullSource = needing.some(
        ([logicalName, definition]) =>
          withVectors?.[logicalName] === undefined &&
          definition.sourceFields.some((field) => !(field in merged)),
      )
      if (needsFullSource) {
        const client = yield* Capacity.client
        const current = yield* client.getItem({ TableName: tableName, Key: marshalledKey })
        if (current.Item) {
          const currentDomain = fromAttributeMap(current.Item) as globalThis.Record<string, unknown>
          // Packed fields are read by their stored form: the source text is
          // derived from the value, not its JSON string or compressed bytes.
          yield* unpackFields(currentDomain, "update.vector")
          deserializeSparseFields(currentDomain)
          renameFromDynamo(currentDomain)
          merged = { ...currentDomain, ...merged }
        }
      }
      // Cleared attributes are absent post-update, whichever channel cleared
      // them — the same two-way classification the GSI composer uses (§7).
      for (const attr of clearedFields) delete merged[attr]

      const sets: globalThis.Record<string, unknown> = {}
      const removes: Array<string> = []
      for (const [logicalName, definition] of vectorIndexEntries) {
        const isNeeded = needing.some(([name]) => name === logicalName)
        // Partition value: idempotent and cheap, so recompose whenever the
        // merged record can supply it (same reasoning as the PK-composites-only
        // GSI shape in §7).
        const partition = KeyComposer.tryComposeVectorPartition(
          schema,
          entityType,
          definition,
          keyForm(merged),
        )
        if (partition === undefined) {
          // Only drop the partition when THIS writer invalidated it. Otherwise
          // the composite simply wasn't in scope for this call and dropping it
          // would be the multi-writer clobber the §7 gate exists to prevent.
          if (definition.partition.some((attr) => clearedFields.has(attr))) {
            removes.push(definition.partitionField, definition.vectorField)
          }
          continue
        }
        sets[definition.partitionField] = partition

        if (!isNeeded) continue
        const explicit = withVectors?.[logicalName]
        if (explicit !== undefined) {
          sets[definition.vectorField] = yield* checkDimensions(logicalName, definition, explicit)
          continue
        }
        const text = deriveSourceText(definition, merged)
        if (text === undefined) {
          removes.push(definition.vectorField, definition.partitionField)
          delete sets[definition.partitionField]
          continue
        }
        const embedder = yield* resolveEmbedder(logicalName)
        const embedded = yield* embedder.embed(text)
        sets[definition.vectorField] = yield* checkDimensions(logicalName, definition, embedded)
      }
      return { sets, removes }
    })

  // ---------------------------------------------------------------------------
  // Update concurrency and return values (#133)
  // ---------------------------------------------------------------------------

  /**
   * What proves an item is the same INCARNATION as the one read — not a
   * deleted-and-recreated item at the same version: a hidden per-incarnation
   * token, `__edd_i__`, a random UUID set when the item is created (put,
   * create, upsert, batch / transaction put). `createdAt` would not do: two
   * creates in the same millisecond, or a caller-supplied value, repeat it.
   * Only versioned entities need it — their version CAS is what it completes.
   */
  const incarnationAttr: string | undefined = systemFields.version ? INCARNATION_TOKEN : undefined
  const stampsIncarnation = incarnationAttr === INCARNATION_TOKEN
  const freshIncarnation = freshIncarnationToken

  /**
   * The condition (and its names / values) proving the stored item is still
   * the incarnation `read` — `undefined` when the entity needs no proof.
   */
  const incarnationGuard = (
    read: globalThis.Record<string, AttributeValue>,
    names: globalThis.Record<string, string>,
    values: globalThis.Record<string, AttributeValue>,
  ): string | undefined => {
    if (incarnationAttr === undefined) return undefined
    names["#inc"] = incarnationAttr
    const value = read[incarnationAttr]
    if (value === undefined) return "attribute_not_exists(#inc)"
    values[":inc"] = value
    return "#inc = :inc"
  }

  /**
   * The version an item is stored at: `undefined` for no item, 0 for an item
   * written before the entity was `versioned` (it has no version attribute;
   * real versions start at 1).
   */
  const storedVersionOf = (
    item: Readonly<globalThis.Record<string, unknown>> | undefined,
  ): number | undefined => {
    if (item === undefined || !systemFields.version) return undefined
    const attr = item[systemFields.version]
    return attr !== undefined ? Number((attr as { readonly N?: string }).N) : 0
  }

  /**
   * A version-snapshot Put that never overwrites history (#133). The
   * `v#<version>` row may already exist only as a snapshot of the SAME state —
   * a retain `put` writes `v#0000001` and the first update snapshots that same
   * version 1 state again; a restore re-writes the delete-time snapshot — so
   * the row is replaced only when it holds the same version, the same
   * incarnation and (with timestamps) the same `updatedAt`. Any other row is a
   * different history, and the write is refused.
   */
  const snapshotPut = (tableName: string, snapshotItem: globalThis.Record<string, unknown>) =>
    storedSnapshotPut(tableName, toAttributeMap(snapshotItem))
  /** {@link snapshotPut} of a snapshot as stored: one moving from other key text (#171). */
  const storedSnapshotPut = (
    tableName: string,
    item: globalThis.Record<string, AttributeValue>,
  ) => {
    const same = sameSnapshotAs(item)
    return {
      TableName: tableName,
      Item: item,
      ConditionExpression: `attribute_not_exists(#snap) OR (${same.expression})`,
      ExpressionAttributeNames: same.names,
      ...(Object.keys(same.values).length > 0 && { ExpressionAttributeValues: same.values }),
    }
  }
  /**
   * The condition that a stored snapshot is the same state as `item`, a
   * snapshot as stored: the same version, incarnation and (with timestamps)
   * `updatedAt` (#133). `#snap` names the partition key, for the caller's
   * existence check.
   */
  const sameSnapshotAs = (item: globalThis.Record<string, AttributeValue>) => {
    const names: globalThis.Record<string, string> = { "#snap": config.indexes.primary.pk.field }
    const values: globalThis.Record<string, AttributeValue> = {}
    const same: Array<string> = []
    if (systemFields.version) {
      const version = item[systemFields.version]?.N
      same.push(
        versionIs(
          version === undefined ? 0 : Number(version),
          names,
          values,
          "#snapVer",
          ":snapVer",
        ),
      )
    }
    const sameAs = (attr: string, tag: string) => {
      names[`#${tag}`] = attr
      const value = item[attr]
      if (value === undefined) {
        same.push(`attribute_not_exists(#${tag})`)
      } else {
        values[`:${tag}`] = value
        same.push(`#${tag} = :${tag}`)
      }
    }
    sameAs(INCARNATION_TOKEN, "snapInc")
    if (systemFields.updatedAt) sameAs(systemFields.updatedAt, "snapUpd")
    return { expression: same.join(" AND "), names, values }
  }
  /** A version snapshot Put refused: that version's history row already exists. */
  const historyConflict = (version: number, operation: string): ValidationError =>
    new ValidationError({
      entityType,
      operation,
      cause:
        `The ${entityType} version ${version} snapshot already exists: the item's version is ` +
        "inconsistent with its history, and history is never overwritten. The write was not made.",
    })

  /**
   * The condition that the stored version is `version` — for version 0 (an
   * item written before the entity was `versioned`), that it has none (#133).
   */
  const versionIs = (
    version: number,
    names: globalThis.Record<string, string>,
    values: globalThis.Record<string, AttributeValue>,
    name: string,
    value: string,
  ): string => {
    names[name] = systemFields.version!
    if (version === 0) return `attribute_not_exists(${name})`
    values[value] = toAttributeValue(version)
    return `${name} = ${value}`
  }

  /**
   * Which predicate rejected a version-conditioned (or user-conditioned)
   * write. The write asked for `ReturnValuesOnConditionCheckFailure: "ALL_OLD"`,
   * so DynamoDB hands back the item as stored: a version other than the one
   * the write was conditioned on — or another incarnation at that version — is
   * a lost race; otherwise the user's `.condition()` rejected it. No item back
   * means the item is gone — a race when the write was version-conditioned.
   */
  const conditionRejection = (
    key: globalThis.Record<string, unknown>,
    stored: Readonly<globalThis.Record<string, unknown>> | undefined,
    cas:
      | {
          /** `undefined`: the item read had no version (written before `versioned`). */
          readonly version: number | undefined
          /** The item read, when the write also proved its incarnation. */
          readonly read?: globalThis.Record<string, AttributeValue> | undefined
        }
      | undefined,
    userCondition: boolean,
  ): OptimisticLockError | ConditionalCheckFailed => {
    const storedVersion = storedVersionOf(stored)
    const otherIncarnation =
      cas?.read !== undefined &&
      incarnationAttr !== undefined &&
      !attributeValueEquals(
        stored?.[incarnationAttr] as AttributeValue | undefined,
        cas.read[incarnationAttr],
      )
    if (
      (cas !== undefined && (storedVersion !== cas.version || otherIncarnation)) ||
      !userCondition
    ) {
      return new OptimisticLockError({
        entityType,
        key,
        expectedVersion: cas?.version ?? -1,
        actualVersion: storedVersion ?? -1,
      })
    }
    return new ConditionalCheckFailed({ entityType, key })
  }

  /** The domain field a stored attribute holds (`storedAs` renames reversed). */
  const domainNameOf = (attr: string): string =>
    Object.keys(data.modelFields as object).find((field) => resolveDbName(field) === attr) ?? attr

  /**
   * The condition a read-then-write DELETE carries (#133): the item is still
   * what the tombstone, snapshot and sentinel deletes were derived from.
   * Versioned: its version and incarnation. Otherwise: it exists and every
   * attribute in `dependsOn` still holds the value read (absent ones still
   * absent). `"item"` means the whole item — a tombstone copies all of it —
   * so every stored attribute is guarded, plus every attribute the entity
   * knows of that was absent; an item too wide for that falls back to the
   * strongest guard within DynamoDB's expression limit (never a refusal). A
   * guard that cannot fit beside `others` at all is sent as it is: DynamoDB
   * rejects the expression, and the rejection is diagnosed (#144).
   */
  const deleteGuard = (
    read: globalThis.Record<string, AttributeValue>,
    dependsOn: "item" | ReadonlyArray<string>,
    /** The rest of the condition, ANDed with the guard (the user's, …). */
    others: string | undefined,
  ): {
    readonly expression: string
    readonly names: globalThis.Record<string, string>
    readonly values: globalThis.Record<string, AttributeValue>
    readonly inputs: ReadonlyArray<string>
  } => {
    // Whether a guard fits beside `others` within DynamoDB's real limits.
    const fits = (guard: string) =>
      expressionFits(others === undefined || others === "" ? guard : `${guard} AND (${others})`)
    const names: globalThis.Record<string, string> = {}
    const values: globalThis.Record<string, AttributeValue> = {}
    const parts: Array<string> = []
    const pkField = config.indexes.primary.pk.field
    const skField = config.indexes.primary.sk.field
    if (systemFields.version) {
      names["#dver"] = systemFields.version
      // An item written before the entity was `versioned` has no version.
      const readVersion = read[systemFields.version]
      if (readVersion === undefined) {
        parts.push("attribute_not_exists(#dver)")
      } else {
        values[":dver"] = readVersion
        parts.push("#dver = :dver")
      }
      const incarnation = incarnationGuard(read, names, values)
      if (incarnation !== undefined) parts.push(incarnation)
      return { expression: parts.join(" AND "), names, values, inputs: [] }
    }
    names["#dpk"] = pkField
    parts.push("attribute_exists(#dpk)")
    const attrs =
      dependsOn === "item"
        ? [
            ...new Set([
              ...Object.keys(read),
              ...Object.keys(data.modelFields as object).map(resolveDbName),
              ...[systemFields.createdAt, systemFields.updatedAt].filter(
                (f): f is string => typeof f === "string",
              ),
              ...gsiKeyFields(),
              ...vectorKeyFields(),
            ]),
          ].filter((attr) => attr !== pkField && attr !== skField)
        : dependsOn
    const guardOf = (attr: string, i: number): string => {
      names[`#dg${i}`] = attr
      if (read[attr] === undefined) return `attribute_not_exists(#dg${i})`
      values[`:dg${i}`] = read[attr]!
      return `#dg${i} = :dg${i}`
    }
    const full = [...parts, ...attrs.map(guardOf)].join(" AND ")
    if (fits(full)) return { expression: full, names, values, inputs: attrs }
    // Too wide to guard attribute by attribute (a sparse map with hundreds of
    // entries): the strongest guard that fits. Every library write sets
    // `updatedAt`, so with timestamps it alone detects any library update;
    // then as many attributes as fit, those the sentinels derive from first,
    // then the model's own fields, then the rest.
    const strongest = () => {
      for (const key of Object.keys(names)) if (key.startsWith("#dg")) delete names[key]
      for (const key of Object.keys(values)) if (key.startsWith(":dg")) delete values[key]
      const uniqueAttrs = Object.values(config.unique ?? {}).flatMap((def) =>
        resolveUniqueFields(def as UniqueConstraintDef).map(resolveDbName),
      )
      const modelAttrs = Object.keys(data.modelFields as object).map(resolveDbName)
      const ordered = [
        ...new Set([
          ...(systemFields.updatedAt ? [systemFields.updatedAt] : []),
          ...uniqueAttrs,
          ...modelAttrs,
          ...attrs.slice().sort(),
        ]),
      ].filter((attr) => attrs.includes(attr))
      const inputs: Array<string> = []
      let expression = parts.join(" AND ")
      for (const attr of ordered) {
        const clause = guardOf(attr, inputs.length)
        if (!fits(`${expression} AND ${clause}`)) {
          delete names[`#dg${inputs.length}`]
          delete values[`:dg${inputs.length}`]
          continue
        }
        expression = `${expression} AND ${clause}`
        inputs.push(attr)
      }
      return { expression, names, values, inputs }
    }
    if (systemFields.updatedAt && attrs.includes(systemFields.updatedAt)) return strongest()
    // Nothing guarded that every write changes: the switch point decides.
    switch (unprovableRow()) {
      case "strongest":
        return strongest()
    }
  }

  /** Which predicate rejected a guarded delete — from the stored item (ALL_OLD). */
  const deleteRejection = (
    key: globalThis.Record<string, unknown>,
    read: globalThis.Record<string, AttributeValue>,
    inputs: ReadonlyArray<string>,
    stored: Readonly<globalThis.Record<string, unknown>> | undefined,
    userCondition: boolean,
  ): ItemNotFound | OptimisticLockError | ConcurrentModification | ConditionalCheckFailed => {
    if (stored === undefined) return new ItemNotFound({ entityType, key })
    if (systemFields.version) {
      return conditionRejection(
        key,
        stored,
        { version: storedVersionOf(read), read },
        userCondition,
      )
    }
    const changed = inputs.filter(
      (attr) => !attributeValueEquals(stored[attr] as AttributeValue | undefined, read[attr]),
    )
    if (changed.length === 0 && userCondition)
      return new ConditionalCheckFailed({ entityType, key })
    return new ConcurrentModification({
      entityType,
      key,
      attributes: changed.map(domainNameOf),
      current: Option.none(),
    })
  }

  /** The item at a key, strongly consistent: the read a read-then-write op starts with. */
  const readCurrent = (
    tableName: string,
    marshalledKey: globalThis.Record<string, AttributeValue>,
  ) =>
    Effect.flatMap(Capacity.client, (client) =>
      client.getItem({ TableName: tableName, Key: marshalledKey, ConsistentRead: true }),
    )

  /** Fill a `ConcurrentModification`'s `current` with the stored item, decoded. */
  const withCurrentItem = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    stored: () => globalThis.Record<string, AttributeValue> | undefined,
  ) =>
    effect.pipe(
      Effect.catchIf(
        (e): e is E & ConcurrentModification => e instanceof ConcurrentModification,
        (e) =>
          Effect.gen(function* () {
            const item = stored()
            const current =
              item === undefined
                ? Option.none()
                : yield* Effect.option(
                    decodeAs(
                      fromAttributeMap(item) as globalThis.Record<string, unknown>,
                      item,
                      "model",
                    ),
                  )
            return yield* keepReleaseRace(e, new ConcurrentModification({ ...e, current }))
          }),
      ),
    )

  /**
   * The item a retain path update wrote, read back after its transaction. The
   * write is proven by version AND incarnation: within one incarnation a
   * version is written exactly once, so the live item is ours while it holds
   * our version and incarnation; once a later write replaced it, the
   * `v#<ourVersion>` snapshot that write took is ours — if it carries our
   * incarnation (a snapshot left by an earlier incarnation of the item does
   * not). It is restored to item shape: what a snapshot strips (index and
   * vector attributes) or adds (its sort key and TTL) comes from the item we
   * replaced plus this update's own writes. Without a proven post-image the
   * update still WAS applied: {@link UpdateAppliedButUnreadable}.
   */
  const readRetainPostImage = (
    tableName: string,
    marshalledKey: globalThis.Record<string, AttributeValue>,
    replaced: globalThis.Record<string, AttributeValue>,
    ourVersion: number,
    ourIncarnation: AttributeValue | undefined,
    derivedSets: globalThis.Record<string, AttributeValue>,
    derivedRemoves: ReadonlySet<string>,
    ttlAttrName: string,
    encodedKey: globalThis.Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const ours = (item: globalThis.Record<string, AttributeValue> | undefined) =>
        item !== undefined &&
        (incarnationAttr === undefined ||
          attributeValueEquals(item[incarnationAttr], ourIncarnation))
      const current = (yield* client.getItem({
        TableName: tableName,
        Key: marshalledKey,
        ConsistentRead: true,
      })).Item
      if (storedVersionOf(current) === ourVersion && ours(current)) return current!
      const skField = config.indexes.primary.sk.field
      const snapshot = (yield* client.getItem({
        TableName: tableName,
        Key: {
          ...marshalledKey,
          [skField]: toAttributeValue(
            DynamoSchema.composeVersionKey(
              schema,
              entityType,
              ourVersion,
              historyKeyOptions(marshalledKey[skField]?.S),
            ),
          ),
        },
        ConsistentRead: true,
      })).Item
      if (!ours(snapshot)) {
        return yield* new UpdateAppliedButUnreadable({
          entityType,
          key: encodedKey,
          version: ourVersion,
          reason:
            current === undefined
              ? "the item was deleted before it could be read back"
              : `the item moved past version ${ourVersion}, and no snapshot of this write ` +
                "remains to read it from",
        })
      }
      const post: globalThis.Record<string, AttributeValue> = { ...snapshot! }
      post[skField] = marshalledKey[skField]!
      const restored = [
        ...gsiKeyFields(),
        ...vectorKeyFields(),
        ...vectorIndexEntries.map(([, definition]) => definition.stashField),
        ...(retainTtl() ? [ttlAttrName] : []),
      ]
      for (const field of restored) {
        delete post[field]
        if (replaced[field] !== undefined) post[field] = replaced[field]
      }
      Object.assign(post, derivedSets)
      for (const field of derivedRemoves) delete post[field]
      return post
    })

  /**
   * Decode only `attributes` of a stored image (`updatedOld` / `updatedNew`):
   * a partial — the fields present, each through its own schema.
   */
  const decodePartial = (
    image: globalThis.Record<string, AttributeValue> | undefined,
    attributes: ReadonlySet<string>,
    mode: DecodeMode,
  ) => {
    const corruption = versionCorruption(image, "decode")
    if (corruption !== undefined) return Effect.fail(corruption)
    const projected: globalThis.Record<string, AttributeValue> = {}
    for (const [attr, value] of Object.entries(image ?? {})) {
      if (attributes.has(attr)) projected[attr] = value
    }
    if (mode === "native") return Effect.succeed(projected)
    const raw = fromAttributeMap(projected) as globalThis.Record<string, unknown>
    return Effect.flatMap(unpackFields(raw), () => {
      deserializeSparseFields(raw)
      renameFromDynamo(raw)
      const target =
        mode === "model"
          ? schemas.modelSchema
          : mode === "record"
            ? schemas.recordSchema
            : schemas.itemSchema
      const fields = (target as unknown as { readonly fields: Schema.Struct.Fields }).fields
      const present = Object.fromEntries(Object.entries(fields).filter(([name]) => name in raw))
      return Schema.decodeUnknownEffect(Schema.Struct(present) as unknown as Schema.Codec<any>)(
        raw,
      ).pipe(
        Effect.mapError((cause) => new ValidationError({ entityType, operation: "decode", cause })),
      )
    })
  }
  /**
   * The value an update returns for its `returnValues` mode, from the item
   * before (`old`) and after (`next`) it, and the attributes it wrote:
   * `none` → `undefined`; `allOld` / `allNew` → the whole item; `updatedOld` /
   * `updatedNew` → just the written attributes, decoded as a partial.
   */
  const updateResult = (
    rv: ReturnValuesMode,
    old: globalThis.Record<string, AttributeValue> | undefined,
    next: globalThis.Record<string, AttributeValue> | undefined,
    written: ReadonlySet<string>,
    mode: DecodeMode,
    encodedKey: globalThis.Record<string, unknown>,
  ): Effect.Effect<unknown, ValidationError | ItemNotFound> => {
    const landed = rv === "allOld" || rv === "updatedOld" ? "replaced" : "stored"
    switch (rv) {
      case "none":
        return Effect.succeed(undefined)
      case "updatedOld":
        return appliedUpdate(decodePartial(old, written, mode), landed)
      case "updatedNew":
        return appliedUpdate(decodePartial(next, written, mode), landed)
      default: {
        const image = rv === "allOld" ? old : next
        if (image === undefined)
          return Effect.fail(new ItemNotFound({ entityType, key: encodedKey }))
        return appliedUpdate(
          decodeAs(fromAttributeMap(image) as globalThis.Record<string, unknown>, image, mode),
          landed,
        )
      }
    }
  }

  /**
   * A row that won't decode after its update has landed. The write can't be judged
   * before it's sent: `.subtract()`, `.add()`, `.append()` and the path operations are
   * DynamoDB's to apply to a value only it holds, and a read to check them would cost
   * every update. So the failure says what happened, or a caller reads "validation
   * failed" as "nothing changed".
   */
  const appliedUpdate = <A>(
    decoding: Effect.Effect<A, ValidationError>,
    row: "stored" | "replaced",
  ): Effect.Effect<A, ValidationError> =>
    Effect.mapError(decoding, (error) => {
      const problem = decodeProblem(error.cause)
      return new ValidationError({
        entityType,
        operation: "update",
        cause:
          row === "stored"
            ? `The update WAS applied, and the stored row no longer matches the model: ${problem} ` +
              "An update that changes a value relative to what's stored (.add, .subtract, " +
              ".append, the path operations) isn't checked against the model. Guard it with " +
              ".condition()."
            : `The update WAS applied, but the row it replaced doesn't match the model: ${problem}`,
      })
    })

  /**
   * The history keys (version snapshots, soft-delete tombstones) of the item
   * whose live sort key is `liveSk` (#133). An entity whose primary sort key
   * has composites holds several items per partition, so each item's history
   * keys carry its segment — the composite part of `liveSk` — and items never
   * share a version sequence, a snapshot or a tombstone. Without sort key
   * composites there is one item per partition and no segment: the keys are
   * byte-identical to the partition-wide ones every earlier release wrote.
   */
  const historyKeyOptions = (liveSk: unknown): DynamoSchema.HistoryKeyOptions | undefined => {
    if (typeof liveSk !== "string") return undefined
    const item = KeyComposer.composeHistoryItemSegment(
      schema,
      entityType,
      entityVersion,
      config.indexes.primary,
      liveSk,
    )
    return item === undefined ? undefined : { item }
  }
  /**
   * See {@link Entity._liveRows}. A row is dropped only when it is positively
   * history: its sort key is not the one its own composites compose (or they
   * don't compose) AND it has the layout of a snapshot (`#v#…<version>`), a
   * tombstone (`#deleted#…<timestamp>`) or a time-series event (`#e#` under
   * the live key). Any other row is kept and decoded as before — including
   * rows an earlier release keyed differently (an unpadded number composite),
   * which the current composer can't reproduce.
   */
  const liveRows = (): Query.LiveRows | undefined => {
    if (!isRetainEnabled() && !isSoftDeleteEnabled() && config.timeSeries === undefined) {
      return undefined
    }
    const primary = config.indexes.primary
    const skField = primary.sk.field
    const compositeAttrs = primary.sk.composite.map(resolveDbName)
    const versions = DynamoSchema.composeVersionKeyPrefix(schema, entityType)
    const tombstones = DynamoSchema.composeDeletedKeyPrefix(schema, entityType)
    const bare = KeyComposer.composeSk(
      schema,
      entityType,
      entityVersion,
      { ...primary, sk: { ...primary.sk, composite: [] } },
      keyForm({}),
    )
    const eventMarker = KeyComposer.composeEventSkPrefix("", schema.casing)
    const historyShaped = (sk: string): boolean =>
      (isRetainEnabled() &&
        sk.startsWith(versions) &&
        /^(?:.*#)?\d{7,}$/.test(sk.slice(versions.length))) ||
      (isSoftDeleteEnabled() &&
        sk.startsWith(tombstones) &&
        /^(?:.*#)?\d{4}-\d\d-\d\dT[^#]*$/.test(sk.slice(tombstones.length))) ||
      (config.timeSeries !== undefined &&
        sk.startsWith(bare) &&
        sk.slice(bare.length).includes(eventMarker))
    return {
      isLive: (row) => {
        const sk = row[skField]?.S
        if (sk === undefined) return true
        // Only the composites are unmarshalled: the row may be large.
        const composites: globalThis.Record<string, AttributeValue> = {}
        for (const attr of compositeAttrs) {
          const value = row[attr]
          if (value !== undefined) composites[attr] = value
        }
        try {
          if (liveSkOf(toDomainView(fromAttributeMap(composites))) === sk) return true
        } catch {
          // Not composable now: judged by its layout alone.
        }
        return !historyShaped(sk)
      },
      reads: [skField, ...compositeAttrs],
    }
  }
  // ---------------------------------------------------------------------------
  // History an earlier release wrote without an item segment (#133)
  // ---------------------------------------------------------------------------

  /**
   * Whether the entity's history keys carry an item segment — its primary sort
   * key has composites. Only then can history an earlier release wrote, under
   * the partition-wide keys (`#v#0000003`, `#deleted#<ts>`), be in the
   * partition: every reader of one item's history also reads those rows, and
   * takes the ones whose stored composites compose the item's live key. A
   * version held both ways is read from the segmented row.
   */
  const hasItemHistory = config.indexes.primary.sk.composite.length > 0
  /** Whether a stored (attribute-keyed) row is the history of the item at `liveSk`. */
  const isItemsRow = (row: globalThis.Record<string, AttributeValue>, liveSk: string): boolean => {
    try {
      return liveSkOf(toDomainView(fromAttributeMap(row))) === liveSk
    } catch {
      return false
    }
  }
  /**
   * The item's unsegmented history rows of one kind, in sort key order (latest
   * first with `descending`), stopping at the first with `first`. Unsegmented
   * rows sort before every segmented one — a version or timestamp starts with
   * a digit, a segment with a composite name — so a key range bounds them.
   */
  const legacyHistory = (args: {
    readonly tableName: string
    readonly pk: unknown
    readonly liveSk: string
    readonly kind: "version" | "deleted"
    readonly descending?: boolean
    readonly first?: boolean
  }) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const primary = config.indexes.primary
      const prefix =
        args.kind === "version"
          ? DynamoSchema.composeVersionKeyPrefix(schema, entityType)
          : DynamoSchema.composeDeletedKeyPrefix(schema, entityType)
      const range = {
        TableName: args.tableName,
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lo AND :hi",
        ExpressionAttributeNames: { "#pk": primary.pk.field, "#sk": primary.sk.field },
        ExpressionAttributeValues: {
          ":pk": toAttributeValue(args.pk),
          ":lo": toAttributeValue(`${prefix}0`),
          ":hi": toAttributeValue(`${prefix}:`),
        },
        ConsistentRead: true,
      }
      // The common case — a partition no earlier release wrote history into —
      // costs one `Limit 1` keys-only read. (A row it finds may still be
      // segmented, if a segment starts with a digit; the read below filters.)
      const probe = yield* client.query({ ...range, ProjectionExpression: "#sk", Limit: 1 })
      if ((probe.Items ?? []).length === 0) return []
      const rows: Array<globalThis.Record<string, AttributeValue>> = []
      let start: globalThis.Record<string, AttributeValue> | undefined
      do {
        const result = yield* client.query({
          ...range,
          ScanIndexForward: !args.descending,
          ExclusiveStartKey: start,
        })
        for (const row of result.Items ?? []) {
          const sk = row[primary.sk.field]?.S ?? ""
          if (sk.slice(prefix.length).includes("#")) continue
          if (!isItemsRow(row, args.liveSk)) continue
          rows.push(row)
          if (args.first) return rows
        }
        start = result.LastEvaluatedKey as globalThis.Record<string, AttributeValue> | undefined
      } while (start !== undefined)
      return rows
    })
  /** The version a history sort key ends with. */
  const versionOfSk = (sk: string | undefined): number => {
    if (sk === undefined) return 0
    const version = Number(sk.slice(sk.lastIndexOf("#") + 1))
    return Number.isInteger(version) ? version : 0
  }
  /**
   * The item's latest tombstone — its own, or one an earlier release wrote
   * without a segment, whichever is later (its own on a tie).
   */
  const latestTombstone = (tableName: string, pk: unknown, liveSk: string) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const primary = config.indexes.primary
      const read = yield* client.query({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#pk": primary.pk.field, "#sk": primary.sk.field },
        ExpressionAttributeValues: {
          ":pk": toAttributeValue(pk),
          ":skPrefix": toAttributeValue(
            DynamoSchema.composeDeletedKeyPrefix(schema, entityType, historyKeyOptions(liveSk)),
          ),
        },
        ScanIndexForward: false,
        Limit: 1,
      })
      const own = read.Items?.[0]
      if (!hasItemHistory) return own
      const [legacy] = yield* legacyHistory({
        tableName,
        pk,
        liveSk,
        kind: "deleted",
        descending: true,
        first: true,
      })
      if (legacy === undefined) return own
      if (own === undefined) return legacy
      const stamp = (row: globalThis.Record<string, AttributeValue>) => {
        const sk = row[primary.sk.field]?.S ?? ""
        return sk.slice(sk.lastIndexOf("#") + 1)
      }
      return stamp(legacy) > stamp(own) ? legacy : own
    })
  /** The live sort key of the item at `encodedKey` (the caller's key, encoded). */
  const liveSkOf = (encodedKey: unknown): string =>
    KeyComposer.composeSk(
      schema,
      entityType,
      entityVersion,
      config.indexes.primary,
      keyForm(encodedKey as globalThis.Record<string, unknown>),
    )

  /**
   * Build a version snapshot item: same PK, version SK, stripped GSI keys,
   * keeps __edd_e__ for entity type filtering.
   *
   * The TTL attribute name is resolved from the caller's TableConfig and
   * passed in — the snapshot belongs to the same physical table, so it must
   * align with that table's `TimeToLiveSpecification.AttributeName`.
   */
  const buildSnapshotItem = (
    item: globalThis.Record<string, unknown>,
    version: number,
    _tablePkField: string,
    tableSkField: string,
    ttlAttrName: string,
    now: DateTime.Utc,
    /** The item's live sort key, when `item` is not the live item (a tombstone). */
    liveSk: unknown = item[tableSkField],
  ): globalThis.Record<string, unknown> => {
    const snapshot: globalThis.Record<string, unknown> = { ...item }

    // Strip GSI key fields — snapshots must not appear in index queries
    for (const field of gsiKeyFields()) {
      delete snapshot[field]
    }
    // Same for vector + partition attributes — a snapshot is never an ANN hit.
    for (const field of vectorKeyFields()) {
      delete snapshot[field]
    }
    // And the soft-delete STASH. It is not an indexed attribute, so nothing
    // above touches it, but `restore` builds its snapshot from the tombstone —
    // which is exactly where the stash lives — so without this the `#v#N` row
    // ends up carrying the full embedding blob that the delete-time snapshot at
    // the same SK never had. A snapshot never re-enters the index, so it has no
    // use for a stashed embedding either.
    for (const [, definition] of vectorIndexEntries) {
      delete snapshot[definition.stashField]
    }

    // Replace SK with version SK
    snapshot[tableSkField] = DynamoSchema.composeVersionKey(
      schema,
      entityType,
      version,
      historyKeyOptions(liveSk),
    )

    // Add optional TTL
    const ttl = snapshotTtl()
    if (ttl) {
      snapshot[ttlAttrName] = DateTime.toEpochSeconds(now) + normalizeTtlSeconds(ttl)
    }

    return snapshot
  }

  // ---------------------------------------------------------------------------
  // Multi-item write support for the transact compile path (#113)
  // ---------------------------------------------------------------------------

  /**
   * Which parts of this entity's write contract need more than one item.
   * Drives both the `put` expansion and the `delete` / `Batch.write` rejections.
   */
  const multiItemWriteFeatures = (): ReadonlyArray<"unique" | "retain" | "softDelete"> => {
    const features: Array<"unique" | "retain" | "softDelete"> = []
    if (config.unique != null && Object.keys(config.unique).length > 0) features.push("unique")
    if (isRetainEnabled()) features.push("retain")
    if (isSoftDeleteEnabled()) features.push("softDelete")
    return features
  }

  // ---------------------------------------------------------------------------
  // Unique sentinels: reservation and release (#133)
  // ---------------------------------------------------------------------------

  /**
   * The sentinel item reserving `key` for the item at `owner`. `_entity_pk` /
   * `_entity_sk` name the reserving item — the back-pointer a release checks
   * (see {@link ownedSentinels}).
   */
  const sentinelItemFor = (
    constraintName: string,
    constraintDef: UniqueConstraintDef,
    key: { readonly pk: string; readonly sk: string },
    owner: { readonly pk: unknown; readonly sk: unknown },
    now: DateTime.Utc,
    ttlAttrName: string,
  ): globalThis.Record<string, unknown> => {
    const sentinel: globalThis.Record<string, unknown> = {
      [config.indexes.primary.pk.field]: key.pk,
      [config.indexes.primary.sk.field]: key.sk,
      __edd_e__: `${entityType}._unique.${constraintName}`,
      _entity_pk: owner.pk,
      _entity_sk: owner.sk,
    }
    // Optional TTL — when the constraint declares one, the sentinel
    // auto-expires (time-bounded uniqueness reservation/hold).
    const uniqueTtl = resolveUniqueTtl(constraintDef)
    if (uniqueTtl !== undefined) {
      sentinel[ttlAttrName] = DateTime.toEpochSeconds(now) + normalizeTtlSeconds(uniqueTtl)
    }
    return sentinel
  }

  /**
   * The sentinels among `candidates` that the item at `owner` holds, read
   * consistently (#133). An item can hold a unique value WITHOUT owning its
   * sentinel: the constraint was added after the item was written, the item
   * was written outside the library, or a `ttl`'d reservation expired and
   * another item then claimed the value. That other item owns the sentinel
   * now — its `_entity_pk` / `_entity_sk` name it — and releasing the
   * sentinel by key alone would delete its reservation and let the value be
   * taken twice. So a write releases only the sentinels this returns, each
   * under {@link sentinelRelease}.
   */
  const ownedSentinels = <K extends { readonly pk: string; readonly sk: string }>(
    tableName: string,
    candidates: ReadonlyArray<K>,
    owner: { readonly pk: unknown; readonly sk: unknown },
  ): Effect.Effect<ReadonlyArray<K>, DynamoClientError, DynamoClient> =>
    Effect.gen(function* () {
      if (candidates.length === 0) return []
      const client = yield* Capacity.client
      const pkField = config.indexes.primary.pk.field
      const skField = config.indexes.primary.sk.field
      const ownerPk = toAttributeValue(owner.pk)
      const ownerSk = toAttributeValue(owner.sk)
      const reads = yield* Effect.forEach(
        candidates,
        (key) =>
          client.getItem({
            TableName: tableName,
            Key: toAttributeMap({ [pkField]: key.pk, [skField]: key.sk }),
            ConsistentRead: true,
            ProjectionExpression: "#epk, #esk",
            ExpressionAttributeNames: { "#epk": "_entity_pk", "#esk": "_entity_sk" },
          }),
        { concurrency: "unbounded" },
      )
      return candidates.filter((_, i) => {
        const stored = reads[i]?.Item
        return (
          stored !== undefined &&
          attributeValueEquals(stored._entity_pk, ownerPk) &&
          attributeValueEquals(stored._entity_sk, ownerSk)
        )
      })
    })

  /**
   * The Delete releasing a sentinel {@link ownedSentinels} found owned by
   * `owner` — conditioned on that ownership still holding, so a reservation
   * that changed hands between the read and the write cancels the write
   * instead of being deleted.
   */
  const sentinelRelease = (
    tableName: string,
    key: { readonly pk: string; readonly sk: string },
    owner: { readonly pk: unknown; readonly sk: unknown },
  ) => ({
    Delete: {
      TableName: tableName,
      Key: toAttributeMap({
        [config.indexes.primary.pk.field]: key.pk,
        [config.indexes.primary.sk.field]: key.sk,
      }),
      ConditionExpression: "#epk = :epk AND #esk = :esk",
      ExpressionAttributeNames: { "#epk": "_entity_pk", "#esk": "_entity_sk" },
      ExpressionAttributeValues: {
        ":epk": toAttributeValue(owner.pk),
        ":esk": toAttributeValue(owner.sk),
      },
    },
  })

  /**
   * A sentinel release cancelled: the reservation changed hands between the
   * read and the write. Nothing was written; the item still holds the value.
   */
  const releaseRaced = (
    key: globalThis.Record<string, unknown>,
    constraintName: string,
  ): ConcurrentModification => {
    const error = new ConcurrentModification({
      entityType,
      key,
      attributes: [...resolveUniqueFields(config.unique![constraintName]!)],
      current: Option.none(),
    })
    releaseRaces.add(error)
    return error
  }

  // ---------------------------------------------------------------------------
  // Guarded puts (#133)
  // ---------------------------------------------------------------------------

  /**
   * The highest version retained for the item at `pk` — 0 with none. A
   * deleted retain item's version snapshots outlive it, so the item created
   * again at its key continues the sequence after them rather than
   * overwriting its earlier incarnation's history.
   */
  const highestRetainedVersion = (
    tableName: string,
    pk: unknown,
    liveSk: unknown,
  ): Effect.Effect<number, DynamoClientError, DynamoClient> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const primary = config.indexes.primary
      const latest = yield* client.query({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": primary.pk.field, "#sk": primary.sk.field },
        ExpressionAttributeValues: {
          ":pk": toAttributeValue(pk),
          ":prefix": toAttributeValue(
            DynamoSchema.composeVersionKeyPrefix(schema, entityType, historyKeyOptions(liveSk)),
          ),
        },
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      })
      const own = versionOfSk(latest.Items?.[0]?.[primary.sk.field]?.S)
      if (!hasItemHistory || typeof liveSk !== "string") return own
      // History an earlier release wrote for this item counts too: a version it
      // holds is never written again.
      const [legacy] = yield* legacyHistory({
        tableName,
        pk,
        liveSk,
        kind: "version",
        descending: true,
        first: true,
      })
      return Math.max(own, versionOfSk(legacy?.[primary.sk.field]?.S))
    })

  /**
   * A guarded put — of a versioned or unique-constrained entity — compiled
   * against the item as read (#133). Shared by `put` / `create` / `upsert`
   * and the transaction paths (`Transaction.transactWrite`,
   * `EventStore.append`'s `additionalItems`), so they write the same items:
   *
   * - **The item exists:** its next version, its incarnation and its
   *   `createdAt` (unless the caller supplies one); the Put is guarded on the
   *   item read — version and incarnation, or the unique values its sentinels
   *   derive from. Retain: the replaced item is snapshotted at its version.
   * - **The item is missing** (or not read: `create`): the Put requires it
   *   still missing. A retain item continues after the highest version
   *   retained for its key — a deleted item's history outlives it — with a new
   *   incarnation, and is snapshotted at that version.
   * - **Sentinels:** a changed value takes the new reservation and releases the
   *   old one — only if this item owns it ({@link ownedSentinels}).
   *
   * `verdict` reads a cancellation: a lost race or retained history the read
   * did not see is retried by the caller (re-planned from a fresh read); the
   * caller's own condition is `Condition`; a taken value or a history conflict
   * is final.
   */
  const planPut = (args: {
    readonly tableName: string
    readonly ttlAttrName: string
    readonly now: DateTime.Utc
    /** The item as built: stored attribute names, version 1, a fresh incarnation. */
    readonly item: globalThis.Record<string, unknown>
    /** Whether the caller supplied `createdAt` (a replacing put keeps the stored one). */
    readonly createdAtSupplied: boolean
    readonly userCondition:
      | {
          readonly expression: string
          readonly names: globalThis.Record<string, string>
          readonly values: globalThis.Record<string, AttributeValue>
        }
      | undefined
    /** `create`: the item must be missing — it is not read. */
    readonly create: boolean
    readonly operation: string
    /** The key errors name. */
    readonly key: globalThis.Record<string, unknown>
    /** The item's keys, were these system fields what the plan carries over (see `carriedSystemFields`). */
    readonly composeKeys: (
      carried: globalThis.Record<string, unknown>,
    ) => Effect.Effect<globalThis.Record<string, unknown>, ValidationError>
  }): Effect.Effect<PutPlan, ValidationError | DynamoClientError, DynamoClient> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const pkField = config.indexes.primary.pk.field
      const skField = config.indexes.primary.sk.field
      const item: globalThis.Record<string, unknown> = { ...args.item }
      const owner = { pk: item[pkField], sk: item[skField] }
      const current = args.create
        ? undefined
        : (yield* client.getItem({
            TableName: args.tableName,
            Key: toAttributeMap({ [pkField]: owner.pk, [skField]: owner.sk }),
            ConsistentRead: true,
          })).Item
      yield* checkVersion(current, args.operation)
      const currentRaw =
        current !== undefined
          ? (fromAttributeMap(current) as globalThis.Record<string, unknown>)
          : undefined
      const storedVersion = storedVersionOf(current)
      if (currentRaw !== undefined) {
        // The same item, continued: its next version, its incarnation, its
        // creation time (unless the caller supplies one).
        if (systemFields.version) {
          item[systemFields.version] = (storedVersion ?? 0) + 1
          if (currentRaw[INCARNATION_TOKEN] !== undefined) {
            item[INCARNATION_TOKEN] = currentRaw[INCARNATION_TOKEN]
          }
        }
        if (systemFields.createdAt && !args.createdAtSupplied) {
          const createdAttr = resolveDbName(systemFields.createdAt)
          if (currentRaw[createdAttr] !== undefined) item[createdAttr] = currentRaw[createdAttr]
        }
      } else if (systemFields.version && isRetainEnabled()) {
        item[systemFields.version] =
          (yield* highestRetainedVersion(args.tableName, owner.pk, owner.sk)) + 1
      }
      // What the put continues is what an index over it holds. A put that carries nothing, or an
      // entity with no such index, keeps the keys it was built with.
      const carried = carriedSystemFields(item)
      if (Object.keys(carried).some((field) => indexCompositeFields().has(field))) {
        Object.assign(item, yield* args.composeKeys(carried))
      }
      const marshalled = toAttributeMap(item)

      // The main item. Missing: it must still be missing. Present: still the
      // item read — its version and incarnation, or (unversioned) the unique
      // values its sentinels are keyed by.
      const uniqueAttrs = [
        ...new Set(
          Object.values((config.unique ?? {}) as globalThis.Record<string, UniqueConstraintDef>)
            .flatMap((def) => [...resolveUniqueFields(def)])
            .map(resolveDbName),
        ),
      ]
      const userCondition = args.userCondition
      const guard =
        current === undefined
          ? {
              expression: "attribute_not_exists(#pk)",
              names: { "#pk": pkField } as globalThis.Record<string, string>,
              values: {} as globalThis.Record<string, AttributeValue>,
              inputs: [] as ReadonlyArray<string>,
            }
          : deleteGuard(current, uniqueAttrs, userCondition?.expression)
      const mainValues = { ...guard.values, ...userCondition?.values }
      // Sent as built: a condition over DynamoDB's expression limits is
      // DynamoDB's to reject, and is diagnosed naming the caller's part (#144).
      const mainCondition = userCondition
        ? `${guard.expression} AND (${userCondition.expression})`
        : guard.expression

      const items: Array<TransactWriteItem> = [
        {
          Put: {
            TableName: args.tableName,
            Item: marshalled,
            ConditionExpression: mainCondition,
            ExpressionAttributeNames: { ...guard.names, ...userCondition?.names },
            ...(Object.keys(mainValues).length > 0 && { ExpressionAttributeValues: mainValues }),
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
      ]
      const roles: Array<
        | { readonly kind: "main" }
        | {
            readonly kind: "sentinel"
            readonly constraintName: string
            readonly fields: globalThis.Record<string, string>
          }
        | { readonly kind: "release"; readonly constraintName: string }
        | { readonly kind: "snapshot"; readonly version: number }
      > = [{ kind: "main" }]

      // Sentinels: a changed value takes the new reservation and releases the
      // old one this item owns; an unchanged value is left alone. A field
      // holding only a default has none (`__edd_d__`).
      if (config.unique != null) {
        const newSource = toDomainView(item)
        const oldSource = currentRaw !== undefined ? toDomainView(currentRaw) : undefined
        const changes: Array<{
          readonly constraintName: string
          readonly constraintDef: UniqueConstraintDef
          readonly next:
            | {
                readonly key: { readonly pk: string; readonly sk: string }
                readonly fieldsRecord: globalThis.Record<string, string>
              }
            | undefined
          readonly prior: { readonly pk: string; readonly sk: string } | undefined
        }> = []
        const sameKey = (
          a: { readonly pk: string; readonly sk: string },
          b: { readonly pk: string; readonly sk: string },
        ) => a.pk === b.pk && a.sk === b.sk
        for (const [constraintName, constraintDef] of Object.entries(
          config.unique as globalThis.Record<string, UniqueConstraintDef>,
        )) {
          const next = composeUniqueSentinel(
            schema,
            entityType,
            constraintName,
            constraintDef,
            newSource,
            storedSentinelValue,
          )
          const prior =
            oldSource !== undefined
              ? composeUniqueSentinel(
                  schema,
                  entityType,
                  constraintName,
                  constraintDef,
                  oldSource,
                  readSentinelValue,
                )
              : undefined
          if (next !== undefined && prior !== undefined && sameKey(next.key, prior.key)) continue
          changes.push({ constraintName, constraintDef, next, prior: prior?.key })
        }
        const owned = new Set(
          yield* ownedSentinels(
            args.tableName,
            changes.flatMap((change) => (change.prior === undefined ? [] : [change.prior])),
            owner,
          ),
        )
        for (const change of changes) {
          if (change.prior !== undefined && owned.has(change.prior)) {
            items.push(sentinelRelease(args.tableName, change.prior, owner))
            roles.push({ kind: "release", constraintName: change.constraintName })
          }
          if (change.next === undefined) continue
          items.push({
            Put: {
              TableName: args.tableName,
              Item: toAttributeMap(
                sentinelItemFor(
                  change.constraintName,
                  change.constraintDef,
                  change.next.key,
                  owner,
                  args.now,
                  args.ttlAttrName,
                ),
              ),
              ...sentinelGuard(),
            },
          })
          roles.push({
            kind: "sentinel",
            constraintName: change.constraintName,
            fields: change.next.fieldsRecord,
          })
        }
      }

      // Retain: the item replaced (at its version), or the new item at its own.
      if (isRetainEnabled()) {
        const version =
          currentRaw !== undefined ? (storedVersion ?? 0) : (item[systemFields.version!] as number)
        items.push({
          Put: snapshotPut(
            args.tableName,
            buildSnapshotItem(
              currentRaw ?? item,
              version,
              pkField,
              skField,
              args.ttlAttrName,
              args.now,
            ),
          ),
        })
        roles.push({ kind: "snapshot", version })
      }

      /** The stored attributes that differ from the item read. */
      const changedFrom = (stored: globalThis.Record<string, AttributeValue>) =>
        guard.inputs.filter(
          (attr) => !attributeValueEquals(stored[attr], current?.[attr] as AttributeValue),
        )
      /** A lost race on the main item: the error once retries run out. */
      const lostRace = (
        stored: globalThis.Record<string, AttributeValue> | undefined,
      ): Extract<PutVerdict, { readonly _tag: "Retry" }> => ({
        _tag: "Retry",
        stored,
        error: systemFields.version
          ? new OptimisticLockError({
              entityType,
              key: args.key,
              expectedVersion: storedVersion ?? 0,
              actualVersion: storedVersionOf(stored) ?? -1,
            })
          : new ConcurrentModification({
              entityType,
              key: args.key,
              attributes:
                stored !== undefined && current !== undefined
                  ? changedFrom(stored).map(domainNameOf)
                  : [],
              current: Option.none(),
            }),
      })

      const verdict = (
        reasons: ReadonlyArray<WriteCancellationReason | undefined>,
      ): PutVerdict | undefined => {
        const main = reasons[0]
        if (main?.Code === "ConditionalCheckFailed") {
          const stored = main.Item as globalThis.Record<string, AttributeValue> | undefined
          // `create`: the item exists, or the caller's condition rejected it.
          if (args.create) return { _tag: "Condition" }
          if (current === undefined) {
            // Still missing: the caller's condition. Created since: a race.
            return stored === undefined && userCondition !== undefined
              ? { _tag: "Condition" }
              : lostRace(stored)
          }
          if (stored === undefined) return lostRace(stored)
          const raced = systemFields.version
            ? storedVersionOf(stored) !== storedVersion ||
              (incarnationAttr !== undefined &&
                !attributeValueEquals(stored[incarnationAttr], current[incarnationAttr]))
            : changedFrom(stored).length > 0
          return raced || userCondition === undefined ? lostRace(stored) : { _tag: "Condition" }
        }
        for (let i = 1; i < roles.length; i++) {
          if (reasons[i]?.Code !== "ConditionalCheckFailed") continue
          const role = roles[i]!
          switch (role.kind) {
            case "sentinel":
              return {
                _tag: "Fail",
                error: new UniqueConstraintViolation({
                  entityType,
                  constraint: role.constraintName,
                  fields: role.fields,
                }),
              }
            case "snapshot":
              // A missing item's snapshot: history the read did not see — retried
              // past it. A present item's: its version disagrees with its history.
              return current === undefined
                ? lostRace(undefined)
                : { _tag: "Fail", error: historyConflict(role.version, args.operation) }
            case "release":
              // The reservation changed hands since it was read.
              return {
                _tag: "Retry",
                stored: current,
                error: releaseRaced(args.key, role.constraintName),
              }
          }
        }
        return undefined
      }

      return { items, item, marshalled, verdict }
    })

  /**
   * Run a guarded put to completion (#133): plan it from a fresh read, write
   * it, and on a lost race — a concurrent create, replace or delete of the
   * item, or retained history the read did not see — plan and write it again.
   * A put replaces the whole item, so the last writer wins, as a plain
   * `PutItem` would. Only the caller's own condition, a taken unique value or
   * a history conflict fail it; a race lost on every attempt fails with the
   * concurrency error.
   */
  const runGuardedPut = (args: Parameters<typeof planPut>[0]) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      let lost: Extract<PutVerdict, { readonly _tag: "Retry" }> | undefined
      for (let attempt = 0; attempt < GUARDED_PUT_ATTEMPTS; attempt++) {
        const plan = yield* planPut(args)
        const write: Effect.Effect<unknown, DynamoClientError> =
          plan.items.length === 1
            ? client.putItem(plan.items[0]!.Put!)
            : client.transactWriteItems({ TransactItems: [...plan.items] })
        const verdict = yield* write.pipe(
          Effect.as(undefined as PutVerdict | undefined),
          Effect.catch((err: DynamoClientError) => {
            const reasons = isAwsTransactionCancelled(err.cause)
              ? (err.cause.CancellationReasons ?? [])
              : isAwsConditionalCheckFailed(err.cause)
                ? [{ Code: "ConditionalCheckFailed", Item: err.cause.Item }]
                : undefined
            const read = reasons !== undefined ? plan.verdict(reasons) : undefined
            return read !== undefined ? Effect.succeed(read) : Effect.fail(err)
          }),
          // Terminal: a diagnosed limit is never retried as a lost race.
          plan.items.length === 1
            ? diagnoseItemWrite(
                args.operation,
                plan.items[0]!,
                () => args.userCondition?.expression,
              )
            : diagnoseTransactionWrite(
                args.operation,
                plan.items,
                () => args.userCondition?.expression,
              ),
        )
        if (verdict === undefined) return plan
        switch (verdict._tag) {
          case "Fail":
            return yield* verdict.error
          case "Condition":
            return yield* new ConditionalCheckFailed({ entityType, key: args.key })
          case "Retry":
            lost = verdict
        }
      }
      return yield* withCurrentItem(Effect.fail(lost!.error), () => lost!.stored)
    })

  // ---------------------------------------------------------------------------
  // Ref hydration
  // ---------------------------------------------------------------------------

  /**
   * Hydrate ref fields by fetching referenced entities by ID and embedding
   * their core domain data. Returns a new object with ref fields populated.
   *
   * @param decoded - Decoded input containing `${field}Id` values
   * @returns Object with `${field}Id` removed and `${field}` populated with domain data
   */
  const hydrateRefs = (
    decoded: globalThis.Record<string, unknown>,
    refs?: ReadonlyArray<ResolvedRef>,
  ): Effect.Effect<
    globalThis.Record<string, unknown>,
    RefNotFound | DynamoClientError | ItemNotFound | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      const refsToProcess = refs ?? resolvedRefs
      if (refsToProcess.length === 0) return decoded

      // Fetch all refs in parallel
      const hydrated = { ...decoded }
      const fetchEffects = refsToProcess.map((ref) => {
        const id = decoded[ref.idFieldName] as string
        return Effect.gen(function* () {
          const keyInput = { [ref.identifierField]: id }
          // Use asModel to convert EntityGet to Effect<ModelType>
          const getEffect = asModel(ref.refEntity.get(keyInput) as EntityGet<any, any, any, any>)
          const model = yield* getEffect.pipe(
            Effect.catchTag("ItemNotFound", () =>
              Effect.fail(
                new RefNotFound({
                  entity: entityType,
                  field: ref.fieldName,
                  refEntity: ref.refEntityType,
                  refId: id,
                }),
              ),
            ),
          )
          // `asModel` returns the DECODED domain value (transform fields lifted to
          // their domain form, e.g. `Schema.DateTimeUtcFromString` → `DateTime`).
          // The parent decodes this nested ref field via the ref target's ORIGINAL
          // `Schema.Class` (`substituteSchemas` does not recurse into nested
          // classes), whose Encoded side is the wire primitive. Re-encode through
          // the ref's substituted `modelSchema` so the spliced value is wire-form:
          // marshall-safe for `toAttributeMap` AND decoded exactly once by the
          // parent (issue #72 — without this, a put marshalls a `DateTime` and the
          // return decode fails "Expected string, got DateTime.Utc").
          const wire = yield* Schema.encodeUnknownEffect(
            ref.refEntity.schemas.modelSchema as Schema.Codec<any>,
          )(model).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "hydrateRefs.encode",
                  cause,
                }),
            ),
          )
          return { fieldName: ref.fieldName, idFieldName: ref.idFieldName, data: wire }
        })
      })

      const results = yield* Effect.all(fetchEffects, { concurrency: "unbounded" })
      for (const r of results) {
        // `data` is already a wire-form plain object from the ref's modelSchema.
        hydrated[r.fieldName] = r.data as object
        delete hydrated[r.idFieldName]
      }

      return hydrated
    })

  // ---------------------------------------------------------------------------
  // Cascade update execution
  // ---------------------------------------------------------------------------

  /**
   * Find a GSI on a target entity whose PK composite includes the source entity's
   * identifier field name (e.g., "playerId"). This GSI is used to query all target
   * items that reference the source entity.
   *
   * Selection priority:
   *   1. A GSI whose PK composite is exactly `[idFieldName]` (single attribute).
   *      This is the only shape that can be recomposed from the source identifier
   *      alone, so it's always safe for cascade.
   *   2. Otherwise, the first GSI whose PK composite contains `idFieldName`.
   *      This is a fallback for backwards compatibility — `executeCascade`
   *      validates that all extra composites can be supplied at runtime and
   *      raises a clear error if they cannot.
   */
  const findCascadeIndex = (
    target: CascadeTarget,
    idFieldName: string,
  ): { readonly indexName: string; readonly indexDef: IndexDefinition } | undefined => {
    let fallback: { readonly indexName: string; readonly indexDef: IndexDefinition } | undefined
    for (const [indexName, indexDef] of Object.entries(target.indexes)) {
      if (indexName === "primary") continue
      const composite = indexDef.pk.composite
      if (composite.length === 1 && composite[0] === idFieldName) {
        // Exact match — preferred. PK is fully determined by the source id.
        return { indexName, indexDef }
      }
      if (fallback === undefined && composite.includes(idFieldName)) {
        fallback = { indexName, indexDef }
      }
    }
    return fallback
  }

  /** Cached source entity identifier field name (e.g., "playerId") */
  const sourceIdentifierField = (() => {
    const idField = getIdentifierField(config.model as Schema.Top)
    return idField?.name
  })()

  /**
   * Execute cascade updates after a source entity update completes.
   * For each target entity: query its cascade GSI, then update all matching items.
   */
  const executeCascade = (
    cascadeConfig: CascadeConfig,
    sourceDomainData: globalThis.Record<string, unknown>,
    sourceIdValue: string,
  ): Effect.Effect<void, CascadePartialFailure | DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const { targets, filter, mode } = cascadeConfig
      const sourceEntityType = entityType
      const client = yield* Capacity.client

      if (!sourceIdentifierField) return undefined as undefined

      const allUpdateOps: Array<{
        readonly entityType: string
        readonly tableName: string
        readonly key: globalThis.Record<string, AttributeValue>
        /** The target table's primary-key attributes, `[pk.field, sk.field]`. */
        readonly keyFields: readonly [string, string]
        readonly refFieldName: string
        readonly refData: AttributeValue
      }> = []

      for (const target of targets) {
        // Find the ref on the target that points to our source entity
        const matchingRef = target._resolvedRefs.find((r) => r.refEntityType === sourceEntityType)
        if (!matchingRef) continue

        // Find GSI on target whose PK composite includes the ref's ID field
        const cascadeIdx = findCascadeIndex(target, matchingRef.idFieldName)
        if (!cascadeIdx) continue

        // The cascade can only recompose a GSI PK from the source identifier
        // if every composite attribute is satisfied. The source entity (e.g. a
        // Team) only carries its own identifier (e.g. teamId), so any GSI whose
        // PK includes additional composites (e.g. season, series) is unusable
        // for cascade. findCascadeIndex prefers the safe shape, but the
        // fallback may still hand back an over-composed GSI when no exact
        // match exists. Detect that here and fail with a clear, tagged error
        // rather than throwing deep inside KeyComposer.composePk.
        const cascadePkComposite = cascadeIdx.indexDef.pk.composite
        if (cascadePkComposite.length !== 1 || cascadePkComposite[0] !== matchingRef.idFieldName) {
          return yield* new CascadePartialFailure({
            sourceEntity: sourceEntityType,
            sourceId: sourceIdValue,
            succeeded: 0,
            failed: 0,
            errors: [
              `Cascade target "${target.entityType}" has no GSI usable for cascade from "${sourceEntityType}". ` +
                `The chosen index "${cascadeIdx.indexName}" (${cascadeIdx.indexDef.index}) has PK composite ` +
                `[${cascadePkComposite.join(", ")}], but cascade requires a GSI whose PK composite is exactly ` +
                `["${matchingRef.idFieldName}"]. Add a single-attribute GSI keyed on "${matchingRef.idFieldName}" ` +
                `(or use the refs.${matchingRef.fieldName}.cascade config to auto-generate one).`,
            ],
          })
        }

        // Resolve target table name
        const { name: targetTableName } = yield* target._tableTag

        // The target's primary-key attributes. A target need not be keyed `pk` /
        // `sk`, and one cascade can span targets keyed differently, so each
        // update reads its key — and is diagnosed — by its own target's fields.
        const targetPrimary = target.indexes.primary!
        const keyFields = [targetPrimary.pk.field, targetPrimary.sk.field] as const

        // Compose GSI PK for the source entity's ID: one partition, or a sharded
        // index's several (#183). The cascade reads them all.
        const targetSchema = target._schema
        const gsiPartitions = KeyComposer.composeReadPartitions(
          targetSchema,
          target.entityType,
          cascadeIdx.indexDef,
          keyFormFor(target, { [matchingRef.idFieldName]: sourceIdValue }),
        ).partitions

        // Build query parameters
        const gsiPkField = cascadeIdx.indexDef.pk.field
        const queryNames: globalThis.Record<string, string> = {
          "#pk": gsiPkField,
          "#et": "__edd_e__",
        }
        const queryValues: globalThis.Record<string, AttributeValue> = {
          ":et0": { S: target.entityType },
        }

        let filterExpression = "#et = :et0"

        // Add user-provided filter
        if (filter) {
          let filterIdx = 0
          for (const [key, value] of Object.entries(filter)) {
            const nameKey = `#cf${filterIdx}`
            const valKey = `:cf${filterIdx}`
            queryNames[nameKey] = key
            queryValues[valKey] = toAttributeValue(value)
            filterExpression += ` AND ${nameKey} = ${valKey}`
            filterIdx++
          }
        }

        // Paginated query, per partition
        for (const gsiPkValue of gsiPartitions) {
          let exclusiveStartKey: globalThis.Record<string, AttributeValue> | undefined
          do {
            const queryResult = yield* client.query({
              TableName: targetTableName,
              IndexName: cascadeIdx.indexDef.index,
              KeyConditionExpression: "#pk = :pk",
              FilterExpression: filterExpression,
              ExpressionAttributeNames: queryNames,
              ExpressionAttributeValues: { ...queryValues, ":pk": { S: gsiPkValue } },
              ExclusiveStartKey: exclusiveStartKey,
            })

            for (const item of queryResult.Items ?? []) {
              allUpdateOps.push({
                entityType: target.entityType,
                tableName: targetTableName,
                key: { [keyFields[0]]: item[keyFields[0]]!, [keyFields[1]]: item[keyFields[1]]! },
                keyFields,
                refFieldName: matchingRef.fieldName,
                refData: toAttributeValue(sourceDomainData),
              })
            }

            exclusiveStartKey = queryResult.LastEvaluatedKey as
              | globalThis.Record<string, AttributeValue>
              | undefined
          } while (exclusiveStartKey !== undefined)
        }
      }

      if (allUpdateOps.length === 0) return

      if (mode === "transactional") {
        // Transactional mode — one atomic transaction. DynamoDB's limits (100
        // items, 4 MB, item size, sort keys) are not pre-checked (#144): a
        // rejection is diagnosed and reported as a cascade that wrote nothing.
        const cascadeItems: ReadonlyArray<TransactWriteItem> = allUpdateOps.map((op) => ({
          Update: {
            TableName: op.tableName,
            Key: op.key,
            UpdateExpression: "SET #ref = :refData",
            ExpressionAttributeNames: { "#ref": op.refFieldName },
            ExpressionAttributeValues: { ":refData": op.refData },
          },
        }))
        yield* client.transactWriteItems({ TransactItems: [...cascadeItems] }).pipe(
          diagnoseFailure({
            sent: () => ({
              _tag: "Transaction",
              items: cascadeItems,
              targets: () =>
                cascadeItems.map((item, index) => {
                  const op = allUpdateOps[index]!
                  return transactItemTarget(
                    item,
                    op.tableName,
                    op.keyFields,
                    op.entityType,
                    `the cascade update of ${op.entityType} (item ${index})`,
                  )
                }),
            }),
            keys: () => ({
              partition: [...new Set(allUpdateOps.map((op) => op.keyFields[0]))],
              sort: [...new Set(allUpdateOps.map((op) => op.keyFields[1]))],
            }),
            rewrite: (diagnosis, original) =>
              new CascadePartialFailure({
                sourceEntity: sourceEntityType,
                sourceId: sourceIdValue,
                succeeded: 0,
                failed: allUpdateOps.length,
                errors: [
                  diagnosedValidationError(diagnosis, original, {
                    operation: "cascade",
                    entityType: sourceEntityType,
                  }),
                ],
              }),
          }),
        )
      } else {
        // Eventual mode — concurrent updates with partial failure tracking
        let succeeded = 0
        const errors: Array<unknown> = []

        const updateEffects = allUpdateOps.map((op) => {
          const update = {
            TableName: op.tableName,
            Key: op.key,
            UpdateExpression: "SET #ref = :refData",
            ExpressionAttributeNames: { "#ref": op.refFieldName },
            ExpressionAttributeValues: { ":refData": op.refData },
          }
          return client.updateItem(update).pipe(
            // An item the cascade grows past 400 KB is named in `errors`.
            diagnoseFailure({
              sent: () => ({
                _tag: "Item",
                item: { Update: update },
                target: () =>
                  transactItemTarget(
                    { Update: update },
                    op.tableName,
                    op.keyFields,
                    op.entityType,
                    `the cascade update of ${op.entityType}`,
                  ),
              }),
              keys: () => ({ partition: [op.keyFields[0]], sort: [op.keyFields[1]] }),
              rewrite: (diagnosis, original) =>
                diagnosedValidationError(diagnosis, original, {
                  operation: "cascade",
                  entityType: op.entityType,
                }),
            }),
            Effect.tap(() =>
              Effect.sync(() => {
                succeeded++
              }),
            ),
            Effect.catch((err) =>
              Effect.sync(() => {
                errors.push(err)
              }),
            ),
          )
        })

        yield* Effect.all(updateEffects, { concurrency: 10 })

        if (errors.length > 0) {
          return yield* new CascadePartialFailure({
            sourceEntity: sourceEntityType,
            sourceId: sourceIdValue,
            succeeded,
            failed: errors.length,
            errors,
          })
        }
      }
    })

  // ---------------------------------------------------------------------------
  // put operation
  // ---------------------------------------------------------------------------

  // Mutable self — safe because operations are closures that only
  // dereference `self` when called by users, after make() has returned
  let self: Entity

  const put = (input: unknown) =>
    new EntityPutImpl(
      (mode: DecodeMode, opts: EntityPutOpts) =>
        Effect.gen(function* () {
          const client = yield* Capacity.client
          const tc = yield* tableTag
          const tableName = tc.name
          const ttlAttrName = resolveTtlAttributeName(tc)

          // `upsert` creates through this path: its errors name it.
          const operation = opts.operation ?? "put"
          yield* checkWithVectorNames(opts.withVectors, operation)

          // Auto-generated id: fill the configured primary-key field with a
          // fresh UUID BEFORE the encode, but only when the caller omitted it —
          // a caller-supplied value is always respected. The id is sourced from
          // the bundled SecureRandom service (`DynamoClient.make` provides a default),
          // so this keeps the bound `put` at `R = never`. The filled id then
          // flows through input validation → key composition → stored item →
          // returned record in this same pass.
          const withGeneratedId = yield* fillGeneratedId(input)
          const unsentineled = unsentineledDefaults(withGeneratedId)
          const inputWithGeneratedId = yield* fillDecodingDefaults(withGeneratedId)

          // Encode user input → wire form. Users typically construct domain
          // values for transforms (DateTime, Redacted, Number) and plain
          // objects for Schema.Class fields. To handle both:
          //   1. Try `encode` directly — the canonical Type → Encoded
          //      conversion. Works when the input is fully Type-shaped
          //      (which is the case for the transforms that issue #29
          //      surfaced: RedactedFromValue, NumberFromString, etc.).
          //   2. On failure, fall back to `decode → encode` — `decode` is
          //      forgiving for Schema.Class (lifts plain objects to
          //      instances) and the substituted date/Redacted transforms
          //      tolerate either form. The subsequent `encode` produces
          //      the canonical wire shape.
          const encodedInput = yield* encodeForWrite(
            schemas.inputSchema as Schema.Codec<any>,
            inputWithGeneratedId,
            operation,
          )

          // Clock-backed time source resolved once for this write op and
          // threaded into every timestamp/TTL computation below — deterministic
          // under `TestClock`, wall-clock in production.
          const now = yield* DateTime.now

          // System fields, before the keys: an index may be composed from one.
          // When a timestamp field collides with a model-declared field, the
          // user may have supplied their own value (optional on collision in
          // `inputSchema`). Respect their value if present (already encoded to
          // wire); otherwise generate a wire primitive directly.
          const stamps = stampsOf(encodedInput as globalThis.Record<string, unknown>, {
            createdAt: opts.createdAt ?? now,
            updatedAt: now,
          })
          const keyValues = { ...(encodedInput as object), ...stamps }

          // Compose all keys from the encoded input (ID fields still present
          // and key composites are wire-format strings/numbers).
          const keys = yield* composeAllKeys(keyValues, operation)

          // A put that sends something before its write refuses a value DynamoDB can't
          // store first. Any other put finds out when it marshals, at no extra cost.
          if (
            hasRefs ||
            hasVectorIndexes ||
            Boolean(systemFields.version) ||
            Object.keys(config.unique ?? {}).length > 0 ||
            (opts.putKind === "create" && hasProjectionTombstones(self))
          ) {
            yield* refuseUnstorable(
              { ...(encodedInput as globalThis.Record<string, unknown>), ...opts.withVectors },
              operation,
            )
            yield* refuseUncomposed(encodedInput, operation)
          }

          // A put writes the whole item, so an entry key its flattening refuses is refused in
          // every case: before the refs are read, where it reads any.
          if (hasRefs) {
            const refusedKey = refusedSparseKey(encodedInput, true)
            if (refusedKey !== undefined) {
              return yield* new ValidationError({
                entityType,
                operation: `${operation}.sparse`,
                cause: refusedKey,
              })
            }
          }

          // Hydrate refs: replace ID fields with full entity domain data
          const encoded: globalThis.Record<string, unknown> = hasRefs
            ? yield* hydrateRefs(encodedInput as globalThis.Record<string, unknown>)
            : (encodedInput as globalThis.Record<string, unknown>)

          // Build the DynamoDB item — already in wire-format after encode
          const item: globalThis.Record<string, unknown> = { ...encoded, ...stamps }
          if (stampsIncarnation) item[INCARNATION_TOKEN] = yield* freshIncarnation

          // Add entity type discriminator
          item.__edd_e__ = entityType
          // Unique fields holding only a default: no sentinel for them (#133).
          if (unsentineled.length > 0) item[UNSENTINELED_DEFAULTS] = new Set(unsentineled)

          // Apply composed keys
          Object.assign(item, keys)

          // Vector search: embed the source text and compose the partition
          // value. Sparse — an index whose source or partition composites are
          // absent contributes nothing. See `DESIGN.md §14`.
          if (hasVectorIndexes) {
            const vectorWrite = yield* computeVectorAttributes(
              { ...encoded, ...stamps },
              opts.withVectors,
              "all",
            )
            Object.assign(item, vectorWrite.sets)
            // `put` writes a whole item, so a REMOVE is just an omission.
            for (const field of vectorWrite.removes) delete item[field]
          }

          const hasUniqueConstraints =
            config.unique != null && Object.keys(config.unique).length > 0
          // A versioned or unique-constrained entity's put is guarded (#133):
          // a put over an existing item continues its version sequence,
          // incarnation and `createdAt`, snapshots the replaced item (retain)
          // and rotates its unique sentinels — never resetting history or
          // orphaning one. See `runGuardedPut`.
          const guarded = hasUniqueConstraints || Boolean(systemFields.version)
          const createdAtSupplied =
            systemFields.createdAt !== null &&
            ((encoded as globalThis.Record<string, unknown>)[systemFields.createdAt] !==
              undefined ||
              opts.createdAt !== undefined)

          // Rename domain fields to DynamoDB attribute names
          renameToDynamo(item)
          // Flatten sparse Map fields into per-entry top-level attributes.
          // Wrapped to surface key-validation errors as ValidationError.
          try {
            serializeSparseFields(item)
          } catch (e) {
            return yield* new ValidationError({
              entityType,
              operation: `${operation}.sparse`,
              cause: e instanceof Error ? e.message : String(e),
            })
          }
          // Pack `storedAs: DynamoModel.Packed` fields to their stored form
          // (JSON string, or compressed binary over the threshold) — after
          // renames and sparse flattening, before marshalling, so every size
          // measured from here on is the stored size.
          yield* packFields(item, operation)

          // The caller's condition, ANDed onto `create`'s not-exists guard —
          // a guard no `.condition()` can replace (#133). `upsert`'s create
          // attempt brings its own (`runGuardedPut` requires the item missing).
          const condition = withGuard(
            opts.putKind === "create" && operation !== "upsert" ? createGuard(self) : undefined,
            opts.condition,
          )
          let userCondition = condition ? compileCondition(condition, resolveDbName) : undefined

          // `create` over a projection tombstone (#154): the row takes the
          // tombstone's place, its checkpoints and revision carried over, on
          // the condition that tombstone is still there.
          if (opts.putKind === "create" && operation !== "upsert" && !guarded) {
            const over = yield* overTombstone(self, client, tc, item)
            if (Option.isSome(over)) {
              userCondition = compileCondition(
                withGuard(over.value, opts.condition) as Expr | ConditionInput,
                resolveDbName,
              )
            }
          }

          if (guarded) {
            const plan = yield* runGuardedPut({
              tableName,
              ttlAttrName,
              now,
              item,
              createdAtSupplied,
              userCondition,
              create: opts.putKind === "create",
              operation,
              key: encoded as globalThis.Record<string, unknown>,
              composeKeys: (carried) => composeAllKeys({ ...keyValues, ...carried }, operation),
            })
            return yield* decodeAs(plan.item, plan.marshalled, mode)
          }

          const marshalledItem = yield* marshalOrFail(
            entityType,
            operation,
            () => toAttributeMap(item),
            { fieldOf: fieldOfAttribute },
          )
          {
            // Simple put without unique constraints or versioning
            const putInput: {
              TableName: string
              Item: globalThis.Record<string, AttributeValue>
              ConditionExpression?: string
              ExpressionAttributeNames?: globalThis.Record<string, string>
              ExpressionAttributeValues?: globalThis.Record<string, AttributeValue>
            } = {
              TableName: tableName,
              Item: marshalledItem,
            }
            if (userCondition) {
              putInput.ConditionExpression = userCondition.expression
              putInput.ExpressionAttributeNames = userCondition.names
              if (Object.keys(userCondition.values).length > 0) {
                putInput.ExpressionAttributeValues = userCondition.values
              }
            }
            yield* client.putItem(putInput).pipe(
              Effect.mapError((err): DynamoClientError | ConditionalCheckFailed => {
                if (userCondition && isAwsConditionalCheckFailed(err.cause)) {
                  return new ConditionalCheckFailed({
                    entityType,
                    key: encoded as globalThis.Record<string, unknown>,
                  })
                }
                return err
              }),
              diagnoseItemWrite("put", { Put: putInput }),
            )
          }

          // Decode and return using selected mode
          return yield* decodeAs(item, marshalledItem, mode)
        }),
      self,
      input as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // create operation — put + attribute_not_exists condition
  // ---------------------------------------------------------------------------

  // The not-exists guard is the put builder's, from `putKind: "create"` —
  // never the op's condition, which `.condition()` replaces (#133).
  const create = (input: unknown) => {
    const op = put(input)
    return new EntityPutImpl(
      op._builder,
      op._entity,
      op._input,
      op._condition,
      op._withVectors,
      "create",
    )
  }

  // ---------------------------------------------------------------------------
  // patch operation — update + attribute_exists condition
  // ---------------------------------------------------------------------------

  // The exists guard is `runUpdate`'s, from `patch: true` — never the op's
  // condition, which `.condition()` replaces (#133).
  const patch = (key: unknown) => {
    const op = update(key)
    return new EntityUpdateImpl(
      op._builder,
      { ...op._updateState, patch: true },
      op._entity,
      op._key,
    )
  }

  // ---------------------------------------------------------------------------
  // get operation
  // ---------------------------------------------------------------------------

  const get = (key: unknown) =>
    new EntityGetImpl(
      (mode: DecodeMode, opts: EntityGetOpts) =>
        Effect.gen(function* () {
          const client = yield* Capacity.client
          const { name: tableName } = yield* tableTag

          // Caller key: Type side in, ENCODED out (see `encodeKey`).
          const encodedKey = yield* encodeKey(key, "get.decode")

          // Compose primary key
          const primaryKey = composePrimaryKey(encodedKey)
          const marshalledKey = toAttributeMap(primaryKey)

          // Build ProjectionExpression if projection attributes provided
          let projectionExpression: string | undefined
          let projectionNames: globalThis.Record<string, string> | undefined
          if (opts.projection && opts.projection.length > 0) {
            const packedProjection = packedProjectionRefusal(
              opts.projection.map((attribute) => [attribute]),
              packedGuards,
            )
            if (packedProjection !== undefined) {
              return yield* new ValidationError({
                entityType,
                operation: "get.projection",
                cause: packedProjection,
              })
            }
            const proj = Projection.projection([...opts.projection])
            projectionExpression = proj.expression
            projectionNames = proj.names
          }

          const result = yield* client.getItem({
            TableName: tableName,
            Key: marshalledKey,
            ConsistentRead: opts.consistentRead || undefined,
            ProjectionExpression: projectionExpression,
            ExpressionAttributeNames:
              projectionNames && Object.keys(projectionNames).length > 0
                ? projectionNames
                : undefined,
          })

          // A projection tombstone (#154) keeps a removed row's checkpoints at
          // its key: there is no row.
          if (!result.Item || isProjectionTombstone(result.Item, entityType)) {
            return yield* new ItemNotFound({ entityType, key: encodedKey })
          }

          // Raw mode: return unmarshalled record without schema decode — a
          // packed attribute as its parsed JSON (#147).
          if (mode === "raw") {
            const row = fromAttributeMap(result.Item) as globalThis.Record<string, unknown>
            yield* unpackFields(row)
            return row
          }

          // Unmarshall and decode using selected mode
          const raw = fromAttributeMap(result.Item)
          return yield* decodeAs(raw, result.Item, mode)
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // update operation
  // ---------------------------------------------------------------------------

  /**
   * What an update decides from its own operands, before reading anything: every refusal of the
   * names, operands and payload it holds and of the keys the payload composes, and the encoded
   * payload and key ({@link checkUpdatePayload}). A payload with refs to hydrate has its keys
   * checked after the reads that hydrate them, in {@link runPreparedUpdate}. `runUpdate` runs this
   * first; `Transaction.transactWrite` runs it for every op before any op reads (`_prepareUpdate`)
   * and plans the update from what it returns. `encoded`: the key, already encoded.
   */
  const prepareUpdate = (
    key: unknown,
    requested: UpdateState,
    encoded?: globalThis.Record<string, unknown> | undefined,
  ) =>
    Effect.gen(function* () {
      // A packed field takes only a whole-value .set() / .remove() (#147).
      const packedRefusal = refusedPackedUpdate(requested)
      if (packedRefusal !== undefined) {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause: packedRefusal,
        })
      }
      const tc = yield* tableTag
      const ttlAttrName = resolveTtlAttributeName(tc)
      // Names first: `.remove(["g"])` is told to name the field stored as `g`.
      const refusedName = refusedAttributeNames(requested, ttlAttrName)
      if (refusedName !== undefined) {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause: refusedName,
        })
      }
      // `.set({ field: undefined })` becomes `.remove([field])`, once, here. So does
      // anything else the update holds that DynamoDB can't store.
      const lacks = writeLacks()
      const clearedFields = normalizeClears(requested, lacks)
      const cleared =
        typeof clearedFields === "string" ? clearedFields : normalizeNoStoredForm(clearedFields)
      if (typeof cleared === "string") {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause: cleared,
        })
      }
      const refusedPath = refusedPathRemove(cleared, lacks)
      if (refusedPath !== undefined) {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause: refusedPath,
        })
      }
      // Path operations on a field that feeds a key or a unique sentinel
      // become the record operations they are equivalent to, or are
      // refused (#133) — before anything reads the state.
      const normalized = normalizeDerivedPathOps(cleared)
      if (typeof normalized === "string") {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause: normalized,
        })
      }
      const refusedRemove =
        refusedRecordRemove(normalized.remove, lacks) ?? refusedRecordOperands(normalized)
      if (refusedRemove !== undefined) {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause: refusedRemove,
        })
      }
      // Removing a defaulted index composite re-materialises its default —
      // stored, keys recomposed from it — as a put that omits it does (#133).
      const { state: uState, defaulted: removedToDefault } =
        yield* rematerializeRemovedDefaults(normalized)
      const refusedSet = refusedRecordSet(uState.updates, key)
      if (refusedSet !== undefined) {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause: refusedSet,
        })
      }
      const immutables = assertedImmutables(uState.updates)
      if (typeof immutables === "string") {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause: immutables,
        })
      }
      const upsertable = completeUpsertPayload(uState.updates, uState.remove ?? [], lacks)
      // What `put` takes to create the item on a missing row: a field cleared here whose
      // absent attribute is one of its values is that value, and `put` requires its key.
      const createInput = (): unknown => {
        const absent = (uState.remove ?? []).flatMap((field) => {
          const reading = lacks.absentReading(field)
          return reading === undefined ? [] : [[field, reading.value] as const]
        })
        return absent.length === 0
          ? uState.updates
          : { ...(uState.updates as object), ...Object.fromEntries(absent) }
      }
      const requestedRv = uState.returnValues ?? "allNew"
      // A cascade propagates the NEW item; a mode returning the OLD one then
      // needs both images exactly — the read-then-write branch has both.
      const needsBothImages =
        uState.cascade !== undefined && (requestedRv === "allOld" || requestedRv === "updatedOld")
      const updates = uState.updates
      const evExpected = uState.expectedVersion
      // An entity without `versioned` has no version to check: an expected
      // version would be silently skipped — a concurrency check that never
      // runs — so it is refused before anything is read or sent (#134).
      if (evExpected !== undefined && !systemFields.version) {
        return yield* new ValidationError({
          entityType,
          operation: "update.expectedVersion",
          cause:
            `expectedVersion(${evExpected}): entity "${entityType}" is not versioned, so there ` +
            "is no version to check. Add `versioned: true`, or use a `.condition()`. Nothing was sent.",
        })
      }
      // The caller's condition, ANDed onto `patch`'s exists guard — a guard
      // no `.condition()` can replace (#133).
      const userCond = withGuard(
        uState.patch ? { attributeExists: [config.indexes.primary.pk.field] } : undefined,
        uState.condition,
      )
      yield* checkWithVectorNames(uState.withVectors, "update")

      // Caller key: Type side in, ENCODED out (see `encodeKey`).
      const encodedKey = encoded ?? (yield* encodeKey(key, "update.decodeKey"))
      // A missing item: `patch`'s exists guard failed — `ConditionalCheckFailed`,
      // on every path, including those that read first (#134); for `update`,
      // `ItemNotFound`.
      const missingItem = () =>
        uState.patch
          ? new ConditionalCheckFailed({
              entityType,
              key: encodedKey as globalThis.Record<string, unknown>,
            })
          : new ItemNotFound({ entityType, key: encodedKey })

      // Encode update payload → wire form (see `put` for the strategy).
      const encodedUpdates = yield* encodeForWrite(
        schemas.updateSchema as Schema.Codec<any>,
        updates ?? {},
        "update",
      )

      const unstorable =
        unstorableOperand(uState, encodedUpdates as globalThis.Record<string, unknown>) ??
        notReadBackOperand(uState)
      if (unstorable !== undefined) {
        return yield* new ValidationError({ entityType, operation: "update", cause: unstorable })
      }

      // Refs are hydrated by reading the entities they name: a payload holding any has its keys
      // checked after those reads.
      const refsToHydrate = hasRefs
        ? resolvedRefs.filter(
            (ref) =>
              ref.idFieldName in (encodedUpdates as globalThis.Record<string, unknown>) &&
              (encodedUpdates as globalThis.Record<string, unknown>)[ref.idFieldName] !== undefined,
          )
        : []
      // A payload whose refs are read first has its entry keys judged before that read, by what
      // is known before it: an update that surely refuses the keys a put refuses
      // (`refusesPutKeys`, which a path op rules out) refuses them, and any other the keys every
      // update refuses. `checkUpdatePayload` judges the rest once the refs are in.
      if (refsToHydrate.length > 0) {
        const refusedKey = refusedSparseKey(
          encodedUpdates,
          (isRetainEnabled() || needsBothImages) && !hasPathOps(uState),
          everyRowWrites,
        )
        if (refusedKey !== undefined) {
          return yield* new ValidationError({
            entityType,
            operation: "update.sparse",
            cause: refusedKey,
          })
        }
      }
      const checked =
        refsToHydrate.length === 0
          ? yield* checkUpdatePayload(
              uState,
              needsBothImages,
              encodedKey,
              encodedUpdates,
              encodedUpdates as globalThis.Record<string, unknown>,
            )
          : undefined
      // The operands written as values of a field, in the form they're written: refused here if
      // the schema refuses one, before anything is read or sent, and written as encoded here.
      const operands = encodeOperands(uState)
      if ("issue" in operands) {
        return yield* new ValidationError({
          entityType,
          operation: operands.operation,
          cause: operands.issue,
        })
      }
      return {
        uState,
        operands,
        removedToDefault,
        immutables,
        upsertable,
        createInput,
        lacks,
        requestedRv,
        needsBothImages,
        evExpected,
        userCond,
        tc,
        ttlAttrName,
        encodedKey,
        missingItem,
        encodedUpdates,
        refsToHydrate,
        checked,
      }
    })

  /**
   * A payload's sparse entry key its write refuses, in words: decided from the payload alone, so
   * before anything is read. A write that flattens the whole item (`whole`: a put, and an update
   * that reads the row and writes it back) refuses the keys the map's writer refuses
   * (`validateSparseKey`); the row's own entries are written back as they're stored. An update
   * sent as an expression refuses an empty key and one holding `#`.
   *
   * Only a value the operation writes whatever the row holds is judged here. An update never
   * writes an immutable field, and an upsert writes one only into a row that isn't there: with
   * the row present it succeeds whatever the immutable map's keys are, so nothing refuses it
   * before the read.
   */
  const refusedSparseKey = (
    payload: unknown,
    whole: boolean,
    /** Whether the operation writes the field's value whatever the row holds. */
    writes: (field: string) => boolean = () => true,
  ): string | undefined => refusedSparseEntry(payload, whole, writes)?.refusal

  /** The entry {@link refusedSparseKey} refuses: its map, its key, and why. */
  const refusedSparseEntry = (
    payload: unknown,
    whole: boolean,
    writes: (field: string) => boolean,
  ):
    | {
        readonly field: string
        readonly prefix: string
        readonly key: string
        readonly refusal: string
      }
    | undefined => {
    if (!hasSparseFields || typeof payload !== "object" || payload === null) return undefined
    for (const [field, sparse] of Object.entries(sparseFields)) {
      if (!writes(field) || !Object.hasOwn(payload, field)) continue
      const value = (payload as globalThis.Record<string, unknown>)[field]
      if (value === null || typeof value !== "object") continue
      for (const key of Object.keys(value)) {
        const refusal = whole
          ? sparseKeyRefusal(field, sparse.prefix, key)
          : key.length === 0 || key.includes("#")
            ? `Sparse map "${field}": invalid key ${JSON.stringify(key)}`
            : undefined
        if (refusal !== undefined) return { field, prefix: sparse.prefix, key, refusal }
      }
    }
    return undefined
  }

  /** Whether an update or an upsert writes the field's value whatever the row holds. */
  const everyRowWrites = (field: string): boolean => !immutableFields.has(field)

  /**
   * Whether an update refuses the entry keys a put refuses (`refusedSparseKey`'s `whole`): one that
   * reads the row and writes it whole for a retained entity, a change to a unique field, a computed
   * index composite or both images, and carries no path operation, as 1.39.0 decided it. Any other
   * refuses only an empty key and one holding `#`. An upsert over a row it read is written whole as
   * well (`rewritesWholeItem`), but 1.39.0 sent it as the update of the upserted fields, so it
   * refuses what that update refuses.
   */
  const refusesPutKeys = (
    needsBothImages: boolean,
    checked: {
      readonly touchesUniqueFields: boolean
      readonly computedComposites: ReadonlyArray<string>
      readonly pathOpsPresent: boolean
    },
  ): boolean =>
    (isRetainEnabled() ||
      checked.touchesUniqueFields ||
      checked.computedComposites.length > 0 ||
      needsBothImages) &&
    !checked.pathOpsPresent

  /** Whether an update reads the row and writes it whole, in a transaction, and not as an expression. */
  const rewritesWholeItem = (
    uState: UpdateState,
    needsBothImages: boolean,
    checked: {
      readonly touchesUniqueFields: boolean
      readonly computedComposites: ReadonlyArray<string>
      readonly pathOpsPresent: boolean
    },
  ): boolean =>
    refusesPutKeys(needsBothImages, checked) ||
    (uState.upsertOver !== undefined && !checked.pathOpsPresent)

  /**
   * Whether an update writes or changes a field one of the entity's unique constraints holds: a
   * field its payload sets (to anything but `undefined`) or one of its operations names.
   */
  const touchesUniqueFieldsOf = (
    uState: UpdateState,
    updates: globalThis.Record<string, unknown>,
  ): boolean => {
    if (config.unique == null || Object.keys(config.unique).length === 0) return false
    const uniqueFieldSet = new Set(
      Object.values(config.unique).flatMap((def) => [...resolveUniqueFields(def)]),
    )
    const allUpdatedFields = new Set([
      ...Object.keys(updates).filter((k) => updates[k] !== undefined),
      ...(uState.remove ?? []),
      ...Object.keys(uState.add ?? {}),
      ...Object.keys(uState.subtract ?? {}),
      ...Object.keys(uState.append ?? {}),
      ...Object.keys(uState.deleteFromSet ?? {}),
    ])
    return [...uniqueFieldSet].some((f) => allUpdatedFields.has(f))
  }

  /**
   * The refusals an update's keys decide, before reading anything: a key its payload composes with
   * no key text or level, and path operations no read-then-write can carry. Returns the primary key
   * and what decides the write's path.
   */
  const checkUpdatePayload = (
    uState: UpdateState,
    needsBothImages: boolean,
    encodedKey: globalThis.Record<string, unknown>,
    encodedUpdates: unknown,
    hydratedUpdates: globalThis.Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      // The index keys the payload feeds, composed once before anything is
      // marshalled: a composite with no key text (`NaN`, `[EDD-9096]`) or
      // Z-order level (`[EDD-9092]`) fails the update with a
      // `ValidationError`. Each branch below composes the keys it writes itself.
      yield* composeKeysOrFail(entityType, "update", () =>
        KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          entityType,
          entityVersion,
          allIndexes,
          keyForm(hydratedUpdates as globalThis.Record<string, unknown>),
          keyForm(encodedKey as globalThis.Record<string, unknown>),
          // The branches below know more: the retain path reads the whole item
          // first, so a shard it can compute is not refused here (#183).
          {
            onMissingShardSource: "keep",
            ...(uState.remove === undefined ? {} : { removedSet: new Set(uState.remove) }),
          },
        ),
      )
      yield* refuseUncomposed(encodedUpdates, "update")

      // Compose primary key
      const primaryKey = composePrimaryKey(encodedKey)
      const marshalledKey = toAttributeMap(primaryKey)

      // Detect whether the update touches any unique constraint fields
      const touchesUniqueFields = touchesUniqueFieldsOf(uState, hydratedUpdates)

      // `.add()` / `.subtract()` / `.append()` / `.deleteFromSet()` on an
      // index composite: DynamoDB would compute the new value, but the
      // index key is composed from it here — so the item is read, the
      // value computed and the keys recomposed by the read-then-write
      // branch below, exactly as for a retain entity (#133).
      const indexComposites = indexCompositeFields()
      const computedComposites = [
        ...Object.keys(uState.add ?? {}),
        ...Object.keys(uState.subtract ?? {}),
        ...Object.keys(uState.append ?? {}),
        ...Object.keys(uState.deleteFromSet ?? {}),
      ].filter((field) => indexComposites.has(field))

      // Path operations are never emulated in memory: DynamoDB applies them
      // (#133). A retain update carrying them takes the standard branch
      // below, transacted with its version snapshot. An update that also
      // rotates a unique sentinel or computes an index composite needs this
      // branch's read-then-put, which cannot carry them — refused rather
      // than silently dropping them.
      const pathOpsPresent = hasPathOps(uState)
      if (pathOpsPresent && (touchesUniqueFields || computedComposites.length > 0)) {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause: touchesUniqueFields
            ? "Path operations (pathSet, pathAppend, …) cannot be combined with a change to a " +
              "unique-constraint field in one update: the unique sentinels are rotated by a " +
              "read-then-put that DynamoDB path expressions cannot join. Split the update in two."
            : `Path operations (pathSet, pathAppend, …) cannot be combined with a computed ` +
              `change to index composite "${computedComposites[0]}" in one update: its new ` +
              "value is computed by a read-then-put that DynamoDB path expressions cannot " +
              "join. Split the update in two.",
        })
      }
      if (needsBothImages && pathOpsPresent && !isRetainEnabled() && !systemFields.version) {
        return yield* new ValidationError({
          entityType,
          operation: "update",
          cause:
            'A cascade with returnValues("allOld" | "updatedOld") and path operations ' +
            "needs the item before AND after the update exactly, which an entity without " +
            "`versioned` cannot prove. Drop the path operations, the cascade, or the mode.",
        })
      }
      const checked = {
        primaryKey,
        marshalledKey,
        touchesUniqueFields,
        computedComposites,
        pathOpsPresent,
      }
      const refused = refusedSparseKey(
        hydratedUpdates,
        refusesPutKeys(needsBothImages, checked),
        everyRowWrites,
      )
      if (refused !== undefined) {
        return yield* new ValidationError({
          entityType,
          operation: "update.sparse",
          cause: refused,
        })
      }
      return checked
    })

  /** An update from what {@link prepareUpdate} decided: its reads and its write. */
  const runPreparedUpdate = (
    key: unknown,
    prepared: Effect.Success<ReturnType<typeof prepareUpdate>>,
    mode: DecodeMode,
    /**
     * The item as already read — consistently — by the caller (`upsert`).
     * Used instead of reading it again: the write is guarded on it either way.
     */
    preRead?: globalThis.Record<string, AttributeValue>,
  ) =>
    Effect.gen(function* () {
      const {
        uState,
        removedToDefault,
        immutables,
        upsertable,
        createInput,
        lacks,
        requestedRv,
        needsBothImages,
        evExpected,
        userCond,
        tc,
        ttlAttrName,
        encodedKey,
        missingItem,
        encodedUpdates,
        operands,
      } = prepared
      const client = yield* Capacity.client
      const tableName = tc.name
      // Clock-backed time source for the updatedAt timestamp + retain snapshot TTL.
      const now = yield* DateTime.now
      // Hydrate refs in updates: for any ${field}Id present, fetch and embed
      const hydratedUpdates =
        prepared.refsToHydrate.length > 0
          ? yield* hydrateRefs(
              encodedUpdates as globalThis.Record<string, unknown>,
              prepared.refsToHydrate,
            )
          : (encodedUpdates as globalThis.Record<string, unknown>)
      const { primaryKey, marshalledKey, touchesUniqueFields, computedComposites, pathOpsPresent } =
        prepared.checked ??
        (yield* checkUpdatePayload(
          uState,
          needsBothImages,
          encodedKey,
          encodedUpdates,
          hydratedUpdates,
        ))
      if (
        rewritesWholeItem(uState, needsBothImages, {
          touchesUniqueFields,
          computedComposites,
          pathOpsPresent,
        })
      ) {
        // --- Retain path: read-then-transact ---
        // Read current item (needed to create snapshot of pre-update state)
        const currentResult =
          preRead !== undefined ? { Item: preRead } : yield* readCurrent(tableName, marshalledKey)

        if (!currentResult.Item) {
          return yield* missingItem()
        }

        const currentRaw = fromAttributeMap(currentResult.Item)
        // 0: written before the entity was `versioned` (#133).
        const currentVersion = systemFields.version
          ? (((currentRaw as globalThis.Record<string, unknown>)[systemFields.version] as
              | number
              | undefined) ?? 0)
          : 0

        // Validate optimistic lock if requested
        if (evExpected !== undefined && currentVersion !== evExpected) {
          return yield* new OptimisticLockError({
            entityType,
            key: encodedKey,
            expectedVersion: evExpected,
            actualVersion: currentVersion,
          })
        }

        // Build new item: merge current + updates + rich ops + recompose keys.
        // `currentRaw` uses DynamoDB attribute names (e.g. `dn`, `hd`);
        // `hydratedUpdates` uses domain names. To avoid the merge leaving
        // both names (which would later have the rename clobber the user's
        // value), translate the current item's keys to domain names first
        // so the spread + assign overlay cleanly.
        const currentDomainItem = {
          ...(currentRaw as globalThis.Record<string, unknown>),
        }
        // Read as every read path reads a row: sparse entries are taken from the
        // attribute-keyed row first, then the names are mapped. The other order
        // took a field named as an entry (`data#x`, stored as `counter`) for the
        // entry, once the rename had put it under that name.
        deserializeSparseFields(currentDomainItem)
        renameFromDynamo(currentDomainItem)
        const newItem: globalThis.Record<string, unknown> = {
          ...uState.upsertOver?.fill,
          ...currentDomainItem,
        }
        // Apply user updates. For sparse fields, merge bucket-by-bucket
        // rather than whole-field replace — concurrent writers to disjoint
        // buckets must coexist (the version CAS protects against same-bucket
        // races). Non-sparse fields use the existing replace semantics.
        //
        // null means "absent" under v3's two-way classification (DESIGN.md
        // §7), unless a row can't lack the field, whose `null` is its value.
        // For the in-memory item we DELETE the attribute (mirrors a DynamoDB
        // REMOVE), so subsequent decode sees the field as absent rather than
        // as a typed null that the model schema may not permit. The composer
        // below sees the attr as absent in `newItem` and applies the
        // structural rule. An `undefined` is an encoded value that writes
        // nothing: the payload's own `undefined`s are already `.remove()`.
        for (const [attr, val] of Object.entries(
          hydratedUpdates as globalThis.Record<string, unknown>,
        )) {
          if (val === undefined || (val === null && lacks.omits(attr))) {
            delete newItem[attr]
            continue
          }
          if (hasSparseFields && attr in sparseFields && typeof val === "object") {
            const existing = (newItem[attr] as globalThis.Record<string, unknown>) ?? {}
            newItem[attr] = { ...existing, ...(val as globalThis.Record<string, unknown>) }
          } else {
            newItem[attr] = val
          }
        }

        // Apply rich operations to in-memory item
        if (uState.remove) {
          for (const attr of uState.remove) {
            delete newItem[attr]
          }
        }
        // Sparse-map removes: drop named entries from the in-memory Record.
        if (uState.sparseRemoveEntries) {
          for (const op of uState.sparseRemoveEntries) {
            if (!hasSparseFields || !(op.field in sparseFields)) continue
            const bucket = newItem[op.field] as globalThis.Record<string, unknown> | undefined
            if (!bucket) continue
            for (const k of op.keys) delete bucket[k]
          }
        }
        // Sparse-map clear: blow away the entire bucket Record. The retain
        // path always reads-then-writes the full item, so the version CAS
        // already gives clearMap atomic semantics for free — no per-bucket
        // GET dance needed here.
        if (uState.sparseClearFields) {
          for (const field of uState.sparseClearFields) {
            if (!hasSparseFields || !(field in sparseFields)) continue
            newItem[field] = {}
          }
        }
        // Where a record operation's attribute is in the row as read: an operation naming a
        // sparse map's entry by its attribute (`.add({ "data#views": 1 })`) reaches the entry
        // in the map, as the same operation sent as an expression does. Applied to a key of
        // its own, it was overwritten by the entry when the map was flattened: the operation
        // reported success and changed nothing.
        //
        // `attr`, and an entry's key, are names the caller supplies: each is read and written as
        // the holder's OWN property, never as a member every object inherits. `data#constructor`
        // on an empty map found `Object`'s constructor, and `2` was added to a function.
        const slot = (attr: string): [globalThis.Record<string, unknown>, string] => {
          const entry = isModelField(attr) ? undefined : sparseEntries.entryOf(attr)
          if (entry === undefined) return [newItem, attr]
          const map: globalThis.Record<string, unknown> = Object.assign(
            Object.create(null),
            newItem[entry.field] as globalThis.Record<string, unknown> | undefined,
          )
          newItem[entry.field] = map
          return [map, entry.key]
        }
        const held = (holder: globalThis.Record<string, unknown>, key: string): unknown =>
          Object.hasOwn(holder, key) ? holder[key] : undefined
        const hold = (
          holder: globalThis.Record<string, unknown>,
          key: string,
          value: unknown,
        ): void => {
          Object.defineProperty(holder, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          })
        }
        if (uState.add) {
          for (const [attr, val] of Object.entries(uState.add)) {
            // DynamoDB's ADD: a number adds, a set unions, and a row without the attribute
            // starts from nothing.
            const [holder, key] = slot(attr)
            const before = held(holder, key)
            hold(
              holder,
              key,
              typeof val === "number"
                ? ((before as number) ?? 0) + val
                : new Set<unknown>([...(before instanceof Set ? before : []), ...val]),
            )
          }
        }
        if (uState.subtract) {
          for (const [attr, val] of Object.entries(uState.subtract)) {
            const [holder, key] = slot(attr)
            hold(holder, key, ((held(holder, key) as number) ?? 0) - val)
          }
        }
        if (uState.append) {
          for (const attr of Object.keys(uState.append)) {
            const [holder, key] = slot(attr)
            const existing = (held(holder, key) as Array<unknown>) ?? []
            hold(holder, key, [...existing, ...(operands.append[attr] as ReadonlyArray<unknown>)])
          }
        }
        if (uState.deleteFromSet) {
          for (const [attr, val] of Object.entries(uState.deleteFromSet)) {
            const [holder, key] = slot(attr)
            const before = held(holder, key)
            if (before instanceof Set && val instanceof Set) {
              const current = new Set(before as Set<unknown>)
              for (const elem of val as Set<unknown>) {
                current.delete(elem)
              }
              hold(holder, key, current)
            }
          }
        }

        // A unique field that held only a default gets its sentinel once a
        // write supplies (or removes) its value (#133).
        const defaultedMarker = newItem[UNSENTINELED_DEFAULTS]
        if (defaultedMarker instanceof Set) {
          const supplied = new Set<string>([
            ...Object.keys(hydratedUpdates as globalThis.Record<string, unknown>),
            ...(uState.remove ?? []),
            ...Object.keys(uState.add ?? {}),
            ...Object.keys(uState.subtract ?? {}),
          ])
          const still = [...(defaultedMarker as ReadonlySet<string>)].filter(
            (f) => !supplied.has(f),
          )
          if (still.length === 0) delete newItem[UNSENTINELED_DEFAULTS]
          else newItem[UNSENTINELED_DEFAULTS] = new Set(still)
        }
        // …and a unique field removed back to its default holds only a default.
        const uniqueRemovedToDefault = removedToDefault.filter((field) =>
          Object.values(config.unique ?? {}).some((def) =>
            resolveUniqueFields(def as UniqueConstraintDef).includes(field),
          ),
        )
        if (uniqueRemovedToDefault.length > 0) {
          const marker = newItem[UNSENTINELED_DEFAULTS]
          newItem[UNSENTINELED_DEFAULTS] = new Set([
            ...(marker instanceof Set ? (marker as ReadonlySet<string>) : []),
            ...uniqueRemovedToDefault,
          ])
        }

        // Increment version and update timestamp. If the caller supplied a
        // value for `updatedAt` (allowed when the field collides with a
        // model-declared field), respect it (already wire-form via encode);
        // else generate a fresh wire primitive.
        const newVersion = currentVersion + 1
        if (systemFields.version) newItem[systemFields.version] = newVersion
        if (systemFields.updatedAt) {
          const userSupplied = (hydratedUpdates as globalThis.Record<string, unknown>)[
            systemFields.updatedAt
          ]
          newItem[systemFields.updatedAt] =
            userSupplied !== undefined
              ? userSupplied
              : generateTimestamp(systemFields.updatedAtEncoding, now)
        }

        // `newItem` is already in domain names (the merge built it from
        // `currentDomainItem` + domain-keyed updates) — no rename needed
        // here. Recompose all keys with the updated attributes.
        //
        // Primary key always recomposes from `newItem` (Put-style).
        const primaryKeyMap = composePrimaryKey(newItem)
        Object.assign(newItem, primaryKeyMap)

        // GSI keys: route through the policy-aware composer so the
        // v1.7.1 per-half evaluation gate, structural rule, and per-half
        // cascade match the standard update path. `newItem` carries
        // stored values for any composite the user did not touch — used
        // as the merged record for the structural rule. The composer
        // emits per-half SETs/REMOVEs/noops that we apply directly to
        // `newItem` (which becomes the put-style item written back). A half it
        // says nothing about keeps its stored value, already on `newItem` from
        // the read-then-write merge above, as on the standard path.
        //
        // EDD-9024 was deprecated in v1.7.1 — hole patterns don't throw. A
        // Z-order value the composer can't place (EDD-9092, #171) fails the
        // update with a `ValidationError`.
        const retainRemovedSet = uState.remove ? new Set(uState.remove) : undefined
        const gsiUpdate = yield* composeKeysOrFail(entityType, "update", () =>
          KeyComposer.composeGsiKeysForUpdatePolicyAware(
            schema,
            entityType,
            entityVersion,
            allIndexes,
            keyForm(hydratedUpdates as globalThis.Record<string, unknown>),
            keyForm(newItem),
            {
              ...(retainRemovedSet === undefined ? {} : { removedSet: retainRemovedSet }),
              stamped: keyForm(writeStamps(newItem[systemFields.updatedAt ?? ""], newVersion)),
            },
          ),
        )
        for (const [field, value] of Object.entries(gsiUpdate.sets)) {
          newItem[field] = value
        }
        for (const field of gsiUpdate.removes) {
          delete newItem[field]
        }
        // Compute sentinel rotation values while newItem is in domain names.
        // currentRaw uses DynamoDB names, so read it through `toDomainView`
        // for fields that may have been renamed (e.g. id → teamId).
        // Sparse-aware rotation: each constraint may transition through one of four
        // states between old and new — both-missing (no-op), missing→present (Put only),
        // present→missing (Delete only), present→present (Delete + Put if changed).
        type SentinelRotation = {
          constraintName: string
          oldUniqueKey: { readonly pk: string; readonly sk: string } | undefined
          newUniqueKey: { readonly pk: string; readonly sk: string } | undefined
          newFieldsRecord: globalThis.Record<string, string> | undefined
        }
        const sentinelRotations: Array<SentinelRotation> = []
        if (touchesUniqueFields) {
          const currentRawDomain = toDomainView(currentRaw as globalThis.Record<string, unknown>)
          for (const [constraintName, constraintDef] of Object.entries(config.unique!)) {
            const oldSentinel = composeUniqueSentinel(
              schema,
              entityType,
              constraintName,
              constraintDef,
              currentRawDomain,
              readSentinelValue,
            )
            const newSentinel = composeUniqueSentinel(
              schema,
              entityType,
              constraintName,
              constraintDef,
              newItem,
              (field, value) =>
                Object.is(value, currentDomainItem[field])
                  ? readSentinelValue(field, value)
                  : storedSentinelValue(field, value),
            )

            if (!oldSentinel && !newSentinel) continue
            if (
              oldSentinel &&
              newSentinel &&
              oldSentinel.key.pk === newSentinel.key.pk &&
              oldSentinel.key.sk === newSentinel.key.sk
            ) {
              continue
            }

            sentinelRotations.push({
              constraintName,
              oldUniqueKey: oldSentinel?.key,
              newUniqueKey: newSentinel?.key,
              newFieldsRecord: newSentinel?.fieldsRecord,
            })
          }
        }

        // Vector search: the retain path already holds the full merged
        // item, so a put-style recompute is exact — no extra read needed.
        // Re-embedding is still gated on the payload touching a source
        // field (`DESIGN.md §14`); untouched indexes keep their stored
        // vector, which the merge above already carried onto `newItem`.
        if (hasVectorIndexes) {
          const embedFor = new Set(
            vectorIndexesNeedingUpdate(
              collectTouchedFields(hydratedUpdates as globalThis.Record<string, unknown>, uState),
              uState.withVectors,
            ).map(([logicalName]) => logicalName),
          )
          // `newItem` is the fully merged post-update item (removals already
          // applied above), so a put-style recompute is exact.
          // Untouched packed fields still hold their stored form on `newItem`
          // (kept byte-identical for the write diff), so the source text is
          // derived from an unpacked copy.
          const vectorWrite = yield* computeVectorAttributes(
            yield* unpackedDomainCopy(newItem, "update.vector"),
            uState.withVectors,
            embedFor,
          )
          Object.assign(newItem, vectorWrite.sets)
          for (const field of vectorWrite.removes) delete newItem[field]
        }

        // Convert back to DynamoDB attribute names for storage
        renameToDynamo(newItem)
        // Flatten sparse Map fields into per-entry top-level attributes. The payload's keys were
        // checked before the read (`checkUpdatePayload`), and the row's own entries go back under
        // the attributes they were read from, whatever their keys.
        for (const [field, sparse] of Object.entries(sparseFields)) {
          const value = newItem[field]
          delete newItem[field]
          if (value === null || typeof value !== "object") continue
          for (const [key, entry] of Object.entries(value))
            newItem[`${sparse.prefix}#${key}`] = entry
        }
        // Pack only the packed fields this update names: the others still
        // hold the stored value read above (a string or bytes), carried
        // byte-identical so the "write only what differs" diff below leaves
        // them alone (#147).
        yield* packFields(
          newItem,
          "update",
          new Set(
            Object.entries(hydratedUpdates as globalThis.Record<string, unknown>)
              .filter(([field, value]) => field in packedFields && value != null)
              .map(([field]) => resolveDbName(field)),
          ),
        )

        const currentItem = currentResult.Item
        yield* checkVersion(currentItem, "update")
        const immutableChange =
          immutableMismatch(immutables, currentItem) ??
          (yield* packedImmutableMismatch(immutables, currentItem))
        if (immutableChange !== undefined) {
          return yield* new ValidationError({
            entityType,
            operation: "update",
            cause: immutableChange,
          })
        }
        const pkField = config.indexes.primary.pk.field
        const skField = config.indexes.primary.sk.field
        // A legacy item of an entity whose incarnation is proven by a
        // hidden token gets one now, so the write is provable from here on.
        if (stampsIncarnation && currentItem[INCARNATION_TOKEN] === undefined) {
          newItem[INCARNATION_TOKEN] = yield* freshIncarnation
        }
        const marshalledNewItem = toAttributeMap(newItem)

        // The write is a guarded Update of what changed — never a Put of
        // the whole item read, which would overwrite whatever another
        // writer changed in between (#133). Attributes the update names
        // are written even when unchanged; the rest only when they differ.
        const named = new Set<string>(
          [
            ...Object.keys(hydratedUpdates as globalThis.Record<string, unknown>),
            ...(uState.remove ?? []),
            ...Object.keys(uState.add ?? {}),
            ...Object.keys(uState.subtract ?? {}),
            ...Object.keys(uState.append ?? {}),
            ...Object.keys(uState.deleteFromSet ?? {}),
          ].map(resolveDbName),
        )
        if (systemFields.version) named.add(systemFields.version)
        if (systemFields.updatedAt) named.add(systemFields.updatedAt)
        const setAttrs: globalThis.Record<string, AttributeValue> = {}
        for (const [attr, value] of Object.entries(marshalledNewItem)) {
          if (attr === pkField || attr === skField) continue
          if (named.has(attr) || !attributeValueEquals(currentItem[attr], value)) {
            setAttrs[attr] = value
          }
        }
        const removeAttrs = Object.keys(currentItem).filter((attr) => !(attr in marshalledNewItem))
        const written = new Set<string>([...Object.keys(setAttrs), ...removeAttrs])

        const writeNames: globalThis.Record<string, string> = {}
        const writeValues: globalThis.Record<string, AttributeValue> = {}
        const setClauses = Object.entries(setAttrs).map(([attr, value], i) => {
          writeNames[`#w${i}`] = attr
          writeValues[`:w${i}`] = value
          return `#w${i} = :w${i}`
        })
        const removeClauses = removeAttrs.map((attr, i) => {
          writeNames[`#x${i}`] = attr
          return `#x${i}`
        })
        if (setClauses.length === 0 && removeClauses.length === 0) {
          // Nothing changed: an idempotent write keeps the condition (and
          // the transaction's other items) meaningful.
          writeNames["#we"] = "__edd_e__"
          writeValues[":we"] = currentItem.__edd_e__ ?? toAttributeValue(entityType)
          setClauses.push("#we = :we")
        }
        const updateExpression = [
          setClauses.length > 0 ? `SET ${setClauses.join(", ")}` : "",
          removeClauses.length > 0 ? `REMOVE ${removeClauses.join(", ")}` : "",
        ]
          .filter((part) => part !== "")
          .join(" ")

        // The condition proves the item is still what the new values were
        // computed from. Versioned: its version and incarnation. Otherwise:
        // it exists, and every attribute whose read value fed a computed
        // value is unchanged — so an unrelated concurrent write survives
        // and a concurrent change to an input is refused.
        const condParts: Array<string> = []
        const inputs: Array<string> = []
        if (systemFields.version) {
          condParts.push(versionIs(currentVersion, writeNames, writeValues, "#ver", ":expectedVer"))
          const incarnation = incarnationGuard(currentItem, writeNames, writeValues)
          if (incarnation !== undefined) condParts.push(incarnation)
        } else {
          writeNames["#pk"] = pkField
          condParts.push("attribute_exists(#pk)")
          const fromPayload = new Set<string>([
            ...Object.entries(hydratedUpdates as globalThis.Record<string, unknown>)
              .filter(([, value]) => value !== undefined && value !== null)
              .map(([field]) => field),
          ])
          const add = (fields: ReadonlyArray<string>, always = false) => {
            for (const field of fields) {
              if ((always || !fromPayload.has(field)) && !inputs.includes(field)) {
                inputs.push(field)
              }
            }
          }
          add(
            [
              ...Object.keys(uState.add ?? {}),
              ...Object.keys(uState.subtract ?? {}),
              ...Object.keys(uState.append ?? {}),
              ...Object.keys(uState.deleteFromSet ?? {}),
            ],
            true,
          )
          for (const [indexName, indexDef] of Object.entries(allIndexes)) {
            if (indexName === "primary") continue
            // Not what this write stamps: its own value is what it writes, and a concurrent
            // write that moved it changed nothing this key was composed from.
            const asRead = (composites: ReadonlyArray<string>) =>
              composites.filter(
                (attr) => attr !== systemFields.updatedAt && attr !== systemFields.version,
              )
            if (written.has(indexDef.pk.field)) add(asRead(indexDef.pk.composite))
            if (written.has(indexDef.sk.field)) add(asRead(indexDef.sk.composite))
          }
          for (const rotation of sentinelRotations) {
            add(resolveUniqueFields(config.unique![rotation.constraintName]!), true)
          }
          for (const [, definition] of vectorIndexEntries) {
            if (written.has(definition.vectorField)) add(definition.sourceFields)
            if (written.has(definition.partitionField)) add(definition.partition)
          }
          for (const [i, field] of inputs.entries()) {
            const attr = resolveDbName(field)
            writeNames[`#g${i}`] = attr
            const read = currentItem[attr]
            if (read === undefined) {
              condParts.push(`attribute_not_exists(#g${i})`)
            } else {
              writeValues[`:g${i}`] = read
              condParts.push(`#g${i} = :g${i}`)
            }
          }
        }
        const uc = userCond ? compileCondition(userCond, resolveDbName) : undefined
        if (uc) {
          condParts.push(`(${uc.expression})`)
          Object.assign(writeNames, uc.names)
          Object.assign(writeValues, uc.values)
        }
        const mainUpdate = {
          TableName: tableName,
          Key: marshalledKey,
          UpdateExpression: updateExpression,
          ConditionExpression: condParts.join(" AND "),
          ExpressionAttributeNames: writeNames,
          ...(Object.keys(writeValues).length > 0 && {
            ExpressionAttributeValues: writeValues,
          }),
          ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
        }

        // An update too wide for one expression (DynamoDB: 4 KB, 300
        // operators — e.g. hundreds of sparse-map entries) writes the whole
        // item instead, as before #133: under the version condition when
        // versioned (exact), otherwise under the strongest guard that fits —
        // the same fallback a wide soft delete uses.
        const wide = !expressionFits(updateExpression, "update")
        const wideGuard =
          wide && !systemFields.version
            ? deleteGuard(currentItem, "item", condParts.slice(1).join(" AND "))
            : undefined
        const putCondition =
          wideGuard === undefined
            ? condParts.join(" AND ")
            : [wideGuard.expression, ...condParts.slice(1)].join(" AND ")
        // Only the placeholders the condition uses (the Put has no update expression).
        const putTokens = new Set(putCondition.match(/[#:][A-Za-z0-9_]+/g) ?? [])
        const used = <V>(entries: globalThis.Record<string, V>) =>
          Object.fromEntries(Object.entries(entries).filter(([token]) => putTokens.has(token)))
        const putValues = used({ ...writeValues, ...wideGuard?.values })
        const mainPut = {
          TableName: tableName,
          Item: marshalledNewItem,
          ConditionExpression: putCondition,
          ExpressionAttributeNames: used({ ...writeNames, ...wideGuard?.names }),
          ...(Object.keys(putValues).length > 0 && { ExpressionAttributeValues: putValues }),
          ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
        }
        // A condition over DynamoDB's expression limits is sent as built:
        // DynamoDB rejects it, and the rejection is diagnosed (#144).
        // The stored attributes the rejection compares: the guarded inputs,
        // and on the wide fallback whatever else its guard covered.
        const guardedAttrs = [
          ...new Set([...inputs.map(resolveDbName), ...(wideGuard?.inputs ?? [])]),
        ]

        // A rejected main write: which predicate, from the stored item.
        const mainRejection = (
          stored: Readonly<globalThis.Record<string, unknown>> | undefined,
        ): OptimisticLockError | ConditionalCheckFailed | ConcurrentModification | ItemNotFound => {
          if (systemFields.version) {
            return conditionRejection(
              encodedKey as globalThis.Record<string, unknown>,
              stored,
              { version: currentVersion, read: currentItem },
              userCond !== undefined,
            )
          }
          if (stored === undefined) return missingItem()
          const changed = guardedAttrs.filter(
            (attr) =>
              !attributeValueEquals(stored[attr] as AttributeValue | undefined, currentItem[attr]),
          )
          if (changed.length === 0 && userCond) {
            return new ConditionalCheckFailed({ entityType, key: encodedKey })
          }
          return new ConcurrentModification({
            entityType,
            key: encodedKey,
            attributes: changed.map(domainNameOf),
            current: Option.none(),
          })
        }
        let rejectedItem: globalThis.Record<string, AttributeValue> | undefined
        const recordRejected = (
          stored: Readonly<globalThis.Record<string, unknown>> | undefined,
        ) => {
          rejectedItem = stored as globalThis.Record<string, AttributeValue> | undefined
          return mainRejection(stored)
        }
        // `current` of a ConcurrentModification: the stored item, decoded.
        const withCurrent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.catchIf(
              (e): e is E & ConcurrentModification => e instanceof ConcurrentModification,
              (e) =>
                Effect.gen(function* () {
                  const current =
                    rejectedItem === undefined
                      ? Option.none()
                      : yield* Effect.option(
                          decodeAs(
                            fromAttributeMap(rejectedItem) as globalThis.Record<string, unknown>,
                            rejectedItem,
                            "model",
                          ),
                        )
                  return yield* keepReleaseRace(e, new ConcurrentModification({ ...e, current }))
                }),
            ),
          )

        // Build snapshot of the pre-update state (only when retain is enabled)
        const snapshotItem = isRetainEnabled()
          ? buildSnapshotItem(
              currentRaw as globalThis.Record<string, unknown>,
              currentVersion,
              config.indexes.primary.pk.field,
              config.indexes.primary.sk.field,
              ttlAttrName,
              now,
            )
          : undefined

        const rv = uState.returnValues ?? "allNew"
        // The item before and after the write. Exact: a versioned write is
        // CAS-guarded on what was read; an unguarded-for-unrelated-attribute
        // single UpdateItem returns its own image.
        let oldImage: globalThis.Record<string, AttributeValue> | undefined = currentItem
        let newImage: globalThis.Record<string, AttributeValue> | undefined = marshalledNewItem

        if (snapshotItem === undefined && sentinelRotations.length === 0) {
          // One item: a plain UpdateItem, whose ALL_OLD image plus this
          // write's own SET / REMOVE is the exact new image as well.
          const result = yield* withCurrent(
            (wide
              ? client.putItem({ ...mainPut, ReturnValues: "ALL_OLD" })
              : client.updateItem({ ...mainUpdate, ReturnValues: "ALL_OLD" })
            ).pipe(
              Effect.mapError((err) =>
                isAwsConditionalCheckFailed(err.cause) ? recordRejected(err.cause.Item) : err,
              ),
              diagnoseItemWrite(
                "update",
                wide ? { Put: mainPut } : { Update: mainUpdate },
                () => uc?.expression,
              ),
            ),
          )
          oldImage = result.Attributes ?? currentItem
          const applied: globalThis.Record<string, AttributeValue> = {
            ...oldImage,
            ...setAttrs,
          }
          for (const attr of removeAttrs) delete applied[attr]
          newImage = wide ? marshalledNewItem : applied
        } else {
          type TransactPut = {
            Put: {
              TableName: string
              Item: globalThis.Record<string, AttributeValue>
              ConditionExpression?: string
              ExpressionAttributeNames?: globalThis.Record<string, string>
              ExpressionAttributeValues?: globalThis.Record<string, AttributeValue>
            }
          }
          type TransactDelete = ReturnType<typeof sentinelRelease>
          type TransactUpdate = { Update: typeof mainUpdate }
          type TransactMainPut = { Put: typeof mainPut }
          const transactItems: Array<
            TransactPut | TransactDelete | TransactUpdate | TransactMainPut
          > = [wide ? { Put: mainPut } : { Update: mainUpdate }]

          // Snapshot of pre-update state (only when retain is enabled)
          if (snapshotItem) {
            transactItems.push({ Put: snapshotPut(tableName, snapshotItem) })
          }

          // Apply sentinel rotations computed earlier. Delete and Put are emitted
          // independently — a sparse field that becomes set emits Put only; a sparse
          // field that becomes unset emits Delete only. A Delete releases only a
          // sentinel this item owns (#133): the item may hold the old value
          // without its reservation, which another item may hold.
          const owner = { pk: primaryKey[pkField], sk: primaryKey[skField] }
          const owned = new Set(
            yield* ownedSentinels(
              tableName,
              sentinelRotations.flatMap((rotation) =>
                rotation.oldUniqueKey === undefined ? [] : [rotation.oldUniqueKey],
              ),
              owner,
            ),
          )
          const sentinelPutIndices: Array<{
            index: number
            constraintName: string
            newFieldsRecord: globalThis.Record<string, string>
          }> = []
          const releaseIndices: Array<{ index: number; constraintName: string }> = []
          for (const rotation of sentinelRotations) {
            const held = rotation.oldUniqueKey
            if (held !== undefined && owned.has(held)) {
              releaseIndices.push({
                index: transactItems.length,
                constraintName: rotation.constraintName,
              })
              transactItems.push(sentinelRelease(tableName, held, owner))
            }

            if (rotation.newUniqueKey && rotation.newFieldsRecord) {
              sentinelPutIndices.push({
                index: transactItems.length,
                constraintName: rotation.constraintName,
                newFieldsRecord: rotation.newFieldsRecord,
              })
              transactItems.push({
                Put: {
                  TableName: tableName,
                  Item: toAttributeMap(
                    sentinelItemFor(
                      rotation.constraintName,
                      config.unique![rotation.constraintName]!,
                      rotation.newUniqueKey,
                      owner,
                      now,
                      ttlAttrName,
                    ),
                  ),
                  ...sentinelGuard(),
                },
              })
            }
          }

          yield* withCurrent(
            client.transactWriteItems({ TransactItems: transactItems }).pipe(
              Effect.mapError(
                (
                  err,
                ):
                  | DynamoClientError
                  | OptimisticLockError
                  | ConditionalCheckFailed
                  | ConcurrentModification
                  | ItemNotFound
                  | ValidationError
                  | UniqueConstraintViolation => {
                  if (isAwsTransactionCancelled(err.cause)) {
                    const reasons = err.cause.CancellationReasons
                    if (reasons) {
                      // The main item first: a sentinel Put rejected because
                      // the main write was cancelled reports nothing useful.
                      if (reasons[0]?.Code === "ConditionalCheckFailed") {
                        return recordRejected(reasons[0].Item)
                      }
                      if (snapshotItem && reasons[1]?.Code === "ConditionalCheckFailed") {
                        return historyConflict(currentVersion, "update")
                      }
                      for (const { index, constraintName, newFieldsRecord } of sentinelPutIndices) {
                        if (reasons[index]?.Code === "ConditionalCheckFailed") {
                          return new UniqueConstraintViolation({
                            entityType,
                            constraint: constraintName,
                            fields: newFieldsRecord,
                          })
                        }
                      }
                      for (const { index, constraintName } of releaseIndices) {
                        if (reasons[index]?.Code === "ConditionalCheckFailed") {
                          return releaseRaced(
                            encodedKey as globalThis.Record<string, unknown>,
                            constraintName,
                          )
                        }
                      }
                    }
                  }
                  if (isAwsConditionalCheckFailed(err.cause)) {
                    return recordRejected(err.cause.Item)
                  }
                  return err
                },
              ),
              diagnoseTransactionWrite("update", transactItems, () => uc?.expression),
            ),
          )
        }

        // Execute cascade if configured (retain path) — from the new item.
        if (uState.cascade) {
          const domainData = {
            ...((yield* appliedUpdate(
              decodeAs(
                fromAttributeMap(newImage) as globalThis.Record<string, unknown>,
                newImage,
                "model",
              ),
              "stored",
            )) as object),
          }
          const sourceId =
            sourceIdentifierField != null
              ? (encodedKey as globalThis.Record<string, unknown>)[sourceIdentifierField]
              : undefined
          if (sourceId != null) {
            yield* executeCascade(uState.cascade, domainData, String(sourceId))
          }
        }

        return yield* updateResult(
          rv,
          oldImage,
          newImage,
          written,
          mode,
          encodedKey as globalThis.Record<string, unknown>,
        )
      }

      // --- Standard path: updateItem ---
      // A retain entity reaching this branch carries path operations. Read
      // the item first: its version snapshot is built from it, and the
      // update below is conditioned on that version, so the snapshot is
      // exactly the item the update replaces (#133).
      let retainSnapshot:
        | {
            readonly item: globalThis.Record<string, unknown>
            readonly raw: globalThis.Record<string, AttributeValue>
            readonly version: number
            /** The incarnation the post-image carries (proof of this write). */
            readonly incarnation: AttributeValue | undefined
            /** A fresh incarnation token this write stamps on a legacy item. */
            readonly stamp: string | undefined
          }
        | undefined
      // A cascade that also returns the OLD item, with path operations on a
      // versioned entity: read first, condition the write on that version
      // and incarnation, so the read IS the old item and ALL_NEW the new.
      let casRead:
        | { readonly raw: globalThis.Record<string, AttributeValue>; readonly version: number }
        | undefined
      if (isRetainEnabled() || needsBothImages) {
        const current = yield* readCurrent(tableName, marshalledKey)
        if (!current.Item) {
          return yield* missingItem()
        }
        yield* checkVersion(current.Item, "update")
        const immutableChange =
          immutableMismatch(immutables, current.Item) ??
          (yield* packedImmutableMismatch(immutables, current.Item))
        if (immutableChange !== undefined) {
          return yield* new ValidationError({
            entityType,
            operation: "update",
            cause: immutableChange,
          })
        }
        const currentRaw = fromAttributeMap(current.Item) as globalThis.Record<string, unknown>
        const version = systemFields.version
          ? ((currentRaw[systemFields.version] as number | undefined) ?? 0)
          : 0
        if (evExpected !== undefined && version !== evExpected) {
          return yield* new OptimisticLockError({
            entityType,
            key: encodedKey,
            expectedVersion: evExpected,
            actualVersion: version,
          })
        }
        if (!isRetainEnabled()) {
          casRead = { raw: current.Item, version }
        } else {
          retainSnapshot = {
            item: buildSnapshotItem(
              currentRaw,
              version,
              config.indexes.primary.pk.field,
              config.indexes.primary.sk.field,
              ttlAttrName,
              now,
            ),
            raw: current.Item,
            version,
            ...(stampsIncarnation && current.Item[INCARNATION_TOKEN] === undefined
              ? yield* freshIncarnation.pipe(
                  Effect.map((stamp) => ({ stamp, incarnation: toAttributeValue(stamp) })),
                )
              : {
                  stamp: undefined,
                  incarnation:
                    incarnationAttr !== undefined ? current.Item[incarnationAttr] : undefined,
                }),
          }
        }
      }
      // Plain (unread) updates require the item to exist (#133). One that
      // could create a complete item — a plain `.set()` of every required
      // field and key composite — does so on a missing item through `put`
      // (`createOnMissing`), so the item is exactly the one `put` writes. A
      // `.remove()` beside it clears what `put` wouldn't write anyway, which is
      // what lets a complete `.set({ ..., optional: undefined })` create too.
      const plainWrite = retainSnapshot === undefined && casRead === undefined
      const createsOnMissing =
        plainWrite &&
        upsertable &&
        !uState.patch &&
        evExpected === undefined &&
        userCond === undefined &&
        uState.cascade === undefined &&
        uState.withVectors === undefined &&
        (requestedRv === "allNew" || requestedRv === "none" || requestedRv === "updatedNew") &&
        [uState.sparseRemoveEntries, uState.sparseClearFields].every(
          (ops) => ops === undefined || ops.length === 0,
        ) &&
        [uState.add, uState.subtract, uState.append, uState.deleteFromSet].every(
          (ops) => ops === undefined || Object.keys(ops).length === 0,
        ) &&
        !hasPathOps(uState)
      // A restated packed immutable cannot be asserted by a condition on its
      // stored bytes (they depend on the codec and threshold it was written
      // under): an unread write reads it and compares the unpacked JSON
      // (#147). The write still requires the item (`attribute_exists`), and
      // no library write changes an immutable value in between. A missing
      // item takes the path the write's rejection would have taken — create
      // it, or fail — without sending a write that needs the item: an op that
      // read its row missing writes nothing that requires it, which is what
      // `transactWrite`'s planner relies on.
      if (plainWrite && immutables.some((asserted) => asserted.packed)) {
        const stored = yield* readCurrent(tableName, marshalledKey)
        if (stored.Item === undefined) {
          return yield* createsOnMissing
            ? new MissingForCreate({ input: createInput() })
            : missingItem()
        }
        const packedChange = yield* packedImmutableMismatch(immutables, stored.Item)
        if (packedChange !== undefined) {
          return yield* new ValidationError({
            entityType,
            operation: "update",
            cause: packedChange,
          })
        }
      }
      // Build UpdateExpression
      const setClauses: Array<string> = []
      const names: globalThis.Record<string, string> = {}
      const values: globalThis.Record<string, AttributeValue> = {}
      let counter = 0

      // `hydratedUpdates` was produced by `Schema.encode(updateSchema)` and
      // is already in wire-format (ISO string / epoch number / etc.). Use
      // it directly — no `serializeDateFields` pass required.
      const encodedUpdatesMap = hydratedUpdates as globalThis.Record<string, unknown>

      // System-colliding updatedAt is handled by the system-field block below.
      // createdAt and version are already excluded by `updateSchema`.
      const updateSystemColliders = new Set<string>()
      if (systemFields.updatedAtCollision && systemFields.updatedAt)
        updateSystemColliders.add(systemFields.updatedAt)

      // Add user-provided updates. Buffered REMOVE clauses for null
      // payload entries land in `removeClauses` below — under v3,
      // `set({ attr: null })` REMOVEs the attribute from the item but does
      // NOT separately cascade-drop GSI keys. The structural composer treats
      // the cleared attribute as absent and recomposes (or truncates / drops
      // / no-ops) per the half's policy. EDD-9025 guarantees no composite is
      // nullable, so `set` of `null` is only reachable for non-composite,
      // model-declared-nullable attributes. See DESIGN.md §7. A field a row
      // can't lack keeps its `null`: it's stored, or the row couldn't be read.
      const nullClears: Array<string> = []
      // A sparse map's entries with no stored form, by their placeholders.
      const entryClears: Array<string> = []
      for (const [attr, val] of Object.entries(encodedUpdatesMap)) {
        if (updateSystemColliders.has(attr)) continue

        if (val === undefined || (val === null && lacks.omits(attr))) {
          // Sparse fields: clearing a sparse field with null is a no-op
          // here — the `.removeEntries` API is the explicit per-key
          // remove. Skip to avoid REMOVE'ing the whole prefix erroneously.
          if (hasSparseFields && attr in sparseFields) continue
          nullClears.push(attr)
          continue
        }

        // Sparse fields: emit one SET per bucket. Whole-bucket replace
        // semantics — concurrent writers to disjoint buckets are safe.
        if (hasSparseFields && attr in sparseFields) {
          if (typeof val !== "object") continue
          const sparse = sparseFields[attr]!
          for (const [k, v] of Object.entries(val as globalThis.Record<string, unknown>)) {
            if (typeof k !== "string" || k.length === 0 || k.includes("#")) {
              return yield* new ValidationError({
                entityType,
                operation: "update.sparse",
                cause: `Sparse map "${attr}": invalid key ${JSON.stringify(k)}`,
              })
            }
            const nameKey = `#u${counter}`
            names[nameKey] = `${sparse.prefix}#${k}`
            if (hasNoStoredForm(v)) {
              entryClears.push(nameKey)
              counter++
              continue
            }
            const valKey = `:u${counter}`
            values[valKey] = toAttributeValue(v)
            setClauses.push(`${nameKey} = ${valKey}`)
            counter++
          }
          continue
        }

        const nameKey = `#u${counter}`
        const valKey = `:u${counter}`
        const storedName = resolveDbName(attr)
        names[nameKey] = storedName
        // A packed field is written whole, as its stored form (#147).
        values[valKey] =
          attr in packedFields
            ? (yield* packAttribute(storedName, val, "update"))!
            : toAttributeValue(val)
        setClauses.push(`${nameKey} = ${valKey}`)
        counter++
      }

      // Add updatedAt timestamp. User-supplied value wins (already in wire
      // form via encode); else fall back to a freshly generated wire
      // primitive.
      const suppliedUpdatedAt =
        systemFields.updatedAt === null ? undefined : encodedUpdatesMap[systemFields.updatedAt]
      const stampedUpdatedAt =
        suppliedUpdatedAt !== undefined
          ? suppliedUpdatedAt
          : generateTimestamp(systemFields.updatedAtEncoding, now)
      if (systemFields.updatedAt) {
        const nameKey = `#u${counter}`
        const valKey = `:u${counter}`
        names[nameKey] = resolveDbName(systemFields.updatedAt)
        values[valKey] = toAttributeValue(stampedUpdatedAt)
        setClauses.push(`${nameKey} = ${valKey}`)
        counter++
      }

      // Add version increment
      if (systemFields.version) {
        const nameKey = `#u${counter}`
        names[nameKey] = systemFields.version
        // An item written before the entity was `versioned` has none: its
        // first versioned write makes it version 1 (#133).
        values[":vzero"] = toAttributeValue(0)
        setClauses.push(`${nameKey} = if_not_exists(${nameKey}, :vzero) + :vinc`)
        values[":vinc"] = toAttributeValue(1)
        counter++
      }

      // Rich update operations from state
      const removeClauses: Array<string> = []
      const addClauses: Array<string> = []
      const deleteClauses: Array<string> = []

      // SUBTRACT → synthesize SET #field = #field - :val
      if (uState.subtract) {
        for (const [attr, val] of Object.entries(uState.subtract)) {
          const nameKey = `#u${counter}`
          const valKey = `:u${counter}`
          names[nameKey] = resolveDbName(attr)
          values[valKey] = toAttributeValue(val)
          setClauses.push(`${nameKey} = ${nameKey} - ${valKey}`)
          counter++
        }
      }

      // APPEND → synthesize SET #field = list_append(#field, :val)
      if (uState.append) {
        for (const attr of Object.keys(uState.append)) {
          const nameKey = `#u${counter}`
          const valKey = `:u${counter}`
          names[nameKey] = resolveDbName(attr)
          values[valKey] = toAttributeValue(operands.append[attr])
          setClauses.push(`${nameKey} = list_append(${nameKey}, ${valKey})`)
          counter++
        }
      }

      // REMOVE
      // Two channels feed REMOVE clauses:
      //  1. `Entity.remove([attr])` — explicit per-attribute drop. Cascades
      //     to drop the GSI keys for any GSI containing the attr as a
      //     composite (one of v3's two drop triggers — see DESIGN.md §7).
      //     Tracked in `removedSet` so the composer can apply the cascade
      //     rule.
      //  2. Null payload entries (`set({ attr: null })`). These REMOVE the
      //     attribute from the item only. They do NOT cascade GSI drops —
      //     under v3 two-way classification, the structural composer just
      //     treats the attribute as absent. (EDD-9025 guarantees these
      //     are never composites.)
      const removedSet = uState.remove ? new Set(uState.remove) : undefined
      if (uState.remove) {
        for (const attr of uState.remove) {
          const nameKey = `#r${removeClauses.length}`
          names[nameKey] = resolveDbName(attr)
          removeClauses.push(nameKey)
        }
      }
      for (const attr of nullClears) {
        const nameKey = `#r${removeClauses.length}`
        names[nameKey] = resolveDbName(attr)
        removeClauses.push(nameKey)
      }
      removeClauses.push(...entryClears)

      // Policy-aware GSI key composition (v1.7.1 — per-half evaluation
      // gate, structural rule, and per-half cascade). One call covers
      // SETs (full recompose, truncated leading prefix), per-half REMOVEs
      // (sparse can't-compose, or preserve + cascade override), and
      // per-half noops (preserve + can't-compose without cascade). See
      // DESIGN.md §7 Policy-Aware GSI Composition.
      //
      // EDD-9024 was deprecated in v1.7.1 — hole patterns collapse into the
      // unified can't-compose rule and don't throw. A Z-order value the
      // composer can't place (EDD-9092, #171) fails with a `ValidationError`.
      const gsiUpdate = yield* composeKeysOrFail(entityType, "update", () =>
        KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          entityType,
          entityVersion,
          allIndexes,
          keyForm(hydratedUpdates as globalThis.Record<string, unknown>),
          keyForm(encodedKey as globalThis.Record<string, unknown>),
          {
            ...(removedSet === undefined ? {} : { removedSet }),
            stamped: keyForm(
              writeStamps(
                stampedUpdatedAt,
                retainSnapshot === undefined ? undefined : retainSnapshot.version + 1,
              ),
            ),
          },
        ),
      )
      // The key and vector attributes this update writes — a retain
      // snapshot strips them, so the post-image is rebuilt from these.
      const derivedSets: globalThis.Record<string, AttributeValue> = {}
      const derivedRemoves = new Set<string>()
      for (const [field, value] of Object.entries(gsiUpdate.sets)) {
        const nameKey = `#u${counter}`
        const valKey = `:u${counter}`
        names[nameKey] = field
        values[valKey] = toAttributeValue(value)
        derivedSets[field] = values[valKey]
        setClauses.push(`${nameKey} = ${valKey}`)
        counter++
      }
      for (const keyField of gsiUpdate.removes) {
        const nameKey = `#r${removeClauses.length}`
        names[nameKey] = keyField
        derivedRemoves.add(keyField)
        removeClauses.push(nameKey)
      }

      // Vector search: partition value is recomposed whenever it can be
      // (idempotent); the embedding is regenerated only when the payload
      // touched a `source.fields` member or supplied `.withVector(...)`.
      // See `DESIGN.md §14 Write path`.
      if (hasVectorIndexes) {
        const vectorWrite = yield* computeVectorUpdateAttributes(
          encodedKey as globalThis.Record<string, unknown>,
          marshalledKey,
          tableName,
          hydratedUpdates as globalThis.Record<string, unknown>,
          uState,
        )
        for (const [field, value] of Object.entries(vectorWrite.sets)) {
          const nameKey = `#u${counter}`
          const valKey = `:u${counter}`
          names[nameKey] = field
          values[valKey] = toAttributeValue(value)
          derivedSets[field] = values[valKey]
          setClauses.push(`${nameKey} = ${valKey}`)
          counter++
        }
        // Clearing every source field takes the item out of the index —
        // there is no other way to delete a vector index entry.
        for (const field of new Set(vectorWrite.removes)) {
          const nameKey = `#r${removeClauses.length}`
          names[nameKey] = field
          derivedRemoves.add(field)
          removeClauses.push(nameKey)
        }
      }

      // ADD (atomic numeric increment / set addition)
      if (uState.add) {
        for (const [attr, val] of Object.entries(uState.add)) {
          const nameKey = `#a${addClauses.length}`
          const valKey = `:a${addClauses.length}`
          names[nameKey] = resolveDbName(attr)
          values[valKey] = toAttributeValue(val)
          addClauses.push(`${nameKey} ${valKey}`)
        }
      }

      // DELETE (remove elements from set)
      if (uState.deleteFromSet) {
        for (const [attr, val] of Object.entries(uState.deleteFromSet)) {
          const nameKey = `#d${deleteClauses.length}`
          const valKey = `:d${deleteClauses.length}`
          names[nameKey] = resolveDbName(attr)
          values[valKey] = toAttributeValue(val)
          deleteClauses.push(`${nameKey} ${valKey}`)
        }
      }

      // Path-based operations (from typed callback API)
      const pathCounter = { value: 0 }

      // Path SET operations
      if (uState.pathSets) {
        for (const [i, op] of uState.pathSets.entries()) {
          const pathExpr = compilePath(op.segments, names, "ps", pathCounter, resolveDbName)
          if (op.isPath && op.valueSegments) {
            const srcExpr = compilePath(op.valueSegments, names, "ps", pathCounter, resolveDbName)
            setClauses.push(`${pathExpr} = ${srcExpr}`)
          } else {
            const valKey = `:ps${pathCounter.value++}`
            values[valKey] = toAttributeValue(operands.pathSets[i])
            setClauses.push(`${pathExpr} = ${valKey}`)
          }
        }
      }

      // Path SUBTRACT operations
      if (uState.pathSubtracts) {
        for (const op of uState.pathSubtracts) {
          const pathExpr = compilePath(op.segments, names, "psb", pathCounter, resolveDbName)
          if (op.isPath && op.valueSegments) {
            const srcExpr = compilePath(op.valueSegments, names, "psb", pathCounter, resolveDbName)
            setClauses.push(`${pathExpr} = ${pathExpr} - ${srcExpr}`)
          } else {
            const valKey = `:psb${pathCounter.value++}`
            values[valKey] = toAttributeValue(op.value)
            setClauses.push(`${pathExpr} = ${pathExpr} - ${valKey}`)
          }
        }
      }

      // Path APPEND operations
      if (uState.pathAppends) {
        for (const [i, op] of uState.pathAppends.entries()) {
          const pathExpr = compilePath(op.segments, names, "pa", pathCounter, resolveDbName)
          const valKey = `:pa${pathCounter.value++}`
          values[valKey] = toAttributeValue(operands.pathAppends[i])
          setClauses.push(`${pathExpr} = list_append(${pathExpr}, ${valKey})`)
        }
      }

      // Path PREPEND operations
      if (uState.pathPrepends) {
        for (const [i, op] of uState.pathPrepends.entries()) {
          const pathExpr = compilePath(op.segments, names, "pp", pathCounter, resolveDbName)
          const valKey = `:pp${pathCounter.value++}`
          values[valKey] = toAttributeValue(operands.pathPrepends[i])
          setClauses.push(`${pathExpr} = list_append(${valKey}, ${pathExpr})`)
        }
      }

      // Path if_not_exists operations
      if (uState.pathIfNotExists) {
        for (const [i, op] of uState.pathIfNotExists.entries()) {
          const pathExpr = compilePath(op.segments, names, "pi", pathCounter, resolveDbName)
          const valKey = `:pi${pathCounter.value++}`
          values[valKey] = toAttributeValue(operands.pathIfNotExists[i])
          setClauses.push(`${pathExpr} = if_not_exists(${pathExpr}, ${valKey})`)
        }
      }

      // Path REMOVE operations
      if (uState.pathRemoves) {
        for (const segments of uState.pathRemoves) {
          const pathExpr = compilePath(segments, names, "pr", pathCounter, resolveDbName)
          removeClauses.push(pathExpr)
        }
      }

      // Path ADD operations
      if (uState.pathAdds) {
        for (const op of uState.pathAdds) {
          const pathExpr = compilePath(op.segments, names, "pad", pathCounter, resolveDbName)
          const valKey = `:pad${pathCounter.value++}`
          values[valKey] = toAttributeValue(op.value)
          addClauses.push(`${pathExpr} ${valKey}`)
        }
      }

      // Path DELETE operations
      if (uState.pathDeletes) {
        for (const op of uState.pathDeletes) {
          const pathExpr = compilePath(op.segments, names, "pd", pathCounter, resolveDbName)
          const valKey = `:pd${pathCounter.value++}`
          values[valKey] = toAttributeValue(op.value)
          deleteClauses.push(`${pathExpr} ${valKey}`)
        }
      }

      // Sparse-map .removeEntries — explicit REMOVE on `<prefix>#<key>`.
      // Each key emits one REMOVE clause through ExpressionAttributeNames
      // (the literal "#" survives via compilePath's raw-segment escape).
      if (uState.sparseRemoveEntries) {
        for (const op of uState.sparseRemoveEntries) {
          if (!hasSparseFields || !(op.field in sparseFields)) {
            return yield* new ValidationError({
              entityType,
              operation: "update.removeEntries",
              cause: `field "${op.field}" is not configured as a sparse map`,
            })
          }
          const sparse = sparseFields[op.field]!
          for (const k of op.keys) {
            // An entry the reader reads under `k`: never `<prefix>#` itself.
            if (
              typeof k !== "string" ||
              sparseEntries.entryOf(`${sparse.prefix}#${k}`)?.field !== op.field
            ) {
              return yield* new ValidationError({
                entityType,
                operation: "update.removeEntries",
                cause:
                  `Sparse map "${op.field}": invalid key ${JSON.stringify(k)}: no stored ` +
                  "attribute is read as its entry under it",
              })
            }
            const nameKey = `#sr${removeClauses.length}`
            names[nameKey] = `${sparse.prefix}#${k}`
            removeClauses.push(nameKey)
          }
        }
      }

      // Sparse-map .clearMap — Get-then-Update helper. Reads the current
      // item with a consistent read to discover which `<prefix>#*` attrs
      // exist, then folds the resulting REMOVEs into this same UpdateItem.
      // On a versioned entity the update is conditioned on the version that
      // read found (`casRead`), so a writer adding a bucket in between makes
      // it fail rather than survive the clear; a stale `expectedVersion` is
      // refused before anything is sent. Non-versioned entities are
      // best-effort (a concurrent writer can add a new bucket between the read
      // and the update — that bucket survives).
      if (uState.sparseClearFields && uState.sparseClearFields.length > 0) {
        for (const field of uState.sparseClearFields) {
          if (!hasSparseFields || !(field in sparseFields)) {
            return yield* new ValidationError({
              entityType,
              operation: "update.clearMap",
              cause: `field "${field}" is not configured as a sparse map`,
            })
          }
        }
        // Read once for all clearMap fields combined.
        const clearGetResult = yield* client.getItem({
          TableName: tableName,
          Key: marshalledKey,
          ConsistentRead: true,
        })
        if (clearGetResult.Item) {
          if (systemFields.version && casRead === undefined && retainSnapshot === undefined) {
            yield* checkVersion(clearGetResult.Item, "update")
            const clearedRaw = fromAttributeMap(clearGetResult.Item) as globalThis.Record<
              string,
              unknown
            >
            const version = (clearedRaw[systemFields.version] as number | undefined) ?? 0
            if (evExpected !== undefined && version !== evExpected) {
              return yield* new OptimisticLockError({
                entityType,
                key: encodedKey,
                expectedVersion: evExpected,
                actualVersion: version,
              })
            }
            casRead = { raw: clearGetResult.Item, version }
          }
          const clearItemKeys = Object.keys(clearGetResult.Item)
          for (const field of uState.sparseClearFields) {
            // Exactly the attributes the reader takes as the map's entries.
            for (const attrName of clearItemKeys) {
              if (sparseEntries.entryOf(attrName)?.field === field) {
                const nameKey = `#sc${removeClauses.length}`
                names[nameKey] = attrName
                removeClauses.push(nameKey)
              }
            }
          }
        }
        // If the item doesn't exist, clearMap is a no-op — and the
        // subsequent UpdateItem's existence condition reports it.
      }

      // A legacy retain item gets its incarnation token with this write.
      if (retainSnapshot?.stamp !== undefined) {
        names["#eddInc"] = INCARNATION_TOKEN
        values[":eddInc"] = toAttributeValue(retainSnapshot.stamp)
        setClauses.push("#eddInc = :eddInc")
      }

      const hasAnyUpdate =
        setClauses.length > 0 ||
        removeClauses.length > 0 ||
        addClauses.length > 0 ||
        deleteClauses.length > 0

      const rv = uState.returnValues ?? "allNew"
      if (!hasAnyUpdate) {
        // Nothing to update: nothing written, so nothing "updated"; the
        // whole-item modes are the current item.
        if (rv === "none") return undefined
        if (rv === "updatedOld" || rv === "updatedNew") {
          return yield* decodePartial(undefined, new Set(), mode)
        }
        return yield* get(key)._run(mode)
      }

      // Compose UpdateExpression from all clause types
      const expressionParts: Array<string> = []
      if (setClauses.length > 0) expressionParts.push(`SET ${setClauses.join(", ")}`)
      if (removeClauses.length > 0) expressionParts.push(`REMOVE ${removeClauses.join(", ")}`)
      if (addClauses.length > 0) expressionParts.push(`ADD ${addClauses.join(", ")}`)
      if (deleteClauses.length > 0) expressionParts.push(`DELETE ${deleteClauses.join(", ")}`)
      const updateExpression = expressionParts.join(" ")

      // Build condition expression — combine optimistic lock + user condition
      const condParts: Array<string> = []
      if (evExpected !== undefined && systemFields.version) {
        condParts.push(versionIs(evExpected, names, values, "#condVer", ":expectedVer"))
      }
      if (plainWrite && systemFields.version) {
        // Never version an item whose version was removed outside the library
        // (incarnation token, no version) as if it predated versioning.
        names["#intVer"] = systemFields.version
        names["#intInc"] = INCARNATION_TOKEN
        condParts.push("(attribute_exists(#intVer) OR attribute_not_exists(#intInc))")
      }
      // A plain write already requires the item (`attribute_exists(#exists)`
      // below), so `patch`'s own exists guard would only repeat it.
      const sentCond = plainWrite ? uState.condition : userCond
      const uc = sentCond ? compileCondition(sentCond, resolveDbName) : undefined
      if (uc) {
        condParts.push(`(${uc.expression})`)
        Object.assign(names, uc.names)
        Object.assign(values, uc.values)
      }
      if (plainWrite) {
        // Restated immutable values must match the item's.
        for (const [i, { attr, value, packed }] of immutables.entries()) {
          if (packed) continue // read and compared above (#147)
          names[`#imm${i}`] = attr
          values[`:imm${i}`] = value
          condParts.push(`#imm${i} = :imm${i}`)
        }
        names["#exists"] = config.indexes.primary.pk.field
        condParts.push("attribute_exists(#exists)")
      }
      if (casRead !== undefined && systemFields.version) {
        condParts.push(versionIs(casRead.version, names, values, "#casVer", ":casVer"))
        const incarnation = incarnationGuard(casRead.raw, names, values)
        if (incarnation !== undefined) condParts.push(incarnation)
      }
      // Sent as built: a condition over DynamoDB's expression limits is
      // DynamoDB's to reject, and is diagnosed naming the caller's part (#144).
      const conditionExpression = condParts.length > 0 ? condParts.join(" AND ") : undefined

      // The top-level attributes this update writes — what `updatedOld` /
      // `updatedNew` return.
      const written = expressionTargets(updateExpression, names)
      const cascadeFrom = (image: globalThis.Record<string, AttributeValue>) =>
        Effect.gen(function* () {
          if (!uState.cascade) return
          const sourceId =
            sourceIdentifierField != null
              ? (encodedKey as globalThis.Record<string, unknown>)[sourceIdentifierField]
              : undefined
          if (sourceId == null) return
          const domainData = yield* appliedUpdate(
            decodeAs(fromAttributeMap(image) as globalThis.Record<string, unknown>, image, "model"),
            "stored",
          )
          yield* executeCascade(uState.cascade, { ...(domainData as object) }, String(sourceId))
        })

      if (retainSnapshot !== undefined) {
        // The SAME UpdateExpression, transacted with the version snapshot of
        // the item it replaces — DynamoDB applies the path operations, so
        // their semantics are DynamoDB's own (#133). The version AND the
        // incarnation prove the snapshot is of the item this replaces.
        const snapshot = retainSnapshot
        const guardParts = [...condParts]
        if (systemFields.version) {
          guardParts.push(versionIs(snapshot.version, names, values, "#retainVer", ":retainVer"))
          const incarnation = incarnationGuard(snapshot.raw, names, values)
          if (incarnation !== undefined) guardParts.push(incarnation)
        }
        const transactItems = [
          {
            Update: {
              TableName: tableName,
              Key: marshalledKey,
              UpdateExpression: updateExpression,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
              ...(guardParts.length > 0 && {
                ConditionExpression: guardParts.join(" AND "),
                ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
              }),
            },
          },
          { Put: snapshotPut(tableName, snapshot.item) },
        ]
        yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
          Effect.mapError(
            (
              err,
            ):
              | DynamoClientError
              | OptimisticLockError
              | ConditionalCheckFailed
              | ValidationError => {
              // The update is guarded by the snapshot version AND any user
              // condition; the stored item (ALL_OLD) says which rejected it.
              const rejection = (
                stored: Readonly<globalThis.Record<string, unknown>> | undefined,
              ) =>
                conditionRejection(
                  encodedKey as globalThis.Record<string, unknown>,
                  stored,
                  systemFields.version
                    ? { version: snapshot.version, read: snapshot.raw }
                    : undefined,
                  userCond !== undefined,
                )
              if (isAwsTransactionCancelled(err.cause)) {
                const main = err.cause.CancellationReasons?.[0]
                if (main?.Code === "ConditionalCheckFailed") return rejection(main.Item)
                if (err.cause.CancellationReasons?.[1]?.Code === "ConditionalCheckFailed") {
                  return historyConflict(snapshot.version, "update")
                }
              }
              if (isAwsConditionalCheckFailed(err.cause)) return rejection(err.cause.Item)
              return err
            },
          ),
          diagnoseTransactionWrite("update", transactItems, () => uc?.expression),
        )
        // A transacted Update returns no attributes. The old item is exact:
        // the version condition proves `snapshot.raw` is what it replaced.
        // The new item is read back only when needed, and proven ours.
        const needsNew = rv === "allNew" || rv === "updatedNew" || uState.cascade !== undefined
        const after = needsNew
          ? yield* readRetainPostImage(
              tableName,
              marshalledKey,
              snapshot.raw,
              snapshot.version + 1,
              snapshot.incarnation,
              derivedSets,
              derivedRemoves,
              ttlAttrName,
              encodedKey as globalThis.Record<string, unknown>,
            )
          : undefined
        if (after !== undefined) yield* cascadeFrom(after)
        return yield* updateResult(
          rv,
          snapshot.raw,
          after,
          written,
          mode,
          encodedKey as globalThis.Record<string, unknown>,
        )
      }

      // The image the mode returns; `none` asks for nothing unless a
      // cascade needs the new item.
      const wantsOld = casRead === undefined && (rv === "allOld" || rv === "updatedOld")
      const returned = wantsOld
        ? "ALL_OLD"
        : rv === "none" && !uState.cascade && casRead === undefined
          ? "NONE"
          : "ALL_NEW"
      // DynamoDB rejects an empty `ExpressionAttributeValues` map. When
      // the UpdateExpression is REMOVE-only (e.g. clearMap with no other
      // combinators), `values` may be empty — omit the property entirely.
      const updateInput: UpdateItemCommandInput = {
        TableName: tableName,
        Key: marshalledKey,
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
        ConditionExpression: conditionExpression,
        ...(conditionExpression !== undefined && {
          ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
        }),
        ReturnValues: returned,
      }
      const result = yield* client.updateItem(updateInput).pipe(
        Effect.mapError(
          (
            err,
          ):
            | DynamoClientError
            | OptimisticLockError
            | ConditionalCheckFailed
            | ItemNotFound
            | MissingForCreate
            | ValidationError => {
            // The stored item (ALL_OLD) says what rejected the update: no
            // item (it must exist), a restated immutable value, the
            // version CAS, or the user's condition.
            if (isAwsConditionalCheckFailed(err.cause)) {
              const stored = err.cause.Item
              if (stored === undefined && !uState.patch) {
                return createsOnMissing
                  ? new MissingForCreate({ input: createInput() })
                  : new ItemNotFound({ entityType, key: encodedKey })
              }
              const corrupt = versionCorruption(stored, "update")
              if (corrupt !== undefined) return corrupt
              const immutableChange =
                stored !== undefined ? immutableMismatch(immutables, stored) : undefined
              if (immutableChange !== undefined) {
                return new ValidationError({
                  entityType,
                  operation: "update",
                  cause: immutableChange,
                })
              }
              return conditionRejection(
                encodedKey as globalThis.Record<string, unknown>,
                stored,
                casRead !== undefined
                  ? { version: casRead.version, read: casRead.raw }
                  : systemFields.version && evExpected !== undefined
                    ? { version: evExpected }
                    : undefined,
                userCond !== undefined,
              )
            }
            return err
          },
        ),
        diagnoseItemWrite(
          "update",
          { Update: updateInput as NonNullable<TransactWriteItem["Update"]> },
          () => uc?.expression,
        ),
      )

      // A cascade never meets an old-image mode here: that combination is
      // routed to the read-then-write branch, or read first (`casRead`).
      const newImage = wantsOld ? undefined : result.Attributes
      if (uState.cascade && newImage !== undefined) yield* cascadeFrom(newImage)

      return yield* updateResult(
        rv,
        casRead !== undefined ? casRead.raw : wantsOld ? result.Attributes : undefined,
        newImage,
        written,
        mode,
        encodedKey as globalThis.Record<string, unknown>,
      )
    })

  const runUpdate = (
    key: unknown,
    mode: DecodeMode,
    requested: UpdateState,
    /** See {@link runPreparedUpdate}. */
    preRead?: globalThis.Record<string, AttributeValue>,
  ) =>
    Effect.flatMap(prepareUpdate(key, requested), (prepared) =>
      runPreparedUpdate(key, prepared, mode, preRead),
    )

  /**
   * An update; on a missing item, a plain `.set()` of a complete item creates
   * it through `create` — exactly the item `put` writes (#133). If another
   * writer creates it first, the update runs once more against that item.
   */
  const updateOrCreate = (
    key: unknown,
    mode: DecodeMode,
    requested: UpdateState,
    /** What {@link prepareUpdate} decided of `requested`, when the caller already ran it. */
    prepared?: Effect.Success<ReturnType<typeof prepareUpdate>>,
  ) => {
    const run = () =>
      prepared === undefined
        ? runUpdate(key, mode, requested)
        : runPreparedUpdate(key, prepared, mode)
    return run().pipe(
      Effect.catchIf(
        (e): e is MissingForCreate => e instanceof MissingForCreate,
        (missing) =>
          Effect.gen(function* () {
            const created = yield* Effect.exit(
              (create(missing.input) as unknown as EntityPutImpl<any, any, any, any>)._run(
                "native",
              ) as Effect.Effect<globalThis.Record<string, AttributeValue>, unknown, any>,
            )
            if (created._tag === "Failure") {
              const raced = Cause.findErrorOption(created.cause).pipe(
                Option.filter((e) => e instanceof ConditionalCheckFailed),
              )
              if (Option.isNone(raced)) return yield* created
              // Created concurrently: now an ordinary update of that item.
              return yield* run().pipe(
                Effect.catchIf(
                  (e): e is MissingForCreate => e instanceof MissingForCreate,
                  () =>
                    Effect.fail(
                      new ItemNotFound({
                        entityType,
                        key: key as globalThis.Record<string, unknown>,
                      }),
                    ),
                ),
              )
            }
            const item = created.value
            return yield* updateResult(
              requested.returnValues ?? "allNew",
              undefined,
              item,
              new Set(Object.keys(item)),
              mode,
              key as globalThis.Record<string, unknown>,
            )
          }),
      ),
    )
  }

  const update = (key: unknown) =>
    new EntityUpdateImpl(
      (mode: DecodeMode, requested: UpdateState) => updateOrCreate(key, mode, requested),
      emptyUpdateState,
      self,
      key as globalThis.Record<string, unknown>,
    )

  /**
   * Run one of this entity's write ops with its write recorded instead of
   * sent (`planWrite`), and say how to read a cancellation of what it would
   * have written. The op is the standalone op itself, so the plan carries
   * every read it makes, every item it writes and every guard it puts on them
   * — see `internal/TransactPlan.ts`.
   *
   * The verdict follows a guarded put's (`_planPut`): a cancelled sentinel
   * reservation is the `UniqueConstraintViolation` the standalone op reports;
   * a cancelled main item is the caller's condition when there is one
   * (`TransactionCancelled`); anything else is a lost race — the row changed
   * between the read and the transaction — and `transactWrite` plans it again
   * from a fresh read.
   *
   * `payload` is what the caller asked to write. With the op's own read of
   * the row, it lets a reservation say which values it reserves.
   */
  const planned = <E, R>(
    operation: string,
    /** The key, through `encodeKey`. */
    encodedKey: globalThis.Record<string, unknown>,
    /** The op itself — a factory, because a missing row means running it again. */
    op: () => Effect.Effect<unknown, E, R>,
    request: {
      readonly payload: globalThis.Record<string, unknown>
      /** Values `.add()` / `.subtract()` change by, for the reported reservation. */
      readonly deltas?: globalThis.Record<string, AddOperand> | undefined
      /** The caller's own `.condition()` — not `patch`'s or `deleteIfExists`'s guard. */
      readonly callerCondition: boolean
      readonly expectedVersion?: number | undefined
    },
  ) =>
    Effect.gen(function* () {
      const primaryKey = composePrimaryKey(encodedKey)
      const ownKey = toAttributeMap(primaryKey)
      const plan = (rowMissing?: { readonly rowMissing: true }) =>
        planWrite(operation, op(), ownKey, rowMissing)
      const recorded = yield* plan()
      let { items, ownRow } = recorded
      // An op that wrote without reading its row relies on its write's own
      // condition to find the row missing — a standalone `update` then
      // creates it (or fails `ItemNotFound`), `patch` fails
      // `ConditionalCheckFailed`. A transaction cannot follow that fallback,
      // so the row is read here, and a missing row is answered to the op as
      // its write would have been answered: it takes the same path.
      if (!recorded.readOwnRow && items.length > 0) {
        const client = yield* Capacity.client
        const { name: tableName } = yield* tableTag
        const read = yield* client.getItem({
          TableName: tableName,
          Key: ownKey,
          ConsistentRead: true,
        })
        if (read.Item === undefined) {
          ;({ items, ownRow } = yield* plan({ rowMissing: true }))
        } else {
          ownRow = read.Item
          // A pinned version the row no longer has is refused before sending,
          // as the read-first paths do — not retried as if it were a race.
          if (request.expectedVersion !== undefined && systemFields.version) {
            const stored = fromAttributeMap(read.Item)[systemFields.version]
            const actual = typeof stored === "number" ? stored : 0
            if (actual !== request.expectedVersion) {
              return yield* new OptimisticLockError({
                entityType,
                key: encodedKey,
                expectedVersion: request.expectedVersion,
                actualVersion: actual,
              })
            }
          }
        }
      }
      const pkField = config.indexes.primary.pk.field
      const skField = config.indexes.primary.sk.field
      const isOwn = (row: globalThis.Record<string, AttributeValue> | undefined) => {
        if (row === undefined) return false
        const plain = fromAttributeMap(row)
        return plain[pkField] === primaryKey[pkField] && plain[skField] === primaryKey[skField]
      }
      // What the row looks like after the write, in domain names: the main
      // Put's item when the op writes the whole row, else the row it read
      // overlaid with the payload.
      const mainPut = items.find((i) => i.Put !== undefined && isOwn(i.Put.Item))?.Put?.Item
      const read = ownRow === undefined ? {} : toDomainView(fromAttributeMap(ownRow))
      const after: globalThis.Record<string, unknown> =
        mainPut !== undefined
          ? toDomainView(fromAttributeMap(mainPut))
          : { ...read, ...request.payload }
      if (mainPut === undefined) {
        for (const [field, delta] of Object.entries(request.deltas ?? {})) {
          if (typeof delta !== "number") continue
          const base = read[field]
          after[field] = (typeof base === "number" ? base : 0) + delta
        }
      }
      const sentinelPrefix = `${entityType}._unique.`
      type Role =
        | { readonly _tag: "main" }
        | { readonly _tag: "side" }
        | { readonly _tag: "snapshot"; readonly version: number }
        | { readonly _tag: "reserve"; readonly error: UniqueConstraintViolation }
      const versionPrefix = DynamoSchema.composeVersionKeyPrefix(schema, entityType)
      const roles = items.map((item): Role => {
        if (isOwn(item.Put?.Item) || isOwn(item.Update?.Key) || isOwn(item.Delete?.Key)) {
          return { _tag: "main" }
        }
        // A retain snapshot: in the row's partition, at a version key.
        const putRow = item.Put?.Item === undefined ? undefined : fromAttributeMap(item.Put.Item)
        const putSk = putRow?.[skField]
        if (
          putRow !== undefined &&
          putRow[pkField] === primaryKey[pkField] &&
          typeof putSk === "string" &&
          putSk.startsWith(versionPrefix)
        ) {
          return { _tag: "snapshot", version: storedVersionOf(item.Put?.Item) ?? 0 }
        }
        const tag = item.Put?.Item?.__edd_e__?.S
        if (
          item.Put === undefined ||
          item.Put.ConditionExpression === undefined ||
          tag === undefined ||
          !tag.startsWith(sentinelPrefix)
        ) {
          return { _tag: "side" }
        }
        const constraintName = tag.slice(sentinelPrefix.length)
        const constraintDef = config.unique?.[constraintName]
        const reserved =
          constraintDef === undefined
            ? undefined
            : composeUniqueSentinel(
                schema,
                entityType,
                constraintName,
                constraintDef,
                after,
                storedSentinelValue,
              )
        const putKey = fromAttributeMap(item.Put.Item ?? {})
        // Only values that recompose THIS sentinel are reported — never a guess.
        const fields =
          reserved !== undefined &&
          reserved.key.pk === putKey[pkField] &&
          reserved.key.sk === putKey[skField]
            ? reserved.fieldsRecord
            : {}
        return {
          _tag: "reserve",
          error: new UniqueConstraintViolation({ entityType, constraint: constraintName, fields }),
        }
      })
      // How a rejected main item reads, as a guarded put's does: compare the
      // stored item the cancellation returns (`ALL_OLD`) with the row the
      // plan was built from. Versioned: its version and incarnation.
      // Otherwise: every attribute the main item's condition names — the
      // op's own guard inputs are all among them, so if none changed the
      // guard held, and only the caller's condition can have rejected it.
      const mainItem = items[roles.findIndex((role) => role._tag === "main")]
      const guarded = mainItem?.Update ?? mainItem?.Put ?? mainItem?.Delete
      const conditionAttrs = [
        ...new Set(
          (guarded?.ConditionExpression?.match(/#[A-Za-z0-9_]+/g) ?? []).flatMap((token) => {
            const attr = guarded?.ExpressionAttributeNames?.[token]
            return attr === undefined ? [] : [attr]
          }),
        ),
      ]
      const readVersion = storedVersionOf(ownRow)
      const changedFrom = (stored: globalThis.Record<string, AttributeValue>) =>
        conditionAttrs.filter((attr) => !attributeValueEquals(stored[attr], ownRow?.[attr]))
      const raced = (stored: globalThis.Record<string, AttributeValue>) =>
        systemFields.version
          ? storedVersionOf(stored) !== readVersion ||
            (incarnationAttr !== undefined &&
              !attributeValueEquals(stored[incarnationAttr], ownRow?.[incarnationAttr]))
          : changedFrom(stored).length > 0
      /** A lost race: the error once retries run out, as a guarded put reports it. */
      const lostRace = (stored: globalThis.Record<string, AttributeValue> | undefined) =>
        ({
          _tag: "Retry",
          stored,
          error: systemFields.version
            ? new OptimisticLockError({
                entityType,
                key: encodedKey,
                expectedVersion: readVersion ?? 0,
                actualVersion: storedVersionOf(stored) ?? -1,
              })
            : new ConcurrentModification({
                entityType,
                key: encodedKey as globalThis.Record<string, unknown>,
                attributes: stored === undefined ? [] : changedFrom(stored).map(domainNameOf),
                current: Option.none(),
              }),
        }) as const
      return {
        items,
        // A taken unique value fails; a snapshot the row's own history
        // already holds fails (`historyConflict`, as standalone — re-reading
        // will not change it); the caller's own condition rejecting an
        // unchanged row is a condition. Everything else is a race, retried —
        // and every attempt plans again from fresh reads, so a row now
        // missing takes the op's missing-row path and a pinned version the
        // row no longer has fails `OptimisticLockError`, as standalone.
        verdict: (reasons) => {
          let main: globalThis.Record<string, AttributeValue> | "absent" | undefined
          let sideFailed = false
          for (const [i, role] of roles.entries()) {
            const reason = reasons[i]
            if (reason?.Code !== "ConditionalCheckFailed") continue
            switch (role._tag) {
              case "reserve":
                return { _tag: "Fail", error: role.error }
              case "snapshot":
                return ownRow === undefined
                  ? lostRace(undefined)
                  : { _tag: "Fail", error: historyConflict(role.version, operation) }
              case "main":
                main =
                  reason.Item === undefined
                    ? "absent"
                    : (reason.Item as globalThis.Record<string, AttributeValue>)
                break
              case "side":
                sideFailed = true
            }
          }
          if (main === undefined) return sideFailed ? lostRace(undefined) : undefined
          if (main === "absent") return lostRace(undefined)
          if (raced(main) || !request.callerCondition) return lostRace(main)
          return { _tag: "Condition" }
        },
      } satisfies TransactPlan
    })

  /** Compile an update for `Transaction.transactWrite` — see `_planUpdate`. */
  const planUpdate = (
    key: unknown,
    uState: UpdateState,
    prepared: Effect.Success<ReturnType<typeof prepareUpdate>>,
  ) =>
    planned(
      "transactWrite.update",
      prepared.encodedKey,
      () => updateOrCreate(key, "native", uState, prepared),
      {
        payload: (uState.updates ?? {}) as globalThis.Record<string, unknown>,
        deltas: {
          ...uState.add,
          ...Object.fromEntries(
            Object.entries(uState.subtract ?? {}).map(([field, by]) => [field, -by]),
          ),
        },
        callerCondition: uState.condition !== undefined,
        expectedVersion: uState.expectedVersion,
      },
    )

  // ---------------------------------------------------------------------------
  // delete operation
  // ---------------------------------------------------------------------------

  const del = (key: unknown) =>
    new EntityDeleteImpl(
      (opts: {
        readonly condition: Expr | ConditionInput | undefined
        readonly returnValues: ReturnValuesMode | undefined
        readonly mustExist: boolean
      }) =>
        Effect.gen(function* () {
          const client = yield* Capacity.client
          const tc = yield* tableTag
          const tableName = tc.name
          const ttlAttrName = resolveTtlAttributeName(tc)

          // Caller key: Type side in, ENCODED out (see `encodeKey`).
          const encodedKey = yield* encodeKey(key, "delete.decode")

          // Compose primary key
          const primaryKey = composePrimaryKey(encodedKey)
          const marshalledKey = toAttributeMap(primaryKey)
          const primary = config.indexes.primary
          const hasUniqueConstraints =
            config.unique != null && Object.keys(config.unique).length > 0

          // A delete that reads the item first already requires it to exist,
          // so a condition asserting only that (`deleteIfExists`) adds nothing
          // to its guard: it is judged against the read instead — a missing
          // item is `ConditionalCheckFailed` — and the delete is retried after
          // a race like an unconditioned one.
          const readsFirst = isSoftDeleteEnabled() || hasUniqueConstraints || isRetainEnabled()
          // `deleteIfExists` (alone, or ANDed with a `.condition()`): a missing
          // item fails its condition — a guard no `.condition()` replaces.
          const mustExist = opts.mustExist
          const existenceOnly = readsFirst && mustExist && opts.condition === undefined
          if (
            opts.returnValues !== undefined &&
            opts.returnValues !== "none" &&
            opts.returnValues !== "allOld"
          ) {
            return yield* new ValidationError({
              entityType,
              operation: "delete",
              cause:
                `delete: returnValues("${opts.returnValues}") is not a mode DeleteItem ` +
                'supports — only "none" and "allOld". Nothing was sent.',
            })
          }
          // The caller's condition, ANDed onto `deleteIfExists`'s exists guard.
          const condition = withGuard(
            mustExist ? { attributeExists: [primary.pk.field] } : undefined,
            opts.condition,
          )
          const userCondition =
            condition && !existenceOnly ? compileCondition(condition, resolveDbName) : undefined
          /**
           * What the delete returns: with `returnValues("allOld")`, the item it
           * removed — the one read (every read-first delete is guarded on it) or
           * DynamoDB's `ALL_OLD` — as a model, `undefined` when there was none.
           */
          const deletedResult = (old: globalThis.Record<string, AttributeValue> | undefined) => {
            if (opts.returnValues !== "allOld" || old === undefined)
              return Effect.succeed(undefined)
            const raw = fromAttributeMap(old) as globalThis.Record<string, unknown>
            // The delete is applied: a decode failure must not read as a refusal.
            return decodeAs({ ...raw }, old, "model").pipe(
              Effect.mapError(
                (cause) =>
                  new DeleteAppliedButUnreadable({
                    entityType,
                    key: encodedKey as globalThis.Record<string, unknown>,
                    item: raw,
                    cause,
                  }),
              ),
            )
          }
          /** The item is missing: what a delete that read it reports. */
          const missing = (
            otherwise: ItemNotFound | undefined,
          ): Effect.Effect<undefined, ItemNotFound | ConditionalCheckFailed> =>
            mustExist
              ? Effect.fail(new ConditionalCheckFailed({ entityType, key: encodedKey }))
              : otherwise === undefined
                ? Effect.succeed(undefined)
                : Effect.fail(otherwise)

          /**
           * Map a rejected user condition on either transaction delete path
           * (soft-delete, unique-constraint) to `ConditionalCheckFailed`.
           *
           * On both paths the current-item Delete sits at index 0 and is the
           * only item carrying a ConditionExpression — the sentinel Deletes and
           * the tombstone/snapshot Puts are unconditional — so an index-0
           * cancellation can only be the user's condition. Every other reason
           * falls through as the raw `DynamoClientError`.
           */
          const mapDeleteConditionFailure = (
            err: DynamoClientError,
          ): DynamoClientError | ConditionalCheckFailed => {
            if (!userCondition) return err
            const cancelledAtMainItem =
              isAwsTransactionCancelled(err.cause) &&
              err.cause.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
            if (cancelledAtMainItem || isAwsConditionalCheckFailed(err.cause)) {
              return new ConditionalCheckFailed({ entityType, key: encodedKey })
            }
            return err
          }

          /** The guard ANDed with the user's condition, for the main Delete. */
          const guardedDeleteCondition = (guard: {
            readonly expression: string
            readonly names: globalThis.Record<string, string>
            readonly values: globalThis.Record<string, AttributeValue>
          }) => {
            const values = { ...guard.values, ...userCondition?.values }
            return {
              ConditionExpression: userCondition
                ? `${guard.expression} AND (${userCondition.expression})`
                : guard.expression,
              ExpressionAttributeNames: { ...guard.names, ...userCondition?.names },
              ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
              ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
            }
          }
          /**
           * Run a guarded delete transaction: index 0 is the main Delete, the
           * only conditioned item, so its rejection is read from the stored
           * item (ALL_OLD) — gone, raced, or the user's condition.
           */
          const guardedDelete = <A>(
            write: Effect.Effect<A, DynamoClientError>,
            read: globalThis.Record<string, AttributeValue>,
            inputs: ReadonlyArray<string>,
            snapshotAt: { readonly index: number; readonly version: number } | undefined,
            releases: ReadonlyArray<{ readonly index: number; readonly constraintName: string }>,
          ) => {
            let rejected: globalThis.Record<string, AttributeValue> | undefined
            const reject = (stored: Readonly<globalThis.Record<string, unknown>> | undefined) => {
              rejected = stored as globalThis.Record<string, AttributeValue> | undefined
              // Deleted since the read: with nothing asserted, read it again —
              // a delete of a missing item reports what such a delete does.
              if (stored === undefined && userCondition === undefined) {
                return new DeletedConcurrently()
              }
              return deleteRejection(
                encodedKey as globalThis.Record<string, unknown>,
                read,
                inputs,
                stored,
                userCondition !== undefined,
              )
            }
            return withCurrentItem(
              write.pipe(
                Effect.mapError((err) => {
                  if (isAwsTransactionCancelled(err.cause)) {
                    const main = err.cause.CancellationReasons?.[0]
                    if (main?.Code === "ConditionalCheckFailed") return reject(main.Item)
                    if (
                      snapshotAt !== undefined &&
                      err.cause.CancellationReasons?.[snapshotAt.index]?.Code ===
                        "ConditionalCheckFailed"
                    ) {
                      return historyConflict(snapshotAt.version, "delete")
                    }
                    for (const { index, constraintName } of releases) {
                      if (
                        err.cause.CancellationReasons?.[index]?.Code === "ConditionalCheckFailed"
                      ) {
                        return releaseRaced(
                          encodedKey as globalThis.Record<string, unknown>,
                          constraintName,
                        )
                      }
                    }
                  }
                  if (isAwsConditionalCheckFailed(err.cause)) return reject(err.cause.Item)
                  return err
                }),
              ),
              () => rejected,
            )
          }

          /**
           * Append a release for each sentinel the stored item `raw` holds AND
           * owns (#133) — composed from its domain view, since the stored row is
           * attribute-keyed and the constraint is not (#127) — returning where
           * each landed, so a release that lost a race can be reported.
           */
          const ownedReleases = (
            table: string,
            raw: globalThis.Record<string, unknown>,
            into: Array<unknown>,
          ) =>
            Effect.gen(function* () {
              const rawDomain = toDomainView(raw)
              const held: Array<{
                readonly pk: string
                readonly sk: string
                readonly constraintName: string
              }> = []
              for (const [constraintName, constraintDef] of Object.entries(config.unique!)) {
                const sentinel = composeUniqueSentinel(
                  schema,
                  entityType,
                  constraintName,
                  constraintDef,
                  rawDomain,
                  readSentinelValue,
                )
                if (!sentinel) continue
                held.push({ ...sentinel.key, constraintName })
              }
              const owner = { pk: primaryKey[primary.pk.field], sk: primaryKey[primary.sk.field] }
              const releases: Array<{ index: number; constraintName: string }> = []
              for (const sentinel of yield* ownedSentinels(table, held, owner)) {
                releases.push({ index: into.length, constraintName: sentinel.constraintName })
                into.push(sentinelRelease(table, sentinel, owner))
              }
              return releases
            })

          if (isSoftDeleteEnabled() || hasUniqueConstraints || isRetainEnabled()) {
            const readFirst = Effect.gen(function* () {
              if (isSoftDeleteEnabled()) {
                // --- Soft delete path ---
                // Read current item
                const result = yield* readCurrent(tableName, marshalledKey)

                if (!result.Item) {
                  return yield* missing(new ItemNotFound({ entityType, key: encodedKey }))
                }
                // The tombstone (and snapshot) copy the item read: the delete is
                // conditioned on it being unchanged, so no concurrent update is lost
                // into them (#133).
                yield* checkVersion(result.Item, "delete")
                const softGuard = deleteGuard(result.Item, "item", userCondition?.expression)

                const raw = fromAttributeMap(result.Item) as globalThis.Record<string, unknown>
                // Clock-backed time source; `now` is the ISO timestamp used for the
                // deleted SK + deletedAt, `dtNow` drives the optional TTL + snapshot.
                const dtNow = yield* DateTime.now
                const now = nowIso(dtNow)

                // Build soft-deleted item: same PK, replace SK with deleted key, strip GSI keys
                const deletedItem: globalThis.Record<string, unknown> = { ...raw }

                // Strip GSI key fields — soft-deleted items must not appear in index queries
                for (const field of gsiKeyFields()) {
                  delete deletedItem[field]
                }

                // Vector attributes: stash the embedding under a non-indexed name
                // before stripping. Sparse semantics drop the tombstone out of the
                // vector index immediately, and `restore()` un-stashes without
                // paying for another Embedder call. See `DESIGN.md §14`.
                for (const [, definition] of vectorIndexEntries) {
                  const stored = deletedItem[definition.vectorField]
                  if (stored !== undefined) deletedItem[definition.stashField] = stored
                  delete deletedItem[definition.vectorField]
                  delete deletedItem[definition.partitionField]
                }

                // Replace SK with deleted sort key
                deletedItem[primary.sk.field] = DynamoSchema.composeDeletedKey(
                  schema,
                  entityType,
                  now,
                  historyKeyOptions(primaryKey[primary.sk.field]),
                )

                // Add deletedAt
                deletedItem.deletedAt = now

                // Add optional TTL
                const sdTtl = tombstoneTtl()
                if (sdTtl) {
                  deletedItem[ttlAttrName] =
                    DateTime.toEpochSeconds(dtNow) + normalizeTtlSeconds(sdTtl)
                }

                // Build transaction
                type TransactItem = {
                  Put?: { TableName: string; Item: globalThis.Record<string, AttributeValue> }
                  Delete?: {
                    TableName: string
                    Key: globalThis.Record<string, AttributeValue>
                    ConditionExpression?: string
                    ExpressionAttributeNames?: globalThis.Record<string, string>
                    ExpressionAttributeValues?: globalThis.Record<string, AttributeValue>
                  }
                }
                const transactItems: Array<TransactItem> = []

                // Delete current entity item — index 0, and the ONLY item in this
                // transaction carrying a ConditionExpression, so a cancellation
                // naming index 0 is unambiguously the user's condition. The guard
                // rides the transaction rather than being pre-checked against the
                // item read above: a client-side check would leave a race window
                // between the read and the write.
                const currentDelete: NonNullable<TransactItem["Delete"]> = {
                  TableName: tableName,
                  Key: marshalledKey,
                  ...guardedDeleteCondition(softGuard),
                }
                transactItems.push({ Delete: currentDelete })

                // Put soft-deleted item
                transactItems.push({
                  Put: {
                    TableName: tableName,
                    Item: toAttributeMap(deletedItem),
                  },
                })

                // Version snapshot if retain is enabled — never over existing history.
                let snapshotAt: { readonly index: number; readonly version: number } | undefined
                if (isRetainEnabled()) {
                  const currentVersion = systemFields.version
                    ? ((raw[systemFields.version] as number | undefined) ?? 0)
                    : 0
                  const snapshotItem = buildSnapshotItem(
                    raw,
                    currentVersion,
                    primary.pk.field,
                    primary.sk.field,
                    ttlAttrName,
                    dtNow,
                  )
                  snapshotAt = { index: transactItems.length, version: currentVersion }
                  transactItems.push({ Put: snapshotPut(tableName, snapshotItem) })
                }

                // Release sentinels if not preserving unique — only those this item
                // owns (#133). Sparse — fields that were unset on the live item
                // never had a sentinel, so nothing to release.
                const releases =
                  hasUniqueConstraints && !preserveUnique()
                    ? yield* ownedReleases(tableName, raw, transactItems)
                    : []

                yield* guardedDelete(
                  client.transactWriteItems({ TransactItems: transactItems }),
                  result.Item,
                  softGuard.inputs,
                  snapshotAt,
                  releases,
                ).pipe(
                  diagnoseTransactionWrite(
                    "delete",
                    transactItems,
                    () => userCondition?.expression,
                  ),
                )
                return result.Item
              } else {
                // --- Hard delete with unique constraints and/or retained history ---
                // The item is read first: the sentinels to release are keyed by its
                // unique values, and a retain entity snapshots its final state.
                const result = yield* readCurrent(tableName, marshalledKey)

                if (!result.Item) {
                  if (hasUniqueConstraints || mustExist) {
                    return yield* missing(new ItemNotFound({ entityType, key: encodedKey }))
                  }
                  // Retain only: deleting a missing item writes nothing, as a plain
                  // `DeleteItem` would. The caller's condition is still judged
                  // against no item — and the delete never removes an item created
                  // since the read, which would leave its final state unsnapshotted.
                  if (!userCondition) return undefined
                  const values = userCondition.values
                  const missingDelete: DeleteItemCommandInput = {
                    TableName: tableName,
                    Key: marshalledKey,
                    ConditionExpression: `attribute_not_exists(#dpk) AND (${userCondition.expression})`,
                    ExpressionAttributeNames: {
                      ...userCondition.names,
                      "#dpk": primary.pk.field,
                    },
                    ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
                    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                  }
                  yield* client.deleteItem(missingDelete).pipe(
                    Effect.mapError((err) =>
                      isAwsConditionalCheckFailed(err.cause)
                        ? conditionRejection(
                            encodedKey as globalThis.Record<string, unknown>,
                            err.cause.Item,
                            err.cause.Item === undefined ? undefined : { version: 0 },
                            true,
                          )
                        : err,
                    ),
                    diagnoseItemWrite("delete", {
                      Delete: missingDelete as NonNullable<TransactWriteItem["Delete"]>,
                    }),
                  )
                  return undefined
                }
                // The sentinel deletes are keyed by the unique values read, and the
                // snapshot copies the item read: the delete is conditioned on it —
                // its version and incarnation — so no sentinel is orphaned and no
                // concurrent write is lost from the history (#133).
                yield* checkVersion(result.Item, "delete")
                const hardGuard = deleteGuard(
                  result.Item,
                  hasUniqueConstraints
                    ? [
                        ...new Set(
                          Object.values(config.unique!).flatMap((def) =>
                            resolveUniqueFields(def).map(resolveDbName),
                          ),
                        ),
                      ]
                    : [],
                  userCondition?.expression,
                )

                const raw = fromAttributeMap(result.Item) as globalThis.Record<string, unknown>

                const transactItems: Array<TransactWriteItem> = []

                // Delete entity item — index 0, and the only item conditioned on the
                // item read (the sentinel Deletes are conditioned on ownership, the
                // snapshot on history), so an index-0 cancellation is read from it.
                transactItems.push({
                  Delete: {
                    TableName: tableName,
                    Key: marshalledKey,
                    ...guardedDeleteCondition(hardGuard),
                  },
                })

                // Retain: the final state is history too. Snapshotted at its own
                // version — under the same never-overwrite guard as every snapshot —
                // so an item created again at this key continues PAST it, and a
                // writer holding this version can never match the new incarnation.
                let snapshotAt: { readonly index: number; readonly version: number } | undefined
                if (isRetainEnabled()) {
                  const currentVersion = storedVersionOf(result.Item) ?? 0
                  snapshotAt = { index: transactItems.length, version: currentVersion }
                  transactItems.push({
                    Put: snapshotPut(
                      tableName,
                      buildSnapshotItem(
                        raw,
                        currentVersion,
                        primary.pk.field,
                        primary.sk.field,
                        ttlAttrName,
                        yield* DateTime.now,
                      ),
                    ),
                  })
                }

                // Release sentinels — only those this item owns (#133). Sparse: no
                // sentinel was ever written for a constraint whose fields are unset.
                const releases = hasUniqueConstraints
                  ? yield* ownedReleases(tableName, raw, transactItems)
                  : []

                yield* guardedDelete(
                  client.transactWriteItems({ TransactItems: transactItems }),
                  result.Item,
                  hardGuard.inputs,
                  snapshotAt,
                  releases,
                ).pipe(
                  diagnoseTransactionWrite(
                    "delete",
                    transactItems,
                    () => userCondition?.expression,
                  ),
                )
                return result.Item
              }
            })
            // The caller asserted nothing about the item, so a concurrent write
            // between the read and the transaction — a changed item, or a
            // sentinel release that changed hands — is not a refusal: the
            // delete reads the item again and is written again, as a put is.
            // With a `.condition()` the read is what the condition was judged
            // against, and a race fails.
            // Deleted concurrently on every attempt: what a delete that read
            // it missing reports.
            const deleted = (yield* userCondition === undefined
              ? readFirst.pipe(
                  Effect.retry({
                    times: GUARDED_PUT_ATTEMPTS - 1,
                    while: (e) =>
                      e instanceof OptimisticLockError ||
                      e instanceof ConcurrentModification ||
                      e instanceof DeletedConcurrently,
                  }),
                  Effect.catchIf(
                    (e): e is DeletedConcurrently => e instanceof DeletedConcurrently,
                    () =>
                      missing(
                        hasUniqueConstraints || isSoftDeleteEnabled()
                          ? new ItemNotFound({ entityType, key: encodedKey })
                          : undefined,
                      ),
                  ),
                )
              : readFirst) as globalThis.Record<string, AttributeValue> | undefined
            return yield* deletedResult(deleted)
          } else {
            // Simple delete
            const deleteInput: DeleteItemCommandInput = {
              TableName: tableName,
              Key: marshalledKey,
            }
            if (userCondition) {
              deleteInput.ConditionExpression = userCondition.expression
              deleteInput.ExpressionAttributeNames = userCondition.names
              if (Object.keys(userCondition.values).length > 0) {
                deleteInput.ExpressionAttributeValues = userCondition.values
              }
            }
            if (opts.returnValues !== undefined) {
              deleteInput.ReturnValues = opts.returnValues === "allOld" ? "ALL_OLD" : "NONE"
            }
            const output = yield* client.deleteItem(deleteInput).pipe(
              Effect.mapError(mapDeleteConditionFailure),
              diagnoseItemWrite("delete", {
                Delete: deleteInput as NonNullable<TransactWriteItem["Delete"]>,
              }),
            )
            return yield* deletedResult(
              output.Attributes as globalThis.Record<string, AttributeValue> | undefined,
            )
          }
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // deleteIfExists operation — delete + attribute_exists condition
  // ---------------------------------------------------------------------------

  /** Compile a delete for `Transaction.transactWrite` — see `_planDelete`. */
  const planDelete = (
    key: unknown,
    opts: {
      readonly condition: Expr | ConditionInput | undefined
      readonly mustExist: boolean
    },
    encodedKey: globalThis.Record<string, unknown>,
  ) =>
    planned(
      "transactWrite.delete",
      encodedKey,
      () => del(key)._builder({ ...opts, returnValues: undefined }),
      { payload: {}, callerCondition: opts.condition !== undefined },
    )

  const deleteIfExists = (key: unknown) => {
    const op = del(key)
    return new EntityDeleteImpl(
      op._builder,
      op._entity,
      op._key,
      op._condition,
      op._returnValues,
      true,
    )
  }

  // ---------------------------------------------------------------------------
  // upsert operation — create-or-update via UpdateItem with if_not_exists()
  // ---------------------------------------------------------------------------

  /**
   * `upsert` that reads the item first (#133) — of an entity with unique
   * constraints or `versioned: { retain: true }`, or an input that omits a
   * defaulted index composite. A single UpdateItem cannot write, rotate or
   * check a sentinel, snapshot the replaced item, or tell whether to store a
   * default or keep the stored value. Missing: a `create` (sentinels guarded
   * by `attribute_not_exists`, the retain snapshot, omitted defaults stored).
   * Present: an update of the upserted fields — sentinels rotate for changed
   * values, unchanged ones are left alone, immutable fields, `createdAt` and
   * fields the input omits or leaves unset keep their stored values, retain snapshots the
   * replaced item — under the update's version / incarnation or attribute
   * guards, from that one read. The whole input is validated either way. A
   * concurrent create or delete between the read and the write is retried the
   * other way, and a sentinel release whose reservation changed hands is
   * planned again from a fresh read (as a put's is); a race lost on every
   * attempt fails with the concurrency error. A concurrent change of the item
   * itself fails the upsert, as it fails an update. A single-write upsert also ends up here, with the
   * row its rejected write returned, when one write couldn't get a key right (`upsertKeyPlan`).
   */
  const guardedUpsert = (
    input: unknown,
    mode: DecodeMode,
    opts: EntityPutOpts,
    /** The stored item, when the caller has it: a rejected write returned it. */
    stored?: globalThis.Record<string, AttributeValue>,
  ) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const { name: tableName } = yield* tableTag
      const now = yield* DateTime.now
      yield* checkWithVectorNames(opts.withVectors, "upsert")
      const lacks = writeLacks()
      // Required fields are required whether or not the item exists.
      const encodedInput = (yield* encodeForWrite(
        schemas.inputSchema as Schema.Codec<any>,
        yield* fillDecodingDefaults(input),
        "upsert",
      )) as globalThis.Record<string, unknown>
      yield* refuseUnstorable({ ...encodedInput, ...opts.withVectors }, "upsert")
      yield* composeAllKeys(encodedInput, "upsert")
      yield* refuseUncomposed(encodedInput, "upsert")
      const record = (input ?? {}) as globalThis.Record<string, unknown>
      const primary = config.indexes.primary
      const keyFields = [...primary.pk.composite, ...primary.sk.composite]
      const key = Object.fromEntries(keyFields.map((field) => [field, record[field]]))
      const encodedKey = yield* encodeKey(key, "upsert.decodeKey")
      const marshalledKey = toAttributeMap(composePrimaryKey(encodedKey))
      const dropped = new Set<string>([
        ...keyFields,
        ...immutableFields,
        ...(systemFields.createdAt ? [systemFields.createdAt] : []),
        ...(systemFields.version ? [systemFields.version] : []),
      ])
      // An `undefined` means what it means on the single write. A merely optional field is left
      // unset, and a defaulted index composite is omitted (`omitsIndexedDefault`), so either keeps
      // what the row holds. Any other default is stored.
      const keyedDefaults = indexedDefaultFields()
      const updates = (yield* fillDecodingDefaults(
        Object.fromEntries(
          Object.entries(record).filter(
            ([field, value]) =>
              !dropped.has(field) &&
              !(
                value === undefined &&
                (keyedDefaults.has(field) ||
                  ((encodedInput as globalThis.Record<string, unknown>)[field] === undefined &&
                    lacks.absentReading(field) === undefined))
              ),
          ),
        ),
        (field, given) => field in given,
      )) as globalThis.Record<string, unknown>
      // What the single-write upsert sets with `if_not_exists`: under whatever the row holds.
      const fill = {
        ...Object.fromEntries(
          [...immutableFields]
            .filter((field) => encodedInput[field] !== undefined)
            .map((field) => [field, encodedInput[field]]),
        ),
        ...(systemFields.createdAt
          ? {
              [systemFields.createdAt]:
                encodedInput[systemFields.createdAt] ??
                generateTimestamp(systemFields.createdAtEncoding, now),
            }
          : {}),
      }
      const read = () =>
        client
          .getItem({ TableName: tableName, Key: marshalledKey, ConsistentRead: true })
          .pipe(Effect.map((result) => result.Item))
      // A row that isn't there is written whole, as a put, and one that is takes the update of the
      // upserted fields (`updates`), which refuses the entry keys `refusesPutKeys` says. A put
      // refuses every key that update refuses, so such a key is refused before the read, in the
      // put's words. Any other is judged by the write the read leads to.
      const refusedEntry = refusedSparseEntry(
        Object.fromEntries(
          Object.keys(updates)
            .filter((field) => Object.hasOwn(encodedInput, field))
            .map((field) => [field, encodedInput[field]]),
        ),
        refusesPutKeys(false, {
          touchesUniqueFields: touchesUniqueFieldsOf(emptyUpdateState, updates),
          computedComposites: [],
          pathOpsPresent: false,
        }),
        everyRowWrites,
      )
      const refusedKey =
        refusedEntry === undefined
          ? undefined
          : sparseKeyRefusal(refusedEntry.field, refusedEntry.prefix, refusedEntry.key)
      if (refusedKey !== undefined) {
        return yield* new ValidationError({
          entityType,
          operation: "upsert.sparse",
          cause: refusedKey,
        })
      }
      let current = stored ?? (yield* read())
      let expected = 0
      let lost: ConcurrentModification | undefined
      for (let attempt = 0; attempt < GUARDED_PUT_ATTEMPTS; attempt++) {
        yield* checkVersion(current, "upsert")
        expected = storedVersionOf(current) ?? 0
        if (current === undefined) {
          const created = yield* Effect.exit(
            put(input)._builder(mode, {
              condition: opts.condition,
              withVectors: opts.withVectors,
              putKind: "create",
              operation: "upsert",
            }) as Effect.Effect<unknown, unknown>,
          )
          if (created._tag === "Success") return created.value
          const error = Cause.findErrorOption(created.cause)
          if (Option.isNone(error) || !(error.value instanceof ConditionalCheckFailed)) {
            return yield* created
          }
          // Created concurrently: upsert it as the existing item it now is.
          // Still missing: the caller's condition rejected it.
          current = yield* read()
          if (current === undefined) return yield* created
          continue
        }
        const updated = yield* Effect.exit(
          runUpdate(
            key,
            mode,
            {
              ...emptyUpdateState,
              updates,
              condition: opts.condition,
              withVectors: opts.withVectors,
              upsertOver: { fill },
            },
            current,
          ).pipe(
            // Its errors name the upsert, not the update it runs.
            Effect.mapError((e) =>
              e instanceof ValidationError && e.operation.startsWith("update")
                ? new ValidationError({
                    entityType: e.entityType,
                    operation: `upsert${e.operation.slice("update".length)}`,
                    cause: e.cause,
                  })
                : e,
            ),
          ) as Effect.Effect<unknown, unknown>,
        )
        if (updated._tag === "Success") return updated.value
        const error = Cause.findErrorOption(updated.cause)
        if (Option.isNone(error)) return yield* updated
        // A sentinel it would release changed hands since its ownership read:
        // nothing was written, and the upsert is planned again from a fresh
        // read, as a put is.
        if (error.value instanceof ConcurrentModification && releaseRaces.has(error.value)) {
          lost = error.value
        } else if (!(error.value instanceof ItemNotFound)) {
          return yield* updated
        }
        // Deleted concurrently: upserted as the missing item it now is.
        current = yield* read()
      }
      if (lost !== undefined) return yield* lost
      // Every attempt raced a concurrent create or delete.
      return yield* systemFields.version
        ? new OptimisticLockError({
            entityType,
            key: encodedKey,
            expectedVersion: expected,
            actualVersion: storedVersionOf(current) ?? -1,
          })
        : new ConcurrentModification({
            entityType,
            key: encodedKey,
            attributes: [],
            current: Option.none(),
          })
    })

  const upsert = (input: unknown) =>
    new EntityPutImpl(
      (mode: DecodeMode, opts: EntityPutOpts) =>
        Effect.gen(function* () {
          const lacks = writeLacks()
          // A primary key over `createdAt` the input doesn't supply names no item that exists yet.
          if (
            systemFields.createdAt !== null &&
            isPrimaryComposite(systemFields.createdAt) &&
            (input as globalThis.Record<string, unknown>)[systemFields.createdAt] === undefined
          ) {
            return yield* put(input)._builder(mode, {
              condition: opts.condition,
              withVectors: opts.withVectors,
              putKind: "create",
              operation: "upsert",
            }) as Effect.Effect<unknown, unknown>
          }
          if (
            (config.unique != null && Object.keys(config.unique).length > 0) ||
            isRetainEnabled() ||
            omitsIndexedDefault(input)
          ) {
            return yield* guardedUpsert(input, mode, opts)
          }
          const client = yield* Capacity.client
          const { name: tableName } = yield* tableTag
          // Clock-backed time source for createdAt/updatedAt SET clauses.
          const now = yield* DateTime.now

          yield* checkWithVectorNames(opts.withVectors, "upsert")

          // Encode user input → wire form (see `put` for strategy). An input
          // that omits a defaulted index composite took the guarded path: the
          // default is stored on create, the stored value kept on update.
          const encodedInput = yield* encodeForWrite(
            schemas.inputSchema as Schema.Codec<any>,
            input,
            "upsert",
          )
          yield* refuseUnstorable(
            { ...(encodedInput as globalThis.Record<string, unknown>), ...opts.withVectors },
            "upsert",
          )
          // Clearing a composite clears what a half says, and one write can't tell what's left of
          // it: the update's own rule says, and that needs the stored row.
          if (
            [...indexCompositeFields()].some(
              (field) =>
                upsertClears(
                  field,
                  (encodedInput as globalThis.Record<string, unknown>)[field],
                  lacks,
                ) &&
                field !== systemFields.createdAt &&
                field !== systemFields.updatedAt,
            )
          ) {
            return yield* guardedUpsert(input, mode, opts)
          }

          // Hydrate refs: replace ID fields with full entity domain data
          const encoded = hasRefs
            ? yield* hydrateRefs(encodedInput as globalThis.Record<string, unknown>)
            : encodedInput

          const item = encoded as globalThis.Record<string, unknown>
          const suppliedCreatedAt =
            systemFields.createdAt === null ? undefined : item[systemFields.createdAt]
          const upsertedCreatedAt =
            suppliedCreatedAt !== undefined
              ? suppliedCreatedAt
              : generateTimestamp(systemFields.createdAtEncoding, now)
          const suppliedUpdatedAt =
            systemFields.updatedAt === null ? undefined : item[systemFields.updatedAt]
          const upsertedUpdatedAt =
            suppliedUpdatedAt !== undefined
              ? suppliedUpdatedAt
              : generateTimestamp(systemFields.updatedAtEncoding, now)

          // Every index's keys, composed before anything is marshalled: a
          // composite with no key text (`NaN`, `[EDD-9096]`) or Z-order level
          // (`[EDD-9092]`) fails the upsert with a `ValidationError`.
          const stamped = {
            ...item,
            ...writeStamps(upsertedUpdatedAt, undefined),
            ...(systemFields.createdAt ? { [systemFields.createdAt]: upsertedCreatedAt } : {}),
          }
          const allKeys = yield* upsertKeys(stamped, yield* composeAllKeys(stamped, "upsert"))
          yield* refuseUncomposed(encodedInput, "upsert")
          const keyPlan = upsertKeyPlan(allKeys, item, suppliedCreatedAt !== undefined)
          const primaryKey = composePrimaryKey(item)
          const marshalledKey = toAttributeMap(primaryKey)
          // Build UpdateExpression with if_not_exists for immutable fields + createdAt
          const setClauses: Array<string> = []
          const upsertRemoveClauses: Array<string> = []
          const names: globalThis.Record<string, string> = {}
          const values: globalThis.Record<string, AttributeValue> = {}
          let counter = 0
          // Each written value's placeholders, for the key guards below.
          const placeholders = new Map<string, readonly [string, string]>()

          // The physical key attributes (`pk` / `sk`) live in `Key` and cannot
          // appear in an UpdateExpression. The COMPOSITE SOURCE fields are
          // ordinary attributes and must be written like any other model field —
          // skipping them (as this path used to) left the stored item without
          // e.g. `productId`, so every read of an upserted item failed to decode
          // with `Missing key`. Their values are fixed by the key, so a plain
          // SET is idempotent.
          const keyAttributeFields = new Set([
            config.indexes.primary.pk.field,
            config.indexes.primary.sk.field,
          ])

          // System-colliding fields are written below in the system-field block
          // (so their semantics — if_not_exists / always-set — stay consistent).
          const systemColliders = new Set<string>()
          if (systemFields.createdAtCollision && systemFields.createdAt)
            systemColliders.add(systemFields.createdAt)
          if (systemFields.updatedAtCollision && systemFields.updatedAt)
            systemColliders.add(systemFields.updatedAt)
          if (systemFields.versionCollision && systemFields.version)
            systemColliders.add(systemFields.version)

          // `item` is already in wire-form via `Schema.encode(inputSchema)`.

          // All model fields (excluding the physical key attributes themselves)
          for (const [attr, val] of Object.entries(item)) {
            if (keyAttributeFields.has(resolveDbName(attr))) continue
            if (systemColliders.has(attr)) continue
            if (upsertClears(attr, val, lacks)) {
              const nameKey = `#u${counter}`
              names[nameKey] = resolveDbName(attr)
              upsertRemoveClauses.push(nameKey)
              counter++
              continue
            }
            if (val === undefined || isEmptySet(val)) continue

            // Sparse fields: expand into one SET per bucket. Each bucket
            // attribute is named `<prefix>#<key>` and goes through
            // ExpressionAttributeNames as a literal (the `#` survives).
            if (hasSparseFields && attr in sparseFields) {
              if (val === null || typeof val !== "object") continue
              const sparse = sparseFields[attr]!
              for (const [k, v] of Object.entries(val as globalThis.Record<string, unknown>)) {
                try {
                  if (typeof k !== "string" || k.length === 0 || k.includes("#")) {
                    throw new Error(`Sparse map "${attr}": invalid key ${JSON.stringify(k)}`)
                  }
                } catch (e) {
                  return yield* new ValidationError({
                    entityType,
                    operation: "upsert.sparse",
                    cause: e instanceof Error ? e.message : String(e),
                  })
                }
                const nameKey = `#u${counter}`
                names[nameKey] = `${sparse.prefix}#${k}`
                if (hasNoStoredForm(v)) {
                  upsertRemoveClauses.push(nameKey)
                  counter++
                  continue
                }
                const valKey = `:u${counter}`
                values[valKey] = toAttributeValue(v)
                setClauses.push(`${nameKey} = ${valKey}`)
                counter++
              }
              continue
            }

            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            const storedName = resolveDbName(attr)
            names[nameKey] = storedName
            // A packed field is written whole, as its stored form (#147).
            values[valKey] =
              attr in packedFields
                ? (yield* packAttribute(storedName, val, "upsert"))!
                : toAttributeValue(val)

            placeholders.set(attr, [nameKey, valKey])
            // Immutable fields use if_not_exists — only set on first create
            if (immutableFields.has(attr)) {
              setClauses.push(`${nameKey} = if_not_exists(${nameKey}, ${valKey})`)
            } else {
              setClauses.push(`${nameKey} = ${valKey}`)
            }
            counter++
          }

          // Add all index keys (including GSIs)
          const keptKeyNames: Array<string> = []
          for (const [field, value] of Object.entries(allKeys)) {
            // Skip primary key fields (they're in Key, not UpdateExpression)
            if (
              field === config.indexes.primary.pk.field ||
              field === config.indexes.primary.sk.field
            )
              continue
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = field
            values[valKey] = toAttributeValue(value)
            if (keyPlan.keep.has(field)) {
              setClauses.push(`${nameKey} = if_not_exists(${nameKey}, ${valKey})`)
              keptKeyNames.push(nameKey)
            } else {
              setClauses.push(`${nameKey} = ${valKey}`)
            }
            counter++
          }

          // Vector search: upsert writes the full item, so it always re-embeds
          // (same contract as `put` — see `DESIGN.md §14 Write path`). Emitted
          // as plain SETs, never `if_not_exists`: an upsert that overwrites the
          // source fields must overwrite the vector derived from them, or the
          // item would stay searchable under its previous description forever.
          if (hasVectorIndexes) {
            const vectorWrite = yield* computeVectorAttributes(
              { ...item, ...writeStamps(upsertedUpdatedAt, undefined) },
              opts.withVectors,
              "all",
            )
            for (const [field, value] of Object.entries(vectorWrite.sets)) {
              const nameKey = `#u${counter}`
              const valKey = `:u${counter}`
              names[nameKey] = field
              values[valKey] = toAttributeValue(value)
              setClauses.push(`${nameKey} = ${valKey}`)
              counter++
            }
            // An upsert whose input carries no source text takes the item out
            // of the index, exactly as a `put` of the same input would.
            for (const field of new Set(vectorWrite.removes)) {
              const nameKey = `#vr${counter}`
              names[nameKey] = field
              upsertRemoveClauses.push(nameKey)
              counter++
            }
          }

          // Add entity type discriminator
          {
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = "__edd_e__"
            values[valKey] = toAttributeValue(entityType)
            setClauses.push(`${nameKey} = ${valKey}`)
            counter++
          }

          // Add createdAt with if_not_exists — only set on first create.
          // User-supplied value wins (domain input → already serialized above);
          // else fall back to a freshly generated storage primitive.
          if (systemFields.createdAt) {
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = resolveDbName(systemFields.createdAt)
            values[valKey] = toAttributeValue(upsertedCreatedAt)
            setClauses.push(`${nameKey} = if_not_exists(${nameKey}, ${valKey})`)
            placeholders.set(systemFields.createdAt, [nameKey, valKey])
            counter++
          }

          // Add updatedAt — user-supplied wins, else always set to current time.
          if (systemFields.updatedAt) {
            const nameKey = `#u${counter}`
            const valKey = `:u${counter}`
            names[nameKey] = resolveDbName(systemFields.updatedAt)
            values[valKey] = toAttributeValue(upsertedUpdatedAt)
            setClauses.push(`${nameKey} = ${valKey}`)
            placeholders.set(systemFields.updatedAt, [nameKey, valKey])
            counter++
          }

          // Add version: if_not_exists(version, 0) + 1
          if (systemFields.version) {
            const nameKey = `#u${counter}`
            const zeroKey = `:u${counter}z`
            names[nameKey] = systemFields.version
            values[zeroKey] = toAttributeValue(0)
            values[":vinc"] = toAttributeValue(1)
            setClauses.push(`${nameKey} = if_not_exists(${nameKey}, ${zeroKey}) + :vinc`)
            counter++
          }
          // An upsert that creates the item gives it an incarnation token (#133).
          if (stampsIncarnation) {
            names["#eddInc"] = INCARNATION_TOKEN
            values[":eddInc"] = toAttributeValue(yield* freshIncarnation)
            setClauses.push("#eddInc = if_not_exists(#eddInc, :eddInc)")
          }

          const updateExpression =
            upsertRemoveClauses.length > 0
              ? `SET ${setClauses.join(", ")} REMOVE ${upsertRemoveClauses.join(", ")}`
              : `SET ${setClauses.join(", ")}`

          // Optional user condition
          const condParts: Array<string> = []
          if (systemFields.version) {
            // Never version an item whose version was removed outside the library
            // (incarnation token, no version) as if it predated versioning (#133).
            names["#intVer"] = systemFields.version
            names["#intInc"] = INCARNATION_TOKEN
            condParts.push("(attribute_exists(#intVer) OR attribute_not_exists(#intInc))")
          }
          const uc = opts.condition ? compileCondition(opts.condition, resolveDbName) : undefined
          if (uc) {
            condParts.push(`(${uc.expression})`)
            Object.assign(names, uc.names)
            Object.assign(values, uc.values)
          }
          // The key written holds the input's value of what the upsert keeps: only where that's
          // what's stored. A row with nothing stored takes the input's, and passes.
          const keyGuards: Array<string> = []
          for (const attr of keyPlan.matches) {
            const [nameKey, valKey] = placeholders.get(attr)!
            keyGuards.push(`(attribute_not_exists(${nameKey}) OR ${nameKey} = ${valKey})`)
          }
          // A new row takes the key. An existing one keeps its own, so it must have one, and one
          // that still says what this input says.
          const stays = [
            ...keptKeyNames.map((nameKey) => `attribute_exists(${nameKey})`),
            ...[...keyPlan.same].map((attr) => {
              const [nameKey, valKey] = placeholders.get(attr)!
              return `${nameKey} = ${valKey}`
            }),
          ]
          if (stays.length > 0) {
            names["#kpk"] = config.indexes.primary.pk.field
            keyGuards.push(`(attribute_not_exists(#kpk) OR (${stays.join(" AND ")}))`)
          }
          condParts.push(...keyGuards)

          const upsertInput: UpdateItemCommandInput = {
            TableName: tableName,
            Key: marshalledKey,
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ConditionExpression: condParts.length > 0 ? condParts.join(" AND ") : undefined,
            // The corruption guard needs the stored item, and so does a rejected key guard.
            ...((systemFields.version || keyGuards.length > 0) && {
              ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
            }),
            ReturnValues: "ALL_NEW",
          }
          // The row a key guard's rejection returned: DynamoDB charges no read for it.
          const rejected: { row?: globalThis.Record<string, AttributeValue> } = {}
          const mapUpsertFailure = (
            err: DynamoClientError,
          ): DynamoClientError | ConditionalCheckFailed | ValidationError => {
            if (isAwsConditionalCheckFailed(err.cause)) {
              const corrupt = versionCorruption(err.cause.Item, "upsert")
              if (corrupt !== undefined) return corrupt
              if (keyGuards.length > 0 && err.cause.Item !== undefined) {
                rejected.row = err.cause.Item as globalThis.Record<string, AttributeValue>
              }
              if (opts.condition) return new ConditionalCheckFailed({ entityType, key: item })
            }
            return err
          }
          const written = yield* client.updateItem(upsertInput).pipe(
            Effect.mapError(mapUpsertFailure),
            diagnoseItemWrite("upsert", {
              Update: upsertInput as NonNullable<TransactWriteItem["Update"]>,
            }),
            Effect.exit,
          )
          // One write couldn't get a key right: compose from the row. If it was the caller's
          // condition that rejected the write, this write is rejected too.
          if (rejected.row !== undefined)
            return yield* guardedUpsert(input, mode, opts, rejected.row)
          const result = yield* written

          if (!result.Attributes) {
            return yield* new ItemNotFound({ entityType, key: item })
          }

          const raw = fromAttributeMap(result.Attributes)
          return yield* decodeAs(raw, result.Attributes, mode)
        }),
      self,
      input as globalThis.Record<string, unknown>,
      undefined,
      undefined,
      // Tagged so the transact/batch compilers can refuse it: this op is an
      // UpdateItem with `if_not_exists`, not a Put (#100).
      "upsert",
    )

  /**
   * @internal Compare stored vs attempted `orderBy` to decide whether the CAS
   * predicate `attribute_not_exists(pk) OR stored < attempted` failed.
   *
   * Returns `true` (CAS failed → stale) when `stored >= attempted`.
   * Returns `false` (CAS held; the user's `.condition()` is the rejecter)
   * when `stored < attempted` or when `stored` is missing.
   *
   * `stored` arrives as a decoded domain value matching the configured schema
   * for the attribute: a `DateTime.Utc` for `Schema.DateTimeUtc`, a `Date` for
   * `Schema.Date`, a `number`/`bigint` for numeric schemas, a `string` for
   * lexicographic comparisons.
   */
  const isCasFailure = (stored: unknown, attempted: unknown): boolean => {
    if (stored == null) return false
    // DateTime.Utc — compare epoch ms.
    if (DateTime.isDateTime(stored) && DateTime.isDateTime(attempted)) {
      return DateTime.toEpochMillis(stored) >= DateTime.toEpochMillis(attempted)
    }
    // Date — compare epoch ms.
    if (stored instanceof Date && attempted instanceof Date) {
      return stored.getTime() >= attempted.getTime()
    }
    // Numeric — number or bigint (cast comparable via JS coercion).
    if (typeof stored === "number" && typeof attempted === "number") {
      return stored >= attempted
    }
    if (typeof stored === "bigint" && typeof attempted === "bigint") {
      return stored >= attempted
    }
    // Strings — lexicographic.
    if (typeof stored === "string" && typeof attempted === "string") {
      return stored >= attempted
    }
    // Mixed / unknown shapes — fall back to string compare on String(...).
    // Defensive: return true so we report StaleAppend (the safer default —
    // never suppress a CAS rejection by mis-classifying it as a user-condition
    // rejection).
    return String(stored) >= String(attempted)
  }

  // ---------------------------------------------------------------------------
  // append operation — time-series primitive (only when `timeSeries` configured)
  //
  // Two-item `TransactWriteItems`:
  //  - UpdateItem on current: scoped SET (appendInput fields only) + CAS on
  //    `orderBy`, with GSI keys recomposed when any appendInput field is a
  //    GSI composite. `createdAt` uses if_not_exists on first append.
  //  - Put of event: full decoded input + __edd_e__ + TTL attr (if configured),
  //    GSI keys stripped, SK replaced with `<currentSk>#e#<orderByValue>`.
  //
  // Concurrency outcome (stale-as-error contract — supersedes
  // `docs/designs/timeseries.md` §4.7 v1 stale-as-value):
  //
  // - Success path (default): on transaction success, issue a follow-up
  //   GetItem and return `{ current }` (decoded model).
  // - Stale path (default): on TransactionCancelled, issue a follow-up
  //   GetItem to disambiguate. If the stored `orderBy >= attempted`, the CAS
  //   fired → fail with `StaleAppend(current: Option.some)`. Otherwise the
  //   user-supplied `.condition()` rejected the write → fail with
  //   `ConditionalCheckFailed(current: Option.some)` — `Option.none` when
  //   there is no item: the condition rejected the append creating it.
  // - A cancellation for a `TransactionConflict` alone (another transaction
  //   in flight on the item) is no verdict: the transaction is sent again.
  // - skipFollowUp success path: return `void`.
  // - skipFollowUp stale path: cannot disambiguate (no GetItem), so fail
  //   with `StaleAppend(current: Option.none)` for both cancellation modes.
  //   Documented as a deliberate trade-off in `guides/timeseries.mdx`.
  // - TTL-race / row vanished after success: surface as
  //   `ValidationError("append.followUp")`. Undetected on skipFollowUp path.
  // ---------------------------------------------------------------------------

  const timeSeriesConfig = config.timeSeries as TimeSeriesConfig<any> | undefined

  const appendCore = (
    input: unknown,
    givenCondition?: Expr | ConditionInput,
    skipFollowUp = false,
    removeAttrs?: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const lacks = writeLacks()
      if (!timeSeriesConfig) {
        return yield* new ValidationError({
          entityType,
          operation: "append",
          cause: "Entity is not configured with timeSeries. .append() requires timeSeries config.",
        })
      }
      // `append` takes its condition as an argument — no `condition`
      // combinator — so an empty one becomes none here (#133).
      const userCondition = nonEmptyCondition(givenCondition)
      if (userCondition !== undefined) {
        const packedRefusal = packedExprRefusal(toExpr(userCondition), packedGuards, "condition")
        if (packedRefusal !== undefined) {
          return yield* new ValidationError({
            entityType,
            operation: "append.condition",
            cause: packedRefusal,
          })
        }
      }
      const emptyPart =
        userCondition === undefined ? undefined : emptyPartProblem(toExpr(userCondition))
      if (emptyPart !== undefined) {
        return yield* new ValidationError({
          entityType,
          operation: "append.condition",
          cause: `append: ${emptyPart} Nothing was sent.`,
        })
      }
      const client = yield* Capacity.client
      const tc = yield* tableTag
      const tableName = tc.name
      const ttlAttrName = resolveTtlAttributeName(tc)
      const orderByField = timeSeriesConfig.orderBy
      const ttlDuration = eventTtl()
      const appendInputSchema = schemas.appendInputSchema as Schema.Codec<any>
      // Clock-backed time source for current-item timestamps + event-item TTL.
      const now = yield* DateTime.now

      // ---------- Validate removeAttrs (issue #49) ----------
      // `.remove(attrs)` clears `appendInput` attributes in the same UpdateItem
      // as the scoped SET + CAS. Composite-attribute removal cascades through
      // `composeGsiKeysForUpdatePolicyAware` via the `removedSet` option.
      // Validation enforces the time-series invariants — orderBy, PK/SK
      // composites, and ref fields must not be cleared, and the caller cannot
      // remove enrichment fields outside `appendInput` (that's a `.update()`
      // operation, not an append).
      const requestedRemoves =
        removeAttrs !== undefined && removeAttrs.length > 0 ? new Set(removeAttrs) : undefined
      if (requestedRemoves !== undefined) {
        const primary = config.indexes.primary
        const pkSkComposites = new Set<string>([...primary.pk.composite, ...primary.sk.composite])
        const appendInputTop = timeSeriesConfig.appendInput as Schema.Top
        const appendInputFieldSet = new Set<string>(
          Object.keys(getSchemaFields(appendInputTop) ?? {}),
        )
        const model = config.model as Schema.Top
        for (const attr of requestedRemoves) {
          const unnamed = unaddressable(attr, ttlAttrName)
          if (unnamed !== undefined) {
            return yield* new ValidationError({
              entityType,
              operation: "append.remove",
              cause: `.remove() of "${attr}": ${unnamed}. Nothing was sent.`,
            })
          }
          if (!appendInputFieldSet.has(attr)) {
            return yield* new ValidationError({
              entityType,
              operation: "append.remove",
              cause:
                `Attribute "${attr}" passed to .remove() is not declared in appendInput. ` +
                `.append().remove() can only clear fields the entity exposes via appendInput. ` +
                `Use .update().remove([...]) on the entity for enrichment fields outside appendInput.`,
            })
          }
          if (attr === orderByField) {
            return yield* new ValidationError({
              entityType,
              operation: "append.remove",
              cause: `Attribute "${attr}" is the orderBy clock — removing it would invalidate the CAS anchor.`,
            })
          }
          if (pkSkComposites.has(attr)) {
            return yield* new ValidationError({
              entityType,
              operation: "append.remove",
              cause: `Attribute "${attr}" is a primary-key composite — removing it would orphan the item.`,
            })
          }
          if (isRefField(attr, model)) {
            return yield* new ValidationError({
              entityType,
              operation: "append.remove",
              cause: `Attribute "${attr}" is a ref field — refs are create-time denormalisations and cannot be cleared via .append(). Use .update() to reassign.`,
            })
          }
          const refused = clearRefusal(".remove()", attr, lacks)
          if (refused !== undefined) {
            return yield* new ValidationError({
              entityType,
              operation: "append.remove",
              cause: refused,
            })
          }
        }
      }

      // Removing a defaulted index composite re-materialises its default, as
      // an update's `.remove()` does (#133): the row would read back as the
      // default with its index keys dropped.
      const removedToDefault = defaultedFields.filter(
        ([name]) => requestedRemoves?.has(name) === true && indexedDefaultFields().has(name),
      )
      for (const [attr] of removedToDefault) {
        if ((input as globalThis.Record<string, unknown>)[attr] !== undefined) {
          return yield* new ValidationError({
            entityType,
            operation: "append.remove",
            cause:
              `Attribute "${attr}" appears in both the append payload and .remove(). ` +
              `Choose one — either set the new value or remove the attribute.`,
          })
        }
      }
      const defaulted =
        removedToDefault.length === 0
          ? {}
          : yield* Schema.decodeUnknownEffect(
              Schema.Struct(Object.fromEntries(removedToDefault)) as unknown as Schema.Codec<any>,
            )({}).pipe(
              Effect.mapError(
                (cause) => new ValidationError({ entityType, operation: "append.default", cause }),
              ),
            )
      const removes = [...(requestedRemoves ?? [])].filter(
        (attr) => !removedToDefault.some(([name]) => name === attr),
      )
      const namedRemoves = removes.length > 0 ? new Set(removes) : undefined

      // Encode user input via appendInputSchema (see `put` for strategy).
      const encodedInput = yield* encodeForWrite(
        appendInputSchema,
        removedToDefault.length === 0 ? input : { ...(input as object), ...(defaulted as object) },
        "append",
      )
      const encoded = encodedInput as globalThis.Record<string, unknown>

      // After encoding, detect SET/REMOVE conflict — DynamoDB rejects an
      // UpdateExpression that touches the same attribute in SET and REMOVE.
      // The SET loop (below) skips entries with `undefined` values, so the
      // conflict is only real when the payload carries a non-undefined value
      // for an attribute also named in `.remove()`.
      if (namedRemoves !== undefined) {
        for (const attr of namedRemoves) {
          if (
            attr in encoded &&
            (encoded as globalThis.Record<string, unknown>)[attr] !== undefined
          ) {
            return yield* new ValidationError({
              entityType,
              operation: "append.remove",
              cause:
                `Attribute "${attr}" appears in both the append payload and .remove(). ` +
                `Choose one — either set the new value or remove the attribute.`,
            })
          }
        }
      }

      // A value with no stored form is an absent attribute, on the current item as on
      // the event item, so it's a `.remove()` of that field. A field left unset (an
      // optional `undefined`) isn't: it leaves the current item's attribute alone.
      const absentValues = Object.keys(encoded).filter(
        (attr) =>
          isEmptySet(encoded[attr]) ||
          (encoded[attr] === undefined && lacks.absentReading(attr) !== undefined),
      )
      for (const attr of absentValues) {
        const refused = clearRefusal(".append()", attr, lacks)
        if (refused !== undefined) {
          return yield* new ValidationError({
            entityType,
            operation: "append",
            cause: refused,
          })
        }
      }
      const removedSet =
        absentValues.length === 0
          ? namedRemoves
          : new Set([...(namedRemoves ?? []), ...absentValues])

      // Compose current-item primary key (pk + sk derived from PK/SK composites),
      // and the event key, before anything is marshalled: a value with no key
      // text (`NaN`, `[EDD-9096]`) fails the append with a `ValidationError`.
      // The event key's orderBy segment follows the setting, as `.history().where()` and
      // `liveRows` compose it (`eventOrderByValue`): with `escapeKeys: true` a
      // `NumberFromString` orderBy is the number, so events sort numerically;
      // off, the encoded text 1.36 wrote, which sorts "10" before "9".
      const primary = config.indexes.primary
      const appendKeyForm = keyForm(encoded)
      const { pkValue, currentSk, eventSk } = yield* composeKeysOrFail(entityType, "append", () => {
        const currentSk = KeyComposer.composeSk(
          schema,
          entityType,
          entityVersion,
          primary,
          appendKeyForm,
        )
        return {
          pkValue: KeyComposer.composePk(schema, entityType, primary, appendKeyForm),
          currentSk,
          eventSk: KeyComposer.composeEventSk(
            schema,
            currentSk,
            KeyComposer.eventOrderByValue(
              schema,
              encoded[orderByField],
              appendKeyForm[orderByField],
            ),
          ),
        }
      })

      // Before anything is read or sent. `.append` marshals each value twice over
      // already: the current item's SET and the event item.
      yield* refuseUnstorable(encoded, "append")
      yield* refuseUncomposed(encoded, "append")
      const marshalledKey = toAttributeMap({
        [primary.pk.field]: pkValue,
        [primary.sk.field]: currentSk,
      })
      // `encoded` is already in wire-form via Schema.encode — used directly.
      const serialisedInput: globalThis.Record<string, unknown> = { ...encoded }

      // Packed `appendInput` fields (#147), packed ONCE: the same stored value
      // is SET on the current item and written on the event item.
      const packedStored: globalThis.Record<string, unknown> = {}
      for (const field of Object.keys(packedFields)) {
        if (serialisedInput[field] !== undefined) {
          packedStored[resolveDbName(field)] = serialisedInput[field]
        }
      }
      yield* packFields(packedStored, "append")

      // ---------- Build UpdateItem (scoped SET + CAS) ----------
      const setClauses: Array<string> = []
      const names: globalThis.Record<string, string> = {}
      const values: globalThis.Record<string, AttributeValue> = {}
      let counter = 0

      // Only fields named in appendInput (the serialisedInput object). This is
      // the enrichment-preservation contract — fields outside appendInput are
      // never touched. PK composites ARE included: they're stored as regular
      // attributes on the item (mirrors `.put()`), and though their values
      // never change, writing them on every append makes the first append
      // (where the row doesn't yet exist) materialise the row correctly.
      for (const [attr, val] of Object.entries(serialisedInput)) {
        if (val === undefined || isEmptySet(val)) continue
        const nameKey = `#a${counter}`
        const valKey = `:a${counter}`
        const storedName = resolveDbName(attr)
        names[nameKey] = storedName
        values[valKey] = toAttributeValue(attr in packedFields ? packedStored[storedName] : val)
        setClauses.push(`${nameKey} = ${valKey}`)
        counter++
      }

      // GSI key recomposition. v3 unifies append with update — both call the
      // same composer. The encoded input is the key record, and also the
      // payload without the primary key composites, which every append repeats
      // and so assert nothing: a half mixing one with a field this appendInput
      // doesn't carry belongs to whichever writer owns that field (DESIGN.md §7,
      // shape 10). A half made only of primary key composites still composes on
      // every append, through the key record (#43). EDD-9024 was deprecated in
      // v1.7.1 — the composer doesn't throw for hole patterns. A Z-order value
      // it can't place (EDD-9092, #171) fails the append with a `ValidationError`.
      const appendNamed = Object.fromEntries(
        Object.entries(encoded).filter(
          ([attr]) =>
            !config.indexes.primary.pk.composite.includes(attr) &&
            !config.indexes.primary.sk.composite.includes(attr),
        ),
      )
      //
      // `createdAt` isn't in the input: an append that creates the row stamps it, and any other
      // keeps what's stored (`if_not_exists` below), which an UpdateItem can't tell apart. A half
      // holding it keeps its key the same way (`keptKeys`), on a row where what else the half holds
      // is what this append writes (`keptValues`). Anywhere else the rejected write returns the row
      // to compose from (`DESIGN.md` §7, "An upsert over a value it keeps").
      const stampedCreatedAt = generateTimestamp(systemFields.createdAtEncoding, now)
      const createdAtKeyed =
        systemFields.createdAt !== null && indexCompositeFields().has(systemFields.createdAt)
      const composeAppendKeys = (createdAt: unknown) =>
        composeKeysOrFail(entityType, "append", () =>
          KeyComposer.composeGsiKeysForUpdatePolicyAware(
            schema,
            entityType,
            entityVersion,
            allIndexes,
            keyForm(appendNamed),
            keyForm(
              createdAtKeyed ? { ...encoded, [systemFields.createdAt!]: createdAt } : encoded,
            ),
            removedSet !== undefined ? { removedSet } : undefined,
          ),
        )
      const gsiUpdate = yield* composeAppendKeys(stampedCreatedAt)
      const keptKeys = new Set<string>()
      const keptValues = new Map<string, AttributeValue>()
      if (createdAtKeyed) {
        for (const [indexName, index] of Object.entries(allIndexes)) {
          if (indexName === "primary") continue
          for (const [field, composites] of halvesOf(index)) {
            if (!(field in gsiUpdate.sets) || !composites.includes(systemFields.createdAt!)) {
              continue
            }
            keptKeys.add(field)
            for (const attr of composites) {
              if (attr !== systemFields.createdAt && !isPrimaryComposite(attr)) {
                keptValues.set(resolveDbName(attr), toAttributeValue(serialisedInput[attr]))
              }
            }
          }
        }
      }
      const gsiValueNames: globalThis.Record<string, string> = {}
      const keptKeyNames: Array<string> = []
      // Composed from the stored row, a kept key is written like any other.
      const writtenKeyClauses = new Map<string, string>()
      for (const [field, value] of Object.entries(gsiUpdate.sets)) {
        const nameKey = `#a${counter}`
        const valKey = `:a${counter}`
        names[nameKey] = field
        values[valKey] = toAttributeValue(value)
        gsiValueNames[field] = valKey
        if (keptKeys.has(field)) {
          const clause = `${nameKey} = if_not_exists(${nameKey}, ${valKey})`
          setClauses.push(clause)
          writtenKeyClauses.set(clause, `${nameKey} = ${valKey}`)
          keptKeyNames.push(nameKey)
        } else {
          setClauses.push(`${nameKey} = ${valKey}`)
        }
        counter++
      }
      const appendRemoveClauses: Array<string> = []
      for (const keyField of gsiUpdate.removes) {
        const nameKey = `#a${counter}`
        names[nameKey] = keyField
        appendRemoveClauses.push(nameKey)
        counter++
      }
      // User-supplied attribute REMOVEs (issue #49). Validation above ensured
      // these are safe — they're appendInput fields, not orderBy / PK
      // composites / refs, and don't overlap the encoded payload. The cascade
      // override on any GSI half whose composite list intersects `removedSet`
      // is already wired through `composeGsiKeysForUpdatePolicyAware` above.
      if (removedSet !== undefined) {
        for (const attr of removedSet) {
          const nameKey = `#a${counter}`
          names[nameKey] = resolveDbName(attr)
          appendRemoveClauses.push(nameKey)
          counter++
        }
      }

      // Entity type discriminator — idempotent; ensures existing items
      // without __edd_e__ still get tagged on first append.
      {
        const nameKey = `#a${counter}`
        const valKey = `:a${counter}`
        names[nameKey] = "__edd_e__"
        values[valKey] = toAttributeValue(entityType)
        setClauses.push(`${nameKey} = ${valKey}`)
        counter++
      }

      // createdAt (if configured) — if_not_exists so subsequent appends leave it alone
      if (systemFields.createdAt) {
        const nameKey = `#a${counter}`
        const valKey = `:a${counter}`
        names[nameKey] = resolveDbName(systemFields.createdAt)
        values[valKey] = toAttributeValue(stampedCreatedAt)
        setClauses.push(`${nameKey} = if_not_exists(${nameKey}, ${valKey})`)
        counter++
      }

      // CAS: the append applies when the item is new or its stored orderBy is
      // below the attempted one. `#_tspk` / `#_tsob` name the key and the
      // orderBy attribute; each attempt's condition adds only the names and
      // values it uses (DynamoDB refuses unused ones).
      const pkName = primary.pk.field
      const orderByName = resolveDbName(orderByField)
      // The attempted orderBy as stored (the encoded value).
      const newObValue = serialisedInput[orderByField]
      // The user's condition is ANDed after the CAS, its names and values
      // after the CAS's, as 1.36 sent them.
      const uc =
        userCondition !== undefined ? compileCondition(userCondition, resolveDbName) : undefined
      const expressionOf = (clauses: ReadonlyArray<string>) =>
        [
          ...(clauses.length > 0 ? [`SET ${clauses.join(", ")}`] : []),
          ...(appendRemoveClauses.length > 0 ? [`REMOVE ${appendRemoveClauses.join(", ")}`] : []),
        ].join(" ")
      const updateExpression = expressionOf(setClauses)
      const composedExpression = expressionOf(
        setClauses.map((clause) => writtenKeyClauses.get(clause) ?? clause),
      )

      // ---------- Build Put of event item ----------
      // `encoded` is already in wire-form via Schema.encode; no extra
      // serialisation step is required for the Put.
      const eventItem: globalThis.Record<string, unknown> = { ...encoded }
      // Rename domain → DB names for the Put (matches put path)
      renameToDynamo(eventItem)
      // The packed fields' stored values — the same ones SET above (#147).
      Object.assign(eventItem, packedStored)
      // pk + sk (event)
      eventItem[primary.pk.field] = pkValue
      eventItem[primary.sk.field] = eventSk
      // __edd_e__
      eventItem.__edd_e__ = entityType
      // TTL — attribute name comes from TableConfig (default "_ttl")
      if (ttlDuration) {
        eventItem[ttlAttrName] = DateTime.toEpochSeconds(now) + normalizeTtlSeconds(ttlDuration)
      }
      // Events never participate in indexes: strip any GSI key fields that the
      // naive spread above may have carried over. gsiKeys weren't written into
      // eventItem (only decoded fields are), but defensively clear them.
      for (const field of gsiKeyFields()) {
        delete eventItem[field]
      }
      // Only the current item is searchable — event items carry no embedding.
      for (const field of vectorKeyFields()) {
        delete eventItem[field]
      }
      // Sparse-map fields are aggregate state, not event state. They live on
      // the current item only — strip from event items entirely. (Same
      // treatment as enrichment fields outside `appendInput`. By design,
      // `appendInput` cannot include sparse fields, so this is defensive.)
      if (hasSparseFields) {
        for (const fieldName of Object.keys(sparseFields)) delete eventItem[fieldName]
        // Also strip any flattened bucket attrs that might have leaked in
        // via a future code change — defensive cleanup.
        for (const k of Object.keys(eventItem)) {
          if (sparseEntries.entryOf(k) !== undefined) delete eventItem[k]
        }
      }

      const marshalledEventItem = toAttributeMap(eventItem)

      // ---------- Execute TransactWriteItems ----------
      /** One attempt: the UpdateItem guarded by `cas` (and the user's condition), then the event Put. */
      const send = (cas: AppendCas, expression = updateExpression) => {
        const appendItems: Array<TransactWriteItem> = [
          {
            Update: {
              TableName: tableName,
              Key: marshalledKey,
              UpdateExpression: expression,
              // A rejection hands back the row a kept key has to be composed from.
              ...(keptKeyNames.length > 0 && {
                ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
              }),
              ConditionExpression: uc
                ? `(${cas.expression}) AND (${uc.expression})`
                : cas.expression,
              ExpressionAttributeNames: { ...names, ...cas.names, ...uc?.names },
              ExpressionAttributeValues: { ...values, ...cas.values, ...uc?.values },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: marshalledEventItem,
            },
          },
        ]
        return client.transactWriteItems({ TransactItems: appendItems }).pipe(
          // Another transaction in flight on the item (#171): nothing was
          // judged and nothing written, so the same transaction is sent again
          // — a re-read would find the item unchanged and take the
          // cancellation for a stale append or the user's condition.
          Effect.retry({
            times: APPEND_GUARD_ATTEMPTS - 1,
            while: (err) => isTransactionConflict(err.cause),
          }),
          // A limit DynamoDB enforced (#144) — the current item grown past
          // 400 KB, an oversized event item, an over-long sort key — is
          // diagnosed first: such a cancellation carries no conditional
          // failure, so it is never a stale append.
          diagnoseFailure({
            sent: () => ({
              _tag: "Transaction",
              items: appendItems,
              targets: () =>
                targetsFor(appendItems, entityKeyFields(), entityType, (index) =>
                  index === 0 ? "the current item" : "the event item",
                ),
            }),
            keys: entityKeys,
            rewrite: (diagnosis, original) =>
              diagnosedValidationError(diagnosis, original, { operation: "append", entityType }),
          }),
          Effect.matchEffect({
            onSuccess: () => Effect.succeed({ stale: false as const }),
            onFailure: (
              err: DynamoClientError | ValidationError,
            ): Effect.Effect<
              { readonly stale: true; readonly error: DynamoClientError },
              DynamoClientError | ValidationError
            > => {
              if (err._tag === "ValidationError") return Effect.fail(err)
              // Still contended after every attempt: the transaction's error.
              if (isTransactionConflict(err.cause)) return Effect.fail(err)
              // TransactionCancelled or ConditionalCheckFailed at the transaction
              // level both surface here. Disambiguation between CAS and
              // user-condition happens after the follow-up GetItem (when run).
              if (isAwsTransactionCancelled(err.cause) || isAwsConditionalCheckFailed(err.cause)) {
                return Effect.succeed({ stale: true as const, error: err })
              }
              return Effect.fail(err)
            },
          }),
        )
      }

      /** The current item, decoded — for a result or an error's `current`. */
      const decodeCurrent = (item: globalThis.Record<string, AttributeValue>) =>
        decodeAs(
          fromAttributeMap(item) as globalThis.Record<string, unknown>,
          item,
          "model",
        ) as Effect.Effect<ModelType<TModel>, ValidationError>

      const staleAppend = (current: Option.Option<unknown>) =>
        new StaleAppend({ entityType, orderByField, attemptedOrderBy: newObValue, current })

      /**
       * The post-append current item: one GetItem (skipped under
       * `skipFollowUp`). Strongly consistent: an eventually consistent read
       * can miss the item the append just created, or return it as it was
       * before the append.
       */
      const applied = Effect.gen(function* () {
        if (skipFollowUp) return undefined
        const followUp = yield* client.getItem({
          TableName: tableName,
          Key: marshalledKey,
          ConsistentRead: true,
        })
        if (!followUp.Item) {
          // TTL race or out-of-band delete — the previous state vanished
          // under us. Distinct from a CAS-stale outcome.
          return yield* new ValidationError({
            entityType,
            operation: "append.followUp",
            cause: "Current item not found after append — possible TTL race or concurrent delete.",
          })
        }
        return { current: yield* decodeCurrent(followUp.Item) }
      })

      const readCurrentRow = () =>
        client
          .getItem({ TableName: tableName, Key: marshalledKey, ConsistentRead: true })
          .pipe(Effect.map((result) => result.Item))

      const appendOverRead = (first?: globalThis.Record<string, AttributeValue>) =>
        Effect.gen(function* () {
          // A string-encoded numeric orderBy (`NumberFromString`,
          // `BigIntFromString`) is stored as `S`, and DynamoDB compares `S` as
          // text: `#_tsob < :_tsNewOb` refused 10 after 9 and took 9 after 10
          // (#171 E9). So the append reads the current item (strongly
          // consistent), compares the orderBy's key form — the number — here,
          // and guards the write on the stored value it read (`=`, exact on
          // text). A concurrent append moves the stored value and cancels the
          // write; the append then reads again and decides again, up to
          // `APPEND_GUARD_ATTEMPTS` attempts in all. A key composed from a stored
          // `createdAt` needs the same read, and the same guard: an append that found
          // no item must not write a key for a `createdAt` another writer just created.
          const attempted = appendKeyForm[orderByField] as number | bigint
          const storedKeyForm = (stored: AttributeValue) =>
            Effect.try({
              try: () =>
                keyForm({ [orderByField]: fromAttributeMap({ v: stored }).v })[orderByField] as
                  | number
                  | bigint,
              catch: (cause) => new ValidationError({ entityType, operation: "append", cause }),
            })
          let current = first ?? (yield* readCurrentRow())
          for (let attempt = 1; ; attempt++) {
            const storedOb = current?.[orderByName]
            // The CAS, decided on the numbers: an existing item takes the
            // append only when its stored orderBy is below the attempted one
            // (one without an orderBy never does, as under `<`).
            if (
              current !== undefined &&
              (storedOb === undefined || !((yield* storedKeyForm(storedOb)) < attempted))
            ) {
              return yield* skipFollowUp
                ? staleAppend(Option.none())
                : staleAppend(Option.some(yield* decodeCurrent(current)))
            }
            if (createdAtKeyed) {
              const stored = current?.[resolveDbName(systemFields.createdAt!)]
              const keys = yield* composeAppendKeys(
                stored === undefined ? stampedCreatedAt : fromAttributeMap({ v: stored }).v,
              )
              for (const [field, value] of Object.entries(keys.sets)) {
                values[gsiValueNames[field]!] = toAttributeValue(value)
              }
            }
            const outcome = yield* send(
              current === undefined
                ? {
                    expression: "attribute_not_exists(#_tspk)",
                    names: { "#_tspk": pkName },
                    values: {},
                  }
                : {
                    expression: "#_tsob = :_tsObserved",
                    names: { "#_tsob": orderByName },
                    values: { ":_tsObserved": storedOb! },
                  },
              composedExpression,
            )
            if (!outcome.stale) return yield* applied
            const again = yield* readCurrentRow()
            const moved =
              (current === undefined) !== (again === undefined) ||
              (again !== undefined && !attributeValueEquals(again[orderByName], storedOb))
            if (!moved) {
              // The guard held: the user's condition rejected the write (or
              // something other than a condition cancelled it, which 1.36
              // reported as stale too).
              if (skipFollowUp) return yield* staleAppend(Option.none())
              const decoded =
                again === undefined ? Option.none() : Option.some(yield* decodeCurrent(again))
              return yield* userCondition !== undefined
                ? new ConditionalCheckFailed({
                    entityType,
                    key: encoded as globalThis.Record<string, unknown>,
                    current: decoded,
                  })
                : staleAppend(decoded)
            }
            // Another writer moved the item between the read and the write.
            if (attempt >= APPEND_GUARD_ATTEMPTS) return yield* Effect.fail(outcome.error)
            current = again
          }
        })

      if (
        compositeKeyFormKind(schemas.inputSchema as unknown as Schema.Top, orderByField) ===
        "type-numeric"
      ) {
        return yield* appendOverRead()
      }

      // Any other orderBy compares in DynamoDB as it orders: numbers as
      // numbers, ISO-8601 dates and strings as text. A row whose key stays must have one, or
      // `if_not_exists` would give it a key composed from this append's stamp, and one that still
      // says what this append writes.
      const keptValueGuards = [...keptValues].map(([name, value], index) => ({
        name,
        value,
        nameKey: `#_tsk${index}`,
        valKey: `:_tsk${index}`,
      }))
      const stays = [
        ...keptKeyNames.map((nameKey) => `attribute_exists(${nameKey})`),
        ...keptValueGuards.map((guard) => `${guard.nameKey} = ${guard.valKey}`),
      ]
      const cas: AppendCas = {
        expression:
          stays.length === 0
            ? "attribute_not_exists(#_tspk) OR #_tsob < :_tsNewOb"
            : `attribute_not_exists(#_tspk) OR (#_tsob < :_tsNewOb AND ${stays.join(" AND ")})`,
        names: {
          "#_tspk": pkName,
          "#_tsob": orderByName,
          ...Object.fromEntries(keptValueGuards.map((guard) => [guard.nameKey, guard.name])),
        },
        values: {
          ":_tsNewOb": toAttributeValue(newObValue),
          ...Object.fromEntries(keptValueGuards.map((guard) => [guard.valKey, guard.value])),
        },
      }
      const transactResult = yield* send(cas)

      // The rejection returned the row, whatever rejected it. One without the key, or whose values
      // the key can't stay over, has the key composed from its `createdAt`. A row written before the
      // key could be composed needs that once: from then on it has one.
      const returnedRow =
        transactResult.stale && isAwsTransactionCancelled(transactResult.error.cause)
          ? (transactResult.error.cause.CancellationReasons?.[0]?.Item as
              | globalThis.Record<string, AttributeValue>
              | undefined)
          : undefined
      const rejectedRow =
        transactResult.stale && keptKeyNames.length > 0
          ? (returnedRow ?? (yield* readCurrentRow()))
          : undefined
      if (
        rejectedRow !== undefined &&
        ([...keptKeys].some((key) => rejectedRow[key] === undefined) ||
          keptValueGuards.some(
            (guard) => !attributeValueEquals(rejectedRow[guard.name], guard.value),
          ))
      ) {
        return yield* appendOverRead(rejectedRow)
      }

      // -----------------------------------------------------------------
      // skipFollowUp branch — no GetItem, cannot decode current, cannot
      // disambiguate CAS vs user-condition cancellation. Both modes
      // collapse to StaleAppend(current: Option.none) — documented.
      // -----------------------------------------------------------------
      if (skipFollowUp) {
        if (transactResult.stale) return yield* staleAppend(Option.none())
        return undefined
      }
      if (!transactResult.stale) return yield* applied

      // -----------------------------------------------------------------
      // Cancelled — one follow-up GetItem: the stored orderBy against the
      // attempted one tells the CAS from the user's condition, and the
      // current item goes on the error for the caller. Strongly consistent:
      // the CAS fails only over an item, and a read missing one just
      // created would report the user's condition rejecting its creation.
      // -----------------------------------------------------------------
      const followUp =
        rejectedRow !== undefined
          ? { Item: rejectedRow }
          : yield* client.getItem({
              TableName: tableName,
              Key: marshalledKey,
              ConsistentRead: true,
            })
      if (!followUp.Item) {
        // No item: the CAS holds for a missing one, so with a condition the
        // user's rejected the append creating it — whatever the orderBy type
        // (#171 G5; up to 1.36 this `ValidationError`).
        if (userCondition !== undefined) {
          return yield* new ConditionalCheckFailed({
            entityType,
            key: encoded as globalThis.Record<string, unknown>,
            current: Option.none(),
          })
        }
        return yield* new ValidationError({
          entityType,
          operation: "append.followUp",
          cause: "Current item not found after append — possible TTL race or concurrent delete.",
        })
      }
      const rawCurrent = fromAttributeMap(followUp.Item) as globalThis.Record<string, unknown>
      const currentModel = yield* decodeAs(rawCurrent, followUp.Item, "model")
      // Compare in the WIRE form (what DynamoDB evaluated): `newObValue` is
      // the encoded value passed to the CAS, and `rawCurrent` carries the
      // encoded values read back. `decodeAs` mutated `rawCurrent` to rename
      // DB columns to domain field names, so `rawCurrent[orderByField]` is the
      // wire-form value under its domain name.
      const casFired = isCasFailure(rawCurrent[orderByField], newObValue)
      if (!casFired && userCondition !== undefined) {
        // CAS held; the user's `.condition()` is the only thing that
        // could have rejected.
        return yield* new ConditionalCheckFailed({
          entityType,
          key: encoded as globalThis.Record<string, unknown>,
          current: Option.some(currentModel),
        })
      }
      // Either CAS fired, or no user condition was supplied (CAS is the
      // only possibility) — both map to StaleAppend.
      return yield* staleAppend(Option.some(currentModel))
    })

  // ---------------------------------------------------------------------------
  // history operation — BoundQuery for event items only
  // ---------------------------------------------------------------------------

  // The public `append`: the core as the named operation (consumed capacity, #174).
  const append = (
    input: unknown,
    givenCondition?: Expr | ConditionInput,
    skipFollowUp = false,
    removeAttrs?: ReadonlyArray<string>,
  ) =>
    Capacity.operation(
      "Entity.append",
      { target: entityType },
      appendCore(input, givenCondition, skipFollowUp, removeAttrs),
    )

  const historyQuery = (key: unknown) => {
    if (!timeSeriesConfig) {
      throw new Error(
        `[EDD-9010] Entity "${entityType}": .history() requires timeSeries config on the entity.`,
      )
    }
    const encodedKey = keyForm(encodeKeySync(key))
    const primary = config.indexes.primary
    const pkValue = KeyComposer.composePk(schema, entityType, primary, keyForm(encodedKey))
    const currentSk = KeyComposer.composeSk(
      schema,
      entityType,
      entityVersion,
      primary,
      keyForm(encodedKey as globalThis.Record<string, unknown>),
    )
    const prefix = KeyComposer.composeEventSkPrefix(currentSk, schema.casing)

    const decodeHistory = (raw: globalThis.Record<string, unknown>) => {
      // Sparse fields are aggregate state, not event state — event items DO
      // NOT carry `<prefix>#*` attributes. `deserializeSparseFields` populates
      // empty `{}` Records under the domain field names so the historyRecord
      // schema (which still includes the sparse Record fields) decodes.
      return Effect.flatMap(unpackFields(raw, "history.decode"), () => {
        deserializeSparseFields(raw)
        renameFromDynamo(raw)
        return Schema.decodeUnknownEffect(schemas.historyRecordSchema as Schema.Codec<any>)(
          raw,
        ).pipe(
          Effect.map(attachPrototype),
          Effect.mapError(
            (cause) =>
              new ValidationError({
                entityType,
                operation: "history.decode",
                cause,
              }),
          ),
          missingKeyOnDefect(raw, "history.decode"),
        )
      })
    }

    return Query.make({
      tableName: "",
      indexName: undefined,
      pkField: primary.pk.field,
      pkValue,
      skField: primary.sk.field,
      entityTypes: [entityType],
      decoder: (raw) => decodeHistory(raw),
      ...packedQueryOptions,
      resolveTableName: tableTag.useSync((tc: TableConfig) => tc.name),
      keyFields: [primary.pk.field, primary.sk.field],
    }).pipe(Query.where({ beginsWith: prefix }))
  }

  /**
   * The query `build` makes, or one refused for a key value it can't compose: building
   * a query has no error channel, so its terminals fail instead.
   */
  const refusingQuery = <A>(name: string, build: () => Query.Query<A>): Query.Query<A> =>
    Query.orRefusal({ name, target: entityType }, build, (refusal) =>
      Query.refused<A>(undefined, refusal),
    )

  // ---------------------------------------------------------------------------
  // query namespace
  // ---------------------------------------------------------------------------

  const queryNamespace: globalThis.Record<
    string,
    (pk: globalThis.Record<string, unknown>) => Query.Query<any>
  > = {}
  for (const indexName of Object.keys(config.indexes)) {
    if (indexName === "primary") continue
    // The bound definition: a Z-order half carries its layout (#171).
    const indexDef = data.initialIndexes[indexName] ?? config.indexes[indexName]!
    const zorder = KeyComposer.isZOrderHalf(indexDef.sk)
    const indexQuery = (rawPk: globalThis.Record<string, unknown>) => {
      // Normalise composites to their key form before composing — same rule
      // and same function the write path uses (see `CompositeCodec`). They are
      // the caller's DOMAIN values: the key `put` wrote for one is the key form
      // of the value it stores.
      const pkKeyForm = domainKeyForm(rawPk)
      // One partition, or a sharded index's several (#183).
      const read = KeyComposer.composeReadPartitions(schema, entityType, indexDef, pkKeyForm)
      const pkValue = read.partitions[0]!
      // A Z-order sort key has no text prefix: its prefix composites and
      // dimensions are bounded through `.within()` on the typed accessor, never
      // passed as accessor composites (EDD-9093).
      const misplaced = zorder
        ? indexDef.sk.composite.filter((attr) => pkKeyForm[attr] !== undefined)
        : []
      if (misplaced.length > 0) {
        throw new Error(
          `[EDD-9093] Entity "${entityType}" query "${indexName}": ${misplaced
            .map((attr) => `"${attr}"`)
            .join(", ")} feed${misplaced.length === 1 ? "s" : ""} the Z-order sort key, so ` +
            `${misplaced.length === 1 ? "it" : "they"} can't be passed as accessor composites — ` +
            `pass the partition key composites only and bound them with .within().`,
        )
      }
      const hasSkComposites =
        !zorder && indexDef.sk.composite.some((attr) => pkKeyForm[attr] !== undefined)
      const query = Query.make({
        tableName: "",
        indexName: indexDef.index,
        pkField: indexDef.pk.field,
        pkValue,
        skField: indexDef.sk.field,
        entityTypes: [entityType],
        decoder: (raw) => decodeRecord(raw),
        ...packedQueryOptions,
        resolveTableName: tableTag.useSync((tc: TableConfig) => tc.name),
        keyFields: [
          indexDef.pk.field,
          indexDef.sk.field,
          config.indexes.primary.pk.field,
          config.indexes.primary.sk.field,
        ],
        // DynamoDB's rejection of the key condition (#144) names the accessor.
        keyConditionDiagnosis: { operation: "query", label: `${entityType}.query.${indexName}` },
      }).pipe((made) => Query.fanOut(made, read))
      // `composeSortKeyCondition`: a partial prefix stops on a segment boundary,
      // or it matches sibling values that merely start with the supplied one
      // (`status_done` also matching `status_done_archived`, issue #115), and on a
      // secondary index takes the row truncated at it; a complete key is an exact
      // `=`, or `seq: 3` also matches 3.14.
      const pinned = hasSkComposites
        ? Query.whereUnderPins(
            query,
            KeyComposer.composeSortKeyCondition(
              schema,
              entityType,
              entityVersion,
              indexDef,
              pkKeyForm,
            ),
          )
        : query
      return pinned
    }
    queryNamespace[indexName] = (rawPk: globalThis.Record<string, unknown>) =>
      Query.orRefusal(
        { name: "Entity.query", target: entityType },
        () => indexQuery(rawPk),
        (refusal) => Query.refused(indexDef.index, refusal),
      )
  }

  // ---------------------------------------------------------------------------
  // scan operation
  // ---------------------------------------------------------------------------

  const scan = () =>
    Query.makeScan({
      tableName: "",
      indexName: undefined,
      entityTypes: [entityType],
      decoder: (raw) => decodeRecord(raw),
      ...packedQueryOptions,
      resolveTableName: tableTag.useSync((tc: TableConfig) => tc.name),
      keyFields: [config.indexes.primary.pk.field, config.indexes.primary.sk.field],
      liveRows: liveRows(),
    })

  // ---------------------------------------------------------------------------
  // getVersion operation
  // ---------------------------------------------------------------------------

  const getVersion = (key: unknown, versionNumber: number) =>
    new EntityGetImpl(
      (mode: DecodeMode, opts: EntityGetOpts) =>
        Effect.gen(function* () {
          const client = yield* Capacity.client
          const { name: tableName } = yield* tableTag

          // Caller key: Type side in, ENCODED out (see `encodeKey`).
          const encodedKey = yield* encodeKey(key, "getVersion.decode")

          // Compose PK + version SK
          const primary = config.indexes.primary
          const pkValue = KeyComposer.composePk(schema, entityType, primary, keyForm(encodedKey))
          const liveSk = liveSkOf(encodedKey)
          const read = (versionSk: string) =>
            client
              .getItem({
                TableName: tableName,
                Key: toAttributeMap({
                  [primary.pk.field]: pkValue,
                  [primary.sk.field]: versionSk,
                }),
                ConsistentRead: opts.consistentRead || undefined,
              })
              .pipe(Effect.map((result) => result.Item))

          let item = yield* read(
            DynamoSchema.composeVersionKey(
              schema,
              entityType,
              versionNumber,
              historyKeyOptions(liveSk),
            ),
          )
          // Not under the item's own key: written by an earlier release, under
          // the partition-wide one — if it is this item's (#133).
          if (item === undefined && hasItemHistory) {
            const legacy = yield* read(
              DynamoSchema.composeVersionKey(schema, entityType, versionNumber),
            )
            if (legacy !== undefined && isItemsRow(legacy, liveSk)) item = legacy
          }
          if (!item) {
            return yield* new ItemNotFound({ entityType, key: encodedKey })
          }

          const raw = fromAttributeMap(item)
          return yield* decodeAs(raw, item, mode)
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // versions operation
  // ---------------------------------------------------------------------------

  const versionsQuery = (key: unknown) => {
    const encodedKey = keyForm(encodeKeySync(key))
    const primary = config.indexes.primary
    const pkValue = KeyComposer.composePk(schema, entityType, primary, keyForm(encodedKey))
    const liveSk = liveSkOf(encodedKey)
    const versionPrefix = DynamoSchema.composeVersionKeyPrefix(
      schema,
      entityType,
      historyKeyOptions(liveSk),
    )
    /** The versions whose snapshots are under `prefix`: a keys-only read. */
    const versionsUnder = (tableName: string, prefix: string) =>
      Effect.gen(function* () {
        const client = yield* Capacity.client
        const found = new Set<number>()
        let start: globalThis.Record<string, AttributeValue> | undefined
        do {
          const result = yield* client.query({
            TableName: tableName,
            KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
            ExpressionAttributeNames: { "#pk": primary.pk.field, "#sk": primary.sk.field },
            ExpressionAttributeValues: {
              ":pk": toAttributeValue(pkValue),
              ":prefix": toAttributeValue(prefix),
            },
            ProjectionExpression: "#sk",
            ConsistentRead: true,
            ExclusiveStartKey: start,
          })
          for (const row of result.Items ?? []) {
            found.add(versionOfSk(row[primary.sk.field]?.S))
          }
          start = result.LastEvaluatedKey as globalThis.Record<string, AttributeValue> | undefined
        } while (start !== undefined)
        return found
      })

    /**
     * History an earlier release wrote for this item, under the partition-wide
     * keys (#133): when there is any, the query reads the partition's history
     * and keeps the item's own rows plus those — a version held both ways is
     * read from its own row. Without any, it reads only the item's own.
     */
    const prepare: Query.QueryPrepare | undefined = hasItemHistory
      ? (tableName) =>
          Effect.gen(function* () {
            const legacy = yield* legacyHistory({ tableName, pk: pkValue, liveSk, kind: "version" })
            if (legacy.length === 0) return {}
            const own = yield* versionsUnder(tableName, versionPrefix)
            const legacySks = new Set(
              legacy
                .map((row) => row[primary.sk.field]?.S ?? "")
                .filter((sk) => !own.has(versionOfSk(sk))),
            )
            return {
              replaceBeginsWith: {
                from: versionPrefix,
                to: DynamoSchema.composeVersionKeyPrefix(schema, entityType),
              },
              keep: (row: globalThis.Record<string, AttributeValue>) => {
                const sk = row[primary.sk.field]?.S ?? ""
                return sk.startsWith(versionPrefix) || legacySks.has(sk)
              },
            }
          })
      : undefined

    return Query.make({
      tableName: "",
      indexName: undefined,
      pkField: primary.pk.field,
      pkValue,
      skField: primary.sk.field,
      entityTypes: [entityType],
      decoder: (raw) => decodeRecord(raw),
      ...packedQueryOptions,
      resolveTableName: tableTag.useSync((tc: TableConfig) => tc.name),
      keyFields: [primary.pk.field, primary.sk.field],
      prepare,
    }).pipe(Query.where({ beginsWith: versionPrefix }))
  }

  // ---------------------------------------------------------------------------
  // deleted namespace
  // ---------------------------------------------------------------------------

  const deletedGet = (key: unknown) =>
    new EntityGetImpl(
      (mode: DecodeMode, _opts: EntityGetOpts) =>
        Effect.gen(function* () {
          const { name: tableName } = yield* tableTag

          // Caller key: Type side in, ENCODED out (see `encodeKey`).
          const encodedKey = yield* encodeKey(key, "deleted.get.decode")

          // The item's latest tombstone — not a sibling's in the same partition,
          // and one an earlier release wrote counts (#133).
          const primary = config.indexes.primary
          const pkValue = KeyComposer.composePk(schema, entityType, primary, keyForm(encodedKey))
          const tombstone = yield* latestTombstone(tableName, pkValue, liveSkOf(encodedKey))

          if (tombstone === undefined) {
            return yield* new ItemNotFound({ entityType, key: encodedKey })
          }

          const raw = fromAttributeMap(tombstone)
          yield* checkVersion(raw, "deleted.get.decode")
          // Soft-deleted items have GSI keys stripped — always use deletedRecordSchema
          // (itemSchema would fail because it expects GSI key fields that aren't present)
          if (mode === "native") return tombstone
          // Packed fields: read by their stored form (copied as-is onto the
          // tombstone, #147).
          yield* unpackFields(raw, "deleted.get.decode")
          // Sparse Map fields: rebuild domain Records from flattened attrs so
          // soft-deleted items decode correctly. Sparse data is preserved
          // verbatim across soft-delete (GSI keys are stripped, sparse data is
          // not).
          deserializeSparseFields(raw)
          // `deletedRecordSchema` is keyed by DOMAIN field name, exactly like
          // `recordSchema` — so the same rename `decodeRecord` does applies here
          // (#127). Without it a `field:`-renamed attribute decodes as a missing
          // key and every soft-deleted row of such an entity is unreadable.
          renameFromDynamo(raw)
          const targetSchema = schemas.deletedRecordSchema
          return yield* Schema.decodeUnknownEffect(targetSchema as Schema.Codec<any>)(raw).pipe(
            Effect.map(attachPrototype),
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType,
                  operation: "deleted.get.decode",
                  cause,
                }),
            ),
            missingKeyOnDefect(raw, "deleted.get.decode"),
          )
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  const deletedListQuery = (key: unknown) => {
    const encodedKey = keyForm(encodeKeySync(key))
    const primary = config.indexes.primary
    const pkValue = KeyComposer.composePk(schema, entityType, primary, keyForm(encodedKey))
    // The whole partition's tombstones — every item's, with sort key
    // composites (#133): no item segment.
    const deletedPrefix = DynamoSchema.composeDeletedKeyPrefix(schema, entityType)

    const decodeDeleted = (raw: globalThis.Record<string, unknown>) => {
      const corruption = versionCorruption(raw, "deleted.list.decode")
      if (corruption !== undefined) return Effect.fail(corruption)
      return Effect.flatMap(unpackFields(raw, "deleted.list.decode"), () => {
        // Sparse fields are domain data and are preserved across soft-delete.
        // Rebuild Records from flattened attrs before schema decode.
        deserializeSparseFields(raw)
        // Then attribute → domain names, same order as `decodeRecord` (#127).
        renameFromDynamo(raw)
        return Schema.decodeUnknownEffect(schemas.deletedRecordSchema as Schema.Codec<any>)(
          raw,
        ).pipe(
          Effect.map(attachPrototype),
          Effect.mapError(
            (cause) =>
              new ValidationError({
                entityType,
                operation: "deleted.list.decode",
                cause,
              }),
          ),
          missingKeyOnDefect(raw, "deleted.list.decode"),
        )
      })
    }

    return Query.make({
      tableName: "",
      indexName: undefined,
      pkField: primary.pk.field,
      pkValue,
      skField: primary.sk.field,
      entityTypes: [],
      decoder: (raw) => decodeDeleted(raw),
      ...packedQueryOptions,
      resolveTableName: tableTag.useSync((tc: TableConfig) => tc.name),
      keyFields: [primary.pk.field, primary.sk.field],
    }).pipe(Query.where({ beginsWith: deletedPrefix }))
  }

  // ---------------------------------------------------------------------------
  // restore operation
  // ---------------------------------------------------------------------------

  const restore = (key: unknown) =>
    new EntityGetImpl(
      (mode: DecodeMode, _opts: EntityGetOpts) =>
        Effect.gen(function* () {
          const client = yield* Capacity.client
          const tc = yield* tableTag
          const tableName = tc.name
          const ttlAttrName = resolveTtlAttributeName(tc)
          // Clock-backed time source for the restored updatedAt + retain snapshot.
          const now = yield* DateTime.now

          // Caller key: Type side in, ENCODED out (see `encodeKey`).
          const encodedKey = yield* encodeKey(key, "restore.decode")

          // The item's latest tombstone — not a sibling's in the same partition,
          // and one an earlier release wrote counts (#133).
          const primary = config.indexes.primary
          const pkValue = KeyComposer.composePk(schema, entityType, primary, keyForm(encodedKey))
          const tombstone = yield* latestTombstone(tableName, pkValue, liveSkOf(encodedKey))

          if (tombstone === undefined) {
            return yield* new ItemNotFound({ entityType, key: encodedKey })
          }

          yield* checkVersion(tombstone, "restore")
          const deletedRaw = fromAttributeMap(tombstone)
          const deletedMarshalledKey = toAttributeMap({
            [primary.pk.field]: (deletedRaw as globalThis.Record<string, unknown>)[
              primary.pk.field
            ],
            [primary.sk.field]: (deletedRaw as globalThis.Record<string, unknown>)[
              primary.sk.field
            ],
          })

          // Build restored item: original SK, recompose all GSI keys, remove deletedAt + TTL
          const restoredItem: globalThis.Record<string, unknown> = {
            ...(deletedRaw as globalThis.Record<string, unknown>),
          }
          delete restoredItem.deletedAt
          delete restoredItem[ttlAttrName]

          // Increment version
          // 0: a tombstone of an item written before the entity was `versioned`.
          const currentVersion = systemFields.version
            ? ((restoredItem[systemFields.version] as number | undefined) ?? 0)
            : 0
          const newVersion = currentVersion + 1
          if (systemFields.version) restoredItem[systemFields.version] = newVersion
          if (systemFields.updatedAt)
            restoredItem[systemFields.updatedAt] = generateTimestamp(
              systemFields.updatedAtEncoding,
              now,
            )

          // Domain-keyed VIEW of the tombstone, taken once and used for every
          // read-by-field-name below: key composition, vector-partition
          // recomposition and unique-sentinel composition. `restoredItem` itself
          // stays attribute-keyed — it is the row being written back, and
          // `decodeAs` renames it in place at the end (#127).
          const restoredDomain = toDomainView(restoredItem)

          // Recompose all keys (original SK, GSI keys)
          const restoredKeys = yield* composeAllKeys(restoredDomain, "restore")
          Object.assign(restoredItem, restoredKeys)

          // Un-stash the embedding and recompose the vector partition value —
          // restoring never costs an Embedder call. See `DESIGN.md §14`.
          for (const [, definition] of vectorIndexEntries) {
            const stashed = restoredItem[definition.stashField]
            if (stashed !== undefined) {
              restoredItem[definition.vectorField] = stashed
              delete restoredItem[definition.stashField]
            }
            if (restoredItem[definition.vectorField] === undefined) continue
            const partition = KeyComposer.tryComposeVectorPartition(
              schema,
              entityType,
              definition,
              keyForm(restoredDomain),
            )
            if (partition !== undefined) restoredItem[definition.partitionField] = partition
          }

          const marshalledRestoredItem = toAttributeMap(restoredItem)

          // Build transaction
          type TransactItem = {
            Put?: {
              TableName: string
              Item: globalThis.Record<string, AttributeValue>
              ConditionExpression?: string
              ExpressionAttributeNames?: globalThis.Record<string, string>
              ExpressionAttributeValues?: globalThis.Record<string, AttributeValue>
            }
            Delete?: {
              TableName: string
              Key: globalThis.Record<string, AttributeValue>
              ConditionExpression?: string
              ExpressionAttributeNames?: globalThis.Record<string, string>
            }
          }
          const transactItems: Array<TransactItem | TransactWriteItem> = []

          // Delete the soft-deleted item — only while it is still there: a
          // concurrent restore that already consumed it must not restore twice.
          transactItems.push({
            Delete: {
              TableName: tableName,
              Key: deletedMarshalledKey,
              ConditionExpression: "attribute_exists(#pk)",
              ExpressionAttributeNames: { "#pk": primary.pk.field },
            },
          })

          // Put restored item — never over a live item (a re-created one, or
          // another restore's): that would lose it and orphan its sentinels.
          transactItems.push({
            Put: {
              TableName: tableName,
              Item: marshalledRestoredItem,
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": primary.pk.field },
            },
          })

          // Version snapshot if retain enabled. The source is the TOMBSTONE, so
          // the soft-delete markers have to come off first: `buildSnapshotItem`
          // only ever overrides the TTL attribute when `versioned.ttl` is set, so
          // a `softDelete: { ttl }` expiry rode along and the snapshot of a
          // version that is very much still live expired an hour later — while
          // `deletedAt` made it look like a tombstone. This Put lands on the same
          // `#v#<version>` SK the delete-time snapshot used (same version — the
          // restored item is version + 1), so a dirty item here REPLACED the
          // clean snapshot the delete wrote.
          if (isRetainEnabled()) {
            const snapshotSource = { ...(deletedRaw as globalThis.Record<string, unknown>) }
            delete snapshotSource.deletedAt
            delete snapshotSource[ttlAttrName]
            const snapshotItem = buildSnapshotItem(
              snapshotSource,
              currentVersion,
              primary.pk.field,
              primary.sk.field,
              ttlAttrName,
              now,
              restoredKeys[primary.sk.field],
            )
            // Replaces only the delete-time snapshot of this same state —
            // never another version's history.
            transactItems.push({
              Put: snapshotPut(tableName, snapshotItem),
            })
          }

          // Re-establish unique constraint sentinels (sparse — fields that are
          // unset on the restored item don't get a sentinel; matches put semantics)
          const sentinelConstraints: Array<string> = []
          if (config.unique && Object.keys(config.unique).length > 0) {
            for (const [constraintName, constraintDef] of Object.entries(config.unique)) {
              const sentinel = composeUniqueSentinel(
                schema,
                entityType,
                constraintName,
                constraintDef,
                restoredDomain,
                readSentinelValue,
              )
              if (!sentinel) continue
              sentinelConstraints.push(constraintName)
              const guard = restoreSentinelGuard(
                restoredKeys[primary.pk.field],
                restoredKeys[primary.sk.field],
              )
              transactItems.push({
                Put: {
                  TableName: tableName,
                  Item: toAttributeMap({
                    [primary.pk.field]: sentinel.key.pk,
                    [primary.sk.field]: sentinel.key.sk,
                    __edd_e__: `${entityType}._unique.${constraintName}`,
                    _entity_pk: restoredKeys[primary.pk.field],
                    _entity_sk: restoredKeys[primary.sk.field],
                  }),
                  ConditionExpression: guard.ConditionExpression,
                  ExpressionAttributeNames: guard.ExpressionAttributeNames,
                  ...(guard.ExpressionAttributeValues
                    ? { ExpressionAttributeValues: guard.ExpressionAttributeValues }
                    : {}),
                },
              })
            }
          }

          yield* client
            .transactWriteItems({
              TransactItems: transactItems,
            })
            .pipe(
              Effect.mapError(
                (
                  err,
                ):
                  | DynamoClientError
                  | UniqueConstraintViolation
                  | ItemNotFound
                  | ItemNotDeleted
                  | ValidationError => {
                  if (isAwsTransactionCancelled(err.cause)) {
                    const reasons = err.cause.CancellationReasons
                    // The tombstone is gone (restored concurrently), or a live
                    // item already exists under the key.
                    if (reasons?.[0]?.Code === "ConditionalCheckFailed") {
                      return new ItemNotFound({ entityType, key: encodedKey })
                    }
                    if (reasons?.[1]?.Code === "ConditionalCheckFailed") {
                      return new ItemNotDeleted({ entityType, key: encodedKey })
                    }
                    if (isRetainEnabled() && reasons?.[2]?.Code === "ConditionalCheckFailed") {
                      return historyConflict(currentVersion, "restore")
                    }
                    if (reasons && config.unique) {
                      // Sentinel Puts come after Delete + Put + optional snapshot, in the
                      // order recorded in `sentinelConstraints` (sparse-skipped entries absent)
                      const sentinelStart = isRetainEnabled() ? 3 : 2
                      for (let i = sentinelStart; i < reasons.length; i++) {
                        if (reasons[i]?.Code === "ConditionalCheckFailed") {
                          const constraintName = sentinelConstraints[i - sentinelStart] ?? "unknown"
                          const constraintDef = config.unique[constraintName]
                          const uniqueFields = constraintDef
                            ? resolveUniqueFields(constraintDef)
                            : []
                          const fieldsRecord: globalThis.Record<string, string> = {}
                          for (const f of uniqueFields) {
                            const v = restoredDomain[f]
                            if (v !== undefined && v !== null) {
                              fieldsRecord[f] = KeyComposer.compositeText(schema, v)
                            }
                          }
                          return new UniqueConstraintViolation({
                            entityType,
                            constraint: constraintName,
                            fields: fieldsRecord,
                          })
                        }
                      }
                    }
                  }
                  return err
                },
              ),
              diagnoseTransactionWrite("restore", transactItems),
            )

          return yield* decodeAs(restoredItem, marshalledRestoredItem, mode)
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // purge operation
  // ---------------------------------------------------------------------------

  const purge = (key: unknown) =>
    new EntityDeleteImpl(
      (opts: { readonly condition: Expr | ConditionInput | undefined }) =>
        Effect.gen(function* () {
          // `purge` queries the partition — every row of it, or with sort key
          // composites this item's rows in it (#133) — and batch-deletes them
          // in chunks, so there is no single item for a
          // ConditionExpression to guard and no way to make one atomic across
          // the batches. `.condition()` is structurally available because
          // `purge` returns an `EntityDelete`; refuse it loudly rather than
          // accept a guard that would never be sent.
          if (opts.condition) {
            return yield* new ValidationError({
              entityType,
              operation: "purge.condition",
              cause:
                "[EDD-9047] .condition() is not supported on purge() — purge deletes every item " +
                "in the partition across multiple batched writes, so a per-item ConditionExpression " +
                "cannot be applied atomically. Guard the individual delete with " +
                "delete(key).condition(...) instead.",
            })
          }
          const client = yield* Capacity.client
          const { name: tableName } = yield* tableTag

          // Caller key: Type side in, ENCODED out (see `encodeKey`).
          const encodedKey = yield* encodeKey(key, "purge.decode")

          const primary = config.indexes.primary
          const pkValue = KeyComposer.composePk(schema, entityType, primary, keyForm(encodedKey))
          const liveSk = liveSkOf(encodedKey)
          const allItems: Array<globalThis.Record<string, AttributeValue>> = []
          const history = historyKeyOptions(liveSk)

          /**
           * Whether a row of the partition is this item's (#133). Only this
           * entity's rows (`__edd_e__`): in a single-table design another
           * entity can share the partition — a collection on the primary key —
           * and purge never removes its rows. Without sort key composites that
           * is every row of this entity. With them, the partition holds
           * siblings, and the item's rows are its live row, the rows nested
           * under it (time-series events), and its own history. History an
           * earlier release wrote without an item segment is the item's when
           * the composites it carries compose the item's live key.
           */
          const ownVersions = DynamoSchema.composeVersionKeyPrefix(schema, entityType, history)
          const ownTombstones = DynamoSchema.composeDeletedKeyPrefix(schema, entityType, history)
          const sharedHistory = [
            DynamoSchema.composeVersionKeyPrefix(schema, entityType),
            DynamoSchema.composeDeletedKeyPrefix(schema, entityType),
          ]
          const belongsToItem = (row: globalThis.Record<string, AttributeValue>): boolean => {
            if (row.__edd_e__?.S !== entityType) return false
            if (history === undefined) return true
            const sk = row[primary.sk.field]?.S
            if (sk === undefined) return false
            if (
              sk === liveSk ||
              sk.startsWith(`${liveSk}#`) ||
              sk.startsWith(ownVersions) ||
              sk.startsWith(ownTombstones)
            ) {
              // Unless its composites say whose it is (#171): with `escapeKeys`
              // off a value holding `#` is keyed under the text of another —
              // `a b#c`'s under `a b`'s live key — and is that value's, not
              // this item's.
              try {
                return liveSkOf(toDomainView(fromAttributeMap(row))) === liveSk
              } catch {
                return true
              }
            }
            const unsegmented = sharedHistory.some(
              (prefix) => sk.startsWith(prefix) && !sk.slice(prefix.length).includes("#"),
            )
            // Judged by the composites it carries, which compose the item's
            // live key.
            return unsegmented && isItemsRow(row, liveSk)
          }

          // Query ALL items in this partition (current + versions + deleted).
          // Keys and entity type only — plus, with sort key composites, the
          // composites that attribute an unsegmented history row to its item.
          const projected: globalThis.Record<string, string> = { "#ent": "__edd_e__" }
          if (history !== undefined) {
            primary.sk.composite.forEach((attr, i) => {
              projected[`#c${i}`] = resolveDbName(attr)
            })
          }
          let exclusiveStartKey: globalThis.Record<string, AttributeValue> | undefined

          do {
            const result = yield* client.query({
              TableName: tableName,
              KeyConditionExpression: "#pk = :pk",
              ExpressionAttributeNames: {
                "#pk": primary.pk.field,
                "#sk": primary.sk.field,
                ...projected,
              },
              ExpressionAttributeValues: { ":pk": toAttributeValue(pkValue) },
              ProjectionExpression: ["#pk", "#sk", ...Object.keys(projected)].join(", "),
              ExclusiveStartKey: exclusiveStartKey,
            })

            allItems.push(...(result.Items ?? []).filter(belongsToItem))
            exclusiveStartKey = result.LastEvaluatedKey as
              | globalThis.Record<string, AttributeValue>
              | undefined
          } while (exclusiveStartKey)

          // The unique sentinels the item holds — live, or soft-deleted with
          // `preserveUnique` — and owns (#133): a sentinel of a value the item
          // holds without owning its reservation belongs to another item.
          if (config.unique && Object.keys(config.unique).length > 0) {
            const owner = { pk: pkValue, sk: liveSk }
            const holders: Array<globalThis.Record<string, AttributeValue>> = []
            const mainResult = yield* client.getItem({
              TableName: tableName,
              Key: toAttributeMap({ [primary.pk.field]: owner.pk, [primary.sk.field]: owner.sk }),
              ConsistentRead: true,
            })
            if (mainResult.Item) holders.push(mainResult.Item)
            // Every soft-deleted incarnation (each kept its reservations).
            const deletedPrefix = DynamoSchema.composeDeletedKeyPrefix(schema, entityType)
            let deletedStart: globalThis.Record<string, AttributeValue> | undefined
            do {
              const deletedResult = yield* client.query({
                TableName: tableName,
                KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
                ExpressionAttributeNames: {
                  "#pk": primary.pk.field,
                  "#sk": primary.sk.field,
                },
                ExpressionAttributeValues: {
                  ":pk": toAttributeValue(pkValue),
                  ":skPrefix": toAttributeValue(deletedPrefix),
                },
                ConsistentRead: true,
                ExclusiveStartKey: deletedStart,
              })
              holders.push(...(deletedResult.Items ?? []).filter(belongsToItem))
              deletedStart = deletedResult.LastEvaluatedKey as
                | globalThis.Record<string, AttributeValue>
                | undefined
            } while (deletedStart !== undefined)

            // Sparse — fields that were unset never had a sentinel. The stored
            // row is attribute-keyed, the constraint is not (#127).
            const held = new Map<string, { readonly pk: string; readonly sk: string }>()
            for (const holder of holders) {
              const holderDomain = toDomainView(fromAttributeMap(holder))
              for (const [constraintName, constraintDef] of Object.entries(config.unique)) {
                const sentinel = composeUniqueSentinel(
                  schema,
                  entityType,
                  constraintName,
                  constraintDef,
                  holderDomain,
                  readSentinelValue,
                )
                if (!sentinel) continue
                held.set(`${sentinel.key.pk}\u0000${sentinel.key.sk}`, sentinel.key)
              }
            }
            // Released one by one, each only while still this item's: a batch
            // delete cannot carry the ownership condition.
            for (const sentinel of yield* ownedSentinels(tableName, [...held.values()], owner)) {
              const release = sentinelRelease(tableName, sentinel, owner)
              yield* client.deleteItem(release.Delete).pipe(
                Effect.catchIf(
                  (err) => isAwsConditionalCheckFailed(err.cause),
                  () => Effect.void,
                ),
                // A delete of a stored key cannot meet a size limit; wrapped
                // for uniformity (#144), so it passes through in practice.
                diagnoseItemWrite("purge", release),
              )
            }
          }

          // Batch delete in chunks of 25. `UnprocessedItems` are retried with
          // `Batch.write`'s backoff; what the purge had deleted is always
          // stated exactly, whether a request is rejected or retries run out. By count alone: 25
          // stored keys (at most 2048 + 1024 bytes each, so at most about 0.5 MB as JSON) can't
          // reach the 16 MB request limit.
          let deleted = 0
          const deletedSoFar = () =>
            deleted === 0
              ? "the purge had deleted none of the partition's items"
              : `the purge had already deleted ${deleted} of the partition's ${allItems.length} items`
          for (let i = 0; i < allItems.length; i += 25) {
            const chunk = allItems.slice(i, i + 25)
            let requestItems: globalThis.Record<string, Array<WriteRequest>> = {
              [tableName]: chunk.map((item) => ({
                DeleteRequest: {
                  Key: {
                    [primary.pk.field]: item[primary.pk.field]!,
                    [primary.sk.field]: item[primary.sk.field]!,
                  },
                },
              })),
            }
            let retries = 0
            for (;;) {
              const sentItems = requestItems
              const sentCount = Object.values(sentItems).reduce(
                (sum, requests) => sum + requests.length,
                0,
              )
              const response = yield* client.batchWriteItem({ RequestItems: sentItems }).pipe(
                // Deletes of stored keys: wrapped for uniformity (#144).
                diagnoseFailure({
                  sent: () => {
                    const items = batchEntries(sentItems)
                    return {
                      _tag: "Batch",
                      items,
                      targets: () =>
                        targetsFor(
                          items,
                          entityKeyFields(),
                          entityType,
                          (index) => `purged item ${deleted + index}`,
                        ),
                    }
                  },
                  keys: entityKeys,
                  rewrite: (diagnosis, original) =>
                    diagnosedValidationError(diagnosis, original, {
                      operation: "purge",
                      entityType,
                      committed: `${deletedSoFar()} before it`,
                    }),
                }),
              )
              const unprocessed: globalThis.Record<string, Array<WriteRequest>> = {}
              let remaining = 0
              for (const [table, requests] of Object.entries(response.UnprocessedItems ?? {})) {
                if (requests.length === 0) continue
                unprocessed[table] = requests
                remaining += requests.length
              }
              deleted += sentCount - remaining
              if (remaining === 0) break
              retries++
              if (retries > MAX_RETRIES) {
                return yield* new DynamoError({
                  operation: "BatchWriteItem",
                  cause: new Error(
                    `purge: ${remaining} of the partition's ${allItems.length} items were still ` +
                      `unprocessed after ${MAX_RETRIES} retries; ${deletedSoFar()}. The rest ` +
                      "were not deleted: purge again to finish.",
                  ),
                })
              }
              yield* Effect.sleep(`${BASE_DELAY_MS * 2 ** (retries - 1)} millis`)
              requestItems = unprocessed
            }
          }
        }),
      self,
      key as globalThis.Record<string, unknown>,
    )

  // ---------------------------------------------------------------------------
  // rekey: the entity's part in `db.tables.<Table>.rekey()`, the only migration of key text
  //
  // Every other operation composes one key text and looks nowhere else. `rekey` brings each row
  // to it. A scanned row of the entity is judged by its own values. Under the key they compose now
  // it is current: its index keys, vector partitions and unique sentinels may still hold other
  // text, rewritten in place. Under the key they compose under any other text it moves, keeping
  // its layout. Under neither it is counted (`skipped.unrecognizedKey`). Nothing is overwritten: a
  // row whose current key another row holds is a conflict, unless that row is itself another
  // value's under other text, which moves first.
  // ---------------------------------------------------------------------------

  type StoredRow = globalThis.Record<string, AttributeValue>
  type StoredKey = globalThis.Record<string, string>
  type RowKind = "item" | "snapshot" | "tombstone" | "outbox" | "event"

  const rekeyPk = config.indexes.primary.pk.field
  const rekeySk = config.indexes.primary.sk.field
  const keyAt = (pk: string, sk: string): StoredKey => ({ [rekeyPk]: pk, [rekeySk]: sk })
  const sameStoredKey = (a: globalThis.Record<string, unknown>, b: StoredKey): boolean =>
    a[rekeyPk] === b[rekeyPk] && a[rekeySk] === b[rekeySk]
  /** A stored key as a sentinel's back-pointer names it. */
  const ownerOf = (key: StoredKey) => ({ pk: key[rekeyPk], sk: key[rekeySk] })
  const storedKeyOf = (row: StoredRow): StoredKey | undefined => {
    const pk = row[rekeyPk]?.S
    const sk = row[rekeySk]?.S
    return pk === undefined || sk === undefined ? undefined : keyAt(pk, sk)
  }
  /** A sentinel key (`{ pk, sk }`) as a primary key record. */
  const sentinelKeyRecord = (key: { readonly pk: string; readonly sk: string }): StoredKey =>
    keyAt(key.pk, key.sk)
  /** Is `row` a projection's row tombstone or outbox item of this read model (#154, #155)? */
  const isValueless = (row: StoredRow): boolean =>
    row.__edd_e__?.S === `${entityType}#tombstone` || row.__edd_e__?.S === `${entityType}#outbox`
  /** Does a drainer hold `row`, an outbox item, now? Its claim lasts until `__edd_claimed_until__`. */
  const claimedNow = (row: StoredRow) =>
    Effect.map(DateTime.now, (now) => {
      const until = row[OUTBOX_CLAIMED_UNTIL]?.N
      return until !== undefined && Number(until) >= DateTime.toEpochMillis(now)
    })
  /** The kind of value each primary key composite's key form is, by its schema. */
  const primaryKeyKinds = (() => {
    const fields = getSchemaFields(schemas.inputSchema as unknown as Schema.Top)
    const kinds = new Map<string, KeyText136.ValueKind>()
    for (const field of [
      ...config.indexes.primary.pk.composite,
      ...config.indexes.primary.sk.composite,
    ]) {
      const fieldSchema = fields?.[field]
      kinds.set(field, fieldSchema === undefined ? undefined : keyFormValueKind(fieldSchema))
    }
    return kinds
  })()

  /** Every key text a row of this entity can be stored under, whatever the setting is now. */
  const keyFormsOf = (): ReadonlyArray<KeyText136.KeyForm> =>
    Object.entries(allIndexes).some(
      ([name, index]) =>
        name !== "primary" && (isTableKeyField(index.pk.field) || isTableKeyField(index.sk.field)),
    )
      ? [...KeyText136.forms(schema), KeyText136.invertedForm137(schema)]
      : KeyText136.forms(schema)

  /** The fields the primary key's text is composed from. */
  const primaryTextFields: ReadonlyArray<string> = [
    ...new Set([...config.indexes.primary.pk.composite, ...config.indexes.primary.sk.composite]),
  ]

  /**
   * The reading of `record`, a key-form record, whose `compose` gives `stored`: each of `fields`
   * holding a number or a bigint as its own kind or as the other one, the other read from the
   * digits `row` stored (`CompositeCodec.kindReadingOf`): a field that stored both kinds composed
   * each value's own kind's text. Each value stays in key form (`kindKeyForm`), a numeric value
   * given as the kind a release stored. `record` itself when it composes `stored`, at the cost of
   * that one composition; otherwise one composition per field, never one per combination.
   */
  const kindReading = (
    row: StoredRow,
    record: globalThis.Record<string, unknown>,
    fields: ReadonlyArray<string>,
    compose: (
      kindKeyForm: globalThis.Record<string, unknown>,
      asOther: ReadonlySet<string>,
    ) => string | ReadonlyArray<string> | undefined,
    stored: string,
  ) =>
    kindReadingOf(
      record,
      fields,
      (field) => row[resolveDbName(field)]?.N,
      (reading) => compose(reading.record, reading.asOther),
      stored,
    )

  /**
   * A table key as one text, for {@link kindReading}: both halves, neither running into the other.
   * {@link keySegments} gives it in its halves.
   */
  const storedKeyText = (key: StoredKey): string => JSON.stringify([key[rekeyPk], key[rekeySk]])

  /**
   * A key's text ({@link storedKeyText}) in its two halves, which concatenate to it: a composite in
   * both halves is read as one kind in both (`CompositeCodec.kindReadingOf`).
   */
  const keySegments = (pk: string | undefined, sk: string | undefined): ReadonlyArray<string> => [
    `[${JSON.stringify(pk)}`,
    `,${JSON.stringify(sk)}]`,
  ]

  /** Bytes as text, one character a byte, for {@link kindReading}. */
  const bytesText = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

  /**
   * A row's values in the key form, then in 1.39.0's where that differs (`keyForm139`): the
   * records each key text a row may be stored under is composed from.
   */
  const rowKeyForms = (
    values: globalThis.Record<string, unknown>,
  ): ReadonlyArray<globalThis.Record<string, unknown>> => {
    const rowKeyForm = keyForm(values)
    const rowKeyForm139 = keyForm139(values)
    return Object.keys(rowKeyForm139).some(
      (attr) =>
        !Object.is(
          rowKeyForm139[attr],
          Object.hasOwn(rowKeyForm, attr) ? rowKeyForm[attr] : undefined,
        ),
    )
      ? [rowKeyForm, rowKeyForm139]
      : [rowKeyForm]
  }

  type RowTargets = {
    readonly kind: RowKind
    /** Where the row belongs now. */
    readonly current: StoredKey
    /** Where it is stored, when that is its place under some key text. */
    readonly old: StoredKey | undefined
    /** The item's key now: a tombstone's sentinels name the item. */
    readonly live: StoredKey
    /**
     * Is `key` the item's key under some text, one a tombstone's sentinels may name: its key now,
     * or what its values compose under another text, a numeric composite as either kind.
     */
    readonly isLive: (key: StoredKey) => boolean
    /**
     * For a row 1.39.0 keyed by a codec's doubled text (`keyForm139`): where its values' stored
     * text puts the same row under each other text, from which another row (a read model's removal
     * tombstone, or a write since) may move to `current` too ({@link clearTarget}).
     */
    readonly elsewhere: ReadonlyArray<StoredKey>
  }

  /** What a row's sort key says it is, for a row whose values compose no key to say it by. */
  const storedRowKind = (sk: string): RowKind => {
    const versions = DynamoSchema.composeVersionKeyPrefix(schema, entityType)
    if (sk.startsWith(versions) && /^(?:.*#)?\d{7,}$/.test(sk.slice(versions.length))) {
      return "snapshot"
    }
    const tombstones = DynamoSchema.composeDeletedKeyPrefix(schema, entityType)
    if (
      sk.startsWith(tombstones) &&
      /^(?:.*#)?\d{4}-\d\d-\d\dT[^#]*$/.test(sk.slice(tombstones.length))
    ) {
      return "tombstone"
    }
    return timeSeriesConfig !== undefined && sk.includes("#e#") ? "event" : "item"
  }

  /**
   * Where a row of the entity belongs now and whether it is stored where some key text put it,
   * from its values and the layout of its sort key: `uncomposable` with what refused them for a
   * row holding a composite whose value has no key text (`NaN`) or that no form of its schema takes
   * (`EDD-9050`), and `undefined` for a row missing one, or of no layout the entity writes. A
   * history row keeps its layout: one an earlier release wrote without an item segment (#133)
   * moves only its partition key.
   */
  const rowPlaces = (
    row: StoredRow,
  ): RowTargets | { readonly uncomposable: string } | undefined => {
    if (row.__edd_e__?.S !== entityType) return undefined
    const stored = storedKeyOf(row)
    if (stored === undefined) return undefined
    try {
      const primary = config.indexes.primary
      const values = toDomainView(fromAttributeMap(row) as globalThis.Record<string, unknown>)
      const live = composePrimaryKey(values) as StoredKey
      const rowKeyForm = keyForm(values)
      // Each reading of the values a key text was composed from: the key form, and the one up to
      // 1.39.0 (`keyForm139`), which keyed a codec whose `encode` takes its own output by its
      // stored text encoded once more.
      const readings = rowKeyForms(values)
      const now: KeyText136.KeyForm = { pk: schema, sk: schema }
      type At = (
        form: KeyText136.KeyForm,
        key: StoredKey,
        record: globalThis.Record<string, unknown>,
      ) => StoredKey
      /**
       * Is `key` where `atOf(reading)` puts a row of some kind reading of some reading of the
       * values, under some form?
       */
      const placed = (
        key: StoredKey,
        atOf: (reading: globalThis.Record<string, unknown>) => At,
        fields: ReadonlyArray<string>,
        among: ReadonlyArray<globalThis.Record<string, unknown>> = readings,
      ) =>
        among.some((reading) => {
          const at = atOf(reading)
          return keyFormsOf().some(
            (form) =>
              kindReading(
                row,
                reading,
                fields,
                (kindKeyForm) => {
                  const placedAt = at(
                    form,
                    KeyText136.composeAt(
                      form,
                      entityType,
                      entityVersion,
                      primary,
                      kindKeyForm,
                    ) as StoredKey,
                    kindKeyForm,
                  )
                  return keySegments(placedAt[rekeyPk], placedAt[rekeySk])
                },
                storedKeyText(key),
              ) !== undefined,
          )
        })
      const itemAt = (): At => (_, at) => at
      const isLive = (key: StoredKey) =>
        sameStoredKey(key, live) || placed(key, itemAt, primaryTextFields)
      const targets = (
        kind: RowKind,
        atOf: (reading: globalThis.Record<string, unknown>) => At,
        fields: ReadonlyArray<string> = primaryTextFields,
      ): RowTargets => {
        const current = atOf(rowKeyForm)(now, live, rowKeyForm)
        const under139 = readings.length > 1 && !placed(stored, atOf, fields, [rowKeyForm])
        return {
          kind,
          current,
          old: sameStoredKey(stored, current) || placed(stored, atOf, fields) ? stored : undefined,
          live,
          isLive,
          elsewhere: !under139
            ? []
            : keyFormsOf().flatMap((form) => {
                try {
                  const at = atOf(rowKeyForm)(
                    form,
                    KeyText136.composeAt(form, entityType, entityVersion, primary, rowKeyForm),
                    rowKeyForm,
                  )
                  return sameStoredKey(at, current) || sameStoredKey(at, stored) ? [] : [at]
                } catch {
                  return []
                }
              }),
        }
      }
      const layoutOf = (reading: globalThis.Record<string, unknown>) =>
        historyLayout(stored[rekeySk]!, values, reading)
      const history = layoutOf(rowKeyForm)
      // A history layout's place, from the reading a key text was composed from.
      const historyAt = (reading: globalThis.Record<string, unknown>): At => layoutOf(reading)!.at
      if (sameStoredKey(stored, live)) return targets("item", itemAt)
      // A history row under its current key, which nothing else composes.
      if (history !== undefined && sameStoredKey(stored, history.at(now, live, rowKeyForm))) {
        return targets(history.kind, historyAt, history.fields)
      }
      if (isLive(stored)) return targets("item", itemAt)
      return history === undefined ? undefined : targets(history.kind, historyAt, history.fields)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Capacity.isRefusedValue(error) || message.startsWith("[EDD-9050]")
        ? { uncomposable: message }
        : undefined
    }
  }

  /**
   * A history row's kind by the layout of its sort key `sk`, with where a row of that kind is for
   * an item at a key ({@link rowPlaces}), and the fields that composes it from; `undefined` for a
   * sort key of no history layout, or an event missing its `orderBy` value.
   */
  const historyLayout = (
    sk: string,
    values: globalThis.Record<string, unknown>,
    rowKeyForm: globalThis.Record<string, unknown>,
  ):
    | {
        readonly kind: RowKind
        readonly at: (
          form: KeyText136.KeyForm,
          key: StoredKey,
          record: globalThis.Record<string, unknown>,
        ) => StoredKey
        readonly fields: ReadonlyArray<string>
      }
    | undefined => {
    const versions = DynamoSchema.composeVersionKeyPrefix(schema, entityType)
    if (sk.startsWith(versions) && /^(?:.*#)?\d{7,}$/.test(sk.slice(versions.length))) {
      if (!sk.slice(versions.length).includes("#")) {
        return {
          kind: "snapshot",
          at: (_, key) => keyAt(key[rekeyPk]!, sk),
          fields: primaryTextFields,
        }
      }
      const version = versionOfSk(sk)
      return {
        kind: "snapshot",
        at: (_, key) =>
          keyAt(
            key[rekeyPk]!,
            DynamoSchema.composeVersionKey(
              schema,
              entityType,
              version,
              historyKeyOptions(key[rekeySk]),
            ),
          ),
        fields: primaryTextFields,
      }
    }
    const tombstones = DynamoSchema.composeDeletedKeyPrefix(schema, entityType)
    if (
      sk.startsWith(tombstones) &&
      /^(?:.*#)?\d{4}-\d\d-\d\dT[^#]*$/.test(sk.slice(tombstones.length))
    ) {
      if (!sk.slice(tombstones.length).includes("#")) {
        return {
          kind: "tombstone",
          at: (_, key) => keyAt(key[rekeyPk]!, sk),
          fields: primaryTextFields,
        }
      }
      const timestamp = sk.slice(sk.lastIndexOf("#") + 1)
      return {
        kind: "tombstone",
        at: (_, key) =>
          keyAt(
            key[rekeyPk]!,
            DynamoSchema.composeDeletedKey(
              schema,
              entityType,
              timestamp,
              historyKeyOptions(key[rekeySk]),
            ),
          ),
        fields: primaryTextFields,
      }
    }
    if (timeSeriesConfig === undefined) return undefined
    const orderBy = timeSeriesConfig.orderBy
    if (values[orderBy] === undefined || values[orderBy] === null) return undefined
    // What `append` composed the key from: the Encoded value it stored, which a `bigint`
    // reads back from as a number while it's a safe integer.
    const appended = readSentinelValue(orderBy, values[orderBy]) ?? values[orderBy]
    return {
      kind: "event",
      at: (form, key, record) =>
        keyAt(
          key[rekeyPk]!,
          KeyComposer.composeEventSk(
            form.sk,
            key[rekeySk]!,
            KeyComposer.eventOrderByValue(
              form.sk,
              // As the other numeric kind, the value is its own Encoded form.
              record[orderBy] === rowKeyForm[orderBy] ? appended : record[orderBy],
              record[orderBy],
            ),
          ),
        ),
      fields: [...new Set([...primaryTextFields, orderBy])],
    }
  }

  /** {@link rowPlaces}, for a row whose values compose its keys. */
  const rowTargets = (row: StoredRow): RowTargets | undefined => {
    const places = rowPlaces(row)
    return places === undefined || "uncomposable" in places ? undefined : places
  }

  /**
   * Who holds `at`, a row's current key: the same row (stored under both
   * keys, or moved there since), another value's row still under other key text, which moves out
   * first, or another row. A projection's row tombstone or outbox item is stale when its key's
   * values compose another key now ({@link valuelessMove}).
   */
  const occupantOf = (held: StoredRow, at: StoredKey): "same" | "stale" | "other" => {
    if (isValueless(held)) {
      return typeof valuelessMove(held, { pk: rekeyPk, sk: rekeySk }) === "object"
        ? "stale"
        : "other"
    }
    const targets = rowTargets(held)
    if (targets === undefined) return "other"
    if (sameStoredKey(targets.current, at)) return "same"
    if (targets.old !== undefined && sameStoredKey(targets.old, at)) return "stale"
    return "other"
  }

  /** Is `held` the same snapshot state as `read` ({@link sameSnapshotAs}, as values)? */
  const sameSnapshotHeld = (held: StoredRow, read: StoredRow): boolean =>
    [systemFields.version, INCARNATION_TOKEN, systemFields.updatedAt].every(
      (attr) => typeof attr !== "string" || attributeValueEquals(held[attr], read[attr]),
    )

  const rekeyConflict = (
    kind: RowKind,
    reason: "bothKeys" | "taken" | "contended" | "failed" | "uncomposable",
    key: StoredKey,
    target: StoredKey | undefined,
    message: string,
  ): Rekey.RekeyTally => ({
    conflicts: [{ member: entityType, kind, reason, key, target, message }],
  })

  /** A row counted once per run, however many handlers see it move. */
  const countMove = (
    ctx: Rekey.RekeyRowContext,
    kind: RowKind,
    to: StoredKey,
    extra?: Rekey.RekeyTally,
  ): Rekey.RekeyTally =>
    Rekey.mergeTallies(
      ctx.claim(`${entityType}\u0000moved\u0000${to[rekeyPk]}\u0000${to[rekeySk]}`)
        ? { moved: { [kind]: 1 } }
        : {},
      extra ?? {},
    )

  /**
   * A row moved since the scan read it — by this run, or by a write. Moved by
   * a write, it is `unchanged`, as a row the scan reads at its current key
   * is: `moved` counts the rows this run moved. Moved by this run, it was
   * counted by the move.
   */
  const movedAway = (ctx: Rekey.RekeyRowContext, to: StoredKey) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const { Item: there } = yield* client.getItem({
        TableName: ctx.tableName,
        Key: toAttributeMap(to),
        ConsistentRead: true,
      })
      return there !== undefined &&
        occupantOf(there, to) === "same" &&
        ctx.claim(`${entityType}\u0000moved\u0000${to[rekeyPk]}\u0000${to[rekeySk]}`)
        ? { unchanged: 1 }
        : {}
    })

  /**
   * The first row at one of `elsewhere` that moves to `to`, and that row as it would be there.
   */
  const movingThereToo = (
    ctx: Rekey.RekeyRowContext,
    elsewhere: ReadonlyArray<StoredKey>,
    to: StoredKey,
  ) =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      for (const key of elsewhere) {
        const { Item: row } = yield* client.getItem({
          TableName: ctx.tableName,
          Key: toAttributeMap(key),
          ConsistentRead: true,
        })
        if (row === undefined) continue
        const plan = isValueless(row) ? valuelessMove(row, { pk: rekeyPk, sk: rekeySk }) : undefined
        if (typeof plan === "object" && sameStoredKey(plan.to, to)) {
          return { row, at: plan.moved(row) }
        }
        const targets = plan === undefined ? rowTargets(row) : undefined
        if (targets !== undefined && sameStoredKey(targets.current, to)) {
          return { row, at: { ...row, ...toAttributeMap(to) } }
        }
      }
      return undefined
    })

  /** A row is left because what holds its current key has to move first, and can't. */
  const cantMoveHolder = (kind: RowKind, from: StoredKey, to: StoredKey) =>
    rekeyConflict(kind, "taken", from, to, "A row that can't move holds its current key.")

  /**
   * Make room at `to` for a row moving there: a stale row (another value's,
   * under other key text) moves out first. A tally of what moved, or the
   * conflict that leaves the row where it is. `copy`: whether the row at `to`
   * is a copy of the moving one, which the move then only deletes (`twin`).
   *
   * `elsewhere` ({@link RowTargets.elsewhere}): a row 1.39.0 keyed by a codec's doubled text moves
   * to `to` after a row there that moves there too, whichever the scan reaches first, so a read
   * model's removal tombstone, not the row it removed, ends up at `to`, and the report is the
   * same in every order. In a dry run nothing moves: that row is judged as if at `to`.
   */
  const clearTarget = (
    ctx: Rekey.RekeyRowContext,
    kind: RowKind,
    from: StoredKey,
    to: StoredKey,
    depth: number,
    copy?: (held: StoredRow) => boolean,
    elsewhere: ReadonlyArray<StoredKey> = [],
  ): Effect.Effect<
    | { readonly cleared: true; readonly tally: Rekey.RekeyTally }
    | { readonly cleared: false; readonly tally: Rekey.RekeyTally }
    | { readonly cleared: "twin"; readonly tally: Rekey.RekeyTally },
    DynamoClientError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      const { Item: atTarget } = yield* client.getItem({
        TableName: ctx.tableName,
        Key: toAttributeMap(to),
        ConsistentRead: true,
      })
      const first =
        atTarget === undefined && depth < Rekey.DISPLACE_DEPTH
          ? yield* movingThereToo(ctx, elsewhere, to)
          : undefined
      if (first !== undefined) {
        const tally = yield* Rekey.displace(ctx, (under) => rekeyRow(first.row, under, depth + 1))
        if ((tally.conflicts ?? []).length > 0) {
          return {
            cleared: false,
            tally: Rekey.mergeTallies(tally, cantMoveHolder(kind, from, to)),
          }
        }
        if (!ctx.dryRun) {
          const after = yield* clearTarget(ctx, kind, from, to, depth, copy)
          return { ...after, tally: Rekey.mergeTallies(tally, after.tally) }
        }
      }
      const held = atTarget ?? first?.at
      if (held === undefined) return { cleared: true, tally: {} }
      const occupant = occupantOf(held, to)
      if (occupant === "same" && copy?.(held) === true) return { cleared: "twin", tally: {} }
      if (occupant === "same") {
        // A move since the caller's read (another row's in this run, or a write) puts it
        // here too, and takes it from there: it's only under both if it's still there.
        const { Item: left } = yield* client.getItem({
          TableName: ctx.tableName,
          Key: toAttributeMap(from),
          ConsistentRead: true,
        })
        const leftTargets = left === undefined ? undefined : rowTargets(left)
        if (leftTargets === undefined || !sameStoredKey(leftTargets.current, to)) {
          return { cleared: false, tally: yield* movedAway(ctx, to) }
        }
        return {
          cleared: false,
          tally: rekeyConflict(
            kind,
            "bothKeys",
            from,
            to,
            "The row is also stored under its current key.",
          ),
        }
      }
      if (occupant === "other") {
        return {
          cleared: false,
          tally: rekeyConflict(kind, "taken", from, to, "Another row holds its current key."),
        }
      }
      if (depth >= Rekey.DISPLACE_DEPTH) {
        return {
          cleared: false,
          tally: rekeyConflict(
            kind,
            "contended",
            from,
            to,
            "Too many rows under other key text hold each other's current keys.",
          ),
        }
      }
      const tally = yield* Rekey.displace(ctx, (under) => rekeyRow(held, under, depth + 1))
      return (tally.conflicts ?? []).length === 0
        ? { cleared: true, tally }
        : { cleared: false, tally: Rekey.mergeTallies(tally, cantMoveHolder(kind, from, to)) }
    })

  /**
   * Move a history row (snapshot, tombstone, event) from `from` to `to`: one transaction puts it
   * there — nothing else may be — and deletes it at `from`, guarded on the row as read. A
   * tombstone's unique sentinels (`preserveUnique`) move in the same transaction: they name the
   * item's live key, not the tombstone's ({@link sentinelRekeys}). A snapshot whose current key
   * holds the same snapshot (`sameSnapshotAs`: a write of the item re-put it there) is a copy: its
   * old row is deleted, while that one is still there and the same, and counted as moved.
   */
  const moveHistoryRow = (
    ctx: Rekey.RekeyRowContext,
    kind: RowKind,
    from: StoredKey,
    to: StoredKey,
    depth: number,
  ): Effect.Effect<Rekey.RekeyTally, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      let tally: Rekey.RekeyTally = {}
      for (let attempt = 0; attempt < GUARDED_PUT_ATTEMPTS; attempt++) {
        // The scan's read is eventually consistent: act on a consistent one.
        const { Item: read } = yield* client.getItem({
          TableName: ctx.tableName,
          Key: toAttributeMap(from),
          ConsistentRead: true,
        })
        const targets = read === undefined ? undefined : rowTargets(read)
        if (targets === undefined || !sameStoredKey(targets.current, to)) {
          return Rekey.mergeTallies(tally, yield* movedAway(ctx, to))
        }
        const same = kind === "snapshot" ? sameSnapshotAs(read!) : undefined
        const room = yield* clearTarget(
          ctx,
          kind,
          from,
          to,
          depth,
          same === undefined ? undefined : (held) => sameSnapshotHeld(held, read!),
          targets.elsewhere,
        )
        tally = Rekey.mergeTallies(tally, room.tally)
        if (room.cleared === "twin") {
          if (ctx.dryRun) return countMove(ctx, kind, to, tally)
          const guard = deleteGuard(read!, "item", undefined)
          const items: ReadonlyArray<TransactWriteItem> = [
            {
              ConditionCheck: {
                TableName: ctx.tableName,
                Key: toAttributeMap(to),
                ConditionExpression: `attribute_exists(#snap) AND (${same!.expression})`,
                ExpressionAttributeNames: same!.names,
                ...(Object.keys(same!.values).length > 0 && {
                  ExpressionAttributeValues: same!.values,
                }),
              },
            },
            {
              Delete: {
                TableName: ctx.tableName,
                Key: toAttributeMap(from),
                ConditionExpression: guard.expression,
                ExpressionAttributeNames: guard.names,
                ...(Object.keys(guard.values).length > 0 && {
                  ExpressionAttributeValues: guard.values,
                }),
              },
            },
          ]
          const deleted = yield* client.transactWriteItems({ TransactItems: [...items] }).pipe(
            Effect.as(true),
            Effect.catch((err: DynamoClientError) =>
              isAwsTransactionCancelled(err.cause) ? Effect.succeed(false) : Effect.fail(err),
            ),
          )
          if (deleted) return countMove(ctx, kind, to, tally)
          // Either row changed between the reads and the write: read again.
          continue
        }
        if (!room.cleared) return tally
        const values = toDomainView(fromAttributeMap(read!) as globalThis.Record<string, unknown>)
        const sentinels =
          kind === "tombstone"
            ? yield* sentinelRekeys(
                ctx,
                kind,
                values,
                read!,
                targets.isLive,
                targets.live,
                depth,
                true,
              )
            : NO_SENTINEL_REKEYS
        if (ctx.dryRun) {
          return Rekey.mergeTallies(countMove(ctx, kind, to, tally), sentinels.tally, {
            sentinelsMoved: sentinels.count,
          })
        }
        const guard = deleteGuard(read!, "item", undefined)
        const items: ReadonlyArray<TransactWriteItem> = [
          {
            Put: {
              TableName: ctx.tableName,
              Item: { ...read!, ...toAttributeMap(to) },
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": rekeyPk },
            },
          },
          {
            Delete: {
              TableName: ctx.tableName,
              Key: toAttributeMap(from),
              ConditionExpression: guard.expression,
              ExpressionAttributeNames: guard.names,
              ...(Object.keys(guard.values).length > 0 && {
                ExpressionAttributeValues: guard.values,
              }),
            },
          },
          ...sentinels.items,
        ]
        const done = yield* client.transactWriteItems({ TransactItems: [...items] }).pipe(
          Effect.as(true),
          Effect.catch((err: DynamoClientError) =>
            isAwsTransactionCancelled(err.cause) ? Effect.succeed(false) : Effect.fail(err),
          ),
        )
        if (done) {
          return Rekey.mergeTallies(countMove(ctx, kind, to, tally), sentinels.tally, {
            sentinelsMoved: sentinels.count,
          })
        }
        // Something changed between the read and the write: read again.
      }
      return Rekey.mergeTallies(
        tally,
        rekeyConflict(
          kind,
          "contended",
          from,
          to,
          "Concurrent writes changed it on every attempt.",
        ),
      )
    })

  /** What judging an index key needs of this entity; `allIndexes.primary` never changes. */
  const indexKeyJudging = (() => {
    let judging: KeyComposer.IndexKeyJudging | undefined
    return (): KeyComposer.IndexKeyJudging => {
      if (judging === undefined) {
        const primary = config.indexes.primary
        judging = {
          schema,
          entityType,
          entityVersion,
          forms: KeyText136.forms(schema),
          primaryComposites: new Set([...primary.pk.composite, ...primary.sk.composite]),
          stamped: new Set(
            [systemFields.createdAt, systemFields.updatedAt, systemFields.version].filter(
              (field): field is string => typeof field === "string",
            ),
          ),
          lagTolerated: systemFields.updatedAt,
        }
      }
      return judging
    }
  })()

  /**
   * A stored row's values as a `put` composed from them. A `put` is given a ref's id and stores the
   * ref (`team: { id, ... }`, no `teamId`), so it's read back from there, as `.within()` does.
   */
  const putValuesOf = (row: StoredRow): globalThis.Record<string, unknown> => {
    const values = toDomainView(fromAttributeMap(row) as globalThis.Record<string, unknown>)
    if (resolvedRefs.length === 0) return values
    const withIds = { ...values }
    for (const ref of resolvedRefs) {
      const id = (values[ref.fieldName] as globalThis.Record<string, unknown> | undefined)?.[
        ref.identifierField
      ]
      if (id !== undefined) withIds[ref.idFieldName] = id
    }
    return withIds
  }

  /** The stored attribute a composite is read from: a ref's id lives in the ref. */
  const compositeAttribute = (composite: string): string =>
    resolveDbName(resolvedRefs.find((ref) => ref.idFieldName === composite)?.fieldName ?? composite)

  type IndexKeyWork = {
    readonly sets: globalThis.Record<string, AttributeValue>
    readonly removes: ReadonlyArray<string>
    /** The stored attributes of the composites the keys written here are composed from. */
    readonly composites: ReadonlyArray<string>
    readonly found: Partial<Rekey.RekeyTally["indexKeys"]>
    /** Halves with no key that a `put` wouldn't be expected to have written: see the caller. */
    readonly keptAbsent: ReadonlyArray<string>
  }
  const NO_INDEX_KEY_WORK: IndexKeyWork = {
    sets: {},
    removes: [],
    composites: [],
    found: {},
    keptAbsent: [],
  }

  /**
   * Each index half of a live item against what its values compose (`KeyComposer.judgeIndexHalf`).
   * Reads nothing and writes nothing. A half in a table key attribute isn't judged: no write names
   * one, on any path. Halves sharing an attribute have one definition (`EDD-9106`), so it's judged
   * once.
   */
  const judgeIndexKeys = (row: StoredRow): IndexKeyWork => {
    let rowKeyForm: globalThis.Record<string, unknown>
    try {
      rowKeyForm = keyForm(putValuesOf(row))
    } catch {
      return NO_INDEX_KEY_WORK
    }
    const judging = indexKeyJudging()
    const sets: globalThis.Record<string, AttributeValue> = {}
    const removes: Array<string> = []
    const composites = new Set<string>()
    const found = { missing: 0, truncated: 0, lagging: 0, ambiguous: 0 }
    const keptAbsent: Array<string> = []
    const judged = new Set<string>()
    for (const [name, index] of Object.entries(allIndexes)) {
      if (name === "primary") continue
      for (const half of ["pk", "sk"] as const) {
        const { field, composite } = index[half]
        if (isTableKeyField(field) || judged.has(field)) continue
        judged.add(field)
        const attribute = row[field]
        const stored = attribute === undefined ? undefined : (attribute.S ?? attribute.B)
        if (attribute !== undefined && stored === undefined) continue
        const verdict = KeyComposer.judgeIndexHalf(judging, index, half, stored, rowKeyForm)
        if (verdict.kind === "fine") continue
        if (verdict.kind === "ambiguous") {
          found.ambiguous++
          keptAbsent.push(field)
          continue
        }
        if (verdict.kind === "remove") {
          found.lagging++
          removes.push(field)
        } else {
          found[verdict.drift]++
          sets[field] =
            typeof verdict.value === "string" ? { S: verdict.value } : { B: verdict.value }
        }
        for (const attr of composite) composites.add(compositeAttribute(attr))
        if (half === "pk") {
          for (const attr of index.shards?.source ?? []) composites.add(compositeAttribute(attr))
        }
      }
    }
    return { sets, removes, composites: [...composites], found, keptAbsent }
  }

  const indexKeyWorkSize = (work: IndexKeyWork): number =>
    Object.keys(work.sets).length + work.removes.length

  /**
   * The `UpdateItem` a repair sends for `work`, judged from `row`: guarded on each key it writes and
   * each composite they're composed from as read, or on their absence, so a writer changing any of
   * them wins (`rekey-repair.md`).
   */
  const repairRequest = (
    tableName: string,
    row: StoredRow,
    at: StoredKey,
    work: IndexKeyWork,
  ): UpdateItemCommandInput => {
    const names: globalThis.Record<string, string> = { "#pk": rekeyPk }
    const operands: globalThis.Record<string, AttributeValue> = {}
    const guards: Array<string> = ["attribute_exists(#pk)"]
    const guardAs = (name: string, operand: string, attribute: string) => {
      names[name] = attribute
      const read = row[attribute]
      if (read === undefined) {
        guards.push(`attribute_not_exists(${name})`)
      } else {
        operands[operand] = read
        guards.push(`${name} = ${operand}`)
      }
    }
    const sets: Array<string> = []
    for (const [i, [field, value]] of Object.entries(work.sets).entries()) {
      guardAs(`#k${i}`, `:o${i}`, field)
      operands[`:n${i}`] = value
      sets.push(`#k${i} = :n${i}`)
    }
    const removes: Array<string> = []
    for (const [i, field] of work.removes.entries()) {
      guardAs(`#r${i}`, `:r${i}`, field)
      removes.push(`#r${i}`)
    }
    for (const [i, attribute] of work.composites.entries()) {
      guardAs(`#c${i}`, `:c${i}`, attribute)
    }
    return {
      TableName: tableName,
      Key: toAttributeMap(at),
      UpdateExpression: [
        ...(sets.length > 0 ? [`SET ${sets.join(", ")}`] : []),
        ...(removes.length > 0 ? [`REMOVE ${removes.join(", ")}`] : []),
      ].join(" "),
      ConditionExpression: guards.join(" AND "),
      ExpressionAttributeNames: names,
      ...(Object.keys(operands).length > 0 && { ExpressionAttributeValues: operands }),
    }
  }

  /**
   * Count the index keys of a live item at its current table key that differ, once per run, and with
   * `repairIndexKeys` write them (`rekey-repair.md`). `row` holds what the run's text rewrite left.
   * A row with nothing to do costs nothing here, whatever the option says. `wrote` says the row was
   * acted on, so isn't `unchanged`.
   */
  const repairIndexKeys = (
    ctx: Rekey.RekeyRowContext,
    row: StoredRow,
    at: StoredKey,
  ): Effect.Effect<
    { readonly tally: Rekey.RekeyTally; readonly wrote: boolean },
    DynamoClientError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      if (!ctx.claim(`${entityType}\u0000indexKeys\u0000${at[rekeyPk]}\u0000${at[rekeySk]}`)) {
        return { tally: {}, wrote: false }
      }
      let work = judgeIndexKeys(row)
      const found = work.found
      if (!ctx.repairIndexKeys || indexKeyWorkSize(work) === 0) {
        return { tally: { indexKeys: found }, wrote: false }
      }
      if (ctx.dryRun) {
        return { tally: { indexKeys: { ...found, repaired: indexKeyWorkSize(work) } }, wrote: true }
      }
      const client = yield* Capacity.client
      let judged = row
      for (let attempt = 0; ; attempt++) {
        const request = repairRequest(ctx.tableName, judged, at, work)
        const outcome = yield* client.updateItem(request).pipe(
          Effect.as({ _tag: "Done" as const }),
          Effect.catch((err: DynamoClientError) =>
            isAwsConditionalCheckFailed(err.cause)
              ? Effect.succeed({ _tag: "Raced" as const })
              : Effect.fail(err),
          ),
          diagnoseItemWrite("rekey", {
            Update: request as NonNullable<TransactWriteItem["Update"]>,
          }),
          Effect.catchTag("ValidationError", (error) =>
            Effect.succeed({ _tag: "Refused" as const, error }),
          ),
        )
        if (outcome._tag === "Done") {
          return {
            tally: { indexKeys: { ...found, repaired: indexKeyWorkSize(work) } },
            wrote: true,
          }
        }
        if (outcome._tag === "Refused") {
          return {
            tally: Rekey.mergeTallies(
              { indexKeys: found },
              rekeyConflict(
                "item",
                "failed",
                at,
                at,
                String(outcome.error.cause ?? outcome.error.message),
              ),
            ),
            wrote: true,
          }
        }
        // A writer got there first: judge the item as it is now, and try once more.
        if (attempt > 0) {
          return {
            tally: { indexKeys: { ...found, skipped: indexKeyWorkSize(work) } },
            wrote: false,
          }
        }
        const { Item: fresh } = yield* client.getItem({
          TableName: ctx.tableName,
          Key: toAttributeMap(at),
          ConsistentRead: true,
        })
        const targets = fresh === undefined ? undefined : rowTargets(fresh)
        if (targets?.kind !== "item" || !sameStoredKey(targets.current, at)) {
          return { tally: { indexKeys: found }, wrote: false }
        }
        judged = fresh!
        work = judgeIndexKeys(judged)
        if (indexKeyWorkSize(work) === 0) return { tally: { indexKeys: found }, wrote: false }
      }
    })

  /**
   * What a move writes for `read` at its current key `current`: index keys recomposed as
   * an update would, so a half that can't compose keeps its text. Reads nothing and
   * writes nothing, so a dry run judges what the real run would leave. The table key is the one
   * `current` names, whatever an index half in one of its attributes composes.
   */
  const movedRowOf = (
    read: StoredRow,
    current: StoredKey,
    operation: string,
  ): Effect.Effect<StoredRow, ValidationError> =>
    Effect.gen(function* () {
      const rowKeyForm = keyForm(
        toDomainView(fromAttributeMap(read) as globalThis.Record<string, unknown>),
      )
      const gsi = yield* composeKeysOrFail(entityType, operation, () =>
        KeyComposer.composeGsiKeysForUpdatePolicyAware(
          schema,
          entityType,
          entityVersion,
          allIndexes,
          rowKeyForm,
          rowKeyForm,
          // A row that can't compute its shard keeps the key it has (#183).
          { onMissingShardSource: "keep" },
        ),
      )
      const moved: StoredRow = {
        ...read,
        ...toAttributeMap({ ...gsi.sets, ...current }),
      }
      for (const field of gsi.removes) {
        if (!isTableKeyField(field)) delete moved[field]
      }
      // A move recomposes as an update naming everything would, which writes a key the row went
      // without on purpose: it isn't damage (`rekey-repair.md`), so it stays that way.
      for (const field of judgeIndexKeys(read).keptAbsent) delete moved[field]
      for (const [, definition] of vectorIndexEntries) {
        if (read[definition.vectorField] === undefined) continue
        const partition = KeyComposer.tryComposeVectorPartition(
          schema,
          entityType,
          definition,
          rowKeyForm,
        )
        if (partition !== undefined) {
          moved[definition.partitionField] = toAttributeValue(partition)
        }
      }
      return moved
    })

  /**
   * Move an item: one transaction puts it at `to`, with its index keys recomposed, deletes it at
   * `from` while it is as read, and brings its unique sentinels along ({@link sentinelRekeys}).
   * A sentinel that can't come leaves the item where it is, in a dry run too.
   */
  const moveItem = (
    ctx: Rekey.RekeyRowContext,
    from: StoredKey,
    to: StoredKey,
    depth: number,
  ): Effect.Effect<Rekey.RekeyTally, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      let tally: Rekey.RekeyTally = {}
      for (let attempt = 0; attempt < GUARDED_PUT_ATTEMPTS; attempt++) {
        // The scan's read is eventually consistent, and a move this run made
        // since — another row's, making room — can have taken the item along:
        // act on a consistent read.
        const { Item: read } = yield* client.getItem({
          TableName: ctx.tableName,
          Key: toAttributeMap(from),
          ConsistentRead: true,
        })
        const targets = read === undefined ? undefined : rowTargets(read)
        if (targets?.kind !== "item" || !sameStoredKey(targets.current, to)) {
          return Rekey.mergeTallies(tally, yield* movedAway(ctx, to))
        }
        const room = yield* clearTarget(ctx, "item", from, to, depth, undefined, targets.elsewhere)
        tally = Rekey.mergeTallies(tally, room.tally)
        if (!room.cleared) return tally
        const values = toDomainView(fromAttributeMap(read!) as globalThis.Record<string, unknown>)
        const sentinels = yield* sentinelRekeys(
          ctx,
          "item",
          values,
          read!,
          (key) => sameStoredKey(key, from),
          to,
          depth,
          true,
        )
        tally = Rekey.mergeTallies(tally, sentinels.tally)
        if ((sentinels.tally.conflicts ?? []).length > 0) return tally
        const failed = (error: ValidationError) =>
          Rekey.mergeTallies(
            tally,
            rekeyConflict("item", "failed", from, to, String(error.cause ?? error.message)),
          )
        const moved = yield* movedRowOf(read!, to, "rekey").pipe(
          Effect.map((row) => ({ _tag: "Moved" as const, row })),
          Effect.catchTag("ValidationError", (error) =>
            Effect.succeed({ _tag: "Failed" as const, error }),
          ),
        )
        if (moved._tag === "Failed") return failed(moved.error)
        if (ctx.dryRun) {
          // The real run goes on to rewrite or report what the move leaves on the row.
          const left = staleIndexKeys(moved.row)
          const repair = yield* repairIndexKeys(ctx, { ...moved.row, ...left.sets }, to)
          return Rekey.mergeTallies(
            countMove(ctx, "item", to, tally),
            { sentinelsMoved: sentinels.moved },
            Object.keys(left.sets).length === 0 ? {} : { indexKeysRewritten: 1 },
            heldBackIndexKeys(to, left.uncomposable),
            repair.tally,
          )
        }
        const guard = deleteGuard(read!, "item", undefined)
        const items: ReadonlyArray<TransactWriteItem> = [
          {
            Put: {
              TableName: ctx.tableName,
              Item: moved.row,
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": rekeyPk },
            },
          },
          {
            Delete: {
              TableName: ctx.tableName,
              Key: toAttributeMap(from),
              ConditionExpression: guard.expression,
              ExpressionAttributeNames: guard.names,
              ...(Object.keys(guard.values).length > 0 && {
                ExpressionAttributeValues: guard.values,
              }),
            },
          },
          ...sentinels.items,
        ]
        const done = yield* client.transactWriteItems({ TransactItems: [...items] }).pipe(
          Effect.as({ _tag: "Done" as const }),
          Effect.catch((err: DynamoClientError) =>
            isAwsTransactionCancelled(err.cause)
              ? Effect.succeed({ _tag: "Raced" as const })
              : Effect.fail(err),
          ),
          diagnoseTransactionWrite("rekey", items),
          // A move is a few items: never over 100, short of ~50 unique constraints.
          Effect.catchTag("TransactionOverflow", (cause) =>
            Effect.fail(new ValidationError({ entityType, operation: "rekey", cause })),
          ),
          Effect.catchTag("ValidationError", (error) =>
            Effect.succeed({ _tag: "Failed" as const, error }),
          ),
        )
        if (done._tag === "Failed") return failed(done.error)
        if (done._tag === "Done") {
          return Rekey.mergeTallies(countMove(ctx, "item", to, tally), {
            sentinelsMoved: sentinels.moved,
          })
        }
        // Something changed between the reads and the write: judge it again.
      }
      return Rekey.mergeTallies(
        tally,
        rekeyConflict(
          "item",
          "contended",
          from,
          to,
          "Concurrent writes changed it on every attempt.",
        ),
      )
    })

  /**
   * The index keys and vector partitions of an item under its current table key that `rekey`
   * rewrites (design §9.2). It compares a stored key with what each key text composes from the
   * row's values, and never reads a value out of a stored key.
   *
   * An unsharded partition key, a sort key, a Z-order sort key or a vector partition is rewritten
   * only when it is exactly its text under some form, and that isn't the current text: the text of
   * the row's values, or of them with a numeric composite as the other kind ({@link kindReading}),
   * looked for only behind a key that isn't its current text. Each half
   * is judged by itself and by its bytes: halves in one attribute have the same definition
   * (`EDD-9106`), so none can be another's other text. A sort key missing a trailing composite is
   * judged by the composites before the gap, which is what a row truncated under 1.36 stores.
   * Anything else is left, with no conflict: a key an index policy kept, one lagging its values,
   * one cleared of them. So is a key that isn't stored (under `sparse` its absence can be
   * deliberate), and a table key attribute: no part of the primary key is ever set, on any write
   * path (`DESIGN.md §7`). A writer changing a composite under this read can make that attribute
   * look like its own other text, and DynamoDB refuses an update naming it.
   *
   * A sharded index's partition key is the exception: moving rows into the layout is the feature,
   * so it is composed and compared whatever it holds, and `EDD-9106` means no half that composes
   * differently shares its attribute. One whose values can't compose it is left too, and reported
   * unless it is already in the current layout.
   */
  const staleIndexKeys = (row: StoredRow) => {
    const values = toDomainView(fromAttributeMap(row) as globalThis.Record<string, unknown>)
    const rowKeyForm = keyForm(values)
    // The texts a key may be stored under: each form's, from the key form and from 1.39.0's.
    const rowKeyFormsThen = rowKeyForms(values)
    const composing = <A>(compose: () => A | undefined): A | undefined => {
      try {
        return compose()
      } catch {
        // Its values compose no key now: left as stored.
        return undefined
      }
    }
    const sets: globalThis.Record<string, AttributeValue> = {}
    const olds: globalThis.Record<string, AttributeValue> = {}
    const composites = new Set<string>()
    const rewrite = (field: string, value: AttributeValue, attrs: ReadonlyArray<string>) => {
      if (isTableKeyField(field)) return
      sets[field] = value
      olds[field] = row[field]!
      for (const attr of attrs) composites.add(resolveDbName(attr))
    }
    const forms = KeyText136.forms(schema)
    /**
     * Is `stored` what some reading of the row's values composes under some form: the values in
     * the key form or in 1.39.0's ({@link rowKeyForms}), or either with some of `fields` as the
     * other numeric kind ({@link kindReading})?
     */
    const composedUnder = (
      fields: ReadonlyArray<string>,
      under: (
        form: KeyText136.KeyForm,
        record: globalThis.Record<string, unknown>,
      ) => string | undefined,
      stored: string,
    ) =>
      rowKeyFormsThen.some((reading) =>
        forms.some(
          (form) =>
            kindReading(row, reading, fields, (record) => under(form, record), stored) !==
            undefined,
        ),
      )
    const consider = (
      field: string,
      attrs: ReadonlyArray<string>,
      now: () => string | undefined,
      under: (
        form: KeyText136.KeyForm,
        record: globalThis.Record<string, unknown>,
      ) => string | undefined,
    ) => {
      const stored = row[field]?.S
      if (stored === undefined) return
      // Its current text, which no other text is looked for behind: nothing to rewrite.
      const text = composing(now)
      if (text === undefined || text === stored) return
      if (composedUnder(attrs, under, stored)) rewrite(field, { S: text }, attrs)
    }
    const sameBytes = (a: Uint8Array, b: Uint8Array | undefined) =>
      b !== undefined && a.length === b.length && a.every((byte, i) => byte === b[i])
    const uncomposable: Array<string> = []
    for (const [name, index] of Object.entries(allIndexes)) {
      if (name === "primary") continue
      if (index.shards !== undefined) {
        const stored = row[index.pk.field]?.S
        if (stored !== undefined) {
          const text = composing(() =>
            KeyComposer.composeStoredPk(schema, entityType, index, rowKeyForm),
          )
          if (text === undefined) {
            if (!KeyComposer.isCurrentShardLayout(schema, entityType, index, stored)) {
              uncomposable.push(name)
            }
          } else if (text !== stored) {
            rewrite(index.pk.field, { S: text }, [...index.pk.composite, ...index.shards.source!])
          }
        }
      } else {
        consider(
          index.pk.field,
          index.pk.composite,
          () => KeyComposer.composePk(schema, entityType, index, rowKeyForm),
          (form, kindKeyForm) => KeyComposer.composePk(form.pk, entityType, index, kindKeyForm),
        )
      }
      if (KeyComposer.isZOrderHalf(index.sk)) {
        // An address holds no text, its prefix segments do.
        const stored = row[index.sk.field]?.B
        if (stored === undefined) continue
        const bytes = composing(() => KeyComposer.composeZOrderSk(schema, index, rowKeyForm))
        if (bytes === undefined || sameBytes(bytes, stored)) continue
        const known = composedUnder(
          index.sk.zorderHalf.prefix.map((segment) => segment.field),
          (form, kindKeyForm) =>
            bytesText(KeyComposer.composeZOrderSk(form.sk, index, kindKeyForm)),
          bytesText(stored),
        )
        if (known) rewrite(index.sk.field, { B: bytes }, index.sk.composite)
        continue
      }
      consider(
        index.sk.field,
        index.sk.composite,
        () =>
          KeyComposer.composeSortKeyPrefix(schema, entityType, entityVersion, index, rowKeyForm),
        (form, kindKeyForm) =>
          KeyComposer.composeSortKeyPrefix(form.sk, entityType, entityVersion, index, kindKeyForm),
      )
    }
    for (const [, definition] of vectorIndexEntries) {
      consider(
        definition.partitionField,
        definition.partition,
        () => KeyComposer.tryComposeVectorPartition(schema, entityType, definition, rowKeyForm),
        (form, kindKeyForm) =>
          KeyComposer.tryComposeVectorPartition(form.pk, entityType, definition, kindKeyForm),
      )
    }
    return { sets, olds, composites: [...composites], uncomposable }
  }

  /** The conflict for the sharded indexes a row's values can't compose a key for. */
  const heldBackIndexKeys = (
    at: StoredKey,
    uncomposable: ReadonlyArray<string>,
  ): Rekey.RekeyTally =>
    uncomposable.length === 0
      ? {}
      : rekeyConflict(
          "item",
          "uncomposable",
          at,
          at,
          `Its values no longer compose a key for sharded ${
            uncomposable.length === 1 ? "index" : "indexes"
          } ${uncomposable.map((name) => `"${name}"`).join(", ")}, and its stored key is ` +
            `from another layout.`,
        )

  /**
   * An item under its current table key: rewrite the index keys {@link staleIndexKeys}
   * names, in place — `UpdateItem` conditioned on each still holding what was read and
   * the composites they are composed from unchanged — and move its unique sentinels
   * whose text changed.
   */
  const rekeyCurrentItem = (
    ctx: Rekey.RekeyRowContext,
    scanned: StoredRow,
    at: StoredKey,
    depth: number,
  ): Effect.Effect<Rekey.RekeyTally, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      let row = scanned
      let rewritten = false
      let uncomposable: ReadonlyArray<string> = []
      // What the text rewrite leaves on the row, for judging what's left of its index keys.
      let left = scanned
      for (let attempt = 0; ; attempt++) {
        const stale = staleIndexKeys(row)
        uncomposable = stale.uncomposable
        left = { ...row, ...stale.sets }
        const fields = Object.keys(stale.sets)
        if (fields.length === 0) break
        if (ctx.dryRun) {
          rewritten = true
          break
        }
        if (attempt >= GUARDED_PUT_ATTEMPTS) {
          return rekeyConflict(
            "item",
            "contended",
            at,
            at,
            "Concurrent writes changed its index keys on every attempt.",
          )
        }
        const names: globalThis.Record<string, string> = { "#pk": rekeyPk }
        const operands: globalThis.Record<string, AttributeValue> = {}
        const sets: Array<string> = []
        const guards: Array<string> = ["attribute_exists(#pk)"]
        for (const [i, field] of fields.entries()) {
          names[`#k${i}`] = field
          operands[`:n${i}`] = stale.sets[field]!
          operands[`:o${i}`] = stale.olds[field]!
          sets.push(`#k${i} = :n${i}`)
          guards.push(`#k${i} = :o${i}`)
        }
        for (const [i, attr] of stale.composites.entries()) {
          // A composite the row lacks (the gap of a truncated sort key) or one derived
          // from another attribute isn't stored: the key's text is what the guard holds on.
          if (row[attr] === undefined) continue
          names[`#c${i}`] = attr
          operands[`:c${i}`] = row[attr]!
          guards.push(`#c${i} = :c${i}`)
        }
        const updated = yield* client
          .updateItem({
            TableName: ctx.tableName,
            Key: toAttributeMap(at),
            UpdateExpression: `SET ${sets.join(", ")}`,
            ConditionExpression: guards.join(" AND "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: operands,
          })
          .pipe(
            Effect.as(true),
            Effect.catch((err: DynamoClientError) =>
              isAwsConditionalCheckFailed(err.cause) ? Effect.succeed(false) : Effect.fail(err),
            ),
          )
        if (updated) {
          rewritten = true
          break
        }
        // Written in between: judge the item as it is now.
        const { Item: fresh } = yield* client.getItem({
          TableName: ctx.tableName,
          Key: toAttributeMap(at),
          ConsistentRead: true,
        })
        if (fresh === undefined) return {}
        row = fresh
      }
      const repair = yield* repairIndexKeys(ctx, left, at)
      const sentinels = yield* rekeySentinels(
        ctx,
        "item",
        row,
        (key) => sameStoredKey(key, at),
        at,
        depth,
        false,
      )
      const refused = heldBackIndexKeys(at, uncomposable)
      return Rekey.mergeTallies(
        rewritten ||
          repair.wrote ||
          (refused.conflicts ?? []).length > 0 ||
          (sentinels.sentinelsMoved ?? 0) > 0 ||
          (sentinels.conflicts ?? []).length > 0
          ? {}
          : { unchanged: 1 },
        rewritten ? { indexKeysRewritten: 1 } : {},
        repair.tally,
        sentinels,
        refused,
      )
    })

  /**
   * What a move left on an item (#183): it recomposes index keys as an update would, so a
   * half that can't compose (a sort key truncated under 1.36 before a gap that a later
   * composite fills) keeps its text. A later run would rewrite or report what it can; this
   * one does, so a second run has nothing to add. It reads the item only when the move, as
   * predicted from the scanned row ({@link movedRowOf}), leaves such a half.
   */
  const rekeyAfterMove = (
    ctx: Rekey.RekeyRowContext,
    scanned: StoredRow,
    at: StoredKey,
    depth: number,
  ): Effect.Effect<Rekey.RekeyTally, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const predicted = yield* movedRowOf(scanned, at, "rekey").pipe(
        Effect.catchTag("ValidationError", () => Effect.succeed(undefined)),
      )
      if (predicted === undefined) return {}
      const stale = staleIndexKeys(predicted)
      if (Object.keys(stale.sets).length === 0 && stale.uncomposable.length === 0) {
        // Judged from what the move wrote, with no read: a repair is conditioned on what's judged,
        // so a prediction that's wrong fails its condition, and the item is read then.
        return (yield* repairIndexKeys(ctx, predicted, at)).tally
      }
      const client = yield* Capacity.client
      const { Item: moved } = yield* client.getItem({
        TableName: ctx.tableName,
        Key: toAttributeMap(at),
        ConsistentRead: true,
      })
      // Gone, or another row's: the scan judges that one where it finds it.
      if (moved === undefined || occupantOf(moved, at) !== "same") return {}
      const { unchanged: _unchanged, ...tally } = yield* rekeyCurrentItem(ctx, moved, at, depth)
      return tally
    })

  const NO_SENTINEL_REKEYS: {
    readonly items: ReadonlyArray<TransactWriteItem>
    readonly count: number
    readonly moved: number
    readonly tally: Rekey.RekeyTally
  } = { items: [], count: 0, moved: 0, tally: {} }

  /**
   * A unique sentinel's key under `under`; `undefined` when the values have none there. A field in
   * `asOther` is composed as given, not lifted to its kind ({@link kindReading}).
   */
  const sentinelKeyUnder = (
    under: DynamoSchema.DynamoSchema,
    constraintName: string,
    constraintDef: UniqueConstraintDef,
    source: globalThis.Record<string, unknown>,
    asOther: ReadonlySet<string> = new Set(),
  ) => {
    try {
      return composeUniqueSentinel(
        under,
        entityType,
        constraintName,
        constraintDef,
        source,
        (field, value) => (asOther.has(field) ? undefined : readSentinelValue(field, value)),
      )?.key
    } catch {
      return undefined
    }
  }
  /** Each of a unique constraint's values as its field's kind, which the other kind is the other of. */
  const liftedSentinelValues = (
    constraintDef: UniqueConstraintDef,
    source: globalThis.Record<string, unknown>,
  ) => {
    const lifted = { ...source }
    for (const field of resolveUniqueFields(constraintDef)) {
      const value = readSentinelValue(field, source[field])
      if (value !== undefined) lifted[field] = value
    }
    return lifted
  }

  /** The sentinel texts a unique sentinel's key is looked for under: each setting's. */
  const sentinelTexts = (): ReadonlyArray<DynamoSchema.DynamoSchema> => [
    KeyText136.schema136(schema),
    KeyText136.schema137(schema),
    KeyText136.schemaEscaped(schema),
  ]

  /**
   * The reading of a row's values its own stored key was composed from ({@link kindReading}):
   * which numeric composites it gives as the other kind. `undefined` when no reading under any
   * form composes it.
   */
  const storedKeyReading = (row: StoredRow) => {
    const stored = storedKeyOf(row)
    if (stored === undefined) return undefined
    const values = toDomainView(fromAttributeMap(row) as globalThis.Record<string, unknown>)
    const rowKeyForm = keyForm(values)
    const history = historyLayout(stored[rekeySk]!, values, rowKeyForm)
    for (const form of keyFormsOf()) {
      for (const [at, fields] of [
        [(key: StoredKey) => key, primaryTextFields],
        ...(history === undefined
          ? []
          : [
              [
                (key: StoredKey, record: globalThis.Record<string, unknown>) =>
                  history.at(form, key, record),
                history.fields,
              ] as const,
            ]),
      ] as const) {
        const reading = kindReading(
          row,
          rowKeyForm,
          fields,
          // A reading of the row's key form: each numeric field read as the kind it composes.
          (kindKeyForm) => {
            const placedAt = at(
              KeyText136.composeAt(
                form,
                entityType,
                entityVersion,
                config.indexes.primary,
                kindKeyForm,
              ) as StoredKey,
              kindKeyForm,
            )
            return keySegments(placedAt[rekeyPk], placedAt[rekeySk])
          },
          storedKeyText(stored),
        )
        if (reading !== undefined) return reading
      }
    }
    return undefined
  }

  /** A unique sentinel's key, as `composeUniqueSentinel` gives it. */
  type SentinelKey = { readonly pk: string; readonly sk: string }
  const sameSentinelKey = (a: SentinelKey, b: SentinelKey) => a.pk === b.pk && a.sk === b.sk

  /**
   * The keys a unique sentinel of `source`'s values, read from `row`, can be stored under, other
   * than `current`: under each text, and with `otherKinds`, with some numeric values as the other
   * kind. A moving row's sentinel is looked for there, before anything has a key to compare.
   * `first` reads the values as they are, as `row`'s own key gives them, each alone as the other
   * kind, and all of them, which is every reading of a constraint over one or two numeric fields.
   * `mixes` gives every other reading, fewest values as the other kind first: looked at only when
   * no key of `first`, and not the current key, holds a sentinel, since a moving row's sentinel
   * names its old key and is moved by nothing else.
   */
  const otherSentinelKeys = (
    constraintName: string,
    constraintDef: UniqueConstraintDef,
    source: globalThis.Record<string, unknown>,
    row: StoredRow,
    current: SentinelKey | undefined,
    otherKinds: boolean,
  ): {
    readonly first: ReadonlyArray<SentinelKey>
    readonly mixes: () => ReadonlyArray<SentinelKey>
  } => {
    const lifted = liftedSentinelValues(constraintDef, source)
    const digits = (field: string) => row[resolveDbName(field)]?.N
    const fields = otherKinds
      ? resolveUniqueFields(constraintDef).filter(
          (field) => otherNumericKind(lifted[field], digits(field)) !== undefined,
        )
      : []
    const readings: Array<ReadonlySet<string>> = [new Set()]
    if (otherKinds) {
      const keyed = storedKeyReading(row)?.asOther
      if (keyed !== undefined) readings.push(new Set(fields.filter((field) => keyed.has(field))))
      for (const field of fields) readings.push(new Set([field]))
      readings.push(new Set(fields))
    }
    const seen = new Set<string>(current === undefined ? [] : [`${current.pk}\u0000${current.sk}`])
    const keysOf = (mixes: ReadonlyArray<ReadonlySet<string>>) => {
      const keys: Array<SentinelKey> = []
      for (const under of sentinelTexts()) {
        for (const asOther of mixes) {
          const record = { ...lifted }
          for (const field of asOther)
            record[field] = otherNumericKind(lifted[field], digits(field))
          const key = sentinelKeyUnder(under, constraintName, constraintDef, record, asOther)
          if (key === undefined || seen.has(`${key.pk}\u0000${key.sk}`)) continue
          seen.add(`${key.pk}\u0000${key.sk}`)
          keys.push(key)
        }
      }
      return keys
    }
    const first = keysOf(readings)
    const mixes = () => {
      const named = new Set(readings.map((asOther) => [...asOther].sort().join("\u0000")))
      const others: Array<ReadonlySet<string>> = []
      for (let mask = 1; mask < 2 ** fields.length; mask++) {
        const asOther = new Set(fields.filter((_, i) => (mask & (1 << i)) !== 0))
        if (!named.has([...asOther].sort().join("\u0000"))) others.push(asOther)
      }
      return keysOf(others.sort((a, b) => a.size - b.size))
    }
    return { first, mixes }
  }

  /**
   * Is `key` where a unique sentinel of `source`'s values, read from `row`, is stored: under the
   * current text or another, and with `otherKinds`, with some numeric values as the other kind,
   * found from the key itself ({@link kindReading}).
   */
  const sentinelHeldAt = (
    constraintName: string,
    constraintDef: UniqueConstraintDef,
    source: globalThis.Record<string, unknown>,
    row: StoredRow,
    key: { readonly pk: string; readonly sk: string },
    otherKinds: boolean,
  ): boolean => {
    const lifted = liftedSentinelValues(constraintDef, source)
    const fields = otherKinds ? resolveUniqueFields(constraintDef) : []
    const text = JSON.stringify([key.pk, key.sk])
    return [schema, ...sentinelTexts()].some(
      (under) =>
        kindReading(
          row,
          lifted,
          fields,
          (record, asOther) => {
            const at = sentinelKeyUnder(under, constraintName, constraintDef, record, asOther)
            return at === undefined ? undefined : keySegments(at.pk, at.sk)
          },
          text,
        ) !== undefined,
    )
  }

  /** The row a sentinel's back-pointer names: the item, or a tombstone keeping its reservation. */
  const sentinelOwnerRow = (tableName: string, sentinel: StoredRow) =>
    Effect.gen(function* () {
      const pk = sentinel._entity_pk?.S
      const sk = sentinel._entity_sk?.S
      if (pk === undefined || sk === undefined) return undefined
      const client = yield* Capacity.client
      const { Item: item } = yield* client.getItem({
        TableName: tableName,
        Key: toAttributeMap(keyAt(pk, sk)),
        ConsistentRead: true,
      })
      return item ?? (yield* latestTombstone(tableName, pk, sk))
    })

  /**
   * The writes that bring the unique sentinels of `values` to their current keys, naming `to`,
   * from consistent reads: a sentinel naming a key `owns` holds under other key text is put under
   * its current key and released under the old one; one under its current key naming another key
   * `owns` holds is re-pointed to `to`. Each write is conditioned on the sentinel as read. An
   * item owns its own key; a tombstone (`preserveUnique`) the item's live keys under every text —
   * the sentinels name the item, not the tombstone.
   *
   * A sentinel's current key can hold another value's sentinel under other key text: the row it
   * names moves first, with its sentinel. Its current key held by anything else is a conflict and
   * the sentinel is left as it is, as is one whose values compose no key now. `count` is the
   * sentinels written, `moved` those whose text changed.
   */
  const sentinelRekeys = (
    ctx: Rekey.RekeyRowContext,
    kind: RowKind,
    values: globalThis.Record<string, unknown>,
    /** The row `values` were read from. */
    row: StoredRow,
    /** Is a key a sentinel names one of its owners'? */
    owns: (key: StoredKey) => boolean,
    to: StoredKey,
    depth: number,
    /**
     * Look under the other numeric kind's text too ({@link otherSentinelKeys}). A moving row's
     * sentinels are looked for there, since they name its old key: under the first readings, then,
     * when none of them nor the current key holds one, under every other mix. One under its current
     * key leaves it to the scan to find one there ({@link rekeySentinelRow}): each read it costs is
     * a read of every item, on every run.
     */
    otherKinds: boolean,
    /** A sentinel the scan reached, which names the row: looked at first, for its constraint. */
    scanned?: { readonly constraintName: string; readonly key: SentinelKey } | undefined,
  ) =>
    Effect.gen(function* () {
      if (config.unique === undefined) return NO_SENTINEL_REKEYS
      const client = yield* Capacity.client
      const readAt = (key: { readonly pk: string; readonly sk: string }) =>
        Effect.map(
          client.getItem({
            TableName: ctx.tableName,
            Key: toAttributeMap(sentinelKeyRecord(key)),
            ConsistentRead: true,
          }),
          (result) => result.Item,
        )
      const ownerIn = (held: StoredRow | undefined): StoredKey | undefined => {
        const pk = held?._entity_pk?.S
        const sk = held?._entity_sk?.S
        if (pk === undefined || sk === undefined) return undefined
        const named = keyAt(pk, sk)
        return owns(named) ? named : undefined
      }
      const items: Array<TransactWriteItem> = []
      let count = 0
      let moved = 0
      let tally: Rekey.RekeyTally = {}
      const refused = (
        reason: "bothKeys" | "taken" | "contended",
        constraintName: string,
        old: { readonly pk: string; readonly sk: string },
        current: { readonly pk: string; readonly sk: string },
        says: string,
      ) => {
        tally = Rekey.mergeTallies(
          tally,
          rekeyConflict(
            kind,
            reason,
            sentinelKeyRecord(old),
            sentinelKeyRecord(current),
            `Unique constraint "${constraintName}": ${says}`,
          ),
        )
      }
      for (const [constraintName, constraintDef] of Object.entries(
        config.unique as globalThis.Record<string, UniqueConstraintDef>,
      )) {
        const now = (() => {
          try {
            return {
              key: composeUniqueSentinel(
                schema,
                entityType,
                constraintName,
                constraintDef,
                values,
                readSentinelValue,
              )?.key,
            }
          } catch {
            return undefined
          }
        })()
        if (now === undefined) {
          tally = Rekey.mergeTallies(
            tally,
            rekeyConflict(
              kind,
              "uncomposable",
              to,
              to,
              `Unique constraint "${constraintName}": its values compose no sentinel key now.`,
            ),
          )
          continue
        }
        const current = now.key
        if (current === undefined) continue
        const heldNow = yield* readAt(current)
        let found:
          | {
              readonly key: { readonly pk: string; readonly sk: string }
              readonly held: StoredRow
              readonly owner: StoredKey
            }
          | undefined
        const keys = otherSentinelKeys(
          constraintName,
          constraintDef,
          values,
          row,
          current,
          otherKinds,
        )
        const at =
          scanned?.constraintName === constraintName && !sameSentinelKey(scanned.key, current)
            ? [scanned.key]
            : []
        const lookAt = (
          among: ReadonlyArray<SentinelKey>,
        ): Effect.Effect<typeof found, DynamoClientError> =>
          Effect.gen(function* () {
            for (const key of among) {
              const held = yield* readAt(key)
              const owner = ownerIn(held)
              if (held !== undefined && owner !== undefined) return { key, held, owner }
            }
            return undefined
          })
        found = yield* lookAt([
          ...at,
          ...keys.first.filter((key) => !at.some((one) => sameSentinelKey(one, key))),
        ])
        // Under no reading looked at, and none under its current key: the sentinel of a moving row
        // is moved by nothing else, so every mix of kinds is looked at.
        if (found === undefined && heldNow === undefined && otherKinds) {
          found = yield* lookAt(
            keys.mixes().filter((key) => !at.some((one) => sameSentinelKey(one, key))),
          )
        }
        if (found !== undefined) {
          if (heldNow !== undefined) {
            if (ownerIn(heldNow) !== undefined) {
              refused(
                "bothKeys",
                constraintName,
                found.key,
                current,
                "its sentinel's current key is also held by the item.",
              )
              continue
            }
            // Another value's sentinel under other key text moves out first, with its row.
            const holder = yield* sentinelOwnerRow(ctx.tableName, heldNow)
            const holderNow =
              holder === undefined
                ? undefined
                : sentinelKeyUnder(
                    schema,
                    constraintName,
                    constraintDef,
                    toDomainView(fromAttributeMap(holder) as globalThis.Record<string, unknown>),
                  )
            const stale =
              holderNow !== undefined &&
              (holderNow.pk !== current.pk || holderNow.sk !== current.sk)
            if (!stale) {
              refused(
                "taken",
                constraintName,
                found.key,
                current,
                "its sentinel's current key is held by another item.",
              )
              continue
            }
            if (depth >= Rekey.DISPLACE_DEPTH) {
              refused(
                "contended",
                constraintName,
                found.key,
                current,
                "too many sentinels under other key text hold each other's current keys.",
              )
              continue
            }
            const displaced = yield* Rekey.displace(ctx, (under) =>
              rekeyRow(holder!, under, depth + 1),
            )
            tally = Rekey.mergeTallies(tally, displaced)
            // A dry run moved nothing: what would stop the holder is what would leave it there.
            const stillHeld = ctx.dryRun
              ? (displaced.conflicts ?? []).length > 0
              : (yield* readAt(current)) !== undefined
            if (stillHeld) {
              refused(
                "taken",
                constraintName,
                found.key,
                current,
                "its sentinel's current key is held by another item.",
              )
              continue
            }
          }
          items.push(
            {
              Put: {
                TableName: ctx.tableName,
                Item: {
                  ...found.held,
                  ...toAttributeMap({
                    ...sentinelKeyRecord(current),
                    _entity_pk: to[rekeyPk],
                    _entity_sk: to[rekeySk],
                  }),
                },
                ...sentinelGuard(),
              },
            },
            sentinelRelease(ctx.tableName, found.key, ownerOf(found.owner)),
          )
          count++
          moved++
          continue
        }
        const ownerNow = ownerIn(heldNow)
        if (ownerNow !== undefined && !sameStoredKey(ownerNow, to)) {
          items.push({
            Update: {
              TableName: ctx.tableName,
              Key: toAttributeMap(sentinelKeyRecord(current)),
              UpdateExpression: "SET #epk = :npk, #esk = :nsk",
              ConditionExpression: "#epk = :epk AND #esk = :esk",
              ExpressionAttributeNames: { "#epk": "_entity_pk", "#esk": "_entity_sk" },
              ExpressionAttributeValues: toAttributeMap({
                ":epk": ownerNow[rekeyPk],
                ":esk": ownerNow[rekeySk],
                ":npk": to[rekeyPk],
                ":nsk": to[rekeySk],
              }),
            },
          })
          count++
        }
      }
      return { items, count, moved, tally }
    })

  /**
   * The unique sentinels of a row under its current key that still hold other key text or name
   * another key — an item's, or a tombstone's — brought to their current keys in one transaction
   * ({@link sentinelRekeys}), read again when a write changed one in between.
   */
  const rekeySentinels = (
    ctx: Rekey.RekeyRowContext,
    kind: RowKind,
    row: StoredRow,
    owns: (key: StoredKey) => boolean,
    to: StoredKey,
    depth: number,
    otherKinds: boolean,
    scanned?: { readonly constraintName: string; readonly key: SentinelKey } | undefined,
  ): Effect.Effect<Rekey.RekeyTally, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      if (config.unique === undefined) return {}
      const client = yield* Capacity.client
      const values = toDomainView(fromAttributeMap(row) as globalThis.Record<string, unknown>)
      for (let attempt = 0; attempt < GUARDED_PUT_ATTEMPTS; attempt++) {
        const planned = yield* sentinelRekeys(
          ctx,
          kind,
          values,
          row,
          owns,
          to,
          depth,
          otherKinds,
          scanned,
        )
        const moved = planned.count > 0 ? { sentinelsMoved: planned.count } : {}
        if (planned.items.length === 0 || ctx.dryRun) {
          return Rekey.mergeTallies(planned.tally, moved)
        }
        const done = yield* client.transactWriteItems({ TransactItems: [...planned.items] }).pipe(
          Effect.as(true),
          Effect.catch((err: DynamoClientError) =>
            isAwsTransactionCancelled(err.cause) ? Effect.succeed(false) : Effect.fail(err),
          ),
        )
        if (done) return Rekey.mergeTallies(planned.tally, moved)
        // A sentinel changed between the read and the write: read again.
      }
      return rekeyConflict(
        kind,
        "contended",
        to,
        to,
        "Its unique sentinels changed while they were moved, on every attempt.",
      )
    })

  /**
   * A scanned unique sentinel. It holds no values and moves with the row it names, so it is
   * counted only when no row will: its row is gone (and no tombstone keeps the reservation), or
   * that row's values compose no such sentinel under any key text. Read again first, since a move
   * of its row takes it along.
   */
  const rekeySentinelRow = (
    row: StoredRow,
    ctx: Rekey.RekeyRowContext,
  ): Effect.Effect<Rekey.RekeyTally, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const constraintName = (row.__edd_e__?.S ?? "").slice(`${entityType}._unique.`.length)
      const constraintDef = (
        config.unique as globalThis.Record<string, UniqueConstraintDef> | undefined
      )?.[constraintName]
      const at = storedKeyOf(row)
      if (at === undefined) return { skipped: { unrecognizedKey: 1 } }
      const keyOf = (sentinel: StoredRow): SentinelKey => {
        const stored = storedKeyOf(sentinel)!
        return { pk: stored[rekeyPk]!, sk: stored[rekeySk]! }
      }
      const named = (sentinel: StoredRow, owner: StoredRow, otherKinds: boolean) => {
        if (constraintDef === undefined) return false
        const values = toDomainView(fromAttributeMap(owner) as globalThis.Record<string, unknown>)
        return sentinelHeldAt(
          constraintName,
          constraintDef,
          values,
          owner,
          keyOf(sentinel),
          otherKinds,
        )
      }
      // Its owner's own pass moves it, except from under the other numeric kind's text, which an
      // owner under its current key doesn't look under: this one moves it from there, from the key
      // the scan found it at, whatever mix of kinds that is.
      const judge = (sentinel: StoredRow, owner: StoredRow | undefined) =>
        owner === undefined
          ? Effect.succeed(undefined)
          : named(sentinel, owner, false)
            ? Effect.succeed({})
            : named(sentinel, owner, true)
              ? sentinelsUnderOtherKind(ctx, owner, { constraintName, key: keyOf(sentinel) })
              : Effect.succeed(undefined)
      const judged = yield* judge(row, yield* sentinelOwnerRow(ctx.tableName, row))
      if (judged !== undefined) return judged
      const client = yield* Capacity.client
      const { Item: fresh } = yield* client.getItem({
        TableName: ctx.tableName,
        Key: toAttributeMap(at),
        ConsistentRead: true,
      })
      if (fresh === undefined) return {}
      return (
        (yield* judge(fresh, yield* sentinelOwnerRow(ctx.tableName, fresh))) ?? {
          skipped: { unrecognizedKey: 1 },
        }
      )
    })

  /**
   * The sentinels of `owner`, a row under its current key, brought from under the other numeric
   * kind's text ({@link sentinelHeldAt}), `scanned` the one the scan found. A row under an old key
   * moves them itself when it moves.
   */
  const sentinelsUnderOtherKind = (
    ctx: Rekey.RekeyRowContext,
    owner: StoredRow,
    scanned: { readonly constraintName: string; readonly key: SentinelKey },
  ): Effect.Effect<Rekey.RekeyTally, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const targets = rowTargets(owner)
      const ownerAt = storedKeyOf(owner)
      if (targets === undefined || ownerAt === undefined) return {}
      if (!sameStoredKey(ownerAt, targets.current)) return {}
      return targets.kind === "tombstone"
        ? yield* rekeySentinels(
            ctx,
            "tombstone",
            owner,
            targets.isLive,
            targets.live,
            0,
            true,
            scanned,
          )
        : yield* rekeySentinels(
            ctx,
            "item",
            owner,
            (key) => sameStoredKey(key, ownerAt),
            ownerAt,
            0,
            true,
            scanned,
          )
    })

  /** The entity's `rekey` handler: one scanned row — or one displaced by a move. */
  const rekeyRow = (
    row: StoredRow,
    ctx: Rekey.RekeyRowContext,
    depth = 0,
  ): Effect.Effect<Rekey.RekeyTally | undefined, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const type = row.__edd_e__?.S
      if (isValueless(row)) return yield* rekeyProjectionRow(row, ctx, undefined, depth)
      if (type?.startsWith(`${entityType}._unique.`)) return yield* rekeySentinelRow(row, ctx)
      if (type !== entityType) return undefined
      const stored = storedKeyOf(row)
      const targets = rowPlaces(row)
      if (stored === undefined || targets === undefined) {
        return { skipped: { unrecognizedKey: 1 } }
      }
      // The member's row, with values no key can be composed from: left where it is, and said so.
      if ("uncomposable" in targets) {
        return rekeyConflict(
          storedRowKind(stored[rekeySk]!),
          "uncomposable",
          stored,
          undefined,
          `Its values compose no key: ${targets.uncomposable}`,
        )
      }
      if (sameStoredKey(stored, targets.current)) {
        // A sentinel in another row's way has this row reached before the scan gets to it, and
        // then it has nothing left to do: `unchanged` counts a row the run didn't touch.
        const firstVisit = ctx.claim(
          `${entityType}\u0000at\u0000${stored[rekeyPk]}\u0000${stored[rekeySk]}`,
        )
        const tally: Rekey.RekeyTally = yield* Effect.gen(function* () {
          if (targets.kind === "item") return yield* rekeyCurrentItem(ctx, row, stored, depth)
          if (targets.kind !== "tombstone") return { unchanged: 1 }
          // A tombstone under its current key: its sentinels may still hold
          // other key text or name another of the item's keys.
          const sentinels = yield* rekeySentinels(
            ctx,
            "tombstone",
            row,
            targets.isLive,
            targets.live,
            depth,
            false,
          )
          return (sentinels.sentinelsMoved ?? 0) > 0 || (sentinels.conflicts ?? []).length > 0
            ? sentinels
            : { unchanged: 1 }
        })
        if (firstVisit) return tally
        const { unchanged: _again, ...rest } = tally
        return rest
      }
      if (targets.old === undefined) return { skipped: { unrecognizedKey: 1 } }
      if (targets.kind !== "item") {
        return yield* moveHistoryRow(ctx, targets.kind, stored, targets.current, depth)
      }
      const moved = yield* moveItem(ctx, stored, targets.current, depth)
      // A dry run wrote nothing to read back: `moveItem` judged the row it predicted.
      // A conflict left the row where it was.
      if (ctx.dryRun || (moved.conflicts ?? []).length > 0) return moved
      return Rekey.mergeTallies(moved, yield* rekeyAfterMove(ctx, row, targets.current, depth))
    })

  /**
   * A key's values read with each numeric composite as its declared kind or the other one, the
   * one whose value composes that composite's own text again (`KeyText136.readIndexKeys`), then
   * given as the kind it is declared: a field that stored both composed each value's own kind's
   * text. One reading, composite by composite, never one per combination. `undefined` when no
   * reading fits.
   */
  const readAsOtherNumericKind = (
    readAs: (
      kindOf: (attr: string) => KeyText136.ValueKind | ReadonlyArray<KeyText136.ValueKind>,
    ) => globalThis.Record<string, unknown> | undefined,
  ): globalThis.Record<string, unknown> | undefined => {
    const read = readAs((attr) => {
      const kind = primaryKeyKinds.get(attr)
      return kind === "number"
        ? ["number", "bigint"]
        : kind === "bigint"
          ? ["bigint", "number"]
          : kind
    })
    if (read === undefined) return undefined
    const declared = { ...read }
    for (const [attr, kind] of primaryKeyKinds) {
      const value = read[attr]
      if (kind === "number" && typeof value === "bigint") declared[attr] = Number(value)
      if (kind === "bigint" && typeof value === "number") {
        if (!Number.isInteger(value)) return undefined
        declared[attr] = BigInt(value)
      }
    }
    return declared
  }

  /**
   * Where a projection's row tombstone or outbox item belongs now. It holds no values: only the
   * key of the read-model row it was written for — its own, or `__edd_row_pk__` /
   * `__edd_row_sk__`; `keys` are its table's key attributes. Its mark (`KEY_TEXT`) says which text
   * that key is ({@link KeyText136.formOfMark}), and the key reads back to values when exactly one
   * set of them composes it there: `"current"` when they compose that key now, else the move to
   * the key they compose — an outbox item keeping its place after the row's sort key, the row it
   * names and its sparse index sort key rewritten (`moved`). `undefined` for any other key.
   */
  const valuelessMove = (
    row: StoredRow,
    keys: { readonly pk: string; readonly sk: string },
  ):
    | {
        readonly kind: "tombstone" | "outbox"
        readonly from: StoredKey
        readonly to: StoredKey
        /** The item at `to`: its keys, its mark, and an outbox item's text naming its row. */
        readonly moved: (read: StoredRow) => StoredRow
      }
    | "current"
    | undefined => {
    const primary = config.indexes.primary
    const kind = row.__edd_e__?.S === `${entityType}#tombstone` ? "tombstone" : "outbox"
    const storedPk = row[keys.pk]?.S
    const storedSk = row[keys.sk]?.S
    const rowPk = kind === "tombstone" ? storedPk : row[OUTBOX_ROW_PK]?.S
    const rowSk = kind === "tombstone" ? storedSk : row[OUTBOX_ROW_SK]?.S
    if (
      storedPk === undefined ||
      storedSk === undefined ||
      rowPk === undefined ||
      rowSk === undefined ||
      rowPk !== storedPk ||
      !storedSk.startsWith(rowSk)
    ) {
      return undefined
    }
    const readAs = (
      kindOf: (attr: string) => KeyText136.ValueKind | ReadonlyArray<KeyText136.ValueKind>,
    ) =>
      KeyText136.readIndexKeys(
        KeyText136.formOfMark(schema, row[KEY_TEXT]?.N),
        entityType,
        entityVersion,
        primary,
        { [primary.pk.field]: rowPk, [primary.sk.field]: rowSk },
        kindOf,
      )
    const readKeyForm =
      readAs((attr) => primaryKeyKinds.get(attr)) ?? readAsOtherNumericKind(readAs)
    if (readKeyForm === undefined) return undefined
    const now = (() => {
      try {
        return KeyText136.composeAt(
          { pk: schema, sk: schema },
          entityType,
          entityVersion,
          primary,
          readKeyForm,
        )
      } catch {
        return undefined
      }
    })()
    if (now === undefined) return undefined
    const newPk = now[primary.pk.field]!
    const newRowSk = now[primary.sk.field]!
    if (newPk === rowPk && newRowSk === rowSk) return "current"
    const suffix = storedSk.slice(rowSk.length)
    const to = { [keys.pk]: newPk, [keys.sk]: `${newRowSk}${suffix}` }
    return {
      kind,
      from: { [keys.pk]: storedPk, [keys.sk]: storedSk },
      to,
      moved: (read) => {
        const item: StoredRow = { ...read, ...toAttributeMap(to) }
        const mark = KeyText136.markOf(schema, entityType, entityVersion, primary, readKeyForm)
        if (mark === undefined) delete item[KEY_TEXT]
        else item[KEY_TEXT] = { N: String(mark) }
        if (kind === "tombstone") return item
        const indexSk = `${storedPk}#${storedSk}`
        for (const [attr, value] of Object.entries(read)) {
          if (value.S === indexSk) item[attr] = { S: `${newPk}#${newRowSk}${suffix}` }
        }
        return {
          ...item,
          ...toAttributeMap({ [OUTBOX_ROW_PK]: newPk, [OUTBOX_ROW_SK]: newRowSk }),
        }
      },
    }
  }

  /**
   * A projection's row tombstone or outbox item as read, whole, and unclaimed by a drainer since (a
   * row too wide for that, as `unprovableRow` decides).
   */
  const valuelessGuard = (read: StoredRow, pkField: string) => {
    const claims = [OUTBOX_CLAIM, OUTBOX_CLAIMED_UNTIL]
    const whole = wholeRowGuard(read, pkField, claims)
    if (whole !== undefined) return whole
    switch (unprovableRow()) {
      case "strongest":
        return asReadGuard(read, pkField, [], claims)
    }
  }

  /**
   * Move a projection's row tombstone or outbox item as a row: one transaction puts `item` at
   * `to`, where nothing may be, and deletes it at `from` while it is as `read`, unclaimed by a
   * drainer since. `false` when either condition failed.
   */
  const moveValueless = (
    tableName: string,
    pkField: string,
    from: StoredKey,
    read: StoredRow,
    item: StoredRow,
  ): Effect.Effect<boolean, DynamoClientError, DynamoClient> =>
    Effect.gen(function* () {
      const client = yield* Capacity.client
      return yield* client
        .transactWriteItems({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: item,
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": pkField },
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: toAttributeMap(from),
                ...valuelessGuard(read, pkField),
              },
            },
          ],
        })
        .pipe(
          Effect.as(true),
          Effect.catch((err: DynamoClientError) =>
            isAwsTransactionCancelled(err.cause) ? Effect.succeed(false) : Effect.fail(err),
          ),
        )
    })

  /**
   * A projection's row tombstone or outbox item, which holds no values: where
   * it belongs is read back from its key ({@link valuelessMove}). One whose key's values compose
   * another key now moves there as a row ({@link moveValueless}); another value's row left at
   * that key moves first, by its kind. One a drainer holds is left, a conflict until a rerun finds
   * it delivered. `keys`: the item's table key attributes.
   */
  const rekeyProjectionRow = (
    row: StoredRow,
    ctx: Rekey.RekeyRowContext,
    keys: { readonly pk: string; readonly sk: string } = { pk: rekeyPk, sk: rekeySk },
    depth = 0,
  ): Effect.Effect<Rekey.RekeyTally, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const move = valuelessMove(row, keys)
      if (move === undefined) return { skipped: { unrecognizedKey: 1 } }
      if (move === "current") return { unchanged: 1 }
      const { kind, from, to } = move
      const client = yield* Capacity.client
      const counted = keyAt(to[keys.pk]!, to[keys.sk]!)
      let tally: Rekey.RekeyTally = {}
      for (let attempt = 0; attempt < GUARDED_PUT_ATTEMPTS; attempt++) {
        // The scan's read is eventually consistent: act on a consistent one.
        const { Item: read } = yield* client.getItem({
          TableName: ctx.tableName,
          Key: toAttributeMap(from),
          ConsistentRead: true,
        })
        // Gone since the scan — delivered, or moved by a write or by this run
        // (counted then), and its key may hold another row now.
        if (read === undefined || read.__edd_e__?.S !== row.__edd_e__?.S) return tally
        const plan = valuelessMove(read, keys)
        if (
          typeof plan !== "object" ||
          plan.to[keys.pk] !== to[keys.pk] ||
          plan.to[keys.sk] !== to[keys.sk]
        ) {
          return tally
        }
        if (yield* claimedNow(read)) {
          return Rekey.mergeTallies(
            tally,
            rekeyConflict(kind, "contended", from, to, "A drainer holds it."),
          )
        }
        if (
          !ctx.dryRun &&
          (yield* moveValueless(ctx.tableName, keys.pk, from, read, plan.moved(read)))
        ) {
          return countMove(ctx, kind, counted, tally)
        }
        const { Item: there } = yield* client.getItem({
          TableName: ctx.tableName,
          Key: toAttributeMap(to),
          ConsistentRead: true,
        })
        if (there !== undefined) {
          // Another value's row left at its current key moves out first.
          if (occupantOf(there, counted) !== "stale") {
            // Or it is this row, moved there since the read by another row's move (counted then).
            const { Item: left } = yield* client.getItem({
              TableName: ctx.tableName,
              Key: toAttributeMap(from),
              ConsistentRead: true,
            })
            if (left === undefined) return tally
            return Rekey.mergeTallies(
              tally,
              rekeyConflict(kind, "taken", from, to, "Another row holds its current key."),
            )
          }
          if (depth >= Rekey.DISPLACE_DEPTH) {
            return Rekey.mergeTallies(
              tally,
              rekeyConflict(
                kind,
                "contended",
                from,
                to,
                "Too many rows under other key text hold each other's current keys.",
              ),
            )
          }
          const displaced = yield* Rekey.displace(ctx, (under) =>
            isValueless(there)
              ? rekeyProjectionRow(there, under, keys, depth + 1)
              : rekeyRow(there, under, depth + 1),
          )
          tally = Rekey.mergeTallies(tally, displaced)
          if ((displaced.conflicts ?? []).length > 0) {
            return Rekey.mergeTallies(tally, cantMoveHolder(kind, from, to))
          }
        }
        if (ctx.dryRun) return countMove(ctx, kind, counted, tally)
        // It changed between the read and the write, or made room: read again.
      }
      return Rekey.mergeTallies(
        tally,
        rekeyConflict(
          kind,
          "contended",
          from,
          to,
          "Concurrent writes changed it on every attempt.",
        ),
      )
    })

  const rekeyHandler: Rekey.RekeyMember = {
    name: entityType,
    types: [entityType, `${entityType}#tombstone`, `${entityType}#outbox`],
    typePrefixes: [`${entityType}._unique.`],
    row: (row, ctx) => rekeyRow(row, ctx),
  }

  // ---------------------------------------------------------------------------
  // Expression combinators: condition, filter, select
  // ---------------------------------------------------------------------------

  // Sparse-field map used by createPathBuilder to wire `.entry(key)` accessors.
  const sparseFieldsForPath = hasSparseFields ? sparseFields : undefined
  const entityPathBuilder = createPathBuilder<any>([], resolveDbName, sparseFieldsForPath)
  const entityConditionOps = createConditionOps<any>()

  /**
   * Build a condition expression combinator from callback or shorthand.
   * Returns a function that applies the condition to an EntityPut/Update/Delete.
   */
  const entityCondition = (
    cbOrShorthand: ((...args: any[]) => any) | globalThis.Record<string, unknown>,
  ) => {
    const expr: Expr =
      typeof cbOrShorthand === "function"
        ? cbOrShorthand(entityPathBuilder, entityConditionOps)
        : parseSimpleShorthand(cbOrShorthand)
    refusePackedExpr(expr, "condition")
    return (self: any) => conditionCombinator(self, expr)
  }

  /**
   * Build a filter expression combinator from callback or shorthand.
   * Returns a function that applies the filter to a Query.
   */
  const entityFilter = (
    cbOrShorthand: ((...args: any[]) => any) | globalThis.Record<string, unknown>,
  ) => {
    const expr: Expr =
      typeof cbOrShorthand === "function"
        ? cbOrShorthand(entityPathBuilder, entityConditionOps)
        : parseSimpleShorthand(cbOrShorthand)
    refusePackedExpr(expr, "filter")
    return <A>(q: Query.Query<A>): Query.Query<A> => filterExpr(q, expr)
  }

  /**
   * Build a select (projection) combinator from callback or string array.
   */
  const entitySelect = (
    cbOrAttrs:
      | ((t: any) => ReadonlyArray<{ segments: ReadonlyArray<string | number> }>)
      | ReadonlyArray<string>,
  ) => {
    const refuse = (paths: ReadonlyArray<ReadonlyArray<string | number>>) => {
      const refused = packedProjectionRefusal(paths, packedGuards)
      if (refused !== undefined) throw new Error(refused)
    }
    if (typeof cbOrAttrs === "function") {
      const paths = cbOrAttrs(entityPathBuilder)
      const segments = paths.map((p: { segments: ReadonlyArray<string | number> }) => p.segments)
      refuse(segments)
      return <A>(q: Query.Query<A>): Query.Query<globalThis.Record<string, unknown>> =>
        selectPaths(q, segments)
    }
    refuse(cbOrAttrs.map((attribute) => [attribute]))
    return <A>(q: Query.Query<A>): Query.Query<globalThis.Record<string, unknown>> =>
      Query.select(q, cbOrAttrs)
  }

  // ---------------------------------------------------------------------------
  // Flattened query accessors (same as query namespace, but on entity directly)
  // ---------------------------------------------------------------------------

  const flattenedAccessors: globalThis.Record<string, (pk: any) => Query.Query<any>> = {}
  for (const indexName of Object.keys(config.indexes)) {
    if (indexName === "primary") continue
    flattenedAccessors[indexName] = queryNamespace[indexName]!
  }

  const entity = {
    _tag: "Entity" as const,
    model: config.model,
    entityType: config.entityType,
    get indexes() {
      return allIndexes
    },
    timestamps: config.timestamps as TTimestamps,
    versioned: config.versioned as TVersioned,
    softDelete: config.softDelete as TSoftDelete,
    unique: config.unique as TUnique,
    identifier: resolvedIdentifier as ExtractIdentifier<ConfiguredModel<TModel, TAttrs>>,
    timeSeries: config.timeSeries as TTimeSeries,
    generatedId: config.generatedId as TGeneratedId,
    vectorIndexes: config.vectorIndexes as TVectorIndexes,
    _vectorIndexes: vectorIndexes,
    _refuseTableAttributes: refuseTableAttributes,
    _packedFields: Object.keys(packedFields),
    _packFields: packFields,
    _unpackFields: unpackFields,
    _dispatchAttributes: dispatchAttributes,
    _packedGuards: packedGuards,
    _decodeImage: decodeImageItem,
    _resolvedRefs: resolvedRefs,
    /** @internal Full decode pipeline: unpack + sparse + rename + schema decode. Used by Batch/Aggregate. */
    _decodeRecord: decodeRecord,
    /** @internal Domain field name → stored attribute name (`storedAs` renames). */
    _resolveDbName: resolveDbName,
    /** @internal Entity schema version baked into composed keys. */
    _entityVersion: entityVersion,
    _serializeSparseFields: serializeSparseFields,
    _keyForm: keyForm,
    _domainKeyForm: domainKeyForm,
    _unstorableKey: unstorableKey,
    _renameToDynamo: renameToDynamo,
    _fieldOfAttribute: fieldOfAttribute,
    _incarnationToken: stampsIncarnation,
    _versionCorruption: versionCorruption,
    _fillDecodingDefaults: fillDecodingDefaults,
    _refuseNotReadBack: (encoded: unknown, operation: string) =>
      kindReads().model.size === 0
        ? refuseNotReadBack(encoded, operation)
        : Effect.andThen(
            refuseNotReadBack(encoded, operation),
            refuseOtherKindRead(encoded, operation),
          ),
    _unsentineledDefaults: unsentineledDefaults,
    _planPut: planPut,
    _multiItemWriteFeatures: multiItemWriteFeatures(),
    _prepareUpdate: (
      key: unknown,
      state: UpdateState,
      encoded: globalThis.Record<string, unknown>,
    ) =>
      prepareUpdate(key, state, encoded).pipe(
        Effect.map((prepared) => prepared as unknown as PreparedUpdate),
      ),
    _planUpdate: (key: unknown, state: UpdateState, prepared: PreparedUpdate) =>
      planUpdate(
        key,
        state,
        prepared as unknown as Effect.Success<ReturnType<typeof prepareUpdate>>,
      ).pipe(
        // Planning stops at the write, so only what an update raises BEFORE
        // writing can surface; anything else is a defect (`isPlanUpdateError`).
        Effect.catch((e: unknown) => (isPlanUpdateError(e) ? Effect.fail(e) : Effect.die(e))),
      ),
    _planDelete: (
      key: unknown,
      opts: { readonly condition: Expr | ConditionInput | undefined; readonly mustExist: boolean },
      encoded: globalThis.Record<string, unknown>,
    ) =>
      planDelete(key, opts, encoded).pipe(
        Effect.catch((e: unknown) => (isPlanDeleteError(e) ? Effect.fail(e) : Effect.die(e))),
      ),
    _encodeKey: encodeKey,
    _liveRows: liveRows,
    _rekeyProjectionRow: rekeyProjectionRow,
    _keyTextMark: (key: globalThis.Record<string, unknown>) =>
      KeyText136.markOf(
        schema,
        entityType,
        entityVersion,
        config.indexes.primary,
        domainKeyForm(key),
      ),
    [Rekey.RekeyHandler]: rekeyHandler,
    _attachPrototype: attachPrototype,
    _overTombstone: (item: globalThis.Record<string, unknown>) =>
      Effect.gen(function* () {
        const client = yield* Capacity.client
        return yield* overTombstone(self, client, yield* tableTag, item)
      }),
    _configure: (
      injectedSchema: DynamoSchema.DynamoSchema,
      injectedTableTag: import("effect").Context.Service<TableConfig, TableConfig>,
    ) => {
      schema = injectedSchema
      tableTag = injectedTableTag
    },
    _injectIndex: (name: string, def: IndexDefinition) => {
      // A collection's index is string-composed; a Z-order one never joins (#171).
      if (KeyComposer.isZOrderHalf(def.sk)) throw zorderInCollection(entityType, name)
      const refused = packedIndexRefusal(entityType, packedFields, name, def)
      if (refused !== undefined) throw new Error(refused)
      allIndexes = { ...allIndexes, [name]: def }
    },
    get _schema() {
      return schema
    },
    get _tableTag() {
      return tableTag
    },
    systemFields,
    schemas,
    inputSchema: schemas.inputSchema,
    createSchema: schemas.createSchema,
    updateSchema: schemas.updateSchema,

    get,
    put,
    create,
    patch,
    update,
    delete: del,
    deleteIfExists,
    upsert,
    scan,
    // Lifecycle ops reuse the get / delete carriers; their builders carry the
    // operation name consumed-capacity reports use (#174).
    getVersion: (key: unknown, versionNumber: number) =>
      namedOp(getVersion(key, versionNumber), "Entity.getVersion"),
    versions: (key: unknown) => refusingQuery("Entity.versions", () => versionsQuery(key)),
    restore: (key: unknown) => namedOp(restore(key), "Entity.restore"),
    purge: (key: unknown) => namedOp(purge(key), "Entity.purge"),
    deleted: {
      get: (key: unknown) => namedOp(deletedGet(key), "Entity.deleted.get"),
      list: (key: unknown) => refusingQuery("Entity.deleted.list", () => deletedListQuery(key)),
    },
    append,
    history: (key: unknown) => refusingQuery("Entity.history", () => historyQuery(key)),

    set,
    expectedVersion,

    query: queryNamespace,
    condition: entityCondition,
    filter: entityFilter,
    select: entitySelect,
    ...flattenedAccessors,
    // Cast rationale: Entity.make() builds the entity object incrementally from
    // closures that capture the config. The object literal's inferred type is a
    // union of all closure return types, which doesn't satisfy the fully-generic
    // Entity<TModel, ...> interface. The cast is safe because each method
    // is constructed with the correct types from the generic config parameters.
  } as unknown as Entity<
    TModel,
    TEntityType,
    TIndexes,
    TTimestamps,
    TVersioned,
    TSoftDelete,
    TUnique,
    TRefs,
    ExtractIdentifier<ConfiguredModel<TModel, TAttrs>>,
    TTimeSeries,
    TGeneratedId,
    TVectorIndexes,
    ExtractPackedFields<ConfiguredModel<TModel, TAttrs>>,
    ExtractUnremovableFields<ConfiguredModel<TModel, TAttrs>>
  >

  // Assign self so operation closures can reference the entity
  // Cast needed: Entity<TModel,...> set property is contravariant in updates type,
  // which makes it incompatible with the default Entity (Schema.Top).
  // This is safe — self is only used internally for extractTransactable.
  self = entity as unknown as Entity
  return entity
}

// ---------------------------------------------------------------------------
// Entity binding — resolve services, return BoundEntity with R = never
// ---------------------------------------------------------------------------

/**
 * Bind an Entity to resolved `DynamoClient` and `TableConfig` services.
 * Returns a {@link BoundEntity} where all operations have `R = never`.
 *
 * @internal Used by `DynamoClient.make()` to bind entities.
 */
export const bind = <
  TModel extends Schema.Top,
  TEntityType extends string,
  TIndexes extends globalThis.Record<string, IndexDefinition>,
  TTimestamps extends TimestampsConfig | undefined,
  TVersioned extends VersionedConfig | undefined,
  TSoftDelete extends SoftDeleteConfig | undefined,
  TUnique extends UniqueConfig | undefined,
  TRefs extends globalThis.Record<string, AnyRefValue> | undefined,
  TIdentifier extends string | undefined,
  TTimeSeries extends TimeSeriesConfig<any> | undefined = undefined,
  TGeneratedId extends GeneratedIdConfig | undefined = undefined,
  TVectorIndexes extends globalThis.Record<string, VectorIndexConfig> | undefined = undefined,
  TPackedFields extends string = never,
  TUnremovable extends string = never,
>(
  entity: Entity<
    TModel,
    TEntityType,
    TIndexes,
    TTimestamps,
    TVersioned,
    TSoftDelete,
    TUnique,
    TRefs,
    TIdentifier,
    TTimeSeries,
    TGeneratedId,
    TVectorIndexes,
    TPackedFields,
    TUnremovable
  >,
): Effect.Effect<
  BoundEntity<
    TModel,
    TIndexes,
    TRefs,
    EntityKeyType<TModel, TIndexes>,
    TTimeSeries,
    TTimestamps,
    TVersioned,
    TGeneratedId,
    TVectorIndexes,
    TPackedFields,
    TUnremovable
  >,
  never,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    // Bundle a default `SecureRandom` service into the captured context. This is how
    // `generatedId` put auto-fills a UUID while keeping bound `put` at
    // `R = never`: the entity op yields `SecureRandom`, and `provide` supplies
    // it from this bundled context rather than surfacing it as a requirement.
    // The `provide` helper is widened to admit `SecureRandom` so the
    // SecureRandom-requiring entity ops typecheck. A platform override supplied via
    // `DynamoClient.make({ crypto })` is already in `baseCtx` and is respected
    // (we only fill the default when absent). See `DESIGN.md`.
    // Detached: no current operation or parent span is pinned for later calls (#174).
    const baseCtx = Capacity.detachContext(yield* Effect.context<DynamoClient | TableConfig>())
    const ctx = Option.isSome(Context.getOption(baseCtx, SecureRandom.SecureRandom))
      ? (baseCtx as Context.Context<DynamoClient | TableConfig | SecureRandom.SecureRandom>)
      : Context.add(baseCtx, SecureRandom.SecureRandom, makeDefaultCrypto())
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DynamoClient | TableConfig | SecureRandom.SecureRandom>,
    ): Effect.Effect<A, E, never> => Effect.provide(effect, ctx)

    type Key = EntityKeyType<TModel, TIndexes>
    type Input = WithGeneratedId<
      EntityRefInputType<TModel, TRefs, TTimestamps, TVersioned, TTimeSeries>,
      TGeneratedId
    >

    // Sparse-field map (if any) — extracted from the Entity's configured model
    // so the PathBuilder used by `.condition((t, ops) => ...)` exposes
    // `.entry(key)` accessors on sparse-map fields.
    const boundSparseFields = getSparseFields(entity.model as Schema.Top)
    const boundSparseFieldsForPath =
      Object.keys(boundSparseFields).length > 0 ? boundSparseFields : undefined

    // Shared config for the bound-CRUD builders — pre-resolved services plus
    // a typed PathBuilder/ConditionOps so `.condition((t, ops) => ...)` works.
    const boundCrudConfig: import("./internal/BoundCrud.js").BoundCrudConfig<unknown> = {
      pathBuilder: createPathBuilder(undefined, undefined, boundSparseFieldsForPath),
      conditionOps: createConditionOps(),
      provide,
    }

    // Helper: apply query combinators then execute
    const applyQuery = <A>(q: Query.Query<A>, combinators: ReadonlyArray<(q: any) => any>) => {
      let result: any = q
      for (const fn of combinators) result = fn(result)
      return result as Query.Query<A>
    }

    // Helper: wrap a raw entity-level Query<A> in a BoundQuery with this binding's
    // pre-resolved provide. Used by `versions` and `deleted.list` accessors so consumers
    // get the same fluent .collect() / .fetch() / .paginate() / .reverse() / .limit() /
    // .filter() ergonomics they get from index accessors and `.scan()`.
    const wrapAsBoundQuery = <A>(q: Query.Query<A>, operation: string) => {
      const bqConfig: BoundQueryConfig<unknown> = {
        pathBuilder: createPathBuilder(),
        conditionOps: createConditionOps(),
        provide,
        ...entityNaming(entity._resolveDbName),
        operation: { name: operation, target: entity.entityType },
      }
      return new BoundQueryImpl(
        q,
        bqConfig,
      ) as unknown as import("./internal/BoundQuery.js").BoundQuery<A, never, A>
    }

    /**
     * Out-of-band embedding refresh.
     *
     * DynamoDB never recomputes a vector, so changing the embedding model (or
     * the declared `source.fields`) leaves every stored vector stale until
     * something rewrites it. `reembed` is that something: scan the entity's
     * items, re-derive the source text, embed, and write the vector +
     * partition attributes back.
     *
     * Version snapshots and soft-delete tombstones carry the same `__edd_e__`
     * discriminator as live items, so they are filtered out by recomposing the
     * primary sort key from the decoded record and comparing it with what is
     * stored — a snapshot's SK never round-trips.
     *
     * See `DESIGN.md §14 Write path`.
     */
    const reembed = (options?: {
      readonly concurrency?: number | undefined
    }): Effect.Effect<number, DynamoClientError | ValidationError | EmbeddingError, never> => {
      const vectorDefs = Object.entries(entity._vectorIndexes)
      const boundSchema = entity._schema
      const primary = entity.indexes.primary as IndexDefinition
      const boundEntityVersion = entity._entityVersion
      const concurrency = options?.concurrency ?? 4
      return provide(
        Capacity.operation(
          "Entity.reembed",
          { target: entity.entityType },
          Effect.gen(function* () {
            if (vectorDefs.length === 0) return 0
            const client = yield* Capacity.client
            const { name: tableName } = yield* entity._tableTag as Context.Service<
              TableConfig,
              TableConfig
            >

            const reembedItem = (marshalled: globalThis.Record<string, AttributeValue>) =>
              Effect.gen(function* () {
                const raw = fromAttributeMap(marshalled) as globalThis.Record<string, unknown>
                const storedSk = raw[primary.sk.field]
                const decoded = (yield* entity._decodeRecord(raw)) as globalThis.Record<
                  string,
                  unknown
                >
                // Snapshots / tombstones live in the same partition under a
                // rewritten SK — their SK cannot be recomposed from the record.
                // `decoded` holds domain values: the keys `put` wrote for them
                // are the key form of the values it stores.
                const decodedKeyForm = entity._domainKeyForm(decoded)
                const liveSk = KeyComposer.composeSk(
                  boundSchema,
                  entity.entityType,
                  boundEntityVersion,
                  primary,
                  decodedKeyForm,
                )
                if (storedSk !== liveSk) return false

                const attributes: globalThis.Record<string, unknown> = {}
                for (const [logicalName, definition] of vectorDefs) {
                  const partition = KeyComposer.tryComposeVectorPartition(
                    boundSchema,
                    entity.entityType,
                    definition,
                    decodedKeyForm,
                  )
                  if (partition === undefined) continue
                  const text = deriveSourceText(definition, decoded)
                  if (text === undefined) continue
                  const maybeEmbedder = yield* Effect.serviceOption(Embedder)
                  if (Option.isNone(maybeEmbedder)) {
                    return yield* new EmbeddingError({
                      entityType: entity.entityType,
                      index: logicalName,
                      reason:
                        "No Embedder service is available. Provide one via " +
                        "DynamoClient.make({ embedder }) before calling reembed().",
                    })
                  }
                  const vector = yield* maybeEmbedder.value.embed(text)
                  if (vector.length !== definition.dimensions) {
                    return yield* new EmbeddingError({
                      entityType: entity.entityType,
                      index: logicalName,
                      reason:
                        `Embedder produced ${vector.length} dimensions but vector index ` +
                        `"${definition.index}" declares ${definition.dimensions}.`,
                    })
                  }
                  attributes[definition.partitionField] = partition
                  attributes[definition.vectorField] = vector
                }
                if (Object.keys(attributes).length === 0) return false

                const names: globalThis.Record<string, string> = { "#pk": primary.pk.field }
                const values: globalThis.Record<string, AttributeValue> = {}
                const sets: Array<string> = []
                let i = 0
                for (const [field, value] of Object.entries(attributes)) {
                  names[`#v${i}`] = field
                  values[`:v${i}`] = toAttributeValue(value)
                  sets.push(`#v${i} = :v${i}`)
                  i++
                }
                // Scan → embed → update is not atomic: an item can be hard-deleted
                // between the scan page and this write, and an unconditional
                // UpdateItem would resurrect it as a key-plus-vector fragment that
                // decodes to nothing but still answers searches. Guard on the item
                // still existing and treat the rejection as "skipped".
                const update = {
                  TableName: tableName,
                  Key: {
                    [primary.pk.field]: marshalled[primary.pk.field]!,
                    [primary.sk.field]: marshalled[primary.sk.field]!,
                  },
                  UpdateExpression: `SET ${sets.join(", ")}`,
                  ConditionExpression: "attribute_exists(#pk)",
                  ExpressionAttributeNames: names,
                  ExpressionAttributeValues: values,
                }
                return yield* client.updateItem(update).pipe(
                  Effect.as(true),
                  Effect.catchIf(
                    (err: DynamoClientError) => isAwsConditionalCheckFailed(err.cause),
                    () => Effect.succeed(false),
                  ),
                  // An embedding that grows the item past 400 KB, named (#144).
                  diagnoseFailure({
                    sent: () => ({
                      _tag: "Item",
                      item: { Update: update },
                      target: () =>
                        targetsFor(
                          [{ Update: update }],
                          [primary.pk.field, primary.sk.field],
                          entity.entityType,
                          () => "the re-embedded item",
                        )[0]!,
                    }),
                    keys: () => keyAttributesOf(entity.indexes as never),
                    rewrite: (diagnosis, original) =>
                      diagnosedValidationError(diagnosis, original, {
                        operation: "reembed",
                        entityType: entity.entityType,
                      }),
                  }),
                )
              })

            let updated = 0
            let exclusiveStartKey: globalThis.Record<string, AttributeValue> | undefined
            do {
              const page = yield* client.scan({
                TableName: tableName,
                FilterExpression: "#et = :et",
                ExpressionAttributeNames: { "#et": "__edd_e__" },
                ExpressionAttributeValues: { ":et": { S: entity.entityType } },
                ExclusiveStartKey: exclusiveStartKey,
              })
              const results = yield* Effect.all(
                (page.Items ?? []).map((item) =>
                  reembedItem(item as globalThis.Record<string, AttributeValue>),
                ),
                { concurrency },
              )
              updated += results.filter((applied) => applied).length
              exclusiveStartKey = page.LastEvaluatedKey as
                | globalThis.Record<string, AttributeValue>
                | undefined
            } while (exclusiveStartKey !== undefined)
            return updated
          }),
        ),
      )
    }

    return {
      // CRUD — fluent bound builders (yieldable, no .run() terminal)
      reembed,
      get: (key: Key) => makeBoundGet(entity.get(key) as any, boundCrudConfig),
      put: (input: Input) => makeBoundPut(entity.put(input), boundCrudConfig),
      create: (input: Input) => makeBoundPut(entity.create(input), boundCrudConfig),
      update: (key: Key) => makeBoundUpdate(entity.update(key), boundCrudConfig),
      delete: (key: Key) => makeBoundDelete(entity.delete(key), boundCrudConfig),
      upsert: (input: Input) => makeBoundPut(entity.upsert(input), boundCrudConfig),
      patch: (key: Key) => makeBoundUpdate(entity.patch(key), boundCrudConfig),
      deleteIfExists: (key: Key) => makeBoundDelete(entity.deleteIfExists(key), boundCrudConfig),
      // Lifecycle
      getVersion: (key: Key, version: number) =>
        provide((entity.getVersion(key, version) as any)._exec("record")),
      versions: (key: Key) => wrapAsBoundQuery(entity.versions(key), "Entity.versions"),
      restore: (key: Key) => provide((entity.restore(key) as any)._exec("record")),
      purge: (key: Key) => provide(entity.purge(key).asEffect()),
      deleted: {
        get: (key: Key) => provide((entity.deleted.get(key) as any)._exec("record")),
        list: (key: Key) => wrapAsBoundQuery(entity.deleted.list(key), "Entity.deleted.list"),
      },
      // Time-series (no-ops when entity is not configured; runtime check in
      // the entity-level `append` returns a ValidationError).
      append: (input: unknown) => {
        const appendCfg: import("./internal/BoundCrud.js").BoundAppendConfig<unknown> = {
          ...boundCrudConfig,
          run: (opts) =>
            provide(
              (
                entity.append as unknown as (
                  i: unknown,
                  c: Expr | ConditionInput | undefined,
                  s: boolean,
                  r: ReadonlyArray<string> | undefined,
                ) => Effect.Effect<any, any, any>
              )(opts.input, opts.condition, opts.skipFollowUp, opts.removeAttrs),
            ),
        }
        return makeBoundAppend(input, appendCfg)
      },
      history: (key: Key) => {
        const q = (entity.history as any as (k: Key) => Query.Query<any>)(key)
        const pathBuilder = createPathBuilder()
        const conditionOps = createConditionOps()
        const ts = (entity as unknown as { readonly timeSeries?: TimeSeriesConfig<any> }).timeSeries
        const orderBy = ts?.orderBy
        const entityInternals = entity as unknown as {
          readonly _schema: DynamoSchema.DynamoSchema
          readonly entityType: string
          readonly model: Schema.Top
          readonly schemas?: { readonly inputSchema?: Schema.Top | undefined }
        }
        const schemaRef = entityInternals._schema
        const entityTypeRef = entityInternals.entityType
        // An orderBy value as its model field stores it, as `append` encodes
        // it (`encodeForWrite`: encoded, else decoded and encoded) and as the
        // key form reads it, so a bound names the key an event's row composes;
        // a value neither takes, as given. Only a bound's key text: nothing is
        // stored from it.
        const encodeOrderBy = (() => {
          const field =
            orderBy === undefined
              ? undefined
              : getSchemaFields(entity.schemas.inputSchema as unknown as Schema.Top)?.[orderBy]
          if (field === undefined) return (v: unknown) => v
          const codec = field as unknown as Schema.Codec<unknown, unknown>
          const encode = Schema.encodeUnknownOption(codec)
          const decode = Schema.decodeUnknownOption(codec)
          return (v: unknown): unknown => {
            const direct = encode(v)
            if (Option.isSome(direct)) return direct.value
            const again = Option.flatMap(decode(v), (decoded) => encode(decoded))
            return Option.isSome(again) ? again.value : v
          }
        })()

        // composeSkCondition: rewrite user's .where() values by prefixing
        // with `<currentSk>#e#` and applying serialisation, casing and
        // escaping to the user-supplied orderBy value.
        const primary = entity.indexes.primary!
        const composeSkCondition = (
          cond: RawSortKeyCondition,
        ): Query.SortKeyCondition | undefined => {
          // We need the `currentSk` + prefix. The user's `key` lets us derive
          // `currentSk` via the same primary SK composer used by `history()`.
          // `key` is the caller's Type-side key; the stored SK was composed
          // from the encoded form, so compose it as `get` does: the key form of
          // the value `put` stores (`_domainKeyForm`).
          const currentSk = KeyComposer.composeSk(
            schemaRef,
            entityTypeRef,
            1,
            primary,
            entity._domainKeyForm(key as globalThis.Record<string, unknown>),
          )
          const prefix = KeyComposer.composeEventSkPrefix(currentSk, schemaRef.casing)
          // Exactly as `Entity.append` composes the event's sort key: the value
          // encoded as `appendInput` encodes it, put into key form from that,
          // and the one of the two the setting keys on (`eventOrderByValue`).
          // From the caller's value, a transformed orderBy (`Option(x)`, a
          // `NumberFromString` with `escapeKeys` off) composed other text.
          const keyFormOf = (v: unknown) =>
            orderBy === undefined ? v : entity._keyForm({ [orderBy]: encodeOrderBy(v) })[orderBy]
          const rewrite = (v: unknown) => {
            if (orderBy === undefined) {
              return `${prefix}${KeyComposer.keyValueText(schemaRef, v, schemaRef.casing)}`
            }
            const encoded = encodeOrderBy(v)
            const value = KeyComposer.eventOrderByValue(
              schemaRef,
              encoded,
              entity._keyForm({ [orderBy]: encoded })[orderBy],
            )
            return `${prefix}${KeyComposer.keyValueText(schemaRef, value, schemaRef.casing)}`
          }
          // DynamoDB allows ONE sort key condition, and this one replaces the
          // history query's `begins_with(prefix)`. Every operator therefore
          // keeps both ends inside `prefix` — the `.where()` clamp of
          // `composeRangeUnder`, for a value that is the key's last segment.
          // A bare one-sided `<` / `>` ran on to the item's current row and
          // its siblings' events. Strict `<` takes the greatest key text below
          // the bound as BETWEEN's inclusive high end (`keyJustBelow`); `>`
          // starts past `#￿`, above every key of the bound value and below
          // every greater one, whose escaped text extends it with a character
          // above `#` (`a%20b` after `a`), as `composeRangeUnder` does. The
          // open end is `prefix` + U+10FFFF, not U+FFFF: the value follows the
          // prefix directly, with no label before it, and one starting with an
          // emoji sorts above U+FFFF. Below the empty string there is no key:
          // `lt("")` plans `empty`, as BETWEEN's ends would be reversed.
          const prefixMax = `${prefix}${KEY_TOP}`
          if ("eq" in cond) return { eq: rewrite(cond.eq) }
          if ("lt" in cond) {
            const below = rewrite(cond.lt)
            return below === prefix ? undefined : { between: [prefix, keyJustBelow(below)] }
          }
          if ("lte" in cond) return { between: [prefix, rewrite(cond.lte)] }
          if ("gt" in cond) {
            return {
              between: [`${rewrite(cond.gt)}${DynamoSchema.KEY_DELIMITER}${KEY_MAX}`, prefixMax],
            }
          }
          if ("gte" in cond) return { between: [rewrite(cond.gte), prefixMax] }
          if ("between" in cond)
            return { between: [rewrite(cond.between[0]), rewrite(cond.between[1])] }
          if ("beginsWith" in cond) {
            // A number has no text prefix: its key text is not its digits
            // (`-3` is `-9999999999999996:`), and an integer's text prefixes
            // its fractions'. `beginsWith` on a numeric orderBy is `eq`.
            const operand = keyFormOf(cond.beginsWith)
            return typeof operand === "number" || typeof operand === "bigint"
              ? { eq: rewrite(cond.beginsWith) }
              : { beginsWith: rewrite(cond.beginsWith) }
          }
          return cond
        }

        const bqConfig: BoundQueryConfig<unknown> = {
          pathBuilder,
          conditionOps,
          provide,
          skFields: orderBy ? [orderBy] : [],
          composeSkCondition,
          ...entityNaming(entity._resolveDbName),
          operation: { name: "Entity.history", target: entity.entityType },
        }
        return new BoundQueryImpl(q, bqConfig)
      },
      // Query execution
      // Each helper is a named operation, inside `provide` (consumed capacity, #174).
      paginate: <A>(q: Query.Query<A>, ...combinators: ReadonlyArray<(q: any) => any>) => {
        const final = applyQuery(q, combinators)
        const options = {
          ...Query.operationOptions(final as Query.Query<unknown>),
          target: entity.entityType,
        }
        return Stream.unwrap(
          provide(
            Effect.flatMap(Query.paginate(final), (pages) =>
              Capacity.operationStream("Entity.paginate", options, pages),
            ),
          ),
        ).pipe(Stream.flatMap((page) => Stream.fromIterable(page)))
      },
      collect: <A>(q: Query.Query<A>, ...combinators: ReadonlyArray<(q: any) => any>) => {
        const final = applyQuery(q, combinators)
        const options = {
          ...Query.operationOptions(final as Query.Query<unknown>),
          target: entity.entityType,
        }
        return provide(Capacity.operation("Entity.collect", options, Query.collect(final)))
      },
      fetch: <A>(q: Query.Query<A>, ...combinators: ReadonlyArray<(q: any) => any>) => {
        const final = applyQuery(q, combinators)
        const options = {
          ...Query.operationOptions(final as Query.Query<unknown>),
          target: entity.entityType,
        }
        return provide(Capacity.operation("Entity.fetch", options, Query.execute(final)))
      },
      scanFetch: (...combinators: ReadonlyArray<(q: any) => any>) =>
        provide(
          Capacity.operation(
            "Entity.scan",
            { target: entity.entityType },
            Query.execute(applyQuery(entity.scan(), combinators)),
          ),
        ),
    } as unknown as BoundEntity<
      TModel,
      TIndexes,
      TRefs,
      EntityKeyType<TModel, TIndexes>,
      TTimeSeries,
      TTimestamps,
      TVersioned,
      TGeneratedId,
      TVectorIndexes,
      TPackedFields,
      TUnremovable
    >
  })

// ---------------------------------------------------------------------------
// Extraction protocol — used by Transaction and Batch modules
// ---------------------------------------------------------------------------

/**
 * What planning an update for a transaction can fail with: everything the
 * update raises before it writes — its reads (`DynamoClientError`, `ItemNotFound`,
 * `RefNotFound`), a stale `expectedVersion`, `patch` of a missing row
 * (`ConditionalCheckFailed`), an op too large for one transaction, and a refused op
 * (`ValidationError`).
 */
/**
 * @internal What `Entity._prepareUpdate` decided of an update, opaque outside the entity that
 * made it: handed back to its `_planUpdate`.
 */
export interface PreparedUpdate {
  readonly _preparedUpdate: unique symbol
}

export type PlanUpdateError =
  | DynamoClientError
  | ValidationError
  | ConditionalCheckFailed
  | ItemNotFound
  | TransactionOverflow
  | OptimisticLockError
  | RefNotFound
  | UniqueConstraintViolation

/** What planning a delete for a transaction can fail with — see {@link PlanUpdateError}. */
export type PlanDeleteError =
  | DynamoClientError
  | ValidationError
  | ConditionalCheckFailed
  | ItemNotFound
  | TransactionOverflow

const tagged =
  <A>(tags: ReadonlySet<string>) =>
  (e: unknown): e is A =>
    typeof e === "object" && e !== null && "_tag" in e && tags.has(String(e._tag))

const clientErrorTags = [
  "DynamoError",
  "ThrottlingError",
  "DynamoValidationError",
  "InternalServerError",
  "ResourceNotFoundError",
]
const planDeleteErrorTags = [
  ...clientErrorTags,
  "ValidationError",
  "ConditionalCheckFailed",
  "ItemNotFound",
  "TransactionOverflow",
]
const isPlanDeleteError = tagged<PlanDeleteError>(new Set(planDeleteErrorTags))
const isPlanUpdateError = tagged<PlanUpdateError>(
  new Set([
    ...planDeleteErrorTags,
    "OptimisticLockError",
    "RefNotFound",
    "UniqueConstraintViolation",
  ]),
)

export interface TransactableInfo {
  readonly opType: "get" | "put" | "update" | "delete"
  readonly entity: Entity
  readonly key?: globalThis.Record<string, unknown> | undefined
  readonly input?: globalThis.Record<string, unknown> | undefined
  /**
   * The condition attached to the op — via `.condition()` on a bound builder,
   * `Entity.condition()` on an unbound intermediate, or implicitly by
   * `Entity.create()` (`attribute_not_exists`) / `Entity.patch()`
   * (`attribute_exists`). Consumers that cannot express a condition (BatchWrite)
   * MUST reject the op rather than drop it.
   */
  readonly condition?: Expr | ConditionInput | undefined
  /**
   * For `opType: "put"`, which put-shaped op produced it. `"upsert"` does NOT
   * have `Put` semantics — it is an `UpdateItem` with `if_not_exists` on
   * `createdAt`, immutable fields and the version counter. Consumers that emit
   * a `Put` MUST reject `"upsert"` rather than compile it (#100).
   */
  readonly putKind?: PutKind | undefined
  /** For `opType: "put"`: the caller's own condition, without `create`'s guard. */
  readonly callerCondition?: Expr | ConditionInput | undefined
  /** For `opType: "update"` — the accumulated update (`.set()`, `.remove()`, `patch`, …). */
  readonly updateState?: UpdateState | undefined
  /**
   * For `opType: "delete"` — the request as the caller built it: its own
   * condition (without `deleteIfExists`'s guard, which `mustExist` carries),
   * and its return mode, which a transaction cannot honour (EDD-9060).
   */
  readonly deleteRequest?:
    | {
        readonly condition: Expr | ConditionInput | undefined
        readonly mustExist: boolean
        readonly returnValues: ReturnValuesMode | undefined
      }
    | undefined
}

/** @internal */
interface InternalEntityOp {
  readonly [EntityOpTypeId]: EntityOpTypeId
  readonly _opType: string
  readonly _entity: Entity
  readonly _key?: globalThis.Record<string, unknown>
  readonly _input?: globalThis.Record<string, unknown>
  readonly _condition?: Expr | ConditionInput | undefined
  readonly _updateState?: UpdateState
  readonly _putKind?: PutKind | undefined
}

/** @internal */
interface InternalEntityDelete {
  readonly [EntityDeleteTypeId]: EntityDeleteTypeId
  readonly _entity: Entity
  readonly _key: globalThis.Record<string, unknown>
  readonly _condition?: Expr | ConditionInput | undefined
  readonly _mustExist?: boolean
  readonly _returnValues?: ReturnValuesMode | undefined
}

const isEntityOp = (op: object): op is InternalEntityOp => EntityOpTypeId in op

const isEntityDelete = (op: object): op is InternalEntityDelete => EntityDeleteTypeId in op

/**
 * Extract transactable metadata from an Entity operation intermediate.
 * Returns undefined if the value is not a recognized entity operation.
 *
 * Bound ops (`db.entities.X.put(...)`, `.create(...)`, `.delete(...)`,
 * `.get(...)`, …) are unwrapped to the `EntityOp` / `EntityDelete` they wrap.
 * That unwrapping is what lets entities authored with the pure, AWS-free
 * `@effect-dynamodb/schema` `Entity.make` take part in `Batch.write`,
 * `Transaction.transactWrite`, `EventStore.append({ additionalItems })` (#100)
 * and — through the same one protocol, not a second one — `Batch.get`,
 * `Transaction.transactGet` and `Transaction.check` (#108). A pure definition
 * carries no operations, so the bound op is the only descriptor its author can
 * ever hold.
 */
/**
 * @internal `create`'s guard: the item must not exist. (Over a projection
 * tombstone, `create` reads it and guards on it instead — `overTombstone`.)
 */
export const createGuard = (entity: {
  readonly indexes: {
    readonly primary?: {
      readonly pk: { readonly field: string }
      readonly sk: { readonly field: string }
    }
  }
}): ConditionInput => {
  const primary = entity.indexes.primary!
  return { attributeNotExists: [primary.pk.field, primary.sk.field] }
}

export const extractTransactable = (op: unknown): TransactableInfo | undefined => {
  if (op == null || typeof op !== "object") return undefined

  // Unwrap a bound-CRUD builder to the intermediate it wraps. Combinators on the
  // builder (`.condition()`, `.set()`, …) are applied to that inner op, so the
  // unwrapped value carries the full request.
  const target = isBoundOp(op) ? (op._op as unknown) : op
  if (target == null || typeof target !== "object") return undefined

  // Check for EntityOp intermediates (get, put, update)
  if (isEntityOp(target)) {
    if (target._opType === "get") {
      return { opType: "get", entity: target._entity, key: target._key }
    }
    // `create`'s own not-exists guard is ANDed with the caller's condition:
    // no `.condition()` replaces it (#133).
    if (target._opType === "put") {
      const putKind = target._putKind ?? "put"
      return {
        opType: "put",
        entity: target._entity,
        input: target._input,
        condition: withGuard(
          putKind === "create" ? createGuard(target._entity) : undefined,
          target._condition,
        ),
        putKind,
        callerCondition: target._condition,
      }
    }
    if (target._opType === "update") {
      // `Transaction.transactWrite` plans an update from its whole state
      // (`_planUpdate`), which applies `patch`'s guard itself; every other
      // multi-item path refuses an update.
      return {
        opType: "update",
        entity: target._entity,
        key: target._key,
        condition: target._updateState?.condition,
        updateState: target._updateState,
      }
    }
  }

  // Check for EntityDelete intermediate — `deleteIfExists`'s exists guard
  // ANDed with the caller's condition.
  if (isEntityDelete(target)) {
    return {
      opType: "delete",
      entity: target._entity,
      key: target._key,
      condition: withGuard(
        target._mustExist
          ? { attributeExists: [target._entity.indexes.primary!.pk.field] }
          : undefined,
        target._condition,
      ),
      deleteRequest: {
        condition: target._condition,
        mustExist: target._mustExist === true,
        returnValues: target._returnValues,
      },
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Time-series public type alias
// ---------------------------------------------------------------------------

/**
 * Success type of `BoundEntity.append()` on the default path — carries the
 * post-append `current` (decoded model).
 *
 * `.skipFollowUp()` narrows this to `void`. Stale outcomes are on the error
 * channel — see {@link StaleAppend} and {@link ConditionalCheckFailed}.
 */
export type AppendSuccess<TModel extends Schema.Top> = AppendSuccessType<TModel>

// ---------------------------------------------------------------------------
// Type extractors — the 7 derived types
// ---------------------------------------------------------------------------

/**
 * Extract the pure model type from an Entity.
 *
 * `Entity.Model<typeof Users>` = `{ userId: string, email: string, ... }`
 */
export type Model<E extends { readonly model: Schema.Top }> = ModelType<E["model"]>

/**
 * Extract the record type (model + system fields) from an Entity.
 *
 * `Entity.Record<typeof Users>` = model fields + createdAt, updatedAt, version
 */
// eslint-disable-next-line @typescript-eslint/no-shadow
export type Record<
  E extends {
    readonly model: Schema.Top
    readonly timestamps: any
    readonly versioned: any
    readonly timeSeries?: any
  },
> = EntityRecordType<E["model"], E["timestamps"], E["versioned"], E["timeSeries"]>

/**
 * Extract the input type from an Entity. Ref-aware: when refs are present,
 * ref fields are replaced with `${field}Id: string`.
 *
 * `Entity.Input<typeof Users>` = model fields only
 * `Entity.Input<typeof TeamPlayerSelection>` = `{ teamId: string, playerId: string, ... }`
 */
export type Input<E extends { readonly model: Schema.Top }> =
  E extends Entity<
    infer M extends Schema.Top,
    any,
    any,
    any,
    any,
    any,
    any,
    infer R,
    any,
    undefined,
    undefined,
    undefined,
    infer _P extends string,
    any
  >
    ? EntityRefInputType<M, R>
    : EntityInputType<E["model"]>

/**
 * Extract the create type from an Entity — input fields minus the identifier.
 * Uses the `identifier` config to determine which field to omit.
 * Falls back to omitting all primary key composites when no identifier is set.
 *
 * `Entity.Create<typeof Teams>` = `{ name: string, gender: Gender, league: League }`
 */
export type Create<E extends { readonly model: Schema.Top; readonly indexes: any }> =
  E extends Entity<
    infer M extends Schema.Top,
    any,
    infer I,
    any,
    any,
    any,
    any,
    infer R,
    infer Id,
    undefined,
    undefined,
    undefined,
    infer _P extends string,
    any
  >
    ? EntityRefCreateType<M, I, R, Id extends string ? Id : undefined>
    : Omit<EntityInputType<E["model"]>, PrimaryKeyComposites<E["indexes"]>>

/**
 * Extract the update type from an Entity. Ref-aware: when refs are present,
 * ref fields are replaced with optional `${field}Id?: string`.
 *
 * `Entity.Update<typeof Users>` = `{ email?: string, displayName?: string, ... }`
 */
export type Update<E extends { readonly model: Schema.Top; readonly indexes: any }> =
  E extends Entity<
    infer M extends Schema.Top,
    any,
    infer I,
    any,
    any,
    any,
    any,
    infer R,
    any,
    undefined,
    undefined,
    undefined,
    infer _P extends string,
    any
  >
    ? EntityRefUpdateType<M, I, R>
    : EntityUpdateType<E["model"], E["indexes"]>

/**
 * Extract the key type from an Entity.
 * Primary index pk + sk composite attributes only.
 *
 * `Entity.Key<typeof Users>` = `{ userId: string }`
 */
export type Key<E extends { readonly model: Schema.Top; readonly indexes: any }> = EntityKeyType<
  E["model"],
  E["indexes"]
>

/**
 * Extract the full DynamoDB item type (unmarshalled).
 * Record + key attributes + __edd_e__.
 *
 * `Entity.Item<typeof Users>` = record + pk, sk, gsi1pk, etc. + __edd_e__
 */
export type Item<E extends { readonly schemas: DerivedSchemas }> = Schema.Schema.Type<
  E["schemas"]["itemSchema"]
>

/**
 * Marshalled DynamoDB item (AttributeValue format).
 * For now, a simple record type. Full typing comes in Group 5.
 */
export type Marshalled<_E> = globalThis.Record<
  string,
  {
    readonly S?: string
    readonly N?: string
    readonly BOOL?: boolean
    readonly NULL?: boolean
    readonly L?: ReadonlyArray<unknown>
    readonly M?: globalThis.Record<string, unknown>
    /** Binary — a compressed packed value (`DynamoModel.Packed`) among others. */
    readonly B?: Uint8Array
  }
>

// ---------------------------------------------------------------------------
// Utility accessors
// ---------------------------------------------------------------------------

/** Minimal structural type for utility accessors (avoids Entity invariance issues). */
interface EntityLike {
  readonly indexes: globalThis.Record<string, IndexDefinition>
}

/**
 * Get the names of all primary key composite attributes for an entity.
 */
export const keyAttributes = (entity: EntityLike): ReadonlyArray<string> =>
  primaryKeyComposites(entity.indexes)

/**
 * Get the names of all key field attributes (pk, sk, gsi1pk, etc.) for an entity.
 */
export const keyFieldNames = (entity: EntityLike): ReadonlyArray<string> =>
  allKeyFieldNames(entity.indexes)

/**
 * Get the names of all composite attributes across all indexes.
 */
export const compositeAttributes = (entity: EntityLike): ReadonlyArray<string> =>
  allCompositeAttributes(entity.indexes)

// ---------------------------------------------------------------------------
// Schema accessors for raw data
// ---------------------------------------------------------------------------

/** Minimal structural type for schema accessors. */
interface EntityWithSchemas {
  readonly schemas: DerivedSchemas
  readonly _attachPrototype?: (decoded: any) => any
  /** See `versionCorruption` (#133): an item with a token but no version. */
  readonly _versionCorruption?: (
    item: Readonly<globalThis.Record<string, unknown>>,
    operation: string,
  ) => ValidationError | undefined
}

/**
 * Get the item schema for an entity.
 *
 * Returns a Schema that decodes unmarshalled DynamoDB items (plain JS objects
 * from `Marshaller.fromAttributeMap`) into Entity.Record instances.
 *
 * Useful for consuming DynamoDB Streams or working with raw query results.
 */
export const itemSchema = (entity: EntityWithSchemas): Schema.Codec<any> =>
  entity.schemas.itemSchema

/**
 * Decode a marshalled DynamoDB item (AttributeValue format) into a typed Entity.Record.
 *
 * Built for DynamoDB Streams records (`NewImage` / `OldImage`) and raw SDK
 * responses. Applies exactly what a table read applies:
 *
 * - **Packed fields** (`storedAs: DynamoModel.Packed`) are read by their
 *   stored form — a legacy native map, a JSON string (`S`), or compressed
 *   binary (`B`). Lambda and EventBridge Pipes deliver `B` / `BS` members as
 *   base64 text; they are decoded at any depth.
 * - Sparse-map fields are rebuilt and `field:` renames reversed.
 *
 * Accepts DynamoDB JSON (`{ pk: { S: "…" }, … }`, `B` as bytes or base64) or
 * an already-unmarshalled item. Fails with `ValidationError` if the item does
 * not match the schema, or when a compressed value's codec is not registered —
 * its `cause` is then a `CompressorNotRegistered` (register the codec with a
 * `Compression.layer([...])` provided where the decode runs).
 *
 * Note: {@link itemSchema} is a pure schema over unmarshalled items and does
 * not unpack — use this for entities with packed fields.
 */
export const decodeMarshalledItem = (
  entity: EntityWithSchemas & {
    readonly entityType: string
    readonly _decodeImage?: (image: StreamImage) => Effect.Effect<unknown, ValidationError>
  },
  marshalledItem: StreamImage,
): Effect.Effect<unknown, ValidationError> => {
  if (entity._decodeImage !== undefined) return entity._decodeImage(marshalledItem)
  const corruption = entity._versionCorruption?.(
    marshalledItem as Readonly<globalThis.Record<string, unknown>>,
    "decodeMarshalledItem",
  )
  if (corruption !== undefined) return Effect.fail(corruption)
  return Schema.decodeUnknownEffect(entity.schemas.itemSchema)(
    fromAttributeMap(marshalledItem as globalThis.Record<string, AttributeValue>),
  ).pipe(
    Effect.map((decoded) => (entity._attachPrototype ? entity._attachPrototype(decoded) : decoded)),
    Effect.mapError(
      (cause) =>
        new ValidationError({
          entityType: entity.entityType,
          operation: "decodeMarshalledItem",
          cause,
        }),
    ),
  )
}
