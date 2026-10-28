/**
 * Cursors (#171, design §10): plain queries keep the legacy bytes; a key the
 * legacy form can't carry, and every planned query, gets a `v2.` cursor that
 * names its plan. `startFrom` only records the cursor — a terminal decodes it
 * against the plan it must belong to, and anything else is `[EDD-9094]`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Cursor from "../src/internal/Cursor.js"
import { type ListingItem, makeListings, STORE } from "./helpers/ListingsFixture.js"
import { compareBytes, type Partition } from "./helpers/PartitionMock.js"
import * as ZListings from "./helpers/ZOrderListings.js"

const fixture = makeListings()

/** Three listings per status, prices 10 / 40 / 70. */
const items: Array<ListingItem> = ["active", "pending", "sold"].flatMap((status, s) =>
  [10, 40, 70].map((price, p) => ({ storeId: STORE, listingId: `l-${s}-${p}`, status, price })),
)

const PRICE = { gte: 20, lte: 50 }

const ids = (rows: ReadonlyArray<{ readonly listingId: string }>) =>
  rows.map((row) => row.listingId)

const run = <X>(
  f: (byStore: (pins: object) => any, partition: Partition) => Effect.Effect<X, unknown, any>,
  rows: ReadonlyArray<ListingItem> = items,
): Effect.Effect<X, unknown> => {
  const { partition, layer } = fixture.serve(rows)
  return Effect.gen(function* () {
    const listings = yield* fixture.listings
    return yield* f((pins) => listings.byStore(pins), partition)
  }).pipe(Effect.provide(layer)) as Effect.Effect<X, unknown>
}

/** The stored key attributes of a listing, as a `LastEvaluatedKey` holds them. */
const keyOf = (item: ListingItem) => {
  const row = fixture.rowOf(item)
  return { gsi1pk: row.gsi1pk!, gsi1sk: row.gsi1sk!, pk: row.pk!, sk: row.sk! }
}

/** The `[EDD-9094]` refusal a terminal fails with. */
const refusal = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.map(Effect.flip(effect), (error: any) => {
    expect(error._tag).toBe("ValidationError")
    expect(error.operation).toBe("query.startFrom")
    expect(String(error.cause)).toContain("[EDD-9094]")
    return String(error.cause)
  })

/** A real cursor of a skip-scan query, stopped inside its first tuple. */
const midTupleCursor = (byStore: (pins: object) => any) =>
  Effect.map(
    byStore({ storeId: STORE })
      .within({ price: { gte: 0 } })
      .limit(1)
      .fetch(),
    (page: any) => {
      const cursor = Cursor.decode(page.cursor!)!
      expect(cursor.s).toBe("skip-scan")
      expect(cursor.k).toBeDefined()
      return cursor
    },
  )

describe("cursor v2 (#171)", () => {
  it.effect("plain queries emit legacy cursor bytes", () =>
    run((byStore) =>
      Effect.gen(function* () {
        const page = yield* byStore({ storeId: STORE }).limit(2).fetch()
        expect(page.cursor!.startsWith("v2.")).toBe(false)
        // `btoa(JSON.stringify(key))`, exactly as 1.36 wrote it.
        const key = JSON.parse(atob(page.cursor!))
        expect(key).toEqual(keyOf(fixture.ordered(items)[1]!))
        expect(page.cursor).toBe(btoa(JSON.stringify(key)))
      }),
    ),
  )

  it.effect("v2 round-trip with non-Latin-1 key text", () => {
    // `btoa` throws above U+00FF: such a key now travels as `v2.` `{ k }`.
    const rows = items.map((item) => ({ ...item, listingId: `${item.listingId}-日本` }))
    return run(
      (byStore) =>
        Effect.gen(function* () {
          const plain = byStore({ storeId: STORE })
          const page = yield* plain.limit(2).fetch()
          expect(page.cursor!.startsWith("v2.")).toBe(true)
          const cursor = Cursor.decode(page.cursor!)!
          expect(cursor).toEqual({ v: 2, k: Cursor.keyToWire(keyOf(fixture.ordered(rows)[1]!)) })
          const rest = yield* plain.startFrom(page.cursor!).collect()
          expect(ids([...page.items, ...rest])).toEqual(ids(fixture.ordered(rows)))

          // A planned query's cursor carries the key text the same way.
          const planned = byStore({ storeId: STORE }).within({ price: PRICE })
          const first = yield* planned.limit(1).fetch()
          expect(Cursor.decode(first.cursor!)!.k!.gsi1sk).toEqual({
            S: fixture.skOf(fixture.ordered(rows).find((row) => row.price === 40)!),
          })
          const others = yield* planned.startFrom(first.cursor!).collect()
          expect(ids([...first.items, ...others])).toEqual(
            ids(fixture.ordered(rows).filter((row) => row.price === 40)),
          )
        }),
      rows,
    )
  })

  it("v2 round-trip with every field", () => {
    const bytes = new Uint8Array([0, 1, 0x7f, 0x80, 0xfe, 0xff])
    const envelopes: Array<Cursor.CursorV2> = [
      {
        v: 2,
        f: "0a1b2c3d",
        s: "skip-scan",
        t: { S: "$shop#v1#listing#status_ä#" },
        k: { gsi1pk: { S: "p" }, gsi1sk: { S: "s" }, n: { N: "42" }, b: { B: "AAF/gP7/" } },
      },
      { v: 2, f: "0a1b2c3d", s: "precise", t: { B: Cursor.toBase64(bytes) }, a: { B: "AAF/gP7/" } },
      { v: 2, f: "0a1b2c3d", s: "filter", t: { S: "t#" }, d: 1 },
      { v: 2, f: "0a1b2c3d", s: "key" },
      // A key pass (#171): the 1.36 key's, then the current key's.
      { v: 2, f: "0a1b2c3d", s: "key", p: 1, k: { pk: { S: "p" }, sk: { S: "s" } } },
      { v: 2, f: "0a1b2c3d", s: "key", p: 0 },
      { v: 2, k: { pk: { S: "日本" } } },
    ]
    for (const envelope of envelopes) {
      const text = Cursor.encodeV2(envelope)
      expect(text.startsWith("v2.")).toBe(true)
      // base64url: no `+`, `/` or padding.
      expect(/^v2\.[A-Za-z0-9_-]+$/.test(text)).toBe(true)
      expect(Cursor.decode(text)).toEqual(envelope)
    }
    // A `B` value comes back as its bytes.
    expect(Cursor.fromWire({ B: Cursor.toBase64(bytes) })).toEqual({ B: bytes })
    expect(Cursor.wireToKeyValue({ B: Cursor.toBase64(bytes) })).toEqual(bytes)
    // A shape no query writes is not a cursor.
    for (const malformed of [
      { v: 2, k: { pk: { S: "p" } }, d: 1 },
      { v: 3 },
      { v: 2, s: "sideways" },
      { v: 2, x: 1 },
      { v: 2, t: { S: 1 } },
      { v: 2, k: {} },
      { v: 2, s: "key", p: 2 },
      { v: 2, s: "key", p: "1" },
    ]) {
      expect(Cursor.decode(Cursor.encodeV2(malformed as any))).toBeUndefined()
    }
  })

  it.effect("v2 round-trip with B: a Z-order key, address and skip tuple", () => {
    const listings = ZListings.randomZListings(33, 120)
    const rows = ZListings.storedRows(listings)
    const bytesOf = new Map(listings.map((l, i) => [l.listingId, rows[i]!]))
    const order = (sk: string, picked: ReadonlyArray<ZListings.ZListing>) =>
      [...picked]
        .sort(
          (a, b) =>
            compareBytes(bytesOf.get(a.listingId)![sk]!.B!, bytesOf.get(b.listingId)![sk]!.B!) ||
            (a.listingId < b.listingId ? -1 : 1),
        )
        .map((l) => l.listingId)
    const serve = <X, E>(
      accessor: ZListings.Accessor,
      f: (client: Effect.Success<typeof ZListings.listings>) => Effect.Effect<X, E>,
    ) => {
      const { layer } = ZListings.servePartition(accessor, rows)
      return Effect.flatMap(ZListings.listings, f).pipe(Effect.provide(layer))
    }
    return Effect.gen(function* () {
      // Unplanned: the LastEvaluatedKey's binary sort key travels as `{ B }`.
      yield* serve("byFacets", (client) =>
        Effect.gen(function* () {
          const plain = client.byFacets({ region: ZListings.REGION })
          const page = yield* plain.limit(5).fetch()
          const cursor = Cursor.decode(page.cursor!)!
          expect(Object.keys(cursor)).toEqual(["v", "k"])
          const sk = Cursor.wireToKeyValue(cursor.k!.gsi1sk!)
          expect(sk).toEqual(bytesOf.get(page.items[4]!.listingId)!.gsi1sk!.B)
          const rest = yield* plain.startFrom(page.cursor!).collect()
          expect(ZListings.ids([...page.items, ...rest])).toEqual(ZListings.ids(listings))
          expect([...page.items, ...rest].map((l) => l.listingId)).toEqual(
            order("gsi1sk", listings),
          )
        }),
      )
      // Planned: `k` (stopped inside a page) and `a` (at a range end) as `{ B }`.
      yield* serve("byFacets", (client) =>
        Effect.gen(function* () {
          const query = client
            .byFacets({ region: ZListings.REGION })
            .within({ price: { lte: 700 }, bedrooms: { gte: 3 } })
            .zorder({ strategy: "precise", maxRanges: 4 })
          const want = order(
            "gsi1sk",
            listings.filter((l) => l.price <= 700 && l.bedrooms >= 3),
          )
          const seen = new Set<string>()
          for (let limit = 1; limit <= want.length; limit++) {
            let cursor: string | null | undefined
            const got: Array<string> = []
            while (cursor !== null) {
              const page = yield* (cursor === undefined ? query : query.startFrom(cursor))
                .limit(limit)
                .fetch()
              got.push(...page.items.map((l) => l.listingId))
              cursor = page.cursor
              if (cursor !== null) {
                const decoded = Cursor.decode(cursor)!
                expect(decoded.s).toBe("precise")
                if (decoded.k !== undefined) {
                  expect("B" in decoded.k.gsi1sk!).toBe(true)
                  seen.add("k")
                }
                if (decoded.a !== undefined) {
                  expect("B" in decoded.a).toBe(true)
                  seen.add("a")
                }
              }
            }
            expect(got).toEqual(want)
          }
          expect([...seen].sort()).toEqual(["a", "k"])
        }),
      )
      // A binary skip tuple: `t` as `{ B }`, the prefix segments of one agency and office.
      yield* serve("byAgency", (client) =>
        Effect.gen(function* () {
          const query = client
            .byAgency({ region: ZListings.REGION })
            .within({ price: { gte: 200 } })
          const first = yield* query.limit(2).fetch()
          const cursor = Cursor.decode(first.cursor!)!
          expect(cursor.s).toBe("skip-scan")
          const tuple = Cursor.wireToKeyValue(cursor.t!)
          expect(tuple).toBeInstanceOf(Uint8Array)
          const stored = bytesOf.get(first.items[0]!.listingId)!.gsi2sk!.B!
          expect(stored.subarray(0, (tuple as Uint8Array).length)).toEqual(tuple)
          const rest = yield* query.startFrom(first.cursor!).collect()
          expect([...first.items, ...rest].map((l) => l.listingId)).toEqual(
            order(
              "gsi2sk",
              listings.filter((l) => l.price >= 200),
            ),
          )
        }),
      )
    })
  })

  it.effect("a legacy cursor resumes as At", () =>
    run((byStore, partition) =>
      Effect.gen(function* () {
        const ordered = fixture.ordered(items)
        const legacy = btoa(JSON.stringify(keyOf(ordered[1]!)))
        // On a plain query: the key is the ExclusiveStartKey.
        const rest = yield* byStore({ storeId: STORE }).startFrom(legacy).collect()
        expect(ids(rest)).toEqual(ids(ordered.slice(2)))
        expect((partition.inputs[0] as any).ExclusiveStartKey).toEqual(keyOf(ordered[1]!))

        // On a `.within()` key plan, when the key lies in its range.
        partition.clear()
        const statuses = { status: { gte: "active", lte: "pending" } }
        const planned = byStore({ storeId: STORE }).within(statuses)
        expect((yield* planned.explain()).plan).toBe("key")
        const resumed = yield* planned.startFrom(legacy).collect()
        expect(ids(resumed)).toEqual(ids(ordered.slice(2).filter((item) => item.status !== "sold")))
        expect((partition.inputs[0] as any).ExclusiveStartKey).toEqual(keyOf(ordered[1]!))
      }),
    ),
  )

  it.effect("decoding is deferred: startFrom before or after within is the same", () =>
    run((byStore, partition) =>
      Effect.gen(function* () {
        const cursor = Cursor.encodeV2(yield* midTupleCursor(byStore))
        partition.clear()
        const after = yield* byStore({ storeId: STORE })
          .within({ price: { gte: 0 } })
          .startFrom(cursor)
          .collect()
        const afterInputs = [...partition.inputs]
        partition.clear()
        const before = yield* byStore({ storeId: STORE })
          .startFrom(cursor)
          .within({ price: { gte: 0 } })
          .collect()
        expect(ids(before)).toEqual(ids(after))
        expect(partition.inputs).toEqual(afterInputs)
        expect(ids(after)).toEqual(ids(fixture.ordered(items).slice(1)))
      }),
    ),
  )

  it.effect("a malformed cursor fails the terminal with EDD-9094, not startFrom", () =>
    run((byStore, partition) =>
      Effect.gen(function* () {
        for (const text of ["%%%", "v2.%%%", btoa("[1,2]"), btoa('{"pk":{"X":"1"}}'), "v2."]) {
          // Recording the cursor never throws…
          const plain = byStore({ storeId: STORE }).startFrom(text)
          const planned = byStore({ storeId: STORE }).within({ price: PRICE }).startFrom(text)
          // …every terminal fails with the refusal, sending nothing.
          yield* refusal(plain.collect())
          yield* refusal(plain.fetch())
          yield* refusal(plain.count())
          yield* refusal(planned.collect())
          yield* refusal(planned.fetch())
          yield* refusal(planned.count())
        }
        expect(partition.inputs).toEqual([])
      }),
    ),
  )

  it.effect("EDD-9094: fingerprint mismatch", () =>
    run((byStore) =>
      Effect.gen(function* () {
        const cursor = Cursor.encodeV2(yield* midTupleCursor(byStore))
        // Other bounds, or the other direction, is another plan.
        const why = yield* refusal(
          byStore({ storeId: STORE })
            .within({ price: { gte: 1 } })
            .startFrom(cursor)
            .collect(),
        )
        expect(why).toContain("fingerprint")
        yield* refusal(
          byStore({ storeId: STORE })
            .within({ price: { gte: 0 } })
            .reverse()
            .startFrom(cursor)
            .collect(),
        )
        // Another partition is another plan too.
        yield* refusal(
          byStore({ storeId: "store-2" })
            .within({ price: { gte: 0 } })
            .startFrom(cursor)
            .collect(),
        )
      }),
    ),
  )

  it.effect("EDD-9094: legacy cursor for a skip-scan plan", () =>
    run((byStore) =>
      Effect.gen(function* () {
        const page = yield* byStore({ storeId: STORE }).limit(2).fetch()
        const why = yield* refusal(
          byStore({ storeId: STORE }).within({ price: PRICE }).startFrom(page.cursor!).collect(),
        )
        expect(why).toContain("without .within()")
      }),
    ),
  )

  it.effect("EDD-9094: v2 planner cursor on a plain query", () =>
    run((byStore) =>
      Effect.gen(function* () {
        const cursor = Cursor.encodeV2(yield* midTupleCursor(byStore))
        const why = yield* refusal(byStore({ storeId: STORE }).startFrom(cursor).collect())
        expect(why).toContain("with .within()")
      }),
    ),
  )

  it.effect("EDD-9094: k outside the recomputed plan", () =>
    run((byStore) =>
      Effect.gen(function* () {
        const cursor = yield* midTupleCursor(byStore)
        // A key in the next tuple, while the cursor says the first.
        const elsewhere = fixture.ordered(items).find((item) => item.status === "pending")!
        const forged = Cursor.encodeV2({ ...cursor, k: Cursor.keyToWire(keyOf(elsewhere))! })
        const why = yield* refusal(
          byStore({ storeId: STORE })
            .within({ price: { gte: 0 } })
            .startFrom(forged)
            .collect(),
        )
        expect(why).toContain("outside the recomputed plan")
      }),
    ),
  )

  it.effect("EDD-9094: t not under P", () =>
    run((byStore) =>
      Effect.gen(function* () {
        const cursor = yield* midTupleCursor(byStore)
        for (const t of ["$shop#v1#order#status_active#", "$shop#v1#listing#price_1#"]) {
          const forged = Cursor.encodeV2({ ...cursor, t: { S: t } })
          const why = yield* refusal(
            byStore({ storeId: STORE })
              .within({ price: { gte: 0 } })
              .startFrom(forged)
              .collect(),
          )
          expect(why).toContain("skip tuple is not one of this plan's")
        }
      }),
    ),
  )
})
