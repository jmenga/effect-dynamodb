/**
 * @internal Aggregate schema derivation — input and update schema building.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import { Option, Schema, SchemaAST } from "effect"
import { ConfiguredModelTag } from "../DynamoModel.js"
import type { AggregateEdge, ManyEdge, RefEntity } from "./AggregateEdges.js"
import type {
  AggregateInputType,
  AggregateStampNames,
  BoundSubAggregate,
  SchemaFieldsOf,
} from "./AggregateTypes.js"
import { bothKindsKeyRefusal, storedFieldAtPath } from "./CompositeCodec.js"
import type { TimestampsConfig } from "./EntityConfig.js"
import { optionalField, type ResolvedSystemFields, resolveSystemFields } from "./EntitySchemas.js"
import {
  extractArrayElement as extractArrayElementImpl,
  extractKeyedValue,
  getSchemaFields as getSchemaFieldsImpl,
  isFieldOptional as isFieldOptionalImpl,
} from "./SchemaAccessors.js"

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * `timestamps` resolved over a value's fields, by the entity's rules: `Schema.optional` wraps the
 * value that's read, a date is the library's, and any other field of that name is the caller's.
 */
export const resolveAggregateStamps = (
  timestamps: TimestampsConfig | undefined,
  fields: Record<string, Schema.Top> | undefined,
  owner: string,
): ResolvedSystemFields =>
  resolveSystemFields(
    timestamps,
    undefined,
    undefined,
    Object.fromEntries(
      Object.entries(fields ?? {}).map(([name, field]) => [
        name,
        optionalField(field)?.inner ?? field,
      ]),
    ),
    {},
    owner,
  )

/**
 * `[EDD-9121]`: a partition key the library would move on every write. An aggregate's rows all live
 * under its partition key and a write only ever `Put`s rows under it, so the key would stop matching
 * the value at the first update, and nothing could find the aggregate by what it holds.
 */
export const refuseAggregateKeyOverMovingValue = (
  aggregate: string,
  timestamps: TimestampsConfig | undefined,
  fields: Record<string, Schema.Top> | undefined,
  composite: ReadonlyArray<string>,
): void => {
  const { updatedAt } = resolveAggregateStamps(timestamps, fields, `Aggregate "${aggregate}"`)
  if (updatedAt !== null && composite.includes(updatedAt)) {
    throw new Error(
      `[EDD-9121] Aggregate "${aggregate}": its partition key can't be composed from ` +
        `"${updatedAt}". The library changes it on every write and a partition key never changes, ` +
        `so the key would stop matching the value at the first update. Remove it from the ` +
        `partition key, or use a field the library doesn't manage.`,
    )
  }
}

/**
 * The fields of a `many` edge's ELEMENT, read off the parent model's field: the array's element
 * (`players: Schema.Array(PlayerSheet)` → `PlayerSheet`'s), or a keyed collection's value, the
 * elements of a custom `decompose` over it. `undefined` when the field says nothing about what its
 * `decompose` returns, or the element exposes no fields (a scalar, or an opaque ref).
 */
export const manyElementFields = (
  parentFields: Record<string, Schema.Top> | undefined,
  edgeName: string,
): Record<string, Schema.Top> | undefined => {
  const element = manyElementSchema(parentFields, edgeName)
  return element === undefined ? undefined : getSchemaFields(element)
}

/**
 * `[EDD-9121]`: a `many` edge's sort key the library would move on every write, on the root's edges
 * and those of the sub-aggregates under it. Whose `updatedAt` it is, is the row's: a field of that
 * name of another type is the caller's, and a root's turns the stamp off on every row.
 */
export const refuseManySortKeysOverMovingValue = (
  aggregate: string,
  timestamps: TimestampsConfig | undefined,
  rootFields: Record<string, Schema.Top> | undefined,
  rootEdges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
): void => {
  const owner = `Aggregate "${aggregate}"`
  if (resolveAggregateStamps(timestamps, rootFields, owner).updatedAt === null) return
  const walk = (
    fields: Record<string, Schema.Top> | undefined,
    edges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  ): void => {
    for (const [name, edge] of Object.entries(edges)) {
      if (!("_tag" in edge)) continue
      if (edge._tag === "BoundSubAggregate") {
        const sub = (edge as BoundSubAggregate<any>).aggregate
        walk(getSchemaFields(sub.schema), sub.edges)
      } else if (edge._tag === "ManyEdge") {
        const entity = (edge as ManyEdge).entity
        const element =
          manyElementFields(fields, name) ??
          (entity === undefined ? undefined : getSchemaFields(unwrapModel(entity.model)))
        const { updatedAt } = resolveAggregateStamps(timestamps, element, owner)
        if (updatedAt !== null && (edge as ManyEdge).sk?.composite.includes(updatedAt) === true) {
          throw new Error(
            `[EDD-9121] Aggregate "${aggregate}": edge "${name}"'s sort key can't be composed ` +
              `from "${updatedAt}". The library changes it on every write and a sort key never ` +
              `changes, so the key would stop matching the value at the first update.`,
          )
        }
      }
    }
  }
  walk(rootFields, rootEdges)
}

/**
 * `[EDD-9128]`: a key an aggregate composes from a field storing both numeric kinds
 * (`bothKindsKeyRefusal`): its partition key, its collection and list keys, and a `many` edge's sort
 * key, on the root's edges and those of the sub-aggregates under it. A sort-key composite that's a
 * path into a value (`player.id`) is followed to the field a row stores there, through an optional,
 * nullable, suspended or class value on the way (`storedFieldAtPath`): a value transformed on the
 * way is judged by what it's stored as, so a struct storing a number at `n` and decoding it to a
 * union of both kinds loads, and one storing either kind there doesn't.
 */
export const refuseAggregateKeysOverBothKinds = (
  aggregate: string,
  rootFields: Record<string, Schema.Top> | undefined,
  config: {
    readonly pk: { readonly composite: ReadonlyArray<string> }
    readonly collection?: { readonly sk?: { readonly composite?: ReadonlyArray<string> } }
    readonly list?: {
      readonly pk: { readonly composite: ReadonlyArray<string> }
      readonly sk: { readonly composite: ReadonlyArray<string> }
    }
  },
  rootEdges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
): void => {
  const owner = `Aggregate "${aggregate}"`
  const refuse = (
    where: string,
    fields: Record<string, Schema.Top> | undefined,
    composites: ReadonlyArray<string>,
  ): void => {
    for (const attr of composites) {
      const field = storedFieldAtPath(fields, attr)
      if (field === undefined) continue
      const refused = bothKindsKeyRefusal(owner, where, attr, field)
      if (refused !== undefined) throw refused
    }
  }
  refuse("its partition key", rootFields, config.pk.composite)
  refuse("its collection sort key", rootFields, config.collection?.sk?.composite ?? [])
  if (config.list !== undefined) {
    refuse("its list partition key", rootFields, config.list.pk.composite)
    refuse("its list sort key", rootFields, config.list.sk.composite)
  }
  const walk = (
    fields: Record<string, Schema.Top> | undefined,
    edges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  ): void => {
    for (const [name, edge] of Object.entries(edges)) {
      if (!("_tag" in edge)) continue
      if (edge._tag === "BoundSubAggregate") {
        const sub = (edge as BoundSubAggregate<any>).aggregate
        walk(getSchemaFields(sub.schema), sub.edges)
      } else if (edge._tag === "ManyEdge") {
        const entity = (edge as ManyEdge).entity
        const element =
          manyElementFields(fields, name) ??
          (entity === undefined ? undefined : getSchemaFields(unwrapModel(entity.model)))
        refuse(`edge "${name}"'s sort key`, element, (edge as ManyEdge).sk?.composite ?? [])
      }
    }
  }
  walk(rootFields, rootEdges)
}

/** The dates the rows of a value with `fields` declare, of those `timestamps` stamps. */
const managedDates = (
  stamps: AggregateStamps,
  fields: Record<string, Schema.Top>,
): ReadonlySet<string> => {
  const own = resolveAggregateStamps(stamps.config, fields, "Aggregate")
  return new Set(
    [own.createdAtCollision ? own.createdAt : null, own.updatedAtCollision ? own.updatedAt : null]
      .filter((name): name is string => name !== null)
      .filter((name) => stamps.names.has(name)),
  )
}

/** `timestamps`, and the names it stamps on this aggregate's rows. */
interface AggregateStamps {
  readonly config: TimestampsConfig | undefined
  readonly names: ReadonlySet<string>
}

/** A managed date's input field: optional, supplied or not. */
const stampInput = (field: Schema.Top): Schema.Top =>
  Schema.optionalKey((optionalField(field)?.inner ?? field) as Schema.Top) as unknown as Schema.Top

/** A row's value on the input: as the model has it, but for the dates the library stamps. */
const rowInput = (schema: Schema.Top, stamps: AggregateStamps): Schema.Top => {
  const fields = getSchemaFields(schema)
  if (fields === undefined) return schema
  const managed = managedDates(stamps, fields)
  if (managed.size === 0) return schema
  return Schema.Struct(
    Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        managed.has(name) ? stampInput(field) : field,
      ]),
    ) as any,
  )
}

// ---------------------------------------------------------------------------
// Input schema derivation
// ---------------------------------------------------------------------------

/**
 * Derive an input schema from an aggregate definition.
 *
 * Edge-driven: walks edges to determine field transformations.
 * - RefEdge, and OneEdge with an entity, fields → `${field}Id`, a value of the entity's key
 *   composite (`refIdInput`): `create` fetches it
 * - OneEdge without one, or with an entity no single id names → the value itself, which is all
 *   `create` can take
 * - Sub-aggregate edges are recursed
 * - Many-edge array elements are recursed for ref replacement
 * - PK composite fields are omitted (auto-generated)
 * - A date `timestamps` stamps is optional, at any level
 * - `Schema.toCodecJson` is applied at the end so Date fields accept ISO strings
 */
/**
 * Precisely-typed derived aggregate schemas. `TInput` is the aggregate's derived
 * input/create payload type (see {@link AggregateInputType}); `updateSchema` is
 * the same shape with every field optional. This lets the table-free
 * `deriveAggregateSchemas` path be as typed as the top-level `Aggregate.make`,
 * so an AWS-free contract package can read `typeof result.inputSchema.Type`
 * without fabricating a stub table tag (issue #67).
 */
export interface DerivedAggregateSchemas<TInput = unknown> {
  readonly inputSchema: Schema.Codec<TInput>
  /** Alias for `inputSchema` — aggregates have no PK-composite stripping on create. */
  readonly createSchema: Schema.Codec<TInput>
  readonly updateSchema: Schema.Codec<Partial<TInput>>
}

export const deriveAggregateSchemas = <
  TSchema extends Schema.Top,
  const TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  const TPK extends ReadonlyArray<string>,
  const TTimestamps extends TimestampsConfig | undefined = undefined,
>(
  schema: TSchema,
  edges: TEdges,
  pkComposites: TPK,
  timestamps?: TTimestamps,
): DerivedAggregateSchemas<
  AggregateInputType<
    Schema.Schema.Type<TSchema>,
    TEdges,
    TPK,
    AggregateStampNames<Schema.Schema.Type<TSchema>, TTimestamps>,
    SchemaFieldsOf<TSchema>
  >
> => {
  const own = resolveAggregateStamps(timestamps, getSchemaFields(schema), "Aggregate")
  return deriveWithStamps(schema, edges, pkComposites, {
    config: timestamps,
    names: new Set([own.createdAt, own.updatedAt].filter((name) => name !== null)),
  }) as never
}

const deriveWithStamps = (
  schema: Schema.Top,
  edges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  pkComposites: ReadonlyArray<string>,
  stamps: AggregateStamps,
): DerivedAggregateSchemas<unknown> => {
  type Result = DerivedAggregateSchemas<unknown>
  const fields = getSchemaFields(schema)
  if (!fields) {
    return { inputSchema: schema, createSchema: schema, updateSchema: schema } as unknown as Result
  }

  const omit = new Set(pkComposites)
  const managed = managedDates(stamps, fields)
  const newFields: Record<string, unknown> = {}

  for (const [name, fieldSchema] of Object.entries(fields)) {
    if (omit.has(name)) continue

    const edge = edges[name]
    if (edge && "_tag" in edge) {
      const isOpt = isFieldOptional(fieldSchema)

      if (
        (edge._tag === "OneEdge" || edge._tag === "RefEdge") &&
        (edge.entity === undefined || refKeyComposite(edge.entity) === undefined)
      ) {
        // Nothing to fetch by: no entity, or one no single id names (its key has two composites,
        // or none). `create` takes the value, and refuses an id for it (`EDD-9129`).
        const value = rowInput(optionalField(fieldSchema)?.inner ?? fieldSchema, stamps)
        newFields[name] = isOpt ? Schema.optionalKey(value) : value
      } else if (edge._tag === "RefEdge" || edge._tag === "OneEdge") {
        const id = refIdInput(edge.entity!)
        newFields[`${name}Id`] = isOpt ? Schema.optionalKey(id) : id
      } else if (edge._tag === "BoundSubAggregate") {
        const sub = (edge as BoundSubAggregate<any>).aggregate
        const subSchemas = deriveWithStamps(sub.schema, sub.edges, [], stamps)
        newFields[name] = isOpt
          ? Schema.optionalKey(subSchemas.inputSchema)
          : subSchemas.inputSchema
      } else if (edge._tag === "ManyEdge") {
        const manyEdge = edge as ManyEdge
        const fieldKey = manyEdge.inputField ?? name
        const elemSchema = deriveElementInputSchema(fieldSchema, manyEdge.entity, stamps)
        if (elemSchema) {
          newFields[fieldKey] = isOpt
            ? Schema.optionalKey(Schema.Array(elemSchema))
            : Schema.Array(elemSchema)
        } else {
          newFields[fieldKey] = keyedInput(fieldSchema, stamps)
        }
      }
      continue
    }

    // Regular field → keep as-is (toCodecJson applied at the end handles Date)
    newFields[name] = managed.has(name) ? stampInput(fieldSchema) : fieldSchema
  }

  const inputSchema = Schema.toCodecJson(Schema.Struct(newFields as any))

  // Update schema: all fields optional
  const optionalFields: Record<string, unknown> = {}
  for (const [name, fieldSchema] of Object.entries(newFields)) {
    optionalFields[name] = isFieldOptional(fieldSchema as Schema.Top)
      ? fieldSchema
      : Schema.optional(fieldSchema as Schema.Top)
  }
  const updateSchema = Schema.toCodecJson(Schema.Struct(optionalFields as any))

  // Runtime members are `Schema.Codec<unknown>`-shaped; the precise input type
  // is a compile-time phantom (`AggregateInputType`) — same approach the
  // top-level `Aggregate.make` overload uses. `createSchema` aliases `inputSchema`.
  return { inputSchema, createSchema: inputSchema, updateSchema } as unknown as Result
}

/** A `Schema.Record` many edge's input (a custom `decompose`): its values' stamps are optional. */
const keyedInput = (fieldSchema: Schema.Top, stamps: AggregateStamps): Schema.Top => {
  const inner = optionalField(fieldSchema)?.inner ?? fieldSchema
  if (!SchemaAST.isObjects(inner.ast)) return fieldSchema
  const record = inner as unknown as { readonly key?: Schema.Top; readonly value?: Schema.Top }
  if (record.key === undefined || record.value === undefined) return fieldSchema
  const value = rowInput(record.value, stamps)
  if (value === record.value) return fieldSchema
  const input = Schema.Record(record.key as never, value)
  return isFieldOptional(fieldSchema) ? Schema.optionalKey(input) : input
}

/**
 * Check if a field schema represents an optional field.
 *
 * Delegates to {@link SchemaAccessors.isFieldOptional}, which uses the stable
 * `SchemaAST.isOptional` guard. Re-exported here (and from `Aggregate.ts`) for
 * backwards-compatible access.
 */
export const isFieldOptional = (fieldSchema: Schema.Top): boolean =>
  isFieldOptionalImpl(fieldSchema)

/**
 * Derive a field name from an entity's model identifier.
 * E.g., entity with model identifier "Umpire" → "umpire" (lowercase first letter).
 */
export const deriveEntityFieldName = (entity: RefEntity): string => {
  const s = entity.model as unknown as Record<string, unknown>
  const identifier =
    "identifier" in s && typeof s.identifier === "string" ? s.identifier : entity.entityType
  return identifier.charAt(0).toLowerCase() + identifier.slice(1)
}

// ---------------------------------------------------------------------------
// Ref ids: what one id of an edge's entity names, and which values hold one
// ---------------------------------------------------------------------------

/**
 * The distinct attributes an entity's primary key is composed from, its partition key's first. An
 * attribute in both halves (`pk: ["lineId"]`, `sk: ["lineId"]`) is one attribute: one value of it
 * names one item.
 */
export const refKeyComposites = (entity: RefEntity): ReadonlyArray<string> => {
  const primary = (
    entity.indexes as
      | {
          readonly primary?: {
            readonly pk?: { readonly composite?: ReadonlyArray<string> }
            readonly sk?: { readonly composite?: ReadonlyArray<string> }
          }
        }
      | undefined
  )?.primary
  return [...new Set([...(primary?.pk?.composite ?? []), ...(primary?.sk?.composite ?? [])])]
}

/**
 * The one attribute an id of `entity` is a value of: its primary key's only distinct composite.
 * `undefined` for a key composed from more than one attribute, or none: no one id names one item.
 */
export const refKeyComposite = (entity: RefEntity): string | undefined => {
  const composites = refKeyComposites(entity)
  return composites.length === 1 ? composites[0] : undefined
}

/**
 * The model field an id of `entity` is a value of (its {@link refKeyComposite}), `undefined` when
 * its key has no one composite or its model's fields can't be read.
 */
export const refIdField = (entity: RefEntity): Schema.Top | undefined => {
  const name = refKeyComposite(entity)
  return name === undefined ? undefined : getSchemaFields(unwrapModel(entity.model))?.[name]
}

/**
 * The schema `create` takes an id of `entity` as: its key composite's own field, so a number keyed
 * entity takes a number. `Schema.String` when the field can't be read, as before.
 */
const refIdInput = (entity: RefEntity): Schema.Top => refIdField(entity) ?? Schema.String

const jsonCodecs = new WeakMap<Schema.Top, Schema.Top | null>()

/** A field's JSON codec (`Schema.toCodecJson`), once per field; `null` where it has none. */
const jsonCodecOf = (field: Schema.Top): Schema.Top | null => {
  const cached = jsonCodecs.get(field)
  if (cached !== undefined) return cached
  let codec: Schema.Top | null
  try {
    codec = Schema.toCodecJson(field as Schema.Codec<unknown>) as unknown as Schema.Top
  } catch {
    codec = null
  }
  jsonCodecs.set(field, codec)
  return codec
}

/**
 * An id given for `entity`, as a value of its key composite ({@link refIdField}): the value itself
 * when it is one (`5` of a number, `5n` of a bigint, a `Date`), or what it decodes to from its JSON
 * or stored form (`"5"` of a `NumberFromString` or a bigint, an ISO string of a date). `None` when it
 * is neither: it names no item. Without a key field to read, a string is taken as given and nothing
 * else, as it always was.
 */
export const refIdValue = (entity: RefEntity, value: unknown): Option.Option<unknown> => {
  const field = refIdField(entity)
  if (field === undefined) return typeof value === "string" ? Option.some(value) : Option.none()
  const codec = field as Schema.Codec<unknown>
  if (Schema.is(codec)(value)) return Option.some(value)
  const json = jsonCodecOf(field)
  const fromJson =
    json === null
      ? Option.none<unknown>()
      : Schema.decodeUnknownOption(json as Schema.Codec<unknown>)(value)
  return Option.isSome(fromJson) ? fromJson : Schema.decodeUnknownOption(codec)(value)
}

// ---------------------------------------------------------------------------
// A `many` element's references: which values `create` fetches an entity for
// ---------------------------------------------------------------------------

/** What a copy of a schema node may change without changing what the node holds. */
const notWhatItHolds: ReadonlySet<string> = new Set(["annotations", "checks", "context"])

/**
 * Whether two schema nodes are one schema: the same node, or a copy of it that changes only its
 * annotations (`DynamoModel.ref`, `.annotate`), its checks (`.check`) or the optionality of the key
 * it's under. Every other part is the same object. Decided from the definitions alone: a struct
 * declared again with the same fields is another schema.
 */
const isSameSchemaNode = (a: SchemaAST.AST, b: SchemaAST.AST): boolean => {
  if (a === b) return true
  if (a._tag !== b._tag) return false
  const own = (ast: SchemaAST.AST) => Object.keys(ast).filter((key) => !notWhatItHolds.has(key))
  const keys = own(a)
  return (
    keys.length === own(b).length &&
    keys.every(
      (key) =>
        (a as unknown as Record<string, unknown>)[key] ===
        (b as unknown as Record<string, unknown>)[key],
    )
  )
}

/** Whether a schema is the entity's own model (`isSameSchemaNode`), its configure wrapper taken off. */
const isEntityModel = (schema: Schema.Top, entity: RefEntity): boolean =>
  isSameSchemaNode(schema.ast, unwrapModel(entity.model).ast)

/**
 * Whether a `many` element is the entity itself (`Array<Umpire>`): the entity's own model, or a
 * class of the same identifier, as 1.39.0 found it. Its values are the entity whole, or an id.
 */
export const isEntityElement = (element: Schema.Top | undefined, entity: RefEntity): boolean =>
  element !== undefined &&
  getSchemaFields(element) !== undefined &&
  (isSchemaMatchingEntity(element, entity) || isEntityModel(element, entity))

/**
 * The field of a `many` element that holds the entity, where the element's definition says so,
 * `undefined` where it doesn't. All of these hold:
 *
 * 1. The element is a plain `Schema.Struct` or `Schema.Class`: one with fields of its own. A
 *    transformation, a union, a `suspend` or a declaration has none.
 * 2. Its field of the entity's name (`deriveEntityFieldName`) is the entity's own model
 *    (`isSameSchemaNode`), or that under `Schema.optional` / `Schema.optionalKey` alone. An
 *    `Option`, a `NullOr` or a `Result` of it is another schema.
 * 3. It doesn't declare `${field}Id` itself: a declared one is the element's own data.
 *
 * Such an element takes an id of the entity's key composite under `${field}Id` (`refIdValue`),
 * which `create` fetches. Any other element is judged as 1.39.0 judged it: a string `${field}Id`
 * is fetched, whatever the element declares.
 */
export const entityFieldOf = (
  element: Schema.Top | undefined,
  entity: RefEntity,
): string | undefined => {
  const fields = element === undefined ? undefined : getSchemaFields(element)
  if (fields === undefined) return undefined
  const name = deriveEntityFieldName(entity)
  const field = fields[name]
  if (field === undefined || `${name}Id` in fields) return undefined
  const optional = optionalField(field)
  if (optional?.union !== undefined) return undefined
  return isEntityModel(optional?.inner ?? field, entity) ? name : undefined
}

/**
 * Whether `create` fetches `entity` for a `many` element value given as an object, under its
 * `${field}Id`: any value but `null` and `undefined` where the element's definition names the field
 * holding the entity ({@link entityFieldOf}), and a string otherwise, as on 1.39.0. An element that is
 * the entity itself ({@link isEntityElement}) holds no reference: given whole, it's stored as given.
 */
export const elementHoldsRef = (
  element: Schema.Top | undefined,
  entity: RefEntity,
  value: Record<string, unknown>,
): boolean => {
  if (isEntityElement(element, entity)) return false
  const id = value[`${deriveEntityFieldName(entity)}Id`]
  return entityFieldOf(element, entity) !== undefined ? id != null : typeof id === "string"
}

/**
 * The element schema of a `many` edge, read off the parent model's field: the array's element, or a
 * keyed collection's value. `undefined` when the field says nothing of it.
 */
export const manyElementSchema = (
  parentFields: Record<string, Schema.Top> | undefined,
  edgeName: string,
): Schema.Top | undefined => {
  const field = parentFields?.[edgeName]
  if (field === undefined) return undefined
  return extractArrayElement(field) ?? extractKeyedValue(field)
}

/**
 * Derive input schema for a many-edge array element, as `create` takes it, for an edge whose entity
 * one id names:
 *
 * - **An element that is the entity** ({@link isEntityElement}): an id of the entity's key composite
 *   (`refIdInput`), or the entity whole.
 * - **An element whose definition names the field holding the entity** ({@link entityFieldOf}): the
 *   element whole, or with `${field}Id`, an id of the entity's key composite, in place of that field.
 *   Each refuses the other's key, so neither drops the other's value.
 * - **Any other element**, as on 1.39.0: the field of the entity's name, if it has one, taken as
 *   `${field}Id: Schema.String`. An element with no fields of its own (a union among them) is taken
 *   as declared.
 *
 * An entity no single id names is given whole, never by id (`EDD-9129`), so its elements are taken as
 * declared. A date the library stamps is optional throughout.
 */
export const deriveElementInputSchema = (
  arrayFieldSchema: Schema.Top,
  entity?: RefEntity,
  stamps?: AggregateStamps,
): Schema.Top | undefined => {
  const elemSchema = extractArrayElement(arrayFieldSchema)
  if (!elemSchema) return undefined
  const fetched = entity !== undefined && refKeyComposite(entity) !== undefined ? entity : undefined
  if (fetched !== undefined && isEntityElement(elemSchema, fetched)) {
    return Schema.Union([
      refIdInput(fetched) as Schema.Codec<unknown>,
      stampedElement(elemSchema, stamps) as Schema.Codec<unknown>,
    ]) as unknown as Schema.Top
  }
  const fields = getSchemaFields(elemSchema)
  if (fields === undefined || fetched === undefined) {
    return fields === undefined ? elemSchema : stampedElement(elemSchema, stamps)
  }
  const named = entityFieldOf(elemSchema, fetched)
  if (named !== undefined) {
    const own = stampedFields(fields, stamps)
    const id = refIdInput(fetched)
    const absent = Schema.optionalKey(Schema.Never)
    const byId: Record<string, Schema.Top> = {}
    for (const [name, field] of Object.entries(own)) {
      if (name === named) {
        byId[`${name}Id`] = isFieldOptional(field) ? Schema.optionalKey(id) : id
        byId[name] = absent
      } else {
        byId[name] = field
      }
    }
    return Schema.Union([
      Schema.Struct({ ...own, [`${named}Id`]: absent } as any),
      Schema.Struct(byId as any),
    ]) as unknown as Schema.Top
  }
  return element139(elemSchema, fields, deriveEntityFieldName(fetched), stamps)
}

/** An element's fields, the dates the library stamps optional. */
const stampedFields = (
  fields: Record<string, Schema.Top>,
  stamps: AggregateStamps | undefined,
): Record<string, Schema.Top> => {
  const managed = stamps === undefined ? undefined : managedDates(stamps, fields)
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      managed?.has(name) === true ? stampInput(field) : field,
    ]),
  )
}

/** An element as declared, the dates the library stamps optional: the element itself when none is. */
const stampedElement = (element: Schema.Top, stamps: AggregateStamps | undefined): Schema.Top => {
  const fields = getSchemaFields(element)
  if (fields === undefined || stamps === undefined || managedDates(stamps, fields).size === 0) {
    return element
  }
  return Schema.Struct(stampedFields(fields, stamps) as any) as unknown as Schema.Top
}

/**
 * An element as 1.39.0's input took it: its field of the entity's name, if it has one, as
 * `${name}Id: Schema.String`, optional when the field is; the dates the library stamps optional.
 * The element itself when nothing changes.
 */
const element139 = (
  element: Schema.Top,
  fields: Record<string, Schema.Top>,
  entityFieldName: string,
  stamps: AggregateStamps | undefined,
): Schema.Top => {
  const managed = stamps === undefined ? undefined : managedDates(stamps, fields)
  let hasChanges = false
  const newFields: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(fields)) {
    if (name === entityFieldName) {
      newFields[`${name}Id`] = isFieldOptional(field)
        ? Schema.optionalKey(Schema.String)
        : Schema.String
      hasChanges = true
    } else if (managed?.has(name) === true) {
      newFields[name] = stampInput(field)
      hasChanges = true
    } else {
      newFields[name] = field
    }
  }
  return hasChanges ? Schema.Struct(newFields as any) : element
}
/**
 * The paths of an aggregate's `many` edges, sub-aggregates included. The collection such a field is
 * declared as is taken apart by `decompose` and put back by `assemble`, so it's never stored itself.
 */
export const manyEdgePaths = (
  edges: Readonly<Record<string, unknown>> | undefined,
  at = "",
): ReadonlySet<string> => {
  const paths = new Set<string>()
  for (const [name, edge] of Object.entries(edges ?? {})) {
    const path = at === "" ? name : `${at}.${name}`
    const tagged = edge as {
      readonly _tag?: string
      readonly aggregate?: { readonly edges?: Readonly<Record<string, unknown>> }
    }
    if (tagged._tag === "ManyEdge") paths.add(path)
    if (tagged._tag === "BoundSubAggregate") {
      for (const nested of manyEdgePaths(tagged.aggregate?.edges, path)) paths.add(nested)
    }
  }
  return paths
}

/**
 * Unwrap a ConfiguredModel to get the raw Schema.Class model.
 * ConfiguredModel wraps the original model with DynamoDB-specific overrides
 * (field renaming, storage encoding) and has shape { model: M, attributes: ... }.
 */
export const unwrapModel = (model: Schema.Top): Schema.Top => {
  const m = model as unknown as Record<string | symbol, unknown>
  if (m[ConfiguredModelTag] === true && "model" in m) {
    return m.model as Schema.Top
  }
  return model
}

/**
 * Check if a schema matches an entity model (same Schema.Class identifier).
 * This is used to detect when an array element IS the entity (e.g., Array<Umpire>),
 * as opposed to wrapping the entity (e.g., Array<{ umpire: Umpire, role: string }>).
 * Unwraps ConfiguredModel if the entity uses DynamoModel.configure.
 */
export const isSchemaMatchingEntity = (schema: Schema.Top, entity: RefEntity): boolean => {
  const s = schema as unknown as Record<string, unknown>
  const entityModel = unwrapModel(entity.model) as unknown as Record<string, unknown>
  // Compare Schema.Class identifiers
  if ("identifier" in s && "identifier" in entityModel) {
    return s.identifier === entityModel.identifier
  }
  return false
}

/**
 * Extract the element schema from a field that is `Schema.Array(T)`,
 * `Schema.NonEmptyArray(T)`, `Schema.optionalKey(Schema.Array(T))`, or
 * `Schema.optional(Schema.Array(T))`. Returns `T`.
 *
 * Delegates to {@link SchemaAccessors.extractArrayElement}, which routes
 * through `SchemaAST.isArrays`/`isUnion` guards and the typed `.value` /
 * `.schema` / `.members` accessors. Re-exported here (and from `Aggregate.ts`)
 * for backwards-compatible access.
 */
export const extractArrayElement = (fieldSchema: Schema.Top): Schema.Top | undefined =>
  extractArrayElementImpl(fieldSchema)

/**
 * Access `.fields` on a Schema.Class or Schema.Struct.
 *
 * Delegates to {@link SchemaAccessors.getSchemaFields} (typed `.fields`).
 * Re-exported here (and from `Aggregate.ts`) for backwards-compatible access.
 */
export const getSchemaFields = (schema: Schema.Top): Record<string, Schema.Top> | undefined =>
  getSchemaFieldsImpl(schema)
