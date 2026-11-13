/**
 * Projections sharing one read-model row, interleaved (#237): a seeded, deterministic property
 * test. Each run applies every stream's events to one row, mostly in order and sometimes
 * redelivered, with `create`s and rebuilds among them; before one of an action's requests is
 * answered, one or two other actions run to completion, nested up to two deep, so every write can
 * lose the race for the row. The properties, after every run:
 *
 * - every action commits or fails with `ConcurrentModification` (a lost race) or, for `create`,
 *   `ConditionalCheckFailed`; on layouts naming disjoint attributes nothing else, `EDD-9144`
 *   included; where two projections give one attribute different roles, `EDD-9144` only for an
 *   attribute present on the row in the role of another projection its token records, and never
 *   on a rebuild;
 * - after every action, each projection the row token records holds an attribute on the row: the
 *   token describes the row as it is;
 * - nothing wedges: every projection's next event lands;
 * - redelivering every event changes nothing;
 * - the row is the one a serial replay of the committed actions, in commit order, writes.
 *
 * `Date` is held at one instant, so every removal stamp is the same: a guard naming the stamp
 * alone can't tell two tombstones apart.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Layer, Schema } from "effect"
import { afterAll, beforeAll, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import {
  layoutTag,
  type ProjectionLayout,
  projectionLayoutsOf,
  ROW_TOKEN,
  rowWriters,
} from "../src/internal/TransactableOps.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", {}) {}

const Row = Schema.Struct({
  id: Schema.String,
  total: Schema.Number,
  a: Schema.optional(Schema.Number),
  ra: Schema.optional(Schema.Number),
  b: Schema.optional(Schema.Number),
  rb: Schema.optional(Schema.Number),
  c: Schema.optional(Schema.Number),
  rc: Schema.optional(Schema.Number),
  shared: Schema.optional(Schema.Number),
})

interface Layout {
  readonly checkpoint: "a" | "b" | "c" | "shared"
  readonly revision?: "ra" | "rb" | "rc" | "shared"
  readonly removal?: boolean
  readonly outbox?: boolean
}

/** mulberry32: a seeded generator, so a failing seed replays exactly. */
const rng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const KEY = "$fz#v1#row#id_x|$fz#v1#row"

/** A program defining every projection of `layouts` on one read model, over `table`. */
const program = (table: ReturnType<typeof makeRecordingTable>, layouts: ReadonlyArray<Layout>) => {
  const schema = DynamoSchema.make({ name: "fz", version: 1 })
  const events = Table.make({ schema, entities: {} })
  const streams = layouts.map((_, i) =>
    EventStore.makeStream({
      table: events,
      streamName: `S${i}`,
      events: [Placed, Cancelled],
      streamId: { composite: ["id"] },
    }),
  )
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const read = Table.make({ schema, entities: { Rows } })
  const outbox = Table.make({ schema, entities: {} })
  const evolve = (state: typeof Row.Type, event: { readonly data: Placed | Cancelled }) =>
    Effect.succeed(
      event.data._tag === "Cancelled"
        ? EventStore.removeRow
        : { ...state, total: state.total + event.data.amount },
    )
  const projections = layouts.map((layout, i) =>
    EventStore.projection({
      stream: streams[i]!,
      readModel: Rows,
      key: (id: { readonly id: string }) => ({ id: id.id }),
      initial: (id: { readonly id: string }) => ({ id: id.id, total: 0 }),
      evolve,
      checkpoint: layout.checkpoint,
      ...(layout.revision !== undefined && { revision: layout.revision }),
      ...(layout.removal === true && { removal: {} }),
      ...(layout.outbox === true && {
        outbox: {
          schema: Schema.Struct({ total: Schema.Number }),
          effects: (_event: unknown, next: typeof Row.Type | undefined) =>
            next === undefined ? [] : [{ total: next.total }],
          table: outbox,
        },
      }),
      retry: 0,
    }),
  )
  const layer = Layer.mergeAll(
    Layer.succeed(DynamoClient, table.client),
    events.layer({ name: "events" }),
    read.layer({ name: "read" }),
    outbox.layer({ name: "outbox" }),
  )
  // Each projection's layout as recorded on the read model, in definition order.
  const recorded = projectionLayoutsOf(Rows) ?? []
  return { streams, Rows, projections, layer, recorded }
}

type Action =
  | { readonly kind: "apply"; readonly p: number; readonly n: number }
  | { readonly kind: "create"; readonly total: number }
  | { readonly kind: "rebuild"; readonly p: number }

const run = <A>(effect: Effect.Effect<A, unknown, any>, layer: Layer.Layer<any>) =>
  Effect.runSync(Effect.exit(effect.pipe(Effect.provide(layer))) as Effect.Effect<Exit.Exit<A>>)

const failureText = (exit: Exit.Exit<unknown, unknown>) => String((exit as any).cause)

const sorted = (o: Record<string, unknown> | undefined) =>
  o === undefined ? o : Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)))

/** The row as stored, without its row token. */
const rowOf = (table: ReturnType<typeof makeRecordingTable>) => {
  const item = table.items.get(KEY)
  if (item === undefined) return undefined
  const { [ROW_TOKEN]: _, ...rest } = fromAttributeMap(item) as Record<string, unknown>
  return rest
}

/** The `EDD-9144` refusals the runs so far met. */
let refusals = 0

/** One run: the problems it found. */
const fuzz = (
  seed: number,
  layouts: ReadonlyArray<Layout>,
  scripts: ReadonlyArray<ReadonlyArray<"P" | "C">>,
  options: { readonly creates?: boolean; readonly rebuilds?: boolean } = {},
): Array<string> => {
  const random = rng(seed)
  const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(random() * xs.length)]!
  const table = makeRecordingTable()
  const { streams, Rows, projections, layer, recorded } = program(table, layouts)
  const byTag = new Map<string, ProjectionLayout>(recorded.map((l) => [layoutTag(l), l]))
  const problems: Array<string> = []

  // Every tag the row token records names a projection holding an attribute on the row.
  const checkTags = (after: string) => {
    const item = table.items.get(KEY)
    if (item === undefined) return
    for (const tag of rowWriters(item[ROW_TOKEN])) {
      const layout = byTag.get(tag)
      if (layout === undefined) problems.push(`${after}: unknown tag ${tag}`)
      else if (!layout.roles.some(([field]) => Object.hasOwn(item, field)))
        problems.push(`${after}: tag of ${layout.label} with none of its attributes on the row`)
    }
  }

  // `EDD-9144` for `p`: an attribute on the row that a projection the token records keeps in a
  // role `p` doesn't give it.
  const twoMeanings = (p: number) => {
    const item = table.items.get(KEY)
    if (item === undefined) return false
    const own = recorded[p]!
    for (const tag of rowWriters(item[ROW_TOKEN])) {
      const other = byTag.get(tag)
      if (other === undefined || tag === layoutTag(own)) continue
      for (const [field, role] of other.roles) {
        if (!Object.hasOwn(item, field)) continue
        if (!own.roles.some(([f, r]) => f === field && r === role)) return true
      }
    }
    return false
  }

  // Every stream's events, each `Placed` a distinct power of two, so the total says which applied.
  const events: Array<ReadonlyArray<any>> = []
  let bit = 1
  for (let i = 0; i < layouts.length; i++) {
    const data = scripts[i]!.map((k) => {
      if (k === "C") return new Cancelled({})
      const e = new Placed({ amount: bit })
      bit *= 2
      return e
    })
    run(streams[i]!.append({ id: "x" }, data, 0), layer)
    const read = run(streams[i]!.read({ id: "x" }), layer)
    if (!Exit.isSuccess(read)) throw new Error(`read failed: ${String(read)}`)
    events.push(read.value)
  }

  const next = layouts.map(() => 0)
  const blocked = new Set<number>()
  const committed: Array<Action> = []
  let depth = 0
  let createTotal = 1000
  const label = (action: Action) =>
    action.kind === "apply"
      ? `apply p${action.p} n${action.n}`
      : action.kind === "rebuild"
        ? `rebuild p${action.p}`
        : `create ${action.total}`

  const doAction = (action: Action, nest: boolean) => {
    const before = table.requests.length
    const injectAt = nest && random() < 0.8 ? Math.floor(random() * 4) : -1
    const previous = table.hooks.onRequest
    if (injectAt >= 0) {
      table.hooks.onRequest = (request) => {
        if (request.input.TableName !== "read" && request.command !== "TransactWriteItems") return
        const mine =
          table.requests
            .slice(before)
            .filter((r) => r.input.TableName === "read" || r.command === "TransactWriteItems")
            .length - 1
        if (mine !== injectAt) return
        table.hooks.onRequest = undefined
        depth++
        const count = 1 + Math.floor(random() * 2)
        for (let k = 0; k < count; k++) step(depth < 2)
        depth--
        table.hooks.onRequest = undefined
      }
    }
    const exit: Exit.Exit<unknown, unknown> =
      action.kind === "apply"
        ? run(projections[action.p]!.apply(events[action.p]![action.n]), layer)
        : action.kind === "rebuild"
          ? run(projections[action.p]!.rebuild({ id: "x" }), layer)
          : run(Rows.create({ id: "x", total: action.total }).asEffect(), layer)
    table.hooks.onRequest = previous
    if (Exit.isSuccess(exit)) {
      committed.push(action)
      if (action.kind === "apply" && next[action.p] === action.n) next[action.p] = action.n + 1
    } else {
      const text = failureText(exit)
      if (/ConcurrentModification/.test(text)) {
        // A lost race.
      } else if (action.kind === "create" && /ConditionalCheckFailed/.test(text)) {
        // The row exists.
      } else if (action.kind === "apply" && /EDD-9144/.test(text) && twoMeanings(action.p)) {
        refusals++
        blocked.add(action.p)
      } else problems.push(`${label(action)}: ${text.slice(0, 300)}`)
    }
    checkTags(label(action))
  }

  const step = (nest: boolean) => {
    if (options.creates === true && random() < 0.12) {
      doAction({ kind: "create", total: createTotal++ }, nest)
      return
    }
    if (options.rebuilds === true && random() < 0.1) {
      doAction({ kind: "rebuild", p: Math.floor(random() * layouts.length) }, nest)
      return
    }
    const open = layouts
      .map((_, i) => i)
      .filter((i) => !blocked.has(i) && next[i]! < events[i]!.length)
    if (open.length === 0) return
    const p = pick(open)
    // Mostly the next event; sometimes a redelivery of an earlier one.
    const n = next[p]! > 0 && random() < 0.15 ? Math.floor(random() * next[p]!) : next[p]!
    doAction({ kind: "apply", p, n }, nest)
  }

  let steps = 0
  while (next.some((n, i) => !blocked.has(i) && n < events[i]!.length)) {
    if (++steps > 2000) {
      problems.push(`wedged: next ${JSON.stringify(next)} row ${JSON.stringify(rowOf(table))}`)
      break
    }
    step(true)
  }

  // Redelivering every event changes nothing.
  const final = rowOf(table)
  for (let p = 0; p < (options.rebuilds === true ? 0 : layouts.length); p++) {
    if (blocked.has(p)) continue
    for (let n = 0; n < events[p]!.length; n++) {
      const exit = run(projections[p]!.apply(events[p]![n]), layer)
      if (!Exit.isSuccess(exit)) problems.push(`redelivery p${p} n${n}: ${failureText(exit)}`)
      else if (exit.value.applied.length > 0) problems.push(`redelivery p${p} n${n} applied again`)
    }
  }
  if (JSON.stringify(rowOf(table)) !== JSON.stringify(final))
    problems.push(`redelivery changed the row: ${JSON.stringify(final)}`)

  // A serial replay of the committed actions, in commit order, writes the same row.
  const serialTable = makeRecordingTable()
  const serial = program(serialTable, layouts)
  for (let i = 0; i < layouts.length; i++) {
    run(
      serial.streams[i]!.append(
        { id: "x" },
        events[i]!.map((e) => e.data),
        0,
      ),
      serial.layer,
    )
  }
  const serialEvents = layouts.map(
    (_, i) => (run(serial.streams[i]!.read({ id: "x" }), serial.layer) as any).value,
  )
  for (const action of committed) {
    if (action.kind === "apply")
      run(serial.projections[action.p]!.apply(serialEvents[action.p][action.n]), serial.layer)
    else if (action.kind === "rebuild")
      run(serial.projections[action.p]!.rebuild({ id: "x" }), serial.layer)
    else run(serial.Rows.create({ id: "x", total: action.total }).asEffect(), serial.layer)
  }
  const expected = rowOf(serialTable)
  if (JSON.stringify(sorted(final)) !== JSON.stringify(sorted(expected)))
    problems.push(
      `not linearisable: ${JSON.stringify(sorted(final))}, serially ${JSON.stringify(sorted(expected))}, order ${committed.map(label).join(", ")}`,
    )
  return problems
}

const SEEDS = 40

/** Every seed of `f` finds nothing: the first few seeds' problems otherwise. */
const sweep = (f: (seed: number) => Array<string>) => {
  const bad: Array<string> = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const problems = f(seed)
    if (problems.length > 0 && bad.length < 3) bad.push(`seed ${seed}: ${problems.join(" | ")}`)
  }
  expect(bad).toEqual([])
}

const P5 = ["P", "P", "P", "P", "P"] as const
const REMOVING_SCRIPTS = [
  ["P", "C", "P", "P", "C", "P"],
  P5,
  ["P", "P", "C", "P", "C", "P"],
] as const

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: 0 })
})
afterAll(() => {
  vi.useRealTimers()
})

describe("projections sharing a row, interleaved (#237)", () => {
  const disjoint: ReadonlyArray<Layout> = [
    { checkpoint: "a", revision: "ra" },
    { checkpoint: "b", revision: "rb" },
    { checkpoint: "c" },
  ]
  const removing: ReadonlyArray<Layout> = [
    { checkpoint: "a", revision: "ra", removal: true },
    { checkpoint: "b" },
    { checkpoint: "c", removal: true },
  ]
  const removing2: ReadonlyArray<Layout> = [
    { checkpoint: "a", removal: true },
    { checkpoint: "b", revision: "rb", removal: true },
    { checkpoint: "c", revision: "rc" },
  ]
  const outboxed: ReadonlyArray<Layout> = [
    { checkpoint: "a", revision: "ra", removal: true, outbox: true },
    { checkpoint: "b", revision: "rb", outbox: true },
    { checkpoint: "c", revision: "rc", removal: true },
  ]
  // A's revision is B's checkpoint.
  const overlapping: ReadonlyArray<Layout> = [
    { checkpoint: "a", revision: "shared", removal: true },
    { checkpoint: "shared" },
    { checkpoint: "c", revision: "rc" },
  ]

  it("three projections without removal, rebuilds among them", () =>
    sweep((seed) => fuzz(seed, disjoint, [P5, P5, P5], { rebuilds: true })))
  it("three projections with removal, `create`s among them", () =>
    sweep((seed) => fuzz(seed, removing, REMOVING_SCRIPTS, { creates: true })))
  it("three projections with removal, `create`s and rebuilds among them", () =>
    sweep((seed) => fuzz(seed, removing, REMOVING_SCRIPTS, { creates: true, rebuilds: true })))
  it("removal without a revision, `create`s and rebuilds among them", () =>
    sweep((seed) =>
      fuzz(seed, removing2, [["P", "C", "P", "P", "C", "P"], ["C", "P", "P", "C", "P"], P5], {
        creates: true,
        rebuilds: true,
      }),
    ))
  it("with outboxes, `create`s among them", () =>
    sweep((seed) => fuzz(seed, outboxed, REMOVING_SCRIPTS, { creates: true })))
  it("one projection with removal and no revision, `create`s among them", () =>
    sweep((seed) =>
      fuzz(seed, [{ checkpoint: "a", removal: true }], [["P", "C", "P", "P", "C", "P", "C", "P"]], {
        creates: true,
      }),
    ))
  it("one projection with removal and a revision, `create`s among them", () =>
    sweep((seed) =>
      fuzz(
        seed,
        [{ checkpoint: "a", revision: "ra", removal: true }],
        [["P", "C", "P", "P", "C", "P", "C", "P"]],
        { creates: true },
      ),
    ))
  it("one attribute in two roles: `EDD-9144` only where the row holds both", () => {
    refusals = 0
    sweep((seed) =>
      fuzz(seed, overlapping, [["P", "C", "P", "P", "C", "P"], P5, P5], {
        creates: true,
        rebuilds: true,
      }),
    )
    // The property isn't vacuous: the runs meet the refusal.
    expect(refusals).toBeGreaterThan(0)
  })
})
