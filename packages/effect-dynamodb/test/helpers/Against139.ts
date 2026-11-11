/**
 * What an update did, in a form a fixture holds, and the one comparison this branch's tests make
 * with what the published 1.39.0 did for the same update.
 *
 * The rule: where 1.39.0 sent a write, this source sends the same requests and ends the same way.
 * Where 1.39.0 refused an operand its schema refuses, this source refuses it with the same error
 * and sends nothing: 1.39.0 decided it as the write was built, after whatever the update reads
 * first. Any other failure with nothing written sends what 1.39.0 sent and fails as it failed.
 *
 * The release branch already differs from 1.39.0 in four ways that aren't this comparison's
 * subject, each named by a case that has it ({@link Since139}).
 */

import { Cause, Exit } from "effect"
import { expect } from "vitest"

export interface Request {
  readonly command: string
  readonly input: unknown
}

/** How an update failed: a typed error, or a defect. */
export type Failure =
  | { readonly error: string; readonly operation?: string; readonly says: string }
  | { readonly defect: string }

export interface Outcome {
  /** Whether the update succeeded: alone, that means the row it returned decoded. */
  readonly ok: boolean
  readonly failure?: Failure
  /** Whether the item reads back afterwards. */
  readonly reads: boolean
  readonly requests: ReadonlyArray<Request>
}

/** JSON as a fixture holds it. */
export const plain = <A>(value: A): A =>
  JSON.parse(
    JSON.stringify(value, (_key, held) =>
      held instanceof Set ? [...held] : typeof held === "bigint" ? `${held}n` : held,
    ),
  )

export const failureOf = (exit: Exit.Exit<unknown, unknown>): Failure | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const squashed = Cause.squash(exit.cause) as any
  if (exit.cause.reasons[0]?._tag !== "Fail") return { defect: String(squashed) }
  return {
    error: String(squashed?._tag),
    ...(typeof squashed?.operation === "string" ? { operation: squashed.operation } : {}),
    says: String(squashed?.cause ?? squashed?.message),
  }
}

/** The operations an update's operand is refused under. */
const OPERAND_REFUSALS: ReadonlySet<string> = new Set([
  "update.append",
  "update.pathSet",
  "update.pathAppend",
  "update.pathPrepend",
  "update.pathIfNotExists",
])

/** Whether an outcome is the refusal of an operand its schema refuses. */
export const refusedOperand = (outcome: Outcome): boolean =>
  outcome.failure !== undefined &&
  "error" in outcome.failure &&
  outcome.failure.error === "ValidationError" &&
  outcome.failure.operation !== undefined &&
  OPERAND_REFUSALS.has(outcome.failure.operation)

/** Whether a write was sent. */
export const wrote = (outcome: Outcome): boolean =>
  outcome.requests.some((request) => !request.command.includes("Get"))

/**
 * What the release branch does otherwise than 1.39.0 for a case, whatever its operand's timing:
 *
 * - `"reads"`: it reads a row 1.39.0 wrote and then couldn't decode (a field with a decoding
 *   default), so the update succeeds;
 * - `"reads the entry"`: a sparse map's entry keyed `__proto__` is read back as an entry. 1.39.0's
 *   read dropped it, so a value its schema refuses there left a row that still read;
 * - `"names the property"`: a path's segment below the first names the property of that name.
 *   1.39.0 renamed it as if it were a top-level field (`count`, stored as `renamed`), so it wrote
 *   another property, and the row the update leaves reads differently.
 *
 * And for every case: an update that wrote a row its reader then couldn't decode failed with a
 * `ValidationError` whose operation was `decode`; the release branch reports the same failure as
 * operation `update`, saying the update was applied.
 */
export type Since139 = "reads" | "reads the entry" | "names the property"

/** An update that was written and whose row then didn't decode, in either release's words. */
const writtenUnreadable = (outcome: Outcome): boolean =>
  wrote(outcome) &&
  outcome.failure !== undefined &&
  "error" in outcome.failure &&
  outcome.failure.error === "ValidationError" &&
  (outcome.failure.operation === "decode" ||
    (outcome.failure.operation === "update" &&
      outcome.failure.says.startsWith("The update WAS applied")))

/** How an update ended. */
const ending = (outcome: Outcome): unknown =>
  writtenUnreadable(outcome) ? "written, and the row doesn't decode" : (outcome.failure ?? "ok")

/** `got` is what 1.39.0 did (`was`), but for the requests it sent before refusing an operand. */
export const expectAs139 = (got: Outcome, was: Outcome, since?: Since139): void => {
  if (since === "names the property") {
    // The same requests, but for the property's name.
    expect(wrote(was)).toBe(true)
    expect(got.requests).toEqual(
      JSON.parse(JSON.stringify(was.requests).replace(/("#ps\d+"):"renamed"/g, '$1:"count"')),
    )
    return
  }
  if (refusedOperand(was)) {
    // 1.39.0 refused it before writing, and after its reads: nothing is sent now.
    expect(wrote(was)).toBe(false)
    expect(got.requests).toEqual([])
  } else {
    expect(got.requests).toEqual(was.requests)
  }
  if (since === "reads") {
    expect(writtenUnreadable(was) || !was.reads).toBe(true)
    expect(got.ok).toBe(true)
    expect(got.reads).toBe(true)
    return
  }
  if (since === "reads the entry") {
    // Written as 1.39.0 wrote it, and now read: the value its schema refuses doesn't decode.
    expect(was.reads).toBe(true)
    expect(wrote(got)).toBe(true)
    expect(got.reads).toBe(false)
    return
  }
  expect(ending(got)).toEqual(ending(was))
  expect(got.ok).toBe(was.ok)
  expect(got.reads).toBe(was.reads)
}
