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
import { differingPaths } from "./WholeDiff.js"

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
 * - `"checks the entry"`: a value written into a sparse map's entry named by its attribute is
 *   checked against the map's value schema and encoded as a field's is (#238). 1.39.0 wrote it as
 *   given: where its row then didn't read, the value is refused with nothing sent; otherwise
 *   the requests are 1.39.0's, or differ in that value alone (written encoded) and the row reads
 *   wherever 1.39.0's did. `"checks the entry keyed `__proto__`"` is the same where 1.39.0's
 *   read dropped the entry, so the row it left read whatever the value was;
 * - `"names the property"`: a path's segment below the first names the property of that name.
 *   1.39.0 renamed it as if it were a top-level field (`count`, stored as `renamed`), so it wrote
 *   another property, and the row the update leaves reads differently.
 *
 * - `"refuses what wouldn't read"` (#236): 1.39.0 sent an operand no row holding it reads, at a
 *   position the read schema resolves exactly (a sparse map's entry, a suspended or branded
 *   schema), and wrote a row that didn't read. The operand is refused now, with nothing sent;
 * - `"stores what reads"` (#236): the same, for an operand only its encoded form is valid for.
 *   The same requests are sent, holding the operand as its reader reads it back (`"7"`, not `7`:
 *   `stored` names the two forms), and the row reads.
 *
 * And for a `pathIfNotExists` operand that 1.39.0 refused, or that it wrote where the row then
 * didn't read (#236): it is refused only where its path is absent, since only there would it be
 * stored. The update finds out by the request {@link fallbackDecided} names:
 *
 * - `"refused where stored"`: the case's row lacks the path. The operand is refused with the error
 *   1.39.0 refused it with (or, where 1.39.0 wrote it, as an operand that wouldn't read), and
 *   nothing is written;
 * - `"kept where present"`: the row holds the path, so DynamoDB keeps the stored value and the
 *   operand is never stored. The update is written and succeeds, and the row reads.
 * - `"refused where stored, keyed `__proto__`"`: `"refused where stored"`, for an operand a sparse
 *   map's entry keyed `__proto__` checks (#238), where 1.39.0's read dropped the entry, so the
 *   row it left read whatever the value was.
 *
 * And for every case: an update that wrote a row its reader then couldn't decode failed with a
 * `ValidationError` whose operation was `decode`; the release branch reports the same failure as
 * operation `update`, saying the update was applied.
 */
export type Since139 =
  | "reads"
  | "reads the entry"
  | "names the property"
  | "refuses what wouldn't read"
  | "stores what reads"
  | "refused where stored"
  | "refused where stored, keyed `__proto__`"
  | "kept where present"
  | "checks the entry"
  | "checks the entry keyed `__proto__`"

/** An update that was written and whose row then didn't decode, in either release's words. */
const writtenUnreadable = (outcome: Outcome): boolean =>
  wrote(outcome) &&
  outcome.failure !== undefined &&
  "error" in outcome.failure &&
  outcome.failure.error === "ValidationError" &&
  (outcome.failure.operation === "decode" ||
    (outcome.failure.operation === "update" &&
      outcome.failure.says.startsWith("The update WAS applied")))

/** Where two JSON values differ: each pair of differing parts, outermost first. */
const differences = (was: unknown, got: unknown): ReadonlyArray<readonly [unknown, unknown]> => {
  if (JSON.stringify(was) === JSON.stringify(got)) return []
  const walkable = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null
  if (!walkable(was) || !walkable(got) || Array.isArray(was) !== Array.isArray(got)) {
    return [[was, got]]
  }
  const keys = [...new Set([...Object.keys(was), ...Object.keys(got)])]
  if (keys.some((key) => !Object.hasOwn(was, key) || !Object.hasOwn(got, key))) return [[was, got]]
  return keys.flatMap((key) => differences(was[key], got[key]))
}

/** A consistent read of a row. */
const readsRow = (request: Request | undefined): boolean =>
  request?.command === "GetItem" && (request.input as any)?.ConsistentRead === true

/** An update sent requiring `pathIfNotExists` paths, beside the row's own guard. */
const guardedUpdate = (request: Request | undefined): boolean => {
  const input = request?.input as Record<string, any> | undefined
  return (
    request?.command === "UpdateItem" &&
    /^attribute_exists\(#exists\)( AND attribute_exists\(#fb\d+((\.#fb\d+)|\[\d+\])*\))+$/.test(
      String(input?.ConditionExpression),
    ) &&
    input?.ReturnValuesOnConditionCheckFailure === "ALL_OLD"
  )
}

/**
 * Whether `requests` find a `pathIfNotExists` path absent or present before writing it: a
 * consistent read of the row (a retained entity's update, a transaction's plan) before any write,
 * or, for an update that reads nothing, its write sent requiring the path, so that DynamoDB's
 * refusal returns the row without it.
 */
export const fallbackDecided = (requests: ReadonlyArray<Request>): boolean => {
  const firstWrite = requests.findIndex((request) => request.command !== "GetItem")
  if (firstWrite === -1) return readsRow(requests.at(-1))
  return guardedUpdate(requests[firstWrite]) || readsRow(requests[firstWrite - 1])
}

/** An update request without the `attribute_exists(<path>)` guards {@link fallbackDecided} names. */
const unguarded = (request: Request | undefined): unknown => {
  if (request?.command !== "UpdateItem") return request
  const input = { ...(request.input as Record<string, any>) }
  input.ConditionExpression = String(input.ConditionExpression).replace(
    / AND attribute_exists\(#fb\d+((\.#fb\d+)|\[\d+\])*\)/g,
    "",
  )
  input.ExpressionAttributeNames = Object.fromEntries(
    Object.entries(input.ExpressionAttributeNames as Record<string, string>).filter(
      ([name]) => !/^#fb\d+$/.test(name),
    ),
  )
  return { command: request.command, input }
}

/**
 * Where each request holds a path operation's operand (`:ps<n>`, `:pa<n>`, `:pp<n>`, `:pi<n>`),
 * as `differingPaths` names it: `[0].input.ExpressionAttributeValues.:ps2`, or in a transaction
 * `[1].input.TransactItems[0].Update.ExpressionAttributeValues.:ps2`.
 */
const operandValuePaths = (requests: ReadonlyArray<Request>): ReadonlyArray<string> =>
  requests.flatMap((request, i) => {
    const input = request.input as {
      readonly ExpressionAttributeValues?: Record<string, unknown>
      readonly TransactItems?: ReadonlyArray<{
        readonly Update?: { readonly ExpressionAttributeValues?: Record<string, unknown> }
      }>
    }
    const at = (values: Record<string, unknown> | undefined, path: string) =>
      Object.keys(values ?? {})
        .filter((name) => /^:p[sapi]\d+$/.test(name))
        .map((name) => `${path}.ExpressionAttributeValues.${name}`)
    return [
      ...at(input.ExpressionAttributeValues, `[${i}].input`),
      ...(input.TransactItems ?? []).flatMap((item, j) =>
        at(item.Update?.ExpressionAttributeValues, `[${i}].input.TransactItems[${j}].Update`),
      ),
    ]
  })

/** How an update ended. */
const ending = (outcome: Outcome): unknown =>
  writtenUnreadable(outcome) ? "written, and the row doesn't decode" : (outcome.failure ?? "ok")

/** `got` is what 1.39.0 did (`was`), but for the requests it sent before refusing an operand. */
export const expectAs139 = (
  got: Outcome,
  was: Outcome,
  since?: Since139,
  stored: readonly [was: unknown, now: unknown] = [{ N: "7" }, { S: "7" }],
): void => {
  if (since === "names the property") {
    // The same requests, but for the property's name.
    expect(wrote(was)).toBe(true)
    expect(got.requests).toEqual(
      JSON.parse(JSON.stringify(was.requests).replace(/("#ps\d+"):"renamed"/g, '$1:"count"')),
    )
    return
  }
  if (
    since === "refused where stored" ||
    since === "refused where stored, keyed `__proto__`" ||
    since === "kept where present"
  ) {
    // 1.39.0 refused it, or wrote it and left a row that didn't read (or dropped the entry).
    expect(
      refusedOperand(was) ||
        (wrote(was) && (!was.reads || since === "refused where stored, keyed `__proto__`")),
    ).toBe(true)
    expect(fallbackDecided(got.requests)).toBe(true)
    const guarded = got.requests.find(guardedUpdate)
    if (guarded !== undefined && wrote(was)) {
      // The update 1.39.0 sent, requiring the path.
      expect(unguarded(guarded)).toEqual(
        was.requests.find((request) => request.command === "UpdateItem"),
      )
    }
    if (since !== "kept where present") {
      // Reads, or the guarded update DynamoDB refuses: nothing else is sent.
      const writes = got.requests.filter((request) => request.command !== "GetItem")
      expect(writes.length === 0 || (writes.length === 1 && guardedUpdate(writes[0]))).toBe(true)
      expect(refusedOperand(got)).toBe(true)
      if (refusedOperand(was)) expect(got.failure).toEqual(was.failure)
    } else {
      expect(wrote(got)).toBe(true)
      expect(got.ok).toBe(true)
    }
    expect(got.reads).toBe(true)
    return
  }
  if (since === "refuses what wouldn't read" || since === "stores what reads") {
    // 1.39.0 wrote it, and the row it left didn't read.
    expect(wrote(was)).toBe(true)
    expect(was.reads).toBe(false)
    if (since === "refuses what wouldn't read") {
      expect(refusedOperand(got)).toBe(true)
      expect(got.requests).toEqual([])
    } else {
      // The operand is sent in the form its reader reads back, and nothing else differs.
      const changes = differences(was.requests, got.requests)
      expect(changes.length).toBeGreaterThan(0)
      for (const change of changes) expect(change).toEqual(stored)
      expect(got.ok).toBe(true)
    }
    expect(got.reads).toBe(true)
    return
  }
  if (since === "checks the entry" || since === "checks the entry keyed `__proto__`") {
    expect(wrote(was)).toBe(true)
    if (refusedOperand(got)) {
      // A value no read takes there: 1.39.0 left a row that didn't read (or dropped the entry).
      expect(got.requests).toEqual([])
      expect(writtenUnreadable(was) || !was.reads || since !== "checks the entry").toBe(true)
      return
    }
    const differ = differingPaths(was.requests, got.requests)
    if (differ.length > 0) {
      // Written encoded: the requests differ in the operand's value alone, and the row reads
      // wherever 1.39.0's did (where 1.39.0's didn't, it reads now or ends as 1.39.0's ended).
      const operands = operandValuePaths(was.requests)
      for (const path of differ) {
        expect(operands.some((operand) => path.startsWith(operand))).toBe(true)
      }
      if (was.reads || !(got.ok && got.reads)) {
        expect(ending(got)).toEqual(ending(was))
        expect(got.ok).toBe(was.ok)
        expect(got.reads).toBe(was.reads)
      }
      return
    }
    // Written as 1.39.0 wrote it: compared as any other case.
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
