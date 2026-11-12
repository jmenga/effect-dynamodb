/**
 * Whether a projection's write over a live row keeps the row's data (#237), judged on exactly the
 * attribute map its request carries: the item encoded, renamed, as sparse entries, packed and then
 * marshalled. A write over a row another projection (B) has written carries B's bookkeeping only
 * where it stores every data attribute the row holds. Anything the marshaller leaves out is a
 * dropped attribute, whatever leaves it out; anything it stores, under the same name, is kept,
 * whatever its value or type.
 *
 * Each kind runs standalone and in the outbox's transaction, under both `escapeKeys` settings.
 * B's events are 5 and 7; A writes once, between B's first event and B's redelivery of it.
 *
 * - **Dropped** (the marshaller stores nothing for the value): B's bookkeeping goes with the data,
 *   as on 1.40.0, so B's redelivered event applies again and B's part comes back whole.
 * - **Kept** (the attribute is stored, with A's value): B's bookkeeping is carried, so B's
 *   redelivery is `alreadyApplied` and B goes on from A's value (1.40.0 dropped it, so B folded
 *   its stream again: the decided reset, `EventStore.projection-carry.test.ts`).
 * - **Refused** (the marshaller refuses the value): A's write fails, as on 1.40.0, and the row is
 *   as B left it.
 */

import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { cases, runCase } from "./helpers/StoredDataCases.js"

describe("a write over a live row the other projection has written, judged on its marshalled attributes (#237)", () => {
  for (const c of cases) {
    for (const outbox of [false, true]) {
      for (const escapeKeys of [false, true]) {
        it.effect(
          `${c.name} (${c.outcome})${outbox ? ", in the outbox's transaction" : ""}, escapeKeys ${escapeKeys ? "on" : "off"}`,
          () => {
            const table = makeRecordingTable()
            const row = Effect.sync(
              () => [...table.items.values()].find((item) => item.__edd_e__?.S === "Row")!,
            )
            return runCase(
              c,
              outbox,
              escapeKeys,
              Layer.succeed(DynamoClient, table.client),
              { events: "events", read: "read" },
              row,
            )
          },
        )
      }
    }
  }
})
