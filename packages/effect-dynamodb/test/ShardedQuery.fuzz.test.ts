/**
 * The randomised brute-force check of a sharded index's reads (#183, design §16).
 * Random layouts, partition contents and duplicates across shards, filters, page
 * sizes and short pages, in both directions: `collect()`, `paginate()`, `fetch`
 * chains with their limits landing anywhere and `count()` all equal a brute-force
 * sort of the stored rows. Seeds are fixed, so a failure reproduces.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import type * as Query from "../src/Query.js"
import { compareBytes } from "./helpers/PartitionMock.js"
import {
  type Device,
  idsOf,
  makeDevices,
  prng,
  randomDevices,
  TENANT,
} from "./helpers/ShardedDevices.js"

const encoder = new TextEncoder()

const pick = <T>(next: () => number, from: ReadonlyArray<T>): T =>
  from[Math.floor(next() * from.length)]!
const upTo = (next: () => number, n: number) => Math.floor(next() * n)

type Sk = ReadonlyArray<"groupId" | "channel" | "deviceId" | "status">

interface Scenario {
  readonly seed: number
  readonly count: number
  readonly previous: number | undefined
  readonly by: boolean
  readonly sk: Sk
  readonly reverse: boolean
  readonly filter: "none" | "server" | "client"
  readonly pageRows: number | undefined
  readonly pageSize: number | "natural" | undefined
  readonly concurrency: number | undefined
  readonly items: ReadonlyArray<Device>
  readonly next: () => number
}

const scenario = (seed: number): Scenario => {
  const next = prng(seed)
  const count = pick(next, [2, 3, 4, 8, 16, 20])
  const sk = pick<Sk>(next, [["groupId", "channel", "deviceId"], ["groupId"], ["status"]])
  const by = next() < 0.4 && sk[0] !== "status"
  const groups = pick(next, [["group-a"], ["group-a", "GROUP-B"], ["a", "b", "c", "d", "e", "f"]])
  return {
    seed,
    count,
    previous: pick(next, [undefined, undefined, 1, count === 2 ? 3 : 2]),
    by,
    sk,
    reverse: next() < 0.5,
    filter: pick(next, ["none", "none", "server", "client"] as const),
    pageRows: pick(next, [undefined, 1, 2, 5]),
    pageSize: pick(next, [undefined, undefined, "natural", 1, 3, 7] as const),
    concurrency: pick(next, [undefined, 1, 3]),
    items: randomDevices(next, pick(next, [0, 1, 2, 7, 40, 90]), groups, ["on", "off"]),
    next,
  }
}

const check = (s: Scenario) => {
  const on = makeDevices({
    shards: {
      count: s.count,
      ...(s.by ? { by: ["groupId"] } : {}),
      ...(s.previous === undefined ? {} : { previous: s.previous }),
    },
    sk: s.sk,
  })
  // The old layout's rows: what a transition holds before `rekey` has finished.
  const old =
    s.previous === undefined
      ? undefined
      : makeDevices({ shards: s.previous === 1 ? null : s.previous, sk: s.sk })
  const inOld = (item: Device) => old !== undefined && Number(item.deviceId.slice(-1)) % 2 === 0
  const stored = (item: Device) => (inOld(item) ? old! : on).rowOf(item)
  const server = on.serve(
    s.items.filter((item) => !inOld(item)),
    { ...(s.pageRows === undefined ? {} : { pageRows: s.pageRows }) },
    s.items.filter(inOld).map((item) => old!.rowOf(item)),
  )

  const query = (devices: any) => {
    let q = devices.byTenant({ tenantId: TENANT })
    if (s.filter === "server") q = q.filter({ status: "on" })
    if (s.filter === "client") q = q.filterBy((item: Device) => item.status === "on")
    if (s.reverse) q = q.reverse()
    if (s.pageSize !== undefined) q = q.pageSize(s.pageSize)
    if (s.concurrency !== undefined) q = q.concurrency(s.concurrency)
    return q
  }

  return Effect.gen(function* () {
    const devices = yield* on.client
    const { fanOut } = (yield* devices
      .byTenant({ tenantId: TENANT })
      .explain()) as Query.QueryExplain
    const partitions = fanOut!.partitions
    const entries = s.items
      .filter((item) => s.filter === "none" || item.status === "on")
      .map((item) => {
        const row = stored(item)
        const at = partitions.indexOf(row.gsi5pk!.S!)
        expect(at).toBeGreaterThanOrEqual(0)
        return {
          item,
          sk: encoder.encode(row.gsi5sk!.S!),
          at,
          tie: encoder.encode(JSON.stringify([row.pk, row.sk])),
        }
      })
      .sort((a, b) => compareBytes(a.sk, b.sk) || a.at - b.at || compareBytes(a.tie, b.tie))
    const forward = idsOf(entries.map((entry) => entry.item))
    const expected = s.reverse ? [...forward].reverse() : forward

    // `collect()`
    expect(idsOf(yield* query(devices).collect())).toEqual(expected)

    // `paginate()`
    const streamed = yield* Stream.runCollect(query(devices).paginate())
    expect(idsOf(Array.from(streamed as Iterable<Device>))).toEqual(expected)

    // `fetch()` chains with the limit landing anywhere, re-drawn per page.
    const chained: Array<string> = []
    let cursor: Option.Option<string> = Option.none()
    let pages = 0
    do {
      const q = query(devices).limit(1 + upTo(s.next, 17))
      const page: Query.Page<Device> = yield* Option.isSome(cursor)
        ? q.startFrom(cursor.value).fetch()
        : q.fetch()
      chained.push(...idsOf(page.items))
      cursor = page.cursor
      expect(++pages).toBeLessThan(10_000)
    } while (Option.isSome(cursor))
    expect(chained).toEqual(expected)

    // `fetch()` chains of one round each.
    const rounds: Array<string> = []
    cursor = Option.none()
    pages = 0
    do {
      const q = query(devices)
      const page: Query.Page<Device> = yield* Option.isSome(cursor)
        ? q.startFrom(cursor.value).fetch()
        : q.fetch()
      rounds.push(...idsOf(page.items))
      cursor = page.cursor
      expect(++pages).toBeLessThan(10_000)
    } while (Option.isSome(cursor))
    expect(rounds).toEqual(expected)

    // A cursor taken anywhere and resumed with `collect()`.
    if (expected.length > 0) {
      const at = 1 + upTo(s.next, expected.length)
      const page = yield* query(devices).limit(at).fetch()
      expect(idsOf(page.items)).toEqual(expected.slice(0, page.items.length))
      if (Option.isSome(page.cursor)) {
        const rest = yield* query(devices).startFrom(page.cursor.value).collect()
        expect(idsOf(rest)).toEqual(expected.slice(page.items.length))
      } else {
        expect(page.items).toHaveLength(expected.length)
      }
    }

    // `count()`
    if (s.filter !== "client") {
      expect(yield* query(devices).count()).toBe(expected.length)
    }
  }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
}

describe("a sharded index's reads, by brute force", () => {
  it.effect.each(Array.from({ length: 200 }, (_, i) => i + 1))("seed %d", (seed) =>
    check(scenario(seed)),
  )
})

describe("pruned reads, by brute force", () => {
  it.effect.each(Array.from({ length: 50 }, (_, i) => i + 1001))("seed %d", (seed) => {
    const next = prng(seed)
    const count = pick(next, [2, 4, 8, 16])
    const on = makeDevices({ shards: { count, by: ["groupId"] } })
    const groups = ["group-a", "GROUP-B", "c", "d"]
    const items = randomDevices(next, 60, groups)
    const group = pick(next, groups)
    const pin = next() < 0.5 ? group.toUpperCase() : group.toLowerCase()
    const reverse = next() < 0.5
    const server = on.serve(items, pick(next, [{}, { pageRows: 2 }]))
    const expected = idsOf(
      on.merged(
        items.filter((item) => item.groupId.toLowerCase() === group.toLowerCase()),
        reverse,
      ),
    )
    return Effect.gen(function* () {
      const devices = yield* on.client
      const query = () => {
        const q = devices.byTenant({ tenantId: TENANT, groupId: pin })
        return reverse ? q.reverse() : q
      }
      expect(idsOf(yield* query().collect())).toEqual(expected)
      expect(new Set(server.partitionsRead()).size).toBe(1)
      const chained: Array<string> = []
      let cursor: Option.Option<string> = Option.none()
      do {
        const q = query().limit(1 + upTo(next, 7))
        const page: Query.Page<Device> = yield* Option.isSome(cursor)
          ? q.startFrom(cursor.value).fetch()
          : q.fetch()
        chained.push(...idsOf(page.items))
        cursor = page.cursor
      } while (Option.isSome(cursor))
      expect(chained).toEqual(expected)
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
  })
})
