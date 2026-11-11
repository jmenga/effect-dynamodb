/**
 * @internal Aggregate schema derivation — input and update schema building.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import { Option, Schema, SchemaAST } from "effect"
import { ConfiguredModelTag, getIdentifierField } from "../DynamoModel.js"
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
 * The names a stored value of `schema` declares: the fields of its stored side, through optionality,
 * classes, unions and suspensions. A record's keys are taken, not declared, and a declaration
 * (`Schema.declare`) declares nothing that can be seen, so neither gives a name.
 */
export const storedFieldNames = (schema: Schema.Top): ReadonlySet<string> => {
  const names = new Set<string>()
  const seen = new Set<SchemaAST.AST>()
  const visit = (ast: SchemaAST.AST): void => {
    if (seen.has(ast)) return
    seen.add(ast)
    if (SchemaAST.isObjects(ast)) {
      for (const property of ast.propertySignatures) {
        if (typeof property.name === "string") names.add(property.name)
      }
    } else if (SchemaAST.isUnion(ast)) {
      for (const member of ast.types) visit(member)
    } else if (SchemaAST.isSuspend(ast)) {
      let inner: SchemaAST.AST
      try {
        inner = SchemaAST.toEncoded(ast.thunk())
      } catch {
        return
      }
      visit(inner)
    }
  }
  visit(SchemaAST.toEncoded(schema.ast))
  return names
}

/** The kinds of row an aggregate writes, by how a read hands back the value one holds. */
export type RowKind = "root" | "subAggregate" | "edge"

/** The index key attributes a read takes off the root's row. */
const ROOT_INDEX_ATTRIBUTES: ReadonlySet<string> = new Set([
  "gsi1pk",
  "gsi1sk",
  "gsi2pk",
  "gsi2sk",
  "gsi3pk",
  "gsi3sk",
  "gsi4pk",
  "gsi4sk",
  "gsi5pk",
  "gsi5sk",
  "lsi1sk",
  "lsi2sk",
])

/**
 * Whether a read takes the attribute `name` off a row of `kind` before handing back the value it
 * holds, whatever the value declares: `__edd_e__`, `pk` and `sk` everywhere; on the root's row the
 * index keys `gsi1pk` … `gsi5sk`, `lsi1sk` and `lsi2sk`; on a sub-aggregate's root row any name
 * starting `pk`, `sk`, `gsi` or `lsi`; on an edge's row any name starting `gsi` or `lsi`. The rule
 * each read has applied through 1.40.0 (#241), the one place it's stated.
 */
export const readTakesOff = (kind: RowKind, name: string): boolean => {
  if (name === "__edd_e__" || name === "pk" || name === "sk") return true
  switch (kind) {
    case "root":
      return ROOT_INDEX_ATTRIBUTES.has(name)
    case "subAggregate":
      return (
        name.startsWith("pk") ||
        name.startsWith("sk") ||
        name.startsWith("gsi") ||
        name.startsWith("lsi")
      )
    case "edge":
      return name.startsWith("gsi") || name.startsWith("lsi")
  }
}

/**
 * How a sub-aggregate's root row is read (#241): with an edge of its own, as a sub-aggregate's root
 * (`"subAggregate"`); without one, as a `one` edge's row (`"edge"`), since assembly reads a
 * sub-aggregate with no edges as it reads a `one` edge.
 */
export const subAggregateRowKind = (edges: Record<string, unknown>): RowKind =>
  Object.values(edges).some(
    (edge) =>
      typeof edge === "object" &&
      edge !== null &&
      "_tag" in edge &&
      (edge._tag === "OneEdge" || edge._tag === "ManyEdge" || edge._tag === "BoundSubAggregate"),
  )
    ? "subAggregate"
    : "edge"

/** A key attribute the library writes on a row, with what it holds, to name it in an error. */
export type RowKeyAttribute = readonly [attribute: string, what: string]

/** The parts of an aggregate's config naming the key attributes its rows are written with. */
export type RowKeyConfig = {
  readonly pk: { readonly field: string }
  readonly collection: {
    readonly index?: string | undefined
    readonly sk?: { readonly field: string } | undefined
  }
  readonly list?:
    | { readonly pk: { readonly field: string }; readonly sk: { readonly field: string } }
    | undefined
}

/**
 * The key attributes the library writes on every row an aggregate writes, over a value's field of
 * the same name (#241): `__edd_e__`, the partition key attribute, `sk` and, with a collection index,
 * the collection sort key's copy.
 */
export const rowKeyAttributes = (config: RowKeyConfig): ReadonlyArray<RowKeyAttribute> => [
  ["__edd_e__", "the attribute holding its entity type"],
  [config.pk.field, "the attribute holding the partition key"],
  ["sk", "the attribute holding its sort key"],
  ...(config.collection.index === undefined || config.collection.sk === undefined
    ? []
    : [
        [
          config.collection.sk.field,
          "the attribute holding the collection sort key's copy",
        ] as const,
      ]),
]

/**
 * The root's list keys, written on its row only when every list composite has a value (they're
 * sparse), over a field of the same name (#241).
 */
export const listKeyAttributes = (config: RowKeyConfig): ReadonlyArray<RowKeyAttribute> =>
  config.list === undefined
    ? []
    : [
        [config.list.pk.field, "the attribute holding its list partition key"],
        [config.list.sk.field, "the attribute holding its list sort key"],
      ]

/**
 * The key attributes of a row of `kind` (`written`) a value declaring `names` has a field of, by
 * what a read does with each ({@link readTakesOff}): `misread`, handed back, so the field reads the
 * library's key text whatever was given, on every row; `lost`, taken off, so a value given there
 * reads back without it, and one given none reads as it was.
 */
export const valueFieldsOverRowKeys = (
  kind: RowKind,
  written: ReadonlyArray<RowKeyAttribute>,
  names: Iterable<string>,
): {
  readonly misread: ReadonlyArray<RowKeyAttribute>
  readonly lost: ReadonlyArray<RowKeyAttribute>
} => {
  const declared = new Set(names)
  const misread: Array<RowKeyAttribute> = []
  const lost: Array<RowKeyAttribute> = []
  for (const entry of written) {
    if (!declared.has(entry[0])) continue
    if (readTakesOff(kind, entry[0])) lost.push(entry)
    else misread.push(entry)
  }
  return { misread, lost }
}

/**
 * `[EDD-9159]`, at make: a row's value declaring a field named like a key attribute the aggregate
 * writes on every row ({@link rowKeyAttributes}) that a read hands back (#241). The library writes
 * the key text over the value's own, so the field reads it back whatever the caller gave, on every
 * row: 1.40.0 misread each. Only an actual collision: a field the value's stored side declares
 * (`storedFieldNames`) of a name the row is written with. A record's keys, a declaration and a custom
 * `decompose`'s rows (what it returns isn't the element's schema) aren't. Refused at write, where
 * the value is known (`Aggregate.ts`): a field the read takes off (`pk`, `sk`, …), which loses only
 * a value given there; a discriminator, which collides only with a value other than its own; and a
 * list key ({@link listKeyAttributes}), written only when every list composite has a value. The
 * value of each kind of row is named as the operational `resolveNode` names it
 * ({@link declaredValueNames}).
 */
export const refuseValueFieldsOnRowAttributes = (
  aggregate: string,
  rootSchema: Schema.Top,
  config: RowKeyConfig & {
    readonly edges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>
  },
): void => {
  const refuse = (owner: string, kind: RowKind, names: Iterable<string> | undefined): void => {
    if (names === undefined) return
    const [first] = valueFieldsOverRowKeys(kind, rowKeyAttributes(config), names).misread
    if (first === undefined) return
    throw new Error(
      `[EDD-9159] Aggregate "${aggregate}": ${owner} declares a field "${first[0]}", which is also ` +
        `${first[1]}. The library writes that attribute on the row over the value's own and a read ` +
        `hands it back, so the field would read the library's value whatever was given. Name the ` +
        `field something else.`,
    )
  }
  const walk = (
    fields: Record<string, Schema.Top> | undefined,
    edges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
    path: ReadonlyArray<string>,
  ): void => {
    for (const [name, edge] of Object.entries(edges)) {
      if (!("_tag" in edge)) continue
      const here = [...path, name].join(".")
      if (edge._tag === "OneEdge") {
        refuse(`the value of edge "${here}"`, "edge", declaredValueNames.one(fields, name))
      } else if (edge._tag === "ManyEdge") {
        refuse(
          `an element of edge "${here}"`,
          "edge",
          declaredValueNames.many(fields, name, edge as ManyEdge),
        )
      } else if (edge._tag === "BoundSubAggregate") {
        const bound = edge as BoundSubAggregate<any>
        const subFields = getSchemaFields(unwrapModel(bound.aggregate.schema))
        refuse(
          `the sub-aggregate at "${here}"`,
          subAggregateRowKind(bound.aggregate.edges),
          declaredValueNames.own(subFields, bound.aggregate.edges),
        )
        walk(subFields, bound.aggregate.edges, [...path, name])
      }
    }
  }
  const rootFields = getSchemaFields(unwrapModel(rootSchema))
  refuse("its root", "root", declaredValueNames.own(rootFields, config.edges))
  walk(rootFields, config.edges, [])
}

/**
 * The field names the value of each kind of row declares, for {@link valueFieldsOverRowKeys}: the
 * root's and a sub-aggregate's own fields (`own`, those no edge claims), a `one` edge's value (the
 * field holding it), a `many` edge's element (none with a custom `decompose`). `undefined` where
 * nothing is declared.
 */
export const declaredValueNames = {
  own: (
    fields: Record<string, Schema.Top> | undefined,
    edges: Record<string, unknown>,
  ): ReadonlyArray<string> =>
    Object.keys(fields ?? {}).filter((name) => !Object.hasOwn(edges, name)),
  one: (
    fields: Record<string, Schema.Top> | undefined,
    edgeName: string,
  ): ReadonlySet<string> | undefined => {
    const value = own(fields, edgeName)
    return value === undefined ? undefined : storedFieldNames(value)
  },
  many: (
    fields: Record<string, Schema.Top> | undefined,
    edgeName: string,
    edge: { readonly decompose?: unknown },
  ): ReadonlySet<string> | undefined => {
    if (edge.decompose !== undefined) return undefined
    const element = manyElementSchema(fields, edgeName)
    return element === undefined ? undefined : storedFieldNames(element)
  },
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
 * The attribute of `entity` an entity-level ref id (`Entity.make({ refs })`'s `${field}Id`) names:
 * its {@link refKeyComposite}, as an aggregate edge's id (#214, #241). It's fetched under that, read
 * back from the stored ref under that (`putValuesOf`, a row check), and a cascade from `entity` is
 * keyed by it. An entity keyed by more than one composite has none: its identifier, as up to
 * 1.40.0. `undefined` with neither.
 */
export const refIdAttribute = (entity: RefEntity): string | undefined =>
  refKeyComposite(entity) ?? getIdentifierField(entity.model as Schema.Top)?.name

/**
 * What a map the library builds or reads a definition from (a schema's fields) holds under `name`
 * itself, `undefined` where it holds nothing there. Never a member every object inherits: a field
 * or an edge named `constructor` or `toString` that the definition doesn't declare is not one.
 */
const own = <A>(record: Readonly<Record<string, A>> | undefined, name: string): A | undefined =>
  record !== undefined && Object.hasOwn(record, name) ? record[name] : undefined

/**
 * What a caller's payload gives under `name`, read as 1.39.0 read it (`payload[name]`): its own
 * property, one its class gives it (a getter, a property of a prototype), or one a proxy answers
 * for. A function is not given: 1.39.0 took a string for an id, a list for a `many` edge and an
 * object for a sub-aggregate, never a function, so a method of the payload's class named like an id
 * is no id, and neither is a member every object inherits (`constructor`, `toString`).
 */
export const given = (payload: object, name: string): unknown => {
  const value = (payload as Record<string, unknown>)[name]
  return typeof value === "function" ? undefined : value
}

/**
 * The model field an id of `entity` is a value of (its {@link refKeyComposite}), `undefined` when
 * its key has no one composite or its model's fields can't be read.
 */
export const refIdField = (entity: RefEntity): Schema.Top | undefined => {
  const name = refKeyComposite(entity)
  return name === undefined ? undefined : own(getSchemaFields(unwrapModel(entity.model)), name)
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
  return keyValueOf(field, value)
}

/**
 * A value given for a key composite whose field is `field`, as a value of that field: the value
 * itself when it is one, or what it decodes to from its JSON or stored form. `None` when it is
 * neither. What an aggregate edge's id ({@link refIdValue}) and an entity-level ref's
 * `${field}Id` name are both read through it (#214, #241).
 */
export const keyValueOf = (field: Schema.Top, value: unknown): Option.Option<unknown> => {
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
  const held = (ast: SchemaAST.AST) => Object.keys(ast).filter((key) => !notWhatItHolds.has(key))
  const keys = held(a)
  return (
    keys.length === held(b).length &&
    keys.every(
      (key) =>
        (a as unknown as Record<string, unknown>)[key] ===
        (b as unknown as Record<string, unknown>)[key],
    )
  )
}

/**
 * Whether a schema is the entity's own model: the schema its definition declares (its
 * `DynamoModel.configure` wrapper taken off), or a copy of it that changes only its annotations, its
 * checks or its brand (`isSameSchemaNode`), compared by reference. An identifier is never identity:
 * a class of the entity's identifier is another schema, as is a struct declared again with the
 * entity's fields. Every question of whether a schema is the entity is asked of this.
 */
export const isEntityModel = (schema: Schema.Top, entity: RefEntity): boolean =>
  isSameSchemaNode(schema.ast, unwrapModel(entity.model).ast)

/**
 * Whether a field's schema holds the entity's own model ({@link isEntityModel}), under
 * `Schema.optional` / `Schema.optionalKey` at most. An `Option`, a `NullOr` or a `Result` of it holds
 * something else: a record fetched for it is no value of the field.
 */
const holdsEntityModel = (field: Schema.Top | undefined, entity: RefEntity): boolean => {
  if (field === undefined) return false
  const optional = optionalField(field)
  if (optional?.union !== undefined) return false
  return isEntityModel(optional?.inner ?? field, entity)
}

/**
 * Whether a `many` element is the entity itself (`Array<Umpire>`): the entity's own model
 * ({@link isEntityModel}). Its values are the entity whole, or an id.
 */
export const isEntityElement = (element: Schema.Top | undefined, entity: RefEntity): boolean =>
  element !== undefined && isEntityModel(element, entity)

/**
 * The field of a `many` element that holds the entity, where the element's definition says so,
 * `undefined` where it doesn't. All of these hold:
 *
 * 1. The element is a plain `Schema.Struct` or `Schema.Class`: one with fields of its own. A
 *    transformation, a union, a `suspend` or a declaration has none.
 * 2. Its field of the entity's name (`deriveEntityFieldName`) holds the entity's own model
 *    (`holdsEntityModel`).
 * 3. It doesn't declare `${field}Id` itself: a declared one is the element's own data.
 *
 * Such an element's input takes an id of the entity's key composite under `${field}Id`.
 */
export const entityFieldOf = (
  element: Schema.Top | undefined,
  entity: RefEntity,
): string | undefined => {
  const fields = element === undefined ? undefined : getSchemaFields(element)
  if (fields === undefined) return undefined
  const name = deriveEntityFieldName(entity)
  if (Object.hasOwn(fields, `${name}Id`)) return undefined
  return holdsEntityModel(own(fields, name), entity) ? name : undefined
}

/**
 * Whether `create` fetches `entity` for `value`'s `${field}Id`, `value` a value of a definition
 * declaring `fields` (`undefined` where it declares none: a union, a transformation): the parent
 * model's, its `field` the edge's name, for a `one` or `ref` edge; a `many` element's, its `field`
 * the entity's name (`deriveEntityFieldName`). One rule for every edge:
 *
 * 1. `null` and `undefined` give no id.
 * 2. A string is fetched, exactly as on 1.39.0, whatever the definition declares: it replaces a
 *    record given whole in `field` with the one fetched, and a `${field}Id` the definition declares
 *    is taken out of the value, as 1.39.0 took it.
 * 3. Any other id (a number, a bigint, a date: a value of the entity's key composite) is fetched only
 *    where the definition's `field` holds the entity's own model (`holdsEntityModel`), the definition
 *    doesn't declare `${field}Id`, which is then its own data, and `field` isn't given whole: a
 *    record given is never replaced or read again. 1.39.0 fetched none of these.
 */
export const holdsRefId = (
  fields: Record<string, Schema.Top> | undefined,
  field: string,
  entity: RefEntity,
  value: Record<string, unknown>,
): boolean => {
  const id = given(value, `${field}Id`)
  if (id == null) return false
  if (typeof id === "string") return true
  return (
    fields !== undefined &&
    !Object.hasOwn(fields, `${field}Id`) &&
    holdsEntityModel(own(fields, field), entity) &&
    given(value, field) == null
  )
}

/**
 * Whether 1.39.0 fetched an element that is the entity by its own key `key` (`lineId` of a `Line`
 * keyed by `lineId`) and completed. It fetched under the model's identifier (`id` without one), so
 * only where that is the entity's one key composite; and it took the key out of the element given,
 * so only where the element doesn't require it. Everywhere else it died composing the key, or
 * refused the element without its key.
 */
const fetchedByOwnKey139 = (
  fields: Record<string, Schema.Top> | undefined,
  entity: RefEntity,
  key: string,
): boolean => {
  const declared = own(fields, key)
  return (
    refKeyComposite(entity) === key &&
    (getIdentifierField(entity.model as never)?.name ?? "id") === key &&
    declared !== undefined &&
    isFieldOptional(declared)
  )
}

/**
 * {@link holdsRefId} for a `many` element given as an object, of the element's schema. An element
 * that is the entity ({@link isEntityElement}), given whole, holds no id in its own key: where the
 * entity is keyed by `${field}Id` (`lineId` of a `Line`), that is the entity's own value, which
 * 1.39.0 took for an id to fetch and failed on. It is left unfetched exactly where 1.39.0 failed:
 * where 1.39.0 fetched it and completed ({@link fetchedByOwnKey139}), it is fetched.
 */
export const elementHoldsRef = (
  element: Schema.Top | undefined,
  entity: RefEntity,
  value: Record<string, unknown>,
): boolean => {
  const field = deriveEntityFieldName(entity)
  const fields = element === undefined ? undefined : getSchemaFields(element)
  if (
    isEntityElement(element, entity) &&
    refKeyComposites(entity).includes(`${field}Id`) &&
    !fetchedByOwnKey139(fields, entity, `${field}Id`)
  ) {
    return false
  }
  return holdsRefId(fields, field, entity, value)
}

/**
 * The element schema of a `many` edge, read off the parent model's field: the array's element, or a
 * keyed collection's value. `undefined` when the field says nothing of it.
 */
export const manyElementSchema = (
  parentFields: Record<string, Schema.Top> | undefined,
  edgeName: string,
): Schema.Top | undefined => {
  const field = own(parentFields, edgeName)
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
 *   element whole, `${field}Id` beside it or not, or with `${field}Id`, an id of the entity's key
 *   composite, in place of that field. Neither refuses the other's key: given both, both are kept,
 *   and `create` judges them as it judges a value given to it directly (`elementHoldsRef`).
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
    const byId: Record<string, Schema.Top> = {}
    for (const [name, field] of Object.entries(own)) {
      if (name === named) {
        byId[`${name}Id`] = isFieldOptional(field) ? Schema.optionalKey(id) : id
      } else {
        byId[name] = field
      }
    }
    return Schema.Union([
      Schema.Struct({ ...own, [`${named}Id`]: Schema.optional(id) } as any),
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
 * Check if a schema has the same Schema.Class identifier as an entity model,
 * unwrapping ConfiguredModel if the entity uses DynamoModel.configure.
 *
 * An identifier is not identity: two classes can share one. Nothing in the
 * library decides by this any more; whether an element IS the entity (e.g.,
 * Array<Umpire>) is decided by comparing the schema itself (`isEntityModel`).
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
