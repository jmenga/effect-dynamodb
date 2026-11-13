/**
 * What a `rebuild` of a projection with an outbox did on 1.40.0 and does now (#237), for
 * `OutboxRolling.test.ts` (in memory) and `connected.outbox-marks.test.ts` (DynamoDB Local), from
 * `fixtures/outbox-rebuild-1.40.0.json` (`helpers/RebuildScenarios.ts`, run against the published
 * 1.40.0 on DynamoDB Local).
 */

import { readFileSync } from "node:fs"
import { expect } from "vitest"
import type { Sent } from "./OutboxScenarios.js"
import type { RebuildState, Rebuilt } from "./RebuildScenarios.js"

export const rebuildFixture = JSON.parse(
  readFileSync(new URL("../fixtures/outbox-rebuild-1.40.0.json", import.meta.url), "utf8"),
) as { readonly version: string; readonly scenarios: Record<string, Rebuilt> }

/** The outbox items a run's requests wrote. */
const outboxPuts = (sent: ReadonlyArray<Sent>) =>
  sent.flatMap((request) =>
    ((request.input as any).TransactItems ?? [request.input]).filter(
      (entry: any) => (entry.Put ?? entry).Item?.__edd_e__?.S === "Ledger#outbox",
    ),
  ).length

/** A write's condition, its names and values in place. */
const condition = (input: any): string =>
  String(input.ConditionExpression).replace(/[#:]\w+/g, (placeholder) =>
    placeholder.startsWith("#")
      ? input.ExpressionAttributeNames[placeholder]
      : JSON.stringify(input.ExpressionAttributeValues[placeholder]),
  )

const sortedItem = (item: unknown) =>
  Object.fromEntries(
    Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
  )

/**
 * `ran` (this release) against `before` (1.40.0, the same scenario). 1.40.0's rebuild wrote the
 * row and, in its transaction, the effects of both events it re-derived, so each was delivered
 * twice. Now it writes the row alone and no outbox item: the pending item is delivered once and
 * the later live event's once. The rebuild's reads are 1.40.0's, its write the transaction's row
 * `Put` alone (the same item), conditioned on the row's guard as the entity writes it, as every
 * projection write that enqueues nothing is; the row stored is 1.40.0's.
 */
export const checkRebuilt = (ran: Rebuilt, before: Rebuilt, state: RebuildState) => {
  // The before: both effects written again and delivered twice.
  expect(outboxPuts(before.sent)).toBe(2)
  expect(before.delivered).toEqual({
    before: ["1:2"],
    after: state === "live" ? ["2:5", "1:2", "2:5"] : ["1:2", "2:5", "2:5"],
    live: ["3:12"],
  })
  // The after: none written, each delivered once.
  expect(outboxPuts(ran.sent)).toBe(0)
  expect(ran.delivered).toEqual({ before: ["1:2"], after: ["2:5"], live: ["3:12"] })
  expect(ran.left).toBe(0)
  expect(before.left).toBe(0)
  // The reads: 1.40.0's.
  expect(ran.sent.map((request) => request.operation)).toEqual(["query", "getItem", "putItem"])
  expect(ran.sent.slice(0, 2)).toEqual(before.sent.slice(0, 2))
  // The write: the transaction's row `Put`, alone.
  const [tx] = before.sent.slice(2)
  expect(before.sent.map((request) => request.operation)).toEqual([
    "query",
    "getItem",
    "transactWriteItems",
  ])
  const rowPut = (tx!.input as any).TransactItems[0].Put
  const write = ran.sent[2]!.input as any
  expect(write.TableName).toBe(rowPut.TableName)
  expect(write.Item).toEqual(rowPut.Item)
  // The guard: the revision read; a row read absent is created (no item at its key), where
  // 1.40.0's transaction asked for no revision there.
  expect(condition(rowPut)).toBe(state === "live" ? 'rev = {"N":"2"}' : "attribute_not_exists(rev)")
  expect(condition(write)).toBe(
    state === "live"
      ? 'rev = {"N":"2"}'
      : "(attribute_not_exists(pk)) AND (attribute_not_exists(sk))",
  )
  expect(sortedItem(ran.row)).toEqual(sortedItem(before.row))
}
