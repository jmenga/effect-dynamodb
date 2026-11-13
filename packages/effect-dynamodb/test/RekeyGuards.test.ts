/**
 * `rekey`'s guards against what the published 1.39.0 sent and kept
 * (`fixtures/rekey-guards-1.39.0.json`, from `helpers/RekeyGuards.ts`).
 *
 * - **A row with nothing absent to guard is guarded as 1.39.0 guarded it**, byte for byte: the
 *   whole-row guard is 1.39.0's, `updatedAt` first, with each attribute a write could add appended.
 *   So is a timestamped aggregate's row too wide to guard whole, with no room left for one.
 * - **An entity whose stamps are stored under other names sends 1.39.0's requests**, for `rekey`'s
 *   move and for a delete, byte for byte.
 * - **A wide row's stamp or version stored under another name is guarded by the attribute it's
 *   stored in**, so an update that lands between `rekey`'s read and its move cancels the move, as on
 *   1.39.0.
 * - **An aggregate or event stream already part-moved is finished**, under the strongest guard that
 *   fits, as on 1.39.0: left across two partitions, a read under either key text misses rows.
 * - **A timestamped aggregate's row too wide to guard whole, whose node declares its own
 *   `updatedAt` as a string, is left, reported `unguarded`, with writes going on.** The caller's
 *   value is stored there and an update leaves it as it was, so it proves nothing of the row. 1.39.0
 *   stored its stamp over the value: declared required, it couldn't read the aggregate back and
 *   reported it `failed`, moving nothing; declared optional, it read the value back absent, and its
 *   stamp guarded the move.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import { CASES, capture, guardGapsOf, type Outcome } from "./helpers/RekeyGuards.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/rekey-guards-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Outcome> }

it("the fixture holds every case", () => {
  expect(Object.keys(fixture.cases)).toEqual([...CASES])
})

const REQUIRED =
  "aggregate, timestamps, a wide row whose node declares updatedAt a string: an update lands before the move"
const OPTIONAL =
  "aggregate, timestamps, a wide row whose node declares updatedAt an optional string: an update lands before the move"

describe("rows moved under a guard that can miss a write are reported, writes going on", () => {
  // A wide row guarded on its `updatedAt`, and a part-moved aggregate or stream finished under the
  // strongest guard that fits. The rest are guarded whole, or by their version, or left as they are.
  const counted: Partial<Record<(typeof CASES)[number], { stamp?: number; strongest?: number }>> = {
    "aggregate, timestamps, a row too wide to guard whole: the move's requests": { stamp: 1 },
    "wide entity, updatedAt stored as zzTime: an update lands before the move": { stamp: 1 },
    "aggregate part-moved: an update adds a wide row before the root's move": { strongest: 1 },
    "aggregate part-moved by a run cut short: an update adds a wide row, and rekey runs again": {
      strongest: 1,
    },
    "stream flipped by a run cut short: a wide event lands under its old key, and rekey runs again":
      { strongest: 1 },
  }
  for (const name of CASES) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const { rows, ...counts } = (yield* guardGapsOf(Lib as never, name)) as {
          readonly rows: ReadonlyArray<{ readonly gap: string }>
        }
        const expected = { stamp: 0, sparse: 0, strongest: 0, ...counted[name] }
        expect(counts).toEqual(expected)
        // Each row counted is named, once, with its stored key and the key it moved to.
        expect(rows.map((row) => row.gap).sort()).toEqual(
          Object.entries(expected).flatMap(([gap, n]) => Array.from({ length: n }, () => gap)),
        )
        for (const row of rows) {
          expect(row).toEqual({
            member: expect.any(String),
            kind: expect.stringMatching(/^(item|aggregate|stream)$/),
            gap: row.gap,
            key: { pk: expect.any(String), sk: expect.any(String) },
            target: { pk: expect.any(String), sk: expect.any(String) },
          })
        }
      }),
    )
  }
})

describe("rekey ends as on 1.39.0", () => {
  for (const name of CASES) {
    if (name === REQUIRED || name === OPTIONAL) continue
    it.effect(name, () =>
      Effect.gen(function* () {
        expect(yield* capture(Lib as never, name)).toEqual(fixture.cases[name])
      }),
    )
  }
})

describe("a wide aggregate row holding the caller's updatedAt is left, reported, with writes going on", () => {
  // Nothing is written, so the update can't land: the aggregate reads as the caller wrote it.
  const left = {
    moved: {},
    conflicts: [
      {
        reason: "unguarded",
        key: { pk: "$guards#v1#orders#a b", sk: "$guards#v1#line#one" },
      },
    ],
    read: "the caller's",
    unchanged: true,
    kept: false,
  }
  it.effect("declared required: 1.39.0 couldn't read it, and reported it failed", () =>
    Effect.gen(function* () {
      expect(fixture.cases[REQUIRED]).toEqual({
        moved: {},
        conflicts: [
          { reason: "failed", key: { pk: "$guards#v1#orders#a b", sk: "$guards#v1#order" } },
        ],
        read: "unreadable",
        unchanged: true,
        kept: false,
      })
      expect(yield* capture(Lib as never, REQUIRED)).toEqual(left)
    }),
  )
  it.effect("declared optional: 1.39.0 read the caller's value back absent", () =>
    Effect.gen(function* () {
      expect(fixture.cases[OPTIONAL]).toEqual({
        moved: { aggregate: 2 },
        conflicts: [],
        read: null,
        unchanged: false,
        kept: true,
      })
      expect(yield* capture(Lib as never, OPTIONAL)).toEqual(left)
    }),
  )
})
