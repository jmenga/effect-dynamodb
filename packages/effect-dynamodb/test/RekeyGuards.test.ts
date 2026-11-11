/**
 * `rekey`'s guards against what the published 1.39.0 sent and kept
 * (`fixtures/rekey-guards-1.39.0.json`, from `helpers/RekeyGuards.ts`).
 *
 * - **A row with nothing absent to guard is guarded as 1.39.0 guarded it**, byte for byte: the
 *   whole-row guard is 1.39.0's, `updatedAt` first, with each attribute a write could add appended.
 *   So is a timestamped aggregate's row too wide to guard whole, with no room left for one.
 * - **A stamp or a version stored under another name is guarded by that name**, so an update that
 *   lands between `rekey`'s read and its move cancels the move, as on 1.39.0.
 * - **An aggregate or event stream already part-moved is finished**, under the strongest guard that
 *   fits, as on 1.39.0: left across two partitions, a read under either key text misses rows.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import { CASES, capture, type Outcome } from "./helpers/RekeyGuards.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/rekey-guards-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Outcome> }

it("the fixture holds every case", () => {
  expect(Object.keys(fixture.cases)).toEqual([...CASES])
})

describe("rekey ends as on 1.39.0", () => {
  for (const name of CASES) {
    it.effect(name, () =>
      Effect.gen(function* () {
        expect(yield* capture(Lib as never, name)).toEqual(fixture.cases[name])
      }),
    )
  }
})
