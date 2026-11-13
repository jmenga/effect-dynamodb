/**
 * `rekey` over random tables (`helpers/RandomTables.ts`) gives one outcome whatever its segment
 * count and the order its scan hands rows over, and its dry run reports what the real run does
 * (#240): every count is a function of the table before the run. The seeds after the first eight
 * are tables where a count once depended on the order — a `preserveUnique` tombstone's sentinel the
 * live row its back-pointer names doesn't hold, counted `unrecognizedKey` when the scan met it
 * before the tombstone's move took it and not after; and a row moving onto the key such a sentinel
 * names, read as its owner when the scan met the sentinel after the move. Such a sentinel is now
 * counted once the run is over, unless a row's pass took or re-pointed it, and is judged against
 * the row its back-pointer named before the run.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { rekeyOnce, scanShuffled, tableOf, writeRandom } from "./helpers/RandomTables.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"
import { storedRows } from "./helpers/StoredRows.js"

const SEEDS = [...Array.from({ length: 8 }, (_, i) => i + 1), 138, 234, 284, 330]

const ORDERS = [1, 2, 3, 8].flatMap((segments) =>
  [0, 1, 2].flatMap((order) => [2, undefined].map((pageSize) => ({ segments, order, pageSize }))),
)

describe.each([
  ["to on", true],
  ["to off", false],
] as const)("rekey over random tables, %s", (_direction, escapeKeys) => {
  for (const seed of SEEDS) {
    it.effect(`seed ${seed}: one outcome in every segment count and order, dry run = run`, () =>
      Effect.gen(function* () {
        const rows = yield* writeRandom(!escapeKeys, seed)
        let first: unknown
        for (const { segments, order, pageSize } of ORDERS) {
          const at = `segments ${segments}, order ${order}, pageSize ${pageSize}`
          const table = tableOf(rows)
          const options = { segments, concurrency: 4, ...(pageSize !== undefined && { pageSize }) }
          const dry = yield* rekeyOnce(
            escapeKeys,
            table,
            { ...options, dryRun: true },
            scanShuffled(order),
          )
          expect(storedRows(table.items.values()), at).toEqual(storedRows(rows))
          const real = yield* rekeyOnce(escapeKeys, table, options, scanShuffled(order))
          expect(rekeyOutcome(dry), at).toEqual(rekeyOutcome(real))
          expect(real.scanned, at).toBe(rows.length)
          const outcome = { report: rekeyOutcome(real), rows: storedRows(table.items.values()) }
          if (first === undefined) first = outcome
          else expect(outcome, at).toEqual(first)
        }
      }),
    )
  }
})
