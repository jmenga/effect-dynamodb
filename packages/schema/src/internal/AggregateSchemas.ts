/**
 * @internal Aggregate schema derivation — input and update schema building.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import { Option, Schema, SchemaAST, SchemaTransformation } from "effect"
import { ConfiguredModelTag } from "../DynamoModel.js"
import type { AggregateEdge, ManyEdge, RefEntity } from "./AggregateEdges.js"
import type {
  AggregateInputType,
  AggregateStampNames,
  BoundSubAggregate,
} from "./AggregateTypes.js"
import { bothKindsKeyRefusal, storedFieldAtPath } from "./CompositeCodec.js"
import type { TimestampsConfig } from "./EntityConfig.js"
import {
  optionalField,
  type ResolvedSystemFields,
  resolveSystemFields,
  substituteSchemaDeep,
  withMetadataOf,
} from "./EntitySchemas.js"
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
export interface AggregateStamps {
  readonly config: TimestampsConfig | undefined
  readonly names: ReadonlySet<string>
}

/** An aggregate's {@link AggregateStamps}: its `timestamps`, over its root model's fields. */
export const aggregateStamps = (
  timestamps: TimestampsConfig | undefined,
  fields: Record<string, Schema.Top> | undefined,
): AggregateStamps => {
  const own = resolveAggregateStamps(timestamps, fields, "Aggregate")
  return {
    config: timestamps,
    names: new Set([own.createdAt, own.updatedAt].filter((name) => name !== null)),
  }
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
    AggregateStampNames<Schema.Schema.Type<TSchema>, TTimestamps>
  >
> => {
  return deriveWithStamps(
    schema,
    edges,
    pkComposites,
    aggregateStamps(timestamps, getSchemaFields(schema)),
  ) as never
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

/** A type AST's members, `undefined` and `null` left out: a union's, flattened, or the type itself. */
const astMembers = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => {
  if (SchemaAST.isUnion(ast)) return ast.types.flatMap((member) => astMembers(member))
  if (SchemaAST.isUndefined(ast) || SchemaAST.isNull(ast)) return []
  return [ast]
}

/** A value with no fields of its own: a scalar, a literal, or a list. */
const isScalarOrList = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isString(ast) ||
  SchemaAST.isNumber(ast) ||
  SchemaAST.isBigInt(ast) ||
  SchemaAST.isBoolean(ast) ||
  SchemaAST.isLiteral(ast) ||
  SchemaAST.isEnum(ast) ||
  SchemaAST.isTemplateLiteral(ast) ||
  SchemaAST.isSymbol(ast) ||
  SchemaAST.isUniqueSymbol(ast) ||
  SchemaAST.isArrays(ast) ||
  SchemaAST.isNever(ast) ||
  SchemaAST.isVoid(ast)

/**
 * The properties of an object type: a struct's, or a class's (read off its declaration, so a class
 * an annotation has taken `.fields` from, `Line.pipe(DynamoModel.ref)`, still has them).
 * `undefined` for anything else.
 */
const astProperties = (
  ast: SchemaAST.AST,
): ReadonlyArray<SchemaAST.PropertySignature> | undefined => {
  if (SchemaAST.isObjects(ast)) return ast.propertySignatures
  if (SchemaAST.isDeclaration(ast)) {
    const [struct] = ast.typeParameters
    if (struct !== undefined && SchemaAST.isObjects(struct)) return struct.propertySignatures
  }
  return undefined
}

/**
 * Whether a field can hold the entity's record, so the field is the entity's: some member of it,
 * `optional` and unions unwrapped, is an object, a class, or something that says nothing of what it
 * holds. A scalar or list field (`line: Schema.String`) never wraps the entity, whatever its name.
 */
const holdsRecordAst = (ast: SchemaAST.AST): boolean =>
  astMembers(ast).some((member) => !isScalarOrList(member))

/** {@link holdsRecordAst} of a field's schema. */
export const holdsRecord = (field: Schema.Top): boolean => holdsRecordAst(field.ast)

// ---------------------------------------------------------------------------
// A `many` element's references: which values `create` fetches an entity for
// ---------------------------------------------------------------------------

/**
 * The values a reference member of an element's input decoded ({@link recordReference}). A value
 * `create` is given is fetched for when the element's input decodes it to one of these
 * ({@link elementHoldsRef}). Held weakly: a decoded value is gone with it.
 */
const referenceOutputs = new WeakSet<object>()

/**
 * The check a reference member of an element's input carries: it records the value the member
 * decoded ({@link referenceOutputs}) and takes every value. The member chosen, its order among
 * the others, a union's mode and every check are the decode's own.
 */
const recordReference = Schema.makeFilter((value: unknown) => {
  if (typeof value === "object" && value !== null) referenceOutputs.add(value)
  return true
})

/**
 * Whether a member of a `many` element holds a reference of the entity whose field is `name`: an
 * object whose property of that name can hold the entity's record ({@link holdsRecordAst}), a record
 * (`Schema.Record`) holding whatever keys it's given, or a value that says nothing of what it holds
 * (`Schema.Unknown`, a `suspend`, a union piped through a transformation). A scalar, a list or a
 * declaration (a date) is a value, never a reference.
 */
const isReferenceMember = (member: Schema.Top, name: string): boolean => {
  const ast = member.ast
  if (SchemaAST.isNull(ast) || SchemaAST.isUndefined(ast)) return false
  const properties = astProperties(ast)
  if (properties === undefined) return !isScalarOrList(ast) && !SchemaAST.isDeclaration(ast)
  const property = properties.find((candidate) => candidate.name === name)
  return property === undefined
    ? SchemaAST.isObjects(ast) && ast.indexSignatures.length > 0
    : holdsRecordAst(property.type)
}

/** Whether an element, a union's members walked as declared, has a reference member. */
const hasReferenceMember = (schema: Schema.Top, name: string): boolean => {
  const members = getSchemaFields(schema) === undefined ? unionMembers(schema) : undefined
  return members !== undefined
    ? members.some((member) => hasReferenceMember(member, name))
    : isReferenceMember(schema, name)
}

/** A schema's checks: a class's own and those of the struct it is declared from. */
const checksOf = (ast: SchemaAST.AST): SchemaAST.Checks | undefined => {
  const own = ast.checks ?? []
  const struct = SchemaAST.isDeclaration(ast) ? ast.typeParameters[0] : undefined
  const inner = struct !== undefined && SchemaAST.isObjects(struct) ? (struct.checks ?? []) : []
  const all = [...inner, ...own]
  return all.length === 0 ? undefined : (all as unknown as SchemaAST.Checks)
}

/** `schema` with `checks` in place of its own, everything else kept. */
const withChecks = (schema: Schema.Top, checks: SchemaAST.Checks | undefined): Schema.Top => {
  if (schema.ast.checks === checks) return schema
  const ast = Object.assign(Object.create(Object.getPrototypeOf(schema.ast)), schema.ast, {
    checks,
  }) as SchemaAST.AST
  return Schema.make<Schema.Top>(ast)
}

/**
 * How a member that takes no reference, in an element whose input takes one, refuses a value giving
 * `${field}Id` (`idField`), which names an entity only a reference member takes. `create` hydrated
 * every such value up to 1.39.0 and then decoded it, so a value an earlier member would take with
 * the id left over is the reference member's, as it was.
 */
type Guard = (member: Schema.Top, fields: Record<string, Schema.Top>, idField: string) => Schema.Top

/**
 * {@link Guard} for the domain stage: the member rebuilt as a struct of its fields with `idField`
 * never given, its own checks kept (and a struct's annotations), so the tolerant decode walks it.
 */
const refusingReference: Guard = (member, fields, idField) => {
  const guarded = Schema.Struct({
    ...fields,
    [idField]: Schema.optionalKey(Schema.Never),
  } as any) as unknown as Schema.Top
  return SchemaAST.isObjects(member.ast)
    ? withMetadataOf(member, guarded)
    : withChecks(guarded, checksOf(member.ast))
}

/**
 * {@link Guard} as `inputSchema` holds it: the member itself, decoded from its encoded form with
 * `idField` never given, so what it decodes to (a class instance), its checks, annotations and
 * transformations stay its own, as 1.39.0's input held it. A member whose encoded form declares
 * `idField` takes it as its own; one whose encoded form is no object is rebuilt
 * ({@link refusingReference}).
 */
const refusingReferenceAsDeclared: Guard = (member, fields, idField) => {
  const encoded = SchemaAST.toEncoded(member.ast)
  if (!SchemaAST.isObjects(encoded)) return refusingReference(member, fields, idField)
  if (encoded.propertySignatures.some((property) => property.name === idField)) return member
  const from = new SchemaAST.Objects(
    [
      ...encoded.propertySignatures,
      new SchemaAST.PropertySignature(idField, Schema.optionalKey(Schema.Never).ast),
    ],
    encoded.indexSignatures,
  )
  return Schema.make<Schema.Top>(from).pipe(
    Schema.decodeTo(
      member as Schema.Codec<unknown>,
      SchemaTransformation.passthrough({ strict: false }),
    ),
  ) as unknown as Schema.Top
}

/** A `many` element as its input takes it, and how `create` reads a value of it. */
interface ElementInput {
  /** The element's input: what `inputSchema` holds for it (`deriveElementInputSchema`). */
  readonly input: Schema.Top
  /** Whether a member of it takes a reference of the entity, under `${field}Id`. */
  readonly references: boolean
  /** `inputSchema`'s own decode of a value of it (its JSON codec). */
  readonly wire: (value: unknown) => Option.Option<unknown>
  /**
   * The same input's decode of a value in the form `create` is typed to take it, domain values
   * (a `Date`, a `bigint`) or their stored form, field by field, as `create`'s own decode takes
   * them after hydration (`writeSchema`). Derived by the same walk, the same members refusing an
   * id, each rebuilt as a struct the tolerant decode walks ({@link refusingReference}). Only a
   * value `wire` refuses is read by it.
   */
  readonly domain: (value: unknown) => Option.Option<unknown>
}

const elementInputs = new WeakMap<
  AggregateStamps | typeof NO_STAMPS,
  WeakMap<Schema.Top, WeakMap<RefEntity | typeof NO_ENTITY, ElementInput>>
>()
const NO_STAMPS = { config: undefined, names: new Set<string>() } satisfies AggregateStamps
const NO_ENTITY = {} as RefEntity

/** A decoder that refuses where the decode can't be built or throws. */
const decoderOf = (schema: () => Schema.Top) => {
  let decode: (value: unknown) => Option.Option<unknown>
  try {
    decode = Schema.decodeUnknownOption(schema() as Schema.Codec<unknown>)
  } catch {
    decode = () => Option.none()
  }
  return (value: unknown): Option.Option<unknown> => {
    try {
      return decode(value)
    } catch {
      // A check that throws on what the input holds: taken by none.
      return Option.none()
    }
  }
}

/**
 * A `many` element's input, once per element, entity and stamps: `inputSchema` and `create` read
 * values of it through this one derived schema.
 */
const elementInputOf = (
  element: Schema.Top,
  entity: RefEntity | undefined,
  stamps: AggregateStamps | undefined,
): ElementInput => {
  const byStamps = stamps ?? NO_STAMPS
  let bySchema = elementInputs.get(byStamps)
  if (bySchema === undefined) {
    bySchema = new WeakMap()
    elementInputs.set(byStamps, bySchema)
  }
  let byEntity = bySchema.get(element)
  if (byEntity === undefined) {
    byEntity = new WeakMap()
    bySchema.set(element, byEntity)
  }
  const cached = byEntity.get(entity ?? NO_ENTITY)
  if (cached !== undefined) return cached

  // An entity no single id names is given whole, never by id (`EDD-9129`).
  const fetched = entity !== undefined && refKeyComposite(entity) !== undefined ? entity : undefined
  const name = entity === undefined ? undefined : deriveEntityFieldName(entity)
  const references = name !== undefined && hasReferenceMember(element, name)
  const elemFields = getSchemaFields(element)
  const idField = fetched !== undefined && references ? `${name}Id` : undefined
  // The element IS the entity (its model, or a class of the same identifier): an id of it.
  const isEntity =
    fetched !== undefined &&
    elemFields !== undefined &&
    (isSchemaMatchingEntity(element, fetched) || element.ast === unwrapModel(fetched.model).ast)
  // One walk, two guards: the members each refuses an id in are the same.
  const derive = (guard: Guard) =>
    isEntity ? refIdInput(fetched) : elementInput(element, fetched, stamps, idField, guard)
  const input = derive(refusingReferenceAsDeclared)
  const judged: ElementInput = {
    input,
    references,
    wire: decoderOf(() => Schema.toCodecJson(input as Schema.Codec<unknown>) as Schema.Top),
    domain: decoderOf(() =>
      substituteSchemaDeep(derive(refusingReference), {
        tolerantTransforms: true,
        decodeOnly: true,
        enforceChecks: true,
        domainValues: true,
      }),
    ),
  }
  byEntity.set(entity ?? NO_ENTITY, judged)
  return judged
}

/**
 * Whether `create` fetches `entity` for a `many` element value, under the `${field}Id` the
 * element's input takes (`deriveElementInputSchema`): when `inputSchema`'s own decode of it is a
 * reference member's ({@link recordReference}). The member, a union's order and mode, and every
 * check are that decode's own. A reference member is one whose field named for the entity
 * (`deriveEntityFieldName`) can hold the entity's record ({@link holdsRecord}), taken as
 * `${field}Id`; one that says nothing of what it holds is taken as declared. In an element that
 * has one, a member that declares neither refuses a value giving `${field}Id`, and a union
 * holding one keeps no check of its own: each was written for the entity's record, and runs on it
 * when `create` decodes the hydrated value.
 *
 * A value `inputSchema` refuses as given (a domain value its JSON codec doesn't take, a `Date`, a
 * `bigint`) is read by the same input in the form `create` takes it. A value neither takes is
 * fetched for as 1.39.0 fetched: a string `${field}Id` of an element that has a reference member.
 * An element that IS the entity's own model takes an id: given whole, it is stored as given.
 */
export const elementHoldsRef = (
  element: Schema.Top | undefined,
  entity: RefEntity,
  value: Record<string, unknown>,
  stamps?: AggregateStamps,
): boolean => {
  if (element === undefined) return true
  const judged = elementInputOf(element, entity, stamps)
  // An entity no single id names: an id given for it is refused (`EDD-9129`), never fetched.
  if (refKeyComposite(entity) === undefined) {
    return judged.references && value[`${deriveEntityFieldName(entity)}Id`] != null
  }
  for (const decode of [judged.wire, judged.domain]) {
    const decoded = decode(value)
    if (Option.isSome(decoded)) {
      const output = decoded.value
      return typeof output === "object" && output !== null && referenceOutputs.has(output)
    }
  }
  return judged.references && typeof value[`${deriveEntityFieldName(entity)}Id`] === "string"
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
 * Derive input schema for a many-edge array element.
 * Extracts the element type from the field schema (which may be an Array
 * or optional(Array)). If the element IS the entity (its model, or a class of the same
 * identifier), transforms to an id, a value of the entity's key composite. Otherwise, finds the
 * entity-derived field within the element, when it can hold the entity's record, and transforms
 * it to `${field}Id`; in a union of members, in each member ({@link elementHoldsRef}). An entity
 * no single id names is left as is.
 */
export const deriveElementInputSchema = (
  arrayFieldSchema: Schema.Top,
  entity?: RefEntity,
  stamps?: AggregateStamps,
): Schema.Top | undefined => {
  const elemSchema = extractArrayElement(arrayFieldSchema)
  if (!elemSchema) return undefined
  return elementInputOf(elemSchema, entity, stamps).input
}

/**
 * An element, or a member of a union of them, as its input takes it ({@link elementHoldsRef}): a
 * member with fields through {@link deriveElementMember}, one with none that holds a reference
 * recording its value, and a union, nested ones included, member by member, rebuilt with its own
 * annotations and mode, and its own checks unless it holds a reference member. A union piped through
 * a transformation is a member, its encoding tied to its members. The schema itself when nothing
 * changes. `idField` is the `${field}Id` a member taking no reference refuses (by `guard`), in an
 * element that has a reference member.
 */
const elementInput = (
  schema: Schema.Top,
  fetched: RefEntity | undefined,
  stamps: AggregateStamps | undefined,
  idField: string | undefined,
  guard: Guard,
): Schema.Top => {
  const name = fetched === undefined ? undefined : deriveEntityFieldName(fetched)
  const fields = getSchemaFields(schema)
  const members = fields === undefined ? unionMembers(schema) : undefined
  if (members !== undefined) {
    const derived = members.map((member) => elementInput(member, fetched, stamps, idField, guard))
    if (!derived.some((member, i) => member !== members[i])) return schema
    const union = withMetadataOf(
      schema,
      Schema.Union(
        derived as unknown as ReadonlyArray<Schema.Codec<unknown>>,
        (schema.ast as SchemaAST.Union).options,
      ) as unknown as Schema.Top,
    )
    return name !== undefined && hasReferenceMember(schema, name)
      ? withChecks(union, undefined)
      : union
  }
  const reference = name !== undefined && isReferenceMember(schema, name)
  if (fields === undefined) {
    return reference ? (schema.check(recordReference) as unknown as Schema.Top) : schema
  }
  const input = deriveElementMember(schema, fields, fetched, stamps)
  if (reference) return input.check(recordReference) as unknown as Schema.Top
  const inputFields = getSchemaFields(input) ?? fields
  return idField === undefined || idField in inputFields
    ? input
    : guard(input, inputFields, idField)
}

/**
 * A union's members, in the order it decodes them: its schemas', or its AST's. `undefined` for
 * anything else, and for a union piped through a transformation.
 */
const unionMembers = (schema: Schema.Top): ReadonlyArray<Schema.Top> | undefined => {
  const ast = schema.ast
  if (!SchemaAST.isUnion(ast) || ast.encoding !== undefined) return undefined
  const members = (schema as { readonly members?: unknown }).members
  return Array.isArray(members)
    ? (members as ReadonlyArray<Schema.Top>)
    : ast.types.map((type) => Schema.make(type))
}

/**
 * An element (or a union member of one) with fields, as its input takes it: the entity-derived
 * field, when it can hold the entity's record, as `${field}Id`; a date the library stamps optional.
 * The element itself when nothing changes.
 */
const deriveElementMember = (
  elemSchema: Schema.Top,
  elemFields: Record<string, Schema.Top>,
  fetched: RefEntity | undefined,
  stamps: AggregateStamps | undefined,
): Schema.Top => {
  const entityFieldName = fetched ? deriveEntityFieldName(fetched) : undefined
  const managed = stamps === undefined ? undefined : managedDates(stamps, elemFields)
  let hasChanges = false
  const newFields: Record<string, unknown> = {}
  for (const [name, fSchema] of Object.entries(elemFields)) {
    if (name === entityFieldName && holdsRecord(fSchema)) {
      // This field references the entity — transform to ${name}Id: <its key composite>
      const isOpt = isFieldOptional(fSchema)
      const id = refIdInput(fetched!)
      newFields[`${name}Id`] = isOpt ? Schema.optionalKey(id) : id
      hasChanges = true
    } else if (managed?.has(name) === true) {
      newFields[name] = stampInput(fSchema)
      hasChanges = true
    } else {
      newFields[name] = fSchema
    }
  }
  return hasChanges ? Schema.Struct(newFields as any) : elemSchema
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
