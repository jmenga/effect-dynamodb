/**
 * DynamoClient — Effect service wrapping the AWS SDK DynamoDBClient.
 *
 * All DynamoDB operations are exposed as Effect-returning methods that fail
 * with {@link DynamoError}. The underlying SDK client lifecycle is managed
 * via `Layer.scoped` (acquire on layer build, destroy on scope close).
 *
 * @module
 */

import type {
  AttributeValue,
  BatchGetItemCommandInput,
  BatchGetItemCommandOutput,
  BatchWriteItemCommandInput,
  BatchWriteItemCommandOutput,
  CreateBackupCommandInput,
  CreateBackupCommandOutput,
  CreateTableCommandInput,
  CreateTableCommandOutput,
  DeleteBackupCommandInput,
  DeleteBackupCommandOutput,
  DeleteItemCommandInput,
  DeleteItemCommandOutput,
  DeleteTableCommandInput,
  DeleteTableCommandOutput,
  DescribeContinuousBackupsCommandInput,
  DescribeContinuousBackupsCommandOutput,
  DescribeExportCommandInput,
  DescribeExportCommandOutput,
  DescribeTableCommandInput,
  DescribeTableCommandOutput,
  DescribeTimeToLiveCommandInput,
  DescribeTimeToLiveCommandOutput,
  ExportTableToPointInTimeCommandInput,
  ExportTableToPointInTimeCommandOutput,
  GetItemCommandInput,
  GetItemCommandOutput,
  ListBackupsCommandInput,
  ListBackupsCommandOutput,
  ListTablesCommandInput,
  ListTablesCommandOutput,
  ListTagsOfResourceCommandInput,
  ListTagsOfResourceCommandOutput,
  PutItemCommandInput,
  PutItemCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  RestoreTableFromBackupCommandInput,
  RestoreTableFromBackupCommandOutput,
  RestoreTableToPointInTimeCommandInput,
  RestoreTableToPointInTimeCommandOutput,
  ScanCommandInput,
  ScanCommandOutput,
  SearchVectorsCommandInput,
  SearchVectorsCommandOutput,
  TagResourceCommandInput,
  TagResourceCommandOutput,
  TransactGetItemsCommandInput,
  TransactGetItemsCommandOutput,
  TransactWriteItemsCommandInput,
  TransactWriteItemsCommandOutput,
  UntagResourceCommandInput,
  UntagResourceCommandOutput,
  UpdateContinuousBackupsCommandInput,
  UpdateContinuousBackupsCommandOutput,
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
  UpdateTableCommandInput,
  UpdateTableCommandOutput,
  UpdateTimeToLiveCommandInput,
  UpdateTimeToLiveCommandOutput,
} from "@aws-sdk/client-dynamodb"
import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  CreateBackupCommand,
  CreateTableCommand,
  DeleteBackupCommand,
  DeleteItemCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeExportCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ExportTableToPointInTimeCommand,
  GetItemCommand,
  ListBackupsCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
  PutItemCommand,
  QueryCommand,
  RestoreTableFromBackupCommand,
  RestoreTableToPointInTimeCommand,
  ScanCommand,
  SearchVectorsCommand,
  TagResourceCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  UntagResourceCommand,
  UpdateContinuousBackupsCommand,
  UpdateItemCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb"
import {
  Compression,
  type Compressor,
  make as makeCompressionRegistry,
} from "@effect-dynamodb/schema/Compression.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { EmbedderService } from "@effect-dynamodb/schema/Embedder.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import type { EntityDefinition } from "@effect-dynamodb/schema/Entity.js"
import {
  DynamoError,
  DynamoValidationError,
  InternalServerError,
  isAwsInternalServerError,
  isAwsResourceNotFound,
  isAwsThrottling,
  isAwsValidationError,
  ResourceNotFoundError,
  ThrottlingError,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import {
  type CompositeKeyForm,
  compositeKeyFormKind,
  type KeyFormValueKind,
  keyFormValueKind,
  keyFormValueKindOf,
  makeCompositeDomainKeyForm,
  makeCompositeKeyForm,
  refuseInexact,
  toCompositeKeyRecord,
} from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import { makeDefaultCrypto } from "@effect-dynamodb/schema/internal/DefaultCrypto.js"
import type {
  EntityKeyType,
  IndexPkInput,
  IndexSkFields,
  IndexZOrderDimensions,
  IndexZOrderPrefix,
} from "@effect-dynamodb/schema/internal/EntityTypes.js"
import { getSchemaFields } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import * as ZOrderCurve from "@effect-dynamodb/schema/internal/ZOrderCurve.js"
import type { IndexDefinition } from "@effect-dynamodb/schema/KeyComposer.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import type {
  VectorIndexConfig,
  VectorIndexDefinition,
} from "@effect-dynamodb/schema/VectorIndex.js"
import {
  Config,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  type Schema,
  SchemaAST,
  type Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import type { Aggregate as AggregateType, BoundAggregate } from "./Aggregate.js"
import { bind as aggregateBind, ownershipConflict } from "./Aggregate.js"
import type { BoundEntity, Entity as EntityType } from "./Entity.js"
import { bind as entityBind, fromDefinition as entityFromDefinition } from "./Entity.js"
import {
  type BoundQueryConfig,
  BoundQueryImpl,
  collectionNaming,
  entityNaming,
  type RawSortKeyCondition,
  type WithinOptions,
} from "./internal/BoundQuery.js"
import {
  type BoundVectorQuery,
  type BoundVectorQueryConfig,
  makeBoundVectorQuery,
} from "./internal/BoundVectorQuery.js"
import * as Capacity from "./internal/Capacity.js"
import {
  acquireSdkClient,
  type ClientOptions,
  type ClientOptionsFromConfig,
  readClientOptions,
} from "./internal/ClientOptions.js"
import { redactCredentialRefusal } from "./internal/CredentialRefusal.js"
import { createConditionOps, type Expr, ExprTag } from "./internal/Expr.js"
import {
  codecRequirements,
  collectionPackedQueryOptions,
  entityPackedQueryOptions,
  type PackedAttributeGuard,
  unregisteredCodecError,
} from "./internal/Packed.js"
import { createPathBuilder, type PathModel } from "./internal/PathBuilder.js"
import {
  canonicalJson,
  compareUtf8,
  compositePlanner,
  type KeyRange,
  keyJustBelow,
  type RowCheck,
  type TupleSpace,
  zorderPlanner,
} from "./internal/RangePlanner.js"
import * as Rekey from "./internal/Rekey.js"
import {
  diagnoseFailure,
  explainDiagnosis,
  type SentTable,
  withCause,
} from "./internal/WriteDiagnosis.js"
import * as Query from "./Query.js"
import type { CreateTableOptions, RekeyOptions, RekeyReport, Table, TableConfig } from "./Table.js"
import { mergeVectorIndexes, definition as tableDefinition, toVectorIndexSpec } from "./Table.js"

/**
 * Upper-bound sentinel used when a `.where()` condition targets a sort key
 * composite that is NOT the last one. The composed operand is then only a
 * prefix of the stored key, so an inclusive upper bound has to be pushed past
 * every key in that composite value's subtree. `￿` is the highest
 * code point representable in a 3-byte UTF-8 sequence, which sorts above every
 * character DynamoDB key composition emits for the following segment.
 */
const SK_MAX_SENTINEL = KeyComposer.SORT_KEY_MAX

/**
 * A composite value's key text as key composition writes it: serialized,
 * cased and escaped (`KeyComposer.keyValueText`), so it sorts as the
 * cased value does.
 */
const valueText = (
  schema: DynamoSchema.DynamoSchema,
  casing: DynamoSchema.Casing,
  keyForm: unknown,
): string => KeyComposer.keyValueText(schema, keyForm, casing)

/** A sort key composite's segment as key composition writes it: `<name>_<value>`, cased. */
export const compositeSegment = (
  schema: DynamoSchema.DynamoSchema,
  casing: DynamoSchema.Casing,
  field: string,
  keyForm: unknown,
): string => `${DynamoSchema.applyCasing(field, casing)}_${valueText(schema, casing, keyForm)}`

/** `bound` with each operand mapped — into its key form, say. */
const mapBound = (
  bound: RawSortKeyCondition,
  f: (value: unknown) => unknown,
): RawSortKeyCondition => {
  if ("eq" in bound) return { eq: f(bound.eq) }
  if ("lt" in bound) return { lt: f(bound.lt) }
  if ("lte" in bound) return { lte: f(bound.lte) }
  if ("gt" in bound) return { gt: f(bound.gt) }
  if ("gte" in bound) return { gte: f(bound.gte) }
  if ("between" in bound) return { between: [f(bound.between[0]), f(bound.between[1])] }
  return { beginsWith: f(bound.beginsWith) }
}

/**
 * Does a composite's value satisfy `bound`, compared as key text (§11)? Key
 * forms. Escaped key text sorts as the cased value, so this is the order the
 * key condition reads in.
 */
const boundHolds = (
  schema: DynamoSchema.DynamoSchema,
  casing: DynamoSchema.Casing,
  bound: RawSortKeyCondition,
  keyForm: unknown,
): boolean => {
  const text = valueText(schema, casing, keyForm)
  const against = (operand: unknown) => compareUtf8(text, valueText(schema, casing, operand))
  if ("eq" in bound) return against(bound.eq) === 0
  if ("lt" in bound) return against(bound.lt) < 0
  if ("lte" in bound) return against(bound.lte) <= 0
  if ("gt" in bound) return against(bound.gt) > 0
  if ("gte" in bound) return against(bound.gte) >= 0
  if ("between" in bound) return against(bound.between[0]) >= 0 && against(bound.between[1]) <= 0
  // A number has no text prefix: `beginsWith` on a numeric composite is `eq`.
  const operand = bound.beginsWith
  return typeof operand === "number" || typeof operand === "bigint"
    ? against(operand) === 0
    : text.startsWith(valueText(schema, casing, operand))
}

/**
 * @internal Compose a bound on sort key composite `field` into a key condition, the
 * same way `put` composes the stored key: `prefixText` — the key text of
 * every composite before `field`, ending with the delimiter — then
 * `<name>_<value>`. Operands are already in key form.
 *
 * A stored SK is `$schema#v1#entity#<name>_<cased value>#...`; comparing a
 * raw operand against that is meaningless (issue #101 — `gte` matched the
 * whole partition because `"1-009" < "ballkey_…"`, while `begins_with` /
 * `between` matched nothing). So the operand is placed in the *position* of
 * the composite it targets and composed like the key, with `serializeValue`,
 * the `<name>_` prefix, the casing and the escaping.
 *
 * The condition is exact: a composite's key text is escaped
 * (`KeyComposer.keyText`), so it sorts as its value, and the delimiter
 * that follows it sorts below every character it holds — a value's subtree
 * (`v#…`) sorts after `v` itself and before every greater value (`v%20x`,
 * `v0`), whatever characters the values hold (#171).
 *
 * `clampToPrefix` keeps a one-sided bound inside `prefixText`: DynamoDB allows
 * one sort key condition, so once leading composites are pinned the open end
 * is clamped and the condition becomes a `BETWEEN`. A strict `lt` on the last
 * composite then ends at the greatest key text below the bound
 * (`keyJustBelow`), BETWEEN being inclusive.
 *
 * Shared by `.where()` and `.within()` (#171), so the two can't drift.
 */
export const composeRangeUnder = (
  index: {
    readonly schema: DynamoSchema.DynamoSchema
    readonly casing: DynamoSchema.Casing
    readonly isLast: boolean
    /** A secondary index: a row may be truncated at a value (`pinCondition`). */
    readonly secondary: boolean
  },
  prefixText: string,
  field: string,
  bound: RawSortKeyCondition,
  options: { readonly clampToPrefix: boolean },
): Query.SortKeyCondition => {
  // A missing operand composes the prefix alone, without its delimiter — as
  // `composeSortKeyPrefix` stops at the first missing composite.
  const compose = (value: unknown): string =>
    value === undefined || value === null
      ? prefixText.slice(0, -1)
      : `${prefixText}${compositeSegment(index.schema, index.casing, field, value)}`

  /**
   * `begins_with` operand matching exactly the keys whose composite equals
   * `value`: it stops on a segment boundary rather than leaking into sibling
   * values (`status_done` vs `status_done_archived`, #115).
   */
  const subtreeBeginsWith = (value: unknown): string =>
    `${compose(value)}${DynamoSchema.KEY_DELIMITER}`

  /**
   * A bound sorting strictly above every key whose composite is `value`, and
   * strictly below the first key of any greater value.
   *
   * The delimiter here is UNCONDITIONAL, including on the last composite:
   * `compose(v)￿` alone would sort below `compose(v + "0")`, which is a
   * strictly greater value that must stay inside a `gt`. `compose(v)#￿` sits
   * above `compose(v)` and below every longer value because `#` is lower than
   * every character a composite's escaped text holds.
   */
  const aboveSubtree = (value: unknown): string =>
    `${compose(value)}${DynamoSchema.KEY_DELIMITER}${SK_MAX_SENTINEL}`

  /** Inclusive upper bound covering the whole subtree of `value`. */
  const upper = (value: unknown): string => (index.isLast ? compose(value) : aboveSubtree(value))

  // `beginsWith` / `between` / `eq` carry the prefix in BOTH operands, so they
  // never escape it.
  if ("beginsWith" in bound) {
    // A number has no text prefix: its key text is not its digits (`-3` is
    // `-9999999999999996:`), and an integer's text prefixes its fractions'
    // (3 of 3.14). `beginsWith` on a numeric composite is `eq` — what it
    // amounted to up to 1.36 for non-negative integers, whose key text was
    // fixed-width.
    const operand = bound.beginsWith
    if (typeof operand === "number" || typeof operand === "bigint") {
      return composeRangeUnder(index, prefixText, field, { eq: operand }, options)
    }
    return { beginsWith: compose(operand) }
  }
  if ("eq" in bound) {
    if (index.isLast) return { eq: compose(bound.eq) }
    return index.secondary
      ? KeyComposer.pinCondition(index.schema, compose(bound.eq))
      : { beginsWith: subtreeBeginsWith(bound.eq) }
  }
  if ("between" in bound) {
    return { between: [compose(bound.between[0]), upper(bound.between[1])] }
  }

  // One-sided operators are open on the other side, which is exactly right
  // when nothing is clamped: the open end runs to the edge of the partition.
  if (!options.clampToPrefix) {
    if ("lt" in bound) return { lt: compose(bound.lt) }
    if ("lte" in bound) return { lte: upper(bound.lte) }
    // `>` is already exclusive of the composed value, so only a non-terminal
    // target needs the subtree pushed past.
    if ("gt" in bound) return { gt: index.isLast ? compose(bound.gt) : aboveSubtree(bound.gt) }
    return { gte: compose(bound.gte) }
  }

  const prefixMax = `${prefixText}${SK_MAX_SENTINEL}`
  if ("gte" in bound) return { between: [compose(bound.gte), prefixMax] }
  if ("gt" in bound) return { between: [aboveSubtree(bound.gt), prefixMax] }
  if ("lte" in bound) return { between: [prefixText, upper(bound.lte)] }
  // `lt`. On a non-terminal composite no stored key can equal the composed
  // bound (trailing composites always follow), so BETWEEN's inclusive high end
  // is harmless. On the LAST composite the bound IS a storable key: the high
  // end is the greatest key text below it (`EDD-9046` refused this bound up to
  // 1.36).
  const below = compose(bound.lt)
  return { between: [prefixText, index.isLast ? keyJustBelow(below) : below] }
}

/**
 * @internal A `.within()` bound on composite `field` — its lower and / or upper end —
 * composed under `prefixText` as {@link composeRangeUnder} composes each,
 * clamped to it: one `BETWEEN` of the lower end's start and the upper end's
 * end, or the one end given. `undefined` when no value satisfies both ends
 * (`{ gt: 3, lte: 3 }`, `{ gte: "b", lt: "a" }`), judged on the ends' key
 * text, which sorts as their values: nothing need be read, and the composed
 * ends could be reversed, which DynamoDB refuses.
 */
export const composeIntervalUnder = (
  index: {
    readonly schema: DynamoSchema.DynamoSchema
    readonly casing: DynamoSchema.Casing
    readonly isLast: boolean
    readonly secondary: boolean
  },
  prefixText: string,
  field: string,
  lower: RawSortKeyCondition | undefined,
  upper: RawSortKeyCondition | undefined,
): Query.SortKeyCondition | undefined => {
  const under = (bound: RawSortKeyCondition) =>
    composeRangeUnder(index, prefixText, field, bound, { clampToPrefix: true }) as {
      readonly between: readonly [string, string]
    }
  if (lower === undefined || upper === undefined) {
    const one = lower ?? upper
    if (one === undefined) throw new Error("[internal] A .within() range bound has no end.")
    return under(one)
  }
  const operand = (bound: RawSortKeyCondition) =>
    valueText(index.schema, index.casing, Object.values(bound)[0])
  const order = compareUtf8(operand(lower), operand(upper))
  if (order > 0 || (order === 0 && ("gt" in lower || "lt" in upper))) return undefined
  return { between: [under(lower).between[0], under(upper).between[1]] }
}

/** A composed sort key condition as a planned key range: only the forms a clamped bound composes. */
const keyRangeOf = (condition: Query.SortKeyCondition, exact: boolean): KeyRange => {
  if ("eq" in condition) return { lower: condition.eq, upper: condition.eq, exact }
  if ("between" in condition) {
    return { lower: condition.between[0], upper: condition.between[1], exact }
  }
  if ("beginsWith" in condition) {
    return { lower: undefined, upper: undefined, beginsWith: condition.beginsWith, exact }
  }
  throw new Error("[internal] .within() composed an unclamped sort key condition.")
}

// ---------------------------------------------------------------------------
// `.within()` on composite sort keys (#171, design §7)
// ---------------------------------------------------------------------------

/** A `.within()` bound on one composite, normalised; operands in key form. */
type CompositeBound =
  | { readonly _tag: "eq"; readonly value: unknown }
  | {
      readonly _tag: "range"
      readonly lower: RawSortKeyCondition | undefined
      readonly upper: RawSortKeyCondition | undefined
    }

const BOUND_OPERATORS: ReadonlySet<string> = new Set(["eq", "between", "gt", "gte", "lt", "lte"])

/**
 * How a row check reads a composite's key form from a raw row (§11): its
 * stored attribute — for a ref-derived `${ref}Id`, the referenced identifier
 * inside the stored ref, which is the value the key was composed from —
 * through the accessor's encoder for a numeric field stored as a string, so a
 * stored `"950000"` reads as `950000`. `undefined` when the row lacks it.
 */
const storedKeyForm = (
  args: {
    readonly entityLike: EntityLike
    readonly encoderSource: Schema.Top
    readonly compositeKeyForm: CompositeKeyForm
  },
  field: string,
): {
  readonly attribute: string
  readonly read: (row: Record<string, AttributeValue>) => unknown
} => {
  const resolve = args.entityLike._resolveDbName ?? ((name: string) => name)
  const ref = args.entityLike._resolvedRefs?.find((r) => r.idFieldName === field)
  const attribute = resolve(ref?.fieldName ?? field)
  const schema = getSchemaFields(args.encoderSource)?.[field]
  const wantsBigInt = schema !== undefined && SchemaAST.isBigInt(SchemaAST.toType(schema.ast))
  const typeNumeric = compositeKeyFormKind(args.encoderSource, field) === "type-numeric"
  return {
    attribute,
    read: (row) => {
      const value = ref === undefined ? row[attribute] : row[attribute]?.M?.[ref.identifierField]
      if (value === undefined) return undefined
      const stored = value.S ?? value.N
      if (typeNumeric && stored !== undefined) return args.compositeKeyForm(field, stored)
      if (value.S !== undefined) return value.S
      if (value.N !== undefined) return wantsBigInt ? BigInt(value.N) : Number(value.N)
      if (value.BOOL !== undefined) return value.BOOL
      return undefined
    },
  }
}

/** One field's per-row check (§11). */
interface FieldCheck {
  readonly field: string
  readonly attribute: string
  readonly accepts: (row: Record<string, AttributeValue>) => boolean
}

/**
 * A composite's per-row check (§11): its key form read from the raw row
 * ({@link storedKeyForm}), and `holds` asked of it; a row without it fails.
 */
const compositeCheck = (
  args: Parameters<typeof storedKeyForm>[0],
  field: string,
  holds: (keyForm: unknown) => boolean,
): FieldCheck => {
  const stored = storedKeyForm(args, field)
  return {
    field,
    attribute: stored.attribute,
    accepts: (row) => {
      const keyForm = stored.read(row)
      return keyForm !== undefined && holds(keyForm)
    },
  }
}

/** Field checks as one row check, every one of them passing; `undefined` for none. */
const combineRowChecks = (checks: ReadonlyArray<FieldCheck>): RowCheck | undefined =>
  checks.length === 0
    ? undefined
    : {
        fields: checks.map((check) => check.field),
        reads: [...new Set(checks.map((check) => check.attribute))],
        accepts: (row) => checks.every((check) => check.accepts(row)),
      }

/**
 * Plan `.within(bounds)` on a composite sort key accessor (design §7.1):
 *
 * - eq bounds right after the accessor's pins extend the prefix, like pins;
 * - a range bound on the next composite (or nothing else bounded) is the `key`
 *   plan — one key condition, composed as `.where()` composes it;
 * - otherwise the unbounded composites in between are the skip tuple:
 *   `skip-scan` when the tuple parse is sound (§7.3), else `filter`.
 *
 * Every bound the key condition can't express is checked per row (§11).
 * Misuse from untyped code throws `[EDD-9093]`; a value that doesn't reach
 * key form throws `[EDD-9050]` (the accessor's own encoder). `{}` plans
 * nothing: the query is returned as it is.
 */
const planCompositeWithin = <A>(args: {
  readonly entityLike: EntityLike
  readonly accessor: string
  readonly indexDef: IndexDefinition
  readonly encoderSource: Schema.Top
  readonly compositeKeyForm: CompositeKeyForm
  /** A bound's key form: the key form of the value `put` stores for it. */
  readonly domainKeyForm: CompositeKeyForm
  /** The accessor's composites, in key form. */
  readonly pinnedKeyForm: Record<string, unknown>
  readonly pkValue: string
  readonly query: Query.Query<A>
  readonly bounds: Record<string, unknown>
  readonly options: WithinOptions | undefined
}): Query.Query<A> => {
  const { entityLike, accessor, indexDef, domainKeyForm, pinnedKeyForm } = args
  const sk = indexDef.sk.composite
  const n = sk.length
  const p = sk.findIndex((attr) => pinnedKeyForm[attr] === undefined)
  const pinnedCount = p === -1 ? n : p
  const refuse = (why: string): never => {
    throw new Error(
      `[EDD-9093] .within() on index "${accessor}" of entity "${entityLike.entityType}": ${why}`,
    )
  }
  if (typeof args.bounds !== "object" || args.bounds === null || Array.isArray(args.bounds)) {
    return refuse("pass an object of bounds keyed by sort key composite.")
  }
  const open = sk.slice(pinnedCount)
  const fields = getSchemaFields(args.encoderSource)
  /** The ref a `${ref}Id` composite is derived from: the item stores the ref, not the id. */
  const refOf = (field: string) =>
    entityLike._resolvedRefs?.find((ref) => ref.idFieldName === field)
  /** The kind of value a composite's key form is, when its schema says (EDD-9093's type check). */
  const kindOf = (field: string): KeyFormValueKind | undefined => {
    const schema = fields?.[field]
    return schema === undefined ? undefined : keyFormValueKind(schema)
  }

  // -- validate and normalise (EDD-9093) --
  const bounds = new Map<number, CompositeBound>()
  for (const [field, raw] of Object.entries(args.bounds)) {
    if (raw === undefined) continue
    const i = sk.indexOf(field)
    if (i === -1) {
      return refuse(
        indexDef.pk.composite.includes(field)
          ? `"${field}" is a partition key composite: give it to the accessor.`
          : `"${field}" is not a sort key composite of the index. Bound one of: ${open.join(", ")}.`,
      )
    }
    if (i < pinnedCount) {
      return refuse(
        `"${field}" is already pinned by the accessor, so it can't also be bounded. Drop it ` +
          `from the accessor call to bound it here.`,
      )
    }
    if (
      refOf(field) === undefined &&
      compositeKeyFormKind(args.encoderSource, field) === "absent"
    ) {
      return refuse(
        `"${field}" is not stored on the item, so its bound can't be checked per row. Give ` +
          `it to the accessor, or bound it with .where().`,
      )
    }
    const shape = raw as Record<string, unknown>
    const operators =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? Object.keys(shape).filter((key) => shape[key] !== undefined)
        : []
    const between = shape?.between
    const wellFormed =
      operators.length > 0 &&
      operators.every((key) => BOUND_OPERATORS.has(key)) &&
      (operators.includes("eq") || operators.includes("between") ? operators.length === 1 : true) &&
      !(operators.includes("gt") && operators.includes("gte")) &&
      !(operators.includes("lt") && operators.includes("lte")) &&
      (between === undefined || (Array.isArray(between) && between.length === 2))
    if (!wellFormed) {
      return refuse(
        `the bound on "${field}" is not one of { eq }, { between: [low, high] }, or ` +
          `{ gt | gte } and / or { lt | lte }.`,
      )
    }
    const expected = kindOf(field)
    const keyForm = (value: unknown): unknown => {
      const converted = domainKeyForm(field, value)
      if (expected !== undefined && keyFormValueKindOf(converted) !== expected) {
        return refuse(
          `the bound on "${field}" is ${JSON.stringify(String(value))} (${typeof value}), but ` +
            `the composite's key form is a ${expected}.`,
        )
      }
      return converted
    }
    if (operators.includes("eq")) {
      bounds.set(i, { _tag: "eq", value: keyForm(shape.eq) })
      continue
    }
    const [low, high] = (between as ReadonlyArray<unknown> | undefined) ?? []
    bounds.set(i, {
      _tag: "range",
      lower:
        between !== undefined
          ? { gte: keyForm(low) }
          : "gt" in shape && shape.gt !== undefined
            ? { gt: keyForm(shape.gt) }
            : "gte" in shape && shape.gte !== undefined
              ? { gte: keyForm(shape.gte) }
              : undefined,
      upper:
        between !== undefined
          ? { lte: keyForm(high) }
          : "lt" in shape && shape.lt !== undefined
            ? { lt: keyForm(shape.lt) }
            : "lte" in shape && shape.lte !== undefined
              ? { lte: keyForm(shape.lte) }
              : undefined,
    })
  }
  if (bounds.size === 0) return args.query

  // -- composition --
  const casing = KeyComposer.effectiveCasing(entityLike._schema, indexDef)
  const segment = (i: number, keyForm: unknown) =>
    compositeSegment(entityLike._schema, casing, sk[i]!, keyForm)
  const label = (i: number) => `${DynamoSchema.applyCasing(sk[i]!, casing)}_`

  /**
   * Bound `i` composed under `prefixText`, clamped to it; `undefined` when no
   * value satisfies it (`{ gt: 3, lte: 3 }`).
   */
  const composeBound = (prefixText: string, i: number): Query.SortKeyCondition | undefined => {
    const bound = bounds.get(i)!
    const index = {
      schema: entityLike._schema,
      casing,
      isLast: i === n - 1,
      secondary: indexDef.index !== undefined,
    }
    return bound._tag === "eq"
      ? composeRangeUnder(index, prefixText, sk[i]!, { eq: bound.value }, { clampToPrefix: true })
      : composeIntervalUnder(index, prefixText, sk[i]!, bound.lower, bound.upper)
  }

  /** Does bound `i` hold for a composite value (key form), compared as key text? */
  const holds = (i: number, keyForm: unknown): boolean => {
    const bound = bounds.get(i)!
    if (bound._tag === "eq") {
      return boundHolds(entityLike._schema, casing, { eq: bound.value }, keyForm)
    }
    return (
      (bound.lower === undefined || boundHolds(entityLike._schema, casing, bound.lower, keyForm)) &&
      (bound.upper === undefined || boundHolds(entityLike._schema, casing, bound.upper, keyForm))
    )
  }

  /**
   * The key condition under `prefixText` from composite `from`: eq bounds
   * extend the prefix, then one range bound (or the prefix alone). Returns
   * the composites left to the row check.
   */
  const keyCondition = (
    prefixText: string,
    from: number,
  ): {
    readonly condition: Query.SortKeyCondition | undefined
    readonly checked: ReadonlyArray<number>
  } => {
    let q = prefixText
    let i = from
    while (i < n) {
      const bound = bounds.get(i)
      if (bound === undefined) break
      if (bound._tag === "eq" && i < n - 1) {
        q = `${q}${segment(i, bound.value)}${DynamoSchema.KEY_DELIMITER}`
        i++
        continue
      }
      return {
        condition: composeBound(q, i),
        checked: [...bounds.keys()].filter((j) => j > i),
      }
    }
    // The eq bounds end at a value with nothing after it bounded. On a secondary
    // index a row truncated there belongs too (`pinCondition`).
    return {
      condition:
        indexDef.index === undefined
          ? { beginsWith: q }
          : KeyComposer.pinCondition(entityLike._schema, q.slice(0, -1)),
      checked: [...bounds.keys()].filter((j) => j >= i),
    }
  }

  /**
   * Bounds checked on the raw row (§11): each composite's key text is
   * composed from the stored attribute — `serializeValue`, casing and
   * escaping, the composer's own path — and compared with the bound's key
   * text ({@link boundHolds}). Key text sorts as the value, so a row passes
   * exactly when the key condition would have admitted it, and the skip and
   * filter plans agree on every row. A ref-derived composite (`${ref}Id`) is
   * read from the stored ref: the referenced identifier inside its map, which
   * is the value the key was composed from.
   */
  const rowCheckFor = (indices: ReadonlyArray<number>): RowCheck | undefined =>
    combineRowChecks(
      [...indices]
        .sort((a, b) => a - b)
        .map((i) => compositeCheck(args, sk[i]!, (keyForm) => holds(i, keyForm))),
    )

  // -- plan choice (§7.1) --
  const prefix0 = KeyComposer.composeSortKeyBeginsWith(
    entityLike._schema,
    entityLike.entityType,
    1,
    indexDef,
    pinnedKeyForm,
  )
  let k = pinnedCount
  let P = prefix0
  while (k < n - 1 && bounds.get(k)?._tag === "eq") {
    P = `${P}${segment(k, (bounds.get(k) as { readonly value: unknown }).value)}${DynamoSchema.KEY_DELIMITER}`
    k++
  }
  let t = k
  while (t < n && !bounds.has(t)) t++
  const tupled = t < n && t > k
  const tupleFields = sk.slice(k, t)

  const fingerprint = {
    index: indexDef.index ?? "primary",
    entityType: entityLike.entityType,
    pk: args.pkValue,
    prefix: prefix0,
    bounds: [...bounds.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, bound]) =>
        bound._tag === "eq"
          ? [sk[i], "eq", segment(i, bound.value)]
          : [
              sk[i],
              bound.lower === undefined ? null : Object.keys(bound.lower)[0],
              bound.lower === undefined ? null : segment(i, Object.values(bound.lower)[0]),
              bound.upper === undefined ? null : Object.keys(bound.upper)[0],
              bound.upper === undefined ? null : segment(i, Object.values(bound.upper)[0]),
            ],
      ),
  }

  const inner = tupled ? keyCondition("", t) : keyCondition(prefix0, pinnedCount)
  const innerRowCheck = rowCheckFor(inner.checked)
  // No value satisfies some bound (`{ gt: 3, lte: 3 }`): nothing to read,
  // whatever the prefix it is composed under.
  const empty = [...bounds.keys()].some((i) => composeBound(prefix0, i) === undefined)
  const space: TupleSpace = tupled
    ? {
        _tag: "string",
        prefix: P,
        labels: tupleFields.map((_, j) => label(k + j)),
        next: label(t),
        fields: tupleFields,
      }
    : { _tag: "none" }
  // Any tuple composite parses soundly from the key text: escaped values
  // hold no delimiter (§7.3). History rows don't parse as tuples.
  const ineligible =
    tupled && indexDef.index === undefined && entityLike._liveRows?.() !== undefined
      ? "history rows on the primary index"
      : undefined

  return Query.plan(args.query, {
    planner: compositePlanner({
      entityType: entityLike.entityType,
      index: indexDef.index ?? "primary",
      pkField: indexDef.pk.field,
      pkValue: args.pkValue,
      skField: indexDef.sk.field,
      fingerprint,
      space,
      inner: {
        _tag: "single",
        conditionFor: (tuple) => {
          const { condition } = tupled
            ? keyCondition(tuple ?? P, t)
            : keyCondition(prefix0, pinnedCount)
          // An empty plan reads nothing, so it never asks for its range.
          if (condition === undefined) throw new Error("[internal] An empty plan has no range.")
          return keyRangeOf(condition, innerRowCheck === undefined)
        },
        rowCheck: innerRowCheck,
        empty,
      },
      filterPlan: {
        prefix: P,
        rowCheck: rowCheckFor([...bounds.keys()].filter((i) => i >= k)),
      },
      ineligible,
    }),
    maxSkips: args.options?.maxSkips,
  })
}

/** What a Z-order dimension bound may name: a composite's operators, and `in` (literals). */
const DIMENSION_OPERATORS: ReadonlySet<string> = new Set([...BOUND_OPERATORS, "in"])

/** The most operands DynamoDB's `IN` takes. */
const MAX_IN_OPERANDS = 100

/** How many Z-order range plans an accessor keeps (§5.4). */
const ZORDER_PLAN_CACHE = 64

/** The capped range plan of a box (§5.4), as an accessor caches it. */
type ZOrderPlans = (
  box: ZOrderCurve.Box,
  maxRanges: number,
  refineFactor: number,
) => ReturnType<typeof ZOrderCurve.plan>

/**
 * An accessor's LRU of Z-order range plans. A plan is a pure function of the
 * layout (the accessor's), the box and the cap, so a miss only recomputes —
 * no cursor depends on what is cached.
 */
const makeZOrderPlans = (layout: ZOrderCurve.Layout): ZOrderPlans => {
  const cache = new Map<string, ReturnType<typeof ZOrderCurve.plan>>()
  return (box, maxRanges, refineFactor) => {
    const key = canonicalJson({ box, maxRanges, refineFactor })
    const hit = cache.get(key)
    if (hit !== undefined) {
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
    const planned = ZOrderCurve.plan(layout, box, maxRanges, refineFactor)
    cache.set(key, planned)
    if (cache.size > ZORDER_PLAN_CACHE) cache.delete(cache.keys().next().value!)
    return planned
  }
}

/** A plain object of bound operators (not a value: a `Date` and a `DateTime` are values). */
const isBoundShape = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" &&
  u !== null &&
  !Array.isArray(u) &&
  !(u instanceof Date) &&
  !DateTime.isDateTime(u)

/** One end of a range bound; `strict` excludes the value itself. */
interface BoundEnd {
  readonly value: unknown
  readonly strict: boolean
}

/** A {@link BoundEnd} in a numeric unit: epoch milliseconds or stored seconds. */
interface NumericEnd extends BoundEnd {
  readonly value: number
}

/** The ends of a range bound (`eq` as both, inclusive). */
const boundEnds = (
  bound: Record<string, unknown>,
): { readonly lower: BoundEnd | undefined; readonly upper: BoundEnd | undefined } => {
  if ("eq" in bound && bound.eq !== undefined) {
    return { lower: { value: bound.eq, strict: false }, upper: { value: bound.eq, strict: false } }
  }
  const between = bound.between as readonly [unknown, unknown] | undefined
  if (between !== undefined) {
    return {
      lower: { value: between[0], strict: false },
      upper: { value: between[1], strict: false },
    }
  }
  return {
    lower:
      bound.gt !== undefined
        ? { value: bound.gt, strict: true }
        : bound.gte !== undefined
          ? { value: bound.gte, strict: false }
          : undefined,
    upper:
      bound.lt !== undefined
        ? { value: bound.lt, strict: true }
        : bound.lte !== undefined
          ? { value: bound.lte, strict: false }
          : undefined,
  }
}

/** Numbers and bigints in numeric order (`bigint` against `bigint` exactly). */
const compareNumeric = (a: unknown, b: unknown): number => {
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0
  const x = Number(a)
  const y = Number(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Does `value` lie between the ends, as `compare` orders them? */
const withinEnds = (
  value: unknown,
  lower: BoundEnd | undefined,
  upper: BoundEnd | undefined,
  compare: (a: unknown, b: unknown) => number,
): boolean => {
  if (lower !== undefined) {
    const order = compare(value, lower.value)
    if (Number.isNaN(order) || order < 0 || (order === 0 && lower.strict)) return false
  }
  if (upper !== undefined) {
    const order = compare(value, upper.value)
    if (Number.isNaN(order) || order > 0 || (order === 0 && upper.strict)) return false
  }
  return true
}

/**
 * Plan `.within(bounds)` on a Z-order accessor (design §3.3, §5, §7.5, §11):
 *
 * - each dimension bound is put into key form through the accessor's encoder
 *   and quantized into the box (an inverted bound is the empty box: nothing
 *   is sent);
 * - the given leading prefix composites are the key prefix `P`; from the first
 *   one left out, the prefix composites are a binary skip tuple, any given
 *   later one checked as each probed key is parsed;
 * - the exact bounds are a `FilterExpression` on the stored attributes where
 *   DynamoDB's comparison agrees with the dimension's order, and a row check
 *   where it doesn't (numbers stored as strings, zoned dates, a `literals`
 *   selection too large for `IN`) and for hashed prefix values (collisions).
 *
 * Throws `[EDD-9093]` for misuse from untyped code and `[EDD-9050]` for a value
 * that doesn't reach key form, at `.within()`, so every terminal (and `explain`)
 * has a valid box. A value no level holds throws `ZOrderValueError` (`[EDD-9092]`),
 * which `.within()` turns into the query's `ValidationError`. `{}` plans nothing:
 * the query is returned as it is.
 */
const planZOrderWithin = <A>(args: {
  readonly entityLike: EntityLike
  readonly accessor: string
  readonly indexDef: IndexDefinition
  readonly encoderSource: Schema.Top
  readonly compositeKeyForm: CompositeKeyForm
  /** A bound's key form: the key form of the value `put` stores for it. */
  readonly domainKeyForm: CompositeKeyForm
  readonly pkValue: string
  readonly plans: ZOrderPlans
  readonly query: Query.Query<A>
  readonly bounds: Record<string, unknown>
  readonly options: WithinOptions | undefined
}): Query.Query<A> => {
  const { entityLike, accessor, indexDef, domainKeyForm } = args
  const refuse = (why: string): never => {
    throw new Error(
      `[EDD-9093] .within() on index "${accessor}" of entity "${entityLike.entityType}": ${why}`,
    )
  }
  if (!KeyComposer.isZOrderHalf(indexDef.sk) || indexDef.sk.zorderHalf.layout === undefined) {
    throw new Error("[internal] A Z-order .within() reached a sort key that isn't bound.")
  }
  const { prefix } = indexDef.sk.zorderHalf
  const layout = indexDef.sk.zorderHalf.layout
  if (!isBoundShape(args.bounds)) {
    return refuse("pass an object of bounds keyed by dimension or prefix composite.")
  }
  const dimensions = layout.dimensions
  const named = [...prefix.map((part) => part.field), ...dimensions.map((dim) => dim.field)]
  const fields = getSchemaFields(args.encoderSource)
  /** `value` in the field's key form: `[EDD-9050]` from the encoder, `[EDD-9093]` for the wrong type. */
  const keyForm = (field: string, value: unknown): unknown => {
    const converted = domainKeyForm(field, value)
    const schema = fields?.[field]
    const expected = schema === undefined ? undefined : keyFormValueKind(schema)
    if (expected !== undefined && keyFormValueKindOf(converted) !== expected) {
      return refuse(
        `the bound on "${field}" is ${JSON.stringify(String(value))} (${typeof value}), but ` +
          `the field's key form is a ${expected}.`,
      )
    }
    return converted
  }

  // -- validate and normalise (EDD-9093) --
  const prefixValues = new Map<string, unknown>()
  const bounded = new Map<
    string,
    { readonly raw: Record<string, unknown>; readonly keyForm: Record<string, unknown> }
  >()
  for (const [field, raw] of Object.entries(args.bounds)) {
    if (raw === undefined) continue
    const shape = isBoundShape(raw) ? raw : undefined
    const operators =
      shape === undefined ? [] : Object.keys(shape).filter((key) => shape[key] !== undefined)
    if (prefix.some((part) => part.field === field)) {
      if (operators.some((key) => DIMENSION_OPERATORS.has(key))) {
        return refuse(
          `"${field}" is a prefix composite: it takes one exact value, not a range bound.`,
        )
      }
      prefixValues.set(field, keyForm(field, raw))
      continue
    }
    const dimension = dimensions.find((dim) => dim.field === field)
    if (dimension === undefined) {
      return refuse(
        indexDef.pk.composite.includes(field)
          ? `"${field}" is a partition key composite: give it to the accessor.`
          : `"${field}" is not a dimension or prefix composite of the index. Bound one of: ` +
              `${named.join(", ")}.`,
      )
    }
    const between = shape?.between
    const members = shape?.in
    const wellFormed =
      shape !== undefined &&
      operators.length > 0 &&
      operators.every((key) => DIMENSION_OPERATORS.has(key)) &&
      (["eq", "between", "in"].some((key) => operators.includes(key))
        ? operators.length === 1
        : true) &&
      !(operators.includes("gt") && operators.includes("gte")) &&
      !(operators.includes("lt") && operators.includes("lte")) &&
      (between === undefined || (Array.isArray(between) && between.length === 2)) &&
      (members === undefined || Array.isArray(members))
    if (!wellFormed) {
      return refuse(
        `the bound on "${field}" is not one of { eq }, { between: [low, high] }, { in: [...] } ` +
          `(a literals dimension), or { gt | gte } and / or { lt | lte }.`,
      )
    }
    if (members !== undefined && dimension.spec.kind !== "literals") {
      return refuse(
        `"in" bounds only a literals dimension, and "${field}" is ${dimension.spec.kind}.`,
      )
    }
    const converted: Record<string, unknown> = {}
    for (const key of operators) {
      converted[key] =
        key === "between" || key === "in"
          ? (shape![key] as ReadonlyArray<unknown>).map((value) => keyForm(field, value))
          : keyForm(field, shape![key])
    }
    bounded.set(field, { raw: shape!, keyForm: converted })
  }
  if (prefixValues.size === 0 && bounded.size === 0) return args.query

  /** A bound's epoch milliseconds: from the domain value when it has them, else its key form. */
  const epochMs = (dimension: ZOrderCurve.BoundDimension, raw: unknown, key: unknown): number =>
    DateTime.isDateTime(raw)
      ? DateTime.toEpochMillis(raw)
      : raw instanceof Date
        ? raw.getTime()
        : ZOrderCurve.epochMsOf(dimension.storage, key)
  /** Both ends of a bound: domain values and key forms side by side. */
  const endsOf = (field: string) => {
    const bound = bounded.get(field)!
    return { raw: boundEnds(bound.raw), key: boundEnds(bound.keyForm) }
  }
  /**
   * An `Epoch` dimension's ends in its stored unit, exactly (§11): a stored
   * second `s` stands for `s × 1000` ms, so each end is converted from the
   * bound's epoch milliseconds — never from its key form, which floors.
   */
  const storedEnds = (
    dimension: ZOrderCurve.BoundDimension,
    seconds: boolean,
  ): { readonly lower: NumericEnd | undefined; readonly upper: NumericEnd | undefined } => {
    const { raw, key } = endsOf(dimension.field)
    const convert = (end: "lower" | "upper"): NumericEnd | undefined => {
      const r = raw[end]
      const k = key[end]
      if (r === undefined || k === undefined) return undefined
      const ms = epochMs(dimension, r.value, k.value)
      if (!seconds) return { value: ms, strict: r.strict }
      const u = ms / 1000
      return end === "lower"
        ? { value: r.strict ? Math.floor(u) : Math.ceil(u), strict: r.strict }
        : { value: r.strict ? Math.ceil(u) : Math.floor(u), strict: r.strict }
    }
    return { lower: convert("lower"), upper: convert("upper") }
  }
  /**
   * The bound a dimension's levels are quantized from: its key form, except
   * on epoch seconds, where the key form of a sub-second end is floored. There
   * the whole stored seconds it holds decide the levels, and whether there are
   * any: `{ gte: T, lt: T + 500 ms }` holds the second `T`, `{ gt: T, lt: T + 1 s }`
   * none — inverted only once converted.
   */
  const quantizable = (dimension: ZOrderCurve.BoundDimension): ZOrderCurve.DimensionBound => {
    const keyForm = bounded.get(dimension.field)!.keyForm as ZOrderCurve.DimensionBound
    const storage = dimension.storage
    if (storage._tag !== "Epoch" || storage.unit !== "epochSeconds") return keyForm
    const { lower, upper } = storedEnds(dimension, true)
    return {
      ...(lower === undefined ? {} : { gte: lower.strict ? lower.value + 1 : lower.value }),
      ...(upper === undefined ? {} : { lte: upper.strict ? upper.value - 1 : upper.value }),
    }
  }

  // -- the box (§5.1) and each literals dimension's exact selection --
  const literalSelection = (
    dimension: ZOrderCurve.BoundDimension,
    bound: Record<string, unknown>,
  ): ReadonlyArray<number> => {
    const index = (value: unknown) => Number(dimension.quantize(value))
    if (bound.eq !== undefined) return [index(bound.eq)]
    if (bound.in !== undefined) {
      return [...new Set((bound.in as ReadonlyArray<unknown>).map(index))].sort((a, b) => a - b)
    }
    const between = bound.between as readonly [unknown, unknown] | undefined
    const lo =
      between !== undefined
        ? index(between[0])
        : bound.gt !== undefined
          ? index(bound.gt) + 1
          : bound.gte !== undefined
            ? index(bound.gte)
            : 0
    const hi =
      between !== undefined
        ? index(between[1])
        : bound.lt !== undefined
          ? index(bound.lt) - 1
          : bound.lte !== undefined
            ? index(bound.lte)
            : Number(dimension.levels) - 1
    return Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i)
  }
  const { box, selections } = (() => {
    const quantized = ZOrderCurve.quantizeBounds(
      layout,
      Object.fromEntries(
        dimensions
          .filter((dim) => bounded.has(dim.field))
          .map((dim) => [dim.field, quantizable(dim)]),
      ),
    )
    const selected = new Map(
      dimensions
        .filter((dim) => dim.spec.kind === "literals" && bounded.has(dim.field))
        .map((dim) => [dim.field, literalSelection(dim, bounded.get(dim.field)!.keyForm)]),
    )
    const none = [...selected.values()].some((members) => members.length === 0)
    return { box: none ? ("empty" as const) : quantized, selections: selected }
  })()

  // -- exact bounds (§11): a FilterExpression where DynamoDB's order agrees, else row checks --
  const path = (field: string) => ({ _tag: "path" as const, segments: [field] })
  const compare = (field: string, op: "eq" | "gt" | "gte" | "lt" | "lte", value: unknown): Expr =>
    ({
      [ExprTag]: ExprTag,
      _tag: op,
      left: path(field),
      right: { _tag: "value", value },
    }) as Expr
  const membership = (field: string, values: ReadonlyArray<unknown>): Expr =>
    ({
      [ExprTag]: ExprTag,
      _tag: "in",
      operand: path(field),
      values: values.map((value) => ({ _tag: "value", value })),
    }) as Expr
  const rangeFilter = (
    field: string,
    lower: BoundEnd | undefined,
    upper: BoundEnd | undefined,
  ): ReadonlyArray<Expr> =>
    lower !== undefined &&
    upper !== undefined &&
    !lower.strict &&
    !upper.strict &&
    lower.value === upper.value
      ? [compare(field, "eq", lower.value)]
      : [
          ...(lower === undefined
            ? []
            : [compare(field, lower.strict ? "gt" : "gte", lower.value)]),
          ...(upper === undefined
            ? []
            : [compare(field, upper.strict ? "lt" : "lte", upper.value)]),
        ]
  const filters: Array<Expr> = []
  const dimensionChecks: Array<FieldCheck> = []
  for (const dimension of dimensions) {
    const field = dimension.field
    if (!bounded.has(field)) continue
    const storage = dimension.storage
    if (storage._tag === "Literal") {
      const values = (dimension.spec as { readonly values: ReadonlyArray<unknown> }).values
      const selected = selections.get(field) ?? []
      if (selected.length === values.length) continue
      const chosen = new Set(selected.map((i) => values[i]))
      const complement = values.filter((value) => !chosen.has(value))
      if (chosen.size <= MAX_IN_OPERANDS) {
        filters.push(membership(field, [...chosen]))
      } else if (complement.length <= MAX_IN_OPERANDS) {
        // Exact: every item in the index carries the attribute (the half needs it).
        filters.push({
          [ExprTag]: ExprTag,
          _tag: "not",
          expr: membership(field, complement),
        } as Expr)
      } else {
        const stored = storedKeyForm(args, field)
        dimensionChecks.push({
          field,
          attribute: stored.attribute,
          accepts: (row) => chosen.has(stored.read(row)),
        })
      }
      continue
    }
    const { raw, key } = endsOf(field)
    switch (storage._tag) {
      case "Number":
      case "UtcIsoString":
      case "RawString":
        filters.push(...rangeFilter(field, key.lower, key.upper))
        break
      case "Epoch": {
        const stored = storedEnds(dimension, storage.unit === "epochSeconds")
        filters.push(...rangeFilter(field, stored.lower, stored.upper))
        break
      }
      case "NumericString": {
        // S order isn't numeric order: compared on the key form, per row.
        const stored = storedKeyForm(args, field)
        dimensionChecks.push({
          field,
          attribute: stored.attribute,
          accepts: (row) => {
            const value = stored.read(row)
            return value !== undefined && withinEnds(value, key.lower, key.upper, compareNumeric)
          },
        })
        break
      }
      case "ZonedIsoString": {
        // ISO strings with offsets don't sort chronologically: compared as epoch ms, per row.
        const stored = storedKeyForm(args, field)
        const toMs = (end: BoundEnd | undefined, k: BoundEnd | undefined): BoundEnd | undefined =>
          end === undefined || k === undefined
            ? undefined
            : { value: epochMs(dimension, end.value, k.value), strict: end.strict }
        const lower = toMs(raw.lower, key.lower)
        const upper = toMs(raw.upper, key.upper)
        dimensionChecks.push({
          field,
          attribute: stored.attribute,
          accepts: (row) => {
            const ms = ZOrderCurve.epochMsOf(storage, stored.read(row))
            return Number.isFinite(ms) && withinEnds(ms, lower, upper, compareNumeric)
          },
        })
        break
      }
    }
  }

  // -- the prefix (§4.3, §7.5) --
  const casing = KeyComposer.effectiveCasing(entityLike._schema, indexDef)
  const textOf = (value: unknown) => valueText(entityLike._schema, casing, value)
  const segmentOf = (part: KeyComposer.ZOrderPrefixSegment) =>
    ZOrderCurve.prefixSegment(textOf(prefixValues.get(part.field)), part.hash)
  /** A given prefix composite, checked on the cased value — never a hash, which can collide. */
  const prefixCheck = (part: KeyComposer.ZOrderPrefixSegment): FieldCheck => {
    const stored = storedKeyForm(args, part.field)
    const wanted = textOf(prefixValues.get(part.field))
    return {
      field: part.field,
      attribute: stored.attribute,
      accepts: (row) => {
        const value = stored.read(row)
        return value !== undefined && textOf(value) === wanted
      },
    }
  }
  const firstMissing = prefix.findIndex((part) => !prefixValues.has(part.field))
  const leading = firstMissing === -1 ? prefix : prefix.slice(0, firstMissing)
  const later = firstMissing === -1 ? [] : prefix.slice(firstMissing)
  const hashed = prefix.filter((part) => part.hash !== undefined && prefixValues.has(part.field))
  const parsedExactly = later.filter(
    (part) => part.hash === undefined && prefixValues.has(part.field),
  )

  const renameExpr = entityNaming(entityLike._resolveDbName).renameExpr ?? ((expr: Expr) => expr)
  const filter =
    filters.length === 0
      ? undefined
      : renameExpr(
          filters.length === 1
            ? filters[0]!
            : ({ [ExprTag]: ExprTag, _tag: "and", exprs: filters } as Expr),
        )

  return Query.plan(args.query, {
    planner: zorderPlanner({
      entityType: entityLike.entityType,
      index: indexDef.index ?? "primary",
      pkField: indexDef.pk.field,
      pkValue: args.pkValue,
      skField: indexDef.sk.field,
      fingerprint: {
        index: indexDef.index ?? "primary",
        entityType: entityLike.entityType,
        pk: args.pkValue,
        prefix: prefix.map((part) => [
          part.field,
          part.hash ?? null,
          prefixValues.has(part.field) ? textOf(prefixValues.get(part.field)) : null,
        ]),
        box,
        layout: dimensions.map((dim) => ({ spec: dim.spec, storage: dim.storage, bits: dim.bits })),
      },
      layout,
      box,
      bounded: bounded.size > 0,
      prefix: ZOrderCurve.concatBytes(leading.map((part) => segmentOf(part))),
      tuple: later.map((part) => ({
        field: part.field,
        hash: part.hash,
        given: prefixValues.has(part.field) ? segmentOf(part) : undefined,
      })),
      filter,
      rowCheck: combineRowChecks([...dimensionChecks, ...hashed.map(prefixCheck)]),
      filterRowCheck: combineRowChecks([
        ...dimensionChecks,
        ...hashed.map(prefixCheck),
        ...parsedExactly.map(prefixCheck),
      ]),
      ranges: (maxRanges, refineFactor) =>
        box === "empty" ? { ranges: [], exact: true } : args.plans(box, maxRanges, refineFactor),
    }),
    maxSkips: args.options?.maxSkips,
  })
}

/**
 * The key form of a caller's DOMAIN record for an arbitrary entity-like value —
 * the key `put` wrote for those values (`internal/CompositeCodec.ts`,
 * `makeCompositeDomainKeyForm`), as `Entity._domainKeyForm` composes it.
 */
const entityDomainKeyForm = (
  entityLike: { readonly model?: unknown; readonly schemas?: { readonly inputSchema?: unknown } },
  record: Record<string, unknown>,
): Record<string, unknown> => {
  const source = (entityLike.schemas?.inputSchema ?? entityLike.model) as Schema.Top | undefined
  if (source === undefined) return record
  const form = makeCompositeDomainKeyForm(source, (attr, value, reason) => {
    if (reason !== undefined) return refuseInexact(`Composite "${attr}"`, value, reason)
    throw new Error(
      `[EDD-9050] Composite "${attr}" could not be put into its key form: ` +
        `${JSON.stringify(String(value))} resolves under neither encode nor decode->encode.`,
    )
  })
  return toCompositeKeyRecord(form, record)
}

/**
 * Fail at bind time when a collection's members spell a shared PK composite
 * differently. See the call site for why picking one member is not an option.
 */
const assertCollectionKeyFormAgreement = (
  collName: string,
  members: ReadonlyArray<{ entityKey: string; entityLike: EntityLike; indexDef: IndexDefinition }>,
): void => {
  if (members.length < 2) return
  const attrs = new Set<string>()
  for (const m of members) for (const attr of m.indexDef.pk.composite) attrs.add(attr)
  for (const attr of attrs) {
    // `absent` and `identity` are the SAME behaviour — both pass the value
    // through untouched — so a member that simply does not declare the
    // attribute (a ref-derived id, or an index whose composite list differs)
    // is not in conflict. Only a genuine difference in how the value is
    // transformed is. This catches identity-vs-transformed and
    // numeric-Type-vs-encoded; two DIFFERENT encoded transforms of the same
    // kind still classify alike and are not detected here.
    const kinds = members
      .filter((m) => m.indexDef.pk.composite.includes(attr))
      .map((m) => {
        const kind = compositeKeyFormKind(
          (m.entityLike.schemas.inputSchema ?? m.entityLike.model) as Schema.Top,
          attr,
        )
        return { entityKey: m.entityKey, kind: kind === "absent" ? "identity" : kind }
      })
    const distinct = new Set(kinds.map((k) => k.kind))
    if (distinct.size > 1) {
      const detail = kinds.map((k) => `${k.entityKey}: ${k.kind}`).join(", ")
      throw new Error(
        `[EDD-9050] Collection "${collName}" members disagree on how the partition key ` +
          `composite "${attr}" is composed into a key (${detail}). They share one physical ` +
          `index, so rows written under different forms can never match — align the ` +
          `attribute's schema across the member models.`,
      )
    }
  }
}

/** Union of all DynamoDB client error types */
export type DynamoClientError =
  | DynamoError
  | ThrottlingError
  | DynamoValidationError
  | InternalServerError
  | ResourceNotFoundError

/**
 * Service interface for DynamoDB operations. Each method wraps a single
 * AWS SDK command and returns `Effect<Output, DynamoError>`.
 */
export interface DynamoClientService {
  /** Create a DynamoDB table. */
  readonly createTable: (
    input: CreateTableCommandInput,
  ) => Effect.Effect<CreateTableCommandOutput, DynamoClientError>

  /** Delete a DynamoDB table. */
  readonly deleteTable: (
    input: DeleteTableCommandInput,
  ) => Effect.Effect<DeleteTableCommandOutput, DynamoClientError>

  /** Describe a DynamoDB table (status, stream specification, etc.). */
  readonly describeTable: (
    input: DescribeTableCommandInput,
  ) => Effect.Effect<DescribeTableCommandOutput, DynamoClientError>

  /** Put a single item. */
  readonly putItem: (
    input: PutItemCommandInput,
  ) => Effect.Effect<PutItemCommandOutput, DynamoClientError>

  /** Get a single item by key. */
  readonly getItem: (
    input: GetItemCommandInput,
  ) => Effect.Effect<GetItemCommandOutput, DynamoClientError>

  /** Delete a single item by key. */
  readonly deleteItem: (
    input: DeleteItemCommandInput,
  ) => Effect.Effect<DeleteItemCommandOutput, DynamoClientError>

  /** Update a single item with an update expression. */
  readonly updateItem: (
    input: UpdateItemCommandInput,
  ) => Effect.Effect<UpdateItemCommandOutput, DynamoClientError>

  /** Execute a query against a table or index. */
  readonly query: (input: QueryCommandInput) => Effect.Effect<QueryCommandOutput, DynamoClientError>

  /** Execute a scan against a table or index. */
  readonly scan: (input: ScanCommandInput) => Effect.Effect<ScanCommandOutput, DynamoClientError>

  /**
   * Approximate-nearest-neighbour search against a vector index.
   *
   * Endpoint routing to `search-dynamodb.{region}.amazonaws.com` is handled by
   * the standard SDK client's endpoint ruleset (an explicit `endpoint` override
   * wins), so there is no second client to configure. The operation requires the
   * `dynamodb:SearchVectors` IAM action — existing read policies do NOT cover it.
   *
   * DynamoDB Local does not implement this operation; use
   * `VectorSearchEmulation.layer` for local testing.
   */
  readonly searchVectors: (
    input: SearchVectorsCommandInput,
  ) => Effect.Effect<SearchVectorsCommandOutput, DynamoClientError>

  /** Batch-get up to 100 items in a single request. */
  readonly batchGetItem: (
    input: BatchGetItemCommandInput,
  ) => Effect.Effect<BatchGetItemCommandOutput, DynamoClientError>

  /** Batch-write up to 25 items (puts and deletes) in a single request. */
  readonly batchWriteItem: (
    input: BatchWriteItemCommandInput,
  ) => Effect.Effect<BatchWriteItemCommandOutput, DynamoClientError>

  /** Atomically get up to 100 items across tables. */
  readonly transactGetItems: (
    input: TransactGetItemsCommandInput,
  ) => Effect.Effect<TransactGetItemsCommandOutput, DynamoClientError>

  /** Atomically write up to 100 items across tables (2x WCU cost). */
  readonly transactWriteItems: (
    input: TransactWriteItemsCommandInput,
  ) => Effect.Effect<TransactWriteItemsCommandOutput, DynamoClientError>

  // --- Table management ---

  /** Update table settings (provisioned throughput, GSIs, etc.). */
  readonly updateTable: (
    input: UpdateTableCommandInput,
  ) => Effect.Effect<UpdateTableCommandOutput, DynamoClientError>

  /** List all tables. */
  readonly listTables: (
    input: ListTablesCommandInput,
  ) => Effect.Effect<ListTablesCommandOutput, DynamoClientError>

  // --- Backup ---

  /** Create an on-demand backup. */
  readonly createBackup: (
    input: CreateBackupCommandInput,
  ) => Effect.Effect<CreateBackupCommandOutput, DynamoClientError>

  /** Delete a backup. */
  readonly deleteBackup: (
    input: DeleteBackupCommandInput,
  ) => Effect.Effect<DeleteBackupCommandOutput, DynamoClientError>

  /** List backups. */
  readonly listBackups: (
    input: ListBackupsCommandInput,
  ) => Effect.Effect<ListBackupsCommandOutput, DynamoClientError>

  /** Restore a table from a backup. */
  readonly restoreTableFromBackup: (
    input: RestoreTableFromBackupCommandInput,
  ) => Effect.Effect<RestoreTableFromBackupCommandOutput, DynamoClientError>

  // --- Point-in-Time Recovery ---

  /** Describe continuous backups (PITR) settings. */
  readonly describeContinuousBackups: (
    input: DescribeContinuousBackupsCommandInput,
  ) => Effect.Effect<DescribeContinuousBackupsCommandOutput, DynamoClientError>

  /** Enable or disable PITR. */
  readonly updateContinuousBackups: (
    input: UpdateContinuousBackupsCommandInput,
  ) => Effect.Effect<UpdateContinuousBackupsCommandOutput, DynamoClientError>

  /** Restore a table to a point in time. */
  readonly restoreTableToPointInTime: (
    input: RestoreTableToPointInTimeCommandInput,
  ) => Effect.Effect<RestoreTableToPointInTimeCommandOutput, DynamoClientError>

  // --- Export ---

  /** Export table to S3 (point-in-time snapshot). */
  readonly exportTableToPointInTime: (
    input: ExportTableToPointInTimeCommandInput,
  ) => Effect.Effect<ExportTableToPointInTimeCommandOutput, DynamoClientError>

  /** Describe an export. */
  readonly describeExport: (
    input: DescribeExportCommandInput,
  ) => Effect.Effect<DescribeExportCommandOutput, DynamoClientError>

  // --- TTL ---

  /** Update TTL settings for a table. */
  readonly updateTimeToLive: (
    input: UpdateTimeToLiveCommandInput,
  ) => Effect.Effect<UpdateTimeToLiveCommandOutput, DynamoClientError>

  /** Describe TTL settings for a table. */
  readonly describeTimeToLive: (
    input: DescribeTimeToLiveCommandInput,
  ) => Effect.Effect<DescribeTimeToLiveCommandOutput, DynamoClientError>

  // --- Tags ---

  /** Tag a DynamoDB resource. */
  readonly tagResource: (
    input: TagResourceCommandInput,
  ) => Effect.Effect<TagResourceCommandOutput, DynamoClientError>

  /** Remove tags from a DynamoDB resource. */
  readonly untagResource: (
    input: UntagResourceCommandInput,
  ) => Effect.Effect<UntagResourceCommandOutput, DynamoClientError>

  /** List tags on a DynamoDB resource. */
  readonly listTagsOfResource: (
    input: ListTagsOfResourceCommandInput,
  ) => Effect.Effect<ListTagsOfResourceCommandOutput, DynamoClientError>
}

/** Static client configuration accepted by {@link DynamoClient.layer}. */
type ClientConfig = ClientOptions & {
  readonly region: string
  readonly endpoint?: string | undefined
  readonly credentials?:
    | { readonly accessKeyId: string; readonly secretAccessKey: string }
    | undefined
}

/** Config-provider client configuration accepted by {@link DynamoClient.layerConfig}. */
type ClientConfigFromConfig = ClientOptionsFromConfig & {
  readonly region: Config.Config<string>
  readonly endpoint?: Config.Config<string> | undefined
  readonly credentials?:
    | Config.Config<{ readonly accessKeyId: string; readonly secretAccessKey: string }>
    | undefined
}

/**
 * Add the `Compression` service built from `compressors` beside a client
 * layer. The registry is validated (EDD-9078) when the layer is constructed.
 */
const withCompressors = <E>(
  client: Layer.Layer<DynamoClient, E>,
  compressors: ReadonlyArray<Compressor> | undefined,
): Layer.Layer<DynamoClient, E> | Layer.Layer<DynamoClient | Compression, E> =>
  compressors === undefined
    ? client
    : Layer.merge(client, Layer.succeed(Compression, makeCompressionRegistry(compressors)))

/**
 * Effect Context.Service for the DynamoDB client service.
 *
 * Use `DynamoClient.layer(config)` to construct a live Layer that manages
 * the underlying AWS SDK client lifecycle with `Effect.acquireRelease`.
 *
 * @example
 * ```typescript
 * const live = DynamoClient.layer({ region: "us-east-1" })
 * pipe(program, Effect.provide(live), Effect.runPromise)
 * ```
 */
export class DynamoClient extends Context.Service<DynamoClient, DynamoClientService>()(
  "@effect-dynamodb/DynamoClient",
) {
  /**
   * Create a live Layer that manages an AWS DynamoDBClient.
   *
   * @param config.region - AWS region
   * @param config.endpoint - Optional endpoint override (e.g., for DynamoDB Local)
   * @param config.credentials - Optional static credentials
   * @param config.requestHandler - Optional HTTP handler, or the options of the
   *   runtime's handler (`{ socketTimeout: 5000 }`), passed to the SDK client.
   *   None is set by default, so without one a connection that stays open and
   *   never answers keeps a call waiting until it is interrupted. A handler you
   *   pass is destroyed with the layer.
   * @param config.maxAttempts - Optional attempts per request, the first
   *   included, passed to the SDK client (its default is 3)
   * @param config.compressors - Optional compressors for packed storage
   *   (`DynamoModel.Packed` with `compression`). When given, the layer also
   *   provides the `Compression` service built from them. That reaches whatever
   *   this layer is merged with — but not past a wrapper that consumes it
   *   through `Layer.provide` (a decorated client, say), whose output is only
   *   `DynamoClient`. Prefer a separate `Compression.layer([...])` merged into
   *   the application layer, which works however the client is composed.
   *
   * @example
   * ```typescript
   * import * as ZlibCompression from "effect-dynamodb/compression/zlib"
   * // Recommended: the compressors as their own layer, beside the client
   * const AppLayer = Layer.mergeAll(
   *   DynamoClient.layer({ region: "us-east-1" }),
   *   Compression.layer([ZlibCompression.zstd()]),
   * )
   * // Also works, when this layer is used directly:
   * const live = DynamoClient.layer({ region: "us-east-1", compressors: [ZlibCompression.zstd()] })
   * ```
   */
  static readonly layer: {
    (
      config: ClientConfig & { readonly compressors: ReadonlyArray<Compressor> },
    ): Layer.Layer<DynamoClient | Compression>
    (config: ClientConfig & { readonly compressors?: undefined }): Layer.Layer<DynamoClient>
    (
      config: ClientConfig & { readonly compressors?: ReadonlyArray<Compressor> | undefined },
    ): Layer.Layer<DynamoClient>
  } = (config: ClientConfig & { readonly compressors?: ReadonlyArray<Compressor> | undefined }) =>
    withCompressors(
      Layer.effect(
        DynamoClient,
        buildService(config.region, config.endpoint, config.credentials, config),
      ),
      config.compressors,
    ) as never

  /**
   * Create a live Layer that reads configuration from Effect Config providers
   * (e.g., environment variables, config files).
   *
   * @param config.region - Config for AWS region
   * @param config.endpoint - Optional Config for endpoint override
   * @param config.credentials - Optional Config for static credentials
   * @param config.requestHandler - Optional Config for each of the handler's
   *   timeouts (`connectionTimeout`, `socketTimeout`, `requestTimeout`,
   *   `throwOnRequestTimeout`), which an operator tunes per environment, or an
   *   HTTP handler, which is code and is passed as itself. A timeout missing
   *   from the provider stays unset.
   * @param config.maxAttempts - Optional Config for the attempts per request
   * @param config.compressors - Optional compressors for packed storage; when
   *   given, the layer also provides the `Compression` service (see {@link layer}
   *   for why a separate `Compression.layer([...])` is the recommended form).
   */
  static readonly layerConfig: {
    (
      config: ClientConfigFromConfig & { readonly compressors: ReadonlyArray<Compressor> },
    ): Layer.Layer<DynamoClient | Compression, Config.ConfigError>
    (
      config: ClientConfigFromConfig & { readonly compressors?: undefined },
    ): Layer.Layer<DynamoClient, Config.ConfigError>
    (
      config: ClientConfigFromConfig & {
        readonly compressors?: ReadonlyArray<Compressor> | undefined
      },
    ): Layer.Layer<DynamoClient, Config.ConfigError>
  } = (
    config: ClientConfigFromConfig & {
      readonly compressors?: ReadonlyArray<Compressor> | undefined
    },
  ) =>
    withCompressors(
      Layer.effect(
        DynamoClient,
        Effect.gen(function* () {
          const region = yield* config.region
          const endpoint = config.endpoint ? yield* Config.option(config.endpoint) : undefined
          const credentials = config.credentials
            ? yield* Config.option(config.credentials)
            : undefined
          const options = yield* readClientOptions(config)
          return yield* buildService(
            region,
            endpoint && endpoint._tag === "Some" ? endpoint.value : undefined,
            credentials && credentials._tag === "Some" ? credentials.value : undefined,
            options,
          )
        }),
      ),
      config.compressors,
    ) as never

  /**
   * Create a typed client gateway from entities, aggregates, and (optionally) tables.
   *
   * Returns a namespaced client with `entities`, `aggregates`, `collections`, and
   * `tables` properties. Collections are auto-discovered from entity index
   * `collection` properties — no separate registration needed.
   *
   * @example
   * ```typescript
   * const db = yield* DynamoClient.make({
   *   entities: { Users, Tasks },
   *   aggregates: { OrderAggregate },
   *   tables: { MainTable },
   * })
   *
   * yield* db.entities.Users.get({ userId: "123" })
   * yield* db.aggregates.OrderAggregate.get({ orderId: "o-1" })
   * yield* db.collections.assignments({ userId: "123" }).collect()
   * yield* db.tables.MainTable.create()
   * ```
   */
  static readonly make: {
    <
      TEntities extends Record<string, { readonly _tag: "Entity" }>,
      TAggregates extends Record<string, AggregateType<any, any, any, any>>,
      TTables extends Record<string, TableLike>,
    >(config: {
      readonly entities: TEntities
      readonly aggregates: TAggregates
      readonly tables: TTables
      readonly crypto?: SecureRandom.SecureRandom["Service"]
      readonly embedder?: EmbedderService
      readonly compressors?: ReadonlyArray<Compressor>
    }): Effect.Effect<
      TypedClient<TEntities, TAggregates, TTables>,
      never,
      DynamoClient | TableConfig
    >

    <
      TEntities extends Record<string, { readonly _tag: "Entity" }>,
      TAggregates extends Record<string, AggregateType<any, any, any, any>>,
    >(config: {
      readonly entities: TEntities
      readonly aggregates: TAggregates
      readonly crypto?: SecureRandom.SecureRandom["Service"]
      readonly embedder?: EmbedderService
      readonly compressors?: ReadonlyArray<Compressor>
    }): Effect.Effect<
      TypedClient<TEntities, TAggregates, Record<string, TableLike>>,
      never,
      DynamoClient | TableConfig
    >

    <
      TEntities extends Record<string, { readonly _tag: "Entity" }>,
      TTables extends Record<string, TableLike>,
    >(config: {
      readonly entities: TEntities
      readonly tables: TTables
      readonly crypto?: SecureRandom.SecureRandom["Service"]
      readonly embedder?: EmbedderService
      readonly compressors?: ReadonlyArray<Compressor>
    }): Effect.Effect<
      TypedClient<TEntities, Record<string, never>, TTables>,
      never,
      DynamoClient | TableConfig
    >

    <TEntities extends Record<string, { readonly _tag: "Entity" }>>(config: {
      readonly entities: TEntities
      readonly crypto?: SecureRandom.SecureRandom["Service"]
      readonly embedder?: EmbedderService
      readonly compressors?: ReadonlyArray<Compressor>
    }): Effect.Effect<
      TypedClient<TEntities, Record<string, never>, Record<string, TableLike>>,
      never,
      DynamoClient | TableConfig
    >
  } = (config: any): any => makeFromConfig(config)
}

// ---------------------------------------------------------------------------
// TypedClient — mapped type for DynamoClient.make() return value
// ---------------------------------------------------------------------------

/** Minimal structural type for tables used in DynamoClient.make() config. */
export interface TableLike {
  readonly _tag: "Table"
  readonly schema: import("@effect-dynamodb/schema/DynamoSchema.js").DynamoSchema
  readonly entities: Record<string, { readonly _tag: "Entity" }>
  readonly aggregates: Record<string, unknown>
  readonly Tag: Context.Service<TableConfig, TableConfig>
}

/**
 * One item a collection's `paginate()` streams: the member it belongs to (the
 * key `collect()` groups it under) and the item.
 */
export type CollectionStreamItem<TResult> = {
  readonly [K in keyof TResult]: {
    readonly member: K
    readonly item: TResult[K] extends ReadonlyArray<infer A> ? A : unknown
  }
}[keyof TResult]

/** A collection's grouped result after `select`: partial records per member. */
export type CollectionSelected<TResult> = {
  readonly [K in keyof TResult]: Array<Record<string, unknown>>
}

/**
 * Collection query — returned by `db.collections.Name(composites)`.
 * `.collect()` and `.fetch()` return the grouped result (not an array);
 * `.paginate()` streams each item tagged with its member.
 */
export interface CollectionQuery<TResult> {
  /** Execute and collect all pages into a grouped result. */
  readonly collect: () => Effect.Effect<TResult, DynamoClientError | ValidationError, never>
  /**
   * Execute a single page, grouped like `collect()`, with the cursor of the
   * next page (`None` when there are no more results).
   */
  readonly fetch: () => Effect.Effect<
    { readonly items: TResult; readonly cursor: Option.Option<string> },
    DynamoClientError | ValidationError,
    never
  >
  /** Stream every item, page by page, each tagged with its member. */
  readonly paginate: () => Stream.Stream<
    CollectionStreamItem<TResult>,
    DynamoClientError | ValidationError,
    never
  >
  /** Count the members' items (every member's, together). */
  readonly count: () => Effect.Effect<number, DynamoClientError | ValidationError, never>
  /** Describe the query without sending anything (see `Query.explain`). */
  readonly explain: () => Effect.Effect<Query.QueryExplain, never, never>
  /**
   * Project attributes — by domain name, per member: each member's items come
   * back as partial records under its key.
   */
  readonly select: (
    attributes:
      | ReadonlyArray<string>
      | ((
          t: import("./internal/PathBuilder.js").PathBuilder<unknown, unknown, never>,
        ) => ReadonlyArray<import("./internal/PathBuilder.js").Path<unknown, any, any>>),
  ) => CollectionQuery<CollectionSelected<TResult>>
  /** Add a filter expression (post-read). */
  readonly filter: {
    (
      fn: (
        t: import("./internal/PathBuilder.js").PathBuilder<unknown, unknown, never>,
        ops: import("./internal/Expr.js").ConditionOps<unknown>,
      ) => import("./internal/Expr.js").Expr,
    ): CollectionQuery<TResult>
    (shorthand: import("./internal/Expr.js").ConditionShorthand): CollectionQuery<TResult>
  }
  /**
   * Return at most `n` items (a contract on results, not on round trips).
   * Under a filter, each request is sized from the observed pass rate.
   */
  readonly limit: (n: number) => CollectionQuery<TResult>
  /**
   * Fetch in batches of `n` rows — sets DynamoDB's `Limit`. `"natural"` sizes
   * requests exactly as 1.36 did.
   */
  readonly pageSize: (size: number | "natural") => CollectionQuery<TResult>
  /** Run `observer` after every request a terminal sends (see `Query.onRequest`). */
  readonly onRequest: (
    observer: (event: Query.QueryRequestEvent) => Effect.Effect<void>,
  ) => CollectionQuery<TResult>
  /** Reverse sort order. */
  readonly reverse: () => CollectionQuery<TResult>
  /** Resume from cursor. */
  readonly startFrom: (cursor: string) => CollectionQuery<TResult>
  /** Stop after `n` DynamoDB requests. */
  readonly maxPages: (n: number) => CollectionQuery<TResult>
  /** Requests a sharded collection sends at once (#183); default one per partition. */
  readonly concurrency: (n: number) => CollectionQuery<TResult>
  /**
   * Strongly consistent reads. A collection over a GSI — every auto-discovered
   * one — is refused with a `ValidationError` when it runs: DynamoDB reads a
   * GSI only eventually consistently.
   */
  readonly consistentRead: () => CollectionQuery<TResult>
  /**
   * Skip the `__edd_e__` ownership filter. Rows of no member are still never
   * returned as a member's items.
   */
  readonly ignoreOwnership: () => CollectionQuery<TResult>
}

/**
 * Typed client returned by `DynamoClient.make({ entities, aggregates?, tables? })`.
 * Namespaced under `entities`, `aggregates`, `collections`, and `tables`.
 * Collections are auto-discovered from entity index `collection` properties.
 */
export type TypedClient<
  TEntities extends Record<string, { readonly _tag: "Entity" }>,
  TAggregates extends Record<string, AggregateType<any, any, any, any>> = Record<string, never>,
  TTables extends Record<string, TableLike> = Record<string, TableLike>,
> = {
  /**
   * Bound entities with CRUD + query accessors for each index.
   *
   * A member may be a runtime `Entity` (authored with `effect-dynamodb`'s
   * `Entity.make`) OR a pure `EntityDefinition` (authored with
   * `@effect-dynamodb/schema`'s `Entity.make` — the AWS-free contract surface).
   * Both carry the same 11 type parameters, so both map to the same bound shape,
   * and both branches forward the inferred refs `R` — the two packages now share
   * one structural `AnyRefValue` (`entity: RefEntity`), so ref-derived composite
   * types (e.g. `${field}Id`) survive into the bound client for either authoring
   * style. `make()` promotes pure definitions (and their ref targets) to runtime
   * entities at bind time, so the type and runtime agree.
   */
  readonly entities: {
    readonly [K in keyof TEntities]: TEntities[K] extends EntityType<
      infer M,
      any,
      infer I,
      infer Ts,
      infer V,
      any,
      any,
      infer R,
      any,
      infer TS,
      infer GenId,
      infer VI,
      infer P,
      infer Un
    >
      ? Resolve<
          BoundEntity<M, I, R, ResolveKey<M, I>, TS, Ts, V, GenId, VI, P, Un> & {
            /** Scan this entity. Returns a BoundQuery for building scan queries. */
            readonly scan: () => import("./internal/BoundQuery.js").BoundQuery<
              PathModel<Schema.Schema.Type<M>, P>,
              never,
              Schema.Schema.Type<M>
            >
          } & EntityIndexAccessors<M, I, R, P> &
            EntityVectorAccessors<M, VI>
        >
      : TEntities[K] extends EntityDefinition<
            infer M,
            any,
            infer I,
            infer Ts,
            infer V,
            any,
            any,
            infer R,
            any,
            infer TS,
            infer GenId,
            infer VI,
            infer P,
            infer Un
          >
        ? Resolve<
            BoundEntity<M, I, R, ResolveKey<M, I>, TS, Ts, V, GenId, VI, P, Un> & {
              /** Scan this entity. Returns a BoundQuery for building scan queries. */
              readonly scan: () => import("./internal/BoundQuery.js").BoundQuery<
                PathModel<Schema.Schema.Type<M>, P>,
                never,
                Schema.Schema.Type<M>
              >
            } & EntityIndexAccessors<M, I, R, P> &
              EntityVectorAccessors<M, VI>
          >
        : never
  }

  /** Bound aggregates with CRUD + list operations (R = never). */
  readonly aggregates: {
    readonly [K in keyof TAggregates]: TAggregates[K] extends AggregateType<
      infer S,
      infer TKey,
      infer TInput,
      infer TCreate
    >
      ? BoundAggregate<S, TKey, TInput, TCreate>
      : never
  }

  /**
   * Collection accessors — auto-discovered from entity index `collection` properties.
   * Access by collection name: `db.collections.assignments({ employee: "x" }).collect()`
   *
   * Each accessor returns a `CollectionQuery` with grouped results keyed by entity name.
   * Type safety for collection results requires explicit type annotation at the call site.
   */
  readonly collections: {
    readonly [K: string]: (composites: Record<string, unknown>) => CollectionQuery<any>
  }

  /** Table operations keyed by table record keys. */
  readonly tables: {
    readonly [K in keyof TTables]: TableOperations
  }
}

/**
 * Collection accessors interface. Uses an interface (not mapped type) so that
 * `noUncheckedIndexedAccess` does not add `| undefined` to each access.
 * Collections are auto-discovered from entity index `collection` properties
 * and guaranteed to exist at runtime.
 */
export interface CollectionAccessors {
  [collectionName: string]: (
    composites: Record<string, unknown>,
  ) => CollectionQuery<Record<string, unknown[]>>
}

/** Force TypeScript to resolve an interface/intersection into a plain object for clean hover display */
type Resolve<T> = { [K in keyof T]: T[K] }

/** Resolve EntityKeyType into a plain object type for clean hover display.
 * Uses conditional type to force eager evaluation by TypeScript. */
type ResolveKey<M extends Schema.Top, I> =
  EntityKeyType<M, I> extends infer K ? { [P in keyof K]: K[P] } : never

/**
 * Force eager resolution of remaining SK fields for clean hover display.
 *
 * Resolves to `never` — not `{}` — when nothing remains, which is what makes
 * `.where()` disappear from {@link BoundQuery} (its gate is
 * `[SkRemaining] extends [never]`). Without the `keyof SK` check the mapped
 * type produced `{}` for BOTH "the accessor pinned every composite" and "this
 * index has no sort key composites at all", so the gate never fired and
 * `.where()` was offered on accessors with nothing left to constrain — the
 * first silently dropping the accessor's own pin (#121), the second reaching
 * the EDD-9045 runtime throw that existed only to catch it.
 */
type ResolveSkFields<M extends Schema.Top, I, K extends keyof I, Provided, R = undefined> =
  Omit<IndexSkFields<M, I, K, R>, keyof Provided> extends infer SK
    ? [keyof SK] extends [never]
      ? never
      : { readonly [P in keyof SK]: SK[P] }
    : never

/** Compute entity query accessors for each index — including `primary`.
 * Generic over provided input — `.where()` only exposes SK composites NOT already provided.
 * `R` (refs) lets ref-derived composite names (e.g. `playerId`) resolve to their
 * branded identifier types instead of being silently dropped. */
type EntityIndexAccessors<
  M extends Schema.Top,
  I extends Record<string, IndexDefinition>,
  R = undefined,
  P extends string = never,
> = {
  readonly [K in keyof I & string]: <Provided extends IndexPkInput<M, I, K, R>>(
    composites: Provided,
  ) => I[K] extends { readonly sk: { readonly zorder: ReadonlyArray<unknown> } }
    ? import("./internal/BoundQuery.js").BoundQuery<
        PathModel<Schema.Schema.Type<M>, P>,
        never,
        Schema.Schema.Type<M>,
        import("./internal/BoundQuery.js").WithinSpec<ZOrderWithin<M, I, K, R>, "zorder">
      >
    : import("./internal/BoundQuery.js").BoundQuery<
        PathModel<Schema.Schema.Type<M>, P>,
        ResolveSkFields<M, I, K, Provided, R>,
        Schema.Schema.Type<M>,
        CompositeWithin<ResolveSkFields<M, I, K, Provided, R>>
      >
}

/**
 * What `.within()` takes on a Z-order accessor (#171): an optional bound per
 * dimension, in the field's model type (`DateTime.Utc` for a `dateTime`
 * dimension, the members for a `literals` one, which also takes `in`), and an
 * optional exact value per prefix composite.
 */
type ZOrderWithin<M extends Schema.Top, I, K extends keyof I, R> =
  IndexZOrderDimensions<M, I, K, R> extends infer Dims
    ? IndexZOrderPrefix<M, I, K, R> extends infer Prefix
      ? {
          readonly [F in keyof Dims]?: Dims[F] extends {
            readonly dimension: infer D
            readonly value: infer V
          }
            ? import("./internal/BoundQuery.js").DimensionBound<D, V>
            : never
        } & { readonly [F in keyof Prefix]?: Prefix[F] }
      : never
    : never

/**
 * What `.within()` takes on a composite accessor (#171): an optional bound per
 * SK composite the accessor left open, in the composite's own type (string
 * literal unions widened to `string`, as `.where()` does). `never` — no
 * `.within()` — when the accessor pinned every composite or the index has none.
 */
type CompositeWithin<SK> = [SK] extends [never]
  ? never
  : import("./internal/BoundQuery.js").WithinSpec<
      {
        readonly [F in keyof SK]?: import("./internal/BoundQuery.js").RangeBound<
          import("./internal/BoundQuery.js").SkOperand<SK[F]>
        >
      },
      "composite"
    >

/**
 * Partition composites a vector index accessor requires.
 *
 * Resolves to `never` when the index declares no `partition` — which is exactly
 * what makes `.partition()` disappear (and the terminals appear immediately) in
 * {@link BoundVectorQuery}. Same shape as the "PK composites required" rule on
 * index query accessors.
 */
type VectorPartitionInput<M extends Schema.Top, C> = C extends {
  readonly partition: ReadonlyArray<infer K>
}
  ? [K] extends [never]
    ? never
    : { readonly [P in K & keyof Schema.Schema.Type<M>]: Schema.Schema.Type<M>[P] }
  : never

/**
 * The `INLINE_FILTER` attributes a vector index declares, as a string union.
 *
 * Resolves to `never` for an index with no `filters`, which makes `.filter()`
 * accept only `{}` — matching DynamoDB, where an undeclared filter attribute is
 * a `ValidationException` rather than a slower query.
 */
type VectorFilterNames<C> = C extends { readonly filters: ReadonlyArray<infer K extends string> }
  ? K
  : never

/**
 * Vector search accessors injected for each declared vector index, plus the
 * `reembed` maintenance operation. Empty when the entity declares none — so a
 * consumer never sees vector API surface on an entity that has no vectors.
 */
type EntityVectorAccessors<M extends Schema.Top, VI> =
  VI extends Record<string, VectorIndexConfig>
    ? {
        readonly [K in keyof VI & string]: (
          query: string | ReadonlyArray<number>,
        ) => BoundVectorQuery<
          Schema.Schema.Type<M>,
          VectorPartitionInput<M, VI[K]>,
          VectorFilterNames<VI[K]>,
          Schema.Schema.Type<M>
        >
      } & {
        /**
         * Re-derive and rewrite every stored embedding for this entity.
         *
         * DynamoDB never recomputes a vector — this is the migration path when the
         * embedding model or the declared `source.fields` change. Returns the
         * number of items whose vector was rewritten.
         */
        readonly reembed: (options?: {
          readonly concurrency?: number | undefined
        }) => Effect.Effect<
          number,
          | DynamoClientError
          | import("@effect-dynamodb/schema/Errors.js").ValidationError
          | import("@effect-dynamodb/schema/Errors.js").EmbeddingError,
          never
        >
      }
    : {}

/**
 * Pre-bound table operations with resolved table name.
 */
export interface TableOperations {
  /** Create the physical DynamoDB table. */
  readonly create: (options?: CreateTableOptions) => Effect.Effect<void, DynamoClientError>
  /** Delete the physical DynamoDB table. */
  readonly delete: () => Effect.Effect<void, DynamoClientError>
  /** Describe the table. */
  readonly describe: () => Effect.Effect<DescribeTableCommandOutput, DynamoClientError>
  /** Update table settings. */
  readonly update: (
    input: Omit<UpdateTableCommandInput, "TableName">,
  ) => Effect.Effect<void, DynamoClientError>
  /** Create an on-demand backup. */
  readonly backup: (name: string) => Effect.Effect<CreateBackupCommandOutput, DynamoClientError>
  /** List backups for this table. */
  readonly listBackups: () => Effect.Effect<ListBackupsCommandOutput, DynamoClientError>
  /** Restore from a backup. */
  readonly restoreFromBackup: (
    backupArn: string,
  ) => Effect.Effect<RestoreTableFromBackupCommandOutput, DynamoClientError>
  /** Enable point-in-time recovery. */
  readonly enablePointInTimeRecovery: () => Effect.Effect<void, DynamoClientError>
  /** Disable point-in-time recovery. */
  readonly disablePointInTimeRecovery: () => Effect.Effect<void, DynamoClientError>
  /** Restore to a point in time. */
  readonly restoreToPointInTime: (
    timestamp: Date,
  ) => Effect.Effect<RestoreTableToPointInTimeCommandOutput, DynamoClientError>
  /** Export table to S3. */
  readonly exportToS3: (
    s3Bucket: string,
    options?: { readonly s3Prefix?: string; readonly exportFormat?: "DYNAMODB_JSON" | "ION" },
  ) => Effect.Effect<ExportTableToPointInTimeCommandOutput, DynamoClientError>
  /** Enable TTL on an attribute. */
  readonly enableTTL: (attributeName: string) => Effect.Effect<void, DynamoClientError>
  /** Disable TTL on an attribute. */
  readonly disableTTL: (attributeName: string) => Effect.Effect<void, DynamoClientError>
  /** Describe TTL settings. */
  readonly describeTTL: () => Effect.Effect<DescribeTimeToLiveCommandOutput, DynamoClientError>
  /** Tag this table. */
  readonly tag: (tags: Record<string, string>) => Effect.Effect<void, DynamoClientError>
  /** Remove tags from this table. */
  readonly untag: (tagKeys: ReadonlyArray<string>) => Effect.Effect<void, DynamoClientError>
  /** List tags on this table. */
  readonly tags: () => Effect.Effect<ListTagsOfResourceCommandOutput, DynamoClientError>

  // --- Vector indexes ---

  /**
   * Add a declared vector index to an existing table via `UpdateTable`.
   * `indexName` is the physical index name declared on a registered entity.
   *
   * The index backfills asynchronously; `searchVectors` fails until it is
   * ACTIVE, so follow this with {@link waitForVectorIndex}.
   */
  readonly addVectorIndex: (indexName: string) => Effect.Effect<void, DynamoClientError>

  /** Remove a vector index from the table via `UpdateTable`. */
  readonly removeVectorIndex: (indexName: string) => Effect.Effect<void, DynamoClientError>

  /**
   * Poll `DescribeTable` until the named vector index reports `ACTIVE` with
   * `Backfilling: false`.
   *
   * Returns once the index is searchable, or fails with `ResourceNotFoundError`
   * if the index never appears within the timeout. DynamoDB Local never reports
   * vector indexes at all, so this resolves immediately there.
   */
  readonly waitForVectorIndex: (
    indexName: string,
    options?: {
      readonly pollInterval?: Duration.Input | undefined
      readonly timeout?: Duration.Input | undefined
    },
  ) => Effect.Effect<void, DynamoClientError>

  // --- Key text (#171, #183) ---

  /**
   * Move every row under key text the schema's `escapeKeys` setting doesn't compose
   * (1.36's, that of 1.37.0 and 1.38.0, or the other setting's) to the text it does:
   * items with their unique sentinels, version snapshots, tombstones,
   * time-series events, aggregates, and the event streams passed in
   * `options.streams` (copied, flipped, then deleted, while writers append).
   * A sharded index's partition key is rewritten in place when it differs from what
   * the row's values compose. Any other index key or vector partition is rewritten
   * only when it is exactly its values' text under another form: anything else is left,
   * with no conflict, and a key the row doesn't have isn't written. Scans the table
   * (`segments` in parallel); a row is moved only when it is stored under a key its
   * values composed under another form, so a rerun moves nothing. Conflicts are reported,
   * never overwritten. `dryRun` counts what would move, judging each row on its own: a
   * row whose destination is held by a row that can't move may be predicted as moved.
   * This is the only thing that moves a row between key texts: no read or write looks
   * under any text but the one the setting composes. See DESIGN.md §7 "Rows under other
   * key text" and the upgrade guide.
   *
   * Fails with `ValidationError` (`EDD-9098`) for a bad option or resume
   * token, and with the `DynamoClientError` of a request that failed — resume
   * from the last `onProgress` token.
   */
  readonly rekey: (
    options?: RekeyOptions,
  ) => Effect.Effect<RekeyReport, DynamoClientError | ValidationError>
}

// ---------------------------------------------------------------------------
// makeFromConfig — entity-centric make implementation
// ---------------------------------------------------------------------------

/**
 * Accessor names the bound entity owns outright. A vector index logical name
 * that lands on one of these would take the corresponding feature offline.
 */
const RESERVED_ACCESSOR_NAMES: ReadonlySet<string> = new Set(["scan", "reembed"])

/** @internal Structural entity type for runtime access. */
interface EntityLike {
  readonly _tag: "Entity"
  readonly entityType: string
  readonly model: Schema.Top
  readonly indexes: Record<string, IndexDefinition>
  readonly _vectorIndexes?: Record<string, VectorIndexDefinition> | undefined
  /** Domain field name → stored DynamoDB attribute name (`storedAs` renames). */
  readonly _resolveDbName?: ((domainName: string) => string) | undefined
  /**
   * The entity's refs: a `${ref}Id` composite is not stored on the item, but
   * the ref it names is, as a map holding the referenced identifier.
   */
  readonly _resolvedRefs?:
    | ReadonlyArray<{
        readonly fieldName: string
        readonly idFieldName: string
        readonly identifierField: string
      }>
    | undefined
  readonly _schema: DynamoSchema.DynamoSchema
  readonly _tableTag: Context.Service<TableConfig, TableConfig>
  /** `[EDD-9140]` for the attributes the table's configuration names (its TTL attribute). */
  readonly _refuseTableAttributes?: ((tableConfig: TableConfig) => void) | undefined
  /** Where a stored row's values key it in an index now (#171). */
  readonly _injectIndex: (name: string, def: IndexDefinition) => void
  readonly _decodeRecord: (raw: Record<string, unknown>) => Effect.Effect<any, any>
  /** Packed attributes an expression may not look inside (EDD-9076, #147). */
  readonly _packedGuards?: ReadonlyArray<PackedAttributeGuard> | undefined
  /** The domain fields stored packed. */
  readonly _packedFields?: ReadonlyArray<string> | undefined
  /** Read packed attributes of a raw row by their stored form (#147). */
  readonly _unpackFields?:
    | ((raw: Record<string, unknown>, operation?: string) => Effect.Effect<void, ValidationError>)
    | undefined
  /** The stored attributes `_unpackFields` reads (a projection naming none runs no hook). */
  readonly _dispatchAttributes?: ReadonlyArray<string> | undefined
  /** Which rows are items: a primary-key query or scan leaves the rest out (#133). */
  readonly _liveRows?: (() => Query.LiveRows | undefined) | undefined
  readonly schemas: {
    readonly recordSchema: Schema.Codec<any>
    /** The schema `put` encodes through — the source of truth for composite
     * encoding on the read path. Optional so pure schema-package definitions
     * promoted at bind time still satisfy the shape. */
    readonly inputSchema?: Schema.Top | undefined
  }
}

/** An entity's domain field names (its record's), when its schema exposes them. */
const domainFieldsOf = (entityLike: EntityLike): ReadonlySet<string> | undefined => {
  const fields = (entityLike.schemas.recordSchema as unknown as { readonly fields?: object }).fields
  return fields === undefined ? undefined : new Set(Object.keys(fields))
}

/**
 * Which rows of a collection over the table's primary key are items (#133):
 * each row judged by the member its `__edd_e__` names. `undefined` when no
 * member keeps history.
 */
const collectionLiveRows = (
  members: ReadonlyArray<{ readonly entityLike: EntityLike }>,
): Query.LiveRows | undefined => {
  const byType = new Map<string, Query.LiveRows>()
  for (const { entityLike } of members) {
    const live = entityLike._liveRows?.()
    if (live !== undefined) byType.set(entityLike.entityType, live)
  }
  if (byType.size === 0) return undefined
  return {
    isLive: (row) => byType.get(row.__edd_e__?.S ?? "")?.isLive(row) ?? true,
    reads: [...new Set(["__edd_e__", ...[...byType.values()].flatMap((live) => live.reads)])],
  }
}

/**
 * Each packed field of an entity once, by its domain name, with its config: a
 * renamed field has a guard per name (domain and stored), both carrying it.
 */
const packedFieldConfigs = (
  entity: EntityLike,
): Array<readonly [string, PackedAttributeGuard["storedAs"] | undefined]> =>
  (entity._packedFields ?? []).map((field) => [
    field,
    entity._packedGuards?.find((guard) => guard.attribute === field)?.storedAs,
  ])

const makeFromConfig = (config: {
  readonly entities: Record<string, EntityType>
  readonly aggregates?: Record<string, AggregateType<any, any, any, any>>
  readonly tables?: Record<string, TableLike>
  readonly crypto?: SecureRandom.SecureRandom["Service"]
  readonly embedder?: EmbedderService
  readonly compressors?: ReadonlyArray<Compressor>
}): Effect.Effect<any, never, DynamoClient | TableConfig> =>
  Effect.gen(function* () {
    // 1. Resolve the provide function from context.
    //
    // Bundle a `SecureRandom` service into the captured context so that bound entity
    // operations (auto-generated UUID primary keys via `generatedId`) resolve a
    // cryptographically-secure source WITHOUT widening the public `R` of bound
    // methods — bound `put` stays `R = never`. A caller-supplied `crypto`
    // override (e.g. `@effect/platform-node`) takes precedence over the default
    // `globalThis.crypto`-backed wrapper. The `provide` helper is widened to
    // admit `SecureRandom`. See `DESIGN.md` for the `R = never` rationale.
    // Detached: no current operation or parent span is pinned for later calls (#174).
    const baseCtx = Capacity.detachContext(yield* Effect.context<DynamoClient | TableConfig>())
    const cryptoService = config.crypto ?? makeDefaultCrypto()
    const withCrypto = Context.add(baseCtx, SecureRandom.SecureRandom, cryptoService)
    // Bundle the Embedder the same way, so entities with `vectorIndexes` keep
    // `R = never` on their bound operations. An explicit `embedder` wins; an
    // ambient one already in context is honoured; otherwise nothing is added
    // and the write path fails with a pointed `EmbeddingError` naming the index
    // (rather than forcing the service on every consumer's type).
    const ambientEmbedder = Context.getOption(baseCtx, Embedder)
    const embedderService =
      config.embedder ?? (Option.isSome(ambientEmbedder) ? ambientEmbedder.value : undefined)
    const withEmbedder =
      embedderService !== undefined
        ? Context.add(withCrypto, Embedder, embedderService)
        : withCrypto
    // Bundle the compressor registry for packed storage the same way: explicit
    // `compressors` win, then an ambient `Compression` at bind time. Without
    // either nothing is added. A `Compression` provided only at run time then
    // reaches bound operations (they read it with `Effect.serviceOption`), but
    // only when no bound member's `Packed` config names a codec: such a member
    // fails the bind-time [EDD-9078] check below before any operation runs.
    const ambientCompression = Context.getOption(baseCtx, Compression)
    const compressionRegistry =
      config.compressors !== undefined
        ? makeCompressionRegistry(config.compressors)
        : Option.isSome(ambientCompression)
          ? ambientCompression.value
          : undefined
    // A bound member whose packed config names a codec meets values
    // compressed with it on every read and write, so the codec must be
    // registered here — a configuration defect (`[EDD-9078]`) at bind, not a
    // ValidationError on the first compressed value (#147).
    const codecError = unregisteredCodecError(
      "DynamoClient.make",
      [
        ...Object.entries(config.entities).flatMap(([key, entity]) =>
          codecRequirements(`entity "${key}"`, packedFieldConfigs(entity as unknown as EntityLike)),
        ),
        ...Object.entries(config.aggregates ?? {}).flatMap(([key, aggregate]) =>
          [...(aggregate._packedByType ?? new Map())].flatMap(([edgeType, packed]) =>
            codecRequirements(`aggregate "${key}" (edge "${edgeType}")`, Object.entries(packed)),
          ),
        ),
      ],
      compressionRegistry,
    )
    if (codecError !== undefined) throw codecError
    const ctx =
      compressionRegistry !== undefined
        ? Context.add(withEmbedder, Compression, compressionRegistry)
        : withEmbedder
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DynamoClient | TableConfig | SecureRandom.SecureRandom>,
    ): Effect.Effect<A, E, never> => Effect.provide(effect, ctx)

    // A table's TTL attribute is named by its configuration, so an entity that sets it is checked
    // here, where the table is bound: a row's reader may not take it as a sparse map's entry
    // (`[EDD-9140]`, as `Entity.make` checks every name the definition supplies).
    for (const rawEntity of Object.values(config.entities)) {
      const entityLike = rawEntity as unknown as EntityLike
      const tableConfig = Option.getOrUndefined(Context.getOption(baseCtx, entityLike._tableTag))
      if (tableConfig !== undefined) entityLike._refuseTableAttributes?.(tableConfig)
    }

    // Dimension agreement between the Embedder and every bound vector index is
    // a construction-time invariant — a mismatch would otherwise surface as a
    // per-write failure long after wiring. See `DESIGN.md §14`.
    if (embedderService !== undefined) {
      for (const [entityKey, rawEntity] of Object.entries(config.entities)) {
        const declared = (rawEntity as unknown as EntityLike)._vectorIndexes
        if (!declared) continue
        for (const [logicalName, definition] of Object.entries(declared)) {
          if (definition.dimensions === embedderService.dimensions) continue
          throw new Error(
            `[EDD-9037] Entity "${entityKey}" vector index "${logicalName}" declares ` +
              `${definition.dimensions} dimensions, but the provided Embedder produces ` +
              `${embedderService.dimensions}. Dimensions are immutable on a DynamoDB vector index — ` +
              `align the index declaration with the embedding model.`,
          )
        }
      }
    }

    // Helper: validate query composites at runtime
    const validateQueryComposites = (
      indexName: string,
      indexDef: IndexDefinition,
      composites: Record<string, unknown>,
    ): void => {
      const pkAttrs = indexDef.pk.composite
      const skAttrs = indexDef.sk.composite

      // 1. All PK composites must be present
      for (const attr of pkAttrs) {
        if (composites[attr] === undefined) {
          throw new Error(
            `[EDD-9002] Missing required partition key attribute "${attr}" for index "${indexName}"`,
          )
        }
      }

      // 2. SK composites must follow prefix ordering
      let lastProvided = -1
      for (let i = 0; i < skAttrs.length; i++) {
        if (composites[skAttrs[i]!] !== undefined) {
          if (i !== lastProvided + 1) {
            const missing = skAttrs.slice(lastProvided + 1, i).join(", ")
            throw new Error(
              `[EDD-9004] Sort key composite "${skAttrs[i]}" for index "${indexName}" requires prior composites: ${missing}. Sort key composites must follow prefix ordering.`,
            )
          }
          lastProvided = i
        }
      }

      // 3. No excess properties
      const validKeys = new Set([...pkAttrs, ...skAttrs])
      for (const key of Object.keys(composites)) {
        if (!validKeys.has(key)) {
          throw new Error(
            `[EDD-9006] Unknown composite attribute "${key}" for index "${indexName}". Valid attributes: ${[...validKeys].join(", ")}`,
          )
        }
      }
    }

    // Helper: build a BoundQuery for a single-entity index query
    const buildEntityQueryAccessor = (
      entityLike: EntityLike,
      _indexName: string,
      indexDef: IndexDefinition,
    ) => {
      // Key composition runs on the ENCODED record on the write path
      // (`Entity.put` encodes, then composes), while accessors and `.where()`
      // hand us DECODED model values. Put both on one pipeline by encoding the
      // composites here — otherwise a transformed composite (e.g.
      // `Schema.BigIntFromString`) composes a different string from the one
      // that was stored, and the query silently matches nothing.
      // Source: `inputSchema`, the EXACT schema `put` encodes through before
      // composing keys. The raw model is not equivalent — entity derivation
      // substitutes date/Redacted fields with their wire transforms.
      const encoderSource = entityLike.schemas.inputSchema ?? entityLike.model
      const unencodable = (attr: string, value: unknown, reason?: string): never => {
        if (reason !== undefined) {
          return refuseInexact(
            `Composite "${attr}" on index "${_indexName}" of entity "${entityLike.entityType}"`,
            value,
            reason,
          )
        }
        throw new Error(
          `[EDD-9050] Composite "${attr}" on index "${_indexName}" of entity ` +
            `"${entityLike.entityType}" could not be encoded to its stored form. The ` +
            `attribute's schema carries an encoding transformation, so the stored key holds ` +
            `the ENCODED value, but ${JSON.stringify(String(value))} encodes under neither ` +
            `encode nor decode->encode. Supply a value of the attribute's own type.`,
        )
      }
      const compositeKeyForm = makeCompositeKeyForm(encoderSource, unencodable)
      // The caller's composites and bounds are DOMAIN values: the key `put` wrote for one is
      // the key form of the value it stores (`Entity._domainKeyForm`).
      const domainKeyForm = makeCompositeDomainKeyForm(encoderSource, unencodable)

      // A Z-order sort key (#171) is a binary address: its prefix composites
      // and dimensions are bounded with `.within()`, never pinned by the
      // accessor, which takes the partition key composites only.
      const zorder = KeyComposer.isZOrderHalf(indexDef.sk)
      const accessorDef: IndexDefinition = zorder
        ? { ...indexDef, sk: { field: indexDef.sk.field, composite: [] } }
        : indexDef
      // Its range plans, cached across the accessor's queries (§5.4).
      const zorderLayout = KeyComposer.isZOrderHalf(indexDef.sk)
        ? indexDef.sk.zorderHalf.layout
        : undefined
      const zorderPlans = zorderLayout === undefined ? undefined : makeZOrderPlans(zorderLayout)

      const accessor = (rawComposites: Record<string, unknown>) => {
        if (zorder) {
          const misplaced = indexDef.sk.composite.filter(
            (attr) => rawComposites[attr] !== undefined,
          )
          if (misplaced.length > 0) {
            throw new Error(
              `[EDD-9093] Index "${_indexName}" of entity "${entityLike.entityType}" has a ` +
                `Z-order sort key, so ${misplaced.map((attr) => `"${attr}"`).join(", ")} can't ` +
                `be passed to its accessor: pass the partition key composites ` +
                `(${indexDef.pk.composite.join(", ")}) and bound the rest with .within().`,
            )
          }
        }
        validateQueryComposites(_indexName, accessorDef, rawComposites)
        const compositesKeyForm = toCompositeKeyRecord(domainKeyForm, rawComposites)
        // One partition, or a sharded index's several (#183).
        const read = KeyComposer.composeReadPartitions(
          entityLike._schema,
          entityLike.entityType,
          indexDef,
          compositesKeyForm,
        )
        const pkValue = read.partitions[0]!
        const unpartitioned = Query.make({
          tableName: "",
          indexName: indexDef.index,
          pkField: indexDef.pk.field,
          pkValue,
          skField: indexDef.sk.field,
          entityTypes: [entityLike.entityType],
          decoder: (raw) => entityLike._decodeRecord(raw),
          ...entityPackedQueryOptions(entityLike),
          resolveTableName: entityLike._tableTag.useSync((tc: TableConfig) => tc.name),
          keyFields: [
            indexDef.pk.field,
            indexDef.sk.field,
            entityLike.indexes.primary?.pk.field,
            entityLike.indexes.primary?.sk.field,
          ],
          // The primary key also holds the entity's history rows; an index
          // never does (they carry no index keys).
          liveRows: indexDef.index === undefined ? entityLike._liveRows?.() : undefined,
          // DynamoDB's rejection of the key condition (#144) names the accessor.
          keyConditionDiagnosis: {
            operation: "query",
            label: `${entityLike.entityType}.${_indexName}`,
          },
        })
        const query = Query.fanOut(unpartitioned, read)

        // Apply the SK condition from the provided composites
        // (`composeSortKeyCondition`): a partial prefix stops on a segment
        // boundary, or it matches sibling values that merely start with the
        // supplied one (`status_done` also matching `status_done_archived`,
        // issue #115), and on a secondary index takes the row truncated at it; a
        // complete key is an exact `=`, or `seq: 3` also matches 3.14 and
        // `name: "a"` also matches "ab".
        const hasSkComposites =
          !zorder &&
          indexDef.sk.composite.some((attr: string) => compositesKeyForm[attr] !== undefined)
        const pinnedQuery = hasSkComposites
          ? Query.whereUnderPins(
              query,
              KeyComposer.composeSortKeyCondition(
                entityLike._schema,
                entityLike.entityType,
                1,
                indexDef,
                compositesKeyForm,
              ),
            )
          : query

        const pathBuilder = createPathBuilder()
        const conditionOps = createConditionOps()

        // composeSkCondition — compose the user's `.where()` operand into a full
        // sort key value the same way `put` composes the stored one
        // (`composeRangeUnder`).
        const skComposites = indexDef.sk.composite
        const composeSkCondition = (
          condition: RawSortKeyCondition,
          field: string | undefined,
        ): Query.SortKeyCondition => {
          if (zorder) {
            throw new Error(
              `[EDD-9093] .where() on index "${_indexName}" of entity ` +
                `"${entityLike.entityType}": a Z-order sort key has no text order to compare ` +
                `against — bound its prefix composites and dimensions with .within().`,
            )
          }
          if (skComposites.length === 0) {
            throw new Error(
              `[EDD-9045] Index "${_indexName}" has no sort key composites, so there is ` +
                `nothing for .where() to constrain. Remove the .where() call, or add sort ` +
                `key composites to the index definition.`,
            )
          }

          // How many leading composites the accessor already pinned. Pinning is
          // a prefix by construction — `validateQueryComposites` rejects a hole
          // with EDD-9004 before the accessor is built — so this count is also
          // the index of the first composite still open to a condition.
          const pinnedCount = (() => {
            const i = skComposites.findIndex(
              (attr: string) => compositesKeyForm[attr] === undefined,
            )
            return i === -1 ? skComposites.length : i
          })()

          /**
           * `.where()` may only constrain a composite the accessor left open.
           *
           * DynamoDB allows exactly ONE sort key condition, and `Query.where`
           * REPLACES the `begins_with` the accessor installed for its pinned
           * prefix. So a condition on an already-pinned composite does not
           * narrow within the pin — it discards the pin, and the query runs
           * against the whole partition. Under a pinned `label = "ship"`,
           * `eq("label", "shine")` returned rows whose label was `shine`.
           *
           * The two sides cannot be ANDed into one key condition, and
           * intersecting them (pin ∩ condition) would silently turn some calls
           * into "matches nothing". Raise instead — the caller pinned the value
           * once already, so the condition is either redundant or contradictory
           * and only the caller knows which was meant (#121).
           */
          const rejectPinned = (attr: string): never => {
            throw new Error(
              `[EDD-9053] Sort key composite "${attr}" for index "${_indexName}" is already ` +
                `pinned to ${JSON.stringify(String(compositesKeyForm[attr]))} by the accessor, ` +
                `so .where() cannot also constrain it: DynamoDB allows one sort key condition, ` +
                `and this one would REPLACE the accessor's own prefix rather than narrow it — ` +
                `returning rows outside the pinned value. Drop "${attr}" from the accessor call ` +
                `and express the whole constraint in .where(), or drop the .where() and keep ` +
                `the pin.`,
            )
          }

          // Resolve the targeted composite. `.where((t) => ...)` hands back the
          // composite name via the sk accessor; fall back to the first composite
          // the accessor call did not already pin.
          if (field !== undefined && skComposites.includes(field)) {
            if (skComposites.indexOf(field) < pinnedCount) rejectPinned(field)
          } else if (pinnedCount === skComposites.length) {
            // No field named and nothing left open — the fallback would land on
            // a pinned composite. (`ResolveSkFields` now hides `.where()` in
            // this shape, so reaching here means an untyped or cast call site.)
            rejectPinned(skComposites[skComposites.length - 1]!)
          }
          const targetIndex =
            field !== undefined && skComposites.includes(field)
              ? skComposites.indexOf(field)
              : pinnedCount
          const targetAttr = skComposites[targetIndex]!

          // Every composite to the left of the target must already be pinned by
          // the accessor — otherwise the composed operand would have a hole and
          // silently compare against the wrong prefix.
          const missing = skComposites
            .slice(0, targetIndex)
            .filter((attr: string) => compositesKeyForm[attr] === undefined)
          if (missing.length > 0) {
            throw new Error(
              `[EDD-9004] Sort key condition on "${targetAttr}" for index "${_indexName}" ` +
                `requires prior composites: ${missing.join(", ")}. Sort key composites must ` +
                `follow prefix ordering — supply them to the accessor before calling .where().`,
            )
          }

          // Compose under the pinned prefix — the key text of the composites
          // the accessor pinned, ending on a segment boundary (the target
          // follows them, so the shared delimiter rule always applies).
          const pinnedKeyForm: Record<string, unknown> = {}
          for (let i = 0; i < targetIndex; i++) {
            pinnedKeyForm[skComposites[i]!] = compositesKeyForm[skComposites[i]!]
          }
          const prefixText = KeyComposer.composeSortKeyBeginsWith(
            entityLike._schema,
            entityLike.entityType,
            1,
            indexDef,
            pinnedKeyForm,
          )
          // Operands are encoded exactly as the accessor composites (and the
          // write path) are, so both sides of the comparison come out of one
          // pipeline.
          //
          // The clamp predicate is "the accessor pinned something", NOT
          // `targetIndex > 0`. Those coincided for every shape the tests
          // covered but are different claims: an accessor can pin composite[0]
          // itself, and then targeting index 0 skipped the clamp and dropped
          // the pin (#121). That call now raises EDD-9053 above, so the two
          // are equivalent again — stating the real predicate keeps them from
          // drifting apart a second time.
          return composeRangeUnder(
            {
              schema: entityLike._schema,
              casing: KeyComposer.effectiveCasing(entityLike._schema, indexDef),
              isLast: targetIndex === skComposites.length - 1,
              secondary: indexDef.index !== undefined,
            },
            prefixText,
            targetAttr,
            mapBound(condition, (value) => domainKeyForm(targetAttr, value)),
            { clampToPrefix: pinnedCount > 0 },
          )
        }

        const bqConfig: BoundQueryConfig<unknown> = {
          pathBuilder,
          conditionOps,
          provide,
          composeSkCondition,
          // A Z-order accessor bounds its dimensions and prefix composites
          // (#171), and takes `.zorder()`.
          ...(zorder
            ? {
                zorder: true,
                planWithin: (q, bounds, options) =>
                  planZOrderWithin({
                    entityLike,
                    accessor: _indexName,
                    indexDef,
                    encoderSource,
                    compositeKeyForm,
                    domainKeyForm,
                    pkValue,
                    plans: zorderPlans!,
                    query: q,
                    bounds,
                    options,
                  }),
              }
            : {
                planWithin: (q, bounds, options) =>
                  planCompositeWithin({
                    entityLike,
                    accessor: _indexName,
                    indexDef,
                    encoderSource,
                    compositeKeyForm,
                    domainKeyForm,
                    pinnedKeyForm: compositesKeyForm,
                    pkValue,
                    query: q,
                    bounds,
                    options,
                  }),
              }),
          skFields: accessorDef.sk.composite,
          ...entityNaming(entityLike._resolveDbName),
          operation: { name: "Entity.query", target: entityLike.entityType, index: _indexName },
        }
        return new BoundQueryImpl(pinnedQuery, bqConfig)
      }

      return (rawComposites: Record<string, unknown>) => {
        const operation = {
          name: "Entity.query",
          target: entityLike.entityType,
          index: _indexName,
        }
        return Query.orRefusal(
          operation,
          () => accessor(rawComposites) as BoundQueryImpl<unknown, unknown, unknown>,
          (refusal) =>
            new BoundQueryImpl(Query.refused(indexDef.index, refusal), {
              pathBuilder: createPathBuilder(),
              conditionOps: createConditionOps(),
              provide,
              ...entityNaming(entityLike._resolveDbName),
              operation,
            }),
        )
      }
    }

    // 2. Bind entities + build entity query accessors
    const boundEntities: Record<string, unknown> = {}
    // Track collection memberships for auto-discovery
    // collectionName → { entityKey, entityLike, indexName, indexDef }[]
    const collectionMembers = new Map<
      string,
      Array<{ entityKey: string; entityLike: EntityLike; indexDef: IndexDefinition }>
    >()

    for (const [key, rawEntity] of Object.entries(config.entities)) {
      // A member may be a pure `@effect-dynamodb/schema` EntityDefinition (the
      // headline output of the schema/runtime split) rather than a runtime
      // Entity. Pure definitions carry no operations or `_decodeRecord`, so
      // binding one directly would crash at call time. Promote it to a full
      // runtime Entity (a thin op-attach over its retained `_data`) so the bound
      // CRUD, query accessors, and collection decode all work. Runtime-authored
      // entities already carry `.get` and pass through untouched.
      const entity =
        typeof (rawEntity as { get?: unknown }).get === "function"
          ? rawEntity
          : entityFromDefinition(rawEntity as unknown as EntityDefinition)
      // Provide the resolved services (SecureRandom, Embedder, Compression) into the
      // bind: `bind` captures its context at bind time, so the bound CRUD
      // methods resolve the explicit `crypto`, `embedder` and `compressors`
      // given here — keeping them at `R = never`. `bind` respects an
      // already-present SecureRandom and only fills its own default when absent, so
      // the override is honored.
      const bound = yield* provide(entityBind(entity as EntityType))
      const entityLike = entity as unknown as EntityLike
      const accessors: Record<string, unknown> = {}

      // Add query accessor for each index — including `primary`.
      for (const [indexName, indexDef] of Object.entries(entityLike.indexes)) {
        if (!indexDef) continue

        accessors[indexName] = buildEntityQueryAccessor(entityLike, indexName, indexDef)

        // Track collection membership for auto-discovery
        if (indexDef.collection) {
          const collNames = Array.isArray(indexDef.collection)
            ? indexDef.collection
            : [indexDef.collection]
          for (const collName of collNames) {
            if (!collectionMembers.has(collName)) {
              collectionMembers.set(collName, [])
            }
            collectionMembers.get(collName)!.push({ entityKey: key, entityLike, indexDef })
          }
        }
      }

      // Vector search accessors — one per declared vector index.
      for (const [logicalName, definition] of Object.entries(entityLike._vectorIndexes ?? {})) {
        // Accessors share one namespace on the bound entity. A vector index
        // named after an existing index accessor (or `scan` / `reembed`) would
        // silently replace it and take the other feature offline, so make the
        // collision a construction-time failure instead.
        if (logicalName in accessors || RESERVED_ACCESSOR_NAMES.has(logicalName)) {
          throw new Error(
            `[EDD-9038] Entity "${key}": vector index "${logicalName}" collides with an existing ` +
              `accessor of the same name. Vector index names share a namespace with GSI query ` +
              `accessors, \`scan\` and \`reembed\` — rename one of them.`,
          )
        }
        const vqConfig: BoundVectorQueryConfig = {
          keyForm: (record: Record<string, unknown>) => entityDomainKeyForm(entityLike, record),
          entityType: entityLike.entityType,
          logicalName,
          definition,
          schema: entityLike._schema,
          tableTag: entityLike._tableTag,
          decode: (raw) => entityLike._decodeRecord(raw),
          unpackRaw: entityLike._unpackFields,
          unpackAttributes: entityLike._dispatchAttributes,
          provide,
          resolveDbName: entityLike._resolveDbName ?? ((domainName: string) => domainName),
        }
        accessors[logicalName] = (query: string | ReadonlyArray<number>) =>
          makeBoundVectorQuery(vqConfig, query)
      }

      // Add scan accessor
      accessors.scan = () => {
        const scanQuery = Query.makeScan({
          tableName: "",
          indexName: undefined,
          entityTypes: [entityLike.entityType],
          decoder: (raw) => entityLike._decodeRecord(raw),
          ...entityPackedQueryOptions(entityLike),
          resolveTableName: entityLike._tableTag.useSync((tc: TableConfig) => tc.name),
          keyFields: [entityLike.indexes.primary?.pk.field, entityLike.indexes.primary?.sk.field],
          liveRows: entityLike._liveRows?.(),
        })
        const pathBuilder = createPathBuilder()
        const conditionOps = createConditionOps()
        const bqConfig: BoundQueryConfig<unknown> = {
          pathBuilder,
          conditionOps,
          provide,
          ...entityNaming(entityLike._resolveDbName),
          operation: { name: "Entity.scan", target: entityLike.entityType },
        }
        return new BoundQueryImpl(scanQuery, bqConfig)
      }

      boundEntities[key] = { ...bound, ...accessors }
    }

    // 3. Build auto-discovered collection accessors
    const boundCollections: Record<string, unknown> = {}
    for (const [collName, members] of collectionMembers) {
      // A collection spans several entities over ONE physical index, so its
      // members must agree on how each PK composite is spelled in a key. Two
      // members disagreeing (`Schema.Date` vs `DateEpochMs`, say) write keys
      // into the same partition that can never match each other, and picking
      // the first member's form would silently lose the others' rows. Fail at
      // bind time instead.
      assertCollectionKeyFormAgreement(collName, members)
      KeyComposer.assertCollectionCasingAgreement(
        collName,
        members.map((m) => ({ key: m.entityKey, schema: m.entityLike._schema, index: m.indexDef })),
      )
      KeyComposer.assertCollectionShardsAgreement(
        collName,
        members.map((m) => ({ key: m.entityKey, index: m.indexDef })),
      )

      const collectionAccessor = (composites: Record<string, unknown>) => {
        // Use the first member for PK composition — verified above to agree
        // with every other member.
        const firstMember = members[0]!
        const indexDef = firstMember.indexDef

        // Build entity type → entity key lookup
        const memberByType = new Map<string, string>()
        const entityTypes: string[] = []
        for (const member of members) {
          memberByType.set(member.entityLike.entityType, member.entityKey)
          entityTypes.push(member.entityLike.entityType)
        }

        // Collection decoder: decode and group by entity key
        const collDecoder = (raw: Record<string, unknown>) => {
          const entityType = raw.__edd_e__ as string | undefined
          if (!entityType) {
            return Effect.fail(
              new ValidationError({
                entityType: "unknown",
                operation: "collection.decode",
                cause: "Item missing __edd_e__",
              }),
            )
          }
          const entityKey = memberByType.get(entityType)
          if (!entityKey) {
            return Effect.succeed({ _memberKey: "__unknown__", _decoded: raw })
          }
          const member = members.find((m) => m.entityLike.entityType === entityType)
          if (!member) {
            return Effect.succeed({ _memberKey: "__unknown__", _decoded: raw })
          }
          return member.entityLike
            ._decodeRecord(raw)
            .pipe(Effect.map((decoded: unknown) => ({ _memberKey: entityKey, _decoded: decoded })))
        }

        // Same key form the member entities' own accessors and their write
        // path use — without it `db.collections.window({ takenAt })` composed a
        // different PK from `db.entities.Readings.byWindow({ takenAt })` and
        // returned nothing.
        // Members share the partitions, whatever each hashes: never pruned (#183).
        const read = KeyComposer.composeReadPartitions(
          firstMember.entityLike._schema,
          firstMember.entityLike.entityType,
          indexDef,
          entityDomainKeyForm(firstMember.entityLike, composites),
          { prune: false },
        )

        // Always isolated — begins_with on collection SK prefix
        let query = Query.make({
          tableName: "",
          indexName: indexDef.index,
          pkField: indexDef.pk.field,
          pkValue: read.partitions[0]!,
          skField: indexDef.sk.field,
          entityTypes,
          decoder: collDecoder as any,
          ...collectionPackedQueryOptions(members.map((m) => m.entityLike)),
          resolveTableName: firstMember.entityLike._tableTag.useSync((tc: TableConfig) => tc.name),
          keyFields: [
            indexDef.pk.field,
            indexDef.sk.field,
            firstMember.entityLike.indexes.primary?.pk.field,
            firstMember.entityLike.indexes.primary?.sk.field,
          ],
          // A collection on the primary key also meets its members' history.
          liveRows: indexDef.index === undefined ? collectionLiveRows(members) : undefined,
          keyConditionDiagnosis: { operation: "query", label: `collection "${collName}"` },
        })
        query = Query.fanOut(query, read)

        // Add begins_with on collection SK prefix for clustered collections.
        // For isolated collections (default), each entity has its own entity-type
        // SK prefix, so a collection-name begins_with would filter them all out.
        //
        // For sub-collections (collection: ["parent", "child"]), the SK prefix
        // includes the full hierarchy from root up to and including the queried
        // collection name. A query at the parent level matches every descendant.
        if (indexDef.sk.field && indexDef.type === "clustered") {
          const coll = indexDef.collection
          const hierarchy = Array.isArray(coll)
            ? coll.slice(0, coll.indexOf(collName) + 1)
            : [collName]
          const casing = KeyComposer.effectiveCasing(firstMember.entityLike._schema, indexDef)
          const pre = DynamoSchema.prefix(firstMember.entityLike._schema)
          const casedNames = hierarchy.map((n) => DynamoSchema.applyCasing(n, casing))
          const skPrefix = `${pre}#${casedNames.join("#")}`
          query = Query.where(query, { beginsWith: skPrefix })
        }

        // Wrap in BoundQuery that groups results by entity key
        const pathBuilder = createPathBuilder()
        const conditionOps = createConditionOps()
        const collectionProvide = <X, E>(eff: Effect.Effect<X, E, any>) =>
          Effect.provide(eff, ctx) as Effect.Effect<X, E, never>
        const bqConfig: BoundQueryConfig<unknown> = {
          pathBuilder,
          conditionOps,
          provide: collectionProvide,
          // Each streamed item tagged with its member; foreign rows dropped.
          tagStreamed: (item) => {
            const memberKey = (item as any)._memberKey
            return memberKey !== undefined && memberKey !== "__unknown__"
              ? { member: memberKey, item: (item as any)._decoded }
              : undefined
          },
          // Group results by member — through every combinator.
          groupCollected: (items) => {
            const result: Record<string, unknown[]> = {}
            for (const member of members) {
              result[member.entityKey] = []
            }
            for (const item of items) {
              const memberKey = (item as any)._memberKey
              if (memberKey && result[memberKey]) {
                result[memberKey]!.push((item as any)._decoded)
              }
            }
            return result
          },
          ...collectionNaming(
            members.map((m) => ({
              entityType: m.entityLike.entityType,
              entityKey: m.entityKey,
              resolve: m.entityLike._resolveDbName ?? ((name: string) => name),
              fields: domainFieldsOf(m.entityLike),
            })),
          ),
          operation: { name: "Collection.query", target: collName },
        }
        return new BoundQueryImpl(query, bqConfig)
      }

      boundCollections[collName] = (composites: Record<string, unknown>) => {
        const operation = { name: "Collection.query", target: collName }
        return Query.orRefusal(
          operation,
          () => collectionAccessor(composites) as BoundQueryImpl<unknown, unknown, unknown>,
          (refusal) =>
            new BoundQueryImpl(Query.refused(members[0]!.indexDef.index, refusal), {
              pathBuilder: createPathBuilder(),
              conditionOps: createConditionOps(),
              provide,
              operation,
            }),
        )
      }
    }

    // An aggregate declaring `ownsRows` takes every row of its types in its partition. Refused when
    // another member this client can see can write such a row there (DESIGN.md §7 "Which rows in
    // its partition are an aggregate's"): those its table declares, those the client binds, and
    // those of every table the client binds, on the same physical table (by table, or by the
    // name it resolves to here). A writer it doesn't see, here or in another process, isn't checked.
    const tableNameOf = (table: unknown): string | undefined => {
      // A table's tag is a function.
      if (
        table === null ||
        (typeof table !== "object" && typeof table !== "function") ||
        !("key" in table)
      ) {
        return undefined
      }
      return Option.getOrUndefined(
        Context.getOption(baseCtx, table as Context.Key<TableConfig, TableConfig>),
      )?.name
    }
    // Every entity the client sees: those it binds, then those of every table it binds, named as a
    // refusal names them. A member may reach the client only as another bound table's.
    const visible: ReadonlyArray<readonly [name: string, entity: unknown]> = [
      ...Object.entries(config.entities),
      ...Object.entries(config.tables ?? {}).flatMap(([tableKey, table]) =>
        Object.entries(table.entities).map(
          ([key, entity]) => [`${tableKey}.${key}`, entity] as const,
        ),
      ),
    ]
    // And every aggregate it sees, the same way.
    const visibleAggregates: ReadonlyArray<readonly [name: string, aggregate: unknown]> = [
      ...Object.entries(config.aggregates ?? {}),
      ...Object.entries(config.tables ?? {}).flatMap(([tableKey, table]) =>
        Object.entries(
          (table as { readonly aggregates?: Record<string, unknown> }).aggregates ?? {},
        ).map(([key, aggregate]) => [`${tableKey}.${key}`, aggregate] as const),
      ),
    ]
    const visibleMembers = [...visible, ...visibleAggregates].map(([name, member]) => ({
      name,
      member,
    }))
    // The owners checked are the aggregates it sees, from the same list: `rekey` runs the handler of
    // a table's aggregate the client doesn't bind itself. Each once, by the first name it has.
    const checked = new Set<unknown>()
    for (const [key, aggregate] of visibleAggregates) {
      if ((aggregate as { readonly _ownsRows?: boolean })._ownsRows !== true) continue
      if (checked.has(aggregate)) continue
      checked.add(aggregate)
      const own = (aggregate as { readonly _tableTag?: { readonly key: string } })._tableTag
      const ownName = tableNameOf(own)
      const conflict = ownershipConflict(aggregate, visibleMembers, (table) => {
        if (table === own) return true
        const keyOf = (t: unknown) => (t as { readonly key?: unknown } | undefined)?.key
        if (keyOf(table) !== undefined && keyOf(table) === keyOf(own)) return true
        return ownName !== undefined && tableNameOf(table) === ownName
      })
      if (conflict !== undefined) {
        throw new Error(
          `[EDD-9130] Aggregate "${key}" declares \`ownsRows\`, but "${conflict.member}" can write ` +
            `a row of type "${conflict.type}" into its partition (${conflict.channel}). ` +
            `\`ownsRows\` would take that row for the aggregate's: leave it off, or keep ` +
            `"${conflict.member}"'s rows out of the aggregate's partition.`,
        )
      }
    }

    // 4. Bind aggregates
    const boundAggregates: Record<string, unknown> = {}
    if (config.aggregates) {
      for (const [key, aggregate] of Object.entries(config.aggregates)) {
        // Same as entities: the aggregate captures the resolved services
        // (notably `Compression`, for packed edge entity fields) at bind time.
        boundAggregates[key] = yield* provide(aggregateBind(aggregate))
      }
    }

    // 5. Build table operations
    const client = yield* DynamoClient
    const tables: Record<string, TableOperations> = {}

    // `rekey` (#171) hands each row to the member owning it: the table's
    // entities and aggregates, those the client binds on the same table, and
    // the streams the caller passes (`DynamoClient.make` binds no streams).
    const rekeyFor =
      (tableName: string, tagKey: string, registered: ReadonlyArray<unknown>) =>
      (options?: RekeyOptions): Effect.Effect<RekeyReport, DynamoClientError | ValidationError> => {
        const onTable = (member: unknown) =>
          (member as { readonly _tableTag?: { readonly key: string } })._tableTag?.key === tagKey
        const handlers = new Set<Rekey.RekeyMember>()
        for (const member of [
          ...registered,
          ...Object.values(config.entities).filter(onTable),
          ...Object.values(config.aggregates ?? {}).filter(onTable),
          ...(options?.streams ?? []),
        ]) {
          const handler = Rekey.handlerOf(member)
          if (handler !== undefined) handlers.add(handler)
        }
        // The outboxes on this table of a read model on another (#171): every projection's, so a
        // second projection of one read model doesn't hide the first's items.
        const outboxOf = new Set<unknown>()
        for (const entity of [...registered, ...Object.values(config.entities)]) {
          if (outboxOf.has(entity)) continue
          outboxOf.add(entity)
          const outboxes = (
            entity as {
              readonly _projectionOutboxes?: ReadonlyArray<{
                readonly table: { readonly Tag: { readonly key: string } } | undefined
                readonly pk: string
                readonly sk: string
              }>
            }
          )._projectionOutboxes
          // Their key attributes, once each.
          const layouts = new Map<string, { readonly pk: string; readonly sk: string }>()
          for (const outbox of outboxes ?? []) {
            if (outbox.table?.Tag.key !== tagKey) continue
            layouts.set(`${outbox.pk}\u0000${outbox.sk}`, { pk: outbox.pk, sk: outbox.sk })
          }
          if (layouts.size === 0) continue
          const keys = [...layouts.values()]
          const readModel = entity as unknown as Pick<
            EntityType,
            "entityType" | "_rekeyProjectionRow"
          >
          handlers.add({
            name: readModel.entityType,
            types: [`${readModel.entityType}#outbox`],
            // A table has one key schema, so its items are under the layout whose attributes they hold.
            row: (row, ctx) =>
              readModel._rekeyProjectionRow(
                row,
                ctx,
                keys.find((key) => row[key.pk]?.S !== undefined && row[key.sk]?.S !== undefined) ??
                  keys[0]!,
              ),
          })
        }
        return provide(Rekey.run({ tableName, members: [...handlers], options }))
      }

    if (config.tables) {
      for (const [tableKey, table] of Object.entries(config.tables)) {
        const tableConfig = yield* table.Tag
        // Merge any runtime-registered aggregates from `config.aggregates` whose
        // `_tableTag` matches this table's tag. Users may intentionally omit
        // aggregates from `Table.make({ aggregates })` to sidestep the multi-file
        // circular-import problem, registering them on `DynamoClient.make` instead.
        // Without this merge, `tableDefinition()` would never see those aggregates
        // and `db.tables.*.create()` would silently drop their (L|G)SIs.
        let mergedTable = table as unknown as Table
        if (config.aggregates) {
          const tableTagKey = table.Tag.key
          const existingAggs = table.aggregates as Record<string, unknown>
          const existingAggSet = new Set(Object.values(existingAggs))
          const extraAggregateEntries: Array<[string, unknown]> = []
          for (const [aggKey, agg] of Object.entries(config.aggregates)) {
            const aggTag = (agg as unknown as { _tableTag?: EntityLike["_tableTag"] })._tableTag
            if (aggTag === undefined) continue
            if (aggTag.key !== tableTagKey) continue
            // Skip if this aggregate is already registered on the table object
            // (reference equality) so we don't emit duplicate LSI/GSI entries.
            if (existingAggSet.has(agg)) continue
            extraAggregateEntries.push([aggKey, agg])
          }
          if (extraAggregateEntries.length > 0) {
            mergedTable = {
              ...(table as unknown as Table),
              aggregates: {
                ...existingAggs,
                ...Object.fromEntries(extraAggregateEntries),
              },
            } as unknown as Table
          }
        }
        tables[tableKey] = {
          ...buildTableOperationsFromTable(tableConfig.name, mergedTable, client),
          rekey: rekeyFor(tableConfig.name, table.Tag.key, [
            ...Object.values(mergedTable.entities as Record<string, unknown>),
            ...Object.values(mergedTable.aggregates as Record<string, unknown>),
          ]),
        }
      }
    } else {
      // Group entities by table tag so we can derive full table schema for create().
      // Aggregates are also assigned to a table tag via their underlying entities;
      // we collect them here so create() includes their GSIs.
      const entitiesByTag = new Map<
        string,
        {
          tag: EntityLike["_tableTag"]
          entities: EntityLike[]
          aggregates: AggregateType<any, any, any, any>[]
        }
      >()
      for (const [, entity] of Object.entries(config.entities)) {
        const entityLike = entity as unknown as EntityLike
        const tagId = entityLike._tableTag.key
        if (!entitiesByTag.has(tagId)) {
          entitiesByTag.set(tagId, { tag: entityLike._tableTag, entities: [], aggregates: [] })
        }
        entitiesByTag.get(tagId)!.entities.push(entityLike)
      }
      // Attach aggregates to whichever table tag matches their root entity tag.
      // (Aggregates expose `_tableTag` from their root entity registration.)
      if (config.aggregates) {
        for (const [, agg] of Object.entries(config.aggregates)) {
          const aggTag = (agg as unknown as { _tableTag?: EntityLike["_tableTag"] })._tableTag
          if (aggTag && entitiesByTag.has(aggTag.key)) {
            entitiesByTag.get(aggTag.key)!.aggregates.push(agg)
          }
        }
      }
      for (const [
        ,
        { tag, entities: tableEntities, aggregates: tableAggregates },
      ] of entitiesByTag) {
        const tableConfig = yield* tag
        // Build a minimal Table-like object so tableDefinition() can derive GSIs
        // (entities + aggregates).
        const syntheticTable = {
          entities: Object.fromEntries(tableEntities.map((e) => [e.entityType, e])),
          aggregates: Object.fromEntries(
            tableAggregates.map((a, i) => [
              (a as { name?: string }).name ?? `__aggregate_${i}__`,
              a,
            ]),
          ),
        } as unknown as Table
        tables[tableConfig.name] = {
          ...buildTableOperationsFromTable(tableConfig.name, syntheticTable, client),
          rekey: rekeyFor(tableConfig.name, tag.key, [...tableEntities, ...tableAggregates]),
        }
      }
    }

    return {
      entities: boundEntities,
      aggregates: boundAggregates,
      collections: boundCollections,
      tables,
    } as any
  })

// ---------------------------------------------------------------------------
// buildTableOperations — pre-bound table management
// ---------------------------------------------------------------------------

/** Check if a DynamoError wraps a ResourceInUseException (table already exists). */
const isResourceInUse = (err: DynamoClientError): boolean =>
  err._tag === "DynamoError" &&
  err.cause != null &&
  typeof err.cause === "object" &&
  "name" in err.cause &&
  (err.cause as { name: string }).name === "ResourceInUseException"

/**
 * DynamoDB's vector-index limits — dimensions in 1..4096, inline filters per
 * index, vector indexes per table (an adjustable quota) — are not pre-checked
 * (#144): a rejected `CreateTable` / `UpdateTable` is diagnosed against the
 * vector indexes it sent, naming the index and the entities sharing it, and
 * fails with the error DynamoDB's would have been (same tag), its message
 * explained and DynamoDB's error kept as the cause. Anything else passes
 * through.
 */
const diagnoseVectorLimits = (
  operation: "CreateTable" | "UpdateTable",
  label: string,
  sent: Omit<SentTable, "_tag" | "operation">,
) =>
  diagnoseFailure({
    sent: () => ({ _tag: "Table", operation, ...sent }),
    only: ["VectorIndexDimensions", "VectorIndexFilters", "VectorIndexCount"],
    rewrite: (diagnosis, original): DynamoClientError => {
      const cause = withCause(explainDiagnosis(diagnosis, label), original)
      return (original as DynamoClientError)._tag === "DynamoValidationError"
        ? new DynamoValidationError({ operation, cause })
        : new DynamoError({ operation, cause })
    },
  })

/** Make createTable idempotent — ignore if table already exists. */
const idempotentCreate = (
  effect: Effect.Effect<void, DynamoClientError>,
): Effect.Effect<void, DynamoClientError> =>
  Effect.catchIf(effect, isResourceInUse, () => Effect.void)

const buildTableOperationsFromTable = (
  tableName: string,
  table: Table,
  client: DynamoClientService,
): Omit<TableOperations, "rekey"> => {
  // Composed when a table is created: a table holding only event streams or a
  // projection's outbox has no definition to give, but its other operations
  // (`rekey` among them) still work.
  const definition = () => tableDefinition(table)
  const vectorIndexes = mergeVectorIndexes(
    table.entities as unknown as Record<string, Parameters<typeof mergeVectorIndexes>[0][string]>,
  )
  const sharers = (indexName: string) => vectorIndexes.get(indexName)?.sharers ?? []
  return {
    ...buildTableOperations(tableName, client),
    create: (options?: CreateTableOptions) =>
      Effect.suspend(() => {
        const def = definition()
        return idempotentCreate(
          client
            .createTable({
              TableName: tableName,
              BillingMode: options?.billingMode ?? "PAY_PER_REQUEST",
              ...def,
            })
            .pipe(
              Effect.asVoid,
              diagnoseVectorLimits("CreateTable", `db.tables create of "${tableName}"`, {
                vectorIndexes: def.VectorIndexes ?? [],
                sharers,
                declared: vectorIndexes.size,
              }),
            ),
        )
      }),
    addVectorIndex: (indexName) => {
      const entry = vectorIndexes.get(indexName)
      if (entry === undefined) {
        return Effect.fail(
          new DynamoError({
            operation: "UpdateTable",
            cause:
              `[EDD-9036] No entity registered on table "${tableName}" declares vector index ` +
              `"${indexName}". Declared: ${[...vectorIndexes.keys()].sort().join(", ") || "(none)"}`,
          }),
        )
      }
      // UpdateTable, like CreateTable, requires every SearchSchema element to
      // be declared in AttributeDefinitions (the composed HASH partition is
      // always a string; filter types were derived at Entity.make).
      const attributeDefinitions = [
        { AttributeName: entry.definition.partitionField, AttributeType: "S" as const },
        ...Object.entries(entry.filterStoredTypes).map(([AttributeName, AttributeType]) => ({
          AttributeName,
          AttributeType,
        })),
      ]
      const spec = toVectorIndexSpec(entry.definition, {
        filters: entry.filters,
        resolveDbName: entry.resolveDbName,
      })
      return client
        .updateTable({
          TableName: tableName,
          AttributeDefinitions: attributeDefinitions,
          VectorIndexUpdates: [{ Create: spec }],
        })
        .pipe(
          Effect.asVoid,
          // The request shows only the index it adds: a count rejection is
          // confirmed against the indexes the table already has, read back
          // after the rejection (unknown if that read fails: passed through).
          Effect.catch((error) =>
            client.describeTable({ TableName: tableName }).pipe(
              Effect.map((described) => described.Table?.VectorIndexes?.length ?? 0),
              Effect.orElseSucceed(() => undefined),
              Effect.flatMap((existing) =>
                Effect.fail(error).pipe(
                  diagnoseVectorLimits(
                    "UpdateTable",
                    `addVectorIndex("${indexName}") on "${tableName}"`,
                    { vectorIndexes: [spec], sharers, declared: vectorIndexes.size, existing },
                  ),
                ),
              ),
            ),
          ),
        )
    },
  }
}

const buildTableOperations = (
  tableName: string,
  client: DynamoClientService,
): Omit<TableOperations, "rekey"> => ({
  create: (options?: CreateTableOptions) =>
    idempotentCreate(
      client
        .createTable({
          TableName: tableName,
          BillingMode: options?.billingMode ?? "PAY_PER_REQUEST",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
        })
        .pipe(Effect.asVoid),
    ),
  delete: () => client.deleteTable({ TableName: tableName }).pipe(Effect.asVoid),
  describe: () => client.describeTable({ TableName: tableName }),
  update: (input) =>
    client
      .updateTable({ ...input, TableName: tableName } as UpdateTableCommandInput)
      .pipe(Effect.asVoid),
  backup: (name) => client.createBackup({ TableName: tableName, BackupName: name }),
  listBackups: () => client.listBackups({ TableName: tableName }),
  restoreFromBackup: (backupArn) =>
    client.restoreTableFromBackup({
      TargetTableName: `${tableName}-restore`,
      BackupArn: backupArn,
    }),
  enablePointInTimeRecovery: () =>
    client
      .updateContinuousBackups({
        TableName: tableName,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      })
      .pipe(Effect.asVoid),
  disablePointInTimeRecovery: () =>
    client
      .updateContinuousBackups({
        TableName: tableName,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      })
      .pipe(Effect.asVoid),
  restoreToPointInTime: (timestamp) =>
    client.restoreTableToPointInTime({
      SourceTableName: tableName,
      TargetTableName: `${tableName}-pitr-restore`,
      RestoreDateTime: timestamp,
    }),
  exportToS3: (s3Bucket, options) =>
    client.exportTableToPointInTime({
      TableArn: tableName, // Will need actual ARN — use describe first
      S3Bucket: s3Bucket,
      S3Prefix: options?.s3Prefix,
      ExportFormat: options?.exportFormat,
    }),
  enableTTL: (attributeName) =>
    client
      .updateTimeToLive({
        TableName: tableName,
        TimeToLiveSpecification: {
          Enabled: true,
          AttributeName: attributeName,
        },
      })
      .pipe(Effect.asVoid),
  disableTTL: (attributeName) =>
    client
      .updateTimeToLive({
        TableName: tableName,
        TimeToLiveSpecification: {
          Enabled: false,
          AttributeName: attributeName,
        },
      })
      .pipe(Effect.asVoid),
  describeTTL: () => client.describeTimeToLive({ TableName: tableName }),
  tag: (tags) =>
    client
      .tagResource({
        ResourceArn: tableName, // Will need actual ARN
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      })
      .pipe(Effect.asVoid),
  untag: (tagKeys) =>
    client
      .untagResource({
        ResourceArn: tableName, // Will need actual ARN
        TagKeys: [...tagKeys],
      })
      .pipe(Effect.asVoid),
  tags: () => client.listTagsOfResource({ ResourceArn: tableName }),
  addVectorIndex: (indexName) =>
    Effect.fail(
      new DynamoError({
        operation: "UpdateTable",
        cause:
          `[EDD-9036] Cannot add vector index "${indexName}" — this table handle was built ` +
          `without entity registrations, so no vector index declarations are available. ` +
          `Pass \`tables\` to DynamoClient.make().`,
      }),
    ),
  removeVectorIndex: (indexName) =>
    client
      .updateTable({
        TableName: tableName,
        VectorIndexUpdates: [{ Delete: { IndexName: indexName } }],
      })
      .pipe(Effect.asVoid),
  waitForVectorIndex: (indexName, options) =>
    waitForVectorIndexReady(tableName, indexName, client, options),
})

/** Default poll interval while waiting for a vector index to finish backfilling. */
const VECTOR_INDEX_POLL_INTERVAL = Duration.seconds(2)
/** Default overall timeout while waiting for a vector index to finish backfilling. */
const VECTOR_INDEX_TIMEOUT = Duration.minutes(10)

/**
 * @internal Poll `DescribeTable` until the named vector index is ACTIVE and no
 * longer backfilling.
 *
 * A vector index absent from `DescribeTable` output is treated as "nothing to
 * wait for" rather than an error: DynamoDB Local silently discards
 * `VectorIndexes` on `CreateTable`, so every local run would otherwise block
 * for the full timeout.
 */
const waitForVectorIndexReady = (
  tableName: string,
  indexName: string,
  client: DynamoClientService,
  options?: {
    readonly pollInterval?: Duration.Input | undefined
    readonly timeout?: Duration.Input | undefined
  },
): Effect.Effect<void, DynamoClientError> => {
  const pollInterval = options?.pollInterval ?? VECTOR_INDEX_POLL_INTERVAL
  const timeout = options?.timeout ?? VECTOR_INDEX_TIMEOUT
  const poll: Effect.Effect<boolean, DynamoClientError> = Effect.gen(function* () {
    const described = yield* client.describeTable({ TableName: tableName })
    const indexes = described.Table?.VectorIndexes
    if (indexes === undefined || indexes.length === 0) return true
    const found = indexes.find((i) => i.IndexName === indexName)
    if (found === undefined) return true
    return found.IndexStatus === "ACTIVE" && found.Backfilling !== true
  })
  return Effect.gen(function* () {
    while (true) {
      if (yield* poll) return
      yield* Effect.sleep(pollInterval)
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new DynamoError({
            operation: "DescribeTable",
            cause:
              `Vector index "${indexName}" on table "${tableName}" did not become ACTIVE within ` +
              `${Duration.format(Duration.fromInputUnsafe(timeout))}.`,
          }),
        ),
    }),
  )
}

/** @internal Classify an AWS SDK error into a specific tagged error type. */
export const classifyError =
  (operation: string) =>
  (thrown: unknown): DynamoClientError => {
    const cause = redactCredentialRefusal(thrown)
    if (isAwsThrottling(cause)) return new ThrottlingError({ operation, cause })
    if (isAwsValidationError(cause)) return new DynamoValidationError({ operation, cause })
    if (isAwsInternalServerError(cause)) return new InternalServerError({ operation, cause })
    if (isAwsResourceNotFound(cause)) return new ResourceNotFoundError({ operation, cause })
    return new DynamoError({ operation, cause })
  }

/** @internal Build the DynamoClient service implementation from resolved config values. */
const buildService = (
  region: string,
  endpoint: string | undefined,
  credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined,
  options: ClientOptions,
) =>
  Effect.gen(function* () {
    const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = { region }
    if (endpoint !== undefined) clientConfig.endpoint = endpoint
    if (credentials !== undefined) clientConfig.credentials = credentials
    if (options.requestHandler !== undefined) clientConfig.requestHandler = options.requestHandler
    if (options.maxAttempts !== undefined) clientConfig.maxAttempts = options.maxAttempts
    const client = yield* acquireSdkClient(() => new DynamoDBClient(clientConfig))
    return {
      createTable: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new CreateTableCommand(input), { abortSignal: signal }),
          catch: classifyError("CreateTable"),
        }),
      deleteTable: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new DeleteTableCommand(input), { abortSignal: signal }),
          catch: classifyError("DeleteTable"),
        }),
      describeTable: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new DescribeTableCommand(input), { abortSignal: signal }),
          catch: classifyError("DescribeTable"),
        }),
      putItem: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new PutItemCommand(input), { abortSignal: signal }),
          catch: classifyError("PutItem"),
        }),
      getItem: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new GetItemCommand(input), { abortSignal: signal }),
          catch: classifyError("GetItem"),
        }),
      deleteItem: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new DeleteItemCommand(input), { abortSignal: signal }),
          catch: classifyError("DeleteItem"),
        }),
      updateItem: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new UpdateItemCommand(input), { abortSignal: signal }),
          catch: classifyError("UpdateItem"),
        }),
      query: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new QueryCommand(input), { abortSignal: signal }),
          catch: classifyError("Query"),
        }),
      scan: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new ScanCommand(input), { abortSignal: signal }),
          catch: classifyError("Scan"),
        }),
      searchVectors: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new SearchVectorsCommand(input), { abortSignal: signal }),
          catch: classifyError("SearchVectors"),
        }),
      batchGetItem: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new BatchGetItemCommand(input), { abortSignal: signal }),
          catch: classifyError("BatchGetItem"),
        }),
      batchWriteItem: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new BatchWriteItemCommand(input), { abortSignal: signal }),
          catch: classifyError("BatchWriteItem"),
        }),
      transactGetItems: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new TransactGetItemsCommand(input), { abortSignal: signal }),
          catch: classifyError("TransactGetItems"),
        }),
      transactWriteItems: (input) =>
        Effect.tryPromise({
          try: (signal) =>
            client.send(new TransactWriteItemsCommand(input), { abortSignal: signal }),
          catch: classifyError("TransactWriteItems"),
        }),
      // --- Table management ---
      updateTable: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new UpdateTableCommand(input), { abortSignal: signal }),
          catch: classifyError("UpdateTable"),
        }),
      listTables: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new ListTablesCommand(input), { abortSignal: signal }),
          catch: classifyError("ListTables"),
        }),
      // --- Backup ---
      createBackup: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new CreateBackupCommand(input), { abortSignal: signal }),
          catch: classifyError("CreateBackup"),
        }),
      deleteBackup: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new DeleteBackupCommand(input), { abortSignal: signal }),
          catch: classifyError("DeleteBackup"),
        }),
      listBackups: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new ListBackupsCommand(input), { abortSignal: signal }),
          catch: classifyError("ListBackups"),
        }),
      restoreTableFromBackup: (input) =>
        Effect.tryPromise({
          try: (signal) =>
            client.send(new RestoreTableFromBackupCommand(input), { abortSignal: signal }),
          catch: classifyError("RestoreTableFromBackup"),
        }),
      // --- PITR ---
      describeContinuousBackups: (input) =>
        Effect.tryPromise({
          try: (signal) =>
            client.send(new DescribeContinuousBackupsCommand(input), { abortSignal: signal }),
          catch: classifyError("DescribeContinuousBackups"),
        }),
      updateContinuousBackups: (input) =>
        Effect.tryPromise({
          try: (signal) =>
            client.send(new UpdateContinuousBackupsCommand(input), { abortSignal: signal }),
          catch: classifyError("UpdateContinuousBackups"),
        }),
      restoreTableToPointInTime: (input) =>
        Effect.tryPromise({
          try: (signal) =>
            client.send(new RestoreTableToPointInTimeCommand(input), { abortSignal: signal }),
          catch: classifyError("RestoreTableToPointInTime"),
        }),
      // --- Export ---
      exportTableToPointInTime: (input) =>
        Effect.tryPromise({
          try: (signal) =>
            client.send(new ExportTableToPointInTimeCommand(input), { abortSignal: signal }),
          catch: classifyError("ExportTableToPointInTime"),
        }),
      describeExport: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new DescribeExportCommand(input), { abortSignal: signal }),
          catch: classifyError("DescribeExport"),
        }),
      // --- TTL ---
      updateTimeToLive: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new UpdateTimeToLiveCommand(input), { abortSignal: signal }),
          catch: classifyError("UpdateTimeToLive"),
        }),
      describeTimeToLive: (input) =>
        Effect.tryPromise({
          try: (signal) =>
            client.send(new DescribeTimeToLiveCommand(input), { abortSignal: signal }),
          catch: classifyError("DescribeTimeToLive"),
        }),
      // --- Tags ---
      tagResource: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new TagResourceCommand(input), { abortSignal: signal }),
          catch: classifyError("TagResource"),
        }),
      untagResource: (input) =>
        Effect.tryPromise({
          try: (signal) => client.send(new UntagResourceCommand(input), { abortSignal: signal }),
          catch: classifyError("UntagResource"),
        }),
      listTagsOfResource: (input) =>
        Effect.tryPromise({
          try: (signal) =>
            client.send(new ListTagsOfResourceCommand(input), { abortSignal: signal }),
          catch: classifyError("ListTagsOfResource"),
        }),
    } satisfies DynamoClientService
  })
