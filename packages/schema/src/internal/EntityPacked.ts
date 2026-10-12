/**
 * @internal Packed entity fields (`storedAs: DynamoModel.Packed(...)`) —
 * definition-time guards and the derived storage plan.
 *
 * Shared by the pure `Entity.make` (this package) and the runtime one
 * (`effect-dynamodb`), through `buildEntityDefinition`. See
 * `docs/designs/storage-encoding.md` §6.1 and `DESIGN.md §7 "Packed Storage"`.
 *
 * Guards (thrown as plain `Error`s at `Entity.make()`, like the sparse ones):
 *
 * - `[EDD-9073]` the packed field does not exist on the model, or its encoded
 *   side is not object- or array-shaped (a scalar, a date — so never a TTL
 *   attribute — binary, a set, or a union with such a member).
 * - `[EDD-9072]` the packed field feeds a key or index attribute: a primary-key
 *   or secondary-index composite (collection-injected indexes are checked again
 *   when injected — {@link packedIndexRefusal}), `timeSeries.orderBy`, or a
 *   vector index partition / filter field.
 * - `[EDD-9074]` a unique constraint names the packed field.
 * - `[EDD-9075]` the packed field is a `DynamoModel.ref` field.
 *
 * Sparse + packed is impossible by construction: a field has one `storedAs`.
 */

import type { Schema } from "effect"
import { type PackedConfig, isRefField } from "../DynamoModel.js"
import type { IndexDefinition } from "../KeyComposer.js"
import type { VectorIndexConfig } from "../VectorIndex.js"
import type { TimeSeriesConfig, UniqueConfig } from "./EntityConfig.js"
import { resolveUniqueFields } from "./EntitySchemas.js"
import { isDispatchEligible, packedShape } from "./PackedCodec.js"

/** The storage plan of an entity's packed fields. */
export interface PackedPlan {
  /** Domain field name → config, for every field configured packed. */
  readonly packedFields: Readonly<Record<string, PackedConfig>>
  /** Stored attribute name (after `field` renames) → config. */
  readonly packedAttributes: Readonly<Record<string, PackedConfig>>
  /**
   * Stored attribute names a reader dispatches on by stored form: every packed
   * attribute, plus every non-sparse model field whose encoded side is
   * object- or array-shaped (a native value of it is never `S` or `B`, so a
   * value written while the field was packed still reads after it is not).
   */
  readonly dispatchAttributes: ReadonlyArray<string>
  readonly hasPackedFields: boolean
}

const refusal = (code: string, entityType: string, field: string, message: string): Error =>
  new Error(`[${code}] Entity "${entityType}": packed field "${field}" ${message}`)

/**
 * Why a (possibly injected) index cannot be added to an entity with these
 * packed fields, or `undefined`: one of its composites is packed (`[EDD-9072]`).
 */
export const packedIndexRefusal = (
  entityType: string,
  packedFields: Readonly<Record<string, PackedConfig>>,
  indexName: string,
  def: IndexDefinition,
): string | undefined => {
  for (const attr of [...def.pk.composite, ...def.sk.composite]) {
    if (attr in packedFields) {
      return (
        `[EDD-9072] Entity "${entityType}": packed field "${attr}" cannot be a composite of ` +
        `${indexName === "primary" ? "the primary key" : `index "${indexName}"`}. A packed value ` +
        "is one opaque JSON string or compressed binary attribute; key composites must be " +
        "scalar model values."
      )
    }
  }
  return undefined
}

/**
 * Validate the packed fields of an entity definition and derive its
 * {@link PackedPlan}. Throws on the first refusal (see the module header).
 */
export const resolvePackedPlan = (args: {
  readonly entityType: string
  readonly model: Schema.Top
  readonly packedFields: Readonly<Record<string, PackedConfig>>
  readonly sparseFields: Readonly<Record<string, unknown>>
  readonly modelFields: Readonly<Record<string, Schema.Top>>
  readonly indexes: Readonly<Record<string, IndexDefinition>>
  readonly unique: UniqueConfig | undefined
  readonly timeSeries: TimeSeriesConfig<any> | undefined
  readonly vectorIndexes: Readonly<Record<string, VectorIndexConfig>> | undefined
  readonly resolveDbName: (domainName: string) => string
}): PackedPlan => {
  const { entityType, packedFields, modelFields } = args
  for (const [field] of Object.entries(packedFields)) {
    const schema = modelFields[field]
    if (schema === undefined) {
      throw refusal(
        "EDD-9073",
        entityType,
        field,
        `does not exist on the model. Valid model fields: ${Object.keys(modelFields).sort().join(", ")}`,
      )
    }
    const shape = packedShape(schema)
    if (shape._tag === "Refused") {
      throw refusal(
        "EDD-9073",
        entityType,
        field,
        `cannot be packed: ${shape.reason}. Packed storage holds object- or array-shaped JSON ` +
          "(a scalar or date — including a TTL attribute — stays native).",
      )
    }
    if (isRefField(field, args.model)) {
      throw refusal(
        "EDD-9075",
        entityType,
        field,
        "is a DynamoModel.ref field. A ref is a denormalised copy the library writes and " +
          "cascades into; it stays a native map.",
      )
    }
    for (const [indexName, def] of Object.entries(args.indexes)) {
      const refused = packedIndexRefusal(entityType, packedFields, indexName, def)
      if (refused !== undefined && [...def.pk.composite, ...def.sk.composite].includes(field)) {
        throw new Error(refused)
      }
    }
    if (args.timeSeries?.orderBy === field) {
      throw refusal(
        "EDD-9072",
        entityType,
        field,
        "cannot be timeSeries.orderBy: the event clock is compared by DynamoDB (CAS) and " +
          "composed into the event sort key.",
      )
    }
    for (const [name, vector] of Object.entries(args.vectorIndexes ?? {})) {
      if ((vector.partition ?? []).includes(field)) {
        throw refusal(
          "EDD-9072",
          entityType,
          field,
          `cannot be a partition composite of vector index "${name}".`,
        )
      }
      if ((vector.filters ?? []).includes(field)) {
        throw refusal(
          "EDD-9072",
          entityType,
          field,
          `cannot be a filter field of vector index "${name}": DynamoDB filters on the stored value.`,
        )
      }
    }
    for (const [constraint, def] of Object.entries(args.unique ?? {})) {
      if (resolveUniqueFields(def).includes(field)) {
        throw refusal(
          "EDD-9074",
          entityType,
          field,
          `cannot be named by unique constraint "${constraint}": its sentinel is composed from ` +
            "scalar field values.",
        )
      }
    }
  }

  const packedAttributes: Record<string, PackedConfig> = {}
  for (const [field, config] of Object.entries(packedFields)) {
    packedAttributes[args.resolveDbName(field)] = config
  }
  const dispatch = new Set<string>(Object.keys(packedAttributes))
  for (const [field, schema] of Object.entries(modelFields)) {
    if (field in args.sparseFields) continue
    if (isDispatchEligible(schema)) dispatch.add(args.resolveDbName(field))
  }
  return {
    packedFields,
    packedAttributes,
    dispatchAttributes: [...dispatch],
    hasPackedFields: Object.keys(packedFields).length > 0,
  }
}
