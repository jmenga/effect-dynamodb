/**
 * Queries of a sharded index against a mocked client (#183, design §6): one request
 * per partition, the merged order, cursors, pruning, `previous`, `concurrency`,
 * projections and failures. The randomised check is in `ShardedQuery.fuzz.test.ts`.
 */

import { describe, expect, it } from "@effect/vitest"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Fiber, Option, Stream } from "effect"
import * as Cursor from "../src/internal/Cursor.js"
import { canonicalJson, fnv1a32 } from "../src/internal/RangePlanner.js"
import type * as Query from "../src/Query.js"
import {
  type Device,
  idsOf,
  makeDevices,
  pkOfInput,
  prng,
  randomDevices,
  type Server,
  type ServerOptions,
  TENANT,
} from "./helpers/ShardedDevices.js"

const fixture = makeDevices({ shards: 8 })
const makeDevicesUnsharded = () => ({
  fixture: makeDevices({ shards: null }),
  options: {} as ServerOptions,
})
const checksum = (positions: unknown) => fnv1a32(canonicalJson(positions))
const items = randomDevices(prng(1), 60)

const run = <X>(
  f: (devices: any, server: Server) => Effect.Effect<X, unknown, any>,
  options: ServerOptions = {},
  rows: ReadonlyArray<Device> = items,
  on: ReturnType<typeof makeDevices> = fixture,
): Effect.Effect<X, unknown> => {
  const server = on.serve(rows, options)
  return Effect.gen(function* () {
    const devices = yield* on.client
    return yield* f(devices, server)
  }).pipe(Effect.provide(server.layer)) as Effect.Effect<X, unknown>
}

const refusal = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.map(Effect.flip(effect), (error: any) => {
    expect(error._tag).toBe("ValidationError")
    expect(String(error.cause)).toContain("[EDD-9094]")
    return String(error.cause)
  })

const partition = (shard: number, width = 1, count = 8) =>
  `$fleet-db#v1#devicestate#!${count}.${String(shard).padStart(width, "0")}#tenantid_${TENANT}`

describe("rounds: what a page costs", () => {
  const on = makeDevices({ shards: 20 })
  const many = randomDevices(prng(7), 2000)

  it.effect("`.fetch()` without a limit is one round: one request per shard", () =>
    run(
      (devices, server) =>
        Effect.gen(function* () {
          yield* devices.byTenant({ tenantId: TENANT }).fetch()
          expect(server.inputs).toHaveLength(20)
        }),
      {},
      many,
      on,
    ),
  )

  it.effect("`.limit(n).fetch()`: every shard at `n / N`, then the shards that ran dry", () =>
    run(
      (devices, server) =>
        Effect.gen(function* () {
          const page = yield* devices.byTenant({ tenantId: TENANT }).limit(100).fetch()
          expect(page.items).toHaveLength(100)
          const first = server.inputs.slice(0, 20)
          expect(
            new Set(first.map((input) => input.ExpressionAttributeValues![":pk"]!.S)),
          ).toHaveProperty("size", 20)
          // `n / N` and a margin: enough that a page rarely needs every shard again, not
          // enough to spare the shards that run dry.
          for (const input of first) {
            expect(input.Limit).toBeGreaterThanOrEqual(5)
            expect(input.Limit).toBeLessThan(10)
          }
          // A shard's first page runs out before a page of 100 is proven in order.
          expect(server.inputs.length).toBeGreaterThan(20)
        }),
      {},
      many,
      on,
    ),
  )

  it.effect("`.pageSize(n)` at the page's size: one round, reading more rows", () =>
    run(
      (devices, server) =>
        Effect.gen(function* () {
          const page = yield* devices
            .byTenant({ tenantId: TENANT })
            .limit(100)
            .pageSize(100)
            .fetch()
          expect(page.items).toHaveLength(100)
          expect(server.inputs).toHaveLength(20)
          for (const input of server.inputs) expect(input.Limit).toBe(100)
        }),
      {},
      many,
      on,
    ),
  )
})

describe("requests", () => {
  it.effect("collect reads each partition once, with one key condition per shard", () =>
    run((devices, server) =>
      Effect.gen(function* () {
        yield* devices.byTenant({ tenantId: TENANT }).collect()
        expect(server.inputs).toHaveLength(8)
        expect(new Set(server.partitionsRead())).toEqual(
          new Set(Array.from({ length: 8 }, (_, i) => partition(i))),
        )
        for (const input of server.inputs) {
          expect(input.IndexName).toBe("gsi5")
          expect(input.KeyConditionExpression).toContain("#pk = :pk")
        }
      }),
    ),
  )

  it.effect("every shard sends the same key condition and filter", () =>
    run((devices, server) =>
      Effect.gen(function* () {
        yield* devices
          .byTenant({ tenantId: TENANT })
          .where((t: any, { beginsWith }: any) => beginsWith(t.groupId, "group-a"))
          .filter({ status: "on" })
          .collect()
        const shapes = new Set(
          server.inputs.map((input) =>
            JSON.stringify({
              key: input.KeyConditionExpression,
              filter: input.FilterExpression,
              sk: input.ExpressionAttributeValues?.[":sk"],
            }),
          ),
        )
        expect(shapes.size).toBe(1)
        expect(server.inputs[0]!.FilterExpression).toContain("#eddE")
      }),
    ),
  )

  it.effect("pruned: every `by` attribute pinned sends one request", () => {
    const on = makeDevices({ shards: { count: 8, by: ["groupId"] } })
    return run(
      (devices, server) =>
        Effect.gen(function* () {
          const found = yield* devices.byTenant({ tenantId: TENANT, groupId: "group-a" }).collect()
          expect(server.inputs).toHaveLength(1)
          expect(idsOf(found)).toEqual(
            idsOf(on.merged(items.filter((item) => item.groupId === "group-a"))),
          )
        }),
      {},
      items,
      on,
    )
  })

  it.effect("pruned: a pin differing only in case reaches the same shard (finding 1)", () => {
    const on = makeDevices({ shards: { count: 8, by: ["groupId"] } })
    return run(
      (devices, server) =>
        Effect.gen(function* () {
          const lower = yield* devices.byTenant({ tenantId: TENANT, groupId: "group-a" }).collect()
          const upper = yield* devices.byTenant({ tenantId: TENANT, groupId: "GROUP-A" }).collect()
          expect(new Set(server.partitionsRead()).size).toBe(1)
          expect(lower.length).toBeGreaterThan(0)
          expect(idsOf(upper)).toEqual(idsOf(lower))
        }),
      {},
      items,
      on,
    )
  })

  it.effect("a `by` query with `by` unpinned reads every shard", () => {
    const on = makeDevices({ shards: { count: 8, by: ["groupId"] } })
    return run(
      (devices, server) =>
        Effect.gen(function* () {
          const found = yield* devices.byTenant({ tenantId: TENANT }).collect()
          expect(server.inputs).toHaveLength(8)
          expect(idsOf(found)).toEqual(idsOf(on.merged(items)))
        }),
      {},
      items,
      on,
    )
  })

  describe("a default source: the whole primary key pinned", () => {
    const target = items[17]!
    const fullPin = {
      tenantId: TENANT,
      groupId: target.groupId,
      channel: target.channel,
      deviceId: target.deviceId,
    }
    const storedPk = fixture.rowOf(target).gsi5pk!.S!

    it.effect("reads the one shard the row is on", () =>
      run((devices, server) =>
        Effect.gen(function* () {
          const found = yield* devices.byTenant(fullPin).collect()
          expect(server.partitionsRead()).toEqual([storedPk])
          expect(idsOf(found)).toEqual([target.deviceId])
          const explained: Query.QueryExplain = yield* devices.byTenant(fullPin).explain()
          expect(explained.fanOut?.pruned).toBe(true)
          expect(explained.fanOut?.partitions).toEqual([storedPk])
          expect(explained.reason).toContain("one shard")
        }),
      ),
    )

    it.effect("a partial pin still fans out", () =>
      run((devices, server) =>
        Effect.gen(function* () {
          for (const pins of [
            { tenantId: TENANT, groupId: target.groupId },
            { tenantId: TENANT, groupId: target.groupId, channel: target.channel },
          ]) {
            server.clear()
            const found = yield* devices.byTenant(pins).collect()
            expect(server.inputs).toHaveLength(8)
            expect(idsOf(found)).toContain(target.deviceId)
            const explained: Query.QueryExplain = yield* devices.byTenant(pins).explain()
            expect(explained.fanOut?.pruned).toBe(false)
          }
        }),
      ),
    )

    it.effect("a pin in another case reaches the stored shard and finds the row", () =>
      run((devices, server) =>
        Effect.gen(function* () {
          const found = yield* devices
            .byTenant({
              tenantId: TENANT,
              groupId: target.groupId.toUpperCase(),
              channel: target.channel.toUpperCase(),
              deviceId: target.deviceId.toUpperCase(),
            })
            .collect()
          expect(server.partitionsRead()).toEqual([storedPk])
          expect(idsOf(found)).toEqual([target.deviceId])
        }),
      ),
    )

    it.effect("a fetch chain on a pruned query stays on the shard and ends", () =>
      run((devices, server) =>
        Effect.gen(function* () {
          const query = devices.byTenant(fullPin).limit(1)
          const first = yield* query.fetch()
          expect(idsOf(first.items)).toEqual([target.deviceId])
          if (Option.isSome(first.cursor)) {
            const second = yield* query.startFrom(first.cursor.value).fetch()
            expect(second.items).toEqual([])
            expect(second.cursor).toEqual(Option.none())
          }
          expect(new Set(server.partitionsRead())).toEqual(new Set([storedPk]))
        }),
      ),
    )

    it.effect("a pruned query's cursor is one of its own: another query's is refused", () => {
      // A whole-primary-key pin holds one row, so a page with more behind it takes
      // a pruned `by` query. The cursor format is the same: one per index.
      const on = makeDevices({ shards: { count: 8, by: ["groupId"] } })
      return run(
        (devices) =>
          Effect.gen(function* () {
            const pruned = devices.byTenant({ tenantId: TENANT, groupId: target.groupId })
            const page = yield* pruned.limit(1).fetch()
            const cursor = Option.getOrThrow(page.cursor as Option.Option<string>)
            const rest = yield* pruned.startFrom(cursor).collect()
            expect([...idsOf(page.items), ...idsOf(rest)]).toEqual(idsOf(yield* pruned.collect()))
            yield* refusal(devices.byTenant({ tenantId: TENANT }).startFrom(cursor).collect())
            const wide = yield* devices.byTenant({ tenantId: TENANT }).limit(1).fetch()
            yield* refusal(
              pruned.startFrom(Option.getOrThrow(wide.cursor as Option.Option<string>)).collect(),
            )
          }),
        {},
        items,
        on,
      )
    })

    it.effect("a primary key composite outside the sort key: it never fires", () => {
      const on = makeDevices({ shards: 8, sk: ["groupId", "deviceId"] })
      return run(
        (devices, server) =>
          Effect.gen(function* () {
            const found = yield* devices
              .byTenant({ tenantId: TENANT, groupId: target.groupId, deviceId: target.deviceId })
              .collect()
            expect(server.inputs).toHaveLength(8)
            expect(idsOf(found)).toEqual([target.deviceId])
          }),
        {},
        items,
        on,
      )
    })

    it.effect("`.where()` doesn't prune, even to the last primary key composite", () =>
      run((devices, server) =>
        Effect.gen(function* () {
          const found = yield* devices
            .byTenant({ tenantId: TENANT, groupId: target.groupId, channel: target.channel })
            .where((t: any, { eq }: any) => eq(t.deviceId, target.deviceId))
            .collect()
          expect(server.inputs).toHaveLength(8)
          expect(idsOf(found)).toEqual([target.deviceId])
        }),
      ),
    )

    for (const [previous, partitions] of [
      [1, 2],
      [4, 5],
    ] as const) {
      it.effect(`\`previous: ${previous}\` isn't pruned: ${partitions} partitions`, () => {
        const on = makeDevices({ shards: { count: 8, previous } })
        const server = on.serve(items)
        return Effect.gen(function* () {
          const devices = yield* on.client
          const found = yield* devices.byTenant(fullPin).collect()
          expect(server.inputs).toHaveLength(partitions)
          expect(idsOf(found)).toEqual([target.deviceId])
        }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
      })
    }

    it("Entity.query.<index> prunes as the accessor does", () => {
      const query = fixture.Devices.query.byTenant(fullPin)
      expect(query._state.pkValue).toBe(storedPk)
      expect(query._state.fanOut?.pruned).toBe(true)
      expect(query._state.fanOut?.partitions).toEqual([storedPk])
    })

    it("a partial pin on Entity.query.<index> fans out", () => {
      const partial = fixture.Devices.query.byTenant({ tenantId: TENANT })
      expect(partial._state.fanOut?.pruned).toBe(false)
      expect(partial._state.fanOut?.partitions).toHaveLength(8)
    })
  })

  it.effect("`.where()` doesn't prune, even on a `by` attribute", () => {
    const on = makeDevices({ shards: { count: 8, by: ["groupId"] } })
    return run(
      (devices, server) =>
        Effect.gen(function* () {
          yield* devices
            .byTenant({ tenantId: TENANT })
            .where((t: any, { beginsWith }: any) => beginsWith(t.groupId, "group-a"))
            .collect()
          expect(server.inputs).toHaveLength(8)
        }),
      {},
      items,
      on,
    )
  })

  it.effect("explain names the partitions without a request", () =>
    run((devices, server) =>
      Effect.gen(function* () {
        const explained: Query.QueryExplain = yield* devices
          .byTenant({ tenantId: TENANT })
          .concurrency(3)
          .explain()
        expect(server.inputs).toHaveLength(0)
        expect(explained.plan).toBe("key")
        expect(explained.fanOut?.partitions).toHaveLength(8)
        expect(explained.fanOut?.pruned).toBe(false)
        expect(explained.fanOut?.concurrency).toBe(3)
        expect(explained.keyConditions).toHaveLength(8)
      }),
    ),
  )

  it.effect("explain of a pruned query says it is one shard", () => {
    const on = makeDevices({ shards: { count: 8, by: ["groupId"] } })
    return run(
      (devices) =>
        Effect.gen(function* () {
          const explained: Query.QueryExplain = yield* devices
            .byTenant({ tenantId: TENANT, groupId: "group-a" })
            .explain()
          expect(explained.fanOut?.partitions).toHaveLength(1)
          expect(explained.fanOut?.pruned).toBe(true)
          expect(explained.reason).toContain("one shard")
        }),
      {},
      items,
      on,
    )
  })
})

describe("merged order", () => {
  it.effect("collect is in sort key order across shards", () =>
    run((devices) =>
      Effect.gen(function* () {
        const found = yield* devices.byTenant({ tenantId: TENANT }).collect()
        expect(idsOf(found)).toEqual(idsOf(fixture.merged(items)))
      }),
    ),
  )

  it.effect("reverse is the exact reversal", () =>
    run((devices) =>
      Effect.gen(function* () {
        const found = yield* devices.byTenant({ tenantId: TENANT }).reverse().collect()
        expect(idsOf(found)).toEqual(idsOf(fixture.merged(items, true)))
      }),
    ),
  )

  describe("with ties across shards", () => {
    const tied = makeDevices({ shards: 8, sk: ["status"] })

    it.effect("orders by partition; reverse is the exact reversal", () =>
      run(
        (devices) =>
          Effect.gen(function* () {
            const forward = yield* devices.byTenant({ tenantId: TENANT }).collect()
            const backward = yield* devices.byTenant({ tenantId: TENANT }).reverse().collect()
            expect(idsOf(forward)).toEqual(idsOf(tied.merged(items)))
            expect(idsOf(backward)).toEqual(idsOf(forward).reverse())
          }),
        {},
        items,
        tied,
      ),
    )

    it.effect("a fetch chain through a tie loses and repeats nothing", () =>
      run(
        (devices) =>
          Effect.gen(function* () {
            const all = idsOf(tied.merged(items))
            const out: Array<string> = []
            let cursor: Option.Option<string> = Option.none()
            do {
              const query = devices.byTenant({ tenantId: TENANT }).limit(3)
              const page: Query.Page<Device> = yield* Option.isSome(cursor)
                ? query.startFrom(cursor.value).fetch()
                : query.fetch()
              out.push(...idsOf(page.items))
              cursor = page.cursor
            } while (Option.isSome(cursor))
            expect(out).toEqual(all)
          }),
        {},
        items,
        tied,
      ),
    )
  })

  it.effect("a partition's short pages are followed before anything is emitted past them", () =>
    run(
      (devices) =>
        Effect.gen(function* () {
          const found = yield* devices.byTenant({ tenantId: TENANT }).collect()
          expect(idsOf(found)).toEqual(idsOf(fixture.merged(items)))
        }),
      { pageRows: 2 },
    ),
  )

  it.effect("paginate streams the same order", () =>
    run((devices) =>
      Effect.gen(function* () {
        const found = yield* Stream.runCollect(devices.byTenant({ tenantId: TENANT }).paginate())
        expect(idsOf(Array.from(found as Iterable<Device>))).toEqual(idsOf(fixture.merged(items)))
      }),
    ),
  )

  it.effect("paginate holds at most one page per partition", () =>
    run(
      (devices, server) =>
        Effect.gen(function* () {
          const first = yield* devices
            .byTenant({ tenantId: TENANT })
            .paginate()
            .pipe(Stream.take(1), Stream.runCollect)
          expect(Array.from(first as Iterable<Device>)).toHaveLength(1)
          expect(server.inputs.length).toBeLessThanOrEqual(8)
        }),
      { pageRows: 2 },
    ),
  )
})

describe("fetch", () => {
  it.effect("limit: the page is the merged prefix, the cursor continues it", () =>
    run((devices) =>
      Effect.gen(function* () {
        const all = idsOf(fixture.merged(items))
        const page = yield* devices.byTenant({ tenantId: TENANT }).limit(7).fetch()
        expect(idsOf(page.items)).toEqual(all.slice(0, 7))
        const next = yield* devices
          .byTenant({ tenantId: TENANT })
          .limit(7)
          .startFrom(Option.getOrThrow(page.cursor))
          .fetch()
        expect(idsOf(next.items)).toEqual(all.slice(7, 14))
      }),
    ),
  )

  it.effect("the cursor is None once every partition is done, and exact at the end", () =>
    run((devices) =>
      Effect.gen(function* () {
        const page = yield* devices.byTenant({ tenantId: TENANT }).limit(1000).fetch()
        expect(page.items).toHaveLength(items.length)
        expect(Option.isNone(page.cursor)).toBe(true)
      }),
    ),
  )

  it.effect("a limit that takes exactly everything may hold a cursor that reads nothing more", () =>
    run(
      (devices) =>
        Effect.gen(function* () {
          const page = yield* devices.byTenant({ tenantId: TENANT }).limit(items.length).fetch()
          expect(page.items).toHaveLength(items.length)
          if (Option.isSome(page.cursor)) {
            const rest = yield* devices
              .byTenant({ tenantId: TENANT })
              .startFrom(page.cursor.value)
              .collect()
            expect(rest).toEqual([])
          }
        }),
      { pageRows: 3 },
    ),
  )

  it.effect("without a limit a page is one round, and the chain is complete", () =>
    run(
      (devices, server) =>
        Effect.gen(function* () {
          const out: Array<string> = []
          let cursor: Option.Option<string> = Option.none()
          let pages = 0
          do {
            const query = devices.byTenant({ tenantId: TENANT })
            const before = server.inputs.length
            const page: Query.Page<Device> = yield* Option.isSome(cursor)
              ? query.startFrom(cursor.value).fetch()
              : query.fetch()
            expect(server.inputs.length - before).toBeLessThanOrEqual(8)
            out.push(...idsOf(page.items))
            cursor = page.cursor
            pages++
          } while (Option.isSome(cursor))
          expect(pages).toBeGreaterThan(1)
          expect(out).toEqual(idsOf(fixture.merged(items)))
        }),
      { pageRows: 2 },
    ),
  )

  it.effect("the cursor names no partition key: it can't leave its partitions", () =>
    run((devices) =>
      Effect.gen(function* () {
        const page = yield* devices.byTenant({ tenantId: TENANT }).limit(3).fetch()
        const cursor = Cursor.decode(Option.getOrThrow(page.cursor))
        expect(cursor?.z).toHaveLength(8)
        expect(JSON.stringify(cursor)).not.toContain("gsi5pk")
      }),
    ),
  )

  it.effect("sizes each request from the partition's share of what is owed", () =>
    run((devices, server) =>
      Effect.gen(function* () {
        yield* devices.byTenant({ tenantId: TENANT }).limit(16).fetch()
        for (const input of server.inputs.slice(0, 8)) {
          expect(input.Limit).toBeGreaterThanOrEqual(2)
          expect(input.Limit).toBeLessThanOrEqual(16)
        }
      }),
    ),
  )

  it.effect("a resumed query may change its limit, page size and concurrency", () =>
    run((devices) =>
      Effect.gen(function* () {
        const all = idsOf(fixture.merged(items))
        const page = yield* devices.byTenant({ tenantId: TENANT }).limit(5).fetch()
        const next = yield* devices
          .byTenant({ tenantId: TENANT })
          .limit(9)
          .pageSize(4)
          .concurrency(2)
          .startFrom(Option.getOrThrow(page.cursor))
          .fetch()
        expect(idsOf(next.items)).toEqual(all.slice(5, 14))
      }),
    ),
  )

  it.effect("a cursor resumes through collect and count", () =>
    run((devices) =>
      Effect.gen(function* () {
        const all = idsOf(fixture.merged(items))
        const page = yield* devices.byTenant({ tenantId: TENANT }).limit(5).fetch()
        const cursor = Option.getOrThrow(page.cursor)
        const rest = yield* devices.byTenant({ tenantId: TENANT }).startFrom(cursor).collect()
        expect(idsOf(rest)).toEqual(all.slice(5))
      }),
    ),
  )

  it.effect("a cursor taken on a pruned query fits only that pin", () => {
    const on = makeDevices({ shards: { count: 8, by: ["groupId"] } })
    return run(
      (devices) =>
        Effect.gen(function* () {
          const page = yield* devices
            .byTenant({ tenantId: TENANT, groupId: "group-a" })
            .limit(1)
            .fetch()
          const cursor = Option.getOrThrow(page.cursor)
          const next = yield* devices
            .byTenant({ tenantId: TENANT, groupId: "group-a" })
            .limit(1)
            .startFrom(cursor)
            .fetch()
          expect(next.items).toHaveLength(1)
          yield* refusal(devices.byTenant({ tenantId: TENANT }).startFrom(cursor).fetch())
        }),
      {},
      items,
      on,
    )
  })
})

describe("cursors that don't fit", () => {
  const sharded = (devices: any) =>
    Effect.map(devices.byTenant({ tenantId: TENANT }).limit(3).fetch(), (page: any) =>
      Option.getOrThrow(page.cursor as Option.Option<string>),
    ) as Effect.Effect<string, never>

  /** A cursor with its decoded form changed by `f`. */
  const edited = (text: string, f: (cursor: any) => any) =>
    `v2.${Buffer.from(JSON.stringify(f(Cursor.decode(text))), "utf8").toString("base64url")}`

  const fits = (devices: any, text: string) =>
    devices.byTenant({ tenantId: TENANT }).startFrom(text).fetch()

  it.effect("another shard count's cursor is refused", () => {
    const other = makeDevices({ shards: 4 })
    return Effect.gen(function* () {
      const cursor = yield* run((devices) => sharded(devices), {}, items, other)
      const why = yield* run((devices) => refusal(fits(devices, cursor as string)))
      expect(why).toContain("layout")
    })
  })

  it.effect("another tenant's cursor is refused", () =>
    run((devices) =>
      Effect.gen(function* () {
        const cursor = yield* sharded(devices)
        yield* refusal(devices.byTenant({ tenantId: "t-other" }).startFrom(cursor).fetch())
      }),
    ),
  )

  it.effect("the other direction's cursor is refused", () =>
    run((devices) =>
      Effect.gen(function* () {
        const cursor = yield* sharded(devices)
        yield* refusal(devices.byTenant({ tenantId: TENANT }).reverse().startFrom(cursor).fetch())
      }),
    ),
  )

  it.effect("a cursor of another key condition is refused", () =>
    run((devices) =>
      Effect.gen(function* () {
        const cursor = yield* sharded(devices)
        yield* refusal(
          devices.byTenant({ tenantId: TENANT, groupId: "group-a" }).startFrom(cursor).fetch(),
        )
      }),
    ),
  )

  it.effect("an unsharded query's cursor is refused", () =>
    run((devices) =>
      Effect.gen(function* () {
        const plain = Cursor.encodeKeyCursor({ pk: { S: "x" }, sk: { S: "y" } })
        const why = yield* refusal(fits(devices, plain))
        expect(why).toContain("sharded")
      }),
    ),
  )

  it.effect("garbage is refused", () => run((devices) => refusal(fits(devices, "v2.not-a-cursor"))))

  it.effect("altered positions are refused by the checksum", () =>
    run((devices) =>
      Effect.gen(function* () {
        const cursor = yield* sharded(devices)
        const why = yield* refusal(
          fits(
            devices,
            edited(cursor, (decoded) => ({
              ...decoded,
              z: decoded.z.map((at: unknown) => (at === 0 ? 1 : at)),
            })),
          ),
        )
        expect(why).toContain("altered")
      }),
    ),
  )

  it.effect("a position count that doesn't match is refused, the checksum recomputed", () =>
    run((devices) =>
      Effect.gen(function* () {
        const cursor = yield* sharded(devices)
        const decoded = Cursor.decode(cursor) as any
        const z = decoded.z.slice(1)
        const why = yield* refusal(
          fits(
            devices,
            edited(cursor, () => ({ ...decoded, z, c: checksum(z) })),
          ),
        )
        expect(why).toContain("one position per partition")
      }),
    ),
  )

  it.effect("a position naming another attribute is refused, the checksum recomputed", () =>
    run((devices) =>
      Effect.gen(function* () {
        const cursor = yield* sharded(devices)
        const decoded = Cursor.decode(cursor) as any
        const z = decoded.z.map(() => ({ gsi5pk: { S: "other" }, gsi5sk: { S: "x" } }))
        const why = yield* refusal(
          fits(
            devices,
            edited(cursor, () => ({ ...decoded, z, c: checksum(z) })),
          ),
        )
        expect(why).toContain("isn't a key of this index")
      }),
    ),
  )

  it.effect("a position outside the key condition is refused, the checksum recomputed", () =>
    run((devices) =>
      Effect.gen(function* () {
        const query = () =>
          devices
            .byTenant({ tenantId: TENANT })
            .where((t: any, { beginsWith }: any) => beginsWith(t.groupId, "group-a"))
        const page = yield* query().limit(1).fetch()
        const cursor = Option.getOrThrow(page.cursor as Option.Option<string>)
        const decoded = Cursor.decode(cursor) as any
        const z = decoded.z.map((at: unknown) =>
          typeof at === "object"
            ? { gsi5sk: { S: "$outside" }, pk: { S: "p" }, sk: { S: "s" } }
            : at,
        )
        const why = yield* refusal(
          query()
            .startFrom(edited(cursor, () => ({ ...decoded, z, c: checksum(z) })))
            .fetch(),
        )
        expect(why).toContain("outside the query's key condition")
      }),
    ),
  )

  it.effect("a sharded cursor is refused on an unsharded query", () => {
    const unsharded = makeDevicesUnsharded()
    return Effect.gen(function* () {
      const cursor = yield* run((devices) => sharded(devices))
      yield* run(
        (devices: any) => refusal(devices.byTenant({ tenantId: TENANT }).startFrom(cursor).fetch()),
        unsharded.options,
        items,
        unsharded.fixture,
      )
    })
  })

  it.effect("refused by count too", () =>
    run((devices) =>
      refusal(devices.byTenant({ tenantId: TENANT }).startFrom("v2.not-a-cursor").count()),
    ),
  )
})

describe("count", () => {
  it.effect("sums the partitions with Select COUNT", () =>
    run((devices, server) =>
      Effect.gen(function* () {
        expect(yield* devices.byTenant({ tenantId: TENANT }).count()).toBe(items.length)
        expect(server.inputs).toHaveLength(8)
        for (const input of server.inputs) expect(input.Select).toBe("COUNT")
      }),
    ),
  )

  it.effect("caps at the limit", () =>
    run((devices) =>
      Effect.gen(function* () {
        expect(yield* devices.byTenant({ tenantId: TENANT }).limit(5).count()).toBe(5)
      }),
    ),
  )

  it.effect("applies the filter", () =>
    run((devices) =>
      Effect.gen(function* () {
        const expected = items.filter((item) => item.status === "on").length
        expect(yield* devices.byTenant({ tenantId: TENANT }).filter({ status: "on" }).count()).toBe(
          expected,
        )
      }),
    ),
  )

  it.effect("follows short pages", () =>
    run(
      (devices) =>
        Effect.gen(function* () {
          expect(yield* devices.byTenant({ tenantId: TENANT }).count()).toBe(items.length)
        }),
      { pageRows: 2 },
    ),
  )

  it.effect("resumes from a cursor", () =>
    run((devices) =>
      Effect.gen(function* () {
        const page = yield* devices.byTenant({ tenantId: TENANT }).limit(5).fetch()
        const rest = yield* devices
          .byTenant({ tenantId: TENANT })
          .startFrom(Option.getOrThrow(page.cursor))
          .count()
        expect(rest).toBe(items.length - 5)
      }),
    ),
  )
})

describe("`previous`", () => {
  const moved = makeDevices({ shards: { count: 8, previous: 4 } })
  const fromUnsharded = makeDevices({ shards: { count: 8, previous: 1 } })
  const oldLayout = makeDevices({ shards: 4 })
  const unsharded = makeDevicesUnsharded()

  it.effect("reads N + M partitions", () =>
    run(
      (devices, server) =>
        Effect.gen(function* () {
          yield* devices.byTenant({ tenantId: TENANT }).collect()
          expect(server.inputs).toHaveLength(12)
          expect(new Set(server.partitionsRead()).size).toBe(12)
          const read = server.partitionsRead()
          expect(read.filter((pk) => pk.includes("#!8."))).toHaveLength(8)
          expect(read.filter((pk) => pk.includes("#!4."))).toHaveLength(4)
        }),
      {},
      items,
      moved,
    ),
  )

  it.effect("`previous: 1` reads N partitions and the unsharded one", () =>
    run(
      (devices, server) =>
        Effect.gen(function* () {
          yield* devices.byTenant({ tenantId: TENANT }).collect()
          const read = server.partitionsRead()
          expect(read).toHaveLength(9)
          expect(read).toContain(`$fleet-db#v1#devicestate#tenantid_${TENANT}`)
        }),
      {},
      items,
      fromUnsharded,
    ),
  )

  it.effect("`by` doesn't prune `previous` partitions", () => {
    const on = makeDevices({ shards: { count: 8, by: ["groupId"], previous: 4 } })
    return run(
      (devices, server) =>
        Effect.gen(function* () {
          yield* devices.byTenant({ tenantId: TENANT, groupId: "group-a" }).collect()
          expect(server.partitionsRead().filter((pk) => pk.includes("#!8."))).toHaveLength(1)
          expect(server.partitionsRead().filter((pk) => pk.includes("#!4."))).toHaveLength(4)
        }),
      {},
      items,
      on,
    )
  })

  it.effect("a half-migrated index returns each item once, in merged order", () => {
    const half = Math.floor(items.length / 2)
    const inNew = items.slice(0, half)
    const inOld = items.slice(half)
    const server = moved.serve(inNew, {}, inOld.map(oldLayout.rowOf))
    return Effect.gen(function* () {
      const devices = yield* moved.client
      const found = yield* devices.byTenant({ tenantId: TENANT }).collect()
      expect(idsOf(found).sort()).toEqual(idsOf(items).sort())
      const sks = found.map((item: Device) => moved.rowOf(item).gsi5sk!.S!)
      expect(sks).toEqual([...sks].sort())
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
  })

  it.effect("a value spelling the marker is not read from another layout (finding 3)", () => {
    // Tenant `t-123#07`'s unsharded key is the issue's "final segment" sharded
    // key for tenant `t-123`, shard 07. Under the marker, nothing reads it.
    const foreign = { ...items[0]!, tenantId: `${TENANT}#7`, deviceId: "foreign" }
    const server = fromUnsharded.serve([], {}, [unsharded.fixture.rowOf(foreign)])
    return Effect.gen(function* () {
      const devices = yield* fromUnsharded.client
      expect(yield* devices.byTenant({ tenantId: TENANT }).collect()).toEqual([])
      const found = yield* devices.byTenant({ tenantId: foreign.tenantId }).collect()
      expect(idsOf(found)).toEqual(["foreign"])
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
  })

  it.effect("a cursor from before a step is refused", () =>
    Effect.gen(function* () {
      const cursor = yield* run(
        (devices) =>
          Effect.map(devices.byTenant({ tenantId: TENANT }).limit(1).fetch(), (page: any) =>
            Option.getOrThrow(page.cursor as Option.Option<string>),
          ),
        {},
        items,
        oldLayout,
      )
      yield* run(
        (devices) =>
          refusal(
            devices
              .byTenant({ tenantId: TENANT })
              .startFrom(cursor as string)
              .fetch(),
          ),
        {},
        items,
        moved,
      )
    }),
  )

  it.effect("cursors chain across the partitions of both layouts", () => {
    const half = Math.floor(items.length / 2)
    const server = moved.serve(items.slice(0, half), {}, items.slice(half).map(oldLayout.rowOf))
    return Effect.gen(function* () {
      const devices = yield* moved.client
      const all = idsOf(yield* devices.byTenant({ tenantId: TENANT }).collect())
      const out: Array<string> = []
      let cursor: Option.Option<string> = Option.none()
      do {
        const query = devices.byTenant({ tenantId: TENANT }).limit(4)
        const page: Query.Page<Device> = yield* Option.isSome(cursor)
          ? query.startFrom(cursor.value).fetch()
          : query.fetch()
        out.push(...idsOf(page.items))
        cursor = page.cursor
      } while (Option.isSome(cursor))
      expect(out).toEqual(all)
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
  })
})

describe("concurrency", () => {
  const gauge = () => {
    let inFlight = 0
    let peak = 0
    return {
      peak: () => peak,
      before: () =>
        Effect.gen(function* () {
          inFlight++
          peak = Math.max(peak, inFlight)
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          inFlight--
        }),
    }
  }

  it.effect("the default sends every partition at once", () => {
    const load = gauge()
    return run((devices) => devices.byTenant({ tenantId: TENANT }).collect(), {
      before: load.before,
    }).pipe(Effect.tap(() => Effect.sync(() => expect(load.peak()).toBe(8))))
  })

  it.effect.each([1, 2, 3])("`.concurrency(%d)` holds to it", (n) => {
    const load = gauge()
    return run(
      (devices) =>
        Effect.gen(function* () {
          const found = yield* devices.byTenant({ tenantId: TENANT }).concurrency(n).collect()
          expect(idsOf(found)).toEqual(idsOf(fixture.merged(items)))
        }),
      { before: load.before },
    ).pipe(Effect.tap(() => Effect.sync(() => expect(load.peak()).toBe(n))))
  })

  it.effect("holds on count too", () => {
    const load = gauge()
    return run((devices) => devices.byTenant({ tenantId: TENANT }).concurrency(2).count(), {
      before: load.before,
    }).pipe(Effect.tap(() => Effect.sync(() => expect(load.peak()).toBe(2))))
  })

  it.effect.each([0, -1, 1.5, Number.NaN])("`.concurrency(%s)` throws [EDD-9105]", (n) =>
    run((devices) =>
      Effect.sync(() => {
        expect(() => devices.byTenant({ tenantId: TENANT }).concurrency(n)).toThrow("[EDD-9105]")
      }),
    ),
  )
})

describe("projections (finding 5)", () => {
  it.effect("merges, cursors and strips what it borrowed", () =>
    run((devices, server) =>
      Effect.gen(function* () {
        const query = () => devices.byTenant({ tenantId: TENANT }).select(["deviceId"]).limit(7)
        const page = yield* query().fetch()
        expect(page.items).toEqual(
          fixture
            .merged(items)
            .slice(0, 7)
            .map((item) => ({ deviceId: item.deviceId })),
        )
        expect(server.inputs[0]!.ProjectionExpression).toBeDefined()
        const next = yield* query().startFrom(Option.getOrThrow(page.cursor)).fetch()
        expect(next.items).toEqual(
          fixture
            .merged(items)
            .slice(7, 14)
            .map((item) => ({ deviceId: item.deviceId })),
        )
      }),
    ),
  )

  it.effect("collect without a limit still borrows the sort key", () =>
    run((devices) =>
      Effect.gen(function* () {
        const found = yield* devices.byTenant({ tenantId: TENANT }).select(["status"]).collect()
        expect(found).toEqual(fixture.merged(items).map((item) => ({ status: item.status })))
      }),
    ),
  )
})

describe("`.maxPages(n)`", () => {
  it.effect("counts rounds: at most n × partitions requests", () =>
    run(
      (devices, server) =>
        Effect.gen(function* () {
          yield* devices.byTenant({ tenantId: TENANT }).maxPages(2).collect()
          expect(server.inputs.length).toBeLessThanOrEqual(16)
          expect(server.inputs.length).toBeGreaterThan(8)
        }),
      { pageRows: 2 },
    ),
  )

  it.effect("collect stops short with a sorted prefix", () =>
    run(
      (devices) =>
        Effect.gen(function* () {
          const found = yield* devices.byTenant({ tenantId: TENANT }).maxPages(1).collect()
          const all = idsOf(fixture.merged(items))
          expect(found.length).toBeLessThan(all.length)
          expect(idsOf(found)).toEqual(all.slice(0, found.length))
        }),
      { pageRows: 2 },
    ),
  )

  it.effect("fetch's cursor re-reads what couldn't be proven in order", () =>
    run(
      (devices) =>
        Effect.gen(function* () {
          const all = idsOf(fixture.merged(items))
          const query = () => devices.byTenant({ tenantId: TENANT }).limit(all.length).maxPages(1)
          const first = yield* query().fetch()
          expect(first.items.length).toBeLessThan(all.length)
          expect(idsOf(first.items)).toEqual(all.slice(0, first.items.length))
          const rest = yield* devices
            .byTenant({ tenantId: TENANT })
            .startFrom(Option.getOrThrow(first.cursor))
            .collect()
          expect(idsOf(rest)).toEqual(all.slice(first.items.length))
        }),
      { pageRows: 2 },
    ),
  )
})

describe("`onRequest`", () => {
  it.effect("one event per request, and Σ accepted is what came back", () =>
    run((devices, server) =>
      Effect.gen(function* () {
        const events: Array<Query.QueryRequestEvent> = []
        const found = yield* devices
          .byTenant({ tenantId: TENANT })
          .onRequest((event: Query.QueryRequestEvent) =>
            Effect.sync(() => {
              events.push(event)
            }),
          )
          .collect()
        expect(events).toHaveLength(server.inputs.length)
        expect([...events.map((event) => event.request)].sort((a, b) => a - b)).toEqual(
          events.map((_, i) => i + 1),
        )
        expect(events.reduce((n, event) => n + event.accepted, 0)).toBe(found.length)
      }),
    ),
  )

  it.effect("a limited fetch reports what it took, and a page untouched as discarded", () =>
    run((devices) =>
      Effect.gen(function* () {
        const events: Array<Query.QueryRequestEvent> = []
        const page = yield* devices
          .byTenant({ tenantId: TENANT })
          .limit(1)
          .pageSize(5)
          .onRequest((event: Query.QueryRequestEvent) =>
            Effect.sync(() => {
              events.push(event)
            }),
          )
          .fetch()
        expect(page.items).toHaveLength(1)
        expect(events.reduce((n, event) => n + event.accepted, 0)).toBe(1)
        expect(events.filter((event) => event.discarded === true).length).toBeGreaterThan(0)
      }),
    ),
  )

  it.effect("count reports each request", () =>
    run((devices, server) =>
      Effect.gen(function* () {
        const events: Array<Query.QueryRequestEvent> = []
        yield* devices
          .byTenant({ tenantId: TENANT })
          .onRequest((event: Query.QueryRequestEvent) =>
            Effect.sync(() => {
              events.push(event)
            }),
          )
          .count()
        expect(events).toHaveLength(server.inputs.length)
        expect(events.every((event) => event.kind === "count")).toBe(true)
      }),
    ),
  )
})

describe("a failure on one shard", () => {
  const failing = (shard: number) => ({
    before: (input: { readonly ExpressionAttributeValues?: unknown }) =>
      pkOfInput(input as never) === partition(shard)
        ? Effect.fail(new DynamoError({ operation: "Query", cause: new Error("throttled") }))
        : Effect.void,
  })

  it.effect("fails collect, with no partial result", () =>
    run(
      (devices) =>
        Effect.gen(function* () {
          const error: any = yield* Effect.flip(devices.byTenant({ tenantId: TENANT }).collect())
          expect(error._tag).toBe("DynamoError")
        }),
      failing(3),
    ),
  )

  it.effect("fails fetch", () =>
    run(
      (devices) =>
        Effect.gen(function* () {
          const error: any = yield* Effect.flip(
            devices.byTenant({ tenantId: TENANT }).limit(3).fetch(),
          )
          expect(error._tag).toBe("DynamoError")
        }),
      failing(3),
    ),
  )

  it.effect("fails count", () =>
    run(
      (devices) =>
        Effect.gen(function* () {
          const error: any = yield* Effect.flip(devices.byTenant({ tenantId: TENANT }).count())
          expect(error._tag).toBe("DynamoError")
        }),
      failing(3),
    ),
  )

  it.effect("fails a stream at that point, with nothing beyond what was proven", () =>
    run(
      (devices) =>
        Effect.gen(function* () {
          const all = idsOf(fixture.merged(items))
          const delivered: Array<string> = []
          const failure = yield* devices
            .byTenant({ tenantId: TENANT })
            .paginate()
            .pipe(
              Stream.runForEach((item: Device) =>
                Effect.sync(() => {
                  delivered.push(item.deviceId)
                }),
              ),
              Effect.flip,
            )
          expect((failure as any)._tag).toBe("DynamoError")
          expect(delivered).toEqual(all.slice(0, delivered.length))
        }),
      {
        pageRows: 2,
        // The second page of one shard fails.
        before: (input, request) =>
          request > 8 && pkOfInput(input) === partition(0)
            ? Effect.fail(new DynamoError({ operation: "Query", cause: new Error("throttled") }))
            : Effect.void,
      },
    ),
  )

  it.effect("interrupts the requests in flight", () => {
    let interrupted = 0
    return run(
      (devices) =>
        Effect.flip(devices.byTenant({ tenantId: TENANT }).collect()) as Effect.Effect<unknown>,
      {
        before: (input) =>
          pkOfInput(input) === partition(0)
            ? Effect.gen(function* () {
                yield* Effect.yieldNow
                return yield* Effect.fail(
                  new DynamoError({ operation: "Query", cause: new Error("throttled") }),
                )
              })
            : Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted++
                  }),
                ),
              ),
      },
    ).pipe(Effect.tap(() => Effect.sync(() => expect(interrupted).toBe(7))))
  })

  it.effect("a stream that is interrupted stops reading", () => {
    const server = fixture.serve(items, { pageRows: 2 })
    return Effect.gen(function* () {
      const devices = yield* fixture.client
      const fiber = yield* devices
        .byTenant({ tenantId: TENANT })
        .paginate()
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* Fiber.join(fiber)
      const read = server.inputs.length
      expect(read).toBeLessThanOrEqual(8)
    }).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown>
  })
})

describe("what a sharded index refuses (EDD-9104)", () => {
  it.effect("`.within()`", () =>
    run((devices) =>
      Effect.sync(() => {
        expect(() =>
          devices.byTenant({ tenantId: TENANT }).within({ channel: { gte: "a" } }),
        ).toThrow("[EDD-9104]")
      }),
    ),
  )

  it.effect("`.zorder()`", () =>
    run((devices) =>
      Effect.sync(() => {
        expect(() => devices.byTenant({ tenantId: TENANT }).zorder({ mode: "jump" })).toThrow(
          "[EDD-9104]",
        )
      }),
    ),
  )
})

describe("non-interference", () => {
  it.effect("an unsharded index's query is one request with no fan-out", () => {
    const unsharded = makeDevicesUnsharded()
    return run(
      (devices, server) =>
        Effect.gen(function* () {
          const explained: Query.QueryExplain = yield* devices
            .byTenant({ tenantId: TENANT })
            .explain()
          expect(explained.fanOut).toBeUndefined()
          yield* devices.byTenant({ tenantId: TENANT }).collect()
          expect(server.inputs).toHaveLength(1)
          expect(pkOfInput(server.inputs[0]!)).toBe(`$fleet-db#v1#devicestate#tenantid_${TENANT}`)
        }),
      unsharded.options,
      items,
      unsharded.fixture,
    )
  })

  it.effect("`.concurrency()` has no effect on an unsharded index", () => {
    const unsharded = makeDevicesUnsharded()
    return run(
      (devices, server) =>
        Effect.gen(function* () {
          yield* devices.byTenant({ tenantId: TENANT }).concurrency(4).collect()
          expect(server.inputs).toHaveLength(1)
        }),
      unsharded.options,
      items,
      unsharded.fixture,
    )
  })
})
