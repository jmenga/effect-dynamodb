/**
 * `EDD-9140`: an entity may not store, under any name other than as that map's entry, an attribute
 * a row's reader takes as an entry of one of its sparse maps. A key attribute so named is in
 * `LibraryAttributes.test.ts`. These are the rest of what an entity writes under a name a
 * definition or a table's configuration supplies: a model field by the attribute it's stored in,
 * the timestamps, the version, and the table's TTL attribute.
 *
 * For each, `fixtures/sparse-library-attributes-1.39.0.json` holds the rows the published 1.39.0
 * stored and what it read back (`helpers/SparseLibraryAttributes.ts`): a row it can't read, an
 * attribute read as an entry, or a TTL that's never stored. The definition is now refused, when the
 * entity is made or, for the TTL attribute, which the table's configuration names, when the table
 * is bound. The same definition under a name outside the map's prefix loads and reads back. So
 * does a field whose name is in the prefix and whose attribute isn't (`data#x#y` stored as
 * `counter`, in `SparseEntries.test.ts`): the stored name decides.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { refuseReadAsSparseEntry } from "@effect-dynamodb/schema/internal/SharedKeyAttribute.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { afterEach, beforeEach, vi } from "vitest"
import * as Lib from "../src/index.js"
import {
  type Captured,
  capture,
  cases,
  loads,
  primaryKey,
} from "./helpers/SparseLibraryAttributes.js"

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/sparse-library-attributes-1.39.0.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly cases: Record<string, Captured>
  readonly loads: Record<string, Captured>
}

beforeEach(() => {
  // The record was captured with the clock and the random bytes fixed.
  vi.spyOn(Date, "now").mockReturnValue(1700000000000)
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    ;(array as Uint8Array).fill(7)
    return array
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

const value = (captured: Captured): any =>
  "value" in captured.read ? captured.read.value : undefined

/** What 1.39.0 made of each definition's rows. */
const ON_1_39_0: Record<string, (captured: Captured, attribute: string) => void> = {
  "the created timestamp": (captured, attribute) => {
    expect(captured.rows[0]).toHaveProperty([attribute])
    expect(captured.read).toEqual({ failed: "ValidationError" })
  },
  "the updated timestamp": (captured, attribute) => {
    expect(captured.rows[0]).toHaveProperty([attribute])
    expect(captured.read).toEqual({ failed: "ValidationError" })
  },
  // The version is read as the entry `v`, and the row's version as 0.
  "the version": (captured, attribute) => {
    expect(captured.rows[0]).toHaveProperty([attribute], { N: "1" })
    expect(value(captured)).toEqual({ id: "a", data: { v: 1, ok: 1 }, [attribute]: 0 })
  },
  "a field renamed into the map's prefix": (captured, attribute) => {
    expect(captured.rows[0]).toHaveProperty([attribute], { N: "7" })
    expect(captured.read).toEqual({ failed: "ValidationError" })
  },
  "a field named in the map's prefix": (captured, attribute) => {
    expect(captured.rows[0]).toHaveProperty([attribute], { N: "7" })
    expect(captured.read).toEqual({ failed: "ValidationError" })
  },
  // The whole map is read as the entry `shadow` of `data`, which holds numbers.
  "a sparse map a put stores whole": (captured, attribute) => {
    expect(captured.rows[0]).toHaveProperty([attribute], { M: { y: { N: "2" } } })
    expect(captured.read).toEqual({ failed: "ValidationError" })
  },
  // The snapshot's TTL is read as the entry `expires`.
  "the TTL of a retained version": (captured) => {
    expect(value(captured).data).toEqual({ ok: 1, expires: 1700086400 })
  },
  "the TTL of a soft-deleted row": (captured) => {
    expect(value(captured).data).toEqual({ ok: 1, expires: 1700086400 })
  },
  // The event's TTL is stripped with the map's entries, so the event never expires.
  "the TTL of a time series' event": (captured, attribute) => {
    expect(captured.rows).toHaveLength(2)
    for (const row of captured.rows) expect(row).not.toHaveProperty([attribute])
  },
}

describe("EDD-9140: an attribute an entity writes that a row's reader takes as a sparse map's entry", () => {
  it("every case has its record", () => {
    expect(Object.keys(fixture.cases)).toEqual(cases.map((each) => each.key))
    expect(Object.keys(ON_1_39_0)).toEqual(cases.map((each) => each.key))
  })

  for (const each of cases) {
    describe(each.key, () => {
      it(`1.39.0 stored "${each.attribute}" and couldn't read the row as written`, () => {
        ON_1_39_0[each.key]!(fixture.cases[each.key]!, each.attribute)
      })

      it.effect(`"${each.attribute}" is refused by ${each.refusedAt}`, () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(capture(Lib as never, each, each.attribute))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons[0]!._tag).toBe("Die")
            const message = String(Cause.squash(exit.cause))
            expect(message).toContain('[EDD-9140] Entity "Doc": sparse map "data"')
            expect(message).toContain(`a row's reader takes "${each.attribute}"`)
          }
          const make = () =>
            Lib.Entity.make({
              entityType: "Doc",
              primaryKey,
              ...each.entity(Lib as never, each.attribute),
            } as never)
          const pure = () =>
            PureEntity.make({
              entityType: "Doc",
              primaryKey,
              ...each.entity(Lib as never, each.attribute),
            } as never)
          if (each.refusedAt === "Entity.make") {
            expect(make).toThrow("[EDD-9140]")
            expect(pure).toThrow("[EDD-9140]")
          } else {
            // The table's configuration names the attribute, so the entity itself loads.
            expect(make).not.toThrow()
            expect(pure).not.toThrow()
          }
        }),
      )

      it.effect(`"${each.allowed}" in its place loads, and its rows read back`, () =>
        Effect.gen(function* () {
          const captured = yield* capture(Lib as never, each, each.allowed)
          expect("value" in captured.read).toBe(true)
          const read = value(captured)
          if (each.allowedReads !== undefined) expect(read).toMatchObject(each.allowedReads)
          else {
            const data = Array.isArray(read) ? read[0].data : read.data
            expect(data).toEqual(each.key === "the TTL of a time series' event" ? {} : { ok: 1 })
          }
          expect(captured.rows.some((row) => Object.hasOwn(row, each.allowed))).toBe(true)
        }),
      )
    })
  }

  // The names the check sees are the ones stored, and the TTL attribute counts only for an
  // entity that writes it.
  for (const each of loads) {
    // On the live clock, which is fixed as it was when the record was captured.
    it.live(`${each.key}: loads, and reads back as on 1.39.0`, () =>
      Effect.gen(function* () {
        const captured = yield* capture(Lib as never, each, each.attribute)
        expect(captured).toEqual(fixture.loads[each.key])
        expect("value" in captured.read).toBe(true)
        expect(() =>
          PureEntity.make({
            entityType: "Doc",
            primaryKey,
            ...each.entity(Lib as never, each.attribute),
          } as never),
        ).not.toThrow()
      }),
    )
  }

  it("a sparse map's prefix is checked as a name too, though `configure` lets none hold `#`", () => {
    const maps = { data: { prefix: "data" }, aux: { prefix: "data#shadow" } }
    expect(() =>
      refuseReadAsSparseEntry(
        "Doc",
        [
          {
            attribute: "data#shadow",
            what: 'the prefix the sparse map "aux" stores its entries under',
          },
        ],
        maps,
      ),
    ).toThrow('[EDD-9140] Entity "Doc": sparse map "data"')
    expect(() =>
      Lib.DynamoModel.configure(
        Schema.Struct({ id: Schema.String, aux: Schema.Record(Schema.String, Schema.Number) }),
        { aux: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "data#shadow" }) } },
      ),
    ).toThrow("must not contain '#'")
  })
})
