/**
 * Whether what a write stores reads back, for a value of a custom declaration (`EDD-9126`).
 *
 * A `Schema.instanceOf` and a duck-typed `Schema.declare` have the same AST, and only the second reads
 * back, so a model can't be judged when it loads (`EDD-9125` judges Effect's own declarations). What
 * can be judged is the value: what the marshaller makes of it, unmarshalled, is what a read would
 * hand the schema. The test is whether that decodes, never whether the value is an instance.
 *
 * A schema holding no custom declaration has no check at all, so what it costs is the scan when it's
 * built, and its requests are the ones it always sent.
 */

import { holdsCustomDeclaration } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import { Cause, Effect, Schema } from "effect"
import { fromAttributeMap, toAttributeMap } from "../Marshaller.js"

/** What a read gets for a value a write stores, marshalled and unmarshalled for real. */
export const asRead = (encoded: unknown): unknown =>
  fromAttributeMap(toAttributeMap({ value: encoded })).value

/** Fails with the schema's issue when a stored value wouldn't read back. */
export type ReadBack = (encoded: unknown) => Effect.Effect<void, unknown>

/**
 * The check for a schema's stored values, or `undefined` when it holds no custom declaration. A value
 * the marshaller refuses isn't this check's to judge: the write's own marshalling reports it
 * (`EDD-9124`).
 */
export const readBackOf = (stored: Schema.Top, read: () => Schema.Top): ReadBack | undefined => {
  if (!holdsCustomDeclaration(stored.ast)) return undefined
  const decode = Schema.decodeUnknownEffect(read() as Schema.Codec<unknown>)
  return (encoded) => {
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

/** The refusal in words: `what` is what the value is, and `issue` what a read made of it. */
export const notReadBack = (what: string, issue: unknown): string =>
  `${what} wouldn't read back: a custom declaration's value is stored as the map the marshaller ` +
  `makes of it, and a read fails on that: ${issueOf(issue)}. Nothing was written. A class of your ` +
  "own reads back when it's decoded from what's stored, such as a struct with Schema.decodeTo. " +
  "[EDD-9126]"
