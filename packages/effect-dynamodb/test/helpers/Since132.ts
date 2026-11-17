/**
 * What a run sends now, against what a published version recorded, with #132's two changes to
 * the requests applied. Nothing else may differ.
 *
 * - An update that sets nothing reads its row consistently (`ConsistentRead: true` on its
 *   `GetItem`, where 1.40.0 sent an eventually consistent one). A `GetItem` the run sends with
 *   `ConsistentRead: true` in the place of the recording's `GetItem` sent without it, and otherwise
 *   the same, counts as the recording's. Any other change to a `GetItem`, its consistency
 *   included, still differs.
 * - `purge` reads the partition consistently, and deletes a unique entity's live row with its
 *   sentinels in one guarded transaction. A step named for a purge (its label holds "purge") is
 *   compared by the keys it deleted, and its requests are otherwise left out: the recorded run's
 *   requests around it must match the run's, request for request.
 */

import { expect } from "vitest"
import type { Outcome, Sent } from "./InheritedNames.js"

/** `now` with each read made consistent in place of `was`'s eventually consistent one as `was`'s. */
const heldAgainst = (now: ReadonlyArray<Sent>, was: ReadonlyArray<Sent>): ReadonlyArray<Sent> =>
  now.map((sent, i) => {
    const recorded = was[i]
    if (sent.command !== "GetItem" || recorded?.command !== "GetItem") return sent
    const { ConsistentRead: held, ...input } = sent.input as Record<string, unknown>
    const { ConsistentRead: before, ...recordedInput } = recorded.input as Record<string, unknown>
    return held === true &&
      (before === undefined || before === false) &&
      JSON.stringify(input) === JSON.stringify(recordedInput)
      ? recorded
      : sent
  })

/** The keys a run of requests deleted, by any command, sorted. */
const deletedKeys = (requests: ReadonlyArray<Sent>): ReadonlyArray<string> => {
  const keys: Array<string> = []
  for (const { command, input } of requests as ReadonlyArray<{ command: string; input: any }>) {
    if (command === "DeleteItem") keys.push(JSON.stringify(input.Key))
    if (command === "TransactWriteItems") {
      for (const item of input.TransactItems) {
        if (item.Delete !== undefined) keys.push(JSON.stringify(item.Delete.Key))
      }
    }
    if (command === "BatchWriteItem") {
      for (const writes of Object.values(input.RequestItems) as Array<Array<any>>) {
        for (const write of writes) {
          if (write.DeleteRequest !== undefined) keys.push(JSON.stringify(write.DeleteRequest.Key))
        }
      }
    }
  }
  return keys.sort()
}

/** `received`'s steps as `[label, start, length]`, in the order they ran. */
const stepsOf = (received: Outcome): ReadonlyArray<readonly [string, number, number]> => {
  const steps: Array<readonly [string, number, number]> = []
  let at = 0
  for (const [label, commands] of Object.entries(received.sentBy ?? {})) {
    steps.push([label, at, commands.length])
    at += commands.length
  }
  return steps
}

/**
 * Assert `received`'s requests are `recorded`'s with #132's changes (see above). A purge step's
 * place in `recorded`, which may hold no `sentBy`, is found by the requests after it: they must
 * match the run's from some point on.
 */
export const expectRequestsSince132 = (
  received: Outcome,
  recorded: { readonly requests?: ReadonlyArray<Sent> | undefined },
): void => {
  const run = received.requests
  const was = recorded.requests ?? []
  const purges = stepsOf(received).filter(([label]) => label.includes("purge"))
  if (purges.length === 0) {
    expect(heldAgainst(run, was)).toEqual(was)
    return
  }
  // The segments between purges, each matched in order; each purge's recorded requests are the
  // shortest run before the next segment matches.
  let nowAt = 0
  let wasAt = 0
  for (const [index, [label, start, length]] of purges.entries()) {
    const before = was.slice(wasAt, wasAt + (start - nowAt))
    expect(heldAgainst(run.slice(nowAt, start), before)).toEqual(before)
    wasAt += start - nowAt
    const nextStart = purges[index + 1]?.[1] ?? run.length
    const after = run.slice(start + length, nextStart)
    let span = 0
    const matches = (n: number) => {
      const recordedAfter = was.slice(wasAt + n, wasAt + n + after.length)
      return (
        JSON.stringify(heldAgainst(after, recordedAfter)) === JSON.stringify(recordedAfter) &&
        (index + 1 < purges.length || wasAt + n + after.length === was.length)
      )
    }
    while (wasAt + span <= was.length && !matches(span)) span++
    expect(wasAt + span <= was.length, `the requests after ${label} match the recording`).toBe(true)
    expect(deletedKeys(run.slice(start, start + length))).toEqual(
      deletedKeys(was.slice(wasAt, wasAt + span)),
    )
    nowAt = start + length
    wasAt += span
  }
  const rest = was.slice(wasAt)
  expect(heldAgainst(run.slice(nowAt), rest)).toEqual(rest)
}

/**
 * {@link expectRequestsSince132} for requests split by step (`requestsByStep`): each step's
 * requests, with a read made consistent in the place of the recording's read counted as it.
 */
export const readsHeldByStep = (
  byStep: Readonly<Record<string, ReadonlyArray<Sent>>>,
  recordedByStep: Readonly<Record<string, ReadonlyArray<Sent>>>,
): Record<string, ReadonlyArray<Sent>> =>
  Object.fromEntries(
    Object.entries(byStep).map(([label, sent]) => [
      label,
      heldAgainst(sent, recordedByStep[label] ?? []),
    ]),
  )
