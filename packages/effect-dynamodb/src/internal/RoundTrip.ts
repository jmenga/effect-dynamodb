/**
 * Whether what a write stores reads back, for a value of a custom declaration (`EDD-9126`), and
 * whether DynamoDB stores a value at a position no schema types at all (`EDD-9161`).
 *
 * A `Schema.instanceOf` and a duck-typed `Schema.declare` have the same AST, and only the second reads
 * back, so a model can't be judged when it loads (`EDD-9125` judges Effect's own declarations). What
 * can be judged is the value: what the marshaller makes of it, unmarshalled, is what a read would
 * hand the schema. The test is whether that decodes, never whether the value is an instance.
 *
 * A value at a position no schema types is stored as given, so only the value can say whether
 * DynamoDB stores it: one holding a part it doesn't (`LostValues`) is refused, and the same function
 * refuses it in a packed field. A schema holding neither has no check at all, so what it costs is the
 * scan when it's built, and its requests are the ones it always sent.
 */

import {
  isLostAt,
  lostIn,
  lostPath,
  lostRefusal,
} from "@effect-dynamodb/schema/internal/LostValues.js"
import {
  holdsCustomDeclaration,
  holdsUntyped,
} from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import { Cause, Effect, Schema } from "effect"
import { fromAttributeMap, toAttributeMap } from "../Marshaller.js"

/** What a read gets for a value a write stores, marshalled and unmarshalled for real. */
export const asRead = (encoded: unknown): unknown =>
  fromAttributeMap(toAttributeMap({ value: encoded })).value

/** Fails with the schema's issue when a stored value wouldn't read back. */
export type ReadBack = (encoded: unknown) => Effect.Effect<void, unknown>

/**
 * The check for a schema's stored values, or `undefined` when it holds neither a custom declaration
 * nor an untyped position. A value at an untyped position is first looked through for a part
 * DynamoDB doesn't store (`lostIn`), which fails with that part (`EDD-9161`); a custom declaration's
 * value is then read back. A value the marshaller refuses isn't this check's to judge: the write's
 * own marshalling reports it (`EDD-9124`).
 */
export const readBackOf = (stored: Schema.Top, read: () => Schema.Top): ReadBack | undefined => {
  const custom = holdsCustomDeclaration(stored.ast)
  const untyped = holdsUntyped(stored.ast)
  if (!custom && !untyped) return undefined
  const decode = custom ? Schema.decodeUnknownEffect(read() as Schema.Codec<unknown>) : undefined
  return (encoded) => {
    if (untyped) {
      const lost = lostIn(encoded)
      if (lost !== undefined) return Effect.fail(lost)
    }
    if (decode === undefined) return Effect.void
    let value: unknown
    try {
      value = asRead(encoded)
    } catch {
      return Effect.void
    }
    return Effect.asVoid(decode(value) as Effect.Effect<unknown, unknown>)
  }
}

const issueOf = (issue: unknown): string =>
  Cause.isCause(issue) ? Cause.pretty(issue) : String((issue as Error)?.message ?? issue)

/**
 * The refusal of an aggregate write's value its field's schema can't put in its stored form (`EDD-9127`):
 * stored as given, the rows wouldn't read back. `fields` names each such field as `"field" of "member"`,
 * and `issue` is what the read made of the rows.
 */
export const notStoredForm = (fields: ReadonlyArray<string>, issue: unknown): string =>
  `${fields.length === 1 ? "Field" : "Fields"} ${fields.join(", ")} can't be put in the stored form: ` +
  "the schema can't encode the value, nor decode it and encode the result. Stored as given, the " +
  `aggregate wouldn't read back: ${issueOf(issue)}. Nothing was written. A transformation that ` +
  "encodes what it decodes to reads back. [EDD-9127]"

/**
 * The refusal of a key composite's value that reads back otherwise (`EDD-9128`): `what` names the
 * field and what composes it, and `readsAs` is what the value reads back as.
 */
export const readBackRefusal = (what: string, value: unknown, readsAs: string): string => {
  const given =
    typeof value === "bigint"
      ? `the bigint ${value}n`
      : typeof value === "number"
        ? `the number ${Object.is(value, -0) ? "-0" : String(value)}`
        : "the value given"
  let returned: unknown = value
  try {
    returned = asRead(value)
  } catch {
    // Described as given.
  }
  const because =
    (typeof value === "bigint" || typeof value === "number") && typeof returned !== typeof value
      ? "DynamoDB stores a number and a bigint alike"
      : Object.is(value, -0)
        ? "DynamoDB stores -0 as 0"
        : "DynamoDB doesn't hand it back as it was written"
  return (
    `${what}, and ${given} would read back as ${readsAs}, whose key text isn't the one ` +
    `written: ${because}. A key composed again from the stored row wouldn't be this one. ` +
    "Nothing was written. Declare the field's kind, such as Schema.Number or Schema.BigInt, " +
    "or store a value that reads back as written. [EDD-9128]"
  )
}

/**
 * The refusal in words: `what` is what the value is, and `issue` what a read made of it, or the part
 * of it DynamoDB doesn't store (`EDD-9161`), named from `root`. Without `what`, a part DynamoDB doesn't
 * store is named by its path alone.
 */
export const notReadBack = (what: string | undefined, issue: unknown, root = "value"): string => {
  if (isLostAt(issue)) {
    const refused = lostRefusal(lostPath(root, issue.path), issue)
    return what === undefined
      ? `${refused[0]!.toUpperCase()}${refused.slice(1)}`
      : `${what}: ${refused}`
  }
  return (
    `${what ?? "The value"} wouldn't read back: a custom declaration's value is stored as the map ` +
    `the marshaller makes of it, and a read fails on that: ${issueOf(issue)}. Nothing was written. ` +
    "A class of your own reads back when it's decoded from what's stored, such as a struct with " +
    "Schema.decodeTo. [EDD-9126]"
  )
}
