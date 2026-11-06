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
const getSchemaProp = (schema: Schema.Top, prop: "schema" | "value"): Schema.Top | undefined => {
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

/** Whether an AST is a `Schema.ReadonlySet`, by the id Effect gives its representation. */
export const isSetDeclaration = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Declaration" &&
  (
    (ast.annotations as Record<string, unknown> | undefined)?.representation as
      | { readonly id?: unknown }
      | undefined
  )?.id === READONLY_SET

/** Whether a schema's stored side is a set, or a union with one. */
export const storesSet = (schema: Schema.Top): boolean => {
  const encoded = SchemaAST.toEncoded(schema.ast)
  return SchemaAST.isUnion(encoded)
    ? encoded.types.some((member) => isSetDeclaration(member))
    : isSetDeclaration(encoded)
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
 * The one rule for values with no stored form. DynamoDB can't store `undefined`
 * or an empty set, so on a field whose stored side includes one the value is an
 * absent attribute, and an absent attribute reads back as that value. Returns
 * what it reads back as, or `undefined` when the rule doesn't apply: the field's
 * key is optional, so absent reads as absent (or as its decoding default); or
 * its schema refuses the value, as a `.check()` for a non-empty set does, so no
 * row may be without it.
 *
 * The check decodes for real. A transformation that can't run synchronously is
 * taken at its word, reading back as the stored value.
 */
export const absentReading = (field: Schema.Top): AbsentReading | undefined => {
  const encoded = SchemaAST.toEncoded(field.ast)
  if (SchemaAST.isOptional(encoded)) return undefined
  const found = valueWithNoStoredForm(encoded)
  if (found === undefined) return undefined
  const decoded = Schema.decodeUnknownExit(field as unknown as Schema.Codec<unknown, unknown>)(
    found.stored,
  )
  if (Exit.hasFails(decoded)) return undefined
  return { stored: found.stored, value: Exit.isSuccess(decoded) ? decoded.value : found.stored }
}

/**
 * Whether the field's key is one a stored row may leave out: optional fields
 * (`Schema.optional`, `Schema.optionalKey`, the `OptionFromOptional` family) and
 * a decoding default, whose value a read fills in.
 *
 * The stored side's optionality rules most fields out without running anything;
 * what is left is decoded for real, because a transformation may still refuse
 * the missing key. A default that cannot run synchronously is taken at its word.
 */
export const rowOmits = (field: Schema.Top): boolean => {
  if (!SchemaAST.isOptional(SchemaAST.toEncoded(field.ast))) return false
  const probe = Schema.Struct({ field }) as unknown as Schema.Codec<unknown, unknown>
  return !Exit.hasFails(Schema.decodeUnknownExit(probe)({}))
}

/**
 * Whether a stored row can be without this field and still be read: its key may
 * be left out ({@link rowOmits}), or an absent attribute is one of its values
 * ({@link absentReading}). A required field cannot, nor can a `NullOr`, whose key
 * is required even though its value may be empty.
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
