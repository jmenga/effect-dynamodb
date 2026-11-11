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
 * Whether a stored side holds a position no schema types (`Schema.Unknown`, `Schema.Any`), at any
 * depth: what's written there is the caller's value as given, so only a value can say whether
 * DynamoDB stores it (`internal/LostValues.ts`, `EDD-9161`). A declaration's type parameters count,
 * as `Schema.Option(Schema.Unknown)` holds its value as given.
 */
export const holdsUntyped = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST> = new Set()): boolean => {
  const encoding = ast.encoding
  if (encoding !== undefined) return holdsUntyped(encoding[encoding.length - 1]!.to, seen)
  const within = (asts: ReadonlyArray<SchemaAST.AST>) =>
    asts.some((part) => holdsUntyped(part, seen))
  switch (ast._tag) {
    case "Unknown":
    case "Any":
      return true
    case "Declaration":
      return within(ast.typeParameters)
    case "Suspend": {
      if (seen.has(ast)) return false
      seen.add(ast)
      return holdsUntyped(ast.thunk(), seen)
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

// ---------------------------------------------------------------------------
// The names a path's segments are stored under (#238)
// ---------------------------------------------------------------------------

/**
 * A struct that renames its keys as it's stored (`Schema.encodeKeys`): each property's stored
 * name, by its own, and the property each stored name holds.
 */
interface KeyRenames {
  readonly storedName: ReadonlyMap<string, string>
  readonly holding: ReadonlyMap<string, SchemaAST.PropertySignature>
}

const keyRenamesFound = new WeakMap<SchemaAST.Objects, KeyRenames | null>()

/**
 * The key renames of a struct `Schema.encodeKeys` built, seen by its shape alone: the struct's one
 * encoding step is a transformation of two plain functions, to a bare struct of as many
 * properties, whose `i`-th property holds `SchemaAST.toEncoded` of the struct's `i`-th (the very
 * node `encodeKeys` stores, optionality included), under the name it's stored by. `encodeKeys`
 * builds the stored struct property by property in the struct's own order, so the `i`-th stored
 * name is the `i`-th property's; a name JavaScript orders first as an array index (`"0"`) could
 * break that order, so a struct naming one isn't taken.
 *
 * Nothing the model wrote is run: the step's functions are never called. A struct of any other
 * shape (a transformation that defaults, drops or adds a key, stores a key optional the struct
 * requires, or anything else) is `undefined`, a node whose stored names aren't known, so a path
 * below it is sent as written and a removal below it isn't judged (#238). A transformation of
 * exactly that shape is read as the rename it has the shape of: a stored property is then the
 * encoded form of its own, so a removal of a key the stored struct requires leaves a row no read
 * decodes, whatever the functions do.
 */
const keyRenamesOf = (ast: SchemaAST.Objects): KeyRenames | undefined => {
  const found = keyRenamesFound.get(ast)
  if (found !== undefined) return found ?? undefined
  const renames = declaredKeyRenames(ast)
  keyRenamesFound.set(ast, renames ?? null)
  return renames
}

/** A name JavaScript lists before the others, as it does an array index. */
const INDEX_NAME = /^(?:0|[1-9]\d*)$/

const declaredKeyRenames = (ast: SchemaAST.Objects): KeyRenames | undefined => {
  const [link, ...more] = ast.encoding ?? []
  if (link === undefined || more.length > 0 || ast.indexSignatures.length > 0) return undefined
  const to = link.to
  if (!SchemaAST.isObjects(to) || !bare(to) || to.indexSignatures.length > 0) return undefined
  const step = link.transformation as {
    readonly _tag: string
    readonly encode?: { readonly _tag?: string }
    readonly decode?: { readonly _tag?: string }
  }
  if (
    step._tag !== "Transformation" ||
    step.encode?._tag !== "Transform" ||
    step.decode?._tag !== "Transform"
  ) {
    return undefined
  }
  const own = ast.propertySignatures
  const stored = to.propertySignatures
  if (own.length === 0 || own.length !== stored.length) return undefined
  const storedName = new Map<string, string>()
  const storedNames = new Set<string>()
  for (const [i, property] of own.entries()) {
    const held = stored[i]!
    if (typeof property.name !== "string" || typeof held.name !== "string") return undefined
    if (INDEX_NAME.test(property.name) || INDEX_NAME.test(held.name)) return undefined
    if (held.type !== SchemaAST.toEncoded(property.type)) return undefined
    if (storedNames.has(held.name)) return undefined
    storedNames.add(held.name)
    storedName.set(property.name, held.name)
  }
  return {
    storedName,
    holding: new Map(own.map((property) => [storedName.get(property.name as string)!, property])),
  }
}

/** Where a path segment leads from a node, by the name it's stored under. */
type NameStep =
  | {
      readonly _tag: "Named"
      readonly stored: string | number
      readonly next: ReadonlyArray<SchemaAST.AST>
    }
  /** The node holds nothing under the segment (a scalar, a struct without it). */
  | { readonly _tag: "Neutral" }
  /** The node isn't one this knows the stored names of. */
  | { readonly _tag: "Unknown" }

const NEUTRAL: NameStep = { _tag: "Neutral" }
const UNKNOWN: NameStep = { _tag: "Unknown" }

/** The nodes a value read through `ast` is read by: each member of a union, what a suspension holds. */
const namingNodes = (ast: SchemaAST.AST, into: Array<SchemaAST.AST>, seen: Set<SchemaAST.AST>) => {
  if (seen.has(ast)) return
  seen.add(ast)
  if (SchemaAST.isUnion(ast) && ast.encoding === undefined) {
    for (const member of ast.types) namingNodes(member, into, seen)
  } else if (SchemaAST.isSuspend(ast) && ast.encoding === undefined) {
    namingNodes(ast.thunk(), into, seen)
  } else {
    into.push(ast)
  }
}

const namingStep = (node: SchemaAST.AST, segment: string | number): NameStep => {
  if (SchemaAST.isDeclaration(node)) {
    // A `Schema.Class`: stored as the struct it's encoded to.
    const [link, ...more] = node.encoding ?? []
    const step = link?.transformation as
      | { readonly _tag: string; readonly decode?: { readonly _tag?: string } }
      | undefined
    if (
      link === undefined ||
      more.length > 0 ||
      !SchemaAST.isObjects(link.to) ||
      step?._tag !== "Transformation" ||
      step.decode?._tag !== "Transform"
    ) {
      return UNKNOWN
    }
    return namingStep(link.to, segment)
  }
  if (SchemaAST.isObjects(node)) {
    if (node.encoding === undefined) {
      if (typeof segment !== "string") return NEUTRAL
      const property = node.propertySignatures.find((signature) => signature.name === segment)
      if (property !== undefined) return { _tag: "Named", stored: segment, next: [property.type] }
      const reading: Array<SchemaAST.AST> = []
      for (const signature of node.indexSignatures) {
        if (!signatureKey(signature.parameter)) return UNKNOWN
        if (keyMatches(signature.parameter, segment)) reading.push(signature.type)
      }
      return reading.length > 0 ? { _tag: "Named", stored: segment, next: reading } : NEUTRAL
    }
    const renames = keyRenamesOf(node)
    if (renames === undefined) return UNKNOWN
    if (typeof segment !== "string") return NEUTRAL
    // A stored name is sent as it is, even one that's also another property's own name.
    const held = renames.holding.get(segment)
    if (held !== undefined) return { _tag: "Named", stored: segment, next: [held.type] }
    const stored = renames.storedName.get(segment)
    if (stored === undefined) return NEUTRAL
    const property = node.propertySignatures.find((signature) => signature.name === segment)!
    return { _tag: "Named", stored, next: [property.type] }
  }
  if (SchemaAST.isArrays(node)) {
    if (node.encoding !== undefined) return UNKNOWN
    if (typeof segment !== "number") return NEUTRAL
    if (node.rest.length > 1) return UNKNOWN
    const element = node.elements[segment] ?? node.rest[0]
    return element === undefined ? NEUTRAL : { _tag: "Named", stored: segment, next: [element] }
  }
  return SCALARS.has(node._tag) || node._tag === "Never" ? NEUTRAL : UNKNOWN
}

/**
 * The path below a field as it's stored (#238): each segment that is a property's own name, in a
 * struct that renames its keys as it's stored (`Schema.encodeKeys`), becomes the name it's stored
 * under, so a path names what `put` stored and a read takes. This is the one place that says how
 * a path below a field is named, for an update's path operations, a condition, a filter and a
 * projection alike.
 *
 * A segment that is a name a property is stored under is kept as it is, even where it's also
 * another property's own name: `encodeKeys({ a: "b", b: "a" })` stores property `b` under `a`, and
 * the segment `a` names what's stored under `a`, property `b`, as 1.40.0 named it. Every name that
 * reached a stored attribute before is unchanged.
 *
 * The walk follows unions (every member that holds the segment must name it alike), suspensions,
 * `Schema.Class` structs, records and lists. From a node it doesn't know the stored names of (any
 * other transformation, a declaration, `Schema.Unknown`), and where a union's members disagree,
 * the rest of the path is kept as it is, as it was before.
 */
export const storedSegments = (
  field: Schema.Top,
  segments: ReadonlyArray<string | number>,
): ReadonlyArray<string | number> => {
  let ways: ReadonlyArray<SchemaAST.AST> = [field.ast]
  const out: Array<string | number> = []
  for (const [i, segment] of segments.entries()) {
    const nodes: Array<SchemaAST.AST> = []
    const seen = new Set<SchemaAST.AST>()
    for (const way of ways) namingNodes(way, nodes, seen)
    let stored: string | number | undefined
    const next: Array<SchemaAST.AST> = []
    for (const node of nodes) {
      const step = namingStep(node, segment)
      if (step._tag === "Neutral") continue
      if (step._tag === "Unknown" || (stored !== undefined && stored !== step.stored)) {
        return [...out, ...segments.slice(i)]
      }
      stored = step.stored
      next.push(...step.next)
    }
    if (stored === undefined) return [...out, ...segments.slice(i)]
    out.push(stored)
    ways = next
  }
  return out
}

/**
 * The segments below a path's first, as a model of these fields stores them (#238): through the
 * schema of the field the first segment names ({@link storedSegments}), as written below a name
 * that is no field. The one way a model's path below its field is named: an entity's (beside its
 * sparse maps' entries) and an aggregate's root rows' alike.
 */
export const storedBelowFields =
  (fields: Readonly<Record<string, Schema.Top>> | undefined) =>
  (segments: ReadonlyArray<string | number>): ReadonlyArray<string | number> => {
    const head = segments[0]
    const rest = segments.slice(1)
    return rest.length > 0 &&
      typeof head === "string" &&
      fields !== undefined &&
      Object.hasOwn(fields, head)
      ? storedSegments(fields[head]!, rest)
      : rest
  }

/**
 * A struct that renames its keys as it's stored, as the guard models it (#238): a struct of the
 * same properties under their stored names. Reading one is reading the stored struct, then the
 * properties renamed, then the struct, which reads a property as this does under its stored name.
 */
const renamedViews = new WeakMap<SchemaAST.Objects, SchemaAST.Objects | null>()
/** The views {@link renamedStruct} built: a way through one is one 1.40.0 didn't judge. */
const isRenamedView = new WeakSet<SchemaAST.Objects>()

const renamedStruct = (ast: SchemaAST.Objects): SchemaAST.Objects | undefined => {
  const found = renamedViews.get(ast)
  if (found !== undefined) return found ?? undefined
  const renames =
    ast.checks === undefined &&
    (ast as { readonly encodingChecks?: unknown }).encodingChecks === undefined
      ? keyRenamesOf(ast)
      : undefined
  const view =
    renames === undefined
      ? undefined
      : new SchemaAST.Objects(
          ast.propertySignatures.map(
            (property) =>
              new SchemaAST.PropertySignature(
                renames.storedName.get(property.name as string)!,
                property.type,
              ),
          ),
          [],
        )
  if (view !== undefined) isRenamedView.add(view)
  renamedViews.set(ast, view ?? null)
  return view
}

/**
 * A node the removal guard models exactly as a read decodes it. A removal below a field is
 * refused only when the walk from the field to the removed property or position passes through
 * these alone; any other node makes the verdict unknown, and the removal is sent as 1.39.0 sent
 * it:
 *
 * - a struct: one or more fixed properties, and no index signature (`Schema.Struct({})` reads
 *   any value but `null` and `undefined`, so it isn't one);
 * - a record: no fixed property, and one or more index signatures, each keyed by plain
 *   `Schema.String` or by a template literal of plain strings and string literals
 *   ({@link signatureKey}). A key is read by every signature it matches, and one it matches none
 *   of isn't read at all;
 * - a list: an array, or a tuple whose rest, if it has one, is one element with nothing after it;
 * - a union, as each of its members;
 * - a scalar (`null`, `undefined`, a string, number, boolean, bigint or symbol, a literal, a
 *   unique symbol, an enum, a template literal), which holds no path;
 * - a `Schema.Class`, as its struct;
 * - a `Schema.suspend`, as what it suspends, looked at before it's unwrapped;
 * - a struct that renames its keys as it's stored (`Schema.encodeKeys`), as the struct of its
 *   properties under their stored names ({@link renamedStruct}). A path reaches the guard by the
 *   names it's sent with ({@link storedSegments}), so it judges what the request removes (#238).
 *   1.40.0 judged nothing below one, so where another clause of the update changes what a
 *   position's judgement reads, nothing below one is judged ({@link lengthsAlone}).
 *
 * Each only when it carries no transformation (a decoding default is one; a key rename is one but
 * for the struct above) and no check (`checks` or `encodingChecks`). A constructor default takes no
 * part in a read.
 * Anything else is unknown: `Schema.Unknown`, `Schema.Any`, a declaration, a record keyed by
 * anything else, a struct with an index signature, a tuple with elements after its rest, a
 * transformed or checked node, and any node kind this doesn't know.
 */
type Modelled =
  | { readonly _tag: "Struct"; readonly ast: SchemaAST.Objects }
  | { readonly _tag: "Record"; readonly signatures: ReadonlyArray<SchemaAST.IndexSignature> }
  | { readonly _tag: "List"; readonly ast: SchemaAST.Arrays }
  | { readonly _tag: "Union"; readonly members: ReadonlyArray<SchemaAST.AST> }
  | { readonly _tag: "Suspend"; readonly suspended: SchemaAST.AST }
  | { readonly _tag: "Scalar" }

const SCALARS: ReadonlySet<string> = new Set([
  "Null",
  "Undefined",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Literal",
  "UniqueSymbol",
  "Enum",
  "TemplateLiteral",
])

/** Whether a node carries nothing of its own a read runs: no transformation, no check. */
const bare = (ast: SchemaAST.AST): boolean =>
  ast.checks === undefined &&
  ast.encoding === undefined &&
  (ast as { readonly encodingChecks?: unknown }).encodingChecks === undefined

/**
 * Whether an index signature's key is one the guard reads keys by: plain `Schema.String`, or a
 * template literal whose parts are plain strings and string literals. Effect matches a key
 * against either as it decodes it, so {@link keyMatches} asks Effect.
 */
const signatureKey = (parameter: SchemaAST.AST): boolean => {
  if (!bare(parameter)) return false
  if (parameter._tag === "String") return true
  if (parameter._tag !== "TemplateLiteral") return false
  return parameter.parts.every(
    (part) =>
      bare(part) &&
      (part._tag === "String" || (part._tag === "Literal" && typeof part.literal === "string")),
  )
}

/** Whether a record reads `key` through a signature keyed by `parameter` ({@link signatureKey}). */
const keyMatches = (parameter: SchemaAST.AST, key: string): boolean =>
  parameter._tag === "String" || Schema.is(Schema.make<Schema.Top>(parameter))(key)

/** What the guard models a node as ({@link Modelled}), or `undefined` for one it doesn't. */
const modelled = (ast: SchemaAST.AST): Modelled | undefined => {
  if (SchemaAST.isDeclaration(ast)) return classStruct(ast)
  if (SchemaAST.isObjects(ast) && ast.encoding !== undefined) {
    const view = renamedStruct(ast)
    return view === undefined ? undefined : { _tag: "Struct", ast: view }
  }
  if (!bare(ast)) return undefined
  switch (ast._tag) {
    case "Objects": {
      if (ast.indexSignatures.length === 0) {
        return ast.propertySignatures.length > 0 ? { _tag: "Struct", ast } : undefined
      }
      return ast.propertySignatures.length === 0 &&
        ast.indexSignatures.every((signature) => signatureKey(signature.parameter))
        ? { _tag: "Record", signatures: ast.indexSignatures }
        : undefined
    }
    case "Arrays":
      return ast.rest.length <= 1 ? { _tag: "List", ast } : undefined
    case "Union":
      return { _tag: "Union", members: ast.types }
    case "Suspend":
      return { _tag: "Suspend", suspended: ast.thunk() }
    default:
      return SCALARS.has(ast._tag) ? { _tag: "Scalar" } : undefined
  }
}

/**
 * A `Schema.Class`, as its struct: a declaration read by reading a struct and making an instance
 * of what that gives, with one step that only maps the value, and no check of its own.
 */
const classStruct = (ast: SchemaAST.Declaration): Modelled | undefined => {
  const [link, ...more] = ast.encoding ?? []
  if (link === undefined || more.length > 0) return undefined
  if (ast.checks !== undefined || ast.encodingChecks !== undefined) return undefined
  const transformation = link.transformation as {
    readonly _tag: string
    readonly decode?: { readonly _tag?: string }
  }
  if (transformation._tag !== "Transformation" || transformation.decode?._tag !== "Transform") {
    return undefined
  }
  const struct = modelled(link.to)
  return struct?._tag === "Struct" ? struct : undefined
}

/**
 * The annotation on a field a read takes an absent attribute of as the value that absence stands
 * for (a `Schema.UndefinedOr`'s `undefined`, `EntitySchemas`' `readingAbsent`): the field as it reads
 * a stored value. The default the read adds runs only where the attribute is absent, so a value
 * written there is read as this field alone.
 */
export const ReadsAbsentAs: unique symbol = Symbol.for("effect-dynamodb/ReadsAbsentAs")

/** A node as it reads a stored value: under the read's default for an absent attribute, the field. */
const asStored = (ast: SchemaAST.AST): SchemaAST.AST => {
  const field = (SchemaAST.resolve(ast) as Record<symbol, unknown> | undefined)?.[ReadsAbsentAs]
  return typeof field === "object" && field !== null ? (field as SchemaAST.AST) : ast
}

/**
 * Where a value can be at the end of a path, one entry per way through the schema to it:
 *
 * - `At`: a modelled node, a value of which is there;
 * - `Unread`: a struct without the path's next property, or a record none of whose signatures
 *   reads the path's next key, which doesn't read what a value holds under it, so it may read
 *   whatever a removal there leaves;
 * - `Unknown`: the way passed a node the guard doesn't model.
 *
 * A way the path can't take (a property of a list or a scalar, a position of a struct, a position
 * past a tuple's last) has no entry: a value there that held the path isn't one this reads, and
 * DynamoDB refuses the removal on one that doesn't.
 */
type End =
  | { readonly _tag: "At"; readonly node: Modelled }
  | { readonly _tag: "Unread" }
  | { readonly _tag: "Unknown" }

/**
 * One way through the schema to the end of a path: its {@link End}, and the struct it passed at
 * each depth (`structs[j]` reads the map holding the path's segment `j`; `undefined` where the
 * way passed a record or a list there). A removal leaves every property beside the path as it
 * was, so a struct on another way that requires one of them, of a type nothing this way holds
 * there can be, refuses what the removal leaves ({@link besideDisjoint}).
 */
type Way = {
  readonly end: End
  readonly structs: ReadonlyArray<SchemaAST.Objects | undefined>
  /**
   * Whether the way passed a node 1.40.0 didn't model (a record with several index signatures, or
   * a key that's a template literal; a struct that renames its keys as they're stored), which
   * 1.40.0 judged nothing below ({@link lengthsAlone}).
   */
  readonly since140?: true
}

/** Whether 1.40.0 modelled a record: one index signature, keyed by plain `Schema.String`. */
const recordOf140 = (signatures: ReadonlyArray<SchemaAST.IndexSignature>): boolean =>
  signatures.length === 1 && signatures[0]!.parameter._tag === "String"

const waysOf = (
  ast: SchemaAST.AST,
  segments: ReadonlyArray<string | number>,
  ways: Array<Way>,
  structs: ReadonlyArray<SchemaAST.Objects | undefined> = [],
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
  since140?: true,
): void => {
  const node = seen.has(ast) ? undefined : modelled(ast)
  const mark = since140 === undefined ? {} : { since140 }
  if (node === undefined) {
    ways.push({ end: { _tag: "Unknown" }, structs, ...mark })
    return
  }
  if (node._tag === "Union" || node._tag === "Suspend") {
    const within = new Set(seen).add(ast)
    for (const member of node._tag === "Union" ? node.members : [node.suspended]) {
      waysOf(member, segments, ways, structs, within, since140)
    }
    return
  }
  const here = [...structs, node._tag === "Struct" ? node.ast : undefined]
  const [head, ...rest] = segments
  if (head === undefined) {
    ways.push({ end: { _tag: "At", node }, structs: here, ...mark })
    return
  }
  if (node._tag === "Struct" && typeof head === "string") {
    // A struct renaming its keys as it's stored, which 1.40.0 didn't model (#238).
    const struct = isRenamedView.has(node.ast) ? true : since140
    const property = node.ast.propertySignatures.find((signature) => signature.name === head)
    if (property === undefined) {
      ways.push({
        end: { _tag: "Unread" },
        structs: here,
        ...(struct === undefined ? {} : { since140: struct }),
      })
    } else waysOf(property.type, rest, ways, here, new Set(), struct)
  } else if (node._tag === "Record" && typeof head === "string") {
    // A key every matching signature reads: each is a way, and a value there is one all of them
    // read, so a removal any of them refuses leaves a row the record refuses. Judging them as
    // alternatives asks more than that, never less.
    const record = recordOf140(node.signatures) ? since140 : true
    const reading = node.signatures.filter((signature) => keyMatches(signature.parameter, head))
    if (reading.length === 0) {
      ways.push({
        end: { _tag: "Unread" },
        structs: here,
        ...(record === undefined ? {} : { since140: record }),
      })
    }
    for (const signature of reading) waysOf(signature.type, rest, ways, here, new Set(), record)
  } else if (node._tag === "List" && typeof head === "number") {
    const element = node.ast.elements[head] ?? node.ast.rest[0]
    if (element !== undefined) waysOf(element, rest, ways, here, new Set(), since140)
  }
}

/**
 * What a stored value read through a node can be, by kind, and for a kind a literal or an enum
 * names, which values: `"any"` for a node whose stored form this doesn't know (a transformation,
 * a declaration other than a `Schema.Class`, `Schema.Unknown`, a struct with nothing in it). A
 * check only narrows what a node reads, so it's left out: what's here is never less than what
 * the node reads. A bigint is stored as a number and read back as one or the other.
 */
type Domain = "any" | ReadonlyMap<string, "any" | ReadonlySet<unknown>>

const domainOf = (ast: SchemaAST.AST, seen: ReadonlySet<SchemaAST.AST> = new Set()): Domain => {
  if (seen.has(ast)) return "any"
  const of = (...entries: ReadonlyArray<readonly [string, "any" | ReadonlySet<unknown>]>) =>
    new Map(entries)
  if (SchemaAST.isDeclaration(ast))
    return classStruct(ast) === undefined ? "any" : of(["map", "any"])
  if (ast.encoding !== undefined) return "any"
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return of(["string", "any"])
    case "Number":
      return of(["number", "any"])
    case "Boolean":
      return of(["boolean", "any"])
    case "Null":
      return of(["null", "any"])
    case "Undefined":
      return of(["undefined", "any"])
    case "BigInt":
      return of(["number", "any"], ["bigint", "any"])
    case "Never":
      return of()
    case "Literal": {
      const literal = ast.literal
      if (typeof literal === "bigint") return of(["number", "any"], ["bigint", "any"])
      return of([typeof literal, new Set([literal])])
    }
    case "Enum": {
      const values = new Map<string, Set<unknown>>()
      for (const [, value] of ast.enums) {
        const kind = typeof value
        values.set(kind, (values.get(kind) ?? new Set()).add(value))
      }
      return values
    }
    case "Arrays":
      return of(["list", "any"])
    case "Objects":
      return ast.propertySignatures.length > 0 || ast.indexSignatures.length > 0
        ? of(["map", "any"])
        : "any"
    case "Union": {
      const within = new Set(seen).add(ast)
      const merged = new Map<string, "any" | Set<unknown>>()
      for (const member of ast.types) {
        const domain = domainOf(member, within)
        if (domain === "any") return "any"
        for (const [kind, values] of domain) {
          const held = merged.get(kind)
          if (held === "any" || values === "any") merged.set(kind, "any")
          else merged.set(kind, new Set([...(held ?? []), ...values]))
        }
      }
      return merged
    }
    case "Suspend":
      return domainOf(ast.thunk(), new Set(seen).add(ast))
    default:
      return "any"
  }
}

/** Whether no stored value two nodes read can be the same ({@link domainOf}). */
const disjoint = (a: SchemaAST.AST, b: SchemaAST.AST): boolean => {
  const left = domainOf(a)
  const right = domainOf(b)
  if (left === "any" || right === "any") return false
  for (const [kind, values] of left) {
    const other = right.get(kind)
    if (other === undefined) continue
    if (values === "any" || other === "any") return false
    for (const value of values) if (other.has(value)) return false
  }
  return true
}

/**
 * Whether a struct on `target`'s way refuses every map a value on `source`'s way leaves beside
 * the path: at some depth both ways pass a struct declaring a property other than the path's,
 * of types no stored value can be both of ({@link disjoint}), where either `source`'s value always
 * holds it or `target`'s can't read a map without it ({@link rowCanLack}). A tag (`kind: "a"`
 * against `kind: "b"`) is one. A removal changes nothing beside the path, so such a map is still
 * there afterwards.
 */
const besideDisjoint = (
  source: Way,
  target: Way,
  segments: ReadonlyArray<string | number>,
): boolean =>
  target.structs.some((struct, depth) => {
    const from = source.structs[depth]
    if (struct === undefined || from === undefined) return false
    return struct.propertySignatures.some((property) => {
      if (property.name === segments[depth]) return false
      const held = from.propertySignatures.find((signature) => signature.name === property.name)
      return (
        held !== undefined &&
        disjoint(held.type, property.type) &&
        (!rowCanLack(Schema.make<Schema.Top>(held.type)) ||
          !rowCanLack(Schema.make<Schema.Top>(property.type)))
      )
    })
  })

/**
 * The verdict on removing a property or a list position below a field:
 *
 * - `required`: no value the field reads, that holds what's above it, reads after the removal;
 * - `readable`: one may, or one without it is left as it was;
 * - `unheld`: no value holds what's above it, so DynamoDB refuses the removal;
 * - `unknown`: the walk passed a node the guard doesn't model ({@link Modelled}).
 */
type Removal = "required" | "readable" | "unheld" | "unknown"

/**
 * Removing a property `name` from the maps at the ends of `ways`. A struct requires it when a row
 * can't be without it ({@link rowCanLack}, asked of the property as of a field). A record never
 * does, and a struct without it holds no such value, so removing it leaves the value as it was.
 * Lists and scalars hold no property, so a value of theirs that held one isn't one this reads.
 * Every way that holds the path is also one that reads what's left, so a struct requiring the
 * property on every such way is a refusal by each of them.
 */
const propertyRemoval = (ways: ReadonlyArray<Way>, name: string): Removal => {
  if (ways.some(({ end }) => end._tag === "Unknown")) return "unknown"
  let held = false
  for (const { end } of ways) {
    if (end._tag === "Unread") return "readable"
    if (end._tag !== "At") continue
    const { node } = end
    if (node._tag === "Record") return "readable"
    if (node._tag !== "Struct") continue
    const property = node.ast.propertySignatures.find((signature) => signature.name === name)
    if (property === undefined || rowCanLack(Schema.make<Schema.Top>(property.type))) {
      return "readable"
    }
    held = true
  }
  return held ? "required" : "unheld"
}

type ListWay = Way & { readonly list: SchemaAST.Arrays }

/** The lengths a list accepts: from its required positions to all of them, or on with a rest. */
const lengthsOf = (list: SchemaAST.Arrays): { readonly min: number; readonly max: number } => ({
  min: list.elements.filter((element) => !SchemaAST.isOptional(element)).length,
  max: list.rest.length > 0 ? Number.POSITIVE_INFINITY : list.elements.length,
})

/** The element a list reads at `position`, or `undefined` past its last. */
const elementAt = (list: SchemaAST.Arrays, position: number): SchemaAST.AST | undefined =>
  list.elements[position] ?? list.rest[0]

/**
 * Whether `target`'s list refuses every list one shorter that removing `position` leaves of a
 * list `source`'s holds: for each length `source`'s takes, either `target`'s doesn't take one
 * shorter, or somewhere what's left puts an element where `target`'s reads nothing it can be
 * ({@link disjoint}) — before `position` the element that was there, from it on the one after.
 * Lengths past both lists' fixed positions repeat what the last of them shows, so the lengths
 * are taken up to there.
 */
const listRefuses = (source: SchemaAST.Arrays, target: SchemaAST.Arrays, position: number) => {
  const from = lengthsOf(source)
  const to = lengthsOf(target)
  const last = Math.min(
    from.max,
    Math.max(from.min, Math.max(source.elements.length, target.elements.length) + 2),
  )
  for (let length = from.min; length <= last; length++) {
    if (length - 1 < to.min || length - 1 > to.max) continue
    let refused = false
    for (let i = 0; i < length - 1 && !refused; i++) {
      const held = elementAt(source, i < position ? i : i + 1)
      const read = elementAt(target, i)
      refused = held !== undefined && read !== undefined && disjoint(held, read)
    }
    if (!refused) return false
  }
  return true
}

/**
 * Removing list position `position` from the lists at the ends of `ways`. A list closes up when
 * an element is removed, so what's left is one shorter, read by every way to there. Readable when
 * some list may be too short to hold the position (DynamoDB leaves it as it was). Otherwise each
 * list a value is held by is paired with each that may read what's left: the pair refuses when
 * the reading list refuses it ({@link listRefuses}: its lengths, and its elements against the
 * ones that moved) or a struct on the reading way refuses what's beside the path
 * ({@link besideDisjoint}). Required when every pair refuses. An element that can fill a missing
 * one ({@link mayReadMissingKey}) makes the lengths unknown. Structs, records and scalars hold no
 * list, so a value of theirs that held one isn't one this reads, and they read no list that's
 * left.
 */
const positionRemoval = (
  ways: ReadonlyArray<Way>,
  position: number,
  segments: ReadonlyArray<string | number>,
): Removal => {
  if (ways.some(({ end }) => end._tag === "Unknown")) return "unknown"
  if (ways.some(({ end }) => end._tag === "Unread")) return "readable"
  const lists: Array<ListWay> = []
  for (const way of ways) {
    if (way.end._tag !== "At" || way.end.node._tag !== "List") continue
    const list = way.end.node.ast
    if (list.elements.some((element) => mayReadMissingKey(element))) return "unknown"
    lists.push({ ...way, list })
  }
  if (lists.length === 0) return "unheld"
  if (lists.some(({ list }) => lengthsOf(list).min <= position)) return "readable"
  const refused = lists.every((source) =>
    lists.every(
      (target) =>
        listRefuses(source.list, target.list, position) || besideDisjoint(source, target, segments),
    ),
  )
  return refused ? "required" : "readable"
}

/**
 * Removing list position `position` as 1.40.0 judged it, by the lists' lengths alone: required
 * when no list one shorter than a length some list takes is a length some list takes. A way
 * through a record 1.40.0 didn't model is `unknown`, as it was. What this reads of the row is the
 * list's length, which an update's other clauses on the list change too, so this is only the
 * answer {@link pathIsRequired} gives where they make the full judgement's answer unknown: as
 * 1.40.0 answered.
 */
const lengthsAlone = (ways: ReadonlyArray<Way>, position: number): Removal => {
  if (ways.some(({ end, since140 }) => end._tag === "Unknown" || since140 === true)) {
    return "unknown"
  }
  if (ways.some(({ end }) => end._tag === "Unread")) return "readable"
  const lengths: Array<{ readonly min: number; readonly max: number }> = []
  for (const { end } of ways) {
    if (end._tag !== "At" || end.node._tag !== "List") continue
    if (end.node.ast.elements.some((element) => mayReadMissingKey(element))) return "unknown"
    lengths.push(lengthsOf(end.node.ast))
  }
  if (lengths.length === 0) return "unheld"
  if (lengths.some((list) => list.min <= position)) return "readable"
  const shorter = (list: { readonly min: number; readonly max: number }) =>
    lengths.some((other) => other.min <= list.max - 1 && list.min - 1 <= other.max)
  return lengths.some(shorter) ? "readable" : "required"
}

/**
 * Whether another clause of the same update, writing or removing `other` (a path inside the same
 * field, `[]` for all of it), changes what the judgement of removing list position `segments`
 * reads: the list itself (its length, its elements: `other` names another of its positions, or
 * something below one), what's beside the path where a struct holds it ({@link besideDisjoint}:
 * `other` names a sibling of a property on the way, or something below one), or the path itself
 * (`other` names it, a path above it or one below it, which DynamoDB refuses beside a removal).
 * Another element of a list further up isn't read.
 */
const touches = (
  other: ReadonlyArray<string | number>,
  segments: ReadonlyArray<string | number>,
  ways: ReadonlyArray<Way>,
): boolean => {
  const depth = segments.findIndex((segment, i) => i >= other.length || other[i] !== segment)
  if (depth === -1 || depth >= other.length) return true
  if (depth === segments.length - 1) return true
  if (typeof segments[depth] === "number") return false
  return ways.some(({ structs }) => structs[depth] !== undefined)
}

/**
 * Whether removing `segments`, a path inside this field, leaves a value the field's schema
 * refuses, for every value it reads that holds the path, while none that holds what's above it
 * is without it. Refused only when the walk from the field passes through nodes it models exactly
 * as a read decodes them ({@link Modelled}); `false` for anything else, and the removal is sent
 * as 1.39.0 sent it.
 *
 * The walk takes every way through the schema to the path, through unions at every level and
 * every index signature a key matches, so a value one member holds is judged against every
 * member: a struct member without a property on the way doesn't read what a value holds under it,
 * so it may read what's left, and the removal is sent. A property is required when a row can't be
 * without it ({@link rowCanLack}): a required key nothing fills, whose absent attribute isn't one
 * of its values. A list position is required when no list on any way reads what's left
 * ({@link positionRemoval}): removing any position of a `[string, string]`; `f[0]` of a
 * `[string, number?]`, which leaves the number where the string was; and `p[0]` where a tag
 * beside the list names the member holding it, `{ kind: "a", p: [string, string] }` against
 * `{ kind: "b", p: [string] }`. `f[0]` of a `[string, string?]`, either position of
 * `Union([[string, string], [string]])` and an array's element aren't.
 *
 * The removal is judged against the update as a whole. A list position's judgement reads the
 * row's list and what's beside the path, which the update's other clauses (`update.beside`) may
 * write or remove in the same request: `f.kind = "b"` beside the removal of `f.p[0]` above makes
 * what's left the other member's, and `f.p[2] = "third"` (DynamoDB appends past the end) leaves a
 * list as long as before. Where another clause changes what it reads ({@link touches}), the
 * position is judged as 1.40.0 judged it ({@link lengthsAlone}), and below a sparse map's entry,
 * which 1.40.0 didn't judge, not at all. A property's judgement reads nothing of the row, so
 * another clause leaves it as it is.
 *
 * `false` means the schema can't say every such row breaks: a record's keys, a list's elements,
 * a path no value holds (DynamoDB refuses it, as on 1.39.0), and anything the walk doesn't model.
 */
export const pathIsRequired = (
  field: Schema.Top,
  segments: ReadonlyArray<string | number>,
  update: {
    /**
     * What the update's other clauses write or remove inside the same field, each a path inside
     * it (`[]` for all of it).
     */
    readonly beside?: ReadonlyArray<ReadonlyArray<string | number>> | undefined
    /** Whether 1.40.0 judged this path at all: not below a sparse map's entry. */
    readonly judgedBefore?: boolean | undefined
  } = {},
): boolean => {
  const last = segments[segments.length - 1]
  if (last === undefined) return false
  const ways: Array<Way> = []
  waysOf(field.ast, segments.slice(0, -1), ways)
  // A property's verdict reads nothing of the row: no other clause changes it, short of one on
  // the path or above it, beside which DynamoDB refuses the removal.
  if (typeof last === "string") return propertyRemoval(ways, last) === "required"
  if (!(update.beside ?? []).some((other) => touches(other, segments, ways))) {
    return positionRemoval(ways, last, segments) === "required"
  }
  // Another clause changes what the judgement reads: answered as 1.40.0 answered (#238).
  return update.judgedBefore !== false && lengthsAlone(ways, last) === "required"
}

/**
 * What an update writes an operand of at a path below a field: a value (`pathSet`,
 * `pathIfNotExists`), or elements added to a list (`pathAppend`, `pathPrepend`, `.append()`).
 */
export type OperandKind = "value" | "elements"

/**
 * The ways a value written at the end of a path is read, through the nodes {@link modelled}
 * models, collected into `readers`; `false` once the walk meets anything it can't say exactly.
 *
 * The position itself is read by whatever node is there, transformed, checked or declared: it is
 * the read's own. Above it, each segment is taken as DynamoDB takes it:
 *
 * - a struct's property, declared on the struct. One it doesn't declare isn't read at all, so any
 *   value there reads, and neither can `__proto__` be judged. A struct that renames its keys as
 *   it's stored (`Schema.encodeKeys`) reads a property by its stored form first, and can't be said
 *   exactly;
 * - a record's value, under any key but `__proto__`, for a record of one signature keyed by
 *   `Schema.String` (any other record can't be said exactly);
 * - a list's element. Below the end, an element that is there: the tuple's at that position, or
 *   the rest's past them. At the end, DynamoDB writes past a list's last element at its end, so a
 *   position is known only where it lands on one reader whatever the length: a position every
 *   value holds, any position of an array, or one past the elements of a tuple holding nothing
 *   optional and a rest;
 * - a union's members and a suspension's schema, each as itself.
 *
 * A field whose absent attribute the read takes as the value it stands for (`Schema.UndefinedOr`)
 * is the field: that default runs only where nothing is stored ({@link ReadsAbsentAs}).
 *
 * A way the path can't take (a property of a list or a scalar, a position of a map) adds nothing:
 * DynamoDB refuses the write on such a value.
 */
const readersBelow = (
  declared: SchemaAST.AST,
  segments: ReadonlyArray<string | number>,
  readers: Array<SchemaAST.AST>,
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
): boolean => {
  const ast = asStored(declared)
  const [head, ...rest] = segments
  if (head === undefined) {
    readers.push(ast)
    return true
  }
  const node = seen.has(ast) ? undefined : modelled(ast)
  if (node === undefined) return false
  if (node._tag === "Union" || node._tag === "Suspend") {
    const within = new Set(seen).add(ast)
    return (node._tag === "Union" ? node.members : [node.suspended]).every((member) =>
      readersBelow(member, segments, readers, within),
    )
  }
  if (node._tag === "Struct") {
    if (typeof head !== "string") return true
    // A struct that renames its keys as it's stored reads each property by its stored form first,
    // which a reader of the property alone doesn't see (a `catchDecoding` reads what that refuses):
    // it can't be said exactly, as this walk never said it.
    if (isRenamedView.has(node.ast)) return false
    const property = node.ast.propertySignatures.find((signature) => signature.name === head)
    return property !== undefined && head !== "__proto__"
      ? readersBelow(property.type, rest, readers)
      : false
  }
  if (node._tag === "Record") {
    // Only the record this walk has always taken (one signature keyed by `Schema.String`): one of
    // several signatures, or keyed by a template literal, can't be said exactly.
    if (!recordOf140(node.signatures)) return false
    if (typeof head !== "string") return true
    return head === "__proto__" ? false : readersBelow(node.signatures[0]!.type, rest, readers)
  }
  if (node._tag === "List") {
    if (typeof head !== "number") return true
    const { elements, rest: tail } = node.ast
    const required = elements.filter((element) => !SchemaAST.isOptional(element)).length
    if (rest.length > 0 || head < required) {
      const element = elements[head] ?? (head >= elements.length ? tail[0] : undefined)
      return element === undefined ? true : readersBelow(element, rest, readers)
    }
    const element = required === elements.length && head >= elements.length ? tail[0] : undefined
    return element === undefined ? false : readersBelow(element, rest, readers)
  }
  return true
}

/**
 * The element reader of every list a value at the end of a path can be, through unions and
 * suspensions, collected into `readers`; `false` for a list that isn't one array (a tuple: where
 * added elements land depends on its length) or anything the walk doesn't model. A struct, a
 * record and a scalar add nothing: DynamoDB refuses to add elements to one.
 */
const elementReaders = (
  declared: SchemaAST.AST,
  readers: Array<SchemaAST.AST>,
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
): boolean => {
  const ast = asStored(declared)
  const node = seen.has(ast) ? undefined : modelled(ast)
  if (node === undefined) return false
  if (node._tag === "Union" || node._tag === "Suspend") {
    const within = new Set(seen).add(ast)
    return (node._tag === "Union" ? node.members : [node.suspended]).every((member) =>
      elementReaders(member, readers, within),
    )
  }
  // A record this walk never took (several signatures, a template literal key) can't be said.
  if (node._tag === "Record" && !recordOf140(node.signatures)) return false
  if (node._tag !== "List") return true
  const [element, ...more] = node.ast.rest
  if (node.ast.elements.length > 0 || element === undefined || more.length > 0) return false
  readers.push(element)
  return true
}

/**
 * What reads an operand an update writes at `segments` below a field whose READ schema is
 * `field`: for a value, the node at that position, one for each way the schema has to it; for
 * elements, each array's element there. `undefined` when the walk can't say exactly, or no value
 * holds the position (DynamoDB refuses such a write): the operand is then judged as 1.39.0
 * judged it.
 *
 * A row reads only where a reader reads what's written, so an operand none of them reads is one
 * no row holding it reads ({@link modelled} lists what the walk passes through; the rest is
 * `undefined`). An operand one of them reads may still be wrong for the member a row holds, as
 * it always was.
 */
export const readersAt = (
  field: Schema.Top,
  segments: ReadonlyArray<string | number>,
  kind: OperandKind,
): ReadonlyArray<SchemaAST.AST> | undefined => {
  const at: Array<SchemaAST.AST> = []
  if (!readersBelow(field.ast, segments, at)) return undefined
  const readers: Array<SchemaAST.AST> = []
  if (kind === "value") readers.push(...at)
  else if (!at.every((node) => elementReaders(node, readers))) return undefined
  const distinct = [...new Set(readers)]
  return distinct.length === 0 ? undefined : distinct
}
