/**
 * Skip-scan over a composite sort key (#171, design §7): `.within()` bounds a
 * composite behind an unbounded one, and the query probes for each distinct
 * value of the unbounded composites (the skip tuple), then reads that tuple's
 * range.
 *
 * Every case is checked against the partition read whole and filtered in
 * JavaScript: a skip-scan returns exactly the rows a filter over the whole
 * partition returns, in index order.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema, Stream } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { ZOrder } from "../src/index.js"
import * as Cursor from "../src/internal/Cursor.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import {
  inBound,
  type ListingItem,
  type Listings,
  makeListings,
  type PriceBound,
  random,
  randomBound,
  randomListings,
  STORE,
} from "./helpers/ListingsFixture.js"
import { compareBytes, makePartition, type Partition, type Row } from "./helpers/PartitionMock.js"
import { capturePuts } from "./helpers/ZOrderListings.js"

const ids = (items: ReadonlyArray<{ readonly listingId: string }>) =>
  items.map((item) => item.listingId)

/** Run `f` over the accessor of `fixture`, served `items` (plus `extraRows`). */
const over = <X>(
  fixture: Listings,
  items: ReadonlyArray<ListingItem>,
  f: (accessor: (pins: object) => any, partition: Partition) => Effect.Effect<X, unknown, any>,
  extraRows: ReadonlyArray<Row> = [],
): Effect.Effect<X, unknown> => {
  const { partition, layer } = fixture.serve(items, extraRows)
  return Effect.gen(function* () {
    const listings = yield* fixture.listings
    return yield* f((pins) => listings[fixture.accessor](pins), partition)
  }).pipe(Effect.provide(layer)) as Effect.Effect<X, unknown>
}

/** A request's sort key `BETWEEN` operands, if it sent one. */
const betweenOf = (input: any): readonly [string, string] | undefined => {
  const match = /#sk BETWEEN (:\w+) AND (:\w+)/.exec(input.KeyConditionExpression ?? "")
  if (!match) return undefined
  return [
    input.ExpressionAttributeValues[match[1]!].S,
    input.ExpressionAttributeValues[match[2]!].S,
  ] as const
}

const isProbe = (input: any) => input.ProjectionExpression === "#sk" && input.Limit === 1

/** The skip tuple of a sort key: its text through the delimiter before `price`. */
const tupleText = (sk: string) => sk.slice(0, sk.search(/#price_/i) + 1)

/** Every page of a `fetch` chain, from the start. */
const fetchAll = (query: any) =>
  Effect.gen(function* () {
    const pages: Array<{ readonly items: Array<any>; readonly cursor: string | null }> = []
    let cursor: string | null | undefined
    while (cursor !== null) {
      const page = yield* (cursor === undefined ? query : query.startFrom(cursor)).fetch()
      pages.push(page)
      cursor = page.cursor
      if (pages.length > 500) return yield* Effect.die(new Error("the fetch chain did not end"))
    }
    return pages
  })

/** Record every request event. */
const recorder = () => {
  const events: Array<Query.QueryRequestEvent> = []
  return {
    events,
    observe: (event: Query.QueryRequestEvent) => Effect.sync(() => void events.push(event)),
  }
}

/** Three listings per status, prices 10 / 40 / 70. */
const grid = (statuses: ReadonlyArray<string>): Array<ListingItem> =>
  statuses.flatMap((status, s) =>
    [10, 40, 70].map((price, p) => ({ storeId: STORE, listingId: `l-${s}-${p}`, status, price })),
  )

const expected = (
  fixture: Listings,
  items: ReadonlyArray<ListingItem>,
  bound: PriceBound,
  reverse = false,
) => ids(fixture.ordered(items, reverse).filter((item) => inBound(bound, item.price)))

const PRICE: PriceBound = { gte: 20, lte: 50 }

describe("skip-scan (#171)", () => {
  it.effect("results equal a filtered full read for random partitions", () =>
    Effect.gen(function* () {
      const fixture = makeListings()
      const statuses = ["active", "pending", "sold"] as const
      for (let seed = 1; seed <= 40; seed++) {
        const next = random(seed * 7919)
        const items = randomListings(seed, Math.floor(next() * 60))
        const bound = randomBound(next)
        const reverse = next() < 0.3
        // Sometimes also bound the leading composite: an eq extends the
        // prefix (a key plan); a range takes the key condition, leaving the
        // price to the row check.
        const roll = next()
        const statusBound =
          roll < 0.6
            ? undefined
            : roll < 0.8
              ? { eq: statuses[Math.floor(next() * 3)]! }
              : { gte: "b", lte: "q" }
        const statusOk = (status: string) =>
          statusBound === undefined
            ? true
            : "eq" in statusBound
              ? status === statusBound.eq
              : status >= statusBound.gte && status <= statusBound.lte
        const want = ids(
          fixture
            .ordered(items, reverse)
            .filter((item) => statusOk(item.status) && inBound(bound, item.price)),
        )
        const limit = 1 + Math.floor(next() * 7)
        const pageSize = next() < 0.5 ? undefined : 1 + Math.floor(next() * 5)
        const context = JSON.stringify({ seed, bound, statusBound, reverse, limit, pageSize })

        const got = yield* over(fixture, items, (byStore) =>
          Effect.gen(function* () {
            let query = byStore({ storeId: STORE }).within(
              statusBound === undefined ? { price: bound } : { status: statusBound, price: bound },
            )
            if (reverse) query = query.reverse()
            if (pageSize !== undefined) query = query.pageSize(pageSize)
            const pages = yield* fetchAll(query.limit(limit))
            return {
              collected: ids(yield* query.collect()),
              streamed: ids((yield* Stream.runCollect(query.paginate())) as Array<ListingItem>),
              counted: yield* query.count(),
              chained: ids(pages.flatMap((page) => page.items)),
              plan: (yield* query.explain()).plan,
            }
          }),
        )
        expect(got.collected, context).toEqual(want)
        expect(got.streamed, context).toEqual(want)
        expect(got.counted, context).toBe(want.length)
        expect(got.chained, context).toEqual(want)
        expect(got.plan, context).toBe(statusBound === undefined ? "skip-scan" : "key")
      }
    }),
  )

  it.effect("probe count = distinct tuples + 1", () => {
    const fixture = makeListings()
    const items = grid(["active", "pending", "sold"])
    const { events, observe } = recorder()
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE }).within({ price: PRICE }).onRequest(observe)
        expect(ids(yield* query.collect())).toEqual(expected(fixture, items, PRICE))
        const probes = partition.inputs.filter(isProbe)
        expect(probes).toHaveLength(4)
        expect(events.map((event) => event.kind)).toEqual([
          "probe",
          "read",
          "probe",
          "read",
          "probe",
          "read",
          "probe",
        ])
        // A probe sends no FilterExpression, so `Limit: 1` finds a row
        // whenever one is in range.
        for (const probe of probes) expect((probe as any).FilterExpression).toBeUndefined()
        // Each tuple read examines only its tuple's rows in the price range:
        // one per status here, fewer than the partition's nine.
        const read = events.filter((event) => event.kind === "read")
        expect(read.reduce((sum, event) => sum + event.scannedCount, 0)).toBe(3)
        // Probes walk forward from P, then past each tuple.
        const [first, ...rest] = probes.map((probe) => betweenOf(probe)!)
        const P = tupleText(fixture.skOf(items[0]!)).replace(/status_[^#]*#$/, "")
        expect(first).toEqual([P, `${P}￿`])
        expect(rest.map(([lower]) => lower.endsWith("$"))).toEqual([true, true, true])
      }),
    )
  })

  it.effect("casings lowercase / uppercase / preserve", () =>
    Effect.gen(function* () {
      const statuses = ["Active", "pending", "SOLD"]
      for (const casing of ["lowercase", "uppercase", "preserve"] as const) {
        const fixture = makeListings({ statuses, casing })
        const items = grid(statuses)
        const got = yield* over(fixture, items, (byStore, partition) =>
          Effect.gen(function* () {
            const query = byStore({ storeId: STORE }).within({ price: PRICE })
            return {
              plan: (yield* query.explain()).plan,
              items: ids(yield* query.collect()),
              reversed: ids(yield* query.reverse().collect()),
              probes: partition.inputs.filter(isProbe).length,
            }
          }),
        )
        expect(got.plan, casing).toBe("skip-scan")
        expect(got.items, casing).toEqual(expected(fixture, items, PRICE))
        expect(got.reversed, casing).toEqual(expected(fixture, items, PRICE, true))
        // Forward and reverse: three tuples each, plus the probe that finds none.
        expect(got.probes, casing).toBe(8)
      }
    }),
  )

  it.effect("values with characters below #", () => {
    // ` ` (0x20), `!` (0x21) and `"` (0x22) are escaped (`a%20b#…`, `a%21#…`),
    // so each tuple sorts after `a#…` as its value after `a`: each still
    // parses, and the probe past it lands on the next.
    const statuses = ["a", "a b", "a!", 'a"', "on hold"]
    const fixture = makeListings({ statuses })
    const items = grid(statuses)
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE }).within({ price: PRICE })
        expect((yield* query.explain()).plan).toBe("skip-scan")
        expect(ids(yield* query.collect())).toEqual(expected(fixture, items, PRICE))
        expect(partition.inputs.filter(isProbe)).toHaveLength(statuses.length + 1)
        partition.clear()
        expect(ids(yield* query.reverse().collect())).toEqual(expected(fixture, items, PRICE, true))
        expect(partition.inputs.filter(isProbe)).toHaveLength(statuses.length + 1)
      }),
    )
  })

  it.effect("a Schema.String tuple composite skip-scans, whatever its values hold", () => {
    // A free-text composite's key text is escaped (#171): `on#hold` is
    // `on%23hold`, so no value holds the delimiter and every tuple parses
    // from the key. Up to 1.36's key text this took the filter plan.
    const statuses = ["active", "on#hold", "on hold", "on", "on!", "50%", "sold"]
    const fixture = makeListings({ statuses, status: Schema.String })
    const items = grid(statuses)
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE }).within({ price: PRICE })
        const explain = yield* query.explain()
        expect(explain.plan).toBe("skip-scan")
        expect(explain.reason).toBe("skip tuple: status")
        expect(ids(yield* query.collect())).toEqual(expected(fixture, items, PRICE))
        expect(partition.inputs.filter(isProbe)).toHaveLength(statuses.length + 1)
        partition.clear()
        expect(ids(yield* query.reverse().collect())).toEqual(expected(fixture, items, PRICE, true))
        expect(partition.inputs.filter(isProbe)).toHaveLength(statuses.length + 1)
      }),
    )
  })

  it.effect("a primary accessor with history rows takes the filter plan", () => {
    // A version snapshot shares the partition under a key no tuple parse
    // reads, so the plan reads all of P and drops history rows as any
    // primary-key query does.
    const fixture = makeListings({ on: "primary", versioned: true })
    const items = grid(["active", "pending", "sold"])
    const history = items.map((item) => fixture.historyRowOf(item, 1))
    return over(
      fixture,
      items,
      (primary, partition) =>
        Effect.gen(function* () {
          const query = primary({ storeId: STORE }).within({ price: PRICE })
          const explain = yield* query.explain()
          expect(explain.index).toBe("primary")
          expect(explain.plan).toBe("filter")
          expect(explain.reason).toBe("history rows on the primary index")
          expect(ids(yield* query.collect())).toEqual(expected(fixture, items, PRICE))
          expect(yield* query.count()).toBe(expected(fixture, items, PRICE).length)
          expect(partition.inputs.filter(isProbe)).toHaveLength(0)
        }),
      history,
    )
  })

  it.effect("maxSkips fallback mid-way", () => {
    const statuses = ["a", "b", "c", "d", "e"]
    const fixture = makeListings({ statuses })
    const items = grid(statuses)
    const { events, observe } = recorder()
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE })
          .within({ price: PRICE }, { maxSkips: 2 })
          .onRequest(observe)
        const explain = yield* query.explain()
        expect(explain.plan).toBe("skip-scan")
        expect(explain.maxSkips).toBe(2)
        expect(ids(yield* query.collect())).toEqual(expected(fixture, items, PRICE))
        // Two probes and their tuples, then the rest of P in one filtered read.
        expect(events.map((event) => event.kind)).toEqual([
          "probe",
          "read",
          "probe",
          "read",
          "read",
        ])
        const last = partition.inputs[partition.inputs.length - 1]!
        const [lower, upper] = betweenOf(last)!
        expect(lower).toBe(`${tupleText(fixture.skOf(items[3]!)).slice(0, -1)}$`)
        expect(upper.endsWith("￿")).toBe(true)
        // The filter read checks the price on every row it examines.
        expect(events[4]!.scannedCount).toBe(9)
        expect(events[4]!.accepted).toBe(3)
      }),
    )
  })

  it.effect("an explicit maxSkips: undefined keeps the default budget", () => {
    // Typed code under exactOptionalPropertyTypes can pass a possibly-undefined value.
    const maxSkips: number | undefined = undefined
    const fixture = makeListings()
    const items = grid(["active", "pending", "sold"])
    return over(fixture, items, (byStore) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE }).within({ price: PRICE }, { maxSkips })
        const explain = yield* query.explain()
        expect(explain.plan).toBe("skip-scan")
        expect(explain.maxSkips).toBe(32)
        expect(ids(yield* query.collect())).toEqual(expected(fixture, items, PRICE))
      }),
    )
  })

  it.effect("maxSkips: 0", () => {
    const fixture = makeListings()
    const items = grid(["active", "pending", "sold"])
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE }).within({ price: PRICE }, { maxSkips: 0 })
        const explain = yield* query.explain()
        expect(explain.plan).toBe("filter")
        expect(explain.reason).toBe("maxSkips: 0")
        expect(explain.maxSkips).toBeUndefined()
        expect(explain.rowChecks).toEqual(["price"])
        expect(ids(yield* query.collect())).toEqual(expected(fixture, items, PRICE))
        expect(partition.inputs).toHaveLength(1)
        expect(partition.inputs.filter(isProbe)).toHaveLength(0)
      }),
    )
  })

  it.effect("resume mid-skip and mid-fallback keeps the plan", () => {
    const statuses = ["a", "b", "c", "d", "e"]
    const fixture = makeListings({ statuses })
    // Status `a` has one listing in range, the others three.
    const items: Array<ListingItem> = [
      { storeId: STORE, listingId: "a-0", status: "a", price: 30 },
      { storeId: STORE, listingId: "a-1", status: "a", price: 90 },
      ...statuses.slice(1).flatMap((status) =>
        [20, 30, 40, 90].map((price) => ({
          storeId: STORE,
          listingId: `${status}-${price}`,
          status,
          price,
        })),
      ),
    ]
    const want = expected(fixture, items, PRICE)
    return over(fixture, items, (byStore) =>
      Effect.gen(function* () {
        // Mid-skip: every cursor resumes inside (or after) a tuple, as skip-scan.
        const skipping = yield* fetchAll(
          byStore({ storeId: STORE }).within({ price: PRICE }).limit(2),
        )
        expect(ids(skipping.flatMap((page) => page.items))).toEqual(want)
        const skipCursors = skipping.flatMap((page) =>
          page.cursor === null ? [] : [Cursor.decode(page.cursor)!],
        )
        expect(skipCursors.map((cursor) => cursor.s)).toEqual(skipCursors.map(() => "skip-scan"))
        expect(skipCursors.some((cursor) => cursor.k !== undefined && cursor.t !== undefined)).toBe(
          true,
        )
        expect(new Set(skipCursors.map((cursor) => cursor.f)).size).toBe(1)

        // Mid-fallback: one probe, then the filter plan — and every later
        // cursor stays filter, though each call has a fresh probe budget.
        const falling = yield* fetchAll(
          byStore({ storeId: STORE }).within({ price: PRICE }, { maxSkips: 1 }).limit(2),
        )
        expect(ids(falling.flatMap((page) => page.items))).toEqual(want)
        const modes = falling.flatMap((page) =>
          page.cursor === null ? [] : [Cursor.decode(page.cursor)!.s],
        )
        expect(modes[0]).toBe("filter")
        expect(new Set(modes)).toEqual(new Set(["filter"]))
      }),
    )
  })

  it.effect("reverse", () => {
    const fixture = makeListings()
    const items = randomListings(17, 45)
    const want = expected(fixture, items, PRICE, true)
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE }).within({ price: PRICE }).reverse()
        expect(ids(yield* query.collect())).toEqual(want)
        const probes = partition.inputs.filter(isProbe)
        expect(probes.every((probe) => (probe as any).ScanIndexForward === false)).toBe(true)
        // The first probe spans P; each later one ends at the tuple just read.
        const spans = probes.map((probe) => betweenOf(probe)!)
        expect(spans[0]![1].endsWith("￿")).toBe(true)
        expect(spans.slice(1).every(([, upper]) => upper.endsWith("#"))).toBe(true)
        expect(new Set(spans.map(([lower]) => lower)).size).toBe(1)
        expect(ids((yield* fetchAll(query.limit(4))).flatMap((page) => page.items))).toEqual(want)
      }),
    )
  })

  it.effect(
    "maxPages counts probes: maxPages(1) sends only the first probe and returns a Start cursor { t: T1 }",
    () => {
      const fixture = makeListings()
      const items = grid(["active", "pending", "sold"])
      return over(fixture, items, (byStore, partition) =>
        Effect.gen(function* () {
          const query = byStore({ storeId: STORE }).within({ price: PRICE })
          const page = yield* query.maxPages(1).fetch()
          expect(page.items).toEqual([])
          expect(partition.inputs).toHaveLength(1)
          expect(isProbe(partition.inputs[0])).toBe(true)
          const cursor = Cursor.decode(page.cursor!)!
          const T1 = tupleText(fixture.skOf(fixture.ordered(items)[0]!))
          expect(cursor).toEqual({ v: 2, f: cursor.f, s: "skip-scan", t: { S: T1 } })
          // Resuming reads tuple T1 first: no probe for it again.
          partition.clear()
          expect(ids(yield* query.startFrom(page.cursor!).collect())).toEqual(
            expected(fixture, items, PRICE),
          )
          expect(isProbe(partition.inputs[0])).toBe(false)
          expect(betweenOf(partition.inputs[0])![0].startsWith(T1)).toBe(true)
        }),
      )
    },
  )

  it.effect("no probe is sent when the limit is reached at a tuple end", () => {
    const fixture = makeListings()
    // `active` has exactly two listings in range.
    const items = grid(["active", "pending", "sold"]).map((item) =>
      item.status === "active" && item.price === 70 ? { ...item, price: 30 } : item,
    )
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        // Under a filter a request asks for `pageSize` rows, not the limit:
        // the tuple read ends with no LastEvaluatedKey, the limit reached on
        // its last row — and the probe after it is left to the cursor.
        const query = byStore({ storeId: STORE })
          .within({ price: PRICE })
          .filter({ storeId: STORE })
          .pageSize(10)
        const page = yield* query.limit(2).fetch()
        expect(page.items).toHaveLength(2)
        expect(partition.inputs.map(isProbe)).toEqual([true, false])
        const T1 = tupleText(fixture.skOf(items[0]!))
        const cursor = Cursor.decode(page.cursor!)!
        expect(cursor).toEqual({ v: 2, f: cursor.f, s: "skip-scan", t: { S: T1 }, d: 1 })
        // The pending probe is the resumed call's first request.
        partition.clear()
        const rest = yield* query.startFrom(page.cursor!).collect()
        expect(ids([...page.items, ...rest])).toEqual(expected(fixture, items, PRICE))
        expect(isProbe(partition.inputs[0])).toBe(true)
        expect(betweenOf(partition.inputs[0])![0]).toBe(`${T1.slice(0, -1)}$`)
      }),
    )
  })

  it.effect("probes inherit consistentRead on a primary accessor", () => {
    const fixture = makeListings({ on: "primary" })
    const items = grid(["active", "pending", "sold"])
    return over(fixture, items, (primary, partition) =>
      Effect.gen(function* () {
        const query = primary({ storeId: STORE }).within({ price: PRICE }).consistentRead()
        expect((yield* query.explain()).plan).toBe("skip-scan")
        expect(ids(yield* query.collect())).toEqual(expected(fixture, items, PRICE))
        expect(partition.inputs.filter(isProbe)).toHaveLength(4)
        expect(partition.inputs.every((input) => (input as any).ConsistentRead === true)).toBe(true)
      }),
    )
  })

  it.effect("strict lt on the last composite inside a tuple ends just below the value", () => {
    // Price is the last composite: a key can equal `…#price_<50>`, and
    // BETWEEN is inclusive, so its high end is the greatest key text below
    // it (`keyJustBelow`): the read leaves the boundary row out itself.
    const fixture = makeListings({ sk: ["status", "price"] })
    const items: Array<ListingItem> = ["active", "pending", "sold"].flatMap((status) =>
      [10, 50, 70].map((price) => ({
        storeId: STORE,
        listingId: `${status}-${price}`,
        status,
        price,
      })),
    )
    const bound: PriceBound = { lt: 50 }
    const { events, observe } = recorder()
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE }).within({ price: bound }).onRequest(observe)
        const explain = yield* query.explain()
        expect(explain.plan).toBe("skip-scan")
        expect(explain.rowChecks).toEqual([])
        expect(ids(yield* query.collect())).toEqual(expected(fixture, items, bound))
        const reads = partition.inputs.filter((input) => !isProbe(input))
        expect(reads).toHaveLength(3)
        for (const read of reads) {
          // `…price_0…050` with its last character stepped down: `…05/` + U+10FFFF.
          expect(betweenOf(read)![1]).toMatch(/#price_0*5\/\u{10FFFF}$/u)
        }
        // Each tuple read returns the row below the bound alone.
        for (const event of events.filter((e) => e.kind === "read")) {
          expect(event.count).toBe(1)
          expect(event.accepted).toBe(1)
        }
      }),
    )
  })

  it.effect("an empty interval on the last composite plans no read", () => {
    // Well-formed bounds no price satisfies: an inclusive BETWEEN of their
    // composed ends would be reversed, which DynamoDB refuses.
    const fixture = makeListings({ sk: ["status", "price"] })
    const items = grid(["active", "pending", "sold"])
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        for (const pins of [{ storeId: STORE, status: "active" }, { storeId: STORE }]) {
          for (const price of [
            { gt: 40, lte: 40 },
            { gt: 40, lt: 40 },
            { gte: 40, lt: 40 },
            { gte: 4, lte: 3 },
            { between: [70, 10] },
          ]) {
            const context = JSON.stringify({ pins, price })
            const query = byStore(pins).within({ price })
            expect((yield* query.explain()).plan, context).toBe("empty")
            expect(yield* query.collect(), context).toEqual([])
            expect(yield* query.count(), context).toBe(0)
            expect(yield* query.fetch(), context).toEqual({ items: [], cursor: null })
          }
        }
        expect(partition.inputs).toEqual([])
        // The same bounds a step apart hold the one price between them.
        const one = byStore({ storeId: STORE, status: "active" }).within({
          price: { gt: 39, lte: 40 },
        })
        expect(ids(yield* one.collect())).toEqual(["l-0-1"])
      }),
    )
  })

  it.effect("asParams shows the first request: a skip-scan's probe, a filter plan's read", () => {
    const fixture = makeListings()
    const items = grid(["active", "pending", "sold"])
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const skip = byStore({ storeId: STORE }).within({ price: PRICE })
        const probe: any = yield* Query.asParams(skip._query)
        expect(isProbe(probe)).toBe(true)
        expect(probe.FilterExpression).toBeUndefined()
        const filter = byStore({ storeId: STORE }).within({ price: PRICE }, { maxSkips: 0 })
        const read: any = yield* Query.asParams(filter._query)
        expect(isProbe(read)).toBe(false)
        const [lower, upper] = betweenOf(read)!
        expect(upper).toBe(`${lower}\uFFFF`)
        // Nothing is sent.
        expect(partition.inputs).toEqual([])
      }),
    )
  })
})

describe("sizing and streaming a planned query (#171)", () => {
  it.effect("a row-checked plan counts as filtered: the first Limit is max(16, 2 × limit)", () => {
    const fixture = makeListings()
    const items = randomListings(5, 60)
    const { events, observe } = recorder()
    return over(fixture, items, (byStore) =>
      Effect.gen(function* () {
        // The filter plan checks the price on every row; nothing else filters.
        const filterPlan = byStore({ storeId: STORE })
          .within({ price: PRICE }, { maxSkips: 0 })
          .onRequest(observe)
        expect((yield* filterPlan.explain()).rowChecks).toEqual(["price"])
        yield* filterPlan.limit(5).fetch()
        expect(events[0]!.limit).toBe(16)
        // Inside a skip-scan, a bound on a composite after the bounded one is
        // checked per row: the first read after the probe is sized as
        // filtered too.
        events.length = 0
        const skipPlan = byStore({ storeId: STORE })
          .within({ price: { gte: 20 }, listingId: { gte: "l" } })
          .onRequest(observe)
        expect((yield* skipPlan.explain()).rowChecks).toEqual(["listingId"])
        yield* skipPlan.limit(5).fetch()
        expect(events.map((event) => event.kind).slice(0, 2)).toEqual(["probe", "read"])
        expect(events[1]!.limit).toBe(16)
      }),
    )
  })

  it.effect('pageSize("natural") on a row-checked plan reads natural pages', () => {
    const fixture = makeListings()
    const items = randomListings(6, 60)
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE })
          .within({ price: PRICE }, { maxSkips: 0 })
          .pageSize("natural")
        yield* query.limit(5).fetch()
        yield* query.limit(5).collect()
        // As a query under a filter does: no `Limit`, never #133's doubling.
        expect(partition.limits()).toEqual(partition.limits().map(() => undefined))
      }),
    )
  })

  it.effect("paginate emits one page per read, and nothing for a pull that reads nothing", () => {
    const fixture = makeListings()
    const items = grid(["active", "pending", "sold"])
    return over(fixture, items, (byStore, partition) =>
      Effect.gen(function* () {
        const query = byStore({ storeId: STORE }).within({ price: PRICE })
        const pages = yield* Stream.runCollect(yield* Query.paginate(query._query))
        expect(pages.map((page) => ids(page as Array<ListingItem>))).toEqual(
          ["active", "pending", "sold"].map((status) =>
            expected(fixture, items, PRICE).filter((id) =>
              items.some((item) => item.listingId === id && item.status === status),
            ),
          ),
        )
        // The last probe finds no tuple: the stream ends, no empty page.
        expect(partition.inputs.filter(isProbe)).toHaveLength(4)
        // maxPages(1) spends the one request on the first probe: no read, no page.
        partition.clear()
        const capped = yield* Stream.runCollect(
          yield* Query.paginate(Query.maxPages(query._query, 1)),
        )
        expect(capped).toEqual([])
        expect(partition.inputs).toHaveLength(1)
        expect(isProbe(partition.inputs[0])).toBe(true)
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// A ref-derived composite
// ---------------------------------------------------------------------------

describe("a ref-derived composite bound (#171)", () => {
  // Order lines by order, then stage and part. `partId` is derived from the
  // `part` ref: the item stores the ref (a map holding the part's
  // identifier), never `partId`, so a row check reads it from the ref.
  class Part extends Schema.Class<Part>("Part")({
    partId: Schema.String.pipe(DynamoModel.identifier),
    name: Schema.String,
  }) {}

  class OrderLine extends Schema.Class<OrderLine>("OrderLine")({
    lineId: Schema.String,
    orderId: Schema.String,
    stage: Schema.Literals(["packed", "picked", "shipped"]),
    part: Part.pipe(DynamoModel.ref),
  }) {}

  const Parts = Entity.make({
    model: Part,
    entityType: "Part",
    primaryKey: {
      pk: { field: "pk", composite: ["partId"] },
      sk: { field: "sk", composite: [] },
    },
  })

  const OrderLines = Entity.make({
    model: OrderLine,
    entityType: "OrderLine",
    primaryKey: {
      pk: { field: "pk", composite: ["lineId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byOrder: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["orderId"] },
        sk: { field: "gsi1sk", composite: ["stage", "partId"] },
      },
    },
    refs: { part: { entity: Parts } },
  })

  const schema = DynamoSchema.make({ name: "lines", version: 1 })
  const LinesTable = Table.make({ schema, entities: { OrderLines, Parts } })

  const stages = ["packed", "picked", "shipped"] as const
  const parts = ["p-1", "p-2", "p-3", "p-4", "p-5"]
  const lines = stages.flatMap((stage) =>
    parts.map((partId) => ({ lineId: `${stage}-${partId}`, orderId: "o-1", stage, partId })),
  )
  const rowOf = (line: (typeof lines)[number]): Row =>
    toAttributeMap({
      lineId: line.lineId,
      orderId: line.orderId,
      stage: line.stage,
      part: { partId: line.partId, name: `Part ${line.partId}` },
      __edd_e__: "OrderLine",
      ...KeyComposer.composeAllKeys(
        schema,
        "OrderLine",
        1,
        OrderLines.indexes as Record<string, KeyComposer.IndexDefinition>,
        OrderLines._keyForm({ ...line }),
      ),
    })

  const makeDb = () =>
    DynamoClient.make({ entities: { OrderLines, Parts }, tables: { LinesTable } })
  type Db = Effect.Success<ReturnType<typeof makeDb>>

  /** Run `f` over the typed client, served every line. */
  const run = <X>(
    f: (db: Db, partition: Partition) => Effect.Effect<X, unknown, any>,
  ): Effect.Effect<X, unknown> => {
    const partition = makePartition({
      rows: lines.map(rowOf),
      pkField: "gsi1pk",
      skField: "gsi1sk",
      keyFields: ["gsi1pk", "gsi1sk", "pk", "sk"],
    })
    return Effect.gen(function* () {
      return yield* f(yield* makeDb(), partition)
    }).pipe(
      Effect.provide(Layer.merge(partition.layer, LinesTable.layer({ name: "lines" }))),
    ) as Effect.Effect<X, unknown>
  }
  const byOrder = (db: Db) => db.entities.OrderLines.byOrder({ orderId: "o-1" })

  const lineIds = (items: ReadonlyArray<{ readonly lineId: string }>) =>
    items.map((item) => item.lineId)
  const want = (keep: (partId: string) => boolean) =>
    lines.filter((line) => keep(line.partId)).map((line) => line.lineId)

  it.effect("the filter plan and the maxSkips fallback check it from the stored ref", () =>
    run((db) =>
      Effect.gen(function* () {
        const atLeast = want((partId) => partId >= "p-3")
        for (const maxSkips of [0, 1, 32]) {
          const query = byOrder(db).within({ partId: { gte: "p-3" } }, { maxSkips })
          const explain = yield* query.explain()
          expect(explain.plan, `maxSkips ${maxSkips}`).toBe(maxSkips === 0 ? "filter" : "skip-scan")
          expect(lineIds(yield* query.collect()), `maxSkips ${maxSkips}`).toEqual(atLeast)
          expect(yield* query.count(), `maxSkips ${maxSkips}`).toBe(atLeast.length)
          const pages = yield* fetchAll(query.limit(4))
          expect(lineIds(pages.flatMap((page) => page.items)), `maxSkips ${maxSkips}`).toEqual(
            atLeast,
          )
        }
        expect(
          (yield* byOrder(db)
            .within({ partId: { gte: "p-3" } }, { maxSkips: 0 })
            .explain()).rowChecks,
        ).toEqual(["partId"])
      }),
    ),
  )

  it.effect("a strict lt on it as the last composite is exact on the key", () =>
    run((db) =>
      Effect.gen(function* () {
        const query = byOrder(db).within({ partId: { lt: "p-3" } })
        const explain = yield* query.explain()
        expect(explain.plan).toBe("skip-scan")
        expect(explain.rowChecks).toEqual([])
        expect(lineIds(yield* query.collect())).toEqual(want((partId) => partId < "p-3"))
        // A bound after another is still checked from the stored ref.
        const later = byOrder(db).within({ stage: { gte: "p" }, partId: { lt: "p-3" } })
        expect((yield* later.explain()).rowChecks).toEqual(["partId"])
        expect(lineIds(yield* later.collect())).toEqual(want((partId) => partId < "p-3"))
      }),
    ),
  )

  it.effect("a projection borrows the ref, and a path inside it reads the ref whole", () =>
    run((db, partition) =>
      Effect.gen(function* () {
        const atLeast = want((partId) => partId >= "p-3")
        const filterPlan = () => byOrder(db).within({ partId: { gte: "p-3" } }, { maxSkips: 0 })
        // Borrowed for the check, then stripped: the caller doesn't see it.
        // (The mock applies no projection, so the rest of each row comes back.)
        const selected = yield* filterPlan().select(["lineId"]).collect()
        expect(lineIds(selected as Array<{ readonly lineId: string }>)).toEqual(atLeast)
        expect(selected.every((item) => !("part" in item))).toBe(true)
        const borrowed: any = partition.inputs.at(-1)
        expect(Object.values(borrowed.ExpressionAttributeNames)).toContain("part")
        // A path inside the ref: the request reads the ref whole (DynamoDB
        // rejects overlapping paths), and the ref comes back whole.
        partition.clear()
        const inside = yield* filterPlan()
          .select((t) => [t.lineId, t.part.name])
          .collect()
        expect(lineIds(inside as Array<{ readonly lineId: string }>)).toEqual(atLeast)
        const request: any = partition.inputs[0]
        const projected = (request.ProjectionExpression as string).split(", ").map((path) =>
          path
            .split(".")
            .map((name) => request.ExpressionAttributeNames[name])
            .join("."),
        )
        expect(projected).toContain("part")
        expect(projected.filter((path) => path.startsWith("part."))).toEqual([])
        expect((inside[0] as { readonly part: object }).part).toEqual({
          partId: "p-3",
          name: "Part p-3",
        })
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Binary prefix skip-scan (Z-order `sk.prefix`, design §7.5)
// ---------------------------------------------------------------------------

class Desk extends Schema.Class<Desk>("Desk")({
  deskId: Schema.String,
  site: Schema.String,
  floor: Schema.String,
  wing: Schema.String,
  room: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
}) {}

const deskDimensions = [
  ZOrder.int("x", { min: 0, max: 7 }),
  ZOrder.int("y", { min: 0, max: 7 }),
] as const

/** Desks by site, then floor, wing and room — once with `wing` stored as a 2-byte hash. */
const Desks = Entity.make({
  model: Desk,
  entityType: "Desk",
  primaryKey: {
    pk: { field: "pk", composite: ["deskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byRoom: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["site"] },
      sk: { field: "gsi1sk", prefix: ["floor", "wing", "room"], zorder: deskDimensions },
    },
    byHashedWing: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["site"] },
      sk: {
        field: "gsi2sk",
        prefix: ["floor", { field: "wing", hash: 2 }, "room"],
        zorder: deskDimensions,
      },
    },
  },
})

const DeskTable = Table.make({
  schema: DynamoSchema.make({ name: "desks", version: 1 }),
  entities: { Desks },
})
const DeskTableLayer = DeskTable.layer({ name: "desks-table" })

/** Desks on three floors, three wings and two rooms each, at random cells. */
const DESKS = (() => {
  const next = random(75)
  const desks: Array<Desk> = []
  for (const floor of ["1", "2", "3"]) {
    for (const wing of ["east", "north", "west"]) {
      for (const room of ["r1", "r2"]) {
        for (let n = 0; n < 6; n++) {
          desks.push(
            new Desk({
              deskId: `${floor}-${wing}-${room}-${n}`,
              site: "hq",
              floor,
              wing,
              room,
              x: Math.floor(next() * 8),
              y: Math.floor(next() * 8),
            }),
          )
        }
      }
    }
  }
  return desks
})()
const DESK_ROWS = capturePuts(
  DeskTableLayer,
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { Desks }, tables: { DeskTable } })
    for (const desk of DESKS) yield* db.entities.Desks.put(desk)
  }),
)

type DeskIndex = "byRoom" | "byHashedWing"
const DESK_KEYS = { byRoom: "gsi1", byHashedWing: "gsi2" } as const

/** Run `f` over `index`'s partition: a mock that rejects a zero-length key operand. */
const overDesks = <X, E>(
  index: DeskIndex,
  f: (desks: DesksClient, partition: Partition) => Effect.Effect<X, E>,
): Effect.Effect<X, E> => {
  const key = DESK_KEYS[index]
  const partition = makePartition({
    rows: DESK_ROWS,
    pkField: `${key}pk`,
    skField: `${key}sk`,
    keyFields: [`${key}pk`, `${key}sk`, "pk", "sk"],
    evaluateFilter: true,
  })
  return Effect.flatMap(desksClient, (desks) => f(desks, partition)).pipe(
    Effect.provide(Layer.merge(partition.layer, DeskTableLayer)),
  )
}

const desksClient = Effect.map(
  DynamoClient.make({ entities: { Desks }, tables: { DeskTable } }),
  (db) => db.entities.Desks,
)
type DesksClient = Effect.Success<typeof desksClient>

/** `desks` in `index`'s order: sort key bytes, then the table key. */
const deskOrder = (index: DeskIndex, desks: ReadonlyArray<Desk>): Array<string> => {
  const sk = `${DESK_KEYS[index]}sk`
  const rowOf = new Map(DESKS.map((desk, i) => [desk.deskId, DESK_ROWS[i]!]))
  const bytes = (desk: Desk) => rowOf.get(desk.deskId)![sk]!.B!
  return [...desks]
    .sort(
      (a, b) =>
        compareBytes(bytes(a), bytes(b)) ||
        (a.deskId < b.deskId ? -1 : a.deskId > b.deskId ? 1 : 0),
    )
    .map((desk) => desk.deskId)
}

const deskIds = (desks: ReadonlyArray<{ readonly deskId: string }>) =>
  desks.map((desk) => desk.deskId)

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const X = { between: [2, 5] } as const
const inX = (desk: Desk) => desk.x >= 2 && desk.x <= 5

describe("binary prefix skip-scan (#171 §7.5)", () => {
  const cases: ReadonlyArray<
    readonly [string, Record<string, unknown>, (desk: Desk) => boolean, string]
  > = [
    [
      "missing leading: SEEK and SKIP on the given later segments",
      { wing: "north", room: "r2", x: X },
      (desk) => desk.wing === "north" && desk.room === "r2" && inX(desk),
      "skip tuple: floor, wing, room",
    ],
    [
      "missing middle: the leading segment is the prefix, the later one is sought",
      { floor: "2", room: "r1", x: X },
      (desk) => desk.floor === "2" && desk.room === "r1" && inX(desk),
      "skip tuple: wing, room",
    ],
    [
      "all given: no skip tuple",
      { floor: "3", wing: "west", room: "r1", x: X },
      (desk) => desk.floor === "3" && desk.wing === "west" && desk.room === "r1" && inX(desk),
      "",
    ],
    [
      "all omitted: never a zero-length operand",
      { x: X },
      (desk) => inX(desk),
      "skip tuple: floor, wing, room",
    ],
    [
      "a given prefix and no dimension: each tuple read whole",
      { room: "r2" },
      (desk) => desk.room === "r2",
      "skip tuple: floor, wing, room",
    ],
  ]

  for (const index of ["byRoom", "byHashedWing"] as const) {
    for (const [name, bounds, holds, reason] of cases) {
      it.effect(`${index}: ${name}`, () =>
        overDesks(index, (desks, partition) =>
          Effect.gen(function* () {
            const query = desks[index]({ site: "hq" }).within(bounds as never)
            const explain = yield* query.explain()
            if (reason === "") expect(explain.plan).not.toBe("skip-scan")
            else {
              expect(explain.plan).toBe("skip-scan")
              expect(explain.reason.startsWith(reason)).toBe(true)
            }
            const want = deskOrder(index, DESKS.filter(holds))
            expect(want.length).toBeGreaterThan(0)
            expect(deskIds(yield* query.collect())).toEqual(want)
            expect(deskIds(yield* query.reverse().collect())).toEqual([...want].reverse())
            for (const limit of [1, 2, 5]) {
              const pages = yield* fetchAll(query.limit(limit)) as unknown as Effect.Effect<
                Array<{ readonly items: Array<Desk> }>,
                unknown
              >
              expect(deskIds(pages.flatMap((page) => page.items))).toEqual(want)
            }
            // The fallback after one probe returns the same rows.
            const fallback = desks[index]({ site: "hq" }).within(bounds as never, { maxSkips: 1 })
            expect(deskIds(yield* fallback.collect())).toEqual(want)
            expect(partition.inputs.length).toBeGreaterThan(0)
          }),
        ),
      )
    }
  }

  it.effect("all omitted: probe count = distinct tuples + 1", () =>
    overDesks("byRoom", (desks, partition) =>
      Effect.gen(function* () {
        yield* desks.byRoom({ site: "hq" }).within({ x: X }).collect()
        const tuples = new Set(DESKS.map((desk) => `${desk.floor}|${desk.wing}|${desk.room}`))
        expect(partition.inputs.filter(isProbe).length).toBe(tuples.size + 1)
      }),
    ),
  )

  /** The skip tuples reads were sent under: each read's lower operand, less the address. */
  const tuplesRead = (partition: Partition) =>
    new Set(
      partition.inputs
        .filter((input) => !isProbe(input))
        .map((input: any) => {
          const lower = /#sk BETWEEN (:\w+)/.exec(input.KeyConditionExpression)![1]!
          return hexOf(input.ExpressionAttributeValues[lower].B.subarray(0, -1))
        }),
    )
  /** The skip tuples of the desks `holds` keeps, from their stored sort keys. */
  const tuplesOf = (index: DeskIndex, holds: (desk: Desk) => boolean) => {
    const sk = `${DESK_KEYS[index]}sk`
    return new Set(
      DESKS.flatMap((desk, i) =>
        holds(desk) ? [hexOf(DESK_ROWS[i]![sk]!.B!.subarray(0, -1))] : [],
      ),
    )
  }

  it.effect("SEEK: a given later segment is probed for directly, never tuple by tuple", () =>
    overDesks("byRoom", (desks, partition) =>
      Effect.gen(function* () {
        const want = (desk: Desk) => desk.wing === "north" && desk.room === "r2" && inX(desk)
        const got = yield* desks
          .byRoom({ site: "hq" })
          .within({ wing: "north", room: "r2", x: X })
          .collect()
        expect(deskIds(got)).toEqual(deskOrder("byRoom", DESKS.filter(want)))
        // Per floor, wings sort east, west, north (length first): the probe
        // lands on (east, r1), SEEKs to north, lands on (north, r1), SEEKs to
        // r2 and lands on the tuple — 3 probes, then 1 that finds nothing.
        // Probing tuple by tuple would take 18 + 1.
        expect(partition.inputs.filter(isProbe)).toHaveLength(3 * 3 + 1)
        // Only the three matching tuples are read.
        expect(tuplesRead(partition)).toEqual(
          tuplesOf("byRoom", (desk) => desk.wing === "north" && desk.room === "r2"),
        )
      }),
    ),
  )

  for (const index of ["byRoom", "byHashedWing"] as const) {
    it.effect(`${index}: SKIP: a tuple whose given segment is passed is skipped whole`, () =>
      overDesks(index, (desks, partition) =>
        Effect.gen(function* () {
          const want = (desk: Desk) => desk.floor === "2" && desk.room === "r1" && inX(desk)
          const query = desks[index]({ site: "hq" }).within({ floor: "2", room: "r1", x: X })
          expect(deskIds(yield* query.collect())).toEqual(deskOrder(index, DESKS.filter(want)))
          // Per wing: a probe lands on (wing, r1), the tuple; after its reads
          // one lands on (wing, r2), past r1, and SKIPs the wing. Then 1 more.
          expect(partition.inputs.filter(isProbe)).toHaveLength(1 + 2 * 3)
          // (wing, r2) is never read.
          expect(tuplesRead(partition)).toEqual(
            tuplesOf(index, (desk) => desk.floor === "2" && desk.room === "r1"),
          )
        }),
      ),
    )
  }

  it.effect("byHashedWing: SEEK on a hashed segment reads only the matching tuples", () =>
    overDesks("byHashedWing", (desks, partition) =>
      Effect.gen(function* () {
        const want = (desk: Desk) => desk.wing === "north" && desk.room === "r2" && inX(desk)
        const query = desks.byHashedWing({ site: "hq" }).within({ wing: "north", room: "r2", x: X })
        expect(deskIds(yield* query.collect())).toEqual(
          deskOrder("byHashedWing", DESKS.filter(want)),
        )
        // Hash order puts north anywhere among the wings: at most a SEEK to
        // north and one to r2 before the tuple, per floor.
        expect(partition.inputs.filter(isProbe).length).toBeLessThanOrEqual(3 * 3 + 1)
        expect(tuplesRead(partition)).toEqual(
          tuplesOf("byHashedWing", (desk) => desk.wing === "north" && desk.room === "r2"),
        )
      }),
    ),
  )

  for (const index of ["byRoom", "byHashedWing"] as const) {
    it.effect(`${index}: maxSkips caps the probes, then the filter plan reads the rest`, () =>
      overDesks(index, (desks, partition) =>
        Effect.gen(function* () {
          const want = (desk: Desk) => desk.wing === "north" && desk.room === "r2" && inX(desk)
          const { events, observe } = recorder()
          const query = desks[index]({ site: "hq" })
            .within({ wing: "north", room: "r2", x: X }, { maxSkips: 4 })
            .onRequest(observe)
          expect(deskIds(yield* query.collect())).toEqual(deskOrder(index, DESKS.filter(want)))
          expect(partition.inputs.filter(isProbe)).toHaveLength(4)
          // Every probe is sent before the fallback: none follows a filter read.
          const kinds = events.map((event) => event.kind)
          expect(kinds.lastIndexOf("probe")).toBeLessThan(kinds.lastIndexOf("read"))
          expect(kinds.filter((kind) => kind === "probe")).toHaveLength(4)
        }),
      ),
    )
  }
})
