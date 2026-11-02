/**
 * @internal Offloaded entity fields (#179) — definition-time guards and the
 * resolved offload settings.
 *
 * Two field kinds offload to the blob store: **overflow** fields
 * (`storedAs: DynamoModel.Packed({ external })`, which are packed fields and
 * so also pass every Packed guard of `internal/EntityPacked.ts`) and
 * **binary** fields (`storedAs: DynamoModel.External(...)`). Shared by the
 * pure `Entity.make` (this package) and the runtime one (`effect-dynamodb`),
 * through `buildEntityDefinition`; the aggregate and EventStore guards reuse
 * the pieces exported here. See `docs/designs/blob-offload.md` §3, §13–§15 and
 * `DESIGN.md §7 "Offloaded Storage"`.
 *
 * Guards (thrown as plain `Error`s at `Entity.make()`, like the Packed ones):
 *
 * - `[EDD-9111]` an `External` field does not exist on the model, or its
 *   encoded side is not `Uint8Array`.
 * - `[EDD-9142]` an `External` field is a key or index attribute source (a
 *   primary-key / secondary-index composite or a `shards.by` source,
 *   {@link externalIndexRefusal}, or `timeSeries.orderBy`), a unique-constraint field, a `DynamoModel.ref`
 *   field, the entity's identifier (which refs and cascade indexes compose
 *   into keys), or a vector index source, partition or filter field.
 * - `[EDD-9143]` a ref whose schema includes a field the referenced entity
 *   offloads: the denormalised copy would inline it, need to marshal a lazy
 *   handle, or copy a pointer across item families.
 * - `[EDD-9114]` invalid `offload` options (see {@link resolveOffloadOptions}).
 */

import { type Schema, SchemaAST } from "effect"
import {
  type ExternalConfig,
  type ExternalPackedConfig,
  getExternalFields,
  getIdentifierField,
  getPackedFields,
  isExternalPackedConfig,
  isRefField,
} from "../DynamoModel.js"
import type { IndexDefinition } from "../KeyComposer.js"
import type { VectorIndexConfig } from "../VectorIndex.js"
import type {
  OffloadConfig,
  ResolvedOffload,
  TimeSeriesConfig,
  UniqueConfig,
} from "./EntityConfig.js"
import { resolveUniqueFields } from "./EntitySchemas.js"
import { binaryShapeRefusal } from "./PackedCodec.js"
import { firstTypeParameterAst } from "./SchemaAccessors.js"

/** The largest `offload.itemBudget`: DynamoDB's item limit, 400 KB. */
export const MAX_ITEM_BUDGET = 409_600

/** The longest `offload.prefix`, in bytes. */
export const MAX_OFFLOAD_PREFIX_BYTES = 256

/** RFC 3986 unreserved characters, plus `/`. */
const PREFIX_PATTERN = /^[A-Za-z0-9\-._~/]+$/

/** The offloaded fields of a model, by kind (domain field name → config). */
export interface OffloadedFields {
  readonly overflow: Readonly<Record<string, ExternalPackedConfig>>
  readonly binary: Readonly<Record<string, ExternalConfig>>
}

/** The offloaded fields a (possibly configured) model declares. */
export const offloadedFieldsOf = (model: Schema.Top): OffloadedFields => {
  const overflow: Record<string, ExternalPackedConfig> = {}
  for (const [field, config] of Object.entries(getPackedFields(model))) {
    if (isExternalPackedConfig(config)) overflow[field] = config
  }
  return { overflow, binary: getExternalFields(model) }
}

/** The resolved `offload` options of a member. */
export interface OffloadOptions {
  readonly itemBudget: number | undefined
  readonly prefix: string | undefined
}

/**
 * Validate a member's `offload` options (`[EDD-9114]`): an object with only
 * `itemBudget` (a safe integer in 1 … 409,600) and `prefix` (a non-empty
 * string of RFC 3986 unreserved characters and `/`, at most 256 bytes, not
 * starting with `/`); `itemBudget` only on a member with an overflow value,
 * and `offload` only on a member that offloads something.
 *
 * `member` labels messages (`Entity "Document"`, `EventStream "Ledger"`).
 */
export const resolveOffloadOptions = (
  member: string,
  options: unknown,
  kinds: { readonly overflow: boolean; readonly offloaded: boolean },
): OffloadOptions => {
  if (options === undefined) return { itemBudget: undefined, prefix: undefined }
  const fail = (message: string): never => {
    throw new Error(`[EDD-9114] ${member}: ${message}`)
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return fail(
      `offload must be an object { itemBudget?, prefix? }; received ` +
        `${options === null ? "null" : Array.isArray(options) ? "an array" : typeof options}.`,
    )
  }
  for (const key of Object.keys(options)) {
    if (key !== "itemBudget" && key !== "prefix") {
      fail(`unknown offload option "${key}" (expected optional "itemBudget" and "prefix").`)
    }
  }
  if (!kinds.offloaded) {
    fail(
      "offload is set, but nothing is offloaded. Declare an overflow field " +
        "(DynamoModel.Packed({ external })) or a binary field (DynamoModel.External()) first.",
    )
  }
  const { itemBudget, prefix } = options as {
    readonly itemBudget?: unknown
    readonly prefix?: unknown
  }
  if (itemBudget !== undefined) {
    if (
      typeof itemBudget !== "number" ||
      !Number.isSafeInteger(itemBudget) ||
      itemBudget < 1 ||
      itemBudget > MAX_ITEM_BUDGET
    ) {
      fail(
        `offload.itemBudget must be a safe integer in 1 … ${MAX_ITEM_BUDGET} (stored item ` +
          `bytes), got ${String(itemBudget)}.`,
      )
    }
    if (!kinds.overflow) {
      fail(
        "offload.itemBudget is set, but nothing can be offloaded to meet it: the budget routes " +
          "overflow values (DynamoModel.Packed({ external })), and there are none.",
      )
    }
  }
  if (prefix !== undefined) {
    if (
      typeof prefix !== "string" ||
      prefix.length === 0 ||
      prefix.length > MAX_OFFLOAD_PREFIX_BYTES ||
      !PREFIX_PATTERN.test(prefix) ||
      prefix.startsWith("/")
    ) {
      fail(
        `offload.prefix must be a non-empty string of RFC 3986 unreserved characters ` +
          `(A–Z a–z 0–9 - . _ ~) and "/", at most ${MAX_OFFLOAD_PREFIX_BYTES} bytes, not ` +
          `starting with "/"; got ${typeof prefix === "string" ? JSON.stringify(prefix) : String(prefix)}.`,
      )
    }
  }
  return {
    itemBudget: itemBudget as number | undefined,
    prefix: prefix as string | undefined,
  }
}

/**
 * Why an index cannot be declared on an entity with these `External` fields,
 * or `undefined` (`[EDD-9142]`): a binary field is a source of its write
 * sharding (`shards.by`, #183), whose hash would read the stored pointer, or
 * one of its composites. Matched by own key (`Object.hasOwn`) as
 * `packedIndexRefusal` matches packed ones. (An overflow field is a packed
 * one: as a composite it is refused by the Packed guard, and `shards.by`
 * names only composites.)
 */
export const externalIndexRefusal = (
  entityType: string,
  externalFields: Readonly<Record<string, ExternalConfig>>,
  indexName: string,
  def: IndexDefinition,
): string | undefined => {
  for (const attr of def.shards?.by ?? []) {
    if (Object.hasOwn(externalFields, attr)) {
      return (
        `[EDD-9142] Entity "${entityType}": External field "${attr}" cannot be a shards.by ` +
        `source of index "${indexName}". The shard is hashed from the field's value, which lives ` +
        "in the blob store; shard sources must be scalar sort key composites."
      )
    }
  }
  for (const attr of [...def.pk.composite, ...def.sk.composite]) {
    if (Object.hasOwn(externalFields, attr)) {
      return (
        `[EDD-9142] Entity "${entityType}": External field "${attr}" cannot be a composite of ` +
        `${indexName === "primary" ? "the primary key" : `index "${indexName}"`}. Its value ` +
        "lives in the blob store; key composites must be scalar model values."
      )
    }
  }
  return undefined
}

/** The domain property names a (struct- or class-shaped) schema declares. */
const propertyNames = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST>, out: Set<string>): void => {
  if (seen.has(ast)) return
  seen.add(ast)
  const type = SchemaAST.toType(ast)
  if (SchemaAST.isObjects(type)) {
    for (const signature of type.propertySignatures) {
      if (typeof signature.name === "string") out.add(signature.name)
    }
  } else if (SchemaAST.isUnion(type)) {
    for (const member of type.types) propertyNames(member, seen, out)
  } else if (SchemaAST.isSuspend(type)) {
    propertyNames(type.thunk(), seen, out)
  } else if (SchemaAST.isDeclaration(type)) {
    // A Schema.Class: its fields are the declaration's type parameter.
    const fields = firstTypeParameterAst(type)
    if (fields !== undefined) propertyNames(fields, seen, out)
  }
}

/**
 * Why the ref `refName` (a denormalised copy of `target`, described by
 * `refSchema`) cannot be declared, or `undefined`: its schema includes a field
 * the referenced entity offloads (`[EDD-9143]`). `owner` labels the message
 * (`Entity "Order"`, `Aggregate edge "team"`).
 */
export const refOffloadRefusal = (
  owner: string,
  refName: string,
  refSchema: Schema.Top,
  target: { readonly entityType: string; readonly model: Schema.Top },
): string | undefined => {
  const offloaded = offloadedFieldsOf(target.model)
  const names = new Set<string>()
  propertyNames(refSchema.ast, new Set(), names)
  const included = [...Object.keys(offloaded.overflow), ...Object.keys(offloaded.binary)].filter(
    (field) => names.has(field),
  )
  if (included.length === 0) return undefined
  return (
    `[EDD-9143] ${owner}: ref "${refName}" copies entity "${target.entityType}", and its schema ` +
    `includes ${included.map((field) => `"${field}"`).join(", ")}, which that entity offloads to ` +
    "the blob store. A ref is a denormalised copy: it would inline the value (risking the 400 KB " +
    "item limit) or copy a pointer across item families. Reference a subset model without " +
    (included.length === 1 ? "that field." : "those fields.")
  )
}

/** The offload plan of an entity definition. */
export interface OffloadPlan {
  /** Domain field name → config, for every `External` (binary) field. */
  readonly externalFields: Readonly<Record<string, ExternalConfig>>
  /** Domain field name → config, for every overflow field (`Packed({ external })`). */
  readonly overflowFields: Readonly<Record<string, ExternalPackedConfig>>
  /** The resolved `entity.offload`; `undefined` when the entity offloads nothing. */
  readonly offload: ResolvedOffload | undefined
}

const refusal = (code: string, entityType: string, field: string, message: string): Error =>
  new Error(`[${code}] Entity "${entityType}": External field "${field}" ${message}`)

/**
 * Validate the offloaded fields and `offload` options of an entity definition
 * and derive its {@link OffloadPlan}. Throws on the first refusal (see the
 * module header).
 */
export const resolveOffloadPlan = (args: {
  readonly entityType: string
  readonly model: Schema.Top
  readonly modelFields: Readonly<Record<string, Schema.Top>>
  readonly indexes: Readonly<Record<string, IndexDefinition>>
  readonly unique: UniqueConfig | undefined
  readonly timeSeries: TimeSeriesConfig<any> | undefined
  readonly vectorIndexes: Readonly<Record<string, VectorIndexConfig>> | undefined
  readonly refs:
    | Readonly<
        Record<
          string,
          { readonly entity: { readonly entityType: string; readonly model: Schema.Top } }
        >
      >
    | undefined
  readonly offload: OffloadConfig | undefined
}): OffloadPlan => {
  const { entityType, modelFields } = args
  const fields = offloadedFieldsOf(args.model)
  const identifier = getIdentifierField(args.model)?.name

  for (const field of Object.keys(fields.binary)) {
    const schema = modelFields[field]
    if (schema === undefined) {
      throw refusal(
        "EDD-9111",
        entityType,
        field,
        `does not exist on the model. Valid model fields: ${Object.keys(modelFields).sort().join(", ")}`,
      )
    }
    const notBinary = binaryShapeRefusal(schema)
    if (notBinary !== undefined) {
      throw refusal(
        "EDD-9111",
        entityType,
        field,
        `must be binary: ${notBinary}. DynamoModel.External stores a Uint8Array field ` +
          "(Schema.Uint8Array, optionally optional / NullOr); Uint8ArrayFromBase64 stores text.",
      )
    }
    if (isRefField(field, args.model)) {
      throw refusal(
        "EDD-9142",
        entityType,
        field,
        "is a DynamoModel.ref field. A ref is a denormalised copy the library writes and " +
          "cascades into; it stays a native map.",
      )
    }
    if (identifier === field) {
      throw refusal(
        "EDD-9142",
        entityType,
        field,
        "is the entity's identifier. Refs to the entity and their cascade indexes compose it " +
          "into keys, which must be scalar model values.",
      )
    }
    for (const [indexName, def] of Object.entries(args.indexes)) {
      if ([...(def.shards?.by ?? []), ...def.pk.composite, ...def.sk.composite].includes(field)) {
        throw new Error(externalIndexRefusal(entityType, fields.binary, indexName, def))
      }
    }
    if (args.timeSeries?.orderBy === field) {
      throw refusal(
        "EDD-9142",
        entityType,
        field,
        "cannot be timeSeries.orderBy: the event clock is compared by DynamoDB (CAS) and " +
          "composed into the event sort key.",
      )
    }
    for (const [name, vector] of Object.entries(args.vectorIndexes ?? {})) {
      if ((vector.source?.fields ?? []).includes(field)) {
        throw refusal(
          "EDD-9142",
          entityType,
          field,
          `cannot be a source field of vector index "${name}": the embedder reads text.`,
        )
      }
      if ((vector.partition ?? []).includes(field)) {
        throw refusal(
          "EDD-9142",
          entityType,
          field,
          `cannot be a partition composite of vector index "${name}".`,
        )
      }
      if ((vector.filters ?? []).includes(field)) {
        throw refusal(
          "EDD-9142",
          entityType,
          field,
          `cannot be a filter field of vector index "${name}": DynamoDB filters on the stored value.`,
        )
      }
    }
    for (const [constraint, def] of Object.entries(args.unique ?? {})) {
      if (resolveUniqueFields(def).includes(field)) {
        throw refusal(
          "EDD-9142",
          entityType,
          field,
          `cannot be named by unique constraint "${constraint}": its sentinel is composed from ` +
            "scalar field values.",
        )
      }
    }
  }

  for (const [refName, refValue] of Object.entries(args.refs ?? {})) {
    const refSchema = modelFields[refName]
    // A ref naming no model field is refused when refs are resolved.
    if (refSchema === undefined || refValue?.entity?.model === undefined) continue
    const refused = refOffloadRefusal(`Entity "${entityType}"`, refName, refSchema, refValue.entity)
    if (refused !== undefined) throw new Error(refused)
  }

  const overflow = Object.keys(fields.overflow)
  const binary = Object.keys(fields.binary)
  const options = resolveOffloadOptions(`Entity "${entityType}"`, args.offload, {
    overflow: overflow.length > 0,
    offloaded: overflow.length + binary.length > 0,
  })

  return {
    externalFields: fields.binary,
    overflowFields: fields.overflow,
    offload:
      overflow.length + binary.length === 0
        ? undefined
        : Object.freeze({
            itemBudget: options.itemBudget,
            prefix: options.prefix,
            overflow: Object.freeze(overflow),
            binary: Object.freeze(binary),
          }),
  }
}
