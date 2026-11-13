/**
 * Looking a name up on an object the library builds or reads a definition from (#239).
 *
 * A name a definition or a payload supplies (a field, a path segment, an edge, a timestamp, the
 * version) can be one every object inherits: `constructor`, `toString`, `valueOf`,
 * `hasOwnProperty`, `__proto__`. On a plain object, `record[name]` and `name in record` then find
 * `Object.prototype`'s member, and `record[name] = value` under `__proto__` replaces the object's
 * prototype instead of holding the value. So the library's own maps (definition maps, encoded
 * payloads, unmarshalled rows, a schema's fields) are read with {@link ownValue} /
 * {@link hasOwnName} and written with {@link setOwn}.
 *
 * A caller's object is not read this way. Where the library reads it itself (a key's composites, a
 * condition's or an update operand's record, `.within()` bounds, an aggregate's ids) it is read as
 * 1.40.0 read it, `value[name]`: a getter, a class property, a prototype or a proxy answers, and a
 * function there is given as 1.40.0 read it, but for a member every object inherits under a name
 * `Object.prototype` holds (`constructor`, `toString`), which is never a value given (see
 * {@link given}). A read that throws for a name the object doesn't hold is no value. A payload a
 * schema decodes goes to Effect's parser as given, or as 1.40.0 copied it where the library adds to
 * it first (a decoding default, a stamp, a fetched ref, a geo index's cells), and what the parser
 * reads of it is the parser's to decide: under Effect 4.1.3, a declared name `Object.prototype`
 * holds too only as the payload's own property.
 */

import { Data, type Schema, SchemaAST } from "effect"

/** Whether `record` holds `name` itself, not by inheritance. */
export const hasOwnName = (record: object | undefined, name: PropertyKey): boolean =>
  record !== undefined && Object.hasOwn(record, name)

/**
 * What `record` holds under `name` itself, `undefined` where it holds nothing there. Never a member
 * every object inherits: a field named `constructor` that a map doesn't hold is not one.
 */
export const ownValue = <A>(
  record: Readonly<Record<string, A>> | undefined,
  name: PropertyKey,
): A | undefined =>
  record !== undefined && Object.hasOwn(record, name) ? record[name as string] : undefined

/**
 * Why an attribute or a map entry named `__proto__` is refused (`EDD-9165`). The AWS SDK's
 * marshaller assigns each attribute and entry to a plain object, and an assignment to `__proto__`
 * sets that object's prototype instead, so it was never sent; stored by an update, every read drops
 * it the same way, as its unmarshaller assigns too.
 */
export const PROTO_ENTRY =
  'an attribute or a map entry named "__proto__" is lost: the AWS SDK\'s marshaller and ' +
  "unmarshaller assign each to a plain object, and assigning that name sets the object's " +
  "prototype instead, so it is never sent, and one stored otherwise is never read back. Name it " +
  "otherwise."

/**
 * Stores `value` under `name` as `record`'s own property. Assignment does that for every name but
 * `__proto__`, where it would replace the prototype instead (or do nothing, for a value that isn't
 * an object), so that one name is defined.
 */
export const setOwn = <A>(record: Record<string, A>, name: string, value: A): void => {
  if (name === "__proto__") {
    Object.defineProperty(record, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  } else record[name] = value
}

/**
 * A caller's object threw when `field` was read from it, a name it doesn't hold itself but holds
 * by inheritance (a getter of its class, say), read because the entity, aggregate or stream it was
 * given to declares that name. Thrown where the read is, and failed with a `ValidationError` naming
 * the field by the operation it was given to, never a defect (`Capacity.isRefusedValue`). Where the
 * read is made for a key handed on (a geo search's filter), the error stands in the copy for the
 * value, and the search fails with it when it reads it ({@link lackedByName}'s `keep`).
 *
 * Recognised by identity alone ({@link isUnreadableName}): only an error this module made is one.
 * A caller's value carrying the same tag and fields (a stored map compared in a condition) is a
 * value like any other.
 */
export class UnreadableName extends Data.TaggedError("UnreadableName")<{
  readonly field: string
  readonly thrown: unknown
  readonly message: string
}> {}

/** Every {@link UnreadableName} this module made: what {@link isUnreadableName} recognises. */
const made = new WeakSet<object>()

/** Is `u` an {@link UnreadableName} this module made? By identity, never by its tag or fields. */
export const isUnreadableName = (u: unknown): u is UnreadableName =>
  typeof u === "object" && u !== null && made.has(u)

const unreadable = (field: PropertyKey, thrown: unknown): UnreadableName => {
  const error = new UnreadableName({
    field: String(field),
    thrown,
    message:
      `Reading "${String(field)}" from the object given threw: ` +
      `${thrown instanceof Error ? thrown.message : String(thrown)}. The object doesn't hold ` +
      `"${String(field)}" itself but answers for it by inheritance (a getter of its class, a ` +
      `prototype, a proxy), and it is a name the value is read for.`,
  })
  made.add(error)
  return error
}

/** Whether `u` is an object or a function: what `Object.hasOwn` and `in` take. */
const isObject = (u: unknown): u is object =>
  (typeof u === "object" && u !== null) || typeof u === "function"

/** Whether `name` is `in` `payload`, as 1.40.0 asked it; a proxy whose `has` trap throws holds nothing. */
const holds = (payload: object, name: PropertyKey): boolean => {
  try {
    return name in payload
  } catch {
    return false
  }
}

/**
 * `payload[name]`, read as 1.40.0 read it: one read (one `get` of a proxy). A read that throws from
 * the payload's own getter propagates, as on 1.40.0. One that throws for a name the payload doesn't
 * hold at all (a strict proxy, throwing for every name it doesn't know) is no value, so such an
 * object is read as a plain one; one that throws for a name it holds by inheritance (a getter of
 * its class) is an {@link UnreadableName}.
 */
const read = (payload: object, name: PropertyKey): unknown => {
  try {
    return (payload as Record<PropertyKey, unknown>)[name]
  } catch (thrown) {
    if (Object.hasOwn(payload, name)) throw thrown
    if (!holds(payload, name)) return undefined
    throw unreadable(name, thrown)
  }
}

/**
 * Whether `value`, read from a caller's object under `name`, is what every plain object inherits
 * under that name: `Object.prototype`'s own member (`constructor`, `toString`, `valueOf`, …), or,
 * under `__proto__`, `Object.prototype` itself. Judged on the value read alone, by identity: a
 * class's `constructor` or its own `toString` is a value as 1.40.0 read it.
 */
const isObjectPrototypeMember = (name: PropertyKey, value: unknown): boolean =>
  name === "__proto__"
    ? value === Object.prototype
    : typeof value === "function" &&
      Object.hasOwn(Object.prototype, name) &&
      value === (Object.prototype as unknown as Record<PropertyKey, unknown>)[name]

/**
 * What a caller's payload gives under `name`, where the library reads it itself (a key's
 * composites, an aggregate's ids and edges, `.within()` bounds' operators), read as 1.40.0 read it
 * (`payload[name]`, one read, one `get` of a proxy): its own property, one its class gives it (a
 * getter, a property of a prototype, a method), or one a proxy answers for, a function as much as
 * anything else. Reading its own property is as it always was (a throw from its own getter
 * propagates). A throw for a name it doesn't hold at all (a strict proxy) is no value; a throw from
 * a getter it inherits is an {@link UnreadableName}. The one value not given is what every plain
 * object inherits under the name ({@link isObjectPrototypeMember}: `Object.prototype.toString`
 * under `toString`, `Object.prototype` under `__proto__`), which 1.40.0 took for a value of a field
 * so named: such a name reads as absent. Only where the value read is that member is the payload
 * asked anything more, whether it holds the name itself (`Object.hasOwn`): where it does, the value
 * is given.
 */
export const given = (payload: object, name: PropertyKey): unknown => {
  // Anything but an object is read as 1.40.0 read it: `undefined` and `null` throw its TypeError.
  if (!isObject(payload)) return (payload as Record<PropertyKey, unknown>)[name]
  const value = read(payload, name)
  return isObjectPrototypeMember(name, value) && !Object.hasOwn(payload, name) ? undefined : value
}

/**
 * {@link given}, but never a function: where 1.40.0 took no function for a value (an aggregate's
 * ids, `many` lists and sub-aggregates), and where the library reads a name 1.40.0 didn't read at
 * all (a key composite its own entries lack, {@link keyEntries}), so a method of the payload's
 * class is no value there.
 */
export const givenData = (payload: object, name: PropertyKey): unknown => {
  const value = given(payload, name)
  return typeof value === "function" ? undefined : value
}

/**
 * What a caller's payload gives under `name`, where 1.40.0 asked `name in payload` and then read
 * `payload[name]`: `{ value }` where it holds the name (as it asked, but never what every plain
 * object inherits under it, {@link given}), `undefined` where it doesn't. Asked and read as 1.40.0
 * asked and read it, once each.
 */
export const givenEntry = (
  payload: object,
  name: PropertyKey,
): { readonly value: unknown } | undefined => {
  // Anything but an object is asked as 1.40.0 asked it, `name in payload`: a TypeError.
  if (!isObject(payload)) {
    const asked = payload as object
    return name in asked ? { value: (asked as Record<PropertyKey, unknown>)[name] } : undefined
  }
  if (!holds(payload, name)) return undefined
  const value = read(payload, name)
  return isObjectPrototypeMember(name, value) && !Object.hasOwn(payload, name)
    ? undefined
    : { value }
}

/** Whether a caller's payload gives `name` ({@link givenEntry}), reading it once. */
export const givesName = (payload: object, name: PropertyKey): boolean =>
  givenEntry(payload, name) !== undefined

/** Whether `u` is an object a caller gives as a record of names: an object, not an array. */
export const isRecordObject = (u: unknown): u is object =>
  typeof u === "object" && u !== null && !Array.isArray(u)

/**
 * A caller's key as a plain object, read as 1.40.0 read it (`Object.entries`): its own enumerable
 * properties, and nothing else of it, wherever they hold every one of `required` (the composites
 * the key can't be composed without). Only where they don't, where 1.40.0 failed ("Missing
 * composite attribute"), is each of `required` and `optional` they lack read by name
 * ({@link lackedByName}), so a key given by `Object.create`, a class with getters or a proxy is
 * read for its composites. `map` makes each value read the value held (a composite's key form).
 */
export const keyEntries = (
  payload: object,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
  map: (name: string, value: unknown) => unknown = (_name, value) => value,
): Record<string, unknown> => {
  const copy: Record<string, unknown> = {}
  const entries = Object.entries(payload)
  for (let index = 0; index < entries.length; index++) {
    const [name, value] = entries[index]!
    setOwn(copy, name, map(name, value))
  }
  return lacksAny(copy, required)
    ? lackedByName(payload, copy, [...required, ...optional], map)
    : copy
}

/** Whether `copy` lacks any of `names` as its own property. */
export const lacksAny = (copy: object, names: ReadonlyArray<string>): boolean =>
  names.some((name) => !Object.hasOwn(copy, name))

/**
 * `copy` (a copy of a caller's `payload`'s own properties), given each of `names` it lacks that the
 * payload gives otherwise, read by name ({@link givenData}: from a prototype, a class's getter or a
 * proxy, never a function there), `map`ped. Read only where 1.40.0 failed for the lack.
 *
 * With `keep`, a name whose read throws ({@link UnreadableName}) doesn't throw here: the copy holds a
 * property of that name that throws it again when it's read (a key handed on to a search, whose read
 * of it fails the search).
 */
export const lackedByName = (
  payload: object,
  copy: Record<string, unknown>,
  names: ReadonlyArray<string>,
  map: (name: string, value: unknown) => unknown = (_name, value) => value,
  keep?: "getter",
): Record<string, unknown> => {
  for (const name of names) {
    if (Object.hasOwn(copy, name)) continue
    let value: unknown
    try {
      value = givenData(payload, name)
    } catch (error) {
      if (keep === undefined || !isUnreadableName(error)) throw error
      Object.defineProperty(copy, name, {
        get: () => {
          throw error
        },
        enumerable: true,
        configurable: true,
      })
      continue
    }
    if (value !== undefined) setOwn(copy, name, map(name, value))
  }
  return copy
}

/**
 * A plain object holding what a value the library decoded gives (an aggregate's node, as Effect's
 * parser built it): its own enumerable properties, and each of `names` (the fields its schema
 * declares) it gives otherwise ({@link givenData}). Never a caller's object: the parser built it.
 */
export const declaredCopy = (value: object, names: Iterable<string>): Record<string, unknown> => {
  const copy: Record<string, unknown> = {}
  const entries = Object.entries(value)
  for (let index = 0; index < entries.length; index++) {
    const [name, held] = entries[index]!
    setOwn(copy, name, held)
  }
  for (const name of names) {
    if (Object.hasOwn(copy, name)) continue
    const held = givenData(value, name)
    if (held !== undefined) setOwn(copy, name, held)
  }
  return copy
}

/**
 * The class `value` is an instance of: the nearest of its prototypes holding a function as its own
 * `constructor` value, as `value.constructor` reads it for an instance. Never `value`'s own property
 * of that name, nor a prototype's that is no function or is a getter: either is a field of a payload
 * given by `Object.create` or by a class with getters, not the class, and is never read. `undefined`
 * for an object without a prototype.
 */
export const classOf = (value: object): { readonly name?: string } | undefined => {
  for (
    let prototype: unknown = Object.getPrototypeOf(value);
    prototype !== null && typeof prototype === "object";
    prototype = Object.getPrototypeOf(prototype)
  ) {
    const made = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
    if (typeof made === "function") return made as { readonly name?: string }
  }
  return undefined
}

/**
 * Whether every value of `stored` (an encoded form) stores something under its name, by a form
 * this code models exactly: text (`String`, a literal, a template literal, an enum), a number, a
 * boolean, a `bigint`, `null`, a map (a struct or a record, a class's encoded side among them), a
 * list (an array or a tuple), a suspended one followed, or a union of only such forms. A
 * transformation is judged by its encoded side, which Effect validates every encoded value
 * against. Anything else is not known to: `Schema.declare` and the declarations built on it
 * (`Option`, `Date`, a set), `Unknown`, `Any`, `Undefined`, `Void`, `Never`, a symbol, an object
 * keyword, a union with any of them, and a suspension that leads back to itself. A value of
 * those may encode to `undefined`, which the marshaller stores as nothing
 * (`removeUndefinedValues`).
 */
const storesAlways = (stored: SchemaAST.AST, suspended: ReadonlySet<SchemaAST.AST>): boolean => {
  if (SchemaAST.isOptional(stored)) return false
  if (
    SchemaAST.isString(stored) ||
    SchemaAST.isNumber(stored) ||
    SchemaAST.isBoolean(stored) ||
    SchemaAST.isBigInt(stored) ||
    SchemaAST.isLiteral(stored) ||
    SchemaAST.isTemplateLiteral(stored) ||
    SchemaAST.isEnum(stored) ||
    SchemaAST.isNull(stored) ||
    SchemaAST.isObjects(stored) ||
    SchemaAST.isArrays(stored)
  ) {
    return true
  }
  if (SchemaAST.isSuspend(stored)) {
    if (suspended.has(stored)) return false
    return storesAlways(SchemaAST.toEncoded(stored.thunk()), new Set([...suspended, stored]))
  }
  if (SchemaAST.isUnion(stored)) {
    return stored.types.every((member) => storesAlways(SchemaAST.toEncoded(member), suspended))
  }
  return false
}

/**
 * Whether every value of `ast` is certain to store something under its name: it is required, and
 * its stored (encoded) form is one this code models exactly with no value that stores nothing
 * ({@link storesAlways}). One that may be left out, may be `undefined` (`UndefinedOr`,
 * `NullishOr`, a decoding default), or isn't modelled exactly (`Schema.declare`, `Option`, a
 * union with such a member) lets a write store nothing there, as 1.40.0 stored it: a definition
 * naming `__proto__` there loads, and a write giving it a value is refused when it's sent.
 */
export const isRequiredStored = (ast: SchemaAST.AST): boolean =>
  storesAlways(SchemaAST.toEncoded(ast), new Set())

/**
 * The stored form of `ast` where every value stored there is certain to be a map: `ast` is
 * required, and its stored (encoded) form is a struct, a suspended one followed. `undefined` where
 * a value stored there may be no map, or may be no value at all: an optional or an `optionalKey`
 * position, a nullable one, a union (one alternative may be the struct, another not), a list or a
 * tuple (an empty one holds none), a record, text (`Schema.fromJsonString`), a declaration with no
 * encoding (`Schema.Option`).
 */
export const certainStruct = (
  ast: SchemaAST.AST,
  seen: Set<SchemaAST.AST> = new Set(),
): SchemaAST.Objects | undefined => {
  const stored = SchemaAST.toEncoded(ast)
  if (SchemaAST.isOptional(stored) || seen.has(stored)) return undefined
  seen.add(stored)
  if (SchemaAST.isSuspend(stored)) return certainStruct(stored.thunk(), seen)
  return SchemaAST.isObjects(stored) ? stored : undefined
}

/**
 * Where, below `path`, every stored value of `ast` holds a property named `__proto__` in a map: a
 * required property of a struct, with no value that stores nothing ({@link isRequiredStored}),
 * reached from `ast` through containers each certain to hold a map ({@link certainStruct}): `ast`
 * itself required, and each property on the way a required struct.
 * The walk is of the stored (encoded) form. Wherever a container on the way may hold no map, or
 * nothing (an optional or `optionalKey` one, a nullable one, a union, a list or a tuple, a record,
 * text, a declaration with no encoding), a value may or may not hold the name: the definition
 * loads, and a write that gives the name is refused when it's sent (`EDD-9165`). `packed` names the
 * properties of `ast`'s own struct that are stored as JSON text (`DynamoModel.Packed`), which hold
 * any name: the walk doesn't enter them.
 */
export const requiredProtoPropertyIn = (
  ast: SchemaAST.AST,
  path: string,
  packed: ReadonlySet<string> = new Set(),
  seen: Set<SchemaAST.AST> = new Set(),
): string | undefined => {
  const stored = certainStruct(ast, seen)
  if (stored === undefined) return undefined
  for (const property of stored.propertySignatures) {
    if (typeof property.name !== "string" || SchemaAST.isOptional(property.type)) continue
    const at = path === "" ? property.name : `${path}.${property.name}`
    if (property.name === "__proto__") {
      if (isRequiredStored(property.type)) return at
      continue
    }
    if (packed.has(property.name)) continue
    const found = requiredProtoPropertyIn(property.type, at, undefined, seen)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * `[EDD-9152]`: an entity names `__proto__` where every item it writes would hold it, as an
 * attribute or as a property of a stored map. A JavaScript object can't take that name by
 * assignment (it replaces the prototype), and the AWS SDK's marshaller drops an attribute or a map
 * entry so named, while its reader sets a prototype from one: no write could store the item whole.
 * So: an attribute the library writes on every item ({@link names}: the created and updated
 * timestamps, the version, the table's key attributes, an index's key attributes where every
 * composite of both its halves always stores something, the attribute a field that always stores
 * something is stored under), a required model field stored under its own name whose every value
 * stores something ({@link isRequiredStored}), and such a property of one reached through required
 * struct properties ({@link requiredProtoPropertyIn}). Anything else of that name loads (an
 * optional field or property, one whose stored form admits `undefined` or isn't modelled exactly,
 * an index's key attribute that some item may be without): a write that doesn't give it does what
 * it did, and one that does is refused when it's sent (`EDD-9165`). Nothing stored as JSON text is
 * looked into. Thrown at `make`, before anything else is derived.
 *
 * `fields` are the model's fields; `storage` says which are stored under another attribute and
 * which are packed.
 */
export const refuseProtoName = (
  entityType: string,
  fields: Readonly<Record<string, Schema.Top>>,
  storage: {
    readonly renamed: ReadonlySet<string>
    readonly packed: ReadonlySet<string>
  },
  names: ReadonlyArray<{
    readonly name: string | null | undefined
    readonly what: string
    /** Whether every item written holds the attribute (`true` when not said). */
    readonly always?: boolean
  }>,
): void => {
  const refuse = (what: string) => protoRefusal("EDD-9152", `Entity "${entityType}"`, what)
  for (const { name, what, always } of names) {
    if (name === "__proto__" && always !== false) throw refuse(what)
  }
  for (const [name, field] of Object.entries(fields)) {
    if (name === "__proto__" && !storage.renamed.has(name) && isRequiredStored(field.ast)) {
      throw refuse("the model field")
    }
    if (storage.packed.has(name)) continue
    const property = requiredProtoPropertyIn(field.ast, name)
    if (property !== undefined) throw refuse(`the model's property at "${property}"`)
  }
}

/**
 * The refusal of a definition naming `__proto__` where every row it writes would hold it:
 * `[EDD-9152]` for an entity ({@link refuseProtoName}), `[EDD-9153]` for an aggregate
 * (`refuseAggregateProtoName`). `what` says where the name is.
 */
export const protoRefusal = (code: "EDD-9152" | "EDD-9153", owner: string, what: string): Error =>
  new Error(
    `[${code}] ${owner}: ${what} is named "__proto__", and every row written would hold it. A ` +
      `JavaScript object can't hold a property of that name by assignment, and the AWS SDK's ` +
      `marshaller drops an attribute or a map entry so named, so the value would be lost when ` +
      `it's written or read. Name it otherwise.`,
  )
