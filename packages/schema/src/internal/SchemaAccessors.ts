/**
 * @internal Stable, typed accessors over Effect Schema / SchemaAST internals.
 *
 * Effect's beta releases periodically reshape the Schema AST (e.g. beta.71
 * moved the array element off `.schema` onto `.value`, silently breaking
 * `extractArrayElement` — shipped as regression #53). This module centralises
 * the few AST/Schema introspections the entity & aggregate derivation layers
 * need, routing each through Effect's stable typed accessors and `SchemaAST`
 * type guards instead of ad-hoc `as any` poking. A single canary test
 * (`SchemaAST.test.ts`) probes the runtime shapes so a future beta break
 * surfaces loudly in one place rather than as silent mis-derivation.
 *
 * Not part of the public API.
 */

import { Exit, Schema, SchemaAST } from "effect"
import { effectDeclarationOf } from "./EffectInstances.js"

/**
 * Read `.fields` from a `Schema.Struct` or `Schema.Class`.
 *
 * Both `Struct<Fields>` and `Class<...>` expose a typed public `fields`
 * property in Effect v4 (`Struct.fields`, `Class.fields`). Returns `undefined`
 * for any schema that does not carry a `fields` record (e.g. `Schema.String`,
 * `Schema.Array`).
 */
export const getSchemaFields = (schema: Schema.Top): Record<string, Schema.Top> | undefined => {
  if (hasFields(schema)) return schema.fields
  return undefined
}

/** Type guard: schema carries a typed `.fields` record (Struct / Class). */
export const hasFields = (
  schema: Schema.Top,
): schema is Schema.Top & { readonly fields: Record<string, Schema.Top> } =>
  "fields" in schema &&
  typeof (schema as { readonly fields?: unknown }).fields === "object" &&
  (schema as { readonly fields?: unknown }).fields !== null

/**
 * Whether a struct-field schema is optional.
 *
 * `Schema.optionalKey(X)` / `Schema.optional(X)` both flip the field's AST
 * context to optional. `SchemaAST.isOptional(ast)` is the stable public guard
 * for this — it works regardless of whether the optional wrapper produced an
 * `Arrays`, `Union`, or other node tag.
 */
export const isFieldOptional = (fieldSchema: Schema.Top): boolean =>
  SchemaAST.isOptional(fieldSchema.ast)

/** Whether `undefined` or `null` is a value of this type, as far as its unions say. */
const admitsNoValue = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isUndefined(ast) ||
  SchemaAST.isNull(ast) ||
  SchemaAST.isVoid(ast) ||
  SchemaAST.isUnknown(ast) ||
  SchemaAST.isAny(ast) ||
  (SchemaAST.isSuspend(ast) && admitsNoValue(ast.thunk())) ||
  (SchemaAST.isUnion(ast) && ast.types.some((member) => admitsNoValue(member)))

/**
 * Whether every value of a struct holds this field: its key is required, and neither `undefined`
 * nor `null` is one of its values. An input may leave any other field without a value.
 */
export const alwaysHeld = (fieldSchema: Schema.Top): boolean =>
  !isFieldOptional(fieldSchema) && !admitsNoValue(SchemaAST.toType(fieldSchema.ast))

/**
 * Extract the element schema from a field that is `Schema.Array(T)`,
 * `Schema.NonEmptyArray(T)`, `Schema.optionalKey(Schema.Array(T))`, or
 * `Schema.optional(Schema.Array(T))`. Returns `T`, or `undefined` when the
 * field is not array-shaped.
 *
 * Routing (verified runtime shape on Effect beta.85):
 * - `Array(T)` / `NonEmptyArray(T)` → AST is `Arrays`; the element is the
 *   typed `.value` property on the schema.
 * - `optionalKey(Array(T))` → AST is still `Arrays` (`isOptional` true); the
 *   inner array is the typed `.schema` property, whose element is `.value`.
 * - `optional(Array(T))` → AST is a `Union` (`Array | undefined`); the inner
 *   union is the typed `.schema` property, and its typed `.members` contains
 *   the `Arrays` member whose element is `.value`.
 */
export const extractArrayElement = (fieldSchema: Schema.Top): Schema.Top | undefined => {
  const ast = fieldSchema.ast

  // Array(T) / NonEmptyArray(T) — including optionalKey(Array(T)), whose AST is
  // still an `Arrays` node with `isOptional` set.
  if (SchemaAST.isArrays(ast)) {
    if (SchemaAST.isOptional(ast)) {
      // optionalKey(Array(T)): the inner Array(T) is the typed `.schema`.
      const inner = getSchemaProp(fieldSchema, "schema")
      return inner ? arrayValue(inner) : undefined
    }
    // Direct Array(T) / NonEmptyArray(T): the element is the typed `.value`.
    return arrayValue(fieldSchema)
  }

  // optional(Array(T)): AST is a Union (Array | undefined). The inner union is
  // the typed `.schema`; its typed `.members` holds the `Arrays` member.
  if (SchemaAST.isUnion(ast) && SchemaAST.isOptional(ast)) {
    const inner = getSchemaProp(fieldSchema, "schema")
    const members = inner ? getSchemaMembers(inner) : undefined
    if (members) {
      for (const member of members) {
        if (SchemaAST.isArrays(member.ast)) return arrayValue(member)
      }
    }
  }

  return undefined
}

/**
 * The value schema of a keyed collection a custom `decompose` takes apart: `Schema.Record(K, T)`,
 * under `optional` / `optionalKey` too. Returns `T`.
 */
export const extractKeyedValue = (fieldSchema: Schema.Top): Schema.Top | undefined => {
  const keyed = (schema: Schema.Top): Schema.Top | undefined =>
    getSchemaProp(schema, "key") === undefined ? undefined : getSchemaProp(schema, "value")
  if (SchemaAST.isOptional(fieldSchema.ast)) {
    const inner = getSchemaProp(fieldSchema, "schema")
    if (inner === undefined) return undefined
    const members = getSchemaMembers(inner)
    if (members === undefined) return keyed(inner)
    for (const member of members) {
      const value = keyed(member)
      if (value !== undefined) return value
    }
    return undefined
  }
  return keyed(fieldSchema)
}

/** Read the typed `.value` element schema off an `Array`/`NonEmptyArray` schema. */
const arrayValue = (schema: Schema.Top): Schema.Top | undefined => getSchemaProp(schema, "value")

/** Read the typed `.members` array off a `Union` schema, if present. */
const getSchemaMembers = (schema: Schema.Top): ReadonlyArray<Schema.Top> | undefined => {
  const members = (schema as unknown as { readonly members?: unknown }).members
  return Array.isArray(members) ? (members as ReadonlyArray<Schema.Top>) : undefined
}

/**
 * Read a typed nested-schema property (`schema` / `value`) that Effect exposes
 * on wrapper schemas (`optionalKey.schema`, `$Array.value`, …). Validates the
 * value is itself a schema (carries `.ast`) before returning it.
 *
 * Note: a schema may be either an object (`Schema.Struct`, `Schema.String`) or
 * a function (a `Schema.Class` is its constructor) — both carry `.ast`, so we
 * accept either `typeof`.
 */
const getSchemaProp = (
  schema: Schema.Top,
  prop: "schema" | "key" | "value",
): Schema.Top | undefined => {
  const value = (schema as unknown as Record<string, unknown>)[prop]
  if (isSchemaLike(value)) return value
  return undefined
}

/**
 * A schema is any object or function (class constructor) carrying `.ast`.
 *
 * The `function` half is load-bearing: since Effect 4.0.0-rc every schema is
 * callable, so a `typeof value === "object"` test alone silently rejects them.
 */
export const isSchemaLike = (value: unknown): value is Schema.Top =>
  value != null &&
  (typeof value === "object" || typeof value === "function") &&
  "ast" in (value as object)

/**
 * Inspect a schema's AST as a `Record`-shaped `Objects` node:
 * no property signatures + exactly one (string-keyed) index signature.
 *
 * Returns the index-signature value AST on match, otherwise `undefined`.
 * Effect v4 `Schema.Record(K, V)` produces an `Objects` AST node with an empty
 * `propertySignatures` and a single `indexSignatures` entry.
 */
export const recordValueAst = (schema: Schema.Top): SchemaAST.AST | undefined =>
  recordValueAstFromAst(schema.ast)

/**
 * As {@link recordValueAst}, but operating directly on a raw AST (e.g. the
 * value AST of an outer `Record`, for nested-sparse detection).
 */
export const recordValueAstFromAst = (
  ast: SchemaAST.AST | undefined,
): SchemaAST.AST | undefined => {
  if (!ast || !SchemaAST.isObjects(ast)) return undefined
  if (ast.propertySignatures.length !== 0 || ast.indexSignatures.length !== 1) return undefined
  return ast.indexSignatures[0]!.type
}

/**
 * Read the wire form (`"string"` or `"number"`) a transform schema encodes to,
 * by walking its encoding chain (`Base.encoding`, a non-empty tuple of `Link`s)
 * to the final leaf and matching the leaf's `to` AST with `SchemaAST.isString`
 * / `isNumber`. Returns `undefined` when there is no encoding or the leaf is
 * neither a string nor a number node.
 */
export const transformWireKind = (schema: Schema.Top): "string" | "number" | undefined => {
  const encoding = schema.ast.encoding
  if (!encoding || encoding.length === 0) return undefined
  const leaf = encoding[encoding.length - 1]
  if (!leaf) return undefined
  const to = leaf.to
  if (SchemaAST.isString(to)) return "string"
  if (SchemaAST.isNumber(to)) return "number"
  return undefined
}

/**
 * Read the first type-parameter AST off a declaration AST (e.g. the inner type
 * of `Redacted<T>`).
 *
 * UNSTABLE: `ast.typeParameters` has no public typed accessor on Effect v4 —
 * the property exists at runtime on `Declaration` nodes but is not surfaced on
 * the typed `AST` union. This helper isolates that single untyped read so a
 * future beta break surfaces in exactly one place (and is covered by the
 * `SchemaAST.test.ts` canary). Returns `undefined` when no type parameters are
 * present.
 *
 * @see https://github.com/Effect-TS/effect-smol — `Declaration` AST node
 */
export const firstTypeParameterAst = (ast: SchemaAST.AST): SchemaAST.AST | undefined => {
  const params = (ast as unknown as { readonly typeParameters?: ReadonlyArray<SchemaAST.AST> })
    .typeParameters
  if (!params || params.length === 0) return undefined
  return params[0]
}

/**
 * Whether a schema carries an encoding transformation — i.e. its Type form and
 * its Encoded (wire) form can differ.
 *
 * `SchemaAST.Base.encoding` is a documented public field: "When `undefined`,
 * the node has no encoding transformation (type and encoded forms are
 * identical)." That contract is what makes it safe to skip encoding entirely
 * for plain `String` / `Number` / `Boolean` / `Literals` composites — which
 * matters because an open sort key bound (`gte(t.status, "d")`) is deliberately
 * NOT a valid value of the composite and would fail an encode that a
 * transformed composite must pass.
 *
 * Covered by the `SchemaAST.test.ts` canary so a future Effect release that
 * reshapes `encoding` surfaces here rather than as silent mis-composition.
 */
export const hasEncodingTransformation = (schema: Schema.Top): boolean =>
  schema.ast.encoding !== undefined

/**
 * Whether a schema's **Type** side is numeric (`number` / `bigint`) while its
 * **Encoded** side is a `string`.
 *
 * This is the one shape where key composition must use the Type value rather
 * than the encoded one: `KeyComposer.serializeValue` encodes numbers and
 * bigints so their key text sorts in numeric order, but treats a string as
 * text. Composing `Schema.BigIntFromString`'s encoded `"42"` therefore stored
 * `txn_42` next to `txn_100` and `txn_5`, which sorts as 100 < 42 < 5 — a
 * range query returned the wrong rows. Composing the Type value `42n` encodes
 * it instead.
 *
 * `SchemaAST.toType` / `toEncoded` are Effect's public AST projections; the
 * `SchemaAST.test.ts` canary pins the tags this reads.
 */
export const numericTypeWithStringEncoding = (schema: Schema.Top): boolean => {
  const typeAst = SchemaAST.toType(schema.ast)
  const encodedAst = SchemaAST.toEncoded(schema.ast)
  return (
    (SchemaAST.isNumber(typeAst) || SchemaAST.isBigInt(typeAst)) && SchemaAST.isString(encodedAst)
  )
}

/** The `representation` id Effect gives `Schema.ReadonlySet`, the one type stored as a set. */
const READONLY_SET = "effect/schema/ReadonlySet"

/**
 * What an absent attribute reads back as, on a field whose stored side includes
 * a value DynamoDB has no form for.
 */
export interface AbsentReading {
  /** The value on the field's stored side: `undefined`, or an empty set. */
  readonly stored: unknown
  /** That value decoded through the field: what a reader gets. */
  readonly value: unknown
}

/** The `representation` id Effect gives a declaration of its own. A custom one has none. */
const representationIdOf = (ast: SchemaAST.AST): string | undefined => {
  const representation = (ast.annotations as Record<string, unknown> | undefined)?.representation
  const id = (representation as { readonly id?: unknown } | undefined)?.id
  return typeof id === "string" ? id : undefined
}

/** Whether an AST is the declaration Effect represents under this id. */
const isDeclarationOf = (ast: SchemaAST.AST, id: string): boolean =>
  ast._tag === "Declaration" && representationIdOf(ast) === id

/** Whether an AST is a `Schema.ReadonlySet`, by the id Effect gives its representation. */
export const isSetDeclaration = (ast: SchemaAST.AST): boolean => isDeclarationOf(ast, READONLY_SET)

/** Why a schema can't be stored and read back, and what to use instead. */
interface Unreadable {
  readonly name: string
  readonly why: string
  readonly use: string
}

const NO_LONGER_DECODES = "it's stored as an empty map, which no longer decodes"

/**
 * Effect's declarations that no owner can read back, by the `representation` id Effect gives them,
 * each with a replacement measured on entities, aggregates, streams and outboxes.
 */
const NEVER_READ_BACK: Readonly<Record<string, Unreadable>> = {
  "effect/schema/ReadonlyMap": {
    name: "Schema.ReadonlyMap",
    why: "it's stored as a map, a map reads back as a plain object, and the row no longer decodes",
    use: "Schema.Record, which is stored the same way and reads back",
  },
  "effect/schema/HashMap": {
    name: "Schema.HashMap",
    why: "a non-empty one can't be written, and an empty one is stored as its internals, which no longer decode",
    use: "Schema.Record",
  },
  "effect/schema/Chunk": {
    name: "Schema.Chunk",
    why: "writing one overflows the stack, so nothing is ever stored",
    use: "Schema.Array",
  },
  "effect/schema/URL": {
    name: "Schema.URL",
    why: "it's stored as a map of its parts, which no longer decodes",
    use: "Schema.URLFromString",
  },
  "effect/schema/URLSearchParams": {
    name: "Schema.URLSearchParams",
    why: "it's stored as a map of its size alone, which no longer decodes",
    use: "Schema.String, holding the parameters as text",
  },
  "effect/schema/RegExp": {
    name: "Schema.RegExp",
    why: NO_LONGER_DECODES,
    use: "Schema.String, holding the pattern as text",
  },
  "effect/schema/FormData": {
    name: "Schema.FormData",
    why: NO_LONGER_DECODES,
    use: "Schema.Record",
  },
  "effect/http/Headers": {
    name: "Schema.Headers",
    why: "it's stored as a map, a map reads back as a plain object, and the row no longer decodes",
    use: "Schema.Record",
  },
  "effect/schema/File": {
    name: "Schema.File",
    why: "it's stored as bytes without its name or type, which no longer decode",
    use: "Schema.Uint8Array",
  },
  "effect/schema/ByteSize": {
    name: "Schema.ByteSize",
    why: "it's stored as a number, which no longer decodes",
    use: "Schema.ByteSizeFromString or Schema.ByteSizeFromNumber",
  },
  "effect/schema/Error": {
    name: "Schema.ErrorInstance",
    why: NO_LONGER_DECODES,
    use: "Schema.Defect()",
  },
}

const DATE = "effect/schema/Date"
const REDACTED = "effect/schema/Redacted"

/** What an aggregate's date encoder stores as a string. */
const DATE_DOMAINS: ReadonlySet<string | undefined> = new Set([
  DATE,
  "effect/schema/DateTimeUtc",
  "effect/schema/DateTimeZoned",
])

const PLAIN_DATE: Unreadable = {
  name: "Schema.Date",
  why: `${NO_LONGER_DECODES}. An entity or an aggregate stores one as a string only where it reaches it, which isn't under another declaration, a Schema.suspend, a transformation or a decoding default on a container`,
  use: "Schema.DateFromString or Schema.DateFromMillis",
}
const TRANSFORMED_DATE: Unreadable = {
  name: "a transformation over Schema.Date, such as Schema.DateTimeUtcFromDate",
  why: "its stored form no longer decodes",
  use: "Schema.DateTimeUtcFromString or Schema.DateTimeUtcFromMillis",
}
const PLAIN_REDACTED: Unreadable = {
  name: "Schema.Redacted",
  why: "its value isn't stored, and reading it fails. An entity or an aggregate stores the value only where it reaches it, which isn't under another declaration, a Schema.suspend, a transformation or a decoding default on a container",
  use: "Schema.RedactedFromValue",
}
const BIGINT_BESIDE_A_NUMBER: Unreadable = {
  name: "a union of Schema.BigInt and something else stored as a number",
  why: "5n and 5 are stored the same, so a read can't tell which one was written",
  use: "Schema.BigIntFromString",
}
const BIGINT_LITERAL: Unreadable = {
  name: "a bigint Schema.Literal",
  why: "it's stored as a number, which reads back as a number and no longer decodes",
  use: "a string or a number literal",
}

/**
 * What stores a schema. An entity's or an aggregate's fields are substituted before they're
 * marshalled, so a date and a redacted value read back there; a stream, a snapshot and an outbox
 * encode through the schema alone, and a read lifts a date. Every owner lifts a bigint.
 */
export type StoredBy = "entity" | "aggregate" | "schema"

/**
 * An encoding the owner's substitution can't see through, because the runtime accessors it walks
 * aren't on the node: a decoding default on a container, seen through only by a read, a transformation
 * between lists holding the same things, which an entity and an aggregate rebuild from the type side,
 * and any other transformation.
 */
type EncodingStep = "default" | "list" | "transformation"

interface UnreadableWalk {
  readonly by: StoredBy
  readonly manyEdges: ReadonlySet<string>
  /** The type this node is the encoding of, when it was reached through one. */
  readonly declared: SchemaAST.AST | undefined
  /** The substitution doesn't reach it: see `unreachedBy`. */
  readonly unreached: boolean
  /** A read reaches it and a write doesn't, so what's stored is what the schema encodes. */
  readonly writtenAsIs: boolean
  /** The encoding this was reached through, if the substitution can't see through it. */
  readonly beneath: EncodingStep | undefined
  /** Under a union, other than the one `Schema.optional` makes of a field. */
  readonly inUnion: boolean
  /** This field is a `many` edge: its collection is rows, and only the rows are stored. */
  readonly edge: boolean
}

/**
 * Whether a field reached this node through a transformation. A decoding default isn't one, and the
 * owner's substitution sees through it. A transformation is one even when it ends in the type it
 * started from, since the owner stores and reads what's beneath it.
 */
const isTransformed = (walk: UnreadableWalk): boolean =>
  walk.declared !== undefined && walk.beneath !== "default"

/** Whether this node, on its own, is something this owner can't read back. */
const unreadableAt = (ast: SchemaAST.AST, walk: UnreadableWalk): Unreadable | undefined => {
  const stored = walk.by !== "schema" && !walk.unreached && !walk.writtenAsIs
  switch (ast._tag) {
    case "Literal":
      return typeof ast.literal === "bigint" ? BIGINT_LITERAL : undefined
    case "Declaration": {
      const id = representationIdOf(ast) ?? ""
      if (id === DATE) {
        if (isTransformed(walk)) return TRANSFORMED_DATE
        return stored ? undefined : PLAIN_DATE
      }
      if (id === REDACTED) {
        // A step ending in a redacted value is substituted whole. A step onto anything else, such as
        // `Schema.OptionFromOptional`, writes what's beneath it as declared.
        const overAnother = isTransformed(walk) && representationIdOf(walk.declared!) !== REDACTED
        return stored && !overAnother ? undefined : PLAIN_REDACTED
      }
      return NEVER_READ_BACK[id]
    }
    default:
      return undefined
  }
}

type Forced = { readonly node: SchemaAST.AST; readonly seen: ReadonlySet<SchemaAST.AST> }

/** What a suspended node stands for, and the suspensions on the way to it. `undefined` is a cycle. */
const forced = (ast: SchemaAST.AST, seen: ReadonlySet<SchemaAST.AST>): Forced | undefined => {
  if (!SchemaAST.isSuspend(ast)) return { node: ast, seen }
  return seen.has(ast) ? undefined : forced(ast.thunk(), new Set(seen).add(ast))
}

const JSON_VALUES: ReadonlySet<string | undefined> = new Set([
  "effect/schema/Json",
  "effect/schema/MutableJson",
])

/** A number may be what it takes: a custom declaration doesn't say, and the rest take any value. */
const takesAnything = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isUnknown(ast) ||
  SchemaAST.isAny(ast) ||
  (SchemaAST.isDeclaration(ast) &&
    (representationIdOf(ast) === undefined || JSON_VALUES.has(representationIdOf(ast))))

const isNumeric = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isNumber(ast) ||
  SchemaAST.isEnum(ast) ||
  (SchemaAST.isLiteral(ast) && typeof ast.literal === "number")

/** The kind of attribute a node takes, with a bigint's being a number's. */
const storedKind = (ast: SchemaAST.AST): string =>
  SchemaAST.isLiteral(ast)
    ? typeof ast.literal
    : isNumeric(ast) || SchemaAST.isBigInt(ast)
      ? "number"
      : SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)
        ? "string"
        : SchemaAST.isBoolean(ast)
          ? "boolean"
          : ast._tag

/** Whether a struct's map is one a struct takes: it has every field the struct requires. */
const hasFieldsOf = (writer: SchemaAST.Objects, taker: SchemaAST.Objects): boolean =>
  taker.propertySignatures.every(
    (theirs) =>
      SchemaAST.isOptional(theirs.type) ||
      writer.indexSignatures.length > 0 ||
      writer.propertySignatures.some((mine) => mine.name === theirs.name),
  )

const storedMap = (
  tag: string,
  marker: string,
  fields: Readonly<Record<string, SchemaAST.AST>>,
): SchemaAST.Objects =>
  Schema.Struct({
    _op: Schema.String,
    _tag: Schema.Literal(tag),
    [marker]: Schema.Struct({}),
    ...Object.fromEntries(
      Object.entries(fields).map(([name, ast]) => [name, Schema.make<Schema.Top>(ast)]),
    ),
  }).ast

/**
 * The maps the marshaller makes of a declaration, where one holds a value in it. A struct takes a
 * stored value by its fields, so these say which structs take one of these for their own.
 */
const STORED_MAPS: Readonly<
  Record<string, (parameters: ReadonlyArray<SchemaAST.AST>) => ReadonlyArray<SchemaAST.Objects>>
> = {
  "effect/schema/Option": ([value]) => [
    storedMap("Some", "~effect/Option", { value: value! }),
    storedMap("None", "~effect/Option", {}),
  ],
  "effect/schema/Result": ([success, failure]) => [
    storedMap("Success", "~effect/Result", { success: success! }),
    storedMap("Failure", "~effect/Result", { failure: failure! }),
  ],
}

const storedMapsOf = (ast: SchemaAST.Declaration) =>
  STORED_MAPS[representationIdOf(ast) ?? ""]?.(ast.typeParameters)

/**
 * Whether a struct declares a marker. Each of Effect's declarations looks for its marker or a class,
 * and none takes any other map or a primitive (measured, each of them), so a struct's map is one of
 * theirs only with a marker in it.
 */
const declaresMarker = (ast: SchemaAST.Objects): boolean =>
  ast.propertySignatures.some(
    (property) => typeof property.name === "string" && property.name.startsWith("~effect/"),
  )

/**
 * Whether a stored value could be one both a declaration of Effect's and this take. What a struct
 * takes of one depends on the map it's stored as. Two declarations, or a struct beside a declaration
 * whose map isn't known, count.
 */
const declarationCouldBe = (
  declaration: SchemaAST.Declaration,
  other: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST>,
): boolean => {
  if (SchemaAST.isDeclaration(other)) return true
  if (!SchemaAST.isObjects(other)) return false
  const maps = storedMapsOf(declaration)
  return (
    maps === undefined ||
    maps.some((map) => hasFieldsOf(map, other) && couldBeBoth(map, other, seen))
  )
}

/** Whether a stored value could be one both of these take. What can't be told apart counts. */
const couldBeBoth = (
  a: SchemaAST.AST,
  b: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST>,
): boolean => {
  const left = forced(a, seen)
  const right = forced(b, left?.seen ?? seen)
  if (left === undefined || right === undefined) return true
  const [l, r, within] = [left.node, right.node, right.seen]
  if (SchemaAST.isUnion(l)) return l.types.some((type) => couldBeBoth(type, r, within))
  if (SchemaAST.isUnion(r)) return r.types.some((type) => couldBeBoth(l, type, within))
  if (takesAnything(l) || takesAnything(r)) return true
  if (SchemaAST.isDeclaration(l)) return declarationCouldBe(l, r, within)
  if (SchemaAST.isDeclaration(r)) return declarationCouldBe(r, l, within)
  if (SchemaAST.isLiteral(l) && SchemaAST.isLiteral(r)) return l.literal === r.literal
  if (SchemaAST.isObjects(l) && SchemaAST.isObjects(r)) {
    // A record takes a field its values could be, and a key it doesn't cover says nothing.
    const fitsRecord = (fields: SchemaAST.Objects, record: SchemaAST.Objects) =>
      fields.propertySignatures.every(
        (property) =>
          SchemaAST.isOptional(property.type) ||
          record.propertySignatures.some((named) => named.name === property.name) ||
          record.indexSignatures.every(
            (index) =>
              !SchemaAST.isString(index.parameter) ||
              couldBeBoth(property.type, index.type, within),
          ),
      )
    return (
      fitsRecord(l, r) &&
      fitsRecord(r, l) &&
      l.propertySignatures.every((property) => {
        const other = r.propertySignatures.find((candidate) => candidate.name === property.name)
        return (
          other === undefined ||
          (SchemaAST.isOptional(property.type) && SchemaAST.isOptional(other.type)) ||
          couldBeBoth(property.type, other.type, within)
        )
      })
    )
  }
  return storedKind(l) === storedKind(r)
}

/** Whether a stored side holds a plain bigint anywhere. */
export const holdsPlainBigint = (
  ast: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
): boolean => {
  const found = forced(ast, seen)
  if (found === undefined) return false
  const { node } = found
  const within = (asts: ReadonlyArray<SchemaAST.AST>) =>
    asts.some((part) => holdsPlainBigint(part, found.seen))
  switch (node._tag) {
    case "BigInt":
      return true
    case "Declaration":
      return within(node.typeParameters)
    case "Union":
      return within(node.types)
    case "Arrays":
      return within([...node.elements, ...node.rest])
    case "Objects":
      return within([
        ...node.propertySignatures.map((property) => property.type),
        ...node.indexSignatures.map((signature) => signature.type),
      ])
    default:
      return false
  }
}

/**
 * Whether a number can end up on the wrong side of a plain bigint, between two members of a union.
 * The bigint is lifted where it sits and a union tries its members in order, so whichever of the two
 * comes `first` takes what the other stored, if it has what the first requires: a bigint's number
 * kept as a number, or another member's number lifted to a bigint. Two structs apart on a field, as
 * tagged events are, can't. A value lost to an earlier member that has no place for it isn't this:
 * a union of anything does that. What can't be told apart counts.
 */
const confusesItsBigint = (
  holder: SchemaAST.AST,
  other: SchemaAST.AST,
  first: boolean,
  seen: ReadonlySet<SchemaAST.AST>,
): boolean => {
  const left = forced(holder, seen)
  const right = forced(other, left?.seen ?? seen)
  if (left === undefined || right === undefined) return false
  const [l, r, within] = [left.node, right.node, right.seen]
  const confused = (mine: SchemaAST.AST, theirs: SchemaAST.AST) =>
    confusesItsBigint(mine, theirs, first, within)
  if (SchemaAST.isUnion(l)) return l.types.some((type) => confused(type, r))
  if (SchemaAST.isUnion(r)) return r.types.some((type) => confused(l, type))
  if (SchemaAST.isBigInt(l)) return isNumeric(r) || takesAnything(r)
  if (takesAnything(r)) return !(first && SchemaAST.isDeclaration(l)) && holdsPlainBigint(l)
  if (SchemaAST.isArrays(l)) {
    if (!SchemaAST.isArrays(r)) return false
    const fixed = Math.min(l.elements.length, r.elements.length)
    const parts = (ast: SchemaAST.Arrays) => [...ast.elements, ...ast.rest]
    return (
      l.elements
        .slice(0, fixed)
        .every((element, i) => couldBeBoth(element, r.elements[i]!, new Set())) &&
      parts(l).some((mine, i) =>
        (i < fixed ? [r.elements[i]!] : parts(r)).some((theirs) => confused(mine, theirs)),
      )
    )
  }
  if (SchemaAST.isObjects(l)) {
    if (SchemaAST.isDeclaration(r)) {
      if (!first) return declaresMarker(l) && holdsPlainBigint(l)
      return storedMapsOf(r)?.some((map) => confused(l, map)) ?? false
    }
    if (!SchemaAST.isObjects(r)) return false
    if (!(first ? hasFieldsOf(r, l) : hasFieldsOf(l, r)) || !couldBeBoth(l, r, new Set())) {
      return false
    }
    const records = r.indexSignatures.map((signature) => signature.type)
    return (
      l.propertySignatures.some((mine) => {
        const named = r.propertySignatures.find((theirs) => theirs.name === mine.name)
        return (named === undefined ? records : [named.type]).some((theirs) =>
          confused(mine.type, theirs),
        )
      }) ||
      l.indexSignatures.some((signature) =>
        [...r.propertySignatures.map((theirs) => theirs.type), ...records].some((theirs) =>
          confused(signature.type, theirs),
        ),
      )
    )
  }
  if (SchemaAST.isDeclaration(l)) {
    if (SchemaAST.isObjects(r)) {
      if (first) return declaresMarker(r) && holdsPlainBigint(l)
      if (isSetDeclaration(l)) return false
      const maps = storedMapsOf(l)
      return maps === undefined ? holdsPlainBigint(l) : maps.some((map) => confused(map, r))
    }
    return (
      SchemaAST.isDeclaration(r) &&
      representationIdOf(l) === representationIdOf(r) &&
      l.typeParameters.some(
        (parameter, i) =>
          r.typeParameters[i] !== undefined && confused(parameter, r.typeParameters[i]!),
      )
    )
  }
  return false
}

/**
 * Whether a union's members can confuse a bigint with a number. A `oneOf` tries every member, so
 * neither comes first and a value two of them take fails the read.
 */
const hasBigintBesideANumber = (union: SchemaAST.Union): boolean => {
  const members = union.types.map((member) => SchemaAST.toEncoded(member))
  return members.some((holder, at) =>
    members.some(
      (other, position) =>
        position !== at &&
        (union.options?.mode === "oneOf"
          ? confusesItsBigint(holder, other, true, new Set()) ||
            confusesItsBigint(holder, other, false, new Set())
          : confusesItsBigint(holder, other, at < position, new Set())),
    ),
  )
}

/** A `Schema.Class`'s own encoding step, onto the struct of its fields, which are walked. */
const isClassStep = (ast: SchemaAST.AST, to: SchemaAST.AST): boolean =>
  SchemaAST.isDeclaration(ast) && ast.typeParameters[0] === to

/** A union of X and undefined, and nothing else, which is what `Schema.optional(X)` makes of X. */
const isOptionalOfOne = (ast: SchemaAST.Union): boolean =>
  ast.types.filter((member) => !SchemaAST.isUndefined(member)).length === 1

/** Whether a stored side has a type's shape: the same kind of node, with the same fields or elements. */
const sameShape = (type: SchemaAST.AST, stored: SchemaAST.AST): boolean => {
  if (type._tag !== stored._tag || representationIdOf(type) !== representationIdOf(stored)) {
    return false
  }
  if (SchemaAST.isArrays(type) && SchemaAST.isArrays(stored)) return sameElements(type, stored)
  if (!SchemaAST.isObjects(type) || !SchemaAST.isObjects(stored)) return true
  const names = new Set(stored.propertySignatures.map((property) => property.name))
  return (
    type.propertySignatures.length === names.size &&
    type.propertySignatures.every((property) => names.has(property.name))
  )
}

/** Whether two lists hold the same things, which is what makes a step between them invisible. */
const sameElements = (type: SchemaAST.Arrays, stored: SchemaAST.Arrays): boolean => {
  const same = (a: SchemaAST.AST, b: SchemaAST.AST) =>
    sameShape(SchemaAST.toType(a), SchemaAST.toType(b))
  return (
    type.elements.length === stored.elements.length &&
    type.rest.length === stored.rest.length &&
    type.elements.every((element, at) => same(element, stored.elements[at]!)) &&
    type.rest.every((element, at) => same(element, stored.rest[at]!))
  )
}

/**
 * Whether a step onto `to` is a decoding default: the stored side may be absent, it's the same type
 * on both sides, where `Schema.OptionFromOptionalKey` is a different one, and nothing else changes
 * it on the way, as a transformation beneath the default would.
 */
export const isDecodingDefault = (ast: SchemaAST.AST, to: SchemaAST.AST): boolean => {
  if (to.context?.isOptional !== true) return false
  const steps = ast.encoding ?? []
  const type = steps.length === 2 ? steps[0]!.to : ast
  if (steps.length > 2 || (steps.length === 2 && !isClassStep(ast, type))) return false
  const sides = SchemaAST.isUnion(to) && isOptionalOfOne(to) ? [to, ...to.types] : [to]
  return sides.some((side) => sameShape(type, side))
}

/** The list a step's stored side is, if it's one: `Schema.UndefinedOr(Schema.Array(X))` is that array. */
export const storedList = (to: SchemaAST.AST): SchemaAST.Arrays | undefined => {
  const side =
    SchemaAST.isUnion(to) && isOptionalOfOne(to)
      ? to.types.find((member) => !SchemaAST.isUndefined(member))
      : to
  return side !== undefined && SchemaAST.isArrays(side) ? side : undefined
}

/** The encoding step onto `to`, unless a class's own. */
const encodingStep = (
  ast: SchemaAST.AST,
  to: SchemaAST.AST,
  walk: UnreadableWalk,
): EncodingStep | undefined => {
  if (isClassStep(ast, to) || walk.beneath === "transformation") return walk.beneath
  if (isDecodingDefault(ast, to)) return "default"
  if (walk.by === "schema" || !SchemaAST.isArrays(ast)) return "transformation"
  const list = storedList(to)
  return list !== undefined && sameElements(ast, list) ? "list" : "transformation"
}

/** What the children of a container beneath an encoding are. A list stays seen through. */
const unreachedBy = (walk: UnreadableWalk, list: boolean): Partial<UnreadableWalk> => {
  if (walk.beneath === undefined || (list && walk.beneath !== "transformation")) return {}
  return walk.beneath === "default" ? { writtenAsIs: true } : { unreached: true }
}

/** A plain date or nothing, as an aggregate's date encoder finds it in an attribute's union. */
const isNullablePlainDate = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isUnion(ast) &&
  ast.types.every(
    (member) =>
      SchemaAST.isNull(member) ||
      SchemaAST.isUndefined(member) ||
      (member.encoding === undefined && DATE_DOMAINS.has(representationIdOf(member))),
  )

/**
 * A transformation to a date on an aggregate: its date encoder stores the domain value as a string,
 * whatever the transformation is over, except under a union or another declaration. It finds one
 * under a decoding default too, in an attribute of the aggregate's own and not deeper.
 */
const storedByDateEncoder = (
  ast: SchemaAST.AST,
  to: SchemaAST.AST,
  path: string,
  walk: UnreadableWalk,
): boolean => {
  if (walk.by !== "aggregate" || walk.unreached || walk.inUnion) return false
  return (
    DATE_DOMAINS.has(representationIdOf(SchemaAST.toType(ast))) ||
    (to.context?.isOptional === true && !/[.[]/.test(path) && isNullablePlainDate(ast))
  )
}

/**
 * The first thing in this AST that can't be read back, and its path. A cycle through
 * `Schema.suspend` ends where it starts, and a path segment says what kind of value it went through.
 */
const firstUnreadable = (
  ast: SchemaAST.AST,
  path: string,
  seen: Set<SchemaAST.AST>,
  walk: UnreadableWalk,
): { readonly at: string; readonly what: Unreadable } | undefined => {
  const firstIn = (asts: ReadonlyArray<SchemaAST.AST>, at: string, next: UnreadableWalk) => {
    for (const part of asts) {
      const found = firstUnreadable(part, at, seen, next)
      if (found !== undefined) return found
    }
    return undefined
  }
  const child = (at: string, list = false): UnreadableWalk => ({
    ...walk,
    ...unreachedBy(walk, list),
    declared: undefined,
    edge: walk.manyEdges.has(at),
  })
  const encoding = ast.encoding
  if (encoding !== undefined) {
    const to = encoding[encoding.length - 1]!.to
    if (walk.declared === undefined && storedByDateEncoder(ast, to, path, walk)) return undefined
    const beneath = encodingStep(ast, to, walk)
    return firstUnreadable(to, path, seen, {
      ...walk,
      declared: SchemaAST.toType(ast),
      beneath,
    })
  }
  if (!walk.edge) {
    const what = unreadableAt(ast, walk)
    if (what !== undefined) return { at: path, what }
  }
  switch (ast._tag) {
    case "Declaration":
      return firstIn(
        ast.typeParameters,
        path,
        walk.edge
          ? { ...walk, declared: undefined, edge: false }
          : { ...walk, declared: undefined, unreached: true },
      )
    case "Suspend": {
      if (seen.has(ast)) return undefined
      seen.add(ast)
      return firstUnreadable(ast.thunk(), path, seen, { ...walk, unreached: true })
    }
    case "Union": {
      // Where the substitution reaches a union, every member gets its try as declared and only a
      // number none of them takes is lifted. Anywhere else the lift is on the bigint itself.
      const lifted = walk.by === "schema" || walk.unreached || walk.beneath === "transformation"
      if (lifted && hasBigintBesideANumber(ast)) {
        return { at: path, what: BIGINT_BESIDE_A_NUMBER }
      }
      const members: UnreadableWalk = {
        ...walk,
        // The union `Schema.optional(X)` makes under a default on X, which is X to the substitution.
        ...(isOptionalOfOne(ast) && walk.declared?._tag !== "Union"
          ? {}
          : unreachedBy(walk, false)),
        inUnion: walk.inUnion || ast.context?.isOptional !== true,
      }
      if (ast.context?.isOptional !== true) return firstIn(ast.types, path, members)
      // `Schema.optionalKey` over several members: the first is written in its stored form, and the
      // rest as they're declared, unless an aggregate's date encoder finds them in its own attribute.
      const defined = ast.types.filter((member) => !SchemaAST.isUndefined(member))
      const encoded = walk.by === "aggregate" && !/[.[]/.test(path) && isNullablePlainDate(ast)
      return (
        firstIn(defined.slice(0, 1), path, members) ??
        firstIn(defined.slice(1), path, encoded ? members : { ...members, writtenAsIs: true })
      )
    }
    case "Arrays":
      return firstIn(
        [...ast.elements, ...ast.rest],
        `${path}[]`,
        child(`${path}[]`, ast.elements.length === 0),
      )
    case "Objects": {
      for (const property of ast.propertySignatures) {
        const name = String(property.name)
        const at = path === "" ? name : `${path}.${name}`
        const found = firstUnreadable(property.type, at, seen, child(at))
        if (found !== undefined) return found
      }
      return firstIn(
        ast.indexSignatures.map((signature) => signature.type),
        `${path}[key]`,
        child(`${path}[key]`),
      )
    }
    default:
      return undefined
  }
}

/**
 * `[EDD-9125]`: a model whose stored side holds something its owner can't read back, at any depth.
 * Either the write fails in a way nothing can recover, or it succeeds and the row no longer decodes,
 * so a definition holding one can't work and fails at load. The stored side is what's read: a map
 * decoded from a record, or under `Schema.toCodecJson`, is stored as that and reads back, and the
 * collection a `many` edge is declared as is rows, of which only the rows are stored.
 *
 * Only Effect's own declarations can be judged here. A `Schema.instanceOf` and a duck-typed
 * `Schema.declare` have the same AST, and one reads back where the other doesn't, so those are
 * judged by value at write ({@link holdsCustomDeclaration}, `EDD-9126`).
 */
export const refuseUnreadable = (
  owner: string,
  by: StoredBy,
  model: Schema.Top,
  options?: {
    readonly whole?: string | undefined
    readonly manyEdges?: ReadonlySet<string> | undefined
  },
): void => {
  const found = firstUnreadable(model.ast, "", new Set(), {
    by,
    manyEdges: options?.manyEdges ?? new Set(),
    declared: undefined,
    unreached: false,
    writtenAsIs: false,
    beneath: undefined,
    inUnion: false,
    edge: false,
  })
  if (found === undefined) return
  const { at, what } = found
  throw new Error(
    `[EDD-9125] ${owner}: ${at === "" ? (options?.whole ?? "the model") : `field "${at}"`} is ` +
      `${what.name.startsWith("Schema.") ? "a " : ""}${what.name}, which can't be read back: ` +
      `${what.why}. Use ${what.use}.`,
  )
}

/**
 * Whether a stored side holds a declaration Effect didn't make, such as a `Schema.instanceOf` or a
 * duck-typed `Schema.declare`. Only a value can say whether one reads back (`internal/RoundTrip.ts`
 * in `effect-dynamodb`), and this says which schemas have such values. A `Schema.Class`, and a struct
 * decoded to a class, have an encoding: what's stored is the struct, and only what's in it counts.
 * Effect's own address and DNS record declarations carry no `representation` id, and read back as
 * the instances they were (`internal/InstanceReads.ts`), so they're not custom: recognised by their
 * parser, never by a name, so a `Schema.declare` of your own under the same identifier still is.
 */
export const holdsCustomDeclaration = (
  ast: SchemaAST.AST,
  seen: Set<SchemaAST.AST> = new Set(),
): boolean => {
  const encoding = ast.encoding
  if (encoding !== undefined) {
    return holdsCustomDeclaration(encoding[encoding.length - 1]!.to, seen)
  }
  const within = (asts: ReadonlyArray<SchemaAST.AST>) =>
    asts.some((part) => holdsCustomDeclaration(part, seen))
  switch (ast._tag) {
    case "Declaration":
      return (
        (representationIdOf(ast) === undefined && effectDeclarationOf(ast) === undefined) ||
        within(ast.typeParameters)
      )
    case "Suspend": {
      if (seen.has(ast)) return false
      seen.add(ast)
      return holdsCustomDeclaration(ast.thunk(), seen)
    }
    case "Union":
      return within(ast.types)
    case "Arrays":
      return within([...ast.elements, ...ast.rest])
    case "Objects":
      return within([
        ...ast.propertySignatures.map((property) => property.type),
        ...ast.indexSignatures.map((signature) => signature.type),
      ])
    default:
      return false
  }
}

/**
 * The value on a stored side that DynamoDB can't store, if there is one. With
 * both in one union, `undefined` is what an absent attribute means.
 */
const valueWithNoStoredForm = (
  ast: SchemaAST.AST,
  seen: Set<SchemaAST.AST> = new Set(),
): { readonly stored: unknown } | undefined => {
  switch (ast._tag) {
    case "Undefined":
    case "Void":
    case "Unknown":
    case "Any":
      return { stored: undefined }
    case "Declaration":
      return isSetDeclaration(ast) ? { stored: new Set() } : undefined
    case "Suspend": {
      if (seen.has(ast)) return undefined
      seen.add(ast)
      return valueWithNoStoredForm(ast.thunk(), seen)
    }
    case "Union": {
      const found = ast.types.flatMap((member) => valueWithNoStoredForm(member, seen) ?? [])
      return found.find((value) => value.stored === undefined) ?? found[0]
    }
    default:
      return undefined
  }
}

/**
 * Whether a value of this type can be `undefined` and be stored as one: an `undefined` that
 * encodes to something else has a stored form.
 */
export const holdsUndefined = (ast: SchemaAST.AST): boolean =>
  [SchemaAST.toType(ast), SchemaAST.toEncoded(ast)].every((side) => {
    const found = valueWithNoStoredForm(side)
    return found !== undefined && found.stored === undefined
  })

/**
 * The value a field's absent attribute stands for, from its schema alone: DynamoDB can't
 * store `undefined` or an empty set, so on a field whose stored side includes one the value
 * is an absent attribute. `undefined` when the rule doesn't apply: the field's key is
 * optional, so absent reads as absent (or as its decoding default), or its stored side holds
 * no such value. Nothing the schema runs is run, so a `.check()` that refuses the value isn't
 * seen here: {@link absentReading} asks it, at a write.
 */
export const absentStored = (field: Schema.Top): { readonly stored: unknown } | undefined => {
  const encoded = SchemaAST.toEncoded(field.ast)
  return SchemaAST.isOptional(encoded) ? undefined : valueWithNoStoredForm(encoded)
}

/**
 * The one rule for values with no stored form. DynamoDB can't store `undefined`
 * or an empty set, so on a field whose stored side includes one the value is an
 * absent attribute, and an absent attribute reads back as that value. Returns
 * what it reads back as, or `undefined` when the rule doesn't apply: the field's
 * key is optional, so absent reads as absent (or as its decoding default); or
 * its schema refuses the value, as a `.check()` for a non-empty set does, so no
 * row may be without it.
 *
 * The check decodes for real, running the field's checks and transformations on the value,
 * so it's asked by the write that leaves the attribute out and never while an entity is
 * defined ({@link absentStored} answers there). A transformation that can't run
 * synchronously is taken at its word, reading back as the stored value.
 */
export const absentReading = (field: Schema.Top): AbsentReading | undefined => {
  const found = absentStored(field)
  if (found === undefined) return undefined
  const decoded = Schema.decodeUnknownExit(field as unknown as Schema.Codec<unknown, unknown>)(
    found.stored,
  )
  if (Exit.hasFails(decoded)) return undefined
  return { stored: found.stored, value: Exit.isSuccess(decoded) ? decoded.value : found.stored }
}

/**
 * Whether a step may make something of a key the stored row is without. A getter that only
 * maps the value it's given (`passthrough`, `transform`, `transformEffect`) leaves an absent
 * key absent. Anything else may act on the absence: a getter handed the `Option`
 * (`SchemaGetter.withDefault` beneath every `Schema.withDecodingDefault*`, a step onto an
 * `Option` as `Schema.OptionFromOptional`'s is, `SchemaGetter.required`), a middleware
 * (`Schema.middlewareDecoding`, `Schema.catchDecoding`), which is handed the read of the
 * missing key and can fill it or fail it, and any kind of step this doesn't know.
 */
const actsOnAbsentKey = (link: SchemaAST.Link): boolean => {
  const transformation = link.transformation as {
    readonly _tag: string
    readonly decode?: { readonly _tag?: string }
  }
  if (transformation._tag !== "Transformation") return true
  const step = transformation.decode?._tag
  return !(step === "Passthrough" || step === "Transform" || step === "TransformEffect")
}

/**
 * Whether the model's code may take part in reading a missing key through a node: a step
 * that may act on the absence ({@link actsOnAbsentKey}), anywhere on the way from the most
 * stored side up. A suspension is taken to: what it suspends isn't looked into here, so
 * only reading the absence says.
 */
const mayReadMissingKey = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isSuspend(ast) ||
  (ast.encoding ?? []).some((link) => actsOnAbsentKey(link) || mayReadMissingKey(link.to))

/**
 * Whether reading through a node runs nothing but Effect's own parsing: no check, no
 * transformation and no declaration of the model's own, anywhere in it. A check on the stored
 * side of a flipped schema (`encodingChecks`) runs on a read too.
 */
const runsNoCode = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST> = new Set()): boolean => {
  if (seen.has(ast)) return true
  seen.add(ast)
  if (
    ast.checks !== undefined ||
    ast.encoding !== undefined ||
    (ast as { readonly encodingChecks?: unknown }).encodingChecks !== undefined
  ) {
    return false
  }
  const all = (asts: ReadonlyArray<SchemaAST.AST>) => asts.every((part) => runsNoCode(part, seen))
  switch (ast._tag) {
    case "Declaration":
      return representationIdOf(ast) !== undefined && all(ast.typeParameters)
    case "Suspend":
      return runsNoCode(ast.thunk(), seen)
    case "Union":
      return all(ast.types)
    case "Arrays":
      return all([...ast.elements, ...ast.rest])
    case "Objects":
      return all([
        ...ast.propertySignatures.map((property) => property.type),
        ...ast.indexSignatures.flatMap((signature) => [signature.parameter, signature.type]),
      ])
    default:
      return true
  }
}

/**
 * How it's decided whether a stored row can be without a field and still be read.
 *
 * - `"allow"` and `"refuse"`: the schema says, and nothing it runs takes part. A required
 *   field can't be lacked. A field whose read side is an optional key can (`Schema.optional`,
 *   `Schema.optionalKey`, however its stored side is declared: a missing key reaches the read
 *   side as missing through every step that only maps a value), and so can a field whose
 *   absent attribute is one of its values (a `Schema.UndefinedOr`, a set) when reading it
 *   runs no check or transformation.
 * - `"decode"`: the model's own code takes part in reading the absence, so only reading it
 *   says. A decoding default, a step of one's own handed the absent key, a middleware or a
 *   suspension ({@link mayReadMissingKey}), any of which may fill the key, fail, or be
 *   refused by the field's check; or a check or transformation on the value an absent
 *   attribute stands for. The write that leaves the attribute out reads the absence once,
 *   as the next read would ({@link rowOmits}, {@link absentReading}).
 *
 * Answered from the schema alone, so defining an entity runs none of a model's code.
 */
export type LackDecision = "allow" | "refuse" | "decode"

export const lackDecision = (field: Schema.Top): LackDecision => {
  if (mayReadMissingKey(field.ast)) return "decode"
  if (SchemaAST.isOptional(field.ast)) return "allow"
  if (absentStored(field) === undefined) return "refuse"
  return runsNoCode(field.ast) ? "allow" : "decode"
}

/**
 * Whether a row without this field's key reads, by reading one: a decoding default, an
 * absent-key step or a middleware runs, and the field's checks see what that makes. Asked
 * by a write that leaves the key out of a row, once, and never while an entity is defined.
 * A default that can't run synchronously is taken at its word.
 */
const readsMissingKey = (field: Schema.Top): boolean => {
  const probe = Schema.Struct({ field }) as unknown as Schema.Codec<unknown, unknown>
  return !Exit.hasFails(Schema.decodeUnknownExit(probe)({}))
}

/**
 * Whether the field's key is one a stored row may leave out: optional fields
 * (`Schema.optional`, `Schema.optionalKey`, the `OptionFromOptional` family) and
 * a decoding default, whose value a read fills in.
 *
 * The schema answers where nothing it runs takes part: the missing key reaches the read
 * side as missing, so the read side's key says. Where the model's code may take part in
 * reading the missing key ({@link mayReadMissingKey}), the key is read for real, so this
 * belongs to a write and is never asked while an entity is defined.
 */
export const rowOmits = (field: Schema.Top): boolean =>
  mayReadMissingKey(field.ast) ? readsMissingKey(field) : SchemaAST.isOptional(field.ast)

/**
 * Whether what's stored for this can leave out a value that reads back all the same: a struct's
 * field ({@link absentStored}), or the set an `Option` holds as its value. An `undefined` there
 * reads as what it is without anything being done about it.
 */
export const holdsAbsentValue = (
  ast: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
): boolean => {
  const found = forced(ast, seen)
  if (found === undefined) return false
  const { node } = found
  const reading = (part: SchemaAST.AST) => absentStored(Schema.make<Schema.Top>(part))
  const within = (asts: ReadonlyArray<SchemaAST.AST>) =>
    asts.some((part) => holdsAbsentValue(part, found.seen))
  switch (node._tag) {
    case "Declaration":
      return (
        node.typeParameters.some((part) => reading(part)?.stored !== undefined) ||
        within(node.typeParameters)
      )
    case "Union":
      return within(node.types)
    case "Arrays":
      return within([...node.elements, ...node.rest])
    case "Objects": {
      const fields = node.propertySignatures.map((property) => property.type)
      return (
        fields.some((part) => reading(part) !== undefined) ||
        within([...fields, ...node.indexSignatures.map((signature) => signature.type)])
      )
    }
    default:
      return false
  }
}

/**
 * Whether a stored row can be without this field and still be read: its key may
 * be left out ({@link rowOmits}), or an absent attribute is one of its values
 * ({@link absentReading}). A required field cannot, nor can a `NullOr`, whose key
 * is required even though its value may be empty.
 *
 * Reads the absence where the model's code takes part in it ({@link lackDecision}), so
 * this belongs to a write and is never asked while an entity is defined.
 */
export const rowCanLack = (field: Schema.Top): boolean =>
  rowOmits(field) || absentReading(field) !== undefined

/** The verdict on a path, as far as a schema can tell. */
type PathVerdict = "required" | "open" | "absent"

const pathVerdict = (ast: SchemaAST.AST, segments: ReadonlyArray<string | number>): PathVerdict => {
  const head = segments[0]
  if (head === undefined) return "open"
  const rest = segments.slice(1)
  const below = (member: SchemaAST.AST, optional: boolean): PathVerdict =>
    rest.length > 0 ? pathVerdict(member, rest) : optional ? "open" : "required"
  if (SchemaAST.isSuspend(ast)) return pathVerdict(ast.thunk(), segments)
  if (SchemaAST.isUnion(ast)) {
    const verdicts = ast.types
      .map((member) => pathVerdict(member, segments))
      .filter((verdict) => verdict !== "absent")
    if (verdicts.length === 0) return "absent"
    return verdicts.every((verdict) => verdict === "required") ? "required" : "open"
  }
  if (SchemaAST.isObjects(ast)) {
    if (typeof head !== "string") return "absent"
    const property = ast.propertySignatures.find((signature) => signature.name === head)
    if (property !== undefined) {
      const lackable =
        SchemaAST.isOptional(property.type) ||
        absentReading(Schema.make<Schema.Top>(property.type)) !== undefined
      return below(property.type, lackable)
    }
    const index = ast.indexSignatures[0]
    return index === undefined ? "absent" : rest.length > 0 ? pathVerdict(index.type, rest) : "open"
  }
  if (SchemaAST.isArrays(ast)) {
    if (typeof head !== "number") return "absent"
    const element = ast.elements[head]
    if (element !== undefined && ast.rest.length === 0) {
      return below(element, SchemaAST.isOptional(element))
    }
    // A list closes up when an element is removed, so which element is gone
    // says nothing about the row; only what's below an element can be judged.
    const repeated = element ?? ast.rest[0]
    return repeated === undefined
      ? "absent"
      : rest.length > 0
        ? pathVerdict(repeated, rest)
        : "open"
  }
  return "absent"
}

/**
 * Whether removing `segments`, a path inside this field, leaves a value the
 * field's schema refuses: the last segment is a property (or a fixed tuple
 * element) the stored side requires.
 *
 * It walks the stored side of the schema, so a `Schema.Class` and a `ref`
 * field are seen through and a decoding default counts as optional. A union
 * is judged by the members that declare the property: a value holding it is
 * one of those. A property whose absent attribute is one of its values
 * ({@link absentReading}) is not required. `false` means the schema can't say the
 * row breaks: a record's keys, a list's elements, and anything opaque (a
 * `Schema.declare`, a set, a `.check()` such as a minimum length, which is a
 * verdict on the value and not its shape).
 */
export const pathIsRequired = (
  field: Schema.Top,
  segments: ReadonlyArray<string | number>,
): boolean => pathVerdict(SchemaAST.toEncoded(field.ast), segments) === "required"
