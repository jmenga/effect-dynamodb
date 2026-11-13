/**
 * What a synchronous decode or encode says of a value (#236).
 *
 * The library checks an update's operand by running a schema synchronously (`decodeUnknownExit`,
 * `encodeUnknownExit`), where a row's read runs it as an Effect (`decodeUnknownEffect`). Most
 * schemas give the same answer both ways. One whose step suspends (an asynchronous
 * `transformEffect`), dies or throws can't finish synchronously, and its failure there says
 * nothing about the value: the read may well decode it. Only a failure made of schema issues
 * alone is an answer.
 */

import { type Cause, Exit } from "effect"

/** A synchronous run that couldn't finish: nothing can be said of the value from it. */
export const CANT_SAY: unique symbol = Symbol.for("effect-dynamodb/SchemaIssue/CantSay")
export type CantSay = typeof CANT_SAY

/**
 * A synchronous decode's or encode's verdict: `undefined` when it succeeded, its cause when it
 * failed on schema issues alone, and {@link CANT_SAY} when it died, threw, was interrupted or
 * needed to run asynchronously.
 */
export const issueOf = (
  run: () => Exit.Exit<unknown, unknown>,
): Cause.Cause<unknown> | CantSay | undefined => {
  let exit: Exit.Exit<unknown, unknown>
  try {
    exit = run()
  } catch {
    return CANT_SAY
  }
  if (Exit.isSuccess(exit)) return undefined
  const { reasons } = exit.cause
  return reasons.length > 0 && reasons.every((reason) => reason._tag === "Fail")
    ? exit.cause
    : CANT_SAY
}
