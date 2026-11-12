/**
 * One `rekey` run's fibers (its segments, and the rows of a page handled at once) interleave as the
 * table answers, and the report and the rows it leaves don't depend on how (#240). Each table is
 * rekeyed with its requests delayed at random (`jittered`) and must end as the run without delays
 * ends, dry run and real. These seeds once ended otherwise: a moving row read another item's
 * sentinel at its sentinel's current key, then the row that sentinel named, which a move of the run
 * had just taken away with its sentinel; the row read as no row, the sentinel as one in the way,
 * and the move was reported `taken`. Or a sentinel moved out of another's way was moved meanwhile by
 * its own row's move, and the pass moving it out reported its current key taken by the very
 * sentinel it was moving. Before refusing, a move now reads the key again, and a pass whose
 * sentinel was moved meanwhile has nothing left to do.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { DynamoClientService } from "../src/DynamoClient.js"
import { gatedLayer } from "./helpers/GatedClient.js"
import { jittered, rekeyOnce, tableOf, writeRandom } from "./helpers/RandomTables.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import * as RekeyChains from "./helpers/RekeyChains.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"
import { storedRows } from "./helpers/StoredRows.js"

const SEEDS = [4, 6, 12, 13, 20, 22, 30, 38]
const JITTERS = 20
const OPTIONS = { segments: 2, concurrency: 4, pageSize: 3 }

describe.each([
  ["to on", true],
  ["to off", false],
] as const)("rekey's fibers interleaving at random, %s", (_direction, escapeKeys) => {
  for (const seed of SEEDS) {
    it.effect(
      `seed ${seed}: one outcome however its requests interleave`,
      () =>
        Effect.gen(function* () {
          const rows = yield* writeRandom(!escapeKeys, seed)
          const plain = tableOf(rows)
          const report = yield* rekeyOnce(escapeKeys, plain, OPTIONS)
          const want = rekeyOutcome(report)
          expect(report.conflicts).toEqual([])
          for (let jitter = 1; jitter <= JITTERS; jitter++) {
            const at = `jitter ${jitter}`
            const table = tableOf(rows)
            const dry = yield* rekeyOnce(
              escapeKeys,
              table,
              { ...OPTIONS, dryRun: true },
              jittered(seed * 1000 + jitter),
            )
            expect(rekeyOutcome(dry), at).toEqual(want)
            const real = yield* rekeyOnce(
              escapeKeys,
              table,
              OPTIONS,
              jittered(seed * 1000 + jitter),
            )
            expect(rekeyOutcome(real), at).toEqual(want)
            expect(storedRows(table.items.values()), at).toEqual(storedRows(plain.items.values()))
          }
        }),
      60_000,
    )
  }
})

/**
 * The chain scenarios (`helpers/RekeyChains.ts`) with the run's requests delayed at random: the dry
 * run and the run agree, on what the table held before them. A run once counted an item whose
 * sentinel a move of the run had taken out of another's way `unchanged` when its own pass read the
 * sentinel's current key before that move landed there and its old key after the other's sentinel
 * took it: neither read found it, and the pass took the item to have had nothing to move.
 */
describe("the chain scenarios, their requests interleaving at random", () => {
  const STEMS = ["foo", "alpha", "kappa"]
  for (const scenario of RekeyChains.chainScenarios) {
    for (const segments of [1, 3]) {
      it.effect(
        `${scenario.name}, ${segments} segment(s)`,
        () =>
          Effect.gen(function* () {
            for (const stem of STEMS) {
              for (let jitter = 1; jitter <= 12; jitter++) {
                const table = makeRecordingTable()
                const client = gatedLayer(
                  table.client as DynamoClientService,
                  jittered(jitter * 31 + stem.length),
                )
                const on = (member: RekeyChains.ChainWorld) =>
                  Layer.merge(client, member.MainTable.layer({ name: "t" }))
                const harness: RekeyChains.Harness = {
                  on: (world, body) =>
                    body({
                      seed: (row) =>
                        Effect.sync(() => {
                          table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
                        }),
                      remove: (row) =>
                        Effect.sync(() => {
                          table.items.delete(`${row.pk!.S}|${row.sk!.S}`)
                        }),
                      rows: () => Effect.sync(() => [...table.items.values()]),
                      as: (member, effect) => effect.pipe(Effect.provide(on(member))) as never,
                    }).pipe(Effect.provide(on(world))) as never,
                }
                yield* scenario.run(
                  harness,
                  RekeyChains.chainOf(scenario.escapeKeys, stem),
                  segments,
                )
              }
            }
          }),
        60_000,
      )
    }
  }
})
